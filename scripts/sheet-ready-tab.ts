/**
 * Sheet'e tek bir "Hazır Siteler" sekmesi yazar: kayda hazır her site BİR satır.
 *
 *   npx tsx scripts/sheet-ready-tab.ts [--dry-run]
 *
 * "Hazır" = Sheet etiketlemesinin "Hazır" dediği site (annotate.ts): doğrulanmış (dry-run geçti) config,
 * yüksek riskli ve taşınma onayı bekleyen değil, açık hesabı yok, son gerçek denemesi kesin hatayla
 * bitmemiş ve aynı kayıt motorunda doğrulanmış bir engel (ör. görsel captcha) yok. Tek tanım iki yerde
 * ayrışmasın diye burada ayrıca hesaplanmaz, aynı sınıflandırıcıdan okunur.
 * Kaynak sekmelere dokunmaz; yalnızca bu özet sekmesini baştan yazar.
 */

import { setTimeout as sleep } from 'node:timers/promises';
import pino from 'pino';
import { env } from '../src/config.js';
import { SheetClient } from '../src/integrations/sheet.js';
import { annotate, DURUM, READY_HEADER, READY_TAB, readyTable, type Listing, type ReadySite } from '../src/discovery/annotate.js';
import { defaultPaths, loadAnnotateSources, rowInputFor } from '../src/discovery/annotate-sources.js';

const dryRun = process.argv.includes('--dry-run');

async function main(): Promise<number> {
  const log = pino({ level: 'warn' });

  // Hazır siteler: etiketleme sınıflandırıcısının "Hazır" dediği her config. (Tarama dosyası sekmeye özeldir ve
  // config'i olan site için belirleyici değildir; bu yüzden sekmeden bağımsız kaynaklar yeterlidir.)
  const sources = loadAnnotateSources(defaultPaths(''));
  const ready: ReadySite[] = [];
  for (const [siteId, cfg] of sources.configs) {
    if (annotate(rowInputFor(siteId, sources)).durum !== DURUM.READY) continue;
    ready.push({ siteId, signupUrl: cfg.signupUrl, captcha: sources.verification[siteId]?.captcha ?? '' });
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
