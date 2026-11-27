import assert from 'node:assert/strict';
import test from 'node:test';
import { buildPptx, fitBullets, fitImage, PPTX_LAYOUTS } from '../src/media/pptx.js';
import {
  buildFallbackPptxPlan,
  parsePptxPlan,
  pptxPreview,
  toPptxSlides,
  toRasterSlides,
} from '../src/domain/pptx.js';
import {
  buildSlideImagePrompt,
  deckSlideFacts,
  verifySlideText,
} from '../src/media/slide-renderer.js';
import { openZip } from '../src/media/zip-reader.js';

const PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Wl2n0kAAAAASUVORK5CYII=',
  'base64',
);

function deckSlides() {
  return [
    { layout: 'cover', title: '季度复盘', subtitle: '2026 Q4 · 产品与技术' },
    { layout: 'section', title: '第一部分 关键进展' },
    { layout: 'bullets', title: '关键进展', bullets: ['新增工作目录能力', '文档生成支持'] },
    {
      layout: 'image',
      title: '架构图',
      bullets: ['前端 Vue3', '后端 Node'],
      image: { data: PNG, width: 800, height: 600, caption: '架构示意' },
    },
  ];
}

test('every XML part of the package is well-formed and every slide is reachable', () => {
  const { buffer, slideCount } = buildPptx({ title: '季度复盘', slides: deckSlides() });
  const zip = openZip(buffer);
  const names = zip.names();

  assert.equal(slideCount, 4);
  for (const name of names) {
    if (!/\.(xml|rels)$/.test(name)) continue;
    const text = zip.readText(name);
    assert.ok(text && text.trim(), `${name} is empty`);
  }

  // The relationship graph is what makes the deck open: presentation → slides,
  // and each slide → its layout. A missing rel shows up as a repair prompt.
  const presentation = zip.readText('ppt/presentation.xml');
  const presentationRels = zip.readText('ppt/_rels/presentation.xml.rels');
  for (let index = 1; index <= slideCount; index += 1) {
    assert.match(zip.names().join('\n'), new RegExp(`ppt/slides/slide${index}\\.xml`));
    assert.ok(
      presentation.includes(`r:id="rId${index + 1}"`),
      `presentation.xml must reference slide ${index}`,
    );
    assert.ok(
      presentationRels.includes(`Target="slides/slide${index}.xml"`),
      `presentation rels must target slide ${index}`,
    );
    assert.ok(
      zip.readText(`ppt/slides/_rels/slide${index}.xml.rels`).includes('slideLayout1.xml'),
      `slide ${index} must point at a layout`,
    );
  }

  const contentTypes = zip.readText('[Content_Types].xml');
  assert.ok(contentTypes.includes('presentationml.presentation.main+xml'));
  assert.ok(contentTypes.includes('presentationml.slideMaster+xml'));
  assert.ok(contentTypes.includes('theme+xml'));
});

test('slide text, bullets and picture all land in the package', () => {
  const { buffer, imageCount } = buildPptx({ title: '复盘', slides: deckSlides() });
  const zip = openZip(buffer);

  assert.equal(imageCount, 1);
  assert.match(zip.readText('ppt/slides/slide1.xml'), /季度复盘/);
  assert.match(zip.readText('ppt/slides/slide1.xml'), /2026 Q4/);
  assert.match(zip.readText('ppt/slides/slide3.xml'), /新增工作目录能力/);

  const imageSlide = zip.readText('ppt/slides/slide4.xml');
  assert.ok(imageSlide.includes('<p:pic>'), 'the picture is a real picture shape');
  assert.ok(imageSlide.includes('r:embed="rId2"'), 'the picture references its rel');
  // The fixture is a PNG, so the part and content type must both say PNG even
  // if a caller labelled it otherwise.
  assert.ok(
    /media\/image1\.(png|jpeg)/.test(zip.readText('ppt/slides/_rels/slide4.xml.rels')),
    'the slide rels point at the media part',
  );
  assert.ok(zip.names().includes('ppt/media/image1.png'));
  assert.match(zip.readText('ppt/slides/slide4.xml'), /r:embed="rId2"/);
});

