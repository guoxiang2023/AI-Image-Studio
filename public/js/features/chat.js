import {
  autoGrow,
  els,
  notifyUnauthorized,
  scrollBottom,
  setTitle,
  state,
  toast,
} from '../core/index.js';
import { createAssistantShell, createUserMessage, prependSummaryNote } from './messages.js';
import { clearAttachments } from './attachments.js';
import { clearReference } from './reference.js';
import { markActiveSession, refreshSessions, setSessionInUrl } from './sessions.js';
import {
  activeStream,
  ensureStreamShell,
  streamForSession,
  syncStreamingState,
} from './stream.js';
import { refreshGallery } from './gallery.js';

export async function send() {
  const running = activeStream();
  if (running) {
    running.controller.abort();
    return;
  }
  if (state.sessionId && streamForSession(state.sessionId)) {
    toast('当前会话正在生成，请稍候');
    return;
  }

  const text = els.input.value.trim();
  if (!text && !state.references.length && !state.attachments.length) return;

  const seq = ++state.streamSeq;
  const references = state.references.map((ref) => ({ ...ref }));
  const attachments = state.attachments.map((attachment) => ({ ...attachment }));
  const userMessage = {
    role: 'user',
    content: text,
    ts: Date.now(),
    ...(references.length
      ? {
          references,
          referenceImageId: references[0].id,
          referenceUrl: references[0].url,
        }
      : {}),
    ...(attachments.length ? { attachments } : {}),
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
  clearAttachments();
  scrollBottom();

  const stream = {
    seq,
    viewSeq: state.viewSeq,
    sessionId: state.sessionId,
    controller: new AbortController(),
    startedAt: Date.now(),
    finishedAt: 0,
    durationMs: 0,
    content: '',
    images: [],
    status: '思考中…',
    error: '',
    done: false,
    shell: null,
  };
  state.streams.set(seq, stream);
  stream.shell = createAssistantShell({ startedAt: stream.startedAt });
  syncStreamingState();

  const sameView = () => stream.viewSeq === state.viewSeq;

  const handleEvent = (event) => {
    if (event.type === 'session') {
      stream.sessionId = event.sessionId;
      if (sameView()) {
        state.sessionId = event.sessionId;
        setSessionInUrl(event.sessionId);
        if (event.title) setTitle(event.title);
        markActiveSession();
      }
    } else if (event.type === 'status') {
      stream.status = event.text;
      if (sameView()) ensureStreamShell(stream)?.setStatus(event.text);
    } else if (event.type === 'delta') {
      stream.content += event.text;
      if (sameView()) ensureStreamShell(stream)?.appendText(event.text);
    } else if (event.type === 'reset') {
      stream.content = '';
      if (sameView()) ensureStreamShell(stream)?.resetText();
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
      stream.images.push(image);
      if (sameView()) ensureStreamShell(stream)?.addImage(image);
      if (state.view === 'gallery') void refreshGallery();
    } else if (event.type === 'text') {
      stream.content = event.text;
      if (sameView()) ensureStreamShell(stream)?.setText(event.text);
    } else if (event.type === 'document') {
      const document = event.document || {};
      toast(`文档已生成：${document.title || '文档'}，可在「我的文档」查看`);
    } else if (event.type === 'summary') {
      if (!sameView()) return;
      state.summary = event.summary || '';
      state.summaryUpto = event.upto || 0;
      prependSummaryNote();
      scrollBottom();
    } else if (event.type === 'error') {
      stream.error = event.message;
      if (sameView()) ensureStreamShell(stream)?.setError(event.message);
    } else if (event.type === 'done') {
      if (Number.isFinite(Number(event.durationMs))) {
        stream.durationMs = Number(event.durationMs);
      }
      if (Number.isFinite(Number(event.ts))) stream.finishedAt = Number(event.ts);
      if (event.sessionId) stream.sessionId = event.sessionId;
      if (sameView() && stream.finishedAt) {
        ensureStreamShell(stream)?.setTime(stream.finishedAt);
      }
      if (sameView() && stream.sessionId) {
        state.sessionId = stream.sessionId;
        setSessionInUrl(stream.sessionId);
      }
    }
  };

  try {
    const res = await fetch('/api/chat', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        sessionId: stream.sessionId,
        message: text,
        ...(state.qr ? { qr: state.qr } : {}),
        ...(references.length
          ? {
              referenceImageIds: references.map((ref) => ref.id),
              referenceRoles: references.map((ref) => ref.role || '参考'),
            }
          : {}),
        ...(attachments.length ? { attachmentIds: attachments.map((item) => item.id) } : {}),
        options: state.options,
      }),
      signal: stream.controller.signal,
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
    stream.done = true;
    if (!stream.finishedAt) stream.finishedAt = Date.now();
    if (!stream.durationMs) stream.durationMs = Date.now() - stream.startedAt;
    if (sameView()) {
      const shell = ensureStreamShell(stream);
      shell?.setTime(stream.finishedAt);
      shell?.setDuration(stream.durationMs);
      shell?.finish();
      if (stream.content || stream.images.length) {
        state.messages.push({
          role: 'assistant',
          content: stream.content,
          images: stream.images,
          ts: stream.finishedAt,
          durationMs: stream.durationMs,
        });
      }
    }
  } catch (error) {
    if (!state.streams.has(stream.seq)) return;
    if (!stream.finishedAt) stream.finishedAt = Date.now();
    if (!stream.durationMs) stream.durationMs = Date.now() - stream.startedAt;
    stream.error = error.name === 'AbortError' ? '已停止生成' : error.message;
    if (sameView()) {
      const shell = ensureStreamShell(stream);
      if (shell) {
        shell.setError(stream.error);
        shell.setTime(stream.finishedAt);
        shell.setDuration(stream.durationMs);
        shell.finish();
      }
    }
  } finally {
    if (!state.streams.has(stream.seq)) return;
    stream.done = true;
    state.streams.delete(stream.seq);
    syncStreamingState();
    if (stream.sessionId) {
      await refreshSessions();
      if (state.sessionId === stream.sessionId) markActiveSession();
    }
    if (state.view === 'gallery') await refreshGallery();
    if (sameView()) scrollBottom();
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
