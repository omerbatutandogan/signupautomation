/**
 * Site config'lerinin zod şeması.
 *
 * Amaç: elle yazılan ~200 JSON'un hatası çalışma zamanında (tarayıcı açıkken,
 * yarım kalmış kayıtla) değil, YÜKLEME ANINDA patlasın. Her adım tipinin
 * kendi gerekli alanları var — discriminated union bunu zorluyor.
 */

import { z } from 'zod';

/** Semantik alan adları — JSON'da literal değer değil bunlar yazılır. */
export const FieldNameSchema = z.enum([
  'email',
  'username',
  'password',
  'companyName',
  'website',
  'tagline',
  'description',
  'category',
  'firstName',
  'lastName',
  'fullName',
  'role',
  'contactEmail',
  'twitter',
  'linkedin',
  'github',
  'pricing',
  'foundedYear',
  'terms',
]);

/** Her adımda bulunabilen ortak alanlar. */
const common = {
  /** Bulunamazsa adım atlanır, hata fırlatılmaz. */
  optional: z.boolean().optional(),
  timeoutMs: z.number().int().positive().optional(),
  /** Koşul sağlanmazsa adım atlanır. */
  when: z
    .object({
      urlContains: z.string().optional(),
      visible: z.string().optional(),
    })
    .optional(),
};

/**
 * fill/select: değer ya profilden (field) ya da sabit (value) gelir.
 * İkisi de yoksa adım anlamsız — refine ile yakalanıyor.
 */
const valueSource = {
  field: FieldNameSchema.optional(),
  value: z.string().optional(),
};

/**
 * zod'un discriminatedUnion'ı .refine() uygulanmış şemaları kabul etmiyor
 * (refine ZodEffects döndürüyor, union düz ZodObject istiyor). Bu yüzden
 * fill/select'in "field veya value verilmeli" kuralı union'ın DIŞINDA,
 * birleşik şema üzerinde uygulanıyor (StepSchema'nın sonundaki superRefine).
 */
const StepUnion = z.discriminatedUnion('type', [
  z.object({ type: z.literal('goto'), url: z.string().min(1), ...common }),

  z.object({ type: z.literal('fill'), selector: z.string().min(1), ...valueSource, ...common }),

  z.object({ type: z.literal('select'), selector: z.string().min(1), ...valueSource, ...common }),

  z.object({ type: z.literal('check'), selector: z.string().min(1), ...common }),
  z.object({ type: z.literal('click'), selector: z.string().min(1), ...common }),

  /** Çerez banner'ı gibi opsiyonel kapatmalar — ilk tutan selector kullanılır. */
  z.object({ type: z.literal('dismiss'), selectors: z.array(z.string().min(1)).min(1), ...common }),

  z.object({
    type: z.literal('upload'),
    selector: z.string().min(1),
    /** profile/assets altındaki dosya yolu. */
    file: z.string().min(1),
    ...common,
  }),

  z.object({ type: z.literal('waitFor'), selector: z.string().min(1), ...common }),

  /** Sayfada bunlardan HERHANGİ biri görünmeli. */
  z.object({ type: z.literal('expect'), anyOf: z.array(z.string().min(1)).min(1), ...common }),

  /** Captcha tespiti + gerekiyorsa insan devralması. */
  z.object({ type: z.literal('captchaGate'), ...common }),

  z.object({
    type: z.literal('humanPause'),
    minMs: z.number().int().nonnegative().optional(),
    maxMs: z.number().int().positive().optional(),
    ...common,
  }),

  /** Faz 1'de şemada var ama uygulanmıyor — override'lar için ayrılmış. */
  z.object({ type: z.literal('custom'), handler: z.string().min(1), ...common }),
]);

/**
 * Union + union-üstü kurallar. fill/select değerini ya profilden (field)
 * ya da sabit metinden (value) alır; ikisi de yoksa adım anlamsızdır.
 */
