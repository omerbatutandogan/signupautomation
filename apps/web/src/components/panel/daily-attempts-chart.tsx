import { formatDay, plural } from '@/lib/panel/format';
import type { DailyAttempts } from '@/lib/panel/queries';
import { niceScale } from '@/lib/panel/queue';
import { cn } from '@/lib/utils';

/**
 * Gün gün gerçek kayıt denemeleri — tek seri, tek renk, tek eksen.
 *
 * Sütunlar ince (≤24px), veri ucu 4px yuvarlak, taban düz. Değerlerin hepsi
 * etiketlenmez: yalnızca en yüksek gün; gerisi eksen + ipucu + tablo
 * görünümünden okunur. İpucu yalnızca kolaylık: aynı sayılar "View as table"
 * altında da var. Vuruş alanı sütunun kendisi değil, günün bütün dilimi.
 */
export function DailyAttemptsChart({ days, limit }: { days: DailyAttempts[]; limit: number }) {
  const peak = Math.max(0, ...days.map((d) => d.real_attempts));
  const { top, step } = niceScale(Math.max(peak, limit));
  const ticks = Array.from({ length: Math.floor(top / step) + 1 }, (_, i) => i * step);
  const peakIndex = peak > 0 ? days.findIndex((d) => d.real_attempts === peak) : -1;
  const pct = (n: number) => `${(n / top) * 100}%`;

  return (
    <figure className="space-y-3">
      <div className="flex pt-8">
        {/* Y ekseni: temiz sayılar */}
        <div className="relative h-40 w-7 shrink-0 text-[11px] text-muted-foreground tabular-nums" aria-hidden>
          {ticks.map((t) => (
            <span key={t} className="absolute right-2 translate-y-1/2 leading-none" style={{ bottom: pct(t) }}>
              {t}
            </span>
          ))}
        </div>

        <div className="relative h-40 min-w-0 flex-1 border-b border-(--viz-axis)">
          {ticks
            .filter((t) => t > 0)
            .map((t) => (
              <div key={t} aria-hidden className="absolute inset-x-0 border-t border-(--viz-grid)" style={{ bottom: pct(t) }} />
            ))}

          {/* Günlük limit: eksen tonunda düz çizgi + etiket */}
          <div aria-hidden className="absolute inset-x-0 border-t border-(--viz-axis)" style={{ bottom: pct(limit) }}>
            <span className="absolute right-0 bottom-0.5 bg-card pl-1 text-[11px] leading-none text-muted-foreground">
              Daily limit {limit}
            </span>
          </div>

          <div className="absolute inset-0 flex items-end">
            {days.map((d, i) => {
              const summary = `${plural(d.real_attempts, 'real attempt')}, ${d.completed} completed, ${plural(d.dry_runs, 'dry-run')}`;
              return (
                <div
                  key={d.day}
                  tabIndex={0}
                  role="img"
                  aria-label={`${formatDay(d.day, true)}: ${summary}`}
                  data-day={d.day}
                  className="group/col relative flex h-full min-w-0 flex-1 items-end justify-center px-px outline-none"
                >
                  {d.real_attempts > 0 && (
                    <div
                      className="w-full max-w-6 rounded-t-[4px] bg-(--viz-series-1) transition-opacity group-hover/col:opacity-75 group-focus-visible/col:opacity-75"
                      style={{ height: pct(d.real_attempts) }}
                    />
                  )}
                  {i === peakIndex && (
                    <span
                      aria-hidden
                      className="absolute text-[11px] leading-none font-medium tabular-nums"
                      style={{ bottom: `calc(${pct(d.real_attempts)} + 4px)` }}
                    >
                      {d.real_attempts}
                    </span>
                  )}
                  <div
                    role="tooltip"
                    className={cn(
                      'pointer-events-none absolute z-10 hidden w-max rounded-md border bg-popover px-2.5 py-1.5 text-xs shadow-md group-hover/col:block group-focus-visible/col:block',
                      i < 2 ? 'left-0' : i >= days.length - 2 ? 'right-0' : 'left-1/2 -translate-x-1/2',
                    )}
                    style={{ bottom: `calc(${pct(d.real_attempts)} + 8px)` }}
                  >
                    <p className="text-muted-foreground">{formatDay(d.day, true)}</p>
                    <p className="text-sm font-semibold">{plural(d.real_attempts, 'real attempt')}</p>
                    <p className="text-muted-foreground">
                      {d.completed} completed · {plural(d.dry_runs, 'dry-run')}
                    </p>
                  </div>
                </div>
              );
            })}
          </div>
        </div>
      </div>

      {/* X ekseni: her ikinci gün (etiketler çakışmasın) */}
      <div className="ml-7 flex text-[11px] text-muted-foreground" aria-hidden>
        {days.map((d, i) => (
          <span key={d.day} className="min-w-0 flex-1 text-center whitespace-nowrap">
            {(days.length - 1 - i) % 2 === 0 ? formatDay(d.day) : ''}
          </span>
        ))}
      </div>

      <details className="text-sm">
        <summary className="cursor-pointer text-xs text-muted-foreground hover:text-foreground">View as table</summary>
        <table className="mt-2 w-full max-w-md text-left text-xs">
          <thead className="text-muted-foreground">
            <tr className="border-b">
              <th scope="col" className="py-1 font-normal">Day</th>
              <th scope="col" className="py-1 text-right font-normal">Real attempts</th>
              <th scope="col" className="py-1 text-right font-normal">Completed</th>
              <th scope="col" className="py-1 text-right font-normal">Dry-runs</th>
            </tr>
          </thead>
          <tbody className="tabular-nums">
            {days.map((d) => (
              <tr key={d.day} className="border-b last:border-0">
                <th scope="row" className="py-1 font-normal">{formatDay(d.day, true)}</th>
                <td className="py-1 text-right">{d.real_attempts}</td>
                <td className="py-1 text-right">{d.completed}</td>
                <td className="py-1 text-right">{d.dry_runs}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </details>
    </figure>
  );
}
