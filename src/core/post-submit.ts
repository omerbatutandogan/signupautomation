/**
 * Kayıt gönderildikten SONRA sayfanın hangi durumda olduğunu kural tabanlı tanır.
 *
 * Dry-run formu göndermediği için bu kısım yalnızca ilk gerçek koşuda görülür ve taslak config'lerin
 * varsayılan tahmini ("mail ile LİNK doğrulaması, 'check your email' yazısı beklenir") sık sık
 * yanlış çıkar: oturum açık kalır (sideprojects), 6 haneli KOD istenir (robingood, bufferapps), ya da
 * "Thanks for signing up! confirmation email shortly" yazar (alphacoders). Hesap açıldığı halde koşu
 * "başarısız" yazılır ve kayıt yeniden denenemez hâle gelirdi.
 *
 * Kural tabanlıdır (LLM yok) ve yalnızca POZİTİF kanıtla karar verir: kanıt yoksa 'unknown' döner ve
 * koşu eskisi gibi hata verir.
 */

import type { Page } from 'playwright';
import type { VerificationSpec } from './types.js';

export type PostSubmit =
  | { kind: 'logged_in' }
  | { kind: 'code_prompt'; selector: string; submitSelector?: string }
  | { kind: 'check_email' }
  | { kind: 'unknown' };

