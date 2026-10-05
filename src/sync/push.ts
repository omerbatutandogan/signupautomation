/**
 * Panel senkronunun yazma tarafı: fark bazlı upsert (+ isteğe bağlı budama).
 *
 * Değişmeyen satır yeniden yazılmaz — senkron 2 dakikada bir çalışır ve
 * ikinci tur 0 değişiklik üretmeli.
 *
 * Budama (`prune`): veritabanı Aşama 1'de kaynakların yansımasıdır; Sheet'ten
 * silinen satır ya da silinen config dosyası panelde sayılmaya devam etmemeli.
 * Budama yalnızca kaynağı EKSİKSİZ okunan tablolarda açılır (Sheet ya tam
 * okunur ya hata verir; yarım tarama dosyası o turda hiç senkronlanmaz).
 * Yanlış dizin ya da boş bir klasör yansımayı silmesin diye toplu silme
 * reddedilir (bkz. PRUNE_*).
 */

import type { SupabaseClient } from '@supabase/supabase-js';

type Row = Record<string, unknown>;

export interface SyncSpec {
  keyColumns: readonly string[];
  /** Değişiklik sayılacak kolonlar (anahtar dışındakiler). */
  compareColumns: readonly string[];
  /** Zaman damgası kolonları: aynı an farklı biçimde yazılmış olabilir. */
  timeColumns?: readonly string[];
  /** citext anahtarlar (e-posta) için. */
  caseInsensitiveKey?: boolean;
}

export interface SyncPlan<R extends object> {
  inserts: R[];
  updates: R[];
  unchanged: number;
  /** Veritabanında olup istenenler arasında olmayan satırlar (budama adayı). */
  stale: Row[];
}

/** Anahtar sırasından bağımsız, kararlı JSON (jsonb anahtarları yeniden sıralar). */
function canonical(value: unknown): string {
  if (value === undefined || value === null) return 'null';
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (typeof value === 'object') {
    const obj = value as Record<string, unknown>;
    return `{${Object.keys(obj)
      .sort()
      .map((k) => `${JSON.stringify(k)}:${canonical(obj[k])}`)
      .join(',')}}`;
  }
  return JSON.stringify(value);
}

function keyOf(input: object, spec: SyncSpec): string {
  const row = input as Row;
  const key = spec.keyColumns.map((c) => String(row[c] ?? '')).join('\u0000');
  return spec.caseInsensitiveKey ? key.toLowerCase() : key;
}

function comparable(input: object, spec: SyncSpec): string {
  const row = input as Row;
  const times = new Set(spec.timeColumns ?? []);
  return spec.compareColumns
    .map((c) => {
      const v = row[c];
      if (times.has(c) && typeof v === 'string') {
        const ms = Date.parse(v);
        return Number.isNaN(ms) ? canonical(v) : String(ms);
      }
      return canonical(v);
    })
    .join('\u0001');
}

/** Saf plan: neyin ekleneceği, neyin güncelleneceği, neyin kaynakta kalmadığı. */
export function planSync<R extends object>(existing: object[], desired: R[], spec: SyncSpec): SyncPlan<R> {
  const current = new Map(existing.map((r) => [keyOf(r, spec), comparable(r, spec)]));
  const seen = new Set<string>();
  const plan: SyncPlan<R> = { inserts: [], updates: [], unchanged: 0, stale: [] };

  for (const row of desired) {
    const key = keyOf(row, spec);
    if (seen.has(key)) {
      throw new Error(`Senkron: yinelenen anahtar (${spec.keyColumns.join(', ')}): ${key.replace(/\u0000/g, ' / ')}`);
    }
    seen.add(key);

    const before = current.get(key);
    if (before === undefined) plan.inserts.push(row);
    else if (before !== comparable(row, spec)) plan.updates.push(row);
    else plan.unchanged++;
  }
  plan.stale = (existing as Row[]).filter((r) => !seen.has(keyOf(r, spec)));
  return plan;
}

