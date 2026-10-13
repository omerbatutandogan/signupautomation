import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { chromium, type Browser, type Page } from 'playwright';
import pino from 'pino';
import { runSteps } from '../src/adapters/generic.js';
import { parseSiteConfig } from '../src/adapters/schema.js';
import type { SignupContext, SiteConfig } from '../src/core/types.js';

/**
 * `when.waitMs`: koşul bir süreye kadar BEKLENİR. Gerçek vaka (1look4, 13 Ekim canlı çalıştırma): "Gönder" tıklaması 46 ms'de
 * döner, site formu ~270 ms SONRA gönderir ve yeni sayfa ~3 sn sonra açılır. 2. sayfanın adımları `when: {urlContains}` ile
 * korunuyordu ve koşul tıklamanın hemen ardından okunduğundan HEPSİ sessizce atlandı (hiçbir alan doldurulmadı, insan
 * bekletilmedi, gönder tıklanmadı) ve çalıştırma "unconfirmed" bitti.
 */

// İnsan hızında yazma bu testlerin konusu değil.
vi.mock('../src/core/formfill.js', async (original) => ({
  ...(await original<typeof import('../src/core/formfill.js')>()),
  typeHuman: async (locator: { fill(value: string): Promise<void> }, value: string) => locator.fill(value),
}));

let server: Server;
let browser: Browser;
let page: Page;
let base = '';

