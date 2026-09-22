import { describe, expect, it } from 'vitest';
import { mapField } from '../src/discovery/analyze-form.js';
import {
  UNVERIFIED_MARKER,
  clearUnverifiedMarker,
  generateConfig,
  isUnverified,
  riskFor,
} from '../src/discovery/generate-config.js';
import { normalizeUrl, originOf, registrableHost, sameSite } from '../src/discovery/find-signup.js';
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
    ...partial,
  };
}

const candidate: SignupCandidate = {
  url: 'https://example.com/signup',
  confidence: 'high',
  hops: 0,
  method: 'direct-path',
};

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
