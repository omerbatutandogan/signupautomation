/**
 * Toplu keşif: Sheet'teki siteler için config taslağı üretir.
 *
 * Kullanım:
 *   npm run discover -- --limit 20           # Sheet'ten 20 site
 *   npm run discover -- --limit 20 --headed  # gözlemlemek için
 *   npm run discover -- --site 10words       # tek site yeniden keşif
 *   npm run discover -- --reset              # ilerlemeyi sıfırla
 *
 * Kesinti olursa data/discovery.json sayesinde kalınan yerden devam eder.
 */

import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { chromium, type Browser, type Page } from 'playwright';
import pino from 'pino';
import { env } from '../src/config.js';
import { SheetClient, type SheetRow } from '../src/integrations/sheet.js';
import { findSignupPage } from '../src/discovery/find-signup.js';
import { analyzeForm } from '../src/discovery/analyze-form.js';
import { generateConfig, riskFor } from '../src/discovery/generate-config.js';
import { listSiteIds } from '../src/adapters/registry.js';

const PROGRESS_FILE = 'data/discovery.json';
const SITES_DIR = 'src/sites';

const logger = pino({
  level: env.LOG_LEVEL,
  transport: {
    target: 'pino-pretty',
    options: { colorize: true, translateTime: 'HH:MM:ss', ignore: 'pid,hostname' },
  },
});

type Outcome = 'generated' | 'high_risk' | 'no_form' | 'error' | 'skipped_existing';

interface ProgressEntry {
  siteId: string;
  outcome: Outcome;
  reason?: string;
  signupUrl?: string;
  at: number;
}

interface Progress {
  entries: Record<string, ProgressEntry>;
}

async function loadProgress(): Promise<Progress> {
  try {
    return JSON.parse(await readFile(PROGRESS_FILE, 'utf8')) as Progress;
  } catch {
    return { entries: {} };
  }
}

async function saveProgress(p: Progress): Promise<void> {
  await mkdir('data', { recursive: true });
  await writeFile(PROGRESS_FILE, JSON.stringify(p, null, 2));
}

/** Keşif sırasında siteye nazik davran — bu okuma, kayıt değil. */
function politePause(): Promise<void> {
  return new Promise((r) => setTimeout(r, 2000 + Math.random() * 3000));
}

interface SiteResult {
  outcome: Outcome;
  reason?: string;
  signupUrl?: string;
  warnings?: string[];
}

/**
 * Tek siteyi keşfeder.
 *
 * Headless'ta form bulunamazsa headed dener: AlternativeTo headless'ta
 * formu hiç render etmiyordu. Böylece 170 pencere açmadan da
 * headless-dirençli siteler yakalanıyor.
 */
