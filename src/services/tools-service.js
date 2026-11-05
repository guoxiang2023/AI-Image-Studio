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
import { recordImageUsage, recordLlmUsage } from './usage-service.js';
import { directImagePrompt, requestImage } from '../ai/llm.js';
import { inferAspectRatio } from '../media/png.js';
import { addQrToPng } from '../media/qr.js';
import { findGalleryImage } from '../data/repositories/gallery.js';
import { normalizeQr, normalizeRefIds } from '../domain/chat-options.js';
import { canUseReferenceImages } from '../domain/image-capabilities.js';
import { referencePromptBlock } from '../domain/image-references.js';
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
      mode,
      onUsage: (response, messages) =>
        recordLlmUsage({
          userId: ctx.user?.id,
          chatId: ctx.chat?.id,
          turnId: ctx.turnId,
          kind: 'prompt',
          model: ctx.models.llm.model,
          providerId: ctx.models.llm.providerId,
          providerName: ctx.models.llm.providerName,
          usage: response?.usage,
          messages,
          completionText: response?.choices?.[0]?.message?.content,
        }),
    },
    ctx.signal,
  );
}

function sessionReferences(ctx) {
  if (Array.isArray(ctx.references) && ctx.references.length) return ctx.references;
  return (Array.isArray(ctx.refIds) ? ctx.refIds : []).map((id) => ({ id, role: '参考' }));
}

function resolveReferences(args, ctx) {
  const explicit = normalizeRefIds(
    Array.isArray(args.reference_image_ids)
      ? args.reference_image_ids
      : args.reference_image_id,
  );
  const available = sessionReferences(ctx);
  const roleById = new Map(available.map((ref) => [ref.id, ref.role || '参考']));
  const ids = explicit.length ? explicit : available.map((ref) => ref.id);
  return ids.map((id) => ({ id, role: roleById.get(id) || '参考' }));
}

async function loadReferenceFiles(ctx, references) {
  const files = [];
  let qr = null;
  for (const ref of references) {
    const record = findGalleryImage(ctx.user.id, ref.id);
    let referenceQr = null;
    if (record?.qr_json) {
      try {
        referenceQr = normalizeQr(JSON.parse(record.qr_json));
      } catch {
        referenceQr = null;
      }
    }
    if (!qr && referenceQr) qr = referenceQr;
    const sourceId = record?.base_id || ref.id;
    const file = await findImageFile(ctx.user.id, sourceId);
    if (!file) return { error: `找不到参考图 ${ref.id}` };
    if (file.ext === 'svg') {
      return {
        error:
          '这是旧版矢量图，当前版本不能用参考图生成或修改。请重新生成一张位图，或更换参考图。',
      };
    }
    files.push({ ...ref, id: sourceId, sourceId: ref.id, file, qr: referenceQr });
  }
  return { files, qr };
}

async function buildReferenceForm({ model, prompt, size, count, quality }, files) {
  const form = new FormData();
  form.append('model', model);
  form.append('prompt', prompt);
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
  return form;
}

