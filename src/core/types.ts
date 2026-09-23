/**
 * Projenin merkezi sözleşmesi. Diğer her modül bu tiplere karşı yazılır.
 */

import type { Locator, Page } from 'playwright';
import type { Logger } from 'pino';

export type SiteId = string;

/** Otomasyon risk seviyesi. 'high' olanlar ToS gereği hiç denenmez (§9). */
export type RiskLevel = 'low' | 'medium' | 'high';

export type CaptchaKind =
  | 'recaptcha_v2'
  | 'recaptcha_v3'
  | 'hcaptcha'
  | 'turnstile'
  | 'unknown_challenge';

/** Sheet'teki Durum kolonunun kapalı değer kümesi. */
export const STATUS = {
  PENDING: 'Bekliyor',
  IN_PROGRESS: 'İşleniyor',
  AWAITING_EMAIL: 'E-posta Bekleniyor',
  DONE: 'Tamamlandı',
  ERROR: 'Hata',
  FAILED: 'Başarısız',
  MANUAL: 'Manuel Gerekli',
  EMAIL_TIMEOUT: 'Doğrulama Zaman Aşımı',
} as const;

export type Status = (typeof STATUS)[keyof typeof STATUS];

/** Yeni çalıştırmaya uygun durumlar. Terminal durumlar buraya dahil değil. */
export const ELIGIBLE_STATUSES: readonly Status[] = [STATUS.PENDING, STATUS.ERROR];

/** Bir daha asla otomatik denenmeyecek durumlar. */
export const TERMINAL_STATUSES: readonly Status[] = [
  STATUS.DONE,
  STATUS.FAILED,
  STATUS.MANUAL,
];

// ── Profil ────────────────────────────────────────────────────────────────

export interface SignupProfile {
  companyName: string;
  legalName: string;
  website: string;
  /** ~45 karakter — maxlength çok darsa açıklama yerine bu kullanılır. */
  tagline: string;
  descriptions: {
    short: string; // ~50
    medium: string; // ~150
    long: string; // ~500
  };
  category: { primary: string; aliases: string[] };
  logo: Record<string, string>;
  contact: {
    firstName: string;
    lastName: string;
    role: string;
    email: string;
  };
  socials: Partial<Record<'twitter' | 'linkedin' | 'github', string>>;
  pricing: string;
  foundedYear: number;
}

/** Form alanlarının semantik adları — JSON config'de literal selector değil bunlar yazılır. */
export type FieldName =
  | 'email'
  | 'username'
  | 'password'
  | 'companyName'
  | 'website'
  | 'tagline'
  | 'description'
  | 'category'
  | 'firstName'
  | 'lastName'
  | 'fullName'
  | 'role'
  | 'contactEmail'
  | 'twitter'
  | 'linkedin'
  | 'github'
  | 'pricing'
  | 'foundedYear'
  | 'terms';

// ── Doğrulama ─────────────────────────────────────────────────────────────

export interface VerificationSpec {
  /** 'link' → maildeki linke tıkla. 'code' → kodu forma gir. 'none' → doğrulama yok. */
  mode: 'link' | 'code' | 'none';
  /**
   * mode:'none' iken hesap DOĞRULANMAMIŞ kalıyorsa true.
   *
   * 10words doğrulama istemiyor (hesap tam yetkili); alternative.me
   * istiyor ama maili hiç göndermiyor (hesap "Pending User" kalıyor).
   * İkisine de "doğrulama gerekmiyor" yazmak yanıltıcı.
   */
  unverifiedAccount?: boolean;
  from?: string;
  subjectContains?: string[];
  /** Verilirse link çıkarmada generic skorlama yerine bu regex kullanılır. */
  linkPattern?: string;
  /** 'code' modunda kodun gireceği alanın selector'ı. */
  codeSelector?: string;
  timeoutMs?: number;
}

export type VerificationResult =
  | { kind: 'link'; url: string; messageId: string }
  | { kind: 'code'; code: string; messageId: string };

// ── Adaptör ───────────────────────────────────────────────────────────────

export interface SignupIdentity {
  email: string;
  username: string;
  password: string;
  passwordVersion: number;
}

