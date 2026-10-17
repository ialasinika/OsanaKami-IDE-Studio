/**
 * provider.mjs -- one OpenAI-compatible chat-completions client.
 *
 * The IDE may talk to DeepSeek, to a local Ollama, to llama.cpp's server, or to
 * anything else that speaks the same wire protocol:
 *
 *     POST {baseUrl}/chat/completions
 *     Content-Type: application/json
 *     Authorization: Bearer {apiKey}        (omitted when apiKey is empty)
 *
 *     { "model": "...", "messages": [...], "stream": true|false,
 *       "temperature": 0.7, "max_tokens": 2048,
 *       "tools": [{ "type": "function", "function": { ... } }],
 *       "tool_choice": "auto" }
 *
 * and answers either one JSON object or an SSE stream whose frames are
 *
 *     data: {"choices":[{"index":0,"delta":{...},"finish_reason":null}]}
 *     data: [DONE]
 *
 * Design decisions that the callers depend on:
 *
 * - One request shape, two transports.  `chat()` always asks for JSON;
 *   `stream()` always asks for SSE and assembles the same normalized result.
 *   `complete()` picks by settings/request and is what an agent loop uses.
 * - Streaming is *assembled*, not merely forwarded.  Text deltas are
 *   concatenated; `tool_calls` are merged by `index`, with `function.name` and
 *   `function.arguments` accumulated across frames, because a tool call that
 *   arrives as three fragments must look exactly like a non-streaming one.
 * - Errors are one class with one `kind`: `auth` | `rate` | `network` |
 *   `protocol` | `cancelled`.  No error carries the API key: response bodies
 *   are re-scrubbed with the key before they are quoted, and headers are never
 *   echoed.
 * - Timeout is per attempt and aborts the request; a caller AbortSignal aborts
 *   immediately.  A *network* failure is retried exactly once with a short
 *   delay.  Timeouts are not retried (2x the wait for no new information), an
 *   auth/rate/protocol answer is never retried, and a stream that has already
 *   delivered a delta is never retried (that would duplicate output).
 * - Nothing in this module logs.
 *
 * Node 18+ (global `fetch`, `AbortController`, `TextDecoder`); no dependencies.
 */

import {
  ConfigError,
  describeConfig,
  endpointUrl,
  normalizeConfig,
  snippet
} from "./config.mjs";

/** The complete error vocabulary.  Anything a caller must branch on is here. */
export const ERROR_KINDS = Object.freeze(["auth", "rate", "network", "protocol", "cancelled"]);

const MAX_BODY_BYTES = 8 * 1024 * 1024;
const RETRY_DELAY_MS = 250;
const RETRY_LIMIT = 1;

/**
 * One failed provider interaction, classified.
 *
 *   kind === "auth"      - 401/403; the key or the endpoint is wrong. Not retryable.
 *   kind === "rate"      - 429; back off and let the user decide. `retryAfterMs`.
 *   kind === "network"   - the connection failed, or the timeout fired
 *                          (`timedOut: true`). Only the non-timeout kind is
 *                          retried once, automatically.
 *   kind === "protocol"  - an HTTP status/body/stream the client cannot trust.
 *   kind === "cancelled" - the caller's AbortSignal fired.
 *
 * `detail` is a redacted, single-line excerpt of the offending body.
 */
export class ProviderError extends Error {
  /**
   * @param {string} kind
   * @param {string} message
   * @param {{status?: number|null, detail?: string, retryable?: boolean,
   *          timedOut?: boolean, retryAfterMs?: number|null, cause?: unknown}} [options]
   */
  constructor(kind, message, options = {}) {
    super(message);
    this.name = "ProviderError";
    this.kind = ERROR_KINDS.includes(kind) ? kind : "protocol";
    this.status = typeof options.status === "number" ? options.status : null;
    this.detail = typeof options.detail === "string" ? options.detail : "";
    this.retryable = options.retryable === true;
    this.timedOut = options.timedOut === true;
    this.retryAfterMs = typeof options.retryAfterMs === "number" ? options.retryAfterMs : null;
    this.cause = options.cause;
  }

  toJSON() {
    return {
      name: this.name,
      kind: this.kind,
      message: this.message,
      status: this.status,
      detail: this.detail,
      retryable: this.retryable,
      timedOut: this.timedOut,
      retryAfterMs: this.retryAfterMs
    };
  }
}

/** @param {unknown} error */
export function isProviderError(error) {
  return error instanceof ProviderError;
}

/* ------------------------------------------------------------------ */
/* transport options                                                   */
/* ------------------------------------------------------------------ */

