import type { SupabaseClient } from '@supabase/supabase-js';
import { describe, expect, it } from 'vitest';
import { PRUNE_ALWAYS_ALLOWED, syncIfChanged, syncTable, type CacheContext } from '../src/sync/push.js';

/**
 * syncTable ve önbellekli senkron — bellekte çalışan sahte bir PostgREST ile.
 *
 * Buradaki hatalar sessizdir: eksik okunan tablo "değişiklik yok" der, yanlış
 * dilim başka sekmenin satırlarını siler, yarıda kalan yazım "senkronlandı"
 * diye kalır. Sahte istemci, gerçek istemcinin kullandığımız kadarını taklit
 * eder: select(+count) / eq / order / range, upsert(onConflict), delete + in.
 */

type Row = Record<string, unknown>;

interface Fake {
  client: SupabaseClient;
  tables: Record<string, Row[]>;
  calls: string[];
  /** Bir sonraki upsert bu hatayla dönsün (yarıda kalan yazım). */
  failNextUpsert?: string;
}

function fakeDb(tables: Record<string, Row[]>, opts: { maxRows?: number } = {}): Fake {
  const fake: Fake = { tables, calls: [], client: undefined as unknown as SupabaseClient };
  const maxRows = opts.maxRows ?? 1000;

  class Builder {
    private op: 'select' | 'upsert' | 'delete' = 'select';
    private filters: [string, unknown][] = [];
    private inFilter: [string, unknown[]] | null = null;
    private orderBy: string[] = [];
    private window: [number, number] | null = null;
    private columns: string[] = [];
    private payload: Row[] = [];
    private conflict: string[] = [];
    constructor(private table: string) {}

    select(cols: string) {
      this.op = 'select';
      this.columns = cols.split(',');
      return this;
    }
    upsert(rows: Row[], o: { onConflict: string }) {
      this.op = 'upsert';
      this.payload = rows;
      this.conflict = o.onConflict.split(',');
      return this;
    }
    delete() {
      this.op = 'delete';
      return this;
    }
    eq(col: string, value: unknown) {
      this.filters.push([col, value]);
      return this;
    }
    in(col: string, values: unknown[]) {
      this.inFilter = [col, values];
      return this;
    }
    order(col: string) {
      this.orderBy.push(col);
      return this;
    }
    range(from: number, to: number) {
      this.window = [from, to];
      return this;
    }

    private matches(row: Row): boolean {
      if (!this.filters.every(([c, v]) => row[c] === v)) return false;
      return this.inFilter === null || this.inFilter[1].includes(row[this.inFilter[0]]);
    }

    then(resolve: (value: { data: Row[] | null; error: { message: string } | null; count: number | null }) => void) {
      const rows = (fake.tables[this.table] ??= []);
      if (this.op === 'select') {
        const hit = rows
          .filter((r) => this.matches(r))
          .sort((a, b) => this.orderBy.map((c) => String(a[c]).localeCompare(String(b[c]))).find((n) => n !== 0) ?? 0);
        const [from, to] = this.window ?? [0, hit.length - 1];
        const page = hit.slice(from, Math.min(to + 1, from + maxRows));
        fake.calls.push(`select ${this.table} ${from}-${to} → ${page.length}`);
        resolve({ data: page.map((r) => Object.fromEntries(this.columns.map((c) => [c, r[c] ?? null]))), error: null, count: hit.length });
      } else if (this.op === 'upsert') {
        if (fake.failNextUpsert) {
          const message = fake.failNextUpsert;
          fake.failNextUpsert = undefined;
          return resolve({ data: null, error: { message }, count: null });
        }
        for (const incoming of this.payload) {
          const at = rows.findIndex((r) => this.conflict.every((c) => r[c] === incoming[c]));
          if (at === -1) rows.push({ ...incoming });
          else rows[at] = { ...rows[at], ...incoming };
        }
        fake.calls.push(`upsert ${this.table} ${this.payload.length}`);
        resolve({ data: null, error: null, count: null });
      } else {
        const keep = rows.filter((r) => !this.matches(r));
        fake.calls.push(`delete ${this.table} ${rows.length - keep.length}`);
        fake.tables[this.table] = keep;
        resolve({ data: null, error: null, count: null });
      }
    }
  }

  fake.client = { from: (table: string) => new Builder(table) } as unknown as SupabaseClient;
  return fake;
}

