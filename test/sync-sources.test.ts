import { existsSync, mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import { describe, expect, it } from 'vitest';
import { MOVE_MARKER } from '../src/core/markers.js';
import { UNVERIFIED_MARKER } from '../src/discovery/generate-config.js';
import { readConfigs, readDiscoveries, readLedger, readProducts, readProgress, sourcePaths } from '../src/sync/sources.js';

/**
 * Senkronun kaynak okuyucuları — gerçek dosyalarla, geçici dizinde.
 *
 * Kaynaklar canlı sistemin: tarama dosyaları atomik olmayan biçimde yazılıyor,
 * config'ler elle düzenleniyor, profil dosyaları yarım kaydedilebiliyor. Tek
 * bir bozuk dosya senkronun TAMAMINI durdurmamalı ve hiçbir okuyucu kaynağa
 * yazmamalı.
 */

function scratch(): string {
  return mkdtempSync(join(tmpdir(), 'sync-sources-'));
}

const validProfile = {
  companyName: 'Acme CRM',
  legalName: 'Acme Inc.',
  website: 'https://acme.example',
  tagline: 'CRM for everyone',
  descriptions: { short: 'short', medium: 'medium', long: 'long' },
  category: { primary: 'CRM', aliases: ['sales'] },
  logo: {},
  contact: { firstName: 'A', lastName: 'B', role: 'CEO', email: 'a@acme.example' },
  socials: {},
  pricing: 'Free',
  foundedYear: 2024,
};

describe('readProducts', () => {
  it('geçerli profil ready, eksik profil draft olur', async () => {
    const dir = scratch();
    writeFileSync(join(dir, 'acme-crm.json'), JSON.stringify(validProfile));
    writeFileSync(join(dir, 'half-done.json'), JSON.stringify({ companyName: 'Half' }));
    const { rows, skipped, unreadableIds } = await readProducts(dir);
    expect(rows.map((r) => [r.id, r.status])).toEqual([['acme-crm', 'ready'], ['half-done', 'draft']]);
    expect(skipped).toEqual([]);
    expect(unreadableIds).toEqual([]);
  });

  it('bozuk JSON ya da ürün id\'si olamayacak dosya senkronu durdurmaz, atlanır ve bildirilir', async () => {
    const dir = scratch();
    writeFileSync(join(dir, 'good.json'), JSON.stringify(validProfile));
    writeFileSync(join(dir, 'torn.json'), '{"companyName":"Torn","descr'); // yarım kaydedilmiş
    writeFileSync(join(dir, 'profile.example.json'), '{}'); // id olamaz (nokta)
    writeFileSync(join(dir, 'Bad_Id.json'), '{}'); // id olamaz (büyük harf, alt çizgi)
    const { rows, skipped, unreadableIds } = await readProducts(dir);
    expect(rows.map((r) => r.id)).toEqual(['good']);
    expect(skipped).toHaveLength(3);
    // Yalnızca GEÇERLİ id'li ama okunamayan dosya "okunamayan ürün" sayılır: veritabanı
    // satırı korunur. id olamayacak adlar ürün değildir, korunacak satırları yoktur.
    expect(unreadableIds).toEqual(['torn']);
    expect(skipped.join('\n')).toMatch(/torn\.json/);
    expect(skipped.join('\n')).toMatch(/profile\.example\.json: not a product id/);
    expect(skipped.join('\n')).toMatch(/Bad_Id\.json: not a product id/);
  });

  it('profil dizini yoksa boş döner', async () => {
    expect(await readProducts(join(scratch(), 'yok'))).toEqual({ rows: [], skipped: [], unreadableIds: [] });
  });
});

describe('readConfigs', () => {
  it('durumu notlardaki damgalardan çıkarır; bozuk dosya "invalid" satırı olur', async () => {
    const dir = scratch();
    writeFileSync(join(dir, 'hand-written.json'), JSON.stringify({ risk: 'low', verification: { mode: 'link' }, signupUrl: 'https://a/x', notes: 'elle yazıldı' }));
    writeFileSync(join(dir, 'draft.json'), JSON.stringify({ notes: `OTOMATİK ÜRETİLDİ — ${UNVERIFIED_MARKER}` }));
    writeFileSync(join(dir, 'moved.json'), JSON.stringify({ notes: `${UNVERIFIED_MARKER} ${MOVE_MARKER}`, risk: 'high' }));
    writeFileSync(join(dir, 'broken.json'), '{"notes": "yarım');
    writeFileSync(join(dir, 'readme.txt'), 'json değil'); // yok sayılır

    const rows = await readConfigs(dir);
    expect(rows.map((r) => [r.site_id, r.state])).toEqual([
      ['broken', 'invalid'],
      ['draft', 'draft_unverified'],
      ['hand-written', 'verified'],
      ['moved', 'awaiting_move_approval'],
    ]);
    const byId = new Map(rows.map((r) => [r.site_id, r]));
    expect(byId.get('hand-written')).toMatchObject({ risk: 'low', verification_mode: 'link', signup_url: 'https://a/x', parse_error: null });
    expect(byId.get('broken')?.parse_error).toBeTruthy();
    expect(byId.get('broken')?.config).toBeNull();
    // Özet dosyanın tamamından: tek karakter değişirse senkron yeniden yazar.
    expect(byId.get('draft')?.content_hash).toMatch(/^[0-9a-f]{64}$/);
    expect(new Set(rows.map((r) => r.content_hash)).size).toBe(rows.length);
  });
});

describe('readDiscoveries', () => {
  const entry = (siteId: string, outcome: string) => ({ siteId, outcome, at: 1_790_000_000_000 });

  it('sekme adını dosya adından alır (sondaki boşluk dahil); yarım dosyayı atlar; tanınmayan sonucu sayar', async () => {
    const dir = scratch();
    writeFileSync(join(dir, 'discovery-Deals .json'), JSON.stringify({ entries: { a: entry('a', 'generated'), b: entry('b', 'no_form') } }));
    writeFileSync(join(dir, 'discovery-SaaS.json'), JSON.stringify({ entries: { c: entry('c', 'no_form'), d: entry('d', 'brand_new_outcome') } }));
    writeFileSync(join(dir, 'discovery-Forums.json'), '{"entries":{"e":{"siteId":"e","outco'); // tarama yazarken okundu
    writeFileSync(join(dir, 'ledger.sqlite'), ''); // ilgisiz dosya

    const read = await readDiscoveries(dir);
    expect(read.rows.map((r) => `${r.tab}|${r.site_id}`).sort()).toEqual(['Deals |a', 'Deals |b', 'SaaS|c']);
    expect(read.skippedTabs).toEqual(['Forums']);
    expect(read.dropped).toBe(1);
  });
});

describe('readProgress', () => {
  it('günlük dosyası yoksa boş harita döner', async () => {
    expect((await readProgress(scratch())).size).toBe(0);
  });

  it('sekme başına ilk başlangıcı ve son bitişi okur', async () => {
    const dir = scratch();
    mkdirSync(join(dir, 'scan-logs'));
    writeFileSync(
      join(dir, 'scan-logs', '_progress.log'),
      ['2026-09-30 04:05:31 BAŞLADI [SaaS]', '2026-09-30 19:11:49 BİTTİ [SaaS] exit=0'].join('\n'),
    );
    expect((await readProgress(dir)).get('SaaS')).toEqual({ startedAt: '2026-09-30 04:05:31', finishedAt: '2026-09-30 19:11:49' });
  });
});

describe('readLedger', () => {
  function makeLedger(path: string) {
    const db = new Database(path);
    db.exec(`
      CREATE TABLE attempts (id INTEGER PRIMARY KEY, site_id TEXT, run_id TEXT, status TEXT, started_at INTEGER, finished_at INTEGER, note TEXT, terminal INTEGER, dry_run INTEGER);
      CREATE TABLE credentials (site_id TEXT PRIMARY KEY, email TEXT, username TEXT, pw_version INTEGER, created_at INTEGER, profile_url TEXT);
      INSERT INTO attempts VALUES (1, 'betalist', 'r1', 'completed', 1790000000000, 1790000001000, 'ok', 1, 0);
      INSERT INTO credentials VALUES ('betalist', 'a@b.c', 'geonew_betalist', 1, 1790000000000, NULL);
    `);
    db.close();
  }

  it('satırları okur', () => {
    const path = join(scratch(), 'ledger.sqlite');
    makeLedger(path);
    const { attempts, credentials } = readLedger(path);
    expect(attempts).toHaveLength(1);
    expect(attempts[0]).toMatchObject({ site_id: 'betalist', status: 'completed', terminal: 1, dry_run: 0 });
    expect(credentials[0]).toMatchObject({ site_id: 'betalist', username: 'geonew_betalist' });
  });

  it('olmayan ledger\'ı OLUŞTURMAZ, hata verir (yanlış --source boş ledger yaratmasın)', () => {
    const path = join(scratch(), 'data', 'ledger.sqlite');
    mkdirSync(join(path, '..'));
    expect(() => readLedger(path)).toThrow();
    expect(existsSync(path)).toBe(false);
  });

  it('salt-okunur açar: okuyucu aynı bağlantıyla yazamaz', () => {
    const path = join(scratch(), 'ledger.sqlite');
    makeLedger(path);
    const ro = new Database(path, { readonly: true, fileMustExist: true });
    expect(() => ro.exec("INSERT INTO attempts (id, site_id) VALUES (2, 'x')")).toThrow(/readonly/i);
    ro.close();
  });
});

describe('sourcePaths', () => {
  it('canlı dizindeki konumları verir', () => {
    expect(sourcePaths('/live')).toEqual({
      ledger: '/live/data/ledger.sqlite',
      dataDir: '/live/data',
      sitesDir: '/live/src/sites',
      profileDir: '/live/src/profile',
    });
  });
});
