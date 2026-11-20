const path = require('node:path');

// macOS appends the first allowed extension to a save name whose own extension
// is not in the filter list, so `x.pdf` with image-only filters becomes
// `x.pdf.png`. The filter must therefore follow the incoming filename.
const KNOWN_TYPES = {
  pdf: { name: 'PDF 文档', extensions: ['pdf'] },
  docx: { name: 'Word 文档', extensions: ['docx'] },
  png: { name: 'PNG 图片', extensions: ['png'] },
  jpg: { name: 'JPEG 图片', extensions: ['jpg', 'jpeg'] },
  jpeg: { name: 'JPEG 图片', extensions: ['jpg', 'jpeg'] },
  webp: { name: 'WebP 图片', extensions: ['webp'] },
  gif: { name: 'GIF 图片', extensions: ['gif'] },
  md: { name: 'Markdown 文件', extensions: ['md'] },
  txt: { name: '文本文件', extensions: ['txt'] },
  json: { name: 'JSON 文件', extensions: ['json'] },
  csv: { name: 'CSV 文件', extensions: ['csv'] },
  zip: { name: '压缩包', extensions: ['zip'] },
};

function safeBasename(raw) {
  const name = path.basename(String(raw || '').trim());
  // `.` and `..` survive basename and would point the defaultPath at a
  // directory (even the parent of Downloads), so they are not filenames.
  return name && name !== '.' && name !== '..' ? name : 'download';
}

function downloadDialogOptions({ filename, downloadsDir }) {
  const name = safeBasename(filename);
  const ext = path.extname(name).slice(1).toLowerCase();
  // Own-key lookup only: `constructor`, `__proto__` and friends are inherited
  // properties, and handing one to Electron yields an invalid filter.
  const known = Object.hasOwn(KNOWN_TYPES, ext) ? KNOWN_TYPES[ext] : null;
  const options = {
    title: known ? `保存${known.name}` : '保存文件',
    defaultPath: path.join(downloadsDir, name),
  };
  if (known) options.filters = [known];
  return options;
}

module.exports = { downloadDialogOptions };