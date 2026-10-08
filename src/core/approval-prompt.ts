/**
 * Listeleme onayının İNSAN adımı: yayınlanacak TÜM bilgiyi gösterir, etkileşimli terminalde
 * yazılı onay ister, ancak ondan sonra onayı kaydeder.
 *
 * Neden ayrı ve neden katı: onay, ürünün üçüncü sitelerde herkese açık yayınlanmasının tek
 * kapısıdır. Etkileşimli terminal (TTY) şartı, bir betiğin ya da otomasyonun
 * `approve-profile && submit --live` zinciriyle bu kararı insan yerine vermesini engeller.
 */

import { approveProfile, assetFingerprints, listingFingerprint } from './listing-approval.js';
import type { SignupProfile } from './types.js';

export interface ApprovalIO {
  /** Girdi gerçek bir etkileşimli terminal mi (process.stdin.isTTY)? */
  isTTY: boolean;
  print(line: string): void;
  ask(question: string): Promise<string>;
}

export type ApprovalResult =
  | { approved: true; sha256: string }
  | { approved: false; reason: 'not_interactive' | 'declined' };

export async function reviewAndApprove(
  productId: string,
  profile: SignupProfile,
  io: ApprovalIO,
  opts: { dir?: string; assetsDir?: string; now?: Date } = {},
): Promise<ApprovalResult> {
  const assets = await assetFingerprints(profile, opts.assetsDir);
  const code = listingFingerprint(profile, assets).slice(0, 8);

  io.print(`\n${productId} — herkese açık yayınlanabilecek TÜM bilgiler:\n`);
  io.print(`  Ürün adı      : ${profile.companyName}`);
  io.print(`  Şirket/yasal  : ${profile.legalName}`);
  io.print(`  Site          : ${profile.website}`);
  io.print(`  Slogan        : ${profile.tagline}`);
  io.print(`  Kısa açıklama : ${profile.descriptions.short}`);
  io.print(`  Orta açıklama : ${profile.descriptions.medium}`);
  io.print(`  Uzun açıklama : ${profile.descriptions.long}`);
  io.print(`  Kategori      : ${profile.category.primary} (diğer: ${profile.category.aliases.join(', ')})`);
  io.print(`  İletişim      : ${profile.contact.firstName} ${profile.contact.lastName}, ${profile.contact.role}, ${profile.contact.email}`);
  io.print(`  Fiyat         : ${profile.pricing} · Kuruluş: ${profile.foundedYear}`);
  io.print(`  Sosyal        : ${JSON.stringify(profile.socials)}`);
  for (const [path, sha] of Object.entries(assets)) {
    io.print(`  Logo          : ${path} ${sha ? `(sha256 ${sha.slice(0, 12)}…)` : '⚠️  DOSYA YOK — yükleme adımları başarısız olur'}`);
  }

  if (!io.isTTY) {
    io.print('\n❌ approve-profile etkileşimli bir terminal ister (yayın onayı bir insan kararıdır).');
    return { approved: false, reason: 'not_interactive' };
  }

  const answer = await io.ask(`\nBu bilgiler üçüncü sitelerde HERKESE AÇIK yayınlanacak. Onaylamak için "${code}" yazın: `);
  if (answer.trim() !== code) {
    io.print('❌ Onaylanmadı.');
    return { approved: false, reason: 'declined' };
  }

  const record = await approveProfile(productId, profile, { dir: opts.dir, now: opts.now, assets });
  io.print(`\n✅ Bu içerik listeleme için onaylandı (${record.sha256.slice(0, 12)}…). Profil ya da logo dosyası değişirse onay geçersiz olur.`);
  return { approved: true, sha256: record.sha256 };
}
