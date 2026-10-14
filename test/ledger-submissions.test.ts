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


/**
 * Sonucu doğrulanamayan gönderimi İNSAN kanıtıyla "yayınlanmadı" yapmak (reject-submission): site gönderimi bir uyarıyla
 * reddetti ve ürün hiç oluşmadı. Satır 'failed' olur; sonraki gönderim --force gerektirmez ve Sheet "Gönderildi" demez.
 */
describe('rejectSubmission', () => {
  const send = (key: string, status: string, dry = false) => {
    const id = ledger.startSubmission(key, `run-${key}-${status}`, dry);
    ledger.finishSubmission(id, status, 'özgün not', status === 'completed' ? 'https://x.example/p' : undefined);
  };

  it('doğrulanamayan (unconfirmed) gerçek gönderimi failed yapar; yeniden denemenin önü açılır', () => {
    send('site-a', 'unconfirmed');
    expect(ledger.liveSubmission('site-a')?.status).toBe('unconfirmed'); // önce: engelli

    expect(ledger.rejectSubmission('site-a', 'elle doğrulandı: site reddetti')).toBe(1);
    expect(ledger.liveSubmission('site-a')).toBeNull(); // sonra: engel yok
    expect(ledger.recentSubmissions(5)[0]).toMatchObject({ status: 'failed', note: 'elle doğrulandı: site reddetti' });
  });

  it('süreç ölmüş yarım (running) kaydı da kapatır', () => {
    ledger.startSubmission('site-b', 'run-1', false); // 'running' kalır
    expect(ledger.liveSubmission('site-b')?.status).toBe('running');
    expect(ledger.rejectSubmission('site-b', 'elle doğrulandı: hiçbir şey oluşmadı')).toBe(1);
    expect(ledger.liveSubmission('site-b')).toBeNull();
  });

  it('gerçekten listelenmiş (completed) gönderime ve dry-run satırlarına DOKUNMAZ', () => {
    send('site-c', 'completed');
    send('site-c', 'completed', true); // dry-run
    expect(ledger.rejectSubmission('site-c', 'elle doğrulandı: x')).toBe(0);
    expect(ledger.liveSubmission('site-c')?.status).toBe('completed');
    expect(ledger.recentSubmissions(5).map((r) => r.status)).toEqual(['completed', 'completed']);
  });

  it('dry-run satırları durumları ne olursa olsun korunur (yalnızca GERÇEK gönderimler işlenir)', () => {
    send('site-g', 'manual', true); // dry-run denetimi başarısız
    ledger.startSubmission('site-g', 'run-dry', true); // yarım kalmış dry-run ('running')
    expect(ledger.rejectSubmission('site-g', 'elle doğrulandı: x')).toBe(0);
    expect(ledger.recentSubmissions(5).map((r) => r.status).sort()).toEqual(['manual', 'running']);
  });

  it('yalnızca verilen hesabı etkiler; yoksa 0 döner', () => {
    send('site-d', 'unconfirmed');
    send('site-e', 'unconfirmed');
    expect(ledger.rejectSubmission('site-d', 'elle doğrulandı: x')).toBe(1);
    expect(ledger.liveSubmission('site-e')?.status).toBe('unconfirmed');
    expect(ledger.rejectSubmission('yok', 'elle doğrulandı: x')).toBe(0);
  });

  it('günlük gerçek listeleme sayacını DEĞİŞTİRMEZ (başlatılmış denemeler zaten sayıldı)', () => {
    send('site-f', 'unconfirmed');
    const before = ledger.countLiveSubmissionsToday();
    ledger.rejectSubmission('site-f', 'elle doğrulandı: x');
    expect(ledger.countLiveSubmissionsToday()).toBe(before);
  });
});

/**
 * confirm-submission: reject-submission'ın tersi. Ürün sitede GERÇEKTEN oluştu ama sistem başarı işaretini tanımadı (1look4:
 * "You have successfully submitted your story url for Review"): satır İNSAN kanıtıyla 'completed' olur ve herkese açık adres
 * kaydedilir. Yanlış kullanım yalnızca "yayınlandı" demektir (çift yayını engelleyen yön), yine de dokunulan satır dar tutulur.
 */
