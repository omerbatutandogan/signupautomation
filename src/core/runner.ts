/**
 * Uçtan uca state machine.
 *
 * Bir siteyi işlerken sırayla: risk kapısı → kilit → kimlik → tarayıcı →
 * form → doğrulama maili → link → başarı kontrolü. Kilit her koşulda
 * bırakılıyor (finally), çünkü bırakılmayan kilit siteyi TTL boyunca
 * (45 dk) işlenemez yapar.
 */

import { randomUUID } from 'node:crypto';
import type { Logger } from 'pino';
import { env } from '../config.js';
import { loadAdapter } from '../adapters/registry.js';
import { launchContext } from './browser.js';
import { createArtifacts, captureFailure } from './artifacts.js';
import { classify, CaptchaRequiredError, ManualReviewError } from './errors.js';
import { waitForCaptchaCleared } from './captcha.js';
import { canAutoVerify, checkDryRunPage } from './dry-run-check.js';
import { derivePasswordForSite } from '../identity/password.js';
import { signupEmail, usernameForSite } from '../identity/email.js';
import { accountKey, DEFAULT_PRODUCT } from '../identity/account.js';
import { loadProfile } from '../identity/profile.js';
import { Ledger } from '../integrations/ledger.js';
import { createGmailClient, waitForVerificationEmail } from '../integrations/gmail.js';
import { registrableDomain } from '../integrations/mail-parse.js';
import type {
  CaptchaKind,
  SignupContext,
  SignupProfile,
  SiteAdapter,
  SiteConfig,
  TerminalStatus,
} from './types.js';

export interface RunOptions {
  runId?: string;
  dryRun?: boolean;
  force?: boolean;
  log: Logger;
  ledger: Ledger;
  /**
   * Config dosyasından değil doğrudan verilen adapter.
   *
   * `signup <url>` komutu için: keşfedilen bir site src/sites/'a hiç
   * yazılmadan çalıştırılabilsin diye. Verilmezse eskisi gibi
   * loadAdapter(siteId) ile src/sites/<siteId>.json okunur.
   *
   * VERİLİYORSA siteConfig da verilmeli — ctx.site bu ikisinden
   * ayrı bir yerden (loadSiteConfigFor → dosya) okunuyordu ve
   * makeGenericAdapter'ın sardığı config'e dışarıdan erişim yok.
   */
  adapter?: SiteAdapter;
  /** adapter verildiğinde ctx.site için kullanılacak gerçek config. */
  siteConfig?: SiteConfig;
  /**
   * Hangi ürün adına kaydolunacağı (src/profile/<id>.json). Verilmezse
   * varsayılan ürün. Kilit, kayıt, kimlik ve tarayıcı profili hesap
   * anahtarıyla (ürün + site) tutulur — bkz. identity/account.ts.
   */
  productId?: string;
  /**
   * Sheet geri bildirimi — opsiyonel. Verilmezse runner Sheet'siz çalışır.
   * Hataları çağıran taraf yutar; Sheet otorite değil, görünürlük katmanı.
   */
  onProgress?: {
    started?(runId: string): Promise<void>;
    finished?(
      outcome: RunOutcome,
      identity?: { email: string; username: string; profileUrl?: string },
    ): Promise<void>;
  };
}

export interface RunOutcome {
  status: TerminalStatus;
  note?: string;
  artifactsDir?: string;
}

/**
 * "Hesap zaten mevcut" sonucunun terminal durumu.
 *
 * BAŞARISIZLIK DEĞİL: amaç hesap açmaktı ve hesap var. Tek e-posta
 * mimarisi gereği o hesap bize ait — site bizim adresimizle "already
 * taken" diyorsa daha önce biz kaydolmuşuz.
 *
 * `failed` saymak üç şeyi bozuyordu: Sheet'te "Başarısız" görünüp
 * gereksiz elle kayda yönlendiriyor, run-batch her turda yeniden
 * deneyip boşuna trafik üretiyor, ve "hesabımız var" bilgisi hiçbir
 * yerde kayıtlı olmuyordu.
 */
export function alreadyExistsOutcome(): RunOutcome {
  return { status: 'completed', note: 'Hesap zaten mevcut (daha önce açılmış)' };
}

