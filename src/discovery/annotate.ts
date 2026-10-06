/**
 * Sheet'e yazılacak "otomasyon durumu" ve "sorun" sınıflandırması (saf).
 *
 * Amaç: Emre sheet üzerinden bakıp neyin hazır, neyin neden takıldığını
 * filtreleyebilsin. Sınıflar bilerek az ve kalıcı; ayrıntı "Not" kolonunda.
 */

export const DURUM = {
  READY: 'Hazır',
  ACCOUNT: 'Hesap açık',
  DRAFT_FIX: 'Taslak: düzeltilecek',
  DRAFT_UNTESTED: 'Taslak: doğrulanmadı',
  MOVED: 'Taşınma onayı bekliyor',
  NO_FORM: 'Form yok',
  BOT_WALL: 'Bot koruması',
  SUBMIT_FORM: 'Submit formu (ayrı akış)',
  EMAIL_FIRST: 'Mail-first (ayrı akış)',
  TOS: 'ToS yasaklıyor',
  SCAN_ERROR: 'Tarama hatası',
  NOT_SCANNED: 'Taranmadı',
} as const;

/** id/class değeri her sayfa yüklemesinde ya da yapıda değişiyor gibi mi (UUID, md5, zaman damgası...)? */
export function looksDynamicSelector(selector: string): boolean {
  const s = selector.replace(/^#/, '');
  return (
    /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-/i.test(s) || // UUID
    /(^|[_-])[0-9a-f]{16,}$/i.test(s) || // md5/sha/uzun hex ("ctrl_4b96fac8...")
    /^:r[0-9a-z]+:/i.test(s) || // React useId
    /[_-]\d{6,}$/.test(s) || // zaman damgası ("_xfUid-5-1790795823")
    /^css-[a-z0-9]{5,}$/i.test(s) // CSS-in-JS sınıfı
  );
}

export interface Failure {
  /** Kısa, filtrelenebilir sınıf. */
  sorun: string;
  /** İnsan için ayrıntı (Not kolonu). */
  not: string;
}

/** verify-drafts'ın kaydettiği başarısızlık metnini sınıflar. */
export function classifyFailure(note: string): Failure {
  const text = note.replace(/\s+/g, ' ').trim();

  const required = /ZORUNLU işaretliyor \(([a-z-]+)\)/.exec(text);
  if (required) {
    const kind = required[1];
    if (kind === 'checkbox') {
      return {
        sorun: 'Zorunlu onay kutusu işaretlenmedi',
        not: 'Dry-run şartlar/gizlilik kutusunu işaretleyemiyor; büyük olasılıkla gerçek sorun değil, düzeltilecek',
      };
    }
    return { sorun: `Zorunlu alan boş kaldı (${kind === 'select-one' ? 'liste' : kind})`, not: 'Form bu alanı zorunlu işaretliyor, config doldurmuyor' };
  }

  const missing = /Selector bulunamadı: (\S+)/.exec(text);
  if (missing) {
    const selector = missing[1] as string;
    if (/^(button|input)\[type=['"]?submit/i.test(selector) || /^button:has-text/i.test(selector)) {
      return { sorun: 'Gönder butonu bulunamadı', not: `Seçici: ${selector}` };
    }
    if (looksDynamicSelector(selector)) {
      return { sorun: 'Form alan kimliği dinamik (her açılışta değişiyor)', not: `Seçici: ${selector}; sabit name/placeholder ile yeniden üretilecek` };
    }
    return { sorun: 'Form alanı bulunamadı (sayfa farklı ya da geç yükleniyor)', not: `Seçici: ${selector}` };
  }

  if (/Sayfa yüklenmedi, selector beklenemedi/.test(text)) {
    return { sorun: 'Form geç yükleniyor ya da sayfa farklı', not: text.slice(0, 120) };
  }
  if (/page\.goto|net::ERR|Timeout \d+ms exceeded.*navigat/i.test(text)) {
    return { sorun: 'Sayfa açılmadı (zaman aşımı / bağlantı hatası)', not: text.slice(0, 120) };
  }
  if (/locator\.click: Timeout/.test(text)) {
    return { sorun: 'Tıklama engellendi (zaman aşımı)', not: 'Buton üstünde başka öğe var ya da geç aktifleşiyor' };
  }
  if (/kategori seçeneği/i.test(text)) {
    return { sorun: 'Kategori listesinde eşleşme yok', not: 'Sitenin kategorileri ürün kategorisiyle eşleşmedi' };
  }
  if (/insan müdahalesi istiyor/i.test(text)) {
    const what = /credit card|payment|billing/i.test(text)
      ? 'ödeme bilgisi'
      : /phone|sms/i.test(text)
        ? 'telefon/SMS doğrulaması'
        : /identity|passport|document/i.test(text)
          ? 'kimlik belgesi'
          : 'insan doğrulaması';
    return { sorun: `Elle gerekiyor: ${what}`, not: 'Site otomasyonun veremeyeceği bilgi istiyor' };
  }
  if (/cannot be filled|locator\.fill/i.test(text)) {
    return { sorun: 'Alan doldurulamadı (tür uyuşmuyor)', not: text.slice(0, 120) };
  }
  if (/skipped_locked/.test(text)) {
    return { sorun: 'Doğrulama atlandı (geçici kilit)', not: 'Yeniden denenecek' };
  }
  return { sorun: 'Diğer', not: text.slice(0, 120) };
}

export interface RowInput {
  /** Bu siteyle açılmış gerçek hesap var mı? */
  hasAccount: boolean;
  /** Config durumu; config yoksa null. */
  config: { risk?: string; unverified: boolean; awaitsMove: boolean } | null;
  /** verify-drafts sonucu (varsa). */
  verification: { status: 'verified' | 'failed' | 'timeout'; note: string; captcha?: string } | null;
  /** Bu sekmedeki tarama sonucu (config yoksa belirleyici). */
  discovery: string | null;
}

export interface Annotation {
  durum: string;
  not: string;
  /** Yalnızca "Taslak: düzeltilecek" için filtrelenebilir sorun sınıfı. */
  sorun: string;
}

export function annotate(input: RowInput): Annotation {
  if (input.hasAccount) return { durum: DURUM.ACCOUNT, sorun: '', not: '' };

  const cfg = input.config;
  if (cfg) {
    if (cfg.risk === 'high') return { durum: DURUM.TOS, sorun: '', not: 'Kullanım şartları otomatik erişimi yasaklıyor' };
    if (cfg.awaitsMove) return { durum: DURUM.MOVED, sorun: '', not: 'Site başka domaine taşınmış, doğru site mi diye onay bekliyor' };
    if (!cfg.unverified) {
      return { durum: DURUM.READY, sorun: '', not: input.verification?.captcha ? `Captcha: ${input.verification.captcha} (gerçek kayıtta çözülür)` : '' };
    }
    const v = input.verification;
    if (!v) return { durum: DURUM.DRAFT_UNTESTED, sorun: '', not: 'Config üretildi, canlı dry-run henüz yapılmadı' };
    const f = classifyFailure(v.note);
    return { durum: DURUM.DRAFT_FIX, sorun: f.sorun, not: f.not };
  }

  switch (input.discovery) {
    case 'no_form':
      return { durum: DURUM.NO_FORM, sorun: '', not: '' };
    case 'bot_protected':
      return { durum: DURUM.BOT_WALL, sorun: '', not: 'Cloudflare/captcha duvarı; aşılmıyor' };
    case 'submit_form':
      return { durum: DURUM.SUBMIT_FORM, sorun: '', not: 'Hesap yok, doğrudan gönderim formu' };
    case 'email_first':
      return { durum: DURUM.EMAIL_FIRST, sorun: '', not: 'Önce e-posta/sihirli bağlantı adımı' };
    case 'high_risk':
      return { durum: DURUM.TOS, sorun: '', not: 'Kullanım şartları otomatik erişimi yasaklıyor' };
    case 'error':
      return { durum: DURUM.SCAN_ERROR, sorun: '', not: 'Tarama bu site için tamamlanamadı' };
    default:
      return { durum: DURUM.NOT_SCANNED, sorun: '', not: '' };
  }
}
