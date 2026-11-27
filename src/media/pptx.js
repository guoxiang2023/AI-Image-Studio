import { createZip } from './zip-writer.js';

// 16:9 canvas used by every modern deck (13.333in × 7.5in). All geometry below
// is EMU: 914400 per inch, 12700 per point.
const SLIDE_W = 12192000;
const SLIDE_H = 6858000;
const EMU_PER_PT = 12700;
const MARGIN_X = 838200;
const CONTENT_W = SLIDE_W - MARGIN_X * 2;

const BODY_PT = 1800;
// Short slides should grow into the canvas; long ones still shrink to the floor.
const BODY_MAX_PT = 2400;
const BODY_MIN_PT = 1200;
const LINE_FACTOR = 1.35;
const MAX_BULLETS = 6;
const BULLET_CHARS = 96;
const TITLE_CHARS = 46;

const SLIDE_REL_LAYOUT = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships/slideLayout';
const REL_IMAGE = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships/image';

const XML_HEAD = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>';
const NS_P = 'http://schemas.openxmlformats.org/presentationml/2006/main';
const NS_A = 'http://schemas.openxmlformats.org/drawingml/2006/main';
const NS_R = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships';

function escapeXml(value) {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

// Characters PowerPoint itself refuses to store; surrogate halves and control
// codes make the package unreadable rather than merely ugly.
function cleanText(value) {
  return String(value ?? '')
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\uFFFE\uFFFF]/g, '')
    .replace(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])/g, '')
    .replace(/(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/g, '');
}

function clip(value, limit) {
  const text = String(value ?? '').trim();
  const chars = Array.from(text);
  return chars.length > limit ? `${chars.slice(0, limit - 1).join('')}…` : text;
}

/**
 * Rough advance width in points. CJK and full-width punctuation occupy a full
 * em; Latin text averages about half. This is deliberately approximate — it
 * only has to be pessimistic enough to catch overflow before PowerPoint does.
 */
function advancePt(text, pt) {
  let units = 0;
  for (const char of text) {
    const code = char.codePointAt(0);
    const wide =
      (code >= 0x1100 && code <= 0x115f) ||
      (code >= 0x2e80 && code <= 0xa4cf) ||
      (code >= 0xac00 && code <= 0xd7a3) ||
      (code >= 0xf900 && code <= 0xfaff) ||
      (code >= 0xfe30 && code <= 0xfe6f) ||
      (code >= 0xff00 && code <= 0xff60) ||
      (code >= 0xffe0 && code <= 0xffe6);
    units += wide ? 1 : 0.52;
  }
  return units * pt;
}

function wrappedLines(text, pt, widthEmu) {
  const usable = (widthEmu / EMU_PER_PT) * 0.96; // leave room for glyph side bearings
  if (usable <= 0) return 1;
  return Math.max(1, Math.ceil(advancePt(text, pt / 100) / usable));
}

// `pt` values in the XML are hundredths of a point (1800 = 18pt), so every
// measurement converts to points first.
function blockHeight(lines, pt) {
  return lines * (pt / 100) * LINE_FACTOR * EMU_PER_PT;
}

/**
 * Shrinks a bullet list until it fits the box, then trims bullets as a last
 * resort. PowerPoint silently lets text spill outside its frame, so the only
 * defence is to measure here.
 */
export function fitBullets(
  items,
  { width = CONTENT_W, height, startPt = BODY_PT, maxPt = BODY_MAX_PT } = {},
) {
  const source = (Array.isArray(items) ? items : []).map((item) => cleanText(item).trim()).filter(Boolean);
  let clipped = 0;
  const list = source
    .map((item) => {
      const cut = clip(item, BULLET_CHARS);
      if (cut !== item) clipped += 1;
      return cut;
    })
    .slice(0, MAX_BULLETS);
  const dropped = Math.max(0, source.length - MAX_BULLETS);
  if (!list.length) return { items: [], pt: startPt, overflow: false, clipped, dropped };

  const gaps = 0.35; // space after each bullet, as a fraction of a line
  // Start from the ceiling, not the default: with little text the page should
  // read from the back of the room, and the loop still shrinks when it cannot.
  for (let pt = Math.max(startPt, maxPt); pt >= BODY_MIN_PT; pt -= 200) {
    const total = list.reduce(
      (sum, item) => sum + wrappedLines(`• ${item}`, pt, width) + gaps,
      0,
    );
    if (blockHeight(total, pt) <= height) {
      return { items: list, pt, overflow: false, clipped, dropped };
    }
  }

  // Still too tall at the minimum size: drop trailing bullets rather than
  // rendering text outside the slide.
  const trimmed = [...list];
  while (trimmed.length > 1) {
    trimmed.pop();
    const total = trimmed.reduce(
      (sum, item) => sum + wrappedLines(`• ${item}`, BODY_MIN_PT, width) + gaps,
      0,
    );
    if (blockHeight(total, BODY_MIN_PT) <= height) break;
  }
  return {
    items: trimmed,
    pt: BODY_MIN_PT,
    overflow: true,
    clipped,
    dropped: dropped + (list.length - trimmed.length),
  };
}

