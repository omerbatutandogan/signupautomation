/**
 * Doğrulanmamış taslak config'leri toplu DRY-RUN ile doğrular.
 *
 *   npx tsx scripts/verify-drafts.ts [--limit N] [--only a,b,c] [--timeout-min 4]
 *                                    [--retry-failed] [--dry-list]
 *
 *   Durdurmak için:  touch data/verify-drafts/STOP   (mevcut site bitince çıkar)
 *
 * GÜVENLİK: Bu betik YALNIZCA `run-one <site> --dry-run` çalıştırır; kayıt
 * göndermez. Dry-run captcha çözmez, insan beklemez, kimlik kaydı ve kalıcı
 * tarayıcı profili bırakmaz (bkz. src/core/runner.ts, browser.ts). Başarılı
 * dry-run config'in "doğrulanmadı" damgasını kaldırır; başarısız olan taslak
 * kalır ve ledger'a nedeni yazılır.
 *
 * Her site AYRI bir süreçte çalışır: takılan tarayıcı süreç grubuyla birlikte
 * SIGKILL'lenir (Playwright SIGTERM'i yutuyor), tek site turu durduramaz.
 * İlerleme data/verify-drafts/progress.json'da; yarıda kalırsa kaldığı yerden sürer.
 */

import { spawn, spawnSync } from 'node:child_process';
import {
  closeSync,
  existsSync,
  mkdirSync,
  openSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  statfsSync,
  writeFileSync,
} from 'node:fs';
import { setTimeout as sleep } from 'node:timers/promises';
import { isUnverified } from '../src/discovery/generate-config.js';
import { awaitsMoveApproval } from '../src/core/markers.js';
import { TEMP_PROFILE_PREFIX } from '../src/core/browser.js';

const SITES_DIR = 'src/sites';
const OUT_DIR = 'data/verify-drafts';
const LOG_DIR = `${OUT_DIR}/logs`;
const PROGRESS = `${OUT_DIR}/progress.json`;
const STOP_FILE = `${OUT_DIR}/STOP`;
const PROFILE_ROOT = 'data/profiles';
/** Boş disk bunun altına inerse dur: artifact'lar ve tarayıcı önbelleği sistemi boğmasın. */
const MIN_FREE_BYTES = 3 * 1024 ** 3;

const args = process.argv.slice(2);
const flag = (name: string) => args.includes(name);
const option = (name: string) => (args.includes(name) ? args[args.indexOf(name) + 1] : undefined);

const limit = Number(option('--limit') ?? Infinity);
const only = option('--only')?.split(',').map((s) => s.trim()).filter(Boolean);
const timeoutMs = Number(option('--timeout-min') ?? 4) * 60_000;

type Status = 'verified' | 'failed' | 'timeout';
interface Result {
  status: Status;
  at: string;
  seconds: number;
  /** run-one'ın yazdığı sonuç satırı (nedeni içerir). */
  note: string;
  /** Dry-run'da görülen captcha türü (gerçek kayıtta çözücü/insan gerekecek). */
  captcha?: string;
}
type Progress = Record<string, Result>;

function loadProgress(): Progress {
  try {
    return JSON.parse(readFileSync(PROGRESS, 'utf8')) as Progress;
  } catch {
    return {};
  }
}

function saveProgress(progress: Progress): void {
  mkdirSync(OUT_DIR, { recursive: true });
  const tmp = `${PROGRESS}.tmp`;
  writeFileSync(tmp, JSON.stringify(progress, null, 1));
  renameSync(tmp, PROGRESS);
}

