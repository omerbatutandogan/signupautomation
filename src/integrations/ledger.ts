/**
 * SQLite ledger — kilit, idempotency ve kimlik bilgisi kaydı.
 *
 * Kilidin SQLite'ta olmasının sebebi: INSERT atomik. Sheet'te atomik
 * karşılaştır-değiştir yok, read-modify-write yarışı var — o yüzden Sheet
 * (Faz 2'de) yalnızca insan görünürlüğü için, otorite burası.
 *
 * better-sqlite3 kullanılıyor: node:sqlite (Node 22 yerleşik) denendi ama
 * vitest'in Vite tabanlı transform hattı yerleşik modülü çözemiyor
 * ("Failed to load url sqlite") ve testler hiç çalışmıyordu. Test
 * edilemeyen bir kilit mekanizması, idempotency garantisi vermez.
 */

import Database from 'better-sqlite3';
import type { Database as DatabaseType } from 'better-sqlite3';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { env } from '../config.js';
import type { SiteId, TerminalStatus } from '../core/types.js';

const DB_PATH = 'data/ledger.sqlite';

export interface AttemptRow {
  id: number;
  site_id: string;
  run_id: string;
  status: string;
  started_at: number;
  finished_at: number | null;
  note: string | null;
  terminal: number;
}

export interface CredentialRow {
  site_id: string;
  email: string;
  username: string;
  pw_version: number;
  created_at: number;
  profile_url: string | null;
}

/** Bir daha otomatik denenmeyecek sonuçlar. */
const TERMINAL_RESULTS: ReadonlySet<TerminalStatus> = new Set<TerminalStatus>([
  'completed',
  'failed',
  'manual',
]);

export class Ledger {
  private readonly db: DatabaseType;

  constructor(path: string = DB_PATH) {
    mkdirSync(dirname(path), { recursive: true });
    this.db = new Database(path);
    this.db.pragma('journal_mode = WAL');
    this.migrate();
    this.reapStaleLocks();
  }

