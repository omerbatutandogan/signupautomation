/**
 * Panel senkronunun kaynak okuyucuları — hepsi SALT OKUNUR.
 *
 * Kaynak dizin canlı sistemindir (tarama ve CLI orada çalışıyor). Bu modül
 * hiçbir dosyanın İÇERİĞİNİ değiştirmez ve SQLite'ı `readonly` açar:
 * `new Ledger()` yapıcısı migrate + bayat kilit temizliği çalıştırdığı için
 * burada KULLANILMAZ.
 *
 * Tek istisna SQLite'ın kendi yardımcı dosyaları: ledger WAL kipinde olduğu
 * için salt-okunur bir bağlantı bile `ledger.sqlite-shm` (ve yoksa boş bir
 * `-wal`) dosyasını oluşturur/günceller. Bunlar veri değil, paylaşılan bellek
 * dizinidir; ana veritabanı dosyasına dokunulmaz.
 */

import { createHash } from 'node:crypto';
import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import type { Logger } from 'pino';
import { ProfileSchema, isProductId } from '@signup/shared';
import { SheetClient, type SheetRow } from '../integrations/sheet.js';
import {
  classifyConfig,
  parseDiscoveryFile,
  parseProgressLog,
  type ConfigState,
  type DiscoveryRow,
  type LedgerAttempt,
  type LedgerCredential,
  type TabProgress,
} from './mappers.js';

export interface SourcePaths {
  ledger: string;
  dataDir: string;
  sitesDir: string;
  profileDir: string;
}

export function sourcePaths(sourceDir: string): SourcePaths {
  return {
    ledger: join(sourceDir, 'data', 'ledger.sqlite'),
    dataDir: join(sourceDir, 'data'),
    sitesDir: join(sourceDir, 'src', 'sites'),
    profileDir: join(sourceDir, 'src', 'profile'),
  };
}

export function readLedger(path: string): { attempts: LedgerAttempt[]; credentials: LedgerCredential[] } {
  const db = new Database(path, { readonly: true, fileMustExist: true });
  try {
    return {
      attempts: db.prepare('SELECT id, site_id, run_id, status, started_at, finished_at, note, terminal, dry_run FROM attempts ORDER BY id').all() as LedgerAttempt[],
      credentials: db.prepare('SELECT site_id, email, username, pw_version, created_at, profile_url FROM credentials').all() as LedgerCredential[],
    };
  } finally {
    db.close();
  }
}

export interface DiscoveryRead {
  rows: DiscoveryRow[];
  /** Yarım yazılmış olduğu için bu turda atlanan sekmeler. */
  skippedTabs: string[];
  /** Tanınmayan sonuç yüzünden alınamayan kayıt sayısı (0 olmalı). */
  dropped: number;
}

/** data/discovery-<sekme>.json dosyaları; sekme adı dosya adından (boşluklar dahil). */
export async function readDiscoveries(dataDir: string): Promise<DiscoveryRead> {
  const files = (await readdir(dataDir)).filter((f) => /^discovery-.*\.json$/.test(f));
  const rows: DiscoveryRow[] = [];
  const skippedTabs: string[] = [];
  let dropped = 0;
  for (const file of files) {
    const tab = file.slice('discovery-'.length, -'.json'.length);
    const parsed = parseDiscoveryFile(tab, await readFile(join(dataDir, file), 'utf8'));
    if (parsed === null) {
      skippedTabs.push(tab);
    } else {
      rows.push(...parsed.rows);
      dropped += parsed.dropped;
    }
  }
  return { rows, skippedTabs, dropped };
}

export interface ConfigRow {
  site_id: string;
  state: ConfigState | 'invalid';
  risk: string | null;
  verification_mode: string | null;
  solve_captcha: boolean | null;
  signup_url: string | null;
  config: unknown;
  content_hash: string;
  parse_error: string | null;
}

/** src/sites/*.json — bozuk JSON 'invalid' satırı olur (sessizce kaybolmaz). */
export async function readConfigs(sitesDir: string): Promise<ConfigRow[]> {
  const files = (await readdir(sitesDir)).filter((f) => f.endsWith('.json')).sort();
  const rows: ConfigRow[] = [];
  for (const file of files) {
    const text = await readFile(join(sitesDir, file), 'utf8');
    const content_hash = createHash('sha256').update(text).digest('hex');
    const site_id = file.slice(0, -'.json'.length);
    try {
      const c = JSON.parse(text) as {
        notes?: string;
        risk?: string;
        signupUrl?: string;
        solveCaptcha?: boolean;
        verification?: { mode?: string };
      };
      rows.push({
        site_id,
        state: classifyConfig(c),
        risk: c.risk ?? null,
        verification_mode: c.verification?.mode ?? null,
        solve_captcha: c.solveCaptcha ?? null,
        signup_url: c.signupUrl ?? null,
        config: c,
        content_hash,
        parse_error: null,
      });
    } catch (err) {
      rows.push({
        site_id,
        state: 'invalid',
        risk: null,
        verification_mode: null,
        solve_captcha: null,
        signup_url: null,
        config: null,
        content_hash,
        parse_error: (err as Error).message.slice(0, 200),
      });
    }
  }
  return rows;
}