const stripAnsi = (s: string) => s.replace(/\x1b\[[0-9;]*m/g, '');

/** Tarama sırası (Sheet sekme sırası): erken sekmelerdeki taslaklar önce doğrulanır. */
function tabRanks(): Map<string, number> {
  const ranks = new Map<string, number>();
  try {
    const log = readFileSync('data/scan-logs/_progress.log', 'utf8');
    for (const m of log.matchAll(/BAŞLADI \[(.*?)\]/g)) {
      const tab = m[1] as string;
      if (!ranks.has(tab)) ranks.set(tab, ranks.size);
    }
  } catch {
    /* günlük yoksa sıra alfabetik kalır */
  }
  return ranks;
}

function siteRanks(): Map<string, number> {
  const ranks = tabRanks();
  const best = new Map<string, number>();
  for (const file of readdirSync('data').filter((f) => /^discovery-.*\.json$/.test(f))) {
    const tab = file.slice('discovery-'.length, -'.json'.length);
    const rank = ranks.get(tab) ?? 999;
    try {
      const entries = (JSON.parse(readFileSync(`data/${file}`, 'utf8')) as { entries?: Record<string, { siteId?: string; outcome?: string }> }).entries ?? {};
      for (const e of Object.values(entries)) {
        if (e.outcome !== 'generated' || !e.siteId) continue;
        best.set(e.siteId, Math.min(best.get(e.siteId) ?? 999, rank));
      }
    } catch {
      /* yarım dosya: bu sekme sıralamaya katılmaz */
    }
  }
  return best;
}

/** Doğrulanabilir taslaklar: damgalı, taşınma onayı beklemeyen, yüksek riskli olmayan. */
function candidates(): string[] {
  const ranks = siteRanks();
  const ids: string[] = [];
  for (const file of readdirSync(SITES_DIR).filter((f) => f.endsWith('.json')).sort()) {
    const id = file.slice(0, -'.json'.length);
    try {
      const cfg = JSON.parse(readFileSync(`${SITES_DIR}/${file}`, 'utf8')) as { risk?: string; notes?: string };
      if (cfg.risk === 'high') continue;
      if (awaitsMoveApproval(cfg)) continue; // gerçek kayıt zaten insan onayı bekler
      if (!isUnverified(cfg)) continue;
      ids.push(id);
    } catch {
      /* bozuk config: atla */
    }
  }
  return ids.sort((a, b) => (ranks.get(a) ?? 999) - (ranks.get(b) ?? 999) || a.localeCompare(b));
}

function freeBytes(): number {
  const s = statfsSync('.');
  return Number(s.bavail) * Number(s.bsize);
}

/** Yarıda ölen turun bıraktığı geçici profil dizinleri (tur sıralı: hepsi artıktır). */
function cleanTempProfiles(): void {
  if (!existsSync(PROFILE_ROOT)) return;
  for (const d of readdirSync(PROFILE_ROOT).filter((n) => n.startsWith(TEMP_PROFILE_PREFIX))) {
    rmSync(`${PROFILE_ROOT}/${d}`, { recursive: true, force: true });
  }
}

/** Süreç grubunu öldürdükten sonra ayrı gruba geçmiş Chromium süreçleri de kalmasın. */
function killOrphanBrowsers(siteId: string): void {
  spawnSync('pkill', ['-9', '-f', `user-data-dir=.*data/profiles/(${TEMP_PROFILE_PREFIX.replace('.', '\\.')}[^ ]*|${siteId})( |$)`]);
}

function runOne(siteId: string): Promise<{ exit: number | null; timedOut: boolean; logPath: string }> {
  mkdirSync(LOG_DIR, { recursive: true });
  const logPath = `${LOG_DIR}/${siteId}.log`;
  const fd = openSync(logPath, 'w');
  // SADECE dry-run: bu dizi başka bir şeye dönüşemez.
  const cmd = ['--import', 'tsx', 'src/cli.ts', 'run-one', siteId, '--dry-run'];
  if (!cmd.includes('--dry-run') || cmd.includes('--live') || cmd.includes('--force')) throw new Error('verify-drafts yalnızca --dry-run çalıştırır');

  return new Promise((resolve) => {
    const child = spawn(process.execPath, cmd, {
      stdio: ['ignore', fd, fd],
      detached: true, // kendi süreç grubu: zaman aşımında grubun tamamı öldürülür
      env: { ...process.env, HEADLESS: 'true' }, // yüzlerce pencere kullanıcının ekranını ele geçirmesin
    });
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      try {
        if (child.pid) process.kill(-child.pid, 'SIGKILL');
      } catch {
        /* zaten bitmiş */
      }
      killOrphanBrowsers(siteId);
    }, timeoutMs);
    child.on('exit', (code) => {
      clearTimeout(timer);
      closeSync(fd);
      resolve({ exit: code, timedOut, logPath });
    });
  });
}

/** run-one çıktısındaki sonuç satırı ve nedeni (renk kodları ayıklanır). */
function summarize(logPath: string): { note: string; captcha?: string } {
  let text = '';
  try {
    text = stripAnsi(readFileSync(logPath, 'utf8'));
  } catch {
    /* günlük okunamadı */
  }
  const lines = text.split('\n');
  const at = lines.findLastIndex((l) => /^\s*(✅|❌|⏭️)\s/.test(l));
  const note = at >= 0 ? [lines[at], lines[at + 1]].filter(Boolean).join(' | ').replace(/\s+/g, ' ').trim() : 'çıktı yok';
  const cap = /captcha görüldü[\s\S]{0,300}?kind:\s*"?([a-z_0-9]+)/.exec(text);
  return { note: note.slice(0, 400), ...(cap?.[1] ? { captcha: cap[1] } : {}) };
}

