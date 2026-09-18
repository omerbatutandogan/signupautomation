/**
 * Catch-all subdomain adresleri: <site-id>@signup.noderan.com
 *
 * Artı-adresleme (signups+g2@…) KULLANILMIYOR: formlar '+' işaretini
 * validation hatası ya da kasıtlı çoklu-hesap engeli olarak reddediyor,
 * platformlar da '+' sonrasını normalize edip siliyor.
 */

const MAX_LOCAL_PART = 64; // RFC 5321

/** Site id'sini güvenli bir e-posta local-part'ına çevirir. */
export function slugifyLocalPart(raw: string): string {
  const slug = raw
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, MAX_LOCAL_PART);

  if (!slug) throw new Error(`Geçersiz e-posta local-part kaynağı: "${raw}"`);
  return slug;
}

/** Site için catch-all adresi üretir. */
export function emailForSite(domain: string, localPart: string): string {
  if (!domain) throw new Error('EMAIL_DOMAIN tanımsız — .env dosyasını kontrol et');
  if (domain.includes('@')) {
    throw new Error(`EMAIL_DOMAIN sadece domain olmalı, adres değil: "${domain}"`);
  }
  return `${slugifyLocalPart(localPart)}@${domain}`;
}

/**
 * Kullanıcı adı üretir. Çoğu site alfanumerik + alt çizgi kabul eder,
 * tire kabul etmeyenler yaygın olduğu için tireler alt çizgiye çevrilir.
 */
export function usernameForSite(base: string, siteId: string): string {
  const suffix = slugifyLocalPart(siteId).replace(/-/g, '').slice(0, 8);
  const root = base.toLowerCase().replace(/[^a-z0-9]/g, '');
  return `${root}_${suffix}`.slice(0, 30);
}
