import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { chromium, type Browser, type Page } from 'playwright';
import pino from 'pino';
import { runSteps } from '../src/adapters/generic.js';
import { parseSiteConfig } from '../src/adapters/schema.js';
import type { SignupContext, SiteConfig } from '../src/core/types.js';

/**
 * Önceden işaretli gelen pazarlama/bülten kutuları, gerçek bir tıklamadan (gönderim) önce kaldırılır.
 * Projenin kuralı: pazarlama onayı asla işaretli gitmez; yalnızca şartlar. (minds: "Receive exclusive
 * token rewards and info" site tarafından önceden işaretliydi.)
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
  <form id="f">
    <p><input type="checkbox" id="m1" checked><label for="m1">Receive exclusive token rewards and info</label></p>
    <p><label><input type="checkbox" id="m2" checked> Subscribe to our newsletter</label></p>
    <p><input type="checkbox" id="m3" checked aria-label="Send me promotions" style="opacity:0;position:absolute"></p>
    <p><input type="checkbox" id="t" checked><label for="t">I accept the terms and conditions</label></p>
    <p><input type="checkbox" id="c" checked><label for="c">I agree to the Terms and to receive product updates</label></p>
    <p><input type="checkbox" id="u"><label for="u">Receive our newsletter (kullanıcı işaretlemedi)</label></p>
    <button id="submit" type="button">Join</button>
  </form>
  <script>window.__submitted = false; document.getElementById('submit').addEventListener('click', () => { window.__submitted = true; });</script>`;

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

const checked = () =>
  page.evaluate(() => Object.fromEntries(Array.from(document.querySelectorAll<HTMLInputElement>('input[type=checkbox]')).map((i) => [i.id, i.checked])));
const submitted = () => page.evaluate(() => (window as unknown as { __submitted: boolean }).__submitted);

describe('önceden işaretli pazarlama kutuları', () => {
  it('gönderim tıklamasından ÖNCE kaldırılır; şartlar, birleşik onay ve kullanıcının işaretlemedikleri korunur', async () => {
    await page.setContent(PAGE);
    const site = config([{ type: 'click', selector: '#submit' }]);
    await runSteps(context(site, false), site.steps);

    expect(await checked()).toEqual({
      m1: false, // "Receive exclusive token rewards and info"
      m2: false, // sarmalayan etiket: "Subscribe to our newsletter"
      m3: false, // gizli kutu, yalnızca aria-label: "Send me promotions"
      t: true, // şartlar: dokunulmaz
      c: true, // birleşik "Terms ... and product updates": hukuki metin içerdiği için dokunulmaz (bozmaz)
      u: false, // zaten işaretsizdi
    });
    expect(await submitted()).toBe(true); // gönderim tıklaması yine yapıldı
  }, 30_000);

  it("dry-run'da hiçbir tıklama olmadığı için kutulara dokunulmaz", async () => {
    await page.setContent(PAGE);
    const site = config([{ type: 'click', selector: '#submit' }]);
    await runSteps(context(site, true), site.steps);
    expect((await checked()).m1).toBe(true);
    expect(await submitted()).toBe(false);
  }, 30_000);

  it('pazarlama kutusu olmayan sayfada hiçbir şeyi değiştirmez', async () => {
    await page.setContent(`<input type="checkbox" id="t" checked><label for="t">I accept the terms</label><button id="submit" type="button">Join</button>`);
    const site = config([{ type: 'click', selector: '#submit' }]);
    await runSteps(context(site, false), site.steps);
    expect(await page.evaluate(() => (document.getElementById('t') as HTMLInputElement).checked)).toBe(true);
  }, 30_000);
});
