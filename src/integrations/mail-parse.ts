/**
 * Doğrulama maili ayrıştırma.
 *
 * Gmail API'den bağımsız tutuldu: saf fonksiyonlar, gerçek .eml örneklerine
 * karşı test edilebilir. Bu korpus projenin en değerli test varlığı (§10).
 */

import { ManualReviewError } from '../core/errors.js';
import type { VerificationSpec } from '../core/types.js';

export interface ParsedMessage {
  id: string;
  from: string;
  subject: string;
  text: string;
  html: string;
  /** Gmail internalDate — epoch ms. Zaman penceresi eşleştirmesi için gerekli. */
  receivedAt: number;
}

/**
 * Mesajın bu siteye ait doğrulama maili olup olmadığını kontrol eder.
 *
 * Tek e-posta adresi tüm sitelere kaydolunduğu için `to:` ile ayrım
 * yapılamıyor — eşleştirme `from:<site domain>` + kayıt sonrası zaman
 * penceresine dayanıyor. Siteler sıralı işlendiği için (aynı anda tek site)
 * çakışma riski düşük, ama sıfır değil: iki site art arda kısa sürede mail
 * atarsa `from` alanı asıl ayırt edici olur.
 */
export function isVerificationCandidate(
  msg: ParsedMessage,
  spec: VerificationSpec,
  opts: { siteDomain: string; submittedAt: number },
): boolean {
  if (msg.receivedAt < opts.submittedAt - 60_000) return false; // kayıttan önceki mail olamaz

  const fromDomain = domainOfAddress(msg.from);
  const expected = spec.from ? domainOfAddress(spec.from.replace(/^\*@/, 'x@')) : opts.siteDomain;
  if (fromDomain && expected && fromDomain !== expected) return false;

  if (spec.subjectContains?.length) {
    const subj = msg.subject.toLowerCase();
    if (!spec.subjectContains.some((s) => subj.includes(s.toLowerCase()))) return false;
  }

  return true;
}

/** Doğrulama linki olamayacak hostlar / uzantılar. */
const NOISE_PATTERNS = [
  /unsubscribe|opt[-_]?out|preferences|manage[-_]?subscription/i,
  /list-manage\.com|mailchimp|sendgrid\.net\/wf|constantcontact/i,
  /twitter\.com|x\.com|facebook\.com|linkedin\.com|instagram\.com|youtube\.com/i,
  /\.(png|jpe?g|gif|svg|css|ico|webp)(\?|$)/i,
  /privacy|terms|legal|help|support|contact|blog/i,
];

/** Doğrulama anlamı taşıyan path kalıpları. */
const VERIFY_PATH = /\/(verify|confirm|activate|validate|email[-_]?confirm|confirmation|activation|dogrula)/i;

/** Uzun token segmenti — doğrulama linklerinin ayırt edici işareti. */
const TOKEN_SEGMENT = /[A-Za-z0-9_-]{16,}/;

/** Anchor metni doğrulama çağrısı mı? */
const VERIFY_TEXT = /verify|confirm|activate|validate|doğrula|dogrula|onayla|aktivasyon/i;

