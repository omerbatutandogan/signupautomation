/**
 * Ürün profilleri — src/profile/<ürünId>.json.
 *
 * Profil, sitelere yazılan her şeyin kaynağı: ad, açıklamalar, link,
 * kategori. Yanlış bir profil 200 siteye aynı yanlışı yayar — geo.new'in
 * açıklaması tam böyle yanlış yazılmıştı. 10 ürünün profili dışarıdan
 * gelecek; eksik ya da hatalı alan kayıt sırasında değil, YÜKLERKEN
 * yakalanmalı.
 */

import { readdir, readFile } from 'node:fs/promises';
import { z } from 'zod';
import type { SignupProfile } from '../core/types.js';
import { assertProductId } from './account.js';

const PROFILE_DIR = 'src/profile';

const nonEmpty = z.string().trim().min(1);

const ProfileSchema = z.object({
  companyName: nonEmpty,
  legalName: nonEmpty,
  website: z.string().url(),
  tagline: nonEmpty,
  descriptions: z.object({
    short: nonEmpty,
    medium: nonEmpty,
    long: nonEmpty,
  }),
  category: z.object({
    primary: nonEmpty,
    aliases: z.array(nonEmpty),
  }),
  logo: z.record(z.string()),
  contact: z.object({
    firstName: nonEmpty,
    lastName: nonEmpty,
    role: nonEmpty,
    email: z.string().email(),
  }),
  socials: z.object({
    twitter: z.string().optional(),
    linkedin: z.string().optional(),
    github: z.string().optional(),
  }),
  pricing: nonEmpty,
  foundedYear: z.number().int(),
  signupEmail: z.string().email().optional(),
});

export async function listProducts(): Promise<string[]> {
  const files = await readdir(PROFILE_DIR).catch(() => [] as string[]);
  return files.filter((f) => f.endsWith('.json')).map((f) => f.replace(/\.json$/, '')).sort();
}

export async function loadProfile(productId: string): Promise<SignupProfile> {
  assertProductId(productId);

  let raw: string;
  try {
    raw = await readFile(`${PROFILE_DIR}/${productId}.json`, 'utf8');
  } catch {
    const available = await listProducts();
    throw new Error(
      `Ürün profili bulunamadı: ${PROFILE_DIR}/${productId}.json — mevcut ürünler: ${available.join(', ') || '(yok)'}`,
    );
  }

  return parseProfile(JSON.parse(raw), productId);
}

/** Profili doğrular; hatalı alanları tek mesajda sayar. */
export function parseProfile(raw: unknown, productId: string): SignupProfile {
  const parsed = ProfileSchema.safeParse(raw);
  if (!parsed.success) {
    const issues = parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ');
    throw new Error(`Ürün profili geçersiz (${productId}): ${issues}`);
  }
  return parsed.data;
}
