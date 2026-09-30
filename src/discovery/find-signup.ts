/**
 * Kayıt sayfası bulucu.
 *
 * Neden üç stratejili: 10words'te tahmin edilebilir yolların HEPSİ boş
 * döndü (/signup, /register, /login) — gerçek adres
 * portal.10words.io/auth/register'dı ve yalnızca ana sayfadaki
 * "Submit Your Startup" butonunu takip ederek bulundu.
 */

import type { Page, Response } from 'playwright';
import { waitForCaptcha } from '../core/captcha.js';

/** Tahmin edilebilir kayıt yolları — ucuz olduğu için önce denenir. */
const DIRECT_PATHS = [
  '/signup',
  '/register',
  '/auth/register',
  '/auth/signup',
  '/join',
  '/account/register',
  '/users/sign_up',
  '/create-account',
];

/** Ana sayfada kayıt sayfasına götürebilecek link metinleri. */
const SIGNUP_LINK_TEXT =
  /sign\s*up|register|join|submit|get\s*started|create\s*account|add\s*your|list\s*your/i;

/** Kayıt DEĞİL, giriş sayfası olduğunu gösteren işaretler. */
const LOGIN_HINT = /log\s*in|login|sign\s*in|signin/i;

/**
 * Bot koruma duvarı metinleri — gerçek yakalanmış sayfalardan.
 *
 * Dar tutuluyor: "access denied" gibi genel ifadeler ölü sayfalarda da
 * geçiyor ve onları yanlışlıkla "bot koruması" saymak siteyi gereksiz
 * yere otomasyon dışına atar.
 */
const BOT_WALL_TEXT = [
  /just a moment\.\.\./i, // Cloudflare interstitial (goodfirms, eu-startups)
  /attention required! \| cloudflare/i, // Cloudflare blok (crunchbase)
  /enable javascript and cookies to continue/i, // Cloudflare noscript
  /vercel security checkpoint/i, // Vercel (siteinspire)
  /checking your browser before accessing/i, // eski Cloudflare
  /we're verifying your browser/i,
  /sorry, you have been blocked/i,
  /performing security verification/i, // Cloudflare (goodfirms, eu-startups)
];

/** Bot koruması sayılan durum kodları. */
const BOT_WALL_STATUS = new Set([403, 429]);

/**
 * Sayfa bot koruma duvarı mı?
 *
 * 403/404 ayrımı önemli: keşif ikisini de "form bulunamadı" diye
 * kaydediyordu ve Crunchbase, GoodFirms, EU-Startups gibi kayıt formu
 * KESİNLİKLE olan siteler "kayıt almıyor" sanılıyordu. Bot korumalı site
 * otomasyona uygun değil ama "form yok" da değil — ayrı kategori.
 *
 * Saf fonksiyon: tarayıcı olmadan gerçek gövde metinlerine karşı test
 * edilebilir.
 */
export function isBotWall(status: number, bodyText: string): boolean {
  if (BOT_WALL_STATUS.has(status)) return true;
  return BOT_WALL_TEXT.some((re) => re.test(bodyText));
}

/**
 * Domain satış/park platformları. Oraya yönlenen site kapanmış demek.
 * forsale.godaddy.com gerçek vaka (prefundia.com, JS yönlendirmesi);
 * diğerleri bilinen satış pazarları.
 */
const PARKING_HOSTS = ['forsale.godaddy.com', 'afternic.com', 'sedo.com', 'dan.com', 'hugedomains.com'];

/** Park sayfası metinleri — yalnızca kısa sayfalarda aranır. */
const PARKED_TEXT = [
  /is parked free, courtesy of godaddy/i, // codeproject.com/lander
  /this domain (name )?(is|may be) for sale/i,
  /buy this domain/i,
];

/**
 * Sayfa park edilmiş/satılık domain mi?
 *
 * Karar önce alan adından: prefundia.com'un yönlendiği GoDaddy satış
 * sayfası headless'ta Akamai reddi ("Access Denied") gösteriyor, metin
 * işe yaramıyor. Metin eşleşmesi kısa sayfayla sınırlı: park sayfaları
 * birkaç yüz karakter, uzun bir dizin sayfasında "buy this domain"
 * geçen bir ilan olabilir.
 */
