import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { chromium, type Browser, type Page } from 'playwright';
import pino from 'pino';
import { runSite } from '../src/core/runner.js';
import { Ledger } from '../src/integrations/ledger.js';
import { PermanentError } from '../src/core/errors.js';
import type { SiteAdapter, SiteConfig } from '../src/core/types.js';

/**
 * Dry-run iz bırakmaz.
 *
 * 1) Kimlik kaydı yok: dry-run submit etmez, hesap da yoktur. Sahte kayıt
 *    credentials tablosunu yalanlıyor ve aynı e-postayı kullanan başka bir
 *    ürünün gerçek kaydını "çakışma" diye engelliyordu.
 * 2) Kalıcı profil yok: dry-run geçici profil ister (ayrıntısı ephemeral-profile
 *    testinde, gerçek launchContext ile).
 */

const browserSpy = vi.hoisted(() => ({
  launches: [] as Array<{ key: string; opts: unknown }>,
  page: null as Page | null,
}));

// runSite testlerinde gerçek profil dizini açılmasın: tarayıcı sarmalayıcısı
// paylaşılan bir sayfa döndürür, ama çağrı parametreleri kaydedilir.
vi.mock('../src/core/browser.js', async (original) => ({
  ...(await original<typeof import('../src/core/browser.js')>()),
  launchContext: vi.fn(async (key: string, opts: unknown) => {
    browserSpy.launches.push({ key, opts });
    return {
      context: {},
      page: browserSpy.page,
      captchaNetwork: {},
      close: async () => undefined,
    };
  }),
}));

let browser: Browser;

beforeAll(async () => {
  browser = await chromium.launch({ headless: true });
  browserSpy.page = await browser.newPage();
  await browserSpy.page.setContent('<form><input name="email"><button type="submit">Go</button></form>');
}, 30_000);

afterAll(async () => {
  await browser?.close();
});

function site(id: string): { adapter: SiteAdapter; siteConfig: SiteConfig } {
  const siteConfig = {
    id,
    name: id,
    risk: 'low',
    signupUrl: `https://${id}.example/signup`,
    steps: [{ type: 'goto', url: '{{signupUrl}}' }],
    verification: { mode: 'none' },
    emailLocalPart: id,
  } as unknown as SiteConfig;
  const adapter = {
    id,
    name: id,
    risk: 'low',
    emailLocalPart: id,
    verification: { mode: 'none' },
    // Sayfaya hiç dokunmaz; gerçek çalıştırmada hemen düşer (submit yok).
    signup: vi.fn(async () => {
      throw new PermanentError('test: bilerek durduruldu');
    }),
  } as unknown as SiteAdapter;
  return { adapter, siteConfig };
}

describe('runSite — dry-run kimlik kaydı yazmaz', () => {
  it('dry-run: credentials tablosunda satır OLUŞMAZ, geçici profil istenir', async () => {
    const { adapter, siteConfig } = site('trace-dry');
    const ledger = new Ledger(':memory:');
    browserSpy.launches.length = 0;
    try {
      // Dry-run: adapter.signup sonuç döndürsün ki dry-run dalı çalışsın.
      (adapter.signup as ReturnType<typeof vi.fn>).mockResolvedValueOnce({ status: 'submitted', needsEmailVerification: false });
      await runSite('trace-dry', { log: pino({ level: 'silent' }), ledger, dryRun: true, adapter, siteConfig });

      expect(ledger.credentials('trace-dry')).toBeNull();
      expect(browserSpy.launches).toEqual([{ key: 'trace-dry', opts: { ephemeral: true } }]);
      // Deneme kaydı yine tutulur (dry-run olarak): sonuç ledger'da görünür.
      expect(ledger.recentAttempts(5)[0]).toMatchObject({ site_id: 'trace-dry', dry_run: 1 });
    } finally {
      ledger.close();
    }
  }, 30_000);

  it('gerçek çalıştırma (kontrol): kimlik submit\'ten ÖNCE kaydedilir, kalıcı profil istenir', async () => {
    const { adapter, siteConfig } = site('trace-real');
    const ledger = new Ledger(':memory:');
    browserSpy.launches.length = 0;
    try {
      const outcome = await runSite('trace-real', { log: pino({ level: 'silent' }), ledger, dryRun: false, adapter, siteConfig });

      expect(outcome.status).toBe('failed'); // adapter bilerek düştü; submit olmadı
      expect(ledger.credentials('trace-real')).toMatchObject({ site_id: 'trace-real' });
      expect(browserSpy.launches).toEqual([{ key: 'trace-real', opts: { ephemeral: false } }]);
    } finally {
      ledger.close();
    }
  }, 30_000);
});
