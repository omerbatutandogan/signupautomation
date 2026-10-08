import { describe, expect, it } from 'vitest';
import { annotate, classifyFailure, looksDynamicSelector, readyTable, DURUM } from '../src/discovery/annotate.js';

/**
 * Sheet'e yazılacak sınıflar. Gerçek verify-drafts çıktılarından (2026-10-06):
 * Emre "form alanı sürekli değişiyordur" dedi; dinamik id'leri ayırt etmek
 * düzeltme planını belirliyor (XenForo "_xfUid-5-<zaman>", "ctrl_<md5>", UUID).
 */

describe('looksDynamicSelector', () => {
  it('üretilmiş kimlikleri tanır', () => {
    expect(looksDynamicSelector('#9aafcfe4-1b58-4680-b2d7-149be4f97468')).toBe(true);
    expect(looksDynamicSelector('#_xfUid-5-1790795823')).toBe(true);
    expect(looksDynamicSelector('#ctrl_4b96fac8a1d3f12bc9fd5a83d2e028d1')).toBe(true);
    expect(looksDynamicSelector('#:r1a:')).toBe(true);
  });
  it('sabit kimlikleri dinamik saymaz', () => {
    for (const s of ['#email', '#user_primary_email_address', '#elInput_email_address', '#signup-email-field', '#member_login_190-element-10']) {
      expect(looksDynamicSelector(s)).toBe(false);
    }
  });
});

describe('classifyFailure', () => {
  it.each([
    ['❌ x: failed | Selector bulunamadı: #_xfUid-5-1790795823 (çıkış 1)', 'Form alan kimliği dinamik (her açılışta değişiyor)'],
    ["❌ x: failed | Selector bulunamadı: button[type='submit'] (çıkış 1)", 'Gönder butonu bulunamadı'],
    ['❌ x: failed | Selector bulunamadı: #email (çıkış 1)', 'Form alanı bulunamadı (sayfa farklı ya da geç yükleniyor)'],
    ['dry-run BAŞARISIZ: Kritik alan BOŞ — sayfa bu alanı ZORUNLU işaretliyor (text)', 'Zorunlu alan boş kaldı (text)'],
    ['dry-run BAŞARISIZ: Kritik alan BOŞ — sayfa bu alanı ZORUNLU işaretliyor (select-one)', 'Zorunlu alan boş kaldı (liste)'],
    ['dry-run BAŞARISIZ: Kritik alan BOŞ — sayfa bu alanı ZORUNLU işaretliyor (checkbox)', 'Zorunlu onay kutusu işaretlenmedi'],
    ['locator.click: Timeout 15000ms exceeded.', 'Tıklama engellendi (zaman aşımı)'],
    ['page.goto: net::ERR_NAME_NOT_RESOLVED at https://x.com', 'Sayfa açılmadı (zaman aşımı / bağlantı hatası)'],
    ['Uygun kategori seçeneği bulunamadı', 'Kategori listesinde eşleşme yok'],
    ['Site insan müdahalesi istiyor: (credit card|payment method|billing) required', 'Elle gerekiyor: ödeme bilgisi'],
    ['Site insan müdahalesi istiyor: phone (number|verification)|sms (code|verification)', 'Elle gerekiyor: telefon/SMS doğrulaması'],
    ['locator.fill: Error: Input of type "file" cannot be filled', 'Alan doldurulamadı (tür uyuşmuyor)'],
    ['tamamen farklı bir hata', 'Diğer'],
  ])('%s → %s', (note, sorun) => {
    expect(classifyFailure(note).sorun).toBe(sorun);
  });
});

