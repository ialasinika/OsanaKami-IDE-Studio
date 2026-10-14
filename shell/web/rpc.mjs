/**
 * rpc.mjs -- the client side of the frozen kernel protocol.
 *
 * DELETE THIS FILE to remove all contact with the kernel: nothing else in
 * `shell/web/` opens a socket, and the board would render as an empty canvas.
 *
 * Two transports, one object:
 *
 *   POST /rpc     request/response, one JSON object in, one out
 *   GET  /events  SSE, one `data: <json>\n\n` frame per notification
 *
 * The SSE reader deliberately does not use `EventSource`: it is absent in Node,
 * which is where `selftest.mjs` runs, so the same code path is exercised by the
 * browser and by the test.  Chunk boundaries are arbitrary -- a frame can be
 * split mid-line, mid-JSON or mid-UTF-8 -- so the framing is done on a rolling
 * buffer and `TextDecoder` in streaming mode.
 *
 * No imports, no DOM: this module is pure enough to unit-test in Node.
 */

/** The kernel answered a request with `{"ok":false,"error":{...}}`. */
export class RpcError extends Error {
  /**
   * @param {{code?: any, name?: any, message?: any, data?: any}} error
   * @param {string} method  the method that failed, for the message
   * @param {string} [transport]  non-null when the failure was local (HTTP, network)
   */
  constructor(error, method, transport) {
    const err = error && typeof error === "object" ? error : {};
    const message = typeof err.message === "string" && err.message !== ""
      ? err.message
      : "rpc call failed";
    super(transport ? `${method}: ${transport}` : `${method}: ${message}`);
    this.name = "RpcError";
    this.method = method;
    /** Integer from the wire, or the raw value when the wire sent something
     *  else (some endpoints put the symbolic name in `code`). */
    this.code = Number.isInteger(err.code) || typeof err.code === "string" ? err.code : null;
    /** Symbolic name from the wire, e.g. `STALE_REVISION`. */
    this.errorName = typeof err.name === "string" ? err.name : "";
    /** The wire's own message, without our `method:` prefix. */
    this.message_ = message;
    this.data = err.data === undefined ? null : err.data;
    this.transport = transport === undefined ? null : transport;
  }

  /**
   * Best-effort symbol for this failure.
   *
   * The error contract is `{code, name, message}` but real endpoints disagree
   * about which field carries the symbolic name (some put `STALE_REVISION` in
   * `name`, some in `code`, some only in `data`), so all of them are considered.
   * This keeps dirty-state handling working against any of those shapes.
   */
  get symbol() {
    if (this.errorName !== "") {
      return this.errorName;
    }
    const dataName = this.data && typeof this.data === "object" ? this.data.name : null;
    if (typeof dataName === "string" && dataName !== "") {
      return dataName;
    }
    if (typeof this.code === "string" && /\D/.test(this.code)) {
      return this.code;
    }
    return this.code === null ? "" : String(this.code);
  }
}

/** True when an error (any shape) is a stale-revision rejection. */
export function isStaleRevision(error) {
  if (error === null || error === undefined) {
    return false;
  }
  const parts = [error.symbol, error.name, error.code, error.errorName];
  if (error.data && typeof error.data === "object") {
    parts.push(error.data.name, error.data.code);
  }
  return parts.some((part) => String(part ?? "").includes("STALE_REVISION"));
}

/**
 * `error.data.current_revision` from a stale write, or `null`.
 * Accepts both `data.current_revision` and a bare `data` that is the number.
 */
export function staleCurrentRevision(error) {
  const data = error && error.data;
  if (data === null || data === undefined) {
    return null;
  }
  if (typeof data === "number" || typeof data === "string") {
    return data;
  }
  if (typeof data === "object") {
    if (data.current_revision !== undefined) {
      return data.current_revision;
    }
    if (data.revision !== undefined) {
      return data.revision;
    }
  }
  return null;
}

/* ------------------------------------------------------------------ */
/* SSE framing                                                         */
/* ------------------------------------------------------------------ */

