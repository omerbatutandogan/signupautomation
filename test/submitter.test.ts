import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import pino from 'pino';
import { chromium, type Browser } from 'playwright';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { shouldSolveCaptcha } from '../src/adapters/generic.js';
import { derivePasswordForSite } from '../src/identity/password.js';
import { env } from '../src/config.js';
import { approveProfile, assetFingerprints } from '../src/core/listing-approval.js';
import { belongsToSite, listingSiteConfig, submitExitCode, submitListing, type SubmitOptions } from '../src/core/submitter.js';
import type { SiteConfig } from '../src/core/types.js';
import { loadProfile } from '../src/identity/profile.js';
import { Ledger } from '../src/integrations/ledger.js';

/**
 * Listeleme (submission) akışı — gerçek tarayıcı + yerel sahte site.
 *
 * Listeleme ürünü HERKESE AÇIK yayınlar. Burada kanıtlanan: dry-run hiçbir şey
 * göndermez (tıklamasız tetiklenen gönderimler dahil); gerçek gönderim onaysız yapılmaz;
 * aynı hesapla iki kez yayınlanmaz; gönderimin yapılmış OLABİLECEĞİ andan sonraki her hata
 * otomatik yeniden denenmez.
 */

// Gerçek artifacts/ dizinine ekran görüntüsü yazılmasın.
// Kanıt olarak yakalanacak HTML dosyaya değil `captured.html`e yazılır (içeriği denetlenebilsin).
const captured = vi.hoisted(() => ({ html: [] as string[] }));
vi.mock('../src/core/artifacts.js', () => ({
  createArtifacts: (page: { content(): Promise<string> }) => ({
    dir: 'memory',
    shot: async () => 'memory/x.png',
    html: async () => {
      captured.html.push(await page.content().catch(() => ''));
      return 'memory/x.html';
    },
  }),
  captureFailure: async (artifacts: { shot(n: string): Promise<string>; html(n: string): Promise<string> }, name: string) => ({
    shot: await artifacts.shot(name),
    html: await artifacts.html(name),
  }),
}));

// İnsan hızında yazma (alan başına 9 sn'ye kadar) bu testlerin konusu değil; sahte siteyi 5 dk
// değil saniyeler içinde gezmek için alanlar doğrudan doldurulur. Diğer tüm formfill davranışı gerçek.
vi.mock('../src/core/formfill.js', async (original) => ({
  ...(await original<typeof import('../src/core/formfill.js')>()),
  typeHuman: async (locator: { fill(value: string): Promise<void> }, value: string) => locator.fill(value),
}));

// İnsan-captcha kapısı çağrılırsa test hemen düşsün (15 dk beklemesin): çağrılmaması gereken yerler var.
const humanCaptcha = vi.hoisted(() => ({
  handler: async () => {
    throw new Error('insan captcha kapısı ÇAĞRILDI');
  },
}));
vi.mock('../src/core/runner.js', async (original) => ({
  ...(await original<typeof import('../src/core/runner.js')>()),
  makeCaptchaHandler: () => humanCaptcha.handler,
}));

let server: Server;
let browser: Browser;
let base = '';
let port = 0;
const received = { loginPosts: 0, beacons: 0, sameSiteBeacons: 0, dupChecks: 0, submitPosts: [] as Array<Record<string, string>> };
let submissionsDir = '';
let approvalDir = '';
let assetsDir = '';
const tempDirs: string[] = [];

const page = (body: string) => `<!doctype html><html><body>${body}</body></html>`;
const LOGOUT = '<a id="logout" href="/logout">Log out</a>';
const FORM = `<form method="post" action="/submit">
  <input name="site"><input name="title"><textarea name="desc"></textarea>
  <button id="send" type="submit">Submit</button>
</form>`;
const THANKS = '<h2 id="ok">Thank you, your listing was submitted</h2>';
const FAKE_CAPTCHA = '<div class="g-recaptcha"></div><iframe src="/x?u=google.com/recaptcha/api2/bframe" width="300" height="200"></iframe>';

/** Giriş yapılmış kullanıcıya gösterilen listeleme sayfası çeşitleri. */
function listingPage(path: string): string | null {
  switch (path) {
    case '/submit':
      return LOGOUT + FORM;
    case '/submit-required': // sayfa, config'in bilmediği zorunlu bir alan istiyor
      return LOGOUT + FORM.replace('<button', '<input name="must" required><button');
    case '/submit-auto': // seçim değişince TIKLAMASIZ kendiliğinden gönderen form
      return (
        LOGOUT +
        `<form method="post" action="/submit"><select name="cat" onchange="this.form.submit()"><option value="">-</option><option>Developer Tools</option></select>
         <button id="send" type="submit">Submit</button></form>`
      );
    case '/submit-early': // başarı işareti gönderimden ÖNCE de sayfada
      return LOGOUT + THANKS + FORM;
    case '/submit-early-dup': // başarı işareti hazır + alana yazılınca ürün adresini taşıyan "kayıtlı mı?" isteği
      return LOGOUT + THANKS + FORM.replace('<input name="site">', `<input name="site" oninput="fetch('/dup-check',{method:'POST',body:this.value})">`);
    case '/submit-beacon': // analitik işaretleri atan sayfa: biri başka alan adına, biri aynı siteye (Cloudflare gibi)
      return (
        LOGOUT +
        FORM +
        `<script>fetch('http://localhost:${port}/beacon',{method:'POST',mode:'no-cors',body:'x'}).catch(()=>{});
          fetch('/cdn-cgi/jsd',{method:'POST',body:'x'}).catch(()=>{})</script>`
      );
    case '/submit-click-beacon': // butona basınca YALNIZCA başka alan adına bir istek atar (form gönderilmez)
      return LOGOUT + `<button id="send" type="button" onclick="fetch('http://localhost:${port}/beacon',{method:'POST',mode:'no-cors',body:'x'})">Submit</button>`;
    case '/submit-wizard': // ilk adımdan sonra başarı işareti zaten görünür, ikinci düğme belirir
      return (
        LOGOUT +
        `<button id="next" type="button" onclick="document.body.insertAdjacentHTML('beforeend','<h2 id=ok>Thank you</h2><button id=send2 type=button>Done</button>')">Next</button>`
      );
    case '/submit-sw': // seçim, bir service worker üzerinden kendi POST'unu attırır
      return (
        LOGOUT +
        `<script>navigator.serviceWorker.register('/sw.js')</script>
         <form method="post" action="/submit"><select name="cat" onchange="navigator.serviceWorker.ready.then(() => fetch('/sw-trigger'))">
           <option value="">-</option><option>Developer Tools</option></select><button id="send" type="submit">Submit</button></form>`
      );
    default:
      return null;
  }
}

