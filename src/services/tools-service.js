import { readFile } from 'node:fs/promises';
import {
  IMAGE_INPUT_FIDELITY,
  IMAGE_QUALITY,
  INPUT_FIDELITY_MODEL,
  PROMPT_OPTIMIZE,
} from '../config.js';
import {
  actualImageSize,
  findImageFile,
  finalizeRaster,
  itemToBuffer,
  probeImageSize,
  resolveSize,
  saveImageBuffer,
  sizeFromDimensions,
} from '../media/image-storage.js';
import { recordGalleryImage } from './image-service.js';
import { directImagePrompt, requestImage } from '../ai/llm.js';
import { inferAspectRatio } from '../media/png.js';
import { normalizeRefIds } from '../domain/chat-options.js';
import { clamp, clipText } from '../shared/utils.js';

async function optimizePrompt(ctx, draft, { aspectRatio, model, mode }) {
  if (!PROMPT_OPTIMIZE || !ctx.models?.llm?.apiKey) return draft;
  return directImagePrompt(
    ctx.models.llm,
    {
      userText: ctx.userText,
      draft,
      aspectRatio,
      model,
      skill: ctx.skill,
      mode,
    },
    ctx.signal,
  );
}

async function generateImages(args, ctx) {
  const prompt = String(args.prompt || '').trim();
  if (!prompt) return { error: '缺少提示词 prompt' };
  const aspectRatio = ctx.options?.aspectRatio || args.aspect_ratio || null;
  const requested = clamp(Number(args.count) || 1, 1, 4);
  const budget = Number.isInteger(ctx.countBudget) ? ctx.countBudget : null;
  const count = budget == null ? requested : Math.max(0, Math.min(requested, budget));
  if (budget != null && count === 0) {
    return { ok: true, images: [], note: `本轮已达到设定的 ${budget} 张图片。` };
  }
  const size = resolveSize(aspectRatio);
  const quality = ctx.options?.quality || IMAGE_QUALITY;
  const model = ctx.models.image.model;
  const groupId = ctx.turnId;

  const finalPrompt = await optimizePrompt(ctx, prompt, {
    aspectRatio,
    model,
    mode: 'generate',
  });
  ctx.emit({ type: 'status', text: count > 1 ? `正在生成 ${count} 张图片…` : '正在生成图片…' });

  const data = await requestImage(
    ctx.models.image,
    '/images/generations',
    {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${ctx.models.image.apiKey}`,
      },
      body: JSON.stringify({
        model,
        prompt: finalPrompt,
        size,
        n: count,
        quality,
      }),
    },
    ctx.signal,
  );

  const saved = [];
  for (const item of data) {
    const rawBuffer = await itemToBuffer(item, ctx.signal);
    const buffer = finalizeRaster(rawBuffer, aspectRatio);
    const outputSize = actualImageSize(buffer, size);
    const img = await saveImageBuffer(ctx.user.id, buffer, 'png');
    const meta = {
      groupId,
      parentId: null,
      model,
      quality,
      caption: ctx.userText ? clipText(ctx.userText, 500) : '',
    };
    recordGalleryImage(ctx, img, finalPrompt, outputSize, aspectRatio, meta);
    const record = {
      id: img.id,
      url: img.url,
      prompt: finalPrompt,
      size: outputSize,
      aspectRatio,
      ...meta,
    };
    saved.push(record);
    ctx.turnImages.push(record);
    ctx.emit({ type: 'image', ...record });
  }
  if (budget != null) ctx.countBudget = Math.max(0, budget - saved.length);

  return {
    ok: true,
    images: saved.map((s) => ({ image_id: s.id, url: s.url, size: s.size })),
    note: '图片已经展示给用户。',
  };
}

async function editImage(args, ctx) {
  const prompt = String(args.prompt || '').trim();
  if (!prompt) return { error: '缺少修改指令 prompt' };

  const refIds = normalizeRefIds(args.reference_image_ids);
  if (!refIds.length && typeof args.reference_image_id === 'string') {
    refIds.push(...normalizeRefIds(args.reference_image_id));
  }
  if (!refIds.length && Array.isArray(ctx.refIds)) {
    refIds.push(...normalizeRefIds(ctx.refIds));
  }
  const imageId = refIds[0] || ctx.refId || ctx.chat.lastImageId;
  if (!imageId) return { error: '会话里没有可编辑的图片，请先生成一张图或上传参考图。' };
  if (!refIds.includes(imageId)) refIds.unshift(imageId);

  const files = [];
  for (const id of refIds) {
    const file = await findImageFile(ctx.user.id, id);
    if (!file) return { error: `找不到参考图 ${id}` };
    files.push({ id, file });
  }
  if (!files.length) return { error: '会话里没有可编辑的图片，请先生成一张图或上传参考图。' };
  if (files.some(({ file }) => file.ext === 'svg')) {
    return {
      error:
        '这是旧版矢量图，当前版本不能用 edit_image 修改。请重新生成一张位图，再继续修改。',
    };
  }

  let aspectRatio = ctx.options?.aspectRatio || args.aspect_ratio || null;
  let size;
  if (aspectRatio) {
    size = resolveSize(aspectRatio);
  } else {
    const dims = await probeImageSize(files[0].file.path, files[0].file.ext);
    aspectRatio = inferAspectRatio(dims?.width, dims?.height);
    size = sizeFromDimensions(dims?.width, dims?.height);
  }
  const requested = clamp(Number(ctx.options?.count) || 1, 1, 4);
  const budget = Number.isInteger(ctx.countBudget) ? ctx.countBudget : null;
  const count = budget == null ? 1 : Math.max(0, Math.min(requested, budget));
  if (budget != null && count === 0) {
    return { ok: true, images: [], note: `本轮已达到设定的 ${budget} 张图片。` };
  }
  const quality = ctx.options?.quality || IMAGE_QUALITY;
  const model = ctx.models.image.model;
  const groupId = ctx.turnId;
  const parentId = files[0].id;
  const finalPrompt = await optimizePrompt(ctx, prompt, {
    aspectRatio,
    model,
    mode: 'edit',
  });
  ctx.emit({
    type: 'status',
    text:
      files.length > 1 ? `正在基于 ${files.length} 张参考图修改…` : '正在基于参考图修改…',
  });

  const form = new FormData();
  form.append('model', model);
  form.append('prompt', finalPrompt);
  form.append('size', size);
  form.append('n', String(count));
  form.append('quality', quality);
  if (INPUT_FIDELITY_MODEL.test(model)) {
    form.append('input_fidelity', IMAGE_INPUT_FIDELITY);
  }
  for (const { file } of files) {
    const buffer = await readFile(file.path);
    form.append('image', new Blob([buffer], { type: file.mime }), `reference.${file.ext}`);
  }

  const data = await requestImage(
    ctx.models.image,
    '/images/edits',
    {
      method: 'POST',
      headers: { Authorization: `Bearer ${ctx.models.image.apiKey}` },
      body: form,
    },
    ctx.signal,
  );

  const saved = [];
  for (const item of data) {
    const rawOutput = await itemToBuffer(item, ctx.signal);
    const out = finalizeRaster(rawOutput, aspectRatio);
    const outputSize = actualImageSize(out, size);
    const img = await saveImageBuffer(ctx.user.id, out, 'png');
    const meta = {
      groupId,
      parentId,
      model,
      quality,
      caption: ctx.userText ? clipText(ctx.userText, 500) : '',
    };
    recordGalleryImage(ctx, img, finalPrompt, outputSize, aspectRatio, meta);
    const record = {
      id: img.id,
      url: img.url,
      prompt: finalPrompt,
      size: outputSize,
      aspectRatio,
      ...meta,
    };
    saved.push(record);
    ctx.turnImages.push(record);
    ctx.emit({ type: 'image', ...record });
  }
  if (budget != null) ctx.countBudget = Math.max(0, budget - saved.length);

  return {
    ok: true,
    images: saved.map((s) => ({ image_id: s.id, url: s.url, size: s.size })),
    note: '修改后的图片已经展示给用户。',
  };
}

export async function runTool(name, args, ctx) {
  if (name === 'generate_image') return generateImages(args, ctx);
  if (name === 'edit_image') return editImage(args, ctx);
  return { error: `未知工具 ${name}` };
}
