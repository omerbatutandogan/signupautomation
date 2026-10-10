import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { chromium, type Browser, type Page } from 'playwright';
import pino from 'pino';
import { runSteps } from '../src/adapters/generic.js';
import { parseSiteConfig } from '../src/adapters/schema.js';
import { decidePostSubmit, effectiveVerification, observePostSubmit } from '../src/core/post-submit.js';
import { PermanentError } from '../src/core/errors.js';
import type { SignupContext, SiteConfig, VerificationSpec } from '../src/core/types.js';

/**
 * Kayıt sonrası sayfa durumu: gerçek ilk koşularda config tahmini sık yanlış çıktı (sideprojects: oturum açık
 * kaldı; robingood/bufferapps: 6 haneli kod; alphacoders: "confirmation email shortly"). Karar yalnızca
 * POZİTİF kanıtla verilir; kanıt yoksa 'unknown' ve koşu eskisi gibi hata verir.
 */

const facts = (over: Partial<Parameters<typeof decidePostSubmit>[0]> = {}) => ({
  text: '', visiblePasswordInputs: 0, logoutVisible: false, digitBoxes: 0, singleCodeSelector: null, submitSelector: null, ...over,
});

describe('decidePostSubmit (saf karar)', () => {
  it('6 tek hanelik kutu + kod metni → code_prompt (bufferapps)', () => {
    expect(decidePostSubmit(facts({ text: 'Verify Account Please enter the authentication code', digitBoxes: 6, submitSelector: 'button:has-text("Submit")' })))
      .toEqual({ kind: 'code_prompt', selector: 'input[maxlength="1"]', submitSelector: 'button:has-text("Submit")' });
  });
  it('tek kod alanı + kod metni → code_prompt (robingood)', () => {
    expect(decidePostSubmit(facts({ text: 'Confirm your email We just sent an email with a 6-digit confirmation code', singleCodeSelector: "[id='input-confirm-registration-code']" })))
      .toEqual({ kind: 'code_prompt', selector: "[id='input-confirm-registration-code']" });
  });
  it('kod kutuları var ama kod metni YOK → kod sayılmaz (alakasız tek karakterlik alanlar)', () => {
    expect(decidePostSubmit(facts({ text: 'Pick your initials', digitBoxes: 3 })).kind).toBe('unknown');
    expect(decidePostSubmit(facts({ text: 'Welcome', digitBoxes: 6 })).kind).toBe('unknown');
  });
  it('çıkış bağlantısı + parola alanı yok → logged_in (sideprojects)', () => {
    expect(decidePostSubmit(facts({ text: 'Launches Projects Submit project', logoutVisible: true }))).toEqual({ kind: 'logged_in' });
  });
  it('çıkış bağlantısı olsa da parola alanı görünüyorsa oturum açık SAYILMAZ', () => {
    expect(decidePostSubmit(facts({ logoutVisible: true, visiblePasswordInputs: 1 })).kind).toBe('unknown');
  });
  it('"Thanks for signing up … confirmation email" → check_email (alphacoders)', () => {
    expect(decidePostSubmit(facts({ text: 'Thanks For Signing Up! You should receive a confirmation email shortly.' }))).toEqual({ kind: 'check_email' });
    expect(decidePostSubmit(facts({ text: 'Please check your inbox to activate' })).kind).toBe('check_email');
  });
  it('mail yazısı olsa da kayıt formu (parola alanı) hâlâ görünüyorsa → unknown', () => {
    expect(decidePostSubmit(facts({ text: 'Please verify your email address', visiblePasswordInputs: 2 })).kind).toBe('unknown');
  });
  it('kanıt yok → unknown', () => {
    expect(decidePostSubmit(facts({ text: 'Create your account Email Password' })).kind).toBe('unknown');
  });
});

