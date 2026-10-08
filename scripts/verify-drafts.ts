/**
 * Doğrulanmamış taslak config'leri toplu DRY-RUN ile doğrular.
 *
 *   npx tsx scripts/verify-drafts.ts [--limit N] [--only a,b,c] [--timeout-min 4]
 *                                    [--retry-failed] [--headed] [--dry-list]
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
import { isBotWall } from '../src/discovery/find-signup.js';

const SITES_DIR = 'src/sites';
const OUT_DIR = 'data/verify-drafts';
const LOG_DIR = `${OUT_DIR}/logs`;
const PROGRESS = `${OUT_DIR}/progress.json`;
const STOP_FILE = `${OUT_DIR}/STOP`;
const PROFILE_ROOT = 'data/profiles';
/** Boş disk bunun altındayken yeni site başlatma: artifact'lar ve tarayıcı önbelleği sistemi boğmasın. */
const MIN_FREE_BYTES = 3 * 1024 ** 3;

const args = process.argv.slice(2);
const flag = (name: string) => args.includes(name);
const option = (name: string) => (args.includes(name) ? args[args.indexOf(name) + 1] : undefined);

const limit = Number(option('--limit') ?? Infinity);
const only = option('--only')?.split(',').map((s) => s.trim()).filter(Boolean);
const timeoutMs = Number(option('--timeout-min') ?? 4) * 60_000;
/** Görünür tarayıcı: bot duvarı headless'ta çıkıp gerçek (görünür) tarayıcıda çıkmayabiliyor. */
const headed = flag('--headed');
if (!(limit > 0) || !(timeoutMs > 0)) {
  console.error('--limit ve --timeout-min pozitif sayı olmalı');
  process.exit(2);
}
for (const id of only ?? []) {
  if (!/^[a-z0-9-]+$/.test(id) || !existsSync(`${SITES_DIR}/${id}.json`)) {
    console.error(`--only: geçersiz ya da config'i olmayan site: ${id}`);
    process.exit(2);
  }
}

type Status = 'verified' | 'failed' | 'timeout';
interface Result {
  status: Status;
  at: string;
  seconds: number;
  /** run-one'ın yazdığı sonuç satırı (nedeni içerir). */
  note: string;
  /** Dry-run'da görülen captcha türü (gerçek kayıtta çözücü/insan gerekecek). */
  captcha?: string;
  /** Başarısızlık sayfası bir bot duvarıydı (Cloudflare vb.): form sorunu değil, duvar. */
  wall?: boolean;
  /** Tarayıcı görünür miydi? (headless sonuçlar duvara karşı daha duyarlı) */
  headed?: boolean;
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

/**
 * Çocuk sürecin ağacını öldür. Playwright Chromium'u KENDİ süreç grubunda başlatır;
 * node'un grubunu öldürmek ona ulaşmaz. Doğrudan çocukları (Chromium tarayıcı süreci)
 * bulup GRUPLARINI öldürürüz: GPU/renderer yardımcıları da o gruptadır. Desen
 * eşlemesi yok, bu yüzden başka bir Chromium'a (elle dry-run, test, başka kopya) dokunulmaz.
 */
function killTree(pid: number): void {
  const kids = spawnSync('pgrep', ['-P', String(pid)]).stdout.toString().split('\n').filter(Boolean).map(Number);
  for (const kid of kids) {
    try {
      process.kill(-kid, 'SIGKILL');
    } catch {
      try {
        process.kill(kid, 'SIGKILL');
      } catch {
        /* zaten bitmiş */
      }
    }
  }
  try {
    process.kill(-pid, 'SIGKILL');
  } catch {
    /* zaten bitmiş */
  }
}

let currentChild: number | null = null;

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
      // HEADLESS: yüzlerce pencere kullanıcının ekranını ele geçirmesin.
      // CAPTCHA_API_KEY boş: dry-run zaten çözücüyü çağırmaz (kodda), bu İKİNCİ kilit:
      // bir gün o kod değişse bile bu betik ücretli çözücüye erişemez (dotenv var olanı ezmez).
      env: { ...process.env, HEADLESS: headed ? 'false' : 'true', CAPTCHA_API_KEY: '' },
    });
    currentChild = child.pid ?? null;
    let timedOut = false;
    let finished = false;
    const finish = (code: number | null) => {
      if (finished) return;
      finished = true;
      clearTimeout(timer);
      currentChild = null;
      closeSync(fd);
      resolve({ exit: code, timedOut, logPath });
    };
    const timer = setTimeout(() => {
      timedOut = true;
      if (child.pid) killTree(child.pid);
    }, timeoutMs);
    child.on('exit', (code) => finish(code));
    child.on('error', () => finish(null)); // süreç başlatılamadı: tur çökmesin, site 'failed' sayılır
  });
}

/** run-one çıktısındaki sonuç satırı ve nedeni (renk kodları ayıklanır). */
/** run-one'ın yazdığı artifact dizinindeki en son hata sayfası bir bot duvarı mı? */
function failurePageIsWall(log: string): boolean {
  const dir = /artifacts: (\S+)/.exec(log)?.[1];
  if (!dir || !existsSync(dir)) return false;
  const pages = readdirSync(dir).filter((f) => /^failure-.*\.html$/.test(f));
  const html = pages[0] ? readFileSync(`${dir}/${pages[0]}`, 'utf8').slice(0, 80_000) : '';
  const title = /<title[^>]*>([\s\S]*?)<\/title>/i.exec(html)?.[1] ?? '';
  const text = html.replace(/<script[\s\S]*?<\/script>|<style[\s\S]*?<\/style>|<[^>]+>/g, ' ').replace(/\s+/g, ' ');
  return isBotWall(0, `${title} ${text.slice(0, 4000)}`);
}

