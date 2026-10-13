import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { chromium, type Browser, type Page } from 'playwright';
import pino from 'pino';
import { runSteps } from '../src/adapters/generic.js';
import { parseSiteConfig } from '../src/adapters/schema.js';
import { classify, ManualReviewError } from '../src/core/errors.js';
import type { SignupContext, SiteConfig } from '../src/core/types.js';

/**
 * `humanInput` adımı: sistemin çözemediği bir alanı (görsel doğrulama kodu gibi) İNSAN doldurur; sistem alan dolana kadar
 * bekler, sonra akış sürer. Gerçek vaka: 7 yer imi sitesi ikinci adımda görsel doğrulama kodu istiyor; kodu çözmeye
 * çalışmak yerine alanları doldurup insanı bekleriz.
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

const PAGE = `
  <input id="code" type="text">
  <button id="go" type="button">Submit</button>
  <script>window.__clicked = false; window.__codeAtClick = null; document.getElementById('go').addEventListener('click', () => { window.__clicked = true; window.__codeAtClick = document.getElementById('code').value; });</script>`;

function config(steps: unknown[]): SiteConfig {
  return parseSiteConfig({ id: 'fx', name: 'Fx', risk: 'low', signupUrl: 'https://fx.example/signup', steps, verification: { mode: 'none' } }, 'test') as SiteConfig;
}

function context(site: SiteConfig, dryRun: boolean): SignupContext {
  return {
    page,
    site,
    identity: { email: 'x@example.com', username: 'x', password: 'pw', passwordVersion: 1 },
    profile: {},
    log: pino({ level: 'silent' }),
    artifacts: { dir: 'memory', shot: vi.fn(async () => 'memory/x.png'), html: vi.fn(async () => 'memory/x.html') },
    dryRun,
    requestHumanCaptcha: vi.fn(async () => undefined),
  } as unknown as SignupContext;
}

const clicked = () => page.evaluate(() => (window as unknown as { __clicked: boolean }).__clicked);
/** Gönder tıklandığı AN kod alanındaki değer (null: hiç tıklanmadı). */
const codeAtClick = () => page.evaluate(() => (window as unknown as { __codeAtClick: string | null }).__codeAtClick);
/** İnsan taklidi: bir süre sonra alana yazar. */
const typeLater = (value: string, ms: number) => setTimeout(() => void page.fill('#code', value), ms);

