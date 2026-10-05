import { describe, expect, it } from 'vitest';
import { formatAgo, formatDate, formatDateTime, formatDay, formatShare, hostOf, safeHttpUrl, todayInPanelTz } from './format';
import { buildProductMatrix } from './matrix';
import { heatBin, outcomeMeta, pivotScanMap, sortOutcomes } from './outcomes';
import { estimateEta, niceScale, syncState } from './queue';
import { countOf, fetchAllPages, unwrap, unwrapOptional } from './result';

/**
 * Panelin saf hesapları. Bunlar ekrandaki rakamların kendisi: yanlış bir
 * toplam ya da kayan bir gün Emre'ye yanlış durum bildirir.
 */

describe('pivotScanMap', () => {
  const rows = [
    { tab: 'SaaS', outcome: 'generated', sites: 40 },
    { tab: 'SaaS', outcome: 'no_form', sites: 60 },
    { tab: 'Deals ', outcome: 'bot_protected', sites: 5 },
    { tab: 'Deals ', outcome: 'generated', sites: 15 },
  ];

  it('sekme toplamlarını, kolon toplamlarını ve genel toplamı tutarlı verir', () => {
    const m = pivotScanMap(rows);
    expect(m.grandTotal).toBe(120);
    expect(m.totals).toEqual({ generated: 55, no_form: 60, bot_protected: 5 });
    expect(m.tabs.map((t) => [t.tab, t.total])).toEqual([
      ['Deals ', 20],
      ['SaaS', 100],
    ]);
    // Her hücre tam bir kez sayılır: satır toplamları = kolon toplamları = genel toplam.
    expect(m.tabs.reduce((n, t) => n + t.total, 0)).toBe(m.grandTotal);
    expect(Object.values(m.totals).reduce((a, b) => a + b, 0)).toBe(m.grandTotal);
  });

  it('kolonları otomatikleşebilirlik sırasına dizer, boş kolon göstermez', () => {
    expect(pivotScanMap(rows).columns).toEqual(['generated', 'bot_protected', 'no_form']);
  });

  it('sondaki boşluklu sekme adını ayrı sekme olarak korur', () => {
    const m = pivotScanMap([
      { tab: 'Deals ', outcome: 'generated', sites: 1 },
      { tab: 'Deals', outcome: 'generated', sites: 2 },
    ]);
    expect(m.tabs.map((t) => t.tab)).toEqual(['Deals', 'Deals ']);
  });

  it('tanınmayan sonucu düşürmez: kendi adıyla sona ekler', () => {
    const m = pivotScanMap([...rows, { tab: 'SaaS', outcome: 'needs_phone', sites: 3 }]);
    expect(m.columns).toEqual(['generated', 'bot_protected', 'no_form', 'needs_phone']);
    expect(m.grandTotal).toBe(123);
    expect(outcomeMeta('needs_phone').label).toBe('needs_phone');
  });

  it('eksik alanlı satırları (görünümden null) saymaz', () => {
    const m = pivotScanMap([{ tab: null, outcome: 'generated', sites: 5 }, { tab: 'SaaS', outcome: null, sites: 5 }]);
    expect(m.grandTotal).toBe(0);
    expect(m.tabs).toEqual([]);
  });
});

describe('sortOutcomes', () => {
  it('yinelenenleri atar ve bilinen sırayı kullanır', () => {
    expect(sortOutcomes(['error', 'config', 'error', 'no_form'])).toEqual(['config', 'no_form', 'error']);
  });
});

describe('heatBin', () => {
  it('payı beş sınıfa ayırır; sınır değer üst sınıfa girer', () => {
    expect(heatBin(0, 100)).toBe(0);
    expect(heatBin(1, 100)).toBe(1);
    expect(heatBin(5, 100)).toBe(2);
    expect(heatBin(15, 100)).toBe(3);
    expect(heatBin(30, 100)).toBe(4);
    expect(heatBin(50, 100)).toBe(5);
    expect(heatBin(100, 100)).toBe(5);
  });
  it('boş sekmede dolgu yok', () => {
    expect(heatBin(0, 0)).toBe(0);
  });
});

