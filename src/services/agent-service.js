import { SYSTEM_PROMPT } from '../ai/prompts.js';
import { chatCompletion } from '../ai/llm.js';
import { runTool } from './tools-service.js';
import { toLlmHistory } from '../domain/chat.js';
import { parseArgs } from '../shared/utils.js';
import { skillSystemBlock } from '../domain/skill.js';

export async function runAgent(ctx) {
  const summary = String(ctx.chat.summary || '').trim();
  const params = [];
  if (ctx.options?.aspectRatio) params.push(`画幅：${ctx.options.aspectRatio}`);
  if (ctx.options?.count) {
    params.push(
      `本轮总图片数：约 ${ctx.options.count} 张。同一主体的变体可以用一次 generate_image 的 count 表示；多个不同主体则每个主体 1 张，总数不要超过 ${ctx.options.count}。`,
    );
  }
  if (ctx.options?.quality) params.push(`质量：${ctx.options.quality}`);
  const systemBase =
    (summary
      ? `${SYSTEM_PROMPT}\n\n【本会话较早内容的摘要】\n${summary}`
      : SYSTEM_PROMPT) + skillSystemBlock(ctx.skill);
  const system = params.length
    ? `${systemBase}\n\n【本轮生成参数】\n${params.join('\n')}`
    : systemBase;
  const messages = [{ role: 'system', content: system }, ...toLlmHistory(ctx.chat)];
  let text = '';

  for (let step = 0; step < 5; step += 1) {
    ctx.emit({ type: 'status', text: step === 0 ? '理解需求…' : '整理结果…' });
    const response = await chatCompletion(ctx.models.llm, messages, { signal: ctx.signal });
    const message = response?.choices?.[0]?.message;
    if (!message) throw new Error('对话模型返回为空');

    const calls = Array.isArray(message.tool_calls) ? message.tool_calls : [];
    if (calls.length) {
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

    text = String(message.content || '').trim();
    break;
  }

  if (!text) {
    text = ctx.turnImages.length ? '图片已生成。' : '抱歉，我没有理解你的需求，可以换个说法再试一次。';
  }
  return { text };
}
