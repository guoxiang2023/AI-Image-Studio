import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import sharp from 'sharp';

const dataDir = await mkdtemp(path.join(os.tmpdir(), 'luma-doc-export-'));
process.env.DATA_DIR = dataDir;
test.after(() => rm(dataDir, { recursive: true, force: true }));

test('malformed document plan falls back and still produces a document', async (t) => {
  const [{ initDb, closeDb }, { setSecretBox }, { createSecretBox }] = await Promise.all([
    import('../src/data/database.js'),
    import('../src/shared/runtime.js'),
    import('../src/auth/crypto.js'),
  ]);
  const [{ insertChat }] = await Promise.all([
    import('../src/data/repositories/chats.js'),
  ]);
  const [{ defaultSettings, saveUserSettings }, { runTool }, { listUserDocuments }] =
    await Promise.all([
      import('../src/services/model-settings-service.js'),
      import('../src/services/tools-service.js'),
      import('../src/services/document-library-service.js'),
    ]);

  initDb(dataDir);
  setSecretBox(createSecretBox(Buffer.alloc(32, 7)));

  let requests = 0;
  let lastRequest = null;
  const budgets = [];
  const llm = http.createServer((req, res) => {
    requests += 1;
    const chunks = [];
    req.on('data', (chunk) => chunks.push(chunk));
    req.on('end', () => {
      try {
        lastRequest = JSON.parse(Buffer.concat(chunks).toString('utf8'));
        budgets.push(Number(lastRequest?.max_tokens) || 0);
      } catch {
        lastRequest = null;
      }
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(
        JSON.stringify({
          id: 'mock-malformed-plan',
          object: 'chat.completion',
          choices: [
            {
              index: 0,
              message: { role: 'assistant', content: '这不是一个可用的 JSON 策划。' },
              finish_reason: 'stop',
            },
          ],
          usage: { prompt_tokens: 40, completion_tokens: 10, total_tokens: 50 },
        }),
      );
    });
  });
  await new Promise((resolve) => llm.listen(0, '127.0.0.1', resolve));
  const port = llm.address().port;

  t.after(async () => {
    await new Promise((resolve) => llm.close(resolve));
    closeDb();
  });

  const userId = 'user-plan-test';
  const chatId = 'c'.repeat(24);
  insertChat({
    id: chatId,
    userId,
    title: '终稿测试',
    createdAt: Date.now(),
    updatedAt: Date.now(),
    lastImageId: null,
    coverUrl: null,
    messagesJson: JSON.stringify([
      { role: 'user', content: '做一张海报' },
      { role: 'assistant', content: '已完成' },
    ]),
    summary: '',
    summaryUpto: 0,
  });

  const settings = defaultSettings();
  const provider = {
    ...settings.llm.providers[0],
    id: 'llm-malformed-plan',
    name: 'mock',
    baseUrl: `http://127.0.0.1:${port}`,
    model: 'mock',
    apiKey: 'test-key',
    protocol: 'openai',
    temperature: 0.2,
  };
  settings.llm = {
    ...settings.llm,
    ...provider,
    providers: [provider],
    activeId: provider.id,
  };
  saveUserSettings(userId, settings);

  const result = await runTool('create_document', {}, {
    user: { id: userId },
    chat: { id: chatId },
    signal: undefined,
    emit() {},
  });

  assert.equal(result.error, undefined);
  assert.ok(requests > 1, 'composition must still run after a failed plan');
  assert.ok(budgets[0] <= 4096, 'the outline uses a bounded output budget');
  assert.equal(listUserDocuments(userId).length, 1);
});

