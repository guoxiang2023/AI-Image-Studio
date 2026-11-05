import { SYSTEM_PROMPT } from '../ai/prompts.js';
import { streamChatCompletion } from '../ai/llm.js';
import { runTool } from './tools-service.js';
import { buildImageMemory, toLlmHistory } from '../domain/chat.js';
import { recordLlmUsage } from './usage-service.js';
import { friendlyError, parseArgs } from '../shared/utils.js';

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
  const memory = [
    summary ? `【本会话较早内容的摘要】\n${summary}` : '',
    imageMemory,
    history.omitted
      ? `【上下文预算提示】有 ${history.omitted} 条较早消息未直接加载；如涉及细节，请依据摘要和图片索引，不要编造。`
      : '',
  ].filter(Boolean);
  const systemBase = memory.length ? `${SYSTEM_PROMPT}\n\n${memory.join('\n\n')}` : SYSTEM_PROMPT;
  const system = params.length
    ? `${systemBase}\n\n【本轮生成参数】\n${params.join('\n')}`
    : systemBase;
  const messages = [{ role: 'system', content: system }, ...history];
  const maxSteps = 6;
  let text = '';

  for (let step = 0; step < maxSteps; step += 1) {
    ctx.emit({ type: 'status', text: step === 0 ? '理解需求…' : '整理结果…' });
    let streamed = '';
    let response;
    try {
      response = await streamChatCompletion(ctx.models.llm, messages, {
        signal: ctx.signal,
        // The last round must answer in text instead of asking for another tool.
        tools: step < maxSteps - 1,
        maxTokens: 4096,
        onDelta: (delta) => {
          streamed += delta;
          ctx.emit({ type: 'delta', text: delta });
        },
        onReset: () => {
          streamed = '';
          ctx.emit({ type: 'reset' });
        },
      });
    } catch (err) {
      if (ctx.signal?.aborted || !streamed.trim()) throw err;
      // All retries failed after a partial answer arrived. Keep what the user
      // already saw instead of replacing the whole turn with an error.
      text = `${streamed.trim()}\n\n（${friendlyError(err)}，以上内容未完整生成）`;
      break;
    }
    const message = response?.choices?.[0]?.message;
    if (!message) throw new Error('对话模型返回为空');

    const calls = Array.isArray(message.tool_calls) ? message.tool_calls : [];
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
      toolCalls: calls,
      requestCount: 1,
    });
    if (calls.length) {
      // Any text before a tool call is a preamble, not the final answer.
      if (streamed.trim()) ctx.emit({ type: 'reset' });
      messages.push({
        role: 'assistant',
        content: message.content || '',
        tool_calls: calls,
      });
      for (const call of calls) {
        const args = parseArgs(call.function?.arguments);
        const result = await runTool(call.function?.name, args, ctx);
        messages.push({
          role: 'tool',
          tool_call_id: call.id,
          content: JSON.stringify(result),
        });
      }
      continue;
    }

    text = String(message.content || streamed || '').trim();
    break;
  }

  if (!text) {
    text = ctx.turnImages.length ? '图片已生成。' : '抱歉，我没有理解你的需求，可以换个说法再试一次。';
  }
  return { text };
}
