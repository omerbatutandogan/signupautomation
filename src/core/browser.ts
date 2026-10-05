/**
 * Playwright context yönetimi.
 *
 * Kalıcı profil kullanılıyor: çözülmüş Turnstile/Cloudflare cookie'leri
 * saklanıyor, aynı sitede tekrar denemelerde challenge genelde hiç çıkmıyor.
 * Viewport site başına SABİT — her çalıştırmada değişen fingerprint şüphe çeker.
 */

import { chromium, type BrowserContext, type Page } from 'playwright';
import { access, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { env } from '../config.js';
import { attachCaptchaSniffer, type CaptchaNetworkState } from './captcha.js';

const PROFILE_ROOT = 'data/profiles';

/** Geçici (dry-run) profil dizinlerinin öneki. */
export const TEMP_PROFILE_PREFIX = '.dry-';

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

async function exists(path: string): Promise<boolean> {
  return access(path).then(
    () => true,
    () => false,
  );
}

/**
 * @param opts.ephemeral  Henüz kalıcı profili OLMAYAN bir site için geçici profil
 *   kullan ve kapanışta sil. Dry-run için: kalıcı profilin tek işi çerez
 *   saklamak ve dry-run submit etmediği için saklanacak oturum yok; üstelik
 *   her profil yüzlerce MB tutabilir (700 taslağı doğrulamak diski doldururdu).
 *   Kalıcı profili ZATEN olan site (gerçek hesabı olan) eskisi gibi onu kullanır:
 *   çözülmüş Cloudflare çerezleri korunur.
 */
export async function launchContext(
  siteId: string,
  opts: { headless?: boolean; ephemeral?: boolean } = {},
): Promise<LaunchedContext> {
  const permanentDir = `${PROFILE_ROOT}/${siteId}`;
  const ephemeral = opts.ephemeral === true && !(await exists(permanentDir));

  let profileDir = permanentDir;
  if (ephemeral) {
    await mkdir(PROFILE_ROOT, { recursive: true });
    // ".dry-" öneki: yarıda ölen bir tur geride bu dizini bırakırsa tek bakışta
    // tanınsın ve temizlenebilsin (scripts/verify-drafts.ts bunu yapar).
    profileDir = await mkdtemp(`${PROFILE_ROOT}/${TEMP_PROFILE_PREFIX}`);
  } else {
    await mkdir(profileDir, { recursive: true });
  }
  const removeTemp = () => (ephemeral ? rm(profileDir, { recursive: true, force: true }).catch(() => undefined) : undefined);

  const viewport = viewportFor(siteId);

  let context: BrowserContext;
  try {
    context = await chromium.launchPersistentContext(profileDir, {
      headless: opts.headless ?? env.HEADLESS,
      viewport,
      locale: 'en-US',
      timezoneId: 'Europe/Istanbul',
      // Otomasyon bayrağını gizlemek bot tespitini "atlatmak" için değil;
      // bazı siteler bu bayrakla formu hiç göstermiyor ve akış boşa çıkıyor.
      args: ['--disable-blink-features=AutomationControlled'],
    });
  } catch (err) {
    await removeTemp();
    throw err;
  }

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
      await removeTemp();
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
