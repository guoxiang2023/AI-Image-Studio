/**
 * Recovers DSML tool calls that arrive inside assistant *text*.
 *
 * Newer DeepSeek models (the V4 family) emit their tool-call envelope as markup
 * rather than as structured `tool_calls` / `tool_use` blocks, and
 * Anthropic-compatible gateways proxy that text through verbatim. What reaches
 * the client, and what the bug-report screenshot shows, is the double-bar
 * spelling:
 *
 *   <||DSML||calls>
 *   <||DSML||invoke name="search_workspace">
 *   <||DSML||parameter name="max_results" string="false">40</||DSML||parameter>
 *   <||DSML||parameter name="query" string="true">ROWNUM</||DSML||parameter>
 *   </||DSML||invoke>
 *   </||DSML||calls>
 *
 * Three spellings occur on the wire and all are accepted:
 *   `<||DSML||`  double ASCII bar, what the failing gateway emits
 *   `<|DSML|`     single ASCII bar
 *   `<｜<｜place▁holder▁no▁572｜>｜` fullwidth bar (U+FF5C)
 * `string="false"` means the body is JSON and must be decoded; anything else
 * (the attribute omitted, or "true") stays a raw string.
 *
 * Two rules keep this safe:
 *
 *  1. Display recovery and call recovery are independent. Markup is withheld
 *     from the visible answer even when no call can be recovered from it.
 *  2. A call is synthesized only from an explicit `</invoke>` whose parameters
 *     all closed. A truncated envelope must not be dispatched: its last
 *     parameter would swallow the following prose, and a syntactically valid
 *     JSON argument is all the agent loop checks before running the tool.
 */

import { newId } from '../shared/utils.js';

// One bar run: one or two bars, ASCII or fullwidth.
const BAR = '(?:[|｜]{1,2})';
// A complete tag at a position. The `y` flag anchors the match at `lastIndex`,
// so no `^` may be used: with sticky matching `^` only ever matches offset 0.
const TAG_AT = new RegExp(`<(\\/?)${BAR}DSML${BAR}([A-Za-z_]+)([^>]*)>`, 'y');
const ENVELOPE_TAGS = new Set(['calls', 'invoke', 'parameter']);

// Every tag a spelling can start with, longest first, so a buffer ending in
// `<||DS` is held back instead of shown and then reclassified.
const PREFIXES = [
  '<||DSML||',
  '</||DSML||',
  '<|DSML|',
  '</|DSML|',
  '<\uff5c\uff5cDSML\uff5c\uff5c',
  '</\uff5c\uff5cDSML\uff5c\uff5c',
  '<\uff5cDSML\uff5c',
  '</\uff5cDSML\uff5c',
].sort((a, b) => b.length - a.length);
const CLOSE_PREFIXES = PREFIXES.filter((prefix) => prefix.startsWith('</'));
// A parameter body is opaque and this format has no escape, so the only thing
// that can end one is its own closing tag. Searching for every closing tag
// would end the body at a lookalike such as `</||DSML||invoke>` written inside
// the value, and the value would then be truncated.
const PARAM_CLOSE_PREFIXES = CLOSE_PREFIXES.map((prefix) => `${prefix}parameter`);

function earliest(buffer, needles, from = 0) {
  let at = -1;
  for (const needle of needles) {
    const index = buffer.indexOf(needle, from);
    if (index >= 0 && (at < 0 || index < at)) at = index;
  }
  return at;
}

