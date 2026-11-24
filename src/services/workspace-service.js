import { lstat, open, readdir, realpath, stat } from 'node:fs/promises';
import path from 'node:path';
import {
  WORKSPACE_INDEX_TTL_MS,
  WORKSPACE_MAX_DEPTH,
  WORKSPACE_MAX_FILES,
  WORKSPACE_MAX_FILE_BYTES,
  WORKSPACE_READ_CHARS,
  WORKSPACE_READ_LINES,
  WORKSPACE_SEARCH_BYTES,
  WORKSPACE_SEARCH_MATCHES,
} from '../config.js';
import {
  fileExtension,
  isIgnoredDir,
  isSecretFile,
  isTextFile,
  normalizeLineRange,
  normalizeRelativePath,
} from '../domain/workspace.js';
import { AppError } from '../shared/errors.js';
import { getDesktopWorkspace } from '../shared/runtime.js';

const indexCache = new Map();

// Directory binding is a desktop-only capability. The server decides, not the
// renderer: a deployment reachable over the network must never be able to read
// an arbitrary local path just because a client asked it to.
export function isWorkspaceEnabled() {
  return getDesktopWorkspace();
}

// The one funnel every reader goes through. A chat row can carry a bound root
// from a session created by the desktop app, but this process may be a plain
// web/Docker deployment sharing the same DATA_DIR. The capability check belongs
// here so no caller can resurrect a binding in a process that must not read the
// user's disk, whatever the row says.
export function workspaceFromChat(chat) {
  if (!isWorkspaceEnabled()) return null;
  const raw = chat?.workspaceJson;
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed.root !== 'string' || !parsed.root) return null;
    return { root: parsed.root, name: parsed.name || path.basename(parsed.root) };
  } catch {
    return null;
  }
}

export function serializeWorkspace(workspace) {
  return workspace ? JSON.stringify({ root: workspace.root, name: workspace.name }) : '';
}

function isInside(root, target) {
  return target === root || target.startsWith(root.endsWith(path.sep) ? root : `${root}${path.sep}`);
}

async function resolveRoot(root) {
  let resolved;
  try {
    resolved = await realpath(String(root || ''));
  } catch {
    throw new AppError(400, '工作目录不存在或无权访问');
  }
  const info = await stat(resolved).catch(() => null);
  if (!info?.isDirectory()) throw new AppError(400, '工作目录不可用');
  return { root: resolved, name: path.basename(resolved) || resolved };
}

/** Binds a directory to a chat. The stored root is the canonical real path. */
export async function bindWorkspace(directory) {
  if (!isWorkspaceEnabled()) {
    throw new AppError(403, '当前版本不支持工作目录，请使用桌面端');
  }
  const target = String(directory || '').trim();
  if (!target) throw new AppError(400, '请选择目录');
  return resolveRoot(target);
}

/**
 * Drops the cached index for a root that just failed validation.
 *
 * Eviction has to happen here rather than in indexFor's cache branch: a bad
 * root throws before indexFor is reached, so a later valid directory at the
 * same path inherited the previous listing (measured: restoring the directory
 * still served README.md while the disk held b.txt).
 */
function evictIndex(root) {
  if (root) indexCache.delete(root);
}

/**
 * Resolves a model-supplied relative path to a real path inside the workspace.
 * Both the root and the target are canonicalized, so a symlinked escape or a
 * `..` segment fails even when the lexical path looks contained.
 */