export async function runSite(siteId: string, opts: RunOptions): Promise<RunOutcome> {
  const runId = opts.runId ?? randomUUID().slice(0, 8);
  const productId = opts.productId ?? DEFAULT_PRODUCT;
  const log = opts.log.child({ siteId, productId, runId });
  const { ledger } = opts;

  const adapter = opts.adapter ?? (await loadAdapter(siteId));
  const key = accountKey(productId, siteId);

  /**
   * Erken çıkışlarda da Sheet'e yazar. Aksi halde atlanan siteler Sheet'te
   * boş görünür ve "neden işlenmedi?" sorusu cevapsız kalır.
   */
  const exitEarly = async (outcome: RunOutcome): Promise<RunOutcome> => {
    try {
      await opts.onProgress?.finished?.(outcome);
    } catch (err) {
      log.warn({ err: (err as Error).message }, 'Sheet yazımı başarısız');
    }
    return outcome;
  };

  // 1. Risk kapısı — ToS koruması. Ağ isteğinden ÖNCE.
  if (adapter.risk === 'high') {
    log.warn('Yüksek riskli site — ToS gereği otomasyon dışı, manuel listeye');
    return exitEarly({ status: 'skipped_high_risk', note: 'ToS otomatik kaydı yasaklıyor' });
  }

  // Profil ağdan ÖNCE yükleniyor: geçersiz profil (eksik açıklama, hatalı
  // e-posta) hiçbir siteye dokunmadan burada durmalı.
  let profile: SignupProfile;
  try {
    profile = await loadProfile(productId);
  } catch (err) {
    log.error({ err: (err as Error).message }, 'Ürün profili yüklenemedi');
    return exitEarly({ status: 'failed', note: (err as Error).message });
  }
  const email = signupEmail(profile.signupEmail ?? env.SIGNUP_EMAIL);

  // 2. Terminal sonuç kontrolü — daha önce bitmişse tekrar deneme.
  const previous = ledger.terminalResult(key);
  if (previous && !opts.force) {
    log.info({ previous }, 'Hesap zaten terminal durumda (--force ile aşılabilir)');
    return exitEarly({ status: 'skipped_terminal', note: `önceki sonuç: ${previous.status}` });
  }

  // Aynı sitede aynı e-postayla başka ürün hesabı varsa DENEME: site
  // "zaten kayıtlı" der, runner bunu başarı sayar ve bu ürün, öteki
  // ürünün hesabıyla yanlışlıkla "tamamlandı" işaretlenir.
  const clash = ledger.otherAccountWithEmail(siteId, key, email);
  if (clash) {
    log.warn({ clash, email }, 'Aynı e-posta bu sitede başka ürün hesabında kullanılıyor');
    return exitEarly({
      status: 'manual',
      note: `bu sitede "${clash}" hesabı aynı e-postayı kullanıyor — ürün profiline ayrı signupEmail tanımla`,
    });
  }

  // 3. Günlük limit — insan-benzeri KAYIT hacmi.
  //
  // Dry-run muaf: submit etmiyor, yani siteye hesap açma trafiği
  // üretmiyor. Limitin koruduğu şey "aynı IP'den günde kaç kayıt"
  // sinyali; selector doğrulaması onu ihlal etmez. Dry-run'ı da saymak
  // teşhis çalışmasını gerçek kayıt kotasıyla yarıştırıyordu.
  if (!opts.dryRun) {
    const todayCount = ledger.countToday();
    if (todayCount >= env.DAILY_LIMIT) {
      log.info({ todayCount, limit: env.DAILY_LIMIT }, 'Günlük limit doldu');
      return exitEarly({ status: 'skipped_limit', note: `bugün ${todayCount}/${env.DAILY_LIMIT}` });
    }
  }

  // 4. Kilit — atomik, aynı hesabı iki kez işlemeyi engeller.
  if (!ledger.tryClaim(key, runId)) {
    const lock = ledger.activeLock(key);
    log.warn({ lock }, 'Hesap başka bir çalıştırma tarafından kilitli');
    return exitEarly({ status: 'skipped_locked', note: `kilit sahibi: ${lock?.run_id ?? '?'}` });
  }

  const attemptId = ledger.startAttempt(key, runId, opts.dryRun);
  let outcome: RunOutcome = { status: 'error' };
  let browser: Awaited<ReturnType<typeof launchContext>> | null = null;
  // Sheet'e yazmak için finally'de gerekiyor; try içinde tanımlanınca erişilemez.
  let identitySnapshot: { email: string; username: string; profileUrl?: string } | undefined;

  // Sheet'i "İşleniyor" yap — SQLite claim'inden SONRA, yarış olmasın.
  // Sheet hatası çalıştırmayı düşürmemeli.
  try {
    await opts.onProgress?.started?.(runId);
  } catch (err) {
    log.warn({ err: (err as Error).message }, 'Sheet başlangıç yazımı başarısız');
  }

  try {
    const siteConfig = opts.siteConfig ?? (await loadSiteConfigFor(adapter));
    const identity = {
      email,
      username: usernameForSite(profile.companyName.replace(/\W/g, ''), siteId),
      // Şifre HESAP anahtarından türetiliyor: varsayılan üründe anahtar =
      // siteId (mevcut hesapların şifresi değişmez), diğer ürünlerde
      // `urun@site`. Site politikası da uygulanıyor — `cli password` ile
      // aynı sonucu vermesi için (önceden burada yok sayılıyordu).
      password: derivePasswordForSite(env.MASTER_SECRET, {
        id: key,
        passwordPolicy: siteConfig.passwordPolicy,
      }),
      passwordVersion: 1,
    };

    // Submit'ten ÖNCE kaydet: çökme halinde hangi kimlikle denendiği kaybolmasın.
    ledger.saveCredentials(key, identity.email, identity.username, identity.passwordVersion);
    identitySnapshot = { email: identity.email, username: identity.username };

    // Tarayıcı profili de hesap başına: aynı sitede A ürününün oturum
    // çerezleri B ürününün kaydına karışmasın.
    browser = await launchContext(key);
    const artifacts = createArtifacts(browser.page, runId, key);
    outcome.artifactsDir = artifacts.dir;

    const ctx: SignupContext = {
      page: browser.page,
      site: siteConfig,
      identity,
      profile,
      log,
      artifacts,
      dryRun: opts.dryRun ?? false,
      requestHumanCaptcha: makeCaptchaHandler(browser.page, log),
    };

    const submittedAt = Date.now();
    log.info({ email: identity.email, username: identity.username }, 'Kayıt başlıyor');

    const result = await adapter.signup(ctx);

    if (result.status === 'already_exists') {
      outcome = { ...alreadyExistsOutcome(), artifactsDir: artifacts.dir };
      return outcome;
    }

    if (opts.dryRun) {
      // Dry-run'da da ekran görüntüsü al: "selector bulundu" demek
      // "alan gerçekten doldu" demek değil. BetaList'te şifre alanları
      // selector'ı bulunmasına rağmen boş kalıyordu ve bu yalnızca
      // ekran görüntüsünden anlaşıldı.
      const shot = await artifacts.shot('dry-run-final');

      // Ekran görüntüsünün yakaladığını PROGRAMLA da yakala: dry-run
      // eskiden koşulsuz 'completed' dönüyordu ve içi boş bir config
      // bile "doğrulandı" sayılabiliyordu. 3430 sitelik listede her
      // taslağa insan gözüyle bakmak mümkün değil.
      const issues = await checkDryRunPage(browser.page, ctx.site);
      for (const i of issues) {
        log.warn({ kind: i.kind, selector: i.selector }, i.detail);
      }

      const ok = canAutoVerify(issues);
      outcome = {
        status: ok ? 'completed' : 'manual',
        note: ok
          ? issues.length > 0
            ? `dry-run (${issues.length} uyarı)`
            : 'dry-run'
          : `dry-run BAŞARISIZ: ${issues.map((i) => i.detail).join(' | ')}`,
        artifactsDir: artifacts.dir,
      };
      log.info({ shot, issues: issues.length, ok }, 'DRY-RUN tamamlandı');
      return outcome;
    }

    // Doğrulama gerekmiyorsa (StackShare gibi otomatik doğrulayan siteler).
    if (!result.needsEmailVerification) {
      const ok = (await adapter.confirmSuccess?.(ctx)) ?? true;
      // Hesap açıldı ama doğrulanmadıysa bunu sakla: "doğrulama
      // gerekmiyor" ile "site maili göndermiyor, hesap Pending kaldı"
      // farklı şeyler ve Sheet'i okuyan kişi için ikisi aynı görünmemeli.
      const unverified = adapter.verification.unverifiedAccount === true;
      outcome = {
        status: ok ? 'completed' : 'manual',
        note: ok
          ? unverified
            ? 'hesap açıldı — site doğrulama maili göndermiyor, DOĞRULANMAMIŞ'
            : 'e-posta doğrulaması gerekmiyor'
          : 'başarı doğrulanamadı',
        artifactsDir: artifacts.dir,
      };
      return outcome;
    }

    // Doğrulama maili bekle.
    log.info('Doğrulama maili bekleniyor');
    const gmailClient = await createGmailClient();
    const siteDomain = registrableDomain(ctx.site.signupUrl);

    let verification: Awaited<ReturnType<typeof waitForVerificationEmail>>;
    try {
      verification = await waitForVerificationEmail(gmailClient, adapter.verification, {
        siteDomain,
        submittedAt,
        log,
        isSeen: (id) => ledger.hasSeenMessage(id),
        onSeen: (id) => ledger.markMessageSeen(id, key),
      });
    } catch (err) {
      // Mail hiç gelmediyse ve submit sonrası URL zaten signup'tan
      // uzaklaşmışsa (10words, alternative, ontoplist deseni — hepsi
      // sonunda mode:'none' oldu), bunu HATA MESAJINA ekle. Kod
      // config'i kendiliğinden DEĞİŞTİRMEZ, yalnızca öneriyi loglar —
      // karar hâlâ insanda.
      if (result.status === 'submitted' && result.sawUrlChangeSignal) {
        log.warn(
          { siteId },
          'Mail gelmedi VE submit sonrası URL değişmişti — mode:"none" olabilir, config gözden geçirilmeli',
        );
      }
      throw err;
    }

    if (verification.kind === 'link') {
      log.info({ url: verification.url.slice(0, 80) }, 'Doğrulama linki açılıyor');
      // AYNI context'te aç — bazı siteler cookie sürekliliği istiyor.
      await browser.page.goto(verification.url, { waitUntil: 'domcontentloaded', timeout: 30_000 });
    } else {
      const selector = adapter.verification.codeSelector;
      if (!selector) throw new ManualReviewError('codeSelector tanımsız');
      await browser.page.locator(selector).first().fill(verification.code);
      await browser.page.keyboard.press('Enter');
    }

    await adapter.postVerify?.(ctx);

    const ok = (await adapter.confirmSuccess?.(ctx)) ?? true;
    if (ok) {
      ledger.setProfileUrl(key, browser.page.url());
      if (identitySnapshot) identitySnapshot.profileUrl = browser.page.url();
      outcome = { status: 'completed', artifactsDir: artifacts.dir };
    } else {
      await captureFailure(artifacts, 'confirm-failed');
      outcome = {
        status: 'manual',
        note: 'doğrulama sonrası başarı kontrolü geçmedi',
        artifactsDir: artifacts.dir,
      };
    }
    return outcome;
  } catch (err) {
    const kind = classify(err);
    const message = err instanceof Error ? err.message : String(err);
    log.error({ err: message, kind }, 'Çalıştırma başarısız');

    if (browser) {
      const artifacts = createArtifacts(browser.page, runId, key);
      await captureFailure(artifacts, `failure-${kind}`);
      outcome.artifactsDir = artifacts.dir;
    }

    outcome = {
      status:
        kind === 'transient'
          ? 'error'
          : kind === 'manual' || kind === 'captcha'
            ? 'manual'
            : 'failed',
      note: message,
      artifactsDir: outcome.artifactsDir,
    };
    return outcome;
  } finally {
    ledger.finishAttempt(attemptId, outcome.status, outcome.note);
    // Kilit HER koşulda bırakılır — bırakılmazsa site TTL boyunca bloke olur.
    ledger.release(key);
    await browser?.close();

    // Sheet'e sonucu yaz. Hata yutulur: ledger zaten doğru kaydı tuttu,
    // Sheet yazımının başarısızlığı çalıştırmayı başarısız yapmamalı.
    try {
      await opts.onProgress?.finished?.(outcome, identitySnapshot);
    } catch (err) {
      log.warn({ err: (err as Error).message }, 'Sheet sonuç yazımı başarısız');
    }
  }
}

