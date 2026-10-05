/**
 * Sorgu sonuçlarını açan yardımcılar (saf — sunucuya özgü hiçbir şey yok).
 *
 * Kural: okunamayan veri HATA olur, asla "0" ya da boş liste olmaz. Panelde
 * yanlış bir sıfır ("0 hesap") doğru görünen bir yalandır.
 */

interface Failure {
  message: string;
  code?: string;
}

export function unwrap<T>(result: { data: T | null; error: Failure | null }, what: string): T {
  if (result.error) throw new Error(`${what} could not be loaded: ${result.error.message}`);
  // Hata yok ama veri de yok: istemci bazı başarısızlıkları böyle döndürür.
  if (result.data === null) throw new Error(`${what} could not be loaded: empty response`);
  return result.data;
}

/** maybeSingle() için: satırın olmaması geçerli bir sonuçtur. */
export function unwrapOptional<T>(result: { data: T | null; error: Failure | null }, what: string): T | null {
  if (result.error) throw new Error(`${what} could not be loaded: ${result.error.message}`);
  return result.data;
}

/**
 * Sayım (HEAD) isteği. postgrest-js, HEAD isteğindeki 404'ü (tablo şema
 * önbelleğinde yok) hata olarak DÖNDÜRMEZ: `error: null, count: null` gelir.
 * Sayı gelmediyse okunamamış demektir.
 */
export function countOf(result: { count: number | null; error: Failure | null }, what: string): number {
  if (result.error) throw new Error(`${what} could not be counted: ${result.error.message}`);
  if (result.count === null) throw new Error(`${what} could not be counted: no count returned`);
  return result.count;
}

/**
 * Büyüyebilecek bir listeyi eksiksiz çeker. Sunucunun bildirdiği toplam sayıya
 * göre ilerler; "sayfa kısa geldiyse bitti" varsayımı, sunucunun sayfa sınırı
 * beklenenden küçükse listeyi sessizce eksik bırakırdı.
 */
export async function fetchAllPages<T>(
  page: (from: number, to: number) => PromiseLike<{ data: T[] | null; error: Failure | null; count: number | null }>,
  what: string,
  pageSize = 1000,
): Promise<T[]> {
  const rows: T[] = [];
  for (;;) {
    const result = await page(rows.length, rows.length + pageSize - 1);
    const batch = unwrap(result, what);
    const total = countOf(result, what);
    rows.push(...batch);
    if (rows.length >= total) return rows;
    if (batch.length === 0) throw new Error(`${what} could not be loaded: got ${rows.length} of ${total} rows`);
  }
}
