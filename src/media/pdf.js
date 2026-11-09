import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import PDFDocument from 'pdfkit';
import { AppError } from '../shared/errors.js';

const PAGE_MARGIN = 56;
const PAGE_WIDTH = 595.28;
const PAGE_HEIGHT = 841.89;
const CONTENT_WIDTH = PAGE_WIDTH - PAGE_MARGIN * 2;

let cachedFonts = null;

function fontExists(filePath) {
  try {
    return Boolean(filePath) && existsSync(filePath);
  } catch {
    return false;
  }
}

function fcMatch(pattern) {
  try {
    const output = execFileSync('fc-match', ['-f', '%{file}\n%{postscriptname}', pattern], {
      encoding: 'utf8',
      timeout: 1500,
      stdio: ['ignore', 'pipe', 'ignore'],
    });
    const [file, family] = output
      .trim()
      .split('\n')
      .map((line) => line.trim());
    if (file && fontExists(file)) return { path: file, family: family || undefined };
  } catch {
    /* fontconfig is optional */
  }
  return null;
}

function cjkFontCandidates() {
  const candidates = [];
  if (process.env.DOCUMENT_PDF_FONT) {
    candidates.push({
      path: process.env.DOCUMENT_PDF_FONT,
      family: process.env.DOCUMENT_PDF_FONT_FAMILY || undefined,
      boldPath: process.env.DOCUMENT_PDF_BOLD_FONT || process.env.DOCUMENT_PDF_FONT,
      boldFamily:
        process.env.DOCUMENT_PDF_BOLD_FONT_FAMILY ||
        process.env.DOCUMENT_PDF_FONT_FAMILY ||
        undefined,
    });
  }

  if (process.platform === 'darwin') {
    candidates.push(
      {
        path: '/System/Library/Fonts/Hiragino Sans GB.ttc',
        family: 'HiraginoSansGB-W3',
        boldPath: '/System/Library/Fonts/Hiragino Sans GB.ttc',
        boldFamily: 'HiraginoSansGB-W6',
      },
      {
        path: '/System/Library/Fonts/STHeiti Light.ttc',
        family: 'STHeitiSC-Light',
        boldPath: '/System/Library/Fonts/STHeiti Medium.ttc',
        boldFamily: 'STHeitiSC-Medium',
      },
      {
        path: '/System/Library/Fonts/Supplemental/Songti.ttc',
        family: 'STSongti-SC-Regular',
        boldPath: '/System/Library/Fonts/Supplemental/Songti.ttc',
        boldFamily: 'STSongti-SC-Bold',
      },
    );
  } else if (process.platform === 'win32') {
    const windows = process.env.WINDIR || 'C:\\Windows';
    candidates.push(
      {
        path: `${windows}\\Fonts\\msyh.ttc`,
        family: 'MicrosoftYaHei',
        boldPath: `${windows}\\Fonts\\msyhbd.ttc`,
        boldFamily: 'MicrosoftYaHei-Bold',
      },
      {
        path: `${windows}\\Fonts\\simsun.ttc`,
        family: 'SimSun',
        boldPath: `${windows}\\Fonts\\simsun.ttc`,
        boldFamily: 'SimSun',
      },
      { path: `${windows}\\Fonts\\simhei.ttf` },
    );
  } else {
    const dirs = [
      '/usr/share/fonts/noto',
      '/usr/share/fonts/opentype/noto',
      '/usr/share/fonts/truetype/noto',
      '/usr/share/fonts/noto-cjk',
      '/usr/share/fonts/truetype/noto-cjk',
    ];
    for (const dir of dirs) {
      candidates.push({
        path: `${dir}/NotoSansCJK-Regular.ttc`,
        family: 'NotoSansCJKsc-Regular',
        boldPath: `${dir}/NotoSansCJK-Bold.ttc`,
        boldFamily: 'NotoSansCJKsc-Bold',
      });
    }
  }

  const regular = fcMatch('sans-serif:lang=zh-cn');
  if (regular) {
    const bold = fcMatch('sans-serif:lang=zh-cn:weight=bold');
    candidates.push({
      ...regular,
      boldPath: bold?.path || regular.path,
      boldFamily: bold?.family || regular.family,
    });
  }

  const seen = new Set();
  return candidates.filter((candidate) => {
    const key = `${candidate.path}\u0000${candidate.family || ''}`;
    if (!candidate.path || !fontExists(candidate.path) || seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function fontUsable(font) {
  if (!font?.path) return false;
  try {
    const probe = new PDFDocument({ size: 'A4', margin: PAGE_MARGIN });
    probe.on('data', () => {});
    probe.on('error', () => {});
    probe.registerFont('probe', font.path, font.family);
    probe.font('probe').fontSize(9).text('中文');
    probe.end();
    return true;
  } catch {
    return false;
  }
}

function resolveFonts() {
  if (cachedFonts) return cachedFonts;
  const regular = cjkFontCandidates().find((candidate) => fontUsable(candidate));
  if (!regular) {
    throw new AppError(
      500,
      '服务器缺少可用的中文字体，无法生成 PDF。请安装 Noto Sans CJK，或设置 DOCUMENT_PDF_FONT。',
    );
  }
  let bold = null;
  if (regular.boldPath && fontUsable({ path: regular.boldPath, family: regular.boldFamily })) {
    bold = { path: regular.boldPath, family: regular.boldFamily };
  }
  cachedFonts = { regular, bold };
  return cachedFonts;
}

function plainText(value) {
  return String(value || '')
    .replace(/\*\*([^*\n]+)\*\*/g, '$1')
    .replace(/\*([^*\n]+)\*/g, '$1')
    .replace(/`([^`\n]+)`/g, '$1')
    .replace(/\[([^\]]+)\]\((?!image:)[^)]*\)/g, '$1');
}

function headingStyle(level) {
  if (level <= 1) return { size: 17, color: '#111827', before: 12 };
  if (level === 2) return { size: 14, color: '#1F2937', before: 10 };
  return { size: 12, color: '#374151', before: 8 };
}

function footer(doc, bodyFont) {
  const range = doc.bufferedPageRange();
  for (let index = 0; index < range.count; index += 1) {
    doc.switchToPage(range.start + index);
    const marginBottom = doc.page.margins.bottom;
    doc.page.margins.bottom = 0;
    doc
      .font(bodyFont)
      .fontSize(8)
      .fillColor('#9CA3AF')
      .text(`Luma · ${index + 1} / ${range.count}`, PAGE_MARGIN, PAGE_HEIGHT - 38, {
        width: CONTENT_WIDTH,
        align: 'right',
        lineBreak: false,
      });
    doc.page.margins.bottom = marginBottom;
  }
}

/**
 * Renders the same parsed blocks used for DOCX into an A4 PDF. A real CJK font
 * is resolved from the host (or DOCUMENT_PDF_FONT), so Chinese text stays
 * selectable and images remain embedded.
 */
export async function buildPdf({ title, meta, blocks }) {
  const fonts = resolveFonts();
  const doc = new PDFDocument({
    size: 'A4',
    margins: {
      top: PAGE_MARGIN,
      right: PAGE_MARGIN,
      bottom: PAGE_MARGIN,
      left: PAGE_MARGIN,
    },
    bufferPages: true,
    info: {
      Title: title || 'Luma 文档',
      Author: 'Luma',
      Creator: 'Luma',
    },
  });

  const chunks = [];
  doc.on('data', (chunk) => chunks.push(chunk));
  const done = new Promise((resolve, reject) => {
    doc.on('end', () => resolve(Buffer.concat(chunks)));
    doc.on('error', reject);
  });

  doc.registerFont('body', fonts.regular.path, fonts.regular.family);
  const bodyFont = 'body';
  let boldFont = bodyFont;
  if (fonts.bold) {
    try {
      doc.registerFont('bold', fonts.bold.path, fonts.bold.family);
      boldFont = 'bold';
    } catch {
      boldFont = bodyFont;
    }
  }

  const bottom = PAGE_HEIGHT - PAGE_MARGIN;
  const ensureSpace = (height) => {
    if (doc.y + height > bottom) doc.addPage();
  };

  if (title) {
    doc.font(boldFont).fontSize(24).fillColor('#111827').text(plainText(title), {
      width: CONTENT_WIDTH,
      lineGap: 2,
    });
    doc.moveDown(0.35);
  }
  if (meta) {
    doc.font(bodyFont).fontSize(9).fillColor('#6B7280').text(plainText(meta), {
      width: CONTENT_WIDTH,
      lineGap: 2,
    });
    doc.moveDown(1);
  }

  for (const block of blocks || []) {
    if (block.type === 'heading') {
      const style = headingStyle(block.level);
      ensureSpace(style.size + 34);
      doc.moveDown(style.before / 20);
      doc
        .font(boldFont)
        .fontSize(style.size)
        .fillColor(style.color)
        .text(plainText(block.text), { width: CONTENT_WIDTH, lineGap: 2 });
      doc.moveDown(0.45);
    } else if (block.type === 'paragraph') {
      doc
        .font(bodyFont)
        .fontSize(11)
        .fillColor('#1F2937')
        .text(plainText(block.text), { width: CONTENT_WIDTH, lineGap: 3 });
      doc.moveDown(0.6);
    } else if (block.type === 'bullets') {
      for (const [index, item] of block.items.entries()) {
        ensureSpace(24);
        doc
          .font(bodyFont)
          .fontSize(11)
          .fillColor('#1F2937')
          .text(`${block.ordered ? `${index + 1}. ` : '• '}${plainText(item)}`, {
            width: CONTENT_WIDTH - 16,
            indent: 16,
            lineGap: 3,
          });
        doc.moveDown(0.18);
      }
      doc.moveDown(0.35);
    } else if (block.type === 'quote') {
      const start = doc.y;
      const pagesBefore = doc.bufferedPageRange().count;
      doc
        .font(bodyFont)
        .fontSize(10.5)
        .fillColor('#4B5563')
        .text(plainText(block.text), {
          width: CONTENT_WIDTH - 18,
          indent: 18,
          lineGap: 3,
        });
      const end = doc.y;
      if (doc.bufferedPageRange().count === pagesBefore) {
        doc
          .save()
          .strokeColor('#D1D5DB')
          .lineWidth(2)
          .moveTo(PAGE_MARGIN, start)
          .lineTo(PAGE_MARGIN, end)
          .stroke()
          .restore();
      }
      doc.moveDown(0.6);
    } else if (block.type === 'image' && block.data) {
      const width = Number(block.width) || 1024;
      const height = Number(block.height) || 1024;
      const maxHeight = PAGE_HEIGHT - PAGE_MARGIN * 2 - 30;
      let drawWidth = CONTENT_WIDTH;
      let drawHeight = drawWidth / (width / height);
      if (drawHeight > maxHeight) {
        drawHeight = maxHeight;
        drawWidth = drawHeight * (width / height);
      }
      if (doc.y + drawHeight + 30 > bottom) doc.addPage();
      const x = PAGE_MARGIN + (CONTENT_WIDTH - drawWidth) / 2;
      const y = doc.y;
      doc.image(block.data, x, y, { width: drawWidth, height: drawHeight });
      doc.y = y + drawHeight;
      doc.moveDown(0.3);
      if (block.caption) {
        doc
          .font(bodyFont)
          .fontSize(8.5)
          .fillColor('#6B7280')
          .text(plainText(block.caption), { width: CONTENT_WIDTH, align: 'center' });
      }
      doc.moveDown(0.7);
    }
  }

  footer(doc, bodyFont);
  doc.end();
  return done;
}