/**
 * Incremental SSE frame splitter.
 *
 * Feed it text chunks in any sizes; it returns the `data` payloads of every
 * frame that became complete, preserving order.  A frame is terminated by a
 * blank line, which is what makes reassembly across chunk boundaries correct:
 * the tail of an incomplete frame stays in the buffer.
 *
 * Within a frame, each `data:` line contributes one line of payload joined with
 * `\n` (the SSE spec); `:` comment lines and other fields (`event:`, `id:`,
 * `retry:`) are ignored because the kernel packs everything into the JSON.
 */
export class SseParser {
  constructor() {
    this.pending = "";
    this.count = 0;
  }

  /** @param {string} chunk @returns {string[]} complete frame payloads */
  push(chunk) {
    this.pending += chunk;
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
        this.count += 1;
      }
    }
    return out;
  }

  /** A trailing frame with no blank line is still data when the stream ends. */
  flush() {
    const block = this.pending;
    this.pending = "";
    const payload = framePayload(block);
    if (payload === null) {
      return [];
    }
    this.count += 1;
    return [payload];
  }
}

/** Index of the blank line ending the first frame, or null. */
function findFrameEnd(text) {
  const lf = text.indexOf("\n\n");
  const crlf = text.indexOf("\r\n\r\n");
  if (lf < 0 && crlf < 0) {
    return null;
  }
  // Handle a `\r\n\r\n` that also contains the `\n\n` we would find first.
  if (crlf >= 0 && (lf < 0 || crlf < lf)) {
    return { end: crlf + 2, next: crlf + 4 };
  }
  if (crlf >= 0 && crlf + 2 === lf) {
    return { end: lf, next: lf + 2 };
  }
  return { end: lf, next: lf + 2 };
}

