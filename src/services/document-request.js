import { chatCompletion } from '../ai/llm.js';
import { NETWORK_ERROR_MESSAGE } from '../shared/utils.js';
import { recordLlmUsage } from './usage-service.js';

/**
 * Persisted usage kind for document requests. Kept separate from `chat` so the
 * export pipeline's spend can be read back without scanning provider models.
 */
export const DOCUMENT_REQUEST_KIND = 'document';

const STAGE_MAX_CHARS = 64;
const DOCUMENT_STAGE_PREFIX = 'document.';

/**
 * Stable error taxonomy persisted instead of provider text.
 *
 * Storing the provider's message would copy whatever a rejected request quoted
 * back into the usage table, and the excerpt is only useful anyway for the
 * class of failure it belongs to. Callers get the original error; the row gets
 * one of these categories.
 */
export const DOCUMENT_REQUEST_ERRORS = Object.freeze({
  canceled: 'canceled',
  timeout: 'timeout',
  network: 'network_error',
  invalidResponse: 'invalid_response',
  provider: 'provider_error',
  unknown: 'unknown_error',
  httpPrefix: 'provider_http_',
});

function normalizeStage(stage) {
  const value = String(stage ?? '').trim().slice(0, STAGE_MAX_CHARS);
  if (!value) return null;
  // One namespace for every export stage, so grouping by stage cannot split on
  // whether a caller wrote `plan`, `brief.summary` or `document.plan`.
  return value.startsWith(DOCUMENT_STAGE_PREFIX)
    ? value
    : `${DOCUMENT_STAGE_PREFIX}${value}`;
}

function finishReasonOf(response) {
  const value = response?.choices?.[0]?.finish_reason;
  return value ? String(value).slice(0, 64) : null;
}

function responseText(response) {
  return String(response?.choices?.[0]?.message?.content || '');
}

function httpStatusOf(err) {
  for (const candidate of [err, err?.cause]) {
    const status = Number(candidate?.status ?? candidate?.statusCode ?? candidate?.code);
    if (Number.isInteger(status) && status >= 100 && status <= 599) return status;
    // The transport reports the status only in its message:
    // `对话模型请求失败 (429)：…`
    const match = /\((\d{3})\)/.exec(String(candidate?.message || ''));
    if (match) {
      const parsed = Number(match[1]);
      if (parsed >= 100 && parsed <= 599) return parsed;
    }
  }
  return null;
}

function errorCategory(err, signal) {
  const timeout =
    err?.name === 'TimeoutError' || signal?.reason?.name === 'TimeoutError';
  if (timeout) return DOCUMENT_REQUEST_ERRORS.timeout;
  if (signal?.aborted) return DOCUMENT_REQUEST_ERRORS.canceled;
  const status = httpStatusOf(err);
  if (status) return `${DOCUMENT_REQUEST_ERRORS.httpPrefix}${status}`;
  const message = String(err?.message || '');
  if (message === NETWORK_ERROR_MESSAGE) return DOCUMENT_REQUEST_ERRORS.network;
  if (/无法解析/.test(message)) return DOCUMENT_REQUEST_ERRORS.invalidResponse;
  if (err?.name === 'AbortError' || err?.code === 'ABORT_ERR') {
    return DOCUMENT_REQUEST_ERRORS.canceled;
  }
  if (err instanceof Error) return DOCUMENT_REQUEST_ERRORS.provider;
  return DOCUMENT_REQUEST_ERRORS.unknown;
}

function persist({ userId, chatId, turnId, llm, stage, messages, outcome }) {
  try {
    recordLlmUsage({
      userId,
      chatId,
      turnId,
      kind: DOCUMENT_REQUEST_KIND,
      model: llm?.model,
      providerId: llm?.providerId,
      providerName: llm?.providerName,
      usage: outcome.usage,
      messages,
      completionText: outcome.completionText,
      requestCount: 1,
      stage,
      status: outcome.status,
      finishReason: outcome.finishReason,
      elapsedMs: outcome.elapsedMs,
      error: outcome.error,
    });
  } catch (err) {
    // Instrumentation must never replace a provider error, nor fail a response
    // that was already produced.
    console.warn('文档请求用量记录失败:', err?.message || err);
  }
}

/**
 * Creates the tracked provider request used by the Word/PDF pipeline.
 *
 * The returned function mirrors the `chatCompletion` call site:
 *
 *   request(stage, llm, messages, options) -> Promise<provider response>
 *
 * Every invocation persists exactly one `usage_events` row — success, truncated
 * answer, provider error, timeout or cancellation. The row holds the stage,
 * elapsed milliseconds, finish reason, `status` (`ok`/`error`), the error
 * category, and request count 1. Prompts and completions are never stored;
 * token counts come from the provider's `usage` when present, otherwise from
 * estimates for successful responses. Failed requests have no reported usage.
 *
 * @param {{user?: {id?: string}, chat?: {id?: string}, turnId?: string}} scope
 * @returns {(stage: string, llm: object, messages: object[], options?: object) => Promise<object>}
 */
export function createDocumentRequest({ user, chat, turnId } = {}) {
  const userId = user?.id;
  const chatId = chat?.id;
  const recordedTurnId = turnId ? String(turnId) : null;

  return async function documentRequest(stage, llm, messages, options = {}) {
    if (!llm || typeof llm !== 'object') {
      throw new TypeError('documentRequest 需要 llm 配置');
    }
    const requestStage = normalizeStage(stage);
    const startedAt = Date.now();
    const elapsedMs = () => Math.max(0, Date.now() - startedAt);

    let response;
    try {
      response = await chatCompletion(llm, messages, options);
    } catch (err) {
      persist({
        userId,
        chatId,
        turnId: recordedTurnId,
        llm,
        stage: requestStage,
        outcome: {
          status: 'error',
          usage: null,
          completionText: '',
          finishReason: null,
          elapsedMs: elapsedMs(),
          error: errorCategory(err, options.signal),
        },
      });
      throw err;
    }

    persist({
      userId,
      chatId,
      turnId: recordedTurnId,
      llm,
      stage: requestStage,
      messages,
      outcome: {
        status: 'ok',
        usage: response?.usage,
        completionText: responseText(response),
        finishReason: finishReasonOf(response),
        elapsedMs: elapsedMs(),
        error: null,
      },
    });
    return response;
  };
}
