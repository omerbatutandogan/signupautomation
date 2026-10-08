import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { chromium, type Browser, type Page } from 'playwright';
import { analyzeForm } from '../src/discovery/analyze-form.js';
import { generateConfig } from '../src/discovery/generate-config.js';
import { idSelector } from '../src/discovery/selectors.js';

/**
 * Keşif seçicileri: üretilmiş (her yüklemede değişen) id'ye GÜVENİLMEZ.
 *
 * 2026-10-06 toplu doğrulamada 110 taslak "Selector bulunamadı: #_xfUid-5-<zaman>" /
 * "#ctrl_<md5>" / "#<uuid>" ile düştü: keşif id'yi seçici yapmış, kayıt günü id değişmişti.
 * Aynı alanlarda sabit `name` vardı.
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

const candidate = { url: 'https://forum.example/register', via: 'direct-path', hops: 0, confidence: 'high' } as never;

const XENFORO = `
  <form action="/register">
    <input type="text" id="_xfUid-5-1790795823" name="username" placeholder="Username">
    <input type="email" id="_xfUid-6-1790795824" name="email" placeholder="Email">
    <input type="password" id="ctrl_4b96fac8a1d3f12bc9fd5a83d2e028d1" name="password">
    <input type="email" id="user_email_stable" name="alt_email">
    <input type="checkbox" id="3ffab6823d8" name="terms_agree" style="opacity:0;position:absolute;width:1px;height:1px">
    <label for="3ffab6823d8">I agree</label>
    <button type="submit" id="9aafcfe4-1b58-4680-b2d7-149be4f97468">Register</button>
  </form>`;

describe('analyzeForm — dinamik id seçici olmaz', () => {
  it('üretilmiş id yerine sabit name; sabit id korunur', async () => {
    await page.setContent(XENFORO);
    const a = await analyzeForm(page);
    const sel = Object.fromEntries(a.fields.map((f) => [f.name, f.selector]));
    expect(sel.username).toBe("input[name='username']");
    expect(sel.email).toBe("input[name='email']");
    expect(sel.password).toBe("input[name='password']");
    expect(sel.alt_email).toBe('#user_email_stable');
  }, 30_000);

  it('gönder butonu üretilmiş id yerine metin/kararlı seçiciyle seçilir', async () => {
    await page.setContent(XENFORO);
    const a = await analyzeForm(page);
    expect(a.submitSelector).toBe("button:has-text('Register')");
    expect(a.submitSelector).not.toMatch(/9aafcfe4/);
  }, 30_000);

  it('üretilmiş id\'li görünmez onay kutusu etiketi saran seçiciyle tıklanır (label[for=<dinamik>] değil)', async () => {
    await page.setContent(XENFORO);
    const a = await analyzeForm(page);
    const { config } = generateConfig({ id: 'forum', name: 'Forum', website: 'forum.example', candidate, analysis: a });
    const labelSteps = config.steps.filter((s) => s.type === 'click' && /^label/.test(s.selector ?? '')).map((s) => s.selector);
    expect(labelSteps.length).toBeGreaterThan(0);
    for (const s of labelSteps) expect(s).not.toMatch(/3ffab6823d8/);
    // Hiçbir üretilen seçici üretilmiş id içermez.
    const all = JSON.stringify(config.steps);
    expect(all).not.toMatch(/_xfUid|ctrl_4b96|3ffab6823d8|9aafcfe4/);
  }, 30_000);
});

describe('idSelector — CSS\'te geçerli seçici', () => {
  it('düz id # ile, noktalı/rakamla başlayan/özel karakterli id öznitelik seçicisiyle', () => {
    expect(idSelector('email')).toBe('#email');
    expect(idSelector('user_email-2')).toBe('#user_email-2');
    expect(idSelector('registerUser.email')).toBe("[id='registerUser.email']");
    expect(idSelector('3ffab6823d8')).toBe("[id='3ffab6823d8']");
    expect(idSelector('a:b')).toBe("[id='a:b']");
    expect(idSelector("o'k")).toBe("[id='o\\'k']");
  });

  it('gerçek tarayıcıda: noktalı id\'li alan bulunur (bibsonomy "#registerUser.email" vakası)', async () => {
    await page.setContent('<form><input id="registerUser.email" name="e"><input id="3ab" name="x"></form>');
    expect(await page.locator('#registerUser.email').count()).toBe(0); // eski seçici: eşleşmez
    expect(await page.locator(idSelector('registerUser.email')).count()).toBe(1);
    expect(await page.locator(idSelector('3ab')).count()).toBe(1);
  }, 30_000);

  it('analyzeForm noktalı id\'li alan için çalışan seçici üretir', async () => {
    await page.setContent('<form><input type="email" id="registerUser.email"><input type="password" id="registerUser.password"><button id="go.btn">Register</button></form>');
    const a = await analyzeForm(page);
    for (const f of a.fields) expect(await page.locator(f.selector).count(), f.selector).toBe(1);
  }, 30_000);
});