test('paragraph spacing stays inside the DrawingML range', () => {
  const { buffer } = buildPptx({
    title: 't',
    slides: [{ layout: 'bullets', title: 't', bullets: ['一', '二'] }],
  });
  const xml = openZip(buffer).readText('ppt/slides/slide1.xml');

  // sz is in hundredths of a point and spcPts is too, so the gap is always
  // 0.35 × the chosen size. A second ×100 here once produced 63000 (630pt),
  // which is far outside what PowerPoint accepts and pushes text off the slide.
  const gaps = [...xml.matchAll(/<a:spcPts val="(\d+)"\/>/g)].map((m) => Number(m[1]));
  assert.ok(gaps.length > 0, 'bullets carry spacing');
  const sizes = [...xml.matchAll(/sz="(\d+)"/g)].map((m) => Number(m[1]));
  const bodySize = Math.min(...sizes);
  for (const gap of gaps) {
    assert.equal(gap, Math.round(bodySize * 0.35), 'gap follows the body size');
    assert.ok(gap <= 20116800, 'must stay inside the schema range');
  }
  assert.ok(bodySize >= 1200 && bodySize <= 2400, 'body stays inside the readable band');
});

test('text is escaped so markup in content cannot corrupt the file', () => {
  const { buffer } = buildPptx({
    title: 'A & B <tag>',
    slides: [{ layout: 'bullets', title: '<script>alert(1)</script>', bullets: ['a < b & c > d'] }],
  });
  const xml = openZip(buffer).readText('ppt/slides/slide1.xml');
  assert.ok(!xml.includes('<script>'), 'raw tags must not survive');
  assert.match(xml, /&lt;script&gt;/);
  assert.match(xml, /a &lt; b &amp; c &gt; d/);

  const core = openZip(buffer).readText('docProps/core.xml');
  assert.match(core, /A &amp; B &lt;tag&gt;/);
});

test('oversized decks shrink type first, then trim bullets and report it', () => {
  const roomy = fitBullets(['短句'], { height: 4000000 });
  assert.equal(roomy.overflow, false);
  assert.ok(roomy.pt > 1800, 'short content grows into the empty canvas');
  assert.ok(roomy.pt <= 2400, 'growth is capped so the title stays dominant');

  const long = Array.from({ length: 6 }, () => '这是一条很长的要点'.repeat(12));
  const tight = fitBullets(long, { height: 1200000 });
  assert.ok(tight.pt < 1800, 'type shrinks before content is dropped');
  assert.ok(tight.items.length <= 6, 'bullet count stays bounded');

  const impossible = fitBullets(long, { height: 200000 });
  assert.equal(impossible.overflow, true);
  assert.ok(impossible.dropped > 0, 'bullets beyond what fits are counted as dropped');
  assert.ok(impossible.items.length >= 1, 'at least one bullet survives');
  assert.ok(impossible.pt >= 1200, 'type never goes below the readable floor');

  // The report surfaces which slides lost content so the caller can warn.
  const { trimmed } = buildPptx({
    title: 't',
    slides: [
      { layout: 'cover', title: '封面' },
      { layout: 'bullets', title: 't', bullets: long },
    ],
  });
  assert.deepEqual(trimmed, [2], 'only the crowded slide is reported');
});

test('images keep their aspect ratio inside the slot', () => {
  const wide = fitImage(1600, 400, 4000000, 4000000);
  assert.equal(wide.cx, 4000000);
  assert.equal(wide.cy, 1000000);

  const tall = fitImage(400, 1600, 4000000, 2000000);
  assert.equal(tall.cy, 2000000);
  assert.equal(tall.cx, 500000);

  assert.deepEqual(fitImage(0, 0, 1000, 500), { cx: 1000, cy: 500 }, 'unknown size fills the box');
});

