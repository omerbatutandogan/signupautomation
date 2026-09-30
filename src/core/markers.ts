/**
 * Config notlarındaki işaretler — keşif basar, runner ve CLI okur.
 *
 * core'da duruyor çünkü runner'ın kapısı buna bağlı; discovery'yi
 * core'a çekmemek için.
 */

import type { SiteConfig } from './types.js';

/**
 * Kayıt sayfası başka domaine taşınmış sitenin damgası. Dry-run bunu
 * KALDIRMAZ: taşınma sanılan yer ölü domainin satış pazarı ya da bir
 * platform olabilir ve oradaki form da dry-run'dan geçer. Doğru site
 * olduğunu insan onaylayıp bu damgayı elle siler.
 */
export const MOVE_MARKER = 'TAŞINMA ONAYI BEKLİYOR';

/** Taşınma onayı bekliyor mu? Hiçbir bayrak bunu aşmaz. */
export function awaitsMoveApproval(config: Pick<SiteConfig, 'notes'>): boolean {
  return (config.notes ?? '').includes(MOVE_MARKER);
}
