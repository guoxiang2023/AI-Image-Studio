import sharp from 'sharp';
import {
  DOCUMENT_BRIEF_INPUT_CHARS,
  DOCUMENT_FINAL_IMAGES,
  DOCUMENT_MAX_IMAGES,
  DOCUMENT_PLAN_CHARS,
  DOCUMENT_SECTION_CHARS,
  DOCUMENT_TIMEOUT,
  documentTimeoutSeconds,
} from '../config.js';
import { chatCompletion } from '../ai/llm.js';
import {
  archiveDocumentImages,
  buildDocumentContextChunks,
  buildDocumentImagePlanMessages,
  buildDocumentIntroMessages,
  buildDocumentPlanMessages,
  buildDocumentSectionMessages,
  buildFallbackDocumentImagePlan,
  buildFallbackDocumentPlan,
  buildSectionTranscript,
  buildTranscript,
  buildDocumentUserGuidance,
  applySettledCorrections,
  collectDocumentImages,
  dedupeDocumentVoice,
  finalizeDocument,
  imageCaption,
  parseDocumentMarkdown,
  parseDocumentImagePlan,
  parseDocumentPlan,
  selectFinalDocumentImages,
} from '../domain/document.js';
import { findGalleryImage, listChatGalleryImages } from '../data/repositories/gallery.js';
import { findImageFile } from '../media/image-storage.js';
import { buildDocx } from '../media/docx.js';
import { buildPdf } from '../media/pdf.js';
import { buildPptx } from '../media/pptx.js';
import { needsImageRenderer, renderDeckImages } from '../media/slide-renderer.js';
import {
  buildFallbackPptxPlan,
  buildPptxMessages,
  parsePptxPlan,
  pptxImageCatalog,
  pptxPreview,
  salvagePptxPlan,
  toRasterSlides,
  toPptxSlides,
} from '../domain/pptx.js';
import { AppError } from '../shared/errors.js';
import { friendlyError, newId, withTimeout } from '../shared/utils.js';
import { loadChatForUser } from './chat-service.js';
import { loadSettings } from './model-settings-service.js';
import { recordLlmUsage } from './usage-service.js';
import { buildDocumentBrief } from './document-brief.js';
import { saveGeneratedDocument } from './document-library-service.js';
import { createDocumentRequest } from './document-request.js';
import { findDocument } from '../media/document-storage.js';

// The outline has room for detailed Chinese JSON without tying body length to
// one response. Each chapter gets its own completion budget.
const PLAN_MAX_TOKENS = 4096;
const INTRO_MAX_TOKENS = 1024;
const SECTION_MAX_TOKENS = 4096;
const MAX_CONTINUATIONS = 2;

async function rasterizeImage(file, { maxSize = 1600, quality = 88 } = {}) {
  try {
    const source = sharp(file.path, { failOn: 'none', animated: false });
    const meta = await source.metadata();
    if (!meta.width || !meta.height) return null;
    const { data, info } = await source
      .rotate()
      .resize({
        width: maxSize,
        height: maxSize,
        fit: 'inside',
        withoutEnlargement: true,
      })
      .flatten({ background: '#ffffff' })
      .jpeg({ quality, chromaSubsampling: '4:4:4' })
      .toBuffer({ resolveWithObject: true });
    if (!data.length || !info.width || !info.height) return null;
    return { data, width: info.width, height: info.height };
  } catch {
    return null;
  }
}

