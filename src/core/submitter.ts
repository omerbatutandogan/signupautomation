/**
 * Ürünü bir sitenin listeleme formuna girer (hesap ZATEN açılmış olmalı).
 *
 * Sıra: kapılar → kilit → giriş → form adımları → (dry-run: denetle | gerçek: gönder ve
 * başarıyı doğrula). Gerçek gönderim ürünü HERKESE AÇIK yayınlar; bu yüzden varsayılan
 * dry-run'dır ve gerçek gönderim için profil içeriğinin insan onayı gerekir
 * (core/listing-approval.ts).
 */

import { randomUUID } from 'node:crypto';
import type { Logger } from 'pino';
import type { Page } from 'playwright';
import { env } from '../config.js';
import { makeGenericAdapter } from '../adapters/generic.js';
import { loadSiteConfig } from '../adapters/registry.js';
import { loadSubmissionConfig } from '../adapters/submission-registry.js';
import type { ValidatedSubmissionConfig } from '../adapters/submission-schema.js';
import { accountKey, DEFAULT_PRODUCT } from '../identity/account.js';
import { loadProfile } from '../identity/profile.js';
import { derivePasswordForSite } from '../identity/password.js';
import type { Ledger } from '../integrations/ledger.js';
import { createArtifacts } from './artifacts.js';
import { launchContext } from './browser.js';
import { canAutoVerify, checkDryRunPage } from './dry-run-check.js';
import { listingApproval, APPROVAL_DIR } from './listing-approval.js';
import { makeCaptchaHandler } from './runner.js';
import type { SignupContext, SiteConfig, SiteId } from './types.js';

export type SubmitStatus =
  | 'completed'
  | 'unconfirmed'
  | 'failed'
  | 'manual'
  | 'error'
  | 'skipped_no_account'
  | 'skipped_not_approved'
  | 'skipped_done'
  | 'skipped_locked'
  | 'skipped_high_risk';

export interface SubmitOutcome {
  status: SubmitStatus;
  note?: string;
  listingUrl?: string;
  artifactsDir?: string;
}

export interface SubmitOptions {
  log: Logger;
  ledger: Ledger;
  /** Varsayılan true'ya CLI karar verir; burada açıkça verilmeli. */
  dryRun: boolean;
  /** Daha önce tamamlanmış gerçek gönderimi yeniden dene. */
  force?: boolean;
  productId?: string;
  runId?: string;
  /** Testler için: tarayıcıyı dışarıdan ver. */
  launch?: (key: string, opts: { ephemeral: boolean }) => Promise<{ page: Page; close(): Promise<void> }>;
  /** Testler için config / onay dizinleri. */
  submissionsDir?: string;
  approvalDir?: string;
}

