import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { annotate, DURUM } from '../src/discovery/annotate.js';
import { engineSignature, listingBlockerFromNotes, listingCaveat, loadAnnotateSources, rowInputFor, type SourcePaths } from '../src/discovery/annotate-sources.js';
import { Ledger } from '../src/integrations/ledger.js';

/**
 * Sheet etiketlemesinin girdileri: hesap, kesin takılma, listeleme durumu ve "aile engeli" çıkarımı.
 * Hepsi geçici dizinlerde ve gerçek bir (geçici) ledger dosyasında sınanır; gerçek veriye dokunulmaz.
 */

const created: string[] = [];
afterEach(async () => {
  await Promise.all(created.splice(0).map((d) => rm(d, { recursive: true, force: true })));
});

const UNVERIFIED = 'OTOMATİK ÜRETİLDİ — doğrulanmadı';
const IMAGE_NOTE = "Doğrulandı (dry-run). | 2026-10-10 GERÇEK denemede: kayıt formunda GÖRSEL captcha ('SecureImg') var; sistem görsel captcha'yı çözmüyor → hesap açılmadı.";
const HCAPTCHA_NOTE = '| 2026-10-10 GERÇEK denemede: hCaptcha: 2captcha 180 sn içinde çözemedi, sonra insan bekledi → manual.';

const fills = (...selectors: string[]) => selectors.map((selector) => ({ type: 'fill', selector, field: 'email' }));
const FAMILY_FORM = fills('#field-user', '#field-email', '#field-password');

async function env(
  sites: Record<string, object>,
  opts: { submissions?: Record<string, object>; ledger?: (l: Ledger) => void; verify?: object; discovery?: object } = {},
): Promise<SourcePaths> {
  const root = await mkdtemp(join(tmpdir(), 'annotate-src-'));
  created.push(root);
  const paths: SourcePaths = {
    sitesDir: join(root, 'sites'),
    submissionsDir: join(root, 'submissions'),
    ledgerPath: join(root, 'ledger.sqlite'),
    verifyDraftsPath: join(root, 'progress.json'),
    discoveryPath: join(root, 'discovery.json'),
  };
  await mkdir(paths.sitesDir);
  await mkdir(paths.submissionsDir);
  for (const [id, cfg] of Object.entries(sites)) await writeFile(join(paths.sitesDir, `${id}.json`), JSON.stringify({ id, name: id, risk: 'low', signupUrl: `https://${id}.example/signup`, steps: [], ...cfg }));
  for (const [id, cfg] of Object.entries(opts.submissions ?? {})) await writeFile(join(paths.submissionsDir, `${id}.json`), JSON.stringify({ id, ...cfg }));
  if (opts.verify) await writeFile(paths.verifyDraftsPath, JSON.stringify(opts.verify));
  if (opts.discovery) await writeFile(paths.discoveryPath, JSON.stringify(opts.discovery));
  const ledger = new Ledger(paths.ledgerPath);
  try {
    opts.ledger?.(ledger);
  } finally {
    ledger.close();
  }
  return paths;
}

const attempt = (l: Ledger, id: string, status: 'completed' | 'failed' | 'error' | 'manual', opts: { dry?: boolean; note?: string } = {}) => {
  const n = l.startAttempt(id, `run-${id}-${status}`, opts.dry === true);
  l.finishAttempt(n, status, opts.note);
};
const submission = (l: Ledger, id: string, status: string, opts: { dry?: boolean; url?: string } = {}) => {
  const n = l.startSubmission(id, `sub-${id}-${status}`, opts.dry === true);
  l.finishSubmission(n, status, undefined, opts.url);
};

