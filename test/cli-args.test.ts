import { describe, expect, it } from 'vitest';
import { parseArgs } from '../src/cli-args.js';

describe('parseArgs', () => {
  it('--product değerini konumsal argüman sanmaz', () => {
    // Eski ayrıştırma "acme"yi site id'si olarak alırdı.
    const a = parseArgs(['run-one', '--product', 'acme', 'awwwards', '--dry-run']);
    expect(a.command).toBe('run-one');
    expect(a.positional).toEqual(['awwwards']);
    expect(a.options.get('--product')).toBe('acme');
    expect(a.flags.has('--dry-run')).toBe(true);
    expect(a.flags.has('--product')).toBe(false);
  });

  it('--product=değer biçimini de kabul eder', () => {
    const a = parseArgs(['password', 'awwwards', '--product=acme']);
    expect(a.positional).toEqual(['awwwards']);
    expect(a.options.get('--product')).toBe('acme');
  });

  it('değersiz --product hata verir', () => {
    expect(() => parseArgs(['run-one', 'awwwards', '--product'])).toThrow(/değer bekliyor/);
    expect(() => parseArgs(['run-one', '--product', '--dry-run'])).toThrow(/değer bekliyor/);
  });

  it('--product yoksa eski davranış aynen sürer', () => {
    const a = parseArgs(['run-batch', '5', '--dry-run']);
    expect(a.positional).toEqual(['5']);
    expect(a.options.size).toBe(0);
  });
});
