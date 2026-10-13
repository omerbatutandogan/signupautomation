import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { chromium, type Browser, type Page } from 'playwright';
import { parseSiteConfig } from '../src/adapters/schema.js';
import { canAutoVerify, checkDryRunPage } from '../src/core/dry-run-check.js';
import type { SiteConfig } from '../src/core/types.js';

/**
 * Dry-run kontrolünün KAPSAMI — gerçek tarayıcıda.
 *
 * Kontrol eskiden bütün sayfanın zorunlu alanlarını tarıyordu. Kayıt
 * formunun yanındaki giriş/şifre sıfırlama formları da sayılıyordu:
 * ontoplist'te gizli oldukları için yalnızca uyarıydı, görünür olsalar
 * "kritik alan boş" sayılıp doğru config manual'a düşerdi.
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

function config(fillSelectors: string[]): SiteConfig {
  // generate-config.ts ile aynı dönüşüm: şema tipi emailLocalPart'ı
  // opsiyonel tutuyor, SiteConfig zorunlu.
  return parseSiteConfig(
    {
      id: 'fixture',
      name: 'Fixture',
      risk: 'low',
      signupUrl: 'https://example.com/signup',
      steps: [
        { type: 'goto', url: '{{signupUrl}}' },
        ...fillSelectors.map((selector) => ({ type: 'fill', selector, field: 'email' })),
        { type: 'click', selector: '#su-submit' },
      ],
      verification: { mode: 'none' },
    },
    'test',
  ) as SiteConfig;
}

describe('checkDryRunPage — sayfada olmayan alan', () => {
  it('sonraki sayfaya ait (sayfada hiç olmayan) alanı BEKLEMEZ: zaman aşımı kadar takılmaz', async () => {
    // Çok sayfalı listeleme formlarında 2. sayfanın alanları `when` ile korunur; dry-run 1. sayfada kalır.
    // Eskiden her biri için tüm zaman aşımı beklenirdi (gerçek 1look4 dry-run'ı 53 sn sürdü).
    await page.setContent('<form><input id="su-email" name="email" required value="a@b.com"><button id="su-submit">Kayıt</button></form>');
    page.setDefaultTimeout(4_000);
    try {
      const started = Date.now();
      const issues = await checkDryRunPage(page, config(['#su-email', '#ikinci-sayfa-1', '#ikinci-sayfa-2']));
      expect(Date.now() - started).toBeLessThan(2_500);
      expect(issues).toEqual([]); // olmayan alan "boş alan" sayılmaz
    } finally {
      page.setDefaultTimeout(30_000);
    }
  }, 30_000);

  it('sayfada olan boş alanı HÂLÂ yakalar (bekleme kaldırılırken kontrol gevşemedi)', async () => {
    await page.setContent('<form><input id="su-email" name="email"><button id="su-submit">Kayıt</button></form>');
    const issues = await checkDryRunPage(page, config(['#su-email']));
    expect(issues.map((i) => i.kind)).toContain('empty_field');
  });
});

describe('checkDryRunPage — form kapsamı', () => {
  it('yandaki GÖRÜNÜR giriş formunun boş alanlarını kritik saymaz', async () => {
    await page.setContent(`
      <form id="signup">
        <input id="su-email" name="email" required>
        <input id="su-pass" name="password" type="password" required>
        <button id="su-submit">Kayıt ol</button>
      </form>
      <form id="login">
        <input id="li-email" name="loginemail" required>
        <input id="li-pass" name="loginpassword" type="password" required>
        <button>Giriş</button>
      </form>`);
    await page.fill('#su-email', 'a@b.com');
    await page.fill('#su-pass', 'Gizli-123');

    const issues = await checkDryRunPage(page, config(['#su-email', '#su-pass']));
    expect(issues.map((i) => i.selector)).not.toContain('loginemail');
    expect(canAutoVerify(issues)).toBe(true);
  });

  it('kayıt formundaki doldurulmamış zorunlu alanı HÂLÂ yakalar', async () => {
    // "bozuk config" vakası: şifre fill adımı eksik, alan boş kaldı.
    await page.setContent(`
      <form id="signup">
        <input id="su-email" name="email" required>
        <input id="su-pass" name="password" type="password" required>
        <button id="su-submit">Kayıt ol</button>
      </form>`);
    await page.fill('#su-email', 'a@b.com');

    const issues = await checkDryRunPage(page, config(['#su-email']));
    expect(issues.some((i) => i.selector === 'password' && /Kritik/.test(i.detail))).toBe(true);
    expect(canAutoVerify(issues)).toBe(false);
  });

  it('hiç <form> yoksa bütün sayfayı tarar', async () => {
    // Bazı React sayfaları form etiketi kullanmıyor — kapsam
    // belirlenemiyorsa eski davranış.
    await page.setContent(`
      <div>
        <input id="su-email" name="email" required>
        <input id="su-pass" name="password" type="password" required>
        <button id="su-submit">Kayıt ol</button>
      </div>`);
    await page.fill('#su-email', 'a@b.com');

    const issues = await checkDryRunPage(page, config(['#su-email']));
    expect(issues.some((i) => i.selector === 'password')).toBe(true);
  });
});
