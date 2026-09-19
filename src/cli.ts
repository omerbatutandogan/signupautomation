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
  status                  Son denemeler ve ledger özeti
  list                    Tanımlı site config'lerini listele
  unlock <siteId>         Takılı kilidi temizle
  password <siteId>       Türetilmiş şifreyi yazdır
  check-gmail             Gmail bağlantısını doğrula
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
    default:
      usage();
      code = command ? 1 : 0;
  }

  process.exit(code);
}

main().catch((err: unknown) => {
  console.error('\n❌ Beklenmeyen hata:', err instanceof Error ? err.message : err);
  process.exit(1);
});
