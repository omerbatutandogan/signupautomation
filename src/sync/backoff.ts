/**
 * Başarısız turlarda geri çekilme.
 *
 * Başarısız bir tur önbelleği siler: sonraki tur her tabloyu veritabanından
 * baştan çeker (~1,5 MB). Kalıcı bir hata (toplu silme reddi, uygulanmamış bir
 * migration, bozuk bir kaynak) 2 dakikada bir tekrarlanırsa ücretsiz Supabase'in
 * aylık 5 GB çıkış kotası günler içinde biter ve kimse fark etmeden proje
 * kısıtlanır. Zamanlanmış tur bu yüzden üst üste başarısız oldukça seyrekleşir
 * (4, 8, 16, 32, en çok 60 dakika); tek bir başarı sayacı sıfırlar.
 *
 * Panel bu sürede "Sync is failing" gösterir (son hata kalp atışında durur);
 * seyrekleşmek hatayı gizlemez, yalnızca maliyetini sınırlar. Elle çalıştırılan
 * senkron geri çekilmeye takılmaz.
 */

import { mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';

export interface FailureRecord {
  /** Üst üste başarısız tur sayısı. */
  count: number;
  /** Son başarısızlığın zamanı (ISO). */
  lastAt: string;
}

const MINUTE = 60_000;
/** Zamanlayıcının çağrı aralığı; ilk başarısızlıkta beklenmez (bir sonraki tur zaten 2 dk sonra). */
export const TICK_MS = 2 * MINUTE;
export const MAX_BACKOFF_MS = 60 * MINUTE;
/**
 * Bir tur birkaç saniye sürer: başarısızlık zamanı turun BAŞINDAN biraz sonradır,
 * zamanlayıcı ise başlangıçlara göre tıklar. Payı olmasa 4 dakikalık bekleme
 * fiilen 6 dakikaya uzardı (240 sn'lik tık, 235 sn'de sayılır ve atlanır).
 */
export const SLACK_MS = 30_000;

/** n. üst üste başarısızlıktan sonra turlar arasında en az geçmesi gereken süre. */
export function backoffMs(failures: number): number {
  if (failures <= 1) return 0;
  return Math.min(MAX_BACKOFF_MS, TICK_MS * 2 ** (failures - 1));
}

/**
 * Bu tur atlanmalı mı?
 *
 * Saat geri alınmışsa (kayıt "gelecekte") geri çekilme uygulanmaz: yanlış bir
 * saat senkronu saatlerce susturmasın.
 */
export function shouldBackOff(record: FailureRecord | null, now: Date): boolean {
  if (!record) return false;
  const last = Date.parse(record.lastAt);
  if (Number.isNaN(last)) return false;
  const elapsed = now.getTime() - last;
  if (elapsed < -MINUTE) return false;
  return elapsed + SLACK_MS < backoffMs(record.count);
}

/** Kalan bekleme (dakika, yukarı yuvarlanır) — günlük mesajı için. */
export function minutesLeft(record: FailureRecord, now: Date): number {
  const left = backoffMs(record.count) - (now.getTime() - Date.parse(record.lastAt));
  return Math.max(1, Math.ceil(left / MINUTE));
}

export function loadFailure(path: string): FailureRecord | null {
  try {
    const parsed = JSON.parse(readFileSync(path, 'utf8')) as Partial<FailureRecord>;
    if (!Number.isInteger(parsed.count) || (parsed.count as number) < 1 || typeof parsed.lastAt !== 'string') return null;
    return { count: parsed.count as number, lastAt: parsed.lastAt };
  } catch {
    // Dosya yok ya da bozuk: geri çekilme yok (tur çalışır).
    return null;
  }
}

/** Yeni bir başarısızlık kaydeder (önceki sayaca ekler). Yazılan kaydı döner. */
export function recordFailure(path: string, now: Date): FailureRecord {
  const record: FailureRecord = { count: (loadFailure(path)?.count ?? 0) + 1, lastAt: now.toISOString() };
  mkdirSync(dirname(path), { recursive: true });
  const tmp = `${path}.tmp`;
  writeFileSync(tmp, JSON.stringify(record));
  renameSync(tmp, path);
  return record;
}

export function clearFailure(path: string): void {
  rmSync(path, { force: true });
}
