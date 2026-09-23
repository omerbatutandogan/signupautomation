import { describe, expect, it } from 'vitest';
import { mapField } from '../src/discovery/analyze-form.js';
import {
  UNVERIFIED_MARKER,
  clearUnverifiedMarker,
  generateConfig,
  isUnverified,
  riskFor,
} from '../src/discovery/generate-config.js';
import {
  acceptsOffSiteUrl,
  normalizeUrl,
  originOf,
  registrableHost,
  sameSite,
} from '../src/discovery/find-signup.js';
import type { FormAnalysis } from '../src/discovery/analyze-form.js';
import type { SignupCandidate } from '../src/discovery/find-signup.js';

function rawField(partial: Partial<Parameters<typeof mapField>[0]>): Parameters<typeof mapField>[0] {
  return {
    tag: 'input',
    type: 'text',
    name: '',
    id: '',
    placeholder: '',
    ariaLabel: '',
    maxLength: -1,
    required: false,
    visible: true,
    text: '',
    ...partial,
  };
}

describe('mapField — alan eşleme', () => {
  it('type=email ve type=password kesin eşleşir', () => {
    expect(mapField(rawField({ type: 'email' }))).toBe('email');
    expect(mapField(rawField({ type: 'password' }))).toBe('password');
  });

  it('username ipuçlarını yakalar', () => {
    expect(mapField(rawField({ name: 'username' }))).toBe('username');
    expect(mapField(rawField({ placeholder: 'Your nickname' }))).toBe('username');
  });

  it('textarea açıklama sayılır', () => {
    expect(mapField(rawField({ tag: 'textarea' }))).toBe('description');
  });

  it('şartlar kutucuğunu tanır', () => {
    expect(mapField(rawField({ type: 'checkbox', name: 'accept_terms' }))).toBe('terms');
  });

  it('pazarlama kutucuğunu ASLA eşlemez — istenmeden bültene abone olunmasın', () => {
    expect(mapField(rawField({ type: 'checkbox', name: 'newsletter' }))).toBeNull();
    expect(mapField(rawField({ type: 'checkbox', name: 'marketing_emails' }))).toBeNull();
  });

  it('website alanını tanır', () => {
    expect(mapField(rawField({ type: 'url' }))).toBe('website');
    expect(mapField(rawField({ placeholder: 'Your website URL' }))).toBe('website');
  });

  it('ipucu olmayan text alanını uydurmaz', () => {
    // Tahmin etmektense TODO bırakmak daha güvenli.
    expect(mapField(rawField({ type: 'text' }))).toBeNull();
  });

  it('type=text olan e-posta alanını isimden yakalar', () => {
    // 360Quadrants gerçek vakası: user_data[email] ama type="text".
    // type'a güvenmek kaydı e-postasız bırakıyordu.
    expect(mapField(rawField({ type: 'text', name: 'user_data[email]' }))).toBe('email');
    expect(mapField(rawField({ type: 'text', placeholder: 'Email' }))).toBe('email');
  });

  it('yanlış aria-label\'a aldanmaz, yapısal isme güvenir', () => {
    // Gerçek vaka: 360Quadrants'ta isim alanının aria-label'ı yanlışlıkla
    // "Business Email" yazıyor. Metne güvenmek ismi e-posta sanıyordu.
    expect(
      mapField(
        rawField({
          type: 'text',
          name: 'user_data[first_name]',
          placeholder: 'Name',
          ariaLabel: 'Business Email',
        }),
      ),
    ).toBe('firstName');
  });

  it('gerçek e-posta alanını doğru eşler (aynı formda)', () => {
    expect(
      mapField(
        rawField({
          type: 'text',
          name: 'user_data[email]',
          placeholder: 'Email',
          ariaLabel: 'Business Email',
        }),
      ),
    ).toBe('email');
  });

  it('fullname\'i lastName sanmaz', () => {
    // Gerçek vaka: alternative.me'de input[name="fullname"] vardı;
    // "fu-llname" içinde "lname" geçtiği için lastName'e eşleşiyordu.
    expect(mapField(rawField({ name: 'fullname' }))).toBe('fullName');
    expect(mapField(rawField({ name: 'full_name' }))).toBe('fullName');
  });

  it('kısaltmaları yalnızca kelime sınırında eşler', () => {
    expect(mapField(rawField({ name: 'lname' }))).toBe('lastName');
    expect(mapField(rawField({ name: 'fname' }))).toBe('firstName');
  });

  it('telefon alanını bilinçli olarak eşlemez — SMS doğrulama kapsam dışı', () => {
    expect(mapField(rawField({ name: 'user_data[phone]' }))).toBeNull();
    expect(mapField(rawField({ placeholder: 'Contact Number' }))).toBeNull();
  });
});

