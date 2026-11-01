import { api, els, state, toast } from '../core/index.js';

export function findSkill(id) {
  if (!id) return null;
  return (state.skills || []).find((skill) => skill.id === id) || null;
}

export function updateSkillChip() {
  const skill = findSkill(state.skillId);
  if (!els.activeSkillChip || !els.activeSkillName) return;
  els.activeSkillChip.hidden = !skill;
  els.activeSkillName.textContent = skill ? skill.name : '';
  els.activeSkillChip.classList.toggle('active', Boolean(skill));
}

export function setSkillId(id) {
  state.skillId = id && findSkill(id) ? id : null;
  updateSkillChip();
}

export function clearActiveSkill() {
  setSkillId(null);
}

export async function loadSkills() {
  try {
    const skills = await api('/api/skills');
    state.skills = Array.isArray(skills) ? skills : [];
  } catch (error) {
    state.skills = [];
    toast(error.message);
  }
  if (state.skillId && !findSkill(state.skillId)) state.skillId = null;
  updateSkillChip();
  return state.skills;
}

export async function deleteImportedSkill(id) {
  await api(`/api/skills/${id}`, { method: 'DELETE' });
  state.skills = (state.skills || []).filter((skill) => skill.id !== id);
  if (state.skillId === id) setSkillId(null);
  updateSkillChip();
}