function isStillUnverified(siteId: string): boolean {
  try {
    return isUnverified(JSON.parse(readFileSync(`${SITES_DIR}/${siteId}.json`, 'utf8')) as { notes?: string });
  } catch {
    return true;
  }
}

function printSummary(progress: Progress, total: number): void {
  const results = Object.values(progress);
  const count = (s: Status) => results.filter((r) => r.status === s).length;
  const captcha = results.filter((r) => r.captcha).length;
  console.log(
    `\n── Özet ──\n  Doğrulandı: ${count('verified')}\n  Başarısız:  ${count('failed')}\n  Zaman aşımı: ${count('timeout')}\n  Captcha görülen: ${captcha}\n  İşlenen: ${results.length} / ${total}`,
  );
}

async function main(): Promise<number> {
  mkdirSync(LOG_DIR, { recursive: true });
  rmSync(STOP_FILE, { force: true });
  cleanTempProfiles();

  const progress = loadProgress();
  let todo = only ?? candidates();
  const total = todo.length;
  // Kaldığı yerden sür: sonucu olanı atla (başarısızları yeniden denemek için --retry-failed).
  todo = todo.filter((id) => !progress[id] || (flag('--retry-failed') && progress[id]?.status !== 'verified'));
  todo = todo.slice(0, limit);

  console.log(`Doğrulanacak taslak: ${todo.length} (kalan), aday toplamı: ${total}, zaman aşımı: ${timeoutMs / 60_000} dk`);
  if (flag('--dry-list')) {
    console.log(todo.join('\n'));
    return 0;
  }

  const started = Date.now();
  let done = 0;
  for (const id of todo) {
    if (existsSync(STOP_FILE)) {
      console.log('\nSTOP dosyası bulundu — duruyor.');
      break;
    }
    if (freeBytes() < MIN_FREE_BYTES) {
      console.log(`\n⚠️  Boş disk ${(freeBytes() / 1024 ** 3).toFixed(1)} GB'ın altında (eşik ${MIN_FREE_BYTES / 1024 ** 3} GB) — duruyor.`);
      break;
    }

    const t0 = Date.now();
    const { exit, timedOut, logPath } = await runOne(id);
    cleanTempProfiles(); // normal çıkışta boştur; kill sonrası artıkları siler
    const { note, captcha } = summarize(logPath);
    const status: Status = timedOut ? 'timeout' : !isStillUnverified(id) ? 'verified' : 'failed';
    progress[id] = {
      status,
      at: new Date().toISOString(),
      seconds: Math.round((Date.now() - t0) / 1000),
      note: timedOut ? `zaman aşımı (${timeoutMs / 60_000} dk) — süreç öldürüldü` : `${note}${exit !== 0 && status === 'failed' ? ` (çıkış ${exit})` : ''}`,
      ...(captcha ? { captcha } : {}),
    };
    saveProgress(progress);
    done++;

    const icon = status === 'verified' ? '✅' : status === 'timeout' ? '⏱️ ' : '❌';
    console.log(`${icon} [${done}/${todo.length}] ${id} (${progress[id]!.seconds}s)${captcha ? ` captcha:${captcha}` : ''}${status === 'verified' ? '' : ` — ${progress[id]!.note.slice(0, 140)}`}`);

    if (done % 25 === 0) {
      const perSite = (Date.now() - started) / done / 1000;
      printSummary(progress, total);
      console.log(`  Ortalama ${perSite.toFixed(0)} sn/site, kalan ≈ ${Math.round(((todo.length - done) * perSite) / 60)} dk`);
    }
    // Sıradaki siteden önce kısa, rastgele soluk (makineyi ve ağı boğma).
    await sleep(1000 + Math.random() * 2000);
  }

  printSummary(progress, total);
  writeFileSync(`${OUT_DIR}/summary.txt`, JSON.stringify(progress, null, 1));
  return 0;
}

main()
  .then((code) => process.exit(code))
  .catch((err: unknown) => {
    console.error('\n❌ Hata:', err instanceof Error ? err.message : err);
    process.exit(1);
  });