/** Fits an image box inside its slot while keeping the source aspect ratio. */
export function fitImage(width, height, boxW, boxH) {
  const w = Number(width) > 0 ? Number(width) : 0;
  const h = Number(height) > 0 ? Number(height) : 0;
  if (!w || !h) return { cx: boxW, cy: boxH };
  const scale = Math.min(boxW / w, boxH / h);
  return { cx: Math.max(1, Math.round(w * scale)), cy: Math.max(1, Math.round(h * scale)) };
}

/**
 * `pt` and `spaceAfter` are both in hundredths of a point, matching the
 * `sz`/`spcPts` units DrawingML expects, so neither is scaled here again.
 */
function paragraphXml(text, { pt, bold, color, align, spaceAfter } = {}) {
  // Attributes and child elements are separate: <a:rPr> takes lang/sz/b as
  // attributes, while the colour fill is a child element.
  const attrs = [`lang="zh-CN"`, `sz="${pt}"`, bold ? 'b="1"' : '', 'dirty="0"']
    .filter(Boolean)
    .join(' ');
  const fill = color
    ? `<a:solidFill><a:srgbClr val="${color}"/></a:solidFill>`
    : '';
  const pPrAttrs = align ? ` algn="${align}"` : '';
  const pPrChild =
    spaceAfter != null
      ? `<a:spcAft><a:spcPts val="${Math.round(spaceAfter)}"/></a:spcAft>`
      : '';
  const pPr = pPrAttrs || pPrChild ? `<a:pPr${pPrAttrs}>${pPrChild}</a:pPr>` : '';
  return (
    `<a:p>${pPr}` +
    `<a:r><a:rPr ${attrs}>${fill}</a:rPr><a:t>${escapeXml(text)}</a:t></a:r></a:p>`
  );
}

function textShape({ id, name, x, y, cx, cy, paragraphs, anchor = 't' }) {
  // prstGeom is not decorative: without it consumers cannot classify the shape
  // (python-pptx raises on shape_type) and PowerPoint may drop the geometry.
  return (
    `<p:sp><p:nvSpPr><p:cNvPr id="${id}" name="${escapeXml(name)}"/>` +
    '<p:cNvSpPr><a:spLocks noGrp="1"/></p:cNvSpPr><p:nvPr/></p:nvSpPr>' +
    `<p:spPr><a:xfrm><a:off x="${x}" y="${y}"/><a:ext cx="${cx}" cy="${cy}"/></a:xfrm>` +
    '<a:prstGeom prst="rect"><a:avLst/></a:prstGeom></p:spPr>' +
    `<p:txBody><a:bodyPr wrap="square" lIns="0" rIns="0" tIns="0" bIns="0" anchor="${anchor}">` +
    '<a:normAutofit/></a:bodyPr><a:lstStyle/>' +
    // DrawingML requires a body to hold at least one paragraph; a text frame
    // with none is a repair-prompt case in PowerPoint.
    (paragraphs.length ? paragraphs.join('') : '<a:p/>') +
    '</p:txBody></p:sp>'
  );
}

