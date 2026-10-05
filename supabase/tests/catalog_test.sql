-- Aşama 1 katalog tablolarının sözleşmesi.
begin;
create extension if not exists pgtap with schema extensions;

select plan(55);

-- Test kendi verisiyle çalışır. Yerel veritabanı senkronlanmış (dolu) olabilir;
-- tablolar bu işlemin içinde boşaltılır ve sondaki rollback her şeyi geri getirir.
-- truncate tabloları işlem boyunca kilitler: YALNIZCA yerel veritabanında
-- çalıştır (`supabase test db`), üretime karşı (--linked / --db-url) ASLA.
truncate
  public.attempts, public.accounts, public.site_discoveries, public.site_listings,
  public.site_configs, public.scan_progress, public.sync_status, public.products, public.sites
  cascade;

-- ── Veri (postgres rolüyle; işçinin secret key'i de RLS'i böyle aşar) ────
insert into public.allowed_emails (email, role) values ('member@test.local', 'member');
insert into auth.users (id, email, aud, role) values
  ('00000000-0000-0000-0000-0000000000a1', 'member@test.local', 'authenticated', 'authenticated'),
  ('00000000-0000-0000-0000-0000000000a2', 'outsider@test.local', 'authenticated', 'authenticated');

insert into public.sites (id, website) values
  ('site-a', 'https://a.example'), ('site-b', 'https://b.example'),
  ('site-c', 'https://c.example'), ('site-d', 'https://d.example'),
  ('site-e', 'https://e.example'), ('site-f', 'https://f.example'),
  ('site-g', 'https://g.example');
insert into public.site_listings (tab, site_id, row_number) values
  ('SaaS', 'site-a', 2), ('SaaS', 'site-b', 3), ('SaaS', 'site-c', 4), ('Deals ', 'site-d', 2),
  ('SaaS', 'site-e', 5), ('SaaS', 'site-f', 6), ('Deals ', 'site-f', 3);
insert into public.site_discoveries (tab, site_id, outcome, reason, signup_url) values
  ('SaaS', 'site-a', 'generated', null, 'https://a.example/found'),
  ('SaaS', 'site-b', 'bot_protected', 'cloudflare', null),
  -- Aynı site iki sekmede: birinde tarama yarım kaldı, diğerinde sonuç var.
  ('SaaS', 'site-f', 'error', 'timeout', null),
  ('Deals ', 'site-f', 'no_form', null, null);
insert into public.site_configs (site_id, state, risk, signup_url, content_hash) values
  ('site-a', 'verified', 'low', 'https://a.example/config', 'h1'),
  ('site-c', 'draft_unverified', 'low', 'https://c.example/join', 'h2'),
  ('site-d', 'verified', 'high', null, 'h3'),
  ('site-g', 'verified', 'low', null, 'h4');
insert into public.sync_status (last_run_at, last_ok_at, daily_limit) values (now(), now(), 12);
insert into public.products (id, status) values ('geo-new', 'ready'), ('acme-crm', 'draft'), ('idle-draft', 'draft');
insert into public.accounts (product_id, site_id, email, status) values
  ('geo-new', 'site-b', 'A@test.local', 'opened'),
  ('acme-crm', 'site-b', 'b@test.local', 'opened');
insert into public.attempts (account_key, product_id, site_id, status, dry_run, started_at) values
  ('site-a', 'geo-new', 'site-a', 'completed', false, now()),
  ('site-a', 'geo-new', 'site-a', 'completed', true, now()),
  ('site-b', 'geo-new', 'site-b', 'skipped_limit', false, now()),
  ('site-c', 'geo-new', 'site-c', 'failed', false, now() - interval '3 days');
