/**
 * Bir site listesini sırayla gerçek kayda çevirirken kullanılan saf kurallar (scripts/run-list.ts).
 *
 * Neden ayrı: dry-run submit etmediği için kayıt SONRASI beklentileri (başarı sayfası, doğrulama türü)
 * hiç denemez; ilk gerçek koşularda config bozukluğu beklenir. Bu yüzden art arda hata gelince DURULUR
 * ve siteler arası bekleme bot gibi görünmemek için rastgele tutulur.
 */

export type ListOutcome = 'completed' | 'skipped' | 'failed';

/** `run-one` durum metnini (completed, skipped_*, failed, manual, error, ...) üçe indirger. */
export function classifyStatus(status: string): ListOutcome {
  if (status === 'completed') return 'completed';
  if (status.startsWith('skipped')) return 'skipped';
  return 'failed';
}

/**
 * Son `max` sonucun HEPSİ başarısızsa dur. Atlananlar (skipped) ne sayılır ne de seriyi böler.
 * Varsayılan 6: siteler birbirinden bağımsız ve her başarısızlık çoğunlukla farklı bir site sorunu (captcha,
 * iş e-postası şartı, çok adımlı form). 3'te durmak 12 sitelik bir turu 4. sitede kesiyordu; sistem çapında bir
 * bozulma (ağ, token, kod hatası) zaten arka arkaya birkaç başarısızlık olarak da görünür.
 */
export function shouldStop(history: readonly ListOutcome[], max = 6): boolean {
  const real = history.filter((h) => h !== 'skipped');
  return real.length >= max && real.slice(-max).every((h) => h === 'failed');
}

/** İki site arası bekleme (sn): [min, max] dakika arasında rastgele. */
export function gapSeconds(minMinutes: number, maxMinutes: number, random: () => number = Math.random): number {
  const lo = Math.min(minMinutes, maxMinutes) * 60;
  const hi = Math.max(minMinutes, maxMinutes) * 60;
  return Math.round(lo + random() * (hi - lo));
}

/** `run-one` çıktısından (ANSI temizlenmiş) durum metnini çıkarır: "❌ geo-new@x: failed". */
export function parseRunOneStatus(output: string): string | null {
  const clean = output.replace(/\u001b\[[0-9;]*m/g, '');
  const match = /^(?:✅|⏭️|❌)\s+\S+:\s+(\w+)/m.exec(clean);
  return match?.[1] ?? null;
}
