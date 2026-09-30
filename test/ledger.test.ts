import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import { Ledger } from '../src/integrations/ledger.js';

let dir: string;
let ledger: Ledger;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'ledger-test-'));
  ledger = new Ledger(join(dir, 'test.sqlite'));
});

afterEach(() => {
  ledger.close();
  rmSync(dir, { recursive: true, force: true });
});

describe('kilit (idempotency)', () => {
  it('aynı siteyi iki kez kilitlemeye izin vermez', () => {
    expect(ledger.tryClaim('site-a', 'run-1')).toBe(true);
    // İkinci çalıştırma aynı siteyi alamaz — çift kayıt denemesini engeller.
    expect(ledger.tryClaim('site-a', 'run-2')).toBe(false);
  });

  it('farklı siteler birbirini engellemez', () => {
    expect(ledger.tryClaim('site-a', 'run-1')).toBe(true);
    expect(ledger.tryClaim('site-b', 'run-1')).toBe(true);
  });

  it('bırakılan kilit tekrar alınabilir', () => {
    ledger.tryClaim('site-a', 'run-1');
    ledger.release('site-a');
    expect(ledger.tryClaim('site-a', 'run-2')).toBe(true);
  });

  it('TTL dolmuş kilitler yeni örnekte temizlenir', () => {
    ledger.tryClaim('site-a', 'run-1', -1000); // zaten süresi dolmuş
    ledger.close();

    // Yeni örnek başlangıçta bayat kilitleri reap eder — çökmüş çalıştırma
    // siteyi kalıcı olarak bloke etmesin.
    ledger = new Ledger(join(dir, 'test.sqlite'));
    expect(ledger.tryClaim('site-a', 'run-2')).toBe(true);
  });

  it('aktif kilidin sahibini raporlar', () => {
    ledger.tryClaim('site-a', 'run-xyz');
    expect(ledger.activeLock('site-a')?.run_id).toBe('run-xyz');
    expect(ledger.activeLock('site-b')).toBeNull();
  });

  it('öksüz kalan running denemeleri temizler', () => {
    // Süreç çökmesi/kill senaryosu: attempt başlar, finally hiç çalışmaz.
    ledger.tryClaim('site-a', 'run-1', -1000); // TTL zaten dolmuş
    ledger.startAttempt('site-a', 'run-1');
    ledger.close();

    ledger = new Ledger(join(dir, 'test.sqlite'));

    const recent = ledger.recentAttempts(5);
    expect(recent[0]?.status).toBe('error');
    expect(recent[0]?.note).toMatch(/yarıda kesildi/);
    // Terminal DEĞİL — site tekrar denenebilmeli.
    expect(ledger.terminalResult('site-a')).toBeNull();
  });
});

