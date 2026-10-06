import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { launchContext, TEMP_PROFILE_PREFIX } from '../src/core/browser.js';

/**
 * Dry-run için geçici tarayıcı profili — GERÇEK launchContext ile.
 *
 * Kalıcı profil dizini site başına yüzlerce MB tutabiliyor; 700 taslağı dry-run
 * ile doğrulamak boş diski doldururdu. Kalıcı profili olan sitede ise eskisi gibi
 * o kullanılmalı: çözülmüş Cloudflare çerezleri korunur.
 *
 * Profil kökü bu teste özel geçici dizindir: gerçek data/profiles'a ve ondaki
 * (toplu doğrulamanın açıp sildiği) .dry-* dizinlerine bağlı değil.
 */

const root = mkdtempSync(join(tmpdir(), 'profiles-'));
afterAll(() => rmSync(root, { recursive: true, force: true }));

const tempDirs = () => readdirSync(root).filter((d) => d.startsWith(TEMP_PROFILE_PREFIX));

describe('launchContext — geçici profil', () => {
  it('ephemeral + kalıcı profil yok: geçici dizin kullanılır ve kapanışta silinir; kalıcı dizin oluşmaz', async () => {
    const launched = await launchContext('eph-site', { headless: true, ephemeral: true, profileRoot: root });
    try {
      expect(launched.profileDir.startsWith(`${root}/${TEMP_PROFILE_PREFIX}`)).toBe(true);
      expect(existsSync(launched.profileDir)).toBe(true);
      expect(existsSync(`${root}/eph-site`)).toBe(false);
      await launched.page.goto('about:blank');
    } finally {
      await launched.close();
    }
    expect(existsSync(launched.profileDir)).toBe(false);
    expect(tempDirs()).toEqual([]);
    expect(existsSync(`${root}/eph-site`)).toBe(false);
  }, 60_000);

  it('ephemeral ama kalıcı profil ZATEN var: onu kullanır ve SİLMEZ (çözülmüş çerezler korunur)', async () => {
    const dir = `${root}/keep-site`;
    mkdirSync(dir, { recursive: true });

    const launched = await launchContext('keep-site', { headless: true, ephemeral: true, profileRoot: root });
    try {
      expect(launched.profileDir).toBe(dir);
      expect(tempDirs()).toEqual([]);
    } finally {
      await launched.close();
    }
    expect(existsSync(dir)).toBe(true);
  }, 60_000);

  it('ephemeral değilken (gerçek kayıt) kalıcı profil oluşturur ve bırakır', async () => {
    const launched = await launchContext('perm-site', { headless: true, profileRoot: root });
    await launched.close();

    expect(launched.profileDir).toBe(`${root}/perm-site`);
    expect(existsSync(`${root}/perm-site`)).toBe(true);
  }, 60_000);
});
