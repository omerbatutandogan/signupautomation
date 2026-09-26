import { readFile } from 'node:fs/promises';
import { describe, expect, it } from 'vitest';
import { listProducts, loadProfile, parseProfile } from '../src/identity/profile.js';

/**
 * Ürün profili doğrulaması.
 *
 * Profil 200 siteye yazılan her şeyin kaynağı. 10 ürünün profili dışarıdan
 * gelecek; eksik açıklama ya da hatalı e-posta kayıt sırasında değil
 * YÜKLERKEN yakalanmalı — aksi halde aynı hata her siteye yayılır.
 */

async function baseProfile(): Promise<Record<string, unknown>> {
  return JSON.parse(await readFile('src/profile/geo-new.json', 'utf8')) as Record<string, unknown>;
}

describe('loadProfile', () => {
  it('mevcut geo-new profili geçerli', async () => {
    const p = await loadProfile('geo-new');
    expect(p.companyName).toBe('geo.new');
  });

  it('olmayan üründe mevcut ürünleri listeleyen hata verir', async () => {
    await expect(loadProfile('yok-boyle-urun')).rejects.toThrow(/mevcut ürünler: .*geo-new/);
  });

  it('listProducts profilleri bulur', async () => {
    expect(await listProducts()).toContain('geo-new');
  });
});

describe('parseProfile', () => {
  it('eksik açıklama varyantını reddeder', async () => {
    const raw = await baseProfile();
    raw.descriptions = { short: 'kısa', medium: 'orta' }; // long yok
    expect(() => parseProfile(raw, 'acme')).toThrow(/descriptions\.long/);
  });

  it('boş şirket adını reddeder', async () => {
    const raw = await baseProfile();
    raw.companyName = '   ';
    expect(() => parseProfile(raw, 'acme')).toThrow(/companyName/);
  });

  it('geçersiz signupEmail’i reddeder', async () => {
    const raw = await baseProfile();
    raw.signupEmail = 'e-posta-degil';
    expect(() => parseProfile(raw, 'acme')).toThrow(/signupEmail/);
  });

  it('ürüne özel signupEmail kabul edilir', async () => {
    const raw = await baseProfile();
    raw.signupEmail = 'acme@example.com';
    expect(parseProfile(raw, 'acme').signupEmail).toBe('acme@example.com');
  });
});
