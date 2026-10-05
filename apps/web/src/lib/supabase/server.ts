import { createServerClient } from '@supabase/ssr';
import { cookies } from 'next/headers';
import { supabaseEnv } from './env';

/**
 * Sunucu bileşenleri, route handler'lar ve server action'lar için istemci.
 * Her istekte YENİ istemci oluşturulmalı (@supabase/ssr önbellek başlıklarını
 * yalnızca ilk çerez yazımında verir).
 */
export async function createClient() {
  const { url, publishableKey } = supabaseEnv();
  const cookieStore = await cookies();

  return createServerClient(url, publishableKey, {
    cookies: {
      getAll() {
        return cookieStore.getAll();
      },
      setAll(cookiesToSet) {
        try {
          for (const { name, value, options } of cookiesToSet) {
            cookieStore.set(name, value, options);
          }
        } catch {
          // Sunucu bileşeni render ederken çerez yazılamaz (Next.js kuralı).
          // Oturum tazelemesi proxy'de yapıldığı için burada yutmak güvenli.
        }
      },
    },
  });
}