test('control characters and lone surrogates are stripped before they break XML', () => {
  const { buffer } = buildPptx({
    title: 'ok',
    slides: [{ layout: 'bullets', title: 'a\u0001b\uD800c', bullets: ['x\u0002y'] }],
  });
  const xml = openZip(buffer).readText('ppt/slides/slide1.xml');
  assert.ok(!/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/.test(xml));
  assert.ok(!/[\uD800-\uDFFF]/.test(xml));
  assert.match(xml, /abc/);
});

test('no text frame is ever emitted without a paragraph', () => {
  // DrawingML requires every <p:txBody> to hold at least one <a:p>. A title-only
  // image slide (or a bullets slide with nothing to list) used to produce an
  // empty Body frame, which PowerPoint reports as needing repair.
  const { buffer } = buildPptx({
    title: 't',
    slides: [
      { layout: 'image', title: '只有标题', bullets: [], image: { data: PNG, width: 8, height: 6 } },
      { layout: 'bullets', title: '无要点' },
      { layout: 'bullets', title: '只有标题没有正文', bullets: [] },
    ],
  });
  const zip = openZip(buffer);

  for (let index = 1; index <= 3; index += 1) {
    const xml = zip.readText(`ppt/slides/slide${index}.xml`);
    const bodies = xml.match(/<p:txBody>[\s\S]*?<\/p:txBody>/g) || [];
    assert.ok(bodies.length > 0, `slide ${index} has a title frame`);
    for (const body of bodies) {
      assert.match(body, /<a:p[ >\/]/, `slide ${index} body must contain a paragraph`);
    }
    // An empty bullet list must not reserve a blank Body frame either.
    assert.ok(
      !/<p:sp>\s*<p:nvSpPr>[\s\S]*?name="Body"[\s\S]*?<\/p:sp>/.test(xml),
      `slide ${index} must omit the Body frame when there are no bullets`,
    );
  }

  // The title itself must still be present on the title-only slide.
  assert.match(zip.readText('ppt/slides/slide1.xml'), /只有标题/);
});

test('an empty deck is rejected instead of shipping a broken file', () => {
  assert.throws(() => buildPptx({ title: 'x', slides: [] }), /至少需要一页/);
  assert.throws(() => buildPptx({ title: 'x' }), /至少需要一页/);
});

test('unknown layouts fall back to bullets rather than throwing', () => {
  const { buffer, slideCount } = buildPptx({
    title: 'x',
    slides: [{ layout: 'nope', title: '标题', bullets: ['要点'] }],
  });
  assert.equal(slideCount, 1);
  assert.match(openZip(buffer).readText('ppt/slides/slide1.xml'), /要点/);
  assert.deepEqual(PPTX_LAYOUTS.slice().sort(), ['bullets', 'cover', 'fullbleed', 'image', 'section']);
});
test('the deck declares a background so renderers do not fall back to grey', () => {
  // Quick Look and other consumers paint their own canvas when the master has
  // no <p:bg>; the same deck then looked light grey instead of white.
  const { buffer } = buildPptx({
    title: 't',
    slides: [{ layout: 'cover', title: '封面' }],
  });
  const zip = openZip(buffer);
  const master = zip.readText('ppt/slideMasters/slideMaster1.xml');
  assert.match(master, /<p:bg>/, 'the master declares a background');
  assert.match(master, /<p:bgRef idx="1001">/, 'and references the theme background');
});

test('the deterministic fallback never quotes the user request as content', () => {
  const chat = {
    title: '锦江物流园项目汇报',
    messages: [
      { role: 'user', content: '帮我根据这些材料整理一份给甲方汇报的 PPT，讲 2026 年做了哪些、2027 年怎么规划' },
      { role: 'assistant', content: '2026 年一期主体封顶，总建筑面积 53,533.30㎡。2027 年计划二三期开工，投资 2.45 亿元。' },
    ],
  };
  const plan = buildFallbackPptxPlan(chat);
  const bullets = plan.slides.flatMap((slide) => slide.bullets || []);
  assert.ok(bullets.length > 0, 'the answer still produces content');
  for (const bullet of bullets) {
    assert.ok(!bullet.includes('帮我'), `the request leaked into a slide: ${bullet}`);
  }
  assert.ok(
    bullets.some((bullet) => bullet.includes('53,533.30')),
    'figures from the answer survive',
  );
});

