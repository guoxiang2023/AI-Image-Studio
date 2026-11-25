/**
 * Recovers DSML tool calls that arrive inside assistant *text*.
 *
 * Newer DeepSeek models (the V4 family) emit their tool-call envelope as markup
 * rather than as structured `tool_calls` / `tool_use` blocks, and
 * Anthropic-compatible gateways proxy that text through verbatim. What actually
 * reaches the client, taken from the bug report:
 *
 *   <｜｜DSML｜｜ calls>
 *   <｜｜DSML｜｜ invoke name="search_workspace">
 *   <｜｜DSML｜｜ parameter name="query" string="true">ROWNUM</｜｜DSML｜｜ parameter>
 *   </｜｜DSML｜｜ invoke>
 *   </｜｜DSML｜｜ calls>
 *
 * The bar and the name are separated by whitespace, the bar runs are one or two
 * characters wide, and the bar itself may be ASCII (`|`) or fullwidth (`｜`,
 * U+FF5C). All of those spellings are accepted:
 *
 *   `<｜｜DSML｜｜ `  what the gateway in the bug report emits
 *   `<||DSML||`  the same shape with ASCII bars
 *   `<|DSML| `   a single ASCII bar
 *
 * `string="false"` means the body is JSON and must be decoded; anything else
 * (the attribute omitted, or "true") stays a raw string.
 *
 * Two rules keep this safe:
 *
 *  1. Display recovery and call recovery are independent. Markup is withheld
 *     from the visible answer even when no call can be recovered from it.
 *  2. A call is released only by its own `</invoke>`. A truncated envelope must
 *     not be dispatched: its last parameter would swallow the following prose,
 *     and a syntactically valid JSON argument is all the agent loop checks
 *     before running the tool.
 */

import { newId } from '../shared/utils.js';

// One bar run: one or two characters, ASCII or fullwidth.
const BARS = '[|｜]{1,2}';
// A tag head, with the name separated by optional whitespace: `<｜｜DSML｜｜ calls>`.
const HEAD = `<(\\/?)${BARS}DSML${BARS}[ \\t\\r\\n]*`;

// Sticky: the tag must start exactly at `lastIndex`, so no `^` may be used —
// with sticky matching `^` only ever matches offset 0.
const TAG_AT = new RegExp(`${HEAD}([A-Za-z_]+)([^>]*)>`, 'y');
const HEAD_AT = new RegExp(HEAD, 'y');

const ENVELOPE_TAGS = new Set(['calls', 'invoke', 'parameter']);

/**
 * Whether `text` could be the beginning of a tag that has not finished yet.
 *
 * Used to hold back a trailing fragment — `text<｜DS` — so a half-written tag is
 * never shown and then reclassified once the rest of it arrives.
 */
function couldStartTag(text) {
  if (!text.startsWith('<')) return false;
  let at = 1;
  if (text[at] === '/') at += 1;
  let bars = 0;
  while (at < text.length && (text[at] === '|' || text[at] === '｜') && bars < 2) {
    at += 1;
    bars += 1;
  }
  if (bars === 0) return at === text.length;
  const name = 'DSML';
  let matched = 0;
  while (at < text.length && matched < 4 && text[at] === name[matched]) {
    at += 1;
    matched += 1;
  }
  if (matched < 4) return at === text.length;
  // Past `DSML`, everything up to the closing `>` belongs to the tag.
  return true;
}

// How many trailing characters may be the opening of a tag. They are held back.
function incompleteTagLength(buffer) {
  const limit = Math.min(buffer.length, 16);
  for (let size = limit; size > 0; size -= 1) {
    if (couldStartTag(buffer.slice(buffer.length - size))) return size;
  }
  return 0;
}

// Where the next tag starts, or -1. Anything else is ordinary text.
function findTagStart(buffer, from = 0) {
  let at = buffer.indexOf('<', from);
  while (at >= 0) {
    HEAD_AT.lastIndex = at;
    if (HEAD_AT.exec(buffer)) return at;
    at = buffer.indexOf('<', at + 1);
  }
  return -1;
}

// Parses the complete tag at `at`, or returns null when it is still incomplete.
function readTag(text, at) {
  TAG_AT.lastIndex = at;
  const match = TAG_AT.exec(text);
  if (!match) return null;
  return {
    closing: match[1] === '/',
    name: match[2],
    attrs: match[3] || '',
    raw: match[0],
    start: at,
    end: TAG_AT.lastIndex,
  };
}

// The next closing tag after `from`, skipping opening tags — a parameter body is
// opaque, and this format has no escape, so the first closing tag ends it.
function nextClosingTag(markup, from) {
  let at = findTagStart(markup, from);
  while (at >= 0) {
    const tag = readTag(markup, at);
    if (!tag) return null;
    if (tag.closing) return tag;
    at = findTagStart(markup, tag.end);
  }
  return null;
}

function attribute(attrs, name) {
  const match = new RegExp(`${name}="([^"]*)"`).exec(attrs || '');
  return match ? match[1] : '';
}

function decodeValue(value, raw) {
  if (raw) return value;
  try {
    return JSON.parse(value);
  } catch {
    // A body declared as JSON but not parseable is still more useful as text.
    return value;
  }
}

/**
 * Walks the tag stream and returns the calls it contains.
 *
 * A `parameter` body is read as the text up to the next closing tag, so a value
 * that merely looks like a tag is kept as the value it is. If that closing tag
 * is not `</parameter>`, the parameter never closed and the scan stops.
 *
 * A call is released only by its own `</invoke>`. When a new `invoke` opens
 * before that, the previous one was truncated and is dropped: a closed parameter
 * is not enough, because the arguments after it may still have been lost.
 */