describe('estimateEta', () => {
  it('kuyruk boşsa bitiş yok', () => {
    expect(estimateEta(0, 12, 0, '2026-10-04')).toEqual({ days: 0, finishDay: null });
  });
  it('bugünün kalan hakkına sığıyorsa bugün biter', () => {
    expect(estimateEta(2, 12, 0, '2026-10-04')).toEqual({ days: 1, finishDay: '2026-10-04' });
    expect(estimateEta(2, 12, 10, '2026-10-04')).toEqual({ days: 1, finishDay: '2026-10-04' });
  });
  it('bugünün hakkı bittiyse yarına sarkar', () => {
    expect(estimateEta(2, 12, 12, '2026-10-04')).toEqual({ days: 2, finishDay: '2026-10-05' });
    // Limit aşılmış gün (elle zorlanmış çalıştırma) eksi hak üretmez.
    expect(estimateEta(2, 12, 16, '2026-10-04')).toEqual({ days: 2, finishDay: '2026-10-05' });
  });
  it('669 taslak günde 12 ile 56 gün sürer (ay sonunu doğru geçer)', () => {
    expect(estimateEta(669, 12, 0, '2026-10-04')).toEqual({ days: 56, finishDay: '2026-11-28' });
  });
});

describe('syncState', () => {
  const now = new Date('2026-10-04T10:00:00Z');
  const at = (minutesAgo: number) => new Date(now.getTime() - minutesAgo * 60_000).toISOString();

  it('hiç başarılı senkron yoksa never', () => {
    expect(syncState(null, now)).toBe('never');
    expect(syncState({ last_ok_at: null, last_run_at: at(1), last_error: 'x' }, now)).toBe('never');
  });
  it('10 dakikaya kadar taze, sonrası eski (Mac uykuda)', () => {
    expect(syncState({ last_ok_at: at(5), last_run_at: at(5), last_error: null }, now)).toBe('fresh');
    expect(syncState({ last_ok_at: at(11), last_run_at: at(11), last_error: null }, now)).toBe('stale');
  });
  it('başarılı ama eksikli tur warning', () => {
    expect(syncState({ last_ok_at: at(1), last_run_at: at(1), last_error: 'Sheet could not be read' }, now)).toBe('warning');
  });
  it('senkron çalışıyor ama hata veriyorsa "eski" değil "failing" der', () => {
    // Son başarılı tur 30 dk önce, ama senkron 1 dk önce çalışıp hata vermiş:
    // sorun Mac'in uyuması değil, senkronun kendisi.
    expect(syncState({ last_ok_at: at(30), last_run_at: at(1), last_error: 'accounts yazılamadı' }, now)).toBe('failing');
    // Henüz 10 dakika dolmadan da hata görünür olmalı.
    expect(syncState({ last_ok_at: at(4), last_run_at: at(2), last_error: 'x' }, now)).toBe('failing');
  });
  it('eski bir hata kaydı "failing" değil "stale" gösterir (Mac gece boyu uyudu)', () => {
    // Wi-Fi koptu, tur 3 saat önce hata verdi, sonra Mac uyudu: senkron ÇALIŞMIYOR.
    expect(syncState({ last_ok_at: at(200), last_run_at: at(180), last_error: 'fetch failed' }, now)).toBe('stale');
    // Zamanlanmış turun en seyrek hali 60 dk: 70 dk içindeki hata hâlâ "çalışıyor ama hatalı".
    expect(syncState({ last_ok_at: at(300), last_run_at: at(69), last_error: 'x' }, now)).toBe('failing');
    expect(syncState({ last_ok_at: at(300), last_run_at: at(71), last_error: 'x' }, now)).toBe('stale');
  });
  it('hata sonrası başarılı tur durumu temizler', () => {
    expect(syncState({ last_ok_at: at(1), last_run_at: at(1), last_error: null }, now)).toBe('fresh');
  });
});

