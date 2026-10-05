import 'server-only';
import { cache } from 'react';
import { redirect } from 'next/navigation';
import { createClient } from '@/lib/supabase/server';

export interface Viewer {
  id: string;
  email: string;
  isMember: boolean;
  isAdmin: boolean;
}

/**
 * Oturumdaki kişi — veri erişim katmanı (DAL).
 *
 * Proxy yalnızca çerezden iyimser kontrol yapar; kimin neyi görebileceğine
 * burada, veritabanındaki is_member()/is_admin() ile karar verilir. İzin
 * listesinden çıkarılan biri JWT'si geçerliyken bile üye sayılmaz.
 * React cache: aynı render içinde tek sorgu.
 */
export const getViewer = cache(async (): Promise<Viewer | null> => {
  const supabase = await createClient();
  const { data } = await supabase.auth.getClaims();
  const claims = data?.claims;
  if (!claims?.sub) return null;

  const [member, admin] = await Promise.all([supabase.rpc('is_member'), supabase.rpc('is_admin')]);
  // Geçici bir veritabanı hatası "üye değil" sayılırsa gerçek üye yalnızca
  // çıkış sunan /not-allowed'a düşer. Hata hata olarak görünmeli.
  if (member.error || admin.error) {
    throw new Error(`Üyelik kontrolü başarısız: ${(member.error ?? admin.error)?.message}`);
  }

  return {
    id: claims.sub,
    email: typeof claims.email === 'string' ? claims.email : '',
    isMember: member.data === true,
    isAdmin: admin.data === true,
  };
});

/** Üye değilse sayfayı açmaz: girişsiz → /login, izinsiz → /not-allowed. */
export async function requireMember(): Promise<Viewer> {
  const viewer = await getViewer();
  if (!viewer) redirect('/login');
  if (!viewer.isMember) redirect('/not-allowed');
  return viewer;
}
