/**
 * Sheet etiketlemesinin (annotate.ts) girdilerini diskten ve ledger'dan toplar.
 *
 * Neden ayrı: iki betik (sheet-annotate, sheet-ready-tab) aynı bilgiye muhtaç ve eskiden her biri kendi kopyasını
 * topluyordu; "Hazır" tanımı bu yüzden ayrışabilirdi. Burada tek yerde, test edilebilir biçimde toplanır.
 *
 * Kaynaklar: src/sites (kayıt config'leri ve notları), src/submissions (listeleme config'leri), ledger
 * (açık hesaplar, terminal denemeler, listeleme kayıtları), verify-drafts ilerlemesi, sekme tarama dosyası.
 */

import { existsSync, readdirSync, readFileSync } from 'node:fs';
import Database from 'better-sqlite3';
import { awaitsMoveApproval } from '../core/markers.js';
import { classifyRealRun, type ListingInfo, type RowInput } from './annotate.js';
import { isUnverified } from './generate-config.js';

export interface SourcePaths {
  sitesDir: string;
  submissionsDir: string;
  ledgerPath: string;
  verifyDraftsPath: string;
  /** Sekmeye özel tarama dosyası (data/discovery-<sekme>.json); yoksa boş sayılır. */
  discoveryPath: string;
}

export const defaultPaths = (tab: string): SourcePaths => ({
  sitesDir: 'src/sites',
  submissionsDir: 'src/submissions',
  ledgerPath: 'data/ledger.sqlite',
  verifyDraftsPath: 'data/verify-drafts/progress.json',
  discoveryPath: `data/discovery-${tab}.json`,
});

export interface ConfigInfo {
  risk?: string;
  unverified: boolean;
  awaitsMove: boolean;
  notes: string;
  signupUrl: string;
  /** Kayıt formunun parmak izi (aynı motoru kullanan siteleri bulmak için); belirsizse null. */
  signature: string | null;
  /** Hesap açılıyor ama e-posta doğrulanamıyor (site doğrulama maili göndermiyor). */
  unverifiedAccount: boolean;
}

export type VerificationInfo = NonNullable<RowInput['verification']>;

export interface AnnotateSources {
  configs: Map<string, ConfigInfo>;
  verification: Record<string, VerificationInfo>;
  discovery: Record<string, { outcome?: string }>;
  /** Gerçek (dry-run olmayan) tamamlanmış denemesi olan siteler: açık hesap. */
  withAccount: Set<string>;
  /** Gerçek denemesi kesin (terminal) bitmiş ve hesabı olmayan siteler. */
  blocked: Set<string>;
  accountNotes: Map<string, string>;
  listings: Map<string, ListingInfo>;
  familyBlocks: Map<string, { sorun: string; sourceId: string }>;
}

function readJson<T>(path: string, fallback: T): T {
  try {
    return JSON.parse(readFileSync(path, 'utf8')) as T;
  } catch {
    return fallback;
  }
}

/** Her formda bulunan, tek başına bir "motor" ayırt etmeyen alan seçicileri. */
const GENERIC_SELECTORS = new Set([
  '#email', '#password', '#username', '#name', '#user', '#login', '#confirm_password', '#password_confirm', '#confirmPassword', '#password2',
  "input[type='email']", "input[type='password']", "input[type='text']",
  "input[name='email']", "input[name='password']", "input[name='username']", "input[name='name']", "input[name='user']",
]);

/**
 * Kayıt formunun parmak izi: doldurulan alan seçicileri. Yalnızca en az 3 alan VE en az biri jenerik olmayan
 * (motora özgü) bir seçiciyse anlamlıdır; "#email|#password" gibi her yerde görülen ikililer aile belirtmez.
 */
export function engineSignature(steps: ReadonlyArray<{ type: string; selector?: string }>): string | null {
  const selectors = steps.filter((s) => s.type === 'fill' && s.selector).map((s) => s.selector as string);
  if (selectors.length < 3) return null;
  return selectors.some((s) => !GENERIC_SELECTORS.has(s)) ? selectors.join('|') : null;
}

const IMAGE_CAPTCHA = 'Görsel captcha (çözülmüyor)';
const FAMILY_IMAGE_CAPTCHA = 'Görsel captcha (aile)';

/** Config notundaki son "LİSTELEME: <sınıf> — <ayrıntı>" bölümü: bu sitede listeleme formunun bilinen engeli. */
export function listingBlockerFromNotes(notes: string): { blocker: string; blockerNote?: string } | null {
  const parts = notes.split(/\s\|\s/);
  for (let i = parts.length - 1; i >= 0; i--) {
    const m = /LİSTELEME:\s*([^—]+?)\s*(?:—\s*(.*))?$/.exec(parts[i] as string);
    if (m) return { blocker: `Listeleme: ${(m[1] as string).trim()}`, ...(m[2] ? { blockerNote: m[2].trim() } : {}) };
  }
  return null;
}

