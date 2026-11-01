import {
  deleteSkill as deleteSkillRow,
  findSkill as findSkillRow,
  insertSkill as insertSkillRow,
  listSkills as listSkillRows,
} from '../data/repositories/skills.js';
import { normalizeSkillPayload } from '../domain/skill.js';
import { AppError } from '../shared/errors.js';
import { newId } from '../shared/utils.js';

function parseSkillRow(row) {
  if (!row) return null;
  let data;
  try {
    data = JSON.parse(row.data_json || '{}');
  } catch {
    data = {};
  }
  return {
    ...data,
    id: row.id,
    name: row.name || data.name || '',
    description: row.description || data.description || '',
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export function listSkillsForUser(userId) {
  return listSkillRows(userId).map(parseSkillRow).filter(Boolean);
}

export function getSkillForUser(userId, id) {
  if (!/^[a-f0-9]{16,40}$/.test(String(id || ''))) return null;
  return parseSkillRow(findSkillRow(userId, id));
}

export function createSkillForUser(userId, payload) {
  try {
    const skill = normalizeSkillPayload(payload);
    const id = newId();
    const row = insertSkillRow({
      id,
      userId,
      name: skill.name,
      description: skill.description,
      dataJson: JSON.stringify(skill),
    });
    return parseSkillRow(row);
  } catch (err) {
    if (err instanceof AppError) throw err;
    if (/UNIQUE constraint failed/i.test(String(err?.message || ''))) {
      throw new AppError(409, '同名 Skill 已存在，请先修改名称或删除旧版本');
    }
    throw new AppError(400, err.message || 'Skill 导入失败');
  }
}

export function deleteSkillForUser(userId, id) {
  if (!/^[a-f0-9]{16,40}$/.test(String(id || ''))) return false;
  return deleteSkillRow(userId, id).changes > 0;
}
