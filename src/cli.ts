/**
 * Komut satırı arayüzü.
 *
 * Faz 1 kapsamı: tek site çalıştırma + ledger inceleme. Toplu çalıştırma,
 * cron ve Sheet entegrasyonu Faz 2'de.
 */

import pino from 'pino';
import { chromium } from 'playwright';
import { env } from './config.js';
import { runSite } from './core/runner.js';
import { Ledger } from './integrations/ledger.js';
import { listSiteIds, loadSiteConfig } from './adapters/registry.js';
import { derivePasswordForSite } from './identity/password.js';
import { createGmailClient, verifyGmailAccess } from './integrations/gmail.js';
import { siteIdFromWebsite } from './integrations/sheet.js';
import { findSignupPage, originOf } from './discovery/find-signup.js';
import { batchProgress } from './core/batch-progress.js';
import { analyzeForm } from './discovery/analyze-form.js';
import { generateConfig } from './discovery/generate-config.js';
import { makeGenericAdapter } from './adapters/generic.js';
import { parseArgs } from './cli-args.js';
import { accountKey, assertProductId, DEFAULT_PRODUCT } from './identity/account.js';
import { listProducts, loadProfile } from './identity/profile.js';
import { mkdir, writeFile } from 'node:fs/promises';

const logger = pino({
  level: env.LOG_LEVEL,
  // Şifreler asla loglara sızmamalı.
  redact: {
    paths: ['*.password', 'identity.password', 'password', 'MASTER_SECRET'],
    censor: '[gizli]',
  },
  transport: {
    target: 'pino-pretty',
    options: { colorize: true, translateTime: 'HH:MM:ss', ignore: 'pid,hostname' },
  },
});

function usage(): void {
  console.log(`
Kullanım: npm run cli -- <komut> [argümanlar] [--product <ürünId>]

--product: hangi ürün adına işlem yapılacağı (src/profile/<ürünId>.json).
           Verilmezse varsayılan ürün. run-one, signup, password, unlock kabul eder.

Komutlar:
  run-one <siteId>        Tek siteyi uçtan uca işle
    --dry-run             Selector'ları doğrula, submit etme
    --force               Terminal durumu aşıp tekrar dene
  products                Ürün profillerini doğrulayıp listele
  signup <website>        Config dosyası OLMADAN kayıt dener
    (varsayılan --dry-run; --live ile gerçek kayıt)
    --live                Gerçek kayıt yap (varsayılan dry-run)
    --save                Başarılıysa config'i src/sites/'a kaydet
  run-batch [N]           Sheet'ten N siteyi sırayla işle (varsayılan 5)
    --dry-run             Submit etme, selector doğrula
    --no-wait             Siteler arası beklemeyi atla (test için)
    --include-unverified  Doğrulanmamış taslakları da çalıştır (riskli)
  status                  Son denemeler ve ledger özeti
  list                    Tanımlı site config'lerini listele
  unlock <siteId>         Takılı kilidi temizle
  password <siteId>       Türetilmiş şifreyi yazdır
  check-gmail             Gmail bağlantısını doğrula
  sheet                   Sheet bağlantısını ve kolonları kontrol et
    --add-columns         Eksik takip kolonlarını Sheet'e ekle
`);
}

/**
 * Config'in "doğrulanmadı" damgasını kaldırır.
 * Başarılı --dry-run, selector'ların gerçek sayfada bulunduğunu kanıtlar.
 */
