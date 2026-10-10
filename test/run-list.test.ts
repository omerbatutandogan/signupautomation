import { describe, expect, it } from 'vitest';
import { classifyStatus, gapSeconds, parseRunOneStatus, shouldStop, type ListOutcome } from '../src/core/run-list.js';

describe('classifyStatus', () => {
  it('completed / skipped_* / geri kalan her şey failed', () => {
    expect(classifyStatus('completed')).toBe('completed');
    for (const s of ['skipped_terminal', 'skipped_locked', 'skipped_limit', 'skipped_high_risk']) expect(classifyStatus(s), s).toBe('skipped');
    for (const s of ['failed', 'manual', 'error', 'email_timeout', 'bilinmeyen']) expect(classifyStatus(s), s).toBe('failed');
  });
});

describe('shouldStop', () => {
  const f = (n: number): ListOutcome[] => Array.from({ length: n }, () => 'failed');
  it('6 ardışık başarısızlıkta durur', () => {
    expect(shouldStop(f(6))).toBe(true);
    expect(shouldStop(['completed', ...f(6)])).toBe(true);
  });
  it('arada başarı varsa ya da 6\'dan azsa durmaz', () => {
    expect(shouldStop(f(5))).toBe(false);
    expect(shouldStop([...f(3), 'completed', ...f(5)])).toBe(false);
    expect(shouldStop([])).toBe(false);
  });
  it('atlananlar seriyi ne bozar ne sayılır', () => {
    expect(shouldStop(['failed', 'skipped', 'failed', 'skipped', 'failed'], 3)).toBe(true);
    expect(shouldStop(['skipped', 'skipped', 'skipped'])).toBe(false);
    expect(shouldStop([...f(5), 'skipped'])).toBe(false);
  });
  it('eşik ayarlanabilir', () => {
    expect(shouldStop(['failed', 'failed'], 2)).toBe(true);
  });
});

describe('gapSeconds', () => {
  it('[min,max] dakika aralığına düşer', () => {
    expect(gapSeconds(6, 18, () => 0)).toBe(360);
    expect(gapSeconds(6, 18, () => 1)).toBe(1080);
    expect(gapSeconds(6, 18, () => 0.5)).toBe(720);
  });
  it('ters verilen sınırlarda da çalışır', () => {
    expect(gapSeconds(18, 6, () => 0)).toBe(360);
  });
});

describe('parseRunOneStatus', () => {
  it('ANSI renkli ve renksiz çıktıdan durumu okur', () => {
    expect(parseRunOneStatus('log...\n\n❌ geo-new@x: failed\n   not\n')).toBe('failed');
    expect(parseRunOneStatus('\u001b[32m✅ bufferapps: completed\u001b[39m')).toBe('completed');
    expect(parseRunOneStatus('⏭️ bufferapps: skipped_terminal\n   önceki sonuç: failed')).toBe('skipped_terminal');
  });
  it('durum satırı yoksa null', () => {
    expect(parseRunOneStatus('hata: bir şey patladı')).toBeNull();
  });
});
