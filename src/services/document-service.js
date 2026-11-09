import sharp from 'sharp';
import {
  DOCUMENT_BRIEF_INPUT_CHARS,
  DOCUMENT_BRIEF_MAX_CHARS,
  DOCUMENT_BRIEF_MAX_TOKENS,
  DOCUMENT_MAX_IMAGES,
  DOCUMENT_PLAN_CHARS,
  DOCUMENT_SECTION_CHARS,
  DOCUMENT_TIMEOUT,
} from '../config.js';
import { chatCompletion } from '../ai/llm.js';
import {
  buildDocumentBriefMessages,
  buildDocumentContextChunks,
  buildDocumentMergeMessages,
  buildDocumentImagePlanMessages,
  buildDocumentIntroMessages,
  buildDocumentPlanDigest,
  buildDocumentPlanMessages,
  buildDocumentSectionMessages,
  buildFallbackDocumentPlan,
  buildSectionTranscript,
  collectDocumentImages,
  fallbackDocumentImages,
  finalizeDocument,
  parseDocumentImagePlan,
  parseDocumentPlan,
  selectFinalDocumentImages,
} from '../domain/document.js';
import { findGalleryImage } from '../data/repositories/gallery.js';
import { findImageFile } from '../media/image-storage.js';
import { buildDocx } from '../media/docx.js';
import { buildPdf } from '../media/pdf.js';
import { AppError } from '../shared/errors.js';
import { friendlyError, newId, withTimeout } from '../shared/utils.js';
import { loadChatForUser } from './chat-service.js';
import { loadSettings } from './model-settings-service.js';
import { recordLlmUsage } from './usage-service.js';

// Document work is split into small requests so it does not depend on a large
// per-request max_tokens. The compact outline and one chapter at a time both
// fit within a conservative completion budget, even when the provider spends
// part of that budget on hidden reasoning. Planning failures degrade to a
// deterministic outline rather than aborting the export.
const PLAN_MAX_TOKENS = 2048;
const INTRO_MAX_TOKENS = 2048;
const SECTION_MAX_TOKENS = 4096;
const MAX_CONTINUATIONS = 2;