describe('engineSignature', () => {
  it('en az 3 alan ve en az biri motora özgü seçiciyse parmak izi verir', () => {
    expect(engineSignature(FAMILY_FORM)).toBe('#field-user|#field-email|#field-password');
  });
  it('yalnızca jenerik seçiciler ya da 3\'ten az alan: aile belirtmez', () => {
    expect(engineSignature(fills('#email', '#password', '#username'))).toBeNull();
    expect(engineSignature(fills('#field-user', '#field-email'))).toBeNull();
  });
  it('fill dışındaki adımlar ve seçicisiz adımlar sayılmaz', () => {
    expect(engineSignature([{ type: 'goto' }, { type: 'click', selector: '#a' }, ...FAMILY_FORM])).toBe('#field-user|#field-email|#field-password');
  });
});

describe('listingBlockerFromNotes', () => {
  it('son "LİSTELEME:" bölümünü sınıf ve ayrıntı olarak ayırır', () => {
    expect(listingBlockerFromNotes('a | 2026-10-13 LİSTELEME: eski sınıf — eski ayrıntı | 2026-10-14 LİSTELEME: görsel doğrulama kodu (2. adım) — kodu insan yazmalı')).toEqual({
      blocker: 'Listeleme: görsel doğrulama kodu (2. adım)',
      blockerNote: 'kodu insan yazmalı',
    });
  });
  it('ayrıntısız bölüm ve bölüm yokluğu', () => {
    expect(listingBlockerFromNotes('x | LİSTELEME: form yok')).toEqual({ blocker: 'Listeleme: form yok' });
    expect(listingBlockerFromNotes('yalnızca kayıt notu')).toBeNull();
  });
});

describe('listingCaveat', () => {
  it('"DÜZELTME GEREKİYOR" ve "BEKLETİLİYOR: <neden>" işaretlerini uyarıya çevirir', () => {
    expect(listingCaveat('a | 2026-10-12 DÜZELTME GEREKİYOR: eski metin')).toMatch(/düzeltme bekliyor/);
    expect(listingCaveat('a | 2026-10-13 BEKLETİLİYOR: silme imkânı belirsiz; sahip karar verecek.')).toBe('Bilinçli bekletiliyor: silme imkânı belirsiz; sahip karar verecek');
    expect(listingCaveat('sıradan not')).toBeUndefined();
  });
});

