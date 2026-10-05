'use client';

import { useEffect } from 'react';
import { Button } from '@/components/ui/button';

/**
 * Veri okunamadığında: boş bir tablo ya da "0 hesap" göstermek yerine açıkça
 * hata. Ayrıntı tarayıcıya gitmez (üretimde Next mesajı gizler); sunucu
 * günlüğünde `digest` ile bulunur.
 */
export default function DashboardError({ error, retry }: { error: Error & { digest?: string }; retry: () => void }) {
  useEffect(() => {
    console.error(error);
  }, [error]);

  return (
    <div role="alert" className="max-w-xl space-y-3">
      <h1 className="text-2xl font-semibold tracking-tight">This page could not load its data</h1>
      <p className="text-sm text-muted-foreground">
        The numbers were not shown because they could not be read from the database. Nothing was changed.
        {error.digest && <> Reference: <span className="font-mono">{error.digest}</span></>}
      </p>
      <Button onClick={() => retry()} variant="outline" size="sm">
        Try again
      </Button>
    </div>
  );
}