export interface SyncCounts {
  table: string;
  inserted: number;
  updated: number;
  unchanged: number;
  deleted: number;
}

const PAGE = 1000; // PostgREST tek istekte en çok 1000 satır döndürür.
const BATCH = 500;
const IN_CHUNK = 200; // .in() listesi adres satırına yazılır; uzunluğu sınırlı.

/** Bu kadar satıra kadar silme serbest (olağan Sheet düzenlemesi) — ama aşağıdaki "hepsi" kuralı hariç. */
export const PRUNE_ALWAYS_ALLOWED = 10;
/** Tablonun (ya da dilimin) bundan büyük kısmı silinecekse reddedilir. */
export const PRUNE_MAX_FRACTION = 0.2;

async function fetchAll(
  client: SupabaseClient,
  table: string,
  columns: readonly string[],
  order: readonly string[],
  where: Readonly<Record<string, string>>,
): Promise<Row[]> {
  const rows: Row[] = [];
  for (;;) {
    let query = client.from(table).select(columns.join(','), { count: 'exact' });
    for (const [col, value] of Object.entries(where)) query = query.eq(col, value);
    for (const col of order) query = query.order(col, { ascending: true });
    const { data, error, count } = await query.range(rows.length, rows.length + PAGE - 1);
    if (error) throw new Error(`${table} okunamadı: ${error.message}`);
    // Toplam sayıya göre ilerle: "sayfa 1000'den kısa geldi" diye durmak, sunucu
    // sayfa sınırı 1000'in altına indirilirse tabloyu sessizce eksik okurdu.
    if (count === null) throw new Error(`${table} okunamadı: satır sayısı gelmedi`);
    const batch = (data ?? []) as unknown as Row[];
    rows.push(...batch);
    if (rows.length >= count) return rows;
    if (batch.length === 0) throw new Error(`${table} okunamadı: ${count} satırdan ${rows.length} tanesi geldi`);
  }
}

async function deleteRows(
  client: SupabaseClient,
  table: string,
  keyColumns: readonly string[],
  rows: Row[],
  where: Readonly<Record<string, string>>,
): Promise<void> {
  const [first, second, ...rest] = keyColumns;
  if (first === undefined || rest.length > 0) {
    throw new Error(`${table}: budama yalnızca bir ya da iki kolonlu anahtarı destekler`);
  }
  // İki kolonlu anahtar: ilk kolona göre grupla, ikincisini .in() ile sil.
  const groups = new Map<string | null, string[]>();
  for (const row of rows) {
    const group = second === undefined ? null : String(row[first]);
    const value = String(row[second ?? first]);
    const list = groups.get(group);
    if (list) list.push(value);
    else groups.set(group, [value]);
  }
  for (const [group, values] of groups) {
    for (let i = 0; i < values.length; i += IN_CHUNK) {
      let query = client.from(table).delete();
      for (const [col, value] of Object.entries(where)) query = query.eq(col, value);
      if (group !== null) query = query.eq(first, group);
      const { error } = await query.in(second ?? first, values.slice(i, i + IN_CHUNK));
      if (error) throw new Error(`${table} budanamadı: ${error.message}`);
    }
  }
}

export interface SyncOptions {
  /** Güncellenen/eklenen satırlara eklenecek alanlar (ör. synced_at). */
  touch?: () => Row;
  dryRun?: boolean;
  /**
   * Tablonun yalnızca bu dilimi kıyaslanır (ör. tek sekme). `desired` de
   * yalnızca o dilimin satırlarını içermelidir.
   */
  where?: Readonly<Record<string, string>>;
  /** Kaynakta olmayan satırları sil. Yalnızca kaynağı eksiksiz okunan tabloda. */
  prune?: boolean;
  /** Toplu silme korumasını aş (bilerek yapılan büyük temizlik). */
  allowMassDelete?: boolean;
}