function safeFilename(title, ext = 'docx') {
  const name = String(title || '文档')
    .replace(/[\u0000-\u001F\u007F\u200E\u200F\u202A-\u202E]/g, ' ')
    .replace(/[\\/:*?"<>|\r\n\t]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 50)
    .replace(/[. ]+$/, '');
  return `${name || '文档'}.${ext}`;
}

/**
 * Builds the authoritative picture inventory of one session.
 *
 * Same-turn images and gallery rows are merged with the conversation record:
 * a document created in the turn that generated the pictures would otherwise
 * miss them, because the chat row it reloads has not been saved yet. The
 * gallery is read per session so another conversation's pictures never leak
 * into this document.
 *
 * The result is the raw material both the picker and the exporter agree on:
 * the caller decides which of these entries may be shown, cited inline, or
 * archived.
 */
async function enumerateSessionImages(user, chat, { turnImages = [] } = {}) {
  const galleryRows = listChatGalleryImages(user.id, chat.id);
  const galleryById = new Map(galleryRows.map((row) => [row.id, row]));
  const galleryImages = galleryRows.map((row) => ({
    id: row.id,
    prompt: row.prompt,
    caption: row.caption || '',
    size: row.size,
    aspectRatio: row.aspect_ratio,
    parentId: row.parent_id,
    createdAt: row.created_at,
  }));
  const collected = collectDocumentImages(chat, Number.MAX_SAFE_INTEGER, {
    turnImages,
    galleryImages,
  });
  const hiddenIds = [];
  const unavailableIds = [];
  const fileById = new Map();
  const enriched = [];

  for (const image of collected.images) {
    // A message can carry a picture recorded under another chat (an imported
    // session), so the per-id lookup only runs when this chat's rows do not
    // already answer it.
    const row = galleryById.get(image.id) || findGalleryImage(user.id, image.id);
    const hidden = Boolean(row?.hidden);
    if (hidden) hiddenIds.push(image.id);
    // A hidden picture is out of the document either way, so its file is not
    // probed: doing so would report a deleted picture the user chose to remove
    // as a missing-but-expected one, and leak its description into the export.
    if (!hidden) {
      const file = await findImageFile(user.id, image.id);
      if (file) fileById.set(image.id, file);
      else unavailableIds.push(image.id);
    }
    enriched.push({
      ...image,
      groupId: row?.group_id || image.groupId || null,
      favorite: Boolean(row?.favorite),
      createdAt: Number(row?.created_at) || image.createdAt || null,
    });
  }

  // The body gets the deliverable set (superseded drafts excluded) and is
  // bounded so the planner prompt stays small; the archive keeps every visible
  // picture, so an early version is never lost with it.
  return {
    entries: enriched,
    hiddenIds,
    unavailableIds,
    fileById,
    total: collected.total,
  };
}

const EXPORT_DRAFT_RE = /^\s*(?:请)?(?:就)?按(?:照)?(?:这|此|该|上面|上述)(?:份|版)?稿.{0,12}(?:生成|导出|输出|制作)/;

function approvedDraftPlan(chat) {
  let draft = '';
  let approved = '';
  for (const message of chat.messages || []) {
    if (message.role === 'assistant') draft = String(message.content || '');
    else if (message.role === 'user' && EXPORT_DRAFT_RE.test(message.content || '')) approved = draft;
  }
  const title = /^#[ \t]+(.+)$/m.exec(approved)?.[1]?.trim();
  if (!title) return null;
  const sections = [...approved.matchAll(/^##[ \t]+(?:§[ \t]*\d+\.?|第\s*\d+\s*章|\d+[.、)])[ \t]+([^\n]+)$/gm)]
    .map((match) => ({ heading: match[1].trim() }));
  if (sections.length < 2) return null;
  return { title, sections };
}

// Match figures in the approved draft to earlier caption/ID pairs. A draft
// can renumber its figures and omit IDs when prepared for Word.
function approvedDraftImages(chat, entries) {
  const catalog = new Map();
  const approved = new Map();
  const titleKey = (title) => title.replace(/\s+/g, '');
  const resolve = (prefix) => {
    const matches = entries.filter((image) => image.id.startsWith(prefix.toLowerCase()));
    return matches.length === 1 ? matches[0].id : null;
  };
  let draft = '';
  for (const message of chat.messages || []) {
    if (message.role === 'assistant') {
      draft = String(message.content || '');
      for (const match of draft.matchAll(/^[ \t]*(?:>[ \t]*)?(?:\*\*)?图[ \t]*\d+[-－–]\d+[ \t]+([^\n（(]+?)[ \t]*[（(]`([a-f0-9]{8,40})`/gim)) {
        const id = resolve(match[2]);
        if (id) catalog.set(titleKey(match[1]), id);
      }
      continue;
    }
    if (message.role !== 'user' || !EXPORT_DRAFT_RE.test(message.content || '')) continue;
    approved.clear();
    for (const match of draft.matchAll(/^[ \t]*\|[ \t]*图[ \t]*\d+[-－–]\d+[ \t]*\|[ \t]*([^|\n]+)\|/gm)) {
      const caption = match[1].trim();
      const id = catalog.get(titleKey(caption));
      if (id) approved.set(id, caption);
    }
    const opening = draft.trim().split(/\n\s*\n/, 1)[0];
    for (const match of opening.matchAll(/(?:已确认[：:]\s*|(?:使用|采用|选用|保留))[^。；，\n]{0,65}?`([a-f0-9]{8,40})`/gi)) {
      const id = resolve(match[1]);
      if (id && !approved.has(id)) approved.set(id, '');
    }
  }
  return approved;
}

async function curateFinalImages(user, chat, { turnImages = [], imageIds = null } = {}) {
  const { entries, hiddenIds, unavailableIds, fileById, total } =
    await enumerateSessionImages(user, chat, { turnImages });
  // An explicit pick replaces the curation heuristics entirely: the user, not
  // the planner or the edit chain, decides what this document is built from.
  // A selected id that is not in this session's visible set is an error rather
  // than a silent omission, because the picker and the report would otherwise
  // disagree about what was asked for.
  if (imageIds) {
    const wanted = new Set(imageIds);
    const eligible = archiveDocumentImages(entries, { hiddenIds, unavailableIds });
    const known = new Set(eligible.map((image) => image.id));
    const stale = imageIds.filter((id) => !known.has(id));
    if (stale.length) {
      throw new AppError(
        409,
        `以下图片已不可用，请重新选择：${stale.join('、')}`,
      );
    }
    const selected = eligible
      .filter((image) => wanted.has(image.id))
      // Generated image captions store the user's chat message. Use the image
      // source for the export fallback since the prompt can also repeat it.
      .map((image) => image.source === '生成图' ? { ...image, caption: image.source } : image);
    const selectedFiles = new Map();
    for (const image of selected) {
      const file = fileById.get(image.id);
      if (file) selectedFiles.set(image.id, file);
    }
    return {
      // The body planner prompt stays bounded, but nothing is lost: the
      // appendix below carries every selected picture the body did not cite.
      images: selected.slice(0, DOCUMENT_MAX_IMAGES),
      archive: selected,
      unavailable: [],
      fileById: selectedFiles,
      total,
    };
  }
  const approved = approvedDraftImages(chat, entries);
  for (const image of entries) {
    image.approved = approved.has(image.id);
    if (image.approved) image.approvedCaption = approved.get(image.id);
  }
  return {
    images: selectFinalDocumentImages(entries, {
      hiddenIds,
      unavailableIds,
      limit: DOCUMENT_MAX_IMAGES,
    }),
    archive: [],
    fileById,
    total,
  };
}

function documentLlm(llm, effort = '') {
  // Document subtasks are deliberately low-latency: hidden reasoning tokens
  // count against max_tokens. Planning and image selection use low effort and
  // tiny outputs; chapters are small enough to fit or continue.
  return { ...llm, reasoningEffort: effort, thinkingDisabled: true };
}

function responseText(response) {
  return String(response?.choices?.[0]?.message?.content || '').trim();
}

function responseFinish(response) {
  return response?.choices?.[0]?.finish_reason;
}

function recordUsage({ user, chat, turnId, llm, messages, response, text }) {
  if (!response) return;
  recordLlmUsage({
    userId: user.id,
    chatId: chat.id,
    turnId,
    kind: 'document',
    model: llm.model,
    providerId: llm.providerId,
    providerName: llm.providerName,
    usage: response.usage,
    messages,
    completionText: text,
  });
}


function unwrapMarkdown(text) {
  return String(text || '')
    .replace(/^```(?:markdown|md)?\s*\n([\s\S]*?)\n```$/i, '$1')
    .trim();
}

function normalizeIntro(text) {
  return unwrapMarkdown(text).replace(/^#\s+[^\n]+\n+/, '').trim();
}

function normalizeSection(text, heading) {
  const body = unwrapMarkdown(text).replace(/^#\s+[^\n]+(?:\n+|$)/, '')
    .replace(/^##\s+[^\n]+(?:\n+|$)/, '').trim();
  const blocks = parseDocumentMarkdown(body).blocks;
  return blocks.some(({ type }) => ['paragraph', 'table', 'bullets', 'quote'].includes(type))
    ? `## ${heading}\n\n${body}`
    : '';
}

async function completeSection(request, llm, messages, signal) {
  const options = { tools: false, maxTokens: SECTION_MAX_TOKENS, temperature: 0.4, signal };
  let response = await request('section', llm, messages, options);
  let text = responseText(response);
  let continuations = 0;
  while (
    responseFinish(response) === 'length' &&
    text &&
    continuations < MAX_CONTINUATIONS
  ) {
    const continuation = [
      ...messages,
      { role: 'assistant', content: text },
      {
        role: 'user',
        content:
          '继续写完当前章节，从断点直接续写，不要重复已经写过的内容，不要添加标题页、导语或其他章节。只输出续写正文。',
      },
    ];
    try {
      response = await request('section_continuation', llm, continuation, options);
    } catch (err) {
      if (signal?.aborted) throw err;
      return { text, incomplete: true };
    }
    const part = responseText(response);
    if (!part) return { text, incomplete: true };
    text = `${text}\n\n${part}`;
    continuations += 1;
  }
  const finish = responseFinish(response);
  return { text, incomplete: Boolean(finish && finish !== 'stop') };
}

/**
 * Builds a deck page by page. The plan is a list of slides rather than
 * chapters, and every image is embedded at the size its slot allows; a
 * planning failure degrades to a deterministic deck instead of an error.
 */
async function generateSessionDeck(
  user,
  chatId,
  { signal, visual = false, emit = () => {}, turnImages = [] } = {},
) {
  const chat = loadChatForUser(user.id, chatId);
  if (!chat) throw new AppError(404, '会话不存在');
  if (!Array.isArray(chat.messages) || !chat.messages.length) {
    throw new AppError(400, '当前会话还没有内容');
  }

  const models = loadSettings(user.id);
  if (!models.llm.apiKey) {
    throw new AppError(400, '请先在「模型设置」中配置对话模型 API Key');
  }

  const timeoutSignal = withTimeout(signal, DOCUMENT_TIMEOUT);
  const turnId = newId();
  const llm = documentLlm(models.llm, 'low');
  const transcript = buildTranscript(chat, DOCUMENT_PLAN_CHARS);

  // The same curation the document pipeline uses: hidden images, images
  // superseded by a later edit, and files that no longer exist are excluded
  // before the model is asked to pick one. The list is also what the renderer
  // is allowed to embed, so a hallucinated id cannot reach the archive.
  const { images: candidates, fileById } = await curateFinalImages(user, chat, { turnImages });
  const catalog = pptxImageCatalog(candidates);
  const imageIds = new Set(catalog.map((image) => image.id));

  let plan = null;
  // How the deck was planned: 'model' is a complete plan, 'salvaged' kept the
  // pages written before a cut-off, 'fallback' had no usable plan at all. The
  // difference matters because only the first one is a review-ready 终稿.
  let planStatus = 'model';
  try {
    const messages = buildPptxMessages({
      chat,
      transcript,
      targetSlides: 10,
      images: catalog,
    });
    const response = await chatCompletion(llm, messages, {
      tools: false,
      // Ten pages of Chinese JSON measures ~2.4k tokens, so the old 2048 cap
      // truncated a normal deck. A cut-off plan is now salvaged page by page
      // rather than discarded, and the larger budget makes that rare.
      maxTokens: 4096,
      temperature: 0.3,
      signal: timeoutSignal,
    });
    const text = responseText(response);
    recordUsage({ user, chat, turnId, llm, messages, response, text });
    plan = parsePptxPlan(text, { imageIds });
    if (!plan) {
      plan = salvagePptxPlan(text, { imageIds });
      if (plan) {
        planStatus = 'salvaged';
        console.warn(`PPT 策划被截断，已保留 ${plan.slides.length} 页完整内容`);
      }
    }
    if (!plan) console.warn('PPT 策划降级：使用确定性分页');
  } catch (err) {
    if (signal?.aborted || timeoutSignal.aborted) throw err;
    console.warn('PPT 策划降级:', err.message);
  }

  if (!plan) {
    plan = buildFallbackPptxPlan(chat);
    planStatus = 'fallback';
  }

  // Only pictures referenced by the plan are rasterized, and only files from
  // the curated candidate set are eligible — a re-check against the gallery is
  // deliberately absent so this cannot drift from the planner's allowlist.
  const imagesById = new Map();
  const wanted = new Set(
    (plan.slides || []).filter((slide) => slide.imageId).map((slide) => slide.imageId),
  );
  for (const id of wanted) {
    if (signal?.aborted) throw new Error('已取消');
    if (!imageIds.has(id)) continue;
    const file = fileById.get(id);
    if (!file) continue;
    const raster = await rasterizeImage(file);
    if (raster) imagesById.set(id, raster);
  }

  // Visual mode rasterises the finished plan page by page. Planning, wording
  // and figures still come from the same pipeline; only the drawing changes.
  // Pages that fail to render keep their authored text, so a deck is never
  // missing a page just because one picture did not come back.
  let rendered = [];
  let unrendered = [];
  if (visual) {
    if (!needsImageRenderer({ models })) {
      throw new AppError(400, '视觉稿需要先配置图片模型的 API Key');
    }
    const out = await renderDeckImages({ models, emit }, plan, {
      signal: timeoutSignal,
      quality: models.image.quality || undefined,
    });
    rendered = out.images;
    unrendered = out.failed;
    if (unrendered.length) {
      console.warn(`PPT 视觉稿有 ${unrendered.length} 页未渲染，已回退为文字版式`);
    }
  }

  // The resolved text slides are computed either way: a page that fails to
  // render falls back to its authored layout, and an `image` page keeps the
  // picture the planner picked rather than reverting to a bare id.
  const fallbackSlides = toPptxSlides(plan, imagesById);
  const slides = visual ? toRasterSlides(plan, rendered, fallbackSlides) : fallbackSlides;
  const result = buildPptx({ title: plan.title || chat.title, slides });
  if (result.trimmed.length) {
    console.warn(`PPT 内容压缩：第 ${result.trimmed.join('、')} 页文字过多，已自动精简`);
  }

  const date = new Intl.DateTimeFormat('zh-CN', {
    year: 'numeric',
    month: 'long',
    day: 'numeric',
  }).format(new Date());

  return {
    buffer: result.buffer,
    filename: safeFilename(plan.title || chat.title || '演示文稿', 'pptx'),
    format: 'pptx',
    title: plan.title || chat.title || '演示文稿',
    meta: planStatus === 'model' ? `终稿 · ${date}` : `初稿 · ${date}`,
    preview: pptxPreview({ slides }),
    images: result.imageCount,
    slideCount: result.slideCount,
    trimmed: result.trimmed,
    planStatus,
    // Which pages were drawn as images, and which fell back to text. The
    // caller reports the difference so a client deck is never mistaken for a
    // fully designed one.
    renderedPages: rendered.filter((page) => page.buffer).length,
    unrenderedPages: unrendered.map((page) => page.index + 1),
  };
}

export async function generateSessionDocument(
  user,
  chatId,
  { signal, format = 'docx', visual = false, includeImages = true, emit = () => {}, turnImages = [] } = {},
) {
  // A deck is planned page by page, not chapter by chapter: reusing the
  // document outline would produce pages holding paragraphs.
  if (format === 'pptx') {
    return generateSessionDeck(user, chatId, { signal, visual, emit, turnImages });
  }
  const chat = loadChatForUser(user.id, chatId);
  if (!chat) throw new AppError(404, '会话不存在');
  if (!Array.isArray(chat.messages) || !chat.messages.length) {
    throw new AppError(400, '当前会话还没有内容');
  }

  // One path only: the model pipeline. Every export is built from the whole
  // conversation — a summary, a planned outline, then each chapter written
  // against its own evidence. Rendering a single chat message instead would
  // hand back whatever the model happened to type in that turn, which is not
  // the same document and not what the reader expects.
  const models = loadSettings(user.id);
  if (!models.llm.apiKey) {
    throw new AppError(400, '请先在「模型设置」中配置对话模型 API Key');
  }
  return generateDocumentWithModel({ user, chat, models, signal, format, emit, turnImages, includeImages });
}

/**
 * Lists the pictures an explicit export may choose from.
 *
 * The list is the session's authoritative inventory — the same one the
 * automatic export curates — reduced to what can actually be embedded: hidden
 * pictures (removed from the gallery), pictures whose file is gone, and
 * pictures of other sessions are not offered. Order is generation order, so the
 * picker reads like the conversation.
 */
export async function listSessionDocumentImages(user, chat) {
  const { entries, hiddenIds, unavailableIds, fileById } = await enumerateSessionImages(
    user,
    chat,
  );
  return archiveDocumentImages(entries, { hiddenIds, unavailableIds }).map(
    (image) => ({
      id: image.id,
      url: `/files/${image.id}.${fileById.get(image.id)?.ext || 'png'}`,
      caption: imageCaption(image),
      source: image.source || '生成图',
      round: Number.isInteger(image.round) && image.round > 0 ? image.round : null,
    }),
  );
}

/**
 * Builds a Word/PDF document from a hand-picked set of this session's pictures.
 *
 * The picker uses the same outline and chapter writers as automatic export.
 * The selection is applied to both the body and the
 * appendix: a picked picture the writer never cites is still delivered, and a
 * picture the user left out cannot come back through a model reply, because
 * neither the planner nor the renderer is given any file it could use.
 * At least one picture must be selected.
 */
export async function generateSelectedDocument({
  user,
  chat,
  format = 'docx',
  imageIds,
  signal,
}) {
  if (!chat) throw new AppError(404, '会话不存在');
  if (!['docx', 'pdf'].includes(format)) {
    throw new AppError(400, '请选择 Word 或 PDF');
  }
  if (!Array.isArray(imageIds)) {
    throw new AppError(400, '图片列表格式不正确');
  }
  const selection = [...new Set(imageIds.map((id) => String(id || '').trim()))].filter(Boolean);
  if (!selection.length) {
    throw new AppError(400, '请至少勾选一张图片');
  }
  if (!Array.isArray(chat.messages) || !chat.messages.length) {
    throw new AppError(400, '当前会话还没有内容');
  }
  const models = loadSettings(user.id);
  if (!models.llm.apiKey) {
    throw new AppError(400, '请先在「模型设置」中配置对话模型 API Key');
  }
  const result = await generateDocumentWithModel({
    user,
    chat,
    models,
    signal,
    format,
    emit: () => {},
    // The picker lists persisted pictures only; a picture generated in a turn
    // that has not been written to the chat row is already in the gallery.
    turnImages: [],
    imageIds: selection,
  });
  const saved = await saveGeneratedDocument({
    userId: user.id,
    chatId: chat.id,
    title: result.title,
    filename: result.filename,
    format: result.format,
    buffer: result.buffer,
    imageCount: result.images,
    preview: result.preview,
  });
  return {
    document: {
      id: saved.id,
      chatId: saved.chatId,
      title: saved.title,
      filename: saved.filename,
      format: saved.format,
      size: saved.size,
      imageCount: saved.imageCount,
      bodyImageCount: result.bodyImages,
      appendixImageCount: result.archivedImages,
      createdAt: saved.createdAt,
      // A partial build is still saved and still downloadable; the reasons
      // belong with the file so the client can say why rather than imply a
      // clean final draft.
      ...(result.issues?.length ? { issues: result.issues } : {}),
    },
  };
}

async function restoreDocumentAttachments(userId, chat) {
  const originals = new Map();
  for (const message of chat.messages) {
    for (const attachment of message.attachments || []) {
      if (!attachment.truncated || !attachment.id) continue;
      if (!originals.has(attachment.id)) {
        const source = await findDocument(userId, attachment.id);
        originals.set(attachment.id, source?.text);
      }
      const text = originals.get(attachment.id);
      if (text) {
        attachment.text = text;
        attachment.truncated = false;
      }
    }
  }
}

async function generateDocumentWithModel({
  user,
  chat,
  models,
  signal,
  format,
  emit,
  turnImages = [],
  imageIds = null,
  includeImages = true,
}) {
  const {
    images: candidates,
    archive: explicitImages,
    fileById,
  } = includeImages
    ? await curateFinalImages(user, chat, { turnImages, imageIds })
    : { images: [], archive: [], fileById: new Map() };
  const request = createDocumentRequest({ user, chat, turnId: newId() });
  const planLlm = documentLlm(models.llm, 'low');
  const llm = documentLlm(models.llm);
  await restoreDocumentAttachments(user.id, chat);
  let plan = approvedDraftPlan(chat);
  const userGuidance = buildDocumentUserGuidance(chat);
  const issues = [];
  let planSource;
  if (plan) {
    planSource = plan.sections.map(({ heading }, index) => `${index + 1}. ${heading}`).join('\n');
  } else {
    const chunks = buildDocumentContextChunks(chat, DOCUMENT_BRIEF_INPUT_CHARS, { includeImages: false });
    const transcriptLength = chunks.reduce((sum, chunk, index) => sum + chunk.length + (index ? 2 : 0), 0);
    planSource = transcriptLength <= DOCUMENT_PLAN_CHARS ? chunks.join('\n\n') : '';
    if (transcriptLength > DOCUMENT_PLAN_CHARS) {
      const briefSignal = withTimeout(signal, documentTimeoutSeconds({ chunks: chunks.length }));
      try {
        const brief = await buildDocumentBrief(chunks, request, planLlm, briefSignal);
        planSource = brief.text;
        issues.push(...brief.issues);
      } catch (err) {
        if (signal?.aborted || !briefSignal.aborted) throw err;
        const half = Math.floor(DOCUMENT_PLAN_CHARS / 2) - 1;
        planSource = [chunks[0].slice(0, half), chunks.at(-1).slice(-half)].join('\n\n');
        issues.push('长会话摘要超时，大纲仅使用首尾原文和用户修订');
      }
    }
  }

  if (!plan) {
    try {
      const planMessages = buildDocumentPlanMessages({ chat, transcript: planSource, userGuidance });
      const planResponse = await request('plan', planLlm, planMessages, {
        tools: false,
        maxTokens: PLAN_MAX_TOKENS,
        temperature: 0.2,
        signal: withTimeout(signal, DOCUMENT_TIMEOUT),
      });
      const planText = responseText(planResponse);
      plan = responseFinish(planResponse) === 'length' ? null : parseDocumentPlan(planText);
    } catch (err) {
      if (signal?.aborted) throw err;
      console.warn('文档策划降级:', err.message);
    }
  }
  if (!plan?.sections.length) {
    plan = buildFallbackDocumentPlan(chat);
    issues.push('未取得完整章节大纲，已按现有素材编排');
  }

  let selectedImages = [];
  let archive = explicitImages;
  if (candidates.length) {
    let selected = null;
    try {
      const imageMessages = buildDocumentImagePlanMessages({
        chat,
        images: candidates,
        plan,
        userGuidance,
        limit: DOCUMENT_FINAL_IMAGES,
      });
      const imageResponse = await request('image_plan', planLlm, imageMessages, {
        tools: false,
        maxTokens: Math.min(8192, Math.max(2048, 512 + DOCUMENT_FINAL_IMAGES * 120)),
        temperature: 0.2,
        signal: withTimeout(signal, DOCUMENT_TIMEOUT),
      });
      const imageText = responseText(imageResponse);
      selected =
        responseFinish(imageResponse) === 'length'
          ? null
          : parseDocumentImagePlan(
              imageText,
              candidates,
              plan.sections,
              DOCUMENT_FINAL_IMAGES,
            );
    } catch (err) {
      if (signal?.aborted) throw err;
      console.warn('文档配图策划失败:', err.message);
    }
    if (selected !== null) {
      selectedImages = selected;
      if (imageIds === null) archive = [...selected].sort((left, right) => left.index - right.index);
    } else if (imageIds === null) {
      archive = buildFallbackDocumentImagePlan(candidates);
      issues.push('未取得完整配图方案，已改用候选图片生成文末附录');
    }
  }

  const sections = plan.sections;
  const title = plan.title || chat.title || '文档';
  const imageBuckets = sections.map(() => []);
  for (const image of selectedImages) imageBuckets[image.section - 1]?.push(image);
  const markdownParts = [`# ${title}`];
  let written = 0;

  try {
    const introMessages = buildDocumentIntroMessages({ chat, plan, transcript: planSource, userGuidance });
    const introResponse = await request('intro', llm, introMessages, {
      tools: false,
      maxTokens: INTRO_MAX_TOKENS,
      temperature: 0.3,
      signal: withTimeout(signal, DOCUMENT_TIMEOUT),
    });
    const intro = responseFinish(introResponse) === 'stop' ? normalizeIntro(responseText(introResponse)) : '';
    if (intro) markdownParts.push(intro);
  } catch (err) {
    if (signal?.aborted) throw err;
    console.warn('文档导语生成失败:', err.message);
  }

  const sectionSignal = withTimeout(signal, documentTimeoutSeconds({ chapters: sections.length }));
  const sectionBudget = DOCUMENT_SECTION_CHARS;
  for (const [index, section] of sections.entries()) {
    const label = `第 ${index + 1} 章「${section.heading}」`;
    try {
      if (signal?.aborted) throw new Error('已取消');
      const makeSectionMessages = (limit) => {
        const transcript = buildSectionTranscript(chat, section, limit);
        return buildDocumentSectionMessages({
          chat,
          plan,
          section,
          index,
          total: sections.length,
          images: imageBuckets[index],
          transcript,
          userGuidance,
        });
      };
      if (process.env.DOCUMENT_DEBUG) {
        console.warn(
          `[doc] 章节 ${index + 1}/${sections.length}: ${section.heading}`,
        );
      }
      let sectionMessages = makeSectionMessages(sectionBudget);
      let result;
      try {
        result = await completeSection(request, llm, sectionMessages, sectionSignal);
      } catch (err) {
        if (sectionSignal.aborted || !/context.{0,24}(length|window|limit)|too many tokens|上下文.{0,8}(超|长)/i.test(err.message)) throw err;
        // A provider with a small context window may reject the normal
        // chapter slice. Retry once with half the evidence before failing.
        const reduced = Math.max(4000, Math.floor(sectionBudget / 2));
        if (sectionBudget <= reduced) throw err;
        console.warn(`文档第 ${index + 1} 章上下文降级:`, err.message);
        sectionMessages = makeSectionMessages(reduced);
        result = await completeSection(request, llm, sectionMessages, sectionSignal);
      }
      const body = normalizeSection(result.text, `${index + 1}. ${section.heading}`);
      if (!body) throw new Error(`${label}没有返回正文`);
      if (result.incomplete) issues.push(`${label}未写完`);
      markdownParts.push(body);
      written++;
    } catch (err) {
      if (signal?.aborted) throw err;
      issues.push(`${label}缺失`);
      console.warn(`文档${label}未生成:`, friendlyError(err));
    }
  }
  if (!written) {
    throw new AppError(502, '文档生成失败：所有章节均没有返回正文');
  }

  const markdown = applySettledCorrections(
    dedupeDocumentVoice(markdownParts.filter(Boolean).join('\n\n')),
    chat.messages.filter((message) => message.role === 'user').map((message) => message.content).join('\n'),
  );
  if (!markdown.trim()) {
    throw new AppError(502, '文档生成失败：模型没有返回有效内容');
  }

  return renderMarkdown({
    markdown,
    title: plan?.title || chat.title,
    issues,
    images: selectedImages,
    archive,
    requestedImageCount: imageIds?.length,
    format,
    fileById,
    signal,
  });
}

async function renderMarkdown({
  markdown,
  title,
  issues,
  images,
  archive,
  requestedImageCount,
  format,
  fileById,
  signal,
}) {
  const document = finalizeDocument({
    markdown,
    title,
    images,
    archive,
    showImageSource: requestedImageCount !== undefined,
  });
  const rasterCache = new Map();
  for (const block of document.blocks) {
    if (signal?.aborted) throw new Error('已取消');
    if (block.type !== 'image' || rasterCache.has(block.id)) continue;
    const file = fileById.get(block.id);
    if (!file) {
      rasterCache.set(block.id, null);
      continue;
    }
    // Appendix pictures illustrate rather than carry the argument, so they are
    // rendered smaller and lighter: a 30-picture appendix must not triple the
    // file size of a document whose body only uses a handful.
    const raster = await rasterizeImage(
      file,
      block.archive ? { maxSize: 900, quality: 78 } : {},
    );
    rasterCache.set(
      block.id,
      raster
        ? { ...raster, url: `/files/${block.id}.${file.ext}` }
        : null,
    );
  }

  const blocks = [];
  const missingBody = [];
  const missingArchive = [];
  let embedded = 0;
  let embeddedBody = 0;
  let embeddedArchive = 0;
  for (const block of document.blocks) {
    if (block.type !== 'image') {
      blocks.push(block);
      continue;
    }
    const raster = rasterCache.get(block.id);
    if (!raster) {
      // A picture that cannot be rasterized is still a generated picture. It is
      // named in the document and in the tool result rather than silently
      // leaving a count that does not match what the user sees in the gallery.
      const label = `${block.id}${block.caption ? `（${block.caption}）` : ''}`;
      if (block.archive) missingArchive.push(label);
      else missingBody.push(label);
      continue;
    }
    embedded += 1;
    if (block.archive) embeddedArchive += 1;
    else embeddedBody += 1;
    blocks.push({
      ...block,
      data: raster.data,
      width: raster.width,
      height: raster.height,
    });
  }
  // All explicitly selected pictures are required, including those in the appendix.
  if (requestedImageCount !== undefined && embedded < requestedImageCount) {
    const failed = [...missingBody, ...missingArchive].join('、');
    throw new AppError(422, `勾选了 ${requestedImageCount} 张图片，仅 ${embedded} 张可嵌入${failed ? `。无法读取或转换：${failed}` : ''}。文档未保存`);
  }
  const notes = [];
  for (const label of missingBody) issues.push(`图片 ${label} 无法嵌入`);
  for (const label of missingArchive) issues.push(`图片 ${label} 无法嵌入`);
  const rasterFailures = [...missingBody, ...missingArchive];
  if (rasterFailures.length) {
    notes.push({
      type: 'paragraph',
      text: `以下图片在导出时无法读取或转换：${rasterFailures.join('；')}。`,
    });
  }
  if (notes.length) {
    const at = blocks.findIndex((block) => block.appendix);
    blocks.splice(at >= 0 ? at : blocks.length, 0, ...notes);
  }

  const partial = issues.length > 0;
  if (partial) {
    document.title = `部分稿 · ${document.title}`;
    blocks.unshift({ type: 'paragraph', text: `交付说明：${issues.join('；')}。` });
  }

  const date = new Intl.DateTimeFormat('zh-CN', {
    year: 'numeric',
    month: 'long',
    day: 'numeric',
  }).format(new Date());
  const meta = `${partial ? '部分稿' : '终稿'} · ${date}`;
  const preview = blocks.map((block) =>
    block.type === 'image'
      ? {
          type: 'image',
          id: block.id,
          url: rasterCache.get(block.id)?.url || '',
          caption: block.caption || '',
          width: block.width,
          height: block.height,
        }
      : block,
  );
  const pdf = format === 'pdf';
  const buffer = pdf
    ? await buildPdf({ title: document.title, meta, blocks })
    : buildDocx({ title: document.title, meta, blocks });

  return {
    buffer,
    filename: safeFilename(document.title, pdf ? 'pdf' : 'docx'),
    format: pdf ? 'pdf' : 'docx',
    title: document.title,
    preview,
    images: embedded,
    bodyImages: embeddedBody,
    archivedImages: embeddedArchive,
    issues,
  };
}