describe('humanInput', () => {
  it('insan alanı doldurana kadar bekler, sonra sonraki adım (gönder) çalışır', async () => {
    await page.setContent(PAGE);
    const site = config([{ type: 'humanInput', selector: '#code', settleMs: 300, timeoutMs: 10_000 }, { type: 'click', selector: '#go' }]);
    const started = Date.now();
    typeLater('x7k2p', 1_200);
    await runSteps(context(site, false), site.steps);

    expect(Date.now() - started).toBeGreaterThanOrEqual(1_000); // gerçekten bekledi
    expect(await clicked()).toBe(true); // alan dolduktan SONRA gönder tıklandı
  }, 30_000);

  it('alan zaten doluysa yalnızca oturma süresi kadar bekler', async () => {
    await page.setContent(PAGE);
    await page.fill('#code', 'hazir');
    const site = config([{ type: 'humanInput', selector: '#code', settleMs: 600, timeoutMs: 10_000 }, { type: 'click', selector: '#go' }]);
    const started = Date.now();
    await runSteps(context(site, false), site.steps);
    const took = Date.now() - started;
    expect(took).toBeGreaterThanOrEqual(500); // değerin oturduğundan emin olmak için bekledi
    expect(took).toBeLessThan(4_000);
    expect(await clicked()).toBe(true);
  }, 30_000);

  it('yazma SÜRERKEN (minLength geçilse bile) devam etmez: değer oturana kadar bekler, gönder TAM kodla tıklanır', async () => {
    // Gerçek vaka riski: 5-6 harflik görsel kod, minLength 3'e ulaşınca devam edilseydi gönder eksik kodla tıklanırdı.
    await page.setContent(PAGE);
    const site = config([{ type: 'humanInput', selector: '#code', minLength: 3, settleMs: 1_500, timeoutMs: 20_000 }, { type: 'click', selector: '#go' }]);
    const started = Date.now();
    ['ab', 'abc', 'abcd', 'abcde'].forEach((value, i) => typeLater(value, 300 + i * 700)); // 0,3 / 1,0 / 1,7 / 2,4 sn: harf harf
    await runSteps(context(site, false), site.steps);

    expect(await codeAtClick()).toBe('abcde'); // eksik kodla tıklanmadı
    expect(Date.now() - started).toBeGreaterThanOrEqual(2_400 + 1_300); // son harften sonra oturma süresi kadar bekledi
  }, 30_000);

  it('settleMs: 0 → alan minLength\'e ulaşır ulaşmaz devam eder', async () => {
    await page.setContent(PAGE);
    const site = config([{ type: 'humanInput', selector: '#code', minLength: 3, settleMs: 0, timeoutMs: 10_000 }, { type: 'click', selector: '#go' }]);
    typeLater('abc', 600);
    const started = Date.now();
    await runSteps(context(site, false), site.steps);
    expect(Date.now() - started).toBeLessThan(2_500);
    expect(await codeAtClick()).toBe('abc');
  }, 30_000);

  it('alan sayfadan kaybolursa (insan kendisi gönderdi ya da sayfa değişti) beklemeyi bırakır: hata yok, sonraki adım kendi koşuluyla karar verir', async () => {
    await page.setContent(PAGE);
    const site = config([
      { type: 'humanInput', selector: '#code', timeoutMs: 20_000 },
      { type: 'click', selector: '#go', when: { visible: '#code' } }, // alan yok → atlanır
    ]);
    setTimeout(() => void page.evaluate(() => document.getElementById('code')?.remove()), 900);
    const started = Date.now();
    await runSteps(context(site, false), site.steps);
    expect(Date.now() - started).toBeLessThan(6_000); // 20 sn'lik insan beklemesine takılmadı
    expect(await clicked()).toBe(false);
  }, 30_000);

  it('süre dolarsa ManualReviewError verir (manual): gönder TIKLANMAZ', async () => {
    await page.setContent(PAGE);
    const site = config([{ type: 'humanInput', selector: '#code', timeoutMs: 1_500 }, { type: 'click', selector: '#go' }]);
    const error = await runSteps(context(site, false), site.steps).then(() => null, (e: unknown) => e);

    expect(error).toBeInstanceOf(ManualReviewError);
    expect(classify(error)).toBe('manual');
    expect((error as Error).message).toContain('#code');
    expect(await clicked()).toBe(false);
  }, 30_000);

  it('minLength: daha kısa değer ve yalnızca boşluk yetmez', async () => {
    await page.setContent(PAGE);
    const site = config([{ type: 'humanInput', selector: '#code', minLength: 4, settleMs: 300, timeoutMs: 10_000 }, { type: 'click', selector: '#go' }]);
    const started = Date.now();
    await page.fill('#code', '  ab ');
    typeLater('abcd', 1_500); // yeterli uzunluk daha sonra yazılır
    await runSteps(context(site, false), site.steps);
    expect(Date.now() - started).toBeGreaterThanOrEqual(1_200); // "  ab " (2 karakter) bekletmeyi bitirmedi
    expect(await clicked()).toBe(true);
  }, 30_000);

  it("dry-run'da insan BEKLENMEZ ve hiçbir şey tıklanmaz (gözetimsiz doğrulama takılmasın)", async () => {
    await page.setContent(PAGE);
    const site = config([{ type: 'humanInput', selector: '#code', timeoutMs: 60_000 }, { type: 'click', selector: '#go' }]);
    const started = Date.now();
    await runSteps(context(site, true), site.steps);
    expect(Date.now() - started).toBeLessThan(2_000);
    expect(await clicked()).toBe(false);
  }, 30_000);

  it('alan sayfada yoksa: optional ise atlanır, değilse kalıcı hata', async () => {
    await page.setContent('<p>alan yok</p>');
    const optional = config([{ type: 'humanInput', selector: '#code', optional: true }]);
    await expect(runSteps(context(optional, false), optional.steps)).resolves.toBeUndefined();

    const required = config([{ type: 'humanInput', selector: '#code' }]);
    await expect(runSteps(context(required, false), required.steps)).rejects.toThrow(/Selector bulunamadı/);
  }, 60_000);

  it('şema: settleMs 0..30000 arası tam sayı', () => {
    const base = { id: 'fx', name: 'Fx', risk: 'low', signupUrl: 'https://fx.example/signup', verification: { mode: 'none' } };
    const withSettle = (settleMs: unknown) => ({ ...base, steps: [{ type: 'humanInput', selector: '#c', settleMs }] });
    expect(() => parseSiteConfig(withSettle(0), 't')).not.toThrow();
    expect(() => parseSiteConfig(withSettle(2_500), 't')).not.toThrow();
    expect(() => parseSiteConfig(withSettle(-1), 't')).toThrow();
    expect(() => parseSiteConfig(withSettle(1.5), 't')).toThrow();
    expect(() => parseSiteConfig(withSettle(30_001), 't')).toThrow();
  });

  it('şema: selector zorunlu, minLength pozitif tam sayı', () => {
    const base = { id: 'fx', name: 'Fx', risk: 'low', signupUrl: 'https://fx.example/signup', verification: { mode: 'none' } };
    expect(() => parseSiteConfig({ ...base, steps: [{ type: 'humanInput' }] }, 't')).toThrow();
    expect(() => parseSiteConfig({ ...base, steps: [{ type: 'humanInput', selector: '#c', minLength: 0 }] }, 't')).toThrow();
    expect(() => parseSiteConfig({ ...base, steps: [{ type: 'humanInput', selector: '#c', minLength: 2.5 }] }, 't')).toThrow();
    expect(() => parseSiteConfig({ ...base, steps: [{ type: 'humanInput', selector: '#c', minLength: 5, timeoutMs: 1000 }] }, 't')).not.toThrow();
  });
});