async function resolveInside(workspace, relative) {
  const root = await realpath(workspace.root).catch(() => null);
  if (!root) {
    evictIndex(workspace.root);
    throw new AppError(409, '工作目录已不可用');
  }
  // realpath succeeds for a regular file too, so a directory replaced by a file
  // still "resolves". Without this check a read reports the file inside it as
  // missing (404), which sends the user looking for a file that was never the
  // problem.
  const rootInfo = await stat(root).catch(() => null);
  if (!rootInfo?.isDirectory()) {
    evictIndex(root);
    evictIndex(workspace.root);
    throw new AppError(409, '工作目录已不可用（原路径已不是目录），请重新选择目录');
  }
  const normalized = normalizeRelativePath(relative);
  if (normalized.error) throw new AppError(400, normalized.error);
  const target = normalized.path ? path.join(root, normalized.path) : root;
  let resolved;
  try {
    resolved = await realpath(target);
  } catch {
    throw new AppError(404, `找不到 ${normalized.path || '目录'}`);
  }
  if (!isInside(root, resolved)) {
    throw new AppError(403, '路径超出工作目录范围');
  }
  return { root, resolved, relative: normalized.path };
}

function relativeOf(root, absolute) {
  return path.relative(root, absolute).split(path.sep).join('/');
}

async function walk(root, { maxDepth, maxFiles }) {
  const files = [];
  const skipped = { ignored: 0, secret: 0, binary: 0, large: 0, symlink: 0, truncated: false };
  const queue = [{ dir: root, depth: 0 }];

  while (queue.length) {
    const { dir, depth } = queue.shift();
    let entries;
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch (err) {
      // A subdirectory that cannot be listed is skipped: it is usually a
      // permission quirk deep in a tree and stopping the whole scan would be
      // worse. The ROOT is different — an unreadable root means the binding is
      // dead, and reporting an empty directory would tell the user their
      // project is empty when it is actually unreachable.
      if (dir === root) {
        throw new AppError(409, `工作目录不可读（${err.code || 'EACCES'}），可能是权限已变更或目录已删除`);
      }
      continue;
    }
    for (const entry of entries) {
      if (files.length >= maxFiles) {
        skipped.truncated = true;
        return { files, skipped };
      }
      const absolute = path.join(dir, entry.name);
      if (entry.isSymbolicLink()) {
        skipped.symlink += 1;
        continue;
      }
      if (entry.isDirectory()) {
        if (isIgnoredDir(entry.name)) {
          skipped.ignored += 1;
          continue;
        }
        if (depth + 1 > maxDepth) continue;
        queue.push({ dir: absolute, depth: depth + 1 });
        continue;
      }
      if (!entry.isFile()) continue;
      if (isSecretFile(entry.name)) {
        skipped.secret += 1;
        continue;
      }
      if (!isTextFile(entry.name)) {
        skipped.binary += 1;
        continue;
      }
      let info;
      try {
        info = await stat(absolute);
      } catch {
        continue;
      }
      if (info.size > WORKSPACE_MAX_FILE_BYTES) {
        skipped.large += 1;
        continue;
      }
      files.push({
        path: relativeOf(root, absolute),
        size: info.size,
        mtime: info.mtimeMs,
        ext: fileExtension(entry.name),
      });
    }
  }
  return { files, skipped };
}

async function indexFor(workspace) {
  const { root } = await resolveInside(workspace, '');
  const cached = indexCache.get(root);
  if (cached && Date.now() - cached.at < WORKSPACE_INDEX_TTL_MS) {
    // The TTL keeps a large tree from being re-walked on every call, but it
    // must not outlive the directory itself. A cached index is only reused when
    // the root is still listable, so losing the directory or its permissions is
    // reported instead of served from memory.
    let entries = null;
    try {
      entries = await readdir(root);
    } catch (err) {
      indexCache.delete(root);
      throw new AppError(
        409,
        `工作目录不可读（${err.code || 'EACCES'}），可能是权限已变更或目录已删除`,
      );
    }
    if (entries) return cached;
  }
  const scanned = await walk(root, {
    maxDepth: WORKSPACE_MAX_DEPTH,
    maxFiles: WORKSPACE_MAX_FILES,
  });
  const index = { at: Date.now(), root, ...scanned };
  indexCache.set(root, index);
  return index;
}

