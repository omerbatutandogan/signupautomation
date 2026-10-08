import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { approveProfile, assetFingerprints, listingApproval, profileFingerprint } from '../src/core/listing-approval.js';

/**
 * Listeleme onayı: ürün bilgisi HERKESE AÇIK yayınlanmadan önce bir insanın gördüğü
 * içeriğin onayı. Onay içeriğe bağlı: profil değişirse geçersiz.
 */
const created: string[] = [];
async function tmp(prefix = 'appr-'): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), prefix));
  created.push(dir);
  return dir;
}
afterEach(async () => {
  await Promise.all(created.splice(0).map((d) => rm(d, { recursive: true, force: true })));
});

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
    const dir = await tmp();
    expect(await listingApproval('geo-new', profile, dir)).toEqual({ ok: false, reason: 'missing' });
  });

  it('onaylanan içerik aynıysa ok, tarihle birlikte', async () => {
    const dir = await tmp();
    await approveProfile('geo-new', profile, { dir, now: new Date('2026-10-08T12:00:00Z') });
    expect(await listingApproval('geo-new', profile, dir)).toEqual({ ok: true, approvedAt: '2026-10-08T12:00:00.000Z' });
  });

  it('onaydan sonra içerik değişirse changed', async () => {
    const dir = await tmp();
    await approveProfile('geo-new', profile, { dir });
    expect(await listingApproval('geo-new', { ...profile, companyName: 'Geo.New' }, dir)).toEqual({ ok: false, reason: 'changed' });
  });

  it('onay ürüne özel: başka ürünün onayı geçmez', async () => {
    const dir = await tmp();
    await approveProfile('geo-new', profile, { dir });
    expect(await listingApproval('acme-crm', profile, dir)).toEqual({ ok: false, reason: 'missing' });
  });

  it('bozuk onay dosyası unreadable (yayına izin vermez)', async () => {
    const dir = await tmp();
    const { writeFile } = await import('node:fs/promises');
    await writeFile(join(dir, 'geo-new.json'), '{"sha256": 12}');
    expect(await listingApproval('geo-new', profile, dir)).toEqual({ ok: false, reason: 'unreadable' });
    await writeFile(join(dir, 'geo-new.json'), '{yarım');
    expect(await listingApproval('geo-new', profile, dir)).toEqual({ ok: false, reason: 'unreadable' });
  });
});

describe('assetFingerprints — onay logo dosyalarının İÇERİĞİNE de bağlı', () => {
  const withLogo = { ...profile, logo: { '512': 'assets/logo-512.png', '256': 'assets/logo-256.png' } };
  async function assetsDir(files: Record<string, string>): Promise<string> {
    const dir = await tmp('assets-');
    await mkdir(join(dir, 'assets'), { recursive: true });
    for (const [name, content] of Object.entries(files)) await writeFile(join(dir, name), content);
    return dir;
  }

  it('her dosya için içerik özeti verir; olmayan dosya null', async () => {
    const dir = await assetsDir({ 'assets/logo-512.png': 'AAA' });
    const fp = await assetFingerprints(withLogo, dir);
    expect(Object.keys(fp).sort()).toEqual(['assets/logo-256.png', 'assets/logo-512.png']);
    expect(fp['assets/logo-512.png']).toMatch(/^[0-9a-f]{64}$/);
    expect(fp['assets/logo-256.png']).toBeNull();
  });

  it('logo tanımı yoksa boş', async () => {
    expect(await assetFingerprints({}, 'bulunmayan-dizin')).toEqual({});
  });

  it('aynı yol, FARKLI içerik → onay geçersiz (changed)', async () => {
    const approvals = await tmp();
    const dir = await assetsDir({ 'assets/logo-512.png': 'logo-v1', 'assets/logo-256.png': 'logo-v1-small' });
    await approveProfile('geo-new', withLogo, { dir: approvals, assets: await assetFingerprints(withLogo, dir) });
    expect(await listingApproval('geo-new', withLogo, approvals, await assetFingerprints(withLogo, dir))).toMatchObject({ ok: true });

    await writeFile(join(dir, 'assets/logo-512.png'), 'baska-bir-logo');
    expect(await listingApproval('geo-new', withLogo, approvals, await assetFingerprints(withLogo, dir))).toEqual({ ok: false, reason: 'changed' });
  });

  it('dosya sonradan EKLENİRSE (null → özet) onay geçersiz', async () => {
    const approvals = await tmp();
    const dir = await assetsDir({ 'assets/logo-512.png': 'v1' }); // 256 yok
    await approveProfile('geo-new', withLogo, { dir: approvals, assets: await assetFingerprints(withLogo, dir) });

    await writeFile(join(dir, 'assets/logo-256.png'), 'sonradan-eklendi');
    expect(await listingApproval('geo-new', withLogo, approvals, await assetFingerprints(withLogo, dir))).toEqual({ ok: false, reason: 'changed' });
  });

  it('yalnızca profile bağlı eski onay, dosya özetleriyle yapılan kontrolü GEÇMEZ', async () => {
    const approvals = await tmp();
    const dir = await assetsDir({ 'assets/logo-512.png': 'v1', 'assets/logo-256.png': 'v1' });
    await approveProfile('geo-new', withLogo, { dir: approvals }); // dosya özeti yok
    expect(await listingApproval('geo-new', withLogo, approvals, await assetFingerprints(withLogo, dir))).toEqual({ ok: false, reason: 'changed' });
  });
});
