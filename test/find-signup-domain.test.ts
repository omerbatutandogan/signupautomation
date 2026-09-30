import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { chromium, type Browser, type Page } from 'playwright';
import { findSignupPage, isParkedDomain, markMove, resolveLanding } from '../src/discovery/find-signup.js';
import { html, LONG_TEXT, ok, serve as serveOn, SIGNUP_FORM, type Routes } from './fake-sites.js';

/**
 * "Form bulunamadı" kovasının teşhisi (2026-09-30, 18 site elle incelendi).
 *
 * Kovanın bir kısmı gerçekten formsuz değildi, keşif yanılıyordu:
 *  - angel.co → wellfound.com'a taşınmış; kayıt linkleri yeni domainde
 *    olduğu için "siteden dışarı çıkma" filtresine takılıyordu.
 *  - appagg.com boş sayfa + Cloudflare "Verify you are human" kutusu
 *    veriyordu; boş gövde "ölü site" sayılıyordu, oysa bot duvarı.
 * Taşınmayı takip etmenin tuzağı park edilmiş domainler: prefundia.com
 * GoDaddy satış sayfasına yönleniyor — "taşınma" sanılsa GoDaddy'nin
 * kendi kayıt formu bulunurdu.
 */

// Gerçek gövdeler (2026-09-30).
const CODEPROJECT_PARKED =
  'codeproject.com\nis parked free, courtesy of GoDaddy.com.\nGet This Domain\nRelated Searches\ncode\nproject\nCopyright © 1999-2026 GoDaddy, LLC. All rights reserved.';
// prefundia.com'un yönlendiği satış sayfası headless'ta Akamai reddi veriyor —
// metin işe yaramıyor, karar alan adından verilmeli.
const GODADDY_FORSALE_URL =
  'https://forsale.godaddy.com/forsale/prefundia.com?utm_source=TDFS_BINNS2&utm_medium=parkedpages';
const GODADDY_FORSALE_BODY =
  'Access Denied\nYou don\'t have permission to access "http://forsale.godaddy.com/forsale/prefundia.com?" on this server.';

describe('isParkedDomain', () => {
  it('GoDaddy "parked free" sayfasını tanır (codeproject.com)', () => {
    expect(isParkedDomain('https://codeproject.com/lander', CODEPROJECT_PARKED)).toBe(true);
  });

  it('satış platformuna yönlenmeyi metinden bağımsız tanır (prefundia.com)', () => {
    expect(isParkedDomain(GODADDY_FORSALE_URL, GODADDY_FORSALE_BODY)).toBe(true);
  });

  it('normal dizin sayfasını park sanmaz', () => {
    const body = 'Startup Jobs & AI Recruiting Platform. Sign up for free. Businesses for sale category.';
    expect(isParkedDomain('https://wellfound.com/', body)).toBe(false);
  });

  it('godaddy.com alt alan adlarının hepsini park saymaz', () => {
    expect(isParkedDomain('https://www.godaddy.com/', 'Domains, hosting and more')).toBe(false);
  });
});

describe('resolveLanding — taşınma mı, gitmiş mi', () => {
  it('aynı sitede kalınca kök değişmez (alt domain dahil)', () => {
    expect(resolveLanding('https://portal.10words.io/', 'x'.repeat(100), 'https://10words.io')).toEqual({
      kind: 'same',
    });
  });

  it('başka domaine taşınma yeni kök döner (angel.co → wellfound.com)', () => {
    expect(resolveLanding('https://wellfound.com/', 'Startup Jobs', 'https://angel.co')).toEqual({
      kind: 'moved',
      origin: 'https://wellfound.com',
    });
  });

  it('www ve ülke uzantısı geçişlerinde de arama yeni domainde sürer', () => {
    expect(resolveLanding('https://www.example.com/', 'x'.repeat(100), 'https://example.com')).toEqual({
      kind: 'same',
    });
    expect(resolveLanding('https://www.example.com.tr/', 'x'.repeat(100), 'https://example.com')).toEqual({
      kind: 'moved',
      origin: 'https://www.example.com.tr',
    });
  });

  it('park/satış sayfası gitmiş sayılır', () => {
    const r = resolveLanding(GODADDY_FORSALE_URL, GODADDY_FORSALE_BODY, 'https://prefundia.com');
    expect(r.kind).toBe('gone');
  });

  it('büyük platforma yönlenme gitmiş sayılır — oranın kaydı bizim hedefimiz değil', () => {
    // Dizin kapanıp Medium/Facebook sayfasına yönlenirse "taşınma" sanıp
    // platformun kendi kayıt formunu bulurduk.
    for (const url of ['https://medium.com/@olddir', 'https://www.facebook.com/olddir', 'https://linktr.ee/olddir']) {
      expect(resolveLanding(url, 'x'.repeat(100), 'https://old-dir.com').kind).toBe('gone');
    }
  });
});

