/**
 * Site adaptörü yükleme.
 *
 * JSON önce, kod sonra: overrides/<id>.ts varsa o kullanılır. Override
 * tipik olarak generic adaptörü sarar ve yalnızca tek bir metodu değiştirir.
 */

import { readFile, readdir } from 'node:fs/promises';
import { parseSiteConfig } from './schema.js';
import { makeGenericAdapter } from './generic.js';
import type { SiteAdapter, SiteConfig, SiteId } from '../core/types.js';

const SITES_DIR = 'src/sites';
const OVERRIDES_DIR = 'src/adapters/overrides';

export async function loadSiteConfig(siteId: SiteId): Promise<SiteConfig> {
  const path = `${SITES_DIR}/${siteId}.json`;
  let raw: string;
  try {
    raw = await readFile(path, 'utf8');
  } catch {
    throw new Error(`Site config bulunamadı: ${path}`);
  }

  let json: unknown;
  try {
    json = JSON.parse(raw);
  } catch (err) {
    throw new Error(`${path} geçerli JSON değil: ${(err as Error).message}`);
  }

  // Zod doğrulaması: hatalı config çalışma zamanında değil BURADA patlar.
  return parseSiteConfig(json, path) as SiteConfig;
}

export async function loadAdapter(siteId: SiteId): Promise<SiteAdapter> {
  const cfg = await loadSiteConfig(siteId);

  try {
    const mod = (await import(`./overrides/${siteId}.js`)) as {
      default?: (cfg: SiteConfig) => SiteAdapter;
    };
    if (mod.default) return mod.default(cfg);
  } catch {
    // Override yok — normal durum, sitelerin çoğu saf declarative.
  }

  return makeGenericAdapter(cfg);
}

/** sites/ altındaki tüm config id'lerini listeler. */
export async function listSiteIds(): Promise<SiteId[]> {
  try {
    const files = await readdir(SITES_DIR);
    return files
      .filter((f) => f.endsWith('.json') && !f.startsWith('_'))
      .map((f) => f.replace(/\.json$/, ''))
      .sort();
  } catch {
    return [];
  }
}

export { OVERRIDES_DIR, SITES_DIR };