export async function workspaceOverview(workspace) {
  const index = await indexFor(workspace);
  const byExt = new Map();
  let bytes = 0;
  for (const file of index.files) {
    bytes += file.size;
    const key = file.ext || '无扩展名';
    byExt.set(key, (byExt.get(key) || 0) + 1);
  }
  const languages = [...byExt.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, 8)
    .map(([ext, count]) => `${ext} × ${count}`);
  return {
    root: index.root,
    name: workspace.name || path.basename(index.root),
    files: index.files.length,
    bytes,
    truncated: index.skipped.truncated,
    skipped: index.skipped,
    languages,
  };
}

export async function listWorkspaceFiles(workspace, { sub = '', depth = 2, limit = 200 } = {}) {
  const index = await indexFor(workspace);
  const base = normalizeRelativePath(sub);
  if (base.error) throw new AppError(400, base.error);
  const prefix = base.path ? `${base.path}/` : '';
  const maxDepth = Math.min(WORKSPACE_MAX_DEPTH, Math.max(1, Number(depth) || 2));
  const max = Math.min(500, Math.max(1, Number(limit) || 200));

  const seen = new Set();
  const lines = [];
  for (const file of index.files) {
    if (prefix && !file.path.startsWith(prefix)) continue;
    const rest = prefix ? file.path.slice(prefix.length) : file.path;
    const parts = rest.split('/');
    if (parts.length - 1 > maxDepth) {
      const dir = parts.slice(0, maxDepth).join('/');
      if (seen.has(dir)) continue;
      seen.add(dir);
      lines.push(`${dir}/`);
    } else {
      lines.push(`${file.path}\t${file.size}`);
    }
    if (lines.length >= max) break;
  }
  return {
    files: index.files.length,
    shown: lines.length,
    listing: lines.join('\n'),
    truncated: lines.length >= max || index.skipped.truncated,
  };
}

/**
 * The single door through which workspace bytes are read. Both the explicit
 * read and the search walk go through it, because a cached index entry can be
 * replaced on disk between scans: a file that was regular can become a symlink
 * pointing outside the root. Everything is therefore re-verified per call:
 *   - the path is a relative path with no `..`
 *   - the target itself is not a symlink (the scan never indexes one)
 *   - the canonical target still lives inside the canonical root
 *   - the size bound is re-measured, not trusted from the index
 *   - at most WORKSPACE_MAX_FILE_BYTES bytes are read, whatever the file claims
 */
async function openGuardedText(workspace, relative) {
  const normalized = normalizeRelativePath(relative);
  if (normalized.error) throw new AppError(400, normalized.error);
  const root = await realpath(workspace.root).catch(() => null);
  if (!root) {
    evictIndex(workspace.root);
    throw new AppError(409, '工作目录已不可用');
  }
  // This path resolves the root itself instead of going through
  // resolveInside(), so it needs the same directory check: a root replaced by a
  // regular file would otherwise report the requested file as missing.
  const rootInfo = await stat(root).catch(() => null);
  if (!rootInfo?.isDirectory()) {
    evictIndex(root);
    evictIndex(workspace.root);
    throw new AppError(409, '工作目录已不可用（原路径已不是目录），请重新选择目录');
  }

  const lexical = path.join(root, normalized.path);
  const link = await lstat(lexical).catch(() => null);
  if (!link) throw new AppError(404, `找不到 ${normalized.path}`);
  if (link.isSymbolicLink()) {
    throw new AppError(403, '不跟随符号链接，请直接使用目标文件的相对路径');
  }
  if (!link.isFile()) throw new AppError(400, '目标不是文件');
  if (isSecretFile(path.basename(lexical))) {
    throw new AppError(403, '该文件包含凭据，不开放读取');
  }

  const resolved = await realpath(lexical).catch(() => null);
  if (!resolved || !isInside(root, resolved)) {
    throw new AppError(403, '路径超出工作目录范围');
  }
  if (link.size > WORKSPACE_MAX_FILE_BYTES) {
    throw new AppError(
      413,
      `文件超过 ${Math.round(WORKSPACE_MAX_FILE_BYTES / 1024)}KB，请改用 search_workspace`,
    );
  }

  // Read through a handle with an explicit byte cap so a file that grew after
  // the stat above still cannot be pulled in whole.
  const handle = await open(resolved, 'r');
  let buffer;
  try {
    const chunk = Buffer.alloc(WORKSPACE_MAX_FILE_BYTES + 1);
    const { bytesRead } = await handle.read(chunk, 0, chunk.length, 0);
    if (bytesRead > WORKSPACE_MAX_FILE_BYTES) {
      throw new AppError(
        413,
        `文件超过 ${Math.round(WORKSPACE_MAX_FILE_BYTES / 1024)}KB，请改用 search_workspace`,
      );
    }
    buffer = chunk.subarray(0, bytesRead);
  } finally {
    await handle.close();
  }
  return { relative: normalized.path, text: buffer.toString('utf8') };
}

