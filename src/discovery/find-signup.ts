/**
 * Kayıt sayfası bulucu.
 *
 * Neden üç stratejili: 10words'te tahmin edilebilir yolların HEPSİ boş
 * döndü (/signup, /register, /login) — gerçek adres
 * portal.10words.io/auth/register'dı ve yalnızca ana sayfadaki
 * "Submit Your Startup" butonunu takip ederek bulundu.
 */

import type { Page } from 'playwright';

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

export interface SignupCandidate {
  url: string;
  /** high: şifre alanı + submit var. low: yalnızca email alanı bulundu. */
  confidence: 'high' | 'low';
  /** Kaç link takip edilerek ulaşıldı (0 = doğrudan yol). */
  hops: number;
  /** Nasıl bulunduğu — config notlarına yazılıyor. */
  method: 'direct-path' | 'link-follow' | 'origin';
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
async function tryUrl(
  page: Page,
  url: string,
  baseDomain?: string,
): Promise<'high' | 'low' | null> {
  try {
    // Kısa timeout: site ayakta olduğu zaten doğrulandı, bu yol yoksa
    // hızlıca sıradakine geçilmeli (8 yol × uzun timeout = dakikalar).
    const res = await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 12_000 });
    // 404/5xx sayfalarında form aramanın anlamı yok.
    if (res && res.status() >= 400) return null;
    // Yönlendirme başka siteye götürdüyse bu bizim kayıt sayfamız değil.
    if (baseDomain && !sameSite(page.url(), baseDomain)) return null;
    return await evaluateForm(page);
  } catch {
    return null;
  }
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
): Promise<SignupCandidate | null> {
  const maxHops = opts.maxHops ?? 2;
  const origin = originOf(website);
  const baseDomain = registrableHost(origin);

  // 0. Site ayakta mı? Yanıt vermeyen sitede 8 yolu tek tek denemek
  // site başına ~3 dk harcıyor (affordhunt.com boş sayfa döndürüyordu).
  // Tek kısa kontrolle bunu saniyelere indiriyoruz.
  const reachable = await page
    .goto(origin, { waitUntil: 'domcontentloaded', timeout: 15_000 })
    .then((res) => !res || res.status() < 400)
    .catch(() => false);

  if (!reachable) return null;

  // Ana sayfa boş mu? (park edilmiş/kapanmış domainler)
  const hasContent = await page
    .evaluate(() => (document.body?.innerText ?? '').trim().length > 50)
    .catch(() => false);

  if (!hasContent) return null;

  // 1. Doğrudan yollar — ucuz, çoğu sitede tutuyor.
  for (const path of DIRECT_PATHS) {
    const url = `${origin}${path}`;
    const confidence = await tryUrl(page, url, baseDomain);
    if (confidence) {
      return { url: page.url(), confidence, hops: 0, method: 'direct-path' };
    }
  }

  // 2. Ana sayfadaki kayıt linklerini takip et.
  try {
    await page.goto(origin, { waitUntil: 'domcontentloaded', timeout: 25_000 });
    await page.waitForTimeout(2500);
  } catch {
    return null;
  }

  // Ana sayfanın kendisinde form olabilir (tek sayfalık siteler).
  const onHome = await evaluateForm(page);
  if (onHome === 'high') {
    return { url: page.url(), confidence: 'high', hops: 0, method: 'origin' };
  }

  const links = await collectSignupLinks(page, origin);

  for (const link of links.slice(0, maxHops * 3)) {
    const confidence = await tryUrl(page, link, baseDomain);
    if (confidence) {
      return { url: page.url(), confidence, hops: 1, method: 'link-follow' };
    }

    // İkinci sıçrama: 10words deseni — ara sayfa asıl kayda yönlendiriyor.
    if (maxHops >= 2) {
      const second = await collectSignupLinks(page, origin);
      for (const inner of second.slice(0, 3)) {
        if (inner === link) continue;
        const innerConfidence = await tryUrl(page, inner, baseDomain);
        if (innerConfidence) {
          return { url: page.url(), confidence: innerConfidence, hops: 2, method: 'link-follow' };
        }
      }
    }
  }

  return null;
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
