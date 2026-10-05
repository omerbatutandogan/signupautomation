import Link from 'next/link';
import { ArrowRight } from 'lucide-react';
import { cn } from '@/lib/utils';

/**
 * Tek bir sayının anlatıldığı kutu. Büyük sayı orantılı rakamlarla yazılır
 * (tabular-nums yalnızca alt alta hizalanan kolonlarda).
 *
 * `hero`: sayfanın tek öne çıkan rakamı (≥48px) — sayfa başına en çok bir tane.
 */
export function StatTile({
  label,
  value,
  hint,
  href,
  hero = false,
  children,
}: {
  label: string;
  value: string;
  hint?: string;
  href?: string;
  hero?: boolean;
  children?: React.ReactNode;
}) {
  const body = (
    <>
      <p className="flex items-center justify-between gap-2 text-sm text-muted-foreground">
        {label}
        {href && <ArrowRight aria-hidden className="size-3.5 opacity-0 transition-opacity group-hover/tile:opacity-100" />}
      </p>
      <p className={cn('font-semibold tracking-tight', hero ? 'text-5xl' : 'text-2xl')}>{value}</p>
      {children}
      {hint && <p className="text-xs text-muted-foreground">{hint}</p>}
    </>
  );
  const frame = 'flex flex-col gap-1.5 rounded-xl bg-card p-4 ring-1 ring-foreground/10';

  if (!href) {
    return (
      <div data-stat={label} className={frame}>
        {body}
      </div>
    );
  }
  return (
    <Link
      href={href}
      data-stat={label}
      className={cn(frame, 'group/tile transition-shadow hover:ring-foreground/25 focus-visible:outline-2 focus-visible:outline-ring')}
    >
      {body}
    </Link>
  );
}

/**
 * İlerleme çubuğu: dolgu ve iz aynı tonun iki adımı (mavi üstüne açık mavi).
 * Limit aşılsa da çubuk %100'de kalır; gerçek sayı yanındaki metinde yazar.
 */
export function Meter({ value, max, label }: { value: number; max: number; label: string }) {
  const pct = max > 0 ? Math.min(100, Math.max(0, (value / max) * 100)) : 0;
  return (
    <div
      role="meter"
      aria-label={label}
      aria-valuemin={0}
      aria-valuemax={max}
      aria-valuenow={Math.min(value, max)}
      aria-valuetext={`${value} of ${max}`}
      className="h-2 w-full overflow-hidden rounded-full bg-(--viz-track)"
    >
      <div className="h-full rounded-full bg-(--viz-series-1)" style={{ width: `${pct}%` }} />
    </div>
  );
}
