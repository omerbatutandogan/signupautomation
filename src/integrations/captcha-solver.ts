/**
 * 2captcha entegrasyonu — SİTE BAZINDA OPT-IN.
 *
 * ÖNEMLİ SINIR: Yalnızca config'inde "solveCaptcha": true olan sitelerde
 * devreye girer. Varsayılan KAPALI çünkü bazı dizinlerin kullanım şartları
 * CAPTCHA bypass'ını açıkça yasaklıyor (G2, Capterra vb.) ve hesabın
 * askıya alınması kalıcı listing kaybı demek.
 *
 * Yüksek riskli siteler (risk: "high") zaten ağ isteği yapılmadan
 * reddediliyor (runner.ts risk kapısı) — orada asla çalışmaz.
 */

import type { Page } from 'playwright';
import type { Logger } from 'pino';
import { env } from '../config.js';
import { ManualReviewError, TransientError } from '../core/errors.js';
import type { CaptchaKind } from '../core/types.js';

const API_BASE = 'https://2captcha.com';

/** Çözüm bekleme: 2captcha tipik olarak 15-60 sn sürüyor. */
const POLL_INTERVAL_MS = 5_000;
const MAX_WAIT_MS = 180_000;

interface SubmitResponse {
  status: number;
  request: string;
}

/** 2captcha'nın tanıdığı görev tipleri. */
const METHOD_BY_KIND: Partial<Record<CaptchaKind, string>> = {
  turnstile: 'turnstile',
  hcaptcha: 'hcaptcha',
  recaptcha_v2: 'userrecaptcha',
  recaptcha_v3: 'userrecaptcha',
};

export function isSolverConfigured(): boolean {
  return env.CAPTCHA_API_KEY.length > 0;
}

/**
 * Captcha frame URL'inden sitekey çıkarır.
 *
 * Sitekey iki yerde olabilir:
 *  - sorgu parametresi: ?k=... veya ?sitekey=...
 *  - YOL SEGMENTİ: .../turnstile/f/av0/rch/3k4pd/0x4AAAAAA.../auto/...
 *    Gerçek vaka (BetaList): yalnızca parametre aramak bunu kaçırıyordu.
 */
export function sitekeyFromFrameUrl(url: string): string | null {
  const fromQuery = /[?&](?:k|sitekey)=([^&]+)/.exec(url);
  if (fromQuery?.[1]) return decodeURIComponent(fromQuery[1]);

  // Turnstile sitekey'leri "0x" ile başlar; reCAPTCHA/hCaptcha
  // anahtarları uzun alfanümerik segmentler.
  const fromPath =
    /\/(0x[0-9A-Za-z_-]{15,})\//.exec(url) ?? /\/([0-9A-Za-z_-]{30,})\//.exec(url);
  return fromPath?.[1] ?? null;
}

/**
 * Sayfadan captcha sitekey'ini çıkarır.
 *
 * Widget Shadow DOM'da olabildiği için birden fazla yere bakıyor:
 * DOM attribute, frame URL'i, sayfa kaynağı.
 */