export async function readWorkspaceFile(workspace, { file, startLine, maxLines } = {}) {
  const target = await openGuardedText(workspace, file);
  const all = target.text.split('\n');
  const { start, lines } = normalizeLineRange(startLine, maxLines, WORKSPACE_READ_LINES);
  const slice = all.slice(start - 1, start - 1 + lines);
  const numbered = slice
    .map((line, index) => `${start + index}| ${line}`)
    .join('\n')
    .slice(0, WORKSPACE_READ_CHARS);
  return {
    path: target.relative,
    totalLines: all.length,
    startLine: start,
    lines: slice.length,
    truncated: start - 1 + slice.length < all.length || numbered.length >= WORKSPACE_READ_CHARS,
    content: numbered,
  };
}

export async function searchWorkspace(
  workspace,
  { query, sub = '', maxResults = WORKSPACE_SEARCH_MATCHES } = {},
) {
  const needle = String(query || '').trim();
  if (!needle) throw new AppError(400, '缺少搜索内容 query');
  if (needle.length > 200) throw new AppError(400, '搜索内容过长');
  const index = await indexFor(workspace);
  const base = normalizeRelativePath(sub);
  if (base.error) throw new AppError(400, base.error);
  const prefix = base.path ? `${base.path}/` : '';
  const limit = Math.min(
    WORKSPACE_SEARCH_MATCHES,
    Math.max(1, Number(maxResults) || WORKSPACE_SEARCH_MATCHES),
  );
  const lower = needle.toLowerCase();
  const matches = [];
  let scanned = 0;
  let bytes = 0;
  let truncated = false;

  for (const file of index.files) {
    if (prefix && !file.path.startsWith(prefix)) continue;
    if (bytes > WORKSPACE_SEARCH_BYTES) {
      truncated = true;
      break;
    }
    // A stale index entry can no longer be trusted: re-validate it through the
    // same door as an explicit read and silently skip anything that now escapes.
    let text;
    try {
      ({ text } = await openGuardedText(workspace, file.path));
    } catch {
      continue;
    }
    scanned += 1;
    bytes += text.length;
    const lines = text.split('\n');
    for (let i = 0; i < lines.length; i += 1) {
      if (!lines[i].toLowerCase().includes(lower)) continue;
      matches.push(`${file.path}:${i + 1}| ${lines[i].trim().slice(0, 240)}`);
      if (matches.length >= limit) {
        truncated = true;
        break;
      }
    }
    if (matches.length >= limit) break;
  }

  return {
    query: needle,
    filesScanned: scanned,
    matches: matches.length,
    truncated,
    results: matches.join('\n'),
  };
}

export function workspaceToolError(ctx) {
  if (!isWorkspaceEnabled()) {
    return { error: '当前版本不支持工作目录，请使用桌面端。' };
  }
  return ctx.workspace
    ? null
    : { error: '当前会话没有绑定工作目录。请让用户在输入框上方的「工作目录」里选择一个目录后再试。' };
}

