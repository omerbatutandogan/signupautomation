/**
 * Listeleme (submission) config'i — hesap açıldıktan SONRA ürünü sitenin kendi
 * "siteni ekle / ürününü gönder" formuna girmek için.
 *
 * Kayıt config'inden (src/sites) AYRI dosya (src/submissions/<id>.json): kayıt ve
 * listeleme farklı hayat döngüleri, farklı riskler taşıyor. Kayıt hesap açar;
 * listeleme ürünü HERKESE AÇIK yayınlar ve geri alınması zordur.
 *
 * Adımlar kayıt config'iyle aynı sözlüğü kullanır (fill/select/check/click/upload/
 * expect/...), aynı yürütücüde çalışır.
 */

import { z } from 'zod';
import { StepSchema } from './schema.js';

export const SubmissionConfigSchema = z
  .object({
  id: z.string().min(1).regex(/^[a-z0-9-]+$/, 'id yalnızca küçük harf, rakam ve tire içerebilir'),
  name: z.string().min(1),
  /** Listeleme formunun adresi (giriş yapılmış hesapla açılır). */
  listingUrl: z.string().url(),
  /**
   * Giriş yapılmışken görünen seçici (çıkış bağlantısı gibi). Verilirse ve görünürse
   * giriş atlanır; verilmezse `login` her çalıştırmada uygulanır.
   */
  loggedIn: z.string().min(1).optional(),
  /** Giriş adımları. İlk adım genelde `{type:'goto', url:'{{signupUrl}}'}` (signupUrl = login.url). */
  login: z
    .object({
      url: z.string().url(),
      steps: z.array(StepSchema).min(1),
    })
    .optional(),
  steps: z.array(StepSchema).min(1, 'en az bir adım gerekli'),
  /**
   * Gönderimin BAŞARILI olduğunu gösteren işaret: bunlardan biri görünmeli ya da adres
   * bunlardan birini içermeli. ZORUNLU: "tıkladım, oldu sandım" ile gerçek yayın aynı
   * şey değildir.
   */
  success: z
    .object({
      anyOf: z.array(z.string().min(1)).optional(),
      urlContains: z.array(z.string().min(1)).optional(),
    })
    .refine((s) => (s.anyOf?.length ?? 0) + (s.urlContains?.length ?? 0) > 0, {
      message: 'success.anyOf ya da success.urlContains verilmeli',
    }),
  notes: z.string().optional(),
  })
  .superRefine((cfg, ctx) => {
    // Giriş tanımlıysa "giriş yapıldı mı?" işareti ZORUNLU: yanlış şifre ya da engelli hesap
    // sessizce giriş yapılmamış formu doldurmaya yol açmasın.
    if (cfg.login && !cfg.loggedIn) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['loggedIn'], message: 'login tanımlıysa loggedIn (giriş işareti) zorunlu' });
    }
    if (cfg.login && cfg.login.url === cfg.listingUrl) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['login', 'url'], message: 'login.url, listingUrl ile aynı olamaz (dry-run girişi ile gönderim ayrılamaz)' });
    }
    // Zaten adreste bulunan bir parça "başarı" kanıtı olamaz: gönderim yapılmadan da tutar.
    for (const fragment of cfg.success.urlContains ?? []) {
      if (cfg.listingUrl.includes(fragment)) {
        ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['success', 'urlContains'], message: `"${fragment}" listingUrl içinde zaten var: başarı kanıtı olamaz` });
      }
    }
  });

export type ValidatedSubmissionConfig = z.infer<typeof SubmissionConfigSchema>;

export function parseSubmissionConfig(raw: unknown, source: string): ValidatedSubmissionConfig {
  const result = SubmissionConfigSchema.safeParse(raw);
  if (result.success) return result.data;
  const lines = result.error.issues.map((i) => `  - ${i.path.join('.') || '(kök)'}: ${i.message}`);
  throw new Error(`Geçersiz listeleme config (${source}):\n${lines.join('\n')}`);
}