function rectShape({ id, name, x, y, cx, cy, color }) {
  return (
    `<p:sp><p:nvSpPr><p:cNvPr id="${id}" name="${escapeXml(name)}"/>` +
    '<p:cNvSpPr><a:spLocks noGrp="1"/></p:cNvSpPr><p:nvPr/></p:nvSpPr>' +
    `<p:spPr><a:xfrm><a:off x="${x}" y="${y}"/><a:ext cx="${cx}" cy="${cy}"/></a:xfrm>` +
    '<a:prstGeom prst="rect"><a:avLst/></a:prstGeom>' +
    `<a:solidFill><a:srgbClr val="${color}"/></a:solidFill>` +
    '<a:ln><a:noFill/></a:ln></p:spPr>' +
    '<p:txBody><a:bodyPr/><a:lstStyle/><a:p/></p:txBody></p:sp>'
  );
}

function pictureShape({ id, relId, x, y, cx, cy, name = 'Picture', description = '' }) {
  return (
    `<p:pic><p:nvPicPr><p:cNvPr id="${id}" name="${escapeXml(name)}" descr="${escapeXml(
      description,
    )}"/><p:cNvPicPr><a:picLocks noChangeAspect="1"/></p:cNvPicPr><p:nvPr/></p:nvPicPr>` +
    `<p:blipFill><a:blip r:embed="${relId}"/><a:stretch><a:fillRect/></a:stretch></p:blipFill>` +
    `<p:spPr><a:xfrm><a:off x="${x}" y="${y}"/><a:ext cx="${cx}" cy="${cy}"/></a:xfrm>` +
    '<a:prstGeom prst="rect"><a:avLst/></a:prstGeom></p:spPr></p:pic>'
  );
}

function slideXml(shapes) {
  return (
    XML_HEAD +
    `<p:sld xmlns:p="${NS_P}" xmlns:a="${NS_A}" xmlns:r="${NS_R}">` +
    '<p:cSld><p:spTree>' +
    '<p:nvGrpSpPr><p:cNvPr id="1" name=""/><p:cNvGrpSpPr/><p:nvPr/></p:nvGrpSpPr>' +
    '<p:grpSpPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="0" cy="0"/>' +
    '<a:chOff x="0" y="0"/><a:chExt cx="0" cy="0"/></a:xfrm></p:grpSpPr>' +
    shapes.join('') +
    '</p:spTree></p:cSld><p:clrMapOvr><a:masterClrMapping/></p:clrMapOvr></p:sld>'
  );
}

// ---- layouts -------------------------------------------------------------
// Four templates cover what a generated deck actually needs. Each returns
// { shapes, image } where `image` asks the packager for a picture part.

function coverSlide(slide, nextId) {
  const title = clip(cleanText(slide.title), TITLE_CHARS);
  const subtitle = clip(cleanText(slide.subtitle || slide.body || ''), 80);
  const shapes = [
    rectShape({
      id: nextId(),
      name: 'Accent',
      x: MARGIN_X,
      y: 1900000,
      cx: 685800,
      cy: 45720,
      color: slide.accent || '3B82F6',
    }),
    textShape({
      id: nextId(),
      name: 'Title',
      x: MARGIN_X,
      y: 2100000,
      cx: CONTENT_W,
      cy: 1500000,
      paragraphs: [paragraphXml(title, { pt: 4000, bold: true })],
    }),
  ];
  if (subtitle) {
    shapes.push(
      textShape({
        id: nextId(),
        name: 'Subtitle',
        x: MARGIN_X,
        y: 3600000,
        cx: CONTENT_W,
        cy: 900000,
        paragraphs: [paragraphXml(subtitle, { pt: 1800, color: '5B6470' })],
      }),
    );
  }
  return { shapes, image: null };
}

function sectionSlide(slide, nextId) {
  const title = clip(cleanText(slide.title), TITLE_CHARS);
  return {
    shapes: [
      rectShape({
        id: nextId(),
        name: 'Accent',
        x: MARGIN_X,
        y: 2700000,
        cx: 457200,
        cy: 45720,
        color: slide.accent || '3B82F6',
      }),
      textShape({
        id: nextId(),
        name: 'Title',
        x: MARGIN_X,
        y: 2850000,
        cx: CONTENT_W,
        cy: 1400000,
        paragraphs: [paragraphXml(title, { pt: 3600, bold: true })],
      }),
    ],
    image: null,
  };
}