export function isParkedDomain(url: string, bodyText: string): boolean {
  let host: string;
  try {
    host = new URL(url).hostname.toLowerCase();
  } catch {
    return false;
  }
  if (PARKING_HOSTS.some((h) => host === h || host.endsWith(`.${h}`))) return true;
  return bodyText.length < 3000 && PARKED_TEXT.some((re) => re.test(bodyText));
}

/**
 * Büyük platformlar. Dizin kapanıp Medium/Facebook sayfasına yönlenirse
 * bu "taşınma" değil: orada bulunacak kayıt formu platformun kendisine
 * ait, hedef sitenin değil.
 */
const PLATFORM_HOSTS = [
  'medium.com', 'facebook.com', 'linkedin.com', 'twitter.com', 'x.com', 'instagram.com',
  'linktr.ee', 'substack.com', 'wordpress.com', 'blogspot.com', 'github.com',
  'google.com', 'youtube.com', 'tumblr.com', 'wix.com',
];

export const PARKED_REASON = 'Domain park edilmiş/satılık — site kapanmış';
export const PLATFORM_REASON = 'Site büyük bir platforma yönleniyor — dizin kapanmış olabilir';

export type Landing =
  | { kind: 'same' }
  | { kind: 'moved'; origin: string }
  | { kind: 'gone'; reason: string };

/**
 * Açılan sayfa aradığımız site mi?
 *
 * Keşif eskiden sheet'teki domainde kalıyordu: angel.co wellfound.com'a
 * taşınmıştı ve kayıt linkleri "siteden dışarı çıkma" filtresine
 * takılıyordu. Taşınmayı takip etmek gerekiyor ama park/satış sayfaları
 * ve büyük platformlar taşınma değil — oradaki kayıt yanlış siteye olur.
 */