const TRANSPORT_KEYS = Object.freeze(["fetchImpl", "headers", "retryDelayMs", "retryLimit"]);

/** @param {unknown} value */
function plainObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

/**
 * Validate and freeze the transport half of the options.
 * @param {object} options
 * @returns {{fetchImpl: Function, headers: object, retryDelayMs: number, retryLimit: number}}
 */
function normalizeTransport(options) {
  const fetchImpl = options.fetchImpl === undefined ? globalThis.fetch : options.fetchImpl;
  if (typeof fetchImpl !== "function") {
    throw new ConfigError("provider: fetchImpl must be a function");
  }
  const headers = {};
  if (options.headers !== undefined) {
    if (!plainObject(options.headers)) {
      throw new ConfigError("provider: headers must be an object");
    }
    for (const name of Object.keys(options.headers)) {
      const value = options.headers[name];
      if (typeof value !== "string" && typeof value !== "number") {
        throw new ConfigError("provider: headers[" + name + "] must be a string");
      }
      if (/[\r\n]/.test(name) || /[\r\n]/.test(String(value))) {
        throw new ConfigError("provider: header " + name + " must be one line");
      }
      headers[name] = String(value);
    }
  }
  const retryDelayMs = options.retryDelayMs === undefined ? RETRY_DELAY_MS : options.retryDelayMs;
  if (!Number.isFinite(retryDelayMs) || retryDelayMs < 0 || retryDelayMs > 10000) {
    throw new ConfigError("provider: retryDelayMs must be a number between 0 and 10000");
  }
  const retryLimit = options.retryLimit === undefined ? RETRY_LIMIT : options.retryLimit;
  if (!Number.isInteger(retryLimit) || retryLimit < 0 || retryLimit > 5) {
    throw new ConfigError("provider: retryLimit must be an integer between 0 and 5");
  }
  return { fetchImpl, headers, retryDelayMs, retryLimit };
}

/* ------------------------------------------------------------------ */
/* SSE framing                                                         */
/* ------------------------------------------------------------------ */

/**
 * Incremental SSE frame splitter: feed it text chunks in any sizes, get back
 * the `data:` payloads of the frames that are now complete.  The blank line is
 * the frame terminator, which is what makes reassembly across TCP chunks (and
 * across a JSON body split in the middle of a number) correct: the tail of an
 * incomplete frame stays in the buffer.
 *
 * Inside a frame, every `data:` line contributes one payload line joined with
 * "\n"; `:` comments and other fields are ignored.
 */
class SseFrames {
  constructor() {
    this.pending = "";
  }

  /** @param {string} text @returns {string[]} */
  push(text) {
    this.pending += text;
    const out = [];
    for (;;) {
      const split = findFrameEnd(this.pending);
      if (split === null) {
        break;
      }
      const block = this.pending.slice(0, split.end);
      this.pending = this.pending.slice(split.next);
      const payload = framePayload(block);
      if (payload !== null) {
        out.push(payload);
      }
    }
    return out;
  }

  /** A final frame without a trailing blank line is still data. */
  flush() {
    const block = this.pending;
    this.pending = "";
    const payload = framePayload(block);
    return payload === null ? [] : [payload];
  }
}

/** @param {string} text @returns {{end: number, next: number}|null} */
function findFrameEnd(text) {
  const lf = text.indexOf("\n\n");
  const crlf = text.indexOf("\r\n\r\n");
  if (lf < 0 && crlf < 0) {
    return null;
  }
  if (crlf >= 0 && (lf < 0 || crlf < lf)) {
    // The `\r\n` at crlf+2 is the tail of the last data line.
    return { end: crlf + 2, next: crlf + 4 };
  }
  if (crlf >= 0 && crlf + 2 === lf) {
    return { end: lf, next: lf + 2 };
  }
  return { end: lf, next: lf + 2 };
}

/** @param {string} block @returns {string|null} */
function framePayload(block) {
  const parts = [];
  for (const line of block.split(/\r?\n/)) {
    if (line === "" || line.startsWith(":")) {
      continue;
    }
    if (line.startsWith("data:")) {
      let value = line.slice(5);
      if (value.startsWith(" ")) {
        value = value.slice(1);
      }
      parts.push(value);
    }
  }
  return parts.length === 0 ? null : parts.join("\n");
}

/* ------------------------------------------------------------------ */
/* message / tool shape                                                */
/* ------------------------------------------------------------------ */

const MESSAGE_ROLES = Object.freeze(["system", "user", "assistant", "tool"]);

/**
 * @param {unknown} content
 * @returns {string|null}
 */