/** The payload of one raw frame block, or null when it carries no data. */
function framePayload(block) {
  const lines = block.split(/\r?\n/);
  const parts = [];
  for (const line of lines) {
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
/* the client                                                          */
/* ------------------------------------------------------------------ */

/**
 * @param {object} [options]
 * @param {string} [options.origin]  defaults to the page's origin
 * @param {Function} [options.fetchImpl]  injectable for tests
 * @param {AbortSignal} [options.signal]
 * @param {(state: object) => void} [options.onStatus]  connection-state feed
 * @param {number} [options.readyTimeoutMs]
 */
export function createClient(options = {}) {
  const {
    origin = "",
    fetchImpl = globalThis.fetch,
    signal = null,
    onStatus = null,
    readyTimeoutMs = 8000,
  } = options;

  if (typeof fetchImpl !== "function") {
    throw new TypeError("createClient: no fetch implementation available");
  }

  const base = origin === "" ? "" : origin.replace(/\/+$/, "");
  const url = (path) => `${base}${path}`;

  const handlers = new Map();
  const pending = new Map();
  let nextId = 1;
  let connected = false;
  let closed = false;
  let lastError = null;
  let streamDone = null;

  const state = {
    connected: false,
    lastError: null,
    events: 0,
    pending: 0,
    closed: false,
  };

  let resolveReady = null;
  let rejectReady = null;
  const readyPromise = new Promise((resolve, reject) => {
    resolveReady = resolve;
    rejectReady = reject;
  });
  // Nobody may await ready(); that must not be an unhandled rejection.
  readyPromise.catch(() => {});

  function setState(patch) {
    Object.assign(state, patch);
    if (onStatus !== null) {
      try {
        onStatus({ ...state });
      } catch {
        /* a broken status sink must never break the transport */
      }
    }
  }

  /** Deliver one notification object to its handlers. */
  function dispatch(notification) {
    if (notification === null || typeof notification !== "object") {
      return;
    }
    state.events += 1;
    const name = notification.event;
    const list = handlers.get(name);
    if (list === undefined) {
      return;
    }
    for (const handler of list) {
      try {
        handler(notification);
      } catch (err) {
        // One bad listener must not stop the others, and must not kill the loop.
        if (typeof console !== "undefined" && console.error) {
          console.error(`event handler for ${String(name)} failed`, err);
        }
      }
    }
  }

  /** Turn raw frame payloads into notifications; malformed frames are dropped. */
  function dispatchPayloads(payloads) {
    for (const payload of payloads) {
      let parsed = null;
      try {
        parsed = JSON.parse(payload);
      } catch {
        parsed = null;
      }
      if (parsed !== null) {
        dispatch(parsed);
      }
    }
  }

  function failTransport(error) {
    lastError = error;
    setState({ connected: false, lastError: error });
    const err = new RpcError(
      { code: null, name: "TRANSPORT", message: `${error.name}: ${error.message}` },
      "events",
      `${error.name}: ${error.message}`,
    );
    for (const [, entry] of pending) {
      entry.reject(err);
    }
    pending.clear();
    setState({ pending: 0 });
    if (rejectReady !== null && !connected) {
      rejectReady(err);
      rejectReady = null;
      resolveReady = null;
    }
  }

  /** Open the POST channel for one call. */
  function call(method, params = {}) {
    const id = nextId;
    nextId += 1;

    if (closed) {
      return Promise.reject(new RpcError(
        { code: null, name: "CLIENT_CLOSED", message: "the client was closed" },
        method,
        "the client was closed",
      ));
    }

    return new Promise((resolve, reject) => {
      const entry = { resolve, reject, method };
      pending.set(id, entry);
      setState({ pending: pending.size });

      const init = {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        // The id is what makes this a request rather than a notification: the
        // host answers by echoing it, and without it the host correctly
        // replies 204 No Content, leaving this promise pending forever.
        body: JSON.stringify({
          jsonrpc: "2.0",
          id,
          method,
          params: params === undefined ? {} : params,
        }),
      };
      if (signal !== null) {
        init.signal = signal;
      }

      let response;
      try {
        response = fetchImpl(url("/rpc"), init);
      } catch (err) {
        pending.delete(id);
        setState({ pending: pending.size, lastError: err });
        reject(new RpcError(
          { code: null, name: "TRANSPORT", message: String(err && err.message) },
          method,
          `network error: ${err && err.message}`,
        ));
        return;
      }

      Promise.resolve(response).then(
        (res) => {
          if (!res || typeof res.text !== "function") {
            throw new RpcError(
              { code: null, name: "TRANSPORT", message: "no HTTP response" },
              method,
              "the host returned no response",
            );
          }
          if (res.ok === false) {
            const status = res.status === undefined ? "?" : res.status;
            throw new RpcError(
              { code: null, name: "HTTP_STATUS", message: `HTTP ${status}` },
              method,
              `the host answered HTTP ${status}`,
            );
          }
          return res.text();
        },
        (err) => {
          throw new RpcError(
            { code: null, name: "TRANSPORT", message: String(err && err.message) },
            method,
            `network error: ${err && err.message}`,
          );
        },
      ).then(
        (body) => {
          pending.delete(id);
          setState({ pending: pending.size });
          let reply = null;
          try {
            reply = JSON.parse(body);
          } catch {
            reject(new RpcError(
              { code: null, name: "BAD_REPLY", message: "reply is not JSON" },
              method,
              "the host's reply was not JSON",
            ));
            return;
          }
          if (reply === null || typeof reply !== "object") {
            reject(new RpcError(
              { code: null, name: "BAD_REPLY", message: "reply is not an object" },
              method,
              "the host's reply was not an object",
            ));
            return;
          }
          /*
           * The id is not bookkeeping: with several calls in flight it is the
           * only thing that says *which* request this reply answers.  Accepting
           * a mismatched id would hand one caller another caller's result, so it
           * is rejected before the result or the error is even looked at.
           */
          if (reply.id !== id) {
            reject(new RpcError(
              {
                code: null,
                name: "BAD_REPLY",
                message: `reply id ${JSON.stringify(reply.id)} does not match request id ${id}`,
              },
              method,
              `the host answered a different request (id ${JSON.stringify(reply.id)}, expected ${id})`,
            ));
            return;
          }
          /*
           * The host speaks JSON-RPC: it echoes the id and carries either a
           * `result` or an `error`.  Both the kernel and the shell answer in
           * exactly this shape, so there is no second reply format to guess.
           */
          if (reply.error !== undefined && reply.error !== null) {
            const error = reply.error;
            setState({ lastError: new RpcError(error, method) });
            reject(new RpcError(error, method));
            return;
          }
          if (!("result" in reply)) {
            reject(new RpcError(
              { code: null, name: "BAD_REPLY", message: "reply has no result" },
              method,
              "the host's reply carried neither a result nor an error",
            ));
            return;
          }
          resolve(reply.result);
        },
        (err) => {
          pending.delete(id);
          setState({ pending: pending.size });
          if (err instanceof RpcError) {
            setState({ lastError: err });
            reject(err);
            return;
          }
          const wrapped = new RpcError(
            { code: null, name: "TRANSPORT", message: String(err && err.message) },
            method,
            String(err && err.message),
          );
          setState({ lastError: wrapped });
          reject(wrapped);
        },
      );
    });
  }

  /** Subscribe to one notification name; returns an unsubscribe function. */
  function on(eventName, handler) {
    if (typeof handler !== "function") {
      throw new TypeError("on(eventName, handler): handler must be a function");
    }
    let list = handlers.get(eventName);
    if (list === undefined) {
      list = [];
      handlers.set(eventName, list);
    }
    list.push(handler);
    return () => {
      const current = handlers.get(eventName);
      if (current === undefined) {
        return;
      }
      const at = current.indexOf(handler);
      if (at >= 0) {
        current.splice(at, 1);
      }
    };
  }

  /** Read the SSE stream until it ends. Resolves when the stream is done. */
  async function runStream() {
    const parser = new SseParser();
    const init = { headers: { Accept: "text/event-stream" } };
    if (signal !== null) {
      init.signal = signal;
    }
    const response = await fetchImpl(url("/events"), init);
    if (!response || response.ok === false) {
      const status = response && response.status !== undefined ? response.status : "?";
      throw new Error(`events: HTTP ${status}`);
    }
    if (!response.body || typeof response.body.getReader !== "function") {
      throw new Error("events: response has no readable body");
    }
    setState({ connected: true, lastError: null });
    connected = true;
    if (resolveReady !== null) {
      resolveReady(client);
      resolveReady = null;
      rejectReady = null;
    }

    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    for (;;) {
      const { done, value } = await reader.read();
      if (done) {
        break;
      }
      const chunk = typeof value === "string"
        ? value
        : decoder.decode(value, { stream: true });
      dispatchPayloads(parser.push(chunk));
    }
    const tail = decoder.decode();
    if (tail !== "") {
      dispatchPayloads(parser.push(tail));
    }
    dispatchPayloads(parser.flush());
    setState({ connected: false });
  }

  /** Start consuming `/events`. Idempotent. */
  function connect() {
    if (streamDone !== null) {
      return streamDone;
    }
    streamDone = runStream().catch((err) => {
      failTransport(err);
    });
    return streamDone;
  }

  /** Resolves once the event stream is open, rejects if it cannot open. */
  function ready() {
    if (streamDone === null) {
      connect();
    }
    return readyPromise;
  }

  function close() {
    closed = true;
    setState({ closed: true, connected: false, pending: 0 });
    for (const [, entry] of pending) {
      entry.reject(new RpcError(
        { code: null, name: "CLIENT_CLOSED", message: "the client was closed" },
        entry.method,
        "the client was closed",
      ));
    }
    pending.clear();
  }

  const client = { call, on, connect, ready, close, isStaleRevision, readyPromise };

  // Convenience getters; cheap and handy from a console.
  Object.defineProperties(client, {
    state: { get: () => ({ ...state }) },
    connected: { get: () => state.connected },
    lastError: { get: () => state.lastError },
  });

  return client;
}
