import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { extractSiteFacts, fetchSiteFacts, SITE_OVERLAP_MIN, siteOverlap, type SiteFacts } from '../src/core/site-facts.js';
import { loadProfile } from '../src/identity/profile.js';

/**
 * Ürünün KENDİ sitesinin anlatımı ile yayınlanacak profilin karşılaştırılması.
 *
 * Gerçek vaka: geo.new'in profili adından tahminle "geolokasyon API'si" diye yazılmıştı; site ise kendini
 * "AI aramasında sayfayı denetleyen ücretsiz GEO audit aracı" olarak tanıtıyor. Aşağıdaki iki metin o vakanın
 * birebir kopyasıdır: ölçüt, yanlış profili yakalamalı, doğru profili susturmalı.
 */

/** geo.new'in kendi sayfasından (12 Ekim 2026): <title>, meta description, <h1>. */
const GEO_NEW: SiteFacts = {
  url: 'https://geo.new/',
  title: 'GEO.new — Free GEO Audit for AI Search',
  description:
    'An AI-native GEO audit for AI search. See what ChatGPT, Perplexity and AI Overviews read on your page, and exactly what to fix first. Free, no signup.',
  headline: 'Free GEO audit: see your page the way AI search does.',
};

/** Ürünü adından tahmin ederek yazılmış ESKİ profil metni (yanlış). */
const WRONG_PROFILE = {
  tagline: 'Instant geolocation data for any address',
  descriptions: {
    short: 'Instant geolocation and address data through a simple API.',
    medium: 'geo.new turns any address into structured geolocation data with a single API call. Fast, accurate, and built for developers.',
    long: 'geo.new is a developer-first geolocation API that turns any address into structured, accurate location data with a single request. It handles address parsing, normalization, geocoding and reverse geocoding, returning clean JSON you can use immediately.',
  },
};

describe('extractSiteFacts', () => {
  it('başlık, meta açıklama ve ana başlığı okur; varlıkları çözer, etiketleri ve boşlukları temizler', () => {
    const html = `<!doctype html><html><head>
      <title>
        GEO.new &mdash; Free &amp; Fast  </title>
      <meta name="description" content="Audit &quot;one&quot; page &#x27;fast&#x27;.">
      </head><body><h1 class="hero">Free <em>GEO</em>
        audit</h1><h1>ikinci</h1></body></html>`;
    expect(extractSiteFacts(html, 'https://x.example')).toEqual({
      url: 'https://x.example',
      title: 'GEO.new — Free & Fast',
      description: 'Audit "one" page \'fast\'.',
      headline: 'Free GEO audit',
    });
  });

  it('meta özniteliklerinin sırası ve tırnak biçimi fark etmez; description yoksa og:description kullanılır', () => {
    expect(extractSiteFacts(`<meta content='Sıra tersine' name='description'>`, 'u').description).toBe('Sıra tersine');
    expect(extractSiteFacts(`<meta property="og:description" content="Sosyal açıklama">`, 'u').description).toBe('Sosyal açıklama');
    expect(extractSiteFacts(`<meta name="description" content="Asıl"><meta property="og:description" content="Sosyal">`, 'u').description).toBe('Asıl');
  });

  it('bulunmayan alan null olur (hata fırlatmaz)', () => {
    expect(extractSiteFacts('<html><body>boş</body></html>', 'u')).toEqual({ url: 'u', title: null, description: null, headline: null });
    expect(extractSiteFacts('<title>   </title><meta name="description" content="">', 'u')).toMatchObject({ title: null, description: null });
  });

  it('bilinmeyen adlandırılmış varlık olduğu gibi kalır; çift çözme yapılmaz (&amp;lt; → &lt;)', () => {
    expect(extractSiteFacts('<title>a &foo; b &amp;lt; c</title>', 'u').title).toBe('a &foo; b &lt; c');
  });
});

describe('siteOverlap — profil sitenin kendi anlatımıyla örtüşüyor mu?', () => {
  it('ürünü adından tahminle yazılmış YANLIŞ profili yakalar (eşiğin çok altında)', () => {
    const overlap = siteOverlap(WRONG_PROFILE, GEO_NEW);
    expect(overlap).not.toBeNull();
    expect(overlap as number).toBeLessThan(SITE_OVERLAP_MIN);
  });

  it('sitenin kendi metninden yazılmış DOĞRU (güncel) profili onaylar', async () => {
    const overlap = siteOverlap(await loadProfile('geo-new'), GEO_NEW);
    expect(overlap as number).toBeGreaterThanOrEqual(0.6);
  });

  it('kontrol: eşik yalnızca farklı metni ayırır — aynı metin %100 örtüşür', () => {
    const same = { tagline: GEO_NEW.title as string, descriptions: { short: GEO_NEW.description as string, medium: GEO_NEW.headline as string, long: '' } };
    expect(siteOverlap(same, GEO_NEW)).toBe(1);
  });

  it('site yeterli metin vermiyorsa karşılaştırılamaz (null: ceza yok)', () => {
    expect(siteOverlap(WRONG_PROFILE, { url: 'u', title: 'Home', description: null, headline: null })).toBeNull();
    expect(siteOverlap(WRONG_PROFILE, { url: 'u', title: null, description: null, headline: null })).toBeNull();
  });
});

describe('fetchSiteFacts', () => {
  let server: Server;
  let base: string;

  beforeAll(async () => {
    server = createServer((req, res) => {
      if (req.url === '/ok') {
        res.setHeader('content-type', 'text/html');
        res.end('<title>Yerel Site</title><meta name="description" content="Yerel açıklama"><h1>Merhaba</h1>');
      } else if (req.url === '/yonlen') {
        res.writeHead(302, { location: '/ok' });
        res.end();
      } else if (req.url === '/yavas') {
        // Yanıt hiç gelmez: zaman aşımı sınanır.
      } else {
        res.statusCode = 404;
        res.end('yok');
      }
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });

  afterAll(async () => {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  it('sayfayı okur, yönlendirmeyi izler ve son adresi bildirir', async () => {
    expect(await fetchSiteFacts(`${base}/ok`)).toEqual({ url: `${base}/ok`, title: 'Yerel Site', description: 'Yerel açıklama', headline: 'Merhaba' });
    expect((await fetchSiteFacts(`${base}/yonlen`))?.url).toBe(`${base}/ok`);
  });

  it('ulaşılamayan her durumda null döner: 404, kapalı port, zaman aşımı', async () => {
    expect(await fetchSiteFacts(`${base}/yok`)).toBeNull();
    expect(await fetchSiteFacts('http://127.0.0.1:1/')).toBeNull();
    expect(await fetchSiteFacts(`${base}/yavas`, { timeoutMs: 300 })).toBeNull();
  });
});
