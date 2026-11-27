import { AppError } from '../shared/errors.js';
import { openZip } from './zip-reader.js';

// Formats that are neither OOXML, plain text nor PDF, but still carry readable
// text inside a container this repository already knows how to open. They live
// here instead of in document-text.js so that file stays about the OOXML and
// PDF shapes; the entry point and the supported-extension list stay shared.

const MAX_NOTEBOOK_CELLS = 2000;
const MAX_EML_PARTS = 40;

function tidy(text) {
  return String(text || '')
    .replace(/\r\n?/g, '\n')
    .replace(/\u0000/g, '')
    .split('\n')
    .map((line) => line.replace(/[ \t]+$/g, ''))
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

function decodeXmlEntities(text) {
  return String(text || '').replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (match, body) => {
    if (body[0] === '#') {
      const code =
        body[1] === 'x' || body[1] === 'X'
          ? Number.parseInt(body.slice(2), 16)
          : Number.parseInt(body.slice(1), 10);
      return Number.isFinite(code) && code > 0 && code <= 0x10ffff ? String.fromCodePoint(code) : match;
    }
    const named = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ' };
    return named[body.toLowerCase()] ?? match;
  });
}

/** Strips tags while keeping the line structure a reader needs. */
function blockText(xml) {
  return decodeXmlEntities(
    String(xml || '')
      .replace(/<(script|style)\b[\s\S]*?<\/\1>/gi, ' ')
      .replace(/<br\b[^>]*\/?>/gi, '\n')
      .replace(/<\/(p|div|li|h[1-6]|tr|section|article|blockquote|pre|dd|dt)>/gi, '\n')
      .replace(/<\/t[dh]>/gi, '\t')
      .replace(/<[^>]*>/g, ''),
  ).replace(/[ \t]+\n/g, '\n');
}

// --- OpenDocument (odt / ods / odp) -----------------------------------------

/**
 * ODF keeps every word in one content.xml; the mimetype and manifest files add
 * nothing readable. Namespaces are matched by local name so a document that
 * declares them with different prefixes still parses.
 */
function extractOdf(buffer) {
  const zip = openZip(buffer);
  const xml = zip.readText('content.xml');
  if (!xml) throw new AppError(400, '这个 OpenDocument 文件缺少正文内容');
  const body = xml
    // Comments are stored inline in the text flow; they are not part of the
    // document a reader is previewing.
    .replace(/<(?:\w+:)?annotation\b[^>]*>[\s\S]*?<\/(?:\w+:)?annotation>/g, '')
    // A writer indents its XML. Those newlines and the spaces after them are
    // formatting, while a space on the same line between two runs is content
    // (ODF writers use `text:s` for multiples, but one real space is common).
    .replace(/>\r?\n[ \t]*</g, '><')
    .replace(/<text:s\b[^>]*\/>/g, ' ')
    .replace(/<text:tab\b[^>]*\/>/g, '\t')
    .replace(/<text:line-break\b[^>]*\/>/g, '\n')
    .replace(/<\/table:table-cell>/g, '\t')
    .replace(/<\/(?:text:p|text:h|text:list-item|table:table-row|table:table)>/g, '\n');
  // Source newlines between tags are indentation, not content, and ODF has no
  // blank-line semantics: one `text:p` is one line. Collapsing the newline runs
  // after block tags turned every paragraph into two.
  return tidy(blockText(body))
    .replace(/\n[ \t]*\n+/g, '\n')
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\t{2,}/g, '\t');
}

// --- Rich Text Format -------------------------------------------------------

// Groups that describe formatting or embedded binaries, never sentence text.
const RTF_SKIP =
  /^(fonttbl|colortbl|stylesheet|info|pict|object|objdata|themedata|colorschememapping|datastore|latentstyles|xmlnstbl|listtable|listoverridetable|rsidtbl|generator|filetbl|revtbl|pgptbl|protusertbl|userprops|mmathpr|wgrffmtfilter|panose|falt|fname|filename|shpinst|sp|sn|sv)$/;

function codepageDecoder(code) {
  const label =
    code === 936
      ? 'gbk'
      : code === 950
        ? 'big5'
        : code === 932
          ? 'shift_jis'
          : code === 949
            ? 'euc-kr'
            : code === 1251
              ? 'windows-1251'
              : code === 65001
                ? 'utf-8'
                : 'windows-1252';
  try {
    const decoder = new TextDecoder(label);
    return (bytes) => decoder.decode(bytes);
  } catch {
    const fallback = new TextDecoder('windows-1252');
    return (bytes) => fallback.decode(bytes);
  }
}

/**
 * RTF is a stream of groups, control words and ANSI bytes. Word, LibreOffice and
 * Chinese WPS all emit it, so a preview is worth the small parser: control words
 * are consumed, ignorable destinations dropped, and `\'hh` escapes decoded with
 * the document's declared ANSI code page.
 */