test('duplicate pages are dropped instead of padding the deck', () => {
  const plan = parsePptxPlan(
    JSON.stringify({
      title: '锦江物流园项目汇报',
      slides: [
        { layout: 'cover', title: '锦江物流园项目汇报' },
        { layout: 'bullets', title: '三项决策需甲方明确', bullets: ['Q1 前确认总平面', '3 月前完成选型'] },
        { layout: 'bullets', title: '下一步：按节点推进', bullets: ['Q1 前确认总平面', '3 月前完成选型'] },
        { layout: 'bullets', title: '2027 年计划投资 2.45 亿元', bullets: ['土建 1.42 亿元'] },
      ],
    }),
  );
  assert.deepEqual(
    plan.slides.map((slide) => slide.title),
    ['锦江物流园项目汇报', '三项决策需甲方明确', '2027 年计划投资 2.45 亿元'],
    'the restated page is removed, the distinct one survives',
  );
});

test('a page that re-lists earlier bullets keeps only what is new', () => {
  // The closing "next steps" page a model writes after a decision page is the
  // real case: same items, new lead-in, plus one genuine conclusion.
  const plan = parsePptxPlan(
    JSON.stringify({
      title: '锦江物流园项目汇报',
      slides: [
        { layout: 'cover', title: '锦江物流园项目汇报' },
        {
          layout: 'bullets',
          title: '三项决策需甲方在关键节点前确认',
          bullets: ['Q1 前确认总平面与红线调整方案', '3 月前完成冷链库选型定标', '明确多式联运接口责任'],
        },
        {
          layout: 'bullets',
          title: '下一步：请甲方按节点确认',
          bullets: [
            '决策事项：Q1 前确认总平面与红线调整方案',
            '决策事项：3 月前完成冷链库选型定标',
            '决策事项：明确多式联运接口责任',
            '后果：任一延迟将影响 2027 年 3 月二期开工',
          ],
        },
      ],
    }),
  );
  const closing = plan.slides.at(-1);
  assert.deepEqual(
    closing.bullets,
    ['后果：任一延迟将影响 2027 年 3 月二期开工'],
    'the restated items are removed, the new consequence survives',
  );
});

test('a fully repeated page is dropped entirely', () => {
  const plan = parsePptxPlan(
    JSON.stringify({
      title: '汇报',
      slides: [
        { layout: 'cover', title: '汇报' },
        { layout: 'bullets', title: '决策事项', bullets: ['Q1 前确认总平面', '3 月前完成选型'] },
        { layout: 'bullets', title: '下一步', bullets: ['请甲方 Q1 前确认总平面', '请甲方 3 月前完成选型'] },
      ],
    }),
  );
  assert.equal(plan.slides.length, 2, 'the page with no new claim is removed');
});

test('a continuation that repeats a figure but adds content is untouched', () => {
  // Repeating 98.4% on the following page is continuity, not padding.
  const plan = parsePptxPlan(
    JSON.stringify({
      title: '汇报',
      slides: [
        { layout: 'cover', title: '汇报' },
        { layout: 'bullets', title: '2026 年投资完成率 98.4%', bullets: ['计划 1.82 亿元', '完成 1.79 亿元'] },
        { layout: 'bullets', title: '2027 年投资 2.45 亿元', bullets: ['土建 1.42 亿元', '设备购置 0.78 亿元', '信息化 0.25 亿元'] },
      ],
    }),
  );
  assert.equal(plan.slides.length, 3);
  assert.equal(plan.slides[2].bullets.length, 3, 'the full page is kept');
});

test('a page is never dropped for differing only in year or amount', () => {
  // A 2027 page restating 2026's sentences with new figures is the most
  // dangerous false positive: dropping it silently deletes the future plan.
  const plan = parsePptxPlan(
    JSON.stringify({
      title: '锦江物流园项目汇报',
      slides: [
        { layout: 'cover', title: '锦江物流园项目汇报' },
        {
          layout: 'bullets',
          title: '2026 年工作回顾',
          bullets: ['2026 年完成一期设备安装', '年度投资计划 1.45 亿元'],
        },
        {
          layout: 'bullets',
          title: '2027 年实施规划',
          bullets: ['2027 年完成一期设备安装', '年度投资计划 2.45 亿元'],
        },
      ],
    }),
  );
  assert.equal(plan.slides.length, 3, 'both years survive');
  assert.deepEqual(plan.slides[2].bullets, [
    '2027 年完成一期设备安装',
    '年度投资计划 2.45 亿元',
  ]);
});

