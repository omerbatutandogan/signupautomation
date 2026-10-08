import { mkdtemp, mkdir, writeFile } from 'node:fs/promises';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import pino from 'pino';
import { chromium, type Browser } from 'playwright';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { approveProfile } from '../src/core/listing-approval.js';
import { submitListing, type SubmitOptions } from '../src/core/submitter.js';
import { loadProfile } from '../src/identity/profile.js';
import { Ledger } from '../src/integrations/ledger.js';

/**
 * Listeleme (submission) akışı — gerçek tarayıcı + yerel sahte site.
 *
 * Listeleme ürünü HERKESE AÇIK yayınlar. Burada kanıtlanan: dry-run hiçbir şey
 * göndermez; gerçek gönderim onaysız yapılmaz; aynı hesapla iki kez yayınlanmaz;
 * sonucu doğrulanamayan gönderim otomatik yeniden denenmez.
 */

// Gerçek artifacts/ dizinine ekran görüntüsü yazılmasın.
vi.mock('../src/core/artifacts.js', () => ({
  createArtifacts: () => ({ dir: 'memory', shot: async () => 'memory/x.png', html: async () => 'memory/x.html' }),
  captureFailure: async () => ({ shot: 'memory/x.png', html: 'memory/x.html' }),
}));

let server: Server;
let browser: Browser;
let base = '';
const received = { loginPosts: 0, submitPosts: [] as Array<Record<string, string>> };
let submissionsDir = '';
let approvalDir = '';

const form = (body: string) => `<!doctype html><html><body>${body}</body></html>`;

beforeAll(async () => {
  server = createServer((req, res) => {
    const cookie = req.headers.cookie ?? '';
    const loggedIn = cookie.includes('sid=1');
    const send = (status: number, html: string, headers: Record<string, string> = {}) => {
      res.writeHead(status, { 'content-type': 'text/html', ...headers });
      res.end(html);
    };
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', () => {
      const url = new URL(req.url ?? '/', 'http://x');
      if (url.pathname === '/login' && req.method === 'GET') {
        return send(200, form(`<form method="post" action="/login"><input name="email"><input name="password" type="password"><button id="login-btn">Log in</button></form>`));
      }
      if (url.pathname === '/login' && req.method === 'POST') {
        received.loginPosts++;
        return send(302, '', { location: '/submit', 'set-cookie': 'sid=1; Path=/' });
      }
      if (url.pathname === '/submit' && req.method === 'GET') {
        if (!loggedIn) return send(200, form('<p>Please log in to submit your product.</p>'));
        return send(
          200,
          form(`<a id="logout" href="/logout">Log out</a>
            <form method="post" action="/submit">
              <input name="site"><input name="title"><textarea name="desc"></textarea>
              <button id="send" type="submit">Submit</button>
            </form>`),
        );
      }
      if (url.pathname === '/submit' && req.method === 'POST') {
        received.submitPosts.push(Object.fromEntries(new URLSearchParams(body)));
        return send(200, form('<h2 id="ok">Thank you, your listing was submitted</h2>'));
      }
      return send(404, form('not found'));
    });
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  browser = await chromium.launch({ headless: true });
}, 30_000);

afterAll(async () => {
  await browser?.close();
  await new Promise((r) => server.close(r));
});

async function writeConfig(id: string, overrides: Record<string, unknown> = {}) {
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
  await writeFile(join(submissionsDir, `${id}.json`), JSON.stringify(config));
}

/** Hesabı açılmış gibi ledger kaydı: kimlik + tamamlanmış gerçek kayıt denemesi. */
function withAccount(ledger: Ledger, key: string, note = 'e-posta doğrulaması gerekmiyor') {
  ledger.saveCredentials(key, 'owner@example.com', 'geonew_fixture', 1);
  const id = ledger.startAttempt(key, 'r0', false);
  ledger.finishAttempt(id, 'completed', note);
}

let launches = 0;
function options(ledger: Ledger, over: Partial<SubmitOptions> = {}): SubmitOptions {
  return {
    log: pino({ level: 'silent' }),
    ledger,
    dryRun: true,
    submissionsDir,
    approvalDir,
    launch: async () => {
      launches++;
      const ctx = await browser.newContext();
      return { page: await ctx.newPage(), close: () => ctx.close() };
    },
    ...over,
  };
}

beforeEach(async () => {
  received.loginPosts = 0;
  received.submitPosts.length = 0;
  launches = 0;
  submissionsDir = await mkdtemp(join(tmpdir(), 'subs-'));
  approvalDir = await mkdtemp(join(tmpdir(), 'appr-'));
  await mkdir(submissionsDir, { recursive: true });
});

