import { existsSync, mkdirSync, readdirSync, rmSync } from 'node:fs';
import { afterAll, describe, expect, it } from 'vitest';
import { launchContext, TEMP_PROFILE_PREFIX } from '../src/core/browser.js';

/**
 * Dry-run için geçici tarayıcı profili — GERÇEK launchContext ile.
 *
 * Kalıcı profil dizini site başına yüzlerce MB tutabiliyor; 700 taslağı dry-run
 * ile doğrulamak boş diski (11 GB) doldururdu. Kalıcı profili olan sitede ise
 * eskisi gibi o kullanılmalı: çözülmüş Cloudflare çerezleri korunur.
 */

const REAL_PROFILE_ROOT = 'data/profiles';
const createdProfiles: string[] = [];

afterAll(() => {
  for (const dir of createdProfiles) rmSync(dir, { recursive: true, force: true });
});

const tempDirs = () =>
  existsSync(REAL_PROFILE_ROOT) ? readdirSync(REAL_PROFILE_ROOT).filter((d) => d.startsWith(TEMP_PROFILE_PREFIX)) : [];

describe('launchContext — geçici profil', () => {
  it('ephemeral + kalıcı profil yok: geçici dizin kullanılır ve kapanışta silinir; kalıcı dizin oluşmaz', async () => {
    const id = `trace-eph-${process.pid}`;
    const before = tempDirs();
    const launched = await launchContext(id, { headless: true, ephemeral: true });
    try {
      expect(tempDirs().length).toBe(before.length + 1); // çalışırken geçici profil var
      expect(existsSync(`${REAL_PROFILE_ROOT}/${id}`)).toBe(false);
      await launched.page.goto('about:blank');
    } finally {
      await launched.close();
    }
    expect(tempDirs()).toEqual(before); // kapanışta iz kalmadı
    expect(existsSync(`${REAL_PROFILE_ROOT}/${id}`)).toBe(false);
  }, 60_000);

  it('ephemeral ama kalıcı profil ZATEN var: onu kullanır ve SİLMEZ (çözülmüş çerezler korunur)', async () => {
    const id = `trace-keep-${process.pid}`;
    const dir = `${REAL_PROFILE_ROOT}/${id}`;
    mkdirSync(dir, { recursive: true });
    createdProfiles.push(dir);
    const before = tempDirs();

    const launched = await launchContext(id, { headless: true, ephemeral: true });
    try {
      expect(tempDirs()).toEqual(before); // geçici dizin açılmadı
    } finally {
      await launched.close();
    }
    expect(existsSync(dir)).toBe(true);
  }, 60_000);

  it('ephemeral değilken (gerçek kayıt) kalıcı profil oluşturur ve bırakır', async () => {
    const id = `trace-perm-${process.pid}`;
    const dir = `${REAL_PROFILE_ROOT}/${id}`;
    createdProfiles.push(dir);

    const launched = await launchContext(id, { headless: true });
    await launched.close();

    expect(existsSync(dir)).toBe(true);
  }, 60_000);
});
