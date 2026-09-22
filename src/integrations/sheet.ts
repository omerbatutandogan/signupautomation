/**
 * Google Sheets — insan görünürlüğü katmanı.
 *
 * ÖNEMLİ: Sheet otorite DEĞİL. Otorite SQLite ledger'da (atomik kilit,
 * idempotency). Sheet yalnızca Emre'nin/Batu'nun bakıp ilerlemeyi görmesi
 * için. Bu yüzden her Sheet işlemi hata toleranslı: erişim koparsa uyarı
 * basılır ama çalıştırma DÜŞMEZ.
 *
 * Kimlik: Gmail ile aynı OAuth token (spreadsheets scope eklendi). Sheet
 * kayıt hesabının kendi Drive'ında olduğu için ayrı service account ve
 * paylaşım gerekmiyor.
 */

import { readFile } from 'node:fs/promises';
import { auth as googleAuth, sheets as sheetsApi, type sheets_v4 } from '@googleapis/sheets';
import type { Logger } from 'pino';
import { env } from '../config.js';
import type { RiskLevel, TerminalStatus } from '../core/types.js';

/** Sheet'teki Durum kolonunun değerleri — core/types.ts'teki STATUS ile hizalı. */
export const SHEET_STATUS = {
  PENDING: 'Bekliyor',
  IN_PROGRESS: 'İşleniyor',
  DONE: 'Tamamlandı',
  ERROR: 'Hata',
  FAILED: 'Başarısız',
  MANUAL: 'Manuel Gerekli',
  EMAIL_TIMEOUT: 'Doğrulama Zaman Aşımı',
} as const;

/**
 * TerminalStatus → Sheet'te gösterilecek metin.
 *
 * skipped_terminal burada YOK: "zaten bitmiş" demek, ama nasıl bittiğini
 * (başarı mı hata mı) bu durum taşımıyor. Sheet'teki mevcut değeri
 * bozmamak için writeOutcome onu atlıyor.
 */
const STATUS_LABEL: Partial<Record<TerminalStatus, string>> = {
  completed: SHEET_STATUS.DONE,
  failed: SHEET_STATUS.FAILED,
  error: SHEET_STATUS.ERROR,
  manual: SHEET_STATUS.MANUAL,
  email_timeout: SHEET_STATUS.EMAIL_TIMEOUT,
  // Kilit/limit geçici — satır bekliyor durumunda kalmalı.
  skipped_locked: SHEET_STATUS.PENDING,
  skipped_limit: SHEET_STATUS.PENDING,
  skipped_high_risk: SHEET_STATUS.MANUAL,
};

/** Kod tarafında beklenen kolon başlıkları. */
export const COLUMNS = {
  name: 'Name',
  website: 'Website',
  // Alternatif kolon adları — sekmeler arası şema farkı var.
  // SaaS: Name + Website · Directory: URL (Name yok).
  type: 'Type',
  status: 'Durum',
  email: 'E-posta',
  username: 'Kullanıcı Adı',
  risk: 'Risk',
  attempts: 'Deneme',
  lastRun: 'Son Çalıştırma',
  note: 'Not',
  profileUrl: 'Profil URL',
} as const;

/** Site adresi kolonunun olası adları — sekmeler arası şema farkı. */
const WEBSITE_ALIASES = ['Website', 'URL', 'Site', 'Link', 'Domain'] as const;

/** Site adı kolonunun olası adları. Opsiyonel — yoksa id kullanılır. */
const NAME_ALIASES = ['Name', 'Site Name', 'Title'] as const;

export interface SheetRow {
  /** 1-tabanlı satır numarası (başlık satırı dahil). */
  rowNumber: number;
  name: string;
  website: string;
  type: string;
  status: string;
  risk: string;
  note: string;
  /** Site id'si — website'ten türetilir. */
  siteId: string;
}

