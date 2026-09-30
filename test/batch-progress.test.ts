import { describe, expect, it, vi } from 'vitest';
import { batchProgress } from '../src/core/batch-progress.js';
import type { SheetRow } from '../src/integrations/sheet.js';

/**
 * run-batch'in Sheet'e yazdıkları.
 *
 * Gerçek hata: `run-batch --dry-run` sonucu Sheet'e gerçek sonuç gibi
 * yazılıyordu ("Tamamlandı" ya da "Manuel Gerekli"). readPending yalnızca
 * boş/Bekliyor/Hata satırlarını aldığı için o site canlı batch'e bir daha
 * hiç girmiyordu. Dry-run hesap açmıyor; Sheet'e dokunmamalı.
 */

const row = { siteId: 'site-a', website: 'https://a.example' } as unknown as SheetRow;

function fakes() {
  const sheet = { markInProgress: vi.fn(async () => undefined), writeOutcome: vi.fn(async () => undefined) };
  const ledger = { terminalResult: vi.fn(() => null), credentials: vi.fn(() => null) };
  return { sheet, ledger };
}

describe('batchProgress', () => {
  it('dry-run modunda Sheet\'e HİÇ yazmaz', () => {
    const { sheet, ledger } = fakes();
    expect(batchProgress({ dryRun: true, sheet, ledger, row })).toBeUndefined();
  });

  it('gerçek çalıştırmada başlangıcı ve sonucu yazar', async () => {
    const { sheet, ledger } = fakes();
    const progress = batchProgress({ dryRun: false, sheet, ledger, row });

    await progress?.started?.('run-1');
    await progress?.finished?.({ status: 'completed' }, { email: 'e@x.com', username: 'u' });

    expect(sheet.markInProgress).toHaveBeenCalledWith(row, 'run-1');
    expect(sheet.writeOutcome).toHaveBeenCalledWith(row, { status: 'completed' }, { email: 'e@x.com', username: 'u' });
  });

  it('skipped_terminal\'da ledger\'daki gerçek sonucu yazar', async () => {
    const { sheet, ledger } = fakes();
    ledger.terminalResult.mockReturnValue({ status: 'completed', note: 'Hesap zaten mevcut' } as never);
    const progress = batchProgress({ dryRun: false, sheet, ledger, row });

    await progress?.finished?.({ status: 'skipped_terminal', note: 'önceki sonuç: completed' });

    expect(sheet.writeOutcome).toHaveBeenCalledWith(row, { status: 'completed', note: 'Hesap zaten mevcut' }, undefined);
  });
});
