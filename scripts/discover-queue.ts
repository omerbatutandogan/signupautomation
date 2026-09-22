/**
 * Keşif kuyruğu kararları — saf mantık, test edilebilir.
 *
 * discover.ts'den ayrıldı çünkü buradaki tek bir hata veri kaybı demek:
 * doğrulanmış bir config yeniden taranırsa keşif taslağıyla ezilir ve
 * elle yapılmış düzeltmeler (selector'lar, expect desenleri, ToS notları)
 * kaybolur.
 */

export type Outcome =
  | 'generated'
  | 'high_risk'
  | 'bot_protected'
  | 'no_form'
  | 'error'
  | 'skipped_existing';

/**
 * Yeniden taranabilir sonuçlar.
 *
 * `generated` ve `high_risk` ASLA yeniden taranmaz: ilki doğrulanmış iş,
 * ikincisi ToS kararı. `bot_protected` de sitenin kalıcı özelliği.
 * Yalnızca aracın yanılmış olabileceği sonuçlar yeniden kuyruğa girer.
 */
export const RETRYABLE: ReadonlySet<Outcome> = new Set<Outcome>(['no_form', 'error']);

/** Bot duvarı red sebebi — Sheet'te "form yok"tan ayrışması için. */
export const BOT_REASON = 'Bot koruması (403/challenge) — otomasyon denenmeyecek, elle açılmalı';

/**
 * Bu site bu turda taranmalı mı?
 *
 * @param prior  Daha önceki sonuç; hiç işlenmediyse undefined.
 * @param retryFailed  --retry-failed bayrağı verildi mi.
 */
export function shouldEnqueue(prior: Outcome | undefined, retryFailed: boolean): boolean {
  if (!prior) return true; // hiç işlenmemiş
  return retryFailed && RETRYABLE.has(prior);
}
