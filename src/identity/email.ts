/**
 * Tek sabit e-posta adresi — TÜM sitelere aynı adresle kaydolunuyor.
 *
 * Bilinçli tercih: kurumsal domain (noderan.com) yerine kullanılmayan
 * bireysel bir Gmail hesabı kullanılıyor; kurulum daha basit (DNS/Workspace
 * admin erişimi gerekmiyor, sade OAuth yeterli) ve kurumsal domain'in spam
 * itibarı hiç risk altına girmiyor.
 *
 * Sonuç: mail eşleştirmesi artık `to:` adresine göre değil, `from:<site
 * domain>` + zaman penceresine göre yapılıyor (integrations/gmail.ts).
 * Siteler sıralı işlendiği için (aynı anda tek site) çakışma riski düşük.
 */

/** Sabit kayıt adresini döndürür. Tek doğrulama noktası — .env'den okunur. */
export function signupEmail(fixedAddress: string): string {
  if (!fixedAddress) {
    throw new Error('SIGNUP_EMAIL tanımsız — .env dosyasını kontrol et');
  }
  if (!fixedAddress.includes('@')) {
    throw new Error(`SIGNUP_EMAIL geçerli bir adres değil: "${fixedAddress}"`);
  }
  return fixedAddress;
}

/** Site id'sini kullanıcı adı üretimi için güvenli bir slug'a çevirir. */
export function slugifySiteId(raw: string): string {
  const slug = raw
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');

  if (!slug) throw new Error(`Geçersiz site id: "${raw}"`);
  return slug;
}

/**
 * Kullanıcı adı üretir. E-posta sabit olduğu için ayrımı username taşıyor —
 * çoğu site alfanumerik + alt çizgi kabul eder.
 */
export function usernameForSite(base: string, siteId: string, style: 'default' | 'plain' = 'default'): string {
  const suffix = slugifySiteId(siteId).replace(/-/g, '').slice(0, 8);
  const root = base.toLowerCase().replace(/[^a-z0-9]/g, '');
  // 'plain': yalnızca harf ve rakam (bazı siteler "Username cannot contain special characters" der, alt çizgi dahil).
  return (style === 'plain' ? `${root}${suffix}` : `${root}_${suffix}`).slice(0, 30);
}
