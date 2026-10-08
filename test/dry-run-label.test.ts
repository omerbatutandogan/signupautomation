import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { chromium, type Browser, type Page } from 'playwright';
import pino from 'pino';
import { makeGenericAdapter } from '../src/adapters/generic.js';
import { parseSiteConfig } from '../src/adapters/schema.js';
import { checkDryRunPage } from '../src/core/dry-run-check.js';
import { checkboxLabelSelector, isCheckboxLabelClick, looksDynamicId } from '../src/discovery/selectors.js';
import type { SignupContext, SiteConfig } from '../src/core/types.js';

/**
 * Dry-run ve onay kutusu etiketi — gerçek tarayıcıda.
 *
 * Config, görünmez (özel stilli) şartlar kutusunu `label[for=…]` TIKLAMASIYLA işaretler.
 * Dry-run tüm tıklamaları atladığı için kutu boş kalıyor ve sayfa "zorunlu alan boş" diye
 * doğru bir config'i başarısız sayıyordu (2026-10-06: 19 site). Etiket tıklaması formu
 * göndermez; ama etiketin içinde "Şartlar" bağlantısı olabilir: oraya gidilmemeli.
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

const FORM = `
  <form id="f">
    <input id="em" name="email">
    <input type="checkbox" id="terms-box" name="terms" required style="position:absolute;opacity:0;width:1px;height:1px">
    <label for="terms-box" id="lbl">I agree to the <a href="https://example.com/terms" id="tl">Terms</a></label>
    <button id="submit" type="submit">Join</button>
  </form>
  <script>
    window.__submitted = false; window.__linkClicked = false;
    document.getElementById('f').addEventListener('submit', (e) => { e.preventDefault(); window.__submitted = true; });
    document.getElementById('tl').addEventListener('click', (e) => { e.preventDefault(); window.__linkClicked = true; });
  </script>`;

function config(steps: unknown[]): SiteConfig {
  return parseSiteConfig(
    { id: 'fx', name: 'Fx', risk: 'low', signupUrl: 'https://fx.example/signup', steps, verification: { mode: 'none' } },
    'test',
  ) as SiteConfig;
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

const steps = (labelSelector: string) => [
  { type: 'fill', selector: '#em', field: 'email' },
  { type: 'click', selector: labelSelector, optional: true },
  { type: 'click', selector: '#submit' },
];

const state = () => page.evaluate(() => ({
  checked: (document.getElementById('terms-box') as HTMLInputElement).checked,
  submitted: (window as unknown as { __submitted: boolean }).__submitted,
  linkClicked: (window as unknown as { __linkClicked: boolean }).__linkClicked,
}));

describe('dry-run: onay kutusu etiketi', () => {
  it("kutuyu işaretler, bağlantıya GİTMEZ, formu GÖNDERMEZ; dry-run denetimi kutuyu dolu görür", async () => {
    await page.setContent(FORM);
    const site = config(steps("label[for='terms-box']"));
    await makeGenericAdapter(site).signup(context(site, true));

    expect(await state()).toEqual({ checked: true, submitted: false, linkClicked: false });
    const issues = await checkDryRunPage(page, site);
    expect(issues.filter((i) => /terms/.test(i.selector))).toEqual([]);
  }, 30_000);

  it('etiket tıklaması olmadan kutu boş kalır ve denetim bunu kritik hata sayar (testin amacı gerçek)', async () => {
    await page.setContent(FORM);
    const site = config([{ type: 'fill', selector: '#em', field: 'email' }, { type: 'click', selector: '#submit' }]);
    await makeGenericAdapter(site).signup(context(site, true));
    expect((await checkDryRunPage(page, site)).some((i) => /ZORUNLU/.test(i.detail))).toBe(true);
  }, 30_000);

  it('üretilmiş id\'li kutuda etiketi saran seçiciyle çalışır', async () => {
    await page.setContent(FORM.replace(/terms-box/g, 'ctrl_4b96fac8a1d3f12bc9fd5a83d2e028d1'));
    const sel = checkboxLabelSelector('ctrl_4b96fac8a1d3f12bc9fd5a83d2e028d1', "input[name='terms']");
    expect(sel).toBe("label:has(input[name='terms'])");
    // Bu sayfada kutu etiketin İÇİNDE değil (for=…); :has eşleşmezse optional adım atlanır, kutu boş kalır.
    // Kutu etiketin içindeyken çalıştığını ayrıca doğrula:
    await page.setContent(`<form id="f"><label><input type="checkbox" name="terms" required style="opacity:0"> I agree</label><input id="em" name="email"></form>`);
    const site = config([{ type: 'fill', selector: '#em', field: 'email' }, { type: 'click', selector: sel, optional: true }]);
    await makeGenericAdapter(site).signup(context(site, true));
    expect(await page.evaluate(() => (document.querySelector('[name=terms]') as HTMLInputElement).checked)).toBe(true);
  }, 30_000);

  it("başka hiçbir tıklama dry-run'da yapılmaz: gönder butonu ve düz bağlantı etiketi atlanır", async () => {
    await page.setContent(FORM);
    const site = config([{ type: 'click', selector: '#submit' }, { type: 'click', selector: '#tl', optional: true }]);
    await makeGenericAdapter(site).signup(context(site, true));
    expect(await state()).toEqual({ checked: false, submitted: false, linkClicked: false });
  }, 30_000);
});

describe('dry-run: sıradan "zaten kayıtlı?" metni doğrulamayı engellemez', () => {
  const PAGE = `<form id="f"><p>Already registered? <a href="/login">Log in</a></p><input id="em" name="email"><button id="submit" type="submit">Join</button></form>`;

  it('dry-run: alan doldurma denetlenir, sonuç submitted (already_exists değil)', async () => {
    await page.setContent(PAGE);
    const site = config([{ type: 'fill', selector: '#em', field: 'email' }, { type: 'click', selector: '#submit' }]);
    const result = await makeGenericAdapter(site).signup(context(site, true));
    expect(result.status).toBe('submitted');
    expect(await page.inputValue('#em')).toBe('x@example.com');
  }, 30_000);

  it('gerçek çalıştırma: aynı metin hâlâ already_exists (davranış değişmedi)', async () => {
    await page.setContent(PAGE);
    const site = config([{ type: 'fill', selector: '#em', field: 'email' }]);
    const result = await makeGenericAdapter(site).signup(context(site, false));
    expect(result.status).toBe('already_exists');
  }, 30_000);
});

describe('gerçek çalıştırma (kontrol)', () => {
  it('etiket ve gönder butonu tıklanır — davranış değişmedi', async () => {
    await page.setContent(FORM);
    const site = config(steps("label[for='terms-box']"));
    // Etiketin ortası "Terms" bağlantısına düşebilir; bu testte yalnızca gönderimin yapıldığını doğrula.
    await makeGenericAdapter(site).signup(context(site, false)).catch(() => undefined);
    expect((await state()).submitted).toBe(true);
  }, 30_000);
});

describe('dry-run: etiket bir onay kutusuna bağlı DEĞİLSE dokunulmaz', () => {
  // `label[for=…]` biçimi onay kutusu etiketi gibi görünür ama bir gönder butonunu da gösterebilir;
  // o etiketi tıklamak formu GÖNDERİR. Dry-run yalnızca gerçek checkbox/radio'yu işaretler.
  const PAGE = (control: string) => `
    <form id="f"><input name="email">${control}<label for="go" id="lbl">Go</label></form>
    <script>
      window.__submitted = false;
      document.getElementById('f').addEventListener('submit', (e) => { e.preventDefault(); window.__submitted = true; });
    </script>`;
  const submitted = () => page.evaluate(() => (window as unknown as { __submitted: boolean }).__submitted);

  for (const [name, control] of [
    ['<button>', '<button id="go" type="submit">Go</button>'],
    ['<input type=submit>', '<input id="go" type="submit" value="Go">'],
  ] as const) {
    it(`etiket bir ${name} gösteriyorsa tıklanmaz, form GÖNDERİLMEZ`, async () => {
      await page.setContent(PAGE(control));
      const site = config([{ type: 'click', selector: "label[for='go']" }]);
      await makeGenericAdapter(site).signup(context(site, true));
      expect(await submitted()).toBe(false);
    }, 30_000);
  }

  it('kontrol: gerçek onay kutusu etiketi yine işaretler', async () => {
    await page.setContent(PAGE('<input id="go" type="checkbox" name="go">'));
    const site = config([{ type: 'click', selector: "label[for='go']" }]);
    await makeGenericAdapter(site).signup(context(site, true));
    expect(await page.evaluate(() => (document.getElementById('go') as HTMLInputElement).checked)).toBe(true);
  }, 30_000);
});

describe('selectors', () => {
  it('etiket tıklamasını tanır', () => {
    expect(isCheckboxLabelClick("label[for='x']")).toBe(true);
    expect(isCheckboxLabelClick('label:has(input[name=t])')).toBe(true);
    for (const s of ['#submit', "button[type='submit']", 'a.terms', "labelx[for='a']", '']) expect(isCheckboxLabelClick(s)).toBe(false);
  });
  it('üretilmiş kimlikleri tanır, kararlıları tanımaz (2026-10-06 gerçek örnekleri)', () => {
    for (const id of ['9aafcfe4-1b58-4680-b2d7-149be4f97468', '_xfUid-5-1790795823', 'ctrl_4b96fac8a1d3f12bc9fd5a83d2e028d1', 'react-aria1868403586-11611', '_R_11aht6_-form-item', 'mantine-salpigra7', 'email790437677', '3ffab6823d8', 'signup-emailr-6abeab5ce9986', ':r1a:']) {
      expect(looksDynamicId(id), id).toBe(true);
    }
    for (const id of ['email', 'user_email', 'elInput_email_address', 'new-account-email', 'id_email', 'fos_user_registration_form_email', 'member_login_190-element-10', 'ReduxFormInput1', 'signup-email-input']) {
      expect(looksDynamicId(id), id).toBe(false);
    }
  });
});
