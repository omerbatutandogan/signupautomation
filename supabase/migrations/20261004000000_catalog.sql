-- Aşama 1: salt-okunur panelin verisi.
--
-- Bu tabloların TEK yazarı işçi/senkron sürecidir (secret key, RLS'i aşar).
-- Panel kullanıcıları yalnızca okur: her tabloda "members read" politikası
-- var, yazma politikası YOK. Aşama 1'de kaynak hâlâ yerel dosyalar ve
-- SQLite ledger; senkron bunları buraya yansıtır (kaynağa asla yazmaz).

-- ── Siteler ve Sheet satırları ───────────────────────────────────────────
create table public.sites (
  -- siteIdFromWebsite() çıktısı; mevcut satırlar için ASLA yeniden hesaplanmaz
  -- (hesap anahtarı ve türetilen şifre buna bağlı).
  id text primary key,
  website text not null,
  name text,
  first_seen_at timestamptz not null default now()
);

create table public.site_listings (
  -- Sekme adı Sheet'teki haliyle saklanır (sondaki boşluk dahil: "Deals ").
  tab text not null,
  site_id text not null references public.sites (id) on delete cascade,
  row_number int not null,
  sheet_status text not null default '',
  imported_at timestamptz not null default now(),
  primary key (tab, site_id)
);

-- ── Keşif (tarama) sonuçları ─────────────────────────────────────────────
create type public.discovery_outcome as enum (
  'generated', 'no_form', 'submit_form', 'email_first',
  'bot_protected', 'high_risk', 'error', 'skipped_existing'
);

create table public.site_discoveries (
  tab text not null,
  site_id text not null,
  outcome public.discovery_outcome not null,
  reason text,
  signup_url text,
  discovered_at timestamptz,
  primary key (tab, site_id)
);
create index site_discoveries_outcome_idx on public.site_discoveries (outcome);
-- v_site_outcome siteye göre arar; birincil anahtar (tab, site_id) bunu karşılamaz.
create index site_discoveries_site_idx on public.site_discoveries (site_id);

create table public.scan_progress (
  tab text primary key,
  total_rows int not null default 0,
  scanned int not null default 0,
  started_at timestamptz,
  finished_at timestamptz,
  updated_at timestamptz not null default now()
);

-- ── Site config yansıması ────────────────────────────────────────────────
-- Config'ler v1'de repo'da JSON dosyası olarak kalır (kod sayılır, testle
-- düzenlenir). Buradaki satır salt-okunur yansıma + yedek.
create table public.site_configs (
  site_id text primary key,
  state text not null check (state in ('draft_unverified', 'awaiting_move_approval', 'verified', 'invalid')),
  risk text,
  verification_mode text,
  solve_captcha boolean,
  signup_url text,
  config jsonb,
  content_hash text not null,
  parse_error text,
  synced_at timestamptz not null default now()
);
create index site_configs_state_idx on public.site_configs (state);

-- ── Ürünler ──────────────────────────────────────────────────────────────
create table public.products (
  id text primary key check (id ~ '^[a-z0-9]+(-[a-z0-9]+)*$'),
  status text not null default 'draft' check (status in ('draft', 'ready', 'archived')),
  profile jsonb not null default '{}'::jsonb,
  updated_at timestamptz not null default now()
);

-- Ürün id'si hesap anahtarına, o da türetilen şifreye girer: id değişirse o
-- ürünün bütün hesap şifreleri sessizce değişir. Değiştirmek yasak.
create function public.forbid_product_id_change()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if new.id is distinct from old.id then
    raise exception 'product id is immutable (it is part of every derived password)';
  end if;
  return new;
end;
$$;

create trigger products_id_immutable
  before update on public.products
  for each row execute function public.forbid_product_id_change();

-- ── Hesaplar ve denemeler ────────────────────────────────────────────────
create table public.accounts (
  id uuid primary key default gen_random_uuid(),
  product_id text not null references public.products (id),
  site_id text not null,
  -- packages/shared accountKey() ile BİREBİR aynı olmalı (sözleşme testi var).
  account_key text generated always as (
    case when product_id = 'geo-new' then site_id else product_id || '@' || site_id end
  ) stored unique,
  email extensions.citext,
  username text,
  pw_version int not null default 1,
  -- derived: şifre MASTER_SECRET'tan türetilir. user_held: hesap sistemden
  -- önce vardı, şifre kullanıcıda (betalist) — türetilen şifre ÇALIŞMAZ.
  password_source text not null default 'derived' check (password_source in ('derived', 'user_held', 'unknown')),
  status text not null check (status in ('opened', 'already_existed')),
  verification text check (verification in ('link', 'code', 'none', 'unverified')),
  profile_url text,
  opened_at timestamptz,
  note text,
  unique (product_id, site_id)
);

-- Çakışma koruması veritabanında da: aynı e-posta aynı sitede tek hesap.
create unique index accounts_site_email_idx on public.accounts (site_id, lower(email::text));