describe('riskFor — ToS koruması', () => {
  it('denylist domainlerini high işaretler', () => {
    expect(riskFor('g2.com')).toBe('high');
    expect(riskFor('https://www.capterra.com')).toBe('high');
    expect(riskFor('trustpilot.com')).toBe('high');
  });

  it('Gartner mülklerini de yakalar (Capterra ile aynı ToS)', () => {
    expect(riskFor('getapp.com')).toBe('high');
    expect(riskFor('softwareadvice.com')).toBe('high');
  });

  it('normal siteleri low bırakır', () => {
    expect(riskFor('10words.io')).toBe('low');
    expect(riskFor('betalist.com')).toBe('low');
  });
});

describe('normalizeUrl / originOf', () => {
  it('şema ekler', () => {
    expect(normalizeUrl('example.com')).toBe('https://example.com');
  });

  it('sondaki eğik çizgiyi atar', () => {
    expect(normalizeUrl('https://example.com/')).toBe('https://example.com');
  });

  it('kökü çıkarır', () => {
    expect(originOf('https://example.com/a/b')).toBe('https://example.com');
    expect(originOf('airtable.com/marketplace')).toBe('https://airtable.com');
  });
});

describe('sameSite — domain sınırı', () => {
  it('farklı siteyi reddeder', () => {
    // Gerçek vaka: aixcollection.com keşfi saashub.com/register'a
    // sapmıştı — yanlış siteye kayıt olurdu.
    expect(sameSite('https://www.saashub.com/register', 'aixcollection.com')).toBe(false);
  });

  it('alt domaini kabul eder', () => {
    // 10words gerçek vakası: kayıt portal.10words.io'da.
    expect(sameSite('https://portal.10words.io/auth/register', '10words.io')).toBe(true);
  });

  it('www farkını yok sayar', () => {
    expect(sameSite('https://www.example.com/signup', 'example.com')).toBe(true);
  });

  it('baseDomain boşsa güvenli tarafta kalır', () => {
    expect(sameSite('https://example.com', '')).toBe(false);
  });
});

describe('acceptsOffSiteUrl — taşınma mı sızma mı', () => {
  it('YÖNLENDİRME ile gelen farklı domaini kabul eder (site taşınmış)', () => {
    // Gerçek vaka: angel.co/signup → wellfound.com/signup. Sunucu 30x ile
    // gönderdi, hâlâ aradığımız sitenin kaydı. Eskiden reddediliyordu ve
    // AngelList "kayıt formu bulunamadı" diye kaydedilmişti.
    expect(
      acceptsOffSiteUrl({
        url: 'https://wellfound.com/signup',
        baseDomain: 'angel.co',
        redirected: true,
      }),
    ).toBe(true);
  });

  it('LİNK ile gidilen farklı domaini reddeder (sızma)', () => {
    // Gerçek vaka: aixcollection.com sayfasındaki bir link saashub.com'a
    // götürüyordu — yanlış siteye kayıt olurduk. Bu koruma bozulmamalı.
    expect(
      acceptsOffSiteUrl({
        url: 'https://www.saashub.com/register',
        baseDomain: 'aixcollection.com',
        redirected: false,
      }),
    ).toBe(false);
  });

  it('aynı sitede yönlendirme olmasa da kabul eder', () => {
    expect(
      acceptsOffSiteUrl({
        url: 'https://example.com/signup',
        baseDomain: 'example.com',
        redirected: false,
      }),
    ).toBe(true);
  });

  it('aynı sitenin alt domainini yönlendirmesiz kabul eder', () => {
    // 10words: portal.10words.io — sameSite zaten kabul ediyor.
    expect(
      acceptsOffSiteUrl({
        url: 'https://portal.10words.io/auth/register',
        baseDomain: '10words.io',
        redirected: false,
      }),
    ).toBe(true);
  });
});