export interface Artifacts {
  shot(name: string): Promise<string>;
  html(name: string): Promise<string>;
  dir: string;
}

export interface SignupContext {
  page: Page;
  site: SiteConfig;
  identity: SignupIdentity;
  profile: SignupProfile;
  log: Logger;
  artifacts: Artifacts;
  /** true ise submit adımları atlanır — selector doğrulama için. */
  dryRun: boolean;
  /**
   * Captcha çözülene kadar bloklar. İnsan headed tarayıcıda devralır;
   * Telegram bildirimi gider, DOM izleyici otomatik çözülmeyi de yakalar.
   */
  requestHumanCaptcha(kind: CaptchaKind, screenshotPath: string): Promise<void>;
}

export type SignupResult =
  | { status: 'submitted'; needsEmailVerification: boolean }
  | { status: 'already_exists' };

export interface SiteAdapter {
  id: SiteId;
  name: string;
  risk: RiskLevel;
  emailLocalPart: string;
  verification: VerificationSpec;

  /** Formu doldurup gönderir. Transient/Permanent/CaptchaRequired fırlatabilir. */
  signup(ctx: SignupContext): Promise<SignupResult>;

  /** Doğrulama linkinden sonra ikinci bir form gerekiyorsa. */
  postVerify?(ctx: SignupContext): Promise<void>;

  /** Hesabın gerçekten açıldığını doğrular. */
  confirmSuccess?(ctx: SignupContext): Promise<boolean>;
}

// ── Declarative adım sözlüğü ──────────────────────────────────────────────

/** Adım tipleri kapalı küme — schema.ts bunu zod ile doğrular. */
export type StepType =
  | 'goto'
  | 'fill'
  | 'select'
  | 'check'
  | 'click'
  | 'dismiss'
  | 'upload'
  | 'waitFor'
  | 'expect'
  | 'captchaGate'
  | 'humanPause'
  | 'custom';

export interface StepBase {
  type: StepType;
  /** Bulunamazsa adım atlanır, hata fırlatılmaz. */
  optional?: boolean;
  timeoutMs?: number;
  /** Koşul sağlanmazsa adım atlanır. */
  when?: { urlContains?: string; visible?: string };
}

export interface SiteConfig {
  id: SiteId;
  name: string;
  risk: RiskLevel;
  signupUrl: string;
  emailLocalPart: string;
  steps: Step[];
  verification: VerificationSpec;
  success?: { afterVerifyUrlContains?: string[]; anyOf?: string[] };
  passwordPolicy?: {
    maxLen?: number;
    noSymbols?: boolean;
    allowedSymbols?: string;
  };
  /** Varsayılan kapalı. Yalnızca trivial navigator.webdriver kontrolü yapan siteler için. */
  stealth?: boolean;
  /**
   * 2captcha ile otomatik captcha çözümü. VARSAYILAN KAPALI.
   * Bazı dizinlerin ToS'u captcha bypass'ını yasaklıyor; her açma
   * bilinçli bir karar olmalı. risk:"high" sitelerde zaten çalışmaz.
   */
  solveCaptcha?: boolean;
  notes?: string;
}

// Step tipleri schema.ts'te zod ile tanımlanıp buradan türetiliyor;
// döngüsel bağımlılığı önlemek için burada yapısal olarak bildiriliyor.
export interface Step extends StepBase {
  selector?: string;
  selectors?: string[];
  field?: FieldName;
  value?: string;
  url?: string;
  anyOf?: string[];
  file?: string;
  minMs?: number;
  maxMs?: number;
  handler?: string;
}

/** Bir çalıştırmanın terminal sonucu. */
export type TerminalStatus =
  | 'completed'
  | 'failed'
  | 'error'
  | 'manual'
  | 'email_timeout'
  | 'skipped_locked'
  | 'skipped_limit'
  | 'skipped_terminal'
  | 'skipped_high_risk';

/** pickDescription'ın maxlength okuyamadığı durumlar için yardımcı tip. */
export interface DescriptionTarget {
  locator: Locator;
  maxLength: number | null;
}
