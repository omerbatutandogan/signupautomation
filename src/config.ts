/**
 * Ortam değişkeni yükleme ve doğrulama.
 *
 * Eksik bir ayar sessizce undefined kalırsa hata tarayıcıda garip bir yerde
 * patlar — burada durup net söylemek çok daha ucuz.
 */

import { config as loadDotenv } from 'dotenv';
import { z } from 'zod';

loadDotenv();

/** "true"/"1" → true, gerisi false. Boşsa varsayılan. */
const boolish = (def: boolean) =>
  z
    .string()
    .optional()
    .transform((v) => (v === undefined || v === '' ? def : /^(true|1|yes)$/i.test(v)));

const intish = (def: number) =>
  z
    .string()
    .optional()
    .transform((v) => (v === undefined || v === '' ? def : Number(v)))
    .pipe(z.number().int().positive());

const EnvSchema = z.object({
  // Kaybı telafi edilemez — tüm site şifreleri bundan türetiliyor.
  MASTER_SECRET: z.string().min(32, 'MASTER_SECRET en az 32 karakter olmalı (openssl rand -hex 32)'),
  // Tüm sitelerde kullanılan tek sabit adres.
  SIGNUP_EMAIL: z.string().email('SIGNUP_EMAIL geçerli bir e-posta olmalı'),

  GOOGLE_OAUTH_CLIENT_FILE: z.string().default('.auth/gmail-client-secret.json'),
  GOOGLE_OAUTH_TOKEN_FILE: z.string().default('.auth/gmail-token.json'),

  // Sheet opsiyonel: boşsa entegrasyon devre dışı, çalıştırma SQLite ile
  // devam eder. Otorite ledger'da, Sheet yalnızca insan görünürlüğü.
  SHEET_ID: z.string().default(''),
  SHEET_TAB: z.string().default('Sheet1'),

  // Captcha insan devralması gerektirdiği için varsayılan headed.
  HEADLESS: boolish(false),

  DAILY_LIMIT: intish(12),
  // Siteler arası bekleme — insan-benzeri trafik deseni, tek IP'den ani
  // yüksek hacim fraud tespitinde işaretlenmesin.
  MIN_GAP_MINUTES: intish(6),
  MAX_GAP_MINUTES: intish(18),
  EMAIL_TIMEOUT_MS: intish(600_000),
  CAPTCHA_TIMEOUT_MS: intish(900_000),
  LOCK_TTL_MS: intish(2_700_000),

  LOG_LEVEL: z.string().default('info'),
});

export type Env = z.infer<typeof EnvSchema>;

function parseEnv(): Env {
  const result = EnvSchema.safeParse(process.env);
  if (result.success) return result.data;

  const lines = result.error.issues.map((i) => `  - ${i.path.join('.')}: ${i.message}`);
  throw new Error(
    `.env dosyası eksik veya hatalı:\n${lines.join('\n')}\n\n` +
      `Kurulum için: cp .env.example .env  (sonra MASTER_SECRET ve SIGNUP_EMAIL'i doldur)`,
  );
}

export const env: Env = parseEnv();

/** Kayıt için kullanılan sabit e-postanın domaini — Gmail sorgularında işe yarar. */
export const signupEmailDomain = env.SIGNUP_EMAIL.split('@').pop() ?? '';
