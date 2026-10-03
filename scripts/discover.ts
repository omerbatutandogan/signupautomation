/**
 * Toplu keşif: Sheet'teki siteler için config taslağı üretir.
 *
 * Kullanım:
 *   npm run discover -- --limit 20           # Sheet'ten 20 site
 *   npm run discover -- --limit 20 --headed  # gözlemlemek için
 *   npm run discover -- --site 10words       # tek site yeniden keşif
 *   npm run discover -- --retry-failed       # yalnızca redleri yeniden dene
 *   npm run discover -- --retry-errors       # yalnızca hataları (açılamayan tarayıcı, zaman aşımı)
 *   npm run discover -- --reset              # ilerlemeyi sıfırla
 *
 * Kesinti olursa data/discovery.json sayesinde kalınan yerden devam eder.
 */

import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { chromium, type Browser, type Page } from 'playwright';
import pino from 'pino';
import { env } from '../src/config.js';
import { SheetClient, type SheetRow } from '../src/integrations/sheet.js';
import { findSignupPage, type SignupHint } from '../src/discovery/find-signup.js';
import { analyzeForm } from '../src/discovery/analyze-form.js';
import { generateConfig, riskFor } from '../src/discovery/generate-config.js';
import { listSiteIds } from '../src/adapters/registry.js';
import {
  BOT_REASON,
  HINT_REASON,
  RETRYABLE,
  SiteTimeoutError,
  guardSite,
  settleWithin,
  shouldEnqueue,
  withSiteTimeout,
  type Outcome as QueueOutcome,
} from './discover-queue.js';

// Sekme başına ayrı ilerleme dosyası: tek dosya kullanılırsa sekme
// değiştirince önceki sekmenin işlenmiş siteleri "zaten işlendi" sanılıp
// yeni sekmenin siteleri atlanıyordu.
const PROGRESS_FILE = `data/discovery-${env.SHEET_TAB}.json`;
const SITES_DIR = 'src/sites';

const logger = pino({
  level: env.LOG_LEVEL,
  transport: {
    target: 'pino-pretty',
    options: { colorize: true, translateTime: 'HH:MM:ss', ignore: 'pid,hostname' },
  },
});