export function parseDsmlCalls(markup) {
  const calls = [];
  let current = null;

  const emit = () => {
    if (!current?.name) return;
    calls.push({
      // A fresh id per call, not a per-batch counter: an assistant turn that
      // leaks an envelope on two rounds would otherwise hand the provider two
      // calls with the same id, and a reply could match the wrong request.
      id: `ptc_${newId()}`,
      type: 'function',
      function: { name: current.name, arguments: JSON.stringify(current.arguments) },
    });
  };

  let at = findTagStart(markup, 0);
  while (at >= 0) {
    const tag = readTag(markup, at);
    if (!tag) break;

    if (tag.closing) {
      if (tag.name === 'invoke') {
        emit();
        current = null;
      }
      at = findTagStart(markup, tag.end);
      continue;
    }

    if (tag.name === 'invoke') {
      current = { name: attribute(tag.attrs, 'name'), arguments: {} };
      at = findTagStart(markup, tag.end);
      continue;
    }

    if (tag.name !== 'parameter' || !current) {
      at = findTagStart(markup, tag.end);
      continue;
    }

    const close = nextClosingTag(markup, tag.end);
    if (!close || close.name !== 'parameter') break;
    const name = attribute(tag.attrs, 'name');
    const raw = attribute(tag.attrs, 'string') !== 'false';
    if (name) current.arguments[name] = decodeValue(markup.slice(tag.end, close.start), raw);
    at = findTagStart(markup, close.end);
  }
  return calls;
}

/**
 * Streaming filter: forwards only text outside the envelope and keeps the tags
 * and parameter bodies aside for `calls()`.
 *
 * An answer may mix prose with a call (DeepSeek writes its analysis first), so
 * prose is emitted as it arrives while the envelope is withheld. Chunk
 * boundaries are arbitrary, so nothing is re-classified after the fact: a
 * fragment that could still be the start of a tag stays in `#pending`.
 *
 * Only whitespace is envelope structure between tags. Any other run of text
 * while the stack is open means the envelope was malformed — an unclosed
 * `<calls>` followed by prose, say — and it is the model's answer, so it is
 * shown. This filter can therefore never silence the rest of a reply.
 */
export class DsmlStream {
  #pending = '';
  #markup = '';
  #stack = [];

  push(chunk) {
    this.#pending += String(chunk || '');
    let visible = '';
    for (;;) {
      const inParameter = this.#stack[this.#stack.length - 1] === 'parameter';
      const at = findTagStart(this.#pending);

      if (at < 0) {
        // No tag in sight. A trailing fragment that may still become a tag is
        // held back, and a whitespace run with the stack open stays in the
        // buffer untouched: between tags it is envelope structure, but inside a
        // malformed envelope it is the answer's own spacing
        // (`<calls>hello world`). Consuming it here dropped the space whenever
        // the chunk boundary fell after it.
        const keep = incompleteTagLength(this.#pending);
        const end = this.#pending.length - keep;
        const run = this.#pending.slice(0, end);
        if (!inParameter && this.#stack.length && !run.trim()) return visible;
        this.#pending = this.#pending.slice(end);
        if (inParameter) this.#markup += run;
        else visible += run;
        return visible;
      }

      const run = this.#pending.slice(0, at);
      this.#pending = this.#pending.slice(at);
      if (inParameter || (this.#stack.length && !run.trim())) this.#markup += run;
      else visible += run;

      const tag = readTag(this.#pending, 0);
      if (!tag) return visible;
      this.#pending = this.#pending.slice(tag.end);

      if (inParameter && !tag.closing) {
        // A lookalike opening tag inside a body is part of the value.
        this.#markup += tag.raw;
        continue;
      }

      if (!ENVELOPE_TAGS.has(tag.name)) {
        // The model mentioning the format rather than calling it. Outside an
        // envelope that is real text; inside one it is noise between tags.
        if (!this.#stack.length) visible += tag.raw;
        continue;
      }

      this.#markup += tag.raw;
      if (tag.closing) {
        if (this.#stack[this.#stack.length - 1] === tag.name) this.#stack.pop();
      } else {
        this.#stack.push(tag.name);
      }
    }
  }

  flush() {
    const rest = this.#pending;
    this.#pending = '';
    if (this.#stack.length) {
      // Whatever is left was inside a malformed envelope; it belongs to the
      // markup, and `parseDsmlCalls` decides whether it yields a call.
      this.#markup += rest;
      return '';
    }
    return rest;
  }

  calls() {
    return parseDsmlCalls(this.#markup);
  }
}

/**
 * Splits a complete assistant message into visible text and recovered calls.
 * The input is returned untouched when no envelope is present.
 */
export function splitDsmlText(text) {
  const source = typeof text === 'string' ? text : '';
  if (!source.includes('DSML')) return { text: source, calls: [] };
  const stream = new DsmlStream();
  const head = stream.push(source) + stream.flush();
  return { text: head, calls: stream.calls() };
}

/**
 * Rewrites a non-streaming completion in place: the envelope leaves the content
 * and becomes `tool_calls`, so the agent loop dispatches it exactly as it would
 * a native call. Native calls win; a provider that returns both must not run the
 * same batch twice.
 */
export function healDsmlResponse(response) {
  const message = response?.choices?.[0]?.message;
  if (!message || typeof message.content !== 'string' || !message.content.includes('DSML')) {
    return response;
  }
  const { text, calls } = splitDsmlText(message.content);
  message.content = text;
  if (!calls.length || (Array.isArray(message.tool_calls) && message.tool_calls.length)) {
    return response;
  }
  message.tool_calls = calls;
  const choice = response.choices[0];
  if (!choice.finish_reason || choice.finish_reason === 'stop') choice.finish_reason = 'tool_calls';
  return response;
}
