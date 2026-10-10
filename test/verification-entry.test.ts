import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { chromium, type Browser, type Page } from 'playwright';
import { ManualReviewError } from '../src/core/errors.js';
import { enterVerificationCode } from '../src/core/verification-entry.js';

/**
 * Doğrulama kodu girişi: tek alan ve rakam başına bir kutu (bufferapps'in 6 kutusu).
 * Tek `fill` ikinci durumda yalnızca ilk kutuyu doldurup kodu bozuyordu.
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

const SPLIT = (boxes: number) => `
  <div id="otp">${'<input class="d" inputmode="numeric" maxlength="1">'.repeat(boxes)}</div>
  <button id="go" type="button">Submit</button>
  <script>
    window.__submitted = null;
    document.getElementById('go').addEventListener('click', () => {
      window.__submitted = Array.from(document.querySelectorAll('.d')).map((i) => i.value).join('');
    });
  </script>`;

const SINGLE = `
  <form id="f"><input id="code" name="code"><button type="submit">Verify</button></form>
  <script>
    window.__submitted = null;
    document.getElementById('f').addEventListener('submit', (e) => { e.preventDefault(); window.__submitted = document.getElementById('code').value; });
  </script>`;

const submitted = () => page.evaluate(() => (window as unknown as { __submitted: string | null }).__submitted);

describe('enterVerificationCode', () => {
  it('rakam başına bir kutu: her rakam kendi kutusuna yazılır, gönder butonuna basılır', async () => {
    await page.setContent(SPLIT(6));
    await enterVerificationCode(page, { codeSelector: '.d', codeSubmitSelector: '#go' }, '482916');
    expect(await page.$$eval('.d', (els) => els.map((e) => (e as HTMLInputElement).value))).toEqual(['4', '8', '2', '9', '1', '6']);
    expect(await submitted()).toBe('482916');
  }, 30_000);

  it('tek alan: kodun tamamı yazılır, gönder seçicisi yoksa Enter formu gönderir', async () => {
    await page.setContent(SINGLE);
    await enterVerificationCode(page, { codeSelector: '#code' }, '123456');
    expect(await submitted()).toBe('123456');
  }, 30_000);

  it('kutu sayısı kod uzunluğuna uymuyorsa elle bakılır ve HİÇBİR ŞEY yazılmaz', async () => {
    await page.setContent(SPLIT(4));
    await expect(enterVerificationCode(page, { codeSelector: '.d', codeSubmitSelector: '#go' }, '482916')).rejects.toBeInstanceOf(ManualReviewError);
    expect(await page.$$eval('.d', (els) => els.map((e) => (e as HTMLInputElement).value))).toEqual(['', '', '', '']);
    expect(await submitted()).toBeNull();
  }, 30_000);

  it('codeSelector yoksa ManualReviewError', async () => {
    await page.setContent(SINGLE);
    await expect(enterVerificationCode(page, {}, '123456')).rejects.toBeInstanceOf(ManualReviewError);
  }, 30_000);
});
