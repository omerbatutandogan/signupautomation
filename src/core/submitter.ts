/**
 * Ürünü bir sitenin listeleme formuna girer (hesap ZATEN açılmış olmalı).
 *
 * Sıra: kapılar → kilit → giriş → form adımları → (dry-run: denetle | gerçek: gönder ve
 * başarıyı doğrula). Gerçek gönderim ürünü HERKESE AÇIK yayınlar; bu yüzden varsayılan
 * dry-run'dır ve gerçek gönderim için profil içeriğinin (logo dosyaları dahil) insan onayı
 * gerekir (core/listing-approval.ts).
 *
 * İki ilke her şeyin önündedir:
 *  - ÇİFT YAYIN YOK: gönderimin yapılmış OLABİLECEĞİ andan sonra (ilk gerçek tıklama ya da
 *    siteye giden ilk yazan istek) hiçbir hata 'failed' (yeniden denenebilir) sayılmaz;
 *    sonuç 'unconfirmed' olur ve ancak --force ile aşılır.
 *  - DRY-RUN HİÇBİR ŞEY YAYINLAMAZ: tıklamalar atlanır VE tarayıcı düzeyinde, girişin kendisi
 *    dışında hiçbir yazan (POST/PUT/...) istek dışarı çıkamaz; böylece tıklamasız tetiklenen
 *    gönderimler de (`onchange="form.submit()"` gibi) durdurulur.
 */

import { randomUUID } from 'node:crypto';
import { posix } from 'node:path';
import type { Logger } from 'pino';
import type { Page, Request, Route } from 'playwright';
import { env } from '../config.js';
import { runSteps, type StepHooks } from '../adapters/generic.js';
import { loadSiteConfig } from '../adapters/registry.js';
import { loadSubmissionConfig } from '../adapters/submission-registry.js';
import type { ValidatedSubmissionConfig } from '../adapters/submission-schema.js';
import { accountKey, DEFAULT_PRODUCT } from '../identity/account.js';
import { loadProfile } from '../identity/profile.js';
import { derivePasswordForSite } from '../identity/password.js';
import type { Ledger } from '../integrations/ledger.js';
import { registrableDomain } from '../integrations/mail-parse.js';
import { captureFailure, createArtifacts } from './artifacts.js';
import { launchContext } from './browser.js';
import { canAutoVerify, checkDryRunPage } from './dry-run-check.js';
import { PermanentError } from './errors.js';
import { APPROVAL_DIR, assetFingerprints, listingApproval } from './listing-approval.js';
import { makeCaptchaHandler } from './runner.js';
import type { Artifacts, SignupContext, SiteConfig, SiteId } from './types.js';

export type SubmitStatus =
  | 'completed'
  | 'unconfirmed'
  | 'failed'
  | 'manual'
  | 'error'
  | 'skipped_no_account'
  | 'skipped_not_approved'
  | 'skipped_done'
  | 'skipped_unverified'
  | 'skipped_locked'
  | 'skipped_high_risk'
  | 'skipped_daily_limit';

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
  /** Daha önce tamamlanmış (ya da sonucu doğrulanamamış) gerçek gönderimi yeniden dene. */
  force?: boolean;
  productId?: string;
  runId?: string;
  /** Testler için: tarayıcıyı dışarıdan ver. */
  launch?: (key: string, opts: { ephemeral: boolean }) => Promise<{ page: Page; close(): Promise<void> }>;
  /** Testler için config / onay / logo dizinleri. */
  submissionsDir?: string;
  approvalDir?: string;
  assetsDir?: string;
  /** Testler için kayıt config'i: verilmezse src/sites'tan yüklenir, `null` = yok. */
  signupConfig?: SiteConfig | null;
}

type Phase = 'prepare' | 'login' | 'form';

interface BlockedRequest {
  method: string;
  url: string;
  phase: Phase;
  /** İstek ürün bilgisini bir yere GÖNDERİYOR gibi mi (bkz. looksLikeSubmission)? */
  submission: boolean;
}

