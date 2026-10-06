/**
 * Sheet'in bir sekmesine "Otomasyon Durumu / Sorunu / Notu" kolonlarını yazar.
 *
 *   SHEET_TAB="SaaS" npx tsx scripts/sheet-annotate.ts [--dry-run]
 *
 * Yalnızca bu üç kolona yazar (yoksa başlık satırının sağına ekler); mevcut
 * kolonlara (Durum, Not, ...) dokunmaz. Kaynaklar: config'ler, verify-drafts
 * sonucu, tarama dosyası, ledger (hesaplar). --dry-run hiçbir şey yazmaz.
 */

import { readFileSync, readdirSync } from 'node:fs';
import Database from 'better-sqlite3';
import pino from 'pino';
import { env } from '../src/config.js';
import { SheetClient } from '../src/integrations/sheet.js';
import { isUnverified } from '../src/discovery/generate-config.js';
import { awaitsMoveApproval } from '../src/core/markers.js';
import { annotate, type RowInput } from '../src/discovery/annotate.js';

const HEADERS = ['Otomasyon Durumu', 'Otomasyon Sorunu', 'Otomasyon Notu'];
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
  const sheet = await SheetClient.create(log);
  if (!sheet) {
    console.error('Sheet bağlanamadı (token süresi dolmuş olabilir: npm run gmail:auth)');
    return 1;
  }

  // Config durumları
  const configs = new Map<string, NonNullable<RowInput['config']>>();
  for (const file of readdirSync('src/sites').filter((f) => f.endsWith('.json'))) {
    const cfg = readJson<{ risk?: string; notes?: string }>(`src/sites/${file}`, {});
    configs.set(file.slice(0, -5), { risk: cfg.risk, unverified: isUnverified(cfg), awaitsMove: awaitsMoveApproval(cfg) });
  }
  const verification = readJson<Record<string, NonNullable<RowInput['verification']>>>('data/verify-drafts/progress.json', {});
  const discovery = readJson<{ entries?: Record<string, { outcome?: string }> }>(`data/discovery-${env.SHEET_TAB}.json`, {}).entries ?? {};

  // Gerçek hesabı olanlar: dry-run olmayan tamamlanmış deneme (varsayılan ürün: anahtar = siteId).
  const db = new Database('data/ledger.sqlite', { readonly: true, fileMustExist: true });
  const withAccount = new Set(
    (db.prepare("SELECT DISTINCT site_id FROM attempts WHERE status = 'completed' AND dry_run = 0 AND site_id NOT LIKE '%@%'").all() as Array<{ site_id: string }>).map((r) => r.site_id),
  );
  db.close();

  const rows = await sheet.readAll();
  const counts = new Map<string, number>();
  const out = rows.map((row) => {
    const a = annotate({
      hasAccount: withAccount.has(row.siteId),
      config: configs.get(row.siteId) ?? null,
      verification: verification[row.siteId] ?? null,
      discovery: discovery[row.siteId]?.outcome ?? null,
    });
    counts.set(a.durum, (counts.get(a.durum) ?? 0) + 1);
    return { rowNumber: row.rowNumber, values: [a.durum, a.sorun, a.not] };
  });

  const summary = [...counts].sort((x, y) => y[1] - x[1]).map(([k, n]) => `${n} ${k}`).join(' · ');
  if (dryRun) {
    console.log(`[${env.SHEET_TAB}] ${rows.length} satır (yazılmadı): ${summary}`);
    return 0;
  }
  const res = await sheet.writeAnnotations(HEADERS, out);
  console.log(`[${env.SHEET_TAB}] ${res.written} satır yazıldı${res.addedHeaders.length ? ` (yeni kolon: ${res.addedHeaders.join(', ')})` : ''}: ${summary}`);
  return 0;
}

main()
  .then((c) => process.exit(c))
  .catch((err: unknown) => {
    console.error('Hata:', err instanceof Error ? err.message : err);
    process.exit(1);
  });
