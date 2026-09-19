import { describe, expect, it } from 'vitest';
import { parseSiteConfig, StepSchema } from '../src/adapters/schema.js';

const validConfig = {
  id: 'example',
  name: 'Example',
  risk: 'low',
  signupUrl: 'https://example.com/register',
  steps: [{ type: 'goto', url: '{{signupUrl}}' }],
  verification: { mode: 'none' },
};

describe('StepSchema', () => {
  it('fill adımında field veya value şart', () => {
    const missing = StepSchema.safeParse({ type: 'fill', selector: '#email' });
    expect(missing.success).toBe(false);

    expect(StepSchema.safeParse({ type: 'fill', selector: '#email', field: 'email' }).success).toBe(
      true,
    );
    expect(StepSchema.safeParse({ type: 'fill', selector: '#x', value: 'sabit' }).success).toBe(
      true,
    );
  });

  it('bilinmeyen adım tipini reddeder', () => {
    expect(StepSchema.safeParse({ type: 'teleport', selector: '#x' }).success).toBe(false);
  });

  it('goto adımı url gerektirir', () => {
    expect(StepSchema.safeParse({ type: 'goto' }).success).toBe(false);
    expect(StepSchema.safeParse({ type: 'goto', url: 'https://x.com' }).success).toBe(true);
  });

  it('dismiss en az bir selector ister', () => {
    expect(StepSchema.safeParse({ type: 'dismiss', selectors: [] }).success).toBe(false);
    expect(StepSchema.safeParse({ type: 'dismiss', selectors: ['#ok'] }).success).toBe(true);
  });

  it('captchaGate ek alan istemez', () => {
    expect(StepSchema.safeParse({ type: 'captchaGate' }).success).toBe(true);
  });

  it('ortak alanları (optional/timeoutMs/when) kabul eder', () => {
    const parsed = StepSchema.safeParse({
      type: 'click',
      selector: '#go',
      optional: true,
      timeoutMs: 5000,
      when: { urlContains: '/step2' },
    });
    expect(parsed.success).toBe(true);
  });
});

describe('parseSiteConfig', () => {
  it('geçerli config’i kabul eder', () => {
    expect(() => parseSiteConfig(validConfig, 'test')).not.toThrow();
  });

  it('hatalı id formatını reddeder', () => {
    expect(() => parseSiteConfig({ ...validConfig, id: 'Has Spaces' }, 'test')).toThrow(/id/);
  });

  it('geçersiz URL’i reddeder', () => {
    expect(() => parseSiteConfig({ ...validConfig, signupUrl: 'not-a-url' }, 'test')).toThrow();
  });

  it('boş adım listesini reddeder', () => {
    expect(() => parseSiteConfig({ ...validConfig, steps: [] }, 'test')).toThrow(/en az bir adım/);
  });

  it("mode:'code' için codeSelector zorunlu", () => {
    const cfg = { ...validConfig, verification: { mode: 'code' } };
    expect(() => parseSiteConfig(cfg, 'test')).toThrow(/codeSelector/);

    const ok = { ...validConfig, verification: { mode: 'code', codeSelector: '#otp' } };
    expect(() => parseSiteConfig(ok, 'test')).not.toThrow();
  });

  it('hata mesajı dosya adını ve alan yolunu içerir', () => {
    expect(() => parseSiteConfig({ ...validConfig, risk: 'extreme' }, 'sites/x.json')).toThrow(
      /sites\/x\.json[\s\S]*risk/,
    );
  });
});

describe('gerçek alternativeto.json', () => {
  it('şemaya uyuyor', async () => {
    const { loadSiteConfig } = await import('../src/adapters/registry.js');
    const cfg = await loadSiteConfig('alternativeto');
    expect(cfg.id).toBe('alternativeto');
    expect(cfg.verification.mode).toBe('link');
    // Faz 0'da gerçek mailden doğrulanan link formatı.
    expect(cfg.verification.linkPattern).toContain('verify-email');
  });
});
