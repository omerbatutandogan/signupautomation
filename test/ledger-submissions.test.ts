import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { Ledger } from '../src/integrations/ledger.js';

/**
 * Listeleme kayıtları — çift yayını önleyen ledger kuralları.
 *
 * Listeleme ürünü herkese açık yayınlar. Ledger'ın yanılabileceği yön "emin değilim → yeniden
 * dene" DEĞİL "emin değilim → engelle" olmalı.
 */

let dir: string;
let path: string;
let ledger: Ledger;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'ledger-sub-'));
  path = join(dir, 'test.sqlite');
  ledger = new Ledger(path);
});

afterEach(() => {
  ledger.close();
  rmSync(dir, { recursive: true, force: true });
});

/** Süreç çökmesi: kayıt 'running' kalır, kilit TTL'siyle düşmüştür; yeni örnek başlangıçta temizler. */
function crashAndReopen(): void {
  ledger.close();
  ledger = new Ledger(path);
}

describe('öksüz (süreç ölmüş) listeleme kayıtları', () => {
  it('yarıda kalan GERÇEK gönderim "unconfirmed" olur ve yeniden denemeyi ENGELLER', () => {
    ledger.tryClaim('site-a#submit', 'run-1', -1000); // TTL zaten dolmuş
    ledger.startSubmission('site-a', 'run-1', false);
    crashAndReopen();

    const row = ledger.recentSubmissions(5)[0];
    expect(row?.status).toBe('unconfirmed');
    expect(row?.note).toMatch(/yayınlanmış olabilir/);
    // Tıklamadan sonra ölmüş olabilir: otomatik yeniden deneme çift listeleme yapardı.
    expect(ledger.liveSubmission('site-a')?.status).toBe('unconfirmed');
  });

  it('yarıda kalan DRY-RUN zararsızdır: "error" olur ve hiçbir şeyi engellemez', () => {
    ledger.tryClaim('site-a#submit', 'run-1', -1000);
    ledger.startSubmission('site-a', 'run-1', true);
    crashAndReopen();

    expect(ledger.recentSubmissions(5)[0]?.status).toBe('error');
    expect(ledger.liveSubmission('site-a')).toBeNull();
  });

  it('kilidi hâlâ tutulan (canlı) kayda dokunulmaz', () => {
    ledger.tryClaim('site-a#submit', 'run-1'); // süresi dolmadı: süreç yaşıyor
    ledger.startSubmission('site-a', 'run-1', false);
    crashAndReopen();

    expect(ledger.recentSubmissions(5)[0]?.status).toBe('running');
  });
});

describe('liveSubmission — varsayılan ENGELLE', () => {
  const finish = (account: string, status: string, dryRun = false) => {
    const id = ledger.startSubmission(account, 'r', dryRun);
    if (status !== 'running') ledger.finishSubmission(id, status);
  };

  it('yalnızca kesin "hiçbir şey gönderilmedi" (failed) engellemez', () => {
    finish('a', 'failed');
    expect(ledger.liveSubmission('a')).toBeNull();
  });

  it.each(['completed', 'unconfirmed', 'running', 'error', 'baska-bir-durum'])('%s engeller', (status) => {
    finish('a', status);
    expect(ledger.liveSubmission('a')?.status).toBe(status);
  });

  it('dry-run kayıtları hiçbir zaman engellemez', () => {
    for (const status of ['completed', 'unconfirmed', 'running', 'error']) finish('a', status, true);
    expect(ledger.liveSubmission('a')).toBeNull();
  });

  it('tamamlanmış kayıt, daha yeni bir belirsiz kayda tercih edilir (listing_url korunur)', () => {
    const done = ledger.startSubmission('a', 'r1', false);
    ledger.finishSubmission(done, 'completed', 'ok', 'https://x.example/listing');
    finish('a', 'unconfirmed');
    expect(ledger.liveSubmission('a')).toMatchObject({ status: 'completed', listing_url: 'https://x.example/listing' });
  });

  it('başka hesabın kaydı engellemez', () => {
    finish('a', 'completed');
    expect(ledger.liveSubmission('b')).toBeNull();
  });
});

describe('countLiveSubmissionsToday', () => {
  it('yalnızca bugün başlatılan GERÇEK gönderimleri sayar (dry-run sayılmaz, failed sayılır)', () => {
    ledger.startSubmission('a', 'r', false);
    ledger.finishSubmission(ledger.startSubmission('b', 'r', false), 'failed');
    ledger.startSubmission('c', 'r', true); // dry-run
    expect(ledger.countLiveSubmissionsToday()).toBe(2);
  });
});
