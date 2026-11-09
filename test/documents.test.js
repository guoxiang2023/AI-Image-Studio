import test from 'node:test';
import assert from 'node:assert/strict';
import { deflateRawSync } from 'node:zlib';
import PDFDocument from 'pdfkit';
import {
  documentExt,
  extractDocumentText,
  extractDocumentTextAsync,
  isSupportedDocumentExt,
} from '../src/media/document-text.js';

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let index = 0; index < 256; index += 1) {
    let value = index;
    for (let bit = 0; bit < 8; bit += 1) {
      value = value & 1 ? 0xedb88320 ^ (value >>> 1) : value >>> 1;
    }
    table[index] = value >>> 0;
  }
  return table;
})();

function crc32(buffer) {
  let value = 0xffffffff;
  for (const byte of buffer) value = CRC_TABLE[(value ^ byte) & 0xff] ^ (value >>> 8);
  return (value ^ 0xffffffff) >>> 0;
}


async function makePdf(text) {
  const doc = new PDFDocument({ size: 'A4', margin: 50 });
  const chunks = [];
  doc.on('data', (chunk) => chunks.push(chunk));
  const done = new Promise((resolve, reject) => {
    doc.on('end', () => resolve(Buffer.concat(chunks)));
    doc.on('error', reject);
  });
  doc.fontSize(12).text(text, { width: 450 });
  doc.end();
  return done;
}

function makeZip(entries) {
  const localParts = [];
  const centralParts = [];
  let offset = 0;
  for (const [name, content] of entries) {
    const nameBuffer = Buffer.from(name, 'utf8');
    const data = Buffer.isBuffer(content) ? content : Buffer.from(content, 'utf8');
    const compressed = deflateRawSync(data);
    const crc = crc32(data);

    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(0, 6);
    local.writeUInt16LE(8, 8);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(compressed.length, 18);
    local.writeUInt32LE(data.length, 22);
    local.writeUInt16LE(nameBuffer.length, 26);
    localParts.push(local, nameBuffer, compressed);

    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(20, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(0, 8);
    central.writeUInt16LE(8, 10);
    central.writeUInt32LE(crc, 16);
    central.writeUInt32LE(compressed.length, 20);
    central.writeUInt32LE(data.length, 24);
    central.writeUInt16LE(nameBuffer.length, 28);
    central.writeUInt32LE(offset, 42);
    centralParts.push(central, nameBuffer);

    offset += 30 + nameBuffer.length + compressed.length;
  }

  const localBuffer = Buffer.concat(localParts);
  const centralBuffer = Buffer.concat(centralParts);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(centralBuffer.length, 12);
  end.writeUInt32LE(localBuffer.length, 16);
  return Buffer.concat([localBuffer, centralBuffer, end]);
}

test('recognizes document extensions', () => {
  assert.equal(documentExt('季度报表.XLSX'), 'xlsx');
  assert.equal(documentExt('no-extension'), '');
  assert.equal(isSupportedDocumentExt('docx'), true);
  assert.equal(isSupportedDocumentExt('pdf'), true);
});

test('extracts Word paragraphs, runs, and table rows', () => {
  const xml = `<?xml version="1.0" encoding="UTF-8"?>
<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body>
<w:p><w:r><w:t>季度总结</w:t></w:r></w:p>
<w:p><w:r><w:t xml:space="preserve">你好 </w:t></w:r><w:r><w:t>世界 &amp; 朋友</w:t></w:r></w:p>
<w:p><w:r><w:t>&lt;div&gt; 是标签文字</w:t></w:r></w:p>
<w:tbl>
<w:tr><w:tc><w:p><w:r><w:t>A</w:t></w:r></w:p></w:tc><w:tc><w:p><w:r><w:t>B</w:t></w:r></w:p></w:tc></w:tr>
<w:tr><w:tc><w:p><w:r><w:t>1</w:t></w:r></w:p></w:tc><w:tc><w:p><w:r><w:t>2</w:t></w:r></w:p></w:tc></w:tr>
</w:tbl>
</w:body></w:document>`;
  const result = extractDocumentText(
    makeZip([['word/document.xml', xml]]),
    'docx',
  );
  assert.equal(result.kind, 'Word 文档');
  assert.match(result.text, /季度总结/);
  assert.match(result.text, /你好 世界 & 朋友/);
  assert.ok(result.text.includes('<div> 是标签文字'));
  assert.match(result.text, /A\tB/);
  assert.match(result.text, /1\t2/);
});

test('keeps escaped markup text from being stripped as XML tags', () => {
  const docx = extractDocumentText(
    makeZip([
      [
        'word/document.xml',
        `<w:document><w:body><w:p><w:r><w:t>&lt;div class="box"&gt;code&lt;/div&gt;</w:t></w:r></w:p></w:body></w:document>`,
      ],
    ]),
    'docx',
  );
  assert.ok(docx.text.includes('<div class="box">code</div>'));

  const pptx = extractDocumentText(
    makeZip([
      ['ppt/slides/slide1.xml', `<p:sld><a:p><a:r><a:t>&lt;div&gt;code&lt;/div&gt;</a:t></a:r></a:p></p:sld>`],
    ]),
    'pptx',
  );
  assert.ok(pptx.text.includes('<div>code</div>'));
});

test('extracts Excel shared strings, numbers, inline strings, and dates', () => {
  const zip = makeZip([
    [
      'xl/sharedStrings.xml',
      `<sst><si><t>名称</t></si><si><t>数值</t></si><si><t>苹果</t></si></sst>`,
    ],
    [
      'xl/workbook.xml',
      `<workbook><sheets><sheet name="数据" sheetId="1" r:id="rId1"/></sheets></workbook>`,
    ],
    [
      'xl/_rels/workbook.xml.rels',
      `<Relationships><Relationship Id="rId1" Target="worksheets/sheet1.xml"/></Relationships>`,
    ],
    [
      'xl/styles.xml',
      `<styleSheet><numFmts><numFmt numFmtId="164" formatCode="yyyy-mm-dd"/></numFmts><cellXfs count="3"><xf numFmtId="0"/><xf numFmtId="14"/><xf numFmtId="164"/></cellXfs></styleSheet>`,
    ],
    [
      'xl/worksheets/sheet1.xml',
      `<worksheet><sheetData>
<row r="1"><c r="A1" t="s"><v>0</v></c><c r="B1" t="s"><v>1</v></c><c r="C1" t="s"><v>2</v></c></row>
<row r="2"><c r="A2"><v>42.5</v></c><c r="B2" s="1"><v>45000</v></c><c r="C2" s="2"><v>45000</v></c></row>
<row r="3"><c r="B3" t="inlineStr"><is><t>内联</t></is></c></row>
</sheetData></worksheet>`,
    ],
  ]);
  const result = extractDocumentText(zip, 'xlsx');
  assert.equal(result.kind, 'Excel 表格');
  assert.match(result.text, /## 工作表：数据/);
  assert.match(result.text, /名称\t数值\t苹果/);
  assert.match(result.text, /42\.5\t2023-03-15\t2023-03-15/);
  assert.match(result.text, /\n\t内联/);
});

test('extracts PowerPoint slide text', () => {
  const zip = makeZip([
    [
      'ppt/slides/slide1.xml',
      `<p:sld><a:p><a:r><a:t>开场</a:t></a:r><a:r><a:t>标题</a:t></a:r></a:p><a:p><a:r><a:t>第二段</a:t></a:r></a:p><a:p><a:r><a:t>&lt;div&gt; 标签</a:t></a:r></a:p></p:sld>`,
    ],
    [
      'ppt/slides/slide2.xml',
      `<p:sld><a:p><a:r><a:t>结尾</a:t></a:r></a:p></p:sld>`,
    ],
  ]);
  const result = extractDocumentText(zip, 'pptx');
  assert.equal(result.kind, 'PPT 演示文稿');
  assert.match(result.text, /## 幻灯片 1\n开场标题\n第二段\n<div> 标签/);
  assert.match(result.text, /## 幻灯片 2\n结尾/);
});

test('decodes UTF-8 BOM and UTF-16 plain text', () => {
  const utf8 = Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from('第一行\n第二行')]);
  assert.equal(extractDocumentText(utf8, 'txt').text, '第一行\n第二行');
  const utf16 = Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from('中文内容', 'utf16le')]);
  assert.equal(extractDocumentText(utf16, 'txt').text, '中文内容');
});