const spec = { keyColumns: ['tab', 'site_id'], compareColumns: ['outcome'] } as const;
const d = (tab: string, site: string, outcome = 'no_form') => ({ tab, site_id: site, outcome });
const many = (tab: string, n: number) => Array.from({ length: n }, (_, i) => d(tab, `s${String(i).padStart(5, '0')}`));

describe('syncTable — okuma', () => {
  it('1000 satırı aşan tabloyu sayfa sayfa eksiksiz okur (hiçbiri "yeni" görünmez)', async () => {
    const db = fakeDb({ site_discoveries: many('SaaS', 2500) });
    const counts = await syncTable(db.client, 'site_discoveries', many('SaaS', 2500), spec);
    expect(counts).toMatchObject({ inserted: 0, updated: 0, unchanged: 2500, deleted: 0 });
    expect(db.calls.filter((c) => c.startsWith('upsert'))).toEqual([]);
  });

  it('sunucu sayfa sınırı 1000\'den küçükse de tabloyu eksik okumaz', async () => {
    // "Sayfa 1000'den kısa geldiyse bitti" kuralı burada 400 satırda dururdu
    // ve kalan 500 satırı "yeni" sayıp her turda yeniden yazardı.
    const db = fakeDb({ site_discoveries: many('SaaS', 900) }, { maxRows: 400 });
    const counts = await syncTable(db.client, 'site_discoveries', many('SaaS', 900), spec);
    expect(counts).toMatchObject({ inserted: 0, unchanged: 900 });
  });
});

describe('syncTable — dilim (where)', () => {
  it('yalnızca verilen sekmeyi kıyaslar; öteki sekmenin satırlarına dokunmaz', async () => {
    // "Deals " (sonda boşluk) ile "Deals" ayrı sekmelerdir.
    const db = fakeDb({ site_discoveries: [d('Deals ', 'a'), d('Deals ', 'old'), d('Deals', 'x'), d('SaaS', 'y')] });
    const counts = await syncTable(db.client, 'site_discoveries', [d('Deals ', 'a', 'generated'), d('Deals ', 'b')], spec, {
      where: { tab: 'Deals ' },
      prune: true,
    });
    expect(counts).toMatchObject({ inserted: 1, updated: 1, unchanged: 0, deleted: 1 });
    expect(db.tables.site_discoveries).toEqual(
      expect.arrayContaining([d('Deals ', 'a', 'generated'), d('Deals ', 'b'), d('Deals', 'x'), d('SaaS', 'y')]),
    );
    expect(db.tables.site_discoveries).toHaveLength(4);
  });

  it('dilime ait olmayan satır verilirse yazmadan hata verir', async () => {
    const db = fakeDb({ site_discoveries: [] });
    await expect(
      syncTable(db.client, 'site_discoveries', [d('SaaS', 'a'), d('Forums', 'b')], spec, { where: { tab: 'SaaS' } }),
    ).rejects.toThrow(/dilimi tab=SaaS/);
    expect(db.calls).toEqual([]);
  });
});

