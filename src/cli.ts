/**
 * Komut satırı arayüzü.
 *
 * Faz 1 kapsamı: tek site çalıştırma + ledger inceleme. Toplu çalıştırma,
 * cron ve Sheet entegrasyonu Faz 2'de.
 */

import pino from 'pino';
import { env } from './config.js';
import { runSite } from './core/runner.js';
import { Ledger } from './integrations/ledger.js';
import { listSiteIds, loadSiteConfig } from './adapters/registry.js';
import { derivePasswordForSite } from './identity/password.js';
import { createGmailClient, verifyGmailAccess } from './integrations/gmail.js';

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
Kullanım: npm run cli -- <komut> [argümanlar]

Komutlar:
  run-one <siteId>        Tek siteyi uçtan uca işle
    --dry-run             Selector'ları doğrula, submit etme
    --force               Terminal durumu aşıp tekrar dene
  run-batch [N]           Sheet'ten N siteyi sırayla işle (varsayılan 5)
    --dry-run             Submit etme, selector doğrula
    --no-wait             Siteler arası beklemeyi atla (test için)
  status                  Son denemeler ve ledger özeti
  list                    Tanımlı site config'lerini listele
  unlock <siteId>         Takılı kilidi temizle
  password <siteId>       Türetilmiş şifreyi yazdır
  check-gmail             Gmail bağlantısını doğrula
  sheet                   Sheet bağlantısını ve kolonları kontrol et
    --add-columns         Eksik takip kolonlarını Sheet'e ekle
`);
}

async function cmdRunOne(siteId: string, flags: Set<string>): Promise<number> {
  const ledger = new Ledger();
  try {
    const outcome = await runSite(siteId, {
      log: logger,
      ledger,
      dryRun: flags.has('--dry-run'),
      force: flags.has('--force'),
    });

    const icon =
      outcome.status === 'completed' ? '✅' : outcome.status.startsWith('skipped') ? '⏭️' : '❌';

    console.log(`\n${icon} ${siteId}: ${outcome.status}`);
    if (outcome.note) console.log(`   ${outcome.note}`);
    if (outcome.artifactsDir) console.log(`   artifacts: ${outcome.artifactsDir}`);

    return outcome.status === 'completed' || outcome.status.startsWith('skipped') ? 0 : 1;
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

async function cmdPassword(siteId: string): Promise<number> {
  const cfg = await loadSiteConfig(siteId).catch(() => null);
  const pw = derivePasswordForSite(env.MASTER_SECRET, {
    id: siteId,
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
  const runnable: typeof pending = [];
  for (const row of pending) {
    if (runnable.length >= limit) break;
    const cfg = await loadSiteConfig(row.siteId).catch(() => null);
    if (cfg) runnable.push(row);
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
        onProgress: {
          started: (runId) => sheet.markInProgress(row, runId),
          finished: async (result, identity) => {
            // skipped_terminal "zaten bitmiş" demek ama nasıl bittiğini
            // taşımıyor — gerçek sonucu ledger'dan alıp Sheet'e yaz.
            if (result.status === 'skipped_terminal') {
              const prev = ledger.terminalResult(row.siteId);
              const creds = ledger.credentials(row.siteId);
              if (prev) {
                await sheet.writeOutcome(
                  row,
                  { status: prev.status as typeof result.status, note: prev.note ?? undefined },
                  creds
                    ? {
                        email: creds.email,
                        username: creds.username,
                        profileUrl: creds.profile_url ?? undefined,
                      }
                    : undefined,
                );
                return;
              }
            }
            await sheet.writeOutcome(row, result, identity);
          },
        },
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
  const args = process.argv.slice(2);
  const command = args[0];
  const positional = args.slice(1).filter((a) => !a.startsWith('--'));
  const flags = new Set(args.filter((a) => a.startsWith('--')));

  let code = 0;

  switch (command) {
    case 'run-one': {
      const siteId = positional[0];
      if (!siteId) {
        console.error('Site id gerekli: npm run cli -- run-one <siteId>');
        code = 1;
        break;
      }
      code = await cmdRunOne(siteId, flags);
      break;
    }
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
      code = cmdUnlock(siteId);
      break;
    }
    case 'password': {
      const siteId = positional[0];
      if (!siteId) {
        console.error('Site id gerekli.');
        code = 1;
        break;
      }
      code = await cmdPassword(siteId);
      break;
    }
    case 'check-gmail':
      code = await cmdCheckGmail();
      break;
    case 'sheet':
      code = await cmdSheet(flags);
      break;
    case 'run-batch':
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
