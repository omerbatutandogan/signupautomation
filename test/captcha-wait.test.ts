import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { chromium, type Browser, type Page } from 'playwright';
import { detectCaptcha, waitForCaptcha } from '../src/core/captcha.js';

/**
 * Geç yüklenen captcha — gerçek tarayıcıda.
 *
 * BetaList (2026-09-28): captchaGate Turnstile yüklenmeden çalıştı, hiçbir
 * şey görmeden geçti, form token'sız gönderildi ve sunucu reddetti.
 * detectCaptcha anlık baktığı için gecikmeli widget'ı kaçırıyor;
 * waitForCaptcha kısa süre bekleyerek yakalamalı.
 */

let browser: Browser;
let page: Page;

beforeAll(async () => {
  browser = await chromium.launch({ headless: true });
  page = await browser.newPage();
}, 30_000);

afterAll(async () => {
  await browser?.close();
});

const DELAYED_TURNSTILE = `
  <form><input name="email"></form>
  <script>
    setTimeout(() => {
      const d = document.createElement('div');
      d.className = 'cf-turnstile';
      document.querySelector('form').appendChild(d);
    }, 1500);
  </script>`;

describe('waitForCaptcha', () => {
  it('anlık kontrol gecikmeli widget’ı KAÇIRIR (eski davranış)', async () => {
    await page.setContent(DELAYED_TURNSTILE);
    expect(await detectCaptcha(page)).toBeNull();
  });

  it('bekleyen kontrol gecikmeli widget’ı YAKALAR', async () => {
    await page.setContent(DELAYED_TURNSTILE);
    expect(await waitForCaptcha(page, 4000)).toBe('turnstile');
  });

  it('captcha yoksa süre dolunca null döner', async () => {
    await page.setContent('<form><input name="email"></form>');
    const started = Date.now();
    expect(await waitForCaptcha(page, 1000, 200)).toBeNull();
    expect(Date.now() - started).toBeGreaterThanOrEqual(1000);
  });
});