/** Bir çalıştırmanın akış durumu: istek korumasının ve hata sınıflandırmasının ortak bilgisi. */
interface RunState {
  phase: Phase;
  /** Gönderim artık YAPILMIŞ OLABİLİR (ilk gerçek form tıklaması / siteye giden yazan istek). */
  maybeSent: boolean;
  blocked: BlockedRequest[];
}

const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);
const isMutating = (method: string): boolean => !SAFE_METHODS.has(method.toUpperCase());

/**
 * Alt alan adlarının FARKLI sahiplere ait olduğu barındırma alan adları: orada "aynı kayıtlanabilir
 * alan adı" aynı site demek değil (a.vercel.app ile b.vercel.app ilgisiz). Bu alan adlarında tam
 * ana makine adı eşleşmesi aranır.
 */
const SHARED_HOSTING = new Set([
  'vercel.app', 'github.io', 'netlify.app', 'herokuapp.com', 'pages.dev', 'workers.dev', 'web.app',
  'firebaseapp.com', 'onrender.com', 'fly.dev', 'blogspot.com', 'wordpress.com', 'tumblr.com', 'wixsite.com',
]);

/** `url`, kayıt sitesiyle (`signupUrl`) AYNI site mi? Şifre yalnızca burada yazılabilir. */
export function belongsToSite(url: string, signupUrl: string): boolean {
  try {
    const home = registrableDomain(signupUrl);
    if (home === '') return false;
    if (SHARED_HOSTING.has(home)) return new URL(url).hostname.toLowerCase() === new URL(signupUrl).hostname.toLowerCase();
    return registrableDomain(url) === home;
  } catch {
    return false;
  }
}

/** İstek gövdesi: ham hâli ve URL-çözülmüş hâli (form kodlaması `https%3A%2F%2F…` yazar). */
function postBody(req: Request): string {
  let raw = '';
  try {
    raw = req.postData() ?? '';
  } catch {
    return '';
  }
  let decoded = raw;
  try {
    decoded = decodeURIComponent(raw.replace(/\+/g, ' '));
  } catch {
    /* çözülemeyen gövde ham hâliyle aranır */
  }
  return `${raw}\n${decoded}`;
}

/**
 * Bu yazan istek ürünü bir yere GÖNDERİYOR olabilir mi? Evet: sayfa gezintisi olan POST'lar (form
 * gönderimi, hangi siteye olursa olsun) ya da gövdesinde yayınlanacak ürün bilgisi (ad/adres) geçen
 * istekler (XHR/fetch ile gönderim). Hayır: analitik / güvenlik betiklerinin işaretleri
 * (ör. Cloudflare `/cdn-cgi/…` POST'u) — bunlar "gönderildi" sayılırsa yeniden denenebilir hatalar
 * sürekli `unconfirmed` olur ve --force'a itilirdi.
 */
function looksLikeSubmission(req: Request, publishedValues: readonly string[]): boolean {
  if (!isMutating(req.method())) return false;
  if (req.isNavigationRequest()) return true;
  const body = postBody(req);
  return publishedValues.some((v) => body.includes(v));
}

/** İstek `pageUrl` adresindeki sayfadan mı çıktı? (origin + yol; sorgu/hash yok sayılır.) */
function isFromPage(req: Request, pageUrl: string | undefined): boolean {
  if (!pageUrl) return false;
  try {
    const from = new URL(req.frame().url());
    const page = new URL(pageUrl);
    return from.origin === page.origin && from.pathname === page.pathname;
  } catch {
    return false; // service worker isteği gibi çerçevesi olmayan istek: izin verme
  }
}

/**
 * Listeleme adımları için kayıt-biçimli site tanımı. Risk ve captcha tercihi KAYIT
 * config'inden miras alınır; kayıt config'i yoksa kapalı-güvenli varsayılan: orta risk,
 * captcha çözümü KAPALI. (Sabit `risk:'low'` yazmak, kayıtta kapatılmış captcha çözümünü
 * listeleme formunda sessizce yeniden açıyordu.)
 */
