/**
 * Panelin sayı ve tarih biçimleri.
 *
 * Sunucu (Vercel) UTC'de çalışır; ekip İstanbul'da. Tarihler saat dilimi
 * AÇIKÇA verilerek biçimlenir — yoksa gece yarısı civarındaki bir kayıt
 * sunucuda bir gün, tarayıcıda başka bir gün görünür.
 */

export const PANEL_TZ = 'Europe/Istanbul';

const int = new Intl.NumberFormat('en-US');

export function formatInt(n: number): string {
  return int.format(n);
}

/** "28%"; sıfır olmayan ama yuvarlanınca 0 çıkan pay "<1%" (kaybolmasın). */
export function formatShare(part: number, whole: number): string {
  if (whole <= 0) return '—';
  const pct = (part / whole) * 100;
  if (part > 0 && pct < 1) return '<1%';
  return `${Math.round(pct)}%`;
}

// Ay ve gün adları elle: Intl'in kısaltmaları ICU sürümüne göre değişiyor
// ("Sep" / "Sept"), sunucu ile test ortamı aynı metni üretmeli.
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'] as const;
const WEEKDAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'] as const;

const partsFmt = new Intl.DateTimeFormat('en-GB', {
  timeZone: PANEL_TZ,
  year: 'numeric',
  month: 'numeric',
  day: 'numeric',
  hour: '2-digit',
  minute: '2-digit',
  hourCycle: 'h23',
});

function zonedParts(iso: string): { year: string; month: string; day: string; hour: string; minute: string } {
  const parts = Object.fromEntries(partsFmt.formatToParts(new Date(iso)).map((p) => [p.type, p.value]));
  return {
    year: parts.year ?? '',
    month: MONTHS[Number(parts.month) - 1] ?? '',
    day: String(Number(parts.day)),
    hour: parts.hour ?? '',
    minute: parts.minute ?? '',
  };
}

/** "30 Sep 2026" */
export function formatDate(iso: string | null): string {
  if (!iso) return '—';
  const p = zonedParts(iso);
  return `${p.day} ${p.month} ${p.year}`;
}

/** "30 Sep, 04:30" */
export function formatDateTime(iso: string | null): string {
  if (!iso) return '—';
  const p = zonedParts(iso);
  return `${p.day} ${p.month}, ${p.hour}:${p.minute}`;
}

/** Bugünün takvim günü panel saat diliminde ("2026-10-04"). */
export function todayInPanelTz(now: Date): string {
  const parts = Object.fromEntries(partsFmt.formatToParts(now).map((p) => [p.type, p.value]));
  return `${parts.year}-${String(parts.month).padStart(2, '0')}-${String(parts.day).padStart(2, '0')}`;
}

/** Veritabanından gelen takvim günü ("2026-09-22") → "22 Sep". Saat dilimi çevrilmez. */
export function formatDay(day: string, withWeekday = false): string {
  const d = new Date(`${day}T00:00:00Z`);
  const text = `${d.getUTCDate()} ${MONTHS[d.getUTCMonth()]}`;
  return withWeekday ? `${WEEKDAYS[d.getUTCDay()]} ${text}` : text;
}

/** "just now", "4 min ago", "3 h ago", "2 days ago" */
export function formatAgo(iso: string, now: Date): string {
  const sec = Math.max(0, Math.floor((now.getTime() - new Date(iso).getTime()) / 1000));
  if (sec < 60) return 'just now';
  const min = Math.floor(sec / 60);
  if (min < 60) return `${min} min ago`;
  const hours = Math.floor(min / 60);
  if (hours < 48) return `${hours} h ago`;
  return `${Math.floor(hours / 24)} days ago`;
}

export function plural(n: number, one: string, many = `${one}s`): string {
  return `${formatInt(n)} ${n === 1 ? one : many}`;
}

/**
 * Sheet'ten gelen adres bağlantı yapılmadan önce süzülür: sonuç her zaman
 * http(s) bir adrestir ya da null. Sheet'e yazılmış bir `javascript:` adresi
 * panelde tıklanabilir olmamalı.
 *
 * Sheet'teki adreslerin bir kısmı şemasızdır ("10words.io",
 * "airtable.com/marketplace"); onlara https:// eklenir.
 */
export function safeHttpUrl(url: string | null | undefined): string | null {
  const raw = url?.trim();
  if (!raw) return null;
  // "alan:8080/yol" şema değil, port; "javascript:…" şemadır.
  const hasScheme = /^[a-z][a-z0-9+.-]*:/i.test(raw) && !/^[^/:]+:\d+(\/|$)/.test(raw);
  try {
    const parsed = new URL(hasScheme ? raw : `https://${raw}`);
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return null;
    // Noktasız "alan adı" (serbest metin, "localhost") bağlantı değildir.
    return parsed.hostname.includes('.') ? parsed.href : null;
  } catch {
    return null;
  }
}

/** "https://www.example.com/join" → "example.com" */
export function hostOf(url: string | null | undefined): string | null {
  const safe = safeHttpUrl(url);
  return safe ? new URL(safe).hostname.replace(/^www\./, '') : null;
}