describe('confirmSubmission', () => {
  const send = (key: string, status: string, dry = false, url?: string) => {
    const id = ledger.startSubmission(key, `run-${key}-${status}-${Math.random()}`, dry);
    ledger.finishSubmission(id, status, 'özgün not', url);
    return id;
  };
  const rows = (key: string) => ledger.recentSubmissions(20).filter((r) => r.account_key === key);

  it('doğrulanamayan (unconfirmed) gerçek gönderimi completed yapar; not ve herkese açık adres kaydedilir', () => {
    send('site-a', 'unconfirmed', false, 'https://x.example/story/submit');
    expect(ledger.confirmSubmission('site-a', 'elle doğrulandı, GÖNDERİLDİ: hikâye sayfada', 'https://x.example/story/seo/geo')).toBe(1);

    expect(rows('site-a')[0]).toMatchObject({ status: 'completed', note: 'elle doğrulandı, GÖNDERİLDİ: hikâye sayfada', listing_url: 'https://x.example/story/seo/geo' });
    expect(ledger.liveSubmission('site-a')).toMatchObject({ status: 'completed', listing_url: 'https://x.example/story/seo/geo' });
  });

  it('adres verilmezse sistemin kaydettiği son adres korunur', () => {
    send('site-b', 'unconfirmed', false, 'https://x.example/last');
    expect(ledger.confirmSubmission('site-b', 'elle doğrulandı: var')).toBe(1);
    expect(rows('site-b')[0]!.listing_url).toBe('https://x.example/last');
  });

  it('süreç ölmüş yarım (running) kaydı da onaylanabilir', () => {
    ledger.startSubmission('site-c', 'run-1', false);
    expect(ledger.confirmSubmission('site-c', 'elle doğrulandı: var')).toBe(1);
    expect(ledger.liveSubmission('site-c')?.status).toBe('completed');
  });

  it("failed, zaten completed ve dry-run satırlarına DOKUNMAZ", () => {
    send('site-d', 'failed');
    send('site-d', 'completed', false, 'https://x.example/old');
    send('site-d', 'unconfirmed', true); // dry-run satırı
    ledger.startSubmission('site-d', 'run-dry', true); // yarım kalmış dry-run
    expect(ledger.confirmSubmission('site-d', 'elle doğrulandı: x', 'https://x.example/new')).toBe(0);
    const statuses = rows('site-d').map((r) => `${r.status}${r.dry_run ? '(dry)' : ''}`).sort();
    expect(statuses).toEqual(['completed', 'failed', 'running(dry)', 'unconfirmed(dry)']);
    expect(ledger.liveSubmission('site-d')?.listing_url).toBe('https://x.example/old'); // adres ezilmedi
  });

  it('birden çok doğrulanamamış deneme varsa yalnızca EN SON olanı onaylar (ikisi birden "yayınlandı" sayılmaz)', () => {
    const first = send('site-e', 'unconfirmed');
    const second = send('site-e', 'unconfirmed');
    expect(ledger.confirmSubmission('site-e', 'elle doğrulandı: var')).toBe(1);
    const byId = new Map(rows('site-e').map((r) => [r.id, r.status]));
    expect(byId.get(second)).toBe('completed');
    expect(byId.get(first)).toBe('unconfirmed');
  });

  it('yalnızca verilen hesabı etkiler; yoksa 0 döner', () => {
    send('site-f', 'unconfirmed');
    send('site-g', 'unconfirmed');
    expect(ledger.confirmSubmission('site-f', 'elle doğrulandı: var')).toBe(1);
    expect(ledger.liveSubmission('site-g')?.status).toBe('unconfirmed');
    expect(ledger.confirmSubmission('yok', 'elle doğrulandı: var')).toBe(0);
  });

  it('günlük gerçek listeleme sayacını DEĞİŞTİRMEZ ve sonraki gönderimi engeller (skipped_done: çift yayın yok)', () => {
    send('site-h', 'unconfirmed');
    const before = ledger.countLiveSubmissionsToday();
    ledger.confirmSubmission('site-h', 'elle doğrulandı: var');
    expect(ledger.countLiveSubmissionsToday()).toBe(before);
    expect(ledger.liveSubmission('site-h')).not.toBeNull(); // engel sürüyor
  });
});