export function listingSiteConfig(args: {
  siteId: SiteId;
  name: string;
  signupConfig: SiteConfig | null;
  url: string;
  steps: SiteConfig['steps'];
}): SiteConfig {
  const { signupConfig } = args;
  return {
    id: args.siteId,
    name: args.name,
    risk: signupConfig?.risk ?? 'medium',
    solveCaptcha: signupConfig ? signupConfig.solveCaptcha : false,
    signupUrl: args.url,
    emailLocalPart: args.siteId,
    steps: args.steps,
    verification: { mode: 'none' },
  } as SiteConfig;
}

/** Dry-run'da form tıklanmadan kendiliğinden yazan istek atmaya çalıştıysa (engellendi) açıklaması. */
function attemptedSubmitNote(state: RunState): string | null {
  const attempted = state.blocked.filter((b) => b.phase === 'form' && b.submission);
  if (attempted.length === 0) return null;
  const where = attempted
    .slice(0, 3)
    .map((b) => `${b.method} ${new URL(b.url).pathname}`)
    .join(', ');
  return `form tıklanmadan kendiliğinden göndermeye çalıştı, engellendi (${where})`;
}

/** Betikler için çıkış kodu: yalnızca gerçekten listelenmiş (ya da zaten listelenmiş) olmak 0'dır. */
export function submitExitCode(status: SubmitStatus): number {
  return status === 'completed' || status === 'skipped_done' ? 0 : 1;
}

function skippedDone(done: NonNullable<ReturnType<Ledger['liveSubmission']>>): SubmitOutcome {
  // "Zaten listelendi" ile "belki listelendi, elle bak" farklı şeylerdir: betikler ayırt edebilsin.
  return done.status === 'completed'
    ? { status: 'skipped_done', note: `zaten listelendi${done.listing_url ? `: ${done.listing_url}` : ''} (--force ile aşılır)` }
    : {
        status: 'skipped_unverified',
        note: `önceki gönderimin sonucu doğrulanamadı (${done.status}), yayınlanmış olabilir — elle kontrol et (--force ile aşılır)`,
      };
}