describe('sorgu sonuçları (yanlış sıfır yok)', () => {
  it('hata varsa fırlatır', () => {
    expect(() => unwrap({ data: null, error: { message: 'permission denied' } }, 'Accounts')).toThrow(/Accounts could not be loaded: permission denied/);
    expect(() => countOf({ count: null, error: { message: 'boom' } }, 'Sites')).toThrow(/Sites could not be counted: boom/);
  });

  it('sayı gelmediyse 0 saymaz, fırlatır (HEAD isteğinde 404 hata olarak gelmez)', () => {
    expect(() => countOf({ count: null, error: null }, 'Accounts')).toThrow(/no count returned/);
    expect(countOf({ count: 0, error: null }, 'Accounts')).toBe(0);
    expect(countOf({ count: 6, error: null }, 'Accounts')).toBe(6);
  });

  it('veri gelmediyse boş liste saymaz, fırlatır; boş liste ise geçerlidir', () => {
    expect(() => unwrap({ data: null, error: null }, 'Accounts')).toThrow(/empty response/);
    expect(unwrap({ data: [], error: null }, 'Accounts')).toEqual([]);
    expect(unwrap({ data: 0, error: null }, 'Usage')).toBe(0);
  });

  it('tek satır sorgusunda satırın olmaması geçerlidir', () => {
    expect(unwrapOptional({ data: null, error: null }, 'Sync status')).toBeNull();
    expect(() => unwrapOptional({ data: null, error: { message: 'x' } }, 'Sync status')).toThrow();
  });

  const pager = (total: number, serverMax: number) => {
    const calls: [number, number][] = [];
    const page = async (from: number, to: number) => {
      calls.push([from, to]);
      const end = Math.min(total, to + 1, from + serverMax);
      return { data: Array.from({ length: Math.max(0, end - from) }, (_, i) => from + i), error: null, count: total };
    };
    return { page, calls };
  };

  it('listeyi sayfa sayfa eksiksiz çeker', async () => {
    const { page, calls } = pager(2500, 1000);
    const rows = await fetchAllPages(page, 'Accounts');
    expect(rows).toHaveLength(2500);
    expect(rows[2499]).toBe(2499);
    expect(calls).toEqual([[0, 999], [1000, 1999], [2000, 2999]]);
  });

  it('küçük liste tek istekte biter', async () => {
    const { page, calls } = pager(6, 1000);
    expect(await fetchAllPages(page, 'Accounts')).toHaveLength(6);
    expect(calls).toHaveLength(1);
  });

  it('sunucu sayfa sınırı beklenenden küçükse de eksik bırakmaz', async () => {
    const { page } = pager(900, 400);
    expect(await fetchAllPages(page, 'Accounts')).toHaveLength(900);
  });

  it('sunucu toplamdan az satır verip durursa fırlatır', async () => {
    const page = async (from: number) => ({ data: from === 0 ? [1, 2] : [], error: null, count: 5 });
    await expect(fetchAllPages(page, 'Accounts')).rejects.toThrow(/got 2 of 5 rows/);
  });

  it('sayfa hatası listeyi yarım döndürmez', async () => {
    const page = async (from: number) =>
      from === 0 ? { data: [1], error: null, count: 3 } : { data: null, error: { message: 'timeout' }, count: null };
    await expect(fetchAllPages(page, 'Accounts')).rejects.toThrow(/timeout/);
  });
});

describe('niceScale', () => {
  it('ekseni temiz sayılara yuvarlar', () => {
    expect(niceScale(16)).toEqual({ top: 20, step: 5 });
    expect(niceScale(12)).toEqual({ top: 15, step: 5 });
    expect(niceScale(3)).toEqual({ top: 3, step: 1 });
    expect(niceScale(0)).toEqual({ top: 1, step: 1 });
  });
});

describe('biçimler', () => {
  it('sıfır olmayan küçük payı "<1%" gösterir (kaybolmasın)', () => {
    expect(formatShare(7, 2497)).toBe('<1%');
    expect(formatShare(706, 2497)).toBe('28%');
    expect(formatShare(0, 2497)).toBe('0%');
    expect(formatShare(1, 0)).toBe('—');
  });

  it('tarihleri İstanbul saatine göre yazar (UTC gece yarısı öncesi ertesi gündür)', () => {
    // 22:30 UTC = ertesi gün 01:30 İstanbul.
    expect(formatDate('2026-09-29T22:30:00Z')).toBe('30 Sep 2026');
    expect(formatDateTime('2026-09-29T22:30:00Z')).toBe('30 Sep, 01:30');
    expect(formatDate(null)).toBe('—');
    expect(todayInPanelTz(new Date('2026-09-29T22:30:00Z'))).toBe('2026-09-30');
    expect(todayInPanelTz(new Date('2026-01-05T08:00:00Z'))).toBe('2026-01-05');
  });

  it('takvim gününü saat dilimine çevirmeden yazar', () => {
    expect(formatDay('2026-09-22')).toBe('22 Sep');
    expect(formatDay('2026-09-22', true)).toBe('Tue 22 Sep');
  });

  it('geçen süreyi okunur yazar', () => {
    const now = new Date('2026-10-04T10:00:00Z');
    expect(formatAgo('2026-10-04T09:59:30Z', now)).toBe('just now');
    expect(formatAgo('2026-10-04T09:56:00Z', now)).toBe('4 min ago');
    expect(formatAgo('2026-10-04T07:00:00Z', now)).toBe('3 h ago');
    expect(formatAgo('2026-10-01T10:00:00Z', now)).toBe('3 days ago');
    // Saat farkı yüzünden "gelecekte" görünen damga eksi süre üretmez.
    expect(formatAgo('2026-10-04T10:00:05Z', now)).toBe('just now');
  });
});

