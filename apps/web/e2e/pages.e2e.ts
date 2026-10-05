/**
 * Uçtan uca sayfa testi — panel sayfalarındaki rakamlar veritabanıyla aynı mı?
 *
 * Beklenen değerler sabit yazılmaz: secret key ile veritabanından okunur ve
 * üyenin tarayıcıda gördüğüyle karşılaştırılır. Böylece test hem boş hem dolu
 * (senkronlanmış) yerel veritabanında anlamlıdır. Kurulum: e2e/local.ts.
 *
 *   E2E_SCREENSHOT_DIR=<dizin>   her sayfanın tam ekran görüntüsünü kaydeder.
 */

import { strict as assert } from 'node:assert';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { chromium, type Page } from 'playwright';
import { formatInt } from '../src/lib/panel/format';
import { buildProductMatrix } from '../src/lib/panel/matrix';
import { pivotScanMap } from '../src/lib/panel/outcomes';
import { addSession, admin, base, memberSession, removeUsers, step } from './local';

const stamp = Date.now();
const member = `e2e-pages-${stamp}@test.local`;
const password = `E2e-${stamp}-pw!`;
const shots = process.env.E2E_SCREENSHOT_DIR;

function must<T>(result: { data: T | null; error: { message: string } | null }, what: string): T {
  assert.equal(result.error, null, `${what}: ${result.error?.message}`);
  return result.data as T;
}

async function count(table: 'sites' | 'site_listings' | 'accounts'): Promise<number> {
  const res = await admin.from(table).select('*', { count: 'exact', head: true });
  assert.equal(res.error, null, `${table}: ${res.error?.message}`);
  // HEAD isteğinde bulunamayan tablo hata değil, boş sayı döndürür.
  assert.notEqual(res.count, null, `${table}: sayı gelmedi`);
  return res.count as number;
}

/** Metnin içinde TAM bu ifade geçiyor mu ("2 / 12", "12 / 12" içinde sayılmaz). */
function exact(text: string): RegExp {
  return new RegExp(`(?<![\\d,])${text.replace(/[.*+?^${}()|[\]\\/]/g, '\\$&')}(?![\\d,])`);
}

async function expected() {
  const scanMap = must(await admin.from('v_scan_map').select('tab, outcome, sites'), 'v_scan_map');
  const unique = must(await admin.from('v_unique_outcomes').select('outcome, sites'), 'v_unique_outcomes');
  const accounts = must(await admin.from('accounts').select('product_id, site_id, status, password_source'), 'accounts');
  const products = must(await admin.from('products').select('id, status').order('id'), 'products');
  const blocked = must(await admin.from('v_blocked_pairs').select('product_id, site_id'), 'v_blocked_pairs');
  const backlog = must(await admin.from('v_signup_backlog').select('*'), 'v_signup_backlog');
  const verified = must(await admin.from('site_configs').select('site_id, risk').eq('state', 'verified'), 'site_configs');
  const usedToday = must(await admin.rpc('real_attempts_today'), 'real_attempts_today');
  // maybeSingle: satır olmayabilir (hiç senkron çalışmamış veritabanı).
  const syncResult = await admin.from('sync_status').select('*').maybeSingle();
  assert.equal(syncResult.error, null, `sync_status: ${syncResult.error?.message}`);
  const sync = syncResult.data;
  return {
    matrix: pivotScanMap(scanMap),
    unique: unique.filter((u) => u.outcome && u.sites),
    accounts,
    products,
    usedToday,
    sync,
    dailyLimit: sync?.daily_limit ?? 12,
    uniqueSites: await count('sites'),
    blocked,
    ready: backlog.reduce((n, b) => n + (b.ready ?? 0), 0),
    productRows: buildProductMatrix(
      products,
      verified.map((c) => ({ siteId: c.site_id, risk: c.risk })),
      accounts,
      blocked.map((b) => ({ productId: b.product_id ?? '', siteId: b.site_id ?? '' })),
    ),
  };
}