/** Yükleme adımlarının dosyaları yalnızca onaylanmış logo dosyaları olabilir (başka dosya sızdırılamaz). */
function unapprovedUploads(steps: ReadonlyArray<{ type: string; file?: string }>, profile: { logo?: Record<string, string> }): string[] {
  const approved = new Set(Object.values(profile.logo ?? {}).map((f) => posix.normalize(f)));
  return steps
    .filter((st) => st.type === 'upload' && st.file !== undefined)
    .map((st) => posix.normalize(st.file as string))
    .filter((f) => !approved.has(f));
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

  // Kayıt config'i: ToS riski, captcha tercihi ve şifre politikası oradan gelir.
  const signupConfig: SiteConfig | null =
    opts.signupConfig !== undefined ? opts.signupConfig : await loadSiteConfig(siteId).catch(() => null);
  if (signupConfig?.risk === 'high') {
    return { status: 'skipped_high_risk', note: 'ToS otomatik erişimi yasaklıyor' };
  }
  // Gerçek gönderim için de, şifre yazılacaksa (giriş adımı varsa) dry-run için de şart: risk, captcha
  // tercihi, şifre politikası ve — en önemlisi — şifrenin yazılabileceği alan adı oradan doğrulanır.
  if (!signupConfig && (!opts.dryRun || config.login)) {
    return {
      status: 'failed',
      note: `${opts.dryRun ? 'Giriş yapan' : 'Gerçek'} listeleme için kayıt config'i (src/sites/${siteId}.json) gerekli: risk, captcha tercihi, şifre politikası ve şifrenin yazılacağı alan adı oradan doğrulanır`,
    };
  }
  if (signupConfig) {
    // Türetilen şifre yalnızca bu sitenin kendi alan adına yazılır: listeleme/giriş adresi
    // başka bir siteye işaret ediyorsa (config hatası ya da kötü niyet) hiçbir şey açılmaz.
    const foreign = [config.listingUrl, config.login?.url].filter((u): u is string => Boolean(u) && !belongsToSite(u as string, signupConfig.signupUrl));
    if (foreign.length > 0) {
      return { status: 'failed', note: `Listeleme/giriş adresi kayıt sitesinin alan adında değil (${registrableDomain(signupConfig.signupUrl) || '?'}): ${foreign.join(', ')}` };
    }
  }

  let profile;
  try {
    profile = await loadProfile(productId);
  } catch (err) {
    return { status: 'failed', note: (err as Error).message };
  }

  const strayUploads = unapprovedUploads([...(config.login?.steps ?? []), ...config.steps], profile);
  if (strayUploads.length > 0) {
    return { status: 'failed', note: `Yükleme adımı onaylı logo dosyaları dışında bir dosya istiyor: ${strayUploads.join(', ')}` };
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
    const assets = await assetFingerprints(profile, opts.assetsDir);
    const approval = await listingApproval(productId, profile, opts.approvalDir ?? APPROVAL_DIR, assets);
    if (!approval.ok) {
      const why =
        approval.reason === 'changed'
          ? 'ürün profili ya da logo dosyası onaydan sonra DEĞİŞMİŞ'
          : approval.reason === 'missing'
            ? 'ürün bilgisi henüz onaylanmamış'
            : 'onay kaydı okunamadı';
      return {
        status: 'skipped_not_approved',
        note: `Herkese açık listeleme için ${why} — profili gözden geçirip onayla: approve-profile ${productId}`,
      };
    }
    // Hız sınırı: --force bunu aşmaz (kayıttaki günlük sınırla aynı sayı, ayrı sayaç).
    if (ledger.countLiveSubmissionsToday() >= env.DAILY_LIMIT) {
      return { status: 'skipped_daily_limit', note: `bugün ${env.DAILY_LIMIT} gerçek listeleme yapıldı (günlük sınır)` };
    }
    const done = ledger.liveSubmission(key);
    if (done && !opts.force) return skippedDone(done);
  }

  // Aynı hesapta kayıt (run-one) sürüyorsa aynı tarayıcı profiline ikinci bir tarayıcı açılmaz.
  const signupLock = ledger.activeLock(key);
  if (signupLock && signupLock.expires_at > Date.now()) {
    return { status: 'skipped_locked', note: 'bu hesapta şu an bir kayıt çalışıyor' };
  }

  // ── Kilit + kayıt ───────────────────────────────────────────────────────
  const lockKey = `${key}#submit`;
  if (!ledger.tryClaim(lockKey, runId)) {
    return { status: 'skipped_locked', note: 'bu hesapta başka bir listeleme çalışıyor' };
  }

  let submissionId: number | null = null;
  let outcome: SubmitOutcome = { status: 'error' };
  let browser: Awaited<ReturnType<NonNullable<SubmitOptions['launch']>>> | null = null;
  let artifacts: Artifacts | undefined;
  const state: RunState = { phase: 'prepare', maybeSent: false, blocked: [] };

  // Kanıt yakalama asıl hatayı gölgelememeli.
  const capture = async (name: string): Promise<void> => {
    if (!artifacts) return;
    try {
      // React gibi çerçeveler yazılan değeri `value` özniteliğine yansıtır: parola diske HTML olarak yazılmasın.
      await browser?.page
        .evaluate(() => {
          for (const input of Array.from(document.querySelectorAll('input[type="password"]'))) {
            (input as HTMLInputElement).value = '';
            input.setAttribute('value', '');
          }
        })
        .catch(() => undefined);
      await captureFailure(artifacts, name);
    } catch {
      /* yoksay */
    }
  };

  try {
    // Kilidi almakla önceki kontrol arasında başka bir süreç gönderim yapmış olabilir.
    if (!opts.dryRun && !opts.force) {
      const done = ledger.liveSubmission(key);
      if (done) return skippedDone(done);
    }

    submissionId = ledger.startSubmission(key, runId, opts.dryRun);

    const launch = opts.launch ?? ((k, o) => launchContext(k, { ephemeral: o.ephemeral }));
    browser = await launch(key, { ephemeral: opts.dryRun });
    const page = browser.page;
    artifacts = createArtifacts(page, runId, `${key}-submit`);
    outcome.artifactsDir = artifacts.dir;
    const shots = artifacts;

    // Gönderim yapılmış OLABİLİR mi? Siteye giden her yazan istek (yükleme, kendiliğinden
    // gönderim...) bunu işaretler; üçüncü taraf (analitik) istekleri sayılmaz.
    const publishedValues = [profile.companyName, profile.website].filter((v) => v.length >= 3);
    const browserContext = page.context();
    browserContext.on('request', (req) => {
      if (state.phase === 'form' && looksLikeSubmission(req, publishedValues)) state.maybeSent = true;
    });

    // DRY-RUN AĞ KORUMASI: giriş formunun kendi isteği dışında yazan hiçbir istek çıkamaz.
    // Hata anında da engelle (kapalı-güvenli): karar verilemeyen istek durdurulur.
    if (opts.dryRun) {
      // Kalıcı profil önceki oturumdan bir service worker taşıyabilir. Playwright sürümüne göre onun
      // kendi istekleri context.route'a uğramayabilir (kurulu sürümde uğruyor; test/submitter.test.ts
      // bunu da dener). İkinci katman: bu sayfada service worker'ı devre dışı bırak.
      const cdp = await browserContext.newCDPSession(page);
      await cdp.send('Network.enable');
      await cdp.send('Network.setBypassServiceWorker', { bypass: true });

      await browserContext.route('**/*', async (route: Route) => {
        let allow = true;
        try {
          const req = route.request();
          if (isMutating(req.method())) {
            allow = state.phase === 'login' && isFromPage(req, config.login?.url);
            if (!allow) {
              const blocked: BlockedRequest = { method: req.method(), url: req.url(), phase: state.phase, submission: looksLikeSubmission(req, publishedValues) };
              state.blocked.push(blocked);
              log.warn({ method: blocked.method, url: blocked.url, phase: blocked.phase }, 'DRY-RUN: yazan istek ENGELLENDİ');
            }
          }
        } catch {
          allow = false;
        }
        await (allow ? route.continue() : route.abort('blockedbyclient')).catch(() => undefined);
      });
    }

    const identity = {
      email: credentials.email,
      username: credentials.username,
      password: derivePasswordForSite(env.MASTER_SECRET, { id: key, passwordPolicy: signupConfig?.passwordPolicy }, credentials.pw_version),
      passwordVersion: credentials.pw_version,
    };

    const signupContextFor = (site: SiteConfig, dryRun: boolean): SignupContext => ({
      page,
      site,
      identity,
      profile,
      log,
      artifacts: shots,
      dryRun,
      requestHumanCaptcha: makeCaptchaHandler(page, log),
    });
    const siteFor = (url: string, steps: SiteConfig['steps']): SiteConfig =>
      listingSiteConfig({ siteId, name: config.name, signupConfig, url, steps });

    // ── Giriş ─────────────────────────────────────────────────────────────
    await page.goto(config.listingUrl, { waitUntil: 'domcontentloaded', timeout: 30_000 });
    if (config.loggedIn) {
      const isLoggedIn = async (waitMs: number): Promise<boolean> => {
        const marker = page.locator(config.loggedIn as string).first();
        if (waitMs > 0) await marker.waitFor({ state: 'visible', timeout: waitMs }).catch(() => undefined);
        return marker.isVisible().catch(() => false);
      };
      // Kalıcı tarayıcı profili önceki oturumu taşıyabilir: önce kısaca bak, yoksa giriş yap.
      if (!(await isLoggedIn(2_000))) {
        if (!config.login) {
          await capture('not-logged-in');
          outcome = { status: 'failed', note: "Oturum açık değil ve config'te giriş adımları (login) yok", artifactsDir: shots.dir };
          return outcome;
        }
        log.info('Oturum yok — giriş yapılıyor');
        // GİRİŞ bir yayın değildir (kendi hesabımıza oturum açıyoruz): dry-run'da bile giriş
        // adımları (tıklamalar dahil) çalışır, yoksa form hiç görünmezdi. Ama dry-run'ın
        // "captcha çözme/insan bekleme yok" kuralı korunur: captchaGate adımları ayıklanır.
        const loginSteps = (config.login.steps as SiteConfig['steps']).filter((st) => !(opts.dryRun && st.type === 'captchaGate'));
        const loginSite = siteFor(config.login.url, loginSteps);
        state.phase = 'login';
        await runSteps(signupContextFor(loginSite, false), loginSite.steps);
        // Giriş isteği (XHR dahil) tıklamadan biraz sonra çıkabilir: bitmeden ne gezin ne de ağ
        // korumasının "giriş" aşamasını kapat.
        await page.waitForLoadState('networkidle', { timeout: 5_000 }).catch(() => undefined);
        state.phase = 'prepare';
        await page.goto(config.listingUrl, { waitUntil: 'domcontentloaded', timeout: 30_000 });
        if (!(await isLoggedIn(8_000))) {
          await capture('login-failed');
          outcome = { status: 'failed', note: 'Giriş yapılamadı (oturum işareti görünmedi) — şifre/akış kontrol edilmeli', artifactsDir: shots.dir };
          return outcome;
        }
      }
    }

    // ── Form ──────────────────────────────────────────────────────────────
    state.phase = 'form';
    const formSite = siteFor(config.listingUrl, config.steps as SiteConfig['steps']);
    const hooks: StepHooks = {
      beforeClick: async () => {
        // Başarı işareti gönderimden ÖNCE de görünüyorsa config sahte başarı üretir: tıklama yok.
        // (İlk tıklamadan sonra çok adımlı formun işareti meşru olarak görünebilir: bir daha bakma.)
        if (!state.maybeSent) {
          const early = await matchSuccess(page, config.success);
          if (early) throw new PermanentError(`Başarı işareti gönderimden ÖNCE de görünüyor (${early}) — config güvenilmez, gönderilmedi`);
        }
        state.maybeSent = true;
      },
    };
    await runSteps(signupContextFor(formSite, opts.dryRun), formSite.steps, hooks);

    if (opts.dryRun) {
      // Son adımın tetiklediği gecikmeli bir kendiliğinden gönderim varsa görünsün.
      await page.waitForLoadState('networkidle', { timeout: 2_000 }).catch(() => undefined);
      const shot = await shots.shot('submission-filled');
      const issues = await checkDryRunPage(page, formSite);
      for (const i of issues) log.warn({ kind: i.kind, selector: i.selector }, i.detail);

      const problems: string[] = [];
      if (!canAutoVerify(issues) || issues.some((i) => i.kind === 'no_submit')) problems.push(...issues.map((i) => i.detail));
      const attempted = attemptedSubmitNote(state);
      if (attempted) problems.push(attempted);
      const early = await matchSuccess(page, config.success);
      if (early) problems.push(`başarı işareti gönderimden ÖNCE de görünüyor (${early}) — gerçek gönderimde sahte başarı verir`);

      outcome =
        problems.length === 0
          ? { status: 'completed', note: `dry-run${issues.length ? ` (${issues.length} uyarı)` : ''} — gönderilmedi`, artifactsDir: shots.dir }
          : { status: 'manual', note: `dry-run BAŞARISIZ: ${problems.join(' | ')}`, artifactsDir: shots.dir };
      log.info({ shot, issues: issues.length, problems: problems.length }, 'DRY-RUN listeleme tamamlandı');
      return outcome;
    }

    // ── Gerçek gönderim: başarıyı doğrula ─────────────────────────────────
    if (!state.maybeSent) {
      await capture('submission-not-sent');
      outcome = { status: 'failed', note: "Form adımları bitti ama gönderim yapılmadı (config'te çalışan bir click adımı yok)", artifactsDir: shots.dir };
      return outcome;
    }
    const confirmed = await waitForSuccess(page, config.success);
    if (confirmed) {
      outcome = { status: 'completed', listingUrl: page.url(), note: `onaylandı (${confirmed})`, artifactsDir: shots.dir };
    } else {
      await capture('submission-unconfirmed');
      outcome = {
        status: 'unconfirmed',
        note: 'Gönderildi ama başarı işareti görünmedi — elle kontrol edilmeli (yayınlanmış olabilir; otomatik tekrar denenmez)',
        listingUrl: page.url(),
        artifactsDir: shots.dir,
      };
    }
    return outcome;
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    log.error({ err: message }, 'Listeleme başarısız');
    await capture('submission-error');
    // Gönderimin yapılmış OLABİLECEĞİ andan sonraki her hata (tıklamadan sonra zaman aşımı gibi)
    // yayınlanmış bir ürünü gizleyebilir; otomatik yeniden deneme çift listeleme yapardı. Öncesi
    // (öğe bulunamadı, sayfa açılmadı, giriş olmadı) güvenle 'failed' kalır ve yeniden denenebilir.
    // Dry-run'da engellenen kendiliğinden gönderim, sonraki adımların hatasının asıl nedenidir
    // (sayfa gezinemedi): kök nedeni kaybetme.
    const attempted = opts.dryRun ? attemptedSubmitNote(state) : null;
    if (attempted) {
      outcome = { status: 'manual', note: `dry-run BAŞARISIZ: ${attempted}; ardından adım hata verdi: ${message}`, artifactsDir: artifacts?.dir };
    } else if (!opts.dryRun && state.maybeSent) {
      outcome = { status: 'unconfirmed', note: `gönderim başladıktan sonra hata, yayınlanmış olabilir — elle kontrol et: ${message}`, artifactsDir: artifacts?.dir };
    } else {
      outcome = { status: 'failed', note: message, artifactsDir: artifacts?.dir };
    }
    return outcome;
  } finally {
    // Her temizlik adımı ayrı korunur: biri patlarsa kilit/tarayıcı açık kalmasın.
    if (submissionId !== null) {
      try {
        ledger.finishSubmission(submissionId, outcome.status, outcome.note, outcome.listingUrl);
      } catch (err) {
        log.error({ err: (err as Error).message }, 'Listeleme sonucu ledger\'a yazılamadı');
      }
    }
    try {
      ledger.release(lockKey);
    } catch (err) {
      log.error({ err: (err as Error).message }, 'Listeleme kilidi bırakılamadı');
    }
    await browser?.close().catch(() => undefined);
  }
}

/** Başarı işaretlerinden biri şu an görünüyor/uyuyor mu? Hangisinin uyduğunu döner. */
async function matchSuccess(page: Page, success: ValidatedSubmissionConfig['success']): Promise<string | null> {
  for (const fragment of success.urlContains ?? []) {
    if (page.url().includes(fragment)) return `url:${fragment}`;
  }
  for (const selector of success.anyOf ?? []) {
    if (await page.locator(selector).first().isVisible().catch(() => false)) return `görünür:${selector}`;
  }
  return null;
}

/** Başarı işaretlerinden biri görünene/uyana kadar bekler. */
async function waitForSuccess(
  page: Page,
  success: ValidatedSubmissionConfig['success'],
  timeoutMs = 15_000,
): Promise<string | null> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const hit = await matchSuccess(page, success);
    if (hit) return hit;
    await page.waitForTimeout(500);
  }
  return null;
}