/**
 * Listeleme config'inin notundaki işaretler: "DÜZELTME GEREKİYOR" (yanlış metinle gönderilmiş, düzeltme bekliyor),
 * "BEKLETİLİYOR: <neden>" (gönderim bilinçli olarak durduruldu) ve "İNSAN GEREKİYOR: <neden>" (akış bir insanın girişini
 * bekler, ör. görsel doğrulama kodu). Sheet'te Not'a uyarı olarak düşer.
 */
export function listingCaveat(notes: string, state: 'sent' | 'other' = 'other'): string | undefined {
  if (notes.includes('DÜZELTME GEREKİYOR')) return 'Eski, yanlış ürün metniyle gönderildi — düzeltme bekliyor';
  // "Bekletiliyor" ve "insan gerekiyor" bir sonraki gönderimin nasıl yapılacağını söyler; gönderilmiş satırda alakasız ve yanıltıcıdır.
  if (state === 'sent') return undefined;
  const hold = /BEKLET[İI]L[İI]YOR:\s*([^|]+)/.exec(notes)?.[1]?.trim();
  if (hold) return `Bilinçli bekletiliyor: ${hold.replace(/\.$/, '')}`;
  const human = /[İI]NSAN GEREK[İI]YOR:\s*([^|]+)/.exec(notes)?.[1]?.trim();
  return human ? `İnsan gerekiyor: ${human.replace(/\.$/, '')}` : undefined;
}

const localDate = (ms: number): string => {
  const d = new Date(ms);
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
};

interface SubmissionRow {
  account_key: string;
  status: string;
  dry_run: number;
  started_at: number;
  listing_url: string | null;
  note: string | null;
}

