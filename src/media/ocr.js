import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { DATA_DIR, ROOT } from '../config.js';

const require = createRequire(import.meta.url);

// Vision loads its text models on the first request (~11 s measured) and then
// answers in 0.3–1.6 s. One resident helper process per app instance keeps that
// cold start out of every page but the first.
const HELPER_TIMEOUT_MS = 60 * 1000;
const HELPER_IDLE_MS = 5 * 60 * 1000;

let helper = null; // { child, pending: Map, nextId, idleTimer }

function helperBinaryPath() {
  const arch = process.arch === 'arm64' ? 'arm64' : 'x64';
  const candidates = [
    path.join(ROOT, 'build', 'ocr', `ocr-helper-${arch}`),
    // Packaged builds ship the helpers as extraResources next to the asar.
    path.join(process.resourcesPath || '', 'ocr', `ocr-helper-${arch}`),
  ];
  return candidates.find((candidate) => candidate && existsSync(candidate)) || null;
}

function stopHelper() {
  if (!helper) return;
  const current = helper;
  helper = null;
  clearTimeout(current.idleTimer);
  for (const entry of current.pending.values()) {
    entry.reject(new Error('OCR 进程已退出'));
  }
  current.pending.clear();
  try {
    current.child.stdin.end();
    current.child.kill();
  } catch {
    /* already gone */
  }
}

function armIdleTimer() {
  if (!helper) return;
  clearTimeout(helper.idleTimer);
  helper.idleTimer = setTimeout(() => {
    if (helper && helper.pending.size === 0) stopHelper();
  }, HELPER_IDLE_MS);
  helper.idleTimer.unref?.();
}

function startHelper(binary) {
  const child = spawn(binary, [], { stdio: ['pipe', 'pipe', 'ignore'] });
  const state = { child, pending: new Map(), nextId: 1, idleTimer: null };
  let buffer = '';

  child.stdout.setEncoding('utf8');
  child.stdout.on('data', (chunk) => {
    buffer += chunk;
    let newline;
    while ((newline = buffer.indexOf('\n')) >= 0) {
      const line = buffer.slice(0, newline).trim();
      buffer = buffer.slice(newline + 1);
      if (!line) continue;
      let payload;
      try {
        payload = JSON.parse(line);
      } catch {
        continue;
      }
      const entry = state.pending.get(payload.id);
      if (!entry) continue;
      state.pending.delete(payload.id);
      clearTimeout(entry.timer);
      if (payload.error) entry.reject(new Error(payload.error));
      else entry.resolve(String(payload.text || ''));
      if (state.pending.size === 0) armIdleTimer();
    }
  });
  child.on('error', (error) => {
    for (const entry of state.pending.values()) {
      clearTimeout(entry.timer);
      entry.reject(error);
    }
    state.pending.clear();
    if (helper === state) helper = null;
  });
  child.on('exit', () => {
    for (const entry of state.pending.values()) {
      clearTimeout(entry.timer);
      entry.reject(new Error('OCR 进程已退出'));
    }
    state.pending.clear();
    if (helper === state) helper = null;
  });

  return state;
}

async function ocrWithVision(buffer) {
  const binary = helperBinaryPath();
  if (!binary) throw new Error('未找到 OCR 组件');
  if (!helper) helper = startHelper(binary);
  const state = helper;
  clearTimeout(state.idleTimer);

  const id = state.nextId++;
  const image = Buffer.from(buffer).toString('base64');
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      state.pending.delete(id);
      reject(new Error('OCR 超时'));
    }, HELPER_TIMEOUT_MS);
    timer.unref?.();
    state.pending.set(id, { resolve, reject, timer });
    state.child.stdin.write(`${JSON.stringify({ id, image })}\n`, (error) => {
      if (!error) return;
      clearTimeout(timer);
      state.pending.delete(id);
      reject(error);
    });
  });
}

// tesseract.js is the cross-platform fallback: pure wasm, no native build step.
// It is ~15x slower than Vision and inserts spaces between Han glyphs, so it is
// only used where Vision does not exist (Windows/Linux, or a missing helper).
let tesseractWorker = null;
let tesseractLoading = null;