async function open(page: Page, path: string, heading: string, shot: string) {
  await page.goto(`${base}${path}`);
  await page.getByRole('heading', { level: 1, name: heading }).waitFor({ timeout: 15_000 });
  // Sayfa yatay taşmamalı (geniş tablolar kendi kutusunda kayar).
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
  assert.ok(overflow <= 0, `${path} yatay taşıyor: ${overflow}px`);
  if (shots) await page.screenshot({ path: join(shots, `${shot}.png`), fullPage: true });
}

async function main() {
  await removeUsers([member]);
  const want = await expected();
  const jar = await memberSession(member, password);
  if (shots) mkdirSync(shots, { recursive: true });

  const browser = await chromium.launch({ headless: true });
  const problems: string[] = [];
  try {
    const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } });
    await addSession(ctx, jar);
    const page = await ctx.newPage();
    page.on('pageerror', (err) => problems.push(`sayfa hatası: ${err.message}`));
    page.on('console', (msg) => {
      if (msg.type() === 'error') problems.push(`konsol hatası: ${msg.text()}`);
    });

    // ── Genel bakış ──────────────────────────────────────────────────────
    await open(page, '/dashboard', 'Overview', '1-overview');
    const stat = (label: string) => page.locator(`[data-stat="${label}"]`);
    assert.match(await stat('Accounts opened').innerText(), exact(formatInt(want.accounts.length)));
    assert.match(await stat('Unique sites in the sheet').innerText(), exact(formatInt(want.uniqueSites)));
    assert.match(
      await stat('Real signups today').innerText(),
      exact(`${want.usedToday} / ${want.dailyLimit}`),
      'bugünkü kullanım veritabanıyla aynı olmalı',
    );
    assert.equal(await page.locator('tr[data-bar]').count(), want.unique.length, 'her tekil sonuç bir satır');
    for (const u of want.unique) {
      const row = await page.locator(`tr[data-bar="${u.outcome}"]`).innerText();
      assert.ok(row.includes(formatInt(u.sites ?? 0)), `${u.outcome}: ${u.sites} bekleniyordu, satır: ${row}`);
    }
    assert.equal(await page.locator('[data-sync-state]').count(), 1, 'veri tazeliği rozeti görünmeli');
    step(`genel bakış: ${want.accounts.length} hesap, ${want.uniqueSites} tekil site, ${want.unique.length} sonuç sınıfı`);

    // ── Tarama haritası ──────────────────────────────────────────────────
    await open(page, '/dashboard/scan', 'Scan map', '2-scan');
    assert.equal(await page.locator('tr[data-tab]').count(), want.matrix.tabs.length, 'her sekme bir satır');
    assert.match(await stat('Sheet rows').innerText(), exact(formatInt(want.matrix.grandTotal)));
    const cells = await page.locator('tr[data-tab] a[data-heat]').count();
    const nonZero = want.matrix.tabs.reduce((n, t) => n + Object.values(t.counts).filter((c) => c > 0).length, 0);
    assert.equal(cells, nonZero, 'sıfır olmayan her hücre bağlantı');

    const pick = want.matrix.tabs.find((t) => t.tab !== t.tab.trim()) ?? want.matrix.tabs[0];
    if (pick) {
      // Sondaki boşluklu sekme adı ("Deals ") adres çubuğundan geçip aynen sorgulanmalı.
      const outcome = want.matrix.columns.find((c) => (pick.counts[c] ?? 0) > 0) as string;
      const n = pick.counts[outcome] ?? 0;
      await page.locator(`tr[data-tab="${pick.tab}"] a[data-heat]`).first().click();
      await page.locator('#sites').waitFor({ timeout: 15_000 });
      assert.equal(new URL(page.url()).searchParams.get('tab'), pick.tab, 'sekme adı adreste aynen korunmalı');
      const listed = await page.locator('#sites tr[data-site]').count();
      assert.equal(listed, Math.min(n, 100), `"${pick.tab}" × ${outcome}: ${n} satır bekleniyordu`);
      assert.match(await page.locator('#sites').innerText(), new RegExp(`of ${formatInt(n)}\\.`));
      if (shots) await page.screenshot({ path: join(shots, '2b-scan-drilldown.png'), fullPage: true });
      step(`tarama haritası: ${want.matrix.tabs.length} sekme, ${nonZero} hücre; "${pick.tab}" × ${outcome} → ${listed} site listelendi`);
    } else {
      step('tarama haritası: boş veritabanı — tablo yerine bilgi notu');
    }
    // Geçersiz süzgeç yok sayılır, sayfa bozulmaz.
    await open(page, '/dashboard/scan?tab=__yok__&outcome=__yok__&page=999', 'Scan map', '2c-scan-bad-filter');
    assert.equal(await page.locator('#sites').count(), 0, 'geçersiz süzgeç liste açmamalı');
    // Saçma büyüklükte sayfa numarası hata sayfası ya da uydurma bir aralık üretmez.
    const anyOutcome = want.matrix.columns[0];
    if (anyOutcome) {
      await open(page, `/dashboard/scan?outcome=${anyOutcome}&page=999999999999999999999`, 'Scan map', '2d-scan-huge-page');
      assert.equal(await page.locator('#sites tr[data-site]').count(), 0, 'listenin ötesindeki sayfa boş olmalı');
      assert.match(await page.locator('#sites').innerText(), /No rows on this page/);
    }

    // ── Hesaplar ─────────────────────────────────────────────────────────
    await open(page, '/dashboard/accounts', 'Accounts', '3-accounts');
    const shown = await page.locator('tr[data-account]').evaluateAll((rows) => rows.map((r) => r.getAttribute('data-account')).sort());
    assert.deepEqual(shown, want.accounts.map((a) => `${a.product_id}@${a.site_id}`).sort(), 'tabloda tam olarak gerçek hesaplar olmalı');
    for (const a of want.accounts.filter((x) => x.password_source === 'user_held')) {
      const row = await page.locator(`tr[data-account="${a.product_id}@${a.site_id}"]`).innerText();
      assert.match(row, /Held by user/, `${a.site_id}: şifre kullanıcıda olarak görünmeli`);
    }
    // Sheet'teki şemasız adresler ("10words.io") de güvenli bir https bağlantısı olur.
    const hrefs = await page.locator('main a[target="_blank"]').evaluateAll((as) => as.map((a) => a.getAttribute('href') ?? ''));
    for (const href of hrefs) assert.match(href, /^https?:\/\//, `beklenmeyen bağlantı: ${href}`);
    const rels = await page.locator('main a[target="_blank"]').evaluateAll((as) => as.map((a) => a.getAttribute('rel') ?? ''));
    for (const rel of rels) assert.match(rel, /noopener/, 'dış bağlantı noopener olmalı');
    step(`hesaplar: ${shown.length} satır, veritabanıyla birebir; ${hrefs.length} dış bağlantı http(s)`);

    // ── Kuyruk ───────────────────────────────────────────────────────────
    await open(page, '/dashboard/queue', 'Queue', '4-queue');
    assert.equal(await page.locator('[data-day]').count(), 14, 'grafikte 14 gün');
    assert.match(await stat('Real signups today').innerText(), exact(`${want.usedToday} / ${want.dailyLimit}`));
    // "Hazır" yalnızca işçinin gerçekten deneyeceği çiftler; takılanlar ayrı listelenir.
    assert.match(await stat('Ready to sign up').innerText(), exact(formatInt(want.ready)));
    const shownBlocked = await page.locator('tr[data-blocked]').evaluateAll((rows) => rows.map((r) => r.getAttribute('data-blocked')).sort());
    assert.deepEqual(shownBlocked, want.blocked.map((b) => `${b.product_id}@${b.site_id}`).sort(), 'ilgi bekleyen kayıtlar');
    const firstDay = page.locator('[data-day]').first();
    await firstDay.hover();
    await firstDay.locator('[role="tooltip"]').waitFor({ state: 'visible', timeout: 5_000 });
    // Klavye odağı da aynı bilgiyi gösterir.
    await page.mouse.move(0, 0);
    await page.locator('[data-day]').nth(5).focus();
    await page.locator('[data-day]').nth(5).locator('[role="tooltip"]').waitFor({ state: 'visible', timeout: 5_000 });
    if (shots) await page.screenshot({ path: join(shots, '4b-queue-tooltip.png'), fullPage: true });
    assert.equal(await page.locator('tr[data-product]').count(), want.products.length, 'her ürün bir satır');
    step(`kuyruk: ${want.ready} hazır, ${want.blocked.length} ilgi bekleyen; 14 günlük grafik, ipucu fareyle ve klavyeyle açılıyor`);

    // ── Ürünler ──────────────────────────────────────────────────────────
    await open(page, '/dashboard/products', 'Products', '5-products');
    assert.equal(await page.locator('[data-slot="card"][data-product]').count(), want.products.length);
    assert.equal(await page.locator('tr[data-site]').count(), want.productRows.length, 'matris satırları');
    for (const row of want.productRows) {
      const states = await page
        .locator(`tr[data-site="${row.siteId}"] td[data-cell]`)
        .evaluateAll((tds) => tds.map((td) => td.getAttribute('data-cell')));
      assert.deepEqual(states, row.cells, `${row.siteId} hücreleri`);
    }
    step(`ürünler: ${want.products.length} ürün × ${want.productRows.length} site matrisi doğru`);

    // ── Eskiyen veri açıkça söylenir ─────────────────────────────────────
    if (want.sync) {
      const original = { last_ok_at: want.sync.last_ok_at, last_run_at: want.sync.last_run_at, last_error: want.sync.last_error };
      const old = new Date(Date.now() - 3 * 3_600_000).toISOString();
      try {
        must(await admin.from('sync_status').update({ last_ok_at: old }).eq('id', true).select(), 'sync_status güncelleme');
        await open(page, '/dashboard', 'Overview', '6-overview-stale');
        const badge = page.locator('[data-sync-state]');
        assert.equal(await badge.getAttribute('data-sync-state'), 'stale');
        assert.match(await badge.innerText(), /stale/i);

        // Senkron çalışıyor ama hata veriyor: "Mac uyuyor" değil, hatanın kendisi.
        must(
          await admin
            .from('sync_status')
            .update({ last_run_at: new Date().toISOString(), last_error: 'accounts could not be written' })
            .eq('id', true)
            .select(),
          'sync_status hata',
        );
        await open(page, '/dashboard', 'Overview', '6b-overview-failing');
        assert.equal(await badge.getAttribute('data-sync-state'), 'failing');
        assert.match(await badge.innerText(), /failing/i);
        assert.match(await badge.innerText(), /accounts could not be written/, 'hata metni rozetin içinde (ekran okuyucu) bulunmalı');
      } finally {
        must(await admin.from('sync_status').update(original).eq('id', true).select(), 'sync_status geri yükleme');
      }
      step('üç saatlik veri "stale", hata veren senkron "failing" olarak işaretleniyor');
    }

    // ── Dar ekran: hiçbir sayfa yatay taşmaz ─────────────────────────────
    await page.setViewportSize({ width: 1024, height: 768 });
    for (const [path, heading] of [
      ['/dashboard', 'Overview'],
      ['/dashboard/scan', 'Scan map'],
      ['/dashboard/accounts', 'Accounts'],
      ['/dashboard/queue', 'Queue'],
      ['/dashboard/products', 'Products'],
    ] as const) {
      await open(page, path, heading, `7-narrow-${heading.toLowerCase().replace(' ', '-')}`);
    }
    step('1024px genişlikte beş sayfa da taşmadan açılıyor');

    assert.deepEqual(problems, [], 'tarayıcıda hata olmamalı');
  } finally {
    await browser.close();
    await removeUsers([member]);
  }
  console.log('\nE2E (sayfalar): tüm adımlar geçti');
}

main().catch(async (err: unknown) => {
  console.error(`\n✗ E2E başarısız: ${err instanceof Error ? err.message : String(err)}`);
  await removeUsers([member]).catch(() => undefined);
  process.exit(1);
});
