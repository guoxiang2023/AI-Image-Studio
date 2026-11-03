import crypto from 'node:crypto';

export const now = () => Date.now();
export const newId = () => crypto.randomBytes(12).toString('hex');

export function joinUrl(base, suffix) {
  return String(base || '').replace(/\/+$/, '') + suffix;
}

export function clamp(n, min, max) {
  return Math.min(max, Math.max(min, n));
}

export function parseArgs(raw) {
  try {
    return JSON.parse(raw || '{}');
  } catch {
    return {};
  }
}

export function isAbort(err) {
  return err?.name === 'AbortError' || err?.code === 'ABORT_ERR';
}

export const MAX_RETRIES = 5;
export const MAX_ATTEMPTS = MAX_RETRIES + 1;
export const NETWORK_ERROR_MESSAGE = '网络错误，请检查网络后重试';
const RETRY_BASE_MS = Math.max(0, Number(process.env.RETRY_BASE_MS || 600));

export function isRetryableStatus(status) {
  return status === 408 || status === 429 || status >= 500;
}

export function retryDelay(attempt) {
  return new Promise((resolve) =>
    setTimeout(resolve, Math.min(RETRY_BASE_MS * 2 ** attempt, 4000)),
  );
}

export function networkError(cause) {
  const error = new Error(NETWORK_ERROR_MESSAGE);
  if (cause) error.cause = cause;
  return error;
}

export function friendlyError(err) {
  if (isAbort(err)) return '已取消';
  if (err?.name === 'TimeoutError') return '请求超时，请重试';
  return err?.message || '未知错误';
}

export function extractError(text) {
  try {
    const j = JSON.parse(text);
    const e = j.error;
    if (typeof e === 'string') return e;
    return e?.message || j.message || text.slice(0, 300);
  } catch {
    return String(text || '')
      .replace(/<[^>]+>/g, ' ')
      .replace(/\s+/g, ' ')
      .trim()
      .slice(0, 300);
  }
}

export function withTimeout(signal, seconds) {
  const timeout = AbortSignal.timeout(Math.max(1, seconds) * 1000);
  return signal ? AbortSignal.any([signal, timeout]) : timeout;
}

export function keyHint(key) {
  if (!key) return '';
  return key.length <= 8 ? '****' : `${key.slice(0, 4)}…${key.slice(-4)}`;
}

export function clipText(value, length) {
  const text = String(value || '');
  return text.length > length ? `${text.slice(0, length)}…` : text;
}
