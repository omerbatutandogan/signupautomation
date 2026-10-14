/**
 * Sheet'e yazılacak "otomasyon durumu" ve "sorun" sınıflandırması (saf).
 *
 * Amaç: Emre sheet üzerinden bakıp neyin hazır, neyin neden takıldığını
 * filtreleyebilsin. Sınıflar bilerek az ve kalıcı; ayrıntı "Not" kolonunda.
 */

import { looksDynamicId } from './selectors.js';

export const DURUM = {
  /** geo.new bu sitenin kendi listeleme formundan gerçekten gönderildi (herkese açık olduğu ayrıca doğrulanır). */
  LISTED: 'Gönderildi',
  /** Hesap açık ve listeleme config'i dry-run'dan geçti: yalnızca insan onayı (approve-profile) bekliyor. */
  LISTING_READY: 'Hesap açık: listeleme hazır',
  READY: 'Hazır',
  BLOCKED: 'Takıldı: elle bakılacak',
  /** Aynı kayıt motorunu kullanan başka bir sitede gerçek denemede engel doğrulandı; bu site denenmedi (tahmin). */
  FAMILY_BLOCK: 'Aile engeli: elle bakılacak',
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

/** id değeri her sayfa yüklemesinde ya da yapıda değişen üretilmiş bir değer gibi mi? (ortak: selectors.ts) */
export function looksDynamicSelector(selector: string): boolean {
  return looksDynamicId(selector);
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

/** Notun SON "GERÇEK …" bölümü (tarih öneki atılmış); yoksa null. Bölümler " | " ile ayrılır. */
export function realRunSegment(notes: string): string | null {
  const parts = notes.split(/\s\|\s/);
  for (let i = parts.length - 1; i >= 0; i--) {
    const part = parts[i] as string;
    if (part.includes('GERÇEK')) return part.replace(/^\s*\d{4}-\d{2}-\d{2}\s*/, '').trim();
  }
  return null;
}

/**
 * Gerçek koşunun config notuna bıraktığı engeli ("GERÇEK denemede: …") filtrelenebilir sınıfa çevirir.
 * Sıra önemlidir: motor düzeyindeki kesin engeller (görsel captcha, iş e-postası…) belirsiz "sayfa tanınmadı"dan önce gelir.
 */
export function classifyRealRun(notes: string): Failure | null {
  const segment = realRunSegment(notes);
  if (!segment) return null;
  const detail = segment.replace(/^GERÇEK[^:]*:\s*/, '');
  const not = detail.length > 240 ? `${detail.slice(0, 237)}...` : detail;
  const rules: Array<[RegExp, string]> = [
    [/G[öÖ]RSEL[^.]{0,40}captcha|SecureImg|Type Image Values|characters above/i, 'Görsel captcha (çözülmüyor)'],
    [/[iİ][sşŞ]\s+e-?postası|work email/i, 'Yalnızca iş e-postası kabul ediyor'],
    [/hcaptcha/i, 'hCaptcha (otomatik çözüm güvenilmez)'],
    [/Turnstile|Cloudflare|bot koruması duvarı/i, 'Bot koruması duvarı'],
    [/ÇOK ADIMLI/, 'Çok adımlı kayıt formu'],
    [/sosyal giriş|Google hesabıyla|Epic Games|\bSSO\b|\(OAuth\)/i, 'Yalnızca SSO ile kayıt'],
    [/moderat/i, 'Moderatör onayı bekliyor'],
    [/bal tuzağı|for robots/i, 'Bal tuzağı alanı (bot ayıklıyor)'],
    [/G[İi]R[İi][ŞşSs] sayfası|giriş sayfasına|Page Not Found|404/i, 'Kayıt adresi yanlış'],
    [/(mail|posta kutusuna)[^.]{0,80}(düşmedi|gelmedi|GÖNDERMİYOR)|HİÇBİR mail/i, 'Doğrulama maili gelmiyor'],
    [/ZORUNLU istiyor/, "Config'in bilmediği zorunlu alan var"],
    [/sunucu hatası|Whoops|something went wrong/i, 'Site sunucu hatası'],
    [/BELİRSİZ|beklenen içerik görünmedi|formda kaldı|yerinde kaldı|sayfa değişm|elle bak|forma geri dönüyor/i, 'Sonuç belirsiz (kayıt sonrası sayfa tanınmadı)'],
  ];
  const hit = rules.find(([re]) => re.test(detail));
  return { sorun: hit ? hit[1] : 'Diğer (nota bak)', not };
}

export interface ListingInfo {
  /** sent: gerçek gönderim yapıldı · unconfirmed: yapılmış olabilir, doğrulanamadı · ready: dry-run geçti · none: listeleme config'i yok. */
  state: 'sent' | 'unconfirmed' | 'ready' | 'none';
  url?: string | null;
  date?: string;
  /** Ürünün herkese açık sayfası insan kanıtıyla doğrulandı mı (`verify-listing`)? Yalnızca `sent` için anlamlı. */
  publicVerified?: boolean;
  /** Gönderimle ilgili uyarı (ör. eski/yanlış metinle gönderildi, düzeltme bekliyor). */
  caveat?: string;
  /** Bilinen listeleme engeli (kısa, filtrelenebilir) ve ayrıntısı. */
  blocker?: string;
  blockerNote?: string;
}

export interface RowInput {
  /** Bu siteyle açılmış gerçek hesap var mı? */
  hasAccount: boolean;
  /**
   * Son gerçek denemesi terminal bir sonuçla bitmiş ve hesabı yok: işçi bunu --force
   * olmadan yeniden denemez (runner.ts → ledger.terminalResult), yani "hazır" değildir.
   */
  blocked?: boolean;
  /** Config durumu; config yoksa null. `notes` gerçek koşu bulgularını okumak için. */
  config: { risk?: string; unverified: boolean; awaitsMove: boolean; notes?: string } | null;
  /** verify-drafts sonucu (varsa). */
  verification: { status: 'verified' | 'failed' | 'timeout'; note: string; captcha?: string; wall?: boolean; headed?: boolean } | null;
  /** Bu sekmedeki tarama sonucu (config yoksa belirleyici). */
  discovery: string | null;
  /** geo.new'in bu sitedeki listeleme durumu (yoksa listeleme akışı hiç bilinmiyor). */
  listing?: ListingInfo | null;
  /** Hesapla ilgili ek bilgi (ör. şifre kullanıcıda, e-posta doğrulanmadı). */
  accountNote?: string;
  /** Aynı kayıt motorunda doğrulanmış engel (başka bir sitenin gerçek denemesinden çıkarım). */
  familyBlock?: { sorun: string; sourceId: string } | null;
}

export interface Annotation {
  durum: string;
  not: string;
  /** Yalnızca "Taslak: düzeltilecek" için filtrelenebilir sorun sınıfı. */
  sorun: string;
}

const join = (...parts: Array<string | null | undefined | false>): string => parts.filter((p): p is string => Boolean(p)).join(' ');

export function annotate(input: RowInput): Annotation {
  const listing = input.listing ?? null;

  // Gerçekten gönderilmiş: her şeyin önünde. Görünürlük ayrıca doğrulanır (site onayı/sahiplik doğrulaması isteyebilir).
  if (listing?.state === 'sent' || listing?.state === 'unconfirmed') {
    const sent = listing.state === 'sent';
    return {
      durum: DURUM.LISTED,
      sorun: sent ? '' : 'Sonucu doğrulanamadı (elle bak)',
      not: join(
        sent ? 'geo.new listeleme formundan gönderildi' : 'Gönderim yapılmış olabilir, başarı doğrulanamadı',
        listing.date && `(${listing.date})`,
        listing.url && `· ${listing.url}`,
        sent && listing.publicVerified ? '· herkese açık olduğu doğrulandı.' : '· herkese açık olduğu doğrulanmadı.',
        listing.caveat && `${listing.caveat}.`,
      ),
    };
  }

  if (input.hasAccount) {
    if (listing?.state === 'ready') {
      return { durum: DURUM.LISTING_READY, sorun: '', not: join('Listeleme config\'i dry-run\'dan geçti; gerçek gönderim için profil onayı (approve-profile) güncel olmalı.', listing.caveat && `${listing.caveat}.`, input.accountNote) };
    }
    return { durum: DURUM.ACCOUNT, sorun: listing?.blocker ?? '', not: join(listing?.blockerNote, input.accountNote) };
  }

  const cfg = input.config;
  if (cfg) {
    if (cfg.risk === 'high') return { durum: DURUM.TOS, sorun: '', not: 'Kullanım şartları otomatik erişimi yasaklıyor' };
    if (cfg.awaitsMove) return { durum: DURUM.MOVED, sorun: '', not: 'Site başka domaine taşınmış, doğru site mi diye onay bekliyor' };
    if (input.blocked) {
      // Gerçek denemede kesin takılmış: taslak ya da doğrulanmış olması fark etmez, gerçek bulgu dry-run'dan güçlüdür.
      const real = classifyRealRun(cfg.notes ?? '');
      return {
        durum: DURUM.BLOCKED,
        sorun: real?.sorun ?? '',
        not: real?.not ?? 'Son gerçek deneme kesin başarısız bitti; işçi kendiliğinden yeniden denemez, config elle düzeltilmeli',
      };
    }
    if (input.familyBlock) {
      return {
        durum: DURUM.FAMILY_BLOCK,
        sorun: input.familyBlock.sorun,
        not: `Aynı kayıt motoru: ${input.familyBlock.sourceId} sitesinde gerçek denemede takıldı. Bu site denenmedi; engel tahmin edilen (gerçek koşuda doğrulanmadı).`,
      };
    }
    if (!cfg.unverified) {
      return { durum: DURUM.READY, sorun: '', not: input.verification?.captcha ? `Captcha: ${input.verification.captcha} (gerçek kayıtta çözülür)` : '' };
    }
    const v = input.verification;
    if (!v) return { durum: DURUM.DRAFT_UNTESTED, sorun: '', not: 'Config üretildi, canlı dry-run henüz yapılmadı' };
    // Hata sayfası bir bot duvarıysa form sorunu değil duvardır; hangi tarayıcıyla görüldüğü notta.
    const f = v.wall
      ? {
          sorun: 'Bot koruması duvarı (dry-run\'da)',
          not: v.headed
            ? 'Görünür tarayıcıda da duvar çıktı; aşılmıyor'
            : 'Headless dry-run duvara takıldı; görünür tarayıcıyla yeniden denenecek',
        }
      : classifyFailure(v.note);
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

// ── "Hazır Siteler" özet sekmesi ──────────────────────────────────────────

export const READY_TAB = 'Hazır Siteler';
export const READY_HEADER = ['Site', 'Kayıt sayfası', 'Captcha', 'Sheet\'te geçtiği sekmeler (satır)'];

export interface ReadySite {
  siteId: string;
  signupUrl: string;
  /** Dry-run'da görülen captcha türü (boş = görülmedi). */
  captcha: string;
}

export interface Listing {
  tab: string;
  rowNumber: number;
  siteId: string;
  website: string;
}

/**
 * Tek bir listede, siteye göre tekilleştirilmiş hazır siteler. Aynı site birden çok
 * sekmede geçebilir (3281 satır = 2497 tekil site): burada bir kez görünür, geçtiği
 * sekmeler yanında yazılır — "hazır kaç site" sorusunun cevabı bu sekmenin satır sayısıdır.
 */
export function readyTable(ready: readonly ReadySite[], listings: readonly Listing[]): string[][] {
  const where = new Map<string, Listing[]>();
  for (const l of listings) {
    const list = where.get(l.siteId);
    if (list) list.push(l);
    else where.set(l.siteId, [l]);
  }
  return [...ready]
    // Sheet'te hiç satırı olmayan config (listeden çıkarılmış site) burada yer almaz.
    .filter((r) => where.has(r.siteId))
    .sort((a, b) => a.siteId.localeCompare(b.siteId))
    .map((r) => {
      const rows = (where.get(r.siteId) ?? []).sort((a, b) => a.tab.localeCompare(b.tab) || a.rowNumber - b.rowNumber);
      return [
        rows[0]?.website ?? r.siteId,
        r.signupUrl,
        r.captcha,
        rows.map((l) => `${l.tab.trim()} (${l.rowNumber})`).join(', '),
      ];
    });
}