function normalizeContent(content) {
  if (content === undefined || content === null) {
    return null;
  }
  if (typeof content === "string") {
    return content;
  }
  if (Array.isArray(content)) {
    const parts = [];
    for (const part of content) {
      if (part && typeof part === "object" && typeof part.text === "string") {
        parts.push(part.text);
      }
    }
    return parts.length === 0 ? null : parts.join("");
  }
  return null;
}

/**
 * @param {unknown} raw
 * @returns {object|null}
 */
function normalizeToolCall(raw) {
  if (!plainObject(raw)) {
    return null;
  }
  const fn = raw.function;
  if (!plainObject(fn)) {
    return null;
  }
  const name = typeof fn.name === "string" ? fn.name : "";
  if (name === "") {
    return null;
  }
  const args = typeof fn.arguments === "string" ? fn.arguments : JSON.stringify(fn.arguments === undefined ? {} : fn.arguments);
  return {
    id: typeof raw.id === "string" ? raw.id : null,
    type: "function",
    function: { name, arguments: args }
  };
}

/**
 * @param {unknown} raw
 * @param {string} label
 * @returns {object}
 */
function normalizeAssistantMessage(raw, label) {
  if (!plainObject(raw)) {
    throw new ProviderError("protocol", "provider: " + label + " is not an object");
  }
  const message = {
    role: typeof raw.role === "string" ? raw.role : "assistant",
    content: normalizeContent(raw.content)
  };
  if (Array.isArray(raw.tool_calls)) {
    const calls = [];
    for (const call of raw.tool_calls) {
      const normalized = normalizeToolCall(call);
      if (normalized !== null) {
        calls.push(normalized);
      }
    }
    if (calls.length > 0) {
      message.tool_calls = calls;
    }
  }
  if (typeof raw.reasoning_content === "string" && raw.reasoning_content !== "") {
    message.reasoning_content = raw.reasoning_content;
  }
  return message;
}

/** @param {unknown} usage */
function normalizeUsage(usage) {
  if (!plainObject(usage)) {
    return null;
  }
  const out = {};
  let seen = false;
  for (const key of ["prompt_tokens", "completion_tokens", "total_tokens"]) {
    if (Number.isFinite(usage[key])) {
      out[key] = usage[key];
      seen = true;
    }
  }
  if (seen) {
    return out;
  }
  return null;
}

/**
 * Validate the request half and build the wire body.
 * @param {unknown} request
 * @param {boolean} stream
 * @param {object} settings
 * @returns {object}
 */
function buildBody(request, stream, settings) {
  const req = request === undefined || request === null ? {} : request;
  if (!plainObject(req)) {
    throw new ConfigError("provider: request must be an object");
  }

  const messages = req.messages;
  if (!Array.isArray(messages) || messages.length === 0) {
    throw new ConfigError("provider: messages must be a non-empty array");
  }

  const model = req.model === undefined ? settings.model : req.model;
  if (typeof model !== "string" || model.trim() === "") {
    throw new ConfigError("provider: model must be a non-empty string");
  }

  const body = {
    model: model.trim(),
    messages: messages.map((message, index) => normalizeWireMessage(message, index)),
    stream
  };

  const temperature = req.temperature === undefined ? settings.temperature : req.temperature;
  if (temperature !== undefined && temperature !== null) {
    if (typeof temperature !== "number" || !Number.isFinite(temperature) || temperature < 0 || temperature > 2) {
      throw new ConfigError("provider: temperature must be a number between 0 and 2");
    }
    body.temperature = temperature;
  }
  const maxTokens = req.maxTokens === undefined ? settings.maxTokens : req.maxTokens;
  if (maxTokens !== undefined && maxTokens !== null) {
    if (!Number.isInteger(maxTokens) || maxTokens < 1) {
      throw new ConfigError("provider: maxTokens must be a positive integer");
    }
    body.max_tokens = maxTokens;
  }

  if (req.tools !== undefined) {
    body.tools = normalizeTools(req.tools);
    body.tool_choice = req.toolChoice === undefined ? "auto" : req.toolChoice;
  } else if (req.toolChoice !== undefined) {
    throw new ConfigError("provider: toolChoice was given without tools");
  }

  if (req.extra !== undefined) {
    if (!plainObject(req.extra)) {
      throw new ConfigError("provider: extra must be an object");
    }
    for (const key of Object.keys(req.extra)) {
      if (["model", "messages", "stream", "tools", "tool_choice"].includes(key)) {
        throw new ConfigError("provider: extra may not override " + key);
      }
      body[key] = req.extra[key];
    }
  }

  return body;
}

