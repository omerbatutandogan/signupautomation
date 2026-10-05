import { SyncBadge } from './sync-badge';

/** Sayfa başlığı + verinin tazeliği (her sayfada aynı yerde). */
export function PageHeader({ title, description }: { title: string; description: string }) {
  return (
    <header className="flex flex-wrap items-start justify-between gap-x-6 gap-y-3">
      <div className="space-y-1">
        <h1 className="text-2xl font-semibold tracking-tight">{title}</h1>
        <p className="max-w-2xl text-sm text-muted-foreground">{description}</p>
      </div>
      <SyncBadge />
    </header>
  );
}
