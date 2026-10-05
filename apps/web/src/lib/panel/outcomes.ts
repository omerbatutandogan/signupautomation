/**
 * Tarama sonuçlarının panel sözlüğü ve sekme × sonuç tablosu.
 *
 * Saf modül: veritabanı görünümlerinden (v_scan_map, v_unique_outcomes) gelen
 * satırları ekranda gösterilecek biçime çevirir. Sonuç anahtarları veritabanı
 * enum'undan gelir; burada tanınmayan bir anahtar (ileride eklenen bir sonuç)
 * SESSİZCE düşürülmez, kendi adıyla ayrı bir kolon olur.
 */

export interface OutcomeMeta {
  /** Tablo başlığı — kısa. */
  label: string;
  description: string;
}

/** En otomatikleşebilirden en az otomatikleşebilire: kolon ve satır sırası. */
const OUTCOMES = {
  config: {
    label: 'Signup config',
    description: 'A signup form was found and the site has a config (draft or verified).',
  },
  generated: {
    label: 'Draft generated',
    description: 'A signup form was found and a draft config was generated from it.',
  },
  has_config: {
    label: 'Config existed',
    description: 'The site already had a config (usually found through another tab), so it was not rescanned.',
  },
  skipped_existing: {
    label: 'Skipped',
    description: 'Skipped because a config already existed when the scan reached it.',
  },
  submit_form: {
    label: 'Submit form',
    description: 'No account signup: the site takes listings through a submission form. Needs a different flow.',
  },
  email_first: {
    label: 'Email-first',
    description: 'Signup starts with an email-only step (magic link or multi-step). Needs a different flow.',
  },
  bot_protected: {
    label: 'Bot protection',
    description: 'Stopped by a bot challenge (Cloudflare, hCaptcha, …). Not bypassed, by policy.',
  },
  high_risk: {
    label: 'High risk',
    description: 'Flagged as high risk and excluded from automation.',
  },
  no_form: {
    label: 'No signup form',
    description: 'No signup page or form was found (dead or parked domain, login only, invite only, …).',
  },
  error: {
    label: 'Scan error',
    description: 'The scan did not finish for this site (timeout or browser crash). Queued for a retry.',
  },
  not_scanned: {
    label: 'Not scanned',
    description: 'In the sheet, but not reached by a scan yet.',
  },
} satisfies Record<string, OutcomeMeta>;

export type KnownOutcome = keyof typeof OUTCOMES;

export const OUTCOME_ORDER = Object.keys(OUTCOMES) as KnownOutcome[];

export function isKnownOutcome(key: string): key is KnownOutcome {
  return Object.hasOwn(OUTCOMES, key);
}

export function outcomeMeta(key: string): OutcomeMeta {
  return isKnownOutcome(key) ? OUTCOMES[key] : { label: key, description: '' };
}

/** Bilinen sıra önce; tanınmayan anahtarlar sonda, alfabetik. */
export function sortOutcomes(keys: Iterable<string>): string[] {
  const rank = (k: string) => (isKnownOutcome(k) ? OUTCOME_ORDER.indexOf(k) : OUTCOME_ORDER.length);
  return [...new Set(keys)].sort((a, b) => rank(a) - rank(b) || a.localeCompare(b));
}

// ── Sekme × sonuç tablosu ─────────────────────────────────────────────────

export interface ScanMapRow {
  tab: string | null;
  outcome: string | null;
  sites: number | null;
}

export interface TabCounts {
  tab: string;
  total: number;
  counts: Record<string, number>;
}

export interface ScanMatrix {
  /** Sıfırdan büyük en az bir hücresi olan sonuçlar, gösterim sırasıyla. */
  columns: string[];
  tabs: TabCounts[];
  totals: Record<string, number>;
  grandTotal: number;
}

export function pivotScanMap(rows: readonly ScanMapRow[]): ScanMatrix {
  const byTab = new Map<string, TabCounts>();
  const totals: Record<string, number> = {};
  let grandTotal = 0;

  for (const r of rows) {
    if (r.tab === null || r.outcome === null || !r.sites) continue;
    let row = byTab.get(r.tab);
    if (!row) byTab.set(r.tab, (row = { tab: r.tab, total: 0, counts: {} }));
    row.counts[r.outcome] = (row.counts[r.outcome] ?? 0) + r.sites;
    row.total += r.sites;
    totals[r.outcome] = (totals[r.outcome] ?? 0) + r.sites;
    grandTotal += r.sites;
  }

  return {
    columns: sortOutcomes(Object.keys(totals)),
    tabs: [...byTab.values()].sort((a, b) => a.tab.localeCompare(b.tab)),
    totals,
    grandTotal,
  };
}

// ── Isı tablosu sınıfları ─────────────────────────────────────────────────

/** Hücrenin sekme içindeki payına göre 5 sınıf; 0 = boş hücre (dolgu yok). */
export const HEAT_BINS = [
  { bin: 1, upTo: 0.05, label: 'under 5%' },
  { bin: 2, upTo: 0.15, label: '5–15%' },
  { bin: 3, upTo: 0.3, label: '15–30%' },
  { bin: 4, upTo: 0.5, label: '30–50%' },
  { bin: 5, upTo: Infinity, label: '50% or more' },
] as const;

export type HeatBin = 0 | 1 | 2 | 3 | 4 | 5;

export function heatBin(count: number, total: number): HeatBin {
  if (count <= 0 || total <= 0) return 0;
  const share = count / total;
  return (HEAT_BINS.find((b) => share < b.upTo) ?? HEAT_BINS[HEAT_BINS.length - 1]).bin;
}