/**
 * verify-listing: gerçekten gönderilmiş (`completed`) kaydın HERKESE AÇIK adresini ve görünürlüğünü insan kanıtıyla işler.
 * Sistem çoğu zaman gönderim sonrası sayfanın adresini (ör. /story/submit) kaydeder, ürünün kendi sayfasını değil; Sheet ise
 * "herkese açık doğrulandı" diyebilmek için bu kaydı okur.
 */
describe('verifyListing', () => {
  const send = (key: string, status: string, opts: { dry?: boolean; url?: string; note?: string } = {}) => {
    const id = ledger.startSubmission(key, `run-${key}-${status}-${Math.random()}`, opts.dry === true);
    ledger.finishSubmission(id, status, opts.note ?? 'özgün not', opts.url);
    return id;
  };
  const rows = (key: string) => ledger.recentSubmissions(20).filter((r) => r.account_key === key);

  it('completed gerçek gönderimin adresini ürünün herkese açık sayfasıyla değiştirir ve notun başına kanıtı yazar (önceki not korunur)', () => {
    send('site-a', 'completed', { url: 'https://x.example/story/submit', note: 'onaylandı (görünür:…)' });
    expect(ledger.verifyListing('site-a', 'https://x.example/story/seo/geo', 'çerezsiz açıldı, başlık var')).toBe(1);
    const row = rows('site-a')[0]!;
    expect(row.listing_url).toBe('https://x.example/story/seo/geo');
    expect(row.status).toBe('completed');
    expect(row.note).toBe('herkese açık doğrulandı: çerezsiz açıldı, başlık var | önceki not: onaylandı (görünür:…)');
  });

  it('tekrar çağrılınca notlar iç içe büyümez: yalnızca doğrulama bölümü yenilenir', () => {
    send('site-b', 'completed', { url: 'https://x.example/old', note: 'onaylandı' });
    ledger.verifyListing('site-b', 'https://x.example/a', 'ilk kanıt');
    ledger.verifyListing('site-b', 'https://x.example/b', 'ikinci kanıt');
    const row = rows('site-b')[0]!;
    expect(row.note).toBe('herkese açık doğrulandı: ikinci kanıt | önceki not: onaylandı');
    expect(row.listing_url).toBe('https://x.example/b');
  });

  it('notu olmayan satırda önceki not eki yazılmaz', () => {
    const id = ledger.startSubmission('site-c', 'run-c', false);
    ledger.finishSubmission(id, 'completed', undefined, 'https://x.example/old');
    ledger.verifyListing('site-c', 'https://x.example/new', 'kanıt var');
    expect(rows('site-c')[0]!.note).toBe('herkese açık doğrulandı: kanıt var');
  });

  it('yalnızca EN SON completed gerçek gönderimi değiştirir; failed, unconfirmed ve dry-run satırlarına dokunmaz', () => {
    const older = send('site-d', 'completed', { url: 'https://x.example/older' });
    send('site-d', 'failed', { url: 'https://x.example/failed' });
    send('site-d', 'unconfirmed', { url: 'https://x.example/unconfirmed' });
    send('site-d', 'completed', { dry: true, url: 'https://x.example/dry' });
    const latest = send('site-d', 'completed', { url: 'https://x.example/latest' });
    expect(ledger.verifyListing('site-d', 'https://x.example/public', 'kanıt var')).toBe(1);
    const byId = new Map(rows('site-d').map((r) => [r.id, r]));
    expect(byId.get(latest)!.listing_url).toBe('https://x.example/public');
    expect(byId.get(older)!.listing_url).toBe('https://x.example/older');
    expect(rows('site-d').filter((r) => r.listing_url === 'https://x.example/public')).toHaveLength(1);
    expect(rows('site-d').find((r) => r.status === 'failed')!.listing_url).toBe('https://x.example/failed');
    expect(rows('site-d').find((r) => r.status === 'unconfirmed')!.listing_url).toBe('https://x.example/unconfirmed');
    expect(rows('site-d').find((r) => r.dry_run === 1)!.listing_url).toBe('https://x.example/dry');
  });

  it('tamamlanmış gönderim yoksa (yalnızca unconfirmed/dry-run) ya da hesap yoksa 0 döner', () => {
    send('site-e', 'unconfirmed');
    send('site-e', 'completed', { dry: true });
    expect(ledger.verifyListing('site-e', 'https://x.example/p', 'kanıt var')).toBe(0);
    expect(ledger.verifyListing('yok', 'https://x.example/p', 'kanıt var')).toBe(0);
  });
});
