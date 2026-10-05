'use client';

import { useState } from 'react';
import { Button } from '@/components/ui/button';
import { createClient } from '@/lib/supabase/client';

/** Google ile giriş — Supabase PKCE akışı; dönüş /auth/callback'e. */
export function GoogleButton({ next }: { next: string }) {
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function signIn() {
    setPending(true);
    setError(null);
    const supabase = createClient();
    const redirectTo = `${window.location.origin}/auth/callback?next=${encodeURIComponent(next)}`;
    const { error: oauthError } = await supabase.auth.signInWithOAuth({
      provider: 'google',
      // select_account: aynı tarayıcıda birden çok Google hesabı olan
      // ekipte yanlış hesapla girip "izin yok" almayı önler.
      options: { redirectTo, queryParams: { prompt: 'select_account' } },
    });
    if (oauthError) {
      setError(oauthError.message);
      setPending(false);
    }
  }

  return (
    <div className="space-y-3">
      <Button onClick={signIn} disabled={pending} size="lg" className="w-full">
        {pending ? 'Redirecting to Google…' : 'Continue with Google'}
      </Button>
      {error ? <p className="text-sm text-destructive">{error}</p> : null}
    </div>
  );
}
