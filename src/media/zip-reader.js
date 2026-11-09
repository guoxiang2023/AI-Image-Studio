import { inflateRawSync } from 'node:zlib';

const EOCD_SIGNATURE = 0x06054b50;
const CENTRAL_SIGNATURE = 0x02014b50;
const LOCAL_SIGNATURE = 0x04034b50;
const MAX_ENTRIES = 4000;
const MAX_ENTRY_BYTES = 32 * 1024 * 1024;
const MAX_TOTAL_BYTES = 96 * 1024 * 1024;

function findEndOfCentralDirectory(buffer) {
  const min = Math.max(0, buffer.length - 22 - 0xffff);
  for (let offset = buffer.length - 22; offset >= min; offset -= 1) {
    if (buffer.readUInt32LE(offset) === EOCD_SIGNATURE) return offset;
  }
  return -1;
}

/**
 * Minimal ZIP index for Office Open XML files. Only the central directory is
 * parsed up front; entry bodies are inflated on demand so embedded images in
 * docx/xlsx/pptx files never get loaded.
 */
export function openZip(buffer) {
  if (!Buffer.isBuffer(buffer) || buffer.length < 22) throw new Error('文件不是有效的 ZIP');
  const eocd = findEndOfCentralDirectory(buffer);
  if (eocd < 0) throw new Error('文件不是有效的 ZIP');

  const count = buffer.readUInt16LE(eocd + 10);
  let cursor = buffer.readUInt32LE(eocd + 16);
  if (count > MAX_ENTRIES) throw new Error('文档压缩包条目过多');
  if (cursor >= buffer.length) throw new Error('文档压缩包已损坏');

  const entries = new Map();
  let totalBytes = 0;
  for (let index = 0; index < count; index += 1) {
    if (cursor + 46 > buffer.length || buffer.readUInt32LE(cursor) !== CENTRAL_SIGNATURE) {
      throw new Error('文档压缩包已损坏');
    }
    const flags = buffer.readUInt16LE(cursor + 8);
    const method = buffer.readUInt16LE(cursor + 10);
    const compressedSize = buffer.readUInt32LE(cursor + 20);
    const uncompressedSize = buffer.readUInt32LE(cursor + 24);
    const nameLength = buffer.readUInt16LE(cursor + 28);
    const extraLength = buffer.readUInt16LE(cursor + 30);
    const commentLength = buffer.readUInt16LE(cursor + 32);
    const localOffset = buffer.readUInt32LE(cursor + 42);
    const name = buffer.toString('utf8', cursor + 46, cursor + 46 + nameLength);

    totalBytes += uncompressedSize;
    if (uncompressedSize > MAX_ENTRY_BYTES || totalBytes > MAX_TOTAL_BYTES) {
      throw new Error('文档解压后体积过大');
    }
    entries.set(name, { flags, method, compressedSize, uncompressedSize, localOffset });
    cursor += 46 + nameLength + extraLength + commentLength;
  }

  function read(name) {
    const entry = entries.get(name);
    if (!entry) return null;
    if (entry.flags & 0x1) throw new Error('暂不支持加密的文档');
    const local = entry.localOffset;
    if (local + 30 > buffer.length || buffer.readUInt32LE(local) !== LOCAL_SIGNATURE) {
      throw new Error('文档压缩包已损坏');
    }
    const nameLength = buffer.readUInt16LE(local + 26);
    const extraLength = buffer.readUInt16LE(local + 28);
    const start = local + 30 + nameLength + extraLength;
    const end = start + entry.compressedSize;
    if (end > buffer.length) throw new Error('文档压缩包已损坏');
    if (entry.method === 0) return buffer.subarray(start, end);
    if (entry.method === 8) {
      return inflateRawSync(buffer.subarray(start, end), {
        maxOutputLength: Math.max(1, entry.uncompressedSize),
      });
    }
    throw new Error('文档使用了不支持的压缩方式');
  }

  return {
    has: (name) => entries.has(name),
    names: () => [...entries.keys()],
    read,
    readText(name) {
      const data = read(name);
      return data ? data.toString('utf8') : null;
    },
  };
}