function headingShapes(slide, nextId) {
  const title = clip(cleanText(slide.title), TITLE_CHARS);
  return [
    textShape({
      id: nextId(),
      name: 'Title',
      x: MARGIN_X,
      y: 500000,
      cx: CONTENT_W,
      cy: 900000,
      paragraphs: [paragraphXml(title, { pt: 2800, bold: true })],
    }),
    rectShape({
      id: nextId(),
      name: 'Rule',
      x: MARGIN_X,
      y: 1420000,
      cx: 914400,
      cy: 38100,
      color: slide.accent || '3B82F6',
    }),
  ];
}

function bulletParagraphs(items, pt) {
  return items.map((item) =>
    paragraphXml(`• ${item}`, { pt, spaceAfter: pt * 0.35 }),
  );
}

function bulletsSlide(slide, nextId) {
  const bodyY = 1700000;
  const bodyH = SLIDE_H - bodyY - 600000;
  const fit = fitBullets(slide.bullets || slide.body, { height: bodyH });
  const shapes = [...headingShapes(slide, nextId)];
  if (fit.items.length) {
    shapes.push(
      textShape({
        id: nextId(),
        name: 'Body',
        x: MARGIN_X,
        y: bodyY,
        cx: CONTENT_W,
        cy: bodyH,
        paragraphs: bulletParagraphs(fit.items, fit.pt),
      }),
    );
  }
  return { shapes, image: null, overflow: fit.overflow, report: fit };
}

function imageSlide(slide, nextId, source) {
  const boxW = 4700000;
  const boxH = 4000000;
  const textW = CONTENT_W - boxW - 400000;
  const bodyY = 1700000;
  const bodyH = SLIDE_H - bodyY - 600000;
  const fit = fitBullets(slide.bullets || slide.body, { width: textW, height: bodyH });
  const shapes = [...headingShapes(slide, nextId)];
  if (fit.items.length) {
    shapes.push(
      textShape({
        id: nextId(),
        name: 'Body',
        x: MARGIN_X,
        y: bodyY,
        cx: textW,
        cy: bodyH,
        paragraphs: bulletParagraphs(fit.items, fit.pt),
      }),
    );
  }
  return {
    shapes,
    // The picture is appended by the packager, which knows the rel id and can
    // measure the real bitmap.
    image: {
      box: { x: MARGIN_X + textW + 400000, y: (SLIDE_H - boxH) / 2, cx: boxW, cy: boxH },
      id: nextId(),
    },
    source,
    overflow: fit.overflow,
    report: fit,
  };
}

// The bitmap already contains the title and bullets. Fit it inside the
// whole slide so those elements stay visible and keep their proportions.
function rasterSlide(nextId, source) {
  return {
    shapes: [],
    image: { box: { x: 0, y: 0, cx: SLIDE_W, cy: SLIDE_H }, id: nextId() },
    source,
    report: { overflow: false, clipped: 0, dropped: 0 },
  };
}

const LAYOUTS = {
  cover: coverSlide,
  section: sectionSlide,
  bullets: bulletsSlide,
  image: imageSlide,
};

export const PPTX_LAYOUTS = [...Object.keys(LAYOUTS), 'fullbleed'];

function buildSlide(slide, nextId) {
  if (slide.layout === 'fullbleed') {
    return { kind: 'fullbleed', ...rasterSlide(nextId, slide.image) };
  }
  const kind = LAYOUTS[slide.layout] ? slide.layout : 'bullets';
  return { kind, ...LAYOUTS[kind](slide, nextId, slide.image) };
}

// ---- package -------------------------------------------------------------

function contentTypesXml(slideCount, media) {
  const overrides = [
    '<Override PartName="/ppt/presentation.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.presentation.main+xml"/>',
    '<Override PartName="/ppt/slideMasters/slideMaster1.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.slideMaster+xml"/>',
    '<Override PartName="/ppt/slideLayouts/slideLayout1.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.slideLayout+xml"/>',
    '<Override PartName="/ppt/theme/theme1.xml" ContentType="application/vnd.openxmlformats-officedocument.theme+xml"/>',
    '<Override PartName="/docProps/core.xml" ContentType="application/vnd.openxmlformats-package.core-properties+xml"/>',
    ...Array.from(
      { length: slideCount },
      (_, index) =>
        `<Override PartName="/ppt/slides/slide${index + 1}.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.slide+xml"/>`,
    ),
  ];
  const defaults = [
    '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>',
    '<Default Extension="xml" ContentType="application/xml"/>',
  ];
  const seen = new Set();
  for (const item of media) {
    if (seen.has(item.ext)) continue;
    seen.add(item.ext);
    defaults.push(
      `<Default Extension="${item.ext}" ContentType="${item.contentType}"/>`,
    );
  }
  return `${XML_HEAD}<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">${defaults.join(
    '',
  )}${overrides.join('')}</Types>`;
}