describe('safeHttpUrl', () => {
  it('http(s) adresini bağlantı yapar', () => {
    expect(safeHttpUrl('https://example.com/join')).toBe('https://example.com/join');
    expect(safeHttpUrl('http://example.com')).toBe('http://example.com/');
  });
  it('Sheet\'teki şemasız adresi https ile tamamlar', () => {
    expect(safeHttpUrl('10words.io')).toBe('https://10words.io/');
    expect(safeHttpUrl('airtable.com/marketplace')).toBe('https://airtable.com/marketplace');
    expect(safeHttpUrl('  betalist.com ')).toBe('https://betalist.com/');
    expect(safeHttpUrl('example.com:8080/x')).toBe('https://example.com:8080/x');
  });
  it('betik ve veri adreslerini reddeder (Sheet güvenilmez girdi)', () => {
    expect(safeHttpUrl('javascript:alert(1)')).toBeNull();
    expect(safeHttpUrl(' JavaScript:alert(1)')).toBeNull();
    expect(safeHttpUrl('javascript:1')).toBeNull();
    expect(safeHttpUrl('data:text/html,<script>alert(1)</script>')).toBeNull();
    expect(safeHttpUrl('ftp://example.com/file')).toBeNull();
  });
  it('adres olmayan metni bağlantı yapmaz', () => {
    expect(safeHttpUrl('not a url')).toBeNull();
    expect(safeHttpUrl('localhost')).toBeNull();
    expect(safeHttpUrl('')).toBeNull();
    expect(safeHttpUrl(null)).toBeNull();
  });
  it('sonuç her zaman http(s) ile başlar', () => {
    for (const input of ['javascript:alert(1)', 'x.io', 'vbscript:msgbox(1)', 'JAVASCRIPT://x.io/%0aalert(1)', '//evil.example/x']) {
      const out = safeHttpUrl(input);
      if (out !== null) expect(out).toMatch(/^https?:\/\//);
    }
  });
  it('alan adını www olmadan verir', () => {
    expect(hostOf('https://www.example.com/join?x=1')).toBe('example.com');
    expect(hostOf('360quadrants.com')).toBe('360quadrants.com');
    expect(hostOf('javascript:alert(1)')).toBeNull();
  });
});
describe('buildProductMatrix', () => {
  const configs = [
    { siteId: 'awwwards', risk: 'low' },
    { siteId: 'crunchbase', risk: 'high' },
    { siteId: 'devhunt', risk: null },
  ];
  const accounts = [
    { product_id: 'geo-new', site_id: 'awwwards', status: 'opened' },
    { product_id: 'geo-new', site_id: 'betalist', status: 'already_existed' },
    { product_id: 'geo-new', site_id: 'crunchbase', status: 'opened' },
  ];
  const ready = (id: string) => ({ id, status: 'ready' });

  it('her ürün için sitenin durumunu verir', () => {
    const rows = buildProductMatrix([ready('acme-crm'), ready('geo-new')], configs, accounts);
    expect(rows).toEqual([
      { siteId: 'awwwards', cells: ['ready', 'opened'] },
      // Config'i doğrulanmış değil ama hesabı var: satır yine görünür.
      { siteId: 'betalist', cells: ['none', 'already_existed'] },
      // Yüksek risk yeni kaydı engeller; açılmış hesabı gizlemez.
      { siteId: 'crunchbase', cells: ['high_risk', 'opened'] },
      { siteId: 'devhunt', cells: ['ready', 'ready'] },
    ]);
  });

  it('son gerçek denemesi terminal biten çift "hazır" değil, ilgi bekler', () => {
    // İşçi terminal sonucu olan hesabı --force olmadan yeniden denemez.
    const rows = buildProductMatrix([ready('geo-new')], configs, accounts, [
      { productId: 'geo-new', siteId: 'devhunt' },
      // Config'i artık doğrulanmış olmayan sitede de görünür.
      { productId: 'geo-new', siteId: 'alternativeto' },
    ]);
    expect(rows.find((r) => r.siteId === 'devhunt')?.cells).toEqual(['blocked']);
    expect(rows.find((r) => r.siteId === 'alternativeto')?.cells).toEqual(['blocked']);
    // Hesabı olan çift engelli sayılmaz.
    expect(rows.find((r) => r.siteId === 'awwwards')?.cells).toEqual(['opened']);
  });

  it('taslak ürün kayda giremez: doğrulanmış sitede "hazır" görünmez', () => {
    const rows = buildProductMatrix([{ id: 'acme-crm', status: 'draft' }, ready('geo-new')], configs, accounts);
    expect(rows.find((r) => r.siteId === 'devhunt')?.cells).toEqual(['none', 'ready']);
  });

  it('ürün yoksa satırlar boş hücreyle döner, hesap/config yoksa satır yok', () => {
    expect(buildProductMatrix([], configs, [])).toHaveLength(3);
    expect(buildProductMatrix([ready('geo-new')], [], [])).toEqual([]);
  });
});