-- site-g: gerçek deneme terminal başarısız → işçi --force olmadan yeniden denemez.
-- Aynı sitede terminal dry-run ve terminal OLMAYAN gerçek hata engel değildir.
insert into public.attempts (account_key, product_id, site_id, status, dry_run, terminal, started_at, finished_at, note) values
  ('site-g', 'geo-new', 'site-g', 'failed', false, true, now() - interval '5 days', now() - interval '5 days', 'Selector bulunamadı'),
  ('site-a', 'geo-new', 'site-a', 'failed', true, true, now() - interval '5 days', now() - interval '5 days', 'dry-run'),
  ('site-a', 'geo-new', 'site-a', 'error', false, false, now() - interval '5 days', now() - interval '5 days', 'timeout'),
  -- Hesabı olan çiftin eski terminal hatası engel sayılmaz.
  ('site-b', 'geo-new', 'site-b', 'failed', false, true, now() - interval '6 days', now() - interval '6 days', 'eski');

-- ── Hesap anahtarı: packages/shared accountKey() ile aynı kural ─────────
select is(
  (select account_key from public.accounts where product_id = 'geo-new' and site_id = 'site-b'),
  'site-b',
  'varsayılan ürünün anahtarı yalın site id (mevcut şifreler değişmesin)'
);
select is(
  (select account_key from public.accounts where product_id = 'acme-crm' and site_id = 'site-b'),
  'acme-crm@site-b',
  'diğer ürünlerin anahtarı urun@site'
);

-- ── Çakışma koruması ─────────────────────────────────────────────────────
select throws_ok(
  $$insert into public.accounts (product_id, site_id, email, status) values ('acme-crm', 'site-a', 'x@test.local', 'opened'), ('geo-new', 'site-a', 'X@test.local', 'opened')$$,
  '23505',
  null,
  'aynı e-posta (büyük/küçük harf farkıyla bile) aynı sitede iki hesap açamaz'
);

-- ── Ürün id'si değişmez ──────────────────────────────────────────────────
select throws_ok(
  $$update public.products set id = 'renamed' where id = 'acme-crm'$$,
  'P0001',
  null,
  'ürün id değiştirilemez (türetilen şifreler bozulurdu)'
);
select lives_ok(
  $$update public.products set status = 'ready' where id = 'acme-crm'$$,
  'ürünün diğer alanları değişebilir'
);
select throws_ok(
  $$insert into public.products (id) values ('Bad Id')$$,
  '23514',
  null,
  'geçersiz ürün id reddedilir'
);

-- ── Günlük kullanım ──────────────────────────────────────────────────────
select is(
  public.real_attempts_today(),
  1,
  'günlük sayım dry-run, atlanan ve önceki günleri saymaz'
);

-- ── anon ─────────────────────────────────────────────────────────────────
set local role anon;
select throws_ok('select count(*) from public.accounts', '42501', null, 'anon hesapları okuyamaz');
select throws_ok('select count(*) from public.site_configs', '42501', null, 'anon config''leri okuyamaz');
select throws_ok('select count(*) from public.v_scan_map', '42501', null, 'anon tarama haritasını okuyamaz');
select throws_ok('select count(*) from public.v_site_status', '42501', null, 'anon site listesini okuyamaz');
select throws_ok('select count(*) from public.v_unique_outcomes', '42501', null, 'anon tekil sonuçları okuyamaz');
select throws_ok('select count(*) from public.sync_status', '42501', null, 'anon senkron durumunu okuyamaz');
select throws_ok('select public.real_attempts_today()', '42501', null, 'anon günlük sayımı çalıştıramaz');
select throws_ok('select count(*) from public.daily_attempts(3)', '42501', null, 'anon günlük seriyi çalıştıramaz');
reset role;

