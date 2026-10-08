/**
 * Sheet'e tek bir "Hazır Siteler" sekmesi yazar: kayda hazır her site BİR satır.
 *
 *   npx tsx scripts/sheet-ready-tab.ts [--dry-run]
 *
 * "Hazır" = doğrulanmış (dry-run geçti) config, yüksek riskli ve taşınma onayı
 * bekleyen değil, açık hesabı yok, son gerçek denemesi kesin hatayla bitmemiş.
 * Kaynak sekmelere dokunmaz; yalnızca bu özet sekmesini baştan yazar.
 */

import { readFileSync, readdirSync } from 'node:fs';
import { setTimeout as sleep } from 'node:timers/promises';
import Database from 'better-sqlite3';
import pino from 'pino';
import { env } from '../src/config.js';
import { SheetClient } from '../src/integrations/sheet.js';
import { isUnverified } from '../src/discovery/generate-config.js';
import { awaitsMoveApproval } from '../src/core/markers.js';
import { READY_HEADER, READY_TAB, readyTable, type Listing, type ReadySite } from '../src/discovery/annotate.js';

const dryRun = process.argv.includes('--dry-run');

function readJson<T>(path: string, fallback: T): T {
  try {
    return JSON.parse(readFileSync(path, 'utf8')) as T;
  } catch {
    return fallback;
  }
}

async function main(): Promise<number> {
  const log = pino({ level: 'warn' });

  // Ledger: hesabı açık ve takılı (terminal hatalı) siteler hazır sayılmaz.
  const db = new Database('data/ledger.sqlite', { readonly: true, fileMustExist: true });
  const rows = (sql: string) => (db.prepare(sql).all() as Array<{ site_id: string }>).map((r) => r.site_id);
  const withAccount = new Set(rows("SELECT DISTINCT site_id FROM attempts WHERE status = 'completed' AND dry_run = 0 AND site_id NOT LIKE '%@%'"));
  const blocked = new Set(rows("SELECT DISTINCT site_id FROM attempts WHERE terminal = 1 AND dry_run = 0 AND site_id NOT LIKE '%@%'"));
  db.close();

  const verification = readJson<Record<string, { captcha?: string }>>('data/verify-drafts/progress.json', {});
  const ready: ReadySite[] = [];
  for (const file of readdirSync('src/sites').filter((f) => f.endsWith('.json'))) {
    const siteId = file.slice(0, -5);
    const cfg = readJson<{ risk?: string; notes?: string; signupUrl?: string }>(`src/sites/${file}`, {});
    if (cfg.risk === 'high' || awaitsMoveApproval(cfg) || isUnverified(cfg)) continue;
    if (withAccount.has(siteId) || blocked.has(siteId)) continue;
    ready.push({ siteId, signupUrl: cfg.signupUrl ?? '', captcha: verification[siteId]?.captcha ?? '' });
  }

  // Sheet: her sekmedeki satırlar (siteId → sekme + satır no).
  const probe = await SheetClient.create(log);
  if (!probe) {
    console.error('Sheet bağlanamadı (token süresi dolmuş olabilir: npm run gmail:auth)');
    return 1;
  }
  const listings: Listing[] = [];
  for (const tab of await probe.tabNames()) {
    if (tab === READY_TAB) continue;
    env.SHEET_TAB = tab; // create() sekmeyi env'den okur
    const client = await SheetClient.create(log);
    if (!client) throw new Error(`Sekme okunamadı: ${tab}`);
    for (const r of await client.readAll()) listings.push({ tab, rowNumber: r.rowNumber, siteId: r.siteId, website: r.website });
    await sleep(1500); // dakikalık okuma kotasına saygı
  }

  const table = readyTable(ready, listings);
  console.log(`Hazır: ${ready.length} config → Sheet'te karşılığı olan ${table.length} site; sekme: "${READY_TAB}"`);
  if (dryRun) return 0;

  const res = await probe.writeTable(READY_TAB, READY_HEADER, table);
  console.log(`${res.created ? 'Sekme oluşturuldu' : 'Sekme güncellendi'}: ${table.length} satır.`);
  return 0;
}

main()
  .then((c) => process.exit(c))
  .catch((err: unknown) => {
    console.error('Hata:', err instanceof Error ? err.message : err);
    process.exit(1);
  });