/** Adapter'ın sarmaladığı config'i geri okur (ctx.site için gerekli). */
async function loadSiteConfigFor(adapter: { id: string }) {
  const { loadSiteConfig } = await import('../adapters/registry.js');
  return loadSiteConfig(adapter.id);
}

/**
 * Faz 1'de captcha bildirimi terminal üzerinden. Faz 2'de Telegram gelecek.
 * DOM izleyici sayesinde insan captcha'yı çözünce otomatik devam ediyor —
 * terminale bir şey yazmaya gerek kalmıyor.
 */
function makeCaptchaHandler(
  page: Awaited<ReturnType<typeof launchContext>>['page'],
  log: Logger,
): (kind: CaptchaKind, shot: string) => Promise<void> {
  return async (kind, shot) => {
    const timeoutMs = env.CAPTCHA_TIMEOUT_MS;

    log.warn(
      { kind, shot },
      `\n\n🤖 CAPTCHA — tarayıcıda çöz, akış otomatik devam edecek ` +
        `(${Math.round(timeoutMs / 60_000)} dk süre)\n`,
    );

    await page.bringToFront().catch(() => undefined);

    const cleared = await waitForCaptchaCleared(page, kind, timeoutMs);
    if (!cleared) {
      throw new CaptchaRequiredError(kind, shot);
    }
    log.info('Captcha çözüldü, devam ediliyor');
  };
}
