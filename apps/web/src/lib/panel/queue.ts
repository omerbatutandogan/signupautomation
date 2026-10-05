/**
 * Kayıt kuyruğu hesapları (saf).
 *
 * Günlük limit bütün ürünlerin ORTAK limitidir (tek IP'den çıkan toplam kayıt
 * sayısını sınırlar); bitiş tahmini bu yüzden ürün başına değil toplam
 * kuyruk üzerinden yapılır.
 */

export interface Eta {
  /** Bugün dahil kaç takvim günü süreceği; kuyruk boşsa 0. */
  days: number;
  /** Son kaydın düşeceği gün ("YYYY-AA-GG"); kuyruk boşsa null. */
  finishDay: string | null;
}

/**
 * @param pending    Yapılacak kayıt sayısı
 * @param dailyLimit Günlük limit (> 0)
 * @param usedToday  Bugün harcanan gerçek deneme
 * @param today      Bugünün takvim günü, işçinin saat diliminde ("YYYY-AA-GG")
 */
export function estimateEta(pending: number, dailyLimit: number, usedToday: number, today: string): Eta {
  if (pending <= 0 || dailyLimit <= 0) return { days: 0, finishDay: null };
  const leftToday = Math.max(0, dailyLimit - usedToday);
  const days = pending <= leftToday ? 1 : 1 + Math.ceil((pending - leftToday) / dailyLimit);

  const finish = new Date(`${today}T00:00:00Z`);
  finish.setUTCDate(finish.getUTCDate() + days - 1);
  return { days, finishDay: finish.toISOString().slice(0, 10) };
}

/** Senkron 2 dakikada bir çalışır; birkaç tur kaçtıysa veri eskidir. */
export const STALE_AFTER_MS = 10 * 60_000;

/**
 * "failing" yalnızca hata kaydı bu kadar tazeyken gösterilir: zamanlanmış turun en
 * seyrek hali 60 dakika (geri çekilme tavanı) + pay. Daha eski bir hata kaydı
 * senkronun artık ÇALIŞMADIĞını gösterir (Mac uyudu): "stale" doğrusu odur.
 */
export const FAILING_WINDOW_MS = 70 * 60_000;

export interface SyncSnapshot {
  last_ok_at: string | null;
  last_run_at: string | null;
  last_error: string | null;
}

/**
 * Panelin gösterdiği verinin durumu. Sıra önemli:
 *  - never:   hiç başarılı senkron yok.
 *  - failing: senkron ÇALIŞIYOR ama hata veriyor (son tur, son başarılı turdan
 *             yeni, hata kayıtlı ve kayıt FAILING_WINDOW_MS içinde). "Mac uyuyor"
 *             demek burada yanlış olurdu.
 *  - stale:   senkron hiç çalışmıyor (Mac uykuda/kapalı).
 *  - warning: son tur başarılı ama eksikle bitti (ör. Sheet okunamadı).
 *  - fresh:   her şey güncel.
 */
export type SyncState = 'never' | 'failing' | 'stale' | 'warning' | 'fresh';

export function syncState(status: SyncSnapshot | null, now: Date): SyncState {
  if (!status?.last_ok_at) return 'never';
  const ok = Date.parse(status.last_ok_at);
  const run = status.last_run_at ? Date.parse(status.last_run_at) : ok;
  if (status.last_error && run > ok && now.getTime() - run <= FAILING_WINDOW_MS) return 'failing';
  if (now.getTime() - ok > STALE_AFTER_MS) return 'stale';
  return status.last_error ? 'warning' : 'fresh';
}

/** Grafik ekseni için "temiz" üst sınır ve adım (0 / 5 / 10 …). */
export function niceScale(max: number): { top: number; step: number } {
  const target = Math.max(1, max);
  const step = [1, 2, 5, 10, 20, 25, 50, 100, 200, 500, 1000].find((s) => target / s <= 4) ?? 1000;
  return { top: Math.ceil(target / step) * step, step };
}