function presentationXml(slides) {
  const ids = slides
    .map((_, index) => `<p:sldId id="${256 + index}" r:id="rId${index + 2}"/>`)
    .join('');
  return (
    XML_HEAD +
    `<p:presentation xmlns:p="${NS_P}" xmlns:a="${NS_A}" xmlns:r="${NS_R}" saveSubsetFonts="1">` +
    '<p:sldMasterIdLst><p:sldMasterId id="2147483648" r:id="rId1"/></p:sldMasterIdLst>' +
    `<p:sldIdLst>${ids}</p:sldIdLst>` +
    `<p:sldSz cx="${SLIDE_W}" cy="${SLIDE_H}"/>` +
    '<p:notesSz cx="6858000" cy="9144000"/>' +
    '</p:presentation>'
  );
}

function presentationRelsXml(slides) {
  const slideRels = slides
    .map(
      (_, index) =>
        `<Relationship Id="rId${index + 2}" Type="${SLIDE_REL_LAYOUT.replace(
          'slideLayout',
          'slide',
        )}" Target="slides/slide${index + 1}.xml"/>`,
    )
    .join('');
  return (
    XML_HEAD +
    '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">' +
    `<Relationship Id="rId1" Type="${SLIDE_REL_LAYOUT.replace('slideLayout', 'slideMaster')}" Target="slideMasters/slideMaster1.xml"/>` +
    slideRels +
    `<Relationship Id="rId${slides.length + 2}" Type="${SLIDE_REL_LAYOUT.replace(
      'slideLayout',
      'theme',
    )}" Target="theme/theme1.xml"/>` +
    '</Relationships>'
  );
}

function slideRelsXml(imageRelId, mediaPath) {
  return (
    XML_HEAD +
    '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">' +
    `<Relationship Id="rId1" Type="${SLIDE_REL_LAYOUT}" Target="../slideLayouts/slideLayout1.xml"/>` +
    (imageRelId && mediaPath
      ? `<Relationship Id="${imageRelId}" Type="${REL_IMAGE}" Target="../${mediaPath}"/>`
      : '') +
    '</Relationships>'
  );
}

function emptyTreeXml() {
  return (
    '<p:nvGrpSpPr><p:cNvPr id="1" name=""/><p:cNvGrpSpPr/><p:nvPr/></p:nvGrpSpPr>' +
    '<p:grpSpPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="0" cy="0"/>' +
    '<a:chOff x="0" y="0"/><a:chExt cx="0" cy="0"/></a:xfrm></p:grpSpPr>'
  );
}

function masterXml() {
  return (
    XML_HEAD +
    `<p:sldMaster xmlns:p="${NS_P}" xmlns:a="${NS_A}" xmlns:r="${NS_R}">` +
    '<p:cSld><p:bg><p:bgRef idx="1001"><a:schemeClr val="bg1"/></p:bgRef></p:bg>' +
    `<p:spTree>${emptyTreeXml()}</p:spTree></p:cSld>` +
    '<p:clrMap bg1="lt1" tx1="dk1" bg2="lt2" tx2="dk2" accent1="accent1" accent2="accent2" accent3="accent3" accent4="accent4" accent5="accent5" accent6="accent6" hlink="hlink" folHlink="folHlink"/>' +
    '<p:sldLayoutIdLst><p:sldLayoutId id="2147483649" r:id="rId1"/></p:sldLayoutIdLst>' +
    '</p:sldMaster>'
  );
}

function masterRelsXml() {
  return (
    XML_HEAD +
    '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">' +
    `<Relationship Id="rId1" Type="${SLIDE_REL_LAYOUT}" Target="../slideLayouts/slideLayout1.xml"/>` +
    '<Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/theme" Target="../theme/theme1.xml"/>' +
    '</Relationships>'
  );
}

