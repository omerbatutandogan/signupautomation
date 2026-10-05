import { createServerClient } from '@supabase/ssr';
import { NextResponse, type NextRequest } from 'next/server';
import type { Database } from './database.types';
import { supabaseEnv } from './env';

/** Giriş gerektiren yollar — proxy'de yalnızca iyimser (çerez) kontrol. */
const PROTECTED_PREFIXES = ['/dashboard'];

/**
 * Her istekte oturumu tazeler ve korumalı yollarda girişsiz isteği
 * /login'e yönlendirir.
 *
 * Bu SAVUNMANIN İLK KATI, tek katı değil: asıl yetki kontrolü veri
 * katmanında (lib/auth.ts → is_member) ve veritabanında (RLS) yapılır.
 */
export async function updateSession(request: NextRequest) {
  const { url, publishableKey } = supabaseEnv();
  let response = NextResponse.next({ request });

  const supabase = createServerClient<Database>(url, publishableKey, {
    cookies: {
      getAll() {
        return request.cookies.getAll();
      },
      setAll(cookiesToSet, headers) {
        for (const { name, value } of cookiesToSet) request.cookies.set(name, value);
        response = NextResponse.next({ request });
        for (const { name, value, options } of cookiesToSet) {
          response.cookies.set(name, value, options);
        }
        // Oturum çerezi yazan yanıt CDN'de önbelleğe alınmamalı — yoksa bir
        // kullanıcının oturumu başkasına sunulabilir.
        for (const [key, value] of Object.entries(headers)) response.headers.set(key, value);
      },
    },
  });

  // İstemci oluşturma ile getClaims arasına kod girmemeli: oturum tazelemesi
  // burada tetikleniyor.
  const { data } = await supabase.auth.getClaims();
  const signedIn = Boolean(data?.claims?.sub);

  const { pathname, search } = request.nextUrl;
  if (!signedIn && PROTECTED_PREFIXES.some((p) => pathname === p || pathname.startsWith(`${p}/`))) {
    const loginUrl = request.nextUrl.clone();
    loginUrl.pathname = '/login';
    loginUrl.search = `?next=${encodeURIComponent(pathname + search)}`;
    const redirect = NextResponse.redirect(loginUrl);
    // Tazelenmiş çerezler yönlendirmede kaybolmasın.
    for (const cookie of response.cookies.getAll()) redirect.cookies.set(cookie);
    return redirect;
  }

  return response;
}
