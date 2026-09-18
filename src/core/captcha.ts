/**
 * Captcha tespiti ve insan devralma kapısı.
 *
 * Kritik ayrım: reCAPTCHA v3 ve managed Turnstile sessizce skorlar, insan
 * gerektirmez. Naif tespit her v3 sitesinde boşuna insan çağırır. Bu yüzden
 * tespit ≠ escalation: yalnızca GÖRÜNÜR interaktif challenge escalate edilir.
 */

import type { BrowserContext, Page } from 'playwright';
import type { CaptchaKind } from './types.js';

/** DOM markerları — ucuz, talep üzerine çalışır. */
const DOM_MARKERS: Record<CaptchaKind, string[]> = {
  recaptcha_v2: [
    'iframe[src*="google.com/recaptcha/api2/anchor"]',
    'iframe[src*="recaptcha/enterprise/anchor"]',
    '.g-recaptcha',
    '#g-recaptcha-response',
  ],
  recaptcha_v3: [
    'script[src*="recaptcha/api.js?render="]',
    'script[src*="recaptcha/enterprise.js?render="]',
  ],
  hcaptcha: ['iframe[src*="hcaptcha.com"]', '.h-captcha', '[data-hcaptcha-widget-id]'],
  turnstile: [
    'iframe[src*="challenges.cloudflare.com"]',
    '.cf-turnstile',
    'input[name="cf-turnstile-response"]',
  ],
  unknown_challenge: [
    '#challenge-running',
    '#cf-challenge-running',
    'iframe[title*="challenge" i]',
  ],
};

/**
 * GÖRÜNÜR interaktif challenge selectorları — insan gerçekten gerekli demek.
 * Anchor iframe'i (onay kutusu) değil, challenge iframe'i (resim bulmacası) aranıyor.
 */
const INTERACTIVE_MARKERS: string[] = [
  'iframe[src*="google.com/recaptcha/api2/bframe"]',
  'iframe[src*="recaptcha/enterprise/bframe"]',
  'iframe[title*="recaptcha challenge" i]',
  'iframe[src*="hcaptcha.com/captcha"]',
  'iframe[title*="hcaptcha challenge" i]',
  '[id^="cf-chl-widget"]',
];

/** Ağ seviyesi imzalar — shadow DOM / lazy inject DOM'dan kaçtığında yakalar. */
const NETWORK_SIGNATURES = /recaptcha\/(api2|enterprise)|hcaptcha\.com\/(checksiteconfig|getcaptcha)|challenges\.cloudflare\.com\/turnstile/;

const CAPTCHA_KINDS = Object.keys(DOM_MARKERS) as CaptchaKind[];

/** Context başına bir kez bağlanan ağ dinleyicisinin durumu. */
export interface CaptchaNetworkState {
  seen: boolean;
  urls: string[];
}

/**
 * Ağ dinleyicisini context'e bağlar. browser.ts bunu context oluştururken
 * bir kez çağırır; dönen state DOM'un kaçırdığı widget'ları görür.
 */
export function attachCaptchaSniffer(context: BrowserContext): CaptchaNetworkState {
  const state: CaptchaNetworkState = { seen: false, urls: [] };
  context.on('request', (req) => {
    const url = req.url();
    if (NETWORK_SIGNATURES.test(url)) {
      state.seen = true;
      if (state.urls.length < 10) state.urls.push(url);
    }
  });
  return state;
}

/** Sayfada herhangi bir captcha var mı? Tür döner, escalation kararı vermez. */
export async function detectCaptcha(
  page: Page,
  network?: CaptchaNetworkState,
): Promise<CaptchaKind | null> {
  for (const kind of CAPTCHA_KINDS) {
    for (const sel of DOM_MARKERS[kind]) {
      if ((await page.locator(sel).count()) > 0) return kind;
    }
  }

  // DOM temiz ama ağda captcha trafiği varsa: widget shadow DOM'da olabilir.
  if (network?.seen) {
    const url = network.urls.at(-1) ?? '';
    if (url.includes('hcaptcha')) return 'hcaptcha';
    if (url.includes('challenges.cloudflare.com')) return 'turnstile';
    if (url.includes('recaptcha')) return 'recaptcha_v2';
    return 'unknown_challenge';
  }

  return null;
}

/**
 * İnsan müdahalesi GERÇEKTEN gerekli mi?
 *
 * Tespit → kısa bekleme (widget render etsin) → görünür interaktif challenge
 * var mı? Yoksa passive (v3/managed Turnstile) demektir, akış devam eder.
 */
export async function needsHumanIntervention(
  page: Page,
  kind: CaptchaKind,
  settleMs = 2000,
): Promise<boolean> {
  // v3 hiçbir zaman interaktif değildir — sessizce skorlar.
  if (kind === 'recaptcha_v3') return false;

  await page.waitForTimeout(settleMs);

  for (const sel of INTERACTIVE_MARKERS) {
    const loc = page.locator(sel).first();
    if ((await loc.count()) === 0) continue;
    if (await loc.isVisible().catch(() => false)) return true;
  }

  // Turnstile/hCaptcha görünür onay kutusu da tıklama isteyebilir.
  if (kind === 'turnstile' || kind === 'hcaptcha') {
    for (const sel of DOM_MARKERS[kind]) {
      const loc = page.locator(sel).first();
      if ((await loc.count()) === 0) continue;
      if (await loc.isVisible().catch(() => false)) {
        const box = await loc.boundingBox().catch(() => null);
        // Görünür ve anlamlı boyutta bir widget → insan tıklaması gerekebilir.
        if (box && box.height > 20) return true;
      }
    }
  }

  return false;
}

/**
 * Captcha'nın çözüldüğünü DOM'dan izler.
 *
 * Dikkatli bir insan captcha'yı çözdüğünde Telegram'a /done yazmasına gerek
 * kalmasın diye: widget kaybolur ya da sayfa gezinirse otomatik çözülür.
 */
export async function waitForCaptchaCleared(
  page: Page,
  kind: CaptchaKind,
  timeoutMs: number,
): Promise<boolean> {
  const startUrl = page.url();
  const deadline = Date.now() + timeoutMs;
  const markers = [...DOM_MARKERS[kind], ...INTERACTIVE_MARKERS];

  while (Date.now() < deadline) {
    if (page.isClosed()) return false;

    // Sayfa gezindiyse form gönderilmiş demektir.
    if (page.url() !== startUrl) return true;

    let anyVisible = false;
    for (const sel of markers) {
      const loc = page.locator(sel).first();
      if ((await loc.count().catch(() => 0)) === 0) continue;
      if (await loc.isVisible().catch(() => false)) {
        anyVisible = true;
        break;
      }
    }
    if (!anyVisible) return true;

    await page.waitForTimeout(1500);
  }

  return false;
}