function layoutXml() {
  return (
    XML_HEAD +
    `<p:sldLayout xmlns:p="${NS_P}" xmlns:a="${NS_A}" xmlns:r="${NS_R}" type="blank" preserve="1">` +
    `<p:cSld name="Blank"><p:spTree>${emptyTreeXml()}</p:spTree></p:cSld>` +
    '<p:clrMapOvr><a:masterClrMapping/></p:clrMapOvr></p:sldLayout>'
  );
}

function layoutRelsXml() {
  return (
    XML_HEAD +
    '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">' +
    `<Relationship Id="rId1" Type="${SLIDE_REL_LAYOUT.replace(
      'slideLayout',
      'slideMaster',
    )}" Target="../slideMasters/slideMaster1.xml"/>` +
    '</Relationships>'
  );
}

function themeXml() {
  const color = (name, hex) => `<a:${name}><a:srgbClr val="${hex}"/></a:${name}>`;
  return (
    XML_HEAD +
    `<a:theme xmlns:a="${NS_A}" name="Luma"><a:themeElements>` +
    '<a:clrScheme name="Luma">' +
    color('dk1', '111111') +
    color('lt1', 'FFFFFF') +
    color('dk2', '1F2937') +
    color('lt2', 'F3F4F6') +
    color('accent1', '3B82F6') +
    color('accent2', '8B5CF6') +
    color('accent3', '10B981') +
    color('accent4', 'F59E0B') +
    color('accent5', 'EF4444') +
    color('accent6', '6366F1') +
    color('hlink', '2563EB') +
    color('folHlink', '7C3AED') +
    '</a:clrScheme>' +
    '<a:fontScheme name="Luma">' +
    '<a:majorFont><a:latin typeface="Aptos Display"/><a:ea typeface="Microsoft YaHei"/><a:cs typeface=""/></a:majorFont>' +
    '<a:minorFont><a:latin typeface="Aptos"/><a:ea typeface="Microsoft YaHei"/><a:cs typeface=""/></a:minorFont>' +
    '</a:fontScheme>' +
    '<a:fmtScheme name="Luma">' +
    '<a:fillStyleLst>' +
    '<a:solidFill><a:schemeClr val="phClr"/></a:solidFill>'.repeat(3) +
    '</a:fillStyleLst>' +
    '<a:lnStyleLst>' +
    '<a:ln w="6350"><a:solidFill><a:schemeClr val="phClr"/></a:solidFill></a:ln>' +
    '<a:ln w="12700"><a:solidFill><a:schemeClr val="phClr"/></a:solidFill></a:ln>' +
    '<a:ln w="19050"><a:solidFill><a:schemeClr val="phClr"/></a:solidFill></a:ln>' +
    '</a:lnStyleLst>' +
    '<a:effectStyleLst>' +
    '<a:effectStyle><a:effectLst/></a:effectStyle>'.repeat(3) +
    '</a:effectStyleLst>' +
    '<a:bgFillStyleLst>' +
    '<a:solidFill><a:schemeClr val="phClr"/></a:solidFill>'.repeat(3) +
    '</a:bgFillStyleLst>' +
    '</a:fmtScheme></a:themeElements></a:theme>'
  );
}

function coreXml(title) {
  const created = new Date().toISOString();
  return (
    XML_HEAD +
    '<cp:coreProperties xmlns:cp="http://schemas.openxmlformats.org/package/2006/metadata/core-properties" ' +
    'xmlns:dc="http://purl.org/dc/elements/1.1/" xmlns:dcterms="http://purl.org/dc/terms/" ' +
    'xmlns:dcmitype="http://purl.org/dc/dcmitype/" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance">' +
    `<dc:title>${escapeXml(title)}</dc:title>` +
    `<dcterms:created xsi:type="dcterms:W3CDTF">${created}</dcterms:created>` +
    `<dcterms:modified xsi:type="dcterms:W3CDTF">${created}</dcterms:modified>` +
    '</cp:coreProperties>'
  );
}

function rootRelsXml() {
  return (
    XML_HEAD +
    '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">' +
    '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="ppt/presentation.xml"/>' +
    '<Relationship Id="rId2" Type="http://schemas.openxmlformats.org/package/2006/relationships/metadata/core-properties" Target="docProps/core.xml"/>' +
    '</Relationships>'
  );
}