async function markVerified(siteId: string): Promise<void> {
  const { readFile, writeFile } = await import('node:fs/promises');
  const { isUnverified, clearUnverifiedMarker, MOVE_MARKER } = await import(
    './discovery/generate-config.js'
  );

  const path = `src/sites/${siteId}.json`;
  try {
    const cfg = JSON.parse(await readFile(path, 'utf8')) as { notes?: string };
    if (!isUnverified(cfg)) return;

    cfg.notes = clearUnverifiedMarker(cfg.notes);
    // Atomik: yazarken öldürülürse config yarım kalıp sessizce kaybolmasın.
    await writeFile(`${path}.tmp`, `${JSON.stringify(cfg, null, 2)}\n`);
    await (await import('node:fs/promises')).rename(`${path}.tmp`, path);
    if (isUnverified(cfg)) {
      console.log(
        `   ⚠️  Dry-run geçti ama site taşınmış — doğru siteyse notlardaki "${MOVE_MARKER}" damgasını elle sil`,
      );
    } else {
      console.log(`   ✓ Config doğrulandı — run-batch artık işleyebilir`);
    }
  } catch {
    // Config okunamadıysa sessizce geç — asıl iş zaten başarılı oldu.
  }
}

async function cmdRunOne(siteId: string, flags: Set<string>, productId: string): Promise<number> {
  const ledger = new Ledger();
  try {
    const outcome = await runSite(siteId, {
      log: logger,
      ledger,
      dryRun: flags.has('--dry-run'),
      force: flags.has('--force'),
      productId,
    });

    const icon =
      outcome.status === 'completed' ? '✅' : outcome.status.startsWith('skipped') ? '⏭️' : '❌';

    console.log(`\n${icon} ${accountKey(productId, siteId)}: ${outcome.status}`);
    if (outcome.note) console.log(`   ${outcome.note}`);
    if (outcome.artifactsDir) console.log(`   artifacts: ${outcome.artifactsDir}`);

    // Başarılı dry-run = selector'lar gerçek sayfada bulundu. Damgayı
    // kaldır ki run-batch bu config'i artık atlamasın.
    if (flags.has('--dry-run') && outcome.status === 'completed') {
      await markVerified(siteId);
    }

    return outcome.status === 'completed' || outcome.status.startsWith('skipped') ? 0 : 1;
  } finally {
    ledger.close();
  }
}

/**
 * Config dosyası OLMADAN tek geçişte kayıt dener.
 *
 * Akış: keşif (findSignupPage) → form analizi (analyzeForm, genişletilmiş
 * sezgisel kurallarla) → geçici config üretimi (bellekte, dosyaya
 * yazılmadan) → runSite (opts.adapter ile, src/sites/ okumadan).
 *
 * Varsayılan --dry-run: gerçek siteye iz bırakmadan (yarım hesap, spam
 * bildirimi) selector'ları doğrular. Gerçek kayıt için --live gerekir.
 * Otomatik çözüm başarısız olursa (tanınmayan bir desen, kritik alan
 * boş) komut KOD YAZMAZ — 'manual' ile durur ve artifact bırakır. Bu
 * sistemin dürüst sınırı: kural tükendiğinde sessizce yanlış davranmak
 * yerine açıkça durmak.
 */
