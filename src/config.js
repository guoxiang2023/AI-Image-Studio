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
// Drawings exported from CAD routinely run 20-40 MB, so the ceiling is set for
// real construction PDFs rather than for plain text documents.
export const DOCUMENT_MAX_BYTES = Math.max(
  1024,
  Number(process.env.DOCUMENT_MAX_BYTES || 50 * 1024 * 1024),
);
export const DOCUMENT_MAX_CHARS = Math.max(
  1000,
  Number(process.env.DOCUMENT_MAX_CHARS || 120000),
);
// A bound workspace is read on demand, never pasted into the prompt. These caps
// bound a single tool call so one read cannot blow the context budget.
export const WORKSPACE_MAX_FILES = Math.max(
  100,
  Number(process.env.WORKSPACE_MAX_FILES || 4000),
);
export const WORKSPACE_MAX_DEPTH = Math.max(1, Number(process.env.WORKSPACE_MAX_DEPTH || 8));
export const WORKSPACE_MAX_FILE_BYTES = Math.max(
  4096,
  Number(process.env.WORKSPACE_MAX_FILE_BYTES || 512 * 1024),
);
export const WORKSPACE_READ_LINES = Math.max(
  20,
  Number(process.env.WORKSPACE_READ_LINES || 400),
);
export const WORKSPACE_READ_CHARS = Math.max(
  2000,
  Number(process.env.WORKSPACE_READ_CHARS || 16000),
);
export const WORKSPACE_SEARCH_MATCHES = Math.max(
  5,
  Number(process.env.WORKSPACE_SEARCH_MATCHES || 60),
);
export const WORKSPACE_SEARCH_BYTES = Math.max(
  1024 * 1024,
  Number(process.env.WORKSPACE_SEARCH_BYTES || 24 * 1024 * 1024),
);
export const WORKSPACE_INDEX_TTL_MS =
  Math.max(5, Number(process.env.WORKSPACE_INDEX_TTL_SECONDS || 60)) * 1000;
// Scanned PDFs are recognized page by page. Vision handles a page in ~1 s once
// warm, but a 200-page scan would still stall an upload for minutes, so only the
// first pages are read and the rest stay available as reference images.
export const OCR_PAGE_LIMIT = Math.max(
  1,
  Number(process.env.OCR_PAGE_LIMIT || 20),
);
export const DOCUMENT_MAX_IMAGES = Math.max(
  1,
  Number(process.env.DOCUMENT_MAX_IMAGES || 60),
);
// Pictures offered as references from one uploaded PDF: embedded photos plus
// screenshots of vector sheets. A construction drawing set routinely runs 20-40
// pages, and a short drawing is useless, so this is per-document, not global.
export const PDF_MAX_IMAGES = Math.max(
  1,
  Number(process.env.PDF_MAX_IMAGES || 40),
);
// Final images that actually enter the document. The candidate pool above can
// be much larger; this is the cap the image planner prompt and parser enforce.
export const DOCUMENT_FINAL_IMAGES = Math.min(
  DOCUMENT_MAX_IMAGES,
  Math.max(1, Number(process.env.DOCUMENT_FINAL_IMAGES || 24)),
);
export const DOCUMENT_TRANSCRIPT_CHARS = Math.max(
  4000,
  Number(process.env.DOCUMENT_TRANSCRIPT_CHARS || 40000),
);
export const DOCUMENT_PLAN_CHARS = Math.max(
  4000,
  Number(process.env.DOCUMENT_PLAN_CHARS || 12000),
);
export const DOCUMENT_SECTION_CHARS = Math.max(
  4000,
  Number(process.env.DOCUMENT_SECTION_CHARS || 16000),
);
export const DOCUMENT_BRIEF_INPUT_CHARS = Math.max(
  4000,
  Number(process.env.DOCUMENT_BRIEF_INPUT_CHARS || 6000),
);
export const DOCUMENT_BRIEF_MAX_CHARS = Math.max(
  1000,
  Number(process.env.DOCUMENT_BRIEF_MAX_CHARS || 11000),
);
export const DOCUMENT_BRIEF_MAX_TOKENS = Math.max(
  512,
  Number(process.env.DOCUMENT_BRIEF_MAX_TOKENS || 4096),
);
export const DOCUMENT_TIMEOUT = Math.max(
  20,
  Number(process.env.DOCUMENT_TIMEOUT_SECONDS || 600),
);

// Summary and chapter deadlines scale separately with the size of each stage.
export const DOCUMENT_CHAPTER_SECONDS = Math.max(
  5,
  Number(process.env.DOCUMENT_CHAPTER_SECONDS || 30),
);
export const DOCUMENT_TIMEOUT_MAX = Math.max(
  DOCUMENT_TIMEOUT,
  Number(process.env.DOCUMENT_TIMEOUT_MAX_SECONDS || 3600),
);

export function documentTimeoutSeconds({ chapters = 0, chunks = 0 } = {}) {
  const steps = Math.max(0, Number(chapters) || 0) + Math.max(0, Number(chunks) || 0);
  return Math.min(
    DOCUMENT_TIMEOUT_MAX,
    DOCUMENT_TIMEOUT + steps * DOCUMENT_CHAPTER_SECONDS,
  );
}
export const DOC_ATTACHMENT_CHARS = Math.max(
  1000,
  Number(process.env.DOC_ATTACHMENT_CHARS || 12000),
);
export const DOC_ATTACHMENT_TOTAL = Math.max(
  DOC_ATTACHMENT_CHARS,
  Number(process.env.DOC_ATTACHMENT_TOTAL || 36000),
);
export const LLM_TIMEOUT = Math.max(10, Number(process.env.LLM_TIMEOUT_SECONDS || 300));
// Per-request output ceiling for a chat turn. A long answer is continued
// automatically when the model hits it, so this bounds one request rather than
// the whole answer.
export const CHAT_MAX_TOKENS = Math.max(
  512,
  Number(process.env.CHAT_MAX_TOKENS || 4096),
);
// How many continuations one turn may use before it stops and reports the cut.
export const CHAT_MAX_CONTINUATIONS = Math.max(
  0,
  Number(process.env.CHAT_MAX_CONTINUATIONS || 3),
);

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
// Per-turn budget: compaction runs before an answer, so a huge backlog must not
// delay the reply. Progress accumulates across turns.
export const SUMMARY_MAX_CALLS = Math.max(1, Number(process.env.SUMMARY_MAX_CALLS || 6));
// Manual compaction: the user is waiting on purpose and expects the whole
// backlog covered in one action.
export const SUMMARY_MAX_CALLS_MANUAL = Math.max(
  SUMMARY_MAX_CALLS,
  Number(process.env.SUMMARY_MAX_CALLS_MANUAL || 24),
);
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
