/**
 * Yerel kaynakları (SQLite ledger, tarama dosyaları, config'ler, ürün
 * profilleri, Sheet) panelin veritabanına yansıtır. Kaynakların içeriğini
 * ASLA değiştirmez (ayrıntı: src/sync/sources.ts).
 *
 * Kullanım:
 *   SUPABASE_URL=… SUPABASE_SECRET_KEY=… npx tsx scripts/sync-panel.ts \
 *     [--source <canlı proje dizini>] [--no-sheet] [--sheet-max-age <dk>]
 *     [--full] [--state <dosya>] [--backoff] [--allow-mass-delete] [--dry-run] [--verify]
 *
 *   --source            Kaynak dizin (varsayılan: çalışma dizini). Canlı sistem
 *                       başka dizindeyse (tarama orada çalışıyor) onu göster.
 *   --no-sheet          Sheet'i okuma (site listesi/satır numaraları güncellenmez).
 *   --sheet-max-age     Sheet en son bu kadar dakika içinde okunduysa bu turda
 *                       okuma (2 dakikada bir çalışan senkron kotayı yemesin).
 *   --full              Önbelleği yok say: her tabloyu veritabanından çekip kıyasla.
 *   --state             Önbellek dosyası (varsayılan: .panel-sync/state.json).
 *   --backoff           Zamanlanmış tur: üst üste başarısız oldukça seyrekleş (4, 8, … en
 *                       çok 60 dk). Kalıcı hata, tabloları her turda baştan çektirip
 *                       ücretsiz Supabase çıkış kotasını bitirmesin (src/sync/backoff.ts).
 *   --allow-mass-delete Bir tablonun büyük kısmını silmeyi gerektiren farka izin
 *                       ver (varsayılan: reddedilir — kaynak eksik okunmuş olabilir).
 *   --dry-run           Hiçbir şey yazma; ne değişeceğini say (önbelleksiz).
 *   --verify            Senkrondan sonra veritabanını kaynakla karşılaştır; fark
 *                       varsa çıkış kodu 1.
 *
 * Veritabanı kaynakların yansımasıdır: kaynakta artık olmayan satır (Sheet'ten
 * silinen site, silinen config dosyası) veritabanından da silinir. Değişmeyen
 * tablo veritabanından çekilmez (src/sync/state.ts): olağan turun maliyeti bir
 * okuma + bir kalp atışıdır.
 *
 * Her tur sonunda sync_status'a kalp atışı yazar (panel "veri ne kadar taze"
 * bilgisini oradan gösterir); hata ya da uyarı olursa onu da oraya yazar.
 *
 * Secret key (sb_secret_…) RLS'i aşar: yalnızca işçide durur, panele girmez.
 */

import { existsSync, readFileSync, rmSync } from 'node:fs';
import { hostname } from 'node:os';
import { resolve } from 'node:path';
import type { SupabaseClient } from '@supabase/supabase-js';
import { parse as parseDotenv } from 'dotenv';
import { clearFailure, loadFailure, minutesLeft, recordFailure, shouldBackOff } from '../src/sync/backoff.js';

const args = process.argv.slice(2);
const flag = (name: string) => args.includes(name);
const option = (name: string) => (args.includes(name) ? args[args.indexOf(name) + 1] : undefined);

const sourceDir = resolve(option('--source') ?? process.cwd());
const statePath = resolve(option('--state') ?? '.panel-sync/state.json');
const failurePath = `${statePath}.failure`;
const dryRun = flag('--dry-run');
/** Zamanlanmış tur (panel-sync-run.sh). Yalnızca bu turlar geri çekilme sayacına yazar/ondan etkilenir. */
const scheduled = flag('--backoff');

// Google token dosyaları kaynak dizinde durur (.auth/); config.ts yolları
// içe aktarılırken okuduğu için ortam değişkenleri ÖNCE ayarlanmalı.
for (const [key, file] of [
  ['GOOGLE_OAUTH_CLIENT_FILE', '.auth/gmail-client-secret.json'],
  ['GOOGLE_OAUTH_TOKEN_FILE', '.auth/gmail-token.json'],
] as const) {
  const path = resolve(sourceDir, file);
  if (!process.env[key] && existsSync(path)) process.env[key] = path;
}

/** İşçinin günlük limiti: kaynak dizinin .env'inden yalnızca bu anahtar alınır. */
function readDailyLimit(dir: string): number {
  const fallback = 12; // config.ts'teki varsayılanla aynı
  try {
    // dotenv ile aynı ayrıştırma: işçi "DAILY_LIMIT=20 # not" satırını 20 okur.
    const n = Number(parseDotenv(readFileSync(resolve(dir, '.env'))).DAILY_LIMIT);
    return Number.isInteger(n) && n > 0 ? n : fallback;
  } catch {
    return fallback;
  }
}

