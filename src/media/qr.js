import qrcode from 'qrcode-generator';
import { decodePng, encodePng } from './png.js';

export const QR_POSITIONS = new Set(['bottom-right', 'bottom-left', 'bottom-center']);
export const QR_SIZES = new Set(['small', 'medium', 'large']);

const SIZE_RATIOS = {
  small: 0.14,
  medium: 0.16,
  large: 0.18,
};
const QUIET_MODULES = 4;
const MIN_QR_PX = 120;

function fillRect(rgba, width, height, x, y, w, h, color) {
  const x0 = Math.max(0, x);
  const y0 = Math.max(0, y);
  const x1 = Math.min(width, x + w);
  const y1 = Math.min(height, y + h);
  for (let py = y0; py < y1; py += 1) {
    for (let px = x0; px < x1; px += 1) {
      const offset = (py * width + px) * 4;
      rgba[offset] = color[0];
      rgba[offset + 1] = color[1];
      rgba[offset + 2] = color[2];
      rgba[offset + 3] = color[3];
    }
  }
}

export function qrMatrix(url) {
  const qr = qrcode(0, 'H');
  qr.addData(String(url));
  qr.make();
  return qr;
}

/**
 * Generate a QR code from the URL and composite it onto the bottom of a PNG.
 * The QR is drawn as a separate white card; the image model never sees it.
 */
export function addQrToPng(buffer, options = {}) {
  const url = String(options.url || '').trim();
  if (!/^https?:\/\//i.test(url)) {
    throw new Error('二维码链接必须是 http 或 https 地址');
  }
  const png = decodePng(buffer);
  if (!png) throw new Error('二维码合成失败：图片不是可解码的 PNG');

  let qr;
  try {
    qr = qrMatrix(url);
  } catch {
    throw new Error('二维码生成失败：链接过长或内容不受支持');
  }

  const { width, height, rgba } = png;
  const minDim = Math.min(width, height);
  const position = QR_POSITIONS.has(options.position) ? options.position : 'bottom-right';
  const size = QR_SIZES.has(options.size) ? options.size : 'medium';
  const maxSide = Math.round(minDim * 0.3);
  const desired = Math.max(
    MIN_QR_PX,
    Math.min(maxSide, Math.round(minDim * SIZE_RATIOS[size])),
  );
  const modules = qr.getModuleCount() + QUIET_MODULES * 2;

  let scale = Math.max(1, Math.floor(desired / modules));
  let cardPad = Math.max(2, Math.round(scale * 1.5));
  let cardSize = modules * scale + cardPad * 2;
  if (cardSize > maxSide) {
    scale = Math.max(1, Math.floor((maxSide - 4) / modules));
    cardPad = Math.max(2, Math.round(scale * 1.5));
    cardSize = modules * scale + cardPad * 2;
  }

  const margin = Math.max(8, Math.round(minDim * 0.04));
  const maxX = Math.max(margin, width - margin - cardSize);
  const maxY = Math.max(margin, height - margin - cardSize);
  const x =
    position === 'bottom-left'
      ? margin
      : position === 'bottom-center'
        ? Math.min(maxX, Math.max(margin, Math.round((width - cardSize) / 2)))
        : maxX;
  const y = maxY;

  fillRect(rgba, width, height, x, y, cardSize, cardSize, [255, 255, 255, 255]);

  const qrLeft = x + cardPad + QUIET_MODULES * scale;
  const qrTop = y + cardPad + QUIET_MODULES * scale;
  for (let row = 0; row < qr.getModuleCount(); row += 1) {
    for (let col = 0; col < qr.getModuleCount(); col += 1) {
      if (!qr.isDark(row, col)) continue;
      fillRect(
        rgba,
        width,
        height,
        qrLeft + col * scale,
        qrTop + row * scale,
        scale,
        scale,
        [0, 0, 0, 255],
      );
    }
  }

  return encodePng(width, height, rgba);
}
