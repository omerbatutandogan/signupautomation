import { describe, expect, it } from 'vitest';
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
