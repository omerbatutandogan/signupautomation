import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { chromium, type Browser } from 'playwright';
import { findSignupPage } from '../src/discovery/find-signup.js';
import { html, LONG_TEXT, ok, serve, SIGNUP_FORM } from './fake-sites.js';

/**
 * "Form bulunamadı" kovasını ayrıştırma (2026-09-30).
 *
 * 18 sitelik elle incelemede kovanın en büyük iki parçası şifreli kayıt
 * formu OLMAYAN ama boş da olmayan sitelerdi:
 *  - hesapsız gönderim formu (onepagelove /submit, blogs-collection
 *    /submit/, 1000.tools/signup: website + e-posta, şifre yok),
 *  - e-postayla başlayan giriş (techinasia /auth: tek e-posta alanı +
 *    "Log in / Sign up"; 1000.tools/login; selfgrowth "sign-in code").
 * Hepsi "form yok" diye kaydediliyordu; tarama haritası hangi özelliğin
 * kaç siteyi açacağını gösteremiyordu.
 */

let browser: Browser;

beforeAll(async () => {
  browser = await chromium.launch({ headless: true });
}, 30_000);

afterAll(async () => {
  await browser?.close();
});

const SUBMIT_FORM = html(`
  <h1>Submit your website</h1>
  <form>
    <input type="url" name="site_url" placeholder="https://">
    <input type="email" name="email">
    <textarea name="description"></textarea>
    <button type="submit">Submit</button>
  </form>`);

// techinasia /auth deseni: tek e-posta alanı, şifre yok, SSO seçeneği.
const EMAIL_FIRST = html(`
  <h1>Log in / Sign up</h1>
  <button>Continue with Google</button>
  <form><input type="email" name="email" placeholder="Email Address">
  <button type="submit">Log in / Sign up</button></form>`);