export const StepSchema = StepUnion.superRefine((step, ctx) => {
  // Yükleme yalnızca src/profile/ altından: `../../.env` gibi yollarla başka dosya sızdırılamaz.
  if (step.type === 'upload' && (step.file.startsWith('/') || step.file.includes('\\') || step.file.split('/').includes('..'))) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['file'], message: 'upload dosyası src/profile/ altında göreli bir yol olmalı (/, \\ ve .. yok)' });
  }
  if (step.type === 'fill' || step.type === 'select') {
    if (step.field === undefined && step.value === undefined) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: `${step.type} adımında field veya value verilmeli`,
      });
    }
  }
});

export const VerificationSpecSchema = z.object({
  /** 'none' → site e-postayı otomatik doğruluyor (StackShare'de görüldü). */
  mode: z.enum(['link', 'code', 'none']),
  /**
   * mode:'none' iken hesap DOĞRULANMAMIŞ kalıyorsa true.
   *
   * İki durumu ayırır: 10words doğrulama istemiyor (hesap tam yetkili),
   * alternative.me istiyor ama maili hiç göndermiyor (hesap "Pending
   * User" kalıyor). İkisine de "doğrulama gerekmiyor" yazmak Sheet'i
   * okuyan için yanıltıcı.
   */
  unverifiedAccount: z.boolean().optional(),
  from: z.string().optional(),
  subjectContains: z.array(z.string()).optional(),
  /** Verilirse generic skorlama yerine bu regex kullanılır — daha deterministik. */
  linkPattern: z.string().optional(),
  codeSelector: z.string().optional(),
  codeSubmitSelector: z.string().optional(),
  timeoutMs: z.number().int().positive().optional(),
});

export const SiteConfigSchema = z
  .object({
    id: z.string().min(1).regex(/^[a-z0-9-]+$/, 'id yalnızca küçük harf, rakam ve tire içerebilir'),
    name: z.string().min(1),
    risk: z.enum(['low', 'medium', 'high']),
    signupUrl: z.string().url(),
    /** Tek e-posta mimarisinde kullanılmıyor ama config şemasında tutuluyor. */
    emailLocalPart: z.string().optional(),
    /** 'plain': kullanıcı adı yalnızca harf+rakam (alt çizgi yok). Varsayılan: `geonew_<site>`. */
    usernameStyle: z.enum(['default', 'plain']).optional(),
    steps: z.array(StepSchema).min(1, 'en az bir adım gerekli'),
    verification: VerificationSpecSchema,
    success: z
      .object({
        afterVerifyUrlContains: z.array(z.string()).optional(),
        anyOf: z.array(z.string()).optional(),
      })
      .optional(),
    passwordPolicy: z
      .object({
        maxLen: z.number().int().positive().optional(),
        noSymbols: z.boolean().optional(),
        allowedSymbols: z.string().optional(),
      })
      .optional(),
    /** Varsayılan kapalı — yalnızca trivial navigator.webdriver kontrolü yapan siteler. */
    stealth: z.boolean().optional(),
    /** 2captcha ile otomatik çözüm. Varsayılan kapalı — ToS riski. */
    solveCaptcha: z.boolean().optional(),
    notes: z.string().optional(),
  })
  .superRefine((cfg, ctx) => {
    // 'code' modunda kodu nereye yazacağımızı bilmemiz gerekiyor.
    if (cfg.verification.mode === 'code' && !cfg.verification.codeSelector) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['verification', 'codeSelector'],
        message: "mode:'code' için codeSelector zorunlu",
      });
    }
  });

export type ValidatedStep = z.infer<typeof StepSchema>;
export type ValidatedSiteConfig = z.infer<typeof SiteConfigSchema>;

/** JSON'u doğrular; hata mesajını okunur hale getirir. */
export function parseSiteConfig(raw: unknown, source: string): ValidatedSiteConfig {
  const result = SiteConfigSchema.safeParse(raw);
  if (result.success) return result.data;

  const lines = result.error.issues.map((i) => `  - ${i.path.join('.') || '(kök)'}: ${i.message}`);
  throw new Error(`Geçersiz site config (${source}):\n${lines.join('\n')}`);
}
