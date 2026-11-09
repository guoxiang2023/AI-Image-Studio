import path from 'node:path';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const LIB_DIR = path.dirname(fileURLToPath(import.meta.url));
const PACKAGE = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));

export const ROOT = path.resolve(LIB_DIR, '..');
export const PUBLIC_DIR = path.join(ROOT, 'public');
export const DATA_DIR = path.resolve(process.env.DATA_DIR || path.join(ROOT, 'data'));
export const USERS_DIR = path.join(DATA_DIR, 'users');
export const APP_VERSION = process.env.APP_VERSION || PACKAGE.version;
export const UPDATE_REPO = process.env.UPDATE_REPO || 'guoxiang2023/AI-Image-Studio';
export const UPDATE_TIMEOUT = Math.max(3, Number(process.env.UPDATE_TIMEOUT_SECONDS || 8));
export const UPDATE_CACHE_MS =
  Math.max(60, Number(process.env.UPDATE_CACHE_SECONDS || 600)) * 1000;

export const HOST = process.env.HOST || '0.0.0.0';
export const PORT = Number(process.env.PORT || 8787);
export const TRUST_PROXY = process.env.TRUST_PROXY === '1';
export const COOKIE_SECURE = process.env.COOKIE_SECURE === '1';
export const REGISTRATION_CODE = process.env.REGISTRATION_CODE || '';
export const ALLOW_REGISTRATION = process.env.ALLOW_REGISTRATION !== '0';

export const SESSION_MS = 7 * 24 * 60 * 60 * 1000;
export const COOKIE_NAME = 'luma_session';

export const IMAGE_TIMEOUT = Number(process.env.IMAGE_TIMEOUT_SECONDS || 240);
export const DOCUMENT_MAX_BYTES = Math.max(
  1024,
  Number(process.env.DOCUMENT_MAX_BYTES || 10 * 1024 * 1024),
);
export const DOCUMENT_MAX_CHARS = Math.max(
  1000,
  Number(process.env.DOCUMENT_MAX_CHARS || 120000),
);
export const DOCUMENT_MAX_IMAGES = Math.max(
  1,
  Number(process.env.DOCUMENT_MAX_IMAGES || 60),
);
export const DOCUMENT_TRANSCRIPT_CHARS = Math.max(
  4000,
  Number(process.env.DOCUMENT_TRANSCRIPT_CHARS || 14000),
);
export const DOCUMENT_TIMEOUT = Math.max(
  20,
  Number(process.env.DOCUMENT_TIMEOUT_SECONDS || 180),
);
export const DOC_ATTACHMENT_CHARS = Math.max(
  1000,
  Number(process.env.DOC_ATTACHMENT_CHARS || 12000),
);
export const DOC_ATTACHMENT_TOTAL = Math.max(
  DOC_ATTACHMENT_CHARS,
  Number(process.env.DOC_ATTACHMENT_TOTAL || 36000),
);
export const LLM_TIMEOUT = Math.max(10, Number(process.env.LLM_TIMEOUT_SECONDS || 300));
export const LLM_STREAM_IDLE_TIMEOUT = Math.max(
  10,
  Number(process.env.LLM_STREAM_IDLE_TIMEOUT_SECONDS || 120),
);
export const IMAGE_QUALITIES = ['auto', 'low', 'medium', 'high', 'xhigh', 'max'];
export const IMAGE_QUALITY = IMAGE_QUALITIES.includes(process.env.IMAGE_QUALITY)
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
export const SUMMARY_INPUT_CHARS = Math.max(2000, Number(process.env.SUMMARY_INPUT_CHARS || 12000));
export const SUMMARY_MAX_CALLS = Math.max(1, Number(process.env.SUMMARY_MAX_CALLS || 6));
export const SUMMARY_TRIGGER_TOKENS = Math.max(
  2000,
  Number(process.env.SUMMARY_TRIGGER_TOKENS || 12000),
);
export const SUMMARY_KEEP_TOKENS = Math.max(
  1000,
  Number(process.env.SUMMARY_KEEP_TOKENS || 5000),
);
export const SUMMARY_MIN_KEEP = Math.min(
  SUMMARY_KEEP,
  Math.max(2, Number(process.env.SUMMARY_MIN_KEEP_MESSAGES || 4)),
);
export const SUMMARY_MAX_CHARS = Math.max(
  600,
  Number(process.env.SUMMARY_MAX_CHARS || 2400),
);
export const CONTEXT_TOKEN_BUDGET = Math.max(
  SUMMARY_TRIGGER_TOKENS + 1000,
  Number(process.env.CONTEXT_TOKEN_BUDGET || 20000),
);
export const CONTEXT_WINDOW = Math.max(
  SUMMARY_ENABLED ? SUMMARY_TRIGGER + 1 : 30,
  Number(process.env.CONTEXT_WINDOW_MESSAGES || (SUMMARY_ENABLED ? 120 : 30)),
);

export const DEFAULT_MODELS = {
  llm: {
    protocol: 'openai',
    baseUrl: '',
    model: '',
    temperature: 0.7,
    reasoningEffort: '',
  },
  image: {
    baseUrl: '',
    model: '',
    quality: IMAGE_QUALITY,
  },
};

// USD per 1M tokens / per generated image. Zero means "not configured".
export const DEFAULT_PRICING = {
  inputPerMillion: 0,
  cachedPerMillion: 0,
  outputPerMillion: 0,
  imagePerImage: 0,
};

export const LLM_PROTOCOLS = ['openai', 'anthropic'];
export const REASONING_EFFORTS = ['low', 'medium', 'high', 'xhigh', 'max'];

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
export const REFERENCE_ROLES = new Set(['参考', '角色', '风格', '构图', '版式', '产品']);

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
