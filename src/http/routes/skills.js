import { json, readJsonBody } from '../responses.js';
import { MAX_SKILL_BYTES } from '../../domain/skill.js';
import {
  createSkillForUser,
  deleteSkillForUser,
  getSkillForUser,
  listSkillsForUser,
} from '../../services/skill-service.js';

export function handleListSkills(req, res, user) {
  return json(res, 200, listSkillsForUser(user.id));
}

export async function handleImportSkill(req, res, user) {
  const body = await readJsonBody(req, MAX_SKILL_BYTES);
  return json(res, 201, createSkillForUser(user.id, body));
}

export function handleGetSkill(req, res, user, id) {
  const skill = getSkillForUser(user.id, id);
  if (!skill) return json(res, 404, { error: 'Skill 不存在' });
  return json(res, 200, skill);
}

export function handleDeleteSkill(req, res, user, id) {
  if (!deleteSkillForUser(user.id, id)) {
    return json(res, 404, { error: 'Skill 不存在' });
  }
  return json(res, 200, { ok: true });
}
