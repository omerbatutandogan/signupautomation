import 'server-only';
import { cache } from 'react';
import { createClient } from '@/lib/supabase/server';
import type { Database } from '@/lib/supabase/database.types';
import { countOf, fetchAllPages, unwrap, unwrapOptional } from './result';

/**
 * Panelin okuma sorguları — hepsi oturumdaki üyenin yetkisiyle (RLS) çalışır.
 *
 * Hata yutulmaz: boş liste "veri yok" demektir, "okunamadı" değil. Sorgu
 * başarısızsa sayfa hata sınırına düşer (0 hesap gösterip yanıltmaz).
 * Sayımlar veritabanı görünümlerinde yapılır; PostgREST tek istekte en çok
 * 1000 satır döndürdüğü için satır çekip burada saymak sessizce eksik sayardı.
 */

type Tables = Database['public']['Tables'];
type Views = Database['public']['Views'];

export type SyncStatus = Tables['sync_status']['Row'];
export type Account = Tables['accounts']['Row'];
export type Attempt = Tables['attempts']['Row'];
export type ScanProgress = Tables['scan_progress']['Row'];
export type SiteStatus = Views['v_site_status']['Row'];
export type DailyAttempts = Database['public']['Functions']['daily_attempts']['Returns'][number];

// ── Senkron durumu ────────────────────────────────────────────────────────

/** Aynı render içinde sayfa başlığı ve sayfa gövdesi tek sorguyu paylaşır. */
export const getSyncStatus = cache(async (): Promise<SyncStatus | null> => {
  const supabase = await createClient();
  return unwrapOptional(await supabase.from('sync_status').select('*').maybeSingle(), 'Sync status');
});

// ── Genel akış ────────────────────────────────────────────────────────────

export interface ConfigStates {
  verified: number;
  draft: number;
  awaitingMove: number;
  invalid: number;
  total: number;
}

export async function getConfigStates(): Promise<ConfigStates> {
  const supabase = await createClient();
  const rows = unwrap(await supabase.from('v_config_states').select('state, configs'), 'Config states');
  const by = new Map(rows.map((r) => [r.state, r.configs ?? 0]));
  const states = {
    verified: by.get('verified') ?? 0,
    draft: by.get('draft_unverified') ?? 0,
    awaitingMove: by.get('awaiting_move_approval') ?? 0,
    invalid: by.get('invalid') ?? 0,
  };
  return { ...states, total: rows.reduce((n, r) => n + (r.configs ?? 0), 0) };
}

export async function getSiteCounts(): Promise<{ uniqueSites: number; sheetRows: number }> {
  const supabase = await createClient();
  const [sites, listings] = await Promise.all([
    supabase.from('sites').select('*', { count: 'exact', head: true }),
    supabase.from('site_listings').select('*', { count: 'exact', head: true }),
  ]);
  return { uniqueSites: countOf(sites, 'Sites'), sheetRows: countOf(listings, 'Sheet rows') };
}

export async function getUniqueOutcomes(): Promise<{ outcome: string; sites: number }[]> {
  const supabase = await createClient();
  const rows = unwrap(await supabase.from('v_unique_outcomes').select('outcome, sites'), 'Scan outcomes');
  return rows.flatMap((r) => (r.outcome && r.sites ? [{ outcome: r.outcome, sites: r.sites }] : []));
}

// ── Tarama haritası ───────────────────────────────────────────────────────

export async function getScanMap(): Promise<Views['v_scan_map']['Row'][]> {
  const supabase = await createClient();
  // En çok sekme × sonuç kadar satır (22 × 10); sayfalama yine de güvence.
  return fetchAllPages(
    (from, to) =>
      supabase.from('v_scan_map').select('tab, outcome, sites', { count: 'exact' }).order('tab').order('outcome').range(from, to),
    'Scan map',
  );
}

export async function getScanProgress(): Promise<ScanProgress[]> {
  const supabase = await createClient();
  return unwrap(await supabase.from('scan_progress').select('*').order('tab'), 'Scan progress');
}