function tesseractLangPath() {
  const chi = require('@tesseract.js-data/chi_sim');
  return chi.langPath;
}

async function tesseractInstance() {
  if (tesseractWorker) return tesseractWorker;
  if (!tesseractLoading) {
    tesseractLoading = (async () => {
      const { createWorker } = require('tesseract.js');
      // No `tessedit_pageseg_mode` override: the default (3, fully automatic)
      // is the one that keeps every text line on a full page. psm 6 assumed a
      // single uniform block and silently dropped the middle lines.
      const worker = await createWorker(['chi_sim'], 1, {
        langPath: tesseractLangPath(),
        gzip: true,
        // Must be writable: in a packaged app ROOT is inside the read-only asar.
        cachePath: path.join(DATA_DIR, 'tesseract'),
      });
      tesseractWorker = worker;
      return worker;
    })().catch((error) => {
      tesseractLoading = null;
      throw error;
    });
  }
  return tesseractLoading;
}

async function ocrWithTesseract(buffer) {
  const worker = await tesseractInstance();
  const { data } = await worker.recognize(Buffer.from(buffer));
  return String(data?.text || '');
}

export function ocrBackend() {
  const forced = String(process.env.OCR_BACKEND || '').toLowerCase();
  if (forced === 'tesseract' || forced === 'vision') return forced;
  if (process.platform === 'darwin' && helperBinaryPath()) return 'vision';
  return 'tesseract';
}

// Tesseract pads every Han glyph with a space. Spaces between CJK characters and
// spaces against punctuation carry no meaning, so both are collapsed; a space
// between Latin and Han ("TCP/IP 与") is real word separation and survives.
const CJK_CLASS = '\\u3000-\\u303F\\u3400-\\u9FFF\\uF900-\\uFAFF\\uFE30-\\uFE4F\\uFF00-\\uFFEF';
const CJK = `[${CJK_CLASS}]`;
const ASCII_PUNCT = ':;,.!?()\\[\\]"';
// Tesseract also pads ASCII punctuation that sits inside Chinese text, which
// reads as `系统 (WCS)` and `架构 : 调度`. Spaces directly against punctuation
// carry no meaning in either script, so drop them on both sides.
const CJK_GAP = new RegExp(`(${CJK})[ \\t]+(?=${CJK})`, 'g');
const PUNCT_GAP = new RegExp(
  `(${CJK})[ \\t]+(?=[${ASCII_PUNCT}])|([${ASCII_PUNCT}])[ \\t]+(?=${CJK})`,
  'g',
);

export function tidyOcrText(raw) {
  return String(raw || '')
    .replace(/\r\n?/g, '\n')
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => {
      // Two passes: a single replace consumes the left neighbour, which would
      // skip the next gap in a run like `仓 储 控 制`.
      let previous;
      let current = line;
      do {
        previous = current;
        current = current.replace(CJK_GAP, '$1').replace(PUNCT_GAP, (m, cjk, punct) => cjk || punct);
      } while (current !== previous);
      return current;
    })
    .join('\n')
    .trim();
}

// Returns both the text and the backend that actually produced it: a Vision
// helper can be missing or crash, and the upload reports which one ran.
export async function recognizeText(buffer) {
  const input = Buffer.from(buffer || []);
  if (!input.length) return { text: '', backend: ocrBackend() };
  const preferred = ocrBackend();
  if (preferred === 'vision') {
    try {
      return { text: tidyOcrText(await ocrWithVision(input)), backend: 'vision' };
    } catch {
      // A missing or crashed helper must not fail the upload; tesseract still
      // yields text, just with lower fidelity.
      return { text: tidyOcrText(await ocrWithTesseract(input)), backend: 'tesseract' };
    }
  }
  return { text: tidyOcrText(await ocrWithTesseract(input)), backend: 'tesseract' };
}

export async function shutdownOcr() {
  stopHelper();
  if (tesseractWorker) {
    const worker = tesseractWorker;
    tesseractWorker = null;
    tesseractLoading = null;
    try {
      await worker.terminate();
    } catch {
      /* ignore */
    }
  }
}