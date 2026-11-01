import { RATIO_SIZE } from '../config.js';

const MAX_SKILL_BYTES = 64 * 1024;
const MAX_NAME = 40;
const MAX_DESCRIPTION = 240;
const MAX_INSTRUCTIONS = 3000;
const MAX_TEMPLATE = 4000;
const MAX_CONSTRAINT = 300;
const MAX_CONSTRAINTS = 12;
const MAX_EXAMPLE_INPUT = 1000;
const MAX_EXAMPLE_PROMPT = 1200;
const MAX_EXAMPLES = 3;
const QUALITIES = new Set(['auto', 'low', 'medium', 'high']);
const ASPECTS = new Set(Object.keys(RATIO_SIZE));
const MODES = new Set(['generate', 'edit']);

function cleanText(value, max) {
  if (typeof value !== 'string') return '';
  return value
    .replace(/\0/g, '')
    .trim()
    .slice(0, max);
}

function cleanStringList(value, maxItems, maxLength) {
  const list = Array.isArray(value)
    ? value
    : typeof value === 'string'
      ? value.split(/\r?\n/)
      : [];
  const out = [];
  for (const item of list) {
    const text = cleanText(item, maxLength);
    if (text && !out.includes(text)) out.push(text);
    if (out.length >= maxItems) break;
  }
  return out;
}

function normalizeModes(value) {
  if (value == null || value === '') return ['generate', 'edit'];
  const list = Array.isArray(value) ? value : [value];
  const modes = [];
  for (const item of list) {
    const mode = String(item || '').trim().toLowerCase();
    if (MODES.has(mode) && !modes.includes(mode)) modes.push(mode);
  }
  return modes.length ? modes : ['generate', 'edit'];
}

function normalizeDefaults(value) {
  const source = value && typeof value === 'object' && !Array.isArray(value) ? value : {};
  const defaults = {};
  if (ASPECTS.has(source.aspectRatio)) defaults.aspectRatio = source.aspectRatio;
  if (QUALITIES.has(source.quality)) defaults.quality = source.quality;
  const count = Number(source.count);
  if (Number.isInteger(count) && count >= 1 && count <= 4) defaults.count = count;
  return defaults;
}

function normalizeExamples(value) {
  if (!Array.isArray(value)) return [];
  const examples = [];
  for (const item of value) {
    if (!item || typeof item !== 'object' || Array.isArray(item)) continue;
    const input = cleanText(item.input, MAX_EXAMPLE_INPUT);
    const prompt = cleanText(item.prompt, MAX_EXAMPLE_PROMPT);
    if (!input && !prompt) continue;
    examples.push({ input, prompt });
    if (examples.length >= MAX_EXAMPLES) break;
  }
  return examples;
}

/**
 * Validate and normalize an imported JSON skill. Unknown fields are dropped:
 * skills are text-only data, never executable code.
 */
export function normalizeSkillPayload(payload) {
  const raw =
    payload && typeof payload === 'object' && !Array.isArray(payload) && payload.skill
      ? payload.skill
      : payload;
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    throw new Error('Skill 必须是 JSON 对象');
  }

  const name = cleanText(raw.name, MAX_NAME);
  if (name.length < 2) throw new Error('Skill 名称至少需要 2 个字符');
  const description = cleanText(raw.description, MAX_DESCRIPTION);
  const instructions = cleanText(raw.instructions, MAX_INSTRUCTIONS);
  const template = cleanText(raw.template, MAX_TEMPLATE);
  const constraints = cleanStringList(raw.constraints, MAX_CONSTRAINTS, MAX_CONSTRAINT);
  const modes = normalizeModes(raw.modes);
  const defaults = normalizeDefaults(raw.defaults);
  const examples = normalizeExamples(raw.examples);

  if (!instructions && !template && !constraints.length) {
    throw new Error('Skill 至少需要 instructions、template 或 constraints 之一');
  }

  return {
    schemaVersion: 1,
    name,
    description,
    modes,
    instructions,
    template,
    constraints,
    defaults,
    examples,
  };
}

export function skillSystemBlock(skill) {
  if (!skill) return '';
  const lines = [`【当前 Skill：${skill.name}】`];
  if (skill.description) lines.push(skill.description);
  if (skill.instructions) lines.push(skill.instructions);
  if (Array.isArray(skill.constraints) && skill.constraints.length) {
    lines.push('必须遵守：', ...skill.constraints.map((item) => `- ${item}`));
  }
  const examples = Array.isArray(skill.examples) ? skill.examples.slice(0, 2) : [];
  if (examples.length) {
    lines.push('参考示例：');
    for (const example of examples) {
      if (example.input) lines.push(`- 用户：${example.input}`);
      if (example.prompt) lines.push(`  目标提示词：${example.prompt}`);
    }
  }
  return `\n\n${lines.join('\n')}`;
}

export { MAX_SKILL_BYTES };