async function cmdSignup(website: string, flags: Set<string>, productId: string): Promise<number> {
  const siteId = siteIdFromWebsite(website);
  if (!siteId) {
    console.error(`Geçersiz URL, siteId türetilemedi: ${website}`);
    return 1;
  }

  const dryRun = !flags.has('--live');
  console.log(`\n🔎 ${website} keşfediliyor (siteId: ${siteId}, ${dryRun ? 'dry-run' : 'GERÇEK ÇALIŞTIRMA'})...`);

  // 1. Keşif — ayrı, geçici bir tarayıcıda. runSite kendi context'ini
  // açacak; ikisini karıştırmak (aynı persistent profile) durumu
  // karmaşıklaştırır.
  const discoveryBrowser = await chromium.launch({
    headless: true,
    args: ['--disable-blink-features=AutomationControlled'],
  });

  let siteConfig: Awaited<ReturnType<typeof generateConfig>>['config'];
  try {
    const page = await discoveryBrowser.newPage();
    try {
      const search = await findSignupPage(page, website);

      if (search.kind === 'bot_protected') {
        console.error(`🛡️  Bot koruması tespit edildi — otomasyon denenmeyecek: ${website}`);
        return 1;
      }
      if (search.kind === 'not_found') {
        const why =
          search.reason ?? (search.hints?.length ? `görülen akış: ${search.hints.join(', ')}` : '');
        console.error(`❌ Kayıt sayfası bulunamadı: ${website}${why ? ` (${why})` : ''}`);
        return 1;
      }

      const analysis = await analyzeForm(page);
      const { config, warnings } = generateConfig({
        id: siteId,
        name: siteId,
        website,
        candidate: search.candidate,
        analysis,
      });

      const blocking = warnings.filter((w) => w.startsWith('KULLANILAMAZ'));
      if (blocking.length > 0) {
        console.error(`❌ Kullanılamaz form: ${blocking.join(' | ')}`);
        return 1;
      }

      if (config.risk === 'high') {
        console.error(`⛔ ToS otomatik kaydı yasaklıyor — manuel listeye: ${website}`);
        return 1;
      }

      // Taşınma sanılan yer ölü domainin satış pazarı olabilir: gerçek
      // kayıt, yeni adres açıkça verilerek yapılmalı.
      const moved = search.candidate.movedFrom;
      if (moved && !dryRun) {
        console.error(
          `⛔ ${moved} başka siteye yönleniyor (${originOf(search.candidate.url)}). Doğru siteyse yeni adresle çalıştır: signup ${originOf(search.candidate.url)} --live`,
        );
        return 1;
      }

      siteConfig = config;
      console.log(`✅ Kayıt sayfası bulundu: ${search.candidate.url}`);
      if (warnings.length > 0) {
        for (const w of warnings) console.log(`   ⚠️  ${w}`);
      }
    } finally {
      await page.close().catch(() => undefined);
    }
  } finally {
    await discoveryBrowser.close();
  }

  // 2. Gerçek çalıştırma (ya da dry-run) — config dosyaya YAZILMADAN
  // runSite'a doğrudan adapter olarak geçiriliyor.
  const adapter = makeGenericAdapter(siteConfig);
  const ledger = new Ledger();
  try {
    const outcome = await runSite(siteId, {
      log: logger,
      ledger,
      dryRun,
      force: true, // geçici çalıştırma, terminal durum kontrolü anlamsız
      adapter,
      siteConfig,
      productId,
    });

    const icon =
      outcome.status === 'completed' ? '✅' : outcome.status === 'manual' ? '🙋' : '❌';
    console.log(`\n${icon} ${siteId}: ${outcome.status}`);
    if (outcome.note) console.log(`   ${outcome.note}`);
    if (outcome.artifactsDir) console.log(`   artifacts: ${outcome.artifactsDir}`);

    if (flags.has('--save')) {
      await mkdir('src/sites', { recursive: true });
      await writeFile(`src/sites/${siteId}.json`, `${JSON.stringify(siteConfig, null, 2)}\n`);
      console.log(`   💾 Config kaydedildi: src/sites/${siteId}.json (DOĞRULANMADI damgalı)`);
    }

    return outcome.status === 'completed' ? 0 : 1;
  } finally {
    ledger.close();
  }
}

function cmdStatus(): number {
  const ledger = new Ledger();
  try {
    const attempts = ledger.recentAttempts(15);
    if (attempts.length === 0) {
      console.log('Henüz hiç deneme yok.');
      return 0;
    }

    console.log(`\nBugün: ${ledger.countToday()}/${env.DAILY_LIMIT} deneme\n`);
    console.log('Son denemeler:');
    for (const a of attempts) {
      const when = new Date(a.started_at).toLocaleString('tr-TR');
      const dur = a.finished_at ? `${Math.round((a.finished_at - a.started_at) / 1000)}s` : '—';
      console.log(`  ${when}  ${a.site_id.padEnd(18)} ${a.status.padEnd(18)} ${dur}`);
      if (a.note) console.log(`    ↳ ${a.note.slice(0, 100)}`);
    }
    return 0;
  } finally {
    ledger.close();
  }
}

