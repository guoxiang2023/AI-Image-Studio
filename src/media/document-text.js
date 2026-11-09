import { DOCUMENT_MAX_CHARS } from '../config.js';
import { AppError } from '../shared/errors.js';
import { openZip } from './zip-reader.js';

export const DOCUMENT_EXTS = new Set([
  'txt',
  'md',
  'markdown',
  'csv',
  'tsv',
  'json',
  'jsonl',
  'log',
  'xml',
  'yml',
  'yaml',
  'html',
  'htm',
  'docx',
  'xlsx',
  'pptx',
  'pdf',
]);

const LEGACY_EXTS = new Set(['doc', 'xls', 'ppt']);
const ZIP_EXTS = new Set(['docx', 'xlsx', 'pptx']);
const MAX_SHEET_ROWS = 2000;
const MAX_SHEET_COLS = 64;
const MAX_PDF_PAGES = 200;
const BUILTIN_DATE_FORMATS = new Set([14, 15, 16, 17, 18, 19, 20, 21, 22, 45, 46, 47]);

const NAMED_ENTITIES = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" };

function decodeXmlEntities(text) {
  return String(text || '').replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (match, body) => {
    if (body[0] === '#') {
      const code =
        body[1] === 'x' || body[1] === 'X'
          ? Number.parseInt(body.slice(2), 16)
          : Number.parseInt(body.slice(1), 10);
      return Number.isFinite(code) && code > 0 && code <= 0x10ffff
        ? String.fromCodePoint(code)
        : match;
    }
    return NAMED_ENTITIES[body.toLowerCase()] ?? match;
  });
}

function parseAttrs(text) {
  const attrs = {};
  const re = /([\w:.-]+)\s*=\s*"([^"]*)"/g;
  let match;
  while ((match = re.exec(text))) attrs[match[1]] = decodeXmlEntities(match[2]);
  return attrs;
}

function tidyText(text) {
  return String(text || '')
    .replace(/\r\n?/g, '\n')
    .replace(/\u0000/g, '')
    .split('\n')
    .map((line) => line.replace(/[ \t]+$/g, ''))
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

function decodePlainText(buffer) {
  let text;
  if (buffer[0] === 0xef && buffer[1] === 0xbb && buffer[2] === 0xbf) {
    text = buffer.toString('utf8', 3);
  } else if (buffer[0] === 0xff && buffer[1] === 0xfe) {
    text = buffer.toString('utf16le', 2);
  } else if (buffer[0] === 0xfe && buffer[1] === 0xff) {
    text = new TextDecoder('utf-16be').decode(buffer.subarray(2));
  } else {
    text = buffer.toString('utf8');
  }
  if (text.includes('\u0000')) throw new AppError(415, '这个文件看起来是二进制文件，无法读取文字');
  return text.replace(/\r\n?/g, '\n');
}

function stripHtml(text) {
  return decodeXmlEntities(
    text
      .replace(/<script\b[\s\S]*?<\/script>/gi, ' ')
      .replace(/<style\b[\s\S]*?<\/style>/gi, ' ')
      .replace(/<[^>]*>/g, ' '),
  ).replace(/[ \t]+/g, ' ');
}

function extractTextRuns(xml, tag) {
  const re = new RegExp(`<${tag}(?:\\s[^>]*)?>([\\s\\S]*?)<\\/${tag}>`, 'g');
  const parts = [];
  let match;
  while ((match = re.exec(xml))) parts.push(decodeXmlEntities(match[1]));
  return parts.join('');
}

function extractDocx(buffer) {
  const zip = openZip(buffer);
  const xml = zip.readText('word/document.xml');
  if (!xml) throw new AppError(400, 'Word 文件缺少正文内容');
  let body = xml
    .replace(/<w:instrText\b[^>]*>[\s\S]*?<\/w:instrText>/g, '')
    .replace(/<w:delText\b[^>]*>[\s\S]*?<\/w:delText>/g, '')
    .replace(/<w:tab\b[^>]*\/?>/g, '\t')
    .replace(/<w:(?:br|cr)\b[^>]*\/?>/g, '\n')
    .replace(/<\/w:tc>/g, '\t')
    .replace(/<\/w:tr>/g, '\n')
    .replace(/<\/w:p>/g, '\n');
  body = body.replace(/<w:t(?:\s[^>]*)?>([\s\S]*?)<\/w:t>/g, (_, text) => text);
  body = body.replace(/<[^>]*>/g, '');
  return tidyText(decodeXmlEntities(body))
    .replace(/\n+\t/g, '\t')
    .replace(/\t+\n/g, '\n')
    .replace(/\t{2,}/g, '\t');
}

function resolveZipPath(baseDir, target) {
  if (!target) return null;
  if (target.startsWith('/')) return target.slice(1);
  const parts = baseDir.split('/').filter(Boolean);
  for (const piece of target.split('/')) {
    if (!piece || piece === '.') continue;
    if (piece === '..') parts.pop();
    else parts.push(piece);
  }
  return parts.join('/');
}

function parseSharedStrings(xml) {
  if (!xml) return [];
  const values = [];
  const re = /<si\b[^>]*>([\s\S]*?)<\/si>/g;
  let match;
  while ((match = re.exec(xml))) values.push(extractTextRuns(match[1], 't'));
  return values;
}

function isDateFormat(numFmtId, code) {
  if (BUILTIN_DATE_FORMATS.has(numFmtId)) return true;
  if (!code) return false;
  const cleaned = code
    .replace(/"[^"]*"/g, '')
    .replace(/\[[^\]]*\]/g, '')
    .replace(/\\./g, '')
    .trim();
  if (!cleaned || /^general$/i.test(cleaned)) return false;
  return /[ymdhs]/i.test(cleaned);
}

