/**
 * Dry-run sonrası otomatik kalite kontrolü.
 *
 * NEDEN: dry-run şimdiye kadar KOŞULSUZ 'completed' dönüyordu ve
 * markVerified() damgayı kaldırıyordu — yani içi boş bir config bile
 * "doğrulandı" sayılabiliyordu. Tek koruma insan gözüydü: her taslak
 * için ekran görüntüsüne bakmak. 3430 sitelik listede bu 50+ saat
 * insan işi demek.
 *
 * Buradaki kontroller ekran görüntüsünün yakaladığı hataları PROGRAMLA
 * yakalıyor. Hepsi gerçek vakalardan geliyor:
 *  - BetaList: şifre alanları selector'ı bulunmasına rağmen BOŞ kalıyordu
 *  - ontoplist: açıklama yarıda kesiliyordu (yazma timeout'u)
 *  - Awwwards: görünmez zorunlu kutucuk atlanıyordu
 *  - 360quadrants: typeahead seçilmeyince gizli id boş kalıyordu
 */

import type { Page } from 'playwright';
import type { SiteConfig, Step } from './types.js';

export interface DryRunIssue {
  kind: 'empty_field' | 'truncated' | 'hidden_required' | 'no_submit';
  selector: string;
  detail: string;
}

/** Alan bazlı kontrol için tek bir fill adımının beklenen durumu. */
interface FillExpectation {
  selector: string;
  /** Alan boş kalırsa kayıt kesin başarısız olur. */
  critical: boolean;
}

/**
 * Bu alan boş kalırsa kayıt kesinlikle başarısız olur mu?
 *
 * email ve password olmadan hesap açılmaz. Diğerleri sitenin
 * zorunluluğuna bağlı — boş kalmaları uyarı, hata değil.
 */
function isCritical(step: Step): boolean {
  return step.field === 'email' || step.field === 'password';
}

function fillExpectations(cfg: SiteConfig): FillExpectation[] {
  const out: FillExpectation[] = [];
  for (const step of cfg.steps) {
    if (step.type !== 'fill' || !step.selector) continue;
    if (step.optional === true && !isCritical(step)) continue;
    out.push({ selector: step.selector, critical: isCritical(step) });
  }
  return out;
}

/**
 * Dry-run sonrası sayfayı denetler.
 *
 * Submit edilmemiş formu inceliyor: alanlar gerçekten doldu mu, görünmez
 * zorunlu alan kaldı mı, submit butonu var mı.
 */
export async function checkDryRunPage(page: Page, cfg: SiteConfig): Promise<DryRunIssue[]> {
  const issues: DryRunIssue[] = [];

  // 1. Doldurulması beklenen alanlar GERÇEKTEN doldu mu?
  for (const exp of fillExpectations(cfg)) {
    const value = await page
      .locator(exp.selector)
      .first()
      .inputValue()
      .catch(() => null);

    if (value === null) continue; // selector yok: fill adımı zaten atlamıştır
    if (value === '') {
      issues.push({
        kind: 'empty_field',
        selector: exp.selector,
        detail: exp.critical
          ? 'Kritik alan BOŞ — kayıt kesin başarısız olur'
          : 'Alan boş kaldı',
      });
    }
  }

  // 2. SAYFANIN istediği alanlar doldu mu?
  //
  // Yukarıdaki kontrol yalnızca config'in doldurmaya ÇALIŞTIĞI alanlara
  // bakıyor. Config bir alanı hiç bilmiyorsa (fill adımı eksik) o kontrol
  // sessiz kalır — kasıtlı bozuk bir configle denendi ve yakalanmadı.
  // Bu yüzden formun kendi zorunlu alanlarını ayrıca denetliyoruz.
  //
  // KAPSAM: yalnızca doldurulan alanların içinde bulunduğu form(lar).
  // Bütün sayfayı taramak, aynı sayfadaki GİRİŞ ve ŞİFRE SIFIRLAMA
  // formlarının boş zorunlu alanlarını da kayıt formununmuş gibi
  // raporluyordu (ontoplist: loginemail, retrieve-pass-email). Gizliyken
  // yalnızca gürültüydü; görünür bir giriş formu olsaydı "kritik alan boş"
  // sayılıp doğru bir config yanlışlıkla manual'a düşerdi. Doldurulan
  // alanlar hiçbir <form> içinde değilse (bazı React sayfaları) eskisi
  // gibi bütün sayfa taranır.
  const filledSelectors = cfg.steps
    .filter((s) => (s.type === 'fill' || s.type === 'select' || s.type === 'check') && s.selector)
    .map((s) => s.selector!);

  const pageRequired = await page
    .evaluate((selectors: string[]) => {
      const forms = new Set<Element>();
      for (const sel of selectors) {
        let el: Element | null = null;
        try {
          el = document.querySelector(sel);
        } catch {
          // Playwright'a özgü selector (text=, :has-text) CSS değil — atla.
        }
        const form = el?.closest('form');
        if (form) forms.add(form);
      }

      const scope: Element[] = forms.size > 0 ? Array.from(forms) : [document.documentElement];
      const candidates: Element[] = [];
      for (const root of scope) {
        candidates.push(...Array.from(root.querySelectorAll('input, select, textarea')));
      }

      const empty: Array<{ name: string; type: string; visible: boolean }> = [];
      for (const el of candidates) {
        const e = el as HTMLInputElement;
        if (e.type === 'hidden' || e.type === 'submit' || e.type === 'button') continue;
        if (!e.required) continue;
        if (e.type === 'checkbox' || e.type === 'radio') {
          if (e.checked) continue;
        } else if (e.value !== '') {
          continue;
        }
        const r = e.getBoundingClientRect();
        empty.push({
          name: e.name || e.id || e.type,
          type: e.type,
          visible: r.width > 0 && r.height > 0,
        });
      }
      return empty;
    }, filledSelectors)
    .catch(() => [] as Array<{ name: string; type: string; visible: boolean }>);

  for (const f of pageRequired) {
    // Zaten 1. adımda raporlanmışsa tekrar etme
    if (issues.some((i) => i.selector.includes(f.name) && f.name !== '')) continue;

    issues.push({
      kind: f.visible ? 'empty_field' : 'hidden_required',
      selector: f.name,
      detail: f.visible
        ? `Kritik alan BOŞ — sayfa bu alanı ZORUNLU işaretliyor (${f.type})`
        : 'Görünmez zorunlu alan doldurulmamış — label[for=...] tıklaması gerekebilir',
    });
  }

  // 3. Submit butonu var mı? Yoksa config gönderemez.
  const hasSubmit = cfg.steps.some((s) => s.type === 'click');
  if (!hasSubmit) {
    issues.push({
      kind: 'no_submit',
      selector: '(yok)',
      detail: 'Config’de click adımı yok — form gönderilemez',
    });
  }

  return issues;
}

/**
 * Config otomatik olarak "doğrulandı" sayılabilir mi?
 *
 * Kritik sorun varsa HAYIR — insan bakmalı. Kritik olmayan uyarılar
 * config'e not olarak yazılır ama damga kalkabilir.
 */
export function canAutoVerify(issues: DryRunIssue[]): boolean {
  return !issues.some((i) => i.kind === 'empty_field' && /Kritik/.test(i.detail));
}
