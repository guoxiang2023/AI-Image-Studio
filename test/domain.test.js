import test from 'node:test';
import assert from 'node:assert/strict';
import {
  normalizeChatOptions,
  normalizeQr,
  normalizeRefIds,
  normalizeRefRoles,
  normalizeTags,
} from '../src/domain/chat-options.js';
import { chatToClient, toLlmHistory } from '../src/domain/chat.js';
import { markdownToHtml } from '../public/js/core/markdown.js';

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
  assert.equal(normalizeChatOptions({ quality: 'xhigh' }).quality, 'xhigh');
  assert.equal(normalizeChatOptions({ quality: 'max' }).quality, 'max');
  assert.deepEqual(
    normalizeRefIds(['a'.repeat(16), 'a'.repeat(16), 'b'.repeat(16), 'bad']),
    ['a'.repeat(16), 'b'.repeat(16)],
  );
  assert.deepEqual(normalizeRefRoles(['角色', '非法'], 3), ['角色', '参考', '参考']);
  assert.deepEqual(normalizeTags(' 霓虹, 霓虹, 夜景 ， 电影感 '), ['霓虹', '夜景', '电影感']);
});

test('normalizes QR links and rejects unsafe schemes', () => {
  assert.deepEqual(
    normalizeQr({
      url: 'https://example.com/benefit?from=poster',
      position: 'bottom-center',
      size: 'large',
    }),
    {
      url: 'https://example.com/benefit?from=poster',
      position: 'bottom-center',
      size: 'large',
    },
  );
  assert.deepEqual(normalizeQr('https://example.com'), {
    url: 'https://example.com/',
    position: 'bottom-right',
    size: 'medium',
  });
  assert.equal(normalizeQr('javascript:alert(1)'), null);
  assert.equal(normalizeQr({ url: 'ftp://example.com/file' }), null);
  assert.equal(normalizeQr({ url: 'not a url' }), null);
  assert.deepEqual(normalizeQr({ url: 'https://example.com', position: 'center', size: 'huge' }), {
    url: 'https://example.com/',
    position: 'bottom-right',
    size: 'medium',
  });
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

test('exposes partial drafts but hides empty ones', () => {
  const chat = {
    id: 'chat',
    title: '测试',
    createdAt: 1,
    updatedAt: 2,
    messages: [
      { role: 'user', content: '问题' },
      { role: 'assistant', content: '', images: [], draft: true },
      { role: 'assistant', content: '中断前的回复', images: [], draft: true },
    ],
  };
  const client = chatToClient(chat);
  assert.equal(client.messages.length, 2);
  assert.equal(client.messages[1].content, '中断前的回复');
  assert.equal(toLlmHistory(chat).length, 2);
});

test('renders safe Markdown for conversational answers', () => {
  const html = markdownToHtml(
    '**重点**\n\n- 第一项\n- 第二项\n\n`code`\n\n<script>alert(1)</script>',
  );
  assert.match(html, /<strong>重点<\/strong>/);
  assert.match(html, /<ul><li>第一项<\/li><li>第二项<\/li><\/ul>/);
  assert.match(html, /<code>code<\/code>/);
  assert.doesNotMatch(html, /<script>/);
  assert.match(html, /&lt;script&gt;/);
});

test('renders pipe tables with alignment and inline text', () => {
  const html = markdownToHtml(
    [
      '| 跨页 | 正文 | 图像承担的信息 |',
      '| :--- | :---: | ---: |',
      '| S01 | **文字** | 建立愿望 |',
      '| S02 | `代码` | 动作清楚 |',
    ].join('\n'),
  );
  assert.match(html, /<div class="table-wrap"><table>/);
  assert.match(html, /<th class="align-left">跨页<\/th>/);
  assert.match(html, /<th class="align-center">正文<\/th>/);
  assert.match(html, /<th class="align-right">图像承担的信息<\/th>/);
  assert.match(html, /<td class="align-left">S01<\/td>/);
  assert.match(html, /<strong>文字<\/strong>/);
  assert.match(html, /<code>代码<\/code>/);
  assert.doesNotMatch(html, /\| :---/);
});