let heartbeatClient: SupabaseClient | null = null;

/** Kalp atışı yazılamazsa senkronun sonucu değişmez; yalnızca uyarı. Yazıldıysa true. */
async function heartbeat(fields: Record<string, unknown>): Promise<boolean> {
  if (!heartbeatClient) return false;
  const { error } = await heartbeatClient
    .from('sync_status')
    .upsert({ id: true, last_run_at: new Date().toISOString(), source_host: hostname(), ...fields }, { onConflict: 'id' });
  if (error) console.error(`  ⚠️  Kalp atışı yazılamadı: ${error.message}`);
  return !error;
}

async function main(): Promise<number> {
  const { createClient } = await import('@supabase/supabase-js');
  const { default: pino } = await import('pino');
  const { buildProductRows, buildScanProgress, deriveAccounts, toAttemptRow } = await import('../src/sync/mappers.js');
  const { readConfigs, readDiscoveries, readLedger, readListings, readProducts, readProgress, sourcePaths } =
    await import('../src/sync/sources.js');
  const { syncIfChanged, syncTable } = await import('../src/sync/push.js');
  const { canTrustState, hashRows, loadState, saveState } = await import('../src/sync/state.js');
  type SyncCounts = Awaited<ReturnType<typeof syncIfChanged>>;
  type SyncSpec = Parameters<typeof syncTable>[3];
  type SyncOpts = NonNullable<Parameters<typeof syncTable>[4]>;

  const url = process.env.SUPABASE_URL;
  const secretKey = process.env.SUPABASE_SECRET_KEY;
  if (!url || !secretKey) {
    console.error('SUPABASE_URL ve SUPABASE_SECRET_KEY gerekli (secret key yalnızca işçide durur).');
    return 2;
  }

  // Zamanlanmış tur, üst üste başarısızlıktan sonra seyrekleşir; elle çalıştırılan
  // senkron (--backoff yok) hiçbir zaman atlanmaz.
  const failure = scheduled && !dryRun ? loadFailure(failurePath) : null;
  if (failure && shouldBackOff(failure, new Date())) {
    console.log(
      `\nSon ${failure.count} tur üst üste başarısız oldu — geri çekiliyor, ${minutesLeft(failure, new Date())} dk sonra yeniden denenecek.`,
    );
    return 0;
  }

  const log = pino({ level: process.env.LOG_LEVEL ?? 'warn' });
  const client = createClient(url, secretKey, { auth: { persistSession: false, autoRefreshToken: false } });
  if (!dryRun) heartbeatClient = client;
  const paths = sourcePaths(sourceDir);

  const remote = await client.from('sync_status').select('last_ok_at, sheet_read_at').maybeSingle();
  if (remote.error) throw new Error(`sync_status okunamadı: ${remote.error.message}`);
  const remoteStatus = remote.data as { last_ok_at: string | null; sheet_read_at: string | null } | null;

  // Önbellek: değişmeyen tabloyu çekmemek için. Dry-run her zaman tam plan çıkarır.
  const loaded = loadState(statePath);
  const cached =
    !dryRun && !flag('--full') && canTrustState(loaded, url, remoteStatus?.last_ok_at ?? null, new Date()) ? loaded : null;
  const cache = { trusted: cached?.hashes ?? null, hashes: { ...cached?.hashes } };

  // Sheet yakın zamanda okunduysa bu turda atla.
  const maxAgeMin = Number(option('--sheet-max-age') ?? 0);
  const lastSheetRead = remoteStatus?.sheet_read_at ? Date.parse(remoteStatus.sheet_read_at) : NaN;
  const sheetFresh = maxAgeMin > 0 && !Number.isNaN(lastSheetRead) && Date.now() - lastSheetRead < maxAgeMin * 60_000;
  const skipSheet = flag('--no-sheet') || sheetFresh;

  // ── Oku ────────────────────────────────────────────────────────────────
  const ledger = readLedger(paths.ledger);
  const configs = await readConfigs(paths.sitesDir);
  const discoveries = await readDiscoveries(paths.dataDir);
  const productFiles = await readProducts(paths.profileDir);
  const progress = await readProgress(paths.dataDir);
  const listings = skipSheet ? null : await readListings(log);
  const sheetFailed = !listings && !skipSheet;

  // Tur başarılı sayılır ama panelin bilmesi gereken eksikler (kalp atışına yazılır).
  const warnings: string[] = [];
  if (sheetFailed) warnings.push('Sheet could not be read; site list not refreshed');
  if (productFiles.skipped.length > 0) warnings.push(`Product files skipped: ${productFiles.skipped.join('; ')}`);
  if (discoveries.dropped > 0) {
    warnings.push(`${discoveries.dropped} scan results have an outcome the sync does not know and were not mirrored`);
  }

  // ── Dönüştür ───────────────────────────────────────────────────────────
  const configModes = new Map(configs.flatMap((c) => (c.verification_mode ? [[c.site_id, c.verification_mode] as const] : [])));
  const accounts = deriveAccounts(ledger.attempts, ledger.credentials, configModes);
  const attempts = ledger.attempts.map(toAttemptRow);

  // Hesabı olan ama profil dosyası olmayan ürün taslak olarak açılır (FK); dosyası
  // okunamayan ürünün veritabanı satırına dokunulmaz.
  const products = buildProductRows(
    productFiles.rows,
    productFiles.unreadableIds,
    accounts.map((a) => a.product_id),
  );

  const totalByTab = listings ? new Map<string, number>() : null;
  for (const l of listings ?? []) totalByTab?.set(l.tab, (totalByTab.get(l.tab) ?? 0) + 1);
  const scanProgress = buildScanProgress({
    discoveries: discoveries.rows,
    skippedTabs: discoveries.skippedTabs,
    totalByTab,
    progress,
  });

  const siteById = new Map<string, { id: string; website: string; name: string }>();
  for (const l of listings ?? []) {
    if (!siteById.has(l.site_id)) siteById.set(l.site_id, { id: l.site_id, website: l.website, name: l.name });
  }

  // ── Yaz ────────────────────────────────────────────────────────────────
  // İlk yazımdan ÖNCE durum dosyası silinir ve ancak tur sonunda yeniden yazılır:
  // tur yarıda ölürse (zaman aşımı SIGALRM'ı, kill -9, elektrik) catch bloğu hiç
  // çalışmaz; dosya silinmeseydi yarım yazılmış tablo bir sonraki turda "güncel"
  // sanılırdı.
  if (!dryRun) rmSync(statePath, { force: true });

  const now = () => new Date().toISOString();
  const counts: SyncCounts[] = [];
  const allowMassDelete = flag('--allow-mass-delete');

  /** İstenen satırların özeti önbellektekiyle aynıysa tablo hiç çekilmez. */
  const sync = (key: string, table: string, desired: object[], spec: SyncSpec, opts: SyncOpts = {}) =>
    syncIfChanged(cache, key, table, desired.length, hashRows(desired), () =>
      syncTable(client, table, desired, spec, { ...opts, dryRun, allowMassDelete: opts.allowMassDelete ?? allowMassDelete }),
    );
  const run = async (c: Promise<SyncCounts>) => counts.push(await c);

  // SIRA: toplu silme korumasının reddedebileceği tablolar (config'ler, Sheet'ten
  // gelen siteler) EN SONA konur. Reddedilen bir tablo turu orada durdurur; öndeki
  // tablolar (deneme, hesap, tarama sonuçları) o sırada zaten güncellenmiş olur.
  // Yabancı anahtar sırası korunur: ürünler → hesaplar; siteler → sekme satırları.

  // Ürünler budanmaz: profil dosyası silinse de hesapları olan ürün kalır.
  await run(sync('products', 'products', products, { keyColumns: ['id'], compareColumns: ['status', 'profile'] }, { touch: () => ({ updated_at: now() }) }));

  // Tarama sonuçları sekme sekme: tarama sürerken yalnızca değişen sekme çekilir.
  // Yarım yazılmış dosyası olan sekme bu listede yoktur → o turda dokunulmaz.
  // Dilim dosyayı AYNEN yansıtır, koruma uygulanmaz: `discover --reset` dosyayı
  // bilerek küçültür; panel o sekmeyi taramanın gerçek durumuyla göstermeli.
  // DİKKAT: bu yüzden PANEL_SYNC_SOURCE yanlış bir dizini gösterirse (ör. eski bir kopya)
  // buradaki ve deneme/hesap tabloları o dizinin içeriğine çekilir; koruma yalnızca
  // sonda, config ve Sheet tablolarında devreye girer. Zarar geçicidir: bir sonraki
  // DOĞRU tur özetleri farklı bulup her şeyi yeniden yansıtır. Kaynak yolu tek
  // seferlik ayardır (.panel-sync/sync.env), turdan tura değişmez.

  const discoveriesByTab = new Map<string, typeof discoveries.rows>();
  for (const d of discoveries.rows) {
    const list = discoveriesByTab.get(d.tab);
    if (list) list.push(d);
    else discoveriesByTab.set(d.tab, [d]);
  }
  const discoveryTotal: SyncCounts = { table: 'site_discoveries', inserted: 0, updated: 0, unchanged: 0, deleted: 0, skipped: true };
  for (const [tab, rows] of [...discoveriesByTab].sort(([a], [b]) => a.localeCompare(b))) {
    const c = await sync(
      `site_discoveries:${tab}`,
      'site_discoveries',
      rows,
      {
        keyColumns: ['tab', 'site_id'],
        compareColumns: ['outcome', 'reason', 'signup_url', 'discovered_at'],
        timeColumns: ['discovered_at'],
      },
      { where: { tab }, prune: true, allowMassDelete: true },
    );
    discoveryTotal.inserted += c.inserted;
    discoveryTotal.updated += c.updated;
    discoveryTotal.unchanged += c.unchanged;
    discoveryTotal.deleted += c.deleted;
    if (!c.skipped) discoveryTotal.skipped = false;
  }
  counts.push(discoveryTotal);

  // Denemeler budanmaz: ledger yalnızca büyür; eksilen satır bir hatadır, silinmez.
  await run(
    sync('attempts', 'attempts', attempts, {
      keyColumns: ['legacy_sqlite_id'],
      compareColumns: ['account_key', 'product_id', 'site_id', 'run_id', 'status', 'dry_run', 'terminal', 'started_at', 'finished_at', 'note'],
      timeColumns: ['started_at', 'finished_at'],
    }),
  );
  // Hesaplar da budanmaz (denemeler gibi, yalnızca büyüyen ledger'dan türer): eski bir
  // ledger yedeği geri yüklenirse hesaplar sessizce silinip denemeleri bırakılmasın.
  // Tutarsızlık varsa `--verify` sayı farkını bildirir ve bir insan karar verir.
  await run(
    sync('accounts', 'accounts', accounts, {
      keyColumns: ['product_id', 'site_id'],
      compareColumns: ['email', 'username', 'pw_version', 'password_source', 'status', 'verification', 'profile_url', 'opened_at', 'note'],
      timeColumns: ['opened_at'],
    }),
  );
  await run(
    // Tek önbellek anahtarı: Sheet okunan/okunmayan turların satır biçimi farklı
    // (total_rows), dolayısıyla özet de farklı; anahtar her zaman SON yazılanı
    // gösterir ve iki ayrı anahtarın birbirinden habersiz kalması mümkün olmaz.
    sync('scan_progress', 'scan_progress', scanProgress, {
      keyColumns: ['tab'],
      compareColumns: [...(listings ? ['total_rows'] : []), 'scanned', 'started_at', 'finished_at'],
      timeColumns: ['started_at', 'finished_at'],
    }, { touch: () => ({ updated_at: now() }) }),
  );

  // Toplu silme korumasının reddedebileceği, budanan tablolar (en sonda).
  await run(
    sync('site_configs', 'site_configs', configs, {
      keyColumns: ['site_id'],
      // content_hash dosyanın tamamını kapsar; jsonb'yi ayrıca kıyaslamaya gerek yok.
      compareColumns: ['content_hash', 'state', 'risk', 'verification_mode', 'solve_captcha', 'signup_url', 'parse_error'],
    }, { touch: () => ({ synced_at: now() }), prune: true }),
  );
  if (listings) {
    await run(sync('sites', 'sites', [...siteById.values()], { keyColumns: ['id'], compareColumns: ['website', 'name'] }, { prune: true }));
    await run(
      sync(
        'site_listings',
        'site_listings',
        listings.map(({ tab, site_id, row_number, sheet_status }) => ({ tab, site_id, row_number, sheet_status })),
        { keyColumns: ['tab', 'site_id'], compareColumns: ['row_number', 'sheet_status'] },
        { touch: () => ({ imported_at: now() }), prune: true },
      ),
    );
  }

  // ── Rapor ──────────────────────────────────────────────────────────────
  console.log(`\nKaynak: ${sourceDir}${dryRun ? '  (DRY-RUN — yazılmadı)' : ''}`);
  for (const c of counts) {
    console.log(
      `  ${c.table.padEnd(18)} +${String(c.inserted).padStart(5)}  ~${String(c.updated).padStart(5)}  -${String(c.deleted).padStart(5)}  =${String(c.unchanged).padStart(5)}${c.skipped ? '  (kaynak değişmedi, çekilmedi)' : ''}`,
    );
  }
  if (discoveries.skippedTabs.length > 0) {
    console.log(`  ⚠️  Yarım yazılmış tarama dosyası, bu tur atlandı: ${discoveries.skippedTabs.join(', ')}`);
  }
  for (const w of warnings) console.log(`  ⚠️  ${w}`);
  const changed = counts.reduce((n, c) => n + c.inserted + c.updated + c.deleted, 0);
  console.log(`  Toplam değişen satır: ${changed}`);

  if (!dryRun) {
    const at = now();
    const beat = await heartbeat({
      last_run_at: at,
      last_ok_at: at,
      // Uyarılı tur yine başarılıdır ama panel bunu görmeli.
      last_error: warnings.length > 0 ? warnings.join(' | ').slice(0, 500) : null,
      changed_rows: changed,
      daily_limit: readDailyLimit(sourceDir),
      ...(listings ? { sheet_read_at: at } : {}),
    });
    if (beat) {
      saveState(statePath, { url, lastOkAt: at, lastFullAt: cached ? cached.lastFullAt : at, hashes: cache.hashes });
      clearFailure(failurePath);
      console.log(`  ${cached ? 'Önbellekli tur' : 'Tam senkron'} (${statePath})`);
    } else {
      // Bu turun yazdıkları önbelleğe işlenmedi; eski önbellek ise artık eksik.
      // Silinir: sonraki tur her tabloyu çekip kıyaslar. Bu da başarısızlıktır
      // (kalıcıysa her tur tam senkron olur): geri çekilme sayacına işlenir.
      rmSync(statePath, { force: true });
      if (scheduled) recordFailure(failurePath, new Date());
      console.log('  Kalp atışı yazılamadı — önbellek silindi, sonraki tur tam senkron.');
    }
  }

  if (!flag('--verify')) return 0;

  // ── Doğrula: veritabanı kaynakla aynı mı? ──────────────────────────────
  const count = async (table: string, tab?: string) => {
    let q = client.from(table).select('*', { count: 'exact', head: true });
    if (tab !== undefined) q = q.eq('tab', tab);
    const { count: n, error } = await q;
    if (error) throw new Error(`${table} sayılamadı: ${error.message}`);
    // HEAD isteğinde bulunamayan tablo hata değil, boş sayı döndürür.
    if (n === null) throw new Error(`${table} sayılamadı: sayı gelmedi`);
    return n;
  };
  const problems: string[] = [];
  const expectEq = (label: string, actual: number, expected: number) => {
    if (actual !== expected) problems.push(`${label}: veritabanı ${actual}, kaynak ${expected}`);
  };

  expectEq('attempts', await count('attempts'), attempts.length);
  expectEq('accounts', await count('accounts'), accounts.length);
  expectEq('site_configs', await count('site_configs'), configs.length);
  if (listings) {
    expectEq('site_listings', await count('site_listings'), listings.length);
    expectEq('sites', await count('sites'), siteById.size);
  }
  for (const [tab, rows] of discoveriesByTab) {
    expectEq(`site_discoveries[${tab}]`, await count('site_discoveries', tab), rows.length);
  }

  if (problems.length > 0) {
    console.log('\n❌ Doğrulama farkları:');
    for (const p of problems) console.log(`   ${p}`);
    return 1;
  }
  console.log('\n✅ Doğrulama: veritabanı kaynakla aynı.');
  return 0;
}

main()
  .then((code) => process.exit(code))
  .catch(async (err: unknown) => {
    const message = err instanceof Error ? err.message : String(err);
    console.error('\n❌ Senkron hatası:', message);
    // Durum dosyasına BURADA dokunulmaz: ilk yazımdan önce zaten silinmişti (yazım
    // başladıysa önbellek güvenilmezdir), yazımdan önce başarısız olan tur ise (ağ
    // yok, kaynak okunamadı) hiçbir şey yazmadı ve önbellek hâlâ doğrudur — silmek
    // sonraki turu ~1,5 MB'lık gereksiz tam çekime mahkûm ederdi.
    // Üst üste başarısızlık sayılır: zamanlanmış turlar seyrekleşir (--backoff).
    if (!dryRun && scheduled) {
      try {
        // Elle çalıştırılan senkronun hatası, sağlıklı zamanlanmış turu seyrekleştirmesin.
        recordFailure(failurePath, new Date());
      } catch (stateErr) {
        console.error('  ⚠️  Başarısızlık kaydı yazılamadı:', stateErr instanceof Error ? stateErr.message : stateErr);
      }
    }
    await heartbeat({ last_error: message.slice(0, 500) }).catch(() => undefined);
    process.exit(1);
  });
