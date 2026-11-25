import { CHAT_MAX_CONTINUATIONS, CHAT_MAX_TOKENS } from '../config.js';
import { SYSTEM_PROMPT } from '../ai/prompts.js';
import { streamChatCompletion } from '../ai/llm.js';
import { runTool } from './tools-service.js';
import { buildImageMemory, toLlmHistory } from '../domain/chat.js';
import { recordLlmUsage } from './usage-service.js';
import { friendlyError, parseArgs } from '../shared/utils.js';
import { imageDataUrl } from '../media/image-storage.js';
import { isWorkspaceEnabled, workspaceOverview } from './workspace-service.js';

/**
 * Turns history rows that reference stored images into multimodal messages.
 *
 * Only the newest user message is expanded. Older attachments would be
 * re-sent — and re-billed — on every turn of the conversation, which is the
 * reason a chat model keeps only recent context anyway; the text side keeps
 * the id so the model can still refer to an older image by name. A row keeps
 * its string content when no pixels can be read, so an unreadable or deleted
 * file degrades to what the model saw before instead of failing the turn.
 */
export async function attachReferenceImages(history, userId, { limit = 1, newestOnly = true } = {}) {
  if (!userId || !Array.isArray(history)) return history;

  // "Newest turn" means the last USER message, not the last message holding
  // ids. Selecting the latter kept re-uploading an old image on every later
  // text-only turn: the user asked a follow-up, and the provider was handed a
  // picture from several turns ago.
  let newestUserIndex = -1;
  if (newestOnly) {
    for (let index = history.length - 1; index >= 0; index -= 1) {
      if (history[index]?.role === 'user') {
        newestUserIndex = index;
        break;
      }
    }
  }

  let expanded = 0;
  const rows = [];
  for (let index = history.length - 1; index >= 0; index -= 1) {
    const row = history[index];
    // imageIds is an internal hand-off field. Copying the row wholesale sent it
    // to the provider as an unknown message property.
    const { imageIds, ...outbound } = row || {};
    const ids = Array.isArray(imageIds) ? imageIds : null;
    const eligible =
      ids?.length &&
      expanded < limit &&
      (!newestOnly || index === newestUserIndex);
    if (!eligible) {
      rows.unshift(outbound);
      continue;
    }
    expanded += 1;
    const urls = [];
    for (const id of ids) {
      const url = await imageDataUrl(userId, id).catch(() => null);
      if (url) urls.push(url);
    }
    if (!urls.length) {
      rows.unshift(outbound);
      continue;
    }
    rows.unshift({
      role: outbound.role,
      content: [
        { type: 'text', text: String(outbound.content || '') },
        ...urls.map((url) => ({ type: 'image_url', image_url: { url } })),
      ],
    });
  }
  const result = rows;
  if (history.omitted) result.omitted = history.omitted;
  return result;
}

// A compact, always-present description of the bound directory. It carries no
// file contents: the model must read through tools so the context budget stays
// predictable no matter how large the project is.
export async function describeWorkspace(workspace) {
  // A binding stored by a desktop session must not leak an overview when this
  // process runs without the desktop capability (web/Docker on the same data).
  if (!workspace || !isWorkspaceEnabled()) return '';
  let overview;
  try {
    overview = await workspaceOverview(workspace);
  } catch {
    return '【工作目录】\n（目录当前不可读，可能是权限或已删除；如用户需要，请让用户重新选择目录。）';
  }
  const skip = overview.skipped;
  const skipped = [
    skip.ignored ? `忽略目录 ${skip.ignored}` : '',
    skip.secret ? `凭据文件 ${skip.secret}` : '',
    skip.binary ? `非文本 ${skip.binary}` : '',
    skip.large ? `过大文件 ${skip.large}` : '',
    skip.symlink ? `符号链接 ${skip.symlink}` : '',
  ]
    .filter(Boolean)
    .join('，');
  return [
    '【工作目录】',
    `名称：${overview.name}`,
    `可读文本文件：${overview.files} 个（合计约 ${Math.round(overview.bytes / 1024)}KB）${
      overview.truncated ? '，已达索引上限，仅覆盖一部分' : ''
    }`,
    overview.languages.length ? `主要类型：${overview.languages.join('、')}` : '',
    skipped ? `未纳入：${skipped}` : '',
    '读取方式：先用 search_workspace 或 list_workspace_files 定位，再用 read_workspace_file 取行区间；不要假设没读过的内容。',
  ]
    .filter(Boolean)
    .join('\n');
}

