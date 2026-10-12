import { describe, expect, it } from 'vitest';
import { annotate, classifyFailure, classifyRealRun, looksDynamicSelector, readyTable, realRunSegment, DURUM } from '../src/discovery/annotate.js';

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
  it('başarısızlık sayfası bot duvarıysa form sorunu değil duvar olarak sınıflanır', () => {
    const wall = { status: 'failed' as const, note: 'Selector bulunamadı: #email', wall: true };
    expect(annotate({ ...base, config: cfg(), verification: wall }).sorun).toBe("Bot koruması duvarı (dry-run'da)");
    expect(annotate({ ...base, config: cfg(), verification: wall }).not).toMatch(/görünür tarayıcıyla yeniden/);
    expect(annotate({ ...base, config: cfg(), verification: { ...wall, headed: true } }).not).toMatch(/aşılmıyor/);
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


/**
 * Gerçek koşunun config notlarına bıraktığı engel ("| 2026-10-10 GERÇEK denemede: …") filtrelenebilir sınıfa çevrilir.
 * Metinler gerçek config'lerden (12 Ekim 2026) olduğu gibi alınmıştır.
 */
describe('realRunSegment', () => {
  it('SON "GERÇEK" bölümünü alır ve tarih önekini atar', () => {
    const notes = 'Doğrulandı (dry-run). | 2026-10-10 GERÇEK denemede: ilk bulgu. | 2026-10-12 GERÇEK denemede: son bulgu.';
    expect(realRunSegment(notes)).toBe('GERÇEK denemede: son bulgu.');
  });
  it('gerçek koşu notu yoksa null', () => {
    expect(realRunSegment('Doğrulandı (dry-run, 06.10.2026) Keşif: direct-path.')).toBeNull();
    expect(realRunSegment('')).toBeNull();
  });
});

describe('classifyRealRun', () => {
  it.each([
    ["GERÇEK denemede: kayıt formunda GÖRSEL captcha ('SecureImg') + reCAPTCHA var; sistem görsel captcha'yı çözmüyor → hesap açılmadı.", 'Görsel captcha (çözülmüyor)'],
    ["GERÇEK denemede: kayıt formunda GÖRSEL (yazı) captcha var ('Enter the characters above') → 'Captcha failed', hesap açılmadı.", 'Görsel captcha (çözülmüyor)'],
    ["GERÇEK denemede: kayıt formunda GÖRSEL (yazı) captcha var ('Type Image Values'); sistem bu tipi çözmüyor", 'Görsel captcha (çözülmüyor)'],
    ["GERÇEK kayıtla: site yalnızca İŞ e-postası kabul ediyor ('Please use your work email address to register') — Gmail adresiyle kayıt YAPILAMAZ.", 'Yalnızca iş e-postası kabul ediyor'],
    ['GERÇEK denemede: hCaptcha: 2captcha 180 sn içinde çözemedi, sonra insan bekledi → manual.', 'hCaptcha (otomatik çözüm güvenilmez)'],
    ["GERÇEK denemede: kayıt formu, Cloudflare Turnstile ('Verify you are human') geçilmeden görünmüyor. Bot koruması duvarı.", 'Bot koruması duvarı'],
    ["GERÇEK denemede: kayıt ÇOK ADIMLI (1 Hesap bilgileri → Next → 2 Konum/meslek); config yalnızca 1. adımı biliyor.", 'Çok adımlı kayıt formu'],
    ["GERÇEK denemede: kayıt Google hesabıyla girişe yönleniyor; e-posta formu kullanılmıyor.", 'Yalnızca SSO ile kayıt'],
    ["GERÇEK denemede: kayıt, Epic Games hesabı girişine yönleniyor (SSO); site kendi formunu kullanmıyor.", 'Yalnızca SSO ile kayıt'],
    ["GERÇEK denemede: gönder adımı 'Sign in with Google' (OAuth) sayfasına götürdü; kayıt sosyal girişe dayanıyor olabilir.", 'Yalnızca SSO ile kayıt'],
    ["GERÇEK denemede: Discourse forumu. E-posta doğrulandı AMA 'A moderator must manually approve your new account'", 'Moderatör onayı bekliyor'],
    ["GERÇEK denemede: formda 'Please leave this field empty. It is for robots' bal tuzağı alanı var; hesap açılmamış görünüyor.", 'Bal tuzağı alanı (bot ayıklıyor)'],
    ["GERÇEK denemede: kayıt adresi 404 döndürüyor ('Page Not Found'): signupUrl artık geçersiz", 'Kayıt adresi yanlış'],
    ["GERÇEK denemede: signupUrl bir GİRİŞ sayfası (sign-in?next=/products/new); kayıt için 'Join' akışı ayrı incelenmeli", 'Kayıt adresi yanlış'],
    ["GERÇEK denemede: kayıt gönderildi ve site 'We sent an activation mail' dedi ama 3 dk içinde posta kutusuna HİÇBİR mail düşmedi.", 'Doğrulama maili gelmiyor'],
    ['GERÇEK denemede: kayıt sonrası kod ekranı çıktı ama doğrulama maili posta kutusuna hiç düşmedi.', 'Doğrulama maili gelmiyor'],
    ["GERÇEK denemede: form şirket adı, ülke ve profil adı alanlarını ZORUNLU istiyor; config bunları bilmiyor → gönderilemedi.", 'Config\'in bilmediği zorunlu alan var'],
    ["GERÇEK denemede: form gönderilince site kendi sunucu hatasını döndü ('Whoops, looks like something went wrong').", 'Site sunucu hatası'],
    ['GERÇEK denemede: form gönderilince beklenen içerik görünmedi; hesabın açılıp açılmadığı BELİRSİZ.', 'Sonuç belirsiz (kayıt sonrası sayfa tanınmadı)'],
    ["GERÇEK denemede: kayıt sayfası gönderimden sonra da formda kaldı; çok adımlı akış ya da gizli engel olabilir, hesap açılmadı görünüyor.", 'Sonuç belirsiz (kayıt sonrası sayfa tanınmadı)'],
    ['GERÇEK denemede: tamamen başka bir şey oldu', 'Diğer (nota bak)'],
  ])('%s → %s', (segment, sorun) => {
    expect(classifyRealRun(`Önceki not. | 2026-10-10 ${segment}`)?.sorun).toBe(sorun);
  });

  it('notu kısaltır, "GERÇEK …:" önekini atar ve gerçek koşu notu yoksa null döner', () => {
    const long = 'x'.repeat(400);
    const r = classifyRealRun(`a | 2026-10-10 GERÇEK denemede: ${long}`);
    expect(r?.not.length).toBeLessThanOrEqual(240);
    expect(r?.not.startsWith('GERÇEK')).toBe(false);
    expect(classifyRealRun('yalnızca dry-run notu')).toBeNull();
  });
});

describe('annotate — hesap, listeleme, takılma, aile engeli', () => {
  const cfg = (o: object = {}) => ({ unverified: false, awaitsMove: false, ...o });
  const base = { hasAccount: false, config: null, verification: null, discovery: null };

  it('geo.new gerçekten gönderilmiş siteyi "Gönderildi" yapar; görünürlük ve düzeltme uyarısı notta', () => {
    const a = annotate({ ...base, hasAccount: true, config: cfg(), listing: { state: 'sent', url: 'https://x.example/tools/geo-new', date: '2026-10-12', caveat: 'Eski metinle gönderildi; düzeltme bekliyor' } });
    expect(a.durum).toBe(DURUM.LISTED);
    expect(a.not).toContain('https://x.example/tools/geo-new');
    expect(a.not).toContain('2026-10-12');
    expect(a.not).toMatch(/herkese açık.*doğrulanmadı/i);
    expect(a.not).toContain('düzeltme bekliyor');
  });

  it('sonucu doğrulanamayan gönderim de ayrıca belirtilir (elle bakılacak)', () => {
    const a = annotate({ ...base, hasAccount: true, config: cfg(), listing: { state: 'unconfirmed' } });
    expect(a.durum).toBe(DURUM.LISTED);
    expect(a.sorun).toMatch(/doğrulanamadı/i);
  });

  it('hesabı açık ve listeleme config\'i dry-run\'dan geçmiş site "listeleme hazır"; onay gerektiğini söyler', () => {
    const a = annotate({ ...base, hasAccount: true, config: cfg(), listing: { state: 'ready' } });
    expect(a.durum).toBe(DURUM.LISTING_READY);
    expect(a.not).toMatch(/approve-profile/);
    const held = annotate({ ...base, hasAccount: true, config: cfg(), listing: { state: 'ready', caveat: 'Bilinçli bekletiliyor: sahip karar verecek' } });
    expect(held.not).toContain('Bilinçli bekletiliyor');
  });

  it('listeleme config\'i olmayan hesap "Hesap açık"; bilinen listeleme engeli Sorun\'a yazılır', () => {
    const a = annotate({ ...base, hasAccount: true, config: cfg(), listing: { state: 'none', blocker: 'Listeleme: 2. adımda görsel doğrulama kodu', blockerNote: 'Alanları doldurulabilir ama kodu insan yazmalı' } });
    expect(a).toMatchObject({ durum: DURUM.ACCOUNT, sorun: 'Listeleme: 2. adımda görsel doğrulama kodu' });
    expect(a.not).toContain('insan yazmalı');
  });

  it('hesap notu (şifre kullanıcıda / doğrulanmamış) Not\'a eklenir', () => {
    const a = annotate({ ...base, hasAccount: true, config: cfg(), accountNote: 'Şifre sistemde değil (kullanıcıda): otomatik giriş yapılamaz.' });
    expect(a).toMatchObject({ durum: DURUM.ACCOUNT });
    expect(a.not).toContain('kullanıcıda');
  });

  it('gerçek denemede kesin takılan site, engel sınıfını ve notu taşır (doğrulanmış ya da taslak fark etmez)', () => {
    const note = "Doğrulandı (dry-run). | 2026-10-10 GERÇEK denemede: kayıt formunda GÖRSEL captcha ('SecureImg') var; sistem görsel captcha'yı çözmüyor → hesap açılmadı.";
    for (const unverified of [false, true]) {
      const a = annotate({ ...base, blocked: true, config: cfg({ unverified, notes: note }) });
      expect(a).toMatchObject({ durum: DURUM.BLOCKED, sorun: 'Görsel captcha (çözülmüyor)' });
      expect(a.not).toMatch(/görsel captcha/i);
    }
  });

  it('takılan sitede gerçek koşu notu yoksa genel not kalır', () => {
    const a = annotate({ ...base, blocked: true, config: cfg({ notes: 'yalnızca dry-run' }) });
    expect(a.durum).toBe(DURUM.BLOCKED);
    expect(a.sorun).toBe('');
    expect(a.not).toMatch(/kesin başarısız/);
  });

  it('aynı kayıt motorunda engel doğrulanmış site denenmeden "Aile engeli" olur (Hazır değil)', () => {
    const familyBlock = { sorun: 'Görsel captcha (aile)', sourceId: 'aboutyoublog' };
    for (const unverified of [false, true]) {
      const a = annotate({ ...base, config: cfg({ unverified }), familyBlock });
      expect(a).toMatchObject({ durum: DURUM.FAMILY_BLOCK, sorun: 'Görsel captcha (aile)' });
      expect(a.not).toContain('aboutyoublog');
      expect(a.not).toMatch(/denenmedi|tahmin/i);
    }
  });

  it('kontrol: aile engeli yoksa doğrulanmış config yine "Hazır"', () => {
    expect(annotate({ ...base, config: cfg() }).durum).toBe(DURUM.READY);
  });

  it('öncelik: hesap açık > ToS/taşınma > kendi gerçek engeli > aile engeli', () => {
    const familyBlock = { sorun: 'x', sourceId: 'y' };
    expect(annotate({ ...base, hasAccount: true, config: cfg(), familyBlock }).durum).toBe(DURUM.ACCOUNT);
    expect(annotate({ ...base, config: cfg({ risk: 'high' }), familyBlock }).durum).toBe(DURUM.TOS);
    expect(annotate({ ...base, config: cfg({ awaitsMove: true }), familyBlock }).durum).toBe(DURUM.MOVED);
    expect(annotate({ ...base, blocked: true, config: cfg({ notes: '| 2026-10-10 GERÇEK denemede: hCaptcha çözülemedi' }), familyBlock }).sorun).toMatch(/hCaptcha/);
  });
});
