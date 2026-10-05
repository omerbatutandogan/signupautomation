import { describe, expect, it } from 'vitest';
import {
  buildProductRows,
  buildScanProgress,
  classifyConfig,
  deriveAccounts,
  parseDiscoveryFile,
  parseProgressLog,
  splitAccountKey,
  type LedgerAttempt,
  type LedgerCredential,
} from '../src/sync/mappers.js';

/**
 * Panel senkronunun saf dönüştürmeleri.
 *
 * Örnekler GERÇEK ledger'daki durumlardan (2026-10-04): hangi satırın
 * "hesap açıldı" sayılacağı panelin en görünür rakamı; yanlış sayılırsa
 * Emre'ye olmayan hesaplar gösterilir.
 */

let nextId = 1;
function attempt(siteId: string, status: string, note: string | null, opts: Partial<LedgerAttempt> = {}): LedgerAttempt {
  const id = nextId++;
  return {
    id,
    site_id: siteId,
    run_id: `run-${id}`,
    status,
    started_at: 1_790_000_000_000 + id * 1000,
    finished_at: 1_790_000_000_500 + id * 1000,
    note,
    terminal: 1,
    dry_run: 0,
    ...opts,
  };
}
function cred(siteId: string, email = '06mertozkan@gmail.com', extra: Partial<LedgerCredential> = {}): LedgerCredential {
  return { site_id: siteId, email, username: `geonew_${siteId}`.slice(0, 15), pw_version: 1, created_at: 1, profile_url: null, ...extra };
}

describe('deriveAccounts', () => {
  const configModes = new Map([
    ['awwwards', 'link'],
    ['360quadrants', 'none'],
  ]);

  it('yalnızca gerçek (dry-run olmayan) "completed" denemesi olan hesapları sayar', () => {
    const accounts = deriveAccounts(
      [
        attempt('podbean', 'completed', 'dry-run', { dry_run: 1 }), // yalnız dry-run
        attempt('alternativeto', 'failed', "Selector bulunamadı: input[type='email']"),
        attempt('10words', 'completed', 'e-posta doğrulaması gerekmiyor'),
      ],
      // Kimlik kaydı dry-run'da da yazılıyor: kayıt var diye hesap var SAYILMAZ.
      [cred('podbean'), cred('alternativeto'), cred('10words', 'johnkevinsmith0@gmail.com')],
      configModes,
    );
    expect(accounts.map((a) => a.site_id)).toEqual(['10words']);
    expect(accounts[0]).toMatchObject({
      product_id: 'geo-new',
      email: 'johnkevinsmith0@gmail.com',
      status: 'opened',
      verification: 'none',
      password_source: 'derived',
    });
  });

  it('açılış olayı İLK completed denemesidir (sonraki "zaten mevcut" onu ezmez)', () => {
    const opening = attempt('alternative', 'completed', 'e-posta doğrulaması gerekmiyor');
    const accounts = deriveAccounts(
      [
        attempt('alternative', 'failed', 'Beklenen içerik görünmedi', { started_at: opening.started_at - 5000 }),
        opening,
        attempt('alternative', 'completed', 'Hesap zaten mevcut (daha önce açılmış)'),
      ],
      [cred('alternative')],
      configModes,
    );
    expect(accounts).toHaveLength(1);
    expect(accounts[0]).toMatchObject({ status: 'opened', verification: 'none' });
    expect(accounts[0]?.opened_at).toBe(new Date(opening.finished_at as number).toISOString());
  });

  it('ilk completed "Hesap zaten mevcut" ise hesap bizden önce vardı', () => {
    const [ontoplist] = deriveAccounts(
      [attempt('ontoplist', 'completed', 'Hesap zaten mevcut (daha önce açılmış)')],
      [cred('ontoplist')],
      configModes,
    );
    expect(ontoplist).toMatchObject({ status: 'already_existed', verification: null, password_source: 'derived' });
  });

  it('"şifre kullanıcıda" notu türetilen şifrenin ÇALIŞMADIĞINI işaretler (betalist)', () => {
    const [betalist] = deriveAccounts(
      [attempt('betalist', 'completed', 'Hesap zaten mevcut (daha önce açılmış) — şifre kullanıcıda, türetilen şifre DEĞİL')],
      [cred('betalist')],
      configModes,
    );
    expect(betalist).toMatchObject({ status: 'already_existed', password_source: 'user_held' });
  });

  it('not boşsa doğrulama config\'in modundan gelir (awwwards: link)', () => {
    const [awwwards] = deriveAccounts(
      [attempt('awwwards', 'completed', null)],
      [cred('awwwards', undefined, { profile_url: 'https://www.awwwards.com/profile/x' })],
      configModes,
    );
    expect(awwwards).toMatchObject({ status: 'opened', verification: 'link', profile_url: 'https://www.awwwards.com/profile/x' });
  });

  it('DOĞRULANMAMIŞ notu hesabın doğrulanmadığını taşır', () => {
    const [x] = deriveAccounts(
      [attempt('some-site', 'completed', 'DOĞRULANMAMIŞ: doğrulama maili gelmedi')],
      [cred('some-site')],
      configModes,
    );
    expect(x?.verification).toBe('unverified');
  });

  it('başka ürünün hesabı urun@site anahtarından ayrılır', () => {
    const [acct] = deriveAccounts(
      [attempt('acme-crm@10words', 'completed', 'e-posta doğrulaması gerekmiyor')],
      [cred('acme-crm@10words', 'acme@gmail.com')],
      configModes,
    );
    expect(acct).toMatchObject({ product_id: 'acme-crm', site_id: '10words', email: 'acme@gmail.com' });
  });
});

