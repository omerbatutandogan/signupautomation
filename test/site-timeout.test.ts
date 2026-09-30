import { describe, expect, it, vi } from 'vitest';
import { SiteTimeoutError, withSiteTimeout } from '../scripts/discover-queue.js';

/**
 * Keşifte site başına süre sınırı.
 *
 * Gerçek vaka (2026-09-30): financesonline.com bilinmeyen yollara hiç
 * yanıt vermiyor; headless ~100sn sürdü, headed denemesi 15 dakikayı
 * aştı ve ölçüm elle durduruldu. 3430 sitelik taramada tek bir site
 * bütün kuyruğu kilitleyebilirdi.
 */

describe('withSiteTimeout', () => {
  it('süre içinde biten işin sonucunu döner', async () => {
    const close = vi.fn(async () => undefined);
    await expect(withSiteTimeout(Promise.resolve('ok'), close, 1000)).resolves.toBe('ok');
    expect(close).not.toHaveBeenCalled();
  });

  it('süreyi aşan işte sayfayı kapatır ve SiteTimeoutError fırlatır', async () => {
    const close = vi.fn(async () => undefined);
    const never = new Promise<string>(() => undefined);
    await expect(withSiteTimeout(never, close, 50)).rejects.toBeInstanceOf(SiteTimeoutError);
    expect(close).toHaveBeenCalledOnce();
  });

  it('süre aşımından sonra işin geç gelen hatası süreci düşürmez', async () => {
    // Sayfa kapanınca bekleyen Playwright çağrısı reddediliyor; bu red
    // yakalanmazsa Node "unhandled rejection" ile taramayı öldürür.
    const unhandled = vi.fn();
    process.on('unhandledRejection', unhandled);
    try {
      let rejectLater: (e: Error) => void = () => undefined;
      const work = new Promise<string>((_, reject) => {
        rejectLater = reject;
      });
      await expect(withSiteTimeout(work, async () => rejectLater(new Error('Target closed')), 20)).rejects.toBeInstanceOf(
        SiteTimeoutError,
      );
      await new Promise((r) => setTimeout(r, 20));
      expect(unhandled).not.toHaveBeenCalled();
    } finally {
      process.off('unhandledRejection', unhandled);
    }
  });
});