export async function submitListing(siteId: SiteId, opts: SubmitOptions): Promise<SubmitOutcome> {
  const runId = opts.runId ?? randomUUID().slice(0, 8);
  const productId = opts.productId ?? DEFAULT_PRODUCT;
  const key = accountKey(productId, siteId);
  const log = opts.log.child({ siteId, productId, runId, flow: 'submission' });
  const { ledger } = opts;

  // ── Kapılar (ağdan ÖNCE) ────────────────────────────────────────────────
  let config: ValidatedSubmissionConfig;
  try {
    config = await loadSubmissionConfig(siteId, opts.submissionsDir);
  } catch (err) {
    return { status: 'failed', note: (err as Error).message };
  }

  // Kayıt config'i varsa onun riski geçerli: ToS otomatik erişimi yasaklıyorsa listeleme de yok.
  const signupConfig = await loadSiteConfig(siteId).catch(() => null);
  if (signupConfig?.risk === 'high') {
    return { status: 'skipped_high_risk', note: 'ToS otomatik erişimi yasaklıyor' };
  }

  let profile;
  try {
    profile = await loadProfile(productId);
  } catch (err) {
    return { status: 'failed', note: (err as Error).message };
  }

  // Hesap şart: listeleme açılmış bir hesapla yapılır, kayıt AÇMAZ.
  const account = ledger.terminalResult(key);
  const credentials = ledger.credentials(key);
  if (!account || account.status !== 'completed' || !credentials) {
    return { status: 'skipped_no_account', note: `${key} için açılmış hesap yok — önce kayıt (run-one ${siteId})` };
  }
  if (/şifre kullanıcıda/i.test(account.note ?? '')) {
    // Hesap sistemden önce vardı; türetilen şifre ÇALIŞMAZ, otomatik giriş yapılamaz.
    return { status: 'manual', note: 'Hesabın şifresi kullanıcıda (türetilen şifre geçerli değil): otomatik giriş yapılamaz' };
  }

  if (!opts.dryRun) {
    const approval = await listingApproval(productId, profile, opts.approvalDir ?? APPROVAL_DIR);
    if (!approval.ok) {
      const why =
        approval.reason === 'changed'
          ? 'ürün profili onaydan sonra DEĞİŞMİŞ'
          : approval.reason === 'missing'
            ? 'ürün bilgisi henüz onaylanmamış'
            : 'onay kaydı okunamadı';
      return {
        status: 'skipped_not_approved',
        note: `Herkese açık listeleme için ${why} — profili gözden geçirip onayla: approve-profile ${productId}`,
      };
    }
    const done = ledger.liveSubmission(key);
    if (done && !opts.force) {
      return {
        status: 'skipped_done',
        note:
          done.status === 'completed'
            ? `zaten listelendi${done.listing_url ? `: ${done.listing_url}` : ''} (--force ile aşılır)`
            : 'önceki gönderimin sonucu doğrulanamadı, yayınlanmış olabilir — elle kontrol et (--force ile aşılır)',
      };
    }
  }

  // ── Kilit + kayıt ───────────────────────────────────────────────────────
  const lockKey = `${key}#submit`;
  if (!ledger.tryClaim(lockKey, runId)) {
    return { status: 'skipped_locked', note: 'bu hesapta başka bir listeleme çalışıyor' };
  }
  const submissionId = ledger.startSubmission(key, runId, opts.dryRun);
  let outcome: SubmitOutcome = { status: 'error' };
  let browser: Awaited<ReturnType<NonNullable<SubmitOptions['launch']>>> | null = null;

  try {
    const launch = opts.launch ?? ((k, o) => launchContext(k, { ephemeral: o.ephemeral }));
    browser = await launch(key, { ephemeral: opts.dryRun });
    const page = browser.page;
    const artifacts = createArtifacts(page, runId, `${key}-submit`);
    outcome.artifactsDir = artifacts.dir;

    const identity = {
      email: credentials.email,
      username: credentials.username,
      password: derivePasswordForSite(env.MASTER_SECRET, { id: key, passwordPolicy: signupConfig?.passwordPolicy }, credentials.pw_version),
      passwordVersion: credentials.pw_version,
    };

    const synthetic = (url: string, steps: SiteConfig['steps']): SiteConfig =>
      ({
        id: siteId,
        name: config.name,
        risk: 'low',
        signupUrl: url,
        emailLocalPart: siteId,
        steps,
        verification: { mode: 'none' },
      }) as SiteConfig;

    const context = (site: SiteConfig, dryRun: boolean): SignupContext => ({
      page,
      site,
      identity,
      profile,
      log,
      artifacts,
      dryRun,
      requestHumanCaptcha: makeCaptchaHandler(page, log),
    });

    // ── Giriş ─────────────────────────────────────────────────────────────
    await page.goto(config.listingUrl, { waitUntil: 'domcontentloaded', timeout: 30_000 });
    const isLoggedIn = async (waitMs = 0): Promise<boolean> => {
      if (!config.loggedIn) return false;
      const marker = page.locator(config.loggedIn).first();
      if (waitMs > 0) await marker.waitFor({ state: 'visible', timeout: waitMs }).catch(() => undefined);
      return marker.isVisible().catch(() => false);
    };
    // Kalıcı tarayıcı profili önceki oturumu taşıyabilir: önce kısaca bak, yoksa giriş yap.
    if (!(await isLoggedIn(2_000)) && config.login) {
      log.info('Oturum yok — giriş yapılıyor');
      // GİRİŞ bir yayın değildir (kendi hesabımıza oturum açıyoruz): dry-run'da bile giriş
      // adımları (tıklamalar dahil) çalışır, yoksa form hiç görünmezdi. Ama dry-run'ın
      // "captcha çözme/insan bekleme yok" kuralı korunur: captchaGate adımları ayıklanır.
      const loginSteps = (config.login.steps as SiteConfig['steps']).filter((st) => !(opts.dryRun && st.type === 'captchaGate'));
      const loginSite = synthetic(config.login.url, loginSteps);
      await makeGenericAdapter(loginSite).signup(context(loginSite, false));
      await page.goto(config.listingUrl, { waitUntil: 'domcontentloaded', timeout: 30_000 });
      if (config.loggedIn && !(await isLoggedIn(8_000))) {
        await artifacts.shot('login-failed');
        outcome = { status: 'manual', note: 'Giriş yapılamadı (oturum işareti görünmedi) — şifre/akış kontrol edilmeli', artifactsDir: artifacts.dir };
        return outcome;
      }
    }

    // ── Form ──────────────────────────────────────────────────────────────
    const formSite = synthetic(config.listingUrl, config.steps as SiteConfig['steps']);
    await makeGenericAdapter(formSite).signup(context(formSite, opts.dryRun));

    if (opts.dryRun) {
      const shot = await artifacts.shot('submission-filled');
      const issues = await checkDryRunPage(page, formSite);
      for (const i of issues) log.warn({ kind: i.kind, selector: i.selector }, i.detail);
      const ok = canAutoVerify(issues);
      outcome = {
        status: ok ? 'completed' : 'manual',
        note: ok ? `dry-run${issues.length ? ` (${issues.length} uyarı)` : ''} — gönderilmedi` : `dry-run BAŞARISIZ: ${issues.map((i) => i.detail).join(' | ')}`,
        artifactsDir: artifacts.dir,
      };
      log.info({ shot, issues: issues.length, ok }, 'DRY-RUN listeleme tamamlandı');
      return outcome;
    }

    // ── Gerçek gönderim: başarıyı doğrula ─────────────────────────────────
    const confirmed = await waitForSuccess(page, config.success);
    if (confirmed) {
      outcome = { status: 'completed', listingUrl: page.url(), note: `onaylandı (${confirmed})`, artifactsDir: artifacts.dir };
    } else {
      await artifacts.shot('submission-unconfirmed');
      await artifacts.html('submission-unconfirmed');
      outcome = {
        status: 'unconfirmed',
        note: 'Gönderildi ama başarı işareti görünmedi — elle kontrol edilmeli (yayınlanmış olabilir; otomatik tekrar denenmez)',
        listingUrl: page.url(),
        artifactsDir: artifacts.dir,
      };
    }
    return outcome;
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    log.error({ err: message }, 'Listeleme başarısız');
    // GERÇEK gönderimde hata, formun gönderilip gönderilmediğini bilmediğimiz bir noktada olabilir
    // (tıklamadan sonra zaman aşımı gibi): yayınlanmış olabilir, otomatik yeniden deneme çift
    // listeleme yapardı. Hiçbir şey gönderilmemiş olduğu KESİN hatalar (öğe bulunamadı, sayfa
    // yüklenmedi) 'failed' kalır ve yeniden denenebilir; gerisi 'unconfirmed' olur.
    const notSent = /Selector bulunamadı|Sayfa yüklenmedi|page\.goto|net::ERR/.test(message);
    if (!opts.dryRun && !notSent) {
      outcome = {
        status: 'unconfirmed',
        note: `gönderim sırasında hata, yayınlanmış olabilir — elle kontrol et: ${message}`,
        artifactsDir: outcome.artifactsDir,
      };
    } else {
      outcome = { status: 'failed', note: message, artifactsDir: outcome.artifactsDir };
    }
    return outcome;
  } finally {
    ledger.finishSubmission(submissionId, outcome.status, outcome.note, outcome.listingUrl);
    ledger.release(lockKey);
    await browser?.close().catch(() => undefined);
  }
}

/** Başarı işaretlerinden biri görünene/uyana kadar bekler; hangisinin uyduğunu döner. */
async function waitForSuccess(
  page: Page,
  success: ValidatedSubmissionConfig['success'],
  timeoutMs = 15_000,
): Promise<string | null> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    for (const fragment of success.urlContains ?? []) {
      if (page.url().includes(fragment)) return `url:${fragment}`;
    }
    for (const selector of success.anyOf ?? []) {
      if (await page.locator(selector).first().isVisible().catch(() => false)) return `görünür:${selector}`;
    }
    await page.waitForTimeout(500);
  }
  return null;
}