export const SITE_PAGE_SIZE = 100;

export async function getSiteStatusPage(
  filter: { tab?: string; outcome?: string },
  page: number,
): Promise<{ rows: SiteStatus[]; total: number }> {
  const supabase = await createClient();
  let query = supabase.from('v_site_status').select('*', { count: 'exact' });
  if (filter.tab !== undefined) query = query.eq('tab', filter.tab);
  if (filter.outcome !== undefined) query = query.eq('outcome', filter.outcome);
  const from = page * SITE_PAGE_SIZE;
  // site_id: aynı satır numarası iki kez geçerse sayfalar arasında sıra oynamasın.
  const result = await query.order('tab').order('row_number').order('site_id').range(from, from + SITE_PAGE_SIZE - 1);
  // Listenin sonundan öteki sayfa (elle yazılmış ?page=) hata değil, boş sayfadır.
  if (result.error?.code === 'PGRST103') return { rows: [], total: 0 };
  return { rows: unwrap(result, 'Sites'), total: countOf(result, 'Sites') };
}

/** Elle yazılmış ?page= için üst sınır: bundan ötesi anlamsız bir aralık üretir. */
export const SITE_MAX_PAGE = 1000;

// ── Hesaplar ──────────────────────────────────────────────────────────────

export interface AccountWithSite extends Account {
  website: string | null;
}

export async function getAccounts(): Promise<AccountWithSite[]> {
  const supabase = await createClient();
  const accounts = await fetchAllPages(
    (from, to) =>
      supabase
        .from('accounts')
        .select('*', { count: 'exact' })
        .order('opened_at', { ascending: false })
        .order('id')
        .range(from, to),
    'Accounts',
  );
  // accounts.site_id'nin sites'a yabancı anahtarı yok (hesap, Sheet'ten
  // silinmiş bir sitede de durur); adresler ayrı sorguyla eşlenir.
  const websites = await getWebsites([...new Set(accounts.map((a) => a.site_id))]);
  return accounts.map((a) => ({ ...a, website: websites.get(a.site_id) ?? null }));
}

export async function getWebsites(siteIds: string[]): Promise<Map<string, string>> {
  const supabase = await createClient();
  const out = new Map<string, string>();
  // URL uzunluğu sınırı: id'ler dilimler halinde sorulur.
  for (let i = 0; i < siteIds.length; i += 200) {
    const rows = unwrap(
      await supabase.from('sites').select('id, website').in('id', siteIds.slice(i, i + 200)),
      'Site addresses',
    );
    for (const r of rows) out.set(r.id, r.website);
  }
  return out;
}

/** Matris için yalnızca hücreyi belirleyen alanlar. */
export async function getAccountCells(): Promise<Pick<Account, 'product_id' | 'site_id' | 'status'>[]> {
  const supabase = await createClient();
  return fetchAllPages(
    (from, to) =>
      supabase.from('accounts').select('product_id, site_id, status', { count: 'exact' }).order('id').range(from, to),
    'Accounts',
  );
}

export async function getAccountCounts(): Promise<{ total: number; opened: number; existed: number }> {
  const supabase = await createClient();
  const [total, opened] = await Promise.all([
    supabase.from('accounts').select('*', { count: 'exact', head: true }),
    supabase.from('accounts').select('*', { count: 'exact', head: true }).eq('status', 'opened'),
  ]);
  const all = countOf(total, 'Accounts');
  const byUs = countOf(opened, 'Opened accounts');
  return { total: all, opened: byUs, existed: all - byUs };
}

// ── Kuyruk ve hız ─────────────────────────────────────────────────────────

export interface Backlog {
  productId: string;
  ready: number;
  /** Terminal sonuç yüzünden işçinin kendiliğinden denemeyeceği çiftler. */
  blocked: number;
  unverified: number;
  awaitingMove: number;
  opened: number;
}