describe('syncTable — budama', () => {
  it('budama kapalıyken kaynakta olmayan satırı silmez (ör. denemeler)', async () => {
    const db = fakeDb({ site_discoveries: [d('SaaS', 'a'), d('SaaS', 'gone')] });
    const counts = await syncTable(db.client, 'site_discoveries', [d('SaaS', 'a')], spec);
    expect(counts.deleted).toBe(0);
    expect(db.tables.site_discoveries).toHaveLength(2);
  });

  it('budama açıkken Sheet\'ten silinen birkaç satırı siler', async () => {
    const db = fakeDb({ site_discoveries: [...many('SaaS', 50), d('SaaS', 'gone-1'), d('SaaS', 'gone-2')] });
    const counts = await syncTable(db.client, 'site_discoveries', many('SaaS', 50), spec, { prune: true });
    expect(counts).toMatchObject({ deleted: 2, unchanged: 50 });
    expect(db.tables.site_discoveries).toHaveLength(50);
  });

  it('toplu silmeyi reddeder: boş okunan kaynak yansımayı silmesin', async () => {
    // Yanlış --source ya da boş bir src/sites klasörü: istenen liste boş.
    const db = fakeDb({ site_configs: many('x', 700).map((r) => ({ site_id: r.site_id, outcome: 'x' })) });
    const configSpec = { keyColumns: ['site_id'], compareColumns: ['outcome'] } as const;
    await expect(syncTable(db.client, 'site_configs', [], configSpec, { prune: true })).rejects.toThrow(/toplu silme reddedildi/);
    expect(db.tables.site_configs).toHaveLength(700);

    const counts = await syncTable(db.client, 'site_configs', [], configSpec, { prune: true, allowMassDelete: true });
    expect(counts.deleted).toBe(700);
    expect(db.tables.site_configs).toHaveLength(0);
  });

  it('oran yüksek olsa da 10 satıra kadar silmek serbesttir (olağan Sheet düzenlemesi)', async () => {
    // 40 satırdan 10'u kalkıyor: %25 ama sayı eşiği aşmıyor.
    const db = fakeDb({ site_discoveries: [...many('SaaS', 40), ...many('SaaS', 50).slice(40)] });
    const counts = await syncTable(db.client, 'site_discoveries', many('SaaS', 40), spec, { prune: true });
    expect(counts.deleted).toBe(PRUNE_ALWAYS_ALLOWED);
    expect(db.tables.site_discoveries).toHaveLength(40);
  });

  it('küçük tabloyu da BOŞALTMAYA izin vermez: boş okunan ledger 6 hesabı silmesin', async () => {
    const accountSpec = { keyColumns: ['product_id', 'site_id'], compareColumns: ['email'] } as const;
    const account = (site: string) => ({ product_id: 'geo-new', site_id: site, email: `${site}@x.test` });
    const db = fakeDb({ accounts: ['a', 'b', 'c', 'd', 'e', 'f'].map(account) });

    await expect(syncTable(db.client, 'accounts', [], accountSpec, { prune: true })).rejects.toThrow(/\(hepsi\).*toplu silme reddedildi/);
    expect(db.tables.accounts).toHaveLength(6);

    // Hepsi yeni satırlarla DEĞİŞİYORSA da (kaynak tümden başka bir şey) reddedilir.
    await expect(
      syncTable(db.client, 'accounts', ['x', 'y'].map(account), accountSpec, { prune: true }),
    ).rejects.toThrow(/toplu silme reddedildi/);
    expect(db.tables.accounts).toHaveLength(6);

    // Bir kısmını silmek (biri kalkmış) serbest.
    const counts = await syncTable(db.client, 'accounts', ['a', 'b', 'c', 'd', 'e'].map(account), accountSpec, { prune: true });
    expect(counts.deleted).toBe(1);
    expect(db.tables.accounts).toHaveLength(5);

    // Bilerek yapılan tam temizlik bayrakla.
    const wiped = await syncTable(db.client, 'accounts', [], accountSpec, { prune: true, allowMassDelete: true });
    expect(wiped.deleted).toBe(5);
    expect(db.tables.accounts).toHaveLength(0);
  });

  it('boş tabloda ya da budama kapalıyken boş kaynak hata değildir', async () => {
    const db = fakeDb({ site_discoveries: [] });
    expect(await syncTable(db.client, 'site_discoveries', [], spec, { prune: true })).toMatchObject({ deleted: 0 });
    const full = fakeDb({ site_discoveries: many('SaaS', 3) });
    expect(await syncTable(full.client, 'site_discoveries', [], spec)).toMatchObject({ deleted: 0 });
    expect(full.tables.site_discoveries).toHaveLength(3);
  });

  it('dry-run ne yazar ne siler; yalnızca sayar', async () => {
    const db = fakeDb({ site_discoveries: [d('SaaS', 'a'), d('SaaS', 'gone')] });
    const counts = await syncTable(db.client, 'site_discoveries', [d('SaaS', 'a', 'generated'), d('SaaS', 'new')], spec, {
      prune: true,
      dryRun: true,
    });
    expect(counts).toMatchObject({ inserted: 1, updated: 1, deleted: 1 });
    expect(db.tables.site_discoveries).toEqual([d('SaaS', 'a'), d('SaaS', 'gone')]);
  });

  it('değişen satırlara touch alanlarını ekler, değişmeyene dokunmaz', async () => {
    const db = fakeDb({ site_discoveries: [d('SaaS', 'a'), d('SaaS', 'b')] });
    await syncTable(db.client, 'site_discoveries', [d('SaaS', 'a'), d('SaaS', 'b', 'generated')], spec, {
      touch: () => ({ synced_at: 'now' }),
    });
    expect(db.tables.site_discoveries).toEqual([d('SaaS', 'a'), { ...d('SaaS', 'b', 'generated'), synced_at: 'now' }]);
  });
});

