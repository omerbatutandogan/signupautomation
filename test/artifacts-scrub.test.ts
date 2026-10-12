import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { chromium, type Browser, type Page } from 'playwright';
import { captureFailure, createArtifacts } from '../src/core/artifacts.js';

/**
 * Hata anı kanıtı (HTML) türetilmiş şifreyi diske düz metin yazmamalı. React gibi çerçeveler yazılan değeri
 * `value` ÖZNİTELİĞİNE yansıtır ve `page.content()` öznitelikleri serileştirir: temizlenmeden kaydedilen sayfada
 * şifre okunurdu. (Listeleme akışı bunu kendisi temizliyordu; kayıt akışı temizlemiyordu.)
 */

const SECRET = 'Gn-sizmamali-parola-7';

let browser: Browser;
let page: Page;
let root: string;

beforeAll(async () => {
  browser = await chromium.launch({ headless: true });
  page = await browser.newPage();
  root = await mkdtemp(join(tmpdir(), 'artifacts-scrub-'));
}, 30_000);

afterAll(async () => {
  await browser?.close();
  await rm(root, { recursive: true, force: true });
});

/** Çerçevelerin yaptığını taklit eder: yazılan değer hem özellikte hem özniteliktedir. */
async function fillLikeAFramework(): Promise<void> {
  await page.setContent(`<!doctype html>
    <html><body>
    <form>
      <input id="mail" type="email" value="">
      <input id="pw" type="password" value="">
      <input id="pw2" type="password" value="">
    </form></body></html>`);
  await page.evaluate((secret) => {
    for (const id of ['pw', 'pw2']) {
      const input = document.getElementById(id) as HTMLInputElement;
      input.value = secret;
      input.setAttribute('value', secret);
    }
    (document.getElementById('mail') as HTMLInputElement).setAttribute('value', 'kisi@example.com');
  }, SECRET);
}

describe('hata anı HTML kanıtı', () => {
  it('parola alanlarının değeri diske YAZILMAZ; diğer içerik korunur', async () => {
    await fillLikeAFramework();
    const artifacts = createArtifacts(page, 'run1', 'site', root);

    const path = await artifacts.html('failure');
    const saved = await readFile(path, 'utf8');

    expect(saved).not.toContain(SECRET);
    expect(saved).toContain('type="password"');
    expect(saved).toContain('kisi@example.com'); // yalnızca parola alanları temizlenir
    expect(saved.toLowerCase()).toContain('<!doctype html>');
  });

  it('canlı sayfaya dokunmaz: hata sonrası akış sürerse alan değeri yerinde kalır', async () => {
    await fillLikeAFramework();
    await createArtifacts(page, 'run2', 'site', root).html('failure');

    const live = await page.evaluate(() => (document.getElementById('pw') as HTMLInputElement).value);
    expect(live).toBe(SECRET);
  });

  it('captureFailure de aynı temizliği kullanır (ekran görüntüsü + HTML birlikte)', async () => {
    await fillLikeAFramework();
    const { html, shot } = await captureFailure(createArtifacts(page, 'run3', 'site', root), 'failure-x');

    expect(await readFile(html, 'utf8')).not.toContain(SECRET);
    expect((await readFile(shot)).length).toBeGreaterThan(0);
  });

  it('kontrol: temizlik olmasaydı şifre gerçekten dosyaya girerdi (test boşuna geçmiyor)', async () => {
    await fillLikeAFramework();
    expect(await page.content()).toContain(SECRET);
  });
});