create table public.attempts (
  id bigint generated always as identity primary key,
  account_key text not null,
  product_id text not null,
  site_id text not null,
  run_id text,
  status text not null,
  dry_run boolean not null default false,
  terminal boolean not null default false,
  started_at timestamptz not null,
  finished_at timestamptz,
  note text,
  -- SQLite ledger'daki id; senkronun aynı satırı iki kez eklememesi için.
  legacy_sqlite_id int unique
);
create index attempts_started_idx on public.attempts (started_at);
create index attempts_account_idx on public.attempts (account_key);

-- ── Senkron kalp atışı ───────────────────────────────────────────────────
-- Tek satır. Panel yansıma gösterdiği için "veri ne kadar taze" sorusunun
-- cevabı burada: işçinin Mac'i uyursa/kapanırsa last_ok_at eskir ve panel
-- bunu açıkça söyler (rakamlar güncelmiş gibi görünmesin).
create table public.sync_status (
  id boolean primary key default true check (id),
  last_run_at timestamptz not null,
  last_ok_at timestamptz,
  last_error text,
  -- Sheet her turda okunmaz (site listesi seyrek değişir, kota var).
  sheet_read_at timestamptz,
  changed_rows int not null default 0,
  -- İşçinin DAILY_LIMIT ayarı; panel "bugün N / limit" için buradan okur.
  daily_limit int not null default 12 check (daily_limit > 0),
  source_host text
);

-- ── Günlük kullanım ──────────────────────────────────────────────────────
-- Ledger.countToday() ile aynı kural: dry-run ve atlananlar sayılmaz.
-- Gün sınırı işçinin saat dilimine göre (IP koruması işçiye aittir).
create function public.real_attempts_today(tz text default 'Europe/Istanbul')
returns int
language sql
stable
set search_path = ''
as $$
  select count(*)::int
  from public.attempts
  where not dry_run
    and status not like 'skipped%'
    and started_at >= (date_trunc('day', now() at time zone tz) at time zone tz);
$$;

-- Son N günün deneme sayıları (boş günler 0 olarak gelir). Aynı sayım kuralı.
create function public.daily_attempts(days int default 14, tz text default 'Europe/Istanbul')
returns table (day date, real_attempts int, completed int, dry_runs int)
language sql
stable
set search_path = ''
as $$
  with d as (
    select generate_series(
      (now() at time zone tz)::date - (least(greatest(days, 1), 90) - 1),
      (now() at time zone tz)::date,
      interval '1 day'
    )::date as day
  )
  select
    d.day,
    count(a.id) filter (where not a.dry_run and a.status not like 'skipped%')::int,
    count(a.id) filter (where not a.dry_run and a.status = 'completed')::int,
    count(a.id) filter (where a.dry_run)::int
  from d
  left join public.attempts a on (a.started_at at time zone tz)::date = d.day
  group by d.day
  order by d.day;
$$;

-- Fonksiyonlar çağıranın yetkisiyle çalışır (RLS geçerli); yine de anon'a
-- çalıştırma izni bırakılmaz.
revoke execute on function public.real_attempts_today(text) from public, anon;
revoke execute on function public.daily_attempts(int, text) from public, anon;
grant execute on function public.real_attempts_today(text) to authenticated, service_role;
grant execute on function public.daily_attempts(int, text) to authenticated, service_role;

-- ── RLS: üyeler okur, kimse (istemci) yazamaz ────────────────────────────
do $$
declare
  t text;
begin
  foreach t in array array[
    'sites', 'site_listings', 'site_discoveries', 'scan_progress',
    'site_configs', 'products', 'accounts', 'attempts', 'sync_status'
  ]
  loop
    execute format('alter table public.%I enable row level security', t);
    execute format('revoke all on public.%I from anon', t);
    execute format('revoke insert, update, delete, truncate on public.%I from authenticated', t);
    execute format(
      'create policy "members read" on public.%I for select to authenticated using ((select public.is_member()))',
      t
    );
  end loop;
end;
$$;

-- ── Panel görünümleri (security_invoker: RLS görüntüleyene göre uygulanır) ─
-- PostgREST tek istekte en çok 1000 satır döndürür; sayımlar veritabanında.

-- Site bazında tarama durumu: tarama haritasının detay listesi ve sayımların
-- tek kaynağı (sonuç kuralı yalnızca burada yazılı).
create view public.v_site_status with (security_invoker = true) as
select
  l.tab,
  l.site_id,
  l.row_number,
  s.website,
  s.name,
  -- Sonuç yoksa: config'i önceden olan site taranmadan atlanır → 'has_config';
  -- yoksa henüz taranmamış.
  coalesce(
    d.outcome::text,
    case when c.site_id is not null then 'has_config' else 'not_scanned' end
  ) as outcome,
  d.reason,
  coalesce(d.signup_url, c.signup_url) as signup_url,
  c.state as config_state,
  c.risk