describe('syncIfChanged — önbellek', () => {
  const ok = (table: string) => async () => ({ table, inserted: 1, updated: 0, unchanged: 0, deleted: 0 });

  it('güvenilen önbellekte özet aynıysa çalıştırmaz', async () => {
    const ctx: CacheContext = { trusted: { attempts: 'h1' }, hashes: { attempts: 'h1' } };
    let ran = false;
    const c = await syncIfChanged(ctx, 'attempts', 'attempts', 65, 'h1', async () => {
      ran = true;
      return ok('attempts')();
    });
    expect(ran).toBe(false);
    expect(c).toMatchObject({ skipped: true, unchanged: 65 });
    expect(ctx.hashes.attempts).toBe('h1');
  });

  it('özet değiştiyse çalıştırır ve yeni özeti kaydeder', async () => {
    const ctx: CacheContext = { trusted: { attempts: 'h1' }, hashes: { attempts: 'h1' } };
    const c = await syncIfChanged(ctx, 'attempts', 'attempts', 66, 'h2', ok('attempts'));
    expect(c.skipped).toBeUndefined();
    expect(ctx.hashes.attempts).toBe('h2');
  });

  it('önbelleğe güvenilmiyorsa özet aynı olsa da çalıştırır', async () => {
    const ctx: CacheContext = { trusted: null, hashes: {} };
    const c = await syncIfChanged(ctx, 'attempts', 'attempts', 65, 'h1', ok('attempts'));
    expect(c.inserted).toBe(1);
    expect(ctx.hashes.attempts).toBe('h1');
  });

  it('yazım yarıda kalırsa o tablonun özeti kaydedilmez (eski özet de silinir)', async () => {
    const ctx: CacheContext = { trusted: { accounts: 'old' }, hashes: { accounts: 'old', attempts: 'keep' } };
    await expect(
      syncIfChanged(ctx, 'accounts', 'accounts', 6, 'new', async () => {
        throw new Error('accounts yazılamadı');
      }),
    ).rejects.toThrow('accounts yazılamadı');
    expect(ctx.hashes).toEqual({ attempts: 'keep' });
  });

  it('uçtan uca: yarıda kalan upsert sonrası aynı kaynak yeniden senkronlanır', async () => {
    const db = fakeDb({ site_discoveries: [d('SaaS', 'a')] });
    const desired = [d('SaaS', 'a', 'generated'), d('SaaS', 'b')];
    const ctx: CacheContext = { trusted: { t: 'h-old' }, hashes: { t: 'h-old' } };
    const attempt = () => syncIfChanged(ctx, 't', 'site_discoveries', desired.length, 'h-new', () => syncTable(db.client, 'site_discoveries', desired, spec));

    db.failNextUpsert = 'connection reset';
    await expect(attempt()).rejects.toThrow(/connection reset/);
    expect(ctx.hashes.t).toBeUndefined();

    // Sonraki tur: önbellekte özet yok → tablo çekilir ve tamamlanır.
    const c = await attempt();
    expect(c).toMatchObject({ inserted: 1, updated: 1 });
    expect(ctx.hashes.t).toBe('h-new');
    expect(db.tables.site_discoveries).toEqual(expect.arrayContaining(desired));
  });
});