describe('splitAccountKey', () => {
  it('yalın anahtar varsayılan ürüne aittir', () => {
    expect(splitAccountKey('betalist')).toEqual({ productId: 'geo-new', siteId: 'betalist' });
  });
  it('urun@site ayrılır', () => {
    expect(splitAccountKey('acme-crm@webwiki-de')).toEqual({ productId: 'acme-crm', siteId: 'webwiki-de' });
  });
});

describe('classifyConfig', () => {
  it('doğrulanmamış taslak', () => {
    expect(classifyConfig({ notes: 'OTOMATİK ÜRETİLDİ — doğrulanmadı Keşif: direct-path' })).toBe('draft_unverified');
  });
  it('taşınma onayı her şeyden önce gelir (dry-run kaldıramaz)', () => {
    expect(classifyConfig({ notes: 'Doğrulandı (dry-run, 1.10.2026) TAŞINMA ONAYI BEKLİYOR' })).toBe('awaiting_move_approval');
    expect(classifyConfig({ notes: 'OTOMATİK ÜRETİLDİ — doğrulanmadı TAŞINMA ONAYI BEKLİYOR' })).toBe('awaiting_move_approval');
  });
  it('damgasız config doğrulanmıştır', () => {
    expect(classifyConfig({ notes: 'Selector\'lar gerçek DOM\'dan doğrulandı.' })).toBe('verified');
    expect(classifyConfig({})).toBe('verified');
  });
});

describe('parseDiscoveryFile', () => {
  it('geçerli dosyayı satırlara çevirir', () => {
    const parsed = parseDiscoveryFile(
      'Deals ',
      JSON.stringify({ entries: { a: { siteId: 'a', outcome: 'generated', signupUrl: 'https://a/x', at: 1_790_000_000_000 }, b: { siteId: 'b', outcome: 'no_form', reason: 'yok', at: 1 } } }),
    );
    expect(parsed?.rows).toHaveLength(2);
    expect(parsed?.dropped).toBe(0);
    expect(parsed?.rows[0]).toEqual({
      tab: 'Deals ',
      site_id: 'a',
      outcome: 'generated',
      reason: null,
      signup_url: 'https://a/x',
      discovered_at: new Date(1_790_000_000_000).toISOString(),
    });
  });

  it('yarım yazılmış dosyada null döner (tarama dosyayı atomik yazmıyor)', () => {
    expect(parseDiscoveryFile('SaaS', '{"entries":{"a":{"siteId":"a","outco')).toBeNull();
  });

  it('bilinmeyen sonucu satır olarak almaz ama SAYAR (sessizce kaybolmasın)', () => {
    const parsed = parseDiscoveryFile(
      'SaaS',
      JSON.stringify({ entries: { a: { siteId: 'a', outcome: 'weird', at: 1 }, b: { siteId: 'b', outcome: 'no_form', at: 1 }, c: { outcome: 'no_form' } } }),
    );
    expect(parsed?.rows.map((r) => r.site_id)).toEqual(['b']);
    expect(parsed?.dropped).toBe(2);
  });
});

