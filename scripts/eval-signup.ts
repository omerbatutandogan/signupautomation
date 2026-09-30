/**
 * Genel kayıt yeteneğini ölçer: sabit bir site setinde, config dosyası
 * ÖNCEDEN yazılmadan, elle-dokunmadan-başarı oranını hesaplar.
 *
 * Bu betik gerçek `runSite`'ı KULLANMIYOR — çünkü runSite `src/sites/`
 * altındaki bir dosyayı okumayı gerektiriyor ve 30 geçici config o
 * dizine yazılırsa gerçek configlerle karışma riski var. Bunun yerine
 * aynı adımları (keşif → form analizi → config üretimi → dry-run form
 * doldurma → otomatik kontrol) izole çalıştırır, hiçbir şeyi diske
 * yazmaz, hiçbir submit yapmaz.
 *
 * Kullanım:
 *   npx tsx scripts/eval-signup.ts --baseline
 *   npx tsx scripts/eval-signup.ts --compare data/eval-baseline.json
 */

import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { chromium, type Browser } from 'playwright';
import pino from 'pino';
import { findSignupPage } from '../src/discovery/find-signup.js';
import { analyzeForm } from '../src/discovery/analyze-form.js';
import { generateConfig } from '../src/discovery/generate-config.js';
import { makeGenericAdapter } from '../src/adapters/generic.js';
import { checkDryRunPage, canAutoVerify } from '../src/core/dry-run-check.js';
import { PermanentError, ManualReviewError } from '../src/core/errors.js';
import { createArtifacts } from '../src/core/artifacts.js';
import { signupEmail, usernameForSite } from '../src/identity/email.js';
import { derivePasswordForSite } from '../src/identity/password.js';
import { env } from '../src/config.js';
import { loadProfile } from '../src/identity/profile.js';
import { DEFAULT_PRODUCT } from '../src/identity/account.js';
import type { SignupContext, SignupProfile } from '../src/core/types.js';

const logger = pino({ level: env.LOG_LEVEL });

interface EvalSite {
  siteId: string;
  website: string;
  tab: string;
}

type SiteResult =
  | { siteId: string; website: string; outcome: 'completed'; issues: 0 }
  | { siteId: string; website: string; outcome: 'manual'; issues: number; reasons: string[] }
  | { siteId: string; website: string; outcome: 'no_form' }
  // "form yok"un ayrıştırılmış parçaları: sitede başka bir akış var ya
  // da site kapanmış.
  | { siteId: string; website: string; outcome: 'submit_form' | 'email_first' | 'dead'; reason?: string }
  | { siteId: string; website: string; outcome: 'bot_protected' }
  | { siteId: string; website: string; outcome: 'error'; message: string };