async function saveImageResults(
  ctx,
  data,
  { aspectRatio, size, groupId, parentId, model, quality, prompt, qr = null },
) {
  const saved = [];
  for (const item of data) {
    const rawBuffer = await itemToBuffer(item, ctx.signal);
    const baseBuffer = finalizeRaster(rawBuffer, aspectRatio);
    let buffer = baseBuffer;
    let baseId = null;
    if (qr) {
      buffer = addQrToPng(baseBuffer, qr);
      const base = await saveImageBuffer(ctx.user.id, baseBuffer, 'png');
      baseId = base.id;
    }
    const outputSize = actualImageSize(buffer, size);
    const img = await saveImageBuffer(ctx.user.id, buffer, 'png');
    const meta = {
      groupId,
      parentId,
      model,
      quality,
      caption: ctx.userText ? clipText(ctx.userText, 500) : '',
      baseId,
      qr,
    };
    recordGalleryImage(ctx, img, prompt, outputSize, aspectRatio, meta);
    const record = {
      id: img.id,
      url: img.url,
      prompt,
      size: outputSize,
      aspectRatio,
      ...meta,
    };
    saved.push(record);
    ctx.turnImages.push(record);
    ctx.emit({ type: 'image', ...record });
  }
  return saved;
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
  const quality = ctx.options?.quality || ctx.models.image.quality || IMAGE_QUALITY;
  const model = ctx.models.image.model;
  const groupId = ctx.turnId;
  const references = resolveReferences(args, ctx);

  if (references.length && !canUseReferenceImages(model)) {
    return {
      error: `当前图片模型 ${model} 不支持参考图生成，请改用支持 /images/edits 的模型，或移除参考图。`,
    };
  }

  let files = [];
  if (references.length) {
    const loaded = await loadReferenceFiles(ctx, references);
    if (loaded.error) return { error: loaded.error };
    files = loaded.files;
  }

  const draft = await optimizePrompt(ctx, prompt, {
    aspectRatio,
    model,
    mode: 'generate',
  });
  const finalPrompt = `${draft}${referencePromptBlock(references, { mode: 'generate' })}`;

  ctx.emit({
    type: 'status',
    text: files.length
      ? `正在基于 ${files.length} 张参考图生成…`
      : count > 1
        ? `正在生成 ${count} 张图片…`
        : '正在生成图片…',
  });

  let data;
  if (files.length) {
    const form = await buildReferenceForm(
      { model, prompt: finalPrompt, size, count, quality },
      files,
    );
    const result = await requestImage(
      ctx.models.image,
      '/images/edits',
      {
        method: 'POST',
        headers: { Authorization: `Bearer ${ctx.models.image.apiKey}` },
        body: form,
      },
      ctx.signal,
    );
    data = result.data;
  } else {
    const result = await requestImage(
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
    data = result.data;
  }
  recordImageUsage({
    userId: ctx.user?.id,
    chatId: ctx.chat?.id,
    turnId: ctx.turnId,
    model,
    providerId: ctx.models.image.providerId,
    providerName: ctx.models.image.providerName,
    images: data.length,
  });

  const saved = await saveImageResults(ctx, data, {
    aspectRatio,
    size,
    groupId,
    parentId: null,
    model,
    quality,
    prompt: finalPrompt,
    qr: ctx.options?.qr || null,
  });
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

  const references = resolveReferences(args, ctx);
  if (!references.length && ctx.chat.lastImageId) {
    references.push({ id: ctx.chat.lastImageId, role: '参考' });
  }
  if (!references.length) {
    return { error: '会话里没有可编辑的图片，请先生成一张图或上传参考图。' };
  }

  const model = ctx.models.image.model;
  if (!canUseReferenceImages(model)) {
    return {
      error: `当前图片模型 ${model} 不支持参考图修改，请改用支持 /images/edits 的模型。`,
    };
  }

  const loaded = await loadReferenceFiles(ctx, references);
  if (loaded.error) return { error: loaded.error };
  const files = loaded.files;

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
  const quality = ctx.options?.quality || ctx.models.image.quality || IMAGE_QUALITY;
  const groupId = ctx.turnId;
  const parentId = files[0].sourceId || files[0].id;
  const draft = await optimizePrompt(ctx, prompt, {
    aspectRatio,
    model,
    mode: 'edit',
  });
  const finalPrompt = `${draft}${referencePromptBlock(references, { mode: 'edit' })}`;

  ctx.emit({
    type: 'status',
    text:
      files.length > 1 ? `正在基于 ${files.length} 张参考图修改…` : '正在基于参考图修改…',
  });

  const form = await buildReferenceForm(
    { model, prompt: finalPrompt, size, count, quality },
    files,
  );
  const result = await requestImage(
    ctx.models.image,
    '/images/edits',
    {
      method: 'POST',
      headers: { Authorization: `Bearer ${ctx.models.image.apiKey}` },
      body: form,
    },
    ctx.signal,
  );
  const data = result.data;
  recordImageUsage({
    userId: ctx.user?.id,
    chatId: ctx.chat?.id,
    turnId: ctx.turnId,
    model,
    providerId: ctx.models.image.providerId,
    providerName: ctx.models.image.providerName,
    images: data.length,
  });

  const saved = await saveImageResults(ctx, data, {
    aspectRatio,
    size,
    groupId,
    parentId,
    model,
    quality,
    prompt: finalPrompt,
    qr: ctx.options?.qr || loaded.qr || null,
  });
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
