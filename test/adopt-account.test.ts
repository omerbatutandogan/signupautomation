import { describe, expect, it } from 'vitest';
import { Ledger } from '../src/integrations/ledger.js';

/**
 * adopt-account: hesap gerçekte açık ama kayıt akışı sonucu yanlış sınıflandırmış (oturum açık kaldı,
 * doğrulama maili beklendi → failed). İnsan kanıtıyla "tamamlandı" yapılır; günlük sınırı tüketmez.
 */

function failedAttempt(ledger: Ledger, key: string) {
  ledger.saveCredentials(key, 'owner@example.com', 'geonew_x', 1);
  const id = ledger.startAttempt(key, 'r1', false);
  ledger.finishAttempt(id, 'failed', 'Beklenen içerik görünmedi');
}

describe('Ledger.adoptAccount', () => {
  it('başarısız kaydı "tamamlandı" yapar; listeleme akışının hesap kapısı açılır', () => {
    const l = new Ledger(':memory:');
    failedAttempt(l, 'site-a');
    expect(l.terminalResult('site-a')?.status).toBe('failed');

    expect(l.adoptAccount('site-a', 'elle doğrulandı: giriş çalıştı')).toBe('adopted');
    expect(l.terminalResult('site-a')).toEqual({ status: 'completed', note: 'elle doğrulandı: giriş çalıştı' });
    l.close();
  });

  it('günlük kayıt sınırını TÜKETMEZ (bu bir kayıt denemesi değil)', () => {
    const l = new Ledger(':memory:');
    failedAttempt(l, 'site-a');
    const before = l.countToday();
    l.adoptAccount('site-a', 'elle doğrulandı: giriş çalıştı');
    expect(l.countToday()).toBe(before);
    l.close();
  });

  it('kimlik kaydı yoksa reddeder (sistemde açılmamış hesabı sahiplenemez)', () => {
    const l = new Ledger(':memory:');
    expect(l.adoptAccount('yok', 'elle doğrulandı: x')).toBe('no_credentials');
    expect(l.terminalResult('yok')).toBeNull();
    l.close();
  });

  it('zaten tamamlanmışsa dokunmaz', () => {
    const l = new Ledger(':memory:');
    l.saveCredentials('site-b', 'owner@example.com', 'u', 1);
    const id = l.startAttempt('site-b', 'r1', false);
    l.finishAttempt(id, 'completed', 'gerçek kayıt');
    expect(l.adoptAccount('site-b', 'elle doğrulandı: x')).toBe('already_completed');
    expect(l.terminalResult('site-b')?.note).toBe('gerçek kayıt');
    expect(l.recentAttempts(10)).toHaveLength(1);
    l.close();
  });

  it('dry-run ile "tamamlanmış" görünen hesabı da sahiplenebilir (dry-run hesap açmaz)', () => {
    const l = new Ledger(':memory:');
    l.saveCredentials('site-c', 'owner@example.com', 'u', 1);
    const id = l.startAttempt('site-c', 'r1', true);
    l.finishAttempt(id, 'completed', 'dry-run');
    expect(l.adoptAccount('site-c', 'elle doğrulandı: x')).toBe('adopted');
    l.close();
  });
});
