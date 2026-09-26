import { describe, expect, it } from 'vitest';
import { accountKey, assertProductId, DEFAULT_PRODUCT } from '../src/identity/account.js';
import { derivePassword } from '../src/identity/password.js';

/**
 * Hesap = ürün + site.
 *
 * En kritik sözleşme: varsayılan ürünün anahtarı yalın siteId KALMALI.
 * Şifre anahtardan türetiliyor; anahtar değişirse açık 4 hesabın
 * (10words, alternative, awwwards, ontoplist) şifresi değişir ve o
 * hesaplara bir daha girilemez.
 */

const SECRET = 'test-secret-0123456789abcdef';

describe('accountKey', () => {
  it('varsayılan üründe yalın siteId döner (mevcut hesaplar)', () => {
    expect(accountKey(DEFAULT_PRODUCT, 'awwwards')).toBe('awwwards');
  });

  it('diğer ürünlerde urun@site döner', () => {
    expect(accountKey('acme', 'awwwards')).toBe('acme@awwwards');
  });

  it('geçersiz ürün id’sini reddeder', () => {
    // Ürün id'si dosya adı olarak da kullanılıyor — yol karakterleri
    // ya da @ (anahtar ayracı) içeremez.
    expect(() => accountKey('../etc', 'awwwards')).toThrow();
    expect(() => accountKey('a@b', 'awwwards')).toThrow();
    expect(() => assertProductId('Acme')).toThrow();
    expect(() => assertProductId('')).toThrow();
  });
});

describe('şifre türetme — geriye uyumluluk', () => {
  it('varsayılan ürünün şifresi eskisiyle BİREBİR aynı', () => {
    // Eski türetme doğrudan siteId kullanıyordu.
    const before = derivePassword(SECRET, 'awwwards');
    const after = derivePassword(SECRET, accountKey(DEFAULT_PRODUCT, 'awwwards'));
    expect(after).toBe(before);
  });

  it('aynı sitede farklı ürünler farklı şifre alır', () => {
    const a = derivePassword(SECRET, accountKey('acme', 'awwwards'));
    const b = derivePassword(SECRET, accountKey('globex', 'awwwards'));
    const def = derivePassword(SECRET, accountKey(DEFAULT_PRODUCT, 'awwwards'));
    expect(new Set([a, b, def]).size).toBe(3);
  });
});
