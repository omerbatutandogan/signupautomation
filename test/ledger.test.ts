import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Ledger } from '../src/integrations/ledger.js';

let dir: string;
let ledger: Ledger;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'ledger-test-'));
  ledger = new Ledger(join(dir, 'test.sqlite'));
});

afterEach(() => {
  ledger.close();
  rmSync(dir, { recursive: true, force: true });
});

describe('kilit (idempotency)', () => {
  it('aynı siteyi iki kez kilitlemeye izin vermez', () => {
    expect(ledger.tryClaim('site-a', 'run-1')).toBe(true);
    // İkinci çalıştırma aynı siteyi alamaz — çift kayıt denemesini engeller.
    expect(ledger.tryClaim('site-a', 'run-2')).toBe(false);
  });

  it('farklı siteler birbirini engellemez', () => {
    expect(ledger.tryClaim('site-a', 'run-1')).toBe(true);
    expect(ledger.tryClaim('site-b', 'run-1')).toBe(true);
  });

  it('bırakılan kilit tekrar alınabilir', () => {
    ledger.tryClaim('site-a', 'run-1');
    ledger.release('site-a');
    expect(ledger.tryClaim('site-a', 'run-2')).toBe(true);
  });

  it('TTL dolmuş kilitler yeni örnekte temizlenir', () => {
    ledger.tryClaim('site-a', 'run-1', -1000); // zaten süresi dolmuş
    ledger.close();

    // Yeni örnek başlangıçta bayat kilitleri reap eder — çökmüş çalıştırma
    // siteyi kalıcı olarak bloke etmesin.
    ledger = new Ledger(join(dir, 'test.sqlite'));
    expect(ledger.tryClaim('site-a', 'run-2')).toBe(true);
  });

  it('aktif kilidin sahibini raporlar', () => {
    ledger.tryClaim('site-a', 'run-xyz');
    expect(ledger.activeLock('site-a')?.run_id).toBe('run-xyz');
    expect(ledger.activeLock('site-b')).toBeNull();
  });

  it('öksüz kalan running denemeleri temizler', () => {
    // Süreç çökmesi/kill senaryosu: attempt başlar, finally hiç çalışmaz.
    ledger.tryClaim('site-a', 'run-1', -1000); // TTL zaten dolmuş
    ledger.startAttempt('site-a', 'run-1');
    ledger.close();

    ledger = new Ledger(join(dir, 'test.sqlite'));

    const recent = ledger.recentAttempts(5);
    expect(recent[0]?.status).toBe('error');
    expect(recent[0]?.note).toMatch(/yarıda kesildi/);
    // Terminal DEĞİL — site tekrar denenebilmeli.
    expect(ledger.terminalResult('site-a')).toBeNull();
  });
});

describe('denemeler', () => {
  it('terminal sonuçları kaydeder, geçici olanları kaydetmez', () => {
    const a1 = ledger.startAttempt('site-a', 'run-1');
    ledger.finishAttempt(a1, 'error', 'geçici ağ hatası');
    expect(ledger.terminalResult('site-a')).toBeNull();

    const a2 = ledger.startAttempt('site-a', 'run-2');
    ledger.finishAttempt(a2, 'completed');
    expect(ledger.terminalResult('site-a')?.status).toBe('completed');
  });

  it('manual ve failed da terminal sayılır', () => {
    const a1 = ledger.startAttempt('site-a', 'run-1');
    ledger.finishAttempt(a1, 'manual', 'captcha yanıtsız');
    expect(ledger.terminalResult('site-a')?.status).toBe('manual');

    const a2 = ledger.startAttempt('site-b', 'run-1');
    ledger.finishAttempt(a2, 'failed');
    expect(ledger.terminalResult('site-b')?.status).toBe('failed');
  });

  it('günlük sayım skipped durumlarını hariç tutar', () => {
    const a1 = ledger.startAttempt('site-a', 'run-1');
    ledger.finishAttempt(a1, 'completed');
    const a2 = ledger.startAttempt('site-b', 'run-1');
    ledger.finishAttempt(a2, 'skipped_locked');

    // skipped gerçek bir deneme değil — günlük limiti tüketmemeli.
    expect(ledger.countToday()).toBe(1);
  });
});

describe('kimlik bilgileri', () => {
  it('kaydeder ve günceller', () => {
    ledger.saveCredentials('site-a', 'a@b.com', 'user1', 1);
    expect(ledger.credentials('site-a')?.username).toBe('user1');

    ledger.saveCredentials('site-a', 'a@b.com', 'user2', 2);
    const row = ledger.credentials('site-a');
    expect(row?.username).toBe('user2');
    expect(row?.pw_version).toBe(2);
  });

  it('şifreyi ASLA saklamaz', () => {
    ledger.saveCredentials('site-a', 'a@b.com', 'user1', 1);
    const row = ledger.credentials('site-a') as unknown as Record<string, unknown>;
    expect(Object.keys(row)).not.toContain('password');
  });

  it('profil URL’ini sonradan ekler', () => {
    ledger.saveCredentials('site-a', 'a@b.com', 'user1', 1);
    ledger.setProfileUrl('site-a', 'https://site-a.com/dashboard');
    expect(ledger.credentials('site-a')?.profile_url).toBe('https://site-a.com/dashboard');
  });
});

describe('görülen mailler', () => {
  it('aynı maili iki kez tüketmez', () => {
    expect(ledger.hasSeenMessage('msg-1')).toBe(false);
    ledger.markMessageSeen('msg-1', 'site-a');
    expect(ledger.hasSeenMessage('msg-1')).toBe(true);
  });

  it('aynı id tekrar işaretlenince patlamaz', () => {
    ledger.markMessageSeen('msg-1', 'site-a');
    expect(() => ledger.markMessageSeen('msg-1', 'site-a')).not.toThrow();
  });
});
