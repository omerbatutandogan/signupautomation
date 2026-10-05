import { createBrowserClient } from '@supabase/ssr';
import type { Database } from './database.types';
import { supabaseEnv } from './env';

/** Tarayıcı bileşenleri için Supabase istemcisi (oturum çerezlerde). */
export function createClient() {
  const { url, publishableKey } = supabaseEnv();
  return createBrowserClient<Database>(url, publishableKey);
}
