/**
 * Deterministik şifre türetme.
 *
 * Şifre hiçbir yerde saklanmaz — MASTER_SECRET + siteId + version'dan
 * yeniden üretilir. Kasa yok, senkronizasyon yok, data/ kaybı kritik değil.
 *
 * version ilk günden dahil: zorunlu şifre sıfırlamasında v2'ye bump edilir.
 * Bu olmadan türetme çıkmaz sokaktır.
 */

import { createHmac } from 'node:crypto';
import type { SiteConfig } from '../core/types.js';

export interface PasswordPolicy {
  maxLen?: number;
  noSymbols?: boolean;
  allowedSymbols?: string;
}

const PREFIX = 'Gn';
const SUFFIX = '!7';
/** base64url gövde uzunluğu — toplam 22 karakter eder. */
const BODY_LEN = 18;

/**
 * Site için şifre türetir.
 *
 * Varsayılan çıktı 22 karakter: büyük harf, küçük harf, rakam ve sembol
 * içerir — pratikte her site politikasını geçer.
 */
export function derivePassword(
  masterSecret: string,
  siteId: string,
  version = 1,
  policy?: PasswordPolicy,
): string {
  if (!masterSecret) {
    throw new Error('MASTER_SECRET tanımsız — .env dosyasını kontrol et');
  }

  const mac = createHmac('sha256', masterSecret)
    .update(`geo.new|${siteId}|v${version}`)
    .digest();

  const body = mac.toString('base64url').replace(/[-_]/g, '').slice(0, BODY_LEN);

  if (policy?.noSymbols) {
    // Sembol kabul etmeyen siteler: harf+rakam, büyük/küçük garantili.
    const plain = `Gn${body}7`;
    return applyMaxLen(plain, policy.maxLen);
  }

  if (policy?.allowedSymbols) {
    const sym = policy.allowedSymbols[0] ?? '!';
    return applyMaxLen(`${PREFIX}${body}${sym}7`, policy.maxLen);
  }

  return applyMaxLen(`${PREFIX}${body}${SUFFIX}`, policy?.maxLen);
}

/**
 * maxLen uygularken karakter çeşitliliğini korur: baştan değil ortadan kırpar,
 * böylece prefix (büyük+küçük harf) ve suffix (sembol+rakam) korunur.
 */
function applyMaxLen(pw: string, maxLen?: number): string {
  if (!maxLen || pw.length <= maxLen) return pw;
  if (maxLen < 8) {
    throw new Error(`Şifre politikası çok kısıtlayıcı: maxLen=${maxLen}`);
  }
  const tail = SUFFIX.length;
  const head = PREFIX.length;
  const keep = maxLen - head - tail;
  return pw.slice(0, head + keep) + pw.slice(-tail);
}

/** SiteConfig'ten politikayı okuyup şifre türetir. */
export function derivePasswordForSite(
  masterSecret: string,
  site: Pick<SiteConfig, 'id' | 'passwordPolicy'>,
  version = 1,
): string {
  return derivePassword(masterSecret, site.id, version, site.passwordPolicy);
}
