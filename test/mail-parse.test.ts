import { describe, expect, it } from 'vitest';
import {
  extractBareUrls,
  extractLinks,
  extractVerificationCode,
  extractVerificationLink,
  registrableDomain,
  scoreLinks,
  type ParsedMessage,
} from '../src/integrations/mail-parse.js';
import { ManualReviewError } from '../src/core/errors.js';

function msg(partial: Partial<ParsedMessage>): ParsedMessage {
  return { id: 'm1', from: 'noreply@example.com', subject: '', text: '', html: '', ...partial };
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
