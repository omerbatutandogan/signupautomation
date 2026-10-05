import { createBrowserClient } from '@supabase/ssr';
import { supabaseEnv } from './env';

/** Tarayıcı bileşenleri için Supabase istemcisi (oturum çerezlerde). */
export function createClient() {
  const { url, publishableKey } = supabaseEnv();
  return createBrowserClient(url, publishableKey);
}