export function extractRtf(buffer) {
  // latin1 keeps every byte one character, so `\'d6\'d0` stays two bytes that
  // the code page decoder can turn into 中.
  const raw = buffer.toString('latin1');
  const declared = Number(raw.match(/\\ansicpg(\d+)/)?.[1] || 1252);
  const decode = codepageDecoder(declared);

  const pending = [];
  let out = '';
  let depth = 0;
  let skipAt = -1;
  let unicodeSkip = 1;

  const flush = () => {
    if (!pending.length) return;
    out += decode(Buffer.from(pending));
    pending.length = 0;
  };

  for (let index = 0; index < raw.length; index += 1) {
    const char = raw[index];
    const skipping = skipAt >= 0;

    if (char === '{') {
      depth += 1;
      continue;
    }
    if (char === '}') {
      if (skipAt === depth) skipAt = -1;
      depth = Math.max(0, depth - 1);
      continue;
    }
    if (char === '\\') {
      const next = raw[index + 1] ?? '';
      if (next === "'") {
        const byte = Number.parseInt(raw.slice(index + 2, index + 4), 16);
        if (!skipping && Number.isFinite(byte)) pending.push(byte);
        index += 3;
        continue;
      }
      if (next === '*') {
        // `{\*\destination ...}` is an ignorable group: drop it whole.
        if (skipAt < 0) skipAt = depth;
        index += 1;
        continue;
      }
      if (next === '\\' || next === '{' || next === '}') {
        if (!skipping) pending.push(next.charCodeAt(0));
        index += 1;
        continue;
      }
      if (next === '~') {
        if (!skipping) pending.push(0x20);
        index += 1;
        continue;
      }
      if (next === '_') {
        if (!skipping) pending.push(0x2d);
        index += 1;
        continue;
      }
      if (next === '\n' || next === '\r') {
        flush();
        if (!skipping) out += '\n';
        index += 1;
        continue;
      }

      const word = raw.slice(index + 1).match(/^[a-zA-Z]+/)?.[0];
      if (!word) {
        index += 1;
        continue;
      }
      let cursor = index + 1 + word.length;
      const digits = raw.slice(cursor).match(/^-?\d+/)?.[0] ?? '';
      cursor += digits.length;
      if (raw[cursor] === ' ') cursor += 1;
      index = cursor - 1;

      if (!skipping && RTF_SKIP.test(word)) {
        // Font tables, stylesheets and embedded pictures: skip their group.
        skipAt = depth;
        continue;
      }
      if (skipping) continue;

      const value = digits ? Number(digits) : 0;
      if (word === 'par' || word === 'line' || word === 'sect' || word === 'row') {
        flush();
        out += '\n';
      } else if (word === 'tab' || word === 'cell') {
        flush();
        out += '\t';
      } else if (word === 'uc') {
        unicodeSkip = Math.max(0, value);
      } else if (word === 'u') {
        flush();
        out += String.fromCodePoint(value < 0 ? value + 65536 : value);
        // Word writes a fallback character after \uN that must not be drawn.
        // `\uc0` declares there is none; the default is one byte.
        for (let step = 0; step < unicodeSkip && index + 1 < raw.length; step += 1) index += 1;
      } else if (word === 'emdash') {
        flush();
        out += '—';
      } else if (word === 'endash') {
        flush();
        out += '–';
      } else if (word === 'bullet') {
        flush();
        out += '•';
      }
      continue;
    }

    if (skipping) continue;
    // Raw line breaks in the source are formatting, not paragraphs.
    if (char === '\r' || char === '\n') continue;
    pending.push(char.charCodeAt(0) & 0xff);
  }
  flush();
  return tidy(out);
}

// --- EPUB -------------------------------------------------------------------

function resolveHref(baseDir, href) {
  const clean = String(href || '').split('#')[0];
  const parts = baseDir ? baseDir.split('/').filter(Boolean) : [];
  for (const piece of clean.split('/')) {
    if (!piece || piece === '.') continue;
    if (piece === '..') parts.pop();
    else parts.push(piece);
  }
  return parts.join('/');
}

