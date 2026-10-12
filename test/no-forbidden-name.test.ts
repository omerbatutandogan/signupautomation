import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * Projede hiçbir yerde belirli bir şirket adı geçmemeli (kullanıcının kesin talimatı: ne kod, ne profil, ne
 * yorum, ne yapılandırma örneği). Ad burada parçalı yazılır ki bu dosyanın kendisi taramaya takılmasın.
 */
const FORBIDDEN = ['nod', 'eran'].join('');

const SKIP_DIRS = new Set(['node_modules', 'data', 'artifacts', '.git', '.omc', '.auth', 'coverage', 'dist']);
const TEXT = /\.(ts|tsx|js|mjs|cjs|json|md|txt|sh|sql|yml|yaml|env|example|html|css)$|^\.env\.example$|^\.gitignore$/;

function walk(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    if (SKIP_DIRS.has(name)) continue;
    const path = join(dir, name);
    const st = statSync(path);
    if (st.isDirectory()) walk(path, out);
    else if (TEXT.test(name)) out.push(path);
  }
  return out;
}

describe('yasak ad taraması', () => {
  it('kaynak, test, betik ve yapılandırma dosyalarında geçmez', () => {
    const hits = walk('.')
      .filter((f) => !f.endsWith('no-forbidden-name.test.ts'))
      .filter((f) => readFileSync(f, 'utf8').toLowerCase().includes(FORBIDDEN));
    expect(hits).toEqual([]);
  });
});
