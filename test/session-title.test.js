import test, { after, before } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { closeDb, initDb } from '../src/data/database.js';
import { createUser } from '../src/data/repositories/users.js';
import { getChat, insertChat, setChatTitleIfEmpty } from '../src/data/repositories/chats.js';
import { loadChatForUser, renameUserChat, saveChat } from '../src/services/chat-service.js';

let dataDir;
const userId = 'title-test-user';

before(async () => {
  dataDir = await mkdtemp(path.join(os.tmpdir(), 'luma-title-test-'));
  initDb(dataDir);
  createUser({ id: userId, username: 'title-tester', passwordHash: 'hash' });
});

after(async () => {
  closeDb();
  await rm(dataDir, { recursive: true, force: true });
});

function insertSession(id, title) {
  insertChat({
    id,
    userId,
    title,
    createdAt: 1,
    updatedAt: 2,
    lastImageId: null,
    coverUrl: null,
    messagesJson: '[]',
    summary: '',
    summaryUpto: 0,
  });
}

test('a streaming turn save never overwrites a rename', () => {
  const id = 'd'.repeat(24);
  insertSession(id, '首轮自动名称');
  const streamingChat = loadChatForUser(userId, id);

  renameUserChat(userId, id, '用户中途改名');
  saveChat(streamingChat);

  assert.equal(getChat(userId, id).title, '用户中途改名');
});

test('turn saves persist the first generated title only for an empty session', () => {
  const id = 'e'.repeat(24);
  insertSession(id, '');
  const firstTurn = loadChatForUser(userId, id);
  firstTurn.title = '自动生成的名称';
  saveChat(firstTurn);
  assert.equal(getChat(userId, id).title, '自动生成的名称');
  assert.equal(setChatTitleIfEmpty(userId, id, '迟到的自动标题'), false);

  const laterTurn = loadChatForUser(userId, id);
  laterTurn.title = '过期名称';
  saveChat(laterTurn);
  assert.equal(getChat(userId, id).title, '自动生成的名称');
});
