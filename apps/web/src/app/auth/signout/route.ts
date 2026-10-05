import { NextResponse, type NextRequest } from 'next/server';
import { createClient } from '@/lib/supabase/server';

/** Çıkış yalnızca POST — GET ile çıkış, üçüncü taraf sayfanın kullanıcıyı atmasına izin verir. */
export async function POST(request: NextRequest) {
  const supabase = await createClient();
  await supabase.auth.signOut();
  // 303: POST'tan sonra tarayıcı hedefi GET ile açsın.
  return NextResponse.redirect(new URL('/', request.nextUrl.origin), { status: 303 });
}
