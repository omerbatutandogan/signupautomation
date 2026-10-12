import { readFile } from 'node:fs/promises';
import { describe, expect, it } from 'vitest';
import { resolveField } from '../src/core/formfill.js';
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

describe('iletişim unvanı ve yasal ad', () => {
  it('geo-new profilinde uydurma unvan ve yasal ad YOK', async () => {
    const raw = await baseProfile();
    expect(raw).not.toHaveProperty('legalName');
    expect(raw.contact).not.toHaveProperty('role');
  });

  it('unvan (role) isteğe bağlıdır: yoksa profil yüklenir', async () => {
    const raw = await baseProfile();
    const { role: _removed, ...contact } = raw.contact as Record<string, unknown>;
    expect(() => parseProfile({ ...raw, contact }, 'acme')).not.toThrow();
  });

  it('formdaki "role" alanı için değer yoksa null döner (alan boş bırakılır, uydurma unvan yazılmaz)', async () => {
    const profile = await loadProfile('geo-new');
    expect(resolveField('role', profile, { email: 'x@example.com', username: 'x', password: 'p', passwordVersion: 1 })).toBeNull();
  });

  it('unvan verilirse formda kullanılır', async () => {
    const raw = await baseProfile();
    const profile = parseProfile({ ...raw, contact: { ...(raw.contact as object), role: 'Developer' } }, 'acme');
    expect(resolveField('role', profile, { email: 'x@example.com', username: 'x', password: 'p', passwordVersion: 1 })).toBe('Developer');
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