function isPngBuffer(data) {
  return (
    Buffer.isBuffer(data) &&
    data.length > 8 &&
    data[0] === 0x89 &&
    data[1] === 0x50 &&
    data[2] === 0x4e &&
    data[3] === 0x47
  );
}

function mediaEntry(block, index) {
  // Trust the bytes over the label: the office part name and content type must
  // match the actual encoding or PowerPoint shows an empty placeholder.
  const png = isPngBuffer(block.data);
  const ext = png ? 'png' : 'jpeg';
  return {
    name: `image${index + 1}.${ext}`,
    ext,
    contentType: png ? 'image/png' : 'image/jpeg',
    data: block.data,
  };
}

/**
 * Builds a PowerPoint-compatible .pptx from page-level input.
 *
 * Each slide is one of the four templates in `PPTX_LAYOUTS`; text is measured
 * and shrunk before it is written, because PowerPoint never reports overflow
 * itself. Returns the archive plus a small report so callers can tell whether
 * content had to be trimmed.
 */
export function buildPptx({ title, slides, meta }) {
  const source = Array.isArray(slides) ? slides.filter(Boolean) : [];
  if (!source.length) throw new Error('PPT 至少需要一页内容');

  let counter = 1;
  const nextId = () => (counter += 1);
  const prepared = source.map((slide) => buildSlide(slide, nextId));

  const media = [];
  const trimmed = [];
  const slideFiles = [];

  prepared.forEach((slide, index) => {
    let imageRelId = null;
    let mediaPath = null;
    if (slide.image && slide.source && slide.source.data) {
      const entry = mediaEntry(slide.source, media.length);
      media.push(entry);
      imageRelId = 'rId2';
      mediaPath = `media/${entry.name}`;
      const box = slide.image.box;
      const { cx, cy } = fitImage(slide.source.width, slide.source.height, box.cx, box.cy);
      slide.shapes.push(
        pictureShape({
          id: slide.image.id,
          relId: imageRelId,
          name: `Picture ${index + 1}`,
          description: clip(slide.source.caption || '', 120),
          x: box.x + Math.round((box.cx - cx) / 2),
          y: box.y + Math.round((box.cy - cy) / 2),
          cx,
          cy,
        }),
      );
    }
    // Any loss — dropped or truncated bullets — is reported by slide number so
    // the caller can tell the user what did not fit.
    if (slide.report && (slide.report.overflow || slide.report.clipped || slide.report.dropped)) {
      trimmed.push(index + 1);
    }
    slideFiles.push({ xml: slideXml(slide.shapes), imageRelId, mediaPath });
  });

  const files = [
    { name: '[Content_Types].xml', data: contentTypesXml(slideFiles.length, media) },
    { name: '_rels/.rels', data: rootRelsXml() },
    { name: 'docProps/core.xml', data: coreXml(title || '演示文稿') },
    { name: 'ppt/presentation.xml', data: presentationXml(slideFiles) },
    { name: 'ppt/_rels/presentation.xml.rels', data: presentationRelsXml(slideFiles) },
    { name: 'ppt/slideMasters/slideMaster1.xml', data: masterXml() },
    { name: 'ppt/slideMasters/_rels/slideMaster1.xml.rels', data: masterRelsXml() },
    { name: 'ppt/slideLayouts/slideLayout1.xml', data: layoutXml() },
    { name: 'ppt/slideLayouts/_rels/slideLayout1.xml.rels', data: layoutRelsXml() },
    { name: 'ppt/theme/theme1.xml', data: themeXml() },
    ...slideFiles.flatMap((slide, index) => [
      { name: `ppt/slides/slide${index + 1}.xml`, data: slide.xml },
      {
        name: `ppt/slides/_rels/slide${index + 1}.xml.rels`,
        data: slideRelsXml(slide.imageRelId, slide.mediaPath),
      },
    ]),
    ...media.map((item) => ({
      name: `ppt/media/${item.name}`,
      data: item.data,
      compress: false,
    })),
  ];

  return {
    buffer: createZip(files),
    slideCount: slideFiles.length,
    imageCount: media.length,
    // Slide numbers whose bullets had to be dropped to stay inside the frame.
    trimmed,
    meta: meta || '',
  };
}