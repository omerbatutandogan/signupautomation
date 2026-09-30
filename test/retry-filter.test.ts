import { describe, expect, it } from 'vitest';
import { RETRYABLE, shouldEnqueue } from '../scripts/discover-queue.js';

/**
 * --retry-failed kuyruk filtresi.
 *
 * Bu testler bir veri kaybını koruyor: doğrulanmış config üretmiş
 * (`generated`) ya da ToS gereği elenmiş (`high_risk`) siteler yeniden
 * taranırsa sonuç üzerine yazılır. Keşif aracı elle düzeltilmiş
 * config'i tanımaz ve taslakla değiştirir.
 */

describe('RETRYABLE kümesi', () => {
  it('yalnızca aracın yanılmış OLABİLECEĞİ sonuçları içerir', () => {
    expect(RETRYABLE.has('no_form')).toBe(true);
    expect(RETRYABLE.has('error')).toBe(true);
  });

  it('henüz desteklenmeyen akışları içerir — destek gelince yeniden taranır', () => {
    expect(RETRYABLE.has('submit_form')).toBe(true);
    expect(RETRYABLE.has('email_first')).toBe(true);
  });

  it('doğrulanmış işi ASLA içermez', () => {
    // generated: config üretildi, muhtemelen elle düzeltildi.
    expect(RETRYABLE.has('generated')).toBe(false);
    // high_risk: ToS kararı, yeniden taramanın anlamı yok.
    expect(RETRYABLE.has('high_risk')).toBe(false);
    // bot_protected: sitenin kalıcı özelliği.
    expect(RETRYABLE.has('bot_protected')).toBe(false);
  });
});

describe('shouldEnqueue', () => {
  it('hiç işlenmemiş siteyi her koşulda kuyruğa alır', () => {
    expect(shouldEnqueue(undefined, false)).toBe(true);
    expect(shouldEnqueue(undefined, true)).toBe(true);
  });

  it('bayraksız çalıştırmada işlenmiş hiçbir siteyi yeniden almaz', () => {
    // Bugünkü davranış korunmalı — bayrak opt-in.
    expect(shouldEnqueue('no_form', false)).toBe(false);
    expect(shouldEnqueue('error', false)).toBe(false);
    expect(shouldEnqueue('generated', false)).toBe(false);
  });

  it('--retry-failed ile yalnızca redleri yeniden alır', () => {
    expect(shouldEnqueue('no_form', true)).toBe(true);
    expect(shouldEnqueue('error', true)).toBe(true);
  });

  it('--retry-failed doğrulanmış config’i KORUR', () => {
    // En kritik satır: bu false olmazsa elle düzeltilmiş ontoplist,
    // awwwards gibi config'ler taslakla ezilir.
    expect(shouldEnqueue('generated', true)).toBe(false);
    expect(shouldEnqueue('high_risk', true)).toBe(false);
    expect(shouldEnqueue('bot_protected', true)).toBe(false);
  });
});
