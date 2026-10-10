/**
 * Verilen siteleri sırayla GERÇEK kayıt olarak çalıştırır (run-one), siteler arasında rastgele bekler.
 *
 * Kullanım:  npx tsx scripts/run-list.ts <id> [<id> ...]      ya da   npx tsx scripts/run-list.ts --file liste.txt
 * Durdurma:  data/pilot/STOP dosyası oluştur (sıradaki siteden önce durur) — ya da 3 ardışık başarısızlık.
 * Günlük sınır, kilitler ve risk kapıları run-one'ın kendi içinde (runSite) zaten uygulanır.
 */

import { spawn } from 'node:child_process';
import { appendFile, mkdir, readFile, stat, writeFile } from 'node:fs/promises';
import { env } from '../src/config.js';
import { classifyStatus, gapSeconds, parseRunOneStatus, shouldStop, type ListOutcome } from '../src/core/run-list.js';

const DIR = 'data/pilot';
const STOP_FILE = `${DIR}/STOP`;

function run(id: string): Promise<{ code: number | null; output: string }> {
  return new Promise((resolve) => {
    const child = spawn('npx', ['tsx', 'src/cli.ts', 'run-one', id], { env: process.env });
    let output = '';
    child.stdout.on('data', (d) => (output += d));
    child.stderr.on('data', (d) => (output += d));
    child.on('close', (code) => resolve({ code, output }));
  });
}

const exists = (path: string) => stat(path).then(() => true, () => false);
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  let ids = args.filter((a) => !a.startsWith('--'));
  const fileIdx = args.indexOf('--file');
  if (fileIdx >= 0) ids = (await readFile(args[fileIdx + 1]!, 'utf8')).split('\n').map((l) => l.trim()).filter((l) => l && !l.startsWith('#'));
  if (ids.length === 0) throw new Error('Site id verilmedi');

  await mkdir(DIR, { recursive: true });
  const history: ListOutcome[] = [];
  console.log(`▶ ${ids.length} site, bekleme ${env.MIN_GAP_MINUTES}-${env.MAX_GAP_MINUTES} dk, günlük sınır ${env.DAILY_LIMIT}`);

  for (const [i, id] of ids.entries()) {
    if (await exists(STOP_FILE)) {
      console.log(`⏹ ${STOP_FILE} bulundu — ${id} ve sonrası çalıştırılmadı`);
      break;
    }
    const startedAt = new Date().toISOString();
    console.log(`\n[${i + 1}/${ids.length}] ${id} başlıyor (${startedAt})`);
    const { code, output } = await run(id);
    await writeFile(`${DIR}/${id}.log`, output);

    const status = parseRunOneStatus(output) ?? (code === 0 ? 'unknown' : 'error');
    const outcome = classifyStatus(status);
    history.push(outcome);
    await appendFile(`${DIR}/results.jsonl`, `${JSON.stringify({ id, status, outcome, startedAt, finishedAt: new Date().toISOString() })}\n`);
    console.log(`   → ${status} (${outcome})`);

    if (shouldStop(history)) {
      console.log('⏹ 6 ardışık başarısızlık — duruyorum. Artifact ve loglara bak, config/akış sorununu çöz.');
      break;
    }
    if (i < ids.length - 1 && outcome !== 'skipped') {
      const wait = gapSeconds(env.MIN_GAP_MINUTES, env.MAX_GAP_MINUTES);
      console.log(`   bir sonraki site için ${Math.round(wait / 60)} dk bekleniyor`);
      for (let left = wait; left > 0; left -= 5) {
        if (await exists(STOP_FILE)) break;
        await sleep(5_000);
      }
    }
  }
  console.log('\n■ bitti');
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