describe('markMove — taşınma işareti', () => {
  const base = { confidence: 'high' as const, hops: 1, method: 'link-follow' as const };

  it('başka markaya taşınmayı işaretler (angel.co → wellfound.com)', () => {
    expect(markMove({ ...base, url: 'https://wellfound.com/jobs/signup' }, 'https://angel.co').movedFrom).toBe(
      'angel.co',
    );
  });

  it('aynı markanın ülke uzantısını taşınma saymaz (example.com → example.com.tr)', () => {
    // Yönlendirmeyi eski domainin sahibi yapıyor; aynı marka adı = aynı
    // şirket. İşaretlemek her bölgesel sitede gereksiz insan onayı ister.
    expect(markMove({ ...base, url: 'https://www.example.com.tr/signup' }, 'https://example.com').movedFrom).toBe(
      undefined,
    );
  });

  it('platform alt alan adındaki dizinin platforma yönlenmesi taşınmadır (notion.site → notion.so)', () => {
    // İlk marka kuralı yalnızca ilk etiketi karşılaştırıyordu: "notion"
    // = "notion" sayılıp işaret düşmüyor, Notion'a kayıt açılabiliyordu.
    const cases: Array<[string, string]> = [
      ['https://www.notion.so/signup', 'https://mydir.notion.site'],
      ['https://webflow.com/signup', 'https://mydir.webflow.io'],
      ['https://vercel.com/signup', 'https://mydir.vercel.app'],
      ['https://www.softr.io/signup', 'https://softr.app'],
    ];
    for (const [url, start] of cases) {
      expect(markMove({ ...base, url }, start).movedFrom, `${start} → ${url}`).toBeDefined();
    }
  });

  it('genel uzantı gibi kullanılan iki harfli uzantılar arası geçiş taşınmadır (foo.io → foo.ai)', () => {
    // .io/.ai/.co pratikte genel uzantı; farklı sahiplere ait olabilir.
    for (const [url, start] of [
      ['https://foo.ai/signup', 'https://foo.io'],
      ['https://foo.co/signup', 'https://foo.de'],
    ] as const) {
      expect(markMove({ ...base, url }, start).movedFrom, `${start} → ${url}`).toBeDefined();
    }
  });

  it('ülke uzantısı dışındaki uzantı değişimi taşınmadır (example.com → example.io)', () => {
    expect(markMove({ ...base, url: 'https://example.io/signup' }, 'https://example.com').movedFrom).toBe(
      'example.com',
    );
  });
});

let browser: Browser;
let page: Page;

beforeAll(async () => {
  browser = await chromium.launch({ headless: true });
}, 30_000);

afterAll(async () => {
  await browser?.close();
});

/** Sahte domainleri ağa çıkmadan yanıtlar — bkz. fake-sites.ts. */
const serve = (routes: Routes): Promise<Page> => serveOn(browser, routes);