/**
 * Collects image ids a tool produced, so they can be shown to the model.
 *
 * The image cannot ride along inside the tool message: OpenAI's Chat
 * Completions only accepts string/text parts in `role: 'tool'` content, so an
 * `image_url` block there is an invalid request. Every paired tool reply stays
 * text, and one user-role message carrying the pictures is appended after the
 * whole batch — the one shape both protocols accept.
 *
 * Capped per result: a four-image batch would otherwise put four pictures in
 * context, and every one of them is re-sent on each later model call.
 */
export function collectResultImages(result, into, { limit = 2 } = {}) {
  if (!Array.isArray(result?.images)) return;
  for (const image of result.images) {
    if (into.length >= limit) return;
    if (image?.image_id) into.push(image.image_id);
  }
}

/**
 * Appends the batch's generated pictures as one user-role observation.
 *
 * The text names each image so the model can tie a picture to a result even
 * when vision is unavailable; the image blocks come after it.
 *
 * Nothing is appended when no picture could be read: an empty user message
 * would be an invalid request, and a text-only model gains nothing from a
 * second copy of ids it already has in the tool replies.
 */
export async function appendImageObservation(messages, imageIds, userId) {
  if (!userId || !imageIds.length) return;
  const urls = [];
  for (const id of imageIds) {
    const url = await imageDataUrl(userId, id).catch(() => null);
    if (url) urls.push({ id, url });
  }
  if (!urls.length) return;
  messages.push({
    role: 'user',
    content: [
      {
        type: 'text',
        text: `以下是刚才生成的图片（${urls.map((entry) => `image_id=${entry.id}`).join('、')}）。请检查它们是否符合要求，再决定是否需要调整。`,
      },
      ...urls.map((entry) => ({ type: 'image_url', image_url: { url: entry.url } })),
    ],
  });
}

/**
 * Removes image blocks from the conversation, keeping every text part.
 *
 * Used when the provider rejects image input: rather than failing the whole
 * turn, the same conversation is retried as text. Mutates in place because the
 * loop owns the array and must keep using it afterwards.
 */
function stripImages(messages) {
  let removed = 0;
  for (let index = 0; index < messages.length; index += 1) {
    const message = messages[index];
    if (!Array.isArray(message?.content)) continue;
    const kept = message.content.filter((part) => part?.type !== 'image_url');
    removed += message.content.length - kept.length;
    if (!kept.length) {
      messages[index] = { ...message, content: '' };
    } else {
      messages[index] = { ...message, content: kept };
    }
  }
  return removed;
}

