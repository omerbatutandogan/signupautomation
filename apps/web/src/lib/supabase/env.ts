/**
 * Supabase bağlantı bilgileri — yalnızca publishable key.
 *
 * Secret key (sb_secret_…) bu uygulamada ASLA bulunmaz: RLS'i aşar ve
 * yalnızca işçide (Mac) durur. Burada tarayıcıya da gidebilecek değerler var.
 */
export function supabaseEnv(): { url: string; publishableKey: string } {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const publishableKey = process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY;
  if (!url || !publishableKey) {
    throw new Error(
      'NEXT_PUBLIC_SUPABASE_URL ve NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY tanımlı olmalı (apps/web/.env.local)',
    );
  }
  return { url, publishableKey };
}
