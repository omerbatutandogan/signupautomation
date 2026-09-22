import { describe, expect, it } from 'vitest';
import { typingDelayMs } from '../src/core/formfill.js';

/**
 * Yazma gecikmesi bütçesi.
 *
 * Gerçek hata: ontoplist açıklama alanı (143 karakter) sabit ~130ms
 * gecikmeyle 19 saniye sürüyordu ve 15 saniyelik adım timeout'unu aşıp
 * metni YARIDA kesiyordu. Ekran görüntüsünde yarım cümle görülene kadar
 * fark edilmedi — bu testler o sessiz kesilmeyi geri getirmeyi engelliyor.
 */

describe('typingDelayMs', () => {
  it('kısa alanlarda doğal hızı korur', () => {
    // 22 karakterlik şifre 130ms ile 2.9sn — bütçeye rahat sığıyor.
    expect(typingDelayMs(22, 130)).toBe(130);
  });

  it('uzun metinde gecikmeyi bütçeye sığacak şekilde daraltır', () => {
    const length = 143; // ontoplist açıklaması
    const delay = typingDelayMs(length, 130);
    expect(delay).toBeLessThan(130);
    expect(length * delay).toBeLessThanOrEqual(9_000);
  });

  it('çok uzun metinde bile 10ms altına inmez', () => {
    // 500 karakterlik uzun varyant: bütçe 18ms/karakter derdi, ama
    // taban 10ms. Gerçek keydown olayları JS validation için şart.
    expect(typingDelayMs(5_000, 130)).toBe(10);
  });

  it('boş metinde doğal gecikmeyi döndürür', () => {
    // Sıfıra bölme olmamalı.
    expect(typingDelayMs(0, 90)).toBe(90);
  });

  it('doğal gecikmeyi asla ARTIRMAZ', () => {
    // Bütçe cömert olsa bile insan hızının üstüne çıkmak bot sinyali olur.
    expect(typingDelayMs(5, 60)).toBe(60);
  });
});