  private migrate(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS locks (
        site_id    TEXT PRIMARY KEY,
        run_id     TEXT NOT NULL,
        claimed_at INTEGER NOT NULL,
        expires_at INTEGER NOT NULL
      );

      CREATE TABLE IF NOT EXISTS attempts (
        id          INTEGER PRIMARY KEY AUTOINCREMENT,
        site_id     TEXT NOT NULL,
        run_id      TEXT NOT NULL,
        status      TEXT NOT NULL,
        started_at  INTEGER NOT NULL,
        finished_at INTEGER,
        note        TEXT,
        terminal    INTEGER NOT NULL DEFAULT 0,
        dry_run     INTEGER NOT NULL DEFAULT 0
      );
      CREATE INDEX IF NOT EXISTS idx_attempts_site ON attempts(site_id);
      CREATE INDEX IF NOT EXISTS idx_attempts_started ON attempts(started_at);

      CREATE TABLE IF NOT EXISTS credentials (
        site_id     TEXT PRIMARY KEY,
        email       TEXT NOT NULL,
        username    TEXT NOT NULL,
        pw_version  INTEGER NOT NULL DEFAULT 1,
        created_at  INTEGER NOT NULL,
        profile_url TEXT
      );

      -- Listeleme (submission) denemeleri. attempts'ten AYRI: attempts hesap AÇMA sonucunu
      -- tutar ve terminal sonuçlar yeniden denemeyi engeller; listeleme aynı anahtarı
      -- kullansaydı hesap kaydını ve paneldeki hesap türetmesini bozardı.
      CREATE TABLE IF NOT EXISTS submissions (
        id          INTEGER PRIMARY KEY AUTOINCREMENT,
        account_key TEXT NOT NULL,
        run_id      TEXT NOT NULL,
        status      TEXT NOT NULL,
        dry_run     INTEGER NOT NULL DEFAULT 0,
        started_at  INTEGER NOT NULL,
        finished_at INTEGER,
        note        TEXT,
        listing_url TEXT
      );
      CREATE INDEX IF NOT EXISTS idx_submissions_account ON submissions(account_key);

      CREATE TABLE IF NOT EXISTS seen_messages (
        message_id TEXT PRIMARY KEY,
        site_id    TEXT NOT NULL,
        seen_at    INTEGER NOT NULL
      );
    `);

    if (this.addColumnIfMissing('attempts', 'dry_run', 'INTEGER NOT NULL DEFAULT 0')) {
      // Kolon YENİ eklendi: geçmiş satırlarda dry-run bilgisi yalnızca
      // notta duruyor. Notu açıkça "dry-run" diyenleri işaretle —
      // yalnızca KESİN olanlar, tahmin yok. Notu başka şey diyen eski
      // dry-run'lar (captcha'da bitenler gibi) gerçek sayılmaya devam
      // eder; bu güvenli taraf.
      this.db.exec("UPDATE attempts SET dry_run = 1 WHERE note LIKE '%dry-run%'");
    }
  }

  /**
   * Mevcut tabloya kolon ekler; zaten varsa dokunmaz.
   *
   * CREATE TABLE IF NOT EXISTS eski veritabanlarını güncellemiyor —
   * dry_run kolonu eklendiğinde mevcut ledger'lar onsuz kalırdı.
   * DEFAULT 0 sayesinde eski satırlar "gerçek deneme" sayılır, ki
   * doğrusu da bu: dry-run olduklarını bilmiyoruz.
   */
  private addColumnIfMissing(table: string, column: string, definition: string): boolean {
    const cols = this.db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>;
    if (cols.some((c) => c.name === column)) return false;
    this.db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
    return true;
  }

  /**
   * TTL'i dolmuş kilitleri ve öksüz kalmış 'running' denemeleri temizler.
   *
   * Süreç çökerse (ya da kill edilirse) finally bloğu çalışmaz: kilit
   * TTL ile düşer ama attempts satırı sonsuza kadar 'running' kalır ve
   * ledger'ı kirletir. Burada onları da terminal olmayan 'error'a çeviriyoruz.
   */
  private reapStaleLocks(): number {
    const now = Date.now();
    const locks = this.db.prepare('DELETE FROM locks WHERE expires_at < ?').run(now)
      .changes as number;

    // Kilidi olmayan 'running' kayıtlar = sahipsiz. Terminal işaretlenmiyor,
    // böylece site yeniden denenebilir kalıyor.
    this.db
      .prepare(
        `UPDATE attempts SET status = 'error', finished_at = ?, note = 'süreç yarıda kesildi'
         WHERE status = 'running'
           AND site_id NOT IN (SELECT site_id FROM locks)`,
      )
      .run(now);

    // Listeleme için aynı kural (kilit anahtarı "<hesap>#submit") — ama sonuç FARKLI:
    // yarıda kesilen GERÇEK gönderim 'error' (yeniden denenebilir) değil 'unconfirmed'
    // olur. Süreç gönderim tıklandıktan sonra ölmüş olabilir; ürün yayınlanmış olabilir ve
    // otomatik yeniden deneme çift listeleme yapardı. Yarıda kesilen DRY-RUN zararsızdır.
    this.db
      .prepare(
        `UPDATE submissions
           SET status = CASE WHEN dry_run = 1 THEN 'error' ELSE 'unconfirmed' END,
               finished_at = ?,
               note = CASE WHEN dry_run = 1 THEN 'süreç yarıda kesildi'
                           ELSE 'süreç yarıda kesildi — yayınlanmış olabilir, elle kontrol et' END
         WHERE status = 'running'
           AND (account_key || '#submit') NOT IN (SELECT site_id FROM locks)`,
      )
      .run(now);

    return locks;
  }

  // ── Kilit ───────────────────────────────────────────────────────────────

  /** Atomik kilit alma. false → başka bir çalıştırma bu siteyi işliyor. */
  tryClaim(siteId: SiteId, runId: string, ttlMs: number = env.LOCK_TTL_MS): boolean {
    const now = Date.now();
    try {
      this.db
        .prepare('INSERT INTO locks (site_id, run_id, claimed_at, expires_at) VALUES (?, ?, ?, ?)')
        .run(siteId, runId, now, now + ttlMs);
      return true;
    } catch {
      // UNIQUE ihlali — kilit zaten alınmış.
      return false;
    }
  }

  release(siteId: SiteId): void {
    this.db.prepare('DELETE FROM locks WHERE site_id = ?').run(siteId);
  }

  activeLock(siteId: SiteId): { run_id: string; expires_at: number } | null {
    const row = this.db
      .prepare('SELECT run_id, expires_at FROM locks WHERE site_id = ?')
      .get(siteId) as { run_id: string; expires_at: number } | undefined;
    return row ?? null;
  }

  // ── Denemeler ───────────────────────────────────────────────────────────

  startAttempt(siteId: SiteId, runId: string, dryRun = false): number {
    const result = this.db
      .prepare(
        'INSERT INTO attempts (site_id, run_id, status, started_at, dry_run) VALUES (?, ?, ?, ?, ?)',
      )
      .run(siteId, runId, 'running', Date.now(), dryRun ? 1 : 0);
    return Number(result.lastInsertRowid);
  }

  finishAttempt(attemptId: number, status: TerminalStatus, note?: string): void {
    this.db
      .prepare('UPDATE attempts SET status = ?, finished_at = ?, note = ?, terminal = ? WHERE id = ?')
      .run(status, Date.now(), note ?? null, TERMINAL_RESULTS.has(status) ? 1 : 0, attemptId);
  }

  /**
   * Gerçekte AÇIK olan ama yanlış sonuçla kaydedilmiş bir hesabı "tamamlandı" olarak işler
   * (ör. kayıttan sonra oturum açık kaldı ama config doğrulama maili bekledi ve `failed` yazıldı).
   *
   * Yalnızca İNSAN kanıtıyla çağrılmalı (türetilen şifreyle giriş yapıldı gibi): kayıt, listeleme
   * akışının "hesap var" kapısını açar. Kimlik kaydı (credentials) şart; zaten tamamlanmışsa dokunmaz.
   * Satır başlangıcı bugünden ÖNCEYE yazılır: bu bir kayıt denemesi değil, günlük sınırı tüketmemeli.
   */
  adoptAccount(siteId: SiteId, note: string): 'adopted' | 'already_completed' | 'no_credentials' {
    if (!this.credentials(siteId)) return 'no_credentials';
    if (this.terminalResult(siteId)?.status === 'completed') return 'already_completed';
    const id = this.startAttempt(siteId, `adopt-${Date.now().toString(36)}`, false);
    this.finishAttempt(id, 'completed', note);
    const startOfDay = new Date();
    startOfDay.setHours(0, 0, 0, 0);
    this.db.prepare('UPDATE attempts SET started_at = ? WHERE id = ?').run(startOfDay.getTime() - 1, id);
    return 'adopted';
  }

  /**
   * Site daha önce terminal bir sonuca ulaştı mı?
   * Sheet yanlışlıkla sıfırlansa bile tekrar kayıt denemesini engeller.
   *
   * Dry-run'lar sayılmaz: submit etmedikleri için hesap açmıyorlar. Eskiden
   * başarılı dry-run "completed" dönüyordu; run-batch siteyi "zaten
   * bitmiş" diye atlıyor ve dry-run'ı Sheet'e "tamamlandı" yazıyordu.
   */
  terminalResult(siteId: SiteId): { status: string; note: string | null } | null {
    const row = this.db
      .prepare(
        'SELECT status, note FROM attempts WHERE site_id = ? AND terminal = 1 AND dry_run = 0 ORDER BY finished_at DESC, id DESC LIMIT 1',
      )
      .get(siteId) as { status: string; note: string | null } | undefined;
    return row ?? null;
  }

  /** Bugün başlatılan, atlanmamış deneme sayısı — günlük limit kapısı. */
  /**
   * Bugün yapılan GERÇEK kayıt denemesi sayısı.
   *
   * Dry-run hariç: submit etmediği için siteye kayıt trafiği üretmiyor
   * ve günlük limitin koruduğu "aynı IP'den kaç kayıt" sinyalini
   * etkilemiyor. Saymak, teşhis çalışmasını gerçek kotayla yarıştırıyordu.
   *
   * Ayrım dry_run KOLONUNDAN yapılıyor, not metninden değil: not sonuca
   * göre değişiyor ve captcha'da biten bir dry-run "Captcha insan
   * müdahalesi gerektiriyor" notuyla kaydedilip sayıma sızıyordu
   * (ledger 13/12 gösteriyordu).
   */
  countToday(): number {
    const startOfDay = new Date();
    startOfDay.setHours(0, 0, 0, 0);
    const row = this.db
      .prepare(
        `SELECT COUNT(*) AS n FROM attempts
         WHERE started_at >= ?
           AND status NOT LIKE 'skipped%'
           AND dry_run = 0`,
      )
      .get(startOfDay.getTime()) as { n: number };
    return row.n;
  }

  recentAttempts(limit = 20): AttemptRow[] {
    return this.db
      .prepare('SELECT * FROM attempts ORDER BY started_at DESC LIMIT ?')
      .all(limit) as unknown as AttemptRow[];
  }

  // ── Listeleme (submission) ──────────────────────────────────────────────

  startSubmission(accountKey: SiteId, runId: string, dryRun = false): number {
    const res = this.db
      .prepare(
        `INSERT INTO submissions (account_key, run_id, status, dry_run, started_at)
         VALUES (?, ?, 'running', ?, ?)`,
      )
      .run(accountKey, runId, dryRun ? 1 : 0, Date.now());
    return Number(res.lastInsertRowid);
  }

  finishSubmission(id: number, status: string, note?: string, listingUrl?: string): void {
    this.db
      .prepare('UPDATE submissions SET status = ?, finished_at = ?, note = ?, listing_url = ? WHERE id = ?')
      .run(status, Date.now(), note ?? null, listingUrl ?? null, id);
  }

  /**
   * Bu hesapla GERÇEK (dry-run olmayan) bir gönderim YAPILMIŞ OLABİLİR mi?
   *
   * Varsayılan ENGELLE: yalnızca 'failed' (hiçbir şeyin gönderilmediği kesin olan) satır
   * engellemez. 'completed', 'unconfirmed', hâlâ 'running' (süreç ölmüş olabilir),
   * 'error' ve her bilinmeyen durum engeller. Beyaz liste değil kara liste: yeni bir durum
   * eklenirse yanlışlıkla çift yayına izin vermesin.
   */
  liveSubmission(accountKey: SiteId): { status: string; listing_url: string | null; finished_at: number | null } | null {
    const row = this.db
      .prepare(
        `SELECT status, listing_url, finished_at FROM submissions
         WHERE account_key = ? AND dry_run = 0 AND status != 'failed'
         ORDER BY (status = 'completed') DESC, started_at DESC LIMIT 1`,
      )
      .get(accountKey) as { status: string; listing_url: string | null; finished_at: number | null } | undefined;
    return row ?? null;
  }

  /** Bugün başlatılan GERÇEK gönderim sayısı (kayıtlarla aynı günlük hız sınırı mantığı). */
  countLiveSubmissionsToday(): number {
    const startOfDay = new Date();
    startOfDay.setHours(0, 0, 0, 0);
    const row = this.db
      .prepare('SELECT COUNT(*) AS n FROM submissions WHERE dry_run = 0 AND started_at >= ?')
      .get(startOfDay.getTime()) as { n: number };
    return row.n;
  }

  recentSubmissions(limit = 20): Array<{
    id: number;
    account_key: string;
    status: string;
    dry_run: number;
    started_at: number;
    note: string | null;
    listing_url: string | null;
  }> {
    return this.db
      .prepare('SELECT id, account_key, status, dry_run, started_at, note, listing_url FROM submissions ORDER BY started_at DESC LIMIT ?')
      .all(limit) as never;
  }

  // ── Kimlik bilgileri ────────────────────────────────────────────────────

  /**
   * Submit'ten ÖNCE çağrılır: çökme halinde hangi kimlikle kayıt denendiği
   * kaybolmasın (şifre türetilebilir ama pw_version bilinmeli).
   */
  saveCredentials(siteId: SiteId, email: string, username: string, pwVersion: number): void {
    this.db
      .prepare(
        `INSERT INTO credentials (site_id, email, username, pw_version, created_at)
         VALUES (?, ?, ?, ?, ?)
         ON CONFLICT(site_id) DO UPDATE SET email = ?, username = ?, pw_version = ?`,
      )
      .run(siteId, email, username, pwVersion, Date.now(), email, username, pwVersion);
  }

  setProfileUrl(siteId: SiteId, url: string): void {
    this.db.prepare('UPDATE credentials SET profile_url = ? WHERE site_id = ?').run(url, siteId);
  }

  credentials(siteId: SiteId): CredentialRow | null {
    const row = this.db.prepare('SELECT * FROM credentials WHERE site_id = ?').get(siteId) as
      | CredentialRow
      | undefined;
    return row ?? null;
  }

  /**
   * Aynı sitede, aynı e-postayla açılmış BAŞKA bir ürün hesabı var mı?
   *
   * site_id kolonu hesap anahtarını tutuyor (identity/account.ts):
   * varsayılan ürün için yalın siteId, diğerleri için `urun@site`.
   * Aynı e-postayla ikinci ürün kaydı denenirse site "zaten kayıtlı" der
   * ve runner bunu başarı sayar — B ürünü, A'nın hesabıyla yanlışlıkla
   * "tamamlandı" işaretlenirdi. Varsa o hesabın anahtarını döndürür.
   */
  otherAccountWithEmail(siteId: string, ownKey: string, email: string): string | null {
    const row = this.db
      .prepare(
        `SELECT site_id FROM credentials
         WHERE email = ? AND site_id != ? AND (site_id = ? OR site_id LIKE ?)
         LIMIT 1`,
      )
      .get(email, ownKey, siteId, `%@${siteId}`) as { site_id: string } | undefined;
    return row?.site_id ?? null;
  }

  // ── Görülen mailler ─────────────────────────────────────────────────────

  /** Yeniden çalıştırma bayat bir doğrulama mailini tüketmesin. */
  markMessageSeen(messageId: string, siteId: SiteId): void {
    this.db
      .prepare('INSERT OR IGNORE INTO seen_messages (message_id, site_id, seen_at) VALUES (?, ?, ?)')
      .run(messageId, siteId, Date.now());
  }

  hasSeenMessage(messageId: string): boolean {
    const row = this.db
      .prepare('SELECT 1 AS hit FROM seen_messages WHERE message_id = ?')
      .get(messageId) as { hit: number } | undefined;
    return row !== undefined;
  }

  close(): void {
    this.db.close();
  }
}
