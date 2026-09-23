/**
 * Keşif sonucundan SiteConfig taslağı üretir.
 *
 * GÜVENLİK: Üretilen her config "doğrulanmadı" damgası taşır ve run-batch
 * bunları atlar. Doğrulanmamış bir config'le gerçek kayıt denemek, yanlış
 * forma veri göndermek demek — --dry-run ile doğrulanana kadar kullanılmaz.
 */

import { parseSiteConfig } from '../adapters/schema.js';
import type { RiskLevel, SiteConfig, Step } from '../core/types.js';
import type { FormAnalysis } from './analyze-form.js';
import type { SignupCandidate } from './find-signup.js';

/** Bu damgayı taşıyan config'ler run-batch tarafından atlanır. */
export const UNVERIFIED_MARKER = 'OTOMATİK ÜRETİLDİ — doğrulanmadı';

/**
 * Kayıt başarısını gösteren varsayılan desenler.
 *
 * TEK KELİMELİK GENEL DESENLER KULLANILMIYOR. Eskiden 'confirm',
 * 'welcome', 'dashboard', 'thank' vardı ve üç sitede yanlış pozitif
 * verdiler — en kötüsü Awwwards'ta: kayıt BAŞARISIZKEN sayfa başlığındaki
 * "Welcome to the community!" eşleşti, sistem başarı sandı ve 10 dakika
 * boşuna doğrulama maili bekledi.
 *
 * Buradaki her desen, kayıt akışına ÖZGÜ bir ifade içeriyor: doğrulama
 * maili gönderildiğini ya da hesabın oluştuğunu söylüyor. Site farklı bir
 * metin kullanıyorsa expect başarısız olur ve artifact'tan gerçek metin
 * okunup config'e yazılır — sessizce yanlış başarı üretmekten iyidir.
 */
/**
 * Doğrulanmamış taslakta mail bekleme süresi (3 dk).
 *
 * Varsayılan 10 dakika doğrulanmış configler için doğru ama taslakta
 * mode:'link' yalnızca bir TAHMİN. Mail göndermeyen sitede her deneme 10
 * dakika yakıyordu; 10words, alternative ve ontoplist'in üçü de sonunda
 * mode:'none' oldu ve bu süre tamamen boşa gitti.
 */
export const DRAFT_EMAIL_TIMEOUT_MS = 180_000;

export const DEFAULT_EXPECT_PATTERNS: readonly string[] = [
  'text=/check your (e-?mail|inbox)/i',
  'text=/verify your (e-?mail|account)/i',
  'text=/verification (e-?mail|link|message)/i',
  'text=/confirmation (e-?mail|link) (has been )?sent/i',
  'text=/we(\'ve| have) sent you/i',
  'text=/activate your account/i',
  'text=/account (has been )?created/i',
  'text=/registration (successful|complete)/i',
];

/**
 * ToS'unda otomatik erişimi/captcha atlatmayı açıkça yasaklayan siteler.
 * Bunlar en değerli listing'ler — ban kalıcı kayıp demek.
 * Gartner mülkleri (getapp, softwareadvice) Capterra ile aynı ToS'u paylaşıyor.
 */
export const HIGH_RISK_DOMAINS = [
  'g2.com',
  'capterra.com',
  'trustpilot.com',
  'producthunt.com',
  'gartner.com',
  'getapp.com',
  'softwareadvice.com',
];

