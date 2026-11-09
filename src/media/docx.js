import { createZip } from './zip-writer.js';

const EMU_PER_INCH = 914400;
const MAX_IMAGE_WIDTH = 6 * EMU_PER_INCH;
const MAX_IMAGE_HEIGHT = 7.2 * EMU_PER_INCH;

function escapeXml(value) {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

function cleanText(value) {
  return String(value ?? '').replace(
    /[\u0000-\u0008\u000B\u000C\u000E-\u001F\uFFFE\uFFFF]/g,
    '',
  );
}

function runProperties({ bold, italic, mono }) {
  const props = [];
  if (bold) props.push('<w:b/>');
  if (italic) props.push('<w:i/>');
  if (mono) props.push('<w:rFonts w:ascii="Consolas" w:hAnsi="Consolas"/>');
  return props.length ? `<w:rPr>${props.join('')}</w:rPr>` : '';
}

function textRun(value, options = {}) {
  const text = cleanText(value);
  if (!text) return '';
  return `<w:r>${runProperties(options)}<w:t xml:space="preserve">${escapeXml(text)}</w:t></w:r>`;
}

function inlineRuns(value) {
  const source = cleanText(value).replace(/\r\n?/g, '\n');
  const output = [];
  for (const [lineIndex, line] of source.split('\n').entries()) {
    if (lineIndex > 0) output.push('<w:r><w:br/></w:r>');
    const pattern = /(\*\*[^*\n]+\*\*|\*[^*\n]+\*|`[^`\n]+`)/g;
    let last = 0;
    let match;
    while ((match = pattern.exec(line))) {
      output.push(textRun(line.slice(last, match.index)));
      const token = match[0];
      if (token.startsWith('**')) output.push(textRun(token.slice(2, -2), { bold: true }));
      else if (token.startsWith('`')) output.push(textRun(token.slice(1, -1), { mono: true }));
      else output.push(textRun(token.slice(1, -1), { italic: true }));
      last = pattern.lastIndex;
    }
    output.push(textRun(line.slice(last)));
  }
  return output.join('');
}

function paragraph(text, { style, extra } = {}) {
  const pPr =
    style || extra
      ? `<w:pPr>${style ? `<w:pStyle w:val="${style}"/>` : ''}${extra || ''}</w:pPr>`
      : '';
  return `<w:p>${pPr}${inlineRuns(text)}</w:p>`;
}

function headingParagraph(text, level) {
  return paragraph(text, { style: `Heading${Math.min(3, Math.max(1, level || 1))}` });
}

function bulletParagraphs(block) {
  return block.items
    .map((item, index) =>
      paragraph(`${block.ordered ? `${index + 1}. ` : '• '}${item}`, {
        extra: '<w:spacing w:after="80"/><w:ind w:left="420" w:hanging="240"/>',
      }),
    )
    .join('');
}

function imageParagraph(block, relId, number, mediaName) {
  const width = Number(block.width) || 1024;
  const height = Number(block.height) || 1024;
  const scale = Math.min(MAX_IMAGE_WIDTH / width, MAX_IMAGE_HEIGHT / height);
  const cx = Math.max(1, Math.round(width * scale));
  const cy = Math.max(1, Math.round(height * scale));
  const description = escapeXml(block.caption || block.alt || '');
  const drawing = `<w:r><w:drawing><wp:inline distT="0" distB="0" distL="0" distR="0"><wp:extent cx="${cx}" cy="${cy}"/><wp:effectExtent l="0" t="0" r="0" b="0"/><wp:docPr id="${number}" name="Picture ${number}" descr="${description}"/><wp:cNvGraphicFramePr><a:graphicFrameLocks noChangeAspect="1"/></wp:cNvGraphicFramePr><a:graphic><a:graphicData uri="http://schemas.openxmlformats.org/drawingml/2006/picture"><pic:pic><pic:nvPicPr><pic:cNvPr id="${number}" name="${mediaName}" descr="${description}"/><pic:cNvPicPr/></pic:nvPicPr><pic:blipFill><a:blip r:embed="${relId}"/><a:stretch><a:fillRect/></a:stretch></pic:blipFill><pic:spPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="${cx}" cy="${cy}"/></a:xfrm><a:prstGeom prst="rect"><a:avLst/></a:prstGeom></pic:spPr></pic:pic></a:graphicData></a:graphic></wp:inline></w:drawing></w:r>`;
  const caption = block.caption
    ? paragraph(block.caption, { style: 'Caption', extra: '<w:spacing w:after="240"/>' })
    : '';
  return `<w:p><w:pPr><w:spacing w:before="240" w:after="80"/><w:jc w:val="center"/></w:pPr>${drawing}</w:p>${caption}`;
}