describe('loadAnnotateSources', () => {
  it('hesap: yalnızca gerçek tamamlanmış deneme sayılır (dry-run ve atlananlar sayılmaz); "ürün@site" anahtarları dışarıda', async () => {
    const paths = await env({ real: {}, dry: {}, skipped: {} }, {
      ledger: (l) => {
        attempt(l, 'real', 'completed');
        attempt(l, 'real', 'completed', { dry: true, note: 'dry-run' }); // sonradan yapılan dry-run hesabı bozmaz
        attempt(l, 'dry', 'completed', { dry: true, note: 'dry-run' });
        attempt(l, 'skipped', 'manual');
        attempt(l, 'other-product@real', 'completed');
      },
    });
    const s = loadAnnotateSources(paths);
    expect([...s.withAccount]).toEqual(['real']);
  });

  it('kesin takılma: terminal gerçek deneme ve hesap yok; hesabı olan ya da yalnızca geçici hata alan takılı sayılmaz', async () => {
    const paths = await env({ stuck: {}, opened: {}, flaky: {}, dryonly: {} }, {
      ledger: (l) => {
        attempt(l, 'stuck', 'failed');
        attempt(l, 'opened', 'failed');
        attempt(l, 'opened', 'completed');
        attempt(l, 'flaky', 'error');
        attempt(l, 'dryonly', 'failed', { dry: true });
      },
    });
    const s = loadAnnotateSources(paths);
    expect([...s.blocked]).toEqual(['stuck']);
  });

  it('"şifre kullanıcıda" bilgisi sonradan yapılan sıradan bir yeniden koşuyla kaybolmaz; dry-run notu hiç sayılmaz', async () => {
    const paths = await env({ held: {}, dryonly: {} }, {
      ledger: (l) => {
        attempt(l, 'held', 'completed', { note: 'Hesap zaten mevcut (daha önce açılmış) — şifre kullanıcıda' });
        attempt(l, 'held', 'completed', { note: 'Hesap zaten mevcut (daha önce açılmış)' }); // sonraki yeniden koşu aynı bilgiyi taşımaz
        attempt(l, 'dryonly', 'completed');
        attempt(l, 'dryonly', 'completed', { dry: true, note: 'şifre kullanıcıda' }); // dry-run notu sayılmaz
      },
    });
    const s = loadAnnotateSources(paths);
    expect(s.accountNotes.get('held')).toMatch(/kullanıcıda/);
    expect(s.accountNotes.has('dryonly')).toBe(false);
  });

  it('hesap notu: şifre kullanıcıda ve doğrulanmamış hesap', async () => {
    const paths = await env(
      { betalike: {}, nomail: { verification: { mode: 'none', unverifiedAccount: true } }, plain: {} },
      {
        ledger: (l) => {
          attempt(l, 'betalike', 'completed', { note: 'Hesap zaten mevcut (daha önce açılmış) — şifre kullanıcıda, türetilen şifre DEĞİL' });
          attempt(l, 'nomail', 'completed');
          attempt(l, 'plain', 'completed');
        },
      },
    );
    const s = loadAnnotateSources(paths);
    expect(s.accountNotes.get('betalike')).toMatch(/kullanıcıda/);
    expect(s.accountNotes.get('nomail')).toMatch(/doğrulanmadı/);
    expect(s.accountNotes.has('plain')).toBe(false);
  });

  it('listeleme: gönderildi (adres, tarih, düzeltme uyarısı), doğrulanamadı, dry-run geçti, config yok + bilinen engel', async () => {
    const paths = await env(
      {
        sent: {},
        maybe: {},
        ready: {},
        dry_failed: {},
        blocked: { notes: '| 2026-10-13 LİSTELEME: görsel doğrulama kodu (2. adım) — kodu insan yazmalı' },
        norecord: {},
      },
      {
        submissions: { sent: { notes: 'x | DÜZELTME GEREKİYOR: eski metin' }, maybe: {}, ready: { notes: '| 2026-10-13 BEKLETİLİYOR: sahip karar verecek' }, dry_failed: {} },
        ledger: (l) => {
          submission(l, 'sent', 'completed', { dry: true });
          submission(l, 'sent', 'completed', { url: 'https://sent.example/tools/geo-new' });
          submission(l, 'maybe', 'unconfirmed');
          submission(l, 'ready', 'completed', { dry: true });
          submission(l, 'dry_failed', 'failed', { dry: true });
          submission(l, 'ready', 'failed'); // gerçek ama 'failed' = hiçbir şey gönderilmedi: durumu değiştirmez
        },
      },
    );
    const s = loadAnnotateSources(paths);
    expect(s.listings.get('sent')).toMatchObject({ state: 'sent', url: 'https://sent.example/tools/geo-new', caveat: expect.stringContaining('düzeltme bekliyor') });
    expect(s.listings.get('sent')?.date).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    expect(s.listings.get('maybe')).toMatchObject({ state: 'unconfirmed' });
    expect(s.listings.get('ready')).toMatchObject({ state: 'ready' });
    expect(s.listings.get('ready')?.caveat).toMatch(/bekletiliyor/);
    expect(s.listings.has('dry_failed')).toBe(false);
    expect(s.listings.get('blocked')).toMatchObject({ state: 'none', blocker: 'Listeleme: görsel doğrulama kodu (2. adım)', blockerNote: 'kodu insan yazmalı' });
    expect(s.listings.has('norecord')).toBe(false);
  });

  it('aile engeli: görsel captcha doğrulanmış sitenin form parmak izini taşıyan, denenmemiş siteler işaretlenir', async () => {
    const paths = await env(
      {
        source: { notes: IMAGE_NOTE, steps: FAMILY_FORM },
        sibling: { notes: 'Doğrulandı (dry-run).', steps: FAMILY_FORM },
        draft_sibling: { notes: UNVERIFIED, steps: FAMILY_FORM },
        has_account: { steps: FAMILY_FORM },
        other_engine: { steps: fills('#a', '#b', '#c') },
        generic_form: { steps: fills('#email', '#password', '#username') },
      },
      {
        ledger: (l) => {
          attempt(l, 'source', 'failed');
          attempt(l, 'has_account', 'completed');
        },
      },
    );
    const s = loadAnnotateSources(paths);
    expect([...s.familyBlocks.keys()].sort()).toEqual(['draft_sibling', 'sibling']);
    expect(s.familyBlocks.get('sibling')).toEqual({ sorun: 'Görsel captcha (aile)', sourceId: 'source' });
  });

  it('aile çıkarımı yalnızca motor düzeyindeki görsel captcha için: hCaptcha gibi siteye özgü engeller yayılmaz', async () => {
    const paths = await env(
      { source: { notes: HCAPTCHA_NOTE, steps: FAMILY_FORM }, sibling: { steps: FAMILY_FORM } },
      { ledger: (l) => attempt(l, 'source', 'manual') },
    );
    expect(loadAnnotateSources(paths).familyBlocks.size).toBe(0);
  });

  it('aile çıkarımı kaynağı gerçek denemede takılmış olmalı: yalnızca nottaki iddia yetmez', async () => {
    const paths = await env({ source: { notes: IMAGE_NOTE, steps: FAMILY_FORM }, sibling: { steps: FAMILY_FORM } });
    expect(loadAnnotateSources(paths).familyBlocks.size).toBe(0);
  });

  it('dosyalar yoksa boş döner (ilk kurulum, ledger yok)', () => {
    const s = loadAnnotateSources({ sitesDir: '/yok/a', submissionsDir: '/yok/b', ledgerPath: '/yok/c.sqlite', verifyDraftsPath: '/yok/d.json', discoveryPath: '/yok/e.json' });
    expect(s.configs.size + s.withAccount.size + s.listings.size + s.familyBlocks.size).toBe(0);
  });
});

