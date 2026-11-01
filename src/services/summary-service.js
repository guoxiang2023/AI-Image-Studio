import {
  SUMMARY_COOLDOWN_MS,
  SUMMARY_ENABLED,
  SUMMARY_INPUT_CHARS,
  SUMMARY_KEEP,
  SUMMARY_MAX_CALLS,
  SUMMARY_TRIGGER,
} from '../config.js';
import { extractError, isAbort, joinUrl, withTimeout } from '../shared/utils.js';

const summaryAttempts = new Map();

function clipText(value, length) {
  const text = String(value || '');
  return text.length > length ? `${text.slice(0, length)}…` : text;
}

function formatSummaryMessage(message) {
  if (message.role === 'user') {
    let text = `用户：${clipText(message.content, 600)}`;
    if (Array.isArray(message.references) && message.references.length) {
      text += `（参考图 ${message.references.map((ref) => `${ref.role || '参考'}:${ref.id}`).join('、')}）`;
    } else if (message.referenceImageId) {
      text += `（参考图 ${message.referenceImageId}）`;
    }
    return text;
  }
  if (message.role === 'assistant') {
    let text = `助手：${clipText(message.content, 600)}`;
    const images = (message.images || [])
      .map((img) => `${img.id}${img.prompt ? `「${clipText(img.prompt, 80)}」` : ''}`)
      .join('；');
    if (images) text += `\n生成图片：${images}`;
    return text;
  }
  return '';
}

async function summarizeConversation(llm, previous, transcript, signal) {
  const prompt = [
    '你在为一段图片创作对话维护长期记忆。请把下面的对话压缩成不超过 300 字的中文摘要。',
    '必须保留：用户的核心需求与偏好（风格、画幅、文字要求）、已经生成或修改过的图片内容、未完成的修改意图。',
    '不要编造。只输出摘要正文，不要加标题。',
    previous ? `\n\n已有摘要：\n${clipText(previous, 1200)}` : '',
    `\n\n新增对话：\n${transcript}`,
  ].join('');

  const res = await fetch(joinUrl(llm.baseUrl, '/chat/completions'), {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${llm.apiKey}`,
    },
    body: JSON.stringify({
      model: llm.model,
      messages: [{ role: 'user', content: prompt }],
      max_tokens: 1024,
      temperature: 0.2,
      stream: false,
    }),
    signal: withTimeout(signal, 60),
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`摘要请求失败 (${res.status})：${extractError(text)}`);
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new Error('摘要接口返回的不是 JSON');
  }
  return String(parsed?.choices?.[0]?.message?.content || '').trim().slice(0, 1200);
}

export async function maybeCompressChat(chat, llm, signal, emit, { saveSummary } = {}) {
  if (!SUMMARY_ENABLED) return;
  if (typeof saveSummary !== 'function') throw new Error('maybeCompressChat 需要 saveSummary');
  const messages = chat.messages || [];
  const start = chat.summaryUpto || 0;
  if (messages.length - start <= SUMMARY_TRIGGER) return;

  const target = messages.length - SUMMARY_KEEP;
  if (target <= start) return;

  const lastAttempt = summaryAttempts.get(chat.id) || 0;
  if (Date.now() - lastAttempt < SUMMARY_COOLDOWN_MS) return;
  summaryAttempts.set(chat.id, Date.now());

  emit?.({ type: 'status', text: '整理较早的对话…' });
  let cursor = start;
  let summary = chat.summary || '';
  let calls = 0;

  try {
    while (cursor < target && calls < SUMMARY_MAX_CALLS) {
      const batch = [];
      let chars = 0;
      while (cursor < target) {
        const text = formatSummaryMessage(messages[cursor]);
        if (text && chars + text.length + 1 > SUMMARY_INPUT_CHARS && batch.length) break;
        if (text) {
          batch.push(text);
          chars += text.length + 1;
        }
        cursor += 1;
      }
      if (!batch.length) break;

      const next = await summarizeConversation(llm, summary, batch.join('\n'), signal);
      if (!next) break;

      summary = next;
      chat.summary = summary;
      chat.summaryUpto = cursor;
      saveSummary(chat.userId, chat.id, summary, cursor);
      calls += 1;
    }

    if (chat.summaryUpto > start) {
      summaryAttempts.delete(chat.id);
      emit?.({ type: 'summary', summary: chat.summary, upto: chat.summaryUpto });
    }
  } catch (err) {
    if (isAbort(err)) throw err;
    console.warn('对话压缩失败:', err.message);
  }
}