function parseCellStyles(xml) {
  if (!xml) return [];
  const formats = new Map();
  const fmtRe = /<numFmt\b([^>]*)\/?>/g;
  let fmt;
  while ((fmt = fmtRe.exec(xml))) {
    const attrs = parseAttrs(fmt[1]);
    if (attrs.numFmtId != null) formats.set(Number(attrs.numFmtId), attrs.formatCode || '');
  }
  const block = xml.match(/<cellXfs\b[^>]*>([\s\S]*?)<\/cellXfs>/)?.[1] || '';
  const styles = [];
  const xfRe = /<xf\b([^>]*?)\/?>/g;
  let xf;
  while ((xf = xfRe.exec(block))) {
    const id = Number(parseAttrs(xf[1]).numFmtId) || 0;
    styles.push(isDateFormat(id, formats.get(id)));
  }
  return styles;
}

function formatExcelDate(serial) {
  if (!Number.isFinite(serial) || serial <= 0 || serial > 2958465) return String(serial);
  const ms = Date.UTC(1899, 11, 30) + Math.round(serial * 86400000);
  const date = new Date(ms);
  if (Number.isNaN(date.getTime())) return String(serial);
  const pad = (n) => String(n).padStart(2, '0');
  const day = `${date.getUTCFullYear()}-${pad(date.getUTCMonth() + 1)}-${pad(date.getUTCDate())}`;
  const seconds = date.getUTCSeconds();
  const minutes = date.getUTCMinutes();
  const hours = date.getUTCHours();
  if (!seconds && !minutes && !hours) return day;
  return `${day} ${pad(hours)}:${pad(minutes)}:${pad(seconds)}`;
}

function columnIndex(ref) {
  const letters = String(ref || '').match(/^[A-Z]+/i)?.[0];
  if (!letters) return null;
  let value = 0;
  for (const char of letters.toUpperCase()) value = value * 26 + (char.charCodeAt(0) - 64);
  return value - 1;
}

function cellValue(attrs, inner, shared, styles) {
  const raw = inner.match(/<v(?:\s[^>]*)?>([\s\S]*?)<\/v>/)?.[1];
  const type = attrs.t;
  if (type === 's') return shared[Number(raw)] ?? '';
  if (type === 'inlineStr') return extractTextRuns(inner, 't');
  if (type === 'b') return raw === '1' ? 'TRUE' : raw === '0' ? 'FALSE' : '';
  if (type === 'str' || type === 'e' || type === 'd') return decodeXmlEntities(raw || '');
  const numeric = Number(raw);
  if (
    raw != null &&
    String(raw).trim() &&
    Number.isFinite(numeric) &&
    styles[Number(attrs.s) || 0]
  ) {
    return formatExcelDate(numeric);
  }
  return decodeXmlEntities(raw || '');
}

