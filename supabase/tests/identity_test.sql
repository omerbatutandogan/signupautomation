-- Kimlik/erişim katmanının sözleşmesi. `npx supabase test db` ile çalışır.
begin;
create extension if not exists pgtap with schema extensions;

select plan(27);

-- Yerel seed e-postayı da açıyor; testler üretim ayarıyla başlar.
update public.panel_settings set value = '["google"]' where key = 'allowed_auth_providers';

-- ── Veri ────────────────────────────────────────────────────────────────
insert into public.allowed_emails (email, role) values
  ('member@test.local', 'member'),
  ('admin@test.local', 'admin'),
  ('Mixed.Case@Test.local', 'member');

insert into auth.users (id, email, aud, role, raw_user_meta_data) values
  ('00000000-0000-0000-0000-000000000001', 'member@test.local', 'authenticated', 'authenticated', '{"full_name":"Member"}'),
  ('00000000-0000-0000-0000-000000000002', 'outsider@test.local', 'authenticated', 'authenticated', '{}'),
  ('00000000-0000-0000-0000-000000000003', 'admin@test.local', 'authenticated', 'authenticated', '{}'),
  ('00000000-0000-0000-0000-000000000004', 'mixed.case@test.local', 'authenticated', 'authenticated', '{}');

select is((select count(*)::int from public.profiles), 4, 'her auth kullanıcısı için profil açılır');
select is(
  (select display_name from public.profiles where id = '00000000-0000-0000-0000-000000000001'),
  'Member',
  'görünen ad Google meta verisinden gelir'
);

-- ── Kanca: izin listesi ─────────────────────────────────────────────────
select is(
  public.hook_before_user_created('{"user":{"email":"outsider@test.local","app_metadata":{"provider":"google"}}}') -> 'error' ->> 'http_code',
  '403',
  'izin listesinde olmayan Google hesabı reddedilir'
);
select is(
  public.hook_before_user_created('{"user":{"email":"Member@TEST.local","app_metadata":{"provider":"google"}}}'),
  '{}'::jsonb,
  'izinli Google hesabı büyük/küçük harften bağımsız kabul edilir'
);
select is(
  public.hook_before_user_created('{"user":{"email":"mixed.case@test.local","app_metadata":{"provider":"google"}}}'),
  '{}'::jsonb,
  'büyük harfle eklenmiş izin kaydı küçük harfli girişle eşleşir'
);
select is(
  public.hook_before_user_created('{"user":{"app_metadata":{"provider":"google"}}}') -> 'error' ->> 'http_code',
  '403',
  'e-postasız istek reddedilir'
);

-- ── Kanca: giriş yöntemi ────────────────────────────────────────────────
select is(
  public.hook_before_user_created('{"user":{"email":"admin@test.local","app_metadata":{"provider":"email"}}}') -> 'error' ->> 'message',
  'Only Google sign-in is allowed for the panel.',
  'izinli adminin e-postasıyla ŞİFRELİ kayıt reddedilir (yalnız Google)'
);
select is(
  public.hook_before_user_created('{"user":{"email":"member@test.local"}}') -> 'error' ->> 'http_code',
  '403',
  'giriş yöntemi bilinmeyen istek reddedilir'
);
update public.panel_settings set value = '["google","email"]' where key = 'allowed_auth_providers';
select is(
  public.hook_before_user_created('{"user":{"email":"member@test.local","app_metadata":{"provider":"email"}}}'),
  '{}'::jsonb,
  'e-posta yöntemi yalnızca ayarda açıkken kabul edilir (yerel)'
);
update public.panel_settings set value = '["google"]' where key = 'allowed_auth_providers';

select ok(
  not has_function_privilege('authenticated', 'public.hook_before_user_created(jsonb)', 'execute'),
  'giriş yapmış kullanıcılar kancayı çağıramaz'
);

-- ── anon ─────────────────────────────────────────────────────────────────
set local role anon;
select throws_ok('select count(*) from public.profiles', '42501', null, 'anon profilleri okuyamaz');
select throws_ok('select count(*) from public.allowed_emails', '42501', null, 'anon izin listesini okuyamaz');
select throws_ok('select count(*) from public.panel_settings', '42501', null, 'anon ayarları okuyamaz');
reset role;

-- ── Üye olmayan (auth.users'ta var ama izin listesinde yok) ─────────────
set local role authenticated;
select set_config('request.jwt.claims', '{"sub":"00000000-0000-0000-0000-000000000002","role":"authenticated"}', true);
select is(public.is_member(), false, 'izin listesinde olmayan üye sayılmaz');
select is((select count(*)::int from public.profiles), 0, 'üye olmayan profilleri göremez');

-- ── Üye ──────────────────────────────────────────────────────────────────
select set_config('request.jwt.claims', '{"sub":"00000000-0000-0000-0000-000000000001","role":"authenticated"}', true);
select is(public.is_member(), true, 'izinli kullanıcı üyedir');
select is(public.is_admin(), false, 'üye admin sayılmaz');
select is((select count(*)::int from public.profiles), 4, 'üye profilleri görür');
select is((select count(*)::int from public.allowed_emails), 0, 'admin olmayan üye izin listesini göremez');
select throws_ok(
  $$insert into public.allowed_emails (email, role) values ('me-too@test.local', 'admin')$$,
  '42501',
  null,
  'üye kendini/başkasını izin listesine ekleyemez'
);
select throws_ok(
  $$update public.profiles set email = 'admin@test.local' where id = '00000000-0000-0000-0000-000000000001'$$,
  '42501',
  null,
  'üye profil e-postasını değiştiremez (yetki yükseltme yok)'
);
select throws_ok('select count(*) from public.panel_settings', '42501', null, 'üye ayarları okuyamaz');

-- ── Büyük harfli izin kaydı ──────────────────────────────────────────────
select set_config('request.jwt.claims', '{"sub":"00000000-0000-0000-0000-000000000004","role":"authenticated"}', true);
select is(public.is_member(), true, 'izin listesine büyük harfle eklenen kişi de üyedir');

-- ── Admin ────────────────────────────────────────────────────────────────
select set_config('request.jwt.claims', '{"sub":"00000000-0000-0000-0000-000000000003","role":"authenticated"}', true);
select is(public.is_admin(), true, 'admin admindir');
select is((select count(*)::int from public.allowed_emails), 3, 'admin izin listesini görür');

-- ── İptal anında etkili ──────────────────────────────────────────────────
reset role;
update public.allowed_emails set revoked_at = now() where email = 'member@test.local';
set local role authenticated;
select set_config('request.jwt.claims', '{"sub":"00000000-0000-0000-0000-000000000001","role":"authenticated"}', true);
select is(public.is_member(), false, 'iptal edilen kişi JWT geçerliyken bile üye sayılmaz');
select is((select count(*)::int from public.profiles), 0, 'iptal edilen kişi profilleri göremez');

select * from finish();
rollback;