async function cmdList(): Promise<number> {
  const ids = await listSiteIds();
  if (ids.length === 0) {
    console.log('src/sites/ altında config yok.');
    return 0;
  }
  console.log('\nTanımlı siteler:\n');
  for (const id of ids) {
    try {
      const cfg = await loadSiteConfig(id);
      const risk = cfg.risk === 'high' ? '⛔ high' : cfg.risk;
      console.log(`  ${id.padEnd(20)} ${String(risk).padEnd(10)} ${cfg.verification.mode}`);
    } catch (err) {
      console.log(`  ${id.padEnd(20)} ❌ ${(err as Error).message.split('\n')[0]}`);
    }
  }
  return 0;
}

function cmdUnlock(siteId: string): number {
  const ledger = new Ledger();
  try {
    const lock = ledger.activeLock(siteId);
    if (!lock) {
      console.log(`${siteId}: kilit yok.`);
      return 0;
    }
    ledger.release(siteId);
    console.log(`${siteId}: kilit temizlendi (sahibi: ${lock.run_id}).`);
    return 0;
  } finally {
    ledger.close();
  }
}

/**
 * Ürün profillerini doğrulayarak listeler. Emre'den gelen ürün bilgileri
 * profile dönüştürülünce eksik/hatalı alan burada görünür — kayıt
 * sırasında 200 siteye yayılmadan önce.
 */
async function cmdProducts(): Promise<number> {
  const ids = await listProducts();
  if (ids.length === 0) {
    console.log('src/profile/ altında ürün profili yok.');
    return 1;
  }
  let bad = 0;
  console.log('\nÜrünler:\n');
  for (const id of ids) {
    try {
      const p = await loadProfile(id);
      const mark = id === DEFAULT_PRODUCT ? ' (varsayılan)' : '';
      console.log(`  ✅ ${id.padEnd(20)} ${p.companyName.padEnd(20)} ${p.signupEmail ?? `${env.SIGNUP_EMAIL} (ortak)`}${mark}`);
    } catch (err) {
      bad++;
      console.log(`  ❌ ${id.padEnd(20)} ${(err as Error).message}`);
    }
  }
  return bad > 0 ? 1 : 0;
}

async function cmdPassword(siteId: string, productId: string): Promise<number> {
  const cfg = await loadSiteConfig(siteId).catch(() => null);
  // runner ile AYNI türetme: hesap anahtarı + site politikası.
  const pw = derivePasswordForSite(env.MASTER_SECRET, {
    id: accountKey(productId, siteId),
    passwordPolicy: cfg?.passwordPolicy,
  });
  // Yalnızca stdout — loglara girmiyor.
  console.log(pw);
  return 0;
}

/** [min, max] dakika arası bekleme — insan-benzeri aralık. */
function sleepMinutes(min: number, max: number): Promise<void> {
  const ms = (Math.random() * (max - min) + min) * 60_000;
  logger.info(`Sonraki siteye ${Math.round(ms / 60_000)} dakika sonra geçilecek`);
  return new Promise((r) => setTimeout(r, ms));
}