export async function extractSitekey(page: Page, kind: CaptchaKind): Promise<string | null> {
  // 1. DOM attribute — en yaygın.
  const fromDom = await page
    .evaluate(() => {
      const el = document.querySelector('[data-sitekey]');
      return el?.getAttribute('data-sitekey') ?? null;
    })
    .catch(() => null);
  if (fromDom) return fromDom;

  // 2. Frame URL'i (Shadow DOM widget'ları).
  for (const frame of page.frames()) {
    const fromUrl = sitekeyFromFrameUrl(frame.url());
    if (fromUrl) return fromUrl;
  }

  // 3. Sayfa kaynağında render çağrısı.
  const fromSource = await page
    .content()
    .then((html) => {
      const patterns = [
        /sitekey["'\s:]+([0-9A-Za-z_-]{20,})/,
        /data-sitekey=["']([0-9A-Za-z_-]{20,})["']/,
      ];
      for (const re of patterns) {
        const m = re.exec(html);
        if (m?.[1]) return m[1];
      }
      return null;
    })
    .catch(() => null);

  return fromSource;
}

async function submitTask(
  kind: CaptchaKind,
  sitekey: string,
  pageUrl: string,
): Promise<string> {
  const method = METHOD_BY_KIND[kind];
  if (!method) {
    throw new ManualReviewError(`2captcha bu captcha tipini desteklemiyor: ${kind}`);
  }

  const params = new URLSearchParams({
    key: env.CAPTCHA_API_KEY,
    method,
    sitekey,
    pageurl: pageUrl,
    json: '1',
  });

  const res = await fetch(`${API_BASE}/in.php`, {
    method: 'POST',
    body: params,
  });

  const data = (await res.json()) as SubmitResponse;
  if (data.status !== 1) {
    // ERROR_ZERO_BALANCE gibi hatalar kalıcı; ağ hataları geçici.
    if (/BALANCE|KEY/i.test(data.request)) {
      throw new ManualReviewError(`2captcha hatası: ${data.request}`);
    }
    throw new TransientError(`2captcha görev gönderilemedi: ${data.request}`);
  }
  return data.request;
}

async function pollResult(taskId: string, log: Logger): Promise<string> {
  const deadline = Date.now() + MAX_WAIT_MS;

  while (Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, POLL_INTERVAL_MS));

    const params = new URLSearchParams({
      key: env.CAPTCHA_API_KEY,
      action: 'get',
      id: taskId,
      json: '1',
    });

    const res = await fetch(`${API_BASE}/res.php?${params.toString()}`);
    const data = (await res.json()) as SubmitResponse;

    if (data.status === 1) return data.request;
    if (data.request === 'CAPCHA_NOT_READY') {
      log.debug({ taskId }, '2captcha çözüm bekleniyor');
      continue;
    }
    throw new TransientError(`2captcha çözüm hatası: ${data.request}`);
  }

  throw new TransientError(`2captcha ${MAX_WAIT_MS / 1000} saniyede çözemedi`);
}

/**
 * Çözülen token'ı sayfaya enjekte eder.
 *
 * Her captcha tipinin kendi gizli alanı var; ayrıca bazı siteler
 * callback bekliyor.
 */
async function injectToken(page: Page, kind: CaptchaKind, token: string): Promise<void> {
  await page.evaluate(
    ({ kind, token }) => {
      const selectors: Record<string, string[]> = {
        turnstile: ['input[name="cf-turnstile-response"]', 'input[name="g-recaptcha-response"]'],
        hcaptcha: ['textarea[name="h-captcha-response"]', 'input[name="h-captcha-response"]'],
        recaptcha_v2: ['textarea[name="g-recaptcha-response"]', '#g-recaptcha-response'],
        recaptcha_v3: ['textarea[name="g-recaptcha-response"]', '#g-recaptcha-response'],
      };

      for (const sel of selectors[kind] ?? []) {
        for (const el of Array.from(document.querySelectorAll(sel))) {
          const input = el as HTMLInputElement | HTMLTextAreaElement;
          input.value = token;
          // Framework'ler (React/Vue) değişikliği fark etsin.
          input.dispatchEvent(new Event('input', { bubbles: true }));
          input.dispatchEvent(new Event('change', { bubbles: true }));
        }
      }

      // Alan hiç yoksa oluştur — bazı siteler submit anında okuyor.
      if ((selectors[kind] ?? []).every((s) => !document.querySelector(s))) {
        const name = kind === 'turnstile' ? 'cf-turnstile-response' : 'g-recaptcha-response';
        const hidden = document.createElement('input');
        hidden.type = 'hidden';
        hidden.name = name;
        hidden.value = token;
        document.querySelector('form')?.appendChild(hidden);
      }
    },
    { kind, token },
  );
}

/**
 * Captcha'yı 2captcha ile çözer ve token'ı sayfaya yerleştirir.
 *
 * Çağıran taraf opt-in kontrolünü YAPMIŞ olmalı — bu fonksiyon
 * kendisi izin sorgulamıyor.
 */
export async function solveCaptcha(
  page: Page,
  kind: CaptchaKind,
  log: Logger,
): Promise<void> {
  if (!isSolverConfigured()) {
    throw new ManualReviewError('CAPTCHA_API_KEY tanımsız — 2captcha kullanılamaz');
  }

  const sitekey = await extractSitekey(page, kind);
  if (!sitekey) {
    throw new ManualReviewError(`Captcha sitekey bulunamadı (${kind}) — elle çözülmeli`);
  }

  const pageUrl = page.url();
  log.info({ kind, sitekey: `${sitekey.slice(0, 12)}…` }, '2captcha görevi gönderiliyor');

  const taskId = await submitTask(kind, sitekey, pageUrl);
  const token = await pollResult(taskId, log);

  await injectToken(page, kind, token);
  log.info({ kind, tokenLength: token.length }, '2captcha çözdü, token yerleştirildi');
}
