import { findImageFile } from '../media/image-storage.js';
import { findDocument } from '../media/document-storage.js';
import { DOC_ATTACHMENT_CHARS, DOC_ATTACHMENT_TOTAL } from '../config.js';
import {
  normalizeAttachmentIds,
  normalizeChatOptions,
  normalizeQr,
  normalizeRefIds,
  normalizeRefRoles,
} from '../domain/chat-options.js';
import { AppError } from '../shared/errors.js';
import { clipText, friendlyError, newId, now } from '../shared/utils.js';
import { runAgent } from './agent-service.js';
import {
  loadChatForUser,
  newChatForUser,
  saveChat,
  updateSummary,
} from './chat-service.js';
import { loadSettings } from './model-settings-service.js';
import { maybeCompressChat } from './summary-service.js';
import { workspaceFromChat } from './workspace-service.js';

export async function prepareChatTurn(user, body) {
  const message = String(body.message || '').trim();
  const attachmentIds = normalizeAttachmentIds(body.attachmentIds);
  const refIds = normalizeRefIds(
    Array.isArray(body.referenceImageIds) ? body.referenceImageIds : body.referenceImageId,
  );
  if (!message && !attachmentIds.length && !refIds.length) {
    throw new AppError(400, '消息不能为空');
  }

  const attachments = [];
  if (attachmentIds.length) {
    const perDocument = Math.min(
      DOC_ATTACHMENT_CHARS,
      Math.floor(DOC_ATTACHMENT_TOTAL / attachmentIds.length),
    );
    for (const id of attachmentIds) {
      const document = await findDocument(user.id, id);
      if (!document) throw new AppError(400, '附件已失效，请重新上传');
      const truncated = document.text.length > perDocument;
      attachments.push({
        id: document.id,
        name: document.name,
        ext: document.ext,
        kind: document.kind,
        size: document.size,
        chars: document.chars,
        images: Array.isArray(document.images) ? document.images : [],
        text: truncated
          ? `${document.text.slice(0, perDocument)}\n…（附件内容过长，已截断）`
          : document.text,
        truncated,
      });
    }
  }

  const models = loadSettings(user.id);
  if (!models.llm.apiKey) {
    throw new AppError(400, '请先在「模型设置」中配置对话模型 API Key');
  }

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

  // The chat is loaded or created LAST, with no await after it.
  //
  // Creating it earlier inserted the row before the reference lookups finished,
  // so its id was already listed by /api/sessions while this turn still had I/O
  // to do. A second tab could then load that chat, run a complete turn, and this
  // caller would go on to save its stale empty snapshot over it. Everything
  // awaits first; the row appears only when the caller is about to claim it.
  let chat = body.sessionId ? loadChatForUser(user.id, body.sessionId) : null;
  const isNew = !chat;
  if (!chat) chat = newChatForUser(user.id);
  if (!chat.title) {
    chat.title =
      clipText(message, 30) ||
      clipText(attachments[0]?.name || '', 30) ||
      (refIds.length ? '图片对话' : '附件对话');
  }

  return {
    message,
    models,
    chat,
    isNew,
    references,
    attachments,
    options,
    workspace: workspaceFromChat(chat),
    turnId: newId(),
  };
}

export async function runPreparedTurn({ user, prepared, emit, signal }) {
  const { message, models, chat, isNew, references, attachments, options, turnId } = prepared;
  // Resolved at execution time through the single capability gate. The turn is
  // prepared and run in the same process, but re-deriving here keeps the row
  // from acting as authority: a binding made by a desktop session is ignored by
  // a web/Docker deployment that shares the same DATA_DIR.
  const workspace = workspaceFromChat(chat);
  const startedAt = Date.now();
  const elapsedMs = () => Math.max(0, Date.now() - startedAt);

  emit({ type: 'session', sessionId: chat.id, title: chat.title });

  const userMessage = { role: 'user', content: message, ts: now() };
  if (attachments.length) userMessage.attachments = attachments;
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
    draft.durationMs = elapsedMs();
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
        if (event.keep) {
          // Analysis shown before a tool call becomes process, not the answer.
          const kept = draft.content.trim();
          if (kept) {
            draft.process = draft.process ? `${draft.process}\n\n${kept}` : kept;
          }
          draft.content = '';
        } else {
          // A retry re-streams only the current attempt. Text already accepted
          // from earlier segments must survive the reset, otherwise an abort
          // or a failed retry finalises an empty draft and deletes it.
          draft.content = String(event.committed || '');
        }
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
    draft = {
      role: 'assistant',
      content: '',
      images: [],
      ts: now(),
      durationMs: 0,
      draft: true,
    };
    chat.messages.push(draft);

    const { text, process } = await runAgent({
      user,
      chat,
      models,
      refId: references[0]?.id || null,
      refIds: references.map((ref) => ref.id),
      references,
      options,
      workspace,
      turnId,
      countBudget: options.count || null,
      userText: message,
      emit: handleEvent,
      signal,
      turnImages,
    });

    const durationMs = elapsedMs();
    const finishedAt = now();
    draft.content = text;
    if (process) draft.process = process;
    draft.images = turnImages;
    draft.ts = finishedAt;
    draft.durationMs = durationMs;
    delete draft.draft;
    if (!draft.content && !draft.images.length) {
      removeDraft();
    } else if (turnImages.length) {
      chat.lastImageId = turnImages[turnImages.length - 1].id;
    }
    saveChat(chat);
    if (text) emit({ type: 'text', text });
    emit({ type: 'done', sessionId: chat.id, created: isNew, durationMs, ts: finishedAt });
  } catch (err) {
    const durationMs = elapsedMs();
    const finishedAt = now();
    if (draft) {
      draft.images = turnImages;
      draft.ts = finishedAt;
      draft.durationMs = durationMs;
      if (draft.content.trim() || draft.images.length) {
        delete draft.draft;
        if (draft.images.length) {
          chat.lastImageId = draft.images[draft.images.length - 1].id;
        }
      } else {
        removeDraft();
      }
    }
    // Guarded: every real caller passes an AbortSignal, but a missing one used
    // to throw inside this catch block — turning a reportable turn failure into
    // an unhandled rejection that swallowed both the error and the `done` event.
    const aborted = signal?.aborted === true;
    if (!aborted) {
      emit({ type: 'error', message: friendlyError(err) });
    }
    try {
      saveChat(chat);
    } catch {
      /* best effort */
    }
    emit({
      type: 'done',
      sessionId: chat.id,
      created: isNew,
      aborted,
      durationMs,
      ts: finishedAt,
    });
  }
}
