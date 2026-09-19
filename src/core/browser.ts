/**
 * Playwright context yönetimi.
 *
 * Kalıcı profil kullanılıyor: çözülmüş Turnstile/Cloudflare cookie'leri
 * saklanıyor, aynı sitede tekrar denemelerde challenge genelde hiç çıkmıyor.
 * Viewport site başına SABİT — her çalıştırmada değişen fingerprint şüphe çeker.
 */

import { chromium, type BrowserContext, type Page } from 'playwright';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { env } from '../config.js';
import { attachCaptchaSniffer, type CaptchaNetworkState } from './captcha.js';

const PROFILE_ROOT = 'data/profiles';

/** Gerçekçi masaüstü viewport'ları — site id'sinden deterministik seçilir. */
const VIEWPORTS = [
  { width: 1440, height: 900 },
  { width: 1512, height: 982 },
  { width: 1680, height: 1050 },
  { width: 1920, height: 1080 },
] as const;

export interface LaunchedContext {
  context: BrowserContext;
  page: Page;
  captchaNetwork: CaptchaNetworkState;
  close(): Promise<void>;
}

/** Site id'sinden deterministik viewport — aynı site hep aynı boyutu görür. */
function viewportFor(siteId: string): { width: number; height: number } {
  const hash = createHash('sha256').update(siteId).digest()[0] ?? 0;
  return VIEWPORTS[hash % VIEWPORTS.length]!;
}

export async function launchContext(
  siteId: string,
  opts: { headless?: boolean } = {},
): Promise<LaunchedContext> {
  const profileDir = `${PROFILE_ROOT}/${siteId}`;
  await mkdir(profileDir, { recursive: true });

  const viewport = viewportFor(siteId);

  const context = await chromium.launchPersistentContext(profileDir, {
    headless: opts.headless ?? env.HEADLESS,
    viewport,
    locale: 'en-US',
    timezoneId: 'Europe/Istanbul',
    // Otomasyon bayrağını gizlemek bot tespitini "atlatmak" için değil;
    // bazı siteler bu bayrakla formu hiç göstermiyor ve akış boşa çıkıyor.
    args: ['--disable-blink-features=AutomationControlled'],
  });

  const captchaNetwork = attachCaptchaSniffer(context);

  const page = context.pages()[0] ?? (await context.newPage());
  page.setDefaultTimeout(15_000);

  return {
    context,
    page,
    captchaNetwork,
    async close() {
      await context.close().catch(() => {
        /* kapanış hatası asıl sonucu gölgelememeli */
      });
    },
  };
}

/**
 * Kalıcı profilde saklanan site notları (ör. şifre sürümü değişikliği).
 * Ledger'dan farklı: burası tarayıcı profiliyle birlikte yaşar/silinir.
 */
export async function readProfileNote(siteId: string): Promise<Record<string, unknown>> {
  try {
    return JSON.parse(await readFile(`${PROFILE_ROOT}/${siteId}/_note.json`, 'utf8')) as Record<
      string,
      unknown
    >;
  } catch {
    return {};
  }
}

export async function writeProfileNote(
  siteId: string,
  note: Record<string, unknown>,
): Promise<void> {
  await mkdir(`${PROFILE_ROOT}/${siteId}`, { recursive: true });
  await writeFile(`${PROFILE_ROOT}/${siteId}/_note.json`, JSON.stringify(note, null, 2));
}
