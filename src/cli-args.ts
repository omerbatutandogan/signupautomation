/**
 * Komut satırı ayrıştırma — cli.ts'ten ayrı, çünkü cli.ts import edildiği
 * anda main()'i çalıştırıyor ve test edilemiyor.
 *
 * Değer alan seçenekler (`--product acme` ya da `--product=acme`) önce
 * çekiliyor. Yoksa değer konumsal argüman sanılırdı: `run-one --product
 * acme awwwards` site id'si olarak "acme"yi alırdı.
 */

/** Değer alan seçenekler. Diğer `--x` argümanları bayrak sayılır. */
const VALUED_OPTIONS = new Set(['--product']);

export interface ParsedArgs {
  command: string | undefined;
  positional: string[];
  flags: Set<string>;
  options: Map<string, string>;
}

export function parseArgs(argv: string[]): ParsedArgs {
  const options = new Map<string, string>();
  const rest: string[] = [];

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]!;
    const eq = arg.indexOf('=');
    const name = eq > 0 ? arg.slice(0, eq) : arg;

    if (VALUED_OPTIONS.has(name)) {
      const value = eq > 0 ? arg.slice(eq + 1) : argv[++i];
      if (!value || value.startsWith('--')) {
        throw new Error(`${name} bir değer bekliyor (örn. ${name} geo-new)`);
      }
      options.set(name, value);
      continue;
    }
    rest.push(arg);
  }

  return {
    command: rest[0],
    positional: rest.slice(1).filter((a) => !a.startsWith('--')),
    flags: new Set(rest.filter((a) => a.startsWith('--'))),
    options,
  };
}
