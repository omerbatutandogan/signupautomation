/**
 * Listeleme onayının İNSAN adımı: yayınlanacak TÜM bilgiyi gösterir, etkileşimli terminalde
 * yazılı onay ister, ancak ondan sonra onayı kaydeder.
 *
 * Neden ayrı ve neden katı: onay, ürünün üçüncü sitelerde herkese açık yayınlanmasının tek
 * kapısıdır. Etkileşimli terminal (TTY) şartı, bir betiğin ya da otomasyonun
 * `approve-profile && submit --live` zinciriyle bu kararı insan yerine vermesini engeller.
 */

import { approveProfile, assetFingerprints, listingFingerprint } from './listing-approval.js';
import { SITE_OVERLAP_MIN, siteOverlap, type SiteFacts } from './site-facts.js';
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

/** Profil, ürünün kendi sitesinin anlatımından farklı göründüğünde kodun YERİNE yazılması gereken ifade. */
export const DIVERGENCE_PHRASE = 'FARKLI ONAYLIYORUM';

export async function reviewAndApprove(
  productId: string,
  profile: SignupProfile,
  io: ApprovalIO,
  opts: {
    dir?: string;
    assetsDir?: string;
    now?: Date;
    /**
     * Ürünün KENDİ sitesinin başlığı/açıklaması (verilirse ekranda profille yan yana gösterilir). Verilmezse
     * karşılaştırma yapılmaz (testler ağa çıkmasın diye varsayılan yok; CLI her zaman verir).
     */
    siteFacts?: () => Promise<SiteFacts | null>;
  } = {},
): Promise<ApprovalResult> {
  const assets = await assetFingerprints(profile, opts.assetsDir);
  const code = listingFingerprint(profile, assets).slice(0, 8);

  io.print(`\n${productId} — herkese açık yayınlanabilecek TÜM bilgiler:\n`);
  io.print(`  Ürün adı      : ${profile.companyName}`);
  io.print(`  Site          : ${profile.website}`);
  io.print(`  Slogan        : ${profile.tagline}`);
  io.print(`  Kısa açıklama : ${profile.descriptions.short}`);
  io.print(`  Orta açıklama : ${profile.descriptions.medium}`);
  io.print(`  Uzun açıklama : ${profile.descriptions.long}`);
  io.print(`  Kategori      : ${profile.category.primary} (diğer: ${profile.category.aliases.join(', ')})`);
  io.print(`  İletişim      : ${[`${profile.contact.firstName} ${profile.contact.lastName}`, profile.contact.role, profile.contact.email].filter(Boolean).join(', ')}`);
  io.print(`  Fiyat         : ${profile.pricing} · Kuruluş: ${profile.foundedYear}`);
  io.print(`  Sosyal        : ${JSON.stringify(profile.socials)}`);
  for (const [path, sha] of Object.entries(assets)) {
    io.print(`  Logo          : ${path} ${sha ? `(sha256 ${sha.slice(0, 12)}…)` : '⚠️  DOSYA YOK — yükleme adımları başarısız olur'}`);
  }

  const diverges = opts.siteFacts ? await compareWithSite(io, profile, opts.siteFacts) : false;

  if (!io.isTTY) {
    io.print('\n❌ approve-profile etkileşimli bir terminal ister (yayın onayı bir insan kararıdır).');
    return { approved: false, reason: 'not_interactive' };
  }

  // Profil sitenin kendi anlatımından farklıysa kod YETMEZ: farkı gördüğünü bilinçli bir ifadeyle onaylamalı.
  const question = diverges
    ? `\nBu bilgiler üçüncü sitelerde HERKESE AÇIK yayınlanacak ve ürünün kendi sitesinden FARKLI görünüyor. ` +
      `Yine de onaylıyorsanız onay kodu ("${code}") yerine tam olarak ${DIVERGENCE_PHRASE} yazın: `
    : `\nBu bilgiler üçüncü sitelerde HERKESE AÇIK yayınlanacak. Onaylamak için "${code}" yazın: `;
  const answer = await io.ask(question);
  if (answer.trim() !== (diverges ? DIVERGENCE_PHRASE : code)) {
    io.print('❌ Onaylanmadı.');
    return { approved: false, reason: 'declined' };
  }

  const record = await approveProfile(productId, profile, { dir: opts.dir, now: opts.now, assets });
  io.print(`\n✅ Bu içerik listeleme için onaylandı (${record.sha256.slice(0, 12)}…). Profil ya da logo dosyası değişirse onay geçersiz olur.`);
  return { approved: true, sha256: record.sha256 };
}

/**
 * Profili ürünün kendi sitesinin anlatımıyla yan yana gösterir. `true` = belirgin biçimde farklı.
 * Site okunamazsa ya da yeterli metin vermezse engellemez; yalnızca elle karşılaştırmayı hatırlatır.
 */
async function compareWithSite(io: ApprovalIO, profile: SignupProfile, load: () => Promise<SiteFacts | null>): Promise<boolean> {
  const facts = await load().catch(() => null);
  if (!facts || (!facts.title && !facts.description && !facts.headline)) {
    io.print(`\n  ℹ️  Ürünün kendi sitesi (${profile.website}) okunamadı: profili siteyle ELLE karşılaştırın.`);
    return false;
  }

  io.print(`\n  Ürünün KENDİ sitesi (${facts.url}) kendini şöyle anlatıyor:`);
  io.print(`    Başlık      : ${facts.title ?? '—'}`);
  io.print(`    Açıklama    : ${facts.description ?? '—'}`);
  io.print(`    Ana başlık  : ${facts.headline ?? '—'}`);

  const overlap = siteOverlap(profile, facts);
  if (overlap === null) {
    io.print('  ℹ️  Site yeterli metin vermiyor: profili siteyle ELLE karşılaştırın.');
    return false;
  }
  const percent = Math.round(overlap * 100);
  if (overlap < SITE_OVERLAP_MIN) {
    io.print(`\n  ⚠️  UYARI: Profil, sitenin kendi anlatımından FARKLI görünüyor (ortak sözcük oranı %${percent}).`);
    io.print('      Yanlış ürün bilgisi herkese açık yayınlanır ve geri alınması zordur: yukarıdaki iki anlatımı yan yana okuyun.');
    return true;
  }
  io.print(`  ✓ Profil sitenin kendi anlatımıyla uyumlu görünüyor (ortak sözcük oranı %${percent}).`);
  return false;
}
