import {
  DOCUMENT_BRIEF_INPUT_CHARS,
  DOCUMENT_BRIEF_MAX_CHARS,
  DOCUMENT_BRIEF_MAX_TOKENS,
  DOCUMENT_PLAN_CHARS,
} from '../config.js';
import {
  buildDocumentBriefMessages,
  buildDocumentMergeMessages,
} from '../domain/document.js';

// Stage names submitted to the tracked request factory, and the only ones this
// module uses: one row per chunk summary, one per merge group.
const STAGE_SUMMARY = 'document.brief.summary';
const STAGE_MERGE = 'document.brief.merge';

// Independent chunk summaries, and independent merge groups, run this wide.
const CONCURRENCY = 3;

// Sources shorter than this carry less than the instruction wrapper around
// them, so they pass through instead of paying for a request.
const TINY_SOURCE_CHARS = 400;

// One request must hold a whole group: the merge instructions, the labels, and
// the summaries themselves.
const MERGE_WRAPPER_CHARS = 320;
const LABEL_CHARS = 20;

// The 【摘要覆盖】 header plus the newline before the body.
const HEADER_RESERVE = 240;

const MIN_MERGE_CHARS = 400;
const MAX_MERGE_INPUT_CHARS = Math.max(DOCUMENT_PLAN_CHARS, DOCUMENT_BRIEF_INPUT_CHARS);
const MAX_SUMMARY_CHARS = Math.floor((MAX_MERGE_INPUT_CHARS - MERGE_WRAPPER_CHARS) / 2) - LABEL_CHARS;
const SUMMARY_FLOOR_CHARS = 600;
const SUMMARY_CEILING_CHARS = 2200;
const CLIPPED_FINISH = 'length';

// Coverage header markers. A complete brief contains COMPLETE_MARKER; any
// degradation is stated in the same line instead, so the text never claims
// full coverage for a run that lost something.
const COVERAGE_PREFIX = '【摘要覆盖】';
const COMPLETE_MARKER = '全部纳入主题摘要';
const DEGRADED_MARKER = '覆盖不完整';

function clipHead(value, limit) {
  const text = String(value || '');
  const max = Math.max(0, Math.floor(limit));
  return text.length > max ? text.slice(0, max) : text;
}

/**
 * Deterministic head+tail excerpt. The tail matters because models budget
 * output tokens from the top, so a failed or clipped pass loses the end first.
 */
function excerptText(value, limit) {
  const text = String(value || '');
  const max = Math.max(0, Math.floor(limit));
  if (text.length <= max) return text;
  if (max <= 3) return text.slice(0, max);
  const marker = '\n…\n';
  const available = Math.max(0, max - marker.length);
  const head = Math.ceil(available * 0.6);
  const tail = available - head;
  return `${text.slice(0, head)}${marker}${tail > 0 ? text.slice(-tail) : ''}`;
}

/**
 * Deterministic stand-in for merges that cannot be run: one bounded excerpt per
 * input, so no input disappears and the result fits the budget it replaces.
 */
function condense(texts, limit) {
  const items = (Array.isArray(texts) ? texts : [])
    .map((text) => String(text || ''))
    .filter(Boolean);
  if (!items.length) return '';
  const max = Math.max(0, Math.floor(limit));
  const joined = items.join('\n\n');
  if (joined.length <= max) return joined;
  const perItem = Math.max(
    0,
    Math.floor((max - (items.length - 1) * 2) / items.length),
  );
  return clipHead(items.map((text) => excerptText(text, perItem)).join('\n\n'), max);
}


/**
 * Contiguous, order-preserving groups sized so every merge request holds its
 * whole input: an even partition never leaves a group larger than `perGroup`,
 * so each group's text stays inside the merge input ceiling and the pass
 * reduces the item count (`<= ceil(n / 2)` groups).
 */
