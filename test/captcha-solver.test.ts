import { describe, expect, it } from 'vitest';
import { parseSiteConfig } from '../src/adapters/schema.js';
import { shouldSolveCaptcha } from '../src/adapters/generic.js';

/**
 * 2captcha opt-in sınırları.
 *
 * Davranış BİLEREK değişti: eskiden solveCaptcha VARSAYILAN KAPALIYDI
 * (her site için elle solveCaptcha:true yazılması gerekiyordu). Proje
 * hedefi "herhangi bir siteye kaydolabilen, captcha'yı geçebilen" bir
 * sistem olunca bu varsayılan tersine çevrildi: risk:"high" hariç
 * VARSAYILAN AÇIK. ToS koruması hâlâ kritik ve hiç gevşemedi — yalnızca
 * hangi tarafın varsayılan olduğu değişti. shouldSolveCaptcha() bu
 * kararın TEK yeri.
 */

const base = {
  id: 'example',
  name: 'Example',
  risk: 'low' as const,
  signupUrl: 'https://example.com/signup',
  steps: [{ type: 'goto', url: '{{signupUrl}}' }],
  verification: { mode: 'none' as const },
};

describe('solveCaptcha config alanı', () => {
  it('config’de belirtilmezse alan undefined kalır (schema seviyesi)', () => {
    // Şemanın kendisi hâlâ opsiyonel — VARSAYILAN DAVRANIŞ artık
    // shouldSolveCaptcha()'da, schema'da değil.
    const cfg = parseSiteConfig(base, 'test');
    expect(cfg.solveCaptcha).toBeUndefined();
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

describe('shouldSolveCaptcha — VARSAYILAN AÇIK, risk:high hariç', () => {
  it('belirtilmemiş alan + risk:low → AÇIK (yeni varsayılan)', () => {
    expect(shouldSolveCaptcha({ solveCaptcha: undefined, risk: 'low' })).toBe(true);
  });

  it('belirtilmemiş alan + risk:medium → AÇIK', () => {
    expect(shouldSolveCaptcha({ solveCaptcha: undefined, risk: 'medium' })).toBe(true);
  });

  it('açıkça false → KAPALI, risk ne olursa olsun', () => {
    // alternativeto/blogarama deseni: ToS okunamadığı için bilerek
    // beklemede tutuluyor, düşük riskli olsalar bile.
    expect(shouldSolveCaptcha({ solveCaptcha: false, risk: 'low' })).toBe(false);
  });

  it('risk:high → HER ZAMAN KAPALI, solveCaptcha ne olursa olsun', () => {
    // BU SATIR ASLA GEVŞEMEMELİ — ToS otomatik erişimi/captcha bypass'ını
    // açıkça yasaklayan siteler (G2, Capterra, Product Hunt, Podbean,
    // Spreaker) için tek koruma.
    expect(shouldSolveCaptcha({ solveCaptcha: undefined, risk: 'high' })).toBe(false);
    expect(shouldSolveCaptcha({ solveCaptcha: true, risk: 'high' })).toBe(false);
  });

  it('açıkça true + risk:low → AÇIK', () => {
    expect(shouldSolveCaptcha({ solveCaptcha: true, risk: 'low' })).toBe(true);
  });
});

describe('mevcut site configleri', () => {
  it('risk:high olan hiçbir sitede solveCaptcha AÇIKÇA true değil', async () => {
    // İkinci savunma katmanı: config elle risk:high + solveCaptcha:true
    // yazılmışsa bu bir uyarı sinyali — shouldSolveCaptcha zaten reddeder
    // ama config'in kendisi böyle bir çelişki taşımamalı.
    const { listSiteIds, loadSiteConfig } = await import('../src/adapters/registry.js');
    const ids = await listSiteIds();

    const violations: string[] = [];
    for (const id of ids) {
      const cfg = await loadSiteConfig(id);
      if (cfg.risk === 'high' && cfg.solveCaptcha === true) violations.push(id);
    }
    expect(violations).toEqual([]);
  });

  it('risk:high olan HER site için shouldSolveCaptcha false döner', async () => {
    const { listSiteIds, loadSiteConfig } = await import('../src/adapters/registry.js');
    const ids = await listSiteIds();

    for (const id of ids) {
      const cfg = await loadSiteConfig(id);
      if (cfg.risk === 'high') {
        expect(shouldSolveCaptcha(cfg)).toBe(false);
      }
    }
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