describe('registrableHost', () => {
  it('www ve alt domainleri atar', () => {
    expect(registrableHost('https://www.example.com')).toBe('example.com');
    expect(registrableHost('https://portal.10words.io')).toBe('10words.io');
  });

  it('co.uk gibi ikili son ekleri korur', () => {
    expect(registrableHost('https://shop.example.co.uk')).toBe('example.co.uk');
  });
});

function analysis(partial: Partial<FormAnalysis> = {}): FormAnalysis {
  return {
    url: 'https://example.com/signup',
    fields: [
      {
        tag: 'input',
        type: 'email',
        name: 'email',
        id: 'email',
        placeholder: '',
        ariaLabel: '',
        maxLength: null,
        required: true,
        selector: '#email',
        field: 'email',
      },
      {
        tag: 'input',
        type: 'password',
        name: 'password',
        id: 'password',
        placeholder: '',
        ariaLabel: '',
        maxLength: null,
        required: true,
        selector: '#password',
        field: 'password',
      },
    ],
    submitSelector: "button:has-text('Sign Up')",
    captcha: null,
    dismissSelectors: [],
    hiddenRequired: [],
    ...partial,
  };
}

const candidate: SignupCandidate = {
  url: 'https://example.com/signup',
  confidence: 'high',
  hops: 0,
  method: 'direct-path',
};

describe('generateConfig — taslak kalitesi', () => {
  /**
   * Bu üç test, elle düzeltilen 8 config'ten çıkan derslerin kodda
   * kalmasını sağlıyor. Üçü de gerçek hatalardan geldi.
   */

  it('expect deseni TEK KELİMELİK genel ifade İÇERMEZ', () => {
    const { config } = generateConfig({
      id: 'example',
      name: 'Example',
      website: 'example.com',
      candidate,
      analysis: analysis(),
    });

    const expectStep = config.steps.find((s) => s.type === 'expect');
    const patterns = (expectStep?.anyOf ?? []).join(' ');

    // Awwwards gerçek vakası: kayıt BAŞARISIZKEN sayfa başlığındaki
    // "Welcome to the community!" /welcome/i ile eşleşti, sistem başarı
    // sandı ve 10 dakika boşuna mail bekledi.
    expect(patterns).not.toMatch(/\/welcome\/i/);
    expect(patterns).not.toMatch(/\/confirm\/i/);
    expect(patterns).not.toMatch(/\/dashboard\/i/);
    expect(patterns).not.toMatch(/\/thank\/i/);

    // Yine de kayıt akışına özgü desenler bulunmalı.
    expect(patterns).toMatch(/check your/);
  });

  it('taslakta mail beklemesi KISA — mod yalnızca tahmin', () => {
    const { config } = generateConfig({
      id: 'example',
      name: 'Example',
      website: 'example.com',
      candidate,
      analysis: analysis(),
    });

    // 10words, alternative, ontoplist: üçü de mode:'link' taslağıyla
    // başlayıp sonunda mode:'none' oldu. Her denemede 10 dakika bekleme
    // tamamen boşa gidiyordu.
    expect(config.verification.timeoutMs).toBeLessThanOrEqual(180_000);
  });

  it('görünmez zorunlu alanı UYARIR, sessizce atmaz', () => {
    const { warnings } = generateConfig({
      id: 'example',
      name: 'Example',
      website: 'example.com',
      candidate,
      analysis: analysis({ hiddenRequired: ["input[name='terms']"] }),
    });

    // Awwwards şartlar kutucuğu vis:false + required idi; keşif onu
    // atıyordu ve form "This value should be true" ile reddediliyordu.
    const hit = warnings.find((w) => /GÖRÜNMEZ ZORUNLU/.test(w));
    expect(hit).toBeDefined();
    expect(hit).toContain("input[name='terms']");
  });
});

