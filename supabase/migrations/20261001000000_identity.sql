-- Kimlik ve erişim: izin listesi, profiller, üyelik kontrolü.
--
-- Panel bir iç araç: yalnızca izin listesindeki Google hesapları girebilir.
-- Üç katman:
--   1) Before User Created kancası izinsiz e-postaya HİÇ auth.users satırı
--      açtırmaz (hook_before_user_created).
--   2) Her RLS politikası is_member()'e bakar; izin listesinden çıkarılan
--      kişinin JWT'si henüz geçerli olsa bile erişimi anında kesilir.
--   3) Üretimde yalnızca Google sağlayıcısı açık (dashboard ayarı).

create extension if not exists citext with schema extensions;

-- ── İzin listesi ─────────────────────────────────────────────────────────
create table public.allowed_emails (
  email extensions.citext primary key,
  role text not null default 'member' check (role in ('admin', 'member')),
  added_by uuid references auth.users (id) on delete set null,
  added_at timestamptz not null default now(),
  revoked_at timestamptz
);

comment on table public.allowed_emails is
  'Panele girebilecek Google hesapları. revoked_at dolu = erişim kapalı.';

-- ── Panel ayarları ───────────────────────────────────────────────────────
-- İzin verilen giriş yöntemleri. Üretimde YALNIZCA Google: kanca yalnızca
-- e-postaya bakarsa ve e-posta kaydı bir gün açılırsa (ör. `supabase config
-- push`), biri davet edilmiş ama henüz girmemiş bir adminin adresiyle
-- şifreli kayıt olup admin olurdu. Yerelde seed.sql e-postayı da açar
-- (uçtan uca testler e-postayla giriyor); seed üretime uygulanmaz.
create table public.panel_settings (
  key text primary key,
  value jsonb not null
);
alter table public.panel_settings enable row level security;
revoke all on public.panel_settings from anon, authenticated;
-- Politika yok: istemciler okuyamaz/yazamaz; kanca security definer ile okur.

insert into public.panel_settings (key, value)
values ('allowed_auth_providers', '["google"]');

-- ── Profiller ────────────────────────────────────────────────────────────
create table public.profiles (
  id uuid primary key references auth.users (id) on delete cascade,
  email extensions.citext not null unique,
  display_name text,
  created_at timestamptz not null default now()
);

-- Her yeni auth kullanıcısı için profil satırı. Kanca izinsizleri zaten
-- reddettiği için buraya yalnızca izinli e-postalar ulaşır.
create function public.handle_new_user()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  insert into public.profiles (id, email, display_name)
  values (
    new.id,
    new.email,
    coalesce(new.raw_user_meta_data ->> 'full_name', new.raw_user_meta_data ->> 'name')
  );
  return new;
end;
$$;

create trigger on_auth_user_created
  after insert on auth.users
  for each row execute function public.handle_new_user();

-- ── Üyelik kontrolleri ───────────────────────────────────────────────────
-- DİKKAT: fonksiyonlar `search_path = ''` ile çalışıyor; bu durumda citext'in
-- büyük/küçük harf duyarsız `=` operatörü (extensions şemasında) bulunamaz ve
-- Postgres sessizce düz metin karşılaştırmasına düşer. Bu yüzden e-posta
-- karşılaştırmaları açıkça lower() ile yapılıyor (pgTAP testi bunu yakaladı).
-- security definer: politikaların içinden çağrıldığında allowed_emails'in
-- kendi RLS'ine takılmadan bakabilsin. stable: politikalarda
-- `(select public.is_member())` biçimiyle ifade başına bir kez hesaplanır.
create function public.is_member()
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (
    select 1
    from public.profiles p
    join public.allowed_emails a on lower(a.email::text) = lower(p.email::text)
    where p.id = auth.uid()
      and a.revoked_at is null
  );
$$;

create function public.is_admin()
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (
    select 1
    from public.profiles p
    join public.allowed_emails a on lower(a.email::text) = lower(p.email::text)
    where p.id = auth.uid()
      and a.revoked_at is null
      and a.role = 'admin'
  );
$$;

-- ── Before User Created kancası ──────────────────────────────────────────
-- Auth sunucusu yeni kullanıcı açmadan önce çağırır (Google dahil tüm
-- yöntemler). '{}' = izin ver; error nesnesi = reddet, satır oluşmaz.
-- Olay yapısı (yerelde ölçüldü): user.email, user.app_metadata.provider.
create function public.hook_before_user_created(event jsonb)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  candidate text := event -> 'user' ->> 'email';
  provider text := event -> 'user' -> 'app_metadata' ->> 'provider';
  allowed_providers jsonb := coalesce(
    (select value from public.panel_settings where key = 'allowed_auth_providers'),
    '["google"]'::jsonb
  );
begin
  -- Yöntem bilinmiyorsa da reddet (kapalı başarısızlık).
  if provider is null or not (allowed_providers ? provider) then
    return jsonb_build_object(
      'error',
      jsonb_build_object(
        'http_code', 403,
        'message', 'Only Google sign-in is allowed for the panel.'
      )
    );
  end if;

  if candidate is not null and exists (
    select 1
    from public.allowed_emails
    where lower(email::text) = lower(candidate)
      and revoked_at is null
  ) then
    return '{}'::jsonb;
  end if;

  return jsonb_build_object(
    'error',
    jsonb_build_object(
      'http_code', 403,
      'message', 'This Google account is not allowed to use the panel.'
    )
  );
end;
$$;

grant execute on function public.hook_before_user_created(jsonb) to supabase_auth_admin;
revoke execute on function public.hook_before_user_created(jsonb) from public, anon, authenticated;

-- ── RLS ──────────────────────────────────────────────────────────────────
alter table public.allowed_emails enable row level security;
alter table public.profiles enable row level security;

-- anon hiçbir panel tablosuna dokunamaz (RLS'e ek, savunma derinliği).
revoke all on public.allowed_emails from anon;
revoke all on public.profiles from anon;

create policy "admins read allowlist"
  on public.allowed_emails for select
  to authenticated
  using ((select public.is_admin()));

create policy "admins add to allowlist"
  on public.allowed_emails for insert
  to authenticated
  with check ((select public.is_admin()));

create policy "admins change allowlist"
  on public.allowed_emails for update
  to authenticated
  using ((select public.is_admin()))
  with check ((select public.is_admin()));

create policy "members read profiles"
  on public.profiles for select
  to authenticated
  using ((select public.is_member()));

-- Kişi yalnızca kendi görünen adını değiştirir; e-posta auth'tan gelir.
create policy "members update own profile"
  on public.profiles for update
  to authenticated
  using (id = (select auth.uid()) and (select public.is_member()))
  with check (id = (select auth.uid()));

revoke update on public.profiles from authenticated;
grant update (display_name) on public.profiles to authenticated;
