/**
 * Panel senkronunun saf dönüştürmeleri: yerel kaynaklar → Supabase satırları.
 *
 * Burada G/Ç yok; her fonksiyon girdisinden çıktısını üretir ve tarayıcısız,
 * veritabanısız test edilir. Kaynaklar (SQLite ledger, tarama dosyaları,
 * config'ler) Aşama 1'de hâlâ otoritedir; senkron onları yalnızca OKUR.
 */

import { MOVE_MARKER } from '../core/markers.js';
import { UNVERIFIED_MARKER } from '../discovery/generate-config.js';
import { DEFAULT_PRODUCT } from '../identity/account.js';

// ── Ledger ────────────────────────────────────────────────────────────────

export interface LedgerAttempt {
  id: number;
  site_id: string; // aslında HESAP ANAHTARI (site ya da urun@site)
  run_id: string;
  status: string;
  started_at: number;
  finished_at: number | null;
  note: string | null;
  terminal: number;
  dry_run: number;
}

export interface LedgerCredential {
  site_id: string;
  email: string;
  username: string;
  pw_version: number;
  created_at: number;
  profile_url: string | null;
}

export interface AccountRow {
  product_id: string;
  site_id: string;
  email: string | null;
  username: string | null;
  pw_version: number;
  password_source: 'derived' | 'user_held';
  status: 'opened' | 'already_existed';
  verification: 'link' | 'code' | 'none' | 'unverified' | null;
  profile_url: string | null;
  opened_at: string | null;
  note: string | null;
}

export interface AttemptRow {
  legacy_sqlite_id: number;
  account_key: string;
  product_id: string;
  site_id: string;
  run_id: string;
  status: string;
  dry_run: boolean;
  terminal: boolean;
  started_at: string;
  finished_at: string | null;
  note: string | null;
}

/** Hesap anahtarını ürün + siteye ayırır (accountKey'in tersi). */
export function splitAccountKey(key: string): { productId: string; siteId: string } {
  const at = key.indexOf('@');
  if (at === -1) return { productId: DEFAULT_PRODUCT, siteId: key };
  return { productId: key.slice(0, at), siteId: key.slice(at + 1) };
}

const iso = (ms: number | null): string | null => (ms == null ? null : new Date(ms).toISOString());

export function toAttemptRow(a: LedgerAttempt): AttemptRow {
  const { productId, siteId } = splitAccountKey(a.site_id);
  return {
    legacy_sqlite_id: a.id,
    account_key: a.site_id,
    product_id: productId,
    site_id: siteId,
    run_id: a.run_id,
    status: a.status,
    dry_run: a.dry_run === 1,
    terminal: a.terminal === 1,
    started_at: new Date(a.started_at).toISOString(),
    finished_at: iso(a.finished_at),
    note: a.note,
  };
}

/**
 * Açılmış hesapları ledger'dan türetir.
 *
 * Kimlik kaydı (credentials) hesabın VAR olduğunu göstermez: runner onu
 * formu göndermeden önce, dry-run'da bile yazıyor. Hesap = dry-run olmayan
 * bir "completed" denemesi. Açılış olayı o denemelerin İLKİ: sonraki
 * çalıştırmalar "Hesap zaten mevcut" der ve bu, hesabı bizim açtığımız
 * gerçeğini değiştirmez.
 *
 * @param configModes  site id → config'teki verification.mode (not boşsa kullanılır)
 */