export async function getBacklog(): Promise<Backlog[]> {
  const supabase = await createClient();
  const rows = unwrap(await supabase.from('v_signup_backlog').select('*').order('product_id'), 'Signup backlog');
  return rows.flatMap((r) =>
    r.product_id
      ? [
          {
            productId: r.product_id,
            ready: r.ready ?? 0,
            blocked: r.blocked ?? 0,
            unverified: r.unverified ?? 0,
            awaitingMove: r.awaiting_move ?? 0,
            opened: r.opened ?? 0,
          },
        ]
      : [],
  );
}

export interface BlockedPair {
  productId: string;
  siteId: string;
  status: string;
  note: string | null;
  finishedAt: string | null;
}

/** İşçinin kendiliğinden yeniden denemeyeceği çiftler (son gerçek sonuç terminal). */
export async function getBlockedPairs(): Promise<BlockedPair[]> {
  const supabase = await createClient();
  const rows = await fetchAllPages(
    (from, to) =>
      supabase
        .from('v_blocked_pairs')
        .select('*', { count: 'exact' })
        .order('finished_at', { ascending: false })
        .order('product_id')
        .order('site_id')
        .range(from, to),
    'Blocked signups',
  );
  return rows.flatMap((r) =>
    r.product_id && r.site_id
      ? [{ productId: r.product_id, siteId: r.site_id, status: r.status ?? '', note: r.note, finishedAt: r.finished_at }]
      : [],
  );
}

/** Varsayılan: işçinin config.ts'indeki DAILY_LIMIT varsayılanıyla aynı. */
const DEFAULT_DAILY_LIMIT = 12;

export async function getUsage(): Promise<{ usedToday: number; dailyLimit: number }> {
  const supabase = await createClient();
  const [used, status] = await Promise.all([supabase.rpc('real_attempts_today'), getSyncStatus()]);
  return {
    usedToday: unwrap(used, "Today's usage"),
    dailyLimit: status?.daily_limit ?? DEFAULT_DAILY_LIMIT,
  };
}

export async function getDailyAttempts(days: number): Promise<DailyAttempts[]> {
  const supabase = await createClient();
  return unwrap(await supabase.rpc('daily_attempts', { days }), 'Daily attempts');
}

export async function getRecentAttempts(limit: number): Promise<Attempt[]> {
  const supabase = await createClient();
  return unwrap(
    await supabase.from('attempts').select('*').order('started_at', { ascending: false }).order('id', { ascending: false }).limit(limit),
    'Recent attempts',
  );
}

// ── Ürünler ───────────────────────────────────────────────────────────────

export interface Product {
  id: string;
  status: string;
  name: string | null;
  website: string | null;
  tagline: string | null;
  updatedAt: string;
}

function text(value: unknown): string | null {
  return typeof value === 'string' && value.trim() !== '' ? value : null;
}

export async function getProducts(): Promise<Product[]> {
  const supabase = await createClient();
  const rows = unwrap(await supabase.from('products').select('id, status, profile, updated_at').order('id'), 'Products');
  return rows.map((r) => {
    // Taslak ürünün profili şemadan geçmemiş olabilir: alanlara güvenme.
    const profile = (r.profile && typeof r.profile === 'object' && !Array.isArray(r.profile) ? r.profile : {}) as Record<string, unknown>;
    return {
      id: r.id,
      status: r.status,
      name: text(profile.companyName),
      website: text(profile.website),
      tagline: text(profile.tagline),
      updatedAt: r.updated_at,
    };
  });
}

export interface VerifiedConfig {
  siteId: string;
  risk: string | null;
  verificationMode: string | null;
  signupUrl: string | null;
}

export async function getVerifiedConfigs(): Promise<VerifiedConfig[]> {
  const supabase = await createClient();
  const rows = await fetchAllPages(
    (from, to) =>
      supabase
        .from('site_configs')
        .select('site_id, risk, verification_mode, signup_url', { count: 'exact' })
        .eq('state', 'verified')
        .order('site_id')
        .range(from, to),
    'Verified configs',
  );
  return rows.map((r) => ({
    siteId: r.site_id,
    risk: r.risk,
    verificationMode: r.verification_mode,
    signupUrl: r.signup_url,
  }));
}