/** Website URL'inden site id üretir: "alternativeto.net" → "alternativeto" */
export function siteIdFromWebsite(website: string): string {
  const host = website
    .replace(/^https?:\/\//i, '')
    .replace(/^www\./i, '')
    .split('/')[0]
    ?.toLowerCase();
  if (!host) return '';
  // İlk etiketi al: "portal.10words.io" → "10words" değil, "portal" olurdu;
  // bu yüzden eTLD'yi atıp en anlamlı etiketi seçiyoruz.
  const labels = host.split('.');
  const meaningful = labels.length > 2 ? labels[labels.length - 2] : labels[0];
  return (meaningful ?? '').replace(/[^a-z0-9-]/g, '');
}

export class SheetClient {
  private constructor(
    private readonly api: sheets_v4.Sheets,
    private readonly spreadsheetId: string,
    private readonly tab: string,
    private readonly log: Logger,
    /** Başlık adı → 0-tabanlı kolon indeksi. */
    private headers: Map<string, number>,
    /** Bu sekmede site adresinin bulunduğu kolon (alias'lardan çözülür). */
    private websiteColumn: string | null = null,
    /** Bu sekmede site adının bulunduğu kolon; yoksa null. */
    private nameColumn: string | null = null,
  ) {}

  /**
   * Sheet istemcisi oluşturur. Kimlik/erişim sorunu varsa null döner —
   * çağıran taraf Sheet'siz devam edebilmeli.
   */
  static async create(log: Logger): Promise<SheetClient | null> {
    if (!env.SHEET_ID) {
      log.debug('SHEET_ID tanımsız — Sheet entegrasyonu devre dışı');
      return null;
    }

    try {
      const clientRaw = await readFile(env.GOOGLE_OAUTH_CLIENT_FILE, 'utf8');
      const tokenRaw = await readFile(env.GOOGLE_OAUTH_TOKEN_FILE, 'utf8');

      const parsed = JSON.parse(clientRaw) as {
        installed?: { client_id: string; client_secret: string };
        web?: { client_id: string; client_secret: string };
      };
      const cfg = parsed.installed ?? parsed.web;
      if (!cfg) throw new Error(`${env.GOOGLE_OAUTH_CLIENT_FILE} geçersiz`);

      const token = JSON.parse(tokenRaw) as { scope?: string };
      if (token.scope && !token.scope.includes('spreadsheets')) {
        log.warn(
          'OAuth token Sheets yetkisi içermiyor. Çalıştır: npm run gmail:auth ' +
            '(Sheets izni eklendi, yeniden yetkilendirme gerekiyor)',
        );
        return null;
      }

      const oauth2 = new googleAuth.OAuth2(cfg.client_id, cfg.client_secret);
      oauth2.setCredentials(token as Record<string, unknown>);

      const api = sheetsApi({ version: 'v4', auth: oauth2 });
      const client = new SheetClient(api, env.SHEET_ID, env.SHEET_TAB, log, new Map());
      await client.loadHeaders();
      return client;
    } catch (err) {
      // Mesaj çok satırlı olabiliyor (sekme listesi gibi) — pino tek satıra
      // sıkıştırmasın diye doğrudan yazdırıyoruz.
      log.warn('Sheet bağlantısı kurulamadı — Sheet’siz devam');
      console.error(`   ${(err as Error).message}`);
      return null;
    }
  }

  /** Sheet'teki sekme adlarını döner — yanlış SHEET_TAB teşhisinde kullanılır. */
  async tabNames(): Promise<string[]> {
    const meta = await this.api.spreadsheets.get({ spreadsheetId: this.spreadsheetId });
    return (meta.data.sheets ?? []).flatMap((s) => {
      const t = s.properties?.title;
      return t ? [t] : [];
    });
  }

  /** Başlık satırını okuyup kolon indekslerini çıkarır. */
  private async loadHeaders(): Promise<void> {
    let row: string[];
    try {
      const res = await this.api.spreadsheets.values.get({
        spreadsheetId: this.spreadsheetId,
        range: `${this.tab}!1:1`,
      });
      row = (res.data.values?.[0] ?? []).map((h) => String(h));
    } catch (err) {
      // "Unable to parse range" = sekme adı yanlış. Tahmin ettirmek yerine
      // mevcut sekmeleri göster.
      const message = (err as Error).message;
      if (/parse range/i.test(message)) {
        const tabs = await this.tabNames().catch(() => []);
        throw new Error(
          `Sekme bulunamadı: "${this.tab}".` +
            (tabs.length > 0
              ? `\n   Mevcut sekmeler: ${tabs.map((t) => `"${t}"`).join(', ')}` +
                `\n   .env'de SHEET_TAB değerini bunlardan biriyle değiştir.`
              : ''),
        );
      }
      throw err;
    }

    this.headers = new Map(row.map((h, i) => [h.trim(), i]));

    // Sekmeler arası şema farkı: SaaS'ta "Website", Directory'de "URL".
    // Site adresi ZORUNLU (site id ondan türetiliyor); isim opsiyonel.
    this.websiteColumn = WEBSITE_ALIASES.find((c) => this.headers.has(c)) ?? null;

    if (!this.websiteColumn) {
      throw new Error(
        `Sekme "${this.tab}" içinde site adresi kolonu yok.` +
          `\n   Aranan adlar: ${WEBSITE_ALIASES.join(', ')}` +
          `\n   Bulunan başlıklar: ${row.filter(Boolean).join(', ') || '(boş satır)'}`,
      );
    }

    this.nameColumn = NAME_ALIASES.find((c) => this.headers.has(c)) ?? null;
  }

  /** Kod tarafının yazacağı kolonlardan eksik olanları bildirir. */
  missingColumns(): string[] {
    return [
      COLUMNS.status,
      COLUMNS.email,
      COLUMNS.username,
      COLUMNS.risk,
      COLUMNS.attempts,
      COLUMNS.lastRun,
      COLUMNS.note,
      COLUMNS.profileUrl,
    ].filter((c) => !this.headers.has(c));
  }

  private cell(rowNumber: number, column: string): string | null {
    const idx = this.headers.get(column);
    if (idx === undefined) return null;
    return `${this.tab}!${columnLetter(idx)}${rowNumber}`;
  }

  /** Tüm satırları okur. */
  async readAll(): Promise<SheetRow[]> {
    const res = await this.api.spreadsheets.values.get({
      spreadsheetId: this.spreadsheetId,
      range: `${this.tab}!A2:Z10000`,
    });

    const get = (row: string[], col: string): string => {
      const idx = this.headers.get(col);
      return idx === undefined ? '' : (row[idx] ?? '').trim();
    };

    return (res.data.values ?? []).flatMap((raw, i) => {
      const row = raw.map((c) => String(c ?? ''));
      const website = this.websiteColumn ? get(row, this.websiteColumn) : '';
      if (!website) return [];

      return [
        {
          rowNumber: i + 2, // başlık satırı 1, veri 2'den başlıyor
          name: this.nameColumn ? get(row, this.nameColumn) : '',
          website,
          type: get(row, COLUMNS.type),
          status: get(row, COLUMNS.status),
          risk: get(row, COLUMNS.risk),
          note: get(row, COLUMNS.note),
          siteId: siteIdFromWebsite(website),
        },
      ];
    });
  }

  /** İşlenmeye uygun satırlar: Durum boş/Bekliyor/Hata ve risk high değil. */
  async readPending(): Promise<SheetRow[]> {
    const all = await this.readAll();
    return all.filter((r) => {
      if (r.risk.toLowerCase() === 'high') return false;
      const s = r.status.trim();
      return s === '' || s === SHEET_STATUS.PENDING || s === SHEET_STATUS.ERROR;
    });
  }

  /** Tek hücre yazar. Hata yutulur — Sheet opsiyonel katman. */
  private async writeCell(rowNumber: number, column: string, value: string): Promise<void> {
    const range = this.cell(rowNumber, column);
    if (!range) return; // kolon yoksa sessizce atla

    try {
      await this.api.spreadsheets.values.update({
        spreadsheetId: this.spreadsheetId,
        range,
        valueInputOption: 'RAW',
        requestBody: { values: [[value]] },
      });
    } catch (err) {
      this.log.warn({ err: (err as Error).message, range }, 'Sheet yazılamadı');
    }
  }

  /** İşleme başlandığını işaretler (SQLite claim'inden SONRA çağrılır). */
  async markInProgress(row: SheetRow, runId: string): Promise<void> {
    await this.writeCell(row.rowNumber, COLUMNS.status, SHEET_STATUS.IN_PROGRESS);
    await this.writeCell(row.rowNumber, COLUMNS.note, `çalışıyor: ${runId}`);
  }

  /** Çalıştırma sonucunu yazar. */
  async writeOutcome(
    row: SheetRow,
    outcome: { status: TerminalStatus; note?: string },
    identity?: { email: string; username: string; profileUrl?: string },
  ): Promise<void> {
    const label = STATUS_LABEL[outcome.status];
    // skipped_terminal gibi durumlarda etiket yok — mevcut değeri koru.
    if (label) {
      await this.writeCell(row.rowNumber, COLUMNS.status, label);
    }
    await this.writeCell(row.rowNumber, COLUMNS.lastRun, new Date().toLocaleString('tr-TR'));
    await this.writeCell(row.rowNumber, COLUMNS.note, outcome.note?.slice(0, 200) ?? '');

    if (identity) {
      await this.writeCell(row.rowNumber, COLUMNS.email, identity.email);
      await this.writeCell(row.rowNumber, COLUMNS.username, identity.username);
      if (identity.profileUrl) {
        await this.writeCell(row.rowNumber, COLUMNS.profileUrl, identity.profileUrl);
      }
    }
  }

  async writeRisk(row: SheetRow, risk: RiskLevel): Promise<void> {
    await this.writeCell(row.rowNumber, COLUMNS.risk, risk);
  }

  /**
   * Eksik takip kolonlarını başlık satırının sonuna ekler.
   * Mevcut kolonlara dokunmaz — yalnızca sağa ekleme yapar.
   */
  async ensureColumns(): Promise<string[]> {
    const missing = this.missingColumns();
    if (missing.length === 0) return [];

    const startIndex = Math.max(...this.headers.values()) + 1;
    const range = `${this.tab}!${columnLetter(startIndex)}1:${columnLetter(
      startIndex + missing.length - 1,
    )}1`;

    await this.api.spreadsheets.values.update({
      spreadsheetId: this.spreadsheetId,
      range,
      valueInputOption: 'RAW',
      requestBody: { values: [missing] },
    });

    // Yerel başlık haritasını güncelle ki aynı oturumda yazım çalışsın.
    missing.forEach((name, i) => this.headers.set(name, startIndex + i));
    return missing;
  }
}

/** 0-tabanlı indeksi A, B, ..., Z, AA formatına çevirir. */
export function columnLetter(index: number): string {
  let n = index;
  let out = '';
  do {
    out = String.fromCharCode(65 + (n % 26)) + out;
    n = Math.floor(n / 26) - 1;
  } while (n >= 0);
  return out;
}
