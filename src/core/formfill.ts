/**
 * Form doldurma yardımcıları.
 *
 * pressSequentially kullanılıyor çünkü sadece bot tespiti meselesi değil:
 * bazı sitelerin JS validation'ı yalnızca gerçek keydown olaylarında
 * tetikleniyor, page.fill() sessizce geçersiz bir form bırakabiliyor.
 */

import type { Locator, Page } from 'playwright';
import { ManualReviewError } from './errors.js';
import type { FieldName, SignupIdentity, SignupProfile } from './types.js';

/** [min, max] aralığında rastgele tamsayı. */
export function randInt(min: number, max: number): number {
  return Math.floor(Math.random() * (max - min + 1)) + min;
}

/**
 * Yazma için ayrılan üst sınır. Adım timeout'u (varsayılan 15sn) bunun
 * üstünde kalmalı, yoksa yazma yarıda kesilir.
 */
const TYPING_BUDGET_MS = 9_000;

/**
 * İnsan hızında yazar.
 *
 * Gecikme uzunluğa göre ölçekleniyor: sabit 60-180ms, uzun açıklamalarda
 * (~140 karakter) 19 saniye ediyor ve adım timeout'unu aşıyordu — ontoplist
 * açıklama alanı tam burada yarıda kesildi. Kısa alanlar tam insan hızında
 * kalıyor; yalnızca bütçeyi aşan uzun metinler hızlanıyor.
 */
export async function typeHuman(locator: Locator, value: string): Promise<void> {
  await locator.click();
  await locator.fill(''); // önceki değeri temizle
  await locator.pressSequentially(value, { delay: typingDelayMs(value.length, randInt(60, 180)) });
}

/**
 * Karakter başına gecikmeyi bütçeye sığdırır.
 *
 * Kısa alanlarda doğal hız korunur; yalnızca toplam süre bütçeyi aşarsa
 * daralır ve asla 10ms altına inmez (keydown olayları gerçek kalmalı).
 */
export function typingDelayMs(length: number, naturalDelay: number): number {
  if (length <= 0) return naturalDelay;
  const affordable = Math.floor(TYPING_BUDGET_MS / length);
  return Math.max(10, Math.min(naturalDelay, affordable));
}

/**
 * Semantik alan adını gerçek değere çevirir.
 * 'description' ve 'category' özel muamele gerektirir (aşağıdaki fonksiyonlar).
 */
export function resolveField(
  field: FieldName,
  profile: SignupProfile,
  identity: SignupIdentity,
): string | null {
  switch (field) {
    case 'email':
      return identity.email;
    case 'username':
      return identity.username;
    case 'password':
      return identity.password;
    case 'companyName':
      return profile.companyName;
    case 'website':
      return profile.website;
    case 'tagline':
      return profile.tagline;
    case 'firstName':
      return profile.contact.firstName;
    case 'lastName':
      return profile.contact.lastName;
    case 'fullName':
      return `${profile.contact.firstName} ${profile.contact.lastName}`.trim();
    case 'role':
      return profile.contact.role;
    case 'contactEmail':
      return profile.contact.email;
    case 'twitter':
      return profile.socials.twitter ?? null;
    case 'linkedin':
      return profile.socials.linkedin ?? null;
    case 'github':
      return profile.socials.github ?? null;
    case 'pricing':
      return profile.pricing;
    case 'foundedYear':
      return String(profile.foundedYear);
    case 'category':
      return profile.category.primary;
    case 'description':
      return profile.descriptions.medium; // pickDescription ile override edilir
    case 'terms':
      return null; // checkbox — fill değil check ile işlenir
    default: {
      const exhaustive: never = field;
      return exhaustive;
    }
  }
}

/** Modern formlarda maxlength yerine yanında karakter sayacı olabiliyor. */
async function inferMaxFromCounter(locator: Locator): Promise<number | null> {
  try {
    const parentText = await locator
      .locator('xpath=..')
      .innerText({ timeout: 1000 })
      .catch(() => '');
    const m = /\d+\s*\/\s*(\d+)/.exec(parentText);
    return m?.[1] ? Number(m[1]) : null;
  } catch {
    return null;
  }
}

/** Kelime sınırında keser — cümle ortasında kesmek kötü görünür. */
export function truncateAtWord(text: string, max: number): string {
  if (text.length <= max) return text;
  const cut = text.slice(0, max);
  const lastSpace = cut.lastIndexOf(' ');
  return (lastSpace > max * 0.6 ? cut.slice(0, lastSpace) : cut).trimEnd();
}

/**
 * Alanın maxlength'ine göre uygun açıklama varyantını seçer.
 * Bu, "declarative config" vaadinin çalıştığı yer: JSON'da hangi varyantın
 * kullanılacağı yazmıyor, alanın kendisi söylüyor.
 */
export async function pickDescription(
  locator: Locator,
  profile: SignupProfile,
): Promise<{ value: string; max: number | null }> {
  const attr = await locator.getAttribute('maxlength').catch(() => null);
  const max = attr ? Number(attr) : await inferMaxFromCounter(locator);

  if (max === null || Number.isNaN(max)) {
    return { value: profile.descriptions.medium, max: null };
  }

  const chosen =
    max >= 400
      ? profile.descriptions.long
      : max >= 120
        ? profile.descriptions.medium
        : max >= 45
          ? profile.descriptions.short
          : profile.tagline;

  return { value: truncateAtWord(chosen, max), max };
}

/**
 * <select> için en uygun seçeneği bulur.
 * Sıra: tam eşleşme → büyük/küçük harf duyarsız → substring → alias.
 */
export async function selectBestOption(
  locator: Locator,
  candidates: string[],
): Promise<string> {
  const options = await locator.locator('option').allTextContents();
  const values = await locator.locator('option').evaluateAll((els) =>
    els.map((el) => (el as HTMLOptionElement).value),
  );

  const pairs = options.map((label, i) => ({ label: label.trim(), value: values[i] ?? '' }));

  for (const candidate of candidates) {
    const exact = pairs.find((p) => p.label === candidate);
    if (exact) return exact.value;
  }
  for (const candidate of candidates) {
    const ci = pairs.find((p) => p.label.toLowerCase() === candidate.toLowerCase());
    if (ci) return ci.value;
  }
  for (const candidate of candidates) {
    const sub = pairs.find((p) => p.label.toLowerCase().includes(candidate.toLowerCase()));
    if (sub) return sub.value;
  }

  throw new ManualReviewError('Uygun kategori seçeneği bulunamadı', {
    candidates,
    available: pairs.slice(0, 20).map((p) => p.label),
  });
}

/**
 * Yazdıktan sonra değeri doğrular.
 * Sessizce kırpılmış açıklama klasik görünmez hatadır — burada yakalanır.
 */
export async function assertValueWritten(
  locator: Locator,
  expected: string,
): Promise<{ ok: boolean; actual: string }> {
  const actual = await locator.inputValue().catch(() => '');
  return { ok: actual === expected, actual };
}

/** Submit öncesi birkaç ara noktalı fare hareketi. */
export async function moveMouseTo(page: Page, locator: Locator): Promise<void> {
  const box = await locator.boundingBox().catch(() => null);
  if (!box) return;

  const targetX = box.x + box.width / 2;
  const targetY = box.y + box.height / 2;
  const steps = randInt(2, 4);

  for (let i = 1; i <= steps; i++) {
    await page.mouse.move(
      targetX * (i / steps) + randInt(-20, 20),
      targetY * (i / steps) + randInt(-20, 20),
    );
  }
  await page.mouse.move(targetX, targetY);
}
