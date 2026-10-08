/**
 * Form analizi — alanları okur ve semantik adlara eşler.
 *
 * inspect-form.ts bu mantığı tek site için script içinde tutuyordu;
 * toplu keşif için yeniden kullanılabilir hale getirildi.
 */

import { idSelector, looksDynamicId } from './selectors.js';
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
  /** Typeahead/autocomplete widget mı — bkz. RawField.isTypeahead. */
  isTypeahead: boolean;
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
  /**
   * Görünmez zorunlu checkbox'lar — otomatik çözüm için id ile birlikte.
   *
   * hiddenRequired yalnızca uyarı metni üretir. Bu liste generateConfig
   * tarafından OKUNUP otomatik `label[for=id]` click adımına çevrilir —
   * Awwwards ve ontoplist'te elle yapılan düzeltmenin otomatiği.
   * id yoksa (nadir) bu listeye girmez, hiddenRequired uyarısı kalır.
   */
  hiddenCheckboxes: Array<{ id: string; selector: string }>;
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
  /**
   * Typeahead/autocomplete widget sinyali.
   *
   * 360quadrants'ta country_name düz metin gibi görünüyordu ama
   * Twitter Typeahead'di (tt-input + tt-hint çifti) — yazmak yetmiyordu,
   * açılan öneriden SEÇİM yapılması gerekiyordu. Tespit edilirse field
   * ataması yapılmaz, notes'a uyarı düşer.
   */
  isTypeahead: boolean;
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

  // Typeahead: düz metin yazmak yetmez, öneri listesinden seçim
  // gerekir. Semantik ad atamak yanıltıcı olur (generic fill adımı
  // yazıp submit eder, sunucu gizli id boş olduğu için reddeder —
  // 360quadrants'ta tam bu oldu). null dönüp notes'ta ayrı uyarılıyor.
  if (f.isTypeahead) return null;

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

  // type="url" KESİN sinyal — isim tabanlı tahminden önce gelmeli.
  // Gerçek vaka: ontoplist'te #sitename (type=text, name'de "site"
  // geçiyor) URL alanı sanıldı ve https://geo.new yazıldı; oysa asıl
  // URL alanı ayrı bir type=url input'tu (#url). "site" kelimesi
  // "sitename"in İÇİNDE geçtiği için eski geniş /site/ deseni ikisini
  // ayırt edemiyordu.
  if (f.type === 'url') return 'website';

  if (/user\s*name|username|nick|handle|login/.test(hint)) return 'username';
  if (/first\s*name|fname|given/.test(hint)) return 'firstName';
  if (/last\s*name|lname|surname|family/.test(hint)) return 'lastName';
  if (/full\s*name|your\s*name|^name$/.test(hint)) return 'fullName';

  // "sitename"/"company name"/"site title" gibi AD alanları website
  // kuralından ÖNCE değerlendirilir — "site" kelimesini içerse bile
  // bunlar URL değil, metin adı bekliyor.
  if (/site[\s_-]*name|company[\s_-]*name|business[\s_-]*name|site[\s_-]*title/.test(hint)) return 'companyName';

  if (/website|\burl\b|\blink\b|\bsite\b/.test(hint)) return 'website';

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

/**
 * En kararlı selector'ı seçer: KARARLI id > name > type > aria-label > (son çare) üretilmiş id.
 *
 * Üretilmiş (dinamik) id yalnızca başka hiçbir ipucu kalmadığında kullanılır: her yüklemede
 * değiştiği için kayıt günü bulunamaz (bkz. selectors.ts). Yine de `tag`'dan iyidir,
 * çünkü sayfada tek alan olabilir.
 */
function suggestSelector(f: RawField): string {
  if (f.id && !looksDynamicId(f.id)) return idSelector(f.id);
  if (f.name) return `${f.tag}[name='${f.name}']`;
  if (f.tag === 'input' && f.type) return `input[type='${f.type}']`;
  if (f.ariaLabel) return `${f.tag}[aria-label='${f.ariaLabel}']`;
  if (f.id) return idSelector(f.id);
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
      const cls = el.className || '';
      const role = el.getAttribute('role') || '';
      const autocomplete = el.getAttribute('aria-autocomplete') || '';
      // Görünürlük eşiği yalnızca boyuta bakıyordu (width/height > 0).
      // Bazı özel checkbox'lar display:none yerine opacity:0 ya da
      // visibility:hidden kullanıyor — bunlar boyut olarak "görünür"
      // ölçülür ama kullanıcı onları göremez/tıklayamaz. Awwwards'takine
      // benzer bir vakayı bu üç CSS yolunun herhangi biriyle kaçırmamak
      // için computed style de kontrol ediliyor.
      const style = window.getComputedStyle(el);
      const cssHidden = style.display === 'none' || style.visibility === 'hidden' || style.opacity === '0';
      return {
        tag: el.tagName.toLowerCase(),
        type: input.type ?? '',
        name: input.name ?? '',
        id: el.id ?? '',
        placeholder: input.placeholder ?? '',
        ariaLabel: el.getAttribute('aria-label') ?? '',
        maxLength: input.maxLength ?? -1,
        required: input.required ?? false,
        visible: rect.width > 0 && rect.height > 0 && !cssHidden,
        text: (el.textContent ?? '').trim().slice(0, 40),
        isTypeahead:
          /tt-input|tt-hint|typeahead|autocomplete-input/.test(cls) ||
          role === 'combobox' ||
          autocomplete === 'list',
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
    isTypeahead: f.isTypeahead,
  }));

  // Görünmez AMA zorunlu alanlar: özel stillenmiş kutucuklar böyle.
  //
  // İKİ ayrı sinyal kabul ediliyor, ikisi de gerçek vakalardan:
  //  (a) HTML required attribute'ü var — sunucu/tarayıcı doğrulaması.
  //  (b) Görünmez bir checkbox, adı terms/agree/accept/tos/policy
  //      içeriyor — Awwwards vakası TAM BÖYLEYDİ: required=FALSE
  //      (form kütüphanesi zorunluluğu JS ile doğruluyordu, HTML
  //      attribute'ü hiç yoktu) ve keşif bu yüzden onu TAMAMEN
  //      kaçırıyordu — ne fields'e ne hiddenRequired'a giriyordu. Sorun
  //      ancak submit sonrası "This value should be true" hatasından
  //      elle anlaşılmıştı. Şartlar kutucukları neredeyse hiçbir zaman
  //      HTML required taşımaz ama fiilen zorunludur; isim eşleşmesi bu
  //      boşluğu kapatıyor.
  const looksLikeTerms = (f: RawField): boolean =>
    f.type === 'checkbox' && /terms|agree|accept|tos\b|policy/i.test(`${f.name} ${f.id}`);

  const hiddenRequiredFields = raw.filter(
    (f) => !f.visible && f.type !== 'hidden' && (f.required || looksLikeTerms(f)),
  );
  const hiddenRequired = hiddenRequiredFields.map((f) => suggestSelector(f));
  const hiddenCheckboxes = hiddenRequiredFields
    .filter((f) => f.type === 'checkbox' && f.id)
    .map((f) => ({ id: f.id, selector: suggestSelector(f) }));

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
    hiddenCheckboxes,
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
  if (best.id && !looksDynamicId(best.id)) return idSelector(best.id);
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