export function riskFor(website: string): RiskLevel {
  const host = website.replace(/^https?:\/\//i, '').replace(/^www\./i, '').split('/')[0] ?? '';
  return HIGH_RISK_DOMAINS.some((d) => host.endsWith(d)) ? 'high' : 'low';
}

export interface GenerateInput {
  id: string;
  name: string;
  website: string;
  candidate: SignupCandidate;
  analysis: FormAnalysis;
}

export interface GenerateResult {
  config: SiteConfig;
  /** Eşlenemeyen alanlar — insan gözden geçirmeli. */
  unmappedFields: string[];
  warnings: string[];
}

/**
 * Analiz sonucundan adım listesi kurar.
 *
 * Sıra sabit: goto → dismiss → waitFor → fill'ler → captchaGate → click → expect
 * Bu sıra 10words ve AlternativeTo'da doğrulandı.
 */
function buildSteps(input: GenerateInput): { steps: Step[]; unmapped: string[] } {
  const { analysis } = input;
  const steps: Step[] = [{ type: 'goto', url: '{{signupUrl}}' }];
  const unmapped: string[] = [];

  if (analysis.dismissSelectors.length > 0) {
    steps.push({
      type: 'dismiss',
      selectors: analysis.dismissSelectors,
      optional: true,
    });
  }

  // İlk zorunlu alanı bekle — sayfanın gerçekten yüklendiğini garantiler.
  const anchor =
    analysis.fields.find((f) => f.field === 'email') ?? analysis.fields.find((f) => f.field);
  if (anchor) {
    steps.push({ type: 'waitFor', selector: anchor.selector, timeoutMs: 20_000 });
  }

  steps.push({ type: 'humanPause', minMs: 600, maxMs: 1600 });

  // Alanları doldur. Eşlenemeyenler atlanıyor ama raporlanıyor.
  for (const f of analysis.fields) {
    if (!f.field) {
      if (f.required) unmapped.push(`${f.selector} (zorunlu, ${f.type || f.tag})`);
      continue;
    }

    if (f.field === 'terms') {
      steps.push({ type: 'check', selector: f.selector, optional: true });
      continue;
    }

    if (f.tag === 'select') {
      steps.push({ type: 'select', field: f.field, selector: f.selector, optional: true });
      continue;
    }

    steps.push({
      type: 'fill',
      field: f.field,
      selector: f.selector,
      // email/password dışındakiler formda olmayabilir — opsiyonel.
      ...(f.field === 'email' || f.field === 'password' ? {} : { optional: true }),
    });
  }

  // Captcha tespit edildiyse gate ekle; edilmediyse de ekliyoruz çünkü
  // captcha otomatik trafikte görünebiliyor (AlternativeTo'da tam bu oldu:
  // elle kayıtta yoktu, otomasyonda hCaptcha çıktı).
  steps.push({ type: 'captchaGate' });
  steps.push({ type: 'humanPause', minMs: 500, maxMs: 1200 });

  if (analysis.submitSelector) {
    steps.push({ type: 'click', selector: analysis.submitSelector });
  }

  steps.push({
    type: 'expect',
    anyOf: [...DEFAULT_EXPECT_PATTERNS],
    timeoutMs: 25_000,
  });

  return { steps, unmapped };
}

export function generateConfig(input: GenerateInput): GenerateResult {
  const { id, name, website, candidate, analysis } = input;
  const warnings: string[] = [];

  const { steps, unmapped } = buildSteps(input);

  // E-posta alanı olmadan kayıt anlamsız: doğrulama maili gelmez,
  // hesap kimliği oluşmaz. Bu bir uyarı değil, kullanılamaz config işareti.
  const hasEmail = analysis.fields.some((f) => f.field === 'email');
  if (!hasEmail) {
    warnings.push('KULLANILAMAZ: e-posta alanı eşlenemedi — elle düzeltilmeli');
  }

  if (!analysis.submitSelector) {
    warnings.push('Gönder butonu bulunamadı — click adımı eksik');
  }
  if (candidate.confidence === 'low') {
    warnings.push('Düşük güven: şifre alanı yok, bülten formu olabilir');
  }
  if (!analysis.fields.some((f) => f.field === 'password')) {
    // Şifresiz form genelde kayıt değil: bülten, demo talebi, ürün gönderimi.
    // Gerçek vakalar: 1000.tools/signup, akitaapp.com/demo.
    warnings.push('KULLANILAMAZ: şifre alanı yok — kayıt formu olmayabilir (bülten/demo?)');
  }
  if (analysis.captcha) {
    warnings.push(`Captcha tespit edildi: ${analysis.captcha}`);
  }
  if (analysis.hiddenRequired?.length) {
    // Görünmez zorunlu alan = sessiz form reddi. Awwwards'ta şartlar
    // kutucuğu böyleydi; check() çalışmıyor, label[for=...] tıklanmalı.
    warnings.push(
      `GÖRÜNMEZ ZORUNLU ALAN (label[for=...] tıklaması gerekebilir): ${analysis.hiddenRequired.join(', ')}`,
    );
  }

  const notes = [
    UNVERIFIED_MARKER,
    `Keşif: ${candidate.method}, ${candidate.hops} sıçrama, güven: ${candidate.confidence}.`,
    analysis.captcha ? `Captcha: ${analysis.captcha}.` : 'Captcha görülmedi.',
    unmapped.length > 0 ? `TODO eşlenmeyen zorunlu alanlar: ${unmapped.join(', ')}.` : '',
    warnings.length > 0 ? `Uyarılar: ${warnings.join(' | ')}` : '',
  ]
    .filter(Boolean)
    .join(' ');

  const draft = {
    id,
    name,
    risk: riskFor(website),
    signupUrl: candidate.url,
    notes,
    steps,
    // Varsayılan link: mail gelmezse ilk gerçek çalıştırmada none'a çevrilir
    // (10words'te tam bu oldu).
    //
    // Ama BEKLEME KISA: doğrulanmamış taslakta mod yalnızca bir tahmin ve
    // mail göndermeyen sitede tam süre beklemek her denemede 10 dakika
    // yakıyordu (10words, alternative, ontoplist — üçü de sonunda
    // mode:'none' oldu). 3 dakika gelmeyen mail çoğunlukla hiç gelmiyor;
    // config doğrulanınca bu satır kaldırılıp tam süreye dönülür.
    verification: { mode: 'link' as const, timeoutMs: DRAFT_EMAIL_TIMEOUT_MS },
  };

  // Ürettiğimiz taslak kendi şemamızdan geçmeli — geçmezse üretici bozuk.
  const config = parseSiteConfig(draft, `<üretilen:${id}>`) as SiteConfig;

  return { config, unmappedFields: unmapped, warnings };
}

/** Config doğrulanmamış mı? run-batch bu kontrolü kullanıyor. */
export function isUnverified(config: Pick<SiteConfig, 'notes'>): boolean {
  return (config.notes ?? '').includes(UNVERIFIED_MARKER);
}

/**
 * Doğrulama damgasını kaldırır — başarılı --dry-run sonrası çağrılır.
 * Damga kalıcı olsaydı config sonsuza dek atlanırdı.
 */
export function clearUnverifiedMarker(notes: string | undefined): string {
  const date = new Date().toLocaleDateString('tr-TR');
  return (notes ?? '')
    .replace(UNVERIFIED_MARKER, `Doğrulandı (dry-run, ${date})`)
    .trim();
}