async function discoverSite(
  browser: Browser,
  row: SheetRow,
  opts: { forceHeaded: boolean; headedBrowser: () => Promise<Browser> },
): Promise<SiteResult> {
  if (riskFor(row.website) === 'high') {
    return { outcome: 'high_risk', reason: 'ToS otomatik kaydı yasaklıyor' };
  }

  const attempt = async (page: Page): Promise<SiteResult | null> => {
    const candidate = await findSignupPage(page, row.website);
    if (!candidate) return null;

    const analysis = await analyzeForm(page);
    const { config, warnings } = generateConfig({
      id: row.siteId,
      name: row.name || row.siteId,
      website: row.website,
      candidate,
      analysis,
    });

    await mkdir(SITES_DIR, { recursive: true });
    await writeFile(`${SITES_DIR}/${row.siteId}.json`, `${JSON.stringify(config, null, 2)}\n`);

    return { outcome: 'generated', signupUrl: candidate.url, warnings };
  };

  // 1. Headless dene (ucuz).
  if (!opts.forceHeaded) {
    const page = await browser.newPage();
    try {
      const result = await attempt(page);
      if (result) return result;
    } catch (err) {
      logger.debug({ err: (err as Error).message }, 'headless deneme hatası');
    } finally {
      await page.close().catch(() => undefined);
    }
  }

  // 2. Headed dene — headless'ta form render etmeyen siteler için.
  const headed = await opts.headedBrowser();
  const page = await headed.newPage();
  try {
    const result = await attempt(page);
    if (result) return result;
    return { outcome: 'no_form', reason: 'Kayıt formu bulunamadı (headless+headed denendi)' };
  } catch (err) {
    return { outcome: 'error', reason: (err as Error).message.slice(0, 150) };
  } finally {
    await page.close().catch(() => undefined);
  }
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const limitArg = args.find((a) => a.startsWith('--limit'));
  const limit = limitArg ? Number(limitArg.split('=')[1] ?? args[args.indexOf(limitArg) + 1]) : 10;
  const siteFilter = args.includes('--site') ? args[args.indexOf('--site') + 1] : null;
  const forceHeaded = args.includes('--headed');
  const reset = args.includes('--reset');

  const progress = reset ? { entries: {} } : await loadProgress();
  if (reset) logger.info('İlerleme sıfırlandı');

  const sheet = await SheetClient.create(logger);
  if (!sheet) {
    console.error('❌ Sheet bağlanamadı — keşif Sheet gerektiriyor.');
    return;
  }

  const allRows = await sheet.readAll();
  const existingConfigs = new Set(await listSiteIds());

  const queue = allRows.filter((row) => {
    if (!row.siteId) return false;
    if (siteFilter) return row.siteId === siteFilter;
    if (progress.entries[row.siteId]) return false; // zaten işlendi
    if (existingConfigs.has(row.siteId)) return false; // config var
    return true;
  });

  const batch = queue.slice(0, limit);

  console.log(`\nSheet'te ${allRows.length} satır`);
  console.log(`Config'i olan: ${existingConfigs.size} · Daha önce işlenen: ${Object.keys(progress.entries).length}`);
  console.log(`Bu turda keşfedilecek: ${batch.length}\n`);

  if (batch.length === 0) {
    console.log('Keşfedilecek yeni site yok. --reset ile baştan başlayabilirsin.');
    return;
  }

  const headless = await chromium.launch({
    headless: true,
    args: ['--disable-blink-features=AutomationControlled'],
  });

  // Headed tarayıcı yalnızca gerekince açılır — 170 pencere açmamak için.
  const headedRef: { browser: Browser | null } = { browser: null };
  const headedBrowser = async (): Promise<Browser> => {
    headedRef.browser ??= await chromium.launch({
      headless: false,
      args: ['--disable-blink-features=AutomationControlled'],
    });
    return headedRef.browser;
  };

  const tally: Record<Outcome, number> = {
    generated: 0,
    high_risk: 0,
    no_form: 0,
    error: 0,
    skipped_existing: 0,
  };

  try {
    for (const [i, row] of batch.entries()) {
      process.stdout.write(`[${i + 1}/${batch.length}] ${row.siteId.padEnd(22)} `);

      const result = await discoverSite(headless, row, { forceHeaded, headedBrowser });
      tally[result.outcome]++;

      progress.entries[row.siteId] = {
        siteId: row.siteId,
        outcome: result.outcome,
        reason: result.reason,
        signupUrl: result.signupUrl,
        at: Date.now(),
      };
      await saveProgress(progress);

      // Sheet'e sonucu yaz — bulunamayanlar sessizce kaybolmasın.
      if (result.outcome === 'generated') {
        console.log(`✅ ${result.signupUrl?.slice(0, 60) ?? ''}`);
        if (result.warnings?.length) {
          for (const w of result.warnings) console.log(`      ⚠️  ${w}`);
        }
      } else {
        const icon = result.outcome === 'high_risk' ? '⛔' : '❌';
        console.log(`${icon} ${result.reason ?? result.outcome}`);
        await sheet
          .writeOutcome(row, { status: 'manual', note: result.reason ?? result.outcome })
          .catch(() => undefined);
      }

      if (i < batch.length - 1) await politePause();
    }
  } finally {
    await headless.close().catch(() => undefined);
    await headedRef.browser?.close().catch(() => undefined);
  }

  console.log(`\n── Keşif Özeti ──`);
  console.log(`   ✅ Taslak üretildi:  ${tally.generated}`);
  console.log(`   ⛔ Yüksek risk:      ${tally.high_risk}`);
  console.log(`   ❌ Form bulunamadı:  ${tally.no_form}`);
  console.log(`   ⚠️  Hata:             ${tally.error}`);
  console.log(`\nÜretilen taslaklar DOĞRULANMADI — run-batch bunları atlar.`);
  console.log(`Doğrulamak için: npm run cli -- run-one <siteId> --dry-run\n`);
}

main().catch((err: unknown) => {
  console.error('\n❌ Hata:', err instanceof Error ? err.message : err);
  process.exit(1);
});