// Kuyruk kararları ve sonuç tipleri discover-queue.ts'de — saf mantık
// olarak ayrıldı, testleri orada.
type Outcome = QueueOutcome;

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

  const hints = new Set<SignupHint>();
  const noFormResult = (): SiteResult => {
    if (hints.has('email_first')) return { outcome: 'email_first', reason: HINT_REASON.email_first };
    if (hints.has('submit_form')) return { outcome: 'submit_form', reason: HINT_REASON.submit_form };
    return { outcome: 'no_form', reason: 'Kayıt formu bulunamadı (headless+headed denendi)' };
  };

  const attempt = async (page: Page): Promise<SiteResult | null> => {
    const search = await findSignupPage(page, row.website);

    // Bot duvarı: headless'ta çıkıp headed'da çıkmayabilir, bu yüzden
    // burada SONUÇ döndürülmüyor — çağıran katman headed denemesini de
    // yaptıktan sonra karar veriyor.
    if (search.kind === 'bot_protected') return { outcome: 'bot_protected', reason: BOT_REASON };
    // Sebepli "yok" (park edilmiş domain, platforma yönlenme) kesin sonuç:
    // headed denemesi bunu değiştirmez, sebebiyle kaydedilir.
    if (search.kind === 'not_found') {
      if (search.reason) return { outcome: 'no_form', reason: search.reason };
      // İpuçları biriktirilir: headed kayıt formunu bulabilir, bulamazsa
      // sonuç "form yok" yerine görülen akış olur.
      for (const h of search.hints ?? []) hints.add(h);
      return null;
    }

    const candidate = search.candidate;
    const analysis = await analyzeForm(page);
    const { config, warnings } = generateConfig({
      id: row.siteId,
      name: row.name || row.siteId,
      website: row.website,
      candidate,
      analysis,
    });

    // KULLANILAMAZ işaretli config'i dosyaya YAZMA: e-postasız veya
    // şifresiz form kayıt formu değil (bülten/demo/ürün gönderimi).
    // Yazmak yalnızca karışıklık yaratır, sonra elle silmek gerekir.
    const blocking = warnings.filter((w) => w.startsWith('KULLANILAMAZ'));
    if (blocking.length > 0) {
      return {
        outcome: 'no_form',
        reason: blocking.map((w) => w.replace('KULLANILAMAZ: ', '')).join(' | '),
      };
    }

    await mkdir(SITES_DIR, { recursive: true });
    await writeFile(`${SITES_DIR}/${row.siteId}.json`, `${JSON.stringify(config, null, 2)}\n`);

    return { outcome: 'generated', signupUrl: candidate.url, warnings };
  };

  // Headless'ta bot duvarı görüldüyse hatırla ama hemen pes etme:
  // gerçek tarayıcı duvarı aşabiliyor (Cloudflare headless'ı daha sert
  // eliyor). Headed de duvara çarparsa sonuç bot_protected olur.
  let botWalled = false;

  // 1. Headless dene (ucuz).
  if (!opts.forceHeaded) {
    const page = await browser.newPage();
    try {
      const result = await withSiteTimeout(attempt(page), () => page.close());
      if (result?.outcome === 'bot_protected') botWalled = true;
      else if (result) return result;
    } catch (err) {
      // Zaman aşımında headed'a geçme: aynı site ikinci kez dakikalarca
      // bekletir. Hata olarak kaydedilir, --retry-failed yeniden dener.
      if (err instanceof SiteTimeoutError) return { outcome: 'error', reason: err.message };
      logger.debug({ err: (err as Error).message }, 'headless deneme hatası');
    } finally {
      await settleWithin(page.close(), 15_000);
    }
  }

  // 2. Headed dene — headless'ta form render etmeyen siteler için.
  const headed = await opts.headedBrowser();
  const page = await headed.newPage();
  try {
    const result = await withSiteTimeout(attempt(page), () => page.close());
    if (result?.outcome === 'bot_protected') {
      return { outcome: 'bot_protected', reason: BOT_REASON };
    }
    if (result) return result;
    // Headed form bulamadı: headless'ta duvar gördüysek sebep "form yok"
    // değil, duvarın arkasını göremememiz.
    if (botWalled) return { outcome: 'bot_protected', reason: BOT_REASON };
    return noFormResult();
  } catch (err) {
    if (err instanceof SiteTimeoutError) return { outcome: 'error', reason: err.message };
    if (botWalled) return { outcome: 'bot_protected', reason: BOT_REASON };
    return { outcome: 'error', reason: (err as Error).message.slice(0, 150) };
  } finally {
    await settleWithin(page.close(), 15_000);
  }
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const limitArg = args.find((a) => a.startsWith('--limit'));
  const limit = limitArg ? Number(limitArg.split('=')[1] ?? args[args.indexOf(limitArg) + 1]) : 10;
  const siteFilter = args.includes('--site') ? args[args.indexOf('--site') + 1] : null;
  const forceHeaded = args.includes('--headed');
  const reset = args.includes('--reset');
  const retryFailed = args.includes('--retry-failed');
  const retryErrors = args.includes('--retry-errors');

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

    if (!shouldEnqueue(progress.entries[row.siteId]?.outcome, retryFailed, retryErrors)) return false;
    if (existingConfigs.has(row.siteId)) return false; // config var
    return true;
  });

  const batch = queue.slice(0, limit);

  console.log(`\nSheet'te ${allRows.length} satır`);
  console.log(`Config'i olan: ${existingConfigs.size} · Daha önce işlenen: ${Object.keys(progress.entries).length}`);
  if (retryFailed) {
    const n = Object.values(progress.entries).filter((e) => RETRYABLE.has(e.outcome)).length;
    console.log(`--retry-failed: ${n} başarısız kayıt yeniden kuyrukta`);
  }
  console.log(`Bu turda keşfedilecek: ${batch.length}\n`);

  if (batch.length === 0) {
    console.log('Keşfedilecek yeni site yok. --retry-failed ile redleri, --reset ile hepsini yeniden dener.');
    return;
  }

  const launchHeadless = (): Promise<Browser> =>
    chromium.launch({ headless: true, args: ['--disable-blink-features=AutomationControlled'] });
  // Bekçi takılan tarayıcıyı atıp yenisini açabilsin diye `let`.
  let headless = await launchHeadless();

  // Headed tarayıcı yalnızca gerekince açılır — 170 pencere açmamak için.
  // Tarayıcı değil AÇILIŞ saklanıyor: bekçi takılmış bir açılışı bıraktığında
  // geç tamamlanan açılış eski referansı ezip pencere sızdırıyordu; kurtarma
  // artık açılış ne zaman biterse o tarayıcıyı kapatıyor.
  const headedRef: { launching: Promise<Browser> | null } = { launching: null };
  const headedBrowser = async (): Promise<Browser> => {
    if (!headedRef.launching) {
      const launching: Promise<Browser> = chromium
        .launch({ headless: false, args: ['--disable-blink-features=AutomationControlled'] })
        .catch((err: unknown) => {
          // Başarısız açılış saklanmasın — yoksa sonraki her deneme aynı
          // hatayı alır. Yalnızca hâlâ güncel açılışsa temizle: bekçinin
          // bıraktığı eski açılışın geç hatası yenisini silmesin.
          if (headedRef.launching === launching) headedRef.launching = null;
          throw err;
        });
      headedRef.launching = launching;
    }
    const browser = await headedRef.launching;
    if (browser.isConnected()) return browser;
    headedRef.launching = null;
    return headedBrowser();
  };
  // Bağlantısı kopmuş headless yeniden açılır (kurtarmada açılış başarısız
  // olduysa sonraki site "Target closed" ile düşmesin).
  const getHeadless = async (): Promise<Browser> => {
    if (!headless.isConnected()) headless = await launchHeadless();
    return headless;
  };

  const tally: Record<Outcome, number> = {
    generated: 0,
    high_risk: 0,
    bot_protected: 0,
    no_form: 0,
    submit_form: 0,
    email_first: 0,
    error: 0,
    skipped_existing: 0,
  };

  try {
    for (const [i, row] of batch.entries()) {
      process.stdout.write(`[${i + 1}/${batch.length}] ${row.siteId.padEnd(22)} `);

      // Sitenin tamamına bekçi: denemeler kendi sınırında ama açma/kapama
      // adımları değil — financesonline'da tarama 12 saat takıldı.
      const result = await guardSite<SiteResult>(
        (async () => discoverSite(await getHeadless(), row, { forceHeaded, headedBrowser }))(),
        async () => {
          // Takılan tarayıcıları at, temiz başla. Headed açılışı henüz
          // bitmemişse bittiğinde kapatılır (sızıntı yok).
          const oldHeaded = headedRef.launching;
          headedRef.launching = null;
          if (oldHeaded) void oldHeaded.then((b) => b.close()).catch(() => undefined);
          const stuck = headless;
          await settleWithin(stuck.close(), 15_000);
          const fresh = await launchHeadless();
          // Açılış kurtarma süresini aşıp geç bittiyse getHeadless() çoktan
          // yenisini açmış olabilir — onu ezme, fazlasını kapat.
          if (headless === stuck) headless = fresh;
          else void fresh.close().catch(() => undefined);
        },
        (reason) => ({ outcome: 'error', reason }),
      );
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
        const icon =
          result.outcome === 'high_risk' ? '⛔' : result.outcome === 'bot_protected' ? '🛡️' : '❌';
        console.log(`${icon} ${result.reason ?? result.outcome}`);
        // googleapis isteklerinde varsayılan süre sınırı yok.
        await settleWithin(
          sheet.writeOutcome(row, { status: 'manual', note: result.reason ?? result.outcome }),
          30_000,
        );
      }

      if (i < batch.length - 1) await politePause();
    }
  } finally {
    await settleWithin(headless.close(), 15_000);
    if (headedRef.launching) await settleWithin(headedRef.launching.then((b) => b.close()), 15_000);
  }

  console.log(`\n── Keşif Özeti ──`);
  console.log(`   ✅ Taslak üretildi:  ${tally.generated}`);
  console.log(`   ⛔ Yüksek risk:      ${tally.high_risk}`);
  console.log(`   🛡️  Bot koruması:     ${tally.bot_protected}`);
  console.log(`   ❌ Form bulunamadı:  ${tally.no_form}`);
  console.log(`   📨 Gönderim formu:   ${tally.submit_form}  (hesapsız "sitenizi gönderin")`);
  console.log(`   ✉️  E-postayla giriş: ${tally.email_first}  (kod/link — henüz desteklenmiyor)`);
  console.log(`   ⚠️  Hata:             ${tally.error}`);
  if (tally.bot_protected > 0) {
    console.log(`\nBot korumalı siteler otomasyona uygun değil — elle açılmalı.`);
  }
  console.log(`\nÜretilen taslaklar DOĞRULANMADI — run-batch bunları atlar.`);
  console.log(`Doğrulamak için: npm run cli -- run-one <siteId> --dry-run\n`);
}

// İş bitince AÇIKÇA çık. Bekçinin bıraktığı işler (zaman aşımındaki siteler)
// açık bir bağlantı ya da süresiz bir Google API isteği bırakabiliyor; Node
// bunları beklerse süreç kapanmaz. Gerçek vaka (2026-10-02): Local sekmesi
// bittikten sonra süreç 28 saat boşta kaldı, tarama sonraki sekmeye geçemedi.
// İlerleme her siteden sonra diske yazıldığı için burada çıkmak güvenli.
main()
  .then(() => process.exit(0))
  .catch((err: unknown) => {
    console.error('\n❌ Hata:', err instanceof Error ? err.message : err);
    process.exit(1);
  });