function documentXml({ title, meta, blocks, media }) {
  const body = [];
  if (title) body.push(paragraph(title, { style: 'Title' }));
  if (meta) body.push(paragraph(meta, { style: 'Meta' }));

  let imageIndex = 0;
  for (const block of blocks) {
    if (block.type === 'heading') {
      body.push(headingParagraph(block.text, block.level));
    } else if (block.type === 'paragraph') {
      body.push(paragraph(block.text));
    } else if (block.type === 'bullets') {
      body.push(bulletParagraphs(block));
    } else if (block.type === 'quote') {
      body.push(paragraph(block.text, { style: 'Quote' }));
    } else if (block.type === 'image' && block.data) {
      imageIndex += 1;
      body.push(
        imageParagraph(
          block,
          `rIdImg${imageIndex}`,
          imageIndex,
          media[imageIndex - 1].name,
        ),
      );
    }
  }

  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships" xmlns:wp="http://schemas.openxmlformats.org/drawingml/2006/wordprocessingDrawing" xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" xmlns:pic="http://schemas.openxmlformats.org/drawingml/2006/picture"><w:body>${body.join('')}<w:sectPr><w:pgSz w:w="11906" w:h="16838"/><w:pgMar w:top="1440" w:right="1440" w:bottom="1440" w:left="1440" w:header="708" w:footer="708" w:gutter="0"/></w:sectPr></w:body></w:document>`;
}

function stylesXml() {
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><w:styles xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:docDefaults><w:rPrDefault><w:rPr><w:rFonts w:ascii="Aptos" w:hAnsi="Aptos" w:eastAsia="Microsoft YaHei" w:cs="Aptos"/><w:sz w:val="21"/><w:szCs w:val="21"/><w:lang w:val="zh-CN" w:eastAsia="zh-CN"/></w:rPr></w:rPrDefault><w:pPrDefault><w:pPr><w:spacing w:after="160" w:line="360" w:lineRule="auto"/></w:pPr></w:pPrDefault></w:docDefaults><w:style w:type="paragraph" w:default="1" w:styleId="Normal"><w:name w:val="Normal"/><w:qFormat/></w:style><w:style w:type="paragraph" w:styleId="Title"><w:name w:val="Title"/><w:basedOn w:val="Normal"/><w:next w:val="Normal"/><w:qFormat/><w:pPr><w:spacing w:before="240" w:after="240"/><w:jc w:val="left"/></w:pPr><w:rPr><w:b/><w:color w:val="111827"/><w:sz w:val="44"/><w:szCs w:val="44"/></w:rPr></w:style><w:style w:type="paragraph" w:styleId="Heading1"><w:name w:val="heading 1"/><w:basedOn w:val="Normal"/><w:next w:val="Normal"/><w:qFormat/><w:pPr><w:keepNext/><w:spacing w:before="360" w:after="120"/><w:outlineLvl w:val="0"/></w:pPr><w:rPr><w:b/><w:color w:val="1F2937"/><w:sz w:val="32"/><w:szCs w:val="32"/></w:rPr></w:style><w:style w:type="paragraph" w:styleId="Heading2"><w:name w:val="heading 2"/><w:basedOn w:val="Normal"/><w:next w:val="Normal"/><w:qFormat/><w:pPr><w:keepNext/><w:spacing w:before="300" w:after="100"/><w:outlineLvl w:val="1"/></w:pPr><w:rPr><w:b/><w:color w:val="1F2937"/><w:sz w:val="28"/><w:szCs w:val="28"/></w:rPr></w:style><w:style w:type="paragraph" w:styleId="Heading3"><w:name w:val="heading 3"/><w:basedOn w:val="Normal"/><w:next w:val="Normal"/><w:qFormat/><w:pPr><w:keepNext/><w:spacing w:before="240" w:after="80"/><w:outlineLvl w:val="2"/></w:pPr><w:rPr><w:b/><w:color w:val="374151"/><w:sz w:val="24"/><w:szCs w:val="24"/></w:rPr></w:style><w:style w:type="paragraph" w:styleId="Meta"><w:name w:val="Meta"/><w:basedOn w:val="Normal"/><w:qFormat/><w:pPr><w:spacing w:after="240"/></w:pPr><w:rPr><w:color w:val="6B7280"/><w:sz w:val="19"/><w:szCs w:val="19"/></w:rPr></w:style><w:style w:type="paragraph" w:styleId="Quote"><w:name w:val="Quote"/><w:basedOn w:val="Normal"/><w:qFormat/><w:pPr><w:spacing w:before="120" w:after="200"/><w:ind w:left="360" w:right="240"/></w:pPr><w:rPr><w:i/><w:color w:val="4B5563"/></w:rPr></w:style><w:style w:type="paragraph" w:styleId="Caption"><w:name w:val="Caption"/><w:basedOn w:val="Normal"/><w:qFormat/><w:pPr><w:spacing w:after="200"/><w:jc w:val="center"/></w:pPr><w:rPr><w:color w:val="6B7280"/><w:sz w:val="18"/><w:szCs w:val="18"/></w:rPr></w:style></w:styles>`;
}

function contentTypesXml(media) {
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Default Extension="jpeg" ContentType="image/jpeg"/><Default Extension="png" ContentType="image/png"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/><Override PartName="/word/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.styles+xml"/><Override PartName="/docProps/core.xml" ContentType="application/vnd.openxmlformats-package.core-properties+xml"/>${media
    .map(
      (item) =>
        `<Override PartName="/word/media/${item.name}" ContentType="${item.contentType}"/>`,
    )
    .join('')}</Types>`;
}

