import test from 'node:test';
import assert from 'node:assert/strict';
import {
  normalizeChatOptions,
  normalizeRefIds,
  normalizeRefRoles,
  normalizeTags,
} from '../src/domain/chat-options.js';
import { toLlmHistory } from '../src/domain/chat.js';
import { normalizeSkillPayload, skillSystemBlock } from '../src/domain/skill.js';

test('normalizes chat options and references', () => {
  assert.deepEqual(normalizeChatOptions({ aspectRatio: '16:9', count: '9', quality: 'high' }), {
    aspectRatio: '16:9',
    count: 4,
    quality: 'high',
  });
  assert.deepEqual(normalizeChatOptions({ aspectRatio: 'bad', count: 'x', quality: 'ultra' }), {
    aspectRatio: null,
    count: null,
    quality: null,
  });
  assert.deepEqual(
    normalizeRefIds(['a'.repeat(16), 'a'.repeat(16), 'b'.repeat(16), 'bad']),
    ['a'.repeat(16), 'b'.repeat(16)],
  );
  assert.deepEqual(normalizeRefRoles(['角色', '非法'], 3), ['角色', '参考', '参考']);
  assert.deepEqual(normalizeTags(' 霓虹, 霓虹, 夜景 ， 电影感 '), ['霓虹', '夜景', '电影感']);
});

test('normalizes skill payload and renders system block', () => {
  const skill = normalizeSkillPayload({
    name: '电影感',
    instructions: '保持电影感',
    constraints: ['不要文字'],
    defaults: { aspectRatio: '2:3', count: 2, quality: 'high' },
    extra: 'dropped',
  });
  assert.equal(skill.schemaVersion, 1);
  assert.deepEqual(skill.defaults, { aspectRatio: '2:3', count: 2, quality: 'high' });
  assert.equal(skill.extra, undefined);
  assert.match(skillSystemBlock(skill), /不要文字/);
});

test('builds LLM history with summary cutoff and image markers', () => {
  const history = toLlmHistory({
    summaryUpto: 1,
    messages: [
      { role: 'user', content: 'old' },
      { role: 'user', content: 'new', references: [{ id: 'a'.repeat(16), role: '角色' }] },
      { role: 'assistant', content: 'done', images: [{ id: 'b'.repeat(16) }] },
    ],
  });
  assert.equal(history.length, 2);
  assert.match(history[0].content, /参考图/);
  assert.match(history[1].content, /已生成图片/);
});
