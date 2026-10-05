import { describe, expect, it } from 'vitest';
import { safeNext } from './safe-next';

describe('safeNext — giriş sonrası yönlendirme', () => {
  it('uygulama içi yolu korur', () => {
    expect(safeNext('/dashboard/accounts?tab=all')).toBe('/dashboard/accounts?tab=all');
  });

  it('boşsa varsayılana döner', () => {
    expect(safeNext(null)).toBe('/dashboard');
    expect(safeNext('')).toBe('/dashboard');
  });

  it('nokta segmentleri normalleşince "//host" olan yolu reddeder', () => {
    // İnceleme bulgusu: "//" kontrolü normalleştirmeden önce yapılıyordu;
    // "/.//evil.example" → "//evil.example" olup tarayıcıyı dışarı atıyordu.
    for (const bad of ['/.//evil.example', '/..//evil.example', '/%2e//evil.example', '/./\\evil.example']) {
      expect(safeNext(bad), bad).toBe('/dashboard');
    }
  });

  it('dış adresi ve şema-göreli adresi reddeder (open redirect)', () => {
    for (const bad of ['https://evil.example', '//evil.example', '/\\evil.example', 'javascript:alert(1)', 'evil.example']) {
      expect(safeNext(bad), bad).toBe('/dashboard');
    }
  });
});