async function cmdRunBatch(flags: Set<string>, positional: string[]): Promise<number> {
  const { SheetClient } = await import('./integrations/sheet.js');
  const { loadSiteConfig } = await import('./adapters/registry.js');

  const limitArg = positional.find((a) => /^\d+$/.test(a));
  const limit = limitArg ? Number(limitArg) : 5;
  const dryRun = flags.has('--dry-run');
  const noWait = flags.has('--no-wait');

  const sheet = await SheetClient.create(logger);
  if (!sheet) {
    console.error('❌ Sheet bağlanamadı — run-batch Sheet gerektiriyor.');
    console.error('   Tek site için: run-one <siteId>');
    return 1;
  }

  const pending = await sheet.readPending();
  console.log(`\nSheet'te işlenmeye uygun: ${pending.length} satır`);

  // Yalnızca config'i yazılmış siteler işlenebilir.
  const { isUnverified, awaitsMoveApproval } = await import('./discovery/generate-config.js');
  const includeUnverified = flags.has('--include-unverified');
  const runnable: typeof pending = [];
  let skippedUnverified = 0;

  for (const row of pending) {
    if (runnable.length >= limit) break;
    const cfg = await loadSiteConfig(row.siteId).catch(() => null);
    if (!cfg) continue;

    // Otomatik üretilmiş ama --dry-run ile doğrulanmamış config'ler
    // atlanır: yanlış selector'la gerçek kayıt denemek, yanlış forma
    // veri göndermek demek.
    // Taşınmış site bayraktan bağımsız atlanır: hata burada yanlış
    // selector değil, yanlış SİTEYE kayıt.
    if (awaitsMoveApproval(cfg)) {
      skippedUnverified++;
      continue;
    }
    if (isUnverified(cfg) && !includeUnverified) {
      skippedUnverified++;
      continue;
    }
    runnable.push(row);
  }

  if (skippedUnverified > 0) {
    console.log(`Doğrulanmamış taslak atlandı: ${skippedUnverified}`);
    console.log(`   Doğrulamak için: run-one <siteId> --dry-run`);
    console.log(`   Yine de çalıştırmak için: --include-unverified`);
  }

  if (runnable.length === 0) {
    console.log('\nConfig\'i yazılmış işlenebilir site yok.');
    console.log('Yeni config için: npm run inspect -- <url>');
    return 0;
  }

  console.log(`Config'i olan ve işlenecek: ${runnable.length}\n`);

  const ledger = new Ledger();
  let completed = 0;
  let failed = 0;
  let todayTotal = 0;

  try {
    for (const [i, row] of runnable.entries()) {
      if (ledger.countToday() >= env.DAILY_LIMIT) {
        console.log(`\n⏸️  Günlük limit doldu (${env.DAILY_LIMIT}) — durduruluyor.`);
        break;
      }

      console.log(`\n[${i + 1}/${runnable.length}] ${row.siteId} (${row.website})`);

      const outcome = await runSite(row.siteId, {
        log: logger,
        ledger,
        dryRun,
        onProgress: batchProgress({ dryRun, sheet, ledger, row }),
      });

      const icon =
        outcome.status === 'completed' ? '✅' : outcome.status.startsWith('skipped') ? '⏭️' : '❌';
      console.log(`${icon} ${row.siteId}: ${outcome.status}${outcome.note ? ` — ${outcome.note}` : ''}`);

      if (outcome.status === 'completed') completed++;
      else if (!outcome.status.startsWith('skipped')) failed++;

      // Son siteden sonra beklemeye gerek yok.
      const isLast = i === runnable.length - 1;
      if (!isLast && !noWait && !dryRun) {
        await sleepMinutes(env.MIN_GAP_MINUTES, env.MAX_GAP_MINUTES);
      }
    }
    todayTotal = ledger.countToday();
  } finally {
    ledger.close();
  }

  console.log(`\n── Özet ──`);
  console.log(`   Tamamlanan: ${completed}`);
  console.log(`   Başarısız:  ${failed}`);
  console.log(`   Bugün toplam: ${todayTotal}/${env.DAILY_LIMIT}`);

  return failed > 0 ? 1 : 0;
}

async function cmdSheet(flags: Set<string>): Promise<number> {
  const { SheetClient, COLUMNS } = await import('./integrations/sheet.js');
  const client = await SheetClient.create(logger);

  if (!client) {
    console.log('❌ Sheet bağlanamadı.');
    console.log('   SHEET_ID .env\'de tanımlı mı?');
    console.log('   OAuth token Sheets yetkisi içeriyor mu? → npm run gmail:auth');
    return 1;
  }

  const rows = await client.readAll();
  const pending = await client.readPending();
  const missing = client.missingColumns();

  console.log(`\n✅ Sheet bağlı — ${rows.length} satır okundu\n`);
  console.log(`   İşlenmeye uygun: ${pending.length}`);

  if (missing.length > 0) {
    if (flags.has('--add-columns')) {
      const added = await client.ensureColumns();
      console.log(`\n✅ ${added.length} kolon eklendi: ${added.join(', ')}`);
    } else {
      console.log(`\n⚠️  Eksik kolonlar (kod bunlara yazamaz):`);
      for (const c of missing) console.log(`     ${c}`);
      console.log(`\n   Otomatik eklemek için: run cli -- sheet --add-columns`);
      console.log(`   Zorunlu olanlar: ${COLUMNS.status}, ${COLUMNS.note}`);
    }
  }

  console.log('\nİlk 10 satır:');
  for (const r of rows.slice(0, 10)) {
    const status = r.status || '(boş)';
    console.log(`  ${r.siteId.padEnd(20)} ${r.website.padEnd(32)} ${status}`);
  }

  return 0;
}