function rootRelsXml() {
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/><Relationship Id="rId2" Type="http://schemas.openxmlformats.org/package/2006/relationships/metadata/core-properties" Target="docProps/core.xml"/></Relationships>`;
}

function documentRelsXml(media) {
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rIdStyles" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/>${media
    .map(
      (item, index) =>
        `<Relationship Id="rIdImg${index + 1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/image" Target="media/${item.name}"/>`,
    )
    .join('')}</Relationships>`;
}

function coreXml(title) {
  const created = new Date().toISOString();
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><cp:coreProperties xmlns:cp="http://schemas.openxmlformats.org/package/2006/metadata/core-properties" xmlns:dc="http://purl.org/dc/elements/1.1/" xmlns:dcterms="http://purl.org/dc/terms/" xmlns:dcmitype="http://purl.org/dc/dcmitype/" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance"><dc:title>${escapeXml(title)}</dc:title><dc:creator>Luma</dc:creator><cp:lastModifiedBy>Luma</cp:lastModifiedBy><dcterms:created xsi:type="dcterms:W3CDTF">${created}</dcterms:created><dcterms:modified xsi:type="dcterms:W3CDTF">${created}</dcterms:modified></cp:coreProperties>`;
}

/**
 * Builds a minimal, Word-compatible .docx from parsed blocks. Images are
 * embedded as JPEG parts and relationships; everything else is plain
 * WordprocessingML so the archive stays small and dependency-free.
 */
export function buildDocx({ title, meta, blocks }) {
  const media = [];
  const prepared = [];
  for (const block of blocks || []) {
    if (block.type !== 'image') {
      prepared.push(block);
      continue;
    }
    if (!block.data || !Buffer.isBuffer(block.data)) continue;
    const name = `image${media.length + 1}.jpeg`;
    media.push({ name, contentType: 'image/jpeg', data: block.data });
    prepared.push({ ...block, mediaName: name });
  }

  const files = [
    {
      name: '[Content_Types].xml',
      data: contentTypesXml(media),
    },
    { name: '_rels/.rels', data: rootRelsXml() },
    { name: 'docProps/core.xml', data: coreXml(title || 'Luma 文档') },
    {
      name: 'word/document.xml',
      data: documentXml({ title, meta, blocks: prepared, media }),
    },
    { name: 'word/styles.xml', data: stylesXml() },
    { name: 'word/_rels/document.xml.rels', data: documentRelsXml(media) },
    ...media.map((item) => ({
      name: `word/media/${item.name}`,
      data: item.data,
      compress: false,
    })),
  ];

  return createZip(files);
}