async function evalSite(browser: Browser, site: EvalSite, profile: SignupProfile): Promise<SiteResult> {
  const page = await browser.newPage();
  try {
    const search = await findSignupPage(page, site.website);
    if (search.kind === 'bot_protected') return { siteId: site.siteId, website: site.website, outcome: 'bot_protected' };
    if (search.kind === 'not_found') {
      const base = { siteId: site.siteId, website: site.website };
      if (search.reason) return { ...base, outcome: 'dead', reason: search.reason };
      if (search.hints?.includes('email_first')) return { ...base, outcome: 'email_first' };
      if (search.hints?.includes('submit_form')) return { ...base, outcome: 'submit_form' };
      return { ...base, outcome: 'no_form' };
    }

    const analysis = await analyzeForm(page);
    const { config, warnings } = generateConfig({
      id: site.siteId,
      name: site.siteId,
      website: site.website,
      candidate: search.candidate,
      analysis,
    });

    const blocking = warnings.filter((w) => w.startsWith('KULLANILAMAZ'));
    if (blocking.length > 0) {
      return { siteId: site.siteId, website: site.website, outcome: 'no_form' };
    }

    // Formu gerçekten doldur (submit ETMEDEN) — mevcut generic adapter
    // mantığının aynısı, izole çağrılıyor.
    const adapter = makeGenericAdapter(config);
    const artifacts = createArtifacts(page, `eval-${site.siteId}`, site.siteId);
    const identity = {
      email: signupEmail(env.SIGNUP_EMAIL),
      username: usernameForSite(env.SIGNUP_EMAIL, site.siteId),
      password: derivePasswordForSite(env.MASTER_SECRET, config, 1),
      passwordVersion: 1,
    };

    const ctx: SignupContext = {
      page,
      site: config,
      identity,
      profile,
      log: logger.child({ siteId: site.siteId }),
      artifacts,
      dryRun: true,
      requestHumanCaptcha: async () => {
        // Eval modunda insan devralma YOK — captcha çıkan site 'manual' sayılır.
        throw new Error('captcha: insan müdahalesi eval modunda desteklenmiyor');
      },
    };

    try {
      await adapter.signup(ctx);
    } catch (err) {
      // Config kalitesi sorunu (selector yok, alan eksik, bilinen bir
      // sınıflandırma) = manual, kod/altyapı hatası DEĞİL. İkisini
      // 'error' kovasına atmak "kaç site config kalitesi yüzünden
      // takıldı" sorusunu cevapsız bırakırdı.
      if (err instanceof PermanentError || err instanceof ManualReviewError) {
        return {
          siteId: site.siteId,
          website: site.website,
          outcome: 'manual',
          issues: 1,
          reasons: [err.message],
        };
      }
      throw err;
    }

    const issues = await checkDryRunPage(page, config);
    const ok = canAutoVerify(issues);

    if (ok) return { siteId: site.siteId, website: site.website, outcome: 'completed', issues: 0 };
    return {
      siteId: site.siteId,
      website: site.website,
      outcome: 'manual',
      issues: issues.length,
      reasons: issues.map((i) => i.detail),
    };
  } catch (err) {
    return { siteId: site.siteId, website: site.website, outcome: 'error', message: (err as Error).message.slice(0, 150) };
  } finally {
    await page.close().catch(() => undefined);
  }
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const isBaseline = args.includes('--baseline');
  const compareIdx = args.indexOf('--compare');
  const comparePath = compareIdx >= 0 ? args[compareIdx + 1] : null;

  const evalSet = JSON.parse(await readFile('data/eval-set.json', 'utf8')) as { sites: EvalSite[] };
  const profile = await loadProfile(DEFAULT_PRODUCT);

  const browser = await chromium.launch({
    headless: true,
    args: ['--disable-blink-features=AutomationControlled'],
  });

  const results: SiteResult[] = [];
  try {
    for (const [i, site] of evalSet.sites.entries()) {
      process.stdout.write(`[${i + 1}/${evalSet.sites.length}] ${site.siteId.padEnd(24)} `);
      const r = await evalSite(browser, site, profile);
      results.push(r);
      console.log(
        r.outcome === 'completed'
          ? '✅ completed'
          : r.outcome === 'manual'
            ? `🙋 manual (${r.issues} sorun)`
            : r.outcome === 'error'
              ? `⚠️ error: ${r.message}`
              : r.outcome === 'bot_protected'
                ? '🛡️ bot_protected'
                : `❌ ${r.outcome}`,
      );
    }
  } finally {
    await browser.close();
  }

  const tally: Record<string, number> = {};
  for (const r of results) tally[r.outcome] = (tally[r.outcome] ?? 0) + 1;

  console.log('\n── Sonuç ──');
  console.log(`   ✅ completed (sıfır elle müdahale):  ${tally.completed ?? 0}/${results.length}`);
  console.log(`   🙋 manual (elle müdahale gerekir):    ${tally.manual ?? 0}/${results.length}`);
  console.log(`   ❌ no_form:                            ${tally.no_form ?? 0}/${results.length}`);
  console.log(`      📨 submit_form (hesapsız gönderim):   ${tally.submit_form ?? 0}/${results.length}`);
  console.log(`      ✉️  email_first (kod/link girişi):     ${tally.email_first ?? 0}/${results.length}`);
  console.log(`      💀 dead (park/kapanmış):             ${tally.dead ?? 0}/${results.length}`);
  console.log(`   🛡️  bot_protected:                      ${tally.bot_protected ?? 0}/${results.length}`);
  console.log(`   ⚠️  error:                              ${tally.error ?? 0}/${results.length}`);

  await mkdir('data', { recursive: true });

  if (isBaseline) {
    await writeFile('data/eval-baseline.json', JSON.stringify({ at: Date.now(), results, tally }, null, 2));
    console.log('\ndata/eval-baseline.json yazıldı.');
  }

  if (comparePath) {
    const baseline = JSON.parse(await readFile(comparePath, 'utf8')) as { tally: Record<string, number> };
    console.log('\n── Başlangıç → Son ──');
    console.log(`   completed: ${baseline.tally.completed ?? 0} → ${tally.completed ?? 0}`);
    console.log(`   manual:    ${baseline.tally.manual ?? 0} → ${tally.manual ?? 0}`);
    console.log(`   no_form:   ${baseline.tally.no_form ?? 0} → ${tally.no_form ?? 0}`);
    // --out: önceki sonucun üzerine yazmamak için (varsayılan eski davranış).
    const outIdx = args.indexOf('--out');
    const outPath = (outIdx >= 0 ? args[outIdx + 1] : undefined) ?? 'data/eval-final.json';
    await writeFile(outPath, JSON.stringify({ at: Date.now(), results, tally }, null, 2));
    console.log(`\n${outPath} yazıldı.`);
  }
}

main().catch((err: unknown) => {
  console.error('\n❌ Hata:', err instanceof Error ? err.stack : err);
  process.exit(1);
});
