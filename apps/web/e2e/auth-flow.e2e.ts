/**
 * Uçtan uca giriş/erişim testi — yerel Supabase + çalışan panel gerekir
 * (kurulum: e2e/local.ts).
 */

import { strict as assert } from 'node:assert';
import { chromium } from 'playwright';
import { addSession, admin, anon, base, removeUsers, sessionCookies, step } from './local';

const stamp = Date.now();
const member = `e2e-member-${stamp}@test.local`;
const outsider = `e2e-outsider-${stamp}@test.local`;
const password = `E2e-${stamp}-pw!`;

const cleanup = () => removeUsers([member, outsider]);

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
  const jar = await sessionCookies(member, password);

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
    await addSession(ctx, jar);
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
    await page.goto(`${base}/dashboard`);
    const revoke = await admin.from('allowed_emails').update({ revoked_at: new Date().toISOString() }).eq('email', member);
    assert.equal(revoke.error, null);
    // Önce İSTEMCİ TARAFI gezinme: layout yeniden render edilmez, üyeliği
    // sayfanın kendisi kontrol etmeli. Bir sayfa requireMember()'ı unutursa
    // tam sayfa yüklemesi (layout) bunu gizlerdi; menü tıklaması gizlemez.
    for (const [link, path] of [
      ['Scan map', 'scan'],
      ['Accounts', 'accounts'],
      ['Queue', 'queue'],
      ['Products', 'products'],
      ['Overview', ''],
    ] as const) {
      await page.goto(`${base}/not-allowed`);
      const restore = await admin.from('allowed_emails').update({ revoked_at: null }).eq('email', member);
      assert.equal(restore.error, null);
      // Üyeyken başka bir sayfadan başla (layout bu sırada render edilir)…
      await page.goto(`${base}/dashboard${path === '' ? '/scan' : ''}`);
      const again = await admin.from('allowed_emails').update({ revoked_at: new Date().toISOString() }).eq('email', member);
      assert.equal(again.error, null);
      // …izin kalkınca menüden hedef sayfaya geç.
      await page.getByRole('navigation').getByRole('link', { name: link, exact: true }).click();
      await page.waitForURL(/\/not-allowed$/, { timeout: 10_000 }).catch(() => {
        throw new Error(`"${link}" sayfası istemci tarafı gezinmede üyeliği kontrol etmiyor (adres: ${page.url()})`);
      });
    }
    step('izin kaldırılınca menüden geçilen beş sayfa da erişimi kesti (istemci tarafı gezinme)');
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
