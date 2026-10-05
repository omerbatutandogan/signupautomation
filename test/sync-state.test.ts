import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { FULL_SYNC_EVERY_MS, canTrustState, hashRows, loadState, saveState, type SyncState } from '../src/sync/state.js';

/**
 * Senkron önbelleği: değişmeyen tabloyu veritabanından çekmemek için.
 *
 * Tehlikesi şu: önbelleğe YANLIŞ güvenilirse panel eski veriyi gösterir ve
 * senkron "her şey güncel" der. Bu yüzden güven koşulları sıkı ve testli.
 */

const url = 'https://abc.supabase.co';
const now = new Date('2026-10-04T10:00:00Z');
const state: SyncState = {
  url,
  lastOkAt: '2026-10-04T09:58:00.000Z',
  lastFullAt: '2026-10-04T08:00:00.000Z',
  hashes: { attempts: 'h1' },
};

describe('canTrustState', () => {
  it('veritabanı bizim bıraktığımız haldeyse güvenir (zaman biçimi farkı önemsiz)', () => {
    expect(canTrustState(state, url, '2026-10-04T09:58:00+00:00', now)).toBe(true);
  });

  it('durum dosyası yoksa güvenmez', () => {
    expect(canTrustState(null, url, state.lastOkAt, now)).toBe(false);
  });

  it('başka veritabanının durumuna güvenmez (staging → üretim)', () => {
    expect(canTrustState(state, 'https://other.supabase.co', state.lastOkAt, now)).toBe(false);
  });

  it('veritabanı sıfırlandıysa (kalp atışı yok) güvenmez', () => {
    expect(canTrustState(state, url, null, now)).toBe(false);
  });

  it('kalp atışını başkası yazdıysa güvenmez', () => {
    expect(canTrustState(state, url, '2026-10-04T09:59:00+00:00', now)).toBe(false);
  });

  it('son tam senkron eskidiyse güvenmez (elle yapılan değişiklikler düzelsin)', () => {
    const old = { ...state, lastFullAt: new Date(now.getTime() - FULL_SYNC_EVERY_MS - 1).toISOString() };
    expect(canTrustState(old, url, state.lastOkAt, now)).toBe(false);
    const fresh = { ...state, lastFullAt: new Date(now.getTime() - FULL_SYNC_EVERY_MS + 1000).toISOString() };
    expect(canTrustState(fresh, url, state.lastOkAt, now)).toBe(true);
  });

  it('bozuk tarihli durumda güvenmez', () => {
    expect(canTrustState({ ...state, lastFullAt: 'dün' }, url, state.lastOkAt, now)).toBe(false);
  });
});

describe('hashRows', () => {
  it('aynı satırlar aynı özeti, değişen tek alan farklı özeti verir', () => {
    const rows = [{ site_id: 'a', outcome: 'error' }, { site_id: 'b', outcome: 'no_form' }];
    expect(hashRows(rows)).toBe(hashRows(structuredClone(rows)));
    expect(hashRows(rows)).not.toBe(hashRows([{ site_id: 'a', outcome: 'generated' }, rows[1]]));
    expect(hashRows(rows)).not.toBe(hashRows([rows[0]]));
  });
});

describe('loadState / saveState', () => {
  it('yazdığını geri okur', () => {
    const path = join(mkdtempSync(join(tmpdir(), 'sync-state-')), 'nested', 'state.json');
    saveState(path, state);
    expect(loadState(path)).toEqual(state);
    expect(JSON.parse(readFileSync(path, 'utf8'))).toEqual(state);
  });

  it('dosya yoksa ya da bozuksa null döner (tam senkron yapılır)', () => {
    const dir = mkdtempSync(join(tmpdir(), 'sync-state-'));
    expect(loadState(join(dir, 'yok.json'))).toBeNull();
    writeFileSync(join(dir, 'yarim.json'), '{"url":"x","lastOk');
    expect(loadState(join(dir, 'yarim.json'))).toBeNull();
    writeFileSync(join(dir, 'eksik.json'), JSON.stringify({ url }));
    expect(loadState(join(dir, 'eksik.json'))).toBeNull();
  });
});
