import path from 'node:path';
import { fileURLToPath } from 'node:url';

const LIB_DIR = path.dirname(fileURLToPath(import.meta.url));

export const ROOT = path.resolve(LIB_DIR, '..');
export const PUBLIC_DIR = path.join(ROOT, 'public');
export const DATA_DIR = path.resolve(process.env.DATA_DIR || path.join(ROOT, 'data'));
export const USERS_DIR = path.join(DATA_DIR, 'users');

export const HOST = process.env.HOST || '0.0.0.0';
export const PORT = Number(process.env.PORT || 8787);
export const TRUST_PROXY = process.env.TRUST_PROXY === '1';
export const COOKIE_SECURE = process.env.COOKIE_SECURE === '1';
export const REGISTRATION_CODE = process.env.REGISTRATION_CODE || '';
export const ALLOW_REGISTRATION = process.env.ALLOW_REGISTRATION !== '0';

export const SESSION_MS = 7 * 24 * 60 * 60 * 1000;
export const COOKIE_NAME = 'huajing_session';

export const IMAGE_TIMEOUT = Number(process.env.IMAGE_TIMEOUT_SECONDS || 240);
export const IMAGE_QUALITY = ['low', 'medium', 'high', 'auto'].includes(process.env.IMAGE_QUALITY)
  ? process.env.IMAGE_QUALITY
  : 'high';
export const IMAGE_INPUT_FIDELITY = process.env.IMAGE_INPUT_FIDELITY || 'high';
export const INPUT_FIDELITY_MODEL = /(1\.5|2\.5)/i;
// Optimize the model-facing prompt before every image request. On by default;
// set PROMPT_OPTIMIZE=0 to use the agent's draft verbatim.
export const PROMPT_OPTIMIZE = process.env.PROMPT_OPTIMIZE !== '0';
export const PROMPT_MODEL = process.env.PROMPT_MODEL || '';

export const SUMMARY_ENABLED = process.env.SUMMARY_ENABLED !== '0';
export const SUMMARY_TRIGGER = Math.max(10, Number(process.env.SUMMARY_TRIGGER_MESSAGES || 40));
export const SUMMARY_KEEP = Math.min(
  SUMMARY_TRIGGER - 1,
  Math.max(4, Number(process.env.SUMMARY_KEEP_MESSAGES || 20)),
);
export const SUMMARY_COOLDOWN_MS = 5 * 60 * 1000;
export const SUMMARY_INPUT_CHARS = Math.max(2000, Number(process.env.SUMMARY_INPUT_CHARS || 12000));
export const SUMMARY_MAX_CALLS = Math.max(1, Number(process.env.SUMMARY_MAX_CALLS || 6));
export const CONTEXT_WINDOW = Math.max(
  SUMMARY_ENABLED ? SUMMARY_TRIGGER + 1 : 30,
  Number(process.env.CONTEXT_WINDOW_MESSAGES || (SUMMARY_ENABLED ? 120 : 30)),
);

export const DEFAULT_MODELS = {
  llm: {
    baseUrl: process.env.DEFAULT_LLM_BASE_URL || 'https://api.deepseek.com/v1',
    model: process.env.DEFAULT_LLM_MODEL || 'deepseek-chat',
    temperature: 0.7,
  },
  image: {
    baseUrl: process.env.DEFAULT_IMAGE_BASE_URL || 'http://218.94.54.82:19901/v1',
    model: process.env.DEFAULT_IMAGE_MODEL || 'gpt-image-2.5-sunburst',
  },
};

export const MIME = {
  png: 'image/png',
  jpg: 'image/jpeg',
  webp: 'image/webp',
  svg: 'image/svg+xml',
};
export const IMAGE_EXT_BY_TYPE = {
  'image/png': 'png',
  'image/jpeg': 'jpg',
  'image/webp': 'webp',
};
export const VALID_SIZES = new Set(['1024x1024', '1536x1024', '1024x1536']);
export const USERNAME_RE = /^[\p{L}\p{N}_-]{2,24}$/u;
export const REFERENCE_ROLES = new Set(['参考', '角色', '风格', '构图', '产品']);

// Image providers expose only three canvas sizes. Ratios that do not match a
// native canvas are expanded after generation (never cropped) so the stored
// file really has the requested aspect ratio.
export const RATIO_SIZE = {
  '1:1': '1024x1024',
  '3:4': '1024x1536',
  '2:3': '1024x1536',
  '9:16': '1024x1536',
  '4:3': '1536x1024',
  '3:2': '1536x1024',
  '16:9': '1536x1024',
};