/** @param {unknown} message @param {number} index @returns {object} */
function normalizeWireMessage(message, index) {
  const where = "provider: messages[" + index + "]";
  if (!plainObject(message)) {
    throw new ConfigError(where + " must be an object");
  }
  if (!MESSAGE_ROLES.includes(message.role)) {
    throw new ConfigError(where + ".role must be system, user, assistant or tool");
  }
  const out = { role: message.role };
  if (message.content !== undefined) {
    if (typeof message.content === "string" || message.content === null || Array.isArray(message.content)) {
      out.content = message.content;
    } else {
      throw new ConfigError(where + ".content must be a string, null or an array");
    }
  }
  if (message.role === "tool") {
    if (typeof message.tool_call_id !== "string" || message.tool_call_id === "") {
      throw new ConfigError(where + ".tool_call_id is required for a tool message");
    }
    out.tool_call_id = message.tool_call_id;
    if (typeof out.content !== "string") {
      throw new ConfigError(where + ".content must be the tool result as a string");
    }
  }
  if (message.role === "assistant" && Array.isArray(message.tool_calls)) {
    const calls = message.tool_calls.map(normalizeToolCall).filter((call) => call !== null);
    if (calls.length !== message.tool_calls.length) {
      throw new ConfigError(where + ".tool_calls contains an entry without a function name");
    }
    out.tool_calls = calls;
  }
  if (typeof message.name === "string" && message.name !== "") {
    out.name = message.name;
  }
  return out;
}

/** @param {unknown} tools @returns {object[]} */
function normalizeTools(tools) {
  if (!Array.isArray(tools)) {
    throw new ConfigError("provider: tools must be an array");
  }
  return tools.map((tool, index) => {
    const where = "provider: tools[" + index + "]";
    if (!plainObject(tool)) {
      throw new ConfigError(where + " must be an object");
    }
    const fn = tool.type === "function" && plainObject(tool.function) ? tool.function : tool;
    if (typeof fn.name !== "string" || fn.name.trim() === "") {
      throw new ConfigError(where + ".function.name must be a non-empty string");
    }
    return {
      type: "function",
      function: {
        name: fn.name.trim(),
        description: typeof fn.description === "string" ? fn.description : "",
        parameters: plainObject(fn.parameters) ? fn.parameters : { type: "object", properties: {} }
      }
    };
  });
}

/* ------------------------------------------------------------------ */
/* abort + failure classification                                      */
/* ------------------------------------------------------------------ */

/**
 * @param {AbortSignal|undefined} outer
 * @param {number} timeoutMs
 */
function createAbort(outer, timeoutMs) {
  const controller = new AbortController();
  let timedOut = false;
  let timer = null;
  const abort = () => {
    try {
      controller.abort();
    } catch {
      // already aborted
    }
  };
  if (Number.isFinite(timeoutMs) && timeoutMs > 0) {
    timer = setTimeout(() => {
      timedOut = true;
      abort();
    }, timeoutMs);
  }
  const onAbort = () => abort();
  if (outer !== undefined && outer !== null) {
    if (outer.aborted) {
      abort();
    } else {
      outer.addEventListener("abort", onAbort, { once: true });
    }
  }
  return {
    signal: controller.signal,
    didTimeOut: () => timedOut,
    cleanup() {
      if (timer !== null) {
        clearTimeout(timer);
        timer = null;
      }
      if (outer !== undefined && outer !== null) {
        outer.removeEventListener("abort", onAbort);
      }
    }
  };
}

/**
 * Classify an I/O failure (fetch rejected, or the body read failed).
 * @param {unknown} error
 * @param {{didTimeOut: () => boolean}} abort
 * @param {AbortSignal|undefined} outer
 * @param {string[]} secrets
 * @returns {ProviderError}
 */
function classifyIoError(error, abort, outer, secrets) {
  if (error instanceof ProviderError) {
    return error;
  }
  if (outer !== undefined && outer !== null && outer.aborted) {
    return new ProviderError("cancelled", "provider: request cancelled", { cause: error });
  }
  if (abort.didTimeOut()) {
    return new ProviderError("network", "provider: request timed out", {
      timedOut: true,
      retryable: false,
      cause: error
    });
  }
  const cause = error && typeof error.message === "string" ? snippet(error.message, secrets, 200) : "fetch failed";
  return new ProviderError("network", "provider: network request failed (" + cause + ")", {
    retryable: true,
    cause: error
  });
}

/* ------------------------------------------------------------------ */
/* stream assembly                                                     */
/* ------------------------------------------------------------------ */