test('Word export preserves source evidence and distinguishes partial documents from final ones', async (t) => {
  const [{ initDb, closeDb }, { setSecretBox }, { createSecretBox }] = await Promise.all([
    import('../src/data/database.js'),
    import('../src/shared/runtime.js'),
    import('../src/auth/crypto.js'),
  ]);
  const [{ insertChat }] = await Promise.all([import('../src/data/repositories/chats.js')]);
  const [{ defaultSettings, saveUserSettings }, { runTool }] = await Promise.all([
    import('../src/services/model-settings-service.js'),
    import('../src/services/tools-service.js'),
  ]);

  initDb(dataDir);
  setSecretBox(createSecretBox(Buffer.alloc(32, 7)));

  const stages = [];
  const decisions = ['最初采用人工盘点', '复核发现偏差后改为逐箱扫码', '最终确定使用双人签收'];
  const latestRequest = '文档补齐收货痛点。';
  const observedDecisions = (text) => decisions.filter((decision) => text.includes(decision));
  let replies = [];
  const llm = http.createServer((req, res) => {
    const chunks = [];
    req.on('data', (chunk) => chunks.push(chunk));
    req.on('end', () => {
      const body = JSON.parse(Buffer.concat(chunks).toString());
      stages.push(body.messages.at(-1).content);
      const prompt = body.messages.at(-1).content;
      let answer;
      if (prompt.includes('请把下面的对话片段整理')) {
        const facts = observedDecisions(prompt);
        answer = [facts.filter((fact) => fact !== decisions[2]).join('，') || '常规记录'];
      } else {
        const next = replies.shift();
        answer = typeof next === 'function' ? next(prompt) : next || [];
      }
      const [content = '', finish = 'stop'] = answer;
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(
        JSON.stringify({
          id: 'mock',
          object: 'chat.completion',
          choices: [
            {
              index: 0,
              message: { role: 'assistant', content },
              finish_reason: finish,
            },
          ],
          usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
        }),
      );
    });
  });
  await new Promise((resolve) => llm.listen(0, '127.0.0.1', resolve));
  const port = llm.address().port;

  t.after(async () => {
    await new Promise((resolve) => llm.close(resolve));
    closeDb();
  });

  const userId = 'user-model-test';
  const chatId = 'cd'.repeat(12);
  const { generatedDocumentPath, saveDocument } = await import('../src/media/document-storage.js');
  const { openZip } = await import('../src/media/zip-reader.js');
  const { listUserDocuments, getUserDocument } = await import('../src/services/document-library-service.js');
  const excerpt = '往期运营记录\n'.repeat(800);
  const source = await saveDocument(userId, Buffer.from('test'), {
    name: '库存字典.txt', ext: 'txt', kind: 'text', text: `${excerpt}\nstock_lock_id 表示锁定流水号。`,
  });
  insertChat({
    id: chatId,
    userId,
    title: '普通会话',
    createdAt: Date.now(),
    updatedAt: Date.now(),
    lastImageId: null,
    coverUrl: null,
    messagesJson: JSON.stringify([
      { role: 'user', content: '给运营团队写库存交接说明。', attachments: [{ id: source.id, name: source.name, text: excerpt, truncated: true }] },
    ]),
    summary: '',
    summaryUpto: 0,
  });

  const settings = defaultSettings();
  const provider = {
    ...settings.llm.providers[0],
    id: 'llm-model-pipeline',
    name: 'mock',
    baseUrl: `http://127.0.0.1:${port}`,
    model: 'mock',
    apiKey: 'test-key',
    protocol: 'openai',
    temperature: 0.2,
  };
  settings.llm = { ...settings.llm, ...provider, providers: [provider], activeId: provider.id };
  saveUserSettings(userId, settings);

  const plan = JSON.stringify({ title: '库存交接', sections: [
    { heading: '库存锁定', purpose: '说明库存锁定字段', points: ['stock_lock_id'] },
    { heading: '交接流程', purpose: '列出交接动作' },
  ] });
  const intro = ['库存交接说明。'];
  const section = ['## 库存锁定\n\nstock_lock_id 表示锁定流水号。'];
  const exportWith = async (...sections) => {
    replies = [[plan], intro, ...sections];
    stages.length = 0;
    return runTool('create_document', {}, { user: { id: userId }, chat: { id: chatId }, emit() {} });
  };
  const readXml = async (id) => openZip(await readFile(generatedDocumentPath(userId, id, 'docx'))).readText('word/document.xml');

  const final = await exportWith(section, ['记录交接时间。']);
  assert.equal(final.error, undefined, final.error);
  assert.equal(stages.length, 4, 'short report needs only outline, intro and its two chapters');
  assert.match(stages[0], /stock_lock_id 表示锁定流水号/, 'planning also sees the restored source');
  assert.match(stages[2], /stock_lock_id 表示锁定流水号/, 'the chapter receives the original uploaded passage');
  assert.match(await readXml(final.document.id), /终稿/);

  const empty = await exportWith(['## 库存锁定'], ['## 交接流程']);
  assert.match(empty.error, /没有返回正文/);
  assert.equal(listUserDocuments(userId).length, 1, 'an introduction alone is never saved');

  const recovered = await exportWith(['## 库存锁定'], ['- 记录交接时间。']);
  assert.equal(recovered.error, undefined, recovered.error);
  assert.deepEqual(recovered.issues, ['第 1 章「库存锁定」缺失']);
  assert.match(await readXml(recovered.document.id), /记录交接时间/);

  const partial = await exportWith([section[0], 'length'], ['保留已写内容。', 'length'], ['仍有遗漏。', 'length'], ['']);
  assert.equal(partial.error, undefined, partial.error);
  assert.deepEqual(partial.issues, ['第 1 章「库存锁定」未写完', '第 2 章「交接流程」缺失']);
  const saved = getUserDocument(userId, partial.document.id);
  assert.match(saved.title, /部分稿/);
  const xml = await readXml(saved.id);
  for (const issue of partial.issues) {
    assert.ok(saved.blocks[0].text.includes(issue));
    assert.ok(xml.includes(issue));
  }
  assert.doesNotMatch(xml, /终稿/);

  const longId = 'ef'.repeat(12);
  const { saveImageBuffer } = await import('../src/media/image-storage.js');
  const widths = [32, 40, 48];
  const [reference, sheet, generated] = await Promise.all(widths.map(async (width) => {
    const png = await sharp({ create: { width, height: 24, channels: 3, background: '#567890' } }).png().toBuffer();
    return saveImageBuffer(userId, png);
  }));
  const log = '库存盘点。'.repeat(1000);
  insertChat({
    id: longId, userId, title: '交接记录', createdAt: 1, updatedAt: 1, lastImageId: null, coverUrl: null,
    messagesJson: JSON.stringify([
      { role: 'user', content: `${decisions[0]}。${log}`, referenceImageId: reference.id },
      { role: 'user', content: `${decisions[1]}。${log}`, attachments: [{ name: '复核表.pdf', images: [{ id: sheet.id, page: 2 }] }] },
      { role: 'user', content: `${decisions[2]}。` },
      { role: 'assistant', content: `${log}签收方案尚未明确。`, images: [{ id: generated.id, prompt: '双人签收示意图' }] },
      { role: 'user', content: latestRequest },
    ]),
  });
  for (const format of ['docx', 'pdf']) {
    await t.test(`${format} keeps the final decision and selected figure in a long-session export`, async (t) => {
      stages.length = 0;
      const longPlan = JSON.stringify({ title: '库存交接', sections: [{ heading: '双人签收', points: ['双人签收'] }] });
      replies = [
        (prompt) => prompt.includes(latestRequest) && prompt.includes(decisions[2]) ? [longPlan] : [],
        [JSON.stringify({ final_images: [{ image_id: generated.id, caption: '双人签收示意图', section: 1 }] })],
        ['未写完的导语', 'length'],
        (prompt) => prompt.includes(decisions[2])
          ? [`${decisions[2]}。\n\n第 8 轮生成图，当轮要求：开工\n\n![签收](image:${generated.id})`]
          : ['签收方案待定。'],
      ];
      const result = await runTool('create_document', { format }, { user: { id: userId }, chat: { id: longId }, emit() {} });
      if (format === 'pdf' && /中文字体/.test(result.error || '')) return t.skip('主机没有可用的中文字体');
      assert.equal(result.error, undefined, result.error);
      assert.equal(result.issues, undefined);
      const saved = getUserDocument(userId, result.document.id);
      const buffer = await readFile(generatedDocumentPath(userId, saved.id, format));
      const { extractDocumentTextAsync } = await import('../src/media/document-text.js');
      const text = (await extractDocumentTextAsync(buffer, format)).text.replace(/\s/g, '');
      assert.doesNotMatch(text, /会话总结|未写完的导语|当轮要求|开工/);
      assert.ok(text.includes(decisions[2]));
      const chunks = stages.filter((prompt) => prompt.includes('请把下面的对话片段整理'));
      assert.deepEqual(chunks.flatMap(observedDecisions).sort(), [...decisions].sort());
      assert.equal(result.document.image_count, 1);
      const embeddedWidths = [];
      if (format === 'docx') {
        const zip = openZip(buffer);
        for (const name of zip.names().filter((entry) => entry.startsWith('word/media/'))) {
          embeddedWidths.push((await sharp(zip.read(name)).metadata()).width);
        }
        assert.equal(zip.readText('word/document.xml').match(/<w:drawing>/g)?.length, 1);
      } else {
        const { getDocument, OPS } = await import('pdfjs-dist/legacy/build/pdf.mjs');
        const pdf = await getDocument({ data: new Uint8Array(buffer), isEvalSupported: false }).promise;
        try {
          for (let page = 1; page <= pdf.numPages; page++) {
            const ops = await (await pdf.getPage(page)).getOperatorList();
            ops.fnArray.forEach((op, i) => {
              if (op === OPS.paintImageXObject || op === OPS.paintJpegXObject) embeddedWidths.push(ops.argsArray[i][1]);
            });
          }
        } finally {
          await pdf.destroy();
        }
      }
      assert.deepEqual(embeddedWidths, [widths[2]]);
      assert.match(text, /终稿/);
      assert.doesNotMatch(text, /部分稿/);
    });
  }

  await t.test('an approved outline survives the export and stale OLAP options are removed', async () => {
    const id = 'ac'.repeat(12);
    insertChat({ id, userId, title: '讨论', createdAt: 1, updatedAt: 1, lastImageId: null, coverUrl: null,
      messagesJson: JSON.stringify([
        { role: 'user', content: 'OLAP 方案确定了使用 Doris 作为替代方案。' },
        { role: 'user', content: '痛点还有一个就是技术栈老旧，17 个工程的技术栈各不相同。' },
        { role: 'user', content: '现状章补齐。' },
        { role: 'user', content: '图沿用会话中的版本。' },
        { role: 'user', content: '输出 Word。' },
        { role: 'assistant', content: '# 报表演进\n\n## §1 现状与痛点\n\n交易与报表共库。\n\n## §2 迁移与选型\n\nDoris 是否长期引入待定。' },
        { role: 'user', content: '按此稿生成 Word。' },
      ]),
    });
    replies = [
      ['报表从交易库剥离。'],
      (prompt) => [prompt.includes('17 个工程的技术栈各不相同') ? '17 个工程的技术栈各不相同，且交易负载与报表争用连接池。' : '交易负载与报表争用连接池。'],
      ['OLAP 已确定采用 Doris。\n\n| 待确认事项 | 说明 |\n|---|---|\n| Doris 是否长期引入 | 取决于 A/B 回放 |\n| Doris 集群规模 | 压测后定容 |'],
    ];
    const result = await runTool('create_document', { format: 'docx' }, { user: { id: userId }, chat: { id }, emit() {} });
    assert.equal(result.error, undefined, result.error);
    assert.equal(result.issues, undefined);
    const buffer = await readFile(generatedDocumentPath(userId, result.document.id, 'docx'));
    const text = openZip(buffer).readText('word/document.xml');
    assert.match(text, /报表演进/);
    assert.match(text, /1\. 现状与痛点/);
    assert.match(text, /17 个工程的技术栈各不相同/);
    assert.match(text, /2\. 迁移与选型/);
    assert.match(text, /OLAP 已确定采用 Doris/);
    assert.match(text, /Doris 集群规模/);
    assert.doesNotMatch(text, /Doris 是否长期引入/);
  });
});

