/**
 * Uçtan uca testlerin ortak zemini: yerel Supabase + çalışan panel.
 *
 *   npx supabase start                      (repo kökünde)
 *   npm run build -w apps/web && npm run start -w apps/web
 *   npm run e2e -w apps/web
 *
 * Google girişi yerelde denenemiyor (OAuth istemcisi gerekir); oturum aynı
 * @supabase/ssr çerezleriyle e-posta/şifre üzerinden kuruluyor. Kanca,
 * proxy, DAL (is_member) ve RLS yolu Google girişiyle birebir aynı.
 */

import { strict as assert } from 'node:assert';
import { execSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { createServerClient } from '@supabase/ssr';
import { createClient } from '@supabase/supabase-js';
import type { BrowserContext } from 'playwright';
import type { Database } from '../src/lib/supabase/database.types';

export const repoRoot = fileURLToPath(new URL('../../../', import.meta.url));
export const base = process.env.E2E_BASE_URL ?? 'http://localhost:3000';

export const status = JSON.parse(
  execSync('npx supabase@2.119.0 status -o json', { cwd: repoRoot, stdio: ['ignore', 'pipe', 'ignore'] }).toString(),
) as { API_URL: string; PUBLISHABLE_KEY: string; SECRET_KEY: string };

/** Secret key: yalnızca test hazırlığı ve beklenen değerleri okumak için. */
export const admin = createClient<Database>(status.API_URL, status.SECRET_KEY, { auth: { persistSession: false } });
export const anon = createClient<Database>(status.API_URL, status.PUBLISHABLE_KEY, { auth: { persistSession: false } });

export function step(name: string) {
  console.log(`✓ ${name}`);
}

/** Test kullanıcılarını ve izin listesi satırlarını siler (öncesi/sonrası temizlik). */
export async function removeUsers(emails: string[]) {
  const { data } = await admin.auth.admin.listUsers({ perPage: 1000 });
  for (const u of data?.users ?? []) {
    if (u.email && emails.includes(u.email)) await admin.auth.admin.deleteUser(u.id);
  }
  await admin.from('allowed_emails').delete().in('email', emails);
}

/** Tarayıcının alacağı @supabase/ssr oturum çerezlerinin aynısı. */
export async function sessionCookies(email: string, password: string): Promise<Map<string, string>> {
  const jar = new Map<string, string>();
  const ssr = createServerClient(status.API_URL, status.PUBLISHABLE_KEY, {
    cookies: {
      getAll: () => [...jar].map(([name, value]) => ({ name, value })),
      setAll: (cookies) => {
        for (const c of cookies) jar.set(c.name, c.value);
      },
    },
  });
  const signIn = await ssr.auth.signInWithPassword({ email, password });
  assert.equal(signIn.error, null, `giriş başarısız: ${signIn.error?.message}`);
  assert.ok(jar.size > 0, 'oturum çerezi yazılmadı');
  return jar;
}

export async function addSession(ctx: BrowserContext, jar: Map<string, string>) {
  const host = new URL(base).hostname;
  await ctx.addCookies([...jar].map(([name, value]) => ({ name, value, domain: host, path: '/', sameSite: 'Lax' as const })));
}

/** İzin listesine eklenmiş, kayıtlı ve giriş yapmış bir üye. */
export async function memberSession(email: string, password: string): Promise<Map<string, string>> {
  const ins = await admin.from('allowed_emails').insert({ email, role: 'member' });
  assert.equal(ins.error, null, `izin listesine eklenemedi: ${ins.error?.message}`);
  const accepted = await anon.auth.signUp({ email, password });
  assert.equal(accepted.error, null, `izinli kayıt başarısız: ${accepted.error?.message}`);
  return sessionCookies(email, password);
}
