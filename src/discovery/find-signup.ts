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
    };
  });

  if (result.passwords > 0 && result.submits > 0) return 'high';
  if (result.emails > 0 && result.submits > 0) return 'low';
  return null;
}

/** Sayfayı açıp form değerlendirir; hata durumunda null döner. */
async function tryUrl(page: Page, url: string): Promise<'high' | 'low' | null> {
  try {
    const res = await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 20_000 });
    // 404/5xx sayfalarında form aramanın anlamı yok.
    if (res && res.status() >= 400) return null;
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

  // 1. Doğrudan yollar — ucuz, çoğu sitede tutuyor.
  for (const path of DIRECT_PATHS) {
    const url = `${origin}${path}`;
    const confidence = await tryUrl(page, url);
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
    const confidence = await tryUrl(page, link);
    if (confidence) {
      return { url: page.url(), confidence, hops: 1, method: 'link-follow' };
    }

    // İkinci sıçrama: 10words deseni — ara sayfa asıl kayda yönlendiriyor.
    if (maxHops >= 2) {
      const second = await collectSignupLinks(page, origin);
      for (const inner of second.slice(0, 3)) {
        if (inner === link) continue;
        const innerConfidence = await tryUrl(page, inner);
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

  const scored = raw
    .filter((l) => SIGNUP_LINK_TEXT.test(l.text) || SIGNUP_LINK_TEXT.test(l.href))
    .map((l) => {
      let score = 0;
      if (SIGNUP_LINK_TEXT.test(l.text)) score += 2;
      if (/sign\s*up|register|join/i.test(l.text)) score += 2;
      if (SIGNUP_LINK_TEXT.test(l.href)) score += 1;
      // Giriş sayfaları kayıt değil — sona at ama tamamen eleme
      // (bazı siteler kayıt/giriş aynı sayfada).
      if (LOGIN_HINT.test(l.text) && !/sign\s*up|register/i.test(l.text)) score -= 3;
      // Aynı domainde kalanlar önce; subdomain kabul (10words: portal.*)
      try {
        if (new URL(l.href).hostname.endsWith(new URL(origin).hostname.replace(/^www\./, ''))) {
          score += 1;
        }
      } catch {
        /* yoksay */
      }
      return { href: l.href, score };
    })
    .filter((l) => l.score > 0)
    .sort((a, b) => b.score - a.score);

  // Aynı URL birden fazla kez geçebilir.
  return [...new Set(scored.map((l) => l.href))];
}
