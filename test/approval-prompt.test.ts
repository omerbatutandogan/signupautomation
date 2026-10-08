import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { reviewAndApprove, type ApprovalIO } from '../src/core/approval-prompt.js';
import { assetFingerprints, listingApproval } from '../src/core/listing-approval.js';
import { loadProfile } from '../src/identity/profile.js';

/**
 * approve-profile'ın insan adımı: yayınlanacak HER ŞEY gösterilir, etkileşimli terminal ve
 * yazılı onay şarttır. Betik/otomasyon bu kararı insan yerine veremez.
 */

const created: string[] = [];
const tmp = async (prefix: string) => {
  const dir = await mkdtemp(join(tmpdir(), prefix));
  created.push(dir);
  return dir;
};
afterEach(async () => {
  await Promise.all(created.splice(0).map((d) => rm(d, { recursive: true, force: true })));
});

function io(over: Partial<ApprovalIO> & { answer?: (question: string) => string } = {}) {
  const lines: string[] = [];
  const questions: string[] = [];
  const api: ApprovalIO = {
    isTTY: true,
    print: (l) => void lines.push(l),
    ask: async (q) => {
      questions.push(q);
      return over.answer ? over.answer(q) : '';
    },
    ...over,
  };
  return { api, lines, questions, out: () => lines.join('\n') };
}

/** Sorudaki tırnak içindeki onay kodunu okur (insan ekranda görüp yazar). */
const codeIn = (question: string) => /"([0-9a-f]{8})"/.exec(question)?.[1] ?? '';

async function setup() {
  const dir = await tmp('appr-');
  const assetsDir = await tmp('assets-');
  await mkdir(join(assetsDir, 'assets'), { recursive: true });
  await writeFile(join(assetsDir, 'assets/logo-512.png'), 'png-v1');
  const profile = await loadProfile('geo-new');
  return { dir, assetsDir, profile };
}

describe('reviewAndApprove', () => {
  it('etkileşimli terminal DEĞİLSE onay yazılmaz (betik/ajan zinciri onay veremez)', async () => {
    const { dir, assetsDir, profile } = await setup();
    const t = io({ isTTY: false, answer: (q) => codeIn(q) });
    const result = await reviewAndApprove('geo-new', profile, t.api, { dir, assetsDir });
    expect(result).toEqual({ approved: false, reason: 'not_interactive' });
    expect(t.questions).toEqual([]); // soru bile sorulmadı
    expect(await readdir(dir)).toEqual([]);
  });

  it('yanlış / boş yanıt onay yazmaz', async () => {
    const { dir, assetsDir, profile } = await setup();
    for (const answer of ['', 'evet', 'y', '12345678']) {
      const result = await reviewAndApprove('geo-new', profile, io({ answer: () => answer }).api, { dir, assetsDir });
      expect(result).toEqual({ approved: false, reason: 'declined' });
    }
    expect(await readdir(dir)).toEqual([]);
  });

  it('ekrandaki kodu yazan insan onaylar; onay içeriğe (logo dosyası dahil) bağlı kaydedilir', async () => {
    const { dir, assetsDir, profile } = await setup();
    const t = io({ answer: (q) => ` ${codeIn(q)} ` });
    const result = await reviewAndApprove('geo-new', profile, t.api, { dir, assetsDir, now: new Date('2026-10-08T12:00:00Z') });
    expect(result.approved).toBe(true);

    const assets = await assetFingerprints(profile, assetsDir);
    expect(await listingApproval('geo-new', profile, dir, assets)).toEqual({ ok: true, approvedAt: '2026-10-08T12:00:00.000Z' });
    // Logo değişince onay düşer:
    await writeFile(join(assetsDir, 'assets/logo-512.png'), 'png-v2');
    expect(await listingApproval('geo-new', profile, dir, await assetFingerprints(profile, assetsDir))).toEqual({ ok: false, reason: 'changed' });
    expect(JSON.parse(await readFile(join(dir, 'geo-new.json'), 'utf8'))).toMatchObject({ approvedAt: '2026-10-08T12:00:00.000Z' });
  });

  it('yayınlanabilecek HER alanı gösterir (uzun açıklama, iletişim, logo dahil)', async () => {
    const { dir, assetsDir, profile } = await setup();
    const t = io();
    await reviewAndApprove('geo-new', profile, t.api, { dir, assetsDir });
    const out = t.out();
    for (const text of [
      profile.companyName,
      profile.legalName,
      profile.website,
      profile.tagline,
      profile.descriptions.short,
      profile.descriptions.medium,
      profile.descriptions.long, // kırpılmadan tam
      profile.category.primary,
      profile.contact.email,
      profile.contact.firstName,
      String(profile.foundedYear),
      'assets/logo-512.png',
    ]) {
      expect(out, text).toContain(text);
    }
  });

  it('eksik logo dosyasını açıkça uyarır', async () => {
    const { dir, assetsDir, profile } = await setup(); // 256 px logo oluşturulmadı
    const t = io();
    await reviewAndApprove('geo-new', profile, t.api, { dir, assetsDir });
    expect(t.out()).toMatch(/logo-256\.png.*DOSYA YOK/);
  });
});
