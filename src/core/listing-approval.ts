/**
 * Ürün bilgisinin HERKESE AÇIK listeleme için insan onayı.
 *
 * Listeleme, ürünü üçüncü sitelerde yayınlar ve geri almak çoğu zaman mümkün değil.
 * Yanlış ya da doğrulanmamış bilgiyle yayınlamamak için gerçek gönderim, profilin
 * tam bu içeriğinin onaylandığını gösteren bir kayıt ister. Profil onaydan sonra
 * DEĞİŞİRSE onay geçersiz olur (içerik özeti eşleşmez) ve yeniden onay gerekir.
 *
 * Onay kayıtları data/ altında (git'e girmez, işçiye özel): onay bir insanın o
 * makinede verdiği karardır, repo'ya işlenen bir şey değil.
 */

import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';

export const APPROVAL_DIR = 'data/approvals';

/** Anahtar sırasından ve boşluktan bağımsız, kararlı içerik özeti. */
export function profileFingerprint(profile: unknown): string {
  const canonical = (v: unknown): string => {
    if (Array.isArray(v)) return `[${v.map(canonical).join(',')}]`;
    if (v && typeof v === 'object') {
      const o = v as Record<string, unknown>;
      return `{${Object.keys(o)
        .sort()
        .map((k) => `${JSON.stringify(k)}:${canonical(o[k])}`)
        .join(',')}}`;
    }
    return JSON.stringify(v) ?? 'null';
  };
  return createHash('sha256').update(canonical(profile)).digest('hex');
}

const pathFor = (productId: string, dir: string) => `${dir}/${productId}.json`;

export async function approveProfile(
  productId: string,
  profile: unknown,
  opts: { dir?: string; now?: Date } = {},
): Promise<{ sha256: string; approvedAt: string }> {
  const dir = opts.dir ?? APPROVAL_DIR;
  const record = { sha256: profileFingerprint(profile), approvedAt: (opts.now ?? new Date()).toISOString() };
  const path = pathFor(productId, dir);
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, `${JSON.stringify(record, null, 2)}\n`);
  return record;
}

export type ApprovalState = { ok: true; approvedAt: string } | { ok: false; reason: 'missing' | 'changed' | 'unreadable' };

export async function listingApproval(productId: string, profile: unknown, dir = APPROVAL_DIR): Promise<ApprovalState> {
  let raw: string;
  try {
    raw = await readFile(pathFor(productId, dir), 'utf8');
  } catch {
    return { ok: false, reason: 'missing' };
  }
  try {
    const rec = JSON.parse(raw) as { sha256?: unknown; approvedAt?: unknown };
    if (typeof rec.sha256 !== 'string' || typeof rec.approvedAt !== 'string') return { ok: false, reason: 'unreadable' };
    return rec.sha256 === profileFingerprint(profile) ? { ok: true, approvedAt: rec.approvedAt } : { ok: false, reason: 'changed' };
  } catch {
    return { ok: false, reason: 'unreadable' };
  }
}