function createAccumulator() {
  return {
    id: null,
    model: null,
    created: null,
    role: "assistant",
    content: "",
    reasoning: "",
    calls: new Map(),
    finishReason: null,
    usage: null
  };
}

/**
 * Merge a stream frame into the accumulator, emitting deltas to `onEvent`.
 * @param {object} acc
 * @param {unknown} chunk
 * @param {string[]} secrets
 * @param {Function|null} onEvent
 */
function applyChunk(acc, chunk, secrets, onEvent) {
  if (!plainObject(chunk)) {
    throw new ProviderError("protocol", "provider: stream frame is not a JSON object");
  }
  if (chunk.error !== undefined && chunk.error !== null) {
    throw endpointError(chunk.error, secrets);
  }
  if (typeof chunk.id === "string" && acc.id === null) {
    acc.id = chunk.id;
  }
  if (typeof chunk.model === "string") {
    acc.model = chunk.model;
  }
  if (Number.isFinite(chunk.created)) {
    acc.created = chunk.created;
  }
  const usage = normalizeUsage(chunk.usage);
  if (usage !== null) {
    acc.usage = usage;
  }

  const choices = chunk.choices;
  if (!Array.isArray(choices)) {
    throw new ProviderError("protocol", "provider: stream frame has no choices array");
  }
  if (choices.length === 0) {
    return; // usage-only frame
  }
  const choice = plainObject(choices[0]) ? choices[0] : {};
  if (choice.finish_reason !== undefined && choice.finish_reason !== null) {
    acc.finishReason = String(choice.finish_reason);
  }
  const delta = plainObject(choice.delta) ? choice.delta : plainObject(choice.message) ? choice.message : null;
  if (delta === null) {
    return;
  }
  if (typeof delta.role === "string" && delta.role !== "") {
    acc.role = delta.role;
  }

  const content = normalizeContent(delta.content);
  if (typeof content === "string" && content !== "") {
    acc.content += content;
    emit(onEvent, { type: "text", text: content });
  }
  if (typeof delta.reasoning_content === "string" && delta.reasoning_content !== "") {
    acc.reasoning += delta.reasoning_content;
    emit(onEvent, { type: "reasoning", text: delta.reasoning_content });
  }
  if (Array.isArray(delta.tool_calls)) {
    delta.tool_calls.forEach((call, index) => {
      applyToolCallDelta(acc, call, index, onEvent);
    });
  }
}

/** @param {Function|null} onEvent @param {object} event */
function emit(onEvent, event) {
  if (onEvent !== null) {
    onEvent(event);
  }
}

/**
 * Merge one streamed tool-call fragment.  Frames carry `index`; `id` and
 * `function.name` usually arrive once, `function.arguments` in pieces.
 * @param {object} acc
 * @param {unknown} raw
 * @param {number} fallbackIndex
 * @param {Function|null} onEvent
 */
function applyToolCallDelta(acc, raw, fallbackIndex, onEvent) {
  if (!plainObject(raw)) {
    throw new ProviderError("protocol", "provider: stream tool_call is not an object");
  }
  const index = Number.isInteger(raw.index) ? raw.index : fallbackIndex;
  let entry = acc.calls.get(index);
  if (entry === undefined) {
    entry = { index, id: null, type: "function", function: { name: "", arguments: "" } };
    acc.calls.set(index, entry);
  }
  if (typeof raw.id === "string" && raw.id !== "" && entry.id === null) {
    entry.id = raw.id;
  }
  if (typeof raw.type === "string" && raw.type !== "") {
    entry.type = raw.type;
  }
  const fn = raw.function;
  if (!plainObject(fn)) {
    return;
  }
  if (typeof fn.name === "string" && fn.name !== "") {
    if (entry.function.name === "") {
      entry.function.name = fn.name;
    } else if (fn.name !== entry.function.name && !entry.function.name.endsWith(fn.name)) {
      entry.function.name += fn.name; // some servers split the name across frames
    }
  }
  if (typeof fn.arguments === "string" && fn.arguments !== "") {
    entry.function.arguments += fn.arguments;
    emit(onEvent, {
      type: "tool_call",
      index,
      id: entry.id,
      name: entry.function.name,
      argumentsDelta: fn.arguments
    });
  }
}

/**
 * Turn the accumulator into the same shape a non-streaming answer has.
 * @param {object} acc
 * @returns {object}
 */