export async function runAgent(ctx) {
  const summary = String(ctx.chat.summary || '').trim();
  const imageMemory = buildImageMemory(ctx.chat);
  const history = toLlmHistory(ctx.chat);
  const params = [];
  if (ctx.options?.aspectRatio) params.push(`画幅：${ctx.options.aspectRatio}`);
  if (ctx.options?.count) {
    params.push(
      `本轮总图片数：约 ${ctx.options.count} 张。同一主体的变体可以用一次 generate_image 的 count 表示；多个不同主体则每个主体 1 张，总数不要超过 ${ctx.options.count}。`,
    );
  }
  if (ctx.options?.quality) params.push(`质量：${ctx.options.quality}`);
  const workspaceBlock = await describeWorkspace(ctx.workspace);
  const memory = [
    summary ? `【本会话较早内容的摘要】\n${summary}` : '',
    imageMemory,
    workspaceBlock,
    history.omitted
      ? `【上下文预算提示】有 ${history.omitted} 条较早消息未直接加载；如涉及细节，请依据摘要和图片索引，不要编造。`
      : '',
  ].filter(Boolean);
  const systemBase = memory.length ? `${SYSTEM_PROMPT}\n\n${memory.join('\n\n')}` : SYSTEM_PROMPT;
  const system = params.length
    ? `${systemBase}\n\n【本轮生成参数】\n${params.join('\n')}`
    : systemBase;
  const visionHistory = await attachReferenceImages(history, ctx.user?.id);
  const messages = [{ role: 'system', content: system }, ...visionHistory];
  // Two independent budgets. A tool round and a length continuation are
  // different kinds of work; sharing one counter meant a long answer could be
  // cut short because the model had already called a few tools.
  const maxToolSteps = 6;
  let toolSteps = 0;
  let continuations = 0;
  // One retry for an answer that spent its whole budget on hidden reasoning.
  let answerRetried = false;
  // Text shown by an attempt that was reset for a retry. Kept only as a
  // fallback: if the retry succeeds it re-sends this text and `streamed` wins.
  let discarded = '';
  // Bounds re-issuing a tool call whose arguments were cut off.
  let toolRetries = 0;
  // Set once images have been removed after a provider rejected them, so the
  // fallback runs at most once instead of looping.
  let imagesDropped = false;
  // Image ids produced by the tool batch currently being dispatched. Collected
  // here and attached once, after the last paired reply.
  let producedImages = [];
  // The single accumulator for the answer. Every accepted segment is appended
  // here immediately and nothing downstream replaces it: the persisted message
  // is exactly this string, so any local buffer that gets discarded is output
  // the user watched arrive and then lost.
  let text = '';
  let truncated = false;
  const processParts = [];
  const continuePrompt =
    '上一条回复因为长度限制被截断了。请从断掉的地方继续，直接接着写，不要重复已经输出的内容，也不要重新开头或加任何说明。';

  // The tool budget ran out and the tool-less round still produced no prose.
  // Nothing the tools gathered is persisted — chat history is rebuilt from text
  // only — so ending here loses the whole turn's work and no later "continue"
  // can recover it. One more tools-off attempt re-sends the same in-memory
  // observations, which is the only place those results exist.
  let synthesisTried = false;

  while (toolSteps < maxToolSteps) {
    const lastToolStep = toolSteps >= maxToolSteps - 1;
    if (lastToolStep) {
      // The last round cannot call another tool, so it must produce the answer.
      // Saying so is not decoration: a model that has spent every previous round
      // in "act" mode will otherwise emit an empty turn, and the turn then ends
      // on the generic apology even though it did plenty of work.
      messages.push({
        role: 'user',
        content:
          '工具调用次数已用完。请不要再调用任何工具，直接基于上面已有的工具结果写出最终回答。如果结果不足以覆盖全部问题，就在回答里说明哪些部分还需要更多信息。',
      });
    }
    ctx.emit({ type: 'status', text: toolSteps === 0 ? '理解需求…' : '整理结果…' });
    let streamed = '';
    let response;
    try {
      response = await streamChatCompletion(
        answerRetried ? { ...ctx.models.llm, thinkingDisabled: true } : ctx.models.llm,
        messages,
        {
          signal: ctx.signal,
          // The last round must answer in text instead of asking for another tool.
          tools: !lastToolStep,
          maxTokens: CHAT_MAX_TOKENS,
          onDelta: (delta) => {
            streamed += delta;
            ctx.emit({ type: 'delta', text: delta });
          },
          onReset: () => {
            // A retry re-streams this attempt, so the screen is rebuilt from
            // what is truly committed. The reset carries that prefix because
            // both the draft row and the client replace their visible text with
            // what the event supplies: a bare reset erased it, and an abort
            // right after then finalised an empty draft.
            //
            // What this attempt already showed is parked in `discarded`. The
            // retry normally re-sends it, but if the retry itself fails we must
            // still be able to fall back to text the user actually saw.
            discarded += streamed;
            streamed = '';
            ctx.emit({ type: 'reset', committed: text });
          },
        },
      );
    } catch (err) {
      if (ctx.signal?.aborted) throw err;
      // Some chat models reject image input outright. Sending a generated
      // picture back to the model must never cost the whole turn, so on the
      // first such failure the images are stripped and the same conversation is
      // retried as text. Restricted to a clean attempt: if text was already
      // streamed, retrying would duplicate it on screen.
      if (!imagesDropped && !text && !streamed.trim()) {
        const removed = stripImages(messages);
        if (removed) {
          imagesDropped = true;
          ctx.emit({ type: 'status', text: '当前模型不支持图片输入，改为按文字继续…' });
          continue;
        }
      }
      // Keep everything accepted plus anything this attempt streamed, plus the
      // portion a failed retry never re-sent. Dropping `discarded` here lost
      // output the user had already watched arrive.
      const kept = `${text}${discarded}${streamed}`.trim();
      if (!kept) throw err;
      text = `${kept}\n\n（${friendlyError(err)}，以上内容未完整生成）`;
      break;
    }
    const message = response?.choices?.[0]?.message;
    if (!message) throw new Error('对话模型返回为空');
    // The retry delivered, so anything it re-sent is now in `streamed`; the
    // parked copy must not be appended a second time.
    discarded = '';

    const rawCalls = Array.isArray(message.tool_calls) ? message.tool_calls : [];
    // The final round is sent without tools, yet a model that has spent the
    // whole turn calling them can still answer with an in-band call. The agent
    // loop cannot dispatch it — no round is left — so taking that path ended the
    // turn with an empty answer and the generic apology. On that round the text
    // is the answer, and a call the provider volunteered there has no work to do.
    const calls = lastToolStep ? [] : rawCalls;
    recordLlmUsage({
      userId: ctx.user?.id,
      chatId: ctx.chat?.id,
      turnId: ctx.turnId,
      kind: 'chat',
      model: ctx.models.llm.model,
      providerId: ctx.models.llm.providerId,
      providerName: ctx.models.llm.providerName,
      usage: response.usage,
      messages,
      completionText: message.content,
      toolCalls: rawCalls,
      requestCount: 1,
    });
    if (calls.length) {
      // Fresh per batch: each round observes only what it just produced.
      producedImages = [];
      // A tool call that ends on the token limit carries truncated JSON. Its
      // arguments parse to nothing, so dispatching it would run the tool with
      // defaults — a truncated create_document produces a Word file for a
      // request that asked for a deck. Refuse the call instead and let the
      // model issue it again with a complete payload.
      if (response?.choices?.[0]?.finish_reason === 'length') {
        toolSteps += 1;
        // Bound it: a model that keeps overrunning the budget must not spin.
        if (toolRetries >= CHAT_MAX_CONTINUATIONS) {
          truncated = true;
          break;
        }
        toolRetries += 1;
        messages.push({
          role: 'assistant',
          content: message.content || '',
          tool_calls: calls,
        });
        for (const call of calls) {
          messages.push({
            role: 'tool',
            tool_call_id: call.id,
            content: JSON.stringify({
              error:
                '工具调用的参数因长度限制被截断，没有执行。请重新发起这个工具调用，并减少参数内容或缩短描述。',
            }),
          });
        }
        ctx.emit({ type: 'status', text: '参数被截断，正在重新调用工具…' });
        continue;
      }
      toolSteps += 1;
      // Text before a tool call is analysis, not the final answer. Keep it as
      // the turn's process so the client can show what the model concluded
      // before acting instead of erasing it.
      if (streamed.trim()) {
        processParts.push(streamed.trim());
        ctx.emit({ type: 'reset', keep: true });
      }
      messages.push({
        role: 'assistant',
        content: message.content || '',
        tool_calls: calls,
      });
      for (const call of calls) {
        const args = parseArgs(call.function?.arguments);
        if (!args) {
          // Not cut off, but still unusable: report it rather than guessing.
          messages.push({
            role: 'tool',
            tool_call_id: call.id,
            content: JSON.stringify({ error: '工具参数不是有效的 JSON 对象，没有执行。请重新发起。' }),
          });
          continue;
        }
        // A tool failure belongs to the tool, not to the turn. The image tools
        // talk to a remote endpoint and throw on any provider error; without
        // this guard an unreachable image host ended the whole turn with a bare
        // "网络错误", discarding analysis the model had already produced.
        // Contained here rather than in runTool because the style studio also
        // calls runTool and turns a returned { error } into an HTTP 400 — a
        // provider outage must stay a 500 for that caller.
        let result;
        try {
          result = await runTool(call.function?.name, args, ctx);
        } catch (err) {
          // Aborting is not a tool failure: it must unwind the turn.
          if (ctx.signal?.aborted) throw err;
          result = { error: friendlyError(err) };
        }
        messages.push({
          role: 'tool',
          tool_call_id: call.id,
          content: JSON.stringify(result),
        });
        collectResultImages(result, producedImages);
      }
      // One observation message for the whole batch, after every paired tool
      // reply. OpenAI rejects image blocks inside a tool message, so this is the
      // only placement both protocols accept.
      await appendImageObservation(messages, producedImages, ctx.user?.id);
      continue;
    }

    const segment = String(message.content || streamed || '').trim();
    const finish = response?.choices?.[0]?.finish_reason;

    // An empty reply that ended on the token limit is not an empty answer: the
    // budget was consumed by hidden reasoning before any visible text was
    // written. Ending here produced a generic apology, or silently stopped a
    // continuation mid-answer. Retry once with reasoning disabled so the
    // budget goes to the text the user asked for.
    if (!segment && finish === 'length') {
      if (!answerRetried) {
        answerRetried = true;
        messages.push({
          role: 'user',
          content:
            '上一条回复没有产生任何正文（输出预算被推理耗尽）。请直接给出正文，不要输出推理过程，也不要复述任务。',
        });
        ctx.emit({ type: 'status', text: '正在重新生成正文…' });
        continue;
      }
      // Still empty: report the exhaustion instead of pretending it finished.
      truncated = true;
      break;
    }
    if (!segment) break;

    // A continuation that replays earlier text is not progress. It is dropped
    // from the answer (not appended) and ends the loop as a real cut.
    const repeated = segment.length > 20 && text.includes(segment);
    if (!repeated) text = text ? `${text}${segment}` : segment;

    const cut = response?.choices?.[0]?.finish_reason === 'length';
    if (cut && !repeated && continuations < CHAT_MAX_CONTINUATIONS) {
      continuations += 1;
      messages.push({ role: 'assistant', content: segment });
      messages.push({ role: 'user', content: continuePrompt });
      ctx.emit({ type: 'status', text: `继续输出（第 ${continuations} 段）…` });
      continue;
    }
    if (cut) truncated = true;
    break;
  }

  if (truncated) {
    // Say so once, plainly, rather than leaving the user to discover the cut.
    // The count describes what was actually accepted, not what was attempted.
    const reason =
      continuations >= CHAT_MAX_CONTINUATIONS
        ? `已自动续写 ${continuations} 段后到达上限`
        : '模型再次输出相同内容，自动续写已停止';
    text = `${text}\n\n（内容较长，${reason}；如需更多请回复「继续」。）`;
  }
  if (!text && toolSteps > 0 && !synthesisTried) {
    // The loop spent its budget on tools and never wrote the answer. Everything
    // those tools returned exists only in `messages`, which dies with this call,
    // so a later "continue" would start from nothing. Ask once more, with the
    // observations still in hand.
    synthesisTried = true;
    messages.push({
      role: 'user',
      content:
        '现在直接写最终回答。只依据上面已经拿到的工具结果，不要调用工具，也不要再重新检索；结果不足以回答的部分就直说。',
    });
    ctx.emit({ type: 'status', text: '正在整理最终回答…' });
    try {
      const retry = await streamChatCompletion(
        { ...ctx.models.llm, thinkingDisabled: true },
        messages,
        {
          signal: ctx.signal,
          tools: false,
          maxTokens: CHAT_MAX_TOKENS,
          onDelta: (delta) => {
            text += delta;
            ctx.emit({ type: 'delta', text: delta });
          },
          onReset: () => {
            text = '';
            ctx.emit({ type: 'reset', committed: '' });
          },
        },
      );
      recordLlmUsage({
        userId: ctx.user?.id,
        chatId: ctx.chat?.id,
        turnId: ctx.turnId,
        kind: 'chat',
        model: ctx.models.llm.model,
        providerId: ctx.models.llm.providerId,
        providerName: ctx.models.llm.providerName,
        usage: retry.usage,
        messages,
        completionText: retry?.choices?.[0]?.message?.content,
        toolCalls: [],
        requestCount: 1,
      });
      text = String(retry?.choices?.[0]?.message?.content || '').trim();
    } catch (err) {
      if (ctx.signal?.aborted) throw err;
      // A failed last attempt must not lose the turn: fall through to the
      // explanation below, which still reports that the work was done.
      text = '';
    }
  }
  if (!text) {
    // The turn did work but produced no prose. Say what actually happened
    // instead of claiming the request was not understood: the tool results are
    // gone once this call returns, so promising a later "continue" would be a
    // promise this code cannot keep.
    text = ctx.createdDocuments
      ? '文档已生成，可在「我的文档」中查看和下载。'
      : ctx.turnImages?.length
        ? '图片已生成。'
        : toolSteps > 0
          ? `这一轮调用了 ${toolSteps} 次工具，但模型没有产出结论，所以没有可交付的分析。工具结果不会保留到下一轮，建议重新提问一次，或把范围缩小到具体模块再试。`
          : '抱歉，我没有理解你的需求，可以换个说法再试一次。';
  }
  return { text, process: processParts.join('\n\n') };
}
