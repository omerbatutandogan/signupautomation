import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { chromium, type Browser, type Page } from 'playwright';
import pino from 'pino';
import { makeGenericAdapter } from '../src/adapters/generic.js';
import type { SignupContext, SiteConfig } from '../src/core/types.js';

/**
 * captchaGate adımı dry-run'da.
 *
 * Dry-run submit etmez; captcha yalnızca submit'i korur, yani çözmenin faydası
 * yok. Ama maliyeti var: 2captcha ücretli ve ToS riski taşıyor, insan beklemek
 * ise (CAPTCHA_TIMEOUT_MS, varsayılan 15 dk) yüzlerce taslağı doğrulayan başsız
 * bir toplu çalıştırmayı saatlerce durdururdu. Çözücü burada HİÇBİR ZAMAN gerçek
 * çağrılmaz: modül sahte ile değiştirildi (yerel .env'de gerçek anahtar var).
 */

const solver = vi.hoisted(() => ({
  solveCaptcha: vi.fn(async () => undefined),
  isSolverConfigured: vi.fn(() => true),
}));
vi.mock('../src/integrations/captcha-solver.js', () => solver);

let browser: Browser;
let page: Page;

beforeAll(async () => {
  browser = await chromium.launch({ headless: true });
  page = await browser.newPage();
}, 30_000);

afterAll(async () => {
  await browser?.close();
});

beforeEach(() => {
  solver.solveCaptcha.mockClear();
  solver.isSolverConfigured.mockClear();
});

// Çözülmemiş Turnstile: DOM'da widget var, token yok → interaktif sayılır.
const PAGE_WITH_CAPTCHA = `
  <form>
    <input name="email">
    <div class="cf-turnstile" data-sitekey="test"></div>
  </form>`;

function config(overrides: Partial<SiteConfig> = {}): SiteConfig {
  return {
    id: 'fixture',
    name: 'Fixture',
    risk: 'low',
    signupUrl: 'https://fixture.example/signup',
    steps: [{ type: 'captchaGate' }],
    verification: { mode: 'none' },
    ...overrides,
  } as unknown as SiteConfig;
}

function context(site: SiteConfig, dryRun: boolean) {
  const requestHumanCaptcha = vi.fn(async () => undefined);
  const shot = vi.fn(async (name: string) => `memory/${name}.png`);
  const ctx = {
    page,
    site,
    identity: { email: 'x@example.com', username: 'x', password: 'pw', passwordVersion: 1 },
    profile: {},
    log: pino({ level: 'silent' }),
    artifacts: { dir: 'memory', shot, html: vi.fn(async () => 'memory/x.html') },
    dryRun,
    requestHumanCaptcha,
  } as unknown as SignupContext;
  return { ctx, requestHumanCaptcha, shot };
}

describe('captchaGate — dry-run', () => {
  it('captcha görünürken çözücüyü ÇAĞIRMAZ ve insan beklemez; akış sürer', async () => {
    await page.setContent(PAGE_WITH_CAPTCHA);
    const site = config();
    const { ctx, requestHumanCaptcha, shot } = context(site, true);

    const started = Date.now();
    const result = await makeGenericAdapter(site).signup(ctx);

    expect(result.status).toBe('submitted'); // adım hata vermeden geçti
    expect(solver.solveCaptcha).not.toHaveBeenCalled();
    expect(solver.isSolverConfigured).not.toHaveBeenCalled();
    expect(requestHumanCaptcha).not.toHaveBeenCalled();
    // Görüldüğü ekran görüntüsüyle kayda geçer (gerçek kayıtta hangi sitede captcha var?).
    expect(shot).toHaveBeenCalledWith('captcha-turnstile');
    // İnsan beklenseydi dakikalar sürerdi; settle bekleyişi de atlanır.
    expect(Date.now() - started).toBeLessThan(10_000);
  }, 30_000);

  it('captcha yoksa dry-run da gerçek çalıştırma gibi sessizce geçer', async () => {
    await page.setContent('<form><input name="email"></form>');
    const site = config();
    const { ctx, requestHumanCaptcha, shot } = context(site, true);

    expect((await makeGenericAdapter(site).signup(ctx)).status).toBe('submitted');
    expect(solver.solveCaptcha).not.toHaveBeenCalled();
    expect(requestHumanCaptcha).not.toHaveBeenCalled();
    expect(shot).not.toHaveBeenCalled();
  }, 30_000);
});

describe('captchaGate — gerçek çalıştırma (kontrol)', () => {
  it('captcha görünürken çözücü çağrılır (davranış değişmedi)', async () => {
    await page.setContent(PAGE_WITH_CAPTCHA);
    const site = config();
    const { ctx, requestHumanCaptcha } = context(site, false);

    await makeGenericAdapter(site).signup(ctx);

    expect(solver.solveCaptcha).toHaveBeenCalledTimes(1);
    expect(requestHumanCaptcha).not.toHaveBeenCalled(); // çözücü başardı
  }, 30_000);

  it('çözücü kapalı siteyle (solveCaptcha:false) insana düşer', async () => {
    await page.setContent(PAGE_WITH_CAPTCHA);
    const site = config({ solveCaptcha: false });
    const { ctx, requestHumanCaptcha } = context(site, false);

    await makeGenericAdapter(site).signup(ctx);

    expect(solver.solveCaptcha).not.toHaveBeenCalled();
    expect(requestHumanCaptcha).toHaveBeenCalledTimes(1);
  }, 30_000);
});