describe('findSignupPage — form yoksa ipucu', () => {
  it('hesapsız gönderim formunu "submit_form" olarak bildirir', async () => {
    const page = await serve(browser, {
      'submit-dir.test/': ok(html(`<p>${LONG_TEXT}</p><a href="/add-site">Submit Your Website</a>`)),
      'submit-dir.test/add-site': ok(SUBMIT_FORM),
    });
    const result = await findSignupPage(page, 'http://submit-dir.test');
    await page.context().close();

    expect(result.kind).toBe('not_found');
    if (result.kind === 'not_found') expect(result.hints).toContain('submit_form');
  }, 90_000);

  it('auth yolundaki tek e-posta alanlı formu "email_first" olarak bildirir', async () => {
    const page = await serve(browser, {
      'auth-dir.test/': ok(html(`<p>${LONG_TEXT}</p><a href="/auth">Sign up</a>`)),
      'auth-dir.test/auth': ok(EMAIL_FIRST),
    });
    const result = await findSignupPage(page, 'http://auth-dir.test');
    await page.context().close();

    expect(result.kind).toBe('not_found');
    if (result.kind === 'not_found') expect(result.hints).toContain('email_first');
  }, 90_000);

  it('başlıkta "Subscribe" butonu olan sayfada giriş modalı yine "email_first" (techinasia)', async () => {
    // Bülten kontrolü sayfa geneline bakarsa başlıktaki SUBSCRIBE butonu
    // gerçek e-postayla girişi siler.
    const page = await serve(browser, {
      'tia-dir.test/': ok(html(`<p>${LONG_TEXT}</p><a href="/auth">Sign up</a>`)),
      'tia-dir.test/auth': ok(
        html(`<header><button>FREE NEWSLETTER</button><button>SUBSCRIBE</button></header>
        <main><p>${LONG_TEXT.repeat(3)}</p></main>
        <div class="modal"><h2>Log in / Sign up</h2><button>Continue with Google</button>
          <form><input type="email" name="email" placeholder="Email Address">
          <button type="submit">Log in / Sign up</button></form></div>`),
      ),
    });
    const result = await findSignupPage(page, 'http://tia-dir.test');
    await page.context().close();

    expect(result.kind).toBe('not_found');
    if (result.kind === 'not_found') expect(result.hints).toContain('email_first');
  }, 90_000);

  it('altbilgide bülten formu olan giriş sayfası yine "email_first"', async () => {
    const page = await serve(browser, {
      'foot-dir.test/': ok(html(`<p>${LONG_TEXT}</p><a href="/login-link">Sign up</a>`)),
      'foot-dir.test/login-link': ok(
        html(`<main><h1>Welcome back</h1>
          <form><input type="email" name="email"><button type="submit">Log in</button></form></main>
        <footer><p>${LONG_TEXT.repeat(3)}</p>
          <div><p>Weekly newsletter</p><form><input type="email" name="nl_email"><button>Subscribe</button></form></div>
        </footer>`),
      ),
    });
    const result = await findSignupPage(page, 'http://foot-dir.test');
    await page.context().close();

    expect(result.kind).toBe('not_found');
    if (result.kind === 'not_found') expect(result.hints).toContain('email_first');
  }, 90_000);

  it('website + e-posta alanlı /signup gönderim formudur, e-postayla giriş DEĞİL (1000.tools)', async () => {
    const page = await serve(browser, {
      'tools-dir.test/': ok(html(`<p>${LONG_TEXT}</p>`)),
      'tools-dir.test/signup': ok(
        html(`<form><input name="website" placeholder="Your website"><input type="email" name="email">
        <button type="submit">Submit</button></form>`),
      ),
    });
    const result = await findSignupPage(page, 'http://tools-dir.test');
    await page.context().close();

    expect(result.kind).toBe('not_found');
    if (result.kind === 'not_found') {
      expect(result.hints).toContain('submit_form');
      expect(result.hints ?? []).not.toContain('email_first');
    }
  }, 90_000);

  it('WordPress yorum formu (Website alanlı) gönderim formu DEĞİL', async () => {
    // Dizinlerin çoğu WordPress; "Submit" linkinin gittiği blog yazısının
    // altındaki yorum kutusunda name="url" alanı var.
    const page = await serve(browser, {
      'wp-dir.test/': ok(html(`<p>${LONG_TEXT}</p><a href="/how-to-submit">Submit</a>`)),
      'wp-dir.test/how-to-submit': ok(
        html(`<article>${LONG_TEXT}</article>
        <div id="respond"><form id="commentform" class="comment-form">
          <textarea name="comment"></textarea>
          <input name="author"><input name="email" type="email"><input name="url" type="url">
          <input type="submit" value="Post Comment">
        </form></div>`),
      ),
    });
    const result = await findSignupPage(page, 'http://wp-dir.test');
    await page.context().close();

    expect(result.kind).toBe('not_found');
    if (result.kind === 'not_found') expect(result.hints ?? []).toEqual([]);
  }, 90_000);

  it('placeholder\'ı "you@domain.com" olan bülten kutusu gönderim formu DEĞİL', async () => {
    const page = await serve(browser, {
      'nl-dir.test/': ok(
        html(`<p>${LONG_TEXT}</p><form><input type="email" name="EMAIL" placeholder="you@domain.com">
        <button type="submit">Subscribe</button></form>`),
      ),
    });
    const result = await findSignupPage(page, 'http://nl-dir.test');
    await page.context().close();

    expect(result.kind).toBe('not_found');
    if (result.kind === 'not_found') expect(result.hints ?? []).toEqual([]);
  }, 90_000);

  it('/join yolundaki bülten sayfası e-postayla giriş DEĞİL', async () => {
    // /join doğrudan denenen yollardan biri; auth yolu sayılıyor.
    const page = await serve(browser, {
      'join-dir.test/': ok(html(`<p>${LONG_TEXT}</p>`)),
      'join-dir.test/join': ok(
        html(`<h1>Join our newsletter</h1><form><input type="email" name="email">
        <button type="submit">Subscribe</button></form>`),
      ),
    });
    const result = await findSignupPage(page, 'http://join-dir.test');
    await page.context().close();

    expect(result.kind).toBe('not_found');
    if (result.kind === 'not_found') expect(result.hints ?? []).toEqual([]);
  }, 90_000);

  it('bülten metni paragrafta, buton "Join" olsa da e-postayla giriş DEĞİL', async () => {
    const page = await serve(browser, {
      'join2-dir.test/': ok(html(`<p>${LONG_TEXT}</p>`)),
      'join2-dir.test/join': ok(
        html(`<section><p>Get our weekly newsletter with the best new tools.</p>
        <form><input type="email" name="email"><button type="submit">Join</button></form></section>`),
      ),
    });
    const result = await findSignupPage(page, 'http://join2-dir.test');
    await page.context().close();

    expect(result.kind).toBe('not_found');
    if (result.kind === 'not_found') expect(result.hints ?? []).toEqual([]);
  }, 90_000);

  it('camelCase adlı website alanını tanır (companyWebsite)', async () => {
    const page = await serve(browser, {
      'camel-dir.test/': ok(html(`<p>${LONG_TEXT}</p><a href="/add-listing">Submit</a>`)),
      'camel-dir.test/add-listing': ok(
        html(`<form><input name="companyName"><input name="companyWebsite"><textarea name="about"></textarea>
        <button type="submit">Send</button></form>`),
      ),
    });
    const result = await findSignupPage(page, 'http://camel-dir.test');
    await page.context().close();

    expect(result.kind).toBe('not_found');
    if (result.kind === 'not_found') expect(result.hints).toContain('submit_form');
  }, 90_000);

  it('auth yolunda olmayan bülten formu ipucu DEĞİL', async () => {
    const page = await serve(browser, {
      'news-dir.test/': ok(
        html(`<p>${LONG_TEXT}</p><form><input type="email" name="email"><button>Subscribe</button></form>
        <a href="/newsletter">Join our newsletter</a>`),
      ),
      'news-dir.test/newsletter': ok(
        html(`<form><input type="email" name="email"><button type="submit">Subscribe</button></form>`),
      ),
    });
    const result = await findSignupPage(page, 'http://news-dir.test');
    await page.context().close();

    expect(result.kind).toBe('not_found');
    if (result.kind === 'not_found') expect(result.hints ?? []).toEqual([]);
  }, 90_000);

  it('gerçek kayıt formu varsa ipucu değil kayıt sayfası döner', async () => {
    const page = await serve(browser, {
      'both-dir.test/': ok(
        html(`<p>${LONG_TEXT}</p><a href="/add-site">Submit Your Website</a><a href="/create-account">Create account</a>`),
      ),
      'both-dir.test/add-site': ok(SUBMIT_FORM),
      'both-dir.test/create-account': ok(SIGNUP_FORM),
    });
    const result = await findSignupPage(page, 'http://both-dir.test');
    await page.context().close();

    expect(result.kind).toBe('found');
  }, 90_000);
});