async function cmdCheckGmail(): Promise<number> {
  try {
    const client = await createGmailClient();
    const address = await verifyGmailAccess(client);
    console.log(`✅ Gmail bağlı: ${address}`);
    if (address !== env.SIGNUP_EMAIL) {
      console.log(`⚠️  .env'deki SIGNUP_EMAIL (${env.SIGNUP_EMAIL}) ile farklı!`);
      return 1;
    }
    return 0;
  } catch (err) {
    console.error(`❌ ${(err as Error).message}`);
    return 1;
  }
}

async function main(): Promise<void> {
  const { command, positional, flags, options } = parseArgs(process.argv.slice(2));
  const productId = options.get('--product') ?? DEFAULT_PRODUCT;
  assertProductId(productId);

  let code = 0;

  switch (command) {
    case 'run-one': {
      const siteId = positional[0];
      if (!siteId) {
        console.error('Site id gerekli: npm run cli -- run-one <siteId>');
        code = 1;
        break;
      }
      code = await cmdRunOne(siteId, flags, productId);
      break;
    }
    case 'signup': {
      const website = positional[0];
      if (!website) {
        console.error('Website gerekli: npm run cli -- signup <website>');
        code = 1;
        break;
      }
      code = await cmdSignup(website, flags, productId);
      break;
    }
    case 'products':
      code = await cmdProducts();
      break;
    case 'status':
      code = cmdStatus();
      break;
    case 'list':
      code = await cmdList();
      break;
    case 'unlock': {
      const siteId = positional[0];
      if (!siteId) {
        console.error('Site id gerekli.');
        code = 1;
        break;
      }
      code = cmdUnlock(accountKey(productId, siteId));
      break;
    }
    case 'password': {
      const siteId = positional[0];
      if (!siteId) {
        console.error('Site id gerekli.');
        code = 1;
        break;
      }
      code = await cmdPassword(siteId, productId);
      break;
    }
    case 'check-gmail':
      code = await cmdCheckGmail();
      break;
    case 'sheet':
      code = await cmdSheet(flags);
      break;
    case 'run-batch':
      // Sheet satırları site başına, ürün başına değil: başka bir ürünün
      // sonucu varsayılan ürünün satırının üzerine yazılırdı. Sheet ürün
      // bazlı olana kadar toplu çalıştırma yalnızca varsayılan ürün için.
      if (productId !== DEFAULT_PRODUCT) {
        console.error(
          `run-batch şimdilik yalnızca varsayılan ürün (${DEFAULT_PRODUCT}) için — Sheet kolonları ürün bazlı değil.`,
        );
        console.error(`Tek site için: run-one <siteId> --product ${productId}`);
        code = 1;
        break;
      }
      code = await cmdRunBatch(flags, positional);
      break;
    default:
      usage();
      code = command ? 1 : 0;
  }

  // process.exit() yerine exitCode: pino'nun async transport'u kendi
  // buffer'ını boşaltabilsin. Zorla kapatınca "_flushSync took too long"
  // uyarısı çıkıyor ve son log satırları kaybolabiliyor.
  process.exitCode = code;
}

main().catch((err: unknown) => {
  console.error('\n❌ Beklenmeyen hata:', err instanceof Error ? err.message : err);
  process.exit(1);
});
