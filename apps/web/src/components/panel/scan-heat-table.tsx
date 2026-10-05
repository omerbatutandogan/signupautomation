import Link from 'next/link';
import { formatDate, formatInt, formatShare } from '@/lib/panel/format';
import { HEAT_BINS, heatBin, outcomeMeta, type ScanMatrix } from '@/lib/panel/outcomes';
import type { ScanProgress } from '@/lib/panel/queries';
import { cn } from '@/lib/utils';

export interface ScanFilter {
  tab?: string;
  outcome?: string;
}

/** Tarama haritası sayfasında bir sekme/sonuç süzgecinin adresi. */
export function scanFilterHref(filter: ScanFilter, page = 0): string {
  const params = new URLSearchParams();
  if (filter.tab !== undefined) params.set('tab', filter.tab);
  if (filter.outcome !== undefined) params.set('outcome', filter.outcome);
  if (page > 0) params.set('page', String(page + 1));
  const query = params.toString();
  return `/dashboard/scan${query ? `?${query}` : ''}#sites`;
}

/**
 * Sekme × sonuç ısı tablosu.
 *
 * Sekiz-dokuz sonuç sınıfının hepsi anlam taşıdığı için (yediden fazla renk
 * sınıfı ayırt edilemez) form tablodur; renk yalnızca büyüklük kodlar: tek
 * ton, açıktan koyuya, hücrenin o SEKMEDEKİ payına göre beş sınıf. Sayı her
 * hücrede yazılı — renk hiçbir değeri tek başına taşımaz. Hücreler arasında
 * çerçeve yok; ayıran 2px'lik yüzey boşluğu.
 */
export function ScanHeatTable({
  matrix,
  progress,
  selected,
}: {
  matrix: ScanMatrix;
  progress: ReadonlyMap<string, ScanProgress>;
  selected: ScanFilter;
}) {
  const isSelected = (tab: string | undefined, outcome: string | undefined) =>
    (selected.tab !== undefined || selected.outcome !== undefined) && selected.tab === tab && selected.outcome === outcome;
  const focus = 'rounded-[4px] outline-offset-1 hover:outline-2 hover:outline-foreground/50 focus-visible:outline-2 focus-visible:outline-foreground';

  return (
    <div className="space-y-4">
      <div className="overflow-x-auto">
        <table className="w-full min-w-[720px] border-separate border-spacing-0.5 text-sm">
          <caption className="sr-only">Sheet rows by tab and scan outcome</caption>
          <thead>
            <tr className="text-xs text-muted-foreground">
              <th scope="col" className="pr-3 pb-2 text-left align-bottom font-medium">
                Sheet tab
              </th>
              {matrix.columns.map((outcome) => {
                const meta = outcomeMeta(outcome);
                return (
                  <th key={outcome} scope="col" title={meta.description} className="w-[84px] px-1 pb-2 align-bottom font-medium">
                    {meta.label}
                  </th>
                );
              })}
              <th scope="col" className="w-16 pb-2 pl-3 text-right align-bottom font-medium">
                Rows
              </th>
              <th scope="col" className="w-28 pb-2 pl-3 text-right align-bottom font-medium">
                Scanned
              </th>
            </tr>
          </thead>
          <tbody>
            {matrix.tabs.map((row) => {
              const scan = progress.get(row.tab);
              return (
                <tr key={row.tab} data-tab={row.tab}>
                  <th scope="row" className="pr-3 text-left font-normal whitespace-nowrap">
                    <Link
                      href={scanFilterHref({ tab: row.tab })}
                      className={cn('px-1 py-0.5', focus, isSelected(row.tab, undefined) && 'outline-2 outline-foreground')}
                    >
                      {row.tab.trim()}
                    </Link>
                  </th>
                  {matrix.columns.map((outcome) => {
                    const count = row.counts[outcome] ?? 0;
                    if (count === 0) {
                      return (
                        <td key={outcome} className="py-1.5 text-center text-muted-foreground/60">
                          <span aria-hidden>·</span>
                          <span className="sr-only">0</span>
                        </td>
                      );
                    }
                    const bin = heatBin(count, row.total);
                    return (
                      <td key={outcome} className="p-0">
                        <Link
                          href={scanFilterHref({ tab: row.tab, outcome })}
                          title={`${row.tab.trim()} · ${outcomeMeta(outcome).label}: ${formatInt(count)} of ${formatInt(row.total)} rows (${formatShare(count, row.total)})`}
                          data-heat={bin}
                          className={cn(
                            'block py-1.5 text-center tabular-nums',
                            focus,
                            isSelected(row.tab, outcome) && 'outline-2 outline-foreground',
                          )}
                          style={{ backgroundColor: `var(--viz-heat-${bin})`, color: `var(--viz-heat-ink-${bin})` }}
                        >
                          {formatInt(count)}
                        </Link>
                      </td>
                    );
                  })}
                  <td className="pl-3 text-right font-medium tabular-nums">{formatInt(row.total)}</td>
                  <td className="pl-3 text-right text-xs whitespace-nowrap text-muted-foreground">
                    {scan?.finished_at ? formatDate(scan.finished_at) : scan?.started_at ? 'In progress' : '—'}
                  </td>
                </tr>
              );
            })}
          </tbody>
          <tfoot>
            <tr className="font-medium">
              <th scope="row" className="pt-2 pr-3 text-left">
                <span className="px-1">All tabs</span>
              </th>
              {matrix.columns.map((outcome) => (
                <td key={outcome} className="p-0 pt-2">
                  <Link
                    href={scanFilterHref({ outcome })}
                    title={`${outcomeMeta(outcome).label}: ${formatInt(matrix.totals[outcome] ?? 0)} rows in all tabs (${formatShare(matrix.totals[outcome] ?? 0, matrix.grandTotal)})`}
                    className={cn('block py-1.5 text-center tabular-nums', focus, isSelected(undefined, outcome) && 'outline-2 outline-foreground')}
                  >
                    {formatInt(matrix.totals[outcome] ?? 0)}
                  </Link>
                </td>
              ))}
              <td className="pt-2 pl-3 text-right tabular-nums">{formatInt(matrix.grandTotal)}</td>
              <td />
            </tr>
          </tfoot>
        </table>
      </div>

      <div className="flex flex-wrap items-center gap-x-4 gap-y-1.5 text-xs text-muted-foreground">
        <span>Share of the tab&apos;s rows</span>
        {HEAT_BINS.map((b) => (
          <span key={b.bin} className="inline-flex items-center gap-1.5">
            <span aria-hidden className="size-3 rounded-[3px]" style={{ backgroundColor: `var(--viz-heat-${b.bin})` }} />
            {b.label}
          </span>
        ))}
      </div>
    </div>
  );
}