test('a bullet that changes only a number or a status is kept', () => {
  const cases = [
    [['年度投资计划 1.45 亿元'], ['年度投资计划 2.45 亿元']],
    [['累计工期滞后 6 天'], ['累计工期滞后 16 天']],
    [['质量验收一次通过率 96%'], ['质量验收一次通过率 89.4%']],
    // 0.75 similarity: only the status guard separates "done" from "not done".
    [['一期主体结构已封顶'], ['一期主体结构未封顶']],
    [['验收一次通过'], ['验收一次未通过']],
    [['二期处于在建状态'], ['二期处于延期状态']],
  ];
  for (const [earlier, later] of cases) {
    const plan = parsePptxPlan(
      JSON.stringify({
        title: '汇报',
        slides: [
          { layout: 'cover', title: '汇报' },
          { layout: 'bullets', title: '前', bullets: earlier },
          { layout: 'bullets', title: '后', bullets: later },
        ],
      }),
    );
    assert.equal(
      plan.slides.length,
      3,
      `dropped a page whose only difference was a fact: ${later[0]}`,
    );
    assert.deepEqual(plan.slides[2].bullets, later);
  }
});

test('numbers are compared before similarity, so a year alone blocks deletion', () => {
  // Guard the guard: without the numeric check this pair scores above the
  // similarity threshold and the second page disappears.
  const plan = parsePptxPlan(
    JSON.stringify({
      title: '汇报',
      slides: [
        { layout: 'cover', title: '汇报' },
        { layout: 'bullets', title: '2026', bullets: ['2026 年完成一期设备安装'] },
        { layout: 'bullets', title: '2027', bullets: ['2027 年完成一期设备安装'] },
      ],
    }),
  );
  assert.equal(plan.slides.length, 3);
});

test('slide verification compares whole numeric tokens, not substrings', () => {
  // "6天" occurs inside "16天"; a substring test would accept a page whose
  // figure silently changed from 6 days to 16 days.
  const facts = ['6天', '98.4%', '1.79亿元'];
  const wrong = verifySlideText('累计工期滞后16天，完成率98.4%，完成1.79亿元', facts);
  assert.equal(wrong.ok, false, '16天 must not satisfy 6天');
  assert.deepEqual(wrong.missing, ['6天']);

  const right = verifySlideText('累计工期滞后6天，完成率98.4%，完成1.79亿元', facts);
  assert.equal(right.ok, true);

  // A wrong percentage or amount is caught the same way.
  assert.deepEqual(verifySlideText('完成率89.4%', ['98.4%']).missing, ['98.4%']);
  assert.deepEqual(verifySlideText('完成2.45亿元', ['1.79亿元']).missing, ['1.79亿元']);
});

test('a cover subtitle is part of the page the model must letter', () => {
  const slide = { layout: 'cover', title: '锦江物流园', subtitle: '2026 成果与 2027 规划' };
  const prompt = buildSlideImagePrompt(slide);
  assert.match(prompt, /2026 成果与 2027 规划/, 'the subtitle is sent to the model');
  // And it is verified like any other figure quoted on the page.
  assert.ok(deckSlideFacts(slide).length === 2, 'both years are facts to check');
});

test('the same unit written differently is not a verification failure', () => {
  // A correct page was rejected because the model lettered ㎡ and OCR read m².
  const facts = deckSlideFacts({
    title: '二期 3 月开工',
    bullets: ['二期建筑面积 32,000㎡', '多式联运场站规划 12 个泊位', '年度计划投资 2.45 亿元'],
  });
  // The title's own figure is a fact too, so the page text includes it.
  for (const written of ['32,000㎡', '32,000 m²', '32,000m2', '32,000平方米', '32000㎡', '32,000mi']) {
    const result = verifySlideText(`二期 3 月开工 ${written} 12 个 2.45 亿元`, facts);
    assert.equal(result.ok, true, `rejected an equivalent rendering: ${written}`);
  }
});