export interface ProductRow {
  id: string;
  status: 'draft' | 'ready';
  profile: unknown;
}

export interface ProductRead {
  rows: ProductRow[];
  /** Bu turda alınamayan dosyalar (nedeniyle), uyarı olarak bildirilir. */
  skipped: string[];
  /**
   * Geçerli bir ürün id'si taşıyıp da okunamayan dosyaların id'leri. Bu ürünlerin
   * veritabanındaki satırına DOKUNULMAZ: iyi bir profil, yarım kaydedilmiş bir
   * dosya yüzünden boş bir taslakla ezilmesin (bkz. buildProductRows).
   */
  unreadableIds: string[];
}

/**
 * src/profile/*.json — şemadan geçen 'ready', geçmeyen 'draft'.
 *
 * Tek bir bozuk dosya senkronun TAMAMINI durdurmamalı: yarım kaydedilmiş bir
 * profil ya da ürün id'si olamayacak bir dosya adı (profile.example.json)
 * atlanır ve uyarı olarak bildirilir. Atlanan ürünün önceki satırı korunur
 * (`unreadableIds`) — geçici bir bozukluk iyi bir profili boş bir taslakla ezmez.
 */
export async function readProducts(profileDir: string): Promise<ProductRead> {
  const files = (await readdir(profileDir).catch(() => [] as string[])).filter((f) => f.endsWith('.json')).sort();
  const rows: ProductRow[] = [];
  const skipped: string[] = [];
  const unreadableIds: string[] = [];
  for (const file of files) {
    const id = file.slice(0, -'.json'.length);
    if (!isProductId(id)) {
      skipped.push(`${file}: not a product id`);
      continue;
    }
    let profile: unknown;
    try {
      profile = JSON.parse(await readFile(join(profileDir, file), 'utf8'));
    } catch (err) {
      skipped.push(`${file}: ${(err as Error).message.slice(0, 120)}`);
      unreadableIds.push(id);
      continue;
    }
    rows.push({ id, status: ProfileSchema.safeParse(profile).success ? 'ready' : 'draft', profile });
  }
  return { rows, skipped, unreadableIds };
}

export async function readProgress(dataDir: string): Promise<Map<string, TabProgress>> {
  const text = await readFile(join(dataDir, 'scan-logs', '_progress.log'), 'utf8').catch(() => '');
  return parseProgressLog(text);
}

export interface ListingRow {
  tab: string;
  site_id: string;
  row_number: number;
  sheet_status: string;
  website: string;
  name: string;
}

/**
 * Sheet'in bütün sekmelerindeki satırlar — tek toplu istekle.
 *
 * Sheet erişilemezse ya da okuma eksik/hatalıysa null döner: senkronun geri
 * kalanı Sheet'siz devam eder ve site listesine bu turda DOKUNULMAZ. Yarım
 * okunmuş listeyi tam saymak satırları kaybolmuş gibi gösterirdi.
 * Aynı sekmede aynı site iki kez geçiyorsa ilk satır alınır.
 */
export async function readListings(log: Logger): Promise<ListingRow[] | null> {
  // Başlık yüklemesi atlanır: o adım .env'deki SHEET_TAB sekmesine bakar ve
  // bayat bir sekme adı bütün listeyi okunamaz gösterirdi. Burada sekmelerin
  // hepsi adlarıyla birlikte toplu okunur.
  const client = await SheetClient.create(log, undefined, { loadHeaders: false });
  if (!client) return null;

  let byTab: Map<string, SheetRow[]>;
  try {
    byTab = await client.readAllTabs();
  } catch (err) {
    log.warn({ err: (err as Error).message }, 'Sheet toplu okunamadı — site listesi bu turda güncellenmeyecek');
    return null;
  }

  const rows: ListingRow[] = [];
  for (const [tab, sheetRows] of byTab) {
    const seen = new Set<string>();
    for (const r of sheetRows) {
      if (!r.siteId || seen.has(r.siteId)) continue;
      seen.add(r.siteId);
      rows.push({
        tab,
        site_id: r.siteId,
        row_number: r.rowNumber,
        sheet_status: r.status,
        website: r.website,
        name: r.name,
      });
    }
  }
  return rows;
}