describe('annotate', () => {
  const cfg = (o: object = {}) => ({ unverified: true, awaitsMove: false, ...o });
  const base = { hasAccount: false, config: null, verification: null, discovery: null };

  it('hesabı olan her şeyin önüne geçer', () => {
    expect(annotate({ ...base, hasAccount: true, config: cfg() }).durum).toBe(DURUM.ACCOUNT);
  });
  it('doğrulanmış config Hazır; görülen captcha not düşer', () => {
    const a = annotate({ ...base, config: cfg({ unverified: false }), verification: { status: 'verified', note: '', captcha: 'hcaptcha' } });
    expect(a).toMatchObject({ durum: DURUM.READY });
    expect(a.not).toMatch(/hcaptcha/);
  });
  it('yüksek risk ve taşınma, taslak durumundan önce gelir', () => {
    expect(annotate({ ...base, config: cfg({ risk: 'high' }) }).durum).toBe(DURUM.TOS);
    expect(annotate({ ...base, config: cfg({ awaitsMove: true }) }).durum).toBe(DURUM.MOVED);
  });
  it('başarısız taslak sorun sınıfıyla düzeltilecek olarak işaretlenir', () => {
    const a = annotate({ ...base, config: cfg(), verification: { status: 'failed', note: 'Selector bulunamadı: #_xfUid-5-1790795823' } });
    expect(a).toMatchObject({ durum: DURUM.DRAFT_FIX, sorun: 'Form alan kimliği dinamik (her açılışta değişiyor)' });
  });
  it('doğrulanmış ama son gerçek denemesi terminal biten site "Hazır" değil, takılı', () => {
    // alternativeto: dry-run geçti ama gerçek deneme "Selector bulunamadı" ile kesin bitti.
    const a = annotate({ ...base, blocked: true, config: cfg({ unverified: false }) });
    expect(a.durum).toBe(DURUM.BLOCKED);
    expect(annotate({ ...base, blocked: false, config: cfg({ unverified: false }) }).durum).toBe(DURUM.READY);
  });
  it('hiç denenmemiş taslak ayrı', () => {
    expect(annotate({ ...base, config: cfg() }).durum).toBe(DURUM.DRAFT_UNTESTED);
  });
  it('config yoksa sekmedeki tarama sonucu belirler', () => {
    const d = (discovery: string | null) => annotate({ ...base, discovery }).durum;
    expect(d('no_form')).toBe(DURUM.NO_FORM);
    expect(d('bot_protected')).toBe(DURUM.BOT_WALL);
    expect(d('submit_form')).toBe(DURUM.SUBMIT_FORM);
    expect(d('email_first')).toBe(DURUM.EMAIL_FIRST);
    expect(d('high_risk')).toBe(DURUM.TOS);
    expect(d('error')).toBe(DURUM.SCAN_ERROR);
    expect(d(null)).toBe(DURUM.NOT_SCANNED);
  });
});

describe('readyTable', () => {
  const l = (tab: string, rowNumber: number, siteId: string, website = `https://${siteId}.com`) => ({ tab, rowNumber, siteId, website });
  const ready = [
    { siteId: 'zeta', signupUrl: 'https://zeta.com/join', captcha: 'hcaptcha' },
    { siteId: 'alpha', signupUrl: 'https://alpha.com/signup', captcha: '' },
    { siteId: 'orphan', signupUrl: 'https://orphan.com/x', captcha: '' },
  ];

  it('siteyi bir kez yazar, geçtiği sekmeleri ve satırları yanına ekler; ada göre sıralar', () => {
    const rows = [l('Forums', 40, 'alpha'), l('Deals ', 7, 'alpha'), l('SaaS', 2, 'zeta')];
    expect(readyTable(ready, rows)).toEqual([
      ['https://alpha.com', 'https://alpha.com/signup', '', 'Deals (7), Forums (40)'],
      ['https://zeta.com', 'https://zeta.com/join', 'hcaptcha', 'SaaS (2)'],
    ]);
  });

  it('Sheet\'te hiç satırı olmayan config\'i listeye almaz', () => {
    expect(readyTable(ready, [l('SaaS', 2, 'alpha')]).map((r) => r[0])).toEqual(['https://alpha.com']);
  });
});