describe('generateConfig', () => {
  it('şemadan geçen config üretir', () => {
    const { config } = generateConfig({
      id: 'example',
      name: 'Example',
      website: 'example.com',
      candidate,
      analysis: analysis(),
    });

    expect(config.id).toBe('example');
    expect(config.signupUrl).toBe('https://example.com/signup');
    expect(config.steps.length).toBeGreaterThan(3);
  });

  it('DOĞRULANMADI damgası taşır — run-batch bunu atlar', () => {
    const { config } = generateConfig({
      id: 'example',
      name: 'Example',
      website: 'example.com',
      candidate,
      analysis: analysis(),
    });

    expect(config.notes).toContain(UNVERIFIED_MARKER);
    expect(isUnverified(config)).toBe(true);
  });

  it('captchaGate adımını her zaman ekler', () => {
    // AlternativeTo dersi: elle kayıtta captcha yoktu, otomatik trafikte çıktı.
    const { config } = generateConfig({
      id: 'example',
      name: 'Example',
      website: 'example.com',
      candidate,
      analysis: analysis({ captcha: null }),
    });

    expect(config.steps.some((s) => s.type === 'captchaGate')).toBe(true);
  });

  it('yüksek riskli siteyi high olarak işaretler', () => {
    const { config } = generateConfig({
      id: 'g2',
      name: 'G2',
      website: 'g2.com',
      candidate,
      analysis: analysis(),
    });
    expect(config.risk).toBe('high');
  });

  it('e-posta alanı yoksa KULLANILAMAZ uyarısı verir', () => {
    // E-postasız kayıt anlamsız: doğrulama maili gelmez, hesap kimliği olmaz.
    const noEmail = analysis({ fields: [analysis().fields[1]!] }); // yalnızca password
    const { warnings } = generateConfig({
      id: 'example',
      name: 'Example',
      website: 'example.com',
      candidate,
      analysis: noEmail,
    });
    expect(warnings.some((w) => w.includes('KULLANILAMAZ'))).toBe(true);
  });

  it('şifresiz formu KULLANILAMAZ sayar — bülten/demo formu olabilir', () => {
    // Gerçek vakalar: 1000.tools/signup (website+email, ürün gönderme),
    // akitaapp.com/demo (your-company+your-email, demo talebi).
    // İkisi de "kayıt formu" sanılıp kullanılamaz config üretmişti.
    const noPassword = analysis({ fields: [analysis().fields[0]!] }); // yalnızca email
    const { warnings } = generateConfig({
      id: 'example',
      name: 'Example',
      website: 'example.com',
      candidate,
      analysis: noPassword,
    });
    expect(warnings.some((w) => w.startsWith('KULLANILAMAZ') && /şifre/i.test(w))).toBe(true);
  });

  it('gönder butonu yoksa uyarır', () => {
    const { warnings } = generateConfig({
      id: 'example',
      name: 'Example',
      website: 'example.com',
      candidate,
      analysis: analysis({ submitSelector: null }),
    });
    expect(warnings.some((w) => /buton/i.test(w))).toBe(true);
  });

  it('eşlenemeyen zorunlu alanı raporlar', () => {
    const withUnknown = analysis({
      fields: [
        ...analysis().fields,
        {
          tag: 'input',
          type: 'text',
          name: 'mystery',
          id: '',
          placeholder: '',
          ariaLabel: '',
          maxLength: null,
          required: true,
          selector: "input[name='mystery']",
          field: null,
        },
      ],
    });

    const { unmappedFields } = generateConfig({
      id: 'example',
      name: 'Example',
      website: 'example.com',
      candidate,
      analysis: withUnknown,
    });

    expect(unmappedFields.length).toBe(1);
    expect(unmappedFields[0]).toContain('mystery');
  });
});

describe('clearUnverifiedMarker', () => {
  it('damgayı kaldırır ve doğrulandı bilgisi bırakır', () => {
    const before = `${UNVERIFIED_MARKER} Keşif: direct-path.`;
    const after = clearUnverifiedMarker(before);

    expect(after).not.toContain(UNVERIFIED_MARKER);
    expect(after).toContain('Doğrulandı');
    expect(after).toContain('Keşif: direct-path.');
    expect(isUnverified({ notes: after })).toBe(false);
  });
});