describe('findSignupPage — domain değişimi', () => {
  it('taşınmış sitede kayıt linkini YENİ domainde takip eder (angel.co → wellfound.com)', async () => {
    // JS yönlendirmesi: Playwright gezinme isteğine sahte 3xx veremiyor
    // (Chromium orijinal adrese ağdan gitmeye çalışıyor). Düzeltme son
    // URL'e baktığı için HTTP ve JS yönlendirmesi aynı yoldan geçiyor.
    page = await serve({
      'old-dir.test/': ok(html(`<script>location.replace('http://new-dir.test/')</script>`)),
      'new-dir.test/': ok(html(`<p>${LONG_TEXT}</p><a href="http://new-dir.test/account/create">Sign up for free</a>`)),
      'new-dir.test/account/create': ok(SIGNUP_FORM),
    });
    const result = await findSignupPage(page, 'http://old-dir.test');
    await page.context().close();

    expect(result.kind).toBe('found');
    if (result.kind === 'found') {
      expect(result.candidate.url).toBe('http://new-dir.test/account/create');
      expect(result.candidate.movedFrom).toBe('old-dir.test');
    }
  }, 90_000);

  it('doğrudan yol form beklerken platforma JS ile yönlenirse oranın formunu ALMAZ', async () => {
    // Domain kontrolü sayfa açılır açılmaz yapılıyordu; form için 2.5sn
    // beklenirken JS yönlendirmesi github.com/signup'a geçerse GitHub
    // kaydı "bulunuyordu".
    page = await serve({
      'jsredir-dir.test/': ok(html(`<p>${LONG_TEXT}</p>`)),
      'jsredir-dir.test/signup': ok(
        html(`<p>${LONG_TEXT}</p><script>setTimeout(() => location.href = 'https://github.com/signup', 300)</script>`),
      ),
      'github.com/signup': ok(SIGNUP_FORM),
    });
    const result = await findSignupPage(page, 'http://jsredir-dir.test');
    await page.context().close();

    expect(result.kind).not.toBe('found');
  }, 90_000);

  it('satış sayfasına yönlenen domainde oranın kayıt formunu ARAMAZ (prefundia.com)', async () => {
    // Gerçek vaka gibi JS ile yönleniyor, HTTP 30x değil.
    const toForsale = ok(
      html(`<script>location.href='https://forsale.godaddy.com/forsale/parked-dir.test'</script>`),
    );
    page = await serve({
      'parked-dir.test/*': toForsale,
      'forsale.godaddy.com/forsale/parked-dir.test': ok(
        html(`<p>${LONG_TEXT}</p><a href="https://forsale.godaddy.com/signup">Sign up</a>`),
      ),
      'forsale.godaddy.com/signup': ok(SIGNUP_FORM),
    });
    const result = await findSignupPage(page, 'http://parked-dir.test');
    await page.context().close();

    expect(result.kind).toBe('not_found');
    if (result.kind === 'not_found') expect(result.reason).toMatch(/park/i);
  }, 90_000);
});

describe('findSignupPage — boş sayfa', () => {
  it('boş gövde + Cloudflare kutusu bot duvarıdır, ölü site değil (appagg.com)', async () => {
    page = await serve({
      'walled-dir.test/': ok(
        html(
          '<iframe src="https://challenges.cloudflare.com/cdn-cgi/challenge-platform/turnstile/if/ov2"></iframe>',
          'Verification - Walled',
        ),
      ),
      'challenges.cloudflare.com/*': ok(html('<input type="checkbox"> Verify you are human')),
    });
    const result = await findSignupPage(page, 'http://walled-dir.test');
    await page.context().close();

    expect(result.kind).toBe('bot_protected');
  }, 60_000);

  it('geç render eden SPA + görünmez reCAPTCHA v3 bot duvarı SAYILMAZ', async () => {
    // v3 sessiz skorlayıcı; SPA'lar formları için yüklüyor. İlk anda boş
    // gövde + v3 script'i "duvar" sanılırsa sağlam site otomasyon dışı kalır.
    // Gerçek api.js görünmez bir anchor iframe'i ekliyor; tespit onu
    // recaptcha_v2 sanıyor — sahte script de aynısını yapıyor.
    page = await serve({
      'www.google.com/recaptcha/api.js': (route) =>
        route.fulfill({
          status: 200,
          contentType: 'application/javascript',
          body: `var f=document.createElement('iframe');f.src='https://www.google.com/recaptcha/api2/anchor?k=sitekey&size=invisible';document.documentElement.appendChild(f);`,
        }),
      'www.google.com/recaptcha/api2/anchor': ok(html('')),
      'spa-dir.test/': ok(
        html(`
          <script src="https://www.google.com/recaptcha/api.js?render=sitekey"></script>
          <div id="app"></div>
          <script>setTimeout(() => {
            document.getElementById('app').innerHTML =
              '<p>${'A curated directory of tools. '.repeat(5)}</p><a href="/join-now">Sign up</a>';
          }, 1500)</script>`),
      ),
      'spa-dir.test/join-now': ok(SIGNUP_FORM),
    });
    const result = await findSignupPage(page, 'http://spa-dir.test');
    await page.context().close();

    expect(result.kind).toBe('found');
  }, 90_000);

  it('gerçekten boş sayfa hâlâ bulunamadı sayılır', async () => {
    page = await serve({ 'empty-dir.test/': ok(html('')) });
    const result = await findSignupPage(page, 'http://empty-dir.test');
    await page.context().close();

    expect(result.kind).toBe('not_found');
  }, 60_000);
});