export function deriveAccounts(
  attempts: LedgerAttempt[],
  credentials: LedgerCredential[],
  configModes: ReadonlyMap<string, string>,
): AccountRow[] {
  const credByKey = new Map(credentials.map((c) => [c.site_id, c]));
  const firstCompleted = new Map<string, LedgerAttempt>();
  const userHeld = new Set<string>();

  for (const a of [...attempts].sort((x, y) => x.started_at - y.started_at)) {
    if (a.dry_run === 1 || a.status !== 'completed') continue;
    if (!firstCompleted.has(a.site_id)) firstCompleted.set(a.site_id, a);
    // "şifre kullanıcıda" herhangi bir completed notunda geçebilir (elle işaret).
    if (/şifre kullanıcıda/i.test(a.note ?? '')) userHeld.add(a.site_id);
  }

  const rows: AccountRow[] = [];
  for (const [key, a] of firstCompleted) {
    const { productId, siteId } = splitAccountKey(key);
    const cred = credByKey.get(key);
    const note = a.note ?? '';
    const existed = /hesap zaten mevcut/i.test(note);

    let verification: AccountRow['verification'];
    if (existed) verification = null; // bizden önce açılmış: nasıl doğrulandığını bilmiyoruz
    else if (/doğrulaması gerekmiyor|doğrulama maili yok/i.test(note)) verification = 'none';
    else if (/DOĞRULANMAMIŞ/.test(note)) verification = 'unverified';
    else {
      const mode = configModes.get(siteId);
      verification = mode === 'link' || mode === 'code' || mode === 'none' ? mode : null;
    }

    rows.push({
      product_id: productId,
      site_id: siteId,
      email: cred?.email ?? null,
      username: cred?.username ?? null,
      pw_version: cred?.pw_version ?? 1,
      password_source: userHeld.has(key) ? 'user_held' : 'derived',
      status: existed ? 'already_existed' : 'opened',
      verification,
      profile_url: cred?.profile_url ?? null,
      opened_at: iso(a.finished_at ?? a.started_at),
      note: a.note,
    });
  }
  return rows.sort((x, y) => `${x.product_id}@${x.site_id}`.localeCompare(`${y.product_id}@${y.site_id}`));
}

// ── Config'ler ────────────────────────────────────────────────────────────

export type ConfigState = 'draft_unverified' | 'awaiting_move_approval' | 'verified';

/**
 * Config'in durumu, notlardaki damgalardan. Taşınma damgası önce gelir:
 * dry-run doğrulanmadı damgasını kaldırsa bile taşınma onayı insan bekler.
 */
export function classifyConfig(config: { notes?: string }): ConfigState {
  const notes = config.notes ?? '';
  if (notes.includes(MOVE_MARKER)) return 'awaiting_move_approval';
  if (notes.includes(UNVERIFIED_MARKER)) return 'draft_unverified';
  return 'verified';
}

// ── Tarama dosyaları ──────────────────────────────────────────────────────

export const DISCOVERY_OUTCOMES = [
  'generated', 'no_form', 'submit_form', 'email_first',
  'bot_protected', 'high_risk', 'error', 'skipped_existing',
] as const;
export type DiscoveryOutcome = (typeof DISCOVERY_OUTCOMES)[number];

export interface DiscoveryRow {
  tab: string;
  site_id: string;
  outcome: DiscoveryOutcome;
  reason: string | null;
  signup_url: string | null;
  discovered_at: string | null;
}

/**
 * data/discovery-<sekme>.json içeriğini satırlara çevirir.
 *
 * Tarama dosyayı her siteden sonra ATOMİK OLMAYAN biçimde yeniden yazıyor;
 * senkron yarım bir dosya görebilir. O durumda null döner — çağıran bu
 * sekmeyi bu turda atlar, sonraki turda yeniden dener (satır silmez).
 *
 * `dropped`: tanınmayan sonuçlu kayıt sayısı. Taramaya yeni bir sonuç türü
 * eklenip burası güncellenmezse o siteler panelde "taranmadı" görünürdü;
 * sessizce düşürmek yerine sayılır ve senkron uyarı olarak bildirir.
 */
export interface ParsedDiscoveries {
  rows: DiscoveryRow[];
  dropped: number;
}

export function parseDiscoveryFile(tab: string, text: string): ParsedDiscoveries | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return null;
  }
  const entries = (parsed as { entries?: Record<string, unknown> } | null)?.entries;
  if (!entries || typeof entries !== 'object') return null;

  const rows: DiscoveryRow[] = [];
  let dropped = 0;
  for (const raw of Object.values(entries)) {
    const e = raw as { siteId?: unknown; outcome?: unknown; reason?: unknown; signupUrl?: unknown; at?: unknown };
    if (typeof e.siteId !== 'string' || !DISCOVERY_OUTCOMES.includes(e.outcome as DiscoveryOutcome)) {
      dropped++;
      continue;
    }
    rows.push({
      tab,
      site_id: e.siteId,
      outcome: e.outcome as DiscoveryOutcome,
      reason: typeof e.reason === 'string' ? e.reason : null,
      signup_url: typeof e.signupUrl === 'string' ? e.signupUrl : null,
      discovered_at: typeof e.at === 'number' ? new Date(e.at).toISOString() : null,
    });
  }
  return { rows, dropped };
}

// ── Tarama ilerleme günlüğü ───────────────────────────────────────────────

export interface TabProgress {
  /** "YYYY-AA-GG SS:DD:SS" — işçinin yerel saati. */
  startedAt: string;
  finishedAt: string | null;
}

