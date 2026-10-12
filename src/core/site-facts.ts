/**
 * Ürünün KENDİ sitesinin kendini nasıl anlattığı — yayınlanacak profil metniyle karşılaştırmak için.
 *
 * Neden var: geo.new'in profili ürünün adından tahmin edilerek yazılmıştı ("geolokasyon API'si"), oysa site
 * kendini "AI aramasında sayfayı denetleyen ücretsiz GEO audit aracı" olarak tanıtıyor. Hata 3 haftadan uzun
 * süre fark edilmedi, insan onayından bile geçti (onay ekranı yalnızca profilin kendi metnini gösteriyordu) ve
 * gerçek bir listelemeye yayıldı. Onay ekranı artık sitenin kendi başlığını/açıklamasını yan yana gösterir ve
 * ikisi birbirine hiç benzemiyorsa bilinçli bir ek onay ister.
 *
 * Bu yalnızca ürünün kendi ana sayfasına tek bir GET'tir; hiçbir yazan istek yapılmaz.
 */

export interface SiteFacts {
  url: string;
  title: string | null;
  description: string | null;
  /** Sayfadaki ilk <h1> (etiketsiz metin). */
  headline: string | null;
}

/** Sitenin tek bir sayfasından okunacak en fazla bayt (ağır sayfaların başlığı zaten baştadır). */
const MAX_HTML_CHARS = 600_000;

const NAMED: Record<string, string> = {
  amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ',
  mdash: '—', ndash: '–', hellip: '…', lsquo: '‘', rsquo: '’', ldquo: '“', rdquo: '”', middot: '·', bull: '•', copy: '©', trade: '™',
};

function decodeEntities(text: string): string {
  return text
    .replace(/&#x([0-9a-f]+);/gi, (_, hex: string) => String.fromCodePoint(parseInt(hex, 16)))
    .replace(/&#(\d+);/g, (_, dec: string) => String.fromCodePoint(Number(dec)))
    .replace(/&([a-z]+);/gi, (m, name: string) => NAMED[name.toLowerCase()] ?? m);
}

const clean = (text: string | undefined | null): string | null => {
  if (!text) return null;
  const out = decodeEntities(text.replace(/<[^>]*>/g, ' ')).replace(/\s+/g, ' ').trim();
  return out === '' ? null : out;
};

/** `<meta …>` etiketinin özniteliklerini (sıradan bağımsız) okur. */
function metaAttributes(tag: string): Record<string, string> {
  const attrs: Record<string, string> = {};
  for (const m of tag.matchAll(/([a-zA-Z:_-]+)\s*=\s*(?:"([^"]*)"|'([^']*)')/g)) {
    attrs[(m[1] ?? '').toLowerCase()] = m[2] ?? m[3] ?? '';
  }
  return attrs;
}

export function extractSiteFacts(html: string, url: string): SiteFacts {
  const metas = Array.from(html.matchAll(/<meta\b[^>]*>/gi)).map((m) => metaAttributes(m[0]));
  const meta = (key: 'name' | 'property', value: string): string | null =>
    clean(metas.find((a) => (a[key] ?? '').toLowerCase() === value)?.content);

  return {
    url,
    title: clean(/<title[^>]*>([\s\S]*?)<\/title>/i.exec(html)?.[1]),
    description: meta('name', 'description') ?? meta('property', 'og:description'),
    headline: clean(/<h1[^>]*>([\s\S]*?)<\/h1>/i.exec(html)?.[1]),
  };
}

/** Ürünün ana sayfasını okur; ulaşılamıyorsa (ağ, 4xx/5xx, zaman aşımı) `null` — karar insanda kalır. */
export async function fetchSiteFacts(
  url: string,
  opts: { fetch?: typeof fetch; timeoutMs?: number } = {},
): Promise<SiteFacts | null> {
  const doFetch = opts.fetch ?? fetch;
  try {
    const res = await doFetch(url, {
      redirect: 'follow',
      signal: AbortSignal.timeout(opts.timeoutMs ?? 15_000),
      headers: { accept: 'text/html', 'user-agent': 'Mozilla/5.0 (compatible; signupautomation-profile-check)' },
    });
    if (!res.ok) return null;
    return extractSiteFacts((await res.text()).slice(0, MAX_HTML_CHARS), res.url || url);
  } catch {
    return null;
  }
}

/** İngilizce işlev sözcükleri: benzerlik ölçerken anlam taşımazlar. */
const STOPWORDS = new Set(
  ('that this with from your yours into have been will also more than then they them their what when which while where about over only just like make made many much such some each both very even here there these those ' +
    'would could should using used uses does done being were your ours must best most other another every').split(' '),
);

function vocabulary(text: string): Set<string> {
  const words = text
    .toLowerCase()
    .split(/[^\p{L}\p{N}]+/u)
    .filter((w) => w.length >= 4 && !STOPWORDS.has(w));
  return new Set(words);
}

/** Bu orandan azı ortak sözcük: profil sitenin kendi anlatımından "farklı" sayılır. */
export const SITE_OVERLAP_MIN = 0.3;

/**
 * Sitenin kendi anlatımındaki anlamlı sözcüklerin ne kadarı profilde de geçiyor (0–1)?
 * Site yeterince metin vermiyorsa (JS ile çizilen boş sayfa vb.) `null`: karşılaştırılamaz, ceza yok.
 */
export function siteOverlap(
  profile: { tagline: string; descriptions: { short: string; medium: string; long: string } },
  facts: SiteFacts,
): number | null {
  const site = vocabulary([facts.title, facts.description, facts.headline].filter(Boolean).join(' '));
  if (site.size < 3) return null;
  const own = vocabulary([profile.tagline, profile.descriptions.short, profile.descriptions.medium, profile.descriptions.long].join(' '));
  let shared = 0;
  for (const word of site) if (own.has(word)) shared++;
  return shared / site.size;
}