/** HTML'den href + anchor metni çiftlerini çıkarır. */
export function extractLinks(html: string): Array<{ url: string; text: string }> {
  const out: Array<{ url: string; text: string }> = [];
  const re = /<a\b[^>]*?href\s*=\s*["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>/gi;
  let m: RegExpExecArray | null;
  while ((m = re.exec(html)) !== null) {
    const url = decodeEntities(m[1] ?? '').trim();
    const text = stripTags(m[2] ?? '').trim();
    if (url.startsWith('http')) out.push({ url, text });
  }
  return out;
}

/** text/plain gövdesinden çıplak URL'leri çıkarır. */
export function extractBareUrls(text: string): string[] {
  const re = /https?:\/\/[^\s<>"')\]]+/gi;
  return (text.match(re) ?? []).map((u) => u.replace(/[.,;:]+$/, ''));
}

function stripTags(s: string): string {
  return decodeEntities(s.replace(/<[^>]*>/g, ' ')).replace(/\s+/g, ' ');
}

function decodeEntities(s: string): string {
  return s
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#(\d+);/g, (_, d: string) => String.fromCharCode(Number(d)))
    .replace(/&#x([0-9a-f]+);/gi, (_, h: string) => String.fromCharCode(parseInt(h, 16)));
}

function isNoise(url: string, text: string): boolean {
  return NOISE_PATTERNS.some((re) => re.test(url) || re.test(text));
}

/** Hostname'i kayıtlanabilir domain'e indirger (eTLD+1 yaklaşımı). */
function registrableDomainFromHost(host: string): string {
  const parts = host.toLowerCase().split('.');
  if (parts.length <= 2) return host.toLowerCase();
  // co.uk, com.tr gibi ikili son ekler için bir seviye daha al.
  const twoLevel = /^(co|com|net|org|gov|edu|ac)\.[a-z]{2}$/;
  const lastTwo = parts.slice(-2).join('.');
  return twoLevel.test(lastTwo) ? parts.slice(-3).join('.') : lastTwo;
}

/** URL'in kayıtlanabilir domain'ini kabaca çıkarır (eTLD+1 yaklaşımı). */
export function registrableDomain(url: string): string {
  try {
    return registrableDomainFromHost(new URL(url).hostname);
  } catch {
    return '';
  }
}

/**
 * "Site Name" <noreply@site.com> ya da düz noreply@site.com formatındaki
 * bir gönderen alanından kayıtlanabilir domain'i çıkarır.
 */
export function domainOfAddress(address: string): string {
  const match = /<([^>]+)>/.exec(address);
  const raw = (match?.[1] ?? address).trim();
  const host = raw.split('@').pop();
  if (!host) return '';
  return registrableDomainFromHost(host);
}

interface ScoredLink {
  url: string;
  score: number;
}

/**
 * Linkleri doğrulama-linki olma olasılığına göre skorlar.
 *
 * Tracker linklerini (sendgrid, mailgun) AÇMAYA ÇALIŞMAZ — sarmalanmış URL
 * Playwright'ta açılıp redirect'in çözmesi URL cerrahisinden çok daha sağlam.
 */
export function scoreLinks(
  links: Array<{ url: string; text: string }>,
  siteDomain?: string,
): ScoredLink[] {
  const scored: ScoredLink[] = [];

  for (const { url, text } of links) {
    if (isNoise(url, text)) continue;

    let score = 0;
    if (VERIFY_PATH.test(url)) score += 3;
    if (TOKEN_SEGMENT.test(new URL(url, 'https://x.invalid').pathname + (url.split('?')[1] ?? ''))) {
      score += 3;
    }
    if (siteDomain && registrableDomain(url) === siteDomain) score += 2;
    if (VERIFY_TEXT.test(text)) score += 2;

    if (score > 0) scored.push({ url, score });
  }

  return scored.sort((a, b) => b.score - a.score);
}

/**
 * Maildan doğrulama linkini çıkarır.
 *
 * Sıra: (1) linkPattern regex'i → (2) generic skorlama.
 * İlk iki aday eşit skordaysa belirsizlik var demektir → ManualReviewError.
 */
export function extractVerificationLink(
  msg: ParsedMessage,
  spec: VerificationSpec,
  siteDomain?: string,
): string {
  if (spec.linkPattern) {
    const re = new RegExp(spec.linkPattern);
    const fromText = re.exec(msg.text);
    if (fromText?.[0]) return fromText[0];

    for (const { url } of extractLinks(msg.html)) {
      if (re.test(url)) return url;
    }
    throw new ManualReviewError('linkPattern maildeki hiçbir linkle eşleşmedi', {
      messageId: msg.id,
      pattern: spec.linkPattern,
    });
  }

  const htmlLinks = extractLinks(msg.html);
  const textLinks = extractBareUrls(msg.text).map((url) => ({ url, text: '' }));
  const all = [...htmlLinks, ...textLinks];

  const scored = scoreLinks(all, siteDomain);
  if (scored.length === 0) {
    throw new ManualReviewError('Mailde doğrulama linki bulunamadı', { messageId: msg.id });
  }

  const [first, second] = scored;
  if (second && first && first.score === second.score) {
    throw new ManualReviewError('Doğrulama linki belirsiz — eşit skorlu iki aday', {
      messageId: msg.id,
      candidates: [first.url, second.url],
    });
  }

  return first!.url;
}

/** Kod satırı ipuçları — sayının doğrulama kodu olma olasılığını artırır. */
const CODE_HINT = /code|kod|pin|otp|token|doğrulama|dogrulama|verification/i;

/**
 * Maildan doğrulama kodunu çıkarır.
 * Yıl (1900-2100) ve telefon benzeri uzun diziler elenir.
 */
export function extractVerificationCode(msg: ParsedMessage): string {
  const body = msg.text || stripTags(msg.html);
  const lines = body.split(/\r?\n/);

  const candidates: Array<{ code: string; weight: number }> = [];

  for (const line of lines) {
    const hinted = CODE_HINT.test(line);
    for (const m of line.matchAll(/\b(\d{4,8})\b/g)) {
      const code = m[1]!;
      const n = Number(code);
      if (code.length === 4 && n >= 1900 && n <= 2100) continue; // yıl
      candidates.push({ code, weight: hinted ? 2 : 1 });
    }
  }

  // Konuda da kod olabilir, orası güçlü bir ipucu.
  for (const m of msg.subject.matchAll(/\b(\d{4,8})\b/g)) {
    candidates.push({ code: m[1]!, weight: 3 });
  }

  if (candidates.length === 0) {
    throw new ManualReviewError('Mailde doğrulama kodu bulunamadı', { messageId: msg.id });
  }

  candidates.sort((a, b) => b.weight - a.weight);
  return candidates[0]!.code;
}
