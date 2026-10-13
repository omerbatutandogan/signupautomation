import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { chromium, type Browser, type Page } from 'playwright';
import { loadSubmissionConfig } from '../src/adapters/submission-registry.js';

/**
 * Hikâye gönderme motorunun (7 kardeş site) başarı işareti — GERÇEK config dosyalarına karşı.
 *
 * İlk gerçek gönderim (1look4, 14 Ekim) başarıyla bitti ama sonuç `unconfirmed` kaldı: site gönderince adresi /story/submit'e
 * yönlendirip "You have successfully submitted your story url for Review" diyor; config'teki desen cümlenin sırasını
 * ("story … submitted") bekliyordu, bu cümle "submitted … story" diyor. Burada o gerçek sayfanın işaretlemesi kullanılır.
 * Kardeş sitelerin aynı şablonu kullandığı VARSAYIMDIR (her biri kendi gerçek gönderimiyle doğrulanacak).
 *
 * Aynı kritik: işaret gönderimden ÖNCEKİ sayfalarda (1. adım, 2. adım, doğrulama hatası) görünürse config "sahte başarı" verir.
 */

const FAMILY = ['1look4', 'ondashboard', 'coolpot', 'justpep', 'mootin', 'sharedais', 'urlsuggest'];

// 1look4'ün gerçek sonuç sayfasından (artifacts/564deab2): yeşil uyarı + 1. adım formu.
const SUCCESS_PAGE = `
  <div class="alert-success alert alert-dismissible" role="alert">
    <button type="button" class="close" data-dismiss="alert" aria-label="Close"><span aria-hidden="true">×</span></button>
    You have successfully submitted your story url for Review
    <br><strong><a href="/story/submit">Create a new one</a></strong>
  </div>
  <h1>Submit a New Story URL</h1>
  <p>Please follow a few simple guidelines to make this site a better place:</p>`;

// Gönderimden ÖNCE: 1. adım sayfası (gerçek metin) ...
const STEP_ONE_PAGE = `
  <h1>Submit a New Story URL</h1>
  <p>Please follow a few simple guidelines to make this site a better place:</p>
  <p>Quality Content: Is your story relevant to the site?<br>Link Directly to the Source: Save people time by linking directly to the original news story.<br>
  Search First: Avoid duplicate submissions by searching to make sure someone else has not submitted the story already.<br>
  Be Descriptive: You are the story editor, so explain what it is and why it is cool.</p>
  <b>News Source</b><label>Submit link URL</label><input><button>Submit</button>
  <b>Easy submission of new links</b><p>You can easily submit stories to OnDashboard.com. Just bookmark the link below in your favorite browser.</p>`;

// ... 2. adım formu (sunucunun ilk çizimde gösterdiği "boş olamaz" hatasıyla) ...
const STEP_TWO_PAGE = `
  <p>Article Details: <b>https://geo.new</b></p>
  <label>Title</label><textarea>geo.new — Free GEO audit for AI search</textarea>
  <label>Category</label><select><option>all</option><option>SEO</option></select>
  <label>Content</label><textarea>An AI-native GEO audit for AI search.</textarea>
  <label>Verification Code</label><input><div class="has-error"><div class="help-block">Verification Code cannot be blank.</div></div>
  <button>Submit</button><p>Preview: <a href="#">geo.new</a> Category: <a href="#">cat name here</a></p>`;

// ... ve yanlış yazılmış kodun hata sayfası.
const WRONG_CODE_PAGE = `${STEP_TWO_PAGE}<div class="has-error"><div class="help-block">Verification Code is invalid.</div></div>
  <div class="alert alert-danger" role="alert">Your story could not be submitted, please check the form</div>`;

let browser: Browser;
let page: Page;

beforeAll(async () => {
  browser = await chromium.launch({ headless: true });
  page = await browser.newPage();
}, 30_000);

afterAll(async () => {
  await browser?.close();
});

/** Config'in başarı işaretlerinden hangileri sayfada GÖRÜNÜR? */
async function visibleMarkers(id: string, html: string): Promise<string[]> {
  const config = await loadSubmissionConfig(id);
  await page.setContent(`<!doctype html><html><body>${html}</body></html>`);
  const hits: string[] = [];
  for (const selector of config.success.anyOf ?? []) {
    if (await page.locator(selector).first().isVisible().catch(() => false)) hits.push(selector);
  }
  return hits;
}

describe('hikâye gönderme motoru: başarı işareti', () => {
  it.each(FAMILY)('%s: sitenin "successfully submitted … for Review" mesajı başarı olarak TANINIR', async (id) => {
    expect((await visibleMarkers(id, SUCCESS_PAGE)).length).toBeGreaterThan(0);
  });

  it.each(FAMILY)('%s: gönderimden ÖNCEKİ sayfalarda (1. adım, 2. adım, yanlış kod) işaret GÖRÜNMEZ', async (id) => {
    expect(await visibleMarkers(id, STEP_ONE_PAGE)).toEqual([]);
    expect(await visibleMarkers(id, STEP_TWO_PAGE)).toEqual([]);
    expect(await visibleMarkers(id, WRONG_CODE_PAGE)).toEqual([]);
  });

  it('"başarıyla gönderilemedi" türü olumsuz bir cümle başarı sayılmaz', async () => {
    const negative = '<div class="alert alert-danger">You have not successfully submitted your story url</div>';
    for (const id of FAMILY) expect(await visibleMarkers(id, negative)).toEqual([]);
  });
});
