import { describe, expect, it } from 'vitest';
import { canAutoVerify, type DryRunIssue } from '../src/core/dry-run-check.js';

/**
 * Otomatik doğrulama kapısı.
 *
 * Dry-run eskiden KOŞULSUZ 'completed' dönüyordu ve markVerified()
 * damgayı kaldırıyordu — içi boş bir config bile "doğrulandı"
 * sayılabiliyordu. Tek koruma insan gözüydü; 3430 sitelik listede bu
 * 50+ saat insan işi demek.
 *
 * Bu kapı yanlış tarafa gevşerse bozuk configler run-batch'e girer ve
 * gerçek sitelere boş form gönderilir.
 */

const kritikBos: DryRunIssue = {
  kind: 'empty_field',
  selector: '#password',
  detail: 'Kritik alan BOŞ — kayıt kesin başarısız olur',
};

const sıradanBos: DryRunIssue = {
  kind: 'empty_field',
  selector: '#company',
  detail: 'Alan boş kaldı',
};

const görünmezZorunlu: DryRunIssue = {
  kind: 'hidden_required',
  selector: 'terms',
  detail: 'Görünmez zorunlu alan doldurulmamış — label[for=...] tıklaması gerekebilir',
};

describe('canAutoVerify', () => {
  it('sorun yoksa otomatik doğrular', () => {
    expect(canAutoVerify([])).toBe(true);
  });

  it('KRİTİK boş alan varsa doğrulamayı REDDEDER', () => {
    // BetaList gerçek vakası: şifre alanları selector'ı bulunmasına
    // rağmen boş kalıyordu ve bu yalnızca ekran görüntüsünden
    // anlaşılmıştı. Artık program yakalıyor.
    expect(canAutoVerify([kritikBos])).toBe(false);
  });

  it('kritik olmayan boş alan doğrulamayı engellemez', () => {
    // Şirket adı gibi opsiyonel alanların boş kalması kayıt başarısını
    // engellemiyor — uyarı olarak nota yazılır, damga kalkabilir.
    expect(canAutoVerify([sıradanBos])).toBe(true);
  });

  it('görünmez zorunlu alan tek başına engellemez ama raporlanır', () => {
    // Awwwards şartlar kutucuğu: gerçek bir sorun ama her zaman
    // kayıt kırıcı değil (bazı siteler submit'te varsayılan işaretliyor).
    // Uyarı olarak geçer, config notuna yazılır.
    expect(canAutoVerify([görünmezZorunlu])).toBe(true);
  });

  it('karışık listede KRİTİK olan belirleyici', () => {
    expect(canAutoVerify([sıradanBos, görünmezZorunlu, kritikBos])).toBe(false);
  });

  it('submit adımı eksikliği tek başına engellemez', () => {
    // Config'de click yoksa gönderilemez ama bu dry-run'ın değil
    // config'in sorunu — nota yazılır.
    const noSubmit: DryRunIssue = {
      kind: 'no_submit',
      selector: '(yok)',
      detail: 'Config’de click adımı yok — form gönderilemez',
    };
    expect(canAutoVerify([noSubmit])).toBe(true);
  });
});