beforeAll(async () => {
  server = createServer((req, res) => {
    const loggedIn = (req.headers.cookie ?? '').includes('sid=1');
    const send = (status: number, html: string, headers: Record<string, string> = {}) => {
      res.writeHead(status, { 'content-type': 'text/html', ...headers });
      res.end(html);
    };
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', () => {
      const { pathname } = new URL(req.url ?? '/', 'http://x');
      const get = req.method === 'GET';
      const loginForm = `<form method="post" action="/login"><input name="email"><input name="password" type="password"><button id="login-btn">Log in</button></form>`;
      if (pathname === '/login' && get) return send(200, page(loginForm));
      if (pathname === '/login-captcha' && get) return send(200, page(loginForm + FAKE_CAPTCHA));
      if (pathname === '/login-mirror' && get) {
        // Yazılan değeri `value` özniteliğine yansıtır (React'in kontrollü girdileri gibi).
        return send(200, page(loginForm.replace('type="password"', `type="password" oninput="this.setAttribute('value', this.value)"`)));
      }
      if (pathname === '/submit-public' && get) return send(200, page(FORM)); // giriş istemeyen açık form
      if (pathname === '/sw.js' && get) {
        return send(
          200,
          `self.addEventListener('install', () => self.skipWaiting());
           self.addEventListener('activate', (e) => e.waitUntil(self.clients.claim()));
           self.addEventListener('fetch', (e) => {
             if (new URL(e.request.url).pathname === '/sw-trigger') {
               e.respondWith(fetch('/submit', { method: 'POST', body: 'via=sw' }).then(() => new Response('ok')));
             }
           });`,
          { 'content-type': 'application/javascript' },
        );
      }
      if (pathname === '/dup-check' && req.method === 'POST') {
        received.dupChecks++;
        return send(200, 'ok');
      }
      if (pathname === '/cdn-cgi/jsd' && req.method === 'POST') {
        received.sameSiteBeacons++;
        return send(204, '');
      }
      if (pathname === '/login' && req.method === 'POST') {
        received.loginPosts++;
        return send(302, '', { location: '/submit', 'set-cookie': 'sid=1; Path=/' });
      }
      if (pathname === '/beacon' && req.method === 'POST') {
        received.beacons++;
        return send(204, '');
      }
      if (pathname === '/submit' && req.method === 'POST') {
        received.submitPosts.push(Object.fromEntries(new URLSearchParams(body)));
        return send(200, page(THANKS));
      }
      const listing = get ? listingPage(pathname) : null;
      if (listing !== null) return send(200, page(loggedIn ? listing : '<p>Please log in to submit your product.</p>'));
      return send(404, page('not found'));
    });
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  port = (server.address() as AddressInfo).port;
  base = `http://127.0.0.1:${port}`;
  browser = await chromium.launch({ headless: true });
}, 30_000);

afterAll(async () => {
  await browser?.close();
  await new Promise((r) => server.close(r));
});

async function tempDir(prefix: string): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

async function writeConfig(id: string, overrides: Record<string, unknown> = {}, fileId = id) {
  const config = {
    id,
    name: 'Fixture Directory',
    listingUrl: `${base}/submit`,
    loggedIn: '#logout',
    login: {
      url: `${base}/login`,
      steps: [
        { type: 'goto', url: '{{signupUrl}}' },
        { type: 'fill', selector: "input[name='email']", field: 'email' },
        { type: 'fill', selector: "input[name='password']", field: 'password' },
        { type: 'click', selector: '#login-btn' },
      ],
    },
    steps: [
      { type: 'goto', url: '{{signupUrl}}' },
      { type: 'fill', selector: "input[name='site']", field: 'website' },
      { type: 'fill', selector: "input[name='title']", field: 'companyName' },
      { type: 'fill', selector: "textarea[name='desc']", field: 'description' },
      { type: 'click', selector: '#send' },
    ],
    success: { anyOf: ['#ok'] },
    ...overrides,
  };
  await writeFile(join(submissionsDir, `${fileId}.json`), JSON.stringify(config));
}

/** Hesabı açılmış gibi ledger kaydı: kimlik + tamamlanmış gerçek kayıt denemesi. */
function withAccount(ledger: Ledger, key: string, note = 'e-posta doğrulaması gerekmiyor') {
  ledger.saveCredentials(key, 'owner@example.com', 'geonew_fixture', 1);
  const id = ledger.startAttempt(key, 'r0', false);
  ledger.finishAttempt(id, 'completed', note);
}

/** Sahte sitenin KAYIT config'i (risk/captcha tercihi/alan adı buradan gelir). */
const signupCfg = (over: Partial<SiteConfig> = {}): SiteConfig =>
  ({ id: 'x', name: 'x', risk: 'low', signupUrl: `${base}/signup`, emailLocalPart: 'x', steps: [], verification: { mode: 'none' }, ...over }) as SiteConfig;

/** Profili (logo dosyalarının içeriğiyle birlikte) onaylar. */
async function approve(over: Record<string, unknown> = {}) {
  const profile = { ...(await loadProfile('geo-new')), ...over };
  await approveProfile('geo-new', profile, { dir: approvalDir, assets: await assetFingerprints(profile, assetsDir) });
  return profile;
}

let launches = 0;
let lastLaunch: { key: string; ephemeral: boolean } | null = null;
function options(ledger: Ledger, over: Partial<SubmitOptions> = {}): SubmitOptions {
  return {
    log: pino({ level: 'silent' }),
    ledger,
    dryRun: true,
    submissionsDir,
    approvalDir,
    assetsDir,
    signupConfig: signupCfg(),
    launch: async (key, o) => {
      launches++;
      lastLaunch = { key, ephemeral: o.ephemeral };
      const ctx = await browser.newContext();
      return { page: await ctx.newPage(), close: () => ctx.close() };
    },
    ...over,
  };
}

const live = (ledger: Ledger, over: Partial<SubmitOptions> = {}) => options(ledger, { dryRun: false, ...over });

beforeEach(async () => {
  received.loginPosts = 0;
  received.beacons = 0;
  received.sameSiteBeacons = 0;
  received.dupChecks = 0;
  captured.html.length = 0;
  received.submitPosts.length = 0;
  launches = 0;
  lastLaunch = null;
  humanCaptcha.handler = async () => {
    throw new Error('insan captcha kapısı ÇAĞRILDI');
  };
  submissionsDir = await tempDir('subs-');
  approvalDir = await tempDir('appr-');
  assetsDir = await tempDir('assets-');
  await mkdir(join(assetsDir, 'assets'), { recursive: true });
  await writeFile(join(assetsDir, 'assets/logo-512.png'), 'png-512-v1');
  await writeFile(join(assetsDir, 'assets/logo-256.png'), 'png-256-v1');
});

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((d) => rm(d, { recursive: true, force: true })));
});