/** Reads the spine in reading order; a book without one still gets its chapters. */
function extractEpub(buffer) {
  const zip = openZip(buffer);
  const container = zip.readText('META-INF/container.xml') || '';
  const opfPath =
    container.match(/full-path="([^"]+)"/i)?.[1] || zip.names().find((name) => name.endsWith('.opf'));
  if (!opfPath) throw new AppError(400, '这个 EPUB 缺少书脊信息');
  const opf = zip.readText(opfPath) || '';
  const baseDir = opfPath.includes('/') ? opfPath.slice(0, opfPath.lastIndexOf('/')) : '';
  const title = blockText(opf.match(/<dc:title\b[^>]*>([\s\S]*?)<\/dc:title>/i)?.[1] || '').trim();

  const manifest = new Map();
  for (const match of opf.matchAll(/<item\b([^>]*)\/?>/gi)) {
    const attrs = match[1];
    const id = attrs.match(/\bid="([^"]+)"/i)?.[1];
    const href = attrs.match(/\bhref="([^"]+)"/i)?.[1];
    if (id && href) manifest.set(id, resolveHref(baseDir, href));
  }
  const spine = [];
  for (const match of opf.matchAll(/<itemref\b([^>]*)\/?>/gi)) {
    const ref = match[1].match(/\bidref="([^"]+)"/i)?.[1];
    const target = ref ? manifest.get(ref) : null;
    if (target) spine.push(target);
  }
  const chapters = spine.length
    ? spine
    : zip.names().filter((name) => /\.(x?html?)$/i.test(name)).sort();

  const parts = [];
  for (const name of chapters) {
    const xml = zip.readText(name);
    if (!xml) continue;
    const text = tidy(blockText(xml.replace(/<(head|nav)\b[\s\S]*?<\/\1>/gi, ' ')));
    if (text) parts.push(text);
  }
  if (!parts.length) throw new AppError(400, '这个 EPUB 没有可读取的文字');
  return { text: parts.join('\n\n'), title };
}

// --- EML --------------------------------------------------------------------

function decodeRfc2047(value) {
  return String(value || '').replace(
    /=\?([^?]+)\?([bqBQ])\?([^?]*)\?=/g,
    (match, charset, encoding, body) => {
      try {
        const label = /^utf-?8$/i.test(charset) ? 'utf-8' : charset.toLowerCase();
        const decoder = new TextDecoder(label);
        if (encoding.toLowerCase() === 'b') {
          return decoder.decode(Buffer.from(body, 'base64'));
        }
        const bytes = [];
        for (let index = 0; index < body.length; index += 1) {
          if (body[index] === '_') {
            bytes.push(0x20);
          } else if (body[index] === '=' && index + 2 < body.length) {
            bytes.push(Number.parseInt(body.slice(index + 1, index + 3), 16));
            index += 2;
          } else {
            bytes.push(body.charCodeAt(index) & 0xff);
          }
        }
        return decoder.decode(Buffer.from(bytes));
      } catch {
        return match;
      }
    },
  );
}

/** Decodes a MIME body to bytes via its transfer encoding, then to text. */
function decodeTransfer(body, encoding, charset) {
  const kind = String(encoding || '').toLowerCase().replace(/\s/g, '');
  let bytes;
  if (kind === 'base64') {
    bytes = Buffer.from(body.replace(/[^\w+/=]/g, ''), 'base64');
  } else if (kind === 'quoted-printable') {
    const out = [];
    for (let index = 0; index < body.length; index += 1) {
      const char = body[index];
      if (char === '=') {
        if (body[index + 1] === '\n') {
          index += 1;
          continue;
        }
        if (body[index + 1] === '\r' && body[index + 2] === '\n') {
          index += 2;
          continue;
        }
        const hex = body.slice(index + 1, index + 3);
        if (/^[0-9a-f]{2}$/i.test(hex)) {
          out.push(Number.parseInt(hex, 16));
          index += 2;
          continue;
        }
      }
      out.push(char.charCodeAt(0) & 0xff);
    }
    bytes = Buffer.from(out);
  } else {
    // A 7bit/8bit body arrives as latin1 text from the UTF-8 read above; going
    // back through latin1 restores the original bytes for the charset decoder.
    bytes = Buffer.from(body, 'latin1');
  }
  const label = String(charset || 'utf-8').trim().toLowerCase();
  try {
    return new TextDecoder(label).decode(bytes);
  } catch {
    return bytes.toString('utf8');
  }
}

function parseHeaders(block) {
  const headers = new Map();
  let current = null;
  for (const line of block.split(/\r?\n/)) {
    if (/^[ \t]/.test(line) && current) {
      headers.set(current, `${headers.get(current)} ${line.trim()}`);
      continue;
    }
    const match = line.match(/^([\w-]+):\s*(.*)$/);
    if (!match) continue;
    current = match[1].toLowerCase();
    headers.set(current, match[2]);
  }
  return headers;
}

/** Splits a multipart body at its boundary and returns the individual parts. */
function splitParts(body, boundary) {
  const marker = `--${boundary}`;
  const chunks = body.split(marker);
  const parts = [];
  for (const chunk of chunks) {
    if (!chunk.startsWith('\n') && !chunk.startsWith('\r')) continue;
    const trimmed = chunk.replace(/^\r?\n/, '');
    if (trimmed.startsWith('--')) continue;
    const split = trimmed.search(/\r?\n\r?\n/);
    if (split < 0) continue;
    parts.push({
      headers: parseHeaders(trimmed.slice(0, split)),
      body: trimmed.slice(split).replace(/^\r?\n\r?\n/, ''),
    });
  }
  return parts;
}

