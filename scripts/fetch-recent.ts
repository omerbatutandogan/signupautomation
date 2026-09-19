/**
 * Faz 0 yardımcısı: kayıt kutusundaki son mailleri listeler ve isteğe bağlı
 * olarak .eml olarak kaydeder.
 *
 * İki işi var:
 *  1) Gmail OAuth kurulumunun gerçekten çalıştığını kanıtlar
 *  2) mail-parse.ts'i doğrulayacak GERÇEK doğrulama maili korpusunu toplar
 *     (planda "projenin en değerli test varlığı" diye geçen şey)
 *
 * Kullanım:
 *   npm run mail:recent              # son 5 maili listele
 *   npm run mail:recent -- 10        # son 10 maili listele
 *   npm run mail:recent -- 10 --save # ayrıca test/fixtures/emails/ altına kaydet
 */

import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { auth as gmailAuth, gmail, type gmail_v1 } from '@googleapis/gmail';

const TOKEN_FILE = process.env.GOOGLE_OAUTH_TOKEN_FILE ?? '.auth/gmail-token.json';
const CLIENT_FILE = process.env.GOOGLE_OAUTH_CLIENT_FILE ?? '.auth/gmail-client-secret.json';
const SAVE_DIR = 'test/fixtures/emails';

async function gmailClient(): Promise<gmail_v1.Gmail> {
  let clientRaw: string;
  let tokenRaw: string;
  try {
    clientRaw = await readFile(CLIENT_FILE, 'utf8');
    tokenRaw = await readFile(TOKEN_FILE, 'utf8');
  } catch {
    console.error(`\n❌ Kimlik dosyaları eksik (${CLIENT_FILE} / ${TOKEN_FILE}).`);
    console.error('   Önce şunu çalıştır:  npm run gmail:auth\n');
    process.exit(1);
  }

  const parsed = JSON.parse(clientRaw) as {
    installed?: { client_id: string; client_secret: string };
    web?: { client_id: string; client_secret: string };
  };
  const cfg = parsed.installed ?? parsed.web;
  if (!cfg) throw new Error(`${CLIENT_FILE} geçersiz`);

  const oauth2 = new gmailAuth.OAuth2(cfg.client_id, cfg.client_secret);
  oauth2.setCredentials(JSON.parse(tokenRaw) as Record<string, unknown>);
  return gmail({ version: 'v1', auth: oauth2 });
}

function header(msg: gmail_v1.Schema$Message, name: string): string {
  const h = msg.payload?.headers?.find((x) => x.name?.toLowerCase() === name.toLowerCase());
  return h?.value ?? '';
}

/** Dosya adı için güvenli slug üretir. */
function slug(s: string): string {
  return s
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 50) || 'mail';
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const count = Number(args.find((a) => /^\d+$/.test(a)) ?? 5);
  const save = args.includes('--save');

  const gmail = await gmailClient();

  const profile = await gmail.users.getProfile({ userId: 'me' });
  console.log(`\n📬 Kutu: ${profile.data.emailAddress}\n`);

  const list = await gmail.users.messages.list({
    userId: 'me',
    maxResults: count,
    q: 'in:anywhere', // Spam/Çöp kutusu dahil — doğrulama mailleri oraya düşebiliyor
  });

  const messages = list.data.messages ?? [];
  if (messages.length === 0) {
    console.log('Hiç mail bulunamadı.\n');
    return;
  }

  if (save) await mkdir(SAVE_DIR, { recursive: true });

  for (const [i, ref] of messages.entries()) {
    if (!ref.id) continue;

    const full = await gmail.users.messages.get({
      userId: 'me',
      id: ref.id,
      format: save ? 'raw' : 'full',
    });

    const from = header(full.data, 'From');
    const subject = header(full.data, 'Subject');
    const date = header(full.data, 'Date');

    console.log(`${i + 1}. ${subject || '(konu yok)'}`);
    console.log(`   Kimden: ${from}`);
    console.log(`   Tarih:  ${date}`);

    if (save && full.data.raw) {
      const name = `${slug(from.split('@').pop() ?? 'unknown')}-${slug(subject)}.eml`;
      const path = `${SAVE_DIR}/${name}`;
      await writeFile(path, Buffer.from(full.data.raw, 'base64url'));
      console.log(`   💾 ${path}`);
    }
    console.log();
  }

  if (save) {
    console.log(`✅ ${messages.length} mail ${SAVE_DIR}/ altına kaydedildi.`);
    console.log('   Bunlar mail-parse.ts testleri için gerçek örnek korpusu oluşturur.\n');
  }
}

main().catch((err: unknown) => {
  console.error('\n❌ Hata:', err instanceof Error ? err.message : err);
  process.exit(1);
});