function extractSheet(xml, shared, styles) {
  const rows = [];
  const rowRe = /<row\b([^>]*?)(?:\/>|>([\s\S]*?)<\/row>)/g;
  let rowMatch;
  let rowCount = 0;
  while ((rowMatch = rowRe.exec(xml)) && rowCount < MAX_SHEET_ROWS) {
    rowCount += 1;
    const inner = rowMatch[2] || '';
    if (!inner) continue;
    const cells = [];
    let nextCol = 0;
    const cellRe = /<c\b([^>]*?)(?:\/>|>([\s\S]*?)<\/c>)/g;
    let cellMatch;
    while ((cellMatch = cellRe.exec(inner))) {
      const attrs = parseAttrs(cellMatch[1]);
      const col = columnIndex(attrs.r) ?? nextCol;
      nextCol = col + 1;
      if (col < 0 || col >= MAX_SHEET_COLS) continue;
      const value = cellValue(attrs, cellMatch[2] || '', shared, styles);
      if (value !== '') cells[col] = value;
    }
    if (cells.some((value) => value !== undefined)) {
      rows.push(cells.map((value) => value ?? '').join('\t'));
    }
  }
  if (rowCount >= MAX_SHEET_ROWS) rows.push(`…（仅显示前 ${MAX_SHEET_ROWS} 行）`);
  return rows.join('\n');
}

function parseWorkbookSheets(zip) {
  const workbook = zip.readText('xl/workbook.xml') || '';
  const relsXml = zip.readText('xl/_rels/workbook.xml.rels') || '';
  const rels = new Map();
  const relRe = /<Relationship\b([^>]*)\/?>/g;
  let rel;
  while ((rel = relRe.exec(relsXml))) {
    const attrs = parseAttrs(rel[1]);
    if (attrs.Id && attrs.Target) rels.set(attrs.Id, resolveZipPath('xl', attrs.Target));
  }

  const sheets = [];
  const sheetRe = /<sheet\b([^>]*?)\/?>/g;
  let sheet;
  let index = 0;
  while ((sheet = sheetRe.exec(workbook))) {
    const attrs = parseAttrs(sheet[1]);
    const relId = attrs['r:id'] || Object.entries(attrs).find(([key]) => key.endsWith(':id'))?.[1];
    const fallback = `xl/worksheets/sheet${index + 1}.xml`;
    sheets.push({
      name: attrs.name || `Sheet${index + 1}`,
      path: (relId && rels.get(relId)) || fallback,
    });
    index += 1;
  }
  if (sheets.length) return sheets;

  return zip
    .names()
    .filter((name) => /^xl\/worksheets\/sheet\d+\.xml$/.test(name))
    .sort((a, b) => Number(a.match(/(\d+)\.xml$/)?.[1]) - Number(b.match(/(\d+)\.xml$/)?.[1]))
    .map((name, position) => ({ name: `Sheet${position + 1}`, path: name }));
}

function extractXlsx(buffer) {
  const zip = openZip(buffer);
  const shared = parseSharedStrings(zip.readText('xl/sharedStrings.xml'));
  const styles = parseCellStyles(zip.readText('xl/styles.xml'));
  const sheets = parseWorkbookSheets(zip);
  if (!sheets.length) throw new AppError(400, 'Excel 文件缺少工作表');

  const parts = [];
  for (const sheet of sheets) {
    const xml = zip.readText(sheet.path);
    if (!xml) continue;
    const content = extractSheet(xml, shared, styles);
    parts.push(`## 工作表：${sheet.name}\n${content || '（空）'}`);
  }
  return parts.join('\n\n');
}

function extractPptx(buffer) {
  const zip = openZip(buffer);
  const slides = zip
    .names()
    .filter((name) => /^ppt\/slides\/slide\d+\.xml$/.test(name))
    .sort((a, b) => Number(a.match(/(\d+)\.xml$/)?.[1]) - Number(b.match(/(\d+)\.xml$/)?.[1]));
  if (!slides.length) throw new AppError(400, '演示文稿缺少幻灯片');

  const parts = [];
  slides.forEach((name, index) => {
    let xml = zip.readText(name) || '';
    xml = xml.replace(/<a:br\b[^>]*\/?>/g, '\n').replace(/<\/a:p>/g, '\n');
    const text = tidyText(
      decodeXmlEntities(
        xml
          .replace(/<a:t(?:\s[^>]*)?>([\s\S]*?)<\/a:t>/g, (_, run) => run)
          .replace(/<[^>]*>/g, ''),
      ),
    );
    parts.push(`## 幻灯片 ${index + 1}\n${text || '（无文字）'}`);
  });
  return parts.join('\n\n');
}

export function documentExt(name) {
  return String(name || '').toLowerCase().match(/\.([a-z0-9]+)$/)?.[1] || '';
}

export function isSupportedDocumentExt(ext) {
  return DOCUMENT_EXTS.has(String(ext || '').toLowerCase());
}

export function documentUnsupportedMessage(ext) {
  const normalized = String(ext || '').toLowerCase();
  if (LEGACY_EXTS.has(normalized)) {
    return `暂不支持旧版 .${normalized} 文件，请另存为 .${normalized}x 后再上传`;
  }
  return `只支持 ${[...DOCUMENT_EXTS].join(' / ')} 文档`;
}

