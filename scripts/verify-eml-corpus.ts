/**
 * test/fixtures/emails/ altındaki gerçek .eml korpusunu mail-parse.ts'e
 * karşı test eder. Kalıcı bir test değil, hızlı bir sağlık kontrolü —
 * yeni bir .eml eklendiğinde link çıkarmanın hâlâ çalıştığını doğrular.
 *
 * Kullanım: npm run mail:verify-corpus
 */

import { readFile, readdir } from 'node:fs/promises';
import { extractLinks, extractVerificationLink } from '../src/integrations/mail-parse.js';

function decodeQuotedPrintable(s: string): string {
  return s.replace(/=\r?\n/g, '').replace(/=([0-9A-F]{2})/gi, (_, h: string) =>
    String.fromCharCode(parseInt(h, 16)),
  );
}

function getHeader(headerBlock: string, name: string): string {
  const re = new RegExp(`^${name}:\\s*(.*(?:\\r?\\n[ \\t]+.*)*)`, 'im');
  const m = re.exec(headerBlock);
  return m?.[1]?.replace(/\r?\n[ \t]+/g, ' ').trim() ?? '';
}

/** Basit MIME ayrıştırıcı — multipart/alternative'den text+html çıkarır. */
function parseEml(raw: string): { from: string; subject: string; text: string; html: string } {
  const headerEnd = raw.search(/\r?\n\r?\n/);
  const headerBlock = raw.slice(0, headerEnd);
  const body = raw.slice(headerEnd);

  const from = getHeader(headerBlock, 'From');
  const subject = decodeMimeWord(getHeader(headerBlock, 'Subject'));

  const ctHeader = getHeader(headerBlock, 'Content-Type');
  const boundary = /boundary="?([^";\r\n]+)"?/i.exec(ctHeader)?.[1]
    ?? /boundary="?([^";\r\n]+)"?/i.exec(raw)?.[1];

  let text = '';
  let html = '';

  if (boundary) {
    for (const part of body.split(`--${boundary}`)) {
      const isHtml = /Content-Type:\s*text\/html/i.test(part);
      const isText = /Content-Type:\s*text\/plain/i.test(part);
      if (!isHtml && !isText) continue;

      const isQP = /Content-Transfer-Encoding:\s*quoted-printable/i.test(part);
      const isBase64 = /Content-Transfer-Encoding:\s*base64/i.test(part);
      const partBody = part.slice(part.search(/\r?\n\r?\n/)).replace(/^\r?\n\r?\n/, '').trim();

      let decoded = partBody;
      if (isQP) decoded = decodeQuotedPrintable(partBody);
      else if (isBase64) decoded = Buffer.from(partBody.replace(/\s/g, ''), 'base64').toString('utf8');

      if (isHtml) html = decoded;
      else if (isText) text = decoded;
    }
  } else {
    // Multipart değil — tek parçalı mail (StackShare, AlternativeTo gibi).
    // Content-Type doğrudan üst başlıkta, gövde tek bir parça.
    const isHtml = /text\/html/i.test(ctHeader);
    const isText = /text\/plain/i.test(ctHeader);
    const isQP = /Content-Transfer-Encoding:\s*quoted-printable/i.test(headerBlock);
    const isBase64 = /Content-Transfer-Encoding:\s*base64/i.test(headerBlock);

    const bodyTrimmed = body.replace(/^\r?\n\r?\n/, '').trim();
    let decoded = bodyTrimmed;
    if (isQP) decoded = decodeQuotedPrintable(bodyTrimmed);
    else if (isBase64) decoded = Buffer.from(bodyTrimmed.replace(/\s/g, ''), 'base64').toString('utf8');

    if (isHtml) html = decoded;
    else if (isText) text = decoded;
    else html = decoded; // Content-Type belirsizse HTML varsay (en yaygın durum)
  }

  return { from, subject, text, html };
}

/** =?UTF-8?B?...?= tarzı encoded-word konu satırlarını çözer. */
function decodeMimeWord(s: string): string {
  return s.replace(/=\?([^?]+)\?([BQ])\?([^?]*)\?=/gi, (_, _charset, enc, data) => {
    if (enc.toUpperCase() === 'B') return Buffer.from(data, 'base64').toString('utf8');
    return decodeQuotedPrintable(data.replace(/_/g, ' '));
  });
}

async function main(): Promise<void> {
  const dir = 'test/fixtures/emails';
  let files: string[];
  try {
    files = (await readdir(dir)).filter((f) => f.endsWith('.eml'));
  } catch {
    console.log(`Korpus dizini yok: ${dir}. Önce: npm run mail:recent -- 10 --save`);
    return;
  }

  if (files.length === 0) {
    console.log('Korpus boş. Önce: npm run mail:recent -- 10 --save');
    return;
  }

  let found = 0;
  let notFound = 0;

  for (const file of files) {
    const raw = await readFile(`${dir}/${file}`, 'latin1');
    const msg = parseEml(raw);

    console.log(`\n=== ${file} ===`);
    console.log(`From: ${msg.from}`);
    console.log(`Subject: ${msg.subject}`);
    console.log(`HTML: ${msg.html.length} karakter, Text: ${msg.text.length} karakter`);

    if (!msg.html && !msg.text) {
      console.log('⏭️  (muhtemelen doğrulama maili değil — atlanıyor)');
      continue;
    }

    try {
      const url = extractVerificationLink(
        { id: file, from: msg.from, subject: msg.subject, text: msg.text, html: msg.html, receivedAt: Date.now() },
        { mode: 'link' },
      );
      console.log(`✅ ${url}`);
      found++;
    } catch (err) {
      console.log(`❌ ${(err as Error).message}`);
      const links = extractLinks(msg.html).slice(0, 5);
      console.log('   İlk linkler:', links.map((l) => l.url));
      notFound++;
    }
  }

  console.log(`\n${found} bulundu, ${notFound} bulunamadı (${files.length} dosyadan).`);
}

main().catch((err: unknown) => {
  console.error('Hata:', err);
  process.exit(1);
});