from public.site_listings l
join public.sites s on s.id = l.site_id
left join public.site_discoveries d on d.tab = l.tab and d.site_id = l.site_id
left join public.site_configs c on c.site_id = l.site_id;

create view public.v_scan_map with (security_invoker = true) as
select tab, outcome, count(*)::int as sites
from public.v_site_status
group by 1, 2;

-- Tekil site bazında sonuç: aynı site birden çok sekmede geçebilir (3281
-- satır, ~2500 tekil site); "listenin ne kadarı otomatikleşebilir" sorusu
-- satır değil SİTE sayısıyla cevaplanır. Config'i olan site 'config';
-- yoksa sekmelerdeki sonuçların en bilgilendirici olanı (yarım kalan 'error'
-- gerçek bir bulguya yenilir).
create view public.v_site_outcome with (security_invoker = true) as
select
  s.id as site_id,
  case
    when c.site_id is not null then 'config'
    else coalesce(
      (
        select d.outcome::text
        from public.site_discoveries d
        where d.site_id = s.id
        order by array_position(
          array['generated', 'submit_form', 'email_first', 'bot_protected', 'high_risk', 'no_form', 'error', 'skipped_existing'],
          d.outcome::text
        )
        limit 1
      ),
      'not_scanned'
    )
  end as outcome
from public.sites s
left join public.site_configs c on c.site_id = s.id;

create view public.v_unique_outcomes with (security_invoker = true) as
select outcome, count(*)::int as sites
from public.v_site_outcome
group by 1;

create view public.v_config_states with (security_invoker = true) as
select state, count(*)::int as configs
from public.site_configs
group by 1;

-- Bir ürün × site çifti için son GERÇEK terminal sonuç (hesabı olmayanlar).
-- İşçi terminal sonucu olan hesabı --force olmadan yeniden denemez
-- (runner.ts → ledger.terminalResult ile aynı kural: dry-run sayılmaz, en son
-- biten geçerlidir). Bu çiftler "hazır" değildir; bir insanın bakması gerekir.
create view public.v_blocked_pairs with (security_invoker = true) as
select distinct on (t.product_id, t.site_id)
  t.product_id,
  t.site_id,
  t.status,
  t.note,
  t.finished_at
from public.attempts t
where t.terminal
  and not t.dry_run
  and not exists (
    select 1 from public.accounts a where a.product_id = t.product_id and a.site_id = t.site_id
  )
order by t.product_id, t.site_id, t.finished_at desc nulls last, t.id desc;

-- Kayıt kuyruğu, ürün başına.
--   ready:      ürün hazır, config doğrulanmış, yüksek riskli değil, hesap yok
--               ve işçinin denemesini engelleyen terminal sonuç yok.
--   blocked:    terminal sonuç yüzünden işçinin kendiliğinden denemeyeceği çiftler.
--   unverified / awaiting_move: config tarafı bekleyenler (yalnızca hazır ürün).
-- Hazır olmayan (taslak/arşiv) ürün için kuyruk boştur: kaydı yapılamaz.
-- left join … on true: hiç config yokken de ürün satırı görünür.
create view public.v_signup_backlog with (security_invoker = true) as
select
  p.id as product_id,
  count(*) filter (
    where p.status = 'ready' and c.state = 'verified' and coalesce(c.risk, 'low') <> 'high'
      and a.id is null and b.site_id is null
  )::int as ready,
  count(*) filter (
    where p.status = 'ready' and c.state = 'draft_unverified' and coalesce(c.risk, 'low') <> 'high'
      and a.id is null and b.site_id is null
  )::int as unverified,
  count(*) filter (
    where p.status = 'ready' and c.state = 'awaiting_move_approval' and a.id is null and b.site_id is null
  )::int as awaiting_move,
  (select count(*) from public.v_blocked_pairs b2 where b2.product_id = p.id)::int as blocked,
  -- Config'i silinmiş sitedeki hesap da sayılır (config birleşiminden bağımsız).
  (select count(*) from public.accounts a2 where a2.product_id = p.id)::int as opened
from public.products p
left join public.site_configs c on true
left join public.accounts a on a.product_id = p.id and a.site_id = c.site_id
left join public.v_blocked_pairs b on b.product_id = p.id and b.site_id = c.site_id
group by p.id, p.status;

-- Görünümler güncellenebilir değil; yine de yazma izni bırakılmaz.
revoke all on
  public.v_site_status, public.v_scan_map, public.v_site_outcome, public.v_unique_outcomes,
  public.v_config_states, public.v_blocked_pairs, public.v_signup_backlog
  from anon, authenticated;
grant select on
  public.v_site_status, public.v_scan_map, public.v_site_outcome, public.v_unique_outcomes,
  public.v_config_states, public.v_blocked_pairs, public.v_signup_backlog
  to authenticated;