test('unit normalisation does not soften the figure itself', () => {
  assert.equal(verifySlideText('滞后 16 天', ['6天']).ok, false, '16天 is not 6天');
  assert.equal(verifySlideText('计划 2.45 亿元', ['1.45亿元']).ok, false);
  assert.equal(verifySlideText('完成率 89.4%', ['98.4%']).ok, false);
  // A dot is a decimal point, never grouping: 32.000㎡ is 32 ㎡, not 32000 ㎡.
  assert.equal(verifySlideText('32.000㎡', ['32,000㎡']).ok, false);
  // A comma is grouping, and only in well-formed 3-digit groups.
  assert.equal(verifySlideText('32,000㎡', ['32000㎡']).ok, true);
  assert.equal(verifySlideText('12,34㎡', ['1234㎡']).ok, false);
});

test('a decimal point is never read as a thousands separator', () => {
  // 1.234亿元 is about 1.23 亿; 1234亿元 is a thousand times larger. They must
  // never compare equal, or a page stating the wrong order of magnitude passes.
  assert.equal(verifySlideText('1.234亿元', ['1234亿元']).ok, false);
  assert.equal(verifySlideText('1234亿元', ['1.234亿元']).ok, false);
  assert.equal(verifySlideText('1.234亿元', ['1.234亿元']).ok, true);
  // Real grouping still normalises.
  assert.equal(verifySlideText('1,234,567元', ['1234567元']).ok, true);
});

test('the area glyph survives the OCR confusion it actually produced', () => {
  // Measured on a real page: Vision read the fused ㎡ as "mi". The prompt now
  // asks for 平方米, but an older or stubborn render can still emit the glyph,
  // so the equivalent spellings are treated as the same area.
  const facts = deckSlideFacts({
    title: '二期 32,000 平方米 3 月开工、10 月封顶',
    bullets: ['二期建筑面积 32,000 平方米', '多式联运场站规划 12 个泊位', '2027 年度计划投资 2.45 亿元'],
  });
  const ocr = [
    '二期32,000mi3月开工、10月封顶',
    '二期建筑面积 32,000m2，3月开工',
    '多式联运场站规划12个泊位',
    '2027年度计划投资2.45亿元',
  ].join('\n');
  const result = verifySlideText(ocr, facts);
  assert.equal(result.ok, true);
  assert.deepEqual(result.missing, []);
});

test('a bare "m" is never promoted to an area', () => {
  // The same deck states 16.00m road widths. A token-level comparison cannot
  // tell a lost ㎡ from a length, so it must not guess: this page fails
  // verification and falls back to the editable layout instead.
  assert.equal(verifySlideText('建筑面积 32,000m', ['32000㎡']).ok, false);
  assert.equal(verifySlideText('宽 16.00㎡', ['16.00m']).ok, false);
});

test('the prompt asks for the unit in words, not a fused glyph', () => {
  const prompt = buildSlideImagePrompt({ layout: 'bullets', title: '面积', bullets: ['32,000㎡'] });
  assert.match(prompt, /写成「平方米」/, 'the model is told to avoid ㎡');
});

test('a road width is never mistaken for an area', () => {
  // 16.00m is a length on a site plan; aliasing every bare m to ㎡ would let a
  // page that changed 16.00m to 16.00㎡ pass as verified.
  for (const fact of ['16.00m', '6.00m', '23.66m', '4.00m']) {
    assert.equal(verifySlideText(`主环路宽 ${fact} 贯通`, [fact]).ok, true);
  }
  assert.equal(verifySlideText('主环路宽 16.00㎡ 贯通', ['16.00m']).ok, false);
});

