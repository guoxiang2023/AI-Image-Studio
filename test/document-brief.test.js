import test from 'node:test';
import assert from 'node:assert/strict';
import { buildDocumentBrief } from '../src/services/document-brief.js';
import { DOCUMENT_BRIEF_MAX_CHARS, DOCUMENT_PLAN_CHARS } from '../src/config.js';

const reply = (text, finish = 'stop') => ({ choices: [{ message: { content: text }, finish_reason: finish }] });

test('independent summaries run concurrently, keep source order and retain a truncated response without replaying its input', async () => {
  const markers = Array.from({ length: 8 }, (_, i) => `来源编号_${i}`);
  const chunks = markers.map((marker) => `${marker}\n${'对话资料。'.repeat(1100)}`);
  let active = 0;
  let peak = 0;
  const seen = [];
  const { text: brief, issues } = await buildDocumentBrief(chunks, async (_stage, _llm, messages) => {
    const match = messages.at(-1).content.match(/来源编号_\d+/);
    assert.ok(match);
    const marker = match[0];
    seen.push(marker);
    peak = Math.max(peak, ++active);
    await new Promise((resolve) => setTimeout(resolve, marker.endsWith('_0') ? 9 : 1));
    active--;
    return reply(`已确认${marker}。`, marker.endsWith('_0') ? 'length' : 'stop');
  }, {}, new AbortController().signal);
  assert.match(issues.join(''), /1 个片段的摘要不完整/);
  assert.deepEqual(seen.sort(), markers);
  assert.ok(peak > 1 && peak <= 3);
  let previous = -1;
  for (const marker of markers) {
    const index = brief.indexOf(marker);
    assert.ok(index > previous, `${marker} remains in source order`);
    previous = index;
  }
});

test('verbose provider output fits the planner budget without replaying uncompressed input', async () => {
  const chunks = Array.from({ length: 34 }, (_, i) => `原始片段_${i}\n${'事实。'.repeat(1800)}`);
  let reads = 0;
  let merges = 0;
  const { text: brief } = await buildDocumentBrief(chunks, async (stage) => {
    if (stage.endsWith('summary')) reads++;
    else merges++;
    return reply('有凭据的结论。'.repeat(1100), 'length');
  }, {}, new AbortController().signal);
  assert.equal(reads, chunks.length);
  assert.ok(merges < chunks.length);
  assert.ok(brief.length > 0 && brief.length <= Math.min(DOCUMENT_PLAN_CHARS, DOCUMENT_BRIEF_MAX_CHARS));
});

test('very long chats retain decisions from the middle of every summary through successive merge levels', async () => {
  const ids = Array.from({ length: 280 }, (_, i) => `合同编号${1000 + i}`);
  const chunks = ids.map((id) => `${'明细'.repeat(250)}签订${id}`);
  const { text: brief, issues } = await buildDocumentBrief(chunks, async (stage, _llm, messages) => {
    const decisions = messages.at(-1).content.match(/合同编号\d+/g);
    // These decisions sit well outside a short head/tail excerpt. Each model
    // merge keeps the contracts in its inputs and drops repetitive context.
    const body = `${'背景'.repeat(100)}${decisions.join('、')}${'说明'.repeat(100)}`;
    return reply(stage.endsWith('summary') ? `${body}${'附注'.repeat(80)}` : body);
  }, {}, new AbortController().signal);
  assert.deepEqual(issues, []);
  assert.deepEqual(brief.match(/合同编号\d+/g), ids);
  assert.ok(brief.length <= Math.min(DOCUMENT_PLAN_CHARS, DOCUMENT_BRIEF_MAX_CHARS));
});

test('completed summaries that exceed the requested share reach the planner without losing interior facts', async () => {
  const ids = Array.from({ length: 20 }, (_, index) => `验收指标${100 + index}`);
  const chunks = ids.map((id) => `${'盘点背景。'.repeat(900)}${id}`);
  const { text, issues } = await buildDocumentBrief(chunks, async (stage, _llm, messages) => {
    const facts = messages.at(-1).content.match(/验收指标\d+/g);
    if (stage.endsWith('summary')) {
      return reply(`${'背景。'.repeat(320)}${facts[0]}${'说明。'.repeat(300)}`);
    }
    return reply(facts.join('、'));
  }, {});
  assert.deepEqual(issues, []);
  assert.deepEqual(text.match(/验收指标\d+/g), ids);
});

test('complete merge responses can use the outline input budget without losing interior facts', async () => {
  const facts = Array.from({ length: 12 }, (_, index) => `独立结论${100 + index}`);
  const chunks = facts.map((fact) => `${'交付背景。'.repeat(200)}${fact}`);
  const { text, issues } = await buildDocumentBrief(chunks, async (stage, _llm, messages) => {
    const found = messages.at(-1).content.match(/独立结论\d+/g);
    if (stage.endsWith('summary')) return reply(`${'范围'.repeat(500)}${found[0]}${'约束'.repeat(500)}`);
    return reply(`${'依据'.repeat(800)}${found.join('、')}${'解释'.repeat(800)}`);
  }, {});
  assert.deepEqual(issues, []);
  assert.deepEqual(text.match(/独立结论\d+/g), facts);
});

test('a truncated merge is recomposed without cutting interior decisions', async () => {
  const facts = Array.from({ length: 12 }, (_, index) => `已定条款${100 + index}`);
  const chunks = facts.map((fact) => `${'合同背景。'.repeat(300)}${fact}`);
  const { text, issues } = await buildDocumentBrief(chunks, async (stage, _llm, messages) => {
    const prompt = messages.at(-1).content;
    const found = prompt.match(/已定条款\d+/g);
    if (stage.endsWith('summary')) return reply(`${'背景'.repeat(380)}${found[0]}${'约束'.repeat(380)}`);
    return /每句一行/.test(prompt) ? reply(found.join('\n')) : reply('未完成的输出', 'length');
  }, {});
  assert.deepEqual(issues, []);
  assert.deepEqual(text.match(/已定条款\d+/g), facts);
});