beforeAll(async () => {
  server = createServer((req, res) => {
    req.resume();
    req.on('end', () => {
      const { pathname } = new URL(req.url ?? '/', 'http://x');
      const send = (html: string) => {
        res.writeHead(200, { 'content-type': 'text/html' });
        res.end(`<!doctype html><html><body>${html}</body></html>`);
      };
      // Gerçek sitedeki gibi: tıklama hemen döner, form ~300 ms sonra JS ile gönderilir, sunucu yanıtı ~1 sn sonra verir.
      if (pathname === '/step1') {
        return send(
          `<form method="post" action="/step2" onsubmit="event.preventDefault(); var f = this; setTimeout(function () { f.submit(); }, 300)">
             <button id="go" type="submit">Next</button></form>`,
        );
      }
      if (pathname === '/step2') {
        setTimeout(() => send('<input id="t"><p id="done">step two</p>'), 1000);
        return;
      }
      if (pathname === '/static') return send('<input id="t">');
      if (pathname === '/late-banner') {
        return send(`<input id="t"><script>setTimeout(function () { document.body.insertAdjacentHTML('beforeend', '<p id="banner">banner</p>'); }, 700)</script>`);
      }
      res.writeHead(404);
      res.end();
    });
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  browser = await chromium.launch({ headless: true });
  page = await browser.newPage();
}, 30_000);

afterAll(async () => {
  await browser?.close();
  await new Promise((r) => server.close(r));
});

function config(steps: unknown[]): SiteConfig {
  return parseSiteConfig({ id: 'fx', name: 'Fx', risk: 'low', signupUrl: 'https://fx.example/signup', steps, verification: { mode: 'none' } }, 'test') as SiteConfig;
}

/** Günlük satırlarını toplayan logger (uyarının yazıldığını görmek için). */
function capturingLog() {
  const lines: Array<Record<string, unknown>> = [];
  const log = pino({ level: 'debug' }, { write: (chunk: string) => void lines.push(JSON.parse(chunk) as Record<string, unknown>) });
  return { log, lines };
}

function context(site: SiteConfig, dryRun: boolean, log = pino({ level: 'silent' })): SignupContext {
  return {
    page,
    site,
    identity: { email: 'x@example.com', username: 'x', password: 'pw', passwordVersion: 1 },
    profile: {},
    log,
    artifacts: { dir: 'memory', shot: vi.fn(async () => 'memory/x.png'), html: vi.fn(async () => 'memory/x.html') },
    dryRun,
    requestHumanCaptcha: vi.fn(async () => undefined),
  } as unknown as SignupContext;
}

const NEXT_PAGE_FILL = { type: 'fill', selector: '#t', value: 'merhaba' };

describe('when.waitMs', () => {
  it('KONTROL — waitMs yoksa koşul tıklamanın hemen ardından okunur: sonraki sayfanın adımı ATLANIR (gerçek vakadaki hata)', async () => {
    await page.goto(`${base}/step1`);
    const site = config([{ type: 'click', selector: '#go' }, { ...NEXT_PAGE_FILL, when: { urlContains: '/step2' } }]);
    await runSteps(context(site, false), site.steps);

    // Sayfa sonradan gerçekten değişir: yani atlama, sayfanın hiç gelmemesinden değil, koşulun ERKEN okunmasından.
    await page.waitForSelector('#t', { timeout: 10_000 });
    expect(page.url()).toContain('/step2');
    expect(await page.inputValue('#t')).toBe('');
  }, 30_000);

  it('waitMs ile koşul sağlanana kadar beklenir ve sonraki sayfanın adımı ÇALIŞIR', async () => {
    await page.goto(`${base}/step1`);
    const site = config([{ type: 'click', selector: '#go' }, { ...NEXT_PAGE_FILL, when: { urlContains: '/step2', waitMs: 8_000 } }]);
    const started = Date.now();
    await runSteps(context(site, false), site.steps);

    expect(page.url()).toContain('/step2');
    expect(await page.inputValue('#t')).toBe('merhaba');
    expect(Date.now() - started).toBeGreaterThanOrEqual(1_000); // gerçekten bekledi
    expect(Date.now() - started).toBeLessThan(8_000); // koşul sağlanır sağlanmaz devam etti
  }, 30_000);

  it('koşul zaten sağlanıyorsa beklemeden çalışır', async () => {
    await page.goto(`${base}/static`);
    const site = config([{ ...NEXT_PAGE_FILL, when: { visible: '#t', waitMs: 8_000 } }]);
    const started = Date.now();
    await runSteps(context(site, false), site.steps);

    expect(await page.inputValue('#t')).toBe('merhaba');
    expect(Date.now() - started).toBeLessThan(3_000);
  }, 30_000);

  it('süre dolarsa adım ATLANIR (hata değil), bekleme waitMs ile sınırlıdır ve uyarı yazılır', async () => {
    await page.goto(`${base}/static`);
    const site = config([{ ...NEXT_PAGE_FILL, when: { urlContains: '/hic-gelmeyen-sayfa', waitMs: 900 } }]);
    const { log, lines } = capturingLog();
    const started = Date.now();
    await expect(runSteps(context(site, false, log), site.steps)).resolves.toBeUndefined();
    const took = Date.now() - started;

    expect(await page.inputValue('#t')).toBe(''); // atlandı
    expect(took).toBeGreaterThanOrEqual(800); // süre boyunca bekledi
    expect(took).toBeLessThan(4_000); // sonsuza kadar değil
    const warn = lines.find((l) => l.level === 40 && /when koşulu/.test(String(l.msg)));
    expect(warn, 'gerçek çalıştırmada beklenen sayfa gelmediyse uyarı verilmeli').toBeDefined();
  }, 30_000);

  it('`visible` koşulu da beklenir (sayfada sonradan beliren öğe)', async () => {
    await page.goto(`${base}/late-banner`);
    const site = config([{ ...NEXT_PAGE_FILL, when: { visible: '#banner', waitMs: 5_000 } }]);
    const started = Date.now();
    await runSteps(context(site, false), site.steps);

    expect(await page.inputValue('#t')).toBe('merhaba');
    expect(Date.now() - started).toBeGreaterThanOrEqual(500);
  }, 30_000);

  it('adres VE görünürlük birlikte verilirse ikisi de beklenir', async () => {
    await page.goto(`${base}/step1`);
    const site = config([{ type: 'click', selector: '#go' }, { ...NEXT_PAGE_FILL, when: { urlContains: '/step2', visible: '#done', waitMs: 8_000 } }]);
    await runSteps(context(site, false), site.steps);
    expect(await page.inputValue('#t')).toBe('merhaba');
  }, 30_000);

  it("dry-run'da tıklama atlanır, sayfa hiç değişmez: adım waitMs sonra atlanır ve takılmaz (uyarı değil bilgi)", async () => {
    await page.goto(`${base}/step1`);
    const site = config([{ type: 'click', selector: '#go' }, { ...NEXT_PAGE_FILL, when: { urlContains: '/step2', waitMs: 900 } }]);
    const { log, lines } = capturingLog();
    const started = Date.now();
    await runSteps(context(site, true, log), site.steps);

    expect(Date.now() - started).toBeLessThan(5_000);
    await page.waitForTimeout(1_800); // tıklanmadıysa sayfa hâlâ 1. adımda olmalı
    expect(page.url()).toContain('/step1');
    expect(lines.some((l) => l.level === 40 && /when koşulu/.test(String(l.msg)))).toBe(false); // dry-run'da beklenen durum: uyarı gürültüsü yok
  }, 30_000);

  it('şema: waitMs pozitif tam sayı ve en çok 120 sn; verilmezse eski davranış', () => {
    const base = { id: 'fx', name: 'Fx', risk: 'low', signupUrl: 'https://fx.example/signup', verification: { mode: 'none' } };
    const withWhen = (when: unknown) => ({ ...base, steps: [{ type: 'click', selector: '#a', when }] });
    expect(() => parseSiteConfig(withWhen({ urlContains: '/x', waitMs: 20_000 }), 't')).not.toThrow();
    expect(() => parseSiteConfig(withWhen({ urlContains: '/x' }), 't')).not.toThrow();
    expect(() => parseSiteConfig(withWhen({ urlContains: '/x', waitMs: 0 }), 't')).toThrow();
    expect(() => parseSiteConfig(withWhen({ urlContains: '/x', waitMs: -5 }), 't')).toThrow();
    expect(() => parseSiteConfig(withWhen({ urlContains: '/x', waitMs: 1.5 }), 't')).toThrow();
    expect(() => parseSiteConfig(withWhen({ urlContains: '/x', waitMs: 120_001 }), 't')).toThrow();
  });
});
