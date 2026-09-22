import { describe, expect, it } from 'vitest';
import { parseSiteConfig } from '../src/adapters/schema.js';

/**
 * 2captcha opt-in sınırları.
 *
 * Bu testler bir ToS korumasını koruyor: bazı dizinlerin kullanım
 * şartları captcha bypass'ını yasaklıyor ve ban kalıcı listing kaybı
 * demek. Varsayılanın kapalı kalması kritik.
 */

const base = {
  id: 'example',
  name: 'Example',
  risk: 'low' as const,
  signupUrl: 'https://example.com/signup',
  steps: [{ type: 'goto', url: '{{signupUrl}}' }],
  verification: { mode: 'none' as const },
};

describe('solveCaptcha opt-in sınırları', () => {
  it('config’de belirtilmezse VARSAYILAN KAPALI', () => {
    const cfg = parseSiteConfig(base, 'test');
    // undefined = kapalı. Açıkça true yazılmadıkça çözücü devreye girmez.
    expect(cfg.solveCaptcha).toBeUndefined();
    expect(Boolean(cfg.solveCaptcha)).toBe(false);
  });

  it('açıkça true yazılabilir', () => {
    const cfg = parseSiteConfig({ ...base, solveCaptcha: true }, 'test');
    expect(cfg.solveCaptcha).toBe(true);
  });

  it('açıkça false yazılabilir', () => {
    const cfg = parseSiteConfig({ ...base, solveCaptcha: false }, 'test');
    expect(cfg.solveCaptcha).toBe(false);
  });

  it('boolean olmayan değeri reddeder', () => {
    expect(() => parseSiteConfig({ ...base, solveCaptcha: 'yes' }, 'test')).toThrow();
  });
});

describe('mevcut site configleri', () => {
  it('hiçbirinde solveCaptcha varsayılan olarak açık değil', async () => {
    const { listSiteIds, loadSiteConfig } = await import('../src/adapters/registry.js');
    const ids = await listSiteIds();

    for (const id of ids) {
      const cfg = await loadSiteConfig(id);
      if (cfg.solveCaptcha) {
        // Açıksa risk'i high OLMAMALI — yüksek riskli sitelerde
        // captcha bypass ToS ihlali.
        expect(cfg.risk).not.toBe('high');
      }
    }
  });

  it('yüksek riskli sitede solveCaptcha açık bırakılmamış', async () => {
    const { listSiteIds, loadSiteConfig } = await import('../src/adapters/registry.js');
    const ids = await listSiteIds();

    const violations: string[] = [];
    for (const id of ids) {
      const cfg = await loadSiteConfig(id);
      if (cfg.risk === 'high' && cfg.solveCaptcha) violations.push(id);
    }
    expect(violations).toEqual([]);
  });
});

describe('sitekeyFromFrameUrl', () => {
  it('yol segmentindeki Turnstile sitekey’ini bulur', async () => {
    const { sitekeyFromFrameUrl } = await import('../src/integrations/captcha-solver.js');
    // Gerçek BetaList frame URL'i — sitekey sorgu parametresinde DEĞİL,
    // yol segmentinde. Sadece ?k= aramak bunu kaçırıyordu.
    const url =
      'https://challenges.cloudflare.com/cdn-cgi/challenge-platform/h/g/turnstile/f/av0/rch/3k4pd/0x4AAAAAAED8fxV-8iaPiv7C/auto/fbE/new/normal?lang=auto';
    expect(sitekeyFromFrameUrl(url)).toBe('0x4AAAAAAED8fxV-8iaPiv7C');
  });

  it('sorgu parametresindeki sitekey’i bulur', async () => {
    const { sitekeyFromFrameUrl } = await import('../src/integrations/captcha-solver.js');
    expect(sitekeyFromFrameUrl('https://x.com/frame?k=6LeIxAcTAAAAAJcZVRqyHh71UMIE')).toBe(
      '6LeIxAcTAAAAAJcZVRqyHh71UMIE',
    );
    expect(sitekeyFromFrameUrl('https://x.com/f?sitekey=abc123def456')).toBe('abc123def456');
  });

  it('sitekey yoksa null döner', async () => {
    const { sitekeyFromFrameUrl } = await import('../src/integrations/captcha-solver.js');
    expect(sitekeyFromFrameUrl('https://example.com/plain/page')).toBeNull();
  });
});
