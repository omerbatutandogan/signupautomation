/**
 * Gmail API — doğrulama maili bekleme ve çıkarma.
 *
 * mail-parse.ts saf mantığı tutuyor; burası ağ/polling katmanı.
 *
 * Tek e-posta mimarisi gereği `to:` ile site ayrımı YAPILAMIYOR — her mesaj
 * isVerificationCandidate()'ten geçiriliyor (gönderen domaini + kayıt sonrası
 * zaman penceresi).
 */

import { readFile } from 'node:fs/promises';
import { auth as gmailAuth, gmail, type gmail_v1 } from '@googleapis/gmail';
import type { Logger } from 'pino';
import { env } from '../config.js';
import { ManualReviewError, TransientError } from '../core/errors.js';
import type { VerificationResult, VerificationSpec } from '../core/types.js';
import {
  extractVerificationCode,
  extractVerificationLink,
  isVerificationCandidate,
  type ParsedMessage,
} from './mail-parse.js';
import { parseMime } from './mime.js';

/**
 * Kademeli polling aralıkları. Çoğu doğrulama maili <60sn'de gelir; sabit
 * kısa aralık yerine kademeli bekleme kotayı minimal tutuyor.
 */
const POLL_SCHEDULE_MS: readonly number[] = [
  ...Array<number>(6).fill(10_000),
  ...Array<number>(8).fill(30_000),
];
const POLL_TAIL_MS = 60_000;

export async function createGmailClient(): Promise<gmail_v1.Gmail> {
  let clientRaw: string;
  let tokenRaw: string;
  try {
    clientRaw = await readFile(env.GOOGLE_OAUTH_CLIENT_FILE, 'utf8');
    tokenRaw = await readFile(env.GOOGLE_OAUTH_TOKEN_FILE, 'utf8');
  } catch {
    throw new Error(
      `Gmail kimlik dosyaları eksik (${env.GOOGLE_OAUTH_CLIENT_FILE} / ${env.GOOGLE_OAUTH_TOKEN_FILE}).\n` +
        'Önce çalıştır: npm run gmail:auth',
    );
  }

  const parsed = JSON.parse(clientRaw) as {
    installed?: { client_id: string; client_secret: string };
    web?: { client_id: string; client_secret: string };
  };
  const cfg = parsed.installed ?? parsed.web;
  if (!cfg) throw new Error(`${env.GOOGLE_OAUTH_CLIENT_FILE} geçersiz`);

  const oauth2 = new gmailAuth.OAuth2(cfg.client_id, cfg.client_secret);
  oauth2.setCredentials(JSON.parse(tokenRaw) as Record<string, unknown>);
  return gmail({ version: 'v1', auth: oauth2 });
}

function toParsedMessage(id: string, raw: string, internalDate: string | null): ParsedMessage {
  const mime = parseMime(raw);
  return {
    id,
    from: mime.from,
    subject: mime.subject,
    text: mime.text,
    html: mime.html,
    receivedAt: internalDate ? Number(internalDate) : Date.now(),
  };
}

export interface WaitOptions {
  siteDomain: string;
  submittedAt: number;
  timeoutMs?: number;
  log: Logger;
  /** Daha önce tüketilmiş mesajları atlamak için (ledger'dan gelir). */
  isSeen?: (messageId: string) => boolean;
  onSeen?: (messageId: string) => void;
}

/**
 * Doğrulama mailini bekler ve link/kodu çıkarır.
 *
 * spec.mode === 'none' ise hiç çağrılmamalı — runner bunu kontrol ediyor.
 */
export async function waitForVerificationEmail(
  client: gmail_v1.Gmail,
  spec: VerificationSpec,
  opts: WaitOptions,
): Promise<VerificationResult> {
  const timeoutMs = spec.timeoutMs ?? opts.timeoutMs ?? env.EMAIL_TIMEOUT_MS;
  const deadline = Date.now() + timeoutMs;

  // Saniye cinsinden, 60sn geriye toleranslı (saat kayması + gönderim gecikmesi).
  const afterSec = Math.floor((opts.submittedAt - 60_000) / 1000);
  // in:anywhere ŞART — doğrulama mailleri Spam'e düşebiliyor ve varsayılan
  // sorgu Spam'i döndürmüyor.
  const query = `in:anywhere after:${afterSec}`;

  let attempt = 0;

  while (Date.now() < deadline) {
    const waitMs = POLL_SCHEDULE_MS[attempt] ?? POLL_TAIL_MS;
    attempt++;

    let messages: gmail_v1.Schema$Message[] = [];
    try {
      const list = await client.users.messages.list({ userId: 'me', q: query, maxResults: 20 });
      messages = list.data.messages ?? [];
    } catch (err) {
      // Kota/ağ hatası kalıcı değil — bir sonraki turda tekrar dene.
      opts.log.warn({ err }, 'Gmail listeleme hatası, tekrar denenecek');
      await sleep(Math.min(waitMs, Math.max(0, deadline - Date.now())));
      continue;
    }

    for (const ref of messages) {
      if (!ref.id) continue;
      if (opts.isSeen?.(ref.id)) continue;

      let full: gmail_v1.Schema$Message;
      try {
        const res = await client.users.messages.get({ userId: 'me', id: ref.id, format: 'raw' });
        full = res.data;
      } catch (err) {
        opts.log.warn({ err, messageId: ref.id }, 'Mesaj okunamadı, atlanıyor');
        continue;
      }

      if (!full.raw) continue;

      const msg = toParsedMessage(
        ref.id,
        Buffer.from(full.raw, 'base64url').toString('utf8'),
        full.internalDate ?? null,
      );

      if (!isVerificationCandidate(msg, spec, {
        siteDomain: opts.siteDomain,
        submittedAt: opts.submittedAt,
      })) {
        continue;
      }

      opts.log.info({ from: msg.from, subject: msg.subject }, 'Aday doğrulama maili bulundu');

      try {
        const result =
          spec.mode === 'code'
            ? ({ kind: 'code', code: extractVerificationCode(msg), messageId: msg.id } as const)
            : ({
                kind: 'link',
                url: extractVerificationLink(msg, spec, opts.siteDomain),
                messageId: msg.id,
              } as const);

        opts.onSeen?.(msg.id);
        return result;
      } catch (err) {
        // Aday maildi ama link/kod çıkarılamadı — başka mail gelebilir,
        // döngüyü kırmadan devam et. Süre biterse aşağıda raporlanır.
        opts.log.warn(
          { messageId: msg.id, err: (err as Error).message },
          'Aday mailden doğrulama çıkarılamadı',
        );
      }
    }

    const remaining = deadline - Date.now();
    if (remaining <= 0) break;
    await sleep(Math.min(waitMs, remaining));
  }

  throw new TransientError(
    `Doğrulama maili ${Math.round(timeoutMs / 1000)} saniyede gelmedi`,
    { siteDomain: opts.siteDomain, query },
  );
}

/** Gmail bağlantısını doğrular ve kutu adresini döner. */
export async function verifyGmailAccess(client: gmail_v1.Gmail): Promise<string> {
  try {
    const profile = await client.users.getProfile({ userId: 'me' });
    return profile.data.emailAddress ?? '(bilinmiyor)';
  } catch (err) {
    throw new ManualReviewError(
      'Gmail erişimi başarısız — token ölmüş olabilir (test kullanıcısı modunda 7 gün). ' +
        'Çalıştır: npm run gmail:auth',
      { err: (err as Error).message },
    );
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