/** Bir tabloyu (ya da dilimini) istenen satırlara getirir. */
export async function syncTable<R extends object>(
  client: SupabaseClient,
  table: string,
  desired: R[],
  spec: SyncSpec,
  opts: SyncOptions = {},
): Promise<SyncCounts> {
  const where = opts.where ?? {};
  for (const [col, value] of Object.entries(where)) {
    const stray = desired.find((r) => (r as Row)[col] !== value);
    if (stray) throw new Error(`Senkron: ${table} dilimi ${col}=${value} ama satırda ${String((stray as Row)[col])}`);
  }
  const existing = await fetchAll(client, table, [...spec.keyColumns, ...spec.compareColumns], spec.keyColumns, where);
  const plan = planSync(existing, desired, spec);
  const changed = [...plan.inserts, ...plan.updates];
  const stale = opts.prune ? plan.stale : [];

  // Kaynak eksik okunmuşsa (yanlış --source, boş klasör, başka bir Sheet) fark
  // "her şey silinsin" demek olur. İki kural:
  //  - veritabanındaki satırların HEPSİNİ silmek (6 hesaplık küçük tablo dahil) asla serbest değil;
  //  - 10'dan fazla satır VE tablonun beşte birinden fazlası da değil.
  if (!opts.allowMassDelete) {
    const everything = existing.length > 0 && stale.length === existing.length;
    const tooMany = stale.length > PRUNE_ALWAYS_ALLOWED && stale.length > existing.length * PRUNE_MAX_FRACTION;
    if (everything || tooMany) {
      throw new Error(
        `${table}: ${existing.length} satırın ${stale.length} tanesi kaynakta yok${everything ? ' (hepsi)' : ''} — toplu silme reddedildi. ` +
          'Kaynak eksik okunmuş olabilir (yanlış --source, boş klasör). Emin isen: --allow-mass-delete',
      );
    }
  }

  if (!opts.dryRun) {
    for (let i = 0; i < changed.length; i += BATCH) {
      const batch: Row[] = changed.slice(i, i + BATCH).map((r) => ({ ...r, ...opts.touch?.() }));
      const { error } = await client.from(table).upsert(batch, { onConflict: spec.keyColumns.join(',') });
      if (error) throw new Error(`${table} yazılamadı: ${error.message}`);
    }
    if (stale.length > 0) await deleteRows(client, table, spec.keyColumns, stale, where);
  }
  return {
    table,
    inserted: plan.inserts.length,
    updated: plan.updates.length,
    unchanged: plan.unchanged,
    deleted: stale.length,
  };
}

// ── Önbellekli senkron ────────────────────────────────────────────────────

export interface CacheContext {
  /** Güvenilen önbellekteki özetler; null = bu turda önbellek kullanılmıyor. */
  trusted: Readonly<Record<string, string>> | null;
  /** Bu tur sonunda kaydedilecek özetler (yerinde güncellenir). */
  hashes: Record<string, string>;
}

/**
 * İstenen satırların özeti güvenilen önbellektekiyle aynıysa `run` çağrılmaz
 * (tablo veritabanından hiç çekilmez). Özet yalnızca `run` başarıyla
 * bittikten SONRA kaydedilir; başlamadan önce eskisi silinir ki yarıda kalan
 * bir yazım hiçbir koşulda "senkronlandı" diye kalmasın.
 */
export async function syncIfChanged(
  ctx: CacheContext,
  key: string,
  table: string,
  desiredCount: number,
  hash: string,
  run: () => Promise<SyncCounts>,
): Promise<SyncCounts & { skipped?: boolean }> {
  if (ctx.trusted && ctx.trusted[key] === hash) {
    return { table, inserted: 0, updated: 0, unchanged: desiredCount, deleted: 0, skipped: true };
  }
  delete ctx.hashes[key];
  const result = await run();
  ctx.hashes[key] = hash;
  return result;
}