function finalizeAccumulator(acc) {
  const entries = [...acc.calls.values()].sort((a, b) => a.index - b.index);
  for (const entry of entries) {
    if (entry.function.name === "") {
      throw new ProviderError("protocol", "provider: streamed tool_call #" + entry.index + " never said which function it was");
    }
  }
  const calls = entries.map((call) => ({
    id: call.id,
    type: "function",
    function: { name: call.function.name, arguments: call.function.arguments }
  }));
  const message = {
    role: acc.role,
    content: acc.content === "" && calls.length > 0 ? null : acc.content
  };
  if (calls.length > 0) {
    message.tool_calls = calls;
  }
  if (acc.reasoning !== "") {
    message.reasoning_content = acc.reasoning;
  }
  return {
    id: acc.id,
    model: acc.model,
    created: acc.created,
    message,
    finishReason: acc.finishReason,
    usage: acc.usage,
    streamed: true
  };
}

/* ------------------------------------------------------------------ */
/* HTTP                                                                */
/* ------------------------------------------------------------------ */

/** @param {unknown} error @returns {ProviderError} */
function endpointError(error, secrets) {
  const message = plainObject(error) && typeof error.message === "string" ? error.message : String(error);
  const type = plainObject(error) && typeof error.type === "string" ? " [" + error.type + "]" : "";
  return new ProviderError("protocol", "provider: the endpoint reported an error" + type + ": " + snippet(message, secrets, 300), {
    detail: snippet(typeof error === "string" ? error : JSON.stringify(error), secrets, 500)
  });
}

/**
 * @param {number} status
 * @param {string} text
 * @param {Headers|null} headers
 * @param {string[]} secrets
 * @returns {ProviderError}
 */
function httpError(status, text, headers, secrets) {
  const detail = snippet(text, secrets, 400);
  let kind = "protocol";
  let label = "unexpected HTTP response";
  if (status === 401 || status === 403) {
    kind = "auth";
    label = "authentication failed";
  } else if (status === 429) {
    kind = "rate";
    label = "rate limited";
  }
  let retryAfterMs = null;
  if (headers !== null && typeof headers.get === "function") {
    const seconds = Number(headers.get("retry-after"));
    if (Number.isFinite(seconds) && seconds >= 0) {
      retryAfterMs = Math.round(seconds * 1000);
    }
  }
  return new ProviderError(kind, "provider: " + label + " (HTTP " + status + ")" + (detail === "" ? "" : ": " + detail), {
    status,
    detail,
    retryAfterMs,
    retryable: kind === "rate" || status >= 500
  });
}

/**
 * Read a whole response body, with abort/timeout classification and a size cap.
 * @param {Response} response
 * @param {{didTimeOut: () => boolean}} abort
 * @param {AbortSignal|undefined} outer
 * @param {string[]} secrets
 * @param {string} what
 * @returns {Promise<string>}
 */
async function readBodyText(response, abort, outer, secrets, what) {
  let text;
  try {
    text = await response.text();
  } catch (error) {
    throw classifyIoError(error, abort, outer, secrets);
  }
  if (typeof text !== "string") {
    return "";
  }
  if (text.length > MAX_BODY_BYTES) {
    throw new ProviderError("protocol", "provider: " + what + " is larger than " + MAX_BODY_BYTES + " bytes");
  }
  return text;
}

/**
 * @param {unknown} json
 * @param {string[]} secrets
 * @param {boolean} streamed
 * @returns {object}
 */
function normalizeCompletion(json, secrets, streamed) {
  if (!plainObject(json)) {
    throw new ProviderError("protocol", "provider: response is not a JSON object");
  }
  if (json.error !== undefined && json.error !== null) {
    throw endpointError(json.error, secrets);
  }
  if (!Array.isArray(json.choices) || json.choices.length === 0) {
    throw new ProviderError("protocol", "provider: response has no choices[0]");
  }
  const choice = plainObject(json.choices[0]) ? json.choices[0] : null;
  if (choice === null) {
    throw new ProviderError("protocol", "provider: response has no choices[0]");
  }
  return {
    id: typeof json.id === "string" ? json.id : null,
    model: typeof json.model === "string" ? json.model : null,
    created: Number.isFinite(json.created) ? json.created : null,
    message: normalizeAssistantMessage(choice.message, "response.choices[0].message"),
    finishReason: choice.finish_reason === undefined ? null : choice.finish_reason,
    usage: normalizeUsage(json.usage),
    streamed
  };
}

/**
 * Consume an SSE response into one normalized answer, forwarding deltas.
 * @param {Response} response
 * @param {{didTimeOut: () => boolean, signal: AbortSignal}} abort
 * @param {AbortSignal|undefined} outer
 * @param {Function|null} onEvent
 * @param {{emitted: boolean}} state
 * @param {string[]} secrets
 * @returns {Promise<object>}
 */