describe('submitListing — dry-run', () => {
  it('giriş yapar, formu doldurur, HİÇBİR ŞEY GÖNDERMEZ', async () => {
    await writeConfig('fixture-a');
    const ledger = new Ledger(':memory:');
    withAccount(ledger, 'fixture-a');

    const outcome = await submitListing('fixture-a', options(ledger));

    expect(outcome.status).toBe('completed');
    expect(outcome.note).toMatch(/dry-run.*gönderilmedi/);
    expect(received.loginPosts).toBe(1); // giriş bir yayın değil: dry-run'da da yapılır
    expect(received.submitPosts).toEqual([]); // ama liste gönderimi YOK
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

  it('zorunlu alan boş kalırsa dry-run başarısız sayar', async () => {
    // Form adımı description'ı doldurmuyor ama sayfa zorunlu işaretlemiş olsaydı yakalanmalı: burada
    // varolmayan bir seçici (optional olmayan) → 'Selector bulunamadı' → failed.
    await writeConfig('fixture-c', {
      steps: [
        { type: 'goto', url: '{{signupUrl}}' },
        { type: 'fill', selector: "input[name='yok']", field: 'website' },
      ],
    });
    const ledger = new Ledger(':memory:');
    withAccount(ledger, 'fixture-c');
    const outcome = await submitListing('fixture-c', options(ledger));
    expect(outcome.status).toBe('failed');
    expect(outcome.note).toMatch(/Selector bulunamadı/);
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
});

describe('submitListing — GERÇEK gönderim', () => {
  it('profil onaylı DEĞİLSE göndermez ve tarayıcı açmaz', async () => {
    await writeConfig('fixture-g');
    const ledger = new Ledger(':memory:');
    withAccount(ledger, 'fixture-g');
    const outcome = await submitListing('fixture-g', options(ledger, { dryRun: false }));
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
    const profile = await loadProfile('geo-new');
    await approveProfile('geo-new', { ...profile, tagline: 'eski, onaylanmış slogan' }, { dir: approvalDir });
    const outcome = await submitListing('fixture-h', options(ledger, { dryRun: false }));
    expect(outcome.status).toBe('skipped_not_approved');
    expect(outcome.note).toMatch(/DEĞİŞMİŞ/);
    expect(received.submitPosts).toEqual([]);
    ledger.close();
  });

  it('onaylıysa gönderir; ürün bilgileri formda; başarı doğrulanır; ikinci kez GÖNDERMEZ', async () => {
    await writeConfig('fixture-i');
    const ledger = new Ledger(':memory:');
    withAccount(ledger, 'fixture-i');
    const profile = await loadProfile('geo-new');
    await approveProfile('geo-new', profile, { dir: approvalDir });

    const first = await submitListing('fixture-i', options(ledger, { dryRun: false }));
    expect(first.status).toBe('completed');
    expect(first.listingUrl).toBe(`${base}/submit`);
    expect(received.submitPosts).toHaveLength(1);
    expect(received.submitPosts[0]).toMatchObject({ site: profile.website, title: profile.companyName });
    expect(received.submitPosts[0]?.desc).toBeTruthy();
    expect(ledger.liveSubmission('fixture-i')?.status).toBe('completed');

    const second = await submitListing('fixture-i', options(ledger, { dryRun: false }));
    expect(second.status).toBe('skipped_done');
    expect(received.submitPosts).toHaveLength(1); // çift yayın YOK

    const forced = await submitListing('fixture-i', options(ledger, { dryRun: false, force: true }));
    expect(forced.status).toBe('completed');
    expect(received.submitPosts).toHaveLength(2); // --force bilinçli aşar
    ledger.close();
  }, 120_000);

  it('başarı işareti görünmezse "unconfirmed": yayınlanmış olabilir, OTOMATİK yeniden denenmez', async () => {
    await writeConfig('fixture-j', { success: { anyOf: ['#hic-gorunmeyen'] } });
    const ledger = new Ledger(':memory:');
    withAccount(ledger, 'fixture-j');
    await approveProfile('geo-new', await loadProfile('geo-new'), { dir: approvalDir });

    const first = await submitListing('fixture-j', options(ledger, { dryRun: false }));
    expect(first.status).toBe('unconfirmed');
    expect(received.submitPosts).toHaveLength(1);

    const retry = await submitListing('fixture-j', options(ledger, { dryRun: false }));
    expect(retry.status).toBe('skipped_done');
    expect(retry.note).toMatch(/doğrulanamadı/);
    expect(received.submitPosts).toHaveLength(1); // ikinci POST yok
    ledger.close();
  }, 120_000);

  it('hiçbir şey gönderilmediği KESİN hata (öğe bulunamadı) yeniden denenebilir: failed', async () => {
    await writeConfig('fixture-k', {
      steps: [
        { type: 'goto', url: '{{signupUrl}}' },
        { type: 'fill', selector: "input[name='yok']", field: 'website' },
        { type: 'click', selector: '#send' },
      ],
    });
    const ledger = new Ledger(':memory:');
    withAccount(ledger, 'fixture-k');
    await approveProfile('geo-new', await loadProfile('geo-new'), { dir: approvalDir });

    expect((await submitListing('fixture-k', options(ledger, { dryRun: false }))).status).toBe('failed');
    expect(ledger.liveSubmission('fixture-k')).toBeNull(); // yeniden denemeyi ENGELLEMEZ
    expect(received.submitPosts).toEqual([]);
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
});

describe('submitListing — yüksek riskli site', () => {
  it('kayıt config\'inde risk:high ise listeleme yapılmaz', async () => {
    // Gerçek bir yüksek riskli config: podbean (src/sites/podbean.json, risk:high)
    await writeConfig('podbean');
    const ledger = new Ledger(':memory:');
    withAccount(ledger, 'podbean');
    const outcome = await submitListing('podbean', options(ledger));
    expect(outcome.status).toBe('skipped_high_risk');
    expect(launches).toBe(0);
    ledger.close();
  });
});

vi.setConfig({ testTimeout: 60_000 });
