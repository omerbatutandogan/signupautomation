/**
 * Hata taksonomisi.
 *
 * Sınıflandırma merkezi: classify(). Bilinmeyen hatalar Permanent'a düşer
 * (fail-closed) — siteleri körlemesine dövmektense durmayı tercih ediyoruz.
 */

import type { CaptchaKind } from './types.js';

export type ErrorClass = 'transient' | 'permanent' | 'captcha' | 'manual';

abstract class SignupError extends Error {
  abstract readonly errorClass: ErrorClass;

  constructor(
    message: string,
    readonly detail?: Record<string, unknown>,
  ) {
    super(message);
    this.name = new.target.name;
  }
}

/** Geçici: ağ hatası, 5xx, timeout. Backoff ile yeniden denenir. */
export class TransientError extends SignupError {
  readonly errorClass = 'transient' as const;
}

/**
 * Kalıcı: sayfa yüklendi ama selector yok, "zaten kayıtlı", 403.
 * Yeniden denenmez — tekrar denemek aynı sonucu verir ve siteyi gereksiz yorar.
 */
export class PermanentError extends SignupError {
  readonly errorClass = 'permanent' as const;
}

/**
 * Captcha tespit edildi. Bu bir HATA DEĞİL — akışı duraklatan bir sinyal.
 * Runner bunu yakalayıp insan devralmasını bekler.
 */
export class CaptchaRequiredError extends SignupError {
  readonly errorClass = 'captcha' as const;

  constructor(
    readonly kind: CaptchaKind,
    readonly screenshotPath?: string,
  ) {
    super(`Captcha insan müdahalesi gerektiriyor: ${kind}`, { kind, screenshotPath });
  }
}

/**
 * İnsan incelemesi gerekli: SMS/kimlik/ödeme istendi, sonuç belirsiz,
 * captcha zaman aşımına uğradı. Asla otomatik yeniden denenmez.
 */
export class ManualReviewError extends SignupError {
  readonly errorClass = 'manual' as const;
}

/** Playwright timeout'larını mesajdan değil, isimden tanı. */
const PLAYWRIGHT_TIMEOUT = /TimeoutError/i;

/** Geçici kabul edilen ağ seviyesi hataları. */
const TRANSIENT_NET = /net::ERR_(CONNECTION|NETWORK|TIMED_OUT|NAME_NOT_RESOLVED|INTERNET_DISCONNECTED|SOCKET)/i;

/** Sayfada "bu e-posta zaten kayıtlı" anlamına gelen kalıplar. */
export const ALREADY_EXISTS_PATTERNS = [
  /already (been )?(registered|taken|in use|exists)/i,
  // "User already exists", "Account already exists" — araya özne girdiği
  // için yukarıdaki desen bunu KAÇIRIYORDU (alternative.me gerçek metni:
  // "User already exists. Please choose a different email.").
  /(user|account|e-?mail|address) already exists/i,
  /e-?mail .{0,20}(already|mevcut|kayıtlı)/i,
  /zaten (kayıtlı|kullanımda|alınmış)/i,
  /bu e-?posta .{0,20}kullanılıyor/i,
];

/** İnsan incelemesi gerektiren, otomasyonun aşamayacağı talepler. */
export const MANUAL_REVIEW_PATTERNS = [
  /phone (number|verification)|sms (code|verification)/i,
  /telefon (numaras[ıi]|do[ğg]rulama)/i,
  /verify your identity|upload .{0,20}(id|passport|document)/i,
  /(credit card|payment method|billing) required/i,
  /invite[- ]only|request an invite|apply for access/i,
];

/**
 * Bilinmeyen bir hatayı sınıflandırır.
 *
 * Bilinmeyen → permanent (fail-closed). Bir hatayı yanlışlıkla geçici sayıp
 * 3 kez yeniden denemek, siteye 3 kat gereksiz yük ve bot sinyali demek.
 */
export function classify(err: unknown): ErrorClass {
  if (err instanceof TransientError) return 'transient';
  if (err instanceof PermanentError) return 'permanent';
  if (err instanceof CaptchaRequiredError) return 'captcha';
  if (err instanceof ManualReviewError) return 'manual';

  if (!(err instanceof Error)) return 'permanent';

  if (PLAYWRIGHT_TIMEOUT.test(err.name) || PLAYWRIGHT_TIMEOUT.test(err.message)) {
    return 'transient';
  }
  if (TRANSIENT_NET.test(err.message)) return 'transient';

  // HTTP durum kodu mesaja gömülmüşse: 5xx ve 429 geçici, gerisi kalıcı.
  const status = /\b(4\d{2}|5\d{2})\b/.exec(err.message);
  if (status?.[1]) {
    const code = Number(status[1]);
    if (code >= 500 || code === 429) return 'transient';
    return 'permanent';
  }

  return 'permanent';
}

/**
 * Bu sınıflandırma "hesap zaten var" mı?
 *
 * İki yerde gerekiyor (expect adımı ve signup sonucu) ve mesaj metnine
 * göre karşılaştırma yapıldığı için tek yerde tutulmalı.
 */
export function isAlreadyExists(err: unknown): boolean {
  return err instanceof PermanentError && /zaten mevcut/i.test(err.message);
}

/** Sayfa metninden bilinen kalıcı/manuel durumları tespit eder. */
export function classifyPageText(text: string): PermanentError | ManualReviewError | null {
  for (const re of MANUAL_REVIEW_PATTERNS) {
    if (re.test(text)) {
      return new ManualReviewError(`Site insan müdahalesi istiyor: ${re.source}`, { pattern: re.source });
    }
  }
  for (const re of ALREADY_EXISTS_PATTERNS) {
    if (re.test(text)) {
      return new PermanentError('Hesap zaten mevcut', { pattern: re.source });
    }
  }
  return null;
}
