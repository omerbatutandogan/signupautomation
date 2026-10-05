/**
 * Website URL'inden site id üretir: "alternativeto.net" → "alternativeto"
 *
 * Aynı markanın farklı ülke siteleri AYRI id alır: webwiki.de → "webwiki-de",
 * webwiki.fr → "webwiki-fr". Bunlar ayrı dizinler ve her birine ayrı kayıt
 * olunabiliyor; hepsini "webwiki" saymak 7 siteyi sessizce yutuyordu
 * (Sheet'te 8 webwiki satırı var, yalnızca biri işleniyordu).
 *
 * Ana TLD'ler (.com/.net/.org/.io/...) sonek ALMAZ — mevcut config'lerin
 * id'si değişmesin diye.
 */
const GENERIC_TLDS = new Set([
  'com',
  'net',
  'org',
  'io',
  'co',
  'app',
  'dev',
  'ai',
  'me',
  'directory',
  'tools',
  'so',
  'xyz',
]);

export function siteIdFromWebsite(website: string): string {
  const host = website
    .replace(/^https?:\/\//i, '')
    .replace(/^www\./i, '')
    .split('/')[0]
    ?.toLowerCase();
  if (!host) return '';
  // İlk etiketi al: "portal.10words.io" → "10words" değil, "portal" olurdu;
  // bu yüzden eTLD'yi atıp en anlamlı etiketi seçiyoruz.
  const labels = host.split('.');
  const meaningful = labels.length > 2 ? labels[labels.length - 2] : labels[0];
  const base = (meaningful ?? '').replace(/[^a-z0-9-]/g, '');
  if (!base) return '';

  const tld = labels[labels.length - 1] ?? '';
  if (GENERIC_TLDS.has(tld) || !/^[a-z]{2,}$/.test(tld)) return base;
  return `${base}-${tld}`;
}