describe('denemeler', () => {
  it('terminal sonuçları kaydeder, geçici olanları kaydetmez', () => {
    const a1 = ledger.startAttempt('site-a', 'run-1');
    ledger.finishAttempt(a1, 'error', 'geçici ağ hatası');
    expect(ledger.terminalResult('site-a')).toBeNull();

    const a2 = ledger.startAttempt('site-a', 'run-2');
    ledger.finishAttempt(a2, 'completed');
    expect(ledger.terminalResult('site-a')?.status).toBe('completed');
  });

  it('dry-run sonucu terminal SAYILMAZ — gerçek kayıt atlanmasın', () => {
    // Gerçek hata: başarılı dry-run "completed" + terminal yazılıyordu;
    // run-batch (force'suz) siteyi "zaten bitmiş" diye atlıyor ve o
    // dry-run'ı Sheet'e "tamamlandı" olarak yazıyordu.
    const d = ledger.startAttempt('site-a', 'run-1', true);
    ledger.finishAttempt(d, 'completed', 'dry-run');
    expect(ledger.terminalResult('site-a')).toBeNull();

    // Gerçek sonuç, sonrasında dry-run olsa bile geçerli kalır.
    const r = ledger.startAttempt('site-a', 'run-2');
    ledger.finishAttempt(r, 'completed');
    const d2 = ledger.startAttempt('site-a', 'run-3', true);
    ledger.finishAttempt(d2, 'manual', 'dry-run kontrolü');
    expect(ledger.terminalResult('site-a')?.status).toBe('completed');
  });

  it('manual ve failed da terminal sayılır', () => {
    const a1 = ledger.startAttempt('site-a', 'run-1');
    ledger.finishAttempt(a1, 'manual', 'captcha yanıtsız');
    expect(ledger.terminalResult('site-a')?.status).toBe('manual');

    const a2 = ledger.startAttempt('site-b', 'run-1');
    ledger.finishAttempt(a2, 'failed');
    expect(ledger.terminalResult('site-b')?.status).toBe('failed');
  });

  it('günlük sayım skipped durumlarını hariç tutar', () => {
    const a1 = ledger.startAttempt('site-a', 'run-1');
    ledger.finishAttempt(a1, 'completed');
    const a2 = ledger.startAttempt('site-b', 'run-1');
    ledger.finishAttempt(a2, 'skipped_locked');

    // skipped gerçek bir deneme değil — günlük limiti tüketmemeli.
    expect(ledger.countToday()).toBe(1);
  });

  it('günlük sayım dry-run’ları hariç tutar', () => {
    const real = ledger.startAttempt('site-a', 'run-1');
    ledger.finishAttempt(real, 'completed');
    const dry = ledger.startAttempt('site-b', 'run-1', true);
    ledger.finishAttempt(dry, 'completed', 'dry-run');

    // Dry-run SUBMIT ETMİYOR: siteye kayıt trafiği üretmediği için
    // "günde kaç kayıt" limitini tüketmemeli. Saymak, teşhis
    // çalışmasını gerçek kayıt kotasıyla yarıştırıyordu.
    expect(ledger.countToday()).toBe(1);
  });

  it('NOTU dry-run demeyen bir dry-run’ı da hariç tutar', () => {
    // GERÇEK HATA: alternativeto dry-run'ı captcha'da takıldı, notu
    // "Captcha insan müdahalesi gerektiriyor" oldu ve içinde "dry-run"
    // geçmediği için sayıma sızdı — ledger 13/12 gösterdi. Ayrım artık
    // not metninden değil dry_run KOLONUNDAN yapılıyor.
    const real = ledger.startAttempt('site-a', 'run-1');
    ledger.finishAttempt(real, 'completed');
    const dry = ledger.startAttempt('site-b', 'run-1', true);
    ledger.finishAttempt(dry, 'manual', 'Captcha insan müdahalesi gerektiriyor: hcaptcha');

    expect(ledger.countToday()).toBe(1);
  });

  it('dry_run varsayılanı false — parametresiz çağrı gerçek sayılır', () => {
    // Muafiyetin fazla gevşemediğini garanti eder: yalnızca AÇIKÇA
    // dry-run denilen denemeler muaf.
    const id = ledger.startAttempt('site-a', 'run-1');
    ledger.finishAttempt(id, 'failed', 'Beklenen içerik görünmedi');
    expect(ledger.countToday()).toBe(1);
  });

  it('gerçek denemeleri saymaya DEVAM eder', () => {
    // Limit koruması gevşetildi — fazla gevşemediğini doğrula.
    for (const [i, site] of ['a', 'b', 'c'].entries()) {
      const id = ledger.startAttempt(`site-${site}`, `run-${i}`);
      ledger.finishAttempt(id, 'failed', 'Beklenen içerik görünmedi');
    }
    expect(ledger.countToday()).toBe(3);
  });
});

describe('kimlik bilgileri', () => {
  it('kaydeder ve günceller', () => {
    ledger.saveCredentials('site-a', 'a@b.com', 'user1', 1);
    expect(ledger.credentials('site-a')?.username).toBe('user1');

    ledger.saveCredentials('site-a', 'a@b.com', 'user2', 2);
    const row = ledger.credentials('site-a');
    expect(row?.username).toBe('user2');
    expect(row?.pw_version).toBe(2);
  });

  it('şifreyi ASLA saklamaz', () => {
    ledger.saveCredentials('site-a', 'a@b.com', 'user1', 1);
    const row = ledger.credentials('site-a') as unknown as Record<string, unknown>;
    expect(Object.keys(row)).not.toContain('password');
  });

  it('profil URL’ini sonradan ekler', () => {
    ledger.saveCredentials('site-a', 'a@b.com', 'user1', 1);
    ledger.setProfileUrl('site-a', 'https://site-a.com/dashboard');
    expect(ledger.credentials('site-a')?.profile_url).toBe('https://site-a.com/dashboard');
  });
});

describe('görülen mailler', () => {
  it('aynı maili iki kez tüketmez', () => {
    expect(ledger.hasSeenMessage('msg-1')).toBe(false);
    ledger.markMessageSeen('msg-1', 'site-a');
    expect(ledger.hasSeenMessage('msg-1')).toBe(true);
  });

  it('aynı id tekrar işaretlenince patlamaz', () => {
    ledger.markMessageSeen('msg-1', 'site-a');
    expect(() => ledger.markMessageSeen('msg-1', 'site-a')).not.toThrow();
  });
});