describe('buildScanProgress', () => {
  const row = (tab: string, site: string) => ({ tab, site_id: site, outcome: 'no_form' as const, reason: null, signup_url: null, discovered_at: null });
  const progress = new Map([
    ['SaaS', { startedAt: '2026-09-30 04:05:31', finishedAt: '2026-09-30 19:11:49' }],
    ['Forums', { startedAt: '2026-10-01 15:09:09', finishedAt: null }],
  ]);

  it('sekme başına taranan sayısını ve tarihleri verir; Sheet okunmadıysa total_rows yok', () => {
    const rows = buildScanProgress({ discoveries: [row('SaaS', 'a'), row('SaaS', 'b')], skippedTabs: [], totalByTab: null, progress });
    expect(rows.map((r) => r.tab)).toEqual(['Forums', 'SaaS']);
    expect(rows[1]).toMatchObject({ tab: 'SaaS', scanned: 2 });
    expect(rows[1]).not.toHaveProperty('total_rows');
    expect(rows[0]).toMatchObject({ tab: 'Forums', scanned: 0, finished_at: null });
    expect(rows[1]?.finished_at).toBe(new Date('2026-09-30T19:11:49').toISOString());
  });

  it('Sheet okunduysa total_rows eklenir', () => {
    const rows = buildScanProgress({ discoveries: [row('SaaS', 'a')], skippedTabs: [], totalByTab: new Map([['SaaS', 168]]), progress: new Map() });
    expect(rows).toEqual([{ tab: 'SaaS', total_rows: 168, scanned: 1, started_at: null, finished_at: null }]);
  });

  it('dosyası yarım okunan sekme için satır üretmez (0 taranmış yazmak yanlış olurdu)', () => {
    // Forums dosyası bu turda okunamadı: taranan sayısı bilinmiyor.
    const rows = buildScanProgress({
      discoveries: [row('SaaS', 'a')],
      skippedTabs: ['Forums'],
      totalByTab: new Map([['SaaS', 168], ['Forums', 499]]),
      progress,
    });
    expect(rows.map((r) => r.tab)).toEqual(['SaaS']);
  });
});

describe('parseProgressLog', () => {
  it('sekme başına ilk başlangıcı ve son bitişi çıkarır (yeniden başlatma dahil)', () => {
    const log = [
      '2026-09-30 04:05:31 BAŞLADI [SaaS]',
      '2026-09-30 17:04:55 YENİDEN BAŞLATILDI (bekçi eklendi)',
      '2026-09-30 17:04:56 BAŞLADI [SaaS]',
      '2026-09-30 19:11:49 BİTTİ [SaaS] exit=0',
      '2026-10-01 21:25:10 BAŞLADI [Deals ]',
      '2026-10-03 21:53:08 TEKRAR [High DA Profile]',
    ].join('\n');
    const p = parseProgressLog(log);
    expect(p.get('SaaS')).toEqual({ startedAt: '2026-09-30 04:05:31', finishedAt: '2026-09-30 19:11:49' });
    expect(p.get('Deals ')).toEqual({ startedAt: '2026-10-01 21:25:10', finishedAt: null });
    expect(p.has('High DA Profile')).toBe(false);
  });
});

describe('buildProductRows', () => {
  const geo = { id: 'geo-new', status: 'ready' as const, profile: { companyName: 'geo.new' } };

  it('profil dosyası olan ürünü dosyadan alır', () => {
    expect(buildProductRows([geo], [], ['geo-new'])).toEqual([geo]);
  });

  it('hesabı olup profil dosyası hiç olmayan ürüne boş taslak açar (yabancı anahtar)', () => {
    expect(buildProductRows([geo], [], ['geo-new', 'acme-crm', 'acme-crm'])).toEqual([
      geo,
      { id: 'acme-crm', status: 'draft', profile: {} },
    ]);
  });

  it('dosyası OKUNAMAYAN ürün için satır üretmez: veritabanındaki iyi satır ezilmez', () => {
    // geo-new.json yarım kaydedilmiş. Boş taslak yazılsaydı ürün "ready"den düşer,
    // kuyruk sıfırlanır, kart adını kaybederdi — hesapları olduğu hâlde.
    expect(buildProductRows([], ['geo-new'], ['geo-new'])).toEqual([]);
    expect(buildProductRows([], ['geo-new'], [])).toEqual([]);
  });

  it('okunamayan ürün diğer ürünlerin satırlarını etkilemez', () => {
    const rows = buildProductRows([geo], ['broken-one'], ['geo-new', 'broken-one', 'orphan']);
    expect(rows.map((r) => r.id)).toEqual(['geo-new', 'orphan']);
  });

  it('hesap yoksa yalnızca dosyalar', () => {
    expect(buildProductRows([geo], [], [])).toEqual([geo]);
    expect(buildProductRows([], [], [])).toEqual([]);
  });
});