function groupOrdered(items) {
  const count = items.length;
  let longest = 0;
  for (const item of items) longest = Math.max(longest, item.length);
  const payload = MAX_MERGE_INPUT_CHARS - MERGE_WRAPPER_CHARS;
  if (payload <= 0 || longest * 2 + LABEL_CHARS * 2 > payload) return null;
  const perGroup = Math.max(2, Math.floor(payload / (longest + LABEL_CHARS)));
  // Balanced partition into exactly `ceil(count / perGroup)` groups: every
  // group holds at most `perGroup` items, so its text stays inside the merge
  // input ceiling, and there are never `count` groups, so the pass shrinks.
  const groupCount = Math.max(1, Math.ceil(count / perGroup));
  const groups = [];
  let start = 0;
  for (let index = 0; index < groupCount; index += 1) {
    const size = Math.ceil((count - start) / (groupCount - index));
    groups.push(items.slice(start, start + size));
    start += size;
  }
  return groups;
}

/** Ordered map with a hard in-flight cap; rejects as soon as any worker does. */
async function mapLimit(items, limit, fn) {
  const results = new Array(items.length);
  const width = Math.max(1, Math.min(limit, items.length));
  let cursor = 0;
  const worker = async () => {
    while (true) {
      const index = cursor;
      cursor += 1;
      if (index >= items.length) return;
      results[index] = await fn(items[index]);
    }
  };
  await Promise.all(Array.from({ length: width }, worker));
  return results;
}

function joinedLength(items) {
  return items.reduce((length, item) => length + item.length, 2 * (items.length - 1));
}

function briefCoverage(chunks, degraded) {
  const notes = [];
  if (degraded.partialChunks) {
    notes.push(`${degraded.partialChunks} 个片段的摘要不完整（请求失败或输出被截断），仅保留节选`);
  }
  if (degraded.mergeFallbacks) {
    notes.push(`${degraded.mergeFallbacks} 次合并未返回可用摘要，相关片段以节选代替`);
  }
  if (degraded.clippedMerges) {
    notes.push(`${degraded.clippedMerges} 个分组无法继续合并，仅保留节选`);
  }
  if (degraded.truncated) notes.push('最终摘要按长度上限截断');
  const issue = notes.length ? `对话摘要${DEGRADED_MARKER}：${notes.join('；')}` : '';
  return {
    header: `${COVERAGE_PREFIX}共处理 ${chunks} 个对话片段，${issue || COMPLETE_MARKER}。`,
    issues: issue ? [issue] : [],
  };
}