test('a page that fails to render keeps the picture the planner picked', () => {
  // An `image` page has a resolved bitmap in imagesById; if that page fails
  // rasterisation it must fall back to the composed slide, not to a bare
  // imageId that no longer points at anything the packager can embed.
  const plan = {
    slides: [
      { layout: 'cover', title: '汇报' },
      { layout: 'image', title: '整体架构', bullets: ['前端 Vue3'], imageId: 'abc123' },
    ],
  };
  const png = PNG;
  const fallback = toPptxSlides(plan, new Map([['abc123', { data: png, width: 8, height: 6, caption: '架构' }]]));
  const rendered = [{ index: 0, buffer: png, width: 1, height: 1 }, { index: 1, buffer: null }];
  const slides = toRasterSlides(plan, rendered, fallback);

  assert.equal(slides[1].layout, 'image', 'the authored image layout survives');
  assert.ok(slides[1].image?.data, 'and it still carries the actual bitmap');
  assert.equal(slides[1].image.width, 8, 'with the measured dimensions intact');
  // Without the fallback base the raw plan slide would be returned instead,
  // and the packager would find no image data to embed.
  const withoutBase = toRasterSlides(plan, rendered);
  assert.equal(withoutBase[1].image, undefined, 'the raw plan slide has no bitmap');
  assert.equal(withoutBase[1].imageId, 'abc123', 'only an id, which cannot be embedded');
});

test('a rasterised page keeps its outline for the preview', () => {
  const plan = {
    slides: [{ layout: 'bullets', title: '2026 成果', bullets: ['投资完成率 98.4%', '验收通过率 96%'] }],
  };
  const slides = toRasterSlides(plan, [{ index: 0, buffer: PNG, width: 1, height: 1 }]);
  assert.equal(slides[0].layout, 'fullbleed');
  assert.deepEqual(slides[0].bullets, ['投资完成率 98.4%', '验收通过率 96%']);

  // The in-app preview reads that outline, so a drawn page is not a blank card.
  const preview = pptxPreview({ slides });
  assert.equal(preview[0].layout, 'fullbleed');
  assert.equal(preview[0].bullets.length, 2);
  assert.match(preview[0].bullets[0], /98\.4%/);
});

test('figures are verified in reading order, so a plan/actual swap fails', () => {
  // The two figures are identical as a set; only their order distinguishes
  // "planned 1.82, actual 1.79" from the false "planned 1.79, actual 1.82".
  const slide = { title: '投资执行', bullets: ['年度计划投资 1.82 亿元，实际完成 1.79 亿元'] };
  const facts = deckSlideFacts(slide);
  assert.deepEqual(facts, ['1.82亿元', '1.79亿元']);

  const correct = verifySlideText('投资执行\n年度计划投资 1.82 亿元，实际完成 1.79 亿元', facts);
  assert.equal(correct.ok, true);

  const swapped = verifySlideText('投资执行\n年度计划投资 1.79 亿元，实际完成 1.82 亿元', facts);
  assert.equal(swapped.ok, false, 'a swapped plan/actual pair must not verify');
  assert.equal(swapped.outOfOrder, true);
  assert.deepEqual(swapped.missing, [], 'both figures are present, only the order is wrong');
});

test('a leading sign is part of the claim', () => {
  const facts = deckSlideFacts({ title: '工期', bullets: ['累计滞后 -6 天'] });
  assert.deepEqual(facts, ['-6天']);
  assert.equal(verifySlideText('累计滞后 -6 天', facts).ok, true);
  // Dropping the minus reads as a gain rather than a slip.
  assert.equal(verifySlideText('累计滞后 6 天', facts).ok, false);
});

test('order checking tolerates repeats without letting a swap through', () => {
  // The title and first bullet quote the same figure; OCR may letter it twice.
  const facts = deckSlideFacts({
    title: '完成率 98.4%',
    bullets: ['完成率 98.4%，完成 1.79 亿元'],
  });
  assert.equal(verifySlideText('98.4% 完成率 98.4% 完成 1.79 亿元', facts).ok, true);
  // A repeat does not license reordering the real sequence.
  assert.equal(verifySlideText('1.79 亿元 98.4%', facts).ok, false);
});