async function consumeStream(response, abort, outer, onEvent, state, secrets) {
  const contentType = String(response.headers.get("content-type") || "").toLowerCase();
  if (!contentType.includes("text/event-stream")) {
    if (contentType.includes("json")) {
      // A server that ignores `stream: true` still owes us one valid answer.
      const text = await readBodyText(response, abort, outer, secrets, "response body");
      const json = parseJsonOrFail(text, secrets);
      const result = normalizeCompletion(json, secrets, false);
      emit(onEvent, { type: "done", finishReason: result.finishReason, streamed: false });
      return result;
    }
    throw new ProviderError(
      "protocol",
      "provider: expected text/event-stream, got " + (contentType === "" ? "no content-type" : contentType)
    );
  }

  if (response.body === null || typeof response.body.getReader !== "function") {
    throw new ProviderError("protocol", "provider: the stream response has no body");
  }
  const reader = response.body.getReader();
  const decoder = new TextDecoder("utf-8");
  const frames = new SseFrames();
  const acc = createAccumulator();
  let done = false;

  const handlePayloads = (payloads) => {
    for (const payload of payloads) {
      if (payload.trim() === "[DONE]") {
        done = true;
        return;
      }
      const chunk = parseJsonOrFail(payload, secrets);
      state.emitted = true;
      applyChunk(acc, chunk, secrets, onEvent);
      if (done) {
        return;
      }
    }
  };

  try {
    for (;;) {
      let next;
      try {
        next = await reader.read();
      } catch (error) {
        throw classifyIoError(error, abort, outer, secrets);
      }
      if (next.done) {
        break;
      }
      handlePayloads(frames.push(decoder.decode(next.value, { stream: true })));
      if (done) {
        break;
      }
    }
    if (!done) {
      handlePayloads(frames.flush());
    }
  } finally {
    try {
      await reader.cancel();
    } catch {
      // The stream is already closed or aborted; nothing to release.
    }
  }

  if (!done && acc.finishReason === null) {
    throw new ProviderError("protocol", "provider: stream ended before [DONE]");
  }
  const result = finalizeAccumulator(acc);
  emit(onEvent, { type: "done", finishReason: result.finishReason, streamed: true });
  return result;
}

/** @param {string} text @param {string[]} secrets @returns {unknown} */
function parseJsonOrFail(text, secrets) {
  try {
    return JSON.parse(text);
  } catch {
    throw new ProviderError("protocol", "provider: stream frame is not JSON: " + snippet(text, secrets, 200));
  }
}

/** @param {number} ms @param {AbortSignal|undefined} signal @returns {Promise<void>} */
function sleep(ms, signal) {
  return new Promise((resolve, reject) => {
    if (signal !== undefined && signal !== null && signal.aborted) {
      reject(new ProviderError("cancelled", "provider: request cancelled"));
      return;
    }
    let timer = null;
    const finish = () => {
      cleanup();
      resolve();
    };
    const onAbort = () => {
      cleanup();
      reject(new ProviderError("cancelled", "provider: request cancelled"));
    };
    const cleanup = () => {
      if (timer !== null) {
        clearTimeout(timer);
      }
      if (signal !== undefined && signal !== null) {
        signal.removeEventListener("abort", onAbort);
      }
    };
    timer = setTimeout(finish, Math.max(0, ms));
    if (signal !== undefined && signal !== null) {
      signal.addEventListener("abort", onAbort, { once: true });
    }
  });
}

/* ------------------------------------------------------------------ */
/* the provider                                                        */
/* ------------------------------------------------------------------ */

/**
 * Build a provider from settings (see config.mjs) plus transport options.
 *
 * @param {object} options
 *   `baseUrl`, `model`, `apiKey`, `temperature`, `maxTokens`, `timeoutMs`,
 *   `stream` -- as stored by config.mjs; and `fetchImpl` (default global
 *   fetch), `headers` (extra request headers), `retryDelayMs`, `retryLimit`.
 * @returns {{
 *   settings: object,
 *   endpoint: string,
 *   describe: () => object,
 *   chat: (request?: object) => Promise<object>,
 *   stream: (request: object, onEvent?: Function) => Promise<object>,
 *   complete: (request?: object) => Promise<object>
 * }}
 */
