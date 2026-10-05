import { describe, expect, it } from 'vitest';
import { planSync } from '../src/sync/push.js';

/**
 * Senkron planı: mevcut satırlar × istenen satırlar → ekle / güncelle / dokunma.
 *
 * Senkron 2 dakikada bir çalışacak; değişmeyen satırı her turda yeniden
 * yazmak hem gereksiz yük hem de panelin "son güncelleme" bilgisini
 * anlamsızlaştırır. İkinci tur 0 değişiklik üretmeli.
 */

const spec = {
  keyColumns: ['tab', 'site_id'] as const,
  compareColumns: ['outcome', 'reason', 'discovered_at', 'meta'] as const,
  timeColumns: ['discovered_at'] as const,
};

describe('planSync', () => {
  it('yeni satırı ekler, değişeni günceller, aynısına dokunmaz', () => {
    const existing = [
      { tab: 'SaaS', site_id: 'a', outcome: 'no_form', reason: null, discovered_at: '2026-10-01T10:00:00+00:00', meta: null },
      { tab: 'SaaS', site_id: 'b', outcome: 'error', reason: 'x', discovered_at: '2026-10-01T10:00:00+00:00', meta: null },
    ];
    const desired = [
      { tab: 'SaaS', site_id: 'a', outcome: 'no_form', reason: null, discovered_at: '2026-10-01T10:00:00.000Z', meta: null },
      { tab: 'SaaS', site_id: 'b', outcome: 'generated', reason: null, discovered_at: '2026-10-03T10:00:00.000Z', meta: null },
      { tab: 'SaaS', site_id: 'c', outcome: 'bot_protected', reason: null, discovered_at: null, meta: null },
    ];
    const plan = planSync(existing, desired, spec);
    expect(plan.inserts.map((r) => r.site_id)).toEqual(['c']);
    expect(plan.updates.map((r) => r.site_id)).toEqual(['b']);
    expect(plan.unchanged).toBe(1);
  });

  it('aynı anı farklı yazan zaman damgalarını değişiklik saymaz', () => {
    // PostgREST "+00:00" ve mikrosaniye döndürür; biz "Z" ve milisaniye üretiriz.
    const plan = planSync(
      [{ tab: 't', site_id: 'a', outcome: 'x', reason: null, discovered_at: '2026-10-01T10:00:00.123+00:00', meta: null }],
      [{ tab: 't', site_id: 'a', outcome: 'x', reason: null, discovered_at: '2026-10-01T10:00:00.123Z', meta: null }],
      spec,
    );
    expect(plan.unchanged).toBe(1);
    expect(plan.updates).toEqual([]);
  });

  it('jsonb anahtar sırası farkını değişiklik saymaz', () => {
    // Postgres jsonb anahtarları yeniden sıralar.
    const plan = planSync(
      [{ tab: 't', site_id: 'a', outcome: 'x', reason: null, discovered_at: null, meta: { b: 1, a: { d: 2, c: [1, 2] } } }],
      [{ tab: 't', site_id: 'a', outcome: 'x', reason: null, discovered_at: null, meta: { a: { c: [1, 2], d: 2 }, b: 1 } }],
      spec,
    );
    expect(plan.unchanged).toBe(1);
  });

  it('boş string ile null\'u ayırır, undefined\'ı null sayar', () => {
    const plan = planSync(
      [
        { tab: 't', site_id: 'a', outcome: 'x', reason: '', discovered_at: null, meta: null },
        { tab: 't', site_id: 'b', outcome: 'x', reason: null, discovered_at: null, meta: null },
      ],
      [
        { tab: 't', site_id: 'a', outcome: 'x', reason: null, discovered_at: null, meta: null },
        { tab: 't', site_id: 'b', outcome: 'x', reason: undefined, discovered_at: null, meta: null },
      ],
      spec,
    );
    expect(plan.updates.map((r) => r.site_id)).toEqual(['a']);
    expect(plan.unchanged).toBe(1);
  });

  it('büyük/küçük harf duyarsız anahtarı eşleştirir (citext e-posta/izin)', () => {
    const plan = planSync(
      [{ email: 'A@x.com', role: 'member' }],
      [{ email: 'a@x.com', role: 'member' }],
      { keyColumns: ['email'], compareColumns: ['role'], caseInsensitiveKey: true },
    );
    expect(plan.unchanged).toBe(1);
    expect(plan.inserts).toEqual([]);
  });

  it('veritabanında olup kaynakta olmayan satırları budama adayı olarak verir', () => {
    const plan = planSync(
      [
        { tab: 't', site_id: 'a', outcome: 'x', reason: null, discovered_at: null, meta: null },
        { tab: 't', site_id: 'gone', outcome: 'x', reason: null, discovered_at: null, meta: null },
      ],
      [{ tab: 't', site_id: 'a', outcome: 'x', reason: null, discovered_at: null, meta: null }],
      spec,
    );
    expect(plan.stale.map((r) => r.site_id)).toEqual(['gone']);
    expect(plan.unchanged).toBe(1);
  });

  it('istenen listede aynı anahtar iki kez varsa hata verir (sessiz veri kaybı yok)', () => {
    expect(() =>
      planSync([], [{ tab: 't', site_id: 'a', outcome: 'x' }, { tab: 't', site_id: 'a', outcome: 'y' }], spec),
    ).toThrow(/yinelenen anahtar/i);
  });
});
