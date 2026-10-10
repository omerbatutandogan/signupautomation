import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { transformSync } from 'esbuild';
import { afterAll, describe, expect, it } from 'vitest';
import { launchContext } from '../src/core/browser.js';

/**
 * CLI `tsx` ile çalışır; esbuild `keepNames` her adlandırılmış fonksiyona `__name(...)` ekler. `page.evaluate`
 * içine giden fonksiyonlarda bu çağrı sayfada tanımsız → ReferenceError. Kayıt sonrası durum tanıma gerçek
 * koşuda bu yüzden sessizce hiç çalışmadı (ondashboard: oturum açık, "Logout" görünüyordu, yine de failed).
 * Vitest bu dönüşümü yapmadığı için normal testler bunu göremez: burada modül AYNI dönüşümle derlenip çalıştırılır.
 */

const work = mkdtempSync(join(tmpdir(), 'keepnames-'));
const profiles = mkdtempSync(join(tmpdir(), 'keepnames-prof-'));
afterAll(() => {
  rmSync(work, { recursive: true, force: true });
  rmSync(profiles, { recursive: true, force: true });
});

describe('keepNames ile derlenmiş sayfa-içi kod', () => {
  it('launchContext sayfalarında __name tanımlıdır', async () => {
    const launched = await launchContext('kn-site', { headless: true, ephemeral: true, profileRoot: profiles });
    try {
      await launched.page.goto('about:blank');
      expect(await launched.page.evaluate('typeof globalThis.__name')).toBe('function');
    } finally {
      await launched.close();
    }
  }, 60_000);

  it('post-submit.ts keepNames ile derlenince de gerçek sayfada durumu tanır (ReferenceError yok)', async () => {
    const { code } = transformSync(readFileSync('src/core/post-submit.ts', 'utf8'), { loader: 'ts', format: 'esm', target: 'node22', keepNames: true });
    expect(code).toContain('__name('); // dönüşüm gerçekten yardımcıyı ekledi: test boşuna geçmiyor
    const file = join(work, 'post-submit.mjs');
    writeFileSync(file, code);
    const { observePostSubmit } = (await import(pathToFileURL(file).href)) as typeof import('../src/core/post-submit.js');

    const launched = await launchContext('kn-site2', { headless: true, ephemeral: true, profileRoot: profiles });
    try {
      await launched.page.goto('about:blank'); // başlangıç belgesi init script'ten önce yüklenmiş olabilir; gerçek akışlar hep gezinir
      await launched.page.setContent('<nav><a href="/u">Profile</a> <a href="/logout">Logout</a></nav><h1>Welcome</h1>');
      expect(await observePostSubmit(launched.page)).toEqual({ kind: 'logged_in' });
    } finally {
      await launched.close();
    }
  }, 60_000);
});
