/**
 * Test fixture sunucusu — gerçek siteleri dövmeden akış testi.
 *
 * Yeni bir retry/captcha mantığını doğrudan gerçek dizinlerde denemek hem
 * bot tespiti riskini artırır hem de tekrarlanabilir değildir. Bu sunucu
 * aynı senaryoları deterministik üretir.
 */

import express from 'express';
import type { Server } from 'node:http';

export const FIXTURE_PORT = 4599;

/** Cloudflare Turnstile resmî test anahtarları. */
const TURNSTILE_ALWAYS_PASS = '1x00000000000000000000AA';
const TURNSTILE_ALWAYS_BLOCK = '2x00000000000000000000AB';

function page(body: string, opts: { head?: string } = {}): string {
  return `<!DOCTYPE html>
<html><head><meta charset="utf-8"><title>Fixture</title>${opts.head ?? ''}</head>
<body>${body}</body></html>`;
}

export function createFixtureApp(): express.Express {
  const app = express();
  app.use(express.urlencoded({ extended: true }));

  // Durum: flaky endpoint'in kaç kez çağrıldığı.
  let flakyHits = 0;
  app.post('/_reset', (_req, res) => {
    flakyHits = 0;
    res.json({ ok: true });
  });

  // ── Mutlu yol ──────────────────────────────────────────────────────────
  app.get('/simple', (_req, res) => {
    res.send(
      page(`
      <form method="post" action="/simple">
        <input type="email" name="email" />
        <input type="password" name="password" />
        <input type="checkbox" name="terms" />
        <button type="submit">Sign up</button>
      </form>`),
    );
  });
  app.post('/simple', (_req, res) => {
    res.send(page('<h1>Check your email</h1><p>We sent a verification link.</p>'));
  });

  // ── maxlength: açıklama varyant seçimi ─────────────────────────────────
  app.get('/maxlength', (_req, res) => {
    res.send(
      page(`
      <form method="post" action="/simple">
        <textarea id="short" maxlength="60"></textarea>
        <textarea id="medium" maxlength="160"></textarea>
        <textarea id="long" maxlength="520"></textarea>
        <div><textarea id="counter"></textarea><span>0 / 200</span></div>
        <button type="submit">Save</button>
      </form>`),
    );
  });

  // ── Zaten kayıtlı → PermanentError ─────────────────────────────────────
  app.get('/already-exists', (_req, res) => {
    res.send(
      page(`
      <form method="post" action="/already-exists">
        <input type="email" name="email" />
        <input type="password" name="password" />
        <button type="submit">Sign up</button>
      </form>`),
    );
  });
  app.post('/already-exists', (_req, res) => {
    res.send(page('<h1>Error</h1><p>That email has already been registered.</p>'));
  });

  // ── Manuel inceleme: telefon doğrulaması isteniyor ─────────────────────
  app.get('/needs-phone', (_req, res) => {
    res.send(page('<h1>Almost there</h1><p>Phone verification required to continue.</p>'));
  });

  // ── Flaky: ilk 2 istekte 503 → TransientError + backoff ────────────────
  app.get('/flaky', (_req, res) => {
    flakyHits++;
    if (flakyHits <= 2) {
      res.status(503).send(page('<h1>Service Unavailable</h1>'));
      return;
    }
    res.send(page('<form><input type="email" name="email" /><button>Go</button></form>'));
  });

  // ── Turnstile: geçen ve bloklayan varyantlar ───────────────────────────
  const turnstilePage = (sitekey: string): string =>
    page(
      `<form method="post" action="/simple">
        <input type="email" name="email" />
        <div class="cf-turnstile" data-sitekey="${sitekey}"></div>
        <button type="submit">Sign up</button>
      </form>`,
      { head: '<script src="https://challenges.cloudflare.com/turnstile/v0/api.js" async></script>' },
    );

  app.get('/turnstile-pass', (_req, res) => res.send(turnstilePage(TURNSTILE_ALWAYS_PASS)));
  app.get('/turnstile-block', (_req, res) => res.send(turnstilePage(TURNSTILE_ALWAYS_BLOCK)));

  // ── Yavaş: timeout testi ───────────────────────────────────────────────
  app.get('/slow', (_req, res) => {
    setTimeout(() => res.send(page('<h1>Finally</h1>')), 30_000);
  });

  return app;
}

export function startFixtureServer(port = FIXTURE_PORT): Promise<Server> {
  const app = createFixtureApp();
  return new Promise((resolve, reject) => {
    const server = app.listen(port, () => resolve(server));
    server.on('error', reject);
  });
}

// Doğrudan çalıştırıldığında sunucuyu ayağa kaldır.
if (process.argv[1]?.endsWith('fixture-server.ts')) {
  startFixtureServer()
    .then(() => console.log(`Fixture sunucusu: http://localhost:${FIXTURE_PORT}`))
    .catch((err: unknown) => {
      console.error('Fixture sunucusu başlatılamadı:', err);
      process.exit(1);
    });
}