export async function buildDocumentBrief(chunks, request, llm, signal) {
  const sources = [];
  for (const chunk of Array.isArray(chunks) ? chunks : []) {
    const text = String(chunk ?? '').trim();
    if (text) sources.push(text);
  }

  const maxChars = Math.max(
    1,
    Math.min(DOCUMENT_BRIEF_MAX_CHARS, DOCUMENT_PLAN_CHARS),
  );
  const degraded = {
    partialChunks: 0,
    mergeFallbacks: 0,
    clippedMerges: 0,
    truncated: false,
  };


  if (!sources.length) return { text: '', issues: [] };

  // A cancelled run must throw even when every chunk is short enough to need no
  // request: the export must not continue towards a finished document.
  signal?.throwIfAborted();

  // A chunk summary only needs its share of the final brief: the plan prompt
  // cannot use more than that. Two summaries plus their labels must also still
  // fit one merge request, otherwise no merge can read them in full.
  const summaryBudget = Math.max(
    SUMMARY_FLOOR_CHARS,
    Math.min(
      SUMMARY_CEILING_CHARS,
      MAX_SUMMARY_CHARS,
      Math.floor(maxChars / Math.max(2, Math.ceil(sources.length / 2))),
    ),
  );

  const invoke = async (stage, messages) => {
    signal?.throwIfAborted();
    let response;
    try {
      response = await request(stage, llm, messages, {
        tools: false,
        maxTokens: DOCUMENT_BRIEF_MAX_TOKENS,
        temperature: 0.2,
        signal,
      });
    } catch (err) {
      // A cancelled run is not a degraded run: it stops the whole export.
      if (signal?.aborted) throw err;
      console.warn(`文档主题摘要降级(${stage}):`, err?.message || err);
      return { text: '', finish: 'error' };
    }
    return {
      text: String(response?.choices?.[0]?.message?.content || '').trim(),
      finish: String(response?.choices?.[0]?.finish_reason || ''),
    };
  };

  // The prompt target is not a storage limit. Keep a finished answer intact
  // when it still fits the next merge, even if it exceeds its requested share.
  const summaries = await mapLimit(sources, CONCURRENCY, async (source) => {
    const input =
      source.length > DOCUMENT_BRIEF_INPUT_CHARS
        ? excerptText(source, DOCUMENT_BRIEF_INPUT_CHARS)
        : source;
    if (input.length !== source.length) degraded.partialChunks += 1;
    if (input.length <= TINY_SOURCE_CHARS) return input;
    const answer = await invoke(
      STAGE_SUMMARY,
      buildDocumentBriefMessages({ chunk: input, maxChars: summaryBudget }),
    );
    if (!answer.text) {
      degraded.partialChunks += 1;
      return excerptText(input, summaryBudget);
    }
    if (answer.finish === CLIPPED_FINISH) {
      degraded.partialChunks += 1;
      const head = Math.floor(summaryBudget / 2);
      const tail = Math.max(0, summaryBudget - head - 40);
      return clipHead(
        `${clipHead(answer.text, head)}\n\n【原文要点补充】\n${excerptText(input, tail)}`,
        summaryBudget,
      );
    }
    if (answer.text.length > MAX_SUMMARY_CHARS) degraded.partialChunks += 1;
    return excerptText(answer.text, MAX_SUMMARY_CHARS);
  });

  // Usually a single level fits. For very long chats, merge neighbouring
  // groups at a readable size before asking for their final synthesis.
  const available = maxChars - HEADER_RESERVE;
  let level = summaries;
  while (level.length > 1 && joinedLength(level) > available) {
    const groups = groupOrdered(level);
    if (!groups) {
      degraded.truncated = true;
      level = [condense(level, available)];
      break;
    }
    const share = Math.floor((available - 2 * (groups.length - 1)) / groups.length);
    const ceiling = groups.length === 1 ? available : MAX_SUMMARY_CHARS;
    const budget = Math.min(ceiling, share >= MIN_MERGE_CHARS ? share : summaryBudget);
    level = await mapLimit(groups, CONCURRENCY, async (group) => {
      if (joinedLength(group) <= budget) return group.join('\n\n');
      const messages = buildDocumentMergeMessages({ summaries: group, maxChars: budget });
      let answer = await invoke(STAGE_MERGE, messages);
      const usable = (result) => result.text && result.finish !== CLIPPED_FINISH && result.text.length <= ceiling;
      if (usable(answer)) return answer.text;
      if (answer.finish === CLIPPED_FINISH || answer.text) {
        const items = Math.max(3, Math.floor(Math.min(budget, 1800) / 45));
        messages.at(-1).content += `\n\n只输出最多 ${items} 条不超过 40 字的短句，每句一行。先删重复材料，禁止展开论证。`;
        answer = await invoke(STAGE_MERGE, messages);
        if (usable(answer)) return answer.text;
      }
      if (answer.text && answer.finish !== CLIPPED_FINISH) degraded.clippedMerges += 1;
      else degraded.mergeFallbacks += 1;
      return condense(group, Math.min(budget, ceiling));
    });
  }
  let body = level.join('\n\n');

  let coverage = briefCoverage(sources.length, degraded);
  if (body.length > maxChars - coverage.header.length - 1) {
    degraded.truncated = true;
    coverage = briefCoverage(sources.length, degraded);
    body = clipHead(body, Math.max(0, maxChars - coverage.header.length - 1));
  }
  return {
    text: body ? `${coverage.header}\n${body}` : coverage.header,
    issues: coverage.issues,
  };
}
