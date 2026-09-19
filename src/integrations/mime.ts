/**
 * Ham MIME ayrıştırma.
 *
 * Faz 0'da öğrenildi: siteler iki farklı format gönderiyor.
 *   - BetaList  → multipart/alternative (text + html parçaları)
 *   - AlternativeTo, StackShare → TEK PARÇALI, Content-Type üst başlıkta
 * Sadece multipart desteklemek, tek parçalı mailleri "boş gövde" olarak
 * görmeye ve doğrulama linkini kaçırmaya yol açıyordu.
 */

export interface MimeParts {
  from: string;
  subject: string;
  date: string;
  text: string;
  html: string;
}

export function decodeQuotedPrintable(s: string): string {
  return s
    .replace(/=\r?\n/g, '')
    .replace(/=([0-9A-F]{2})/gi, (_, h: string) => String.fromCharCode(parseInt(h, 16)));
}

/** =?UTF-8?B?...?= tarzı encoded-word başlıklarını çözer. */
export function decodeMimeWord(s: string): string {
  return s.replace(/=\?([^?]+)\?([BQ])\?([^?]*)\?=/gi, (_, _charset: string, enc: string, data: string) => {
    if (enc.toUpperCase() === 'B') return Buffer.from(data, 'base64').toString('utf8');
    return decodeQuotedPrintable(data.replace(/_/g, ' '));
  });
}

/** Katlanmış (devam satırlı) başlıkları da doğru okur. */
export function readHeader(headerBlock: string, name: string): string {
  const re = new RegExp(`^${name}:\\s*(.*(?:\\r?\\n[ \\t]+.*)*)`, 'im');
  const m = re.exec(headerBlock);
  return m?.[1]?.replace(/\r?\n[ \t]+/g, ' ').trim() ?? '';
}

function decodeBody(body: string, isQP: boolean, isBase64: boolean): string {
  const trimmed = body.replace(/^\r?\n\r?\n/, '').trim();
  if (isQP) return decodeQuotedPrintable(trimmed);
  if (isBase64) return Buffer.from(trimmed.replace(/\s/g, ''), 'base64').toString('utf8');
  return trimmed;
}

/** Ham RFC822 mesajını başlıklar + text/html gövdelerine ayırır. */
export function parseMime(raw: string): MimeParts {
  const headerEnd = raw.search(/\r?\n\r?\n/);
  const headerBlock = headerEnd === -1 ? raw : raw.slice(0, headerEnd);
  const body = headerEnd === -1 ? '' : raw.slice(headerEnd);

  const from = readHeader(headerBlock, 'From');
  const subject = decodeMimeWord(readHeader(headerBlock, 'Subject'));
  const date = readHeader(headerBlock, 'Date');

  const contentType = readHeader(headerBlock, 'Content-Type');
  const boundary =
    /boundary="?([^";\r\n]+)"?/i.exec(contentType)?.[1] ??
    /boundary="?([^";\r\n]+)"?/i.exec(raw)?.[1];

  let text = '';
  let html = '';

  if (boundary) {
    for (const part of body.split(`--${boundary}`)) {
      const isHtml = /Content-Type:\s*text\/html/i.test(part);
      const isText = /Content-Type:\s*text\/plain/i.test(part);
      if (!isHtml && !isText) continue;

      const partBodyStart = part.search(/\r?\n\r?\n/);
      if (partBodyStart === -1) continue;

      const decoded = decodeBody(
        part.slice(partBodyStart),
        /Content-Transfer-Encoding:\s*quoted-printable/i.test(part),
        /Content-Transfer-Encoding:\s*base64/i.test(part),
      );

      if (isHtml) html = decoded;
      else text = decoded;
    }
  } else {
    // Tek parçalı mail — Content-Type doğrudan üst başlıkta.
    const decoded = decodeBody(
      body,
      /Content-Transfer-Encoding:\s*quoted-printable/i.test(headerBlock),
      /Content-Transfer-Encoding:\s*base64/i.test(headerBlock),
    );

    if (/text\/html/i.test(contentType)) html = decoded;
    else if (/text\/plain/i.test(contentType)) text = decoded;
    else html = decoded; // Content-Type belirsizse HTML varsay (en yaygın)
  }

  return { from, subject, date, text, html };
}
