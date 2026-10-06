import { describe, expect, it } from 'vitest';
import type { SheetClient as SheetClientType } from '../src/integrations/sheet.js';
import { columnLetter, siteIdFromWebsite } from '../src/integrations/sheet.js';

describe('siteIdFromWebsite', () => {
  it('basit domainden id çıkarır', () => {
    expect(siteIdFromWebsite('alternativeto.net')).toBe('alternativeto');
  });

  it('https ve www öneklerini atar', () => {
    expect(siteIdFromWebsite('https://www.betalist.com')).toBe('betalist');
  });

  it('yol kısmını yok sayar', () => {
    expect(siteIdFromWebsite('airtable.com/marketplace')).toBe('airtable');
  });

  it('alt domainde anlamlı etiketi seçer', () => {
    // portal.10words.io → "portal" değil "10words" olmalı
    expect(siteIdFromWebsite('portal.10words.io')).toBe('10words');
  });

  it('rakamla başlayan domainleri korur', () => {
    expect(siteIdFromWebsite('10words.io')).toBe('10words');
    expect(siteIdFromWebsite('1000.tools')).toBe('1000');
  });

  it('boş girdide boş döner', () => {
    expect(siteIdFromWebsite('')).toBe('');
  });

  it('ülke sitelerini AYIRIR', () => {
    // Gerçek vaka: Sheet'te 8 webwiki satırı var (.de/.com/.fr/.at/.nl/
    // .ch/.it/.pt). Hepsi "webwiki" id'sine çözülünce yalnızca biri
    // işleniyor, diğer 7'si sessizce kayboluyordu. Bunlar ayrı dizinler.
    expect(siteIdFromWebsite('https://www.webwiki.de/')).toBe('webwiki-de');
    expect(siteIdFromWebsite('https://www.webwiki.fr/')).toBe('webwiki-fr');
    expect(siteIdFromWebsite('https://www.webwiki.at/')).toBe('webwiki-at');
  });

  it('ana TLD sonek ALMAZ — mevcut idler bozulmamalı', () => {
    // Bu satırlar kırılırsa src/sites/*.json dosya adları config'lerle
    // eşleşmez ve tüm siteler "tanımsız" olur.
    expect(siteIdFromWebsite('https://www.webwiki.com/')).toBe('webwiki');
    expect(siteIdFromWebsite('awwwards.com')).toBe('awwwards');
    expect(siteIdFromWebsite('alternativeto.net')).toBe('alternativeto');
    expect(siteIdFromWebsite('10words.io')).toBe('10words');
    expect(siteIdFromWebsite('unltd.directory')).toBe('unltd');
    expect(siteIdFromWebsite('1000.tools')).toBe('1000');
  });

  it('aynı sitenin şema/www farkı AYNI id verir', () => {
    // 1abc.org: Sheet'te hem http hem https var — gerçek mükerrer,
    // ayrılmamalı.
    expect(siteIdFromWebsite('http://1abc.org/')).toBe('1abc');
    expect(siteIdFromWebsite('https://1abc.org/')).toBe('1abc');
    expect(siteIdFromWebsite('https://blogarama.com/')).toBe('blogarama');
    expect(siteIdFromWebsite('https://www.blogarama.com/')).toBe('blogarama');
  });

  it('büyük harfleri küçültür', () => {
    expect(siteIdFromWebsite('AlternativeTo.net')).toBe('alternativeto');
  });
});

describe('columnLetter', () => {
  it('ilk 26 kolonu harfe çevirir', () => {
    expect(columnLetter(0)).toBe('A');
    expect(columnLetter(25)).toBe('Z');
  });

  it('26 ve sonrasını iki harfe çevirir', () => {
    expect(columnLetter(26)).toBe('AA');
    expect(columnLetter(27)).toBe('AB');
    expect(columnLetter(51)).toBe('AZ');
    expect(columnLetter(52)).toBe('BA');
  });
});

describe('SheetClient.writeAnnotations', () => {
  // Gerçek API yerine kayıt tutan sahte; kurucu özel olduğu için dolaylı çağrılır.
  async function client(headers: string[], tab = 'Deals ') {
    const { SheetClient } = await import('../src/integrations/sheet.js');
    const calls: { update: unknown[]; batch: unknown[] } = { update: [], batch: [] };
    const api = {
      spreadsheets: {
        values: {
          update: async (req: unknown) => void calls.update.push(req),
          batchUpdate: async (req: unknown) => void calls.batch.push(req),
        },
      },
    };
    const map = new Map(headers.map((h, i) => [h, i]));
    const Ctor = SheetClient as unknown as new (...a: unknown[]) => { writeAnnotations: SheetClientType['writeAnnotations'] };
    const c = new Ctor(api, 'sheet-id', tab, { warn() {} }, map, 'Website', null);
    return { c, calls };
  }

  it('eksik başlıkları SAĞA ekler, mevcut kolonlara dokunmaz; sekme adı tırnaklanır', async () => {
    const { c, calls } = await client(['Name', 'Website', 'Durum']);
    const res = await c.writeAnnotations(['A', 'B'], [{ rowNumber: 2, values: ['x', 'y'] }]);
    expect(res).toEqual({ addedHeaders: ['A', 'B'], written: 1 });
    expect(calls.update).toEqual([
      expect.objectContaining({ range: "'Deals '!D1:E1", requestBody: { values: [['A', 'B']] } }),
    ]);
    expect(calls.batch).toEqual([
      expect.objectContaining({
        requestBody: { valueInputOption: 'RAW', data: [{ range: "'Deals '!D2:E2", values: [['x', 'y']] }] },
      }),
    ]);
  });

  it('başlıklar zaten varsa başlık satırına yazmaz, kendi kolonlarını kullanır', async () => {
    const { c, calls } = await client(['Website', 'A', 'B']);
    const res = await c.writeAnnotations(['A', 'B'], [{ rowNumber: 7, values: ['1', '2'] }]);
    expect(res.addedHeaders).toEqual([]);
    expect(calls.update).toEqual([]);
    expect(JSON.stringify(calls.batch)).toContain("'Deals '!B7:C7");
  });

  it('çok satırı 400\'lük partilerle yazar', async () => {
    const { c, calls } = await client(['Website', 'A']);
    const rows = Array.from({ length: 900 }, (_, i) => ({ rowNumber: i + 2, values: ['v'] }));
    await c.writeAnnotations(['A'], rows);
    expect(calls.batch).toHaveLength(3);
  });

  it('bitişik olmayan kolonlarda hücre hücre yazar', async () => {
    const { c, calls } = await client(['Website', 'A', 'Aradaki', 'B']);
    await c.writeAnnotations(['A', 'B'], [{ rowNumber: 3, values: ['1', '2'] }]);
    const data = (calls.batch[0] as { requestBody: { data: Array<{ range: string }> } }).requestBody.data.map((d) => d.range);
    expect(data).toEqual(["'Deals '!B3", "'Deals '!D3"]);
  });
});