export function loadAnnotateSources(paths: SourcePaths): AnnotateSources {
  // Kayıt config'leri
  const configs = new Map<string, ConfigInfo>();
  if (existsSync(paths.sitesDir)) {
    for (const file of readdirSync(paths.sitesDir).filter((f) => f.endsWith('.json'))) {
      const cfg = readJson<{
        risk?: string;
        notes?: string;
        signupUrl?: string;
        steps?: Array<{ type: string; selector?: string }>;
        verification?: { unverifiedAccount?: boolean };
      }>(`${paths.sitesDir}/${file}`, {});
      configs.set(file.slice(0, -5), {
        ...(cfg.risk ? { risk: cfg.risk } : {}),
        unverified: isUnverified(cfg),
        awaitsMove: awaitsMoveApproval(cfg),
        notes: cfg.notes ?? '',
        signupUrl: cfg.signupUrl ?? '',
        signature: engineSignature(cfg.steps ?? []),
        unverifiedAccount: cfg.verification?.unverifiedAccount === true,
      });
    }
  }

  const verification = readJson<Record<string, VerificationInfo>>(paths.verifyDraftsPath, {});
  const discovery = readJson<{ entries?: Record<string, { outcome?: string }> }>(paths.discoveryPath, {}).entries ?? {};

  // Ledger (salt okunur): varsayılan ürünün hesap anahtarı yalın siteId'dir; "ürün@site" anahtarları dışarıda kalır.
  const withAccount = new Set<string>();
  const terminal = new Set<string>();
  const accountNotes = new Map<string, string>();
  const submissions: SubmissionRow[] = [];
  if (existsSync(paths.ledgerPath)) {
    const db = new Database(paths.ledgerPath, { readonly: true, fileMustExist: true });
    try {
      // Aynı siteden birden çok tamamlanmış deneme olabilir (ör. sonradan "zaten mevcut" diyen yeniden koşu):
      // "şifre kullanıcıda" bilgisi hesabın kalıcı bir özelliğidir, bu yüzden HERHANGİ bir kayıtta geçmesi yeter.
      const passwordHeld = new Set<string>();
      for (const r of db
        .prepare("SELECT site_id, note FROM attempts WHERE status = 'completed' AND dry_run = 0 AND site_id NOT LIKE '%@%'")
        .all() as Array<{ site_id: string; note: string | null }>) {
        withAccount.add(r.site_id);
        if (/şifre kullanıcıda/i.test(r.note ?? '')) passwordHeld.add(r.site_id);
      }
      for (const siteId of withAccount) {
        const bits: string[] = [];
        if (passwordHeld.has(siteId)) bits.push('Şifre sistemde değil (kullanıcıda): otomatik giriş yapılamaz.');
        if (configs.get(siteId)?.unverifiedAccount) bits.push('E-posta doğrulanmadı: site doğrulama maili göndermiyor.');
        if (bits.length > 0) accountNotes.set(siteId, bits.join(' '));
      }
      for (const r of db.prepare("SELECT DISTINCT site_id FROM attempts WHERE terminal = 1 AND dry_run = 0 AND site_id NOT LIKE '%@%'").all() as Array<{ site_id: string }>) {
        terminal.add(r.site_id);
      }
      submissions.push(
        ...(db
          .prepare("SELECT account_key, status, dry_run, started_at, listing_url, note FROM submissions WHERE account_key NOT LIKE '%@%' ORDER BY started_at")
          .all() as SubmissionRow[]),
      );
    } finally {
      db.close();
    }
  }
  const blocked = new Set([...terminal].filter((id) => !withAccount.has(id)));

  // Listeleme: config var mı, dry-run geçti mi, gerçek gönderim var mı, bilinen engel / düzeltme uyarısı.
  const listings = new Map<string, ListingInfo>();
  const submissionConfigs = new Map<string, string>();
  if (existsSync(paths.submissionsDir)) {
    for (const file of readdirSync(paths.submissionsDir).filter((f) => f.endsWith('.json'))) {
      submissionConfigs.set(file.slice(0, -5), readJson<{ notes?: string }>(`${paths.submissionsDir}/${file}`, {}).notes ?? '');
    }
  }
  const ids = new Set<string>([...submissionConfigs.keys(), ...submissions.map((s) => s.account_key), ...configs.keys()]);
  for (const id of ids) {
    const rows = submissions.filter((s) => s.account_key === id);
    const live = rows.filter((s) => s.dry_run === 0 && s.status !== 'failed');
    const done = live.find((s) => s.status === 'completed');
    const hasConfig = submissionConfigs.has(id);
    const blocker = listingBlockerFromNotes(configs.get(id)?.notes ?? '');
    const caveat = listingCaveat(submissionConfigs.get(id) ?? '');

    let info: ListingInfo;
    if (done) {
      const sentCaveat = listingCaveat(submissionConfigs.get(id) ?? '', 'sent');
      // Herkese açık olduğu insan kanıtıyla doğrulanmış mı? (`verify-listing`, notun başındaki işaret; ledger.ts PUBLIC_VERIFIED_PREFIX)
      const publicVerified = (done.note ?? '').startsWith('herkese açık doğrulandı');
      info = { state: 'sent', url: done.listing_url, date: localDate(done.started_at), ...(publicVerified ? { publicVerified } : {}), ...(sentCaveat ? { caveat: sentCaveat } : {}) };
    } else if (live.length > 0) {
      info = { state: 'unconfirmed', url: live[live.length - 1]?.listing_url ?? null, date: localDate((live[live.length - 1] as SubmissionRow).started_at) };
    } else if (hasConfig && rows.some((s) => s.dry_run === 1 && s.status === 'completed')) {
      info = { state: 'ready', ...(caveat ? { caveat } : {}) };
    } else {
      info = { state: 'none' };
    }
    if (blocker) Object.assign(info, blocker);
    if (info.state !== 'none' || blocker) listings.set(id, info);
  }

  // Aile çıkarımı: bir sitede motor düzeyinde bir engel (görsel captcha) gerçek denemede doğrulandıysa, aynı kayıt
  // formunu kullanan ve henüz denenmemiş siteler "Hazır" sayılmaz (sınıf tahmindir, notta öyle yazar).
  const familyBlocks = new Map<string, { sorun: string; sourceId: string }>();
  const blockedSignatures = new Map<string, string>();
  for (const id of blocked) {
    const cfg = configs.get(id);
    if (cfg?.signature && classifyRealRun(cfg.notes)?.sorun === IMAGE_CAPTCHA && !blockedSignatures.has(cfg.signature)) {
      blockedSignatures.set(cfg.signature, id);
    }
  }
  for (const [id, cfg] of configs) {
    if (!cfg.signature || withAccount.has(id) || blocked.has(id)) continue;
    const sourceId = blockedSignatures.get(cfg.signature);
    if (sourceId) familyBlocks.set(id, { sorun: FAMILY_IMAGE_CAPTCHA, sourceId });
  }

  return { configs, verification, discovery, withAccount, blocked, accountNotes, listings, familyBlocks };
}

/** Bir Sheet satırı (siteId) için annotate girdisini kurar. */
export function rowInputFor(siteId: string, s: AnnotateSources): RowInput {
  const cfg = s.configs.get(siteId);
  return {
    hasAccount: s.withAccount.has(siteId),
    blocked: s.blocked.has(siteId),
    config: cfg ? { ...(cfg.risk ? { risk: cfg.risk } : {}), unverified: cfg.unverified, awaitsMove: cfg.awaitsMove, notes: cfg.notes } : null,
    verification: s.verification[siteId] ?? null,
    discovery: s.discovery[siteId]?.outcome ?? null,
    listing: s.listings.get(siteId) ?? null,
    ...(s.accountNotes.has(siteId) ? { accountNote: s.accountNotes.get(siteId) as string } : {}),
    familyBlock: s.familyBlocks.get(siteId) ?? null,
  };
}