describe('submitListing — dry-run', () => {
  it('giriş yapar, formu doldurur, HİÇBİR ŞEY GÖNDERMEZ; geçici tarayıcı profili ister', async () => {
    await writeConfig('fixture-a');
    const ledger = new Ledger(':memory:');
    withAccount(ledger, 'fixture-a');

    const outcome = await submitListing('fixture-a', options(ledger));

    expect(outcome.status).toBe('completed');
    expect(outcome.note).toMatch(/dry-run.*gönderilmedi/);
    expect(received.loginPosts).toBe(1); // giriş bir yayın değil: dry-run'da da yapılır
    expect(received.submitPosts).toEqual([]); // ama liste gönderimi YOK
    expect(lastLaunch).toEqual({ key: 'fixture-a', ephemeral: true });
    expect(ledger.recentSubmissions(5)[0]).toMatchObject({ account_key: 'fixture-a', status: 'completed', dry_run: 1 });
    expect(ledger.liveSubmission('fixture-a')).toBeNull(); // dry-run, yayın sayılmaz
    ledger.close();
  }, 60_000);

  it('onay GEREKMEZ (hiçbir şey yayınlanmıyor)', async () => {
    await writeConfig('fixture-b');
    const ledger = new Ledger(':memory:');
    withAccount(ledger, 'fixture-b');
    expect((await submitListing('fixture-b', options(ledger))).status).toBe('completed');
    ledger.close();
  }, 60_000);

  it('kayıt config\'i yoksa GİRİŞ yapan dry-run çalışmaz (şifrenin yazılacağı alan adı doğrulanamaz)', async () => {
    await writeConfig('fixture-a2');
    const ledger = new Ledger(':memory:');
    withAccount(ledger, 'fixture-a2');
    const outcome = await submitListing('fixture-a2', options(ledger, { signupConfig: null }));
    expect(outcome.status).toBe('failed');
    expect(outcome.note).toMatch(/Giriş yapan listeleme için kayıt config'i/);
    expect(launches).toBe(0);
    expect(received.loginPosts).toBe(0);
    ledger.close();
  });

  it('giriş istemeyen açık formda kayıt config\'i olmadan da dry-run çalışır (kapalı-güvenli varsayılanlarla)', async () => {
    await writeConfig('fixture-a3', { listingUrl: `${base}/submit-public`, login: undefined, loggedIn: undefined });
    const ledger = new Ledger(':memory:');
    withAccount(ledger, 'fixture-a3');
    expect((await submitListing('fixture-a3', options(ledger, { signupConfig: null }))).status).toBe('completed');
    expect(received.loginPosts).toBe(0);
    ledger.close();
  }, 60_000);

  it('bulunamayan alan (seçici yok) → failed', async () => {
    await writeConfig('fixture-c', {
      steps: [
        { type: 'goto', url: '{{signupUrl}}' },
        { type: 'fill', selector: "input[name='yok']", field: 'website', timeoutMs: 500 },
      ],
    });
    const ledger = new Ledger(':memory:');
    withAccount(ledger, 'fixture-c');
    const outcome = await submitListing('fixture-c', options(ledger));
    expect(outcome.status).toBe('failed');
    expect(outcome.note).toMatch(/Selector bulunamadı/);
    ledger.close();
  }, 60_000);

  it('sayfanın zorunlu tuttuğu ama config\'in doldurmadığı alan → manual (gerçek zorunlu-boş denetimi)', async () => {
    await writeConfig('fixture-c2', { listingUrl: `${base}/submit-required` });
    const ledger = new Ledger(':memory:');
    withAccount(ledger, 'fixture-c2');
    const outcome = await submitListing('fixture-c2', options(ledger));
    expect(outcome.status).toBe('manual');
    expect(outcome.note).toMatch(/dry-run BAŞARISIZ.*ZORUNLU/);
    expect(received.submitPosts).toEqual([]);
    ledger.close();
  }, 60_000);

  it('config\'te click adımı yoksa (gönderilemeyen form) → manual', async () => {
    await writeConfig('fixture-c3', {
      steps: [
        { type: 'goto', url: '{{signupUrl}}' },
        { type: 'fill', selector: "input[name='site']", field: 'website' },
      ],
    });
    const ledger = new Ledger(':memory:');
    withAccount(ledger, 'fixture-c3');
    const outcome = await submitListing('fixture-c3', options(ledger));
    expect(outcome.status).toBe('manual');
    expect(outcome.note).toMatch(/click adımı yok/);
    ledger.close();
  }, 60_000);

  it('başarı işareti gönderimden ÖNCE de görünüyorsa → manual (sahte başarı riski)', async () => {
    await writeConfig('fixture-c4', { listingUrl: `${base}/submit-early` });
    const ledger = new Ledger(':memory:');
    withAccount(ledger, 'fixture-c4');
    const outcome = await submitListing('fixture-c4', options(ledger));
    expect(outcome.status).toBe('manual');
    expect(outcome.note).toMatch(/ÖNCE de görünüyor/);
    ledger.close();
  }, 60_000);
});

describe('submitListing — dry-run ağ koruması (tıklamasız gönderim)', () => {
  const autoSteps = [
    { type: 'goto', url: '{{signupUrl}}' },
    { type: 'select', selector: "select[name='cat']", field: 'category' },
    { type: 'click', selector: '#send', timeoutMs: 500 },
  ];

  it('seçim değişince kendiliğinden POST eden form: istek ENGELLENİR, sonuç manual', async () => {
    await writeConfig('fixture-auto', { listingUrl: `${base}/submit-auto`, steps: autoSteps });
    const ledger = new Ledger(':memory:');
    withAccount(ledger, 'fixture-auto');

    const outcome = await submitListing('fixture-auto', options(ledger));

    expect(received.submitPosts).toEqual([]); // sunucuya HİÇBİR ŞEY ulaşmadı
    expect(outcome.status).toBe('manual');
    expect(outcome.note).toMatch(/kendiliğinden göndermeye çalıştı, engellendi \(POST \/submit\)/);
    ledger.close();
  }, 60_000);

  it('KONTROL: aynı form GERÇEK çalıştırmada gerçekten POST eder (test boşuna geçmiyor)', async () => {
    await writeConfig('fixture-auto2', { listingUrl: `${base}/submit-auto`, steps: autoSteps });
    const ledger = new Ledger(':memory:');
    withAccount(ledger, 'fixture-auto2');
    await approve();

    const outcome = await submitListing('fixture-auto2', live(ledger));

    expect(received.submitPosts).toHaveLength(1);
    // Tıklama yapılmadan POST gitti; ardından #send bulunamadı. Ağ izi "gönderilmiş olabilir" dedi:
    // 'failed' (yeniden denenebilir) DEĞİL 'unconfirmed' olmalı.
    expect(outcome.status).toBe('unconfirmed');
    expect(ledger.liveSubmission('fixture-auto2')?.status).toBe('unconfirmed');
    ledger.close();
  }, 90_000);

  it('üçüncü taraf (başka alan adı) analitik POST\'u dry-run\'da da engellenir, gerçekte "gönderildi" saymaz', async () => {
    const steps = [
      { type: 'goto', url: '{{signupUrl}}' },
      { type: 'fill', selector: "input[name='yok']", field: 'website', timeoutMs: 500 },
    ];
    await writeConfig('fixture-beacon', { listingUrl: `${base}/submit-beacon`, steps });
    const ledger = new Ledger(':memory:');
    withAccount(ledger, 'fixture-beacon');

    // Dry-run: yazan istek (üçüncü taraf bile olsa) çıkamaz.
    expect((await submitListing('fixture-beacon', options(ledger))).status).toBe('failed');
    expect(received.beacons).toBe(0);

    // Gerçek: işaretler sunucuya ulaşır (kontrol), ama bunlar ürünü GÖNDEREN istekler değil
    // (başka alan adı + aynı siteden Cloudflare tarzı /cdn-cgi/ işareti) → yeniden denenebilir 'failed'.
    await approve();
    const outcome = await submitListing('fixture-beacon', live(ledger));
    expect(received.beacons).toBeGreaterThan(0);
    expect(received.sameSiteBeacons).toBeGreaterThan(0);
    expect(outcome.status).toBe('failed');
    expect(ledger.liveSubmission('fixture-beacon')).toBeNull();
    ledger.close();
  }, 90_000);

  it('aynı siteye giden analitik işareti dry-run\'ı "kendiliğinden gönderdi" diye BOZMAZ (sahte manual yok)', async () => {
    await writeConfig('fixture-beacon2', { listingUrl: `${base}/submit-beacon` });
    const ledger = new Ledger(':memory:');
    withAccount(ledger, 'fixture-beacon2');
    const outcome = await submitListing('fixture-beacon2', options(ledger));
    expect(outcome.status).toBe('completed');
    expect(received.sameSiteBeacons).toBe(0); // yine de ENGELLENDİ: dry-run'dan hiçbir yazan istek çıkmaz
    expect(received.beacons).toBe(0);
    expect(received.submitPosts).toEqual([]);
    ledger.close();
  }, 60_000);

  it('dry-run sayfada service worker\'ı devre dışı bırakır (ikinci katman); gerçek çalıştırmada dokunmaz', async () => {
    await writeConfig('fixture-swbypass');
    const ledger = new Ledger(':memory:');
    withAccount(ledger, 'fixture-swbypass');
    await approve();
    const cdpCalls: string[] = [];
    const spyLaunch: SubmitOptions['launch'] = async () => {
      const ctx = await browser.newContext();
      const open = ctx.newCDPSession.bind(ctx);
      ctx.newCDPSession = (async (target: Parameters<typeof open>[0]) => {
        const session = await open(target);
        const send = session.send.bind(session) as (m: string, p?: object) => Promise<unknown>;
        (session as unknown as { send: typeof send }).send = async (method, params) => {
          cdpCalls.push(`${method}:${JSON.stringify(params ?? {})}`);
          return send(method, params);
        };
        return session;
      }) as typeof ctx.newCDPSession;
      return { page: await ctx.newPage(), close: () => ctx.close() };
    };
    await submitListing('fixture-swbypass', options(ledger, { launch: spyLaunch }));
    expect(cdpCalls).toContain('Network.setBypassServiceWorker:{"bypass":true}');
    cdpCalls.length = 0;
    await submitListing('fixture-swbypass', live(ledger, { launch: spyLaunch }));
    expect(cdpCalls).toEqual([]);
    ledger.close();
  }, 90_000);

  it('service worker üzerinden atılan POST dry-run\'da da durdurulur', async () => {
    const steps = [
      { type: 'goto', url: '{{signupUrl}}' },
      { type: 'select', selector: "select[name='cat']", field: 'category' },
      { type: 'click', selector: '#send', timeoutMs: 500 },
    ];
    await writeConfig('fixture-sw', { listingUrl: `${base}/submit-sw`, steps });
    const ledger = new Ledger(':memory:');
    withAccount(ledger, 'fixture-sw');

    await submitListing('fixture-sw', options(ledger));
    expect(received.submitPosts).toEqual([]);

    // KONTROL: korumasız (gerçek) çalıştırmada aynı sayfa service worker ile gerçekten POST eder.
    await approve();
    await submitListing('fixture-sw', live(ledger));
    expect(received.submitPosts.some((post) => post.via === 'sw')).toBe(true);
    ledger.close();
  }, 90_000);

  it('GİRİŞ isteği dry-run\'da serbesttir (giriş yapılamazsa form hiç görünmez)', async () => {
    await writeConfig('fixture-login-ok');
    const ledger = new Ledger(':memory:');
    withAccount(ledger, 'fixture-login-ok');
    await submitListing('fixture-login-ok', options(ledger));
    expect(received.loginPosts).toBe(1);
    ledger.close();
  }, 60_000);

  it('dry-run girişinde captchaGate ADIMI çalıştırılmaz (2captcha / insan bekleme yok)', async () => {
    // Giriş sayfasında görünür bir captcha var. captchaGate süzülmezse adım gerçek bağlamda
    // çalışır, çözücü yoksa insan kapısına düşer (burada hemen patlayan sahte) ve giriş başarısız olurdu.
    await writeConfig('fixture-cap', {
      login: {
        url: `${base}/login-captcha`,
        steps: [
          { type: 'goto', url: '{{signupUrl}}' },
          { type: 'fill', selector: "input[name='email']", field: 'email' },
          { type: 'fill', selector: "input[name='password']", field: 'password' },
          { type: 'captchaGate' },
          { type: 'click', selector: '#login-btn' },
        ],
      },
    });
    const ledger = new Ledger(':memory:');
    withAccount(ledger, 'fixture-cap');
    const outcome = await submitListing('fixture-cap', options(ledger));
    expect(outcome.status).toBe('completed');
    expect(received.loginPosts).toBe(1);
    ledger.close();
  }, 60_000);
});

describe('submitListing — kapılar (tarayıcı AÇILMADAN)', () => {
  it('hesap yoksa listeleme yapmaz, tarayıcı açmaz', async () => {
    await writeConfig('fixture-d');
    const ledger = new Ledger(':memory:');
    const outcome = await submitListing('fixture-d', options(ledger));
    expect(outcome.status).toBe('skipped_no_account');
    expect(launches).toBe(0);
    ledger.close();
  });

  it('hesap yalnızca dry-run ile "tamamlanmış" ise hesap yok sayılır', async () => {
    await writeConfig('fixture-e');
    const ledger = new Ledger(':memory:');
    ledger.saveCredentials('fixture-e', 'o@example.com', 'u', 1);
    const id = ledger.startAttempt('fixture-e', 'r0', true);
    ledger.finishAttempt(id, 'completed', 'dry-run');
    expect((await submitListing('fixture-e', options(ledger))).status).toBe('skipped_no_account');
    ledger.close();
  });

  it('şifresi kullanıcıda olan hesapla otomatik giriş yapılmaz (betalist vakası)', async () => {
    await writeConfig('fixture-f');
    const ledger = new Ledger(':memory:');
    withAccount(ledger, 'fixture-f', 'Hesap zaten mevcut (daha önce açılmış) — şifre kullanıcıda, türetilen şifre DEĞİL');
    const outcome = await submitListing('fixture-f', options(ledger));
    expect(outcome.status).toBe('manual');
    expect(outcome.note).toMatch(/şifresi kullanıcıda/);
    expect(launches).toBe(0);
    ledger.close();
  });

  it('listeleme config\'i yoksa net hata verir', async () => {
    const ledger = new Ledger(':memory:');
    const outcome = await submitListing('yok-boyle-site', options(ledger));
    expect(outcome.status).toBe('failed');
    expect(outcome.note).toMatch(/bulunamadı/);
    ledger.close();
  });

  it('config\'in id\'si dosya adıyla uyuşmuyorsa reddedilir (yanlış sitenin kimliği kullanılmasın)', async () => {
    await writeConfig('baska-site', {}, 'fixture-m');
    const ledger = new Ledger(':memory:');
    withAccount(ledger, 'fixture-m');
    const outcome = await submitListing('fixture-m', options(ledger));
    expect(outcome.status).toBe('failed');
    expect(outcome.note).toMatch(/uyuşmuyor/);
    expect(launches).toBe(0);
    ledger.close();
  });

  it('listeleme/giriş adresi kayıt sitesinin alan adında değilse reddedilir (şifre başka siteye yazılmaz)', async () => {
    await writeConfig('fixture-n');
    const ledger = new Ledger(':memory:');
    withAccount(ledger, 'fixture-n');
    const outcome = await submitListing('fixture-n', options(ledger, { signupConfig: signupCfg({ signupUrl: 'https://baska-site.example.com/signup' }) }));
    expect(outcome.status).toBe('failed');
    expect(outcome.note).toMatch(/alan adında.*değil/);
    expect(launches).toBe(0);
    expect(received.loginPosts).toBe(0);
    ledger.close();
  });

  it('onaylı logo dosyaları dışında bir dosya yükleyen config reddedilir (tarayıcı açılmadan)', async () => {
    await writeConfig('fixture-up', {
      steps: [
        { type: 'goto', url: '{{signupUrl}}' },
        { type: 'upload', selector: "input[name='logo']", file: 'assets/eski-ekran-goruntusu.png' },
      ],
    });
    const ledger = new Ledger(':memory:');
    withAccount(ledger, 'fixture-up');
    const outcome = await submitListing('fixture-up', options(ledger));
    expect(outcome.status).toBe('failed');
    expect(outcome.note).toMatch(/onaylı logo dosyaları dışında.*eski-ekran-goruntusu/);
    expect(launches).toBe(0);
    ledger.close();
  });

  it('onaylı logo yolu kapıdan geçer (bu yüzden sonraki hata yükleme kapısından değildir)', async () => {
    await writeConfig('fixture-up2', {
      steps: [
        { type: 'goto', url: '{{signupUrl}}' },
        { type: 'upload', selector: "input[name='logo']", file: 'assets/logo-512.png', timeoutMs: 500 },
      ],
    });
    const ledger = new Ledger(':memory:');
    withAccount(ledger, 'fixture-up2');
    const outcome = await submitListing('fixture-up2', options(ledger));
    expect(outcome.note).not.toMatch(/onaylı logo dosyaları dışında/);
    expect(launches).toBe(1);
    ledger.close();
  }, 60_000);

  it('adımlardaki SABİT goto adresi başka bir siteye gidiyorsa reddedilir (parola yazan adımdan önce)', async () => {
    await writeConfig('fixture-goto', {
      login: {
        url: `${base}/login`,
        steps: [
          { type: 'goto', url: 'https://baska-site.example.net/login' },
          { type: 'fill', selector: '#password', field: 'password' },
        ],
      },
    });
    const ledger = new Ledger(':memory:');
    withAccount(ledger, 'fixture-goto');
    const outcome = await submitListing('fixture-goto', options(ledger));
    expect(outcome.status).toBe('failed');
    expect(outcome.note).toMatch(/alan adında değil.*baska-site\.example\.net/);
    expect(launches).toBe(0);
    ledger.close();
  });

  it('paylaşımlı barındırma alan adında (vercel.app) başka alt alan adı "aynı site" sayılmaz', async () => {
    await writeConfig('fixture-shared', {
      listingUrl: 'https://baskasi.vercel.app/submit',
      login: { url: 'https://baskasi.vercel.app/login', steps: [{ type: 'goto', url: '{{signupUrl}}' }] },
    });
    const ledger = new Ledger(':memory:');
    withAccount(ledger, 'fixture-shared');
    const outcome = await submitListing('fixture-shared', options(ledger, { signupConfig: signupCfg({ signupUrl: 'https://benim.vercel.app/signup' }) }));
    expect(outcome.status).toBe('failed');
    expect(outcome.note).toMatch(/alan adında değil/);
    expect(launches).toBe(0);
    ledger.close();
  });

  it('hata anında kanıt olarak yakalanan sayfa HTML\'inde PAROLA bulunmaz', async () => {
    // Giriş sayfası yazılan parolayı `value` özniteliğine yansıtır; giriş adımı bir sonraki alanda patlar.
    await writeConfig('fixture-scrub', {
      login: {
        url: `${base}/login-mirror`,
        steps: [
          { type: 'goto', url: '{{signupUrl}}' },
          { type: 'fill', selector: "input[name='email']", field: 'email' },
          { type: 'fill', selector: "input[name='password']", field: 'password' },
          { type: 'fill', selector: "input[name='yok']", field: 'email', timeoutMs: 500 },
        ],
      },
    });
    const ledger = new Ledger(':memory:');
    withAccount(ledger, 'fixture-scrub');
    const password = derivePasswordForSite(env.MASTER_SECRET, { id: 'fixture-scrub', passwordPolicy: undefined }, 1);
    expect(password.length).toBeGreaterThan(8);

    const outcome = await submitListing('fixture-scrub', options(ledger));
    expect(outcome.status).toBe('failed');
    expect(captured.html.length).toBeGreaterThan(0); // kanıt gerçekten yakalandı
    expect(captured.html.some((html) => html.includes(password))).toBe(false);
    ledger.close();
  }, 60_000);

  it('başka bir listeleme sürerken ikinci başlatma kilitlenir', async () => {
    await writeConfig('fixture-l');
    const ledger = new Ledger(':memory:');
    withAccount(ledger, 'fixture-l');
    expect(ledger.tryClaim('fixture-l#submit', 'baska-calisma')).toBe(true);
    expect((await submitListing('fixture-l', options(ledger))).status).toBe('skipped_locked');
    expect(launches).toBe(0);
    ledger.close();
  });

  it('aynı hesapta KAYIT sürerken (aynı tarayıcı profili) listeleme başlamaz', async () => {
    await writeConfig('fixture-l2');
    const ledger = new Ledger(':memory:');
    withAccount(ledger, 'fixture-l2');
    expect(ledger.tryClaim('fixture-l2', 'kayit-calismasi')).toBe(true);
    const outcome = await submitListing('fixture-l2', options(ledger));
    expect(outcome.status).toBe('skipped_locked');
    expect(outcome.note).toMatch(/kayıt çalışıyor/);
    expect(launches).toBe(0);
    ledger.close();
  });

  it('kayıt config\'inde risk:high ise listeleme yapılmaz', async () => {
    await writeConfig('fixture-high');
    const ledger = new Ledger(':memory:');
    withAccount(ledger, 'fixture-high');
    const outcome = await submitListing('fixture-high', options(ledger, { signupConfig: signupCfg({ risk: 'high' }) }));
    expect(outcome.status).toBe('skipped_high_risk');
    expect(launches).toBe(0);
    ledger.close();
  });
});

describe('submitListing — GERÇEK gönderim kapıları', () => {
  it('kayıt config\'i yoksa GERÇEK gönderim yapılmaz (risk/captcha tercihi bilinemez)', async () => {
    await writeConfig('fixture-nocfg');
    const ledger = new Ledger(':memory:');
    withAccount(ledger, 'fixture-nocfg');
    await approve();
    const outcome = await submitListing('fixture-nocfg', live(ledger, { signupConfig: null }));
    expect(outcome.status).toBe('failed');
    expect(outcome.note).toMatch(/kayıt config'i/);
    expect(launches).toBe(0);
    expect(received.submitPosts).toEqual([]);
    ledger.close();
  });

  it('profil onaylı DEĞİLSE göndermez ve tarayıcı açmaz', async () => {
    await writeConfig('fixture-g');
    const ledger = new Ledger(':memory:');
    withAccount(ledger, 'fixture-g');
    const outcome = await submitListing('fixture-g', live(ledger));
    expect(outcome.status).toBe('skipped_not_approved');
    expect(outcome.note).toMatch(/approve-profile/);
    expect(launches).toBe(0);
    expect(received.submitPosts).toEqual([]);
    ledger.close();
  });

  it('onaydan sonra profil DEĞİŞTİYSE onay geçersiz: göndermez', async () => {
    await writeConfig('fixture-h');
    const ledger = new Ledger(':memory:');
    withAccount(ledger, 'fixture-h');
    await approve({ tagline: 'eski, onaylanmış slogan' });
    const outcome = await submitListing('fixture-h', live(ledger));
    expect(outcome.status).toBe('skipped_not_approved');
    expect(outcome.note).toMatch(/DEĞİŞMİŞ/);
    expect(received.submitPosts).toEqual([]);
    ledger.close();
  });

  it('onaydan sonra LOGO DOSYASININ içeriği değiştiyse onay geçersiz: göndermez', async () => {
    await writeConfig('fixture-h2');
    const ledger = new Ledger(':memory:');
    withAccount(ledger, 'fixture-h2');
    await approve();

    // Değişiklikten ÖNCE aynı koşullarda gönderilir (testin sebebi gerçekten logo olsun diye).
    expect((await submitListing('fixture-h2', live(ledger))).status).toBe('completed');
    expect(received.submitPosts).toHaveLength(1);

    await writeFile(join(assetsDir, 'assets/logo-512.png'), 'png-512-v2-BAŞKA-LOGO');
    const outcome = await submitListing('fixture-h2', live(ledger, { force: true })); // --force "zaten yapıldı"yı aşar, onayı değil
    expect(outcome.status).toBe('skipped_not_approved');
    expect(outcome.note).toMatch(/logo dosyası.*DEĞİŞMİŞ/);
    expect(received.submitPosts).toHaveLength(1);
    ledger.close();
  }, 90_000);

  it('günlük gerçek listeleme sınırı dolduysa göndermez (--force bunu aşmaz)', async () => {
    await writeConfig('fixture-cap-limit');
    const ledger = new Ledger(':memory:');
    withAccount(ledger, 'fixture-cap-limit');
    await approve();
    for (let i = 0; i < env.DAILY_LIMIT; i++) ledger.startSubmission(`diger-${i}`, 'r', false);
    const outcome = await submitListing('fixture-cap-limit', live(ledger, { force: true }));
    expect(outcome.status).toBe('skipped_daily_limit');
    expect(launches).toBe(0);
    expect(received.submitPosts).toEqual([]);
    ledger.close();
  });

  it('kilit alındıktan SONRA tekrar bakılır: araya giren başka bir gönderim çift yayını engeller', async () => {
    await writeConfig('fixture-race');
    const ledger = new Ledger(':memory:');
    withAccount(ledger, 'fixture-race');
    await approve();
    const claim = ledger.tryClaim.bind(ledger);
    vi.spyOn(ledger, 'tryClaim').mockImplementation((key, runId, ttl) => {
      const ok = claim(key, runId, ttl);
      // Önceki kontrol ile kilit arasında başka bir süreç gönderimi bitirmiş gibi.
      const id = ledger.startSubmission('fixture-race', 'baska-surec', false);
      ledger.finishSubmission(id, 'completed', 'x', 'https://x.example/listing');
      return ok;
    });
    const outcome = await submitListing('fixture-race', live(ledger));
    expect(outcome.status).toBe('skipped_done');
    expect(launches).toBe(0);
    expect(received.submitPosts).toEqual([]);
    expect(ledger.activeLock('fixture-race#submit')).toBeNull(); // kilit bırakıldı
    ledger.close();
  });
});

describe('submitListing — GERÇEK gönderim', () => {
  it('onaylıysa gönderir; ürün bilgileri formda; başarı doğrulanır; ikinci kez GÖNDERMEZ', async () => {
    await writeConfig('fixture-i');
    const ledger = new Ledger(':memory:');
    withAccount(ledger, 'fixture-i');
    const profile = await approve();

    const first = await submitListing('fixture-i', live(ledger));
    expect(first.status).toBe('completed');
    expect(first.listingUrl).toBe(`${base}/submit`);
    expect(lastLaunch).toEqual({ key: 'fixture-i', ephemeral: false }); // gerçek: kalıcı profil
    expect(received.submitPosts).toHaveLength(1);
    expect(received.submitPosts[0]).toMatchObject({ site: profile.website, title: profile.companyName });
    expect(received.submitPosts[0]?.desc).toBeTruthy();
    expect(ledger.liveSubmission('fixture-i')?.status).toBe('completed');

    const second = await submitListing('fixture-i', live(ledger));
    expect(second.status).toBe('skipped_done');
    expect(received.submitPosts).toHaveLength(1); // çift yayın YOK

    const forced = await submitListing('fixture-i', live(ledger, { force: true }));
    expect(forced.status).toBe('completed');
    expect(received.submitPosts).toHaveLength(2); // --force bilinçli aşar
    ledger.close();
  }, 120_000);

  it('başarı işareti görünmezse "unconfirmed": yayınlanmış olabilir, OTOMATİK yeniden denenmez', async () => {
    await writeConfig('fixture-j', { success: { anyOf: ['#hic-gorunmeyen'] } });
    const ledger = new Ledger(':memory:');
    withAccount(ledger, 'fixture-j');
    await approve();

    const first = await submitListing('fixture-j', live(ledger));
    expect(first.status).toBe('unconfirmed');
    expect(received.submitPosts).toHaveLength(1);

    const retry = await submitListing('fixture-j', live(ledger));
    expect(retry.status).toBe('skipped_unverified'); // "zaten listelendi" DEĞİL: elle bakılmalı
    expect(retry.note).toMatch(/doğrulanamadı \(unconfirmed\)/);
    expect(received.submitPosts).toHaveLength(1); // ikinci POST yok
    ledger.close();
  }, 120_000);

  it('TIKLAMADAN SONRAKİ hata "unconfirmed" olur (yayınlanmış olabilir), "failed" değil', async () => {
    await writeConfig('fixture-after-click', {
      steps: [
        { type: 'goto', url: '{{signupUrl}}' },
        { type: 'fill', selector: "input[name='site']", field: 'website' },
        { type: 'click', selector: '#send' },
        { type: 'expect', anyOf: ['#hic-gorunmeyen'], timeoutMs: 800 },
      ],
    });
    const ledger = new Ledger(':memory:');
    withAccount(ledger, 'fixture-after-click');
    await approve();

    const first = await submitListing('fixture-after-click', live(ledger));
    expect(received.submitPosts).toHaveLength(1);
    expect(first.status).toBe('unconfirmed');
    expect(first.note).toMatch(/yayınlanmış olabilir/);
    expect(ledger.liveSubmission('fixture-after-click')?.status).toBe('unconfirmed');

    expect((await submitListing('fixture-after-click', live(ledger))).status).toBe('skipped_unverified');
    expect(received.submitPosts).toHaveLength(1);
    ledger.close();
  }, 120_000);

  it('hiçbir şey gönderilmeden önceki hata (alan bulunamadı) yeniden denenebilir: failed', async () => {
    await writeConfig('fixture-k', {
      steps: [
        { type: 'goto', url: '{{signupUrl}}' },
        { type: 'fill', selector: "input[name='yok']", field: 'website', timeoutMs: 500 },
        { type: 'click', selector: '#send' },
      ],
    });
    const ledger = new Ledger(':memory:');
    withAccount(ledger, 'fixture-k');
    await approve();

    expect((await submitListing('fixture-k', live(ledger))).status).toBe('failed');
    expect(ledger.liveSubmission('fixture-k')).toBeNull(); // yeniden denemeyi ENGELLEMEZ
    expect(received.submitPosts).toEqual([]);
    ledger.close();
  }, 60_000);

  it('gönder butonu bulunamazsa (tıklama hiç olmadı) → failed, yeniden denenebilir', async () => {
    await writeConfig('fixture-k2', {
      steps: [
        { type: 'goto', url: '{{signupUrl}}' },
        { type: 'fill', selector: "input[name='site']", field: 'website' },
        { type: 'click', selector: '#yok-boyle-bir-buton', timeoutMs: 500 },
      ],
    });
    const ledger = new Ledger(':memory:');
    withAccount(ledger, 'fixture-k2');
    await approve();
    expect((await submitListing('fixture-k2', live(ledger))).status).toBe('failed');
    expect(ledger.liveSubmission('fixture-k2')).toBeNull();
    expect(received.submitPosts).toEqual([]);
    ledger.close();
  }, 60_000);

  it('gönderim tıklaması hiç yapılmadıysa "gönderildi" denmez: failed', async () => {
    await writeConfig('fixture-noclick', {
      steps: [
        { type: 'goto', url: '{{signupUrl}}' },
        { type: 'fill', selector: "input[name='site']", field: 'website' },
      ],
    });
    const ledger = new Ledger(':memory:');
    withAccount(ledger, 'fixture-noclick');
    await approve();
    const outcome = await submitListing('fixture-noclick', live(ledger));
    expect(outcome.status).toBe('failed');
    expect(outcome.note).toMatch(/gönderim yapılmadı/);
    expect(ledger.liveSubmission('fixture-noclick')).toBeNull();
    expect(received.submitPosts).toEqual([]);
    ledger.close();
  }, 60_000);

  it('başarı işareti gönderimden ÖNCE de görünüyorsa tıklanmaz: failed, hiçbir şey gönderilmez', async () => {
    await writeConfig('fixture-early', { listingUrl: `${base}/submit-early` });
    const ledger = new Ledger(':memory:');
    withAccount(ledger, 'fixture-early');
    await approve();
    const outcome = await submitListing('fixture-early', live(ledger));
    expect(outcome.status).toBe('failed');
    expect(outcome.note).toMatch(/ÖNCE de görünüyor/);
    expect(received.submitPosts).toEqual([]);
    expect(ledger.liveSubmission('fixture-early')).toBeNull();
    ledger.close();
  }, 60_000);

  it('tıklama TEK başına "gönderilmiş olabilir" demek için yeter (ağ izi olmasa da): sonraki hata unconfirmed', async () => {
    // Buton yalnızca başka alan adına, ürün bilgisi taşımayan bir istek atar: ağ sinyali YOK, tıklama sinyali var.
    await writeConfig('fixture-click-only', {
      listingUrl: `${base}/submit-click-beacon`,
      steps: [
        { type: 'goto', url: '{{signupUrl}}' },
        { type: 'click', selector: '#send' },
        { type: 'fill', selector: "input[name='yok']", field: 'website', timeoutMs: 500 },
      ],
    });
    const ledger = new Ledger(':memory:');
    withAccount(ledger, 'fixture-click-only');
    await approve();
    const outcome = await submitListing('fixture-click-only', live(ledger));
    expect(outcome.status).toBe('unconfirmed');
    expect(ledger.liveSubmission('fixture-click-only')?.status).toBe('unconfirmed');
    ledger.close();
  }, 60_000);

  it('çok adımlı formda ilk tıklamadan sonra görünen başarı işareti ikinci tıklamayı ENGELLEMEZ', async () => {
    await writeConfig('fixture-wizard', {
      listingUrl: `${base}/submit-wizard`,
      steps: [
        { type: 'goto', url: '{{signupUrl}}' },
        { type: 'click', selector: '#next' },
        { type: 'click', selector: '#send2' },
      ],
    });
    const ledger = new Ledger(':memory:');
    withAccount(ledger, 'fixture-wizard');
    await approve();
    const outcome = await submitListing('fixture-wizard', live(ledger));
    expect(outcome.status).toBe('completed');
    ledger.close();
  }, 60_000);

  it('tıklamadan ÖNCE çıkan "kayıtlı mı?" isteği erken başarı işareti kontrolünü kapatmaz: sahte başarı yok', async () => {
    // Başarı işareti sayfada zaten var; alana yazılınca ürün adresini taşıyan bir istek tıklamadan önce çıkar
    // (ağ izi "gönderilmiş olabilir" der). Kontrol yalnızca İLK TIKLAMADAN önce atlanmalı, o istekle değil.
    await writeConfig('fixture-dup', { listingUrl: `${base}/submit-early-dup` });
    const ledger = new Ledger(':memory:');
    withAccount(ledger, 'fixture-dup');
    await approve();
    const outcome = await submitListing('fixture-dup', live(ledger));
    expect(received.dupChecks).toBeGreaterThan(0); // fixture gerçekten ağ izini bıraktı
    expect(outcome.status).not.toBe('completed'); // kanıtsız "tamamlandı" YOK
    expect(outcome.note).toMatch(/ÖNCE de görünüyor/);
    expect(received.submitPosts).toEqual([]); // ve hiçbir şey gönderilmedi
    ledger.close();
  }, 60_000);

  it('giriş yapılamazsa failed (yayın DEĞİL): yeniden denemeyi engellemez, hiçbir şey gönderilmez', async () => {
    await writeConfig('fixture-nologin', { loggedIn: '#hic-gorunmeyen-cikis' });
    const ledger = new Ledger(':memory:');
    withAccount(ledger, 'fixture-nologin');
    await approve();
    const outcome = await submitListing('fixture-nologin', live(ledger));
    expect(outcome.status).toBe('failed');
    expect(outcome.note).toMatch(/Giriş yapılamadı/);
    expect(received.loginPosts).toBe(1);
    expect(received.submitPosts).toEqual([]);
    expect(ledger.liveSubmission('fixture-nologin')).toBeNull();
    ledger.close();
  }, 60_000);
});

describe('submitListing — temizlik her koşulda çalışır', () => {
  it('sonuç ledger\'a yazılamasa bile kilit bırakılır ve tarayıcı kapanır', async () => {
    await writeConfig('fixture-clean');
    const ledger = new Ledger(':memory:');
    withAccount(ledger, 'fixture-clean');
    vi.spyOn(ledger, 'finishSubmission').mockImplementation(() => {
      throw new Error('disk dolu');
    });
    let closed = false;
    const outcome = await submitListing(
      'fixture-clean',
      options(ledger, {
        launch: async () => {
          const ctx = await browser.newContext();
          return {
            page: await ctx.newPage(),
            close: async () => {
              closed = true;
              await ctx.close();
            },
          };
        },
      }),
    );
    expect(outcome.status).toBe('completed'); // asıl iş yapıldı, yazım hatası onu bozmadı
    expect(ledger.activeLock('fixture-clean#submit')).toBeNull();
    expect(closed).toBe(true);
    ledger.close();
  }, 60_000);

  it('tarayıcı açılamazsa failed olur, kilit bırakılır (başka bir kayıt/listeleme bloke olmaz)', async () => {
    await writeConfig('fixture-nolaunch');
    const ledger = new Ledger(':memory:');
    withAccount(ledger, 'fixture-nolaunch');
    await approve();
    const outcome = await submitListing(
      'fixture-nolaunch',
      live(ledger, {
        launch: async () => {
          throw new Error('Chromium başlatılamadı');
        },
      }),
    );
    expect(outcome.status).toBe('failed');
    expect(outcome.note).toMatch(/Chromium başlatılamadı/);
    expect(ledger.activeLock('fixture-nolaunch#submit')).toBeNull();
    expect(ledger.liveSubmission('fixture-nolaunch')).toBeNull(); // hiçbir şey gönderilmedi: yeniden denenebilir
    ledger.close();
  }, 60_000);
});

describe('listingSiteConfig — kayıt config\'inin tercihleri miras alınır', () => {
  const mk = (signupConfig: SiteConfig | null) =>
    listingSiteConfig({ siteId: 's', name: 'S', signupConfig, url: 'https://s.example/x', steps: [] });

  it('kayıtta kapatılmış captcha çözümü listelemede de kapalı kalır', () => {
    expect(shouldSolveCaptcha(mk(signupCfg({ solveCaptcha: false })))).toBe(false);
  });

  it('kayıt config\'i yoksa kapalı-güvenli: orta risk, captcha çözümü KAPALI', () => {
    expect(mk(null).risk).toBe('medium');
    expect(shouldSolveCaptcha(mk(null))).toBe(false);
  });

  it('risk miras alınır (high ise captcha çözülmez)', () => {
    expect(mk(signupCfg({ risk: 'high' })).risk).toBe('high');
    expect(shouldSolveCaptcha(mk(signupCfg({ risk: 'high' })))).toBe(false);
    expect(mk(signupCfg({ risk: 'medium' })).risk).toBe('medium');
  });

  it('kayıtta açıkça izin verilen ya da varsayılan bırakılan tercih aynen geçer', () => {
    expect(shouldSolveCaptcha(mk(signupCfg({ solveCaptcha: true })))).toBe(true);
    expect(shouldSolveCaptcha(mk(signupCfg()))).toBe(true); // kayıttaki varsayılan davranışın aynısı
  });
});

describe('belongsToSite — şifre yalnızca sitenin kendi alan adına yazılır', () => {
  const cases: Array<[string, string, boolean]> = [
    ['https://accounts.example.com/login', 'https://www.example.com/signup', true],
    ['https://example.com/submit', 'https://www.example.com/signup', true],
    ['https://evil.com/login', 'https://example.com/signup', false],
    ['https://example.com.evil.com/login', 'https://example.com/signup', false],
    ['https://x.example.co.uk/a', 'https://www.example.co.uk/signup', true],
    ['https://other.co.uk/a', 'https://example.co.uk/signup', false],
    // Barındırma alan adlarında alt alan adı = başka sahip: tam ana makine adı eşleşmeli.
    ['https://a.vercel.app/x', 'https://a.vercel.app/signup', true],
    ['https://b.vercel.app/x', 'https://a.vercel.app/signup', false],
    ['https://b.github.io/x', 'https://a.github.io/signup', false],
    ['bozuk adres', 'https://example.com/signup', false],
  ];
  it.each(cases)('%s ↔ %s → %s', (url, signupUrl, expected) => {
    expect(belongsToSite(url, signupUrl)).toBe(expected);
  });
});

describe('submitExitCode', () => {
  it('yalnızca gerçekten listelenmiş / zaten listelenmiş 0 döner; belirsiz ve atlanan durumlar 0 DEĞİL', () => {
    expect(submitExitCode('completed')).toBe(0);
    expect(submitExitCode('skipped_done')).toBe(0);
    for (const status of ['unconfirmed', 'skipped_unverified', 'failed', 'manual', 'error', 'skipped_no_account', 'skipped_not_approved', 'skipped_locked', 'skipped_high_risk', 'skipped_daily_limit'] as const) {
      expect(submitExitCode(status), status).toBe(1);
    }
  });
});

vi.setConfig({ testTimeout: 60_000 });
