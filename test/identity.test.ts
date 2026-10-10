import { describe, expect, it } from 'vitest';
import { derivePassword, derivePasswordForSite } from '../src/identity/password.js';
import { signupEmail, slugifySiteId, usernameForSite } from '../src/identity/email.js';

const SECRET = 'a'.repeat(64);

describe('derivePassword', () => {
  it('aynı girdi için deterministik', () => {
    expect(derivePassword(SECRET, 'alternativeto')).toBe(
      derivePassword(SECRET, 'alternativeto'),
    );
  });

  it('farklı siteler için farklı şifre üretir', () => {
    expect(derivePassword(SECRET, 'g2')).not.toBe(derivePassword(SECRET, 'stackshare'));
  });

  it('version bump şifreyi değiştirir (zorunlu sıfırlama senaryosu)', () => {
    const v1 = derivePassword(SECRET, 'site', 1);
    const v2 = derivePassword(SECRET, 'site', 2);
    expect(v1).not.toBe(v2);
  });

  it('MASTER_SECRET boşsa anlamlı hata verir', () => {
    expect(() => derivePassword('', 'site')).toThrow(/MASTER_SECRET/);
  });

  it('varsayılan çıktı her politikayı geçecek karakter çeşitliliğine sahip', () => {
    const pw = derivePassword(SECRET, 'site');
    expect(pw).toMatch(/[a-z]/);
    expect(pw).toMatch(/[A-Z]/);
    expect(pw).toMatch(/[0-9]/);
    expect(pw).toMatch(/[^A-Za-z0-9]/);
    expect(pw.length).toBe(22);
  });

  it('noSymbols politikasında sembol içermez ama çeşitliliği korur', () => {
    const pw = derivePassword(SECRET, 'site', 1, { noSymbols: true });
    expect(pw).not.toMatch(/[^A-Za-z0-9]/);
    expect(pw).toMatch(/[a-z]/);
    expect(pw).toMatch(/[A-Z]/);
    expect(pw).toMatch(/[0-9]/);
  });

  it('maxLen uygularken prefix ve suffix çeşitliliğini korur', () => {
    const pw = derivePassword(SECRET, 'site', 1, { maxLen: 12 });
    expect(pw.length).toBe(12);
    expect(pw).toMatch(/[A-Z]/);
    expect(pw).toMatch(/[0-9]/);
    expect(pw).toMatch(/[^A-Za-z0-9]/);
  });

  it('allowedSymbols verilirse yalnızca izinli sembolü kullanır', () => {
    const pw = derivePassword(SECRET, 'site', 1, { allowedSymbols: '#' });
    expect(pw).toContain('#');
    expect(pw).not.toContain('!');
  });

  it('aşırı kısıtlayıcı maxLen için açık hata verir', () => {
    expect(() => derivePassword(SECRET, 'site', 1, { maxLen: 6 })).toThrow(/çok kısıtlayıcı/);
  });

  it('derivePasswordForSite politikayı config’ten okur', () => {
    const direct = derivePassword(SECRET, 's1', 1, { noSymbols: true });
    const viaSite = derivePasswordForSite(SECRET, { id: 's1', passwordPolicy: { noSymbols: true } });
    expect(viaSite).toBe(direct);
  });
});

describe('slugifySiteId', () => {
  it('Türkçe karakterleri ASCII’ye indirger', () => {
    expect(slugifySiteId('Ürün Dizini')).toBe('urun-dizini');
  });

  it('noktalama ve boşlukları tireye çevirir, uçlardaki tireleri atar', () => {
    expect(slugifySiteId('  Product Hunt!  ')).toBe('product-hunt');
  });

  it('tamamen geçersiz girdide hata verir', () => {
    expect(() => slugifySiteId('!!!')).toThrow();
  });
});

describe('signupEmail', () => {
  it('tek sabit adresi olduğu gibi döndürür — tüm sitelerde aynı adres kullanılır', () => {
    expect(signupEmail('mysignups@gmail.com')).toBe('mysignups@gmail.com');
  });

  it('adres @ içermiyorsa hata verir', () => {
    expect(() => signupEmail('not-an-email')).toThrow(/geçerli bir adres/);
  });

  it('boşsa anlamlı hata verir', () => {
    expect(() => signupEmail('')).toThrow(/SIGNUP_EMAIL/);
  });
});

describe('usernameForSite', () => {
  it('site başına benzersiz, alfanumerik kullanıcı adı üretir', () => {
    const a = usernameForSite('geonew', 'alternativeto');
    const b = usernameForSite('geonew', 'stackshare');
    expect(a).not.toBe(b);
    expect(a).toMatch(/^[a-z0-9_]+$/);
  });

  it('30 karakteri aşmaz', () => {
    expect(usernameForSite('averylongcompanynamehere', 'someverylongsiteid').length)
      .toBeLessThanOrEqual(30);
  });

  it("'plain' stil yalnızca harf ve rakam üretir (alt çizgi yok), varsayılan değişmez", () => {
    expect(usernameForSite('geonew', 'getworm')).toBe('geonew_getworm');
    expect(usernameForSite('geonew', 'getworm', 'default')).toBe('geonew_getworm');
    expect(usernameForSite('geonew', 'getworm', 'plain')).toBe('geonewgetworm');
    expect(usernameForSite('averylongcompanynamehere', 'someverylongsiteid', 'plain')).toMatch(/^[a-z0-9]{1,30}$/);
  });
});
