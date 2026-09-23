/**
 * Form analizi — alanları okur ve semantik adlara eşler.
 *
 * inspect-form.ts bu mantığı tek site için script içinde tutuyordu;
 * toplu keşif için yeniden kullanılabilir hale getirildi.
 */

import type { Page } from 'playwright';
import type { CaptchaKind, FieldName } from '../core/types.js';

export interface FormField {
  tag: string;
  type: string;
  name: string;
  id: string;
  placeholder: string;
  ariaLabel: string;
  maxLength: number | null;
  required: boolean;
  /** Playwright selector önerisi — kararlılık sırasına göre seçilir. */
  selector: string;
  /** Eşleşen semantik alan; null ise config'de TODO olarak işaretlenir. */
  field: FieldName | null;
}

export interface FormAnalysis {
  url: string;
  fields: FormField[];
  submitSelector: string | null;
  captcha: CaptchaKind | null;
  /** Çerez banner'ı gibi kapatılması gereken öğeler. */
  dismissSelectors: string[];
  /**
   * Görünmez AMA zorunlu alanların selector'ları.
   *
   * Özel stillenmiş kutucuklar (şartlar onayı gibi) `vis:false` görünür
   * ama form onlarsız reddedilir. Awwwards'ta tam bu oldu: keşif alanı
   * attı, kayıt "This value should be true" ile başarısız oldu ve sorun
   * ancak artifact'tan anlaşıldı. Config yazan kişi bunlara
   * `label[for=...]` tıklaması eklemeli.
   */
  hiddenRequired: string[];
}

/** Ham alan bilgisi — tarayıcı içinde toplanıyor, Node tarafında eşleniyor. */
interface RawField {
  tag: string;
  type: string;
  name: string;
  id: string;
  placeholder: string;
  ariaLabel: string;
  maxLength: number;
  required: boolean;
  visible: boolean;
  text: string;
}

/**
 * Alanı semantik ada eşler.
 *
 * Sıra önemli: type=email gibi kesin işaretler önce, isim/placeholder
 * tahminleri sonra. Eşleşmeyen alan null döner — uydurmaktansa TODO
 * bırakmak daha güvenli.
 */
export function mapField(f: RawField): FieldName | null {
  /**
   * Yapısal ipuçları (name/id) metinsel olanlardan (placeholder/aria-label)
   * ÖNCE değerlendirilir. Gerçek vaka: 360Quadrants'ta isim alanının
   * aria-label'ı yanlışlıkla "Business Email" yazıyor — metne güvenmek
   * ismi e-posta alanı sanmaya yol açıyordu.
   */
  const structural = `${f.name} ${f.id}`.toLowerCase();
  const textual = `${f.placeholder} ${f.ariaLabel}`.toLowerCase();
  const hint = `${structural} ${textual}`;

  if (f.type === 'email') return 'email';
  if (f.type === 'password') return 'password';

  // Checkbox kontrolü isim tabanlı kurallardan ÖNCE gelmeli: aksi halde
  // "marketing_emails" kutucuğu e-posta ALANI sanılıp doldurulmaya
  // çalışılıyor. Testle yakalandı.
  if (f.type === 'checkbox') {
    if (/terms|agree|accept|tos|policy/.test(hint)) return 'terms';
    return null; // bülten/pazarlama kutucukları ASLA işaretlenmez
  }

  // İsim alanları önce: "first_name" gibi yapısal isimler kesin, ve bu
  // alanların etiketi yanlış olabiliyor (360Quadrants: aria-label
  // "Business Email" ama alan aslında isim).
  // fullname önce: "fullname" içinde "lname" geçtiği için lastName
  // kuralına takılıyordu (fu-llname). Gerçek vaka: alternative.me.
  if (/full[_-]?name|display[_-]?name/.test(structural)) return 'fullName';
  // \b kelime sınırı: "fname"/"lname" ayrı bir sözcük olmalı, başka
  // kelimenin içinde gizlenmiş olmamalı.
  if (/first[_-]?name|\bfname\b|given[_-]?name/.test(structural)) return 'firstName';
  if (/last[_-]?name|\blname\b|surname|family[_-]?name/.test(structural)) return 'lastName';

  // type="text" olan e-posta alanları yaygın (360Quadrants'ta
  // user_data[email] böyleydi). type'a güvenip ismi kaçırmak, kaydı
  // e-postasız bırakıyordu. Yapısal ipucu önce, sonra metinsel.
  if (/e-?mail/.test(structural)) return 'email';
  if (/password|passwd|pwd/.test(structural)) return 'password';
  if (/e-?mail/.test(textual)) return 'email';
  if (/password|passwd|pwd/.test(textual)) return 'password';

  if (f.tag === 'textarea') return 'description';

  if (f.type === 'url' || /website|url|site|link/.test(hint)) return 'website';

  if (/user\s*name|username|nick|handle|login/.test(hint)) return 'username';
  if (/first\s*name|fname|given/.test(hint)) return 'firstName';
  if (/last\s*name|lname|surname|family/.test(hint)) return 'lastName';
  if (/full\s*name|your\s*name|^name$/.test(hint)) return 'fullName';
  if (/company|organization|startup|product|project|tool|app/.test(hint)) return 'companyName';
  if (/tagline|slogan|headline|short\s*desc|one\s*line/.test(hint)) return 'tagline';
  if (/descri|about|summary|bio|pitch/.test(hint)) return 'description';
  if (/categor|topic|industry|tag/.test(hint)) return 'category';
  if (/twitter|x\.com/.test(hint)) return 'twitter';
  if (/linkedin/.test(hint)) return 'linkedin';
  if (/github/.test(hint)) return 'github';
  if (/role|title|position|job/.test(hint)) return 'role';

  // Telefon alanı bilinçli olarak eşlenmiyor: SMS doğrulama kapsam dışı
  // (planın "Kapsam Dışı" maddesi). Zorunluysa TODO olarak raporlanıp
  // insan incelemesine düşer.
  if (/phone|mobile|tel\b|contact\s*number/.test(hint)) return null;

  // type=text ve hiçbir ipucu yok — çoğu sitede bu username oluyor ama
  // tahmin etmek yerine TODO bırakıyoruz.
  return null;
}

