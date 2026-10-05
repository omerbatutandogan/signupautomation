import { describe, expect, it } from 'vitest';
import { columnLetter, parseSheetGrid, siteIdFromWebsite } from '../src/integrations/sheet.js';

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

describe('parseSheetGrid — bütün sekmeyi (başlık dahil) satırlara çevirir', () => {
  // Panel senkronu 22 sekmeyi tek istekle okuyor; sekmelerin şeması farklı.
  it('Name + Website şeması (SaaS)', () => {
    const rows = parseSheetGrid([
      ['Name', 'Website', 'Durum', 'Not'],
      ['Ten Words', 'https://10words.io', 'Tamamlandı', 'ok'],
      ['', '', '', ''],
      ['Beta List', 'betalist.com'],
    ]);
    expect(rows).toEqual([
      expect.objectContaining({ rowNumber: 2, name: 'Ten Words', website: 'https://10words.io', status: 'Tamamlandı', siteId: '10words' }),
      expect.objectContaining({ rowNumber: 4, name: 'Beta List', website: 'betalist.com', status: '', siteId: 'betalist' }),
    ]);
  });

  it('yalnızca URL kolonu olan şema (Directory)', () => {
    const rows = parseSheetGrid([['URL'], ['https://www.webwiki.de/'], ['  ']]);
    expect(rows).toEqual([expect.objectContaining({ rowNumber: 2, name: '', website: 'https://www.webwiki.de/', siteId: 'webwiki-de' })]);
  });

  it('site adresi kolonu yoksa null döner (sessizce boş liste DEĞİL)', () => {
    // Boş liste "sekmede site yok" demek; yanlış şemayı öyle saymak siteleri siler gibi gösterir.
    expect(parseSheetGrid([['Foo', 'Bar'], ['a', 'b']])).toBeNull();
    expect(parseSheetGrid([])).toBeNull();
  });
});