async function rasterizeImage(file) {
  try {
    const source = sharp(file.path, { failOn: 'none', animated: false });
    const meta = await source.metadata();
    if (!meta.width || !meta.height) return null;
    const { data, info } = await source
      .rotate()
      .resize({
        width: 1600,
        height: 1600,
        fit: 'inside',
        withoutEnlargement: true,
      })
      .flatten({ background: '#ffffff' })
      .jpeg({ quality: 88, chromaSubsampling: '4:4:4' })
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

async function curateFinalImages(user, chat) {
  const all = collectDocumentImages(chat, Number.MAX_SAFE_INTEGER).images;
  const hiddenIds = [];
  const unavailableIds = [];
  const fileById = new Map();
  const enriched = [];

  for (const image of all) {
    const row = findGalleryImage(user.id, image.id);
    if (row?.hidden) hiddenIds.push(image.id);
    const file = await findImageFile(user.id, image.id);
    if (file) fileById.set(image.id, file);
    else unavailableIds.push(image.id);
    enriched.push({
      ...image,
      groupId: row?.group_id || image.groupId || null,
      favorite: Boolean(row?.favorite),
    });
  }

  return {
    images: selectFinalDocumentImages(enriched, {
      hiddenIds,
      unavailableIds,
      limit: DOCUMENT_MAX_IMAGES,
    }),
    fileById,
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

function splitBriefText(text) {
  const limit = Math.max(1000, Math.floor(DOCUMENT_BRIEF_INPUT_CHARS / 2));
  const parts = [];
  let rest = String(text || '');
  while (rest.length > limit) {
    const paragraphCut = rest.lastIndexOf('\n\n', limit);
    const cut = paragraphCut > limit / 2 ? paragraphCut : limit;
    parts.push(rest.slice(0, cut));
    rest = rest.slice(cut);
  }
  if (rest) parts.push(rest);
  return parts;
}

function groupBriefTexts(texts, limit) {
  const groups = [];
  let current = [];
  let size = 0;
  for (const text of texts) {
    if (!text) continue;
    if (text.length > limit) {
      if (current.length) groups.push(current);
      current = [];
      size = 0;
      groups.push([text]);
      continue;
    }
    if (current.length && size + text.length + 2 > limit) {
      groups.push(current);
      current = [];
      size = 0;
    }
    current.push(text);
    size += text.length + 2;
  }
  if (current.length) groups.push(current);
  return groups;
}

async function buildDocumentBrief(user, chat, llm, signal, turnId) {
  const chunks = buildDocumentContextChunks(chat, DOCUMENT_BRIEF_INPUT_CHARS);
  if (!chunks.length) return '';

  const callSummary = async (messages) => {
    let response;
    try {
      response = await chatCompletion(llm, messages, {
        tools: false,
        maxTokens: DOCUMENT_BRIEF_MAX_TOKENS,
        temperature: 0.2,
        signal,
      });
    } catch (err) {
      if (signal?.aborted) throw err;
      console.warn('文档主题摘要降级:', err.message);
      return { text: '', finish: 'error' };
    }
    const text = responseText(response);
    recordUsage({ user, chat, turnId, llm, messages, response, text });
    return { text, finish: responseFinish(response) };
  };

  const summarizeText = async (text, depth = 0) => {
    if (!String(text || '').trim()) return '';
    const messages = buildDocumentBriefMessages({ chunk: text });
    const result = await callSummary(messages);
    if (!result.text) return text;
    if (result.finish !== 'length') return result.text;
    if (depth >= 4) return text;
    const parts = splitBriefText(text);
    if (parts.length <= 1) return result.text || text;
    const summaries = [];
    for (const part of parts) summaries.push(await summarizeText(part, depth + 1));
    return summaries.filter(Boolean).join('\n\n');
  };

  const mergeTexts = async (texts, depth = 0) => {
    const items = texts.filter(Boolean);
    if (!items.length) return '';
    const combined = items.join('\n\n');
    if (combined.length <= DOCUMENT_BRIEF_MAX_CHARS) return combined;
    if (depth >= 5) return combined;
    if (items.length === 1) {
      const parts = splitBriefText(items[0]);
      if (parts.length <= 1) return items[0];
      const merged = [];
      for (const part of parts) merged.push(await mergeTexts([part], depth + 1));
      return mergeTexts(merged, depth + 1);
    }
    const groups = groupBriefTexts(items, DOCUMENT_BRIEF_INPUT_CHARS);
    const merged = [];
    for (const group of groups) {
      if (group.length === 1 && group[0].length > DOCUMENT_BRIEF_INPUT_CHARS) {
        for (const part of splitBriefText(group[0])) {
          merged.push(await mergeTexts([part], depth + 1));
        }
        continue;
      }
      const result = await callSummary(buildDocumentMergeMessages({ summaries: group }));
      if (!result.text) {
        merged.push(...group);
        continue;
      }
      if (result.finish === 'length') {
        const sub = group.length > 1 ? group : splitBriefText(group[0]);
        for (const item of sub) merged.push(await mergeTexts([item], depth + 1));
      } else {
        merged.push(result.text);
      }
    }
    return mergeTexts(merged, depth + 1);
  };

  const summaries = [];
  for (const chunk of chunks) summaries.push(await summarizeText(chunk));
  const brief = await mergeTexts(summaries);
  return `【摘要覆盖】共处理 ${chunks.length} 个对话片段，全部纳入主题摘要。\n${brief}`.trim();
}

function sectionImageBuckets(plan, sections) {
  const buckets = sections.map(() => []);
  let next = 0;
  for (const image of plan.images || []) {
    let index = Math.trunc(Number(image.section)) - 1;
    if (!Number.isInteger(index) || index < 0 || index >= sections.length) {
      index = next % sections.length;
    }
    next += 1;
    buckets[index].push({ ...image, index: buckets[index].length + 1 });
  }
  return buckets;
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
  let value = unwrapMarkdown(text);
  // A chapter may accidentally include the document H1; remove only that
  // leading title and keep the requested H2.
  value = value.replace(/^#\s+[^\n]+\n+/, '');
  if (/^##\s+/.test(value)) return value;
  return `## ${heading}\n\n${value}`;
}

async function completeSection(llm, messages, signal) {
  const responses = [];
  let response = await chatCompletion(llm, messages, {
    tools: false,
    maxTokens: SECTION_MAX_TOKENS,
    temperature: 0.4,
    signal,
  });
  responses.push(response);
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
    response = await chatCompletion(llm, continuation, {
      tools: false,
      maxTokens: SECTION_MAX_TOKENS,
      temperature: 0.4,
      signal,
    });
    responses.push(response);
    const part = responseText(response);
    if (part) text = `${text}\n\n${part}`;
    continuations += 1;
  }
  return { text, responses, finish: responseFinish(response) };
}

/**
 * Generates a review-ready document in small requests: a chunked semantic
 * brief, a compact outline, an introduction, then one chapter at a time.
 * Long conversations are summarized and merged rather than prefix-clipped;
 * planning/image failures degrade instead of blocking the export.
 */
export async function generateSessionDocument(
  user,
  chatId,
  { signal, format = 'docx' } = {},
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

  const { images: candidates, fileById } = await curateFinalImages(user, chat);
  const timeoutSignal = withTimeout(signal, DOCUMENT_TIMEOUT);
  const turnId = newId();
  const planLlm = documentLlm(models.llm, 'low');
  const llm = documentLlm(models.llm);
  const chunks = buildDocumentContextChunks(chat, DOCUMENT_BRIEF_INPUT_CHARS);
  let brief = '';
  if (chunks.length > 1 || (chunks[0]?.length || 0) > DOCUMENT_PLAN_CHARS) {
    try {
      brief = await buildDocumentBrief(user, chat, planLlm, timeoutSignal, turnId);
    } catch (err) {
      if (signal?.aborted || timeoutSignal.aborted) throw err;
      console.warn('文档主题摘要降级:', err.message);
    }
  }
  const planSource = brief || buildDocumentPlanDigest(chat, DOCUMENT_PLAN_CHARS);
  let plan;

  try {
    const planMessages = buildDocumentPlanMessages({ chat, transcript: planSource });
    const planResponse = await chatCompletion(planLlm, planMessages, {
      tools: false,
      maxTokens: PLAN_MAX_TOKENS,
      temperature: 0.2,
      signal: timeoutSignal,
    });
    const planText = responseText(planResponse);
    recordUsage({ user, chat, turnId, llm: models.llm, messages: planMessages, response: planResponse, text: planText });
    plan =
      responseFinish(planResponse) === 'length'
        ? null
        : parseDocumentPlan(planText);
    if (!plan) {
      plan = buildFallbackDocumentPlan(chat);
      console.warn('文档策划降级：使用确定性大纲');
    }
  } catch (err) {
    if (signal?.aborted || timeoutSignal.aborted) throw err;
    plan = buildFallbackDocumentPlan(chat);
    console.warn('文档策划降级:', err.message);
  }

  if (!plan.sections.length) {
    plan = { ...plan, sections: buildFallbackDocumentPlan(chat).sections };
  }

  const selectedImages = [];
  if (candidates.length) {
    try {
      const imageMessages = buildDocumentImagePlanMessages({
        chat,
        images: candidates,
        plan,
      });
      const imageResponse = await chatCompletion(planLlm, imageMessages, {
        tools: false,
        maxTokens: PLAN_MAX_TOKENS,
        temperature: 0.2,
        signal: timeoutSignal,
      });
      const imageText = responseText(imageResponse);
      recordUsage({ user, chat, turnId, llm: models.llm, messages: imageMessages, response: imageResponse, text: imageText });
      const selected =
        responseFinish(imageResponse) === 'length'
          ? null
          : parseDocumentImagePlan(imageText, candidates, plan.sections);
      if (selected) selectedImages.push(...selected);
      else {
        selectedImages.push(...fallbackDocumentImages(candidates, plan.sections));
        console.warn('文档配图降级：使用按时间排序的候选图');
      }
    } catch (err) {
      if (signal?.aborted || timeoutSignal.aborted) throw err;
      selectedImages.push(...fallbackDocumentImages(candidates, plan.sections));
      console.warn('文档配图降级:', err.message);
    }
  }
  plan.images = selectedImages;

  const sections = plan.sections.length
    ? plan.sections
    : [{ heading: '文档正文', purpose: '', points: [] }];
  const title = plan.title || chat.title || '文档';
  const imageBuckets = sectionImageBuckets(plan, sections);
  const markdownParts = [`# ${title}`];

  try {
    const introMessages = buildDocumentIntroMessages({
      chat,
      plan,
      transcript: brief || buildDocumentPlanDigest(chat, 4000),
    });
    const introResponse = await chatCompletion(llm, introMessages, {
      tools: false,
      maxTokens: INTRO_MAX_TOKENS,
      temperature: 0.3,
      signal: timeoutSignal,
    });
    const introText = responseText(introResponse);
    recordUsage({ user, chat, turnId, llm: models.llm, messages: introMessages, response: introResponse, text: introText });
    if (responseFinish(introResponse) === 'length') {
      console.warn('文档导语降级：保留已生成部分');
    }
    const intro = normalizeIntro(introText) || plan.coreMessage || plan.objective;
    if (intro) markdownParts.push(intro);

    const sectionBudget = Math.max(
      4000,
      DOCUMENT_SECTION_CHARS - (brief ? brief.length : 0),
    );
    for (const [index, section] of sections.entries()) {
      if (signal?.aborted) throw new Error('已取消');
      const makeSectionMessages = (limit) => {
        const evidence = buildSectionTranscript(chat, section, limit);
        const transcript = brief
          ? `【全篇事实摘要】\n${brief}\n\n【本章相关片段】\n${evidence}`
          : evidence;
        return buildDocumentSectionMessages({
          chat,
          plan,
          section,
          index,
          total: sections.length,
          images: imageBuckets[index],
          transcript,
        });
      };
      let sectionMessages = makeSectionMessages(sectionBudget);
      let result;
      try {
        result = await completeSection(llm, sectionMessages, timeoutSignal);
      } catch (err) {
        if (signal?.aborted || timeoutSignal.aborted) throw err;
        // A provider with a small context window may reject the normal
        // chapter slice. Retry once with half the evidence before failing.
        const reduced = Math.max(4000, Math.floor(sectionBudget / 2));
        if (sectionBudget <= reduced) throw err;
        console.warn(`文档第 ${index + 1} 章上下文降级:`, err.message);
        sectionMessages = makeSectionMessages(reduced);
        result = await completeSection(llm, sectionMessages, timeoutSignal);
      }
      for (const response of result.responses) {
        recordUsage({
          user,
          chat,
          turnId,
          llm: models.llm,
          messages: sectionMessages,
          response,
          text: responseText(response),
        });
      }
      if (!result.text) {
        throw new AppError(502, `文档生成失败：第 ${index + 1} 章没有返回内容`);
      }
      if (result.finish === 'length') {
        console.warn(`文档第 ${index + 1} 章降级：保留已生成部分`);
      }
      markdownParts.push(normalizeSection(result.text, section.heading));
    }
  } catch (err) {
    if (signal?.aborted || timeoutSignal.aborted) throw err;
    console.warn('文档编排失败:', err.message);
    if (err instanceof AppError) throw err;
    throw new AppError(502, `文档生成失败：${friendlyError(err)}`);
  }

  const markdown = markdownParts.filter(Boolean).join('\n\n');
  if (!markdown.trim()) {
    throw new AppError(502, '文档生成失败：模型没有返回有效内容');
  }

  const document = finalizeDocument({
    markdown,
    title: plan?.title || chat.title,
    images: selectedImages,
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
    const raster = await rasterizeImage(file);
    rasterCache.set(
      block.id,
      raster
        ? { ...raster, url: `/files/${block.id}.${file.ext}` }
        : null,
    );
  }

  const blocks = [];
  let embedded = 0;
  for (const block of document.blocks) {
    if (block.type !== 'image') {
      blocks.push(block);
      continue;
    }
    const raster = rasterCache.get(block.id);
    if (!raster) continue;
    embedded += 1;
    blocks.push({
      ...block,
      data: raster.data,
      width: raster.width,
      height: raster.height,
    });
  }

  const date = new Intl.DateTimeFormat('zh-CN', {
    year: 'numeric',
    month: 'long',
    day: 'numeric',
  }).format(new Date());
  const meta = `终稿 · ${date}`;
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
  };
}
