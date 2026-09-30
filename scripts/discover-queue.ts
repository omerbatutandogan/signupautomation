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
  | 'submit_form'
  | 'email_first'
  | 'error'
  | 'skipped_existing';

/**
 * Yeniden taranabilir sonuçlar.
 *
 * `generated` ve `high_risk` ASLA yeniden taranmaz: ilki doğrulanmış iş,
 * ikincisi ToS kararı. `bot_protected` de sitenin kalıcı özelliği.
 * Aracın yanılmış olabileceği ya da henüz desteklemediği sonuçlar
 * (`submit_form`, `email_first`: destek gelince yeniden taranır)
 * yeniden kuyruğa girer.
 */
export const RETRYABLE: ReadonlySet<Outcome> = new Set<Outcome>([
  'no_form',
  'submit_form',
  'email_first',
  'error',
]);

/** Keşifte tek bir denemenin (headless ya da headed) üst süresi. */
export const SITE_TIMEOUT_MS = 4 * 60_000;

export class SiteTimeoutError extends Error {}

/**
 * İşi süre sınırıyla çalıştırır; aşılırsa sayfayı kapatıp
 * SiteTimeoutError fırlatır.
 *
 * Gerçek vaka: financesonline.com bilinmeyen yollara yanıt vermiyor,
 * headed denemesi 15 dakikayı aştı. Sayfayı kapatmak bekleyen Playwright
 * çağrısını da sonlandırıyor; o çağrının geç gelen reddi race tarafından
 * tüketildiği için "unhandled rejection" olmuyor.
 */
export async function withSiteTimeout<T>(
  work: Promise<T>,
  closePage: () => Promise<void>,
  ms: number = SITE_TIMEOUT_MS,
): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      // Önce red, sonra kapatma: kapatma bekleyen işi "Target closed" ile
      // reddeder ve o red önce gelirse yarışı o kazanırdı.
      reject(new SiteTimeoutError(`Site ${Math.round(ms / 1000)}sn içinde yanıt vermedi`));
      void closePage().catch(() => undefined);
    }, ms);
  });
  try {
    return await Promise.race([work, timeout]);
  } finally {
    clearTimeout(timer);
  }
}

/** Form bulunamadı ama sitede başka bir akış var — Sheet notu. */
export const HINT_REASON = {
  submit_form: 'Hesapsız gönderim formu var (sitenizi gönderin) — ürün bilgisiyle elle/ayrı akışla',
  email_first: 'E-postayla başlayan giriş (kod/link ya da 2. adımda şifre) — henüz desteklenmiyor',
} as const;

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