function summarize(logPath: string): { note: string; captcha?: string; wall?: boolean } {
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
  return { note: note.slice(0, 400), ...(cap?.[1] ? { captcha: cap[1] } : {}), ...(failurePageIsWall(text) ? { wall: true } : {}) };
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

const LOCK_FILE = `${OUT_DIR}/lock`;

/** Tek örnek: iki betik birbirinin geçici profilini siler ve ilerleme dosyasını ezer. */
function acquireLock(): void {
  mkdirSync(OUT_DIR, { recursive: true });
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      writeFileSync(LOCK_FILE, String(process.pid), { flag: 'wx' });
      return;
    } catch {
      const other = Number(readFileSync(LOCK_FILE, 'utf8'));
      let alive = true;
      try {
        process.kill(other, 0);
      } catch {
        alive = false;
      }
      if (alive) throw new Error(`verify-drafts zaten çalışıyor (pid ${other})`);
      rmSync(LOCK_FILE, { force: true }); // ölü sürecin kilidi
    }
  }
  throw new Error('kilit alınamadı');
}

function shutdown(code: number): never {
  if (currentChild) killTree(currentChild);
  cleanTempProfiles();
  rmSync(LOCK_FILE, { force: true });
  process.exit(code);
}

async function main(): Promise<number> {
  const progress = loadProgress();
  let todo = only ?? candidates();
  const total = todo.length;
  // Kaldığı yerden sür: sonucu olanı atla (başarısızları yeniden denemek için --retry-failed).
  todo = todo.filter((id) => !progress[id] || (flag('--retry-failed') && progress[id]?.status !== 'verified'));
  todo = todo.slice(0, limit);

  console.log(`Doğrulanacak taslak: ${todo.length} (kalan), aday toplamı: ${total}, zaman aşımı: ${timeoutMs / 60_000} dk`);
  // Yan etkisiz: çalışan bir turun STOP dosyasına ve geçici profiline DOKUNMADAN çık.
  if (flag('--dry-list')) {
    console.log(todo.join('\n'));
    return 0;
  }

  acquireLock();
  for (const sig of ['SIGINT', 'SIGTERM', 'SIGHUP'] as const) process.on(sig, () => shutdown(130));
  mkdirSync(LOG_DIR, { recursive: true });
  rmSync(STOP_FILE, { force: true });
  cleanTempProfiles();

  const started = Date.now();
  let done = 0;
  for (const id of todo) {
    if (existsSync(STOP_FILE)) {
      console.log('\nSTOP dosyası bulundu — duruyor.');
      break;
    }
    // Disk azsa ÇIKMA, bekle: başka süreçler (ör. bir sanal makinenin geçici bellek
    // dosyaları) boş alanı GB'larca iner çıkar; kalıcı doluluk ise STOP ile durdurulur.
    // Beklerken bu betik disk kullanmaz, yani kendi payı sıfırdır.
    let warned = false;
    while (freeBytes() < MIN_FREE_BYTES && !existsSync(STOP_FILE)) {
      if (!warned) {
        console.log(`\n⚠️  Boş disk ${(freeBytes() / 1024 ** 3).toFixed(1)} GB (eşik ${MIN_FREE_BYTES / 1024 ** 3} GB) — disk açılana kadar bekliyor (durdurmak için STOP dosyası).`);
        warned = true;
      }
      await sleep(5_000); // STOP hızla fark edilsin
    }
    if (warned) console.log(`   Disk açıldı (${(freeBytes() / 1024 ** 3).toFixed(1)} GB) — devam.`);
    if (existsSync(STOP_FILE)) {
      console.log('\nSTOP dosyası bulundu — duruyor.');
      break;
    }

    const t0 = Date.now();
    // "Doğrulandı" = bu çalıştırma damgayı KALDIRDI (önceden damgalıydı, şimdi değil).
    const wasUnverified = isStillUnverified(id);
    const { exit, timedOut, logPath } = await runOne(id);
    cleanTempProfiles(); // normal çıkışta boştur; kill sonrası artıkları siler
    const { note, captcha, wall } = summarize(logPath);
    const status: Status = timedOut ? 'timeout' : wasUnverified && !isStillUnverified(id) ? 'verified' : 'failed';
    progress[id] = {
      status,
      at: new Date().toISOString(),
      seconds: Math.round((Date.now() - t0) / 1000),
      note: timedOut ? `zaman aşımı (${timeoutMs / 60_000} dk) — süreç öldürüldü` : `${note}${exit !== 0 && status === 'failed' ? ` (çıkış ${exit})` : ''}`,
      ...(captcha ? { captcha } : {}),
      ...(status !== 'verified' && wall ? { wall: true } : {}),
      ...(headed ? { headed: true } : {}),
    };
    saveProgress(progress);
    done++;

    const icon = status === 'verified' ? '✅' : status === 'timeout' ? '⏱️ ' : progress[id]!.wall ? '🧱' : '❌';
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
  rmSync(LOCK_FILE, { force: true });
  return 0;
}

main()
  .then((code) => process.exit(code))
  .catch((err: unknown) => {
    console.error('\n❌ Hata:', err instanceof Error ? err.message : err);
    if (currentChild) killTree(currentChild);
    // Başka bir örneğin kilidini silme: yalnızca kendi pid'imizse kaldır.
    try {
      if (Number(readFileSync(LOCK_FILE, 'utf8')) === process.pid) rmSync(LOCK_FILE, { force: true });
    } catch {
      /* kilit yok */
    }
    process.exit(1);
  });