-- ── Üye olmayan ──────────────────────────────────────────────────────────
set local role authenticated;
select set_config('request.jwt.claims', '{"sub":"00000000-0000-0000-0000-0000000000a2","role":"authenticated"}', true);
select is((select count(*)::int from public.accounts), 0, 'üye olmayan hesapları göremez');
select is((select count(*)::int from public.sites), 0, 'üye olmayan siteleri göremez');
select is((select count(*)::int from public.v_scan_map), 0, 'görünüm üye olmayana veri sızdırmaz');
select is((select count(*)::int from public.v_signup_backlog), 0, 'kuyruk görünümü üye olmayana veri sızdırmaz');
select is((select count(*)::int from public.v_site_status), 0, 'site listesi üye olmayana veri sızdırmaz');
select is((select count(*)::int from public.v_unique_outcomes), 0, 'tekil sonuçlar üye olmayana veri sızdırmaz');
select is((select count(*)::int from public.sync_status), 0, 'üye olmayan senkron durumunu göremez');
select is(
  (select coalesce(sum(real_attempts + dry_runs), 0)::int from public.daily_attempts(4)),
  0, 'günlük seri üye olmayana deneme sayısı sızdırmaz'
);

-- ── Üye: okur, yazamaz ───────────────────────────────────────────────────
select set_config('request.jwt.claims', '{"sub":"00000000-0000-0000-0000-0000000000a1","role":"authenticated"}', true);
select is((select count(*)::int from public.accounts), 2, 'üye hesapları görür');
select is((select count(*)::int from public.attempts), 8, 'üye denemeleri görür');
select throws_ok(
  $$insert into public.accounts (product_id, site_id, status) values ('geo-new', 'site-c', 'opened')$$,
  '42501', null, 'üye hesap ekleyemez'
);
select throws_ok(
  $$update public.site_configs set state = 'verified' where site_id = 'site-c'$$,
  '42501', null, 'üye config durumunu değiştiremez'
);
select throws_ok(
  $$delete from public.attempts$$,
  '42501', null, 'üye deneme silemez'
);
select throws_ok(
  $$update public.sync_status set daily_limit = 500$$,
  '42501', null, 'üye günlük limiti panelden değiştiremez'
);
select is((select daily_limit from public.sync_status), 12, 'üye senkron durumunu okur');

-- ── Görünümler ───────────────────────────────────────────────────────────
select is(
  (select sites from public.v_scan_map where tab = 'SaaS' and outcome = 'generated'),
  1, 'tarama haritası sonuçları sekmeye göre sayar'
);
select is(
  (select sites from public.v_scan_map where tab = 'SaaS' and outcome = 'has_config'),
  1, 'taranmamış ama config''i olan site ayrı sayılır'
);
select is(
  (select sites from public.v_scan_map where tab = 'Deals ' and outcome = 'has_config'),
  1, 'sondaki boşluklu sekme adı korunur'
);
select is(
  (select ready from public.v_signup_backlog where product_id = 'geo-new'),
  1, 'kuyruk: doğrulanmış, hesabı olmayan, yüksek riskli olmayan siteler'
);
select is(
  (select unverified from public.v_signup_backlog where product_id = 'geo-new'),
  1, 'kuyruk: doğrulanmamış taslaklar ayrı sayılır'
);
select is(
  (select blocked from public.v_signup_backlog where product_id = 'geo-new'),
  1, 'kuyruk: terminal başarısız çift "hazır" değil, engelli sayılır'
);
select results_eq(
  $$select site_id, status, note from public.v_blocked_pairs where product_id = 'geo-new'$$,
  $$values ('site-g', 'failed', 'Selector bulunamadı')$$,
  'engelli çift: yalnız gerçek + terminal + hesapsız (dry-run, terminal olmayan hata ve hesabı olan site değil)'
);
select is(
  (select opened from public.v_signup_backlog where product_id = 'geo-new'),
  1, 'kuyruk: açılan hesap sayısı config birleşiminden bağımsız'
);
select results_eq(
  $$select ready, unverified, awaiting_move from public.v_signup_backlog where product_id = 'idle-draft'$$,
  $$values (0, 0, 0)$$,
  'taslak ürünün kuyruğu boştur (kaydı yapılamaz) ama satırı görünür'
);
select is(
  (select count(*)::int from public.v_signup_backlog),
  (select count(*)::int from public.products),
  'kuyruk görünümünde her ürün tam bir satır'
);