describe('effectiveVerification', () => {
  const link: VerificationSpec = { mode: 'link', timeoutMs: 180000 };
  const none: VerificationSpec = { mode: 'none' };

  it('gözlem yok / belirsiz → config aynen', () => {
    expect(effectiveVerification(link)).toEqual({ spec: link, needsMail: true });
    expect(effectiveVerification(none, { kind: 'unknown' })).toEqual({ spec: none, needsMail: false });
  });
  it('oturum açık → posta beklenmez (config link olsa da)', () => {
    const r = effectiveVerification(link, { kind: 'logged_in' });
    expect(r.needsMail).toBe(false);
    expect(r.note).toMatch(/oturum açık/);
  });
  it('kod isteniyor → mode:code, seçici ve gönder butonu gözlemden', () => {
    expect(effectiveVerification(link, { kind: 'code_prompt', selector: 'input[maxlength="1"]', submitSelector: 'button:has-text("Submit")' })).toEqual({
      spec: { mode: 'code', timeoutMs: 180000, codeSelector: 'input[maxlength="1"]', codeSubmitSelector: 'button:has-text("Submit")' },
      needsMail: true,
    });
  });
  it('mail gönderildi yazıyor ama config "none" → link varsayılır; link ise aynen kalır', () => {
    expect(effectiveVerification(none, { kind: 'check_email' })).toEqual({ spec: { mode: 'link', timeoutMs: 180000 }, needsMail: true });
    expect(effectiveVerification(link, { kind: 'check_email' })).toEqual({ spec: link, needsMail: true });
  });
});

describe('observePostSubmit + expect adımı (gerçek tarayıcı)', () => {
  let browser: Browser;
  let page: Page;
  beforeAll(async () => {
    browser = await chromium.launch({ headless: true });
    page = await browser.newPage();
  }, 30_000);
  afterAll(async () => {
    await browser?.close();
  });

  const LOGGED_IN = '<nav><a href="/u">Profile</a> <a href="/logout">Log out</a></nav><h1>Welcome back</h1>';
  const SPLIT = '<h1>Verify Account</h1><p>Please enter the authentication code</p>' + '<input maxlength="1" inputmode="numeric">'.repeat(6) + '<button>Submit</button>';
  const SINGLE = '<h1>Confirm your email</h1><p>We just sent an email with a 6-digit confirmation code.</p><input id="confirm-code" type="text"><button>Verify</button>';
  const FORM = '<h1>Join</h1><input type="email"><input type="password"><button>Create account</button>';

  it('gerçek sayfalarda doğru durumu tanır', async () => {
    await page.setContent(LOGGED_IN);
    expect(await observePostSubmit(page)).toEqual({ kind: 'logged_in' });
    await page.setContent(SPLIT);
    expect(await observePostSubmit(page)).toEqual({ kind: 'code_prompt', selector: 'input[maxlength="1"]', submitSelector: 'button:has-text("Submit")' });
    await page.setContent(SINGLE);
    expect(await observePostSubmit(page)).toEqual({ kind: 'code_prompt', selector: "[id='confirm-code']", submitSelector: 'button:has-text("Verify")' });
    await page.setContent(FORM);
    expect((await observePostSubmit(page)).kind).toBe('unknown');
  }, 60_000);

  function ctx(site: SiteConfig): SignupContext {
    return {
      page,
      site,
      identity: { email: 'x@example.com', username: 'x', password: 'pw', passwordVersion: 1 },
      profile: {},
      log: pino({ level: 'silent' }),
      artifacts: { dir: 'memory', shot: vi.fn(async () => 'memory/x.png'), html: vi.fn(async () => 'memory/x.html') },
      dryRun: false,
      requestHumanCaptcha: vi.fn(async () => undefined),
    } as unknown as SignupContext;
  }
  const cfg = (steps: unknown[]) => parseSiteConfig({ id: 'fx', name: 'Fx', risk: 'low', signupUrl: 'https://fx.example/s', steps, verification: { mode: 'link' } }, 't') as SiteConfig;
  const expectStep = { type: 'expect', anyOf: ['text=/check your e-?mail/i'], timeoutMs: 300 };

  it('expect kalıbı tutmasa da durum tanındıysa HATA VERMEZ ve ctx.observed dolar', async () => {
    await page.setContent(LOGGED_IN);
    const site = cfg([expectStep]);
    const c = ctx(site);
    await runSteps(c, site.steps);
    expect(c.observed).toEqual({ kind: 'logged_in' });
  }, 30_000);

  it('hiçbir kanıt yoksa eskisi gibi "Beklenen içerik görünmedi" hatası verir', async () => {
    await page.setContent(FORM);
    const site = cfg([expectStep]);
    await expect(runSteps(ctx(site), site.steps)).rejects.toBeInstanceOf(PermanentError);
  }, 30_000);

  it('expect kalıbı tutsa bile kod ekranı görülürse gözlem kaydedilir (config link dese de kod girilir)', async () => {
    await page.setContent(SPLIT.replace('Verify Account', 'Check your email'));
    const site = cfg([expectStep]);
    const c = ctx(site);
    await runSteps(c, site.steps);
    expect(c.observed?.kind).toBe('code_prompt');
  }, 30_000);
});