describe('rowInputFor + annotate (uçtan uca)', () => {
  it('her durum doğru sınıfa düşer', async () => {
    const paths = await env(
      {
        listed: {},
        listready: {},
        account: { notes: '| 2026-10-13 LİSTELEME: görsel doğrulama kodu — insan yazmalı' },
        stuck: { notes: IMAGE_NOTE, steps: FAMILY_FORM },
        sibling: { notes: 'Doğrulandı (dry-run).', steps: FAMILY_FORM },
        ready: { notes: 'Doğrulandı (dry-run).' },
        draft: { notes: UNVERIFIED },
      },
      {
        submissions: { listed: {}, listready: {} },
        ledger: (l) => {
          attempt(l, 'listed', 'completed');
          attempt(l, 'listready', 'completed');
          attempt(l, 'account', 'completed');
          attempt(l, 'stuck', 'failed');
          submission(l, 'listed', 'completed', { url: 'https://listed.example/x' });
          submission(l, 'listready', 'completed', { dry: true });
        },
      },
    );
    const s = loadAnnotateSources(paths);
    const durum = (id: string) => annotate(rowInputFor(id, s)).durum;
    expect(durum('listed')).toBe(DURUM.LISTED);
    expect(durum('listready')).toBe(DURUM.LISTING_READY);
    expect(durum('account')).toBe(DURUM.ACCOUNT);
    expect(annotate(rowInputFor('account', s)).sorun).toBe('Listeleme: görsel doğrulama kodu');
    expect(durum('stuck')).toBe(DURUM.BLOCKED);
    expect(annotate(rowInputFor('stuck', s)).sorun).toBe('Görsel captcha (çözülmüyor)');
    expect(durum('sibling')).toBe(DURUM.FAMILY_BLOCK);
    expect(durum('ready')).toBe(DURUM.READY);
    expect(durum('draft')).toBe(DURUM.DRAFT_UNTESTED);
    expect(durum('unknown-site')).toBe(DURUM.NOT_SCANNED);
  });
});
