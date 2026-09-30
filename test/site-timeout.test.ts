import { describe, expect, it, vi } from 'vitest';
import { guardSite, SiteTimeoutError, withSiteTimeout } from '../scripts/discover-queue.js';

/**
 * Keşifte site başına süre sınırı.
 *
 * Gerçek vaka (2026-09-30): financesonline.com bilinmeyen yollara hiç
 * yanıt vermiyor; headless ~100sn sürdü, headed denemesi 15 dakikayı
 * aştı ve ölçüm elle durduruldu. 3430 sitelik taramada tek bir site
 * bütün kuyruğu kilitleyebilirdi.
 */

describe('guardSite — sitenin tamamına bekçi', () => {
  // Gerçek vaka (2026-09-30): tarama financesonline'da 12 SAAT takıldı.
  // Denemeler 4dk sınırlıydı ama sınırın DIŞINDAKİ bir adım (sayfa
  // kapatma / headed açma / yeni sekme) dönmedi; kuyruk durdu.

  it('biten işin sonucunu döner, kurtarmayı çağırmaz', async () => {
    const recover = vi.fn(async () => undefined);
    const r = await guardSite(Promise.resolve('ok'), recover, (m) => `err:${m}`, 1000);
    expect(r).toBe('ok');
    expect(recover).not.toHaveBeenCalled();
  });

  it('dönmeyen işte kurtarmayı çağırır ve hata sonucu döner', async () => {
    const recover = vi.fn(async () => undefined);
    const r = await guardSite(new Promise<string>(() => undefined), recover, (m) => `err:${m}`, 30);
    expect(r).toMatch(/^err:/);
    expect(recover).toHaveBeenCalledOnce();
  });

  it('zaman aşımı dışındaki hatada da kurtarır ve hata sonucu döner — tarama düşmez', async () => {
    // Yeniden açılamayan tarayıcı sonraki sitede "Target closed" fırlatır;
    // bu yeniden fırlatılırsa bütün tarama çöker.
    const recover = vi.fn(async () => undefined);
    const r = await guardSite(Promise.reject(new Error('Target closed')), recover, (m) => `err:${m}`, 1000);
    expect(r).toBe('err:Target closed');
    expect(recover).toHaveBeenCalledOnce();
  });

  it('kurtarma da takılırsa yine döner — kuyruk asla durmaz', async () => {
    const r = await guardSite(
      new Promise<string>(() => undefined),
      () => new Promise<void>(() => undefined),
      () => 'err',
      30,
      30,
    );
    expect(r).toBe('err');
  });
});

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