test('strips HTML markup and decodes entities', () => {
  const html = '<html><style>p{color:red}</style><body><h1>标题</h1><p>你好 &amp; 世界</p><script>alert(1)</script></body></html>';
  const result = extractDocumentText(Buffer.from(html), 'html');
  assert.match(result.text, /标题/);
  assert.match(result.text, /你好 & 世界/);
  assert.doesNotMatch(result.text, /color|alert/);
});

test('rejects legacy Office files with a conversion hint', () => {
  assert.throws(
    () => extractDocumentText(Buffer.from('legacy'), 'doc'),
    (error) => error.status === 415 && /另存为 \.docx/.test(error.message),
  );
  assert.throws(
    () => extractDocumentText(Buffer.from('legacy'), 'xls'),
    (error) => error.status === 415 && /另存为 \.xlsx/.test(error.message),
  );
});

test('rejects binary text and corrupt archives', () => {
  assert.throws(
    () => extractDocumentText(Buffer.from([0x41, 0x00, 0x42]), 'txt'),
    (error) => error.status === 415 && /二进制/.test(error.message),
  );
  assert.throws(
    () => extractDocumentText(Buffer.from('not a zip'), 'docx'),
    (error) => error.status === 400 && /无法读取/.test(error.message),
  );
});

test('rejects documents without readable text', () => {
  assert.throws(
    () => extractDocumentText(makeZip([['word/document.xml', '<w:document><w:body /></w:document>']]), 'docx'),
    (error) => error.status === 400 && /没有可读取的文字/.test(error.message),
  );
});

test('extracts text from PDF uploads', async () => {
  const buffer = await makePdf('Hello PDF\nSecond line with 123');
  const result = await extractDocumentTextAsync(buffer, 'pdf');
  assert.equal(result.kind, 'PDF 文档');
  assert.match(result.text, /Hello PDF/);
  assert.match(result.text, /Second line with 123/);
  assert.equal(result.truncated, false);
});

test('rejects fake or unreadable PDF uploads', async () => {
  await assert.rejects(
    () => extractDocumentTextAsync(Buffer.from('not a pdf'), 'pdf'),
    (error) => error.status === 400 && /不是有效的 PDF/.test(error.message),
  );
});