/**
 * data/scan-logs/_progress.log'dan sekme başına ilk başlangıç ve son bitiş.
 * Yeniden başlatılan sekmede ilk başlangıç korunur; "TEKRAR" (hata tekrarı)
 * satırları ana taramanın parçası sayılmaz.
 */
export function parseProgressLog(text: string): Map<string, TabProgress> {
  const out = new Map<string, TabProgress>();
  for (const line of text.split('\n')) {
    const m = /^(\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}) (BAŞLADI|BİTTİ) \[(.*?)\]/.exec(line);
    if (!m) continue;
    const [, at, kind, tab] = m as unknown as [string, string, string, string];
    const cur = out.get(tab);
    if (kind === 'BAŞLADI') {
      // Yeniden başlatıldıysa bitiş sıfırlanır; ilk başlangıç kalır.
      out.set(tab, { startedAt: cur?.startedAt ?? at, finishedAt: null });
    } else if (cur) {
      cur.finishedAt = at;
    }
  }
  return out;
}

// ── Sekme başına tarama ilerlemesi ────────────────────────────────────────

export interface ScanProgressRow {
  tab: string;
  total_rows?: number;
  scanned: number;
  started_at: string | null;
  finished_at: string | null;
}

/**
 * scan_progress satırları.
 *
 * Tarama dosyası bu turda okunamayan (yarım yazılmış) sekme için satır
 * ÜRETİLMEZ: taranan sayısı bilinmiyor, 0 yazmak yanlış olurdu. Sekmenin
 * veritabanındaki önceki satırı olduğu gibi kalır.
 *
 * @param totalByTab  Sheet bu turda okunduysa sekme → satır sayısı; okunmadıysa
 *                    null (total_rows kolonuna dokunulmaz).
 */
export function buildScanProgress(input: {
  discoveries: readonly DiscoveryRow[];
  skippedTabs: readonly string[];
  totalByTab: ReadonlyMap<string, number> | null;
  progress: ReadonlyMap<string, TabProgress>;
}): ScanProgressRow[] {
  const scannedByTab = new Map<string, number>();
  for (const d of input.discoveries) scannedByTab.set(d.tab, (scannedByTab.get(d.tab) ?? 0) + 1);
  const skipped = new Set(input.skippedTabs);
  // İşçinin yerel saatiyle yazılmış "YYYY-AA-GG SS:DD:SS" → ISO.
  const localToIso = (at: string | null) => (at ? new Date(at.replace(' ', 'T')).toISOString() : null);

  const tabs = new Set([...scannedByTab.keys(), ...(input.totalByTab?.keys() ?? []), ...input.progress.keys()]);
  return [...tabs]
    .filter((tab) => !skipped.has(tab))
    .sort()
    .map((tab) => ({
      tab,
      ...(input.totalByTab ? { total_rows: input.totalByTab.get(tab) ?? 0 } : {}),
      scanned: scannedByTab.get(tab) ?? 0,
      started_at: localToIso(input.progress.get(tab)?.startedAt ?? null),
      finished_at: localToIso(input.progress.get(tab)?.finishedAt ?? null),
    }));
}

// ── Ürün satırları ────────────────────────────────────────────────────────

export interface ProductSyncRow {
  id: string;
  status: 'draft' | 'ready';
  profile: unknown;
}

/**
 * products tablosuna yazılacak satırlar.
 *
 * - Profil dosyası olan ürün: dosyadan (ready/draft).
 * - Hesabı olup profil dosyası hiç olmayan ürün: boş taslak (hesaplar ona
 *   yabancı anahtarla bağlı; satır yoksa yazım patlar).
 * - Dosyası var ama OKUNAMAYAN ürün (yarım kaydedilmiş JSON): satır ÜRETİLMEZ.
 *   Veritabanındaki iyi satır olduğu gibi kalır; boş taslak yazmak ürünü
 *   hazır olmaktan çıkarır ve kuyruğu sessizce sıfırlardı.
 */
export function buildProductRows(
  files: readonly ProductSyncRow[],
  unreadableIds: readonly string[],
  accountProductIds: Iterable<string>,
): ProductSyncRow[] {
  const known = new Set([...files.map((f) => f.id), ...unreadableIds]);
  const placeholders = [...new Set(accountProductIds)]
    .filter((id) => !known.has(id))
    .sort()
    .map((id): ProductSyncRow => ({ id, status: 'draft', profile: {} }));
  return [...files, ...placeholders];
}