describe('şema migrasyonu', () => {
  /** dry_run kolonu OLMAYAN eski bir veritabanı üretir. */
  function makeLegacyDb(file: string): void {
    const db = new Database(file);
    db.exec(`
      CREATE TABLE attempts (
        id          INTEGER PRIMARY KEY AUTOINCREMENT,
        site_id     TEXT NOT NULL,
        run_id      TEXT NOT NULL,
        status      TEXT NOT NULL,
        started_at  INTEGER NOT NULL,
        finished_at INTEGER,
        note        TEXT,
        terminal    INTEGER NOT NULL DEFAULT 0
      );
    `);
    db.prepare(
      'INSERT INTO attempts (site_id, run_id, status, started_at) VALUES (?, ?, ?, ?)',
    ).run('eski-site', 'eski-run', 'completed', Date.now());
    db.close();
  }

  it('eski veritabanına dry_run kolonunu ekler ve veriyi korur', () => {
    const file = join(dir, 'legacy.sqlite');
    makeLegacyDb(file);

    // Ledger açılışı migrasyonu çalıştırır.
    const migrated = new Ledger(file);
    migrated.close();

    // Sonucu bağımsız bir bağlantıyla doğrula.
    const check = new Database(file, { readonly: true });
    try {
      const cols = (check.prepare('PRAGMA table_info(attempts)').all() as Array<{ name: string }>)
        .map((c) => c.name);
      expect(cols).toContain('dry_run');

      // Mevcut satır kaybolmamalı; eski satırlar "gerçek deneme" sayılır
      // (dry-run olup olmadıklarını bilmiyoruz).
      const row = check.prepare('SELECT site_id, dry_run FROM attempts').get() as {
        site_id: string;
        dry_run: number;
      };
      expect(row.site_id).toBe('eski-site');
      expect(row.dry_run).toBe(0);
    } finally {
      check.close();
    }
  });

  it('ikinci açılışta ALTER TABLE tekrar çalışmaz', () => {
    const file = join(dir, 'twice.sqlite');
    makeLegacyDb(file);

    const first = new Ledger(file);
    first.close();
    // Kolon zaten varken tekrar eklemeye çalışmak SQLite hatası verirdi.
    expect(() => {
      const second = new Ledger(file);
      second.close();
    }).not.toThrow();
  });
});

describe('ürünler arası e-posta çakışması', () => {
  // site_id kolonu hesap anahtarını tutuyor: varsayılan ürün için yalın
  // siteId, diğer ürünler için `urun@site`.

  it('aynı sitede aynı e-postayı kullanan başka ürün hesabını bulur', () => {
    ledger.saveCredentials('awwwards', 'ortak@x.com', 'geonew_awwwards', 1);
    expect(ledger.otherAccountWithEmail('awwwards', 'acme@awwwards', 'ortak@x.com')).toBe('awwwards');
  });

  it('diğer ürün önce kaydolduysa varsayılan ürün de çakışmayı görür', () => {
    ledger.saveCredentials('acme@awwwards', 'ortak@x.com', 'acme_awwwards', 1);
    expect(ledger.otherAccountWithEmail('awwwards', 'awwwards', 'ortak@x.com')).toBe('acme@awwwards');
  });

  it('farklı e-postada çakışma yok', () => {
    ledger.saveCredentials('awwwards', 'ortak@x.com', 'geonew_awwwards', 1);
    expect(ledger.otherAccountWithEmail('awwwards', 'acme@awwwards', 'acme@x.com')).toBeNull();
  });

  it('kendi hesabını çakışma saymaz', () => {
    ledger.saveCredentials('acme@awwwards', 'ortak@x.com', 'acme_awwwards', 1);
    expect(ledger.otherAccountWithEmail('awwwards', 'acme@awwwards', 'ortak@x.com')).toBeNull();
  });

  it('başka sitedeki aynı e-posta çakışma değildir', () => {
    // "betalist" anahtarı "awwwards" sitesine ait değil; LIKE '%@awwwards'
    // yalnızca @awwwards ile BİTEN anahtarları eşlemeli.
    ledger.saveCredentials('betalist', 'ortak@x.com', 'geonew_betalist', 1);
    ledger.saveCredentials('acme@betalist', 'ortak@x.com', 'acme_betalist', 1);
    expect(ledger.otherAccountWithEmail('awwwards', 'awwwards', 'ortak@x.com')).toBeNull();
  });
});
