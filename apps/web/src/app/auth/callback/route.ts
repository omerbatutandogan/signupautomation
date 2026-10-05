import { NextResponse, type NextRequest } from 'next/server';
import { createClient } from '@/lib/supabase/server';
import { safeNext } from '@/lib/safe-next';

/**
 * Google → Supabase → buraya döner. PKCE kodunu oturuma çevirir.
 *
 * İzin listesinde olmayan hesap için Supabase'in Before User Created
 * kancası kullanıcı OLUŞTURMAZ ve buraya `error=...` ile döner; kod yoktur.
 */
export async function GET(request: NextRequest) {
  const { searchParams, origin } = request.nextUrl;
  const next = safeNext(searchParams.get('next'));
  const code = searchParams.get('code');

  if (!code) {
    const description = `${searchParams.get('error_description') ?? ''} ${searchParams.get('error') ?? ''}`;
    const reason = /not allowed|access_denied|forbidden|403/i.test(description) ? 'not_allowed' : 'auth_failed';
    return NextResponse.redirect(new URL(`/login?error=${reason}`, origin));
  }

  const supabase = await createClient();
  const { error } = await supabase.auth.exchangeCodeForSession(code);
  if (error) {
    return NextResponse.redirect(new URL('/login?error=auth_failed', origin));
  }
  return NextResponse.redirect(new URL(next, origin));
}
