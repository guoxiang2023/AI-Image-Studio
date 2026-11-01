import test, { after, before } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { closeDb, initDb } from '../src/data/database.js';
import { countUsers, createUser, findUserByUsername } from '../src/data/repositories/users.js';
import {
  getSettings,
  saveSettings,
} from '../src/data/repositories/model-settings.js';
import {
  deleteChat,
  getChat,
  insertChat,
  listChats,
  updateChat,
} from '../src/data/repositories/chats.js';
import {
  createGalleryFolder,
  findGalleryImage,
  insertGalleryImage,
  listGalleryFolders,
  listGalleryImages,
  setGalleryImageFavorite,
} from '../src/data/repositories/gallery.js';
import {
  deleteSkill,
  findSkill,
  insertSkill,
  listSkills,
} from '../src/data/repositories/skills.js';

let dataDir;

before(async () => {
  dataDir = await mkdtemp(path.join(os.tmpdir(), 'huajing-test-'));
  initDb(dataDir);
});

after(async () => {
  closeDb();
  await rm(dataDir, { recursive: true, force: true });
});

test('user and settings repositories round-trip', () => {
  createUser({ id: 'u1', username: 'tester', passwordHash: 'hash' });
  assert.equal(countUsers(), 1);
  assert.equal(findUserByUsername('tester').id, 'u1');
  saveSettings('u1', '{"a":1}', '{"b":2}');
  assert.equal(getSettings('u1').llm_json, '{"a":1}');
});

test('chat repository round-trips serialized documents', () => {
  const document = {
    id: 'c1',
    userId: 'u1',
    title: 'hello',
    createdAt: 1,
    updatedAt: 2,
    lastImageId: null,
    coverUrl: null,
    messagesJson: '[]',
    summary: '',
    summaryUpto: 0,
    skillId: null,
  };
  insertChat(document);
  assert.equal(listChats('u1')[0].id, 'c1');
  assert.equal(getChat('u1', 'c1').title, 'hello');
  updateChat({ ...document, title: 'updated', updatedAt: 3 });
  assert.equal(getChat('u1', 'c1').title, 'updated');
  deleteChat('u1', 'c1');
  assert.equal(getChat('u1', 'c1'), undefined);
});

test('gallery and skill repositories isolate users', () => {
  createGalleryFolder({ id: 'f1', userId: 'u1', name: 'folder' });
  assert.equal(listGalleryFolders('u1').length, 1);
  insertGalleryImage({
    id: 'i1',
    userId: 'u1',
    ext: 'png',
    prompt: 'prompt',
    size: '1024x1024',
    aspectRatio: '1:1',
    chatId: null,
    createdAt: 1,
  });
  setGalleryImageFavorite('u1', 'i1', true);
  assert.equal(findGalleryImage('u1', 'i1').favorite, 1);
  assert.equal(listGalleryImages('u1').length, 1);
  assert.equal(listGalleryImages('u2').length, 0);

  insertSkill({ id: 's1', userId: 'u1', name: 'skill', description: '', dataJson: '{}' });
  assert.equal(listSkills('u1').length, 1);
  assert.equal(findSkill('u1', 's1').id, 's1');
  assert.equal(deleteSkill('u1', 's1').changes, 1);
});
