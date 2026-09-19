/**
 * Bir kayıt sayfasındaki form alanlarını listeler.
 *
 * Yeni bir site config'i yazarken ilk adım: gerçek DOM'u görmek. Tahminle
 * selector yazıp --dry-run'da başarısız olmaktansa, formu bir kez okuyup
 * doğru selector'ı yazmak çok daha hızlı.
 *
 * Kullanım:
 *   npm run inspect -- https://alternativeto.net/signup
 *   npm run inspect -- alternativeto        (config'ten signupUrl okur)
 */

import { chromium } from 'playwright';
import { loadSiteConfig } from '../src/adapters/registry.js';

interface FieldInfo {
  tag: string;
  type: string;
  name: string;
  id: string;
  placeholder: string;
  ariaLabel: string;
  maxLength: string;
  required: boolean;
  visible: boolean;
  suggested: string;
}

async function resolveUrl(arg: string): Promise<string> {
  if (arg.startsWith('http')) return arg;
  const cfg = await loadSiteConfig(arg);
  return cfg.signupUrl;
}

async function main(): Promise<void> {
  const arg = process.argv[2];
  if (!arg) {
    console.error('Kullanım: npm run inspect -- <url|siteId>');
    process.exit(1);
  }

  const url = await resolveUrl(arg);
  console.log(`\n🔍 İnceleniyor: ${url}\n`);

  // Headed çalışıyor: bazı siteler (AlternativeTo dahil) headless tarayıcıda
  // formu hiç render etmiyor — headless'ta "form bulunamadı" sanılıyordu.
  const browser = await chromium.launch({
    headless: false,
    args: ['--disable-blink-features=AutomationControlled'],
  });
  const page = await browser.newPage();

  try {
    // networkidle kullanma: reklam/analytics sürekli istek atan sitelerde
    // (AlternativeTo dahil) hiç gerçekleşmiyor ve timeout'a düşüyor.
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 45_000 });
    // JS ile render edilen formlar için bekle.
    await page.waitForTimeout(4000);

    const fields = await page.evaluate((): FieldInfo[] => {
      const nodes = Array.from(
        document.querySelectorAll('input, textarea, select, button[type="submit"], button'),
      );

      return nodes.map((el) => {
        const tag = el.tagName.toLowerCase();
        const input = el as HTMLInputElement;
        const rect = el.getBoundingClientRect();

        // En kararlı selector'ı öner: name > id > type > aria-label
        let suggested = '';
        if (input.name) suggested = `${tag}[name='${input.name}']`;
        else if (el.id) suggested = `#${el.id}`;
        else if (input.type && tag === 'input') suggested = `input[type='${input.type}']`;
        else if (el.getAttribute('aria-label')) {
          suggested = `${tag}[aria-label='${el.getAttribute('aria-label')}']`;
        } else if (tag === 'button') {
          suggested = `button:has-text('${(el.textContent ?? '').trim().slice(0, 30)}')`;
        }

        return {
          tag,
          type: input.type ?? '',
          name: input.name ?? '',
          id: el.id ?? '',
          placeholder: input.placeholder ?? '',
          ariaLabel: el.getAttribute('aria-label') ?? '',
          maxLength: input.maxLength && input.maxLength > 0 ? String(input.maxLength) : '',
          required: input.required ?? false,
          visible: rect.width > 0 && rect.height > 0,
          suggested,
        };
      });
    });

    const visible = fields.filter((f) => f.visible);
    if (visible.length === 0) {
      console.log('Görünür form alanı bulunamadı (sayfa JS ile geç render ediyor olabilir).');
    }

    for (const f of visible) {
      const label = f.placeholder || f.ariaLabel || f.name || f.id || '(etiketsiz)';
      const meta = [
        f.type && `type=${f.type}`,
        f.required && 'required',
        f.maxLength && `maxlength=${f.maxLength}`,
      ]
        .filter(Boolean)
        .join(' ');

      console.log(`  ${f.tag.padEnd(8)} ${label}`);
      if (meta) console.log(`           ${meta}`);
      console.log(`           → ${f.suggested}`);
      console.log();
    }

    // Captcha var mı?
    const captchaMarkers = await page.evaluate(() => {
      const found: string[] = [];
      if (document.querySelector('iframe[src*="hcaptcha"], .h-captcha')) found.push('hCaptcha');
      if (document.querySelector('iframe[src*="recaptcha"], .g-recaptcha')) found.push('reCAPTCHA');
      if (document.querySelector('iframe[src*="challenges.cloudflare"], .cf-turnstile')) {
        found.push('Turnstile');
      }
      return found;
    });

    if (captchaMarkers.length > 0) {
      console.log(`⚠️  Captcha tespit edildi: ${captchaMarkers.join(', ')}`);
      console.log('   Config\'e "captchaGate" adımı ekle (submit\'ten önce).\n');
    } else {
      console.log('✅ Sayfada captcha görünmüyor.\n');
    }
  } finally {
    await browser.close();
  }
}

main().catch((err: unknown) => {
  console.error('Hata:', err instanceof Error ? err.message : err);
  process.exit(1);
});