export function resolveLanding(url: string, bodyText: string, origin: string): Landing {
  if (!/^https?:\/\//i.test(url)) return { kind: 'same' };
  if (isParkedDomain(url, bodyText)) return { kind: 'gone', reason: PARKED_REASON };
  if (sameSite(url, registrableHost(origin))) return { kind: 'same' };
  if (PLATFORM_HOSTS.includes(registrableHost(url))) return { kind: 'gone', reason: PLATFORM_REASON };
  return { kind: 'moved', origin: originOf(url) };
}

/**
 * Kayıt formu asla kabul edilmeyecek host mu? (park/satış ya da büyük
 * platform — oradaki form hedef sitenin değil.)
 */
function isGoneHost(url: string): boolean {
  return isParkedDomain(url, '') || PLATFORM_HOSTS.includes(registrableHost(url));
}

/**
 * Ülke uzantısı atılmış domain: "example.com.tr" → "example.com",
 * "example.de" → "example", "example.com" → "example.com".
 */
function withoutCountryCode(host: string): string {
  return host.replace(/\.[a-z]{2}$/i, '');
}

/**
 * Yalnızca ülke uzantısı mı değişti? (example.com → example.com.tr,
 * example.de → example.fr). Sheet adresinde www dışında alt alan adı
 * varsa HAYIR: mydir.notion.site → notion.so gibi platform alt
 * alanları "aynı marka" sayılıp Notion'a kayıt açılabiliyordu.
 */
function onlyCountryCodeChanged(url: string, startOrigin: string): boolean {
  let startHost: string;
  try {
    startHost = new URL(normalizeUrl(startOrigin)).hostname.toLowerCase().replace(/^www\./, '');
  } catch {
    return false;
  }
  const from = registrableHost(startOrigin);
  if (startHost !== from) return false;
  // Kalan kısımda genel uzantı olmalı (example.com ↔ example.com.tr).
  // foo.io ↔ foo.ai gibi iki harfli uzantılar pratikte genel uzantı;
  // farklı sahiplere ait olabilir, istisna yok.
  const stem = withoutCountryCode(from);
  return stem.includes('.') && withoutCountryCode(registrableHost(url)) === stem;
}

/**
 * Kayıt sayfası sheet'teki domainde değilse bunu adaya yazar. Config
 * üretici bunu dry-run'ın kaldırmadığı bir onay işaretine çeviriyor:
 * taşınma sanılan yer ölü domainin satış pazarı olabilir, o formu da
 * dry-run "çalışıyor" bulur.
 *
 * Yalnızca ülke uzantısı değişimi (example.com → example.com.tr)
 * taşınma sayılmaz: yönlendirmeyi eski domainin sahibi yapıyor.
 */
export function markMove(candidate: SignupCandidate, startOrigin: string): SignupCandidate {
  const from = registrableHost(startOrigin);
  if (sameSite(candidate.url, from) || onlyCountryCodeChanged(candidate.url, startOrigin)) return candidate;
  return { ...candidate, movedFrom: from };
}

export interface SignupCandidate {
  url: string;
  /** high: şifre alanı + submit var. low: yalnızca email alanı bulundu. */
  confidence: 'high' | 'low';
  /** Kaç link takip edilerek ulaşıldı (0 = doğrudan yol). */
  hops: number;
  /** Nasıl bulunduğu — config notlarına yazılıyor. */
  method: 'direct-path' | 'link-follow' | 'origin';
  /** Kayıt sayfası sheet'teki domainde değilse eski domain (angel.co). */
  movedFrom?: string;
}

/**
 * Keşif sonucu.
 *
 * `bot_protected` "form yok" DEĞİL: site kayıt alıyor olabilir ama bot
 * koruması otomasyonu engelliyor. İkisini tek kovaya atmak Crunchbase,
 * GoodFirms, EU-Startups'ı "kayıt almıyor" diye eledi.
 */
export type SignupSearchResult =
  | { kind: 'found'; candidate: SignupCandidate }
  | { kind: 'bot_protected'; url: string }
  | { kind: 'not_found'; reason?: string; hints?: SignupHint[] };

/**
 * Kayıt formu bulunamadığında sitede görülen başka akış.
 *
 * 18 "form yok" sitesinin elle incelemesinde en büyük iki parça:
 *  - submit_form: hesapsız "sitenizi gönderin" formu (onepagelove,
 *    blogs-collection, 1000.tools/signup: website + e-posta, şifre yok)
 *  - email_first: giriş/kayıt yolunda tek e-posta alanı (techinasia
 *    /auth, 1000.tools/login) — kod/link ya da 2. adımda şifre
 * İkisi de kayıt sayılmıyor ama "form yok" da değil; tarama haritası
 * hangi desteğin kaç siteyi açacağını göstersin diye ayrı raporlanıyor.
 */
export type SignupHint = 'submit_form' | 'email_first';

/** Giriş/kayıt yolları — tek e-posta alanlı form burada bülten değil. */
const AUTH_PATH = /\/(log[-_]?in|sign[-_]?in|sign[-_]?up|auth|register|join)(?=[/?#_-]|$)/i;

/**
 * Sayfada şifresiz bir gönderim ya da e-postayla giriş formu var mı?
 * Yalnızca raporlama için: bu ipucuyla hiçbir form doldurulmuyor.
 */
async function pageHint(page: Page): Promise<SignupHint | null> {
  // evaluate içinde adlandırılmış yardımcı YOK (tsx __name tuzağı).
  const f = await page
    .evaluate(() => {
      // Blog yorum formları hariç: WordPress yorum kutusunda name="url"
      // (Website) alanı var ve gönderim formu sanılıyordu.
      const shown = Array.from(document.querySelectorAll('input, textarea')).filter(
        (el) =>
          el.getBoundingClientRect().width > 0 &&
          el.getBoundingClientRect().height > 0 &&
          !el.closest('#commentform, .comment-form, #respond, #comments'),
      );
      const fields = shown.filter((el) => {
        const type = (el.getAttribute('type') ?? 'text').toLowerCase();
        const label = `${el.getAttribute('name') ?? ''} ${el.getAttribute('placeholder') ?? ''} ${el.id}`;
        if (el.tagName === 'TEXTAREA') return true;
        return ['text', 'email', 'url', 'tel', ''].includes(type) && !/search|query/i.test(label);
      });
      return {
        passwords: shown.filter((el) => (el.getAttribute('type') ?? '').toLowerCase() === 'password').length,
        // E-posta alanları hariç ("you@domain.com" placeholder'ı bülten
        // kutusunu gönderim formu yapıyordu); kelime sınırıyla eşleşme.
        urlFields: fields.filter((el) => {
          const type = (el.getAttribute('type') ?? '').toLowerCase();
          // camelCase ayrılıp küçültülüyor: companyWebsite → "company website".
          const label = `${el.getAttribute('name') ?? ''} ${el.getAttribute('placeholder') ?? ''} ${el.id}`
            .replace(/([a-z])([A-Z])/g, '$1 $2')
            .toLowerCase();
          if (type === 'url') return true;
          if (type === 'email' || /e-?mail|@/.test(label)) return false;
          return /(^|[^a-z])(website|url|domain|homepage)([^a-z]|$)/.test(label);
        }).length,
        fields: fields.length,
        submits: Array.from(document.querySelectorAll('button, input[type="submit"]')).filter(
          (el) => el.getBoundingClientRect().width > 0 && el.getBoundingClientRect().height > 0,
        ).length,
        // Bülten OLMAYAN görünür e-posta alanları. Her alan kendi formunun
        // çevresine göre değerlendiriliyor, sayfa geneline değil:
        // techinasia'nın başlığında "SUBSCRIBE" butonu, pek çok giriş
        // sayfasının altbilgisinde bülten formu var. "Join our newsletter"
        // (/join yolunda) gibi formlar ise kendi çevresinden eleniyor.
        // Üst öğe metni kısaysa (modal/bölüm) o da dahil; uzunsa yalnızca
        // formun kendisi.
        authEmails: fields.filter((el) => {
          const isEmail =
            (el.getAttribute('type') ?? '').toLowerCase() === 'email' ||
            /e-?mail/i.test(`${el.getAttribute('name') ?? ''} ${el.getAttribute('placeholder') ?? ''}`);
          if (!isEmail) return false;
          const form = el.closest('form') as HTMLElement | null;
          const parentText = (form?.parentElement as HTMLElement | null)?.innerText ?? '';
          const context = `${form?.innerText ?? ''} ${
            Array.from(form?.querySelectorAll('input[type="submit"]') ?? [])
              .map((b) => (b as HTMLInputElement).value)
              .join(' ')
          } ${parentText.length < 500 ? parentText : ''}`;
          return !/newsletter|subscribe/i.test(context);
        }).length,
      };
    })
    .catch(() => null);

  if (!f || f.passwords > 0 || f.submits === 0) return null;
  // URL alanı olan şifresiz form gönderimdir — /signup yolunda olsa bile
  // (1000.tools/signup gerçek vakası).
  if (f.urlFields > 0) return 'submit_form';

  let path = '';
  try {
    path = new URL(page.url()).pathname;
  } catch {
    return null;
  }
  // Auth yolu şartı bülteni ayırıyor: ana sayfadaki/"newsletter"
  // sayfasındaki tek e-posta alanı giriş değil.
  if (AUTH_PATH.test(path) && f.authEmails >= 1 && f.fields <= 2) return 'email_first';
  return null;
}

/**
 * Sayfada kayıt formu var mı?
 *
 * Şifre alanı en güçlü işaret. Yalnızca email varsa bülten formu da
 * olabilir — düşük güven olarak işaretleniyor.
 */
async function evaluateForm(page: Page): Promise<'high' | 'low' | null> {
  // JS ile render edilen formlar için bekle. networkidle KULLANILMIYOR:
  // reklam/analytics sürekli istek atan sitelerde hiç gerçekleşmiyor.
  await page.waitForTimeout(2500);

  // DİKKAT: page.evaluate() içinde ok fonksiyonu/yardımcı TANIMLANMAZ.
  // tsx derlemesi onlara __name çağrısı enjekte ediyor ve tarayıcı
  // bağlamında o yardımcı olmadığı için "ReferenceError: __name is not
  // defined" hatası alınıyor. Mantık satır içi tutulmalı.
  const result = await page.evaluate(() => {
    const passwords = Array.from(document.querySelectorAll('input[type="password"]')).filter(
      (el) => el.getBoundingClientRect().width > 0 && el.getBoundingClientRect().height > 0,
    );
    const emails = Array.from(
      document.querySelectorAll('input[type="email"], input[name*="email" i]'),
    ).filter(
      (el) => el.getBoundingClientRect().width > 0 && el.getBoundingClientRect().height > 0,
    );
    const submits = Array.from(
      document.querySelectorAll('button[type="submit"], input[type="submit"], button'),
    ).filter(
      (el) => el.getBoundingClientRect().width > 0 && el.getBoundingClientRect().height > 0,
    );

    return {
      passwords: passwords.length,
      emails: emails.length,
      submits: submits.length,
      // Sayfa metninde şifre geçiyor mu? JS ile sonradan gelen şifre
      // alanlarını kaçırmamak için ikinci bir sinyal.
      mentionsPassword: /password|şifre/i.test(document.body?.innerText ?? ''),
    };
  });

  // Şifre alanı kayıt formunun ayırt edici işareti.
  if (result.passwords > 0 && result.submits > 0) return 'high';

  // Şifresiz "email + submit" formları GENELDE kayıt değil: bülten aboneliği,
  // demo talebi, ürün gönderimi. Gerçek vakalar: 1000.tools/signup (website+
  // email, ürün gönderme formu), akitaapp.com/demo (your-company+your-email,
  // demo talebi). Bunları kayıt sanmak kullanılamaz config üretiyordu.
  // Yalnızca sayfada "password" kelimesi geçiyorsa (JS ile sonradan
  // gelen alan olabilir) düşük güvenle kabul ediyoruz.
  if (result.emails > 0 && result.submits > 0 && result.mentionsPassword) return 'low';

  return null;
}

/**
 * Sayfayı açıp form değerlendirir; hata durumunda null döner.
 *
 * baseDomain verilirse yönlendirme sonrası hâlâ aynı sitede olduğumuzu
 * doğrular — bazı siteler kayıt sayfasını üçüncü partiye yönlendiriyor.
 */
type TryResult = 'high' | 'low' | 'bot_wall' | null;

async function tryUrl(
  page: Page,
  url: string,
  baseDomain?: string,
  hints?: Set<SignupHint>,
): Promise<TryResult> {
  try {
    // Kısa timeout: site ayakta olduğu zaten doğrulandı, bu yol yoksa
    // hızlıca sıradakine geçilmeli (8 yol × uzun timeout = dakikalar).
    const res = await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 12_000 });
    const status = res?.status() ?? 0;

    // Bot duvarı "form yok" DEĞİL — ayrı kategori. Crunchbase/GoodFirms
    // burada 403 veriyor ve eskiden "kayıt formu bulunamadı" sayılıyordu.
    const body = await page.evaluate(() => document.body?.innerText ?? '').catch(() => '');
    if (isBotWall(status, body)) return 'bot_wall';

    // 404/5xx sayfalarında form aramanın anlamı yok.
    if (status >= 400) return null;

    const checkedUrl = page.url();
    if (
      baseDomain &&
      !acceptsOffSiteUrl({
        url: checkedUrl,
        baseDomain,
        redirected: wasRedirected(res),
      })
    ) {
      return null;
    }

    const form = await evaluateForm(page);

    // evaluateForm 2.5sn bekliyor; bu sürede JS yönlendirmesi başka siteye
    // geçmiş olabilir (github.com/signup gibi). Formun bulunduğu URL
    // yeniden kontrol edilir: park/platform asla, başka domain yalnızca
    // kontrol anındakiyle aynıysa (HTTP ile kabul edilmiş taşınma).
    // İpucu da aynı kurala tabi — başka sitenin formu bu sitenin haritası değil.
    const finalUrl = page.url();
    if (isGoneHost(finalUrl)) return null;
    if (baseDomain && !sameSite(finalUrl, baseDomain) && registrableHost(finalUrl) !== registrableHost(checkedUrl)) {
      return null;
    }

    if (!form && hints) {
      const hint = await pageHint(page);
      if (hint) hints.add(hint);
    }
    return form;
  } catch {
    return null;
  }
}

/**
 * Bu yanıta HTTP yönlendirmesiyle mi ulaşıldı?
 *
 * Playwright yönlendirme zincirini request.redirectedFrom() ile tutuyor.
 * Zincir varsa sunucu bizi oraya gönderdi; yoksa istenen URL doğrudan
 * yanıtladı.
 */
function wasRedirected(res: Response | null): boolean {
  return res?.request().redirectedFrom() != null;
}

/**
 * Farklı domaindeki sayfa kabul edilmeli mi?
 *
 * İki durumu ayırır:
 *  - Site taşınmış (angel.co → wellfound.com): sunucu 30x ile gönderdi,
 *    hâlâ aradığımız sitenin kaydı. KABUL.
 *  - Sızma (aixcollection.com sayfasındaki link → saashub.com/register):
 *    başka bir sitenin kaydı, yanlış yere kayıt olurduk. RED.
 *
 * Saf fonksiyon: karar tarayıcıdan bağımsız test edilebilsin diye
 * ayrıldı.
 */
export function acceptsOffSiteUrl(opts: {
  url: string;
  baseDomain: string;
  redirected: boolean;
}): boolean {
  if (sameSite(opts.url, opts.baseDomain)) return true;
  return opts.redirected;
}

/** URL'i normalize eder: şema ekler, sondaki eğik çizgiyi atar. */
export function normalizeUrl(raw: string): string {
  const withScheme = /^https?:\/\//i.test(raw) ? raw : `https://${raw}`;
  return withScheme.replace(/\/+$/, '');
}

/** Sitenin kökünü döner: "https://a.com/x/y" → "https://a.com" */
export function originOf(raw: string): string {
  try {
    return new URL(normalizeUrl(raw)).origin;
  } catch {
    return normalizeUrl(raw);
  }
}

/** "https://www.a.co.uk/x" → "a.co.uk" (www ve alt domainler atılır). */
export function registrableHost(raw: string): string {
  try {
    const host = new URL(normalizeUrl(raw)).hostname.toLowerCase().replace(/^www\./, '');
    const parts = host.split('.');
    if (parts.length <= 2) return host;
    const twoLevel = /^(co|com|net|org|gov|edu|ac)\.[a-z]{2}$/;
    const lastTwo = parts.slice(-2).join('.');
    return twoLevel.test(lastTwo) ? parts.slice(-3).join('.') : lastTwo;
  } catch {
    return '';
  }
}

/**
 * URL aynı siteye mi ait? Alt domainler kabul (10words: portal.10words.io),
 * farklı domainler reddedilir.
 */
export function sameSite(url: string, baseDomain: string): boolean {
  if (!baseDomain) return false;
  const host = registrableHost(url);
  return host === baseDomain;
}

/**
 * Kayıt sayfasını bulur.
 *
 * Sıra: (1) doğrudan yollar → (2) ana sayfadaki linkleri takip →
 * (3) bulunamazsa null.
 */
export async function findSignupPage(
  page: Page,
  website: string,
  opts: { maxHops?: number } = {},
): Promise<SignupSearchResult> {
  const maxHops = opts.maxHops ?? 2;
  const startOrigin = originOf(website);
  // Site taşınmışsa (angel.co → wellfound.com) ikisi de yeni domaine geçer.
  let origin = startOrigin;
  let baseDomain = registrableHost(origin);

  // 0. Site ayakta mı? Yanıt vermeyen sitede 8 yolu tek tek denemek
  // site başına ~3 dk harcıyor (affordhunt.com boş sayfa döndürüyordu).
  // Tek kısa kontrolle bunu saniyelere indiriyoruz.
  const homeRes = await page
    .goto(origin, { waitUntil: 'domcontentloaded', timeout: 15_000 })
    .catch(() => null);

  // Ana sayfa bot duvarıysa alt yolları denemenin anlamı yok — hepsi
  // aynı duvarı verir ve site "form yok" diye kaydedilirdi.
  let homeBody = await bodyText(page);
  if (isBotWall(homeRes?.status() ?? 0, homeBody)) {
    return { kind: 'bot_protected', url: origin };
  }

  if (homeRes && homeRes.status() >= 400) return { kind: 'not_found' };

  // Boş görünen sayfa hemen "ölü" sayılmaz. Gerçek vakalar: appagg.com
  // boş gövde + Cloudflare "Verify you are human" kutusu (bot duvarı);
  // prefundia.com ilk anda boş, JS ile satış sayfasına yönleniyor. Geç
  // render eden tek sayfalık uygulamalar da ilk anda boş. Kısa bekleyip
  // yeniden bakılıyor.
  if (homeBody.trim().length <= 50) {
    const captcha = await waitForCaptcha(page, 3000);
    // Yalnızca duvar tipi challenge'lar. reCAPTCHA duvar değil: SPA'lar
    // formları için görünmez v3 yüklüyor ve onun iframe'i tespitte
    // recaptcha_v2 görünüyor. Bulunduğu an dönüldüğü için render'ı bekle.
    const wall = captcha === 'turnstile' || captcha === 'hcaptcha' || captcha === 'unknown_challenge';
    if (captcha && !wall) await page.waitForTimeout(3000);
    homeBody = await bodyText(page);
    // Park kontrolü duvardan önce: challenge gösteren satış sayfası
    // "bot korumalı" değil "kapanmış" olarak kaydedilmeli.
    const early = resolveLanding(page.url(), homeBody, origin);
    if (early.kind === 'gone') return { kind: 'not_found', reason: early.reason };
    if (wall || isBotWall(0, homeBody)) return { kind: 'bot_protected', url: origin };
    if (homeBody.trim().length <= 50) return { kind: 'not_found' };
  }

  const landing = resolveLanding(page.url(), homeBody, origin);
  if (landing.kind === 'gone') return { kind: 'not_found', reason: landing.reason };
  if (landing.kind === 'moved') {
    origin = landing.origin;
    baseDomain = registrableHost(origin);
  }

  // Alt yollarda bot duvarı görülürse hatırla: form bulunamazsa sonuç
  // "form yok" değil "bot korumalı" olmalı.
  let sawBotWall = false;

  // Kayıt formu olmayan ama gönderim/e-postayla giriş akışı olan sayfalar.
  const hints = new Set<SignupHint>();
  const notFound = (): SignupSearchResult =>
    hints.size > 0 ? { kind: 'not_found', hints: [...hints] } : { kind: 'not_found' };

  // 1. Doğrudan yollar — ucuz, çoğu sitede tutuyor.
  //
  // GERÇEK VAKA: crozdesk.com'da art arda 8 istek (6'sı 404) Cloudflare'ı
  // tetikleyip 429'a çevirdi — site muhtemelen bot korumalı DEĞİL, bizim
  // hızlı ardışık deneme desenimiz onu öyle GÖSTERDİ (test sırasında IP
  // birkaç dakika 429'da kaldı, 300ms'lik ilk deneme yetmedi — Cloudflare
  // eşiği düşünülenden daha sıkı). Adımlar arasına gecikme bu deseni
  // kırıyor; site başına toplam maliyet önemsiz (8 × ~1sn ≈ 8sn) ama
  // yanlış "bot_protected" etiketini önlüyor. Gecikme değeri IP cezası
  // aktifken doğrulanamadı — üretimde ölçülüp ayarlanmalı.
  for (const [i, path] of DIRECT_PATHS.entries()) {
    if (i > 0) await page.waitForTimeout(800 + Math.random() * 400);
    const url = `${origin}${path}`;
    const result = await tryUrl(page, url, baseDomain, hints);
    if (result === 'bot_wall') {
      sawBotWall = true;
      continue;
    }
    if (result) {
      return {
        kind: 'found',
        candidate: markMove(
          { url: page.url(), confidence: result, hops: 0, method: 'direct-path' },
          startOrigin,
        ),
      };
    }
  }

  // 2. Ana sayfadaki kayıt linklerini takip et.
  try {
    await page.goto(origin, { waitUntil: 'domcontentloaded', timeout: 25_000 });
    await page.waitForTimeout(2500);
  } catch {
    return sawBotWall ? { kind: 'bot_protected', url: origin } : notFound();
  }

  // Yavaş JS yönlendirmesi ilk kontrolden sonra tamamlanmış olabilir.
  const relanding = resolveLanding(page.url(), await bodyText(page), origin);
  if (relanding.kind === 'gone') return { kind: 'not_found', reason: relanding.reason };
  if (relanding.kind === 'moved') {
    origin = relanding.origin;
    baseDomain = registrableHost(origin);
  }

  // Ana sayfanın kendisinde form olabilir (tek sayfalık siteler).
  const onHome = await evaluateForm(page);
  if (onHome === 'high') {
    return {
      kind: 'found',
      candidate: markMove(
        { url: page.url(), confidence: 'high', hops: 0, method: 'origin' },
        startOrigin,
      ),
    };
  }
  // Ana sayfada "sitenizi gönderin" kutusu olabilir (yol "/" olduğu için
  // e-postayla giriş ipucu burada çıkmaz — bülten kutuları elenir).
  const homeHint = await pageHint(page);
  if (homeHint) hints.add(homeHint);

  const links = await collectSignupLinks(page, origin);

  for (const link of links.slice(0, maxHops * 3)) {
    const result = await tryUrl(page, link, baseDomain, hints);
    if (result === 'bot_wall') sawBotWall = true;
    else if (result) {
      return {
        kind: 'found',
        candidate: markMove(
          { url: page.url(), confidence: result, hops: 1, method: 'link-follow' },
          startOrigin,
        ),
      };
    }

    // İkinci sıçrama: 10words deseni — ara sayfa asıl kayda yönlendiriyor.
    if (maxHops >= 2) {
      const second = await collectSignupLinks(page, origin);
      for (const inner of second.slice(0, 3)) {
        if (inner === link) continue;
        const innerResult = await tryUrl(page, inner, baseDomain, hints);
        if (innerResult === 'bot_wall') sawBotWall = true;
        else if (innerResult) {
          return {
            kind: 'found',
            candidate: markMove(
              { url: page.url(), confidence: innerResult, hops: 2, method: 'link-follow' },
              startOrigin,
            ),
          };
        }
      }
    }
  }

  return sawBotWall ? { kind: 'bot_protected', url: origin } : notFound();
}

function bodyText(page: Page): Promise<string> {
  return page.evaluate(() => document.body?.innerText ?? '').catch(() => '');
}

/** Sayfadaki kayıt adayı linkleri toplar, giriş linklerini geriye atar. */
async function collectSignupLinks(page: Page, origin: string): Promise<string[]> {
  const raw = await page
    .evaluate(() =>
      Array.from(document.querySelectorAll('a'))
        .map((a) => ({ text: (a.textContent ?? '').trim(), href: (a as HTMLAnchorElement).href }))
        .filter((l) => l.href.startsWith('http')),
    )
    .catch(() => [] as Array<{ text: string; href: string }>);

  // Domain sınırı: link takibi siteden DIŞARI çıkmamalı.
  // Gerçek vaka: aixcollection.com keşfi saashub.com/register'a sapmıştı
  // (sitede o dizine giden bir link vardı) — yanlış siteye kayıt olurdu.
  const baseDomain = registrableHost(origin);

  const scored = raw
    .filter((l) => SIGNUP_LINK_TEXT.test(l.text) || SIGNUP_LINK_TEXT.test(l.href))
    .filter((l) => sameSite(l.href, baseDomain))
    .map((l) => {
      let score = 0;
      if (SIGNUP_LINK_TEXT.test(l.text)) score += 2;
      if (/sign\s*up|register|join/i.test(l.text)) score += 2;
      if (SIGNUP_LINK_TEXT.test(l.href)) score += 1;
      // Giriş sayfaları kayıt değil — sona at ama tamamen eleme
      // (bazı siteler kayıt/giriş aynı sayfada).
      if (LOGIN_HINT.test(l.text) && !/sign\s*up|register/i.test(l.text)) score -= 3;
      // Demo/iletişim sayfaları kayıt formu değil — akitaapp'te /demo/
      // sayfası yanlışlıkla kayıt sanılmıştı.
      if (/\/demo|\/contact|\/pricing|\/about/i.test(l.href)) score -= 2;
      return { href: l.href, score };
    })
    .filter((l) => l.score > 0)
    .sort((a, b) => b.score - a.score);

  // Aynı URL birden fazla kez geçebilir.
  return [...new Set(scored.map((l) => l.href))];
}
