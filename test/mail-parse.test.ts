import { describe, expect, it } from 'vitest';
import {
  domainOfAddress,
  extractBareUrls,
  extractLinks,
  extractVerificationCode,
  extractVerificationLink,
  isVerificationCandidate,
  registrableDomain,
  scoreLinks,
  type ParsedMessage,
} from '../src/integrations/mail-parse.js';
import { ManualReviewError } from '../src/core/errors.js';

function msg(partial: Partial<ParsedMessage>): ParsedMessage {
  return {
    id: 'm1',
    from: 'noreply@example.com',
    subject: '',
    text: '',
    html: '',
    receivedAt: Date.now(),
    ...partial,
  };
}

describe('registrableDomain', () => {
  it('iki seviyeli domainleri çıkarır', () => {
    expect(registrableDomain('https://mail.alternativeto.net/x')).toBe('alternativeto.net');
  });

  it('co.uk gibi ikili son ekleri bir seviye daha alır', () => {
    expect(registrableDomain('https://www.example.co.uk/verify')).toBe('example.co.uk');
  });

  it('geçersiz URL için boş döner', () => {
    expect(registrableDomain('not a url')).toBe('');
  });
});

describe('extractLinks', () => {
  it('href ve anchor metnini birlikte çıkarır', () => {
    const html = `<a href="https://a.com/verify?t=abc">Confirm your email</a>`;
    expect(extractLinks(html)).toEqual([
      { url: 'https://a.com/verify?t=abc', text: 'Confirm your email' },
    ]);
  });

  it('HTML entity kodlanmış &amp; işaretlerini çözer', () => {
    const html = `<a href="https://a.com/v?x=1&amp;y=2">go</a>`;
    expect(extractLinks(html)[0]?.url).toBe('https://a.com/v?x=1&y=2');
  });

  it('anchor içindeki iç etiketleri temizler', () => {
    const html = `<a href="https://a.com/verify"><span>Verify</span> now</a>`;
    expect(extractLinks(html)[0]?.text).toBe('Verify now');
  });
});

describe('extractBareUrls', () => {
  it('düz metinden URL çıkarır ve sondaki noktalamayı atar', () => {
    expect(extractBareUrls('Git: https://a.com/verify/abc123.')).toEqual([
      'https://a.com/verify/abc123',
    ]);
  });
});

describe('scoreLinks', () => {
  it('unsubscribe ve sosyal linkleri tamamen eler', () => {
    const links = [
      { url: 'https://a.com/unsubscribe/xyz', text: 'Unsubscribe' },
      { url: 'https://twitter.com/geo_new', text: 'Follow us' },
      { url: 'https://a.com/verify/abcdef1234567890xyz', text: 'Verify' },
    ];
    const scored = scoreLinks(links, 'a.com');
    expect(scored).toHaveLength(1);
    expect(scored[0]?.url).toContain('/verify/');
  });

  it('aynı URL birden fazla anchor\'da geçtiğinde tek aday sayar (gerçek AlternativeTo mailinde bulundu)', () => {
    // Buton hem "Confirm my e-mail" metniyle hem de çıplak URL olarak tekrar
    // ediyordu; tekilleştirme olmadan bu "iki eşit skorlu aday" sayılıp
    // yanlışlıkla ManualReviewError'a düşüyordu.
    const url = 'https://alternativeto.net/api/auth/verify-email?token=abc123def456xyz';
    const links = [
      { url, text: 'Confirm my e-mail' },
      { url, text: url }, // aynı link çıplak metin olarak tekrar
    ];
    const scored = scoreLinks(links, 'alternativeto.net');
    expect(scored).toHaveLength(1);
    expect(scored[0]?.url).toBe(url);
  });

  it('doğrulama linkini pazarlama linkinin üstüne skorlar', () => {
    const links = [
      { url: 'https://a.com/pricing', text: 'See pricing' },
      { url: 'https://a.com/confirm/tok_abcdef1234567890', text: 'Confirm email' },
    ];
    const scored = scoreLinks(links, 'a.com');
    expect(scored[0]?.url).toContain('/confirm/');
  });
});

