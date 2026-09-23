import { describe, expect, it } from 'vitest';
import { urlChangedAfterSubmit } from '../src/core/errors.js';

/**
 * "expect deseni tutmadı ama URL değişti" — zayıf ikinci sinyal.
 *
 * Genel expect desenleri tek başına yanlış pozitif verdi: Awwwards'ta
 * kayıt BAŞARISIZKEN sayfa başlığındaki "Welcome to the community!"
 * /welcome/i ile eşleşmiş, sistem başarı sanıp 10 dk boşuna mail
 * beklemişti. Bu sinyal expect'in yerini ALMAZ — yalnızca config yazan
 * kişiye (ya da otomatik akışa) bir ipucu verir.
 */

describe('urlChangedAfterSubmit', () => {
  it('aynı URL — sinyal yok', () => {
    expect(urlChangedAfterSubmit('https://x.com/signup', 'https://x.com/signup')).toBe(false);
  });

  it('signup path\'inden dashboard\'a düşmek sinyal SAYILIR', () => {
    // alternative.me gerçek deseni: submit sonrası doğrudan /dashboard'a
    // düşüyor, ara "check your email" sayfası yok.
    expect(urlChangedAfterSubmit('https://alternative.me/signup/', 'https://alternative.me/dashboard')).toBe(
      true,
    );
  });

  it('hâlâ signup/register path\'indeyse sinyal SAYILMAZ', () => {
    // Form hata verip aynı sayfada kalmış olabilir (query string
    // değişse bile) — bu bir başarı ipucu değil.
    expect(
      urlChangedAfterSubmit('https://x.com/signup', 'https://x.com/signup?error=invalid'),
    ).toBe(false);
    expect(urlChangedAfterSubmit('https://x.com/register', 'https://x.com/register/step2')).toBe(
      false,
    );
  });

  it('farklı domaine geçiş sinyal SAYILMAZ', () => {
    // Muhtemelen yönlendirme hatası ya da üçüncü parti oturum açma —
    // "kayıt bu sitede tamamlandı" anlamına gelmez.
    expect(urlChangedAfterSubmit('https://x.com/signup', 'https://accounts.google.com/oauth')).toBe(
      false,
    );
  });

  it('geçersiz URL güvenli tarafta kalır — false', () => {
    expect(urlChangedAfterSubmit('not-a-url', 'https://x.com/dashboard')).toBe(false);
  });
});
