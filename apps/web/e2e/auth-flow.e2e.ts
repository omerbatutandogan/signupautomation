/**
 * Uçtan uca giriş/erişim testi — yerel Supabase + çalışan panel gerekir.
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
import { chromium } from 'playwright';

const repoRoot = fileURLToPath(new URL('../../../', import.meta.url));
const base = process.env.E2E_BASE_URL ?? 'http://localhost:3000';

const status = JSON.parse(
  execSync('npx supabase@2.119.0 status -o json', { cwd: repoRoot, stdio: ['ignore', 'pipe', 'ignore'] }).toString(),
) as { API_URL: string; PUBLISHABLE_KEY: string; SECRET_KEY: string };

const admin = createClient(status.API_URL, status.SECRET_KEY, { auth: { persistSession: false } });
const anon = createClient(status.API_URL, status.PUBLISHABLE_KEY, { auth: { persistSession: false } });

const stamp = Date.now();
const member = `e2e-member-${stamp}@test.local`;
const outsider = `e2e-outsider-${stamp}@test.local`;
const password = `E2e-${stamp}-pw!`;

function step(name: string) {
  console.log(`✓ ${name}`);
}

async function cleanup() {
  const { data } = await admin.auth.admin.listUsers({ perPage: 1000 });
  for (const u of data?.users ?? []) {
    if (u.email === member || u.email === outsider) await admin.auth.admin.deleteUser(u.id);
  }
  await admin.from('allowed_emails').delete().in('email', [member, outsider]);
}

async function main() {
  await cleanup();
  const ins = await admin.from('allowed_emails').insert({ email: member, role: 'member' });
  assert.equal(ins.error, null, `izin listesine eklenemedi: ${ins.error?.message}`);

  // 1. Kanca: izinsiz e-postaya kullanıcı açılmaz.
  const rejected = await anon.auth.signUp({ email: outsider, password });
  assert.ok(rejected.error, 'izinsiz kayıt hata vermeliydi');
  // Yalnızca "hata var" yetmez: bozuk bir kanca yanıtı da hata (500) verirdi.
  assert.equal(rejected.error.status, 403, `beklenen 403, gelen ${rejected.error.status}`);
  assert.match(rejected.error.message, /not allowed/i);
  const { data: afterReject } = await admin.auth.admin.listUsers({ perPage: 1000 });
  assert.ok(!afterReject.users.some((u) => u.email === outsider), 'izinsiz e-postaya auth kullanıcısı açılmamalı');
  step(`kanca izinsiz e-postayı reddetti (${rejected.error.status ?? '?'}: ${rejected.error.message})`);

  // 2. İzinli e-posta kaydolur.
  const accepted = await anon.auth.signUp({ email: member, password });
  assert.equal(accepted.error, null, `izinli kayıt başarısız: ${accepted.error?.message}`);
  step('izinli e-posta kaydoldu');

  // 3. Oturum çerezleri — tarayıcının alacağı @supabase/ssr çerezlerinin aynısı.
  const jar = new Map<string, string>();
  const ssr = createServerClient(status.API_URL, status.PUBLISHABLE_KEY, {
    cookies: {
      getAll: () => [...jar].map(([name, value]) => ({ name, value })),
      setAll: (cookies) => {
        for (const c of cookies) jar.set(c.name, c.value);
      },
    },
  });
  const signIn = await ssr.auth.signInWithPassword({ email: member, password });
  assert.equal(signIn.error, null, `giriş başarısız: ${signIn.error?.message}`);
  assert.ok(jar.size > 0, 'oturum çerezi yazılmadı');

  const browser = await chromium.launch({ headless: true });
  try {
    // 4. Girişsiz → /login (proxy).
    const anonCtx = await browser.newContext();
    const anonPage = await anonCtx.newPage();
    await anonPage.goto(`${base}/dashboard/accounts`);
    assert.match(anonPage.url(), /\/login\?next=%2Fdashboard%2Faccounts$/, `beklenmeyen adres: ${anonPage.url()}`);
    step('girişsiz istek /login\'e yönlendi (next korunuyor)');

    // 5. İzinli oturum → dashboard.
    const ctx = await browser.newContext();
    const host = new URL(base).hostname;
    await ctx.addCookies([...jar].map(([name, value]) => ({ name, value, domain: host, path: '/', sameSite: 'Lax' as const })));
    const page = await ctx.newPage();
    await page.goto(`${base}/dashboard`);
    assert.match(page.url(), /\/dashboard$/, `dashboard açılmadı: ${page.url()}`);
    await page.getByText(member).waitFor({ timeout: 10_000 });
    await page.getByRole('heading', { name: 'Overview' }).waitFor({ timeout: 10_000 });
    step('izinli oturum dashboard\'u açtı, e-posta görünüyor');

    // 6. Girişliyken /login → dashboard.
    await page.goto(`${base}/login?next=%2Fdashboard%2Fscan`);
    assert.match(page.url(), /\/dashboard\/scan$/, `login yönlendirmedi: ${page.url()}`);
    step('giriş yapmışken /login, next adresine yönlendi');

    // 7. İzin kaldırılınca bir sonraki istekte erişim kesilir (JWT hâlâ geçerli).
    const revoke = await admin.from('allowed_emails').update({ revoked_at: new Date().toISOString() }).eq('email', member);
    assert.equal(revoke.error, null);
    await page.goto(`${base}/dashboard`);
    assert.match(page.url(), /\/not-allowed$/, `iptal sonrası erişim kesilmedi: ${page.url()}`);
    step('izin kaldırılınca dashboard erişimi kesildi');

    // 8. Çıkış oturumu kapatır.
    await page.getByRole('button', { name: /sign out/i }).click();
    await page.waitForURL(`${base}/`);
    await page.goto(`${base}/dashboard`);
    assert.match(page.url(), /\/login/, `çıkış sonrası hâlâ içeride: ${page.url()}`);
    step('çıkış oturumu kapattı');
  } finally {
    await browser.close();
    await cleanup();
  }
  console.log('\nE2E: tüm adımlar geçti');
}

main().catch(async (err: unknown) => {
  console.error(`\n✗ E2E başarısız: ${err instanceof Error ? err.message : String(err)}`);
  await cleanup().catch(() => undefined);
  process.exit(1);
});
