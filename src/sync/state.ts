/**
 * Senkronun yerel durumu: "bu tabloyu en son hangi içerikle yazdım?"
 *
 * Senkron 2 dakikada bir çalışır ve fark bulmak için tabloyu veritabanından
 * çekmek zorundadır (~1 MB/tur). Ücretsiz Supabase'in aylık çıkış kotası 5 GB:
 * her turda her tabloyu çekmek kotayı birkaç günde bitirir. Kaynaklar yerelde
 * ve okuması ucuz; bu yüzden her tablonun istenen satırlarının özeti (hash)
 * saklanır, özet değişmemişse tablo veritabanından HİÇ çekilmez.
 *
 * Önbelleğe ancak veritabanı hâlâ bizim bıraktığımız haldeyse güvenilir:
 * kalp atışındaki last_ok_at bizim son yazdığımız değerle aynı olmalı
 * (veritabanı sıfırlandıysa ya da başka bir işçi yazdıysa tam senkron).
 * Elle yapılmış değişikliklere karşı da belirli aralıkla tam senkron yapılır.
 */

import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';

export interface SyncState {
  /** Bu durumun ait olduğu veritabanı. */
  url: string;
  /** Bu işçinin kalp atışına yazdığı son last_ok_at. */
  lastOkAt: string;
  /** Önbellek kullanılmadan yapılan son tam senkron. */
  lastFullAt: string;
  /** Önbellek anahtarı (tablo ya da tablo:sekme) → istenen satırların özeti. */
  hashes: Record<string, string>;
}

/** Elle yapılan değişiklikler en geç bu kadar sonra düzeltilir. */
export const FULL_SYNC_EVERY_MS = 6 * 3_600_000;

/** Satırların sırasına ve içeriğine bağlı kararlı özet. */
export function hashRows(rows: readonly unknown[]): string {
  return createHash('sha256').update(JSON.stringify(rows)).digest('hex');
}

export function loadState(path: string): SyncState | null {
  try {
    const parsed = JSON.parse(readFileSync(path, 'utf8')) as Partial<SyncState>;
    if (
      typeof parsed.url !== 'string' ||
      typeof parsed.lastOkAt !== 'string' ||
      typeof parsed.lastFullAt !== 'string' ||
      !parsed.hashes ||
      typeof parsed.hashes !== 'object'
    ) {
      return null;
    }
    return parsed as SyncState;
  } catch {
    // Dosya yok ya da bozuk: önbellek yok sayılır, tam senkron yapılır.
    return null;
  }
}

/** Yarım yazılmış durum dosyası bir sonraki turu yanıltmasın: önce geçici dosya. */
export function saveState(path: string, state: SyncState): void {
  mkdirSync(dirname(path), { recursive: true });
  const tmp = `${path}.tmp`;
  writeFileSync(tmp, JSON.stringify(state, null, 2));
  renameSync(tmp, path);
}

/**
 * Önbelleğe bu turda güvenilebilir mi?
 *
 * @param remoteLastOkAt  Veritabanındaki kalp atışının last_ok_at değeri (yoksa null)
 */
export function canTrustState(
  state: SyncState | null,
  url: string,
  remoteLastOkAt: string | null,
  now: Date,
): state is SyncState {
  if (!state || state.url !== url || remoteLastOkAt === null) return false;
  // Aynı an farklı biçimde yazılmış olabilir ("Z" / "+00:00").
  if (Date.parse(state.lastOkAt) !== Date.parse(remoteLastOkAt)) return false;
  const lastFull = Date.parse(state.lastFullAt);
  return !Number.isNaN(lastFull) && now.getTime() - lastFull < FULL_SYNC_EVERY_MS;
}