function collectEmlBody(headers, body, depth = 0) {
  const type = headers.get('content-type') || 'text/plain';
  const boundary = type.match(/boundary="?([^";]+)"?/i)?.[1];
  if (/^multipart\//i.test(type) && boundary && depth < 3) {
    const parts = splitParts(body, boundary).slice(0, MAX_EML_PARTS);
    const decoded = parts.map((part) => ({
      headers: part.headers,
      text: collectEmlBody(part.headers, part.body, depth + 1),
    }));
    // A plain-text alternative reads better than the HTML one; an HTML-only
    // message still needs its tags stripped.
    const plain = decoded.find((part) => /^text\/plain/i.test(part.headers.get('content-type') || ''));
    if (plain) return plain.text;
    return decoded.map((part) => part.text).filter(Boolean).join('\n\n');
  }
  const charset = type.match(/charset="?([^";]+)"?/i)?.[1] || 'utf-8';
  const text = decodeTransfer(body, headers.get('content-transfer-encoding'), charset);
  return /^text\/html/i.test(type) ? blockText(text) : text;
}

export function extractEml(buffer) {
  // Headers are ASCII; the body's real encoding is declared per part. Reading
  // the whole file as UTF-8 first would replace every 8bit byte of a GBK or
  // Big5 message with U+FFFD before the part charset is even known.
  const raw = buffer.toString('latin1');
  const split = raw.search(/\r?\n\r?\n/);
  if (split < 0) throw new AppError(400, '这不是可读取的邮件文件');
  const headers = parseHeaders(raw.slice(0, split));
  const body = raw.slice(split).replace(/^\r?\n\r?\n/, '');
  const lines = [];
  for (const [label, key] of [
    ['发件人', 'from'],
    ['收件人', 'to'],
    ['抄送', 'cc'],
    ['时间', 'date'],
    ['主题', 'subject'],
  ]) {
    const value = headers.get(key);
    if (value) lines.push(`${label}：${decodeRfc2047(value).trim()}`);
  }
  const text = tidy(collectEmlBody(headers, body));
  return tidy(`${lines.join('\n')}\n\n${text}`);
}

// --- Jupyter notebook -------------------------------------------------------

export function extractNotebook(buffer) {
  let data;
  try {
    data = JSON.parse(buffer.toString('utf8'));
  } catch {
    throw new AppError(400, '笔记本不是有效的 JSON');
  }
  const cells = Array.isArray(data?.cells) ? data.cells : [];
  if (!cells.length) throw new AppError(400, '这个笔记本没有单元格');
  const parts = [];
  for (const [index, cell] of cells.slice(0, MAX_NOTEBOOK_CELLS).entries()) {
    const source = Array.isArray(cell?.source) ? cell.source.join('') : String(cell?.source || '');
    const text = cell?.cell_type === 'markdown' ? blockText(source) : source;
    const clean = tidy(text);
    if (!clean) continue;
    const label = cell?.cell_type === 'code' ? '代码' : cell?.cell_type === 'markdown' ? 'Markdown' : '内容';
    parts.push(`## ${label} ${index + 1}\n${clean}`);
  }
  if (!parts.length) throw new AppError(400, '这个笔记本没有可读取的内容');
  if (cells.length > MAX_NOTEBOOK_CELLS) parts.push(`…（仅显示前 ${MAX_NOTEBOOK_CELLS} 个单元格）`);
  return parts.join('\n\n');
}

export function extraDocumentText(buffer, ext) {
  const normalized = String(ext || '').toLowerCase();
  if (normalized === 'odt') return { kind: 'OpenDocument 文档', text: extractOdf(buffer) };
  if (normalized === 'ods') return { kind: 'OpenDocument 表格', text: extractOdf(buffer) };
  if (normalized === 'odp') return { kind: 'OpenDocument 演示文稿', text: extractOdf(buffer) };
  if (normalized === 'rtf') return { kind: 'RTF 文档', text: extractRtf(buffer) };
  if (normalized === 'epub') {
    const book = extractEpub(buffer);
    return { kind: 'EPUB 电子书', text: book.title ? `${book.title}\n\n${book.text}` : book.text };
  }
  if (normalized === 'eml') return { kind: '邮件', text: extractEml(buffer) };
  if (normalized === 'ipynb') return { kind: 'Jupyter 笔记本', text: extractNotebook(buffer) };
  return null;
}

export const EXTRA_DOC_EXTS = new Set(['odt', 'ods', 'odp', 'rtf', 'epub', 'eml', 'ipynb']);
export const EXTRA_ZIP_EXTS = new Set(['odt', 'ods', 'odp', 'epub']);