export function extractDocumentText(buffer, ext) {
  const normalized = String(ext || '').toLowerCase();
  if (LEGACY_EXTS.has(normalized) || !DOCUMENT_EXTS.has(normalized)) {
    throw new AppError(415, documentUnsupportedMessage(normalized));
  }
  if (normalized === 'pdf') {
    throw new AppError(500, 'PDF 需要使用异步提取接口');
  }

  let kind = '文本';
  let text;
  try {
    if (normalized === 'docx') {
      kind = 'Word 文档';
      text = extractDocx(buffer);
    } else if (normalized === 'xlsx') {
      kind = 'Excel 表格';
      text = extractXlsx(buffer);
    } else if (normalized === 'pptx') {
      kind = 'PPT 演示文稿';
      text = extractPptx(buffer);
    } else if (normalized === 'html' || normalized === 'htm') {
      text = stripHtml(decodePlainText(buffer));
    } else {
      text = decodePlainText(buffer);
    }
  } catch (err) {
    if (err instanceof AppError) throw err;
    throw new AppError(400, `无法读取这个文件：${err.message || '格式不正确'}`);
  }

  const clean = text.trim();
  if (!clean) throw new AppError(400, '文档中没有可读取的文字');
  const total = clean.length;
  const truncated = total > DOCUMENT_MAX_CHARS;
  return {
    kind,
    text: truncated ? `${clean.slice(0, DOCUMENT_MAX_CHARS)}\n…（内容过长，已截断）` : clean,
    chars: total,
    truncated,
  };
}

async function extractPdf(buffer) {
  if (!buffer.subarray(0, 1024).toString('latin1').includes('%PDF-')) {
    throw new AppError(400, '不是有效的 PDF 文件');
  }
  let pdfjs;
  try {
    pdfjs = await import('pdfjs-dist/legacy/build/pdf.mjs');
  } catch {
    throw new AppError(500, 'PDF 解析组件不可用');
  }

  let pdf;
  let truncated = false;
  let pageNote = '';
  let collected = 0;
  const lines = [];
  try {
    const task = pdfjs.getDocument({
      data: new Uint8Array(buffer),
      useWorkerFetch: false,
      isEvalSupported: false,
      useSystemFonts: true,
      disableFontFace: true,
    });
    pdf = await task.promise;
    const pages = Math.min(pdf.numPages, MAX_PDF_PAGES);
    if (pdf.numPages > pages) {
      truncated = true;
      pageNote = `\n…（PDF 共 ${pdf.numPages} 页，仅提取前 ${pages} 页）`;
    }
    const pushLine = (line) => {
      if (!line.trim()) return;
      lines.push(line);
      collected += line.length + 1;
    };
    for (let index = 1; index <= pages; index += 1) {
      if (collected > DOCUMENT_MAX_CHARS) {
        truncated = true;
        break;
      }
      const page = await pdf.getPage(index);
      const content = await page.getTextContent();
      let line = '';
      let lastY = null;
      for (const item of content.items) {
        if (typeof item.str !== 'string') continue;
        const y = item.transform?.[5];
        if (lastY !== null && Number.isFinite(y) && Math.abs(y - lastY) > 2) {
          pushLine(line);
          line = '';
        }
        line += item.str;
        if (item.hasEOL) {
          pushLine(line);
          line = '';
        }
        if (Number.isFinite(y)) lastY = y;
      }
      pushLine(line);
      lines.push('');
    }
  } catch (err) {
    if (err instanceof AppError) throw err;
    throw new AppError(400, 'PDF 已加密或无法解析，请确认文件没有密码保护');
  } finally {
    try {
      await pdf?.destroy?.();
    } catch {
      /* ignore cleanup errors */
    }
  }

  const clean = tidyText(`${lines.join('\n')}${pageNote}`);
  if (!clean) {
    throw new AppError(415, 'PDF 中没有可提取的文字；如果是扫描件，请先 OCR 后再上传');
  }
  const total = clean.length;
  const clipped = total > DOCUMENT_MAX_CHARS;
  return {
    kind: 'PDF 文档',
    text: clipped
      ? `${clean.slice(0, DOCUMENT_MAX_CHARS)}\n…（内容过长，已截断）`
      : clean,
    chars: total,
    truncated: truncated || clipped,
  };
}

export async function extractDocumentTextAsync(buffer, ext) {
  const normalized = String(ext || '').toLowerCase();
  if (normalized === 'pdf') return extractPdf(buffer);
  return extractDocumentText(buffer, normalized);
}

export { ZIP_EXTS };
