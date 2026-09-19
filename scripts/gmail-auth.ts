/**
 * Tek seferlik Gmail OAuth kurulumu.
 *
 * Kişisel Gmail hesabı kullanıldığı için Workspace service account /
 * domain-wide delegation GEREKMİYOR — sade OAuth yeterli.
 *
 * ÖNEMLİ: Google Cloud Console'da OAuth consent screen "Testing" modunda
 * kalırsa refresh token 7 GÜNDE sessizce ölür ve otomasyon durur.
 * "Production"a almak şart (kendi hesabın için doğrulama süreci gerekmez).
 *
 * Kullanım:
 *   1) Google Cloud Console → yeni proje
 *   2) APIs & Services → Library → "Gmail API" → Enable
 *   3) OAuth consent screen → External → PUBLISH APP ("Production")
 *   4) Credentials → Create Credentials → OAuth client ID → Desktop app
 *   5) JSON'u indir → .auth/gmail-client-secret.json
 *   6) npm run gmail:auth
 */

import { createServer } from 'node:http';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { dirname } from 'node:path';
import { createInterface } from 'node:readline/promises';
import { auth as gmailAuth, gmail } from '@googleapis/gmail';

const SCOPES = ['https://www.googleapis.com/auth/gmail.readonly'];
const CLIENT_FILE = process.env.GOOGLE_OAUTH_CLIENT_FILE ?? '.auth/gmail-client-secret.json';
const TOKEN_FILE = process.env.GOOGLE_OAUTH_TOKEN_FILE ?? '.auth/gmail-token.json';
const CALLBACK_PORT = 5899;

interface ClientSecret {
  installed?: { client_id: string; client_secret: string; redirect_uris?: string[] };
  web?: { client_id: string; client_secret: string; redirect_uris?: string[] };
}

async function loadClientSecret(): Promise<{ id: string; secret: string }> {
  let raw: string;
  try {
    raw = await readFile(CLIENT_FILE, 'utf8');
  } catch {
    console.error(`\n❌ OAuth client dosyası bulunamadı: ${CLIENT_FILE}\n`);
    console.error('Yapman gerekenler:');
    console.error('  1. https://console.cloud.google.com → yeni proje oluştur');
    console.error('  2. APIs & Services → Library → "Gmail API" → ENABLE');
    console.error('  3. APIs & Services → OAuth consent screen → External');
    console.error('     → PUBLISH APP (Production) — "Testing"de bırakma!');
    console.error('  4. Credentials → Create Credentials → OAuth client ID');
    console.error('     → Application type: Desktop app');
    console.error(`  5. JSON'u indirip şuraya koy: ${CLIENT_FILE}\n`);
    process.exit(1);
  }

  const parsed = JSON.parse(raw) as ClientSecret;
  const cfg = parsed.installed ?? parsed.web;
  if (!cfg?.client_id || !cfg.client_secret) {
    throw new Error(`${CLIENT_FILE} geçersiz — "installed" veya "web" bloğu bulunamadı`);
  }
  return { id: cfg.client_id, secret: cfg.client_secret };
}

/** Tarayıcıdan dönen ?code=... parametresini yakalar. */
function waitForCode(): Promise<string> {
  return new Promise((resolve, reject) => {
    const server = createServer((req, res) => {
      const url = new URL(req.url ?? '/', `http://localhost:${CALLBACK_PORT}`);
      const code = url.searchParams.get('code');
      const error = url.searchParams.get('error');

      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      if (code) {
        res.end('<h2>✅ Yetkilendirme tamam</h2><p>Bu sekmeyi kapatabilirsin.</p>');
        server.close();
        resolve(code);
      } else {
        res.end(`<h2>❌ Hata</h2><p>${error ?? 'code parametresi yok'}</p>`);
        server.close();
        reject(new Error(error ?? 'Yetkilendirme kodu alınamadı'));
      }
    });

    server.on('error', reject);
    server.listen(CALLBACK_PORT);
    setTimeout(() => {
      server.close();
      reject(new Error('Yetkilendirme zaman aşımına uğradı (5 dk)'));
    }, 5 * 60_000).unref();
  });
}

async function main(): Promise<void> {
  const { id, secret } = await loadClientSecret();
  const redirectUri = `http://localhost:${CALLBACK_PORT}`;
  const oauth2 = new gmailAuth.OAuth2(id, secret, redirectUri);

  const authUrl = oauth2.generateAuthUrl({
    access_type: 'offline', // refresh token almak için şart
    scope: SCOPES,
    prompt: 'consent', // her seferinde refresh token dönmesini garantiler
  });

  console.log('\n🔗 Tarayıcıda şu adresi aç ve kayıt hesabınla giriş yap:\n');
  console.log(`   ${authUrl}\n`);
  console.log('   (Hangi hesabı seçtiğine dikkat et — SIGNUP_EMAIL ile aynı olmalı)\n');

  let code: string;
  try {
    code = await waitForCode();
  } catch (err) {
    // Callback sunucusu çalışmazsa (port dolu, uzak makine) elle yapıştırmaya düş.
    console.warn(`\n⚠️  Otomatik yakalama başarısız: ${(err as Error).message}`);
    const rl = createInterface({ input: process.stdin, output: process.stdout });
    code = (await rl.question('Adres çubuğundaki ?code=... değerini yapıştır: ')).trim();
    rl.close();
  }

  const { tokens } = await oauth2.getToken(code);
  if (!tokens.refresh_token) {
    console.error('\n❌ refresh_token alınamadı.');
    console.error('   Muhtemel sebep: bu hesaba daha önce izin verilmiş.');
    console.error('   Çözüm: https://myaccount.google.com/permissions adresinden');
    console.error('   uygulamanın erişimini kaldırıp tekrar dene.\n');
    process.exit(1);
  }

  await mkdir(dirname(TOKEN_FILE), { recursive: true });
  await writeFile(TOKEN_FILE, JSON.stringify(tokens, null, 2), { mode: 0o600 });

  // Bağlantıyı gerçekten doğrula — token dosyası yazmak tek başına kanıt değil.
  oauth2.setCredentials(tokens);
  const client = gmail({ version: 'v1', auth: oauth2 });
  const profile = await client.users.getProfile({ userId: 'me' });

  console.log(`\n✅ Bağlandı: ${profile.data.emailAddress}`);
  console.log(`   Token kaydedildi: ${TOKEN_FILE}`);

  const expected = process.env.SIGNUP_EMAIL;
  if (expected && profile.data.emailAddress !== expected) {
    console.warn(`\n⚠️  DİKKAT: .env'deki SIGNUP_EMAIL (${expected}) ile`);
    console.warn(`   yetkilendirilen hesap (${profile.data.emailAddress}) farklı!`);
    console.warn('   Doğrulama mailleri okunamaz. Ya .env dosyanı düzelt ya yeniden yetkilendir.\n');
  } else if (!expected) {
    console.log(`\n💡 .env dosyana şunu ekle:  SIGNUP_EMAIL=${profile.data.emailAddress}\n`);
  }

  console.log('\n⚠️  Hatırlatma: OAuth consent screen "Production" modunda mı?');
  console.log('   "Testing"de kalırsa bu token 7 gün sonra ölür ve otomasyon durur.\n');
}

main().catch((err: unknown) => {
  console.error('\n❌ Hata:', err instanceof Error ? err.message : err);
  process.exit(1);
});
