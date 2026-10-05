import { CircleCheck, TriangleAlert } from 'lucide-react';
import { formatAgo, formatDateTime } from '@/lib/panel/format';
import { getSyncStatus } from '@/lib/panel/queries';
import { syncState } from '@/lib/panel/queue';

/**
 * Verinin tazeliği. Panel, işçinin Mac'indeki durumun yansımasını gösterir;
 * Mac uyursa ya da senkron bozulursa rakamlar eskir ve bu her sayfada açıkça
 * yazmalı. Durum rengi tek başına anlam taşımaz: ikon + metin birlikte.
 * Ayrıntı (zaman, hata) hem ipucunda hem ekran okuyucu metninde var.
 */
export async function SyncBadge() {
  const status = await getSyncStatus();
  const now = new Date();
  const state = syncState(status, now);

  if (state === 'never' || !status?.last_ok_at) {
    return (
      <Badge state="never" tone="warning" detail={status?.last_error ?? 'The sync has not completed a run yet.'}>
        No data synced yet
      </Badge>
    );
  }

  const ago = formatAgo(status.last_ok_at, now);
  const from = status.source_host ? ` from ${status.source_host}` : '';
  const lastGood = `Last good sync ${formatDateTime(status.last_ok_at)}${from}.`;

  if (state === 'failing') {
    return (
      <Badge state={state} tone="warning" detail={`${lastGood} The sync is running but failing: ${status.last_error}`}>
        Sync is failing · last good data {ago}
      </Badge>
    );
  }
  if (state === 'stale') {
    const lastError = status.last_error ? ` Last recorded error: ${status.last_error}` : '';
    return (
      <Badge state={state} tone="warning" detail={`${lastGood} The sync is not running: the worker Mac may be asleep or offline.${lastError}`}>
        Data is stale · synced {ago}
      </Badge>
    );
  }
  if (state === 'warning') {
    return (
      <Badge state={state} tone="warning" detail={`${lastGood} ${status.last_error}`}>
        Synced {ago} · with a warning
      </Badge>
    );
  }
  return (
    <Badge state={state} tone="good" detail={lastGood}>
      Synced {ago}
    </Badge>
  );
}

function Badge({
  state,
  tone,
  detail,
  children,
}: {
  state: string;
  tone: 'good' | 'warning';
  detail: string;
  children: React.ReactNode;
}) {
  const Icon = tone === 'good' ? CircleCheck : TriangleAlert;
  return (
    <p
      data-sync-state={state}
      title={detail}
      className="flex shrink-0 items-center gap-1.5 rounded-full border px-2.5 py-1 text-xs text-muted-foreground"
    >
      <Icon aria-hidden className={tone === 'good' ? 'size-3.5 text-(--status-good)' : 'size-3.5 text-(--status-serious)'} />
      {children}
      <span className="sr-only">. {detail}</span>
    </p>
  );
}
