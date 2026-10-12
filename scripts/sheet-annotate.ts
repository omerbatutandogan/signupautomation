/**
 * Sheet'e "Otomasyon Durumu / Sorunu / Notu" kolonlarını yazar.
 *
 *   SHEET_TAB="SaaS" npx tsx scripts/sheet-annotate.ts [--dry-run]   # tek sekme
 *   npx tsx scripts/sheet-annotate.ts --all [--dry-run]              # tüm kaynak sekmeler
 *
 * Yalnızca bu üç kolona yazar (yoksa başlık satırının sağına ekler); mevcut
 * kolonlara (Durum, Not, ...) dokunmaz. Kaynaklar: config'ler, verify-drafts
 * sonucu, tarama dosyası, ledger (hesaplar, gerçek denemeler, listelemeler).
 * Sınıflar ve girdiler: src/discovery/annotate.ts, annotate-sources.ts.
 * --dry-run hiçbir şey yazmaz; yazım tekrar çalıştırılabilir (aynı girdi aynı çıktı).
 */

import { setTimeout as sleep } from 'node:timers/promises';
import pino from 'pino';
import { env } from '../src/config.js';
import { SheetClient } from '../src/integrations/sheet.js';
import { annotate, READY_TAB } from '../src/discovery/annotate.js';
import { defaultPaths, loadAnnotateSources, rowInputFor } from '../src/discovery/annotate-sources.js';

const HEADERS = ['Otomasyon Durumu', 'Otomasyon Sorunu', 'Otomasyon Notu'];
const dryRun = process.argv.includes('--dry-run');
const all = process.argv.includes('--all');

/** Bir sekmeyi etiketler; sekmede site adresi kolonu yoksa (özet sekmesi gibi) null döner. */
async function annotateTab(tab: string, log: pino.Logger): Promise<Map<string, number> | null> {
  env.SHEET_TAB = tab; // SheetClient.create sekmeyi env'den okur
  const sheet = await SheetClient.create(log);
  if (!sheet) throw new Error(`Sheet bağlanamadı: ${tab} (token süresi dolmuş olabilir: npm run gmail:auth)`);

  const rows = await sheet.readAll();
  if (rows.length === 0) return null;

  const sources = loadAnnotateSources(defaultPaths(tab));
  const counts = new Map<string, number>();
  const out = rows.map((row) => {
    const a = annotate(rowInputFor(row.siteId, sources));
    counts.set(a.durum, (counts.get(a.durum) ?? 0) + 1);
    return { rowNumber: row.rowNumber, values: [a.durum, a.sorun, a.not] };
  });

  const summary = [...counts].sort((x, y) => y[1] - x[1]).map(([k, n]) => `${n} ${k}`).join(' · ');
  if (dryRun) {
    console.log(`[${tab}] ${rows.length} satır (yazılmadı): ${summary}`);
    return counts;
  }
  const res = await sheet.writeAnnotations(HEADERS, out);
  console.log(`[${tab}] ${res.written} satır yazıldı${res.addedHeaders.length ? ` (yeni kolon: ${res.addedHeaders.join(', ')})` : ''}: ${summary}`);
  return counts;
}

async function main(): Promise<number> {
  const log = pino({ level: 'warn' });

  if (!all) {
    await annotateTab(env.SHEET_TAB, log);
    return 0;
  }

  const probe = await SheetClient.create(log);
  if (!probe) {
    console.error('Sheet bağlanamadı (token süresi dolmuş olabilir: npm run gmail:auth)');
    return 1;
  }
  const total = new Map<string, number>();
  let tabs = 0;
  for (const tab of await probe.tabNames()) {
    if (tab === READY_TAB) continue; // özet sekmesi: sheet-ready-tab.ts yazar
    const counts = await annotateTab(tab, log);
    if (counts) {
      tabs++;
      for (const [k, n] of counts) total.set(k, (total.get(k) ?? 0) + n);
    }
    await sleep(3000); // dakikalık okuma/yazma kotasına saygı
  }
  const rows = [...total.values()].reduce((a, b) => a + b, 0);
  console.log(`\nToplam: ${tabs} sekme, ${rows} satır${dryRun ? ' (yazılmadı)' : ''}`);
  for (const [k, n] of [...total].sort((x, y) => y[1] - x[1])) console.log(`  ${String(n).padStart(5)}  ${k}`);
  return 0;
}

main()
  .then((c) => process.exit(c))
  .catch((err: unknown) => {
    console.error('Hata:', err instanceof Error ? err.message : err);
    process.exit(1);
  });
