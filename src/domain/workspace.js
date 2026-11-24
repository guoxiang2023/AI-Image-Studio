// A workspace is a directory the user explicitly handed to one chat. Files in
// it are user data, not instructions: nothing here ever executes or evaluates
// their contents, and the tool layer only ever reads within the bound root.

export const WORKSPACE_TEXT_EXTS = new Set([
  'txt',
  'md',
  'markdown',
  'rst',
  'csv',
  'tsv',
  'json',
  'jsonl',
  'ndjson',
  'log',
  'xml',
  'yml',
  'yaml',
  'toml',
  'ini',
  'cfg',
  'conf',
  'html',
  'htm',
  'css',
  'scss',
  'less',
  'js',
  'mjs',
  'cjs',
  'jsx',
  'ts',
  'tsx',
  'vue',
  'svelte',
  'py',
  'rb',
  'go',
  'rs',
  'java',
  'kt',
  'swift',
  'c',
  'h',
  'cc',
  'cpp',
  'hpp',
  'cs',
  'php',
  'sh',
  'bash',
  'zsh',
  'fish',
  'ps1',
  'sql',
  'graphql',
  'gql',
  'proto',
  'dockerfile',
  'makefile',
  'gradle',
  'patch',
  'diff',
]);

// Directories whose contents almost never help a conversation and can add tens
// of thousands of entries. Skipped by name, at any depth.
export const WORKSPACE_IGNORED_DIRS = new Set([
  '.git',
  '.hg',
  '.svn',
  '.next',
  '.nuxt',
  '.turbo',
  '.cache',
  '.parcel-cache',
  '.venv',
  'venv',
  'node_modules',
  'bower_components',
  'vendor',
  '__pycache__',
  '.pytest_cache',
  '.mypy_cache',
  '.ruff_cache',
  'dist',
  'build',
  'out',
  'target',
  'coverage',
  '.idea',
  '.vscode',
  '.run',
  '.DS_Store',
]);

// Files that hold credentials. They are neither indexed nor readable.
const SECRET_FILE_RE =
  /^(\.env(\..*)?|\.npmrc|\.pypirc|\.netrc|credentials(\.json)?|secrets?\.(json|ya?ml|toml)|id_(rsa|dsa|ecdsa|ed25519)(\.pub)?)$/i;
const SECRET_EXT_RE = /\.(pem|key|p12|pfx|keystore|jks|asc|gpg)$/i;
// Checked-in templates list variable names but never real values, and they are
// the best signal of how a project is configured. They stay readable.
const ENV_TEMPLATE_RE = /\.env\.(example|sample|template|dist)$/i;

export function isSecretFile(name) {
  const base = String(name || '');
  if (ENV_TEMPLATE_RE.test(base)) return false;
  return SECRET_FILE_RE.test(base) || SECRET_EXT_RE.test(base);
}

export function isIgnoredDir(name) {
  return WORKSPACE_IGNORED_DIRS.has(String(name || ''));
}

export function fileExtension(name) {
  const base = String(name || '').toLowerCase();
  if (base === 'dockerfile' || base === 'makefile' || base === 'gradle') return base;
  const match = base.match(/\.([a-z0-9]+)$/);
  return match ? match[1] : '';
}

export function isTextFile(name) {
  if (ENV_TEMPLATE_RE.test(String(name || ''))) return true;
  const ext = fileExtension(name);
  if (!ext) return false;
  return WORKSPACE_TEXT_EXTS.has(ext);
}

// Relative paths arriving from the model are untrusted: they may be absolute,
// contain `..`, or use Windows separators. Always returns an object: `{ path }`
// (empty string = the workspace root itself) or `{ error }`. Callers must never
// branch on a bare string.
export function normalizeRelativePath(raw) {
  const value = String(raw || '').trim().replace(/\\/g, '/');
  if (!value) return { path: '' };
  if (value.startsWith('/') || /^[a-zA-Z]:/.test(value)) {
    return { error: '路径必须是工作目录内的相对路径' };
  }
  const parts = [];
  for (const piece of value.split('/')) {
    if (!piece || piece === '.') continue;
    if (piece === '..') return { error: '路径不能超出工作目录' };
    if (piece.includes('\u0000')) return { error: '路径包含非法字符' };
    parts.push(piece);
  }
  return { path: parts.join('/') };
}

export function normalizeLineRange(startLine, maxLines, limit) {
  const start = Number.isInteger(Number(startLine)) ? Math.max(1, Number(startLine)) : 1;
  const lines = Number.isInteger(Number(maxLines))
    ? Math.min(limit, Math.max(1, Number(maxLines)))
    : limit;
  return { start, lines };
}