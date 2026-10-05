import { existsSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  MAX_BACKOFF_MS,
  TICK_MS,
  backoffMs,
  clearFailure,
  loadFailure,
  minutesLeft,
  recordFailure,
  shouldBackOff,
} from '../src/sync/backoff.js';

/**
 * Zamanlanmış senkronun geri çekilmesi.
 *
 * Amaç: kalıcı bir hata her 2 dakikada tüm tabloları yeniden çektirip ücretsiz
 * Supabase'in çıkış kotasını bitirmesin — ama hata da gizlenmesin, düzelince de
 * hemen toparlansın. Yanlış bir geri çekilme ya senkronu gereksiz yere susturur
 * ya da hiçbir şey sınırlamaz; ikisi de sessizdir, o yüzden testli.
 */

const MIN = 60_000;
const t0 = new Date('2026-10-05T10:00:00Z');
const at = (msAfter: number) => new Date(t0.getTime() + msAfter);

describe('backoffMs', () => {
  it('ilk başarısızlıkta beklemez (bir sonraki tur zaten 2 dk sonra)', () => {
    expect(backoffMs(0)).toBe(0);
    expect(backoffMs(1)).toBe(0);
  });
  it('sonrasında ikiye katlanır ve 60 dakikada durur', () => {
    expect([2, 3, 4, 5, 6, 7, 20].map((n) => backoffMs(n) / MIN)).toEqual([4, 8, 16, 32, 60, 60, 60]);
    expect(backoffMs(1000)).toBe(MAX_BACKOFF_MS);
  });
});

describe('shouldBackOff', () => {
  const failed = (count: number) => ({ count, lastAt: t0.toISOString() });

  it('kayıt yoksa çalışır', () => {
    expect(shouldBackOff(null, t0)).toBe(false);
  });

  it('ilk başarısızlıktan sonraki tur (2 dk sonra) çalışır', () => {
    // Tur birkaç saniye sürdüğü için sonraki zamanlayıcı çağrısı ~115 sn sonradır.
    expect(shouldBackOff(failed(1), at(TICK_MS - 5_000))).toBe(false);
  });

  it('ikinci üst üste başarısızlıkta bir tur atlar, sonra dener', () => {
    expect(shouldBackOff(failed(2), at(TICK_MS - 5_000))).toBe(true);
    // 4 dakikalık tık, başarısızlıktan birkaç saniye ÖNCE başlayan turdan sayılır
    // (≈235 sn): payla birlikte bekleme dolmuş sayılır, 6 dakikaya uzamaz.
    expect(shouldBackOff(failed(2), at(2 * TICK_MS - 5_000))).toBe(false);
    expect(shouldBackOff(failed(2), at(2 * TICK_MS - 29_000))).toBe(false);
    // Daha erken tık hâlâ atlanır.
    expect(shouldBackOff(failed(2), at(2 * TICK_MS - 40_000))).toBe(true);
  });

  it('kalıcı hatada günde en fazla ~24 tur: 60 dakikalık tavan', () => {
    expect(shouldBackOff(failed(30), at(58 * MIN))).toBe(true);
    expect(shouldBackOff(failed(30), at(60 * MIN))).toBe(false);
  });

  it('saat geri alınmışsa (kayıt gelecekte) geri çekilmez', () => {
    expect(shouldBackOff(failed(30), at(-10 * MIN))).toBe(false);
    // Küçük saat oynaması (1 dk içinde) geçerli sayılır.
    expect(shouldBackOff(failed(30), at(-30_000))).toBe(true);
  });

  it('bozuk tarihli kayıt çalışmayı engellemez', () => {
    expect(shouldBackOff({ count: 9, lastAt: 'dün' }, t0)).toBe(false);
  });
});

describe('minutesLeft', () => {
  it('kalan süreyi dakika olarak yukarı yuvarlar, en az 1', () => {
    expect(minutesLeft({ count: 4, lastAt: t0.toISOString() }, at(5 * MIN))).toBe(11);
    expect(minutesLeft({ count: 4, lastAt: t0.toISOString() }, at(15 * MIN + 59_000))).toBe(1);
  });
});

describe('kayıt dosyası', () => {
  const file = () => join(mkdtempSync(join(tmpdir(), 'sync-backoff-')), 'nested', 'state.json.failure');

  it('başarısızlıkları sayar, başarı sıfırlar', () => {
    const path = file();
    expect(loadFailure(path)).toBeNull();
    expect(recordFailure(path, at(0))).toEqual({ count: 1, lastAt: t0.toISOString() });
    expect(recordFailure(path, at(5 * MIN))).toEqual({ count: 2, lastAt: at(5 * MIN).toISOString() });
    expect(loadFailure(path)?.count).toBe(2);

    clearFailure(path);
    expect(existsSync(path)).toBe(false);
    expect(loadFailure(path)).toBeNull();
    clearFailure(path); // olmayan dosyayı silmek hata değil
    expect(recordFailure(path, at(10 * MIN)).count).toBe(1);
  });

  it('bozuk ya da eksik dosyayı yok sayar (tur çalışır, sayaç yeniden başlar)', () => {
    const path = file();
    recordFailure(path, at(0));
    writeFileSync(path, '{"count":3,"last');
    expect(loadFailure(path)).toBeNull();
    writeFileSync(path, JSON.stringify({ count: 0, lastAt: t0.toISOString() }));
    expect(loadFailure(path)).toBeNull();
    writeFileSync(path, JSON.stringify({ count: 2 }));
    expect(loadFailure(path)).toBeNull();
    expect(recordFailure(path, at(0)).count).toBe(1);
  });
});
