import zlib from 'node:zlib';

const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n += 1) {
    let c = n;
    for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c >>> 0;
  }
  return table;
})();

function crc32(buffer) {
  let c = 0xffffffff;
  for (let i = 0; i < buffer.length; i += 1) c = CRC_TABLE[(c ^ buffer[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function pngChunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length, 0);
  const typeBuffer = Buffer.from(type, 'ascii');
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(Buffer.concat([typeBuffer, data])), 0);
  return Buffer.concat([len, typeBuffer, data, crc]);
}

function readChunks(buffer) {
  if (!buffer || buffer.length < 8 || !buffer.subarray(0, 8).equals(PNG_SIGNATURE)) return null;
  const chunks = [];
  let offset = 8;
  while (offset + 12 <= buffer.length) {
    const length = buffer.readUInt32BE(offset);
    const type = buffer.toString('ascii', offset + 4, offset + 8);
    const start = offset + 8;
    const end = start + length;
    if (end + 4 > buffer.length) return null;
    chunks.push({ type, data: buffer.subarray(start, end) });
    offset = end + 4;
    if (type === 'IEND') break;
  }
  return chunks;
}

function paeth(a, b, c) {
  const p = a + b - c;
  const pa = Math.abs(p - a);
  const pb = Math.abs(p - b);
  const pc = Math.abs(p - c);
  if (pa <= pb && pa <= pc) return a;
  return pb <= pc ? b : c;
}

function unfilter(raw, width, height, channels) {
  const stride = width * channels;
  const out = Buffer.alloc(stride * height);
  let pos = 0;
  for (let y = 0; y < height; y += 1) {
    if (pos >= raw.length) return null;
    const filter = raw[pos];
    pos += 1;
    const row = y * stride;
    const prev = (y - 1) * stride;
    for (let x = 0; x < stride; x += 1) {
      if (pos >= raw.length) return null;
      const value = raw[pos];
      pos += 1;
      const left = x >= channels ? out[row + x - channels] : 0;
      const up = y > 0 ? out[prev + x] : 0;
      const upLeft = y > 0 && x >= channels ? out[prev + x - channels] : 0;
      let predictor = 0;
      if (filter === 1) predictor = left;
      else if (filter === 2) predictor = up;
      else if (filter === 3) predictor = Math.floor((left + up) / 2);
      else if (filter === 4) predictor = paeth(left, up, upLeft);
      else if (filter !== 0) return null;
      out[row + x] = (value + predictor) & 0xff;
    }
  }
  return out;
}

function decodePng(buffer) {
  const chunks = readChunks(buffer);
  if (!chunks) return null;
  const ihdr = chunks.find((chunk) => chunk.type === 'IHDR');
  if (!ihdr || ihdr.data.length < 13) return null;
  const width = ihdr.data.readUInt32BE(0);
  const height = ihdr.data.readUInt32BE(4);
  const bitDepth = ihdr.data[8];
  const colorType = ihdr.data[9];
  const interlace = ihdr.data[12];
  if (!width || !height || bitDepth !== 8 || interlace !== 0) return null;
  const channelMap = { 0: 1, 2: 3, 4: 2, 6: 4 };
  const channels = channelMap[colorType];
  if (!channels) return null;
  const idat = Buffer.concat(chunks.filter((chunk) => chunk.type === 'IDAT').map((chunk) => chunk.data));
  if (!idat.length) return null;
  let raw;
  try {
    raw = zlib.inflateSync(idat);
  } catch {
    return null;
  }
  const pixels = unfilter(raw, width, height, channels);
  if (!pixels) return null;
  const rgba = Buffer.alloc(width * height * 4);
  for (let i = 0, p = 0; i < width * height; i += 1, p += channels) {
    const out = i * 4;
    if (colorType === 0) {
      rgba[out] = pixels[p];
      rgba[out + 1] = pixels[p];
      rgba[out + 2] = pixels[p];
      rgba[out + 3] = 255;
    } else if (colorType === 4) {
      rgba[out] = pixels[p];
      rgba[out + 1] = pixels[p];
      rgba[out + 2] = pixels[p];
      rgba[out + 3] = pixels[p + 1];
    } else if (colorType === 2) {
      rgba[out] = pixels[p];
      rgba[out + 1] = pixels[p + 1];
      rgba[out + 2] = pixels[p + 2];
      rgba[out + 3] = 255;
    } else {
      rgba[out] = pixels[p];
      rgba[out + 1] = pixels[p + 1];
      rgba[out + 2] = pixels[p + 2];
      rgba[out + 3] = pixels[p + 3];
    }
  }
  return { width, height, rgba };
}

function encodePng(width, height, rgba) {
  const stride = width * 4;
  const raw = Buffer.alloc((stride + 1) * height);
  for (let y = 0; y < height; y += 1) {
    raw[y * (stride + 1)] = 0;
    rgba.copy(raw, y * (stride + 1) + 1, y * stride, (y + 1) * stride);
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8;
  ihdr[9] = 6;
  ihdr[10] = 0;
  ihdr[11] = 0;
  ihdr[12] = 0;
  return Buffer.concat([
    PNG_SIGNATURE,
    pngChunk('IHDR', ihdr),
    pngChunk('IDAT', zlib.deflateSync(raw, { level: 9 })),
    pngChunk('IEND', Buffer.alloc(0)),
  ]);
}

function cornerIsWhite(rgba, width, height) {
  const points = [
    [0, 0],
    [width - 1, 0],
    [0, height - 1],
    [width - 1, height - 1],
  ];
  for (const [cx, cy] of points) {
    let r = 0;
    let g = 0;
    let b = 0;
    let a = 0;
    let count = 0;
    for (let y = Math.max(0, cy - 4); y <= Math.min(height - 1, cy + 4); y += 1) {
      for (let x = Math.max(0, cx - 4); x <= Math.min(width - 1, cx + 4); x += 1) {
        const i = (y * width + x) * 4;
        r += rgba[i];
        g += rgba[i + 1];
        b += rgba[i + 2];
        a += rgba[i + 3];
        count += 1;
      }
    }
    if (!count || a / count < 248 || r / count < 244 || g / count < 244 || b / count < 244) {
      return false;
    }
  }
  return true;
}

function borderColor(rgba, width, height) {
  let r = 0;
  let g = 0;
  let b = 0;
  let count = 0;
  for (let x = 0; x < width; x += 1) {
    for (const y of [0, height - 1]) {
      const i = (y * width + x) * 4;
      r += rgba[i];
      g += rgba[i + 1];
      b += rgba[i + 2];
      count += 1;
    }
  }
  for (let y = 1; y < height - 1; y += 1) {
    for (const x of [0, width - 1]) {
      const i = (y * width + x) * 4;
      r += rgba[i];
      g += rgba[i + 1];
      b += rgba[i + 2];
      count += 1;
    }
  }
  return count
    ? { r: Math.round(r / count), g: Math.round(g / count), b: Math.round(b / count) }
    : { r: 255, g: 255, b: 255 };
}

/**
 * Expand a PNG canvas to an exact aspect ratio. The original pixels are never
 * cropped. White-background artwork gets seamless white margins; other images
 * get a margin filled with their sampled border color.
 */
export function padPngToRatio(buffer, ratio) {
  const match = /^(\d+):(\d+)$/.exec(String(ratio || ''));
  if (!match) return null;
  const target = Number(match[1]) / Number(match[2]);
  if (!Number.isFinite(target) || target <= 0) return null;
  const png = decodePng(buffer);
  if (!png) return null;
  const current = png.width / png.height;
  if (Math.abs(current - target) < 0.004) return buffer;

  let width = png.width;
  let height = png.height;
  if (current < target) width = Math.max(width, Math.round(height * target));
  else height = Math.max(height, Math.round(width / target));
  if (width === png.width && height === png.height) return buffer;

  const dx = Math.floor((width - png.width) / 2);
  const dy = Math.floor((height - png.height) / 2);
  const out = Buffer.alloc(width * height * 4);
  const white = cornerIsWhite(png.rgba, png.width, png.height);
  const fill = white ? { r: 255, g: 255, b: 255 } : borderColor(png.rgba, png.width, png.height);
  for (let i = 0; i < width * height; i += 1) {
    const offset = i * 4;
    out[offset] = fill.r;
    out[offset + 1] = fill.g;
    out[offset + 2] = fill.b;
    out[offset + 3] = 255;
  }

  for (let y = 0; y < png.height; y += 1) {
    png.rgba.copy(
      out,
      ((y + dy) * width + dx) * 4,
      y * png.width * 4,
      (y + 1) * png.width * 4,
    );
  }
  return encodePng(width, height, out);
}

export function pngSize(buffer) {
  if (!buffer || buffer.length < 24) return null;
  if (buffer.readUInt32BE(0) !== 0x89504e47) return null;
  return { width: buffer.readUInt32BE(16), height: buffer.readUInt32BE(20) };
}

const RATIO_VALUES = {
  '1:1': 1,
  '3:4': 0.75,
  '2:3': 2 / 3,
  '9:16': 9 / 16,
  '4:3': 4 / 3,
  '3:2': 1.5,
  '16:9': 16 / 9,
};

export function inferAspectRatio(width, height) {
  if (!width || !height) return null;
  const ratio = width / height;
  let best = null;
  let bestDelta = 0.02;
  for (const [label, value] of Object.entries(RATIO_VALUES)) {
    const delta = Math.abs(ratio - value);
    if (delta < bestDelta) {
      best = label;
      bestDelta = delta;
    }
  }
  return best;
}
