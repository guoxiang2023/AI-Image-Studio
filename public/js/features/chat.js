import {
  autoGrow,
  els,
  notifyUnauthorized,
  scrollBottom,
  setTitle,
  state,
  updateSendButton,
} from '../core/index.js';
import { createAssistantShell, createUserMessage, prependSummaryNote } from './messages.js';
import { clearReference } from './reference.js';
import { markActiveSession, refreshSessions, setSessionInUrl } from './sessions.js';
import { abortStream } from './stream.js';
import { refreshGallery } from './gallery.js';

export async function send() {
  if (state.streaming) {
    abortStream();
    return;
  }

  const text = els.input.value.trim();
  if (!text) return;

  const seq = ++state.streamSeq;
  const references = state.references.map((ref) => ({ ...ref }));
  const userMessage = {
    role: 'user',
    content: text,
    ...(references.length
      ? {
          references,
          referenceImageId: references[0].id,
          referenceUrl: references[0].url,
        }
      : {}),
  };
  state.messages.push(userMessage);
  if (els.messages.classList.contains('is-empty')) {
    els.messages.classList.remove('is-empty');
    els.messages.innerHTML = '';
  }
  els.messages.appendChild(createUserMessage(userMessage));

  els.input.value = '';
  autoGrow();
  clearReference();
  state.streaming = true;
  updateSendButton();
  scrollBottom();

  const shell = createAssistantShell();
  const assistantMessage = { role: 'assistant', content: '', images: [] };
  const controller = new AbortController();
  state.controller = controller;

  let sessionId = state.sessionId;

  const handleEvent = (event) => {
    if (event.type === 'session') {
      sessionId = event.sessionId;
      state.sessionId = event.sessionId;
      setSessionInUrl(event.sessionId);
      if (event.title) setTitle(event.title);
      markActiveSession();
    } else if (event.type === 'status') {
      shell.setStatus(event.text);
    } else if (event.type === 'delta') {
      assistantMessage.content += event.text;
      shell.appendText(event.text);
    } else if (event.type === 'reset') {
      assistantMessage.content = '';
      shell.resetText();
    } else if (event.type === 'image') {
      const image = {
        id: event.id,
        url: event.url,
        prompt: event.prompt,
        size: event.size,
        aspectRatio: event.aspectRatio,
        groupId: event.groupId,
        parentId: event.parentId,
        model: event.model,
        quality: event.quality,
        caption: event.caption,
      };
      assistantMessage.images.push(image);
      shell.addImage(image);
      if (state.view === 'gallery') void refreshGallery();
    } else if (event.type === 'text') {
      assistantMessage.content = event.text;
      shell.setText(event.text);
    } else if (event.type === 'summary') {
      state.summary = event.summary || '';
      state.summaryUpto = event.upto || 0;
      prependSummaryNote();
      scrollBottom();
    } else if (event.type === 'error') {
      shell.setError(event.message);
    } else if (event.type === 'done') {
      sessionId = event.sessionId || sessionId;
      state.sessionId = sessionId;
    }
  };

  try {
    const res = await fetch('/api/chat', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        sessionId,
        message: text,
        ...(state.qr ? { qr: state.qr } : {}),
        ...(references.length
          ? {
              referenceImageIds: references.map((ref) => ref.id),
              referenceRoles: references.map((ref) => ref.role || '参考'),
            }
          : {}),
        options: state.options,
      }),
      signal: controller.signal,
    });

    if (res.status === 401) {
      notifyUnauthorized();
      throw new Error('登录已失效，请重新登录');
    }
    if (!res.ok) {
      const data = await res.json().catch(() => ({}));
      throw new Error(data.error || `请求失败 (${res.status})`);
    }

    await readSSE(res.body, handleEvent);
    shell.finish();
    if (assistantMessage.content || assistantMessage.images.length) {
      state.messages.push(assistantMessage);
    }
  } catch (error) {
    if (error.name === 'AbortError') {
      shell.setError('已停止生成');
    } else {
      shell.setError(error.message);
      shell.finish();
    }
  } finally {
    if (state.streamSeq !== seq) return;
    state.streaming = false;
    state.controller = null;
    updateSendButton();
    if (sessionId) {
      state.sessionId = sessionId;
      await refreshSessions();
      markActiveSession();
    }
    if (state.view === 'gallery') await refreshGallery();
    scrollBottom();
  }
}

export async function readSSE(body, onEvent) {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    let index;
    while ((index = buffer.indexOf('\n\n')) >= 0) {
      const chunk = buffer.slice(0, index);
      buffer = buffer.slice(index + 2);
      for (const line of chunk.split('\n')) {
        if (!line.startsWith('data:')) continue;
        const payload = line.slice(5).trim();
        if (!payload) continue;
        try {
          onEvent(JSON.parse(payload));
        } catch {
          /* ignore malformed event */
        }
      }
    }
  }
}
