/**
 * run-batch'in Sheet'e yazdıkları — cli.ts'den ayrıldı ki test edilebilsin.
 */

import type { Ledger } from '../integrations/ledger.js';
import type { SheetClient, SheetRow } from '../integrations/sheet.js';
import type { RunOptions } from './runner.js';

export interface BatchProgressDeps {
  dryRun: boolean;
  sheet: Pick<SheetClient, 'markInProgress' | 'writeOutcome'>;
  ledger: Pick<Ledger, 'terminalResult' | 'credentials'>;
  row: SheetRow;
}

/**
 * Bir satır için runSite'a verilecek Sheet ilerleme bağlantısı.
 *
 * Dry-run'da undefined: dry-run hesap açmıyor. Eskiden sonucu Sheet'e
 * gerçek sonuç gibi yazıyordu ("Tamamlandı"/"Manuel Gerekli"); readPending
 * yalnızca boş/Bekliyor/Hata satırlarını aldığı için site canlı batch'e
 * bir daha girmiyordu. Başlangıç işareti de yazılmıyor — "İşleniyor"da
 * kalan satır da kuyruk dışı kalırdı.
 */
export function batchProgress({ dryRun, sheet, ledger, row }: BatchProgressDeps): RunOptions['onProgress'] {
  if (dryRun) return undefined;
  return {
    started: (runId) => sheet.markInProgress(row, runId),
    finished: async (result, identity) => {
      // skipped_terminal "zaten bitmiş" demek ama nasıl bittiğini
      // taşımıyor — gerçek sonucu ledger'dan alıp Sheet'e yaz.
      if (result.status === 'skipped_terminal') {
        const prev = ledger.terminalResult(row.siteId);
        const creds = ledger.credentials(row.siteId);
        if (prev) {
          await sheet.writeOutcome(
            row,
            { status: prev.status as typeof result.status, note: prev.note ?? undefined },
            creds
              ? {
                  email: creds.email,
                  username: creds.username,
                  profileUrl: creds.profile_url ?? undefined,
                }
              : undefined,
          );
          return;
        }
      }
      await sheet.writeOutcome(row, result, identity);
    },
  };
}