export function createProvider(options = {}) {
  if (!plainObject(options)) {
    throw new ConfigError("provider: options must be an object");
  }
  const settingsInput = {};
  for (const key of Object.keys(options)) {
    if (!TRANSPORT_KEYS.includes(key)) {
      settingsInput[key] = options[key];
    }
  }
  const normalized = normalizeConfig(settingsInput, { strict: true });
  if (normalized.errors.length > 0) {
    throw new ConfigError("provider: invalid settings", normalized.errors);
  }
  const settings = Object.freeze({ ...normalized.config });
  const transport = normalizeTransport(options);
  const endpoint = endpointUrl(settings.baseUrl);
  const secrets = settings.apiKey === "" ? [] : [settings.apiKey];

  function headersFor(stream) {
    const headers = {
      "content-type": "application/json",
      accept: stream ? "text/event-stream" : "application/json"
    };
    if (settings.apiKey !== "") {
      headers.authorization = "Bearer " + settings.apiKey;
    }
    for (const name of Object.keys(transport.headers)) {
      headers[name.toLowerCase()] = transport.headers[name];
    }
    return headers;
  }

  /**
   * One attempt, including reading the whole body so that the timeout covers
   * it.  Retries live in `post`.
   */
  async function attempt(body, stream, outerSignal, onEvent, state) {
    const abort = createAbort(outerSignal, settings.timeoutMs);
    try {
      let response;
      try {
        response = await transport.fetchImpl(endpoint, {
          method: "POST",
          headers: headersFor(stream),
          body: JSON.stringify(body),
          signal: abort.signal
        });
      } catch (error) {
        throw classifyIoError(error, abort, outerSignal, secrets);
      }
      if (!response.ok) {
        const text = await readBodyText(response, abort, outerSignal, secrets, "error response body");
        throw httpError(response.status, text, response.headers, secrets);
      }
      if (stream) {
        return await consumeStream(response, abort, outerSignal, onEvent, state, secrets);
      }
      const text = await readBodyText(response, abort, outerSignal, secrets, "response body");
      const json = parseJsonOrFail(text, secrets);
      return normalizeCompletion(json, secrets, false);
    } finally {
      abort.cleanup();
    }
  }

  /**
   * @param {object} body
   * @param {boolean} stream
   * @param {AbortSignal|undefined} outerSignal
   * @param {Function|null} onEvent
   * @returns {Promise<object>}
   */
  async function post(body, stream, outerSignal, onEvent) {
    const state = { emitted: false };
    for (let attemptIndex = 0; ; attemptIndex += 1) {
      try {
        return await attempt(body, stream, outerSignal, onEvent, state);
      } catch (error) {
        const retryable =
          error instanceof ProviderError &&
          error.kind === "network" &&
          error.retryable === true &&
          error.timedOut === false &&
          error.status === null &&
          attemptIndex < transport.retryLimit &&
          !state.emitted;
        if (!retryable) {
          throw error;
        }
        await sleep(transport.retryDelayMs, outerSignal);
      }
    }
  }

  function requestBody(request, stream) {
    return buildBody(request, stream, settings);
  }

  const provider = {
    get settings() {
      return { ...settings };
    },
    endpoint,
    describe() {
      return {
        ...describeConfig(settings),
        retryDelayMs: transport.retryDelayMs,
        retryLimit: transport.retryLimit
      };
    },
    /**
     * One non-streaming completion.
     * @param {object} [request] {messages, tools?, toolChoice?, model?, ...}
     * @returns {Promise<{id, model, created, message, finishReason, usage, streamed}>}
     */
    chat(request) {
      const req = request === undefined || request === null ? {} : request;
      const signal = plainObject(req) ? req.signal : undefined;
      return post(requestBody(req, false), false, signal, null);
    },
    /**
     * One streaming completion, assembled into the non-streaming shape.
     * `onEvent` receives {type:"text"|"reasoning"|"tool_call"|"done", ...}.
     * @param {object} request
     * @param {Function} [onEvent]
     * @returns {Promise<object>}
     */
    stream(request, onEvent) {
      const req = request === undefined || request === null ? {} : request;
      const signal = plainObject(req) ? req.signal : undefined;
      const callback = typeof onEvent === "function" ? onEvent : null;
      return post(requestBody(req, true), true, signal, callback);
    },
    /**
     * Transport picked by `request.stream` (falling back to the setting);
     * `request.onEvent` receives the deltas when streaming.
     * @param {object} [request]
     * @returns {Promise<object>}
     */
    complete(request) {
      const req = request === undefined || request === null ? {} : request;
      if (!plainObject(req)) {
        throw new ConfigError("provider: request must be an object");
      }
      const wantStream = req.stream === undefined ? settings.stream : req.stream === true;
      const callback = typeof req.onEvent === "function" ? req.onEvent : null;
      return wantStream ? provider.stream(req, callback) : provider.chat(req);
    }
  };

  return provider;
}