// How many trailing characters may be the start of a tag whose end has not
// arrived yet. They are held back so a half-written tag never reaches the screen.
function partialPrefixLength(buffer, needles) {
  let keep = 0;
  for (const needle of needles) {
    for (let k = Math.min(needle.length - 1, buffer.length); k > keep; k -= 1) {
      if (buffer.endsWith(needle.slice(0, k))) {
        keep = k;
        break;
      }
    }
  }
  return keep;
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

// Parses the complete tag at `at`, or returns null when it is not one.
function readTag(text, at) {
  TAG_AT.lastIndex = at;
  const match = TAG_AT.exec(text);
  if (!match) return null;
  return {
    closing: match[1] === '/',
    name: match[2],
    attrs: match[3] || '',
    raw: match[0],
    end: TAG_AT.lastIndex,
  };
}

/**
 * Walks the tag stream and returns the calls it contains.
 *
 * A `parameter` body is opaque: the parser jumps from its opening tag to the
 * next closing tag, so arbitrary text — including text that looks like other
 * tags — is read as the value it is. If that next closing tag is not
 * `</parameter>`, the parameter never closed and the scan stops.
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

  let at = 0;
  while (at < markup.length) {
    const tag = readTag(markup, at);
    if (!tag) {
      const next = earliest(markup, PREFIXES, at + 1);
      if (next < 0) break;
      at = next;
      continue;
    }
    at = tag.end;

    if (tag.closing) {
      if (tag.name === 'invoke') {
        emit();
        current = null;
      }
      continue;
    }

    if (tag.name === 'invoke') {
      // A new call without closing the previous one means the previous was
      // truncated; drop it rather than run it half-read.
      current = { name: attribute(tag.attrs, 'name'), arguments: {} };
      continue;
    }

    if (tag.name !== 'parameter' || !current) continue;

    const name = attribute(tag.attrs, 'name');
    const raw = attribute(tag.attrs, 'string') !== 'false';
    const closeAt = earliest(markup, PARAM_CLOSE_PREFIXES, at);
    const close = closeAt < 0 ? null : readTag(markup, closeAt);
    if (!close) {
      // The body never closed: everything after it is suspect, so nothing here
      // is usable and the scan ends.
      break;
    }
    if (name) current.arguments[name] = decodeValue(markup.slice(at, closeAt), raw);
    at = close.end;
  }
  return calls;
}

/**
 * Streaming filter: forwards only text outside the envelope and keeps the tags
 * and parameter bodies aside for `calls()`.
 *
 * An answer may mix prose with a call (DeepSeek writes its analysis first), so
 * prose is emitted as it arrives while the envelope is withheld. Chunk
 * boundaries are arbitrary, so nothing is re-classified after the fact: an
 * incomplete tag stays in `#pending` until its `>` arrives.
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
      // Inside a parameter body every byte belongs to the value, so only its own
      // closing tag can end the run. Elsewhere any tag can start structure.
      const needles = inParameter ? PARAM_CLOSE_PREFIXES : PREFIXES;
      const at = earliest(this.#pending, needles);

      if (at < 0) {
        // No complete tag in sight: the tail may still become one, so hold back
        // only what could be a tag prefix.
        const end = this.#pending.length - partialPrefixLength(this.#pending, needles);
        const run = this.#pending.slice(0, end);
        if (inParameter) {
          // A parameter body is opaque, whitespace included.
          this.#markup += run;
          this.#pending = this.#pending.slice(end);
        } else if (this.#stack.length && !run.trim()) {
          // Whitespace with the stack open is undecided: between tags it is
          // envelope structure, but inside a malformed envelope it is the
          // answer's own spacing (`<calls>hello world`). Leave it in the buffer
          // and let the next non-space byte — prose or a real tag — decide, so
          // the same reply renders the same however it was chunked.
          return visible;
        } else {
          visible += run;
          this.#pending = this.#pending.slice(end);
        }
        return visible;
      }

      const tag = readTag(this.#pending, at);
      const run = this.#pending.slice(0, at);
      this.#pending = this.#pending.slice(tag ? tag.end : at);
      // A text run is decided by its own content, never by where a chunk ended:
      // a parameter body is withheld, whitespace directly between two tags is
      // envelope structure, and anything else is the answer, emitted verbatim so
      // its own newlines survive.
      if (inParameter || (this.#stack.length && !run.trim())) this.#markup += run;
      else visible += run;
      if (!tag) return visible;

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