/** En kararlı selector'ı seçer: id > name > type > aria-label. */
function suggestSelector(f: RawField): string {
  if (f.id) return `#${f.id}`;
  if (f.name) return `${f.tag}[name='${f.name}']`;
  if (f.tag === 'input' && f.type) return `input[type='${f.type}']`;
  if (f.ariaLabel) return `${f.tag}[aria-label='${f.ariaLabel}']`;
  return f.tag;
}

/** Çerez/popup kapatma adayları — hepsi optional olarak config'e girer. */
const DISMISS_CANDIDATES = [
  '#onetrust-accept-btn-handler',
  "button:has-text('Accept all')",
  "button:has-text('Accept')",
  "button:has-text('I agree')",
  "button:has-text('Got it')",
  "[aria-label='Accept cookies']",
  '.cookie-accept',
];

export async function analyzeForm(page: Page): Promise<FormAnalysis> {
  const raw = await page.evaluate((): RawField[] => {
    const nodes = Array.from(
      document.querySelectorAll('input, textarea, select, button'),
    );
    return nodes.map((el) => {
      const input = el as HTMLInputElement;
      const rect = el.getBoundingClientRect();
      return {
        tag: el.tagName.toLowerCase(),
        type: input.type ?? '',
        name: input.name ?? '',
        id: el.id ?? '',
        placeholder: input.placeholder ?? '',
        ariaLabel: el.getAttribute('aria-label') ?? '',
        maxLength: input.maxLength ?? -1,
        required: input.required ?? false,
        visible: rect.width > 0 && rect.height > 0,
        text: (el.textContent ?? '').trim().slice(0, 40),
      };
    });
  });

  const visible = raw.filter((f) => f.visible);

  // Arama kutuları form alanı değil — eler.
  const inputs = visible.filter(
    (f) =>
      f.tag !== 'button' &&
      f.type !== 'submit' &&
      f.type !== 'hidden' &&
      f.type !== 'search' &&
      !/search|query|^q$/i.test(`${f.name} ${f.id} ${f.placeholder}`),
  );

  const fields: FormField[] = inputs.map((f) => ({
    tag: f.tag,
    type: f.type,
    name: f.name,
    id: f.id,
    placeholder: f.placeholder,
    ariaLabel: f.ariaLabel,
    maxLength: f.maxLength > 0 ? f.maxLength : null,
    required: f.required,
    selector: suggestSelector(f),
    field: mapField(f),
  }));

  // Görünmez AMA zorunlu alanlar: özel stillenmiş kutucuklar böyle.
  // Awwwards'ın şartlar onayı tam bu durumdaydı (vis:false, required) —
  // keşif onu atıyordu ve form "This value should be true" ile
  // reddediliyordu. Atmak yerine RAPORLA: config yazan kişi
  // label[for=...] tıklaması eklemeli.
  const hiddenRequired = raw
    .filter((f) => !f.visible && f.required && f.type !== 'hidden')
    .map((f) => suggestSelector(f));

  const submitSelector = pickSubmit(visible);
  const captcha = await detectCaptchaOnPage(page);
  const dismissSelectors = await findDismissable(page);

  return {
    url: page.url(),
    fields,
    submitSelector,
    captcha,
    dismissSelectors,
    hiddenRequired,
  };
}

/** Gönder butonunu seçer — metni kayıt anlamı taşıyan tercih edilir. */
function pickSubmit(visible: RawField[]): string | null {
  const buttons = visible.filter((f) => f.tag === 'button' || f.type === 'submit');
  if (buttons.length === 0) return null;

  const signupText = /sign\s*up|register|create\s*account|join|submit|continue|get\s*started/i;
  const best = buttons.find((b) => signupText.test(b.text)) ?? buttons[0];
  if (!best) return null;

  if (best.text && signupText.test(best.text)) {
    return `button:has-text('${best.text.replace(/'/g, "\\'")}')`;
  }
  if (best.id) return `#${best.id}`;
  return "button[type='submit']";
}

/** Sayfadaki captcha tipini tespit eder (core/captcha.ts ile aynı imzalar). */
async function detectCaptchaOnPage(page: Page): Promise<CaptchaKind | null> {
  return page.evaluate((): CaptchaKind | null => {
    if (document.querySelector('iframe[src*="hcaptcha"], .h-captcha')) return 'hcaptcha';
    if (document.querySelector('iframe[src*="challenges.cloudflare"], .cf-turnstile')) {
      return 'turnstile';
    }
    if (document.querySelector('iframe[src*="recaptcha/api2"], .g-recaptcha')) return 'recaptcha_v2';
    if (document.querySelector('script[src*="recaptcha/api.js?render="]')) return 'recaptcha_v3';
    return null;
  });
}

/** Sayfada gerçekten var olan kapatma butonlarını döner. */
async function findDismissable(page: Page): Promise<string[]> {
  const found: string[] = [];
  for (const selector of DISMISS_CANDIDATES) {
    const visible = await page
      .locator(selector)
      .first()
      .isVisible()
      .catch(() => false);
    if (visible) found.push(selector);
  }
  return found;
}
