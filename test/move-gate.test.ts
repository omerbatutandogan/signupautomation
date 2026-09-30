import { describe, expect, it, vi } from 'vitest';
import pino from 'pino';
import { runSite } from '../src/core/runner.js';
import { MOVE_MARKER } from '../src/core/markers.js';
import { Ledger } from '../src/integrations/ledger.js';
import type { SiteAdapter, SiteConfig } from '../src/core/types.js';

/**
 * Taşınma onayı kapısı — runner seviyesinde.
 *
 * Keşif başka domaine taşınmış siteyi takip ediyor ve config'e onay
 * damgası basıyor (taşınma sanılan yer ölü domainin satış pazarı ya da
 * bir platform olabilir). run-batch damgalı config'i atlıyordu ama
 * `run <siteId>` doğrudan runSite'a gidiyor ve damgayı hiç okumuyordu.
 * Kapı runSite'ta olmalı ki hiçbir yol atlatamasın.
 */

function movedSite(): { adapter: SiteAdapter; siteConfig: SiteConfig; signup: ReturnType<typeof vi.fn> } {
  const signup = vi.fn();
  const siteConfig = {
    id: 'moved-dir',
    name: 'Moved Dir',
    risk: 'low',
    signupUrl: 'https://new-owner.example/signup',
    notes: `OTOMATİK ÜRETİLDİ — doğrulanmadı ${MOVE_MARKER} Uyarılar: Site taşınmış: moved-dir.com → new-owner.example`,
    steps: [{ type: 'goto', url: '{{signupUrl}}' }],
    verification: { mode: 'none' },
    emailLocalPart: 'moved-dir',
  } as unknown as SiteConfig;
  const adapter = {
    id: 'moved-dir',
    name: 'Moved Dir',
    risk: 'low',
    emailLocalPart: 'moved-dir',
    verification: { mode: 'none' },
    signup,
  } as unknown as SiteAdapter;
  return { adapter, siteConfig, signup };
}

describe('runSite — taşınma onayı kapısı', () => {
  it('damgalı config ile GERÇEK kayıt yapmaz, tarayıcı açmadan çıkar', async () => {
    const { adapter, siteConfig, signup } = movedSite();
    const ledger = new Ledger(':memory:');
    try {
      const outcome = await runSite('moved-dir', {
        log: pino({ level: 'silent' }),
        ledger,
        dryRun: false,
        adapter,
        siteConfig,
      });

      expect(outcome.status).toBe('manual');
      expect(outcome.note).toMatch(/taşın/i);
      expect(signup).not.toHaveBeenCalled();
    } finally {
      ledger.close();
    }
  });
});
