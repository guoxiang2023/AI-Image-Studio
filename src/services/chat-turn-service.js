import { findImageFile } from '../media/image-storage.js';
import {
  normalizeChatOptions,
  normalizeRefIds,
  normalizeRefRoles,
} from '../domain/chat-options.js';
import { AppError } from '../shared/errors.js';
import { friendlyError, newId, now } from '../shared/utils.js';
import { runAgent } from './agent-service.js';
import {
  loadChatForUser,
  newChatForUser,
  saveChat,
  updateSummary,
} from './chat-service.js';
import { loadSettings } from './model-settings-service.js';
import { getSkillForUser } from './skill-service.js';
import { maybeCompressChat } from './summary-service.js';

export async function prepareChatTurn(user, body) {
  const message = String(body.message || '').trim();
  if (!message) throw new AppError(400, '消息不能为空');

  const models = loadSettings(user.id);
  if (!models.llm.apiKey) {
    throw new AppError(400, '请先在「模型设置」中配置对话模型 API Key');
  }

  const hasSkillField = Object.prototype.hasOwnProperty.call(body, 'skillId');
  const requestedSkillId = hasSkillField ? String(body.skillId || '').trim() : '';
  let skill = requestedSkillId ? getSkillForUser(user.id, requestedSkillId) : null;
  if (requestedSkillId && !skill) {
    throw new AppError(404, 'Skill 不存在或已删除');
  }

  let chat = body.sessionId ? loadChatForUser(user.id, body.sessionId) : null;
  const isNew = !chat;
  if (!chat) chat = newChatForUser(user.id);
  if (hasSkillField) {
    chat.skillId = skill?.id || null;
  } else if (chat.skillId) {
    skill = getSkillForUser(user.id, chat.skillId);
    if (!skill) chat.skillId = null;
  }
  if (!chat.title) chat.title = message.slice(0, 30);

  const refIds = normalizeRefIds(
    Array.isArray(body.referenceImageIds) ? body.referenceImageIds : body.referenceImageId,
  );
  const refRoles = normalizeRefRoles(body.referenceRoles, refIds.length);
  const options = normalizeChatOptions(body.options);
  if (skill?.defaults) {
    options.aspectRatio ||= skill.defaults.aspectRatio || null;
    options.count ||= skill.defaults.count || null;
    options.quality ||= skill.defaults.quality || null;
  }

  const references = [];
  for (let index = 0; index < refIds.length; index += 1) {
    const id = refIds[index];
    const file = await findImageFile(user.id, id);
    if (!file) continue;
    references.push({ id, url: `/files/${id}.${file.ext}`, role: refRoles[index] || '参考' });
  }

  return {
    message,
    models,
    chat,
    skill,
    isNew,
    references,
    options,
    turnId: newId(),
  };
}

export async function runPreparedTurn({ user, prepared, emit, signal }) {
  const { message, models, chat, skill, isNew, references, options, turnId } = prepared;

  emit({ type: 'session', sessionId: chat.id, title: chat.title });

  const userMessage = { role: 'user', content: message, ts: now() };
  if (references.length) {
    userMessage.references = references;
    userMessage.referenceImageId = references[0].id;
    userMessage.referenceUrl = references[0].url;
    chat.lastImageId = references[0].id;
  }
  chat.messages.push(userMessage);

  const turnImages = [];
  let assistantRecorded = false;
  try {
    saveChat(chat);
    await maybeCompressChat(chat, models.llm, signal, emit, { saveSummary: updateSummary });
    const { text } = await runAgent({
      user,
      chat,
      models,
      skill,
      refId: references[0]?.id || null,
      refIds: references.map((ref) => ref.id),
      options,
      turnId,
      countBudget: options.count || null,
      userText: message,
      emit,
      signal,
      turnImages,
    });
    if (text) emit({ type: 'text', text });
    chat.messages.push({
      role: 'assistant',
      content: text,
      images: turnImages,
      ts: now(),
    });
    assistantRecorded = true;
    if (turnImages.length) chat.lastImageId = turnImages[turnImages.length - 1].id;
    saveChat(chat);
    emit({ type: 'done', sessionId: chat.id, created: isNew });
  } catch (err) {
    if (!assistantRecorded && turnImages.length) {
      chat.messages.push({
        role: 'assistant',
        content: '',
        images: turnImages,
        ts: now(),
      });
      chat.lastImageId = turnImages[turnImages.length - 1].id;
    }
    if (!signal.aborted) {
      emit({ type: 'error', message: friendlyError(err) });
    }
    try {
      saveChat(chat);
    } catch {
      /* best effort */
    }
    emit({ type: 'done', sessionId: chat.id, created: isNew, aborted: signal.aborted });
  }
}
