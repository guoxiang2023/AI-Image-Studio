import sharp from 'sharp';
import {
  DOCUMENT_MAX_IMAGES,
  DOCUMENT_TIMEOUT,
  DOCUMENT_TRANSCRIPT_CHARS,
} from '../config.js';
import { chatCompletion } from '../ai/llm.js';
import {
  buildDocumentMessages,
  buildDocumentPlanMessages,
  buildTranscript,
  collectDocumentImages,
  finalizeDocument,
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
  const name = String(title || 'Luma 文档')
    .replace(/[\u0000-\u001F\u007F\u200E\u200F\u202A-\u202E]/g, ' ')
    .replace(/[\\/:*?"<>|\r\n\t]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 50)
    .replace(/[. ]+$/, '');
  return `${name || 'Luma 文档'}.${ext}`;
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

/**
 * Generates a review-ready document. A planning call first decides the final
 * structure and which images are actually final deliverables; a second call
 * writes the prose. Images removed from the gallery, missing files, and
 * superseded edit versions never reach either prompt. If planning or
 * composition fails, the export fails rather than falling back to uncurated
 * candidates or saving a raw transcript as a document.
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
  const transcript = buildTranscript(chat, DOCUMENT_TRANSCRIPT_CHARS);
  const timeoutSignal = withTimeout(signal, DOCUMENT_TIMEOUT);
  const turnId = newId();
  let plan;

  try {
    const planMessages = buildDocumentPlanMessages({
      chat,
      images: candidates,
      transcript,
    });
    const planResponse = await chatCompletion(models.llm, planMessages, {
      tools: false,
      // DeepSeek-style models can easily spend >2000 tokens on the plan and
      // truncate the JSON. Keep enough headroom for a complete plan.
      maxTokens: 4000,
      temperature: 0.2,
      signal: timeoutSignal,
    });
    const planText = String(planResponse?.choices?.[0]?.message?.content || '').trim();
    plan = parseDocumentPlan(planText, candidates);
    if (planResponse) {
      recordLlmUsage({
        userId: user.id,
        chatId: chat.id,
        turnId,
        kind: 'document',
        model: models.llm.model,
        providerId: models.llm.providerId,
        providerName: models.llm.providerName,
        usage: planResponse.usage,
        messages: planMessages,
        completionText: planText,
      });
    }
    if (!plan) {
      throw new AppError(502, '文档策划失败：模型没有返回有效的终稿计划');
    }
  } catch (err) {
    if (signal?.aborted || timeoutSignal.aborted) throw err;
    console.warn('文档策划失败:', err.message);
    if (err instanceof AppError) throw err;
    throw new AppError(502, `文档策划失败：${friendlyError(err)}`);
  }

  const selectedImages = plan.images;
  const messages = buildDocumentMessages({
    chat,
    images: selectedImages,
    transcript,
    plan,
  });

  let markdown = '';
  try {
    const response = await chatCompletion(models.llm, messages, {
      tools: false,
      maxTokens: 6000,
      temperature: 0.4,
      signal: timeoutSignal,
    });
    markdown = String(response?.choices?.[0]?.message?.content || '').trim();
    if (response) {
      recordLlmUsage({
        userId: user.id,
        chatId: chat.id,
        turnId,
        kind: 'document',
        model: models.llm.model,
        providerId: models.llm.providerId,
        providerName: models.llm.providerName,
        usage: response.usage,
        messages,
        completionText: markdown,
      });
    }
  } catch (err) {
    if (signal?.aborted) throw err;
    console.warn('文档编排失败:', err.message);
    throw new AppError(502, `文档生成失败：${friendlyError(err)}`);
  }

  if (!markdown) {
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
  const meta = `由 Luma 整理 · 终稿 · ${date}`;
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