const CODE_TEXT = /(enter|type|input|paste)[^.]{0,60}\b(code|otp)\b|verification code|confirmation code|authentication code|one[- ]time (password|code)|\b[4-8][- ]digit\b|code (we|that we|has been|was) (sent|e-?mailed)/i;
const CHECK_EMAIL_TEXT = /check your (e-?mail|inbox|spam)|(confirmation|verification|activation) (e-?mail|link|message)|we('ve| have)? sent (you )?(an? )?(e-?mail|link|message)|sent (an? )?(e-?mail|link) to|thank(s| you) for (signing up|registering|joining)|account (has been |was )?created|activate your account|verify your (e-?mail|account)|click (on )?the link/i;

/** Sayfada ölçülen, karar için gereken ham bilgi (tarayıcı içinde toplanır). */
interface PageFacts {
  text: string;
  visiblePasswordInputs: number;
  logoutVisible: boolean;
  /** Tek hanelik (maxlength=1) görünür kutu sayısı. */
  digitBoxes: number;
  /** Tek bir kod alanı adayı: görünür metin kutusu, adı/yer tutucusu "code/otp/..." diyor. */
  singleCodeSelector: string | null;
  submitSelector: string | null;
}

async function collectFacts(page: Page): Promise<PageFacts> {
  return page.evaluate((): PageFacts => {
    const visible = (el: Element) => {
      const r = (el as HTMLElement).getBoundingClientRect();
      const style = getComputedStyle(el as HTMLElement);
      return r.width > 0 && r.height > 0 && style.visibility !== 'hidden' && style.display !== 'none';
    };
    const inputs = Array.from(document.querySelectorAll<HTMLInputElement>('input:not([type=hidden]):not([type=checkbox]):not([type=radio]):not([type=submit]):not([type=button])')).filter(visible);
    const digitBoxes = inputs.filter((i) => i.maxLength === 1).length;
    const hint = /code|otp|token|pin|verif|confirm/i;
    const single = inputs.find((i) => i.maxLength !== 1 && hint.test(`${i.id} ${i.name} ${i.placeholder} ${i.getAttribute('aria-label') ?? ''}`));
    const esc = (v: string) => v.replace(/(['\\])/g, '\\$1');
    const singleCodeSelector = single
      ? single.id
        ? `[id='${esc(single.id)}']`
        : single.name
          ? `input[name='${esc(single.name)}']`
          : single.placeholder
            ? `input[placeholder='${esc(single.placeholder)}']`
            : null
      : null;
    const logoutVisible = Array.from(document.querySelectorAll('a, button')).some(
      (el) => visible(el) && /^(log ?out|sign ?out)$/i.test((el.textContent ?? '').trim()),
    ) || Array.from(document.querySelectorAll('a[href]')).some((a) => visible(a) && /(log-?out|sign-?out)/i.test(a.getAttribute('href') ?? ''));
    const submit = Array.from(document.querySelectorAll('button, input[type=submit]')).find(
      (el) => visible(el) && /^(submit|verify|confirm|continue|next|activate)\b/i.test(((el as HTMLInputElement).value || el.textContent || '').trim()),
    );
    const submitText = submit ? ((submit as HTMLInputElement).value || submit.textContent || '').trim() : null;
    return {
      text: (document.body?.innerText ?? '').replace(/\s+/g, ' ').slice(0, 4000),
      visiblePasswordInputs: inputs.filter((i) => i.type === 'password').length,
      logoutVisible,
      digitBoxes,
      singleCodeSelector,
      submitSelector: submitText ? `${submit!.tagName.toLowerCase() === 'input' ? 'input[type=submit]' : 'button'}:has-text("${submitText.replace(/"/g, '')}")` : null,
    };
  });
}

/** Saf karar: ham sayfa bilgisinden durum. (Tarayıcısız test edilebilir.) */
export function decidePostSubmit(f: PageFacts): PostSubmit {
  const codeText = CODE_TEXT.test(f.text);
  // 1) Kod isteniyor: kod metni + (4-8 tek hanelik kutu ya da tek bir kod alanı).
  if (codeText && f.digitBoxes >= 4 && f.digitBoxes <= 8) {
    return { kind: 'code_prompt', selector: 'input[maxlength="1"]', ...(f.submitSelector ? { submitSelector: f.submitSelector } : {}) };
  }
  if (codeText && f.singleCodeSelector) {
    return { kind: 'code_prompt', selector: f.singleCodeSelector, ...(f.submitSelector ? { submitSelector: f.submitSelector } : {}) };
  }
  // 2) Oturum açık: çıkış bağlantısı görünüyor ve ortada parola alanı (hâlâ kayıt/giriş formu) yok.
  if (f.logoutVisible && f.visiblePasswordInputs === 0) return { kind: 'logged_in' };
  // 3) "Mailini kontrol et": yazı var ve form hâlâ ortada değil.
  if (CHECK_EMAIL_TEXT.test(f.text) && f.visiblePasswordInputs === 0) return { kind: 'check_email' };
  return { kind: 'unknown' };
}

export async function observePostSubmit(page: Page): Promise<PostSubmit> {
  try {
    return decidePostSubmit(await collectFacts(page));
  } catch {
    return { kind: 'unknown' }; // sayfa gezindi/kapandı: kanıt yok
  }
}

/**
 * Config'in tahmini ile gözlenen durumu birleştirir: hangi doğrulama belirtimi kullanılacak ve posta
 * beklenecek mi? Gözlem yoksa/belirsizse config aynen geçerli.
 */
export function effectiveVerification(
  configured: VerificationSpec,
  observed?: PostSubmit,
): { spec: VerificationSpec; needsMail: boolean; note?: string } {
  switch (observed?.kind) {
    case 'logged_in':
      return { spec: configured, needsMail: false, note: 'oturum açık kaldı, doğrulama gerekmedi (otomatik tespit)' };
    case 'code_prompt':
      return {
        spec: {
          ...configured,
          mode: 'code',
          codeSelector: observed.selector,
          ...(observed.submitSelector ? { codeSubmitSelector: observed.submitSelector } : {}),
        },
        needsMail: true,
      };
    case 'check_email':
      // Config "doğrulama yok" demişti ama site mail gönderdiğini söylüyor: link varsay.
      return { spec: configured.mode === 'none' ? { ...configured, mode: 'link', timeoutMs: configured.timeoutMs ?? 180_000 } : configured, needsMail: true };
    default:
      return { spec: configured, needsMail: configured.mode !== 'none' };
  }
}
