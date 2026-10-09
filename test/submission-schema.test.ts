import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { listSubmissionIds, loadSubmissionConfig } from '../src/adapters/submission-registry.js';
import { parseSubmissionConfig } from '../src/adapters/submission-schema.js';
import { Ledger } from '../src/integrations/ledger.js';

const valid = {
  id: 'dir-x',
  name: 'Dir X',
  listingUrl: 'https://dir-x.example/submit',
  steps: [{ type: 'goto', url: '{{signupUrl}}' }, { type: 'fill', selector: '#site', field: 'website' }],
  success: { anyOf: ['#ok'] },
};

describe('submission şeması', () => {
  it('geçerli config kabul edilir', () => {
    expect(parseSubmissionConfig(valid, 't').id).toBe('dir-x');
  });
  it('success ZORUNLU: başarı işareti olmadan yayın doğrulanamaz', () => {
    const { success: _s, ...noSuccess } = valid;
    expect(() => parseSubmissionConfig(noSuccess, 't')).toThrow(/success/);
    expect(() => parseSubmissionConfig({ ...valid, success: {} }, 't')).toThrow(/anyOf ya da success.urlContains/);
    expect(parseSubmissionConfig({ ...valid, success: { urlContains: ['/thanks'] } }, 't').success.urlContains).toEqual(['/thanks']);
  });
  it('adımlar kayıt config\'iyle aynı kurallarla doğrulanır', () => {
    expect(() => parseSubmissionConfig({ ...valid, steps: [{ type: 'fill', selector: '#x' }] }, 't')).toThrow(/field veya value/);
    expect(() => parseSubmissionConfig({ ...valid, steps: [] }, 't')).toThrow(/en az bir adım/);
  });
  it('id ve adres doğrulanır', () => {
    expect(() => parseSubmissionConfig({ ...valid, id: 'Bad Id' }, 't')).toThrow(/id/);
    expect(() => parseSubmissionConfig({ ...valid, listingUrl: 'not a url' }, 't')).toThrow(/listingUrl/);
  });
  it('login.url, listingUrl ile aynı SAYFA olamaz (sorgu / hash fark sayılmaz)', () => {
    const login = (url: string) => ({ ...valid, loggedIn: '#out', login: { url, steps: [{ type: 'goto', url: '{{signupUrl}}' }] } });
    expect(() => parseSubmissionConfig(login('https://dir-x.example/submit'), 't')).toThrow(/aynı sayfa/);
    expect(() => parseSubmissionConfig(login('https://dir-x.example/submit?login=1'), 't')).toThrow(/aynı sayfa/);
    expect(() => parseSubmissionConfig(login('https://dir-x.example/submit#giris'), 't')).toThrow(/aynı sayfa/);
    expect(parseSubmissionConfig(login('https://dir-x.example/login'), 't').login?.url).toBe('https://dir-x.example/login');
  });
  it('upload adımı src/profile dışına çıkamaz', () => {
    const withUpload = (file: string) => ({ ...valid, steps: [{ type: 'upload', selector: '#logo', file }] });
    expect(() => parseSubmissionConfig(withUpload('../../.env'), 't')).toThrow(/upload dosyası/);
    expect(parseSubmissionConfig(withUpload('assets/logo-512.png'), 't').steps).toHaveLength(1);
  });
  it('login varsa adres ve adım ister', () => {
    expect(() => parseSubmissionConfig({ ...valid, login: { url: 'https://x.example/login', steps: [] } }, 't')).toThrow();
  });
});

describe('submission registry', () => {
  it('dosyadan yükler, olmayanı ve bozuk JSON\'u net hatayla bildirir, kimlikleri sıralı listeler', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'subs-'));
    await writeFile(join(dir, 'b-site.json'), JSON.stringify({ ...valid, id: 'b-site' }));
    await writeFile(join(dir, 'a-site.json'), JSON.stringify({ ...valid, id: 'a-site' }));
    await writeFile(join(dir, 'broken.json'), '{yarım');
    expect((await loadSubmissionConfig('a-site', dir)).id).toBe('a-site');
    await expect(loadSubmissionConfig('yok', dir)).rejects.toThrow(/bulunamadı/);
    await expect(loadSubmissionConfig('broken', dir)).rejects.toThrow(/geçerli JSON değil/);
    expect(await listSubmissionIds(dir)).toEqual(['a-site', 'b-site', 'broken']);
    expect(await listSubmissionIds(join(dir, 'yok-klasor'))).toEqual([]);
  });
});

describe('ledger: submissions', () => {
  it('liveSubmission yalnızca GERÇEK tamamlanmış/doğrulanamamış gönderimi sayar', () => {
    const l = new Ledger(':memory:');
    const dry = l.startSubmission('s', 'r1', true);
    l.finishSubmission(dry, 'completed', 'dry-run');
    expect(l.liveSubmission('s')).toBeNull();

    const failed = l.startSubmission('s', 'r2', false);
    l.finishSubmission(failed, 'failed', 'öğe yok');
    expect(l.liveSubmission('s')).toBeNull();

    const unconfirmed = l.startSubmission('s', 'r3', false);
    l.finishSubmission(unconfirmed, 'unconfirmed', 'işaret yok', 'https://x/y');
    expect(l.liveSubmission('s')).toMatchObject({ status: 'unconfirmed', listing_url: 'https://x/y' });

    const done = l.startSubmission('t', 'r4', false);
    l.finishSubmission(done, 'completed', 'ok', 'https://t/1');
    expect(l.liveSubmission('t')?.status).toBe('completed');
    expect(l.liveSubmission('baska')).toBeNull();
    expect(l.recentSubmissions(10)).toHaveLength(4);
    l.close();
  });

  it('listeleme denemesi hesap AÇMA kaydını (attempts/terminalResult) etkilemez', () => {
    const l = new Ledger(':memory:');
    const a = l.startAttempt('s', 'r0', false);
    l.finishAttempt(a, 'completed', 'ok');
    const sub = l.startSubmission('s', 'r1', false);
    l.finishSubmission(sub, 'failed', 'x');
    expect(l.terminalResult('s')?.status).toBe('completed');
    expect(l.recentAttempts(10)).toHaveLength(1);
    l.close();
  });
});
