import { findImageFile } from '../media/image-storage.js';
import {
  normalizeChatOptions,
  normalizeQr,
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
import { maybeCompressChat } from './summary-service.js';

export async function prepareChatTurn(user, body) {
  const message = String(body.message || '').trim();
  if (!message) throw new AppError(400, '消息不能为空');

  const models = loadSettings(user.id);
  if (!models.llm.apiKey) {
    throw new AppError(400, '请先在「模型设置」中配置对话模型 API Key');
  }

  let chat = body.sessionId ? loadChatForUser(user.id, body.sessionId) : null;
  const isNew = !chat;
  if (!chat) chat = newChatForUser(user.id);
  if (!chat.title) chat.title = message.slice(0, 30);

  const refIds = normalizeRefIds(
    Array.isArray(body.referenceImageIds) ? body.referenceImageIds : body.referenceImageId,
  );
  const refRoles = normalizeRefRoles(body.referenceRoles, refIds.length);
  const options = normalizeChatOptions(body.options);
  options.qr = normalizeQr(body.qr);

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
    isNew,
    references,
    options,
    turnId: newId(),
  };
}

export async function runPreparedTurn({ user, prepared, emit, signal }) {
  const { message, models, chat, isNew, references, options, turnId } = prepared;

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
  let draft = null;
  let lastDraftSave = 0;

  const removeDraft = () => {
    if (!draft) return;
    const index = chat.messages.indexOf(draft);
    if (index >= 0) chat.messages.splice(index, 1);
    draft = null;
  };

  const saveDraft = (force = false) => {
    if (!draft) return;
    const ts = now();
    if (!force && ts - lastDraftSave < 600) return;
    lastDraftSave = ts;
    try {
      saveChat(chat);
    } catch {
      /* keep the stream alive; the final save is authoritative */
    }
  };

  const handleEvent = (event) => {
    if (draft) {
      if (event.type === 'delta') {
        draft.content += event.text;
        saveDraft();
      } else if (event.type === 'reset') {
        draft.content = '';
        saveDraft(true);
      } else if (event.type === 'image') {
        const image = { ...event };
        delete image.type;
        if (!draft.images.some((item) => item.id === image.id)) {
          draft.images.push(image);
        }
        saveDraft(true);
      }
    }
    emit(event);
  };

  try {
    saveChat(chat);
    await maybeCompressChat(chat, models.llm, signal, emit, { saveSummary: updateSummary });

    // Keep a draft in the chat document while tokens stream. A refresh then
    // reloads what the user has already seen instead of an empty turn.
    draft = { role: 'assistant', content: '', images: [], ts: now(), draft: true };
    chat.messages.push(draft);

    const { text } = await runAgent({
      user,
      chat,
      models,
      refId: references[0]?.id || null,
      refIds: references.map((ref) => ref.id),
      references,
      options,
      turnId,
      countBudget: options.count || null,
      userText: message,
      emit: handleEvent,
      signal,
      turnImages,
    });

    draft.content = text;
    draft.images = turnImages;
    delete draft.draft;
    if (!draft.content && !draft.images.length) {
      removeDraft();
    } else if (turnImages.length) {
      chat.lastImageId = turnImages[turnImages.length - 1].id;
    }
    saveChat(chat);
    if (text) emit({ type: 'text', text });
    emit({ type: 'done', sessionId: chat.id, created: isNew });
  } catch (err) {
    if (draft) {
      draft.images = turnImages;
      if (draft.content.trim() || draft.images.length) {
        delete draft.draft;
        if (draft.images.length) {
          chat.lastImageId = draft.images[draft.images.length - 1].id;
        }
      } else {
        removeDraft();
      }
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