describe('extractVerificationLink', () => {
  it('linkPattern verildiğinde onu kullanır', () => {
    const m = msg({
      text: 'Onayla: https://alternativeto.net/account/confirm?t=abc123def456',
    });
    const url = extractVerificationLink(m, {
      mode: 'link',
      linkPattern: 'https://alternativeto\\.net/account/confirm[^\\s"\'<>]*',
    });
    expect(url).toBe('https://alternativeto.net/account/confirm?t=abc123def456');
  });

  it('linkPattern eşleşmezse ManualReviewError fırlatır', () => {
    const m = msg({ text: 'Hiç link yok' });
    expect(() =>
      extractVerificationLink(m, { mode: 'link', linkPattern: 'https://x\\.com/verify' }),
    ).toThrow(ManualReviewError);
  });

  it('pattern yoksa generic skorlamayla doğru linki seçer', () => {
    const m = msg({
      html: `
        <a href="https://stackshare.io/unsubscribe/abc">Unsubscribe</a>
        <a href="https://stackshare.io/users/activate/tok_9f8e7d6c5b4a3210">Activate account</a>
        <a href="https://twitter.com/stackshare">Twitter</a>`,
    });
    const url = extractVerificationLink(m, { mode: 'link' }, 'stackshare.io');
    expect(url).toContain('/users/activate/');
  });

  it('tracker linkini olduğu gibi döndürür (URL cerrahisi yapmaz)', () => {
    const m = msg({
      html: `<a href="https://ct.sendgrid.net/ls/click?upn=abcdef1234567890xyz">Verify your email</a>`,
    });
    const url = extractVerificationLink(m, { mode: 'link' });
    expect(url).toContain('ct.sendgrid.net');
  });

  it('hiç aday yoksa ManualReviewError fırlatır', () => {
    const m = msg({ html: `<a href="https://twitter.com/x">Follow</a>` });
    expect(() => extractVerificationLink(m, { mode: 'link' })).toThrow(ManualReviewError);
  });

  it('eşit skorlu iki aday varsa belirsizlik olarak escalate eder', () => {
    const m = msg({
      html: `
        <a href="https://a.com/verify/aaaaaaaaaaaaaaaaaa">x</a>
        <a href="https://a.com/verify/bbbbbbbbbbbbbbbbbb">y</a>`,
    });
    expect(() => extractVerificationLink(m, { mode: 'link' })).toThrow(ManualReviewError);
  });
});

describe('extractVerificationCode', () => {
  it('ipuçlu satırdaki kodu seçer', () => {
    const m = msg({ text: 'Merhaba\nDoğrulama kodunuz: 483920\nTeşekkürler' });
    expect(extractVerificationCode(m)).toBe('483920');
  });

  it('konudaki kodu en yüksek ağırlıkla seçer', () => {
    const m = msg({ subject: 'Your code is 771234', text: 'Founded in 2025 by the team' });
    expect(extractVerificationCode(m)).toBe('771234');
  });

  it('yılları kod sanmaz', () => {
    const m = msg({ text: 'Copyright 2026\nYour PIN: 5566' });
    expect(extractVerificationCode(m)).toBe('5566');
  });

  it('kod yoksa ManualReviewError fırlatır', () => {
    expect(() => extractVerificationCode(msg({ text: 'kod yok' }))).toThrow(ManualReviewError);
  });
});

describe('domainOfAddress', () => {
  it('düz e-posta adresinden domain çıkarır', () => {
    expect(domainOfAddress('noreply@alternativeto.net')).toBe('alternativeto.net');
  });

  it('"İsim <adres>" formatından domain çıkarır', () => {
    expect(domainOfAddress('"AlternativeTo" <noreply@alternativeto.net>')).toBe(
      'alternativeto.net',
    );
  });

  it('alt domainleri eTLD+1e indirger', () => {
    expect(domainOfAddress('mail@notifications.g2.com')).toBe('g2.com');
  });
});

describe('isVerificationCandidate — tek e-posta ile mail eşleştirmesi', () => {
  // Senaryo: tüm siteler AYNI adrese kaydolduğu için `to:` ayrım sağlamıyor.
  // Eşleştirme from-domain + kayıt sonrası zaman penceresine dayanıyor.
  const submittedAt = Date.parse('2026-09-19T10:00:00Z');

  it('doğru site domaininden, kayıttan sonra gelen maili kabul eder', () => {
    const m = msg({
      from: 'noreply@alternativeto.net',
      receivedAt: submittedAt + 30_000,
    });
    expect(
      isVerificationCandidate(m, { mode: 'link' }, { siteDomain: 'alternativeto.net', submittedAt }),
    ).toBe(true);
  });

  it('başka bir siteden aynı anda gelen maili reddeder (çakışma senaryosu)', () => {
    // İki site art arda işlense bile from-domain ayrımı kimin mailinin
    // kime ait olduğunu netleştiriyor.
    const m = msg({
      from: 'noreply@stackshare.io',
      receivedAt: submittedAt + 30_000,
    });
    expect(
      isVerificationCandidate(m, { mode: 'link' }, { siteDomain: 'alternativeto.net', submittedAt }),
    ).toBe(false);
  });

  it('kayıttan önce gelen maili reddeder (bayat/alakasız mail)', () => {
    const m = msg({
      from: 'noreply@alternativeto.net',
      receivedAt: submittedAt - 5 * 60_000,
    });
    expect(
      isVerificationCandidate(m, { mode: 'link' }, { siteDomain: 'alternativeto.net', submittedAt }),
    ).toBe(false);
  });

  it('spec.from verilmişse siteDomain yerine onu kullanır', () => {
    const m = msg({ from: 'notifications@mail.g2.com', receivedAt: submittedAt + 10_000 });
    expect(
      isVerificationCandidate(
        m,
        { mode: 'link', from: '*@g2.com' },
        { siteDomain: 'g2.com', submittedAt },
      ),
    ).toBe(true);
  });

  it('subjectContains verilmişse konuyu da kontrol eder', () => {
    const m = msg({
      from: 'noreply@alternativeto.net',
      subject: 'Welcome to the newsletter',
      receivedAt: submittedAt + 10_000,
    });
    expect(
      isVerificationCandidate(
        m,
        { mode: 'link', subjectContains: ['confirm', 'verify'] },
        { siteDomain: 'alternativeto.net', submittedAt },
      ),
    ).toBe(false);
  });
});