-- ── Yetkiler: kataloğun tamamı (yeni tablo/görünüm eklenince de yakalar) ──
reset role;
select is(
  (select count(*)::int from information_schema.role_table_grants
    where table_schema = 'public' and grantee = 'anon'),
  0, 'anon''un public şemasında hiçbir tablo/görünüm yetkisi yok'
);
select is(
  (select coalesce(string_agg(distinct privilege_type, ',' order by privilege_type), '')
    from information_schema.role_table_grants
    where table_schema = 'public' and grantee = 'authenticated'
      and table_name in (
        'sites', 'site_listings', 'site_discoveries', 'scan_progress', 'site_configs', 'products',
        'accounts', 'attempts', 'sync_status',
        'v_site_status', 'v_scan_map', 'v_site_outcome', 'v_unique_outcomes', 'v_config_states',
        'v_blocked_pairs', 'v_signup_backlog'
      )),
  'REFERENCES,SELECT,TRIGGER', 'üyelerin katalogda veri değiştirme yetkisi yok'
);
select is(
  (select count(*)::int from pg_class c join pg_namespace n on n.oid = c.relnamespace
    where n.nspname = 'public' and c.relkind = 'r' and not c.relrowsecurity),
  0, 'public şemasındaki her tabloda RLS açık'
);
select is(
  (select count(*)::int from pg_class c join pg_namespace n on n.oid = c.relnamespace
    where n.nspname = 'public' and c.relkind = 'v'
      and not coalesce((select option_value::boolean from pg_options_to_table(c.reloptions) where option_name = 'security_invoker'), false)),
  0, 'public şemasındaki her görünüm security_invoker'
);
set local role authenticated;
select set_config('request.jwt.claims', '{"sub":"00000000-0000-0000-0000-0000000000a1","role":"authenticated"}', true);

select is(
  (select outcome from public.v_site_status where site_id = 'site-e'),
  'not_scanned', 'taranmamış ve config''i olmayan site not_scanned'
);
select is(
  (select signup_url from public.v_site_status where site_id = 'site-a'),
  'https://a.example/found', 'kayıt adresi önce taramadan gelir'
);
select is(
  (select signup_url from public.v_site_status where site_id = 'site-c'),
  'https://c.example/join', 'tarama adresi yoksa config''teki adres'
);
select is(
  (select sum(sites)::int from public.v_scan_map),
  (select count(*)::int from public.site_listings),
  'tarama haritası her Sheet satırını tam bir kez sayar'
);

-- ── Tekil site sonuçları ─────────────────────────────────────────────────
select is(
  (select sites from public.v_unique_outcomes where outcome = 'config'),
  4, 'config''i olan site, tarama sonucu ne olursa olsun config sayılır'
);
select is(
  (select outcome from public.v_site_outcome where site_id = 'site-b'),
  'bot_protected', 'config''i olmayan sitede tarama sonucu geçerli'
);
select is(
  (select outcome from public.v_site_outcome where site_id = 'site-f'),
  'no_form', 'birden çok sekmede geçen sitede gerçek bulgu, yarım kalan taramaya yeğlenir'
);
select is(
  (select sum(sites)::int from public.v_unique_outcomes),
  (select count(*)::int from public.sites),
  'her tekil site tam bir kez sayılır'
);

-- ── Günlük seri ──────────────────────────────────────────────────────────
select is((select count(*)::int from public.daily_attempts(4)), 4, 'günlük seri boş günleri de döndürür');
select results_eq(
  $$select real_attempts, completed, dry_runs from public.daily_attempts(4) order by day desc limit 1$$,
  $$values (1, 1, 1)$$,
  'bugün: 1 gerçek deneme (atlanan sayılmaz), 1 tamamlanan, 1 dry-run'
);
select is(
  (select real_attempts from public.daily_attempts(4) order by day limit 1),
  1, 'üç gün önceki başarısız deneme o günün gerçek denemesi'
);

select * from finish();
rollback;
