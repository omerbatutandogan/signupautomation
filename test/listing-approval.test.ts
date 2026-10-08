import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { approveProfile, listingApproval, profileFingerprint } from '../src/core/listing-approval.js';

/**
 * Listeleme onayı: ürün bilgisi HERKESE AÇIK yayınlanmadan önce bir insanın gördüğü
 * içeriğin onayı. Onay içeriğe bağlı: profil değişirse geçersiz.
 */
const profile = { companyName: 'geo.new', tagline: 'Instant geolocation', descriptions: { short: 'a', long: 'b' }, socials: {} };

describe('profileFingerprint', () => {
  it('anahtar sırasına ve boşluğa bağlı değil', () => {
    expect(profileFingerprint({ b: 1, a: { d: 2, c: [1, 2] } })).toBe(profileFingerprint({ a: { c: [1, 2], d: 2 }, b: 1 }));
  });
  it('tek karakter değişirse farklı', () => {
    expect(profileFingerprint(profile)).not.toBe(profileFingerprint({ ...profile, tagline: 'Instant geolocation.' }));
  });
  it('dizi sırası anlamlı', () => {
    expect(profileFingerprint({ a: [1, 2] })).not.toBe(profileFingerprint({ a: [2, 1] }));
  });
});

describe('listingApproval', () => {
  it('onay yoksa missing', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'appr-'));
    expect(await listingApproval('geo-new', profile, dir)).toEqual({ ok: false, reason: 'missing' });
  });

  it('onaylanan içerik aynıysa ok, tarihle birlikte', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'appr-'));
    await approveProfile('geo-new', profile, { dir, now: new Date('2026-10-08T12:00:00Z') });
    expect(await listingApproval('geo-new', profile, dir)).toEqual({ ok: true, approvedAt: '2026-10-08T12:00:00.000Z' });
  });

  it('onaydan sonra içerik değişirse changed', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'appr-'));
    await approveProfile('geo-new', profile, { dir });
    expect(await listingApproval('geo-new', { ...profile, companyName: 'Geo.New' }, dir)).toEqual({ ok: false, reason: 'changed' });
  });

  it('onay ürüne özel: başka ürünün onayı geçmez', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'appr-'));
    await approveProfile('geo-new', profile, { dir });
    expect(await listingApproval('acme-crm', profile, dir)).toEqual({ ok: false, reason: 'missing' });
  });

  it('bozuk onay dosyası unreadable (yayına izin vermez)', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'appr-'));
    const { writeFile } = await import('node:fs/promises');
    await writeFile(join(dir, 'geo-new.json'), '{"sha256": 12}');
    expect(await listingApproval('geo-new', profile, dir)).toEqual({ ok: false, reason: 'unreadable' });
    await writeFile(join(dir, 'geo-new.json'), '{yarım');
    expect(await listingApproval('geo-new', profile, dir)).toEqual({ ok: false, reason: 'unreadable' });
  });
});
