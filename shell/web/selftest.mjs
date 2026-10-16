/**
 * selftest.mjs -- the shell's proof, runnable with no browser and no kernel.
 *
 *     node shell/web/selftest.mjs
 *
 * It imports the pure parts of the web shell and drives them with a fake
 * `fetch` (an in-memory SSE stream) and no DOM at all, so the protocol
 * plumbing, the board model, the undo ring and the token-span logic are checked
 * exactly as the browser will use them.
 *
 * What that means: there is no browser here. Canvas layout, pointer gestures
 * (drag, resize, drawing a link), focus, keyboard handling and every CSS rule
 * are never exercised. One check calls `renderCard` against a stub element that
 * records structure and nothing else, purely to prove that a malformed board
 * entry produces a placeholder instead of an exception. The `note:` line at the
 * end of every run says the same thing, so a green run is never read as "the
 * browser was tested".
 *
 * Exit code is 0 only when every check passes; the summary is `ok N/N`.
 */

import assert from "node:assert/strict";
import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { inflateSync } from "node:zlib";

import {
  createClient,
  isStaleRevision,
  SseParser,
  RpcError,
  staleCurrentRevision,
} from "./rpc.mjs";

import {
  CARD_KINDS,
  DEFAULT_SIZE,
  MIN_SIZE,
  ZOOM_MAX,
  ZOOM_MIN,
  clampViewport,
  createBoard,
  normaliseDocument,
} from "./board.mjs";

import {
  CARD_KIND_CONTRACT,
  INDENT_UNIT,
  OutputBuffer,
  SHEET_TYPES,
  addSheetColumn,
  addSheetRow,
  applyTokenSpans,
  cardKind,
  coerceSheetValue,
  describeCard,
  diagCounts,
  diagFile,
  diagWhere,
  dirNameOf,
  emptySheet,
  findMatches,
  formatAge,
  formatExit,
  formatListing,
  formatSize,
  groupDefines,
  indentAfterEnter,
  indentSelection,
  knownCardKinds,
  lineColumn,
  markHits,
  matchesFilter,
  modHeadline,
  modPath,
  nextSheetSelection,
  normaliseSheet,
  normaliseTokenKind,
  parseCommandLine,
  parseZoomArgument,
  pixelColourOf,
  pixelInkOf,
  pixelPaletteOf,
  projectRows,
  projectSummary,
  registerCardKind,
  removeSheetColumn,
  removeSheetRow,
  renderCard,
  replaceAllMatches,
  replaceMatchAt,
  segmentsText,
  setSheetCell,
  sheetCell,
  sheetSummary,
  sheetToTSV,
  storyAcceptSuggestion,
  storyAddLine,
  storyEditableText,
  storyLineIds,
  storyLineText,
  storyRowForLine,
  storySetSpeaker,
  storySetText,
  storySuggestions,
  storyWriteText,
  unknownCardPlaceholder,
} from "./cards.mjs";

import {
  applyCommand,
  commandTypedAt,
  completeYsls,
  parseYsls,
  yslsAbout,
  yslsSignature,
} from "./ysls.mjs";

/*
 * `main.mjs` is importable under Node on purpose (it only builds the app when
 * there is a `document`), which is what lets the two DOM-free helpers behind
 * the listener-leak and save-reporting fixes be checked here for real instead
 * of through a browser.
 */
import { saveOutcomeMessage, scrollRoom, wireChoiceStrip } from "./main.mjs";

import { createHistory, describeChange } from "./history.mjs";
import {
  CLASSIC_SIDEBAR_KINDS,
  CLASSIC_TAB_H,
  classicLayout,
  classicRoles,
  classicTabLabel,
} from "./classic.mjs";

import {
  MOD_AREA_MIN,
  MOD_PANEL_H,
  MOD_PANEL_KINDS,
  MOD_PANEL_MIN,
  MOD_SIDEBAR_KINDS,
  MOD_SIDEBAR_MIN,
  MOD_SIDEBAR_W,
  MOD_TAB_H,
  modLayout,
  modRoles,
} from "./modview.mjs";

import {
  DEFAULT_VIEW,
  SWITCH_VIEWS,
  VIEWS,
  VIEW_LABELS,
  VIEW_TITLES,
  tiledView,
  viewAbout,
  viewHud,
  viewName,
  viewNote,
} from "./views.mjs";

import {
  WATCH_GONE,
  WATCH_OK,
  WATCH_RELOAD,
  WATCH_UNKNOWN,
  WATCH_WARN,
  watchDecision,
  watchReport,
  watchTrimmed,
} from "./watch.mjs";

import {
  LINE_ID,
  STORY_LINE_KINDS,
  lineIdOf,
  nextLineId,
  parseStory,
  serializeStory,
  setLineSpeaker,
  setLineText,
  storyAbout,
  storyLines,
  storyNodes,
} from "./story.mjs";

import {
  CSV_BOM,
  CSV_COLUMNS,
  compareTables,
  csvLineIdOf,
  idOfLine,
  lockOf,
  looksLikeLock,
  metadataOf,
  parseCsv,
  rowFor,
  rowsById,
  rowState,
  serializeCsv,
  setColumn,
  speakersOf,
} from "./storycsv.mjs";

import {
  PNG_SIGNATURE,
  blankImage,
  decodePng,
  encodePng,
  pixelAt,
  setPixelAt,
} from "./pixelpng.mjs";

/* ------------------------------------------------------------------ */
/* the smallest useful test harness                                    */
/* ------------------------------------------------------------------ */

const failures = [];
let checks = 0;

function test(name, fn) {
  checks += 1;
  try {
    fn();
  } catch (err) {
    failures.push({ name, err });
  }
}

async function testAsync(name, fn) {
  checks += 1;
  try {
    await fn();
  } catch (err) {
    failures.push({ name, err });
  }
}

/* ------------------------------------------------------------------ */
/* a fake /rpc and a fake SSE stream                                   */
/* ------------------------------------------------------------------ */

/** An SSE body whose chunks can be cut anywhere we like. */
function sseStream(chunks, { holdOpen = false } = {}) {
  let index = 0;
  return new ReadableStream({
    pull(controller) {
      if (index < chunks.length) {
        const chunk = chunks[index];
        index += 1;
        controller.enqueue(typeof chunk === "string" ? new TextEncoder().encode(chunk) : chunk);
        return;
      }
      if (!holdOpen) {
        controller.close();
      }
    },
  });
}

/**
 * @param {object} options
 * @param {Array<object|Function>} options.replies  one per POST, in order
 * @param {string[]} [options.chunks]  raw SSE chunks
 */
/**
 * The mock host answers in JSON-RPC, because that is the only shape the real
 * host uses: the request's id comes back with either a `result` or an `error`.
 * Testing against any other shape would prove nothing about the real endpoint.
 */
function toJsonRpc(value, record) {
  const id = record && record.body && record.body.id !== undefined ? record.body.id : null;
  if (value === undefined) {
    return { jsonrpc: "2.0", id, result: {} };
  }
  if (value.ok === true) {
    return { jsonrpc: "2.0", id, result: value.result };
  }
  if (value.error !== undefined) {
    return { jsonrpc: "2.0", id, error: value.error };
  }
  return { jsonrpc: "2.0", id, result: value.result === undefined ? value : value.result };
}

function fakeFetch({ replies = [], chunks = [], holdOpen = false, onCall = null }) {
  const calls = [];
  let replyIndex = 0;
  const impl = async (url, init) => {
    const record = { url, init, body: init && init.body ? JSON.parse(init.body) : null };
    calls.push(record);
    if (onCall !== null) {
      onCall(record);
    }
    if (url.endsWith("/events")) {
      return { ok: true, status: 200, body: sseStream(chunks, { holdOpen }) };
    }
    const reply = replies[replyIndex];
    replyIndex += 1;
    const value = typeof reply === "function" ? reply(record) : reply;
    if (value instanceof Error) {
      throw value;
    }
    if (value && value.httpError === true) {
      return { ok: false, status: value.status || 500, text: async () => "" };
    }
    return {
      ok: true,
      status: 200,
      text: async () => JSON.stringify(toJsonRpc(value, record)),
    };
  };
  impl.calls = calls;
  return impl;
}

/** Let every already-resolved promise chain run to completion. */
const tick = (n = 6) => new Promise((resolve) => {
  let left = n;
  const step = () => {
    left -= 1;
    if (left <= 0) {
      resolve();
    } else {
      setTimeout(step, 0);
    }
  };
  setTimeout(step, 0);
});

/* ------------------------------------------------------------------ */
/* stub elements, for the checks that have to touch the DOM layer       */
/* ------------------------------------------------------------------ */

/**
 * Record structure, and nothing else.
 *
 * The suite has no browser, and the interesting half of `renderCard` is not
 * layout: it is the decision to fall back to a placeholder instead of throwing
 * on an entry that is not a card. That decision builds real elements through
 * `document.createElement`, so the smallest possible element stub is installed
 * for the duration of one check. It has no layout, no focus and no real events
 * -- which is exactly what the closing `note:` line says is not covered.
 */
function stubDom() {
  class StubElement {
    constructor(tag) {
      this.tagName = tag;
      this.children = [];
      this.attrs = {};
      this.className = "";
      this.textContent = "";
      this.classList = {
        add: (name) => {
          this.className = `${this.className} ${name}`.trim();
        },
      };
    }

    setAttribute(key, value) {
      this.attrs[key] = String(value);
    }

    append(child) {
      this.children.push(child);
      return child;
    }

    remove() {
      this.removed = true;
    }

    addEventListener() {}
  }

  const previous = Object.prototype.hasOwnProperty.call(globalThis, "document")
    ? globalThis.document
    : undefined;
  globalThis.document = {
    createElement: (tag) => new StubElement(tag),
    createTextNode: (text) => ({ textContent: String(text), children: [] }),
    createDocumentFragment: () => new StubElement("#fragment"),
  };

  return {
    /** Flatten every text node under a stub element. */
    text(el) {
      if (el === null || el === undefined) {
        return "";
      }
      const own = typeof el.textContent === "string" ? el.textContent : "";
      const kids = Array.isArray(el.children) ? el.children.map((child) => this.text(child)).join("") : "";
      return own + kids;
    },
    restore() {
      if (previous === undefined) {
        delete globalThis.document;
      } else {
        globalThis.document = previous;
      }
    },
  };
}

/** A listener-recording stand-in for a DOM element. */
function stubEventTarget() {
  const listeners = new Map();
  return {
    list(type) {
      return listeners.get(type) || [];
    },
    count(type) {
      return this.list(type).length;
    },
    addEventListener(type, fn) {
      const list = listeners.get(type) || [];
      list.push(fn);
      listeners.set(type, list);
    },
    removeEventListener(type, fn) {
      const list = listeners.get(type) || [];
      listeners.set(type, list.filter((entry) => entry !== fn));
    },
    fire(type) {
      for (const fn of [...this.list(type)]) {
        fn({ type });
      }
    },
  };
}

/* ------------------------------------------------------------------ */
/* rpc.mjs                                                             */
/* ------------------------------------------------------------------ */

await testAsync("sse: a frame split across chunk boundaries is reassembled", async () => {
  const fetchImpl = fakeFetch({
    chunks: [
      "data: {\"event\":\"log\",\"level\":\"inf",
      "o\",\"message\":\"one\"}\n",
      "\ndata: {\"event\":\"log\",\"level\":\"warn\",\"message\":\"two\"}\n\n",
    ],
  });
  const client = createClient({ origin: "http://127.0.0.1:1", fetchImpl });
  const seen = [];
  client.on("log", (event) => seen.push(event.message));
  client.connect();
  await client.ready();
  await tick();
  assert.deepEqual(seen, ["one", "two"]);
  assert.equal(client.connected, false, "a closed stream must report disconnected");
});

await testAsync("sse: three frames arriving in one chunk all dispatch, in order", async () => {
  const fetchImpl = fakeFetch({
    chunks: [
      "data: {\"event\":\"log\",\"message\":\"a\"}\n\n"
      + "data: {\"event\":\"log\",\"message\":\"b\"}\n\n"
      + "data: {\"event\":\"log\",\"message\":\"c\"}\n\n",
    ],
  });
  const client = createClient({ fetchImpl });
  const seen = [];
  client.on("log", (event) => seen.push(event.message));
  client.connect();
  await client.ready();
  await tick();
  assert.deepEqual(seen, ["a", "b", "c"]);
});

await testAsync("sse: UTF-8 split mid-codepoint does not corrupt a frame", async () => {
  // "→" is E2 86 92; cut it after the first byte.
  const bytes = new TextEncoder().encode("data: {\"event\":\"log\",\"message\":\"a→b\"}\n\n");
  const fetchImpl = fakeFetch({
    chunks: [bytes.slice(0, 30), bytes.slice(30)],
  });
  const client = createClient({ fetchImpl });
  const seen = [];
  client.on("log", (event) => seen.push(event.message));
  client.connect();
  await client.ready();
  await tick();
  assert.deepEqual(seen, ["a→b"]);
});

test("sse: SseParser keeps an incomplete frame buffered", () => {
  const parser = new SseParser();
  assert.deepEqual(parser.push("data: {\"event\":\"log\"}"), []);
  assert.deepEqual(parser.push("\n\n"), ["{\"event\":\"log\"}"]);
  assert.deepEqual(parser.push("data: {\"a\":1}\n\ndata: {\"b\":2}\n\n"), ["{\"a\":1}", "{\"b\":2}"]);
  assert.deepEqual(parser.push(": keep-alive comment\n\n"), []);
});

await testAsync("rpc: an ok:false reply becomes an RpcError carrying code/name/message/data", async () => {
  const fetchImpl = fakeFetch({
    replies: [{
      ok: false,
      error: { code: 409, name: "STALE_REVISION", message: "file moved on", data: { current_revision: 42 } },
    }],
  });
  const client = createClient({ fetchImpl });
  let caught = null;
  try {
    await client.call("file.write", { path: "a.yarn", text: "x", base_revision: 7 });
  } catch (err) {
    caught = err;
  }
  assert.ok(caught instanceof RpcError, "expected an RpcError");
  assert.equal(caught.code, 409);
  assert.equal(caught.errorName, "STALE_REVISION");
  assert.equal(caught.message, "file.write: file moved on");
  assert.equal(caught.message_, "file moved on");
  assert.deepEqual(caught.data, { current_revision: 42 });
  assert.equal(caught.method, "file.write");
  assert.equal(client.state.pending, 0, "a settled call must leave nothing pending");
});

await testAsync("rpc: a success reply resolves to result and the request is well formed", async () => {
  const fetchImpl = fakeFetch({ replies: [{ ok: true, result: { protocol: "infantgod/2" } }] });
  const client = createClient({ origin: "http://127.0.0.1:3939", fetchImpl });
  const result = await client.call("hello", {});
  assert.deepEqual(result, { protocol: "infantgod/2" });
  assert.equal(fetchImpl.calls[0].url, "http://127.0.0.1:3939/rpc");
  assert.equal(fetchImpl.calls[0].init.method, "POST");
  // A request, not a notification: the id is what makes the host answer.
  assert.equal(typeof fetchImpl.calls[0].body.id, "number");
  assert.deepEqual(fetchImpl.calls[0].body, {
    jsonrpc: "2.0", id: fetchImpl.calls[0].body.id, method: "hello", params: {},
  });
  assert.equal(fetchImpl.calls[0].init.headers["Content-Type"], "application/json");
});

await testAsync("rpc: STALE_REVISION surfaces data.current_revision to the caller", async () => {
  const fetchImpl = fakeFetch({
    replies: [{
      ok: false,
      error: { code: 409, name: "STALE_REVISION", message: "nope", data: { current_revision: 8 } },
    }],
  });
  const client = createClient({ fetchImpl });
  let caught = null;
  try {
    await client.call("file.write", { path: "a.yarn", text: "x", base_revision: 3 });
  } catch (err) {
    caught = err;
  }
  assert.ok(client.isStaleRevision(caught), "the client must recognise a stale write");
  assert.equal(staleCurrentRevision(caught), 8);
  assert.equal(caught.data.current_revision, 8);
  // The same rejection is recognised when the endpoint puts the name in `code`.
  const alt = new RpcError({ code: "STALE_REVISION", message: "nope" }, "file.write");
  assert.ok(isStaleRevision(alt));
  assert.equal(staleCurrentRevision(alt), null);
  assert.ok(!isStaleRevision(new RpcError({ code: 404, name: "NO_SUCH_FILE", message: "x" }, "file.read")));
});

await testAsync("rpc: an unreachable host rejects the call and flips the status", async () => {
  const fetchImpl = async () => {
    throw new TypeError("fetch failed");
  };
  const states = [];
  const client = createClient({ fetchImpl, onStatus: (state) => states.push(state.connected) });
  let caught = null;
  try {
    await client.call("hello", {});
  } catch (err) {
    caught = err;
  }
  assert.ok(caught instanceof RpcError);
  assert.equal(caught.symbol, "TRANSPORT");
  assert.ok(caught.message.includes("network error"), caught.message);
  client.connect();
  await tick();
  assert.equal(client.connected, false);
  assert.ok(states.includes(false));
});

await testAsync("rpc: a non-JSON body is a BAD_REPLY, not a crash", async () => {
  const fetchImpl = async () => ({ ok: true, status: 200, text: async () => "<html>nope" });
  const client = createClient({ fetchImpl });
  let caught = null;
  try {
    await client.call("hello", {});
  } catch (err) {
    caught = err;
  }
  assert.equal(caught.symbol, "BAD_REPLY");
});

await testAsync("rpc: a reply carrying a different id is a BAD_REPLY, not an answer", async () => {
  // The host echoes the id; that echo is the only thing tying a reply to the
  // request it answers, so a reply for some other id must never resolve a call.
  const fetchImpl = async (url, init) => {
    const sent = JSON.parse(init.body);
    return {
      ok: true,
      status: 200,
      text: async () => JSON.stringify({
        jsonrpc: "2.0",
        id: sent.id + 1,
        result: { an_answer: "for somebody else" },
      }),
    };
  };
  const client = createClient({ fetchImpl });
  let caught = null;
  try {
    await client.call("hello", {});
  } catch (err) {
    caught = err;
  }
  assert.ok(caught instanceof RpcError, "a mismatched id must not resolve the call");
  assert.equal(caught.symbol, "BAD_REPLY");
  assert.match(caught.message, /hello: the host answered a different request \(id 2, expected 1\)/);
  assert.equal(client.state.pending, 0, "the rejected call leaves nothing pending");
});

await testAsync("rpc: with two calls in flight a swapped reply rejects instead of misdelivering", async () => {
  // Answer each request with the *other* request's id and hold the replies back
  // until both are in flight. Before the id check this resolved both calls with
  // the wrong result, which is the bug: one caller got another's answer.
  const sent = [];
  const fetchImpl = (url, init) => {
    const body = JSON.parse(init.body);
    sent.push(body);
    return new Promise((resolve) => {
      const answer = () => {
        if (sent.length < 2) {
          setTimeout(answer, 0);
          return;
        }
        const other = sent.find((entry) => entry.id !== body.id);
        resolve({
          ok: true,
          status: 200,
          text: async () => JSON.stringify({
            jsonrpc: "2.0",
            id: other.id,
            result: { answered: other.method },
          }),
        });
      };
      answer();
    });
  };
  const client = createClient({ fetchImpl });
  const settled = await Promise.allSettled([client.call("first", {}), client.call("second", {})]);
  assert.equal(settled[0].status, "rejected");
  assert.equal(settled[1].status, "rejected");
  assert.equal(settled[0].reason.symbol, "BAD_REPLY", "the first call takes no answer but its own");
  assert.equal(settled[1].reason.symbol, "BAD_REPLY", "the second call takes no answer but its own");
  assert.equal(client.state.pending, 0, "both rejected calls are cleaned up");
});

await testAsync("rpc: a handler that throws does not stop the other handlers", async () => {
  const fetchImpl = fakeFetch({
    chunks: ["data: {\"event\":\"log\",\"message\":\"one\"}\n\n"],
  });
  const client = createClient({ fetchImpl });
  const seen = [];
  client.on("log", () => {
    throw new Error("boom");
  });
  client.on("log", (event) => seen.push(event.message));
  // The client is supposed to report the bad handler on the console; that is the
  // behaviour under test, so silence it rather than let it look like a failure.
  const realError = console.error;
  console.error = () => {};
  try {
    client.connect();
    await client.ready();
    await tick();
  } finally {
    console.error = realError;
  }
  assert.deepEqual(seen, ["one"]);
});

/* ------------------------------------------------------------------ */
/* board.mjs                                                           */
/* ------------------------------------------------------------------ */

test("board: addCard/moveCard/linkCards/serialize round-trips", () => {
  let next = 1;
  const board = createBoard(undefined, { idFactory: () => `c${next++}` });
  const a = board.addCard("editor", 40, 60, { file: "examples/hello.yarn" });
  const b = board.addCard("runner", 720, 300, { cmd: "python tools/e2e.py examples/hello.yarn", cwd: "." });
  const link = board.linkCards(a.id, b.id, "runs");

  assert.equal(a.id, "c1");
  assert.equal(b.id, "c2");
  assert.equal(link.id, "l1");
  assert.equal(a.z < b.z, true, "a later card is raised above an earlier one");

  board.moveCard(a.id, 100, 120);
  assert.equal(a.x, 100);
  assert.equal(a.y, 120);

  const doc = board.serialize();
  assert.equal(doc.version, 1);
  assert.deepEqual(doc.viewport, { x: 0, y: 0, zoom: 1 });
  assert.equal(doc.cards.length, 2);
  assert.deepEqual(doc.links, [{ id: "l1", from: "c1", to: "c2", label: "runs" }]);
  assert.deepEqual(doc.cards[0], {
    id: "c1", kind: "editor", x: 100, y: 120, w: 640, h: 420, z: 1, file: "examples/hello.yarn",
  });
  // A second card re-loads from exactly what serialize() produced.
  const again = createBoard(doc);
  assert.deepEqual(again.serialize(), doc);
  assert.equal(CARD_KINDS.includes("files"), true);
});

test("board: serialize returns a copy, so mutating it cannot corrupt the model", () => {
  const board = createBoard(undefined, { idFactory: () => "c9" });
  board.addCard("note", 0, 0, { text: "scratch" });
  const doc = board.serialize();
  doc.cards[0].x = 9999;
  doc.cards.push({ id: "ghost", kind: "note", x: 0, y: 0, w: 1, h: 1 });
  doc.viewport.zoom = 99;
  assert.equal(board.cards.length, 1);
  assert.equal(board.cards[0].x, 0);
  assert.equal(board.viewport.zoom, 1);
});

test("board: removeCard drops the links that pointed at it", () => {
  const ids = ["c1", "c2", "c3"];
  const board = createBoard(undefined, { idFactory: () => ids.shift() });
  const a = board.addCard("editor", 0, 0);
  const b = board.addCard("note", 10, 10);
  const c = board.addCard("runner", 20, 20);
  board.linkCards(a.id, b.id);
  board.linkCards(b.id, c.id);
  assert.equal(board.links.length, 2);
  assert.equal(board.removeCard(b.id), true);
  assert.equal(board.links.length, 0, "a link to a dead card is not a document this format can write");
  assert.equal(board.removeCard("nope"), false);
});

test("board: an unreadable document is repaired on load", () => {
  const result = normaliseDocument({
    version: 1,
    viewport: { x: "nope", y: 5, zoom: 900 },
    cards: [
      { id: "c1", kind: "note", x: 0, y: 0, w: 0, h: -20 },
      { id: "c1", kind: "note", x: 1, y: 1, w: 10, h: 10 },
      { id: "", kind: "note", x: 1, y: 1, w: 10, h: 10 },
      "not a card",
      { id: "c2", kind: "runner", x: 2, y: 2, w: 10, h: 10 },
    ],
    links: [
      { id: "l1", from: "c1", to: "c2" },
      { id: "l2", from: "c1", to: "ghost" },
      { id: "l3", from: "ghost", to: "c2" },
    ],
  });
  assert.equal(result.document.cards.length, 2, "the duplicate and the malformed card are dropped");
  assert.equal(result.droppedCards.length, 3);
  assert.equal(result.droppedLinks, 2);
  assert.equal(result.document.cards[0].w, MIN_SIZE.w, "a zero width is repaired, not fatal");
  assert.equal(result.document.cards[0].h, MIN_SIZE.h);
  assert.equal(result.document.cards[0].z, 0, "a missing z defaults to 0, as normaliseCard does");
  assert.equal(result.document.viewport.x, 0);
  assert.equal(result.document.viewport.y, 5);
  assert.equal(result.document.viewport.zoom, ZOOM_MAX);
});

test("board: viewport zoom is clamped and non-finite input falls back", () => {
  assert.deepEqual(clampViewport({ zoom: 100 }), { x: 0, y: 0, zoom: ZOOM_MAX });
  assert.deepEqual(clampViewport({ zoom: 0 }), { x: 0, y: 0, zoom: ZOOM_MIN });
  assert.deepEqual(clampViewport({ zoom: NaN, x: Infinity }), { x: 0, y: 0, zoom: 1 });
  assert.deepEqual(clampViewport(undefined), { x: 0, y: 0, zoom: 1 });
  assert.deepEqual(clampViewport({ x: 99, y: -99, zoom: 2.5 }), { x: 99, y: -99, zoom: 2.5 });

  const board = createBoard();
  assert.equal(board.setViewport({ zoom: 500 }).zoom, ZOOM_MAX);
  assert.equal(board.setViewport({ zoom: 0.001 }).zoom, ZOOM_MIN);
  assert.equal(board.setViewport({ x: 10 }).zoom, ZOOM_MIN, "an omitted zoom keeps its value");
});

test("board: resize clamps to the minimum, raise puts a card on top", () => {
  const ids = ["c1", "c2"];
  const board = createBoard(undefined, { idFactory: () => ids.shift() });
  const a = board.addCard("note", 0, 0);
  const b = board.addCard("note", 0, 0);
  board.resizeCard(a.id, 1, 1);
  assert.equal(a.w, MIN_SIZE.w);
  assert.equal(a.h, MIN_SIZE.h);
  board.raiseCard(a.id);
  assert.ok(a.z > b.z);
});

test("board: unknown card kinds and extra fields survive a round trip", () => {
  const board = createBoard({
    version: 1,
    cards: [{ id: "c1", kind: "timeline", x: 1, y: 2, w: 3, h: 4, marks: [1, 2, 3] }],
    links: [],
  });
  const doc = board.serialize();
  assert.equal(doc.cards[0].kind, "timeline");
  assert.deepEqual(doc.cards[0].marks, [1, 2, 3]);
});

test("board: adding a card with an id that is already in use throws", () => {
  const board = createBoard(undefined, { idFactory: () => "c1" });
  board.addCard("note", 0, 0);
  assert.throws(() => board.addCard("note", 0, 0), /already used/);
});

test("board: link ids are unique board-wide, and unlink removes exactly one", () => {
  const board = createBoard();
  const a = board.addCard("editor", 0, 0);
  const b = board.addCard("runner", 400, 0);

  const first = board.addLink(a.id, b.id, "runs", "L1");
  assert.equal(first.id, "L1");
  // Accepting the collision would let the UI build a document its own writer
  // refuses, so it is an error, not a second link.
  assert.throws(() => board.addLink(a.id, b.id, "second", "L1"), /already used/,
    "an id that is already in use must be refused");
  assert.throws(() => board.addLink(a.id, b.id, "empty", ""), /must not be empty/);
  assert.equal(board.links.length, 1, "a refused link is not in the document");
  assert.deepEqual(board.links.map((link) => link.id), ["L1"]);

  /*
   * A file can still carry the collision even though the API now refuses it.
   * The loader keeps both edges and renames the second: losing a connection the
   * user can see is the worse repair, and a document with two links named `L1`
   * is one this format cannot write back.
   */
  const doc = board.serialize();
  doc.links = [{ ...doc.links[0] }, { ...doc.links[0] }];
  const repaired = normaliseDocument(doc);
  assert.deepEqual(repaired.repairedLinkIds, ["L1"], "the renamed id is reported, not just counted");
  assert.equal(repaired.document.links.length, 2, "the duplicate edge is kept, not dropped");
  assert.equal(new Set(repaired.document.links.map((link) => link.id)).size, 2);
  board.load(repaired.document);
  assert.doesNotThrow(() => board.serialize(), "the repaired board is a document this format accepts");

  /*
   * The API cannot build a collision any more, so make one behind its back.
   * `unlink <id>` has to remove one edge: `findIndex`/`splice` where a `filter`
   * used to remove every link that shared the id.
   */
  board.document.links.push({ id: "L1", from: a.id, to: b.id });
  assert.equal(board.links.length, 3);
  assert.throws(() => board.serialize(), /repeats link id "L1"/,
    "serialize refuses a document it cannot write");
  assert.equal(board.unlink("L1"), true);
  assert.equal(board.links.length, 2, "exactly one link was removed");
  assert.equal(board.links.filter((link) => link.id === "L1").length, 1, "the other link keeps its id");
  assert.equal(board.unlink("L1"), true, "the second link with that id is still there to remove");
  assert.equal(board.unlink("L1"), false, "removing a missing link reports false");
});

test("board: serialize refuses an invalid card instead of dropping it quietly", () => {
  const board = createBoard();
  board.addCard("note", 0, 0, { text: "keep me" });
  assert.equal(board.serialize().cards.length, 1);

  /*
   * A save that trims the card out reports success while the card is missing
   * from disk -- the one outcome a board-first editor must never produce. The
   * bad entry is kept in the model and named in the error instead.
   */
  board.document.cards.push({ id: "", kind: "note", x: 0, y: 0, w: 10, h: 10, z: 1 });
  assert.throws(() => board.serialize(), /cards\[1\] is not a valid card/);
  assert.equal(board.document.cards.length, 2, "the invalid card is kept, not silently dropped");

  // A repeated card id is refused for the same reason.
  board.document.cards.pop();
  board.document.cards.push({ ...board.document.cards[0] });
  assert.throws(() => board.serialize(), /repeats card id "c1"/);
  assert.equal(board.document.cards.length, 2);
});

/* ------------------------------------------------------------------ */
/* cards.mjs -- token spans and the pure helpers                        */
/* ------------------------------------------------------------------ */

test("tokens: spans are applied in order, with the gap rendered as plain", () => {
  const text = "++ hello world";
  const tokens = [[0, 2, "command"], [10, 14, "keyword"]];
  const segments = applyTokenSpans(text, tokens);
  assert.deepEqual(segments, [
    { start: 0, end: 2, kind: "command" },
    { start: 2, end: 10, kind: "plain" },
    { start: 10, end: 14, kind: "keyword" },
  ]);
  assert.equal(segmentsText(text, tokens), text, "segments must reconstruct the text exactly");
});

test("tokens: a tiling tokenizer produces no plain filler", () => {
  const text = "++ [>+<]\n";
  const tokens = [[0, 2, "command"], [2, 3, "ws"], [3, 8, "command"], [8, 9, "ws"]];
  const segments = applyTokenSpans(text, tokens);
  assert.deepEqual(segments.map((seg) => seg.kind), ["command", "plain", "command", "plain"]);
  assert.equal(segmentsText(text, tokens), text);
});

test("tokens: ws/ident become plain, unknown kinds do not vanish", () => {
  assert.equal(normaliseTokenKind("ws"), "plain");
  assert.equal(normaliseTokenKind("ident"), "plain");
  assert.equal(normaliseTokenKind("keyword"), "keyword");
  assert.equal(normaliseTokenKind("wat"), "plain");
  assert.equal(normaliseTokenKind(undefined), "plain");
  const segments = applyTokenSpans("abcdef", [[0, 3, "keyword"], [3, 6, "wat"]]);
  assert.deepEqual(segments, [{ start: 0, end: 3, kind: "keyword" }, { start: 3, end: 6, kind: "plain" }]);
});

test("tokens: non-ASCII offsets are string indices, so colours do not drift", () => {
  // `langs/tokenize.mjs` scans a JavaScript string, so its offsets count UTF-16
  // code units -- the unit `.length` and `.slice` use. Byte offsets would put
  // every colour after a CJK character one glyph too early, which is what the
  // docs used to warn about; the implementation was measured and it does not.
  // `langs/selftest.mjs` measures the same thing one layer down, at the
  // tokeniser; this is the shell's segment layer, which must not re-derive.
  const text = "+++ \u4E2D\u6587 \u{1F600}";
  assert.equal(text.length, 9, "the fixture's unit length must differ from its byte length");
  assert.equal(Buffer.byteLength(text, "utf8"), 15);
  // Exactly what the tokenizer emits for this text: a command run, whitespace,
  // then one ident run over two CJK characters and a two-code-unit astral one.
  const tokens = [[0, 3, "command"], [3, 4, "ws"], [4, 9, "ident"]];
  assert.equal(segmentsText(text, tokens), text, "the offsets must reconstruct the text exactly");
  assert.deepEqual(
    applyTokenSpans(text, tokens).map((seg) => seg.kind),
    ["command", "plain", "plain"],
  );
  assert.deepEqual(applyTokenSpans(text, tokens).slice(-1)[0], { start: 4, end: 9, kind: "plain" });
});

test("indent: a bare caret gets one step, not a whole line", () => {
  const out = indentSelection("abc\n", 1, 1);
  assert.equal(out.text, `a${INDENT_UNIT}bc\n`);
  assert.deepEqual(
    [out.selectionStart, out.selectionEnd],
    [1 + INDENT_UNIT.length, 1 + INDENT_UNIT.length],
  );
});

test("indent: a selection indents every line it touches, not the rest", () => {
  const out = indentSelection("one\ntwo\nthree\n", 1, 5);
  assert.equal(out.text, `${INDENT_UNIT}one\n${INDENT_UNIT}two\nthree\n`);
  assert.equal(
    out.text.slice(out.selectionStart, out.selectionEnd),
    `${INDENT_UNIT}one\n${INDENT_UNIT}two`,
  );
});

test("indent: a selection ending on a newline does not drag the next line in", () => {
  const out = indentSelection("one\ntwo\n", 0, 4);
  assert.equal(out.text, `${INDENT_UNIT}one\ntwo\n`);
  assert.equal(out.selectionEnd, INDENT_UNIT.length + 3);
});

test("indent: shift+tab takes one step back and never eats real text", () => {
  const text = "\tone\n  two\nthree\n";
  const out = indentSelection(text, 0, text.length, { outdent: true });
  assert.equal(out.text, "one\ntwo\nthree\n");
  // One leading space is indentation too, and only that one character goes.
  assert.equal(indentSelection(" one\n", 0, 5, { outdent: true }).text, "one\n");
  assert.equal(indentSelection("one\n", 0, 4, { outdent: true }).text, "one\n");
});

test("indent: enter keeps the line's indentation and steps in after an opener", () => {
  assert.equal(indentAfterEnter("    foo"), "    ");
  assert.equal(indentAfterEnter("if (x) {"), INDENT_UNIT);
  assert.equal(indentAfterEnter(`    if (x) {`), INDENT_UNIT + INDENT_UNIT);
  assert.equal(indentAfterEnter(""), "");
  assert.equal(indentAfterEnter("    "), "    ");
});

test("find: matches are literal, left to right, and do not overlap", () => {
  assert.deepEqual(findMatches("aAaA", "aa"), [{ start: 0, end: 2 }, { start: 2, end: 4 }]);
  assert.deepEqual(findMatches("aaa", "aa"), [{ start: 0, end: 2 }]);
  assert.deepEqual(findMatches("HeLLo", "hello"), [{ start: 0, end: 5 }]);
  assert.deepEqual(findMatches("abc", ""), []);
  assert.deepEqual(findMatches("abc", "zz"), []);
});

test("find: a query whose case fold changes length stays case-sensitive", () => {
  // 'İ'.toLowerCase() is two code units, so a folded search could not report
  // offsets into the original text; that search falls back to exact matching.
  assert.equal("\u0130".toLowerCase().length, 2);
  assert.deepEqual(findMatches("\u0130x", "i\u0307"), []);
  assert.deepEqual(findMatches("\u0130x", "\u0130"), [{ start: 0, end: 1 }]);
});

test("replace: one match, or every match, and the rest of the text survives", () => {
  const text = "aa bb aa";
  const hits = findMatches(text, "aa");
  assert.equal(replaceMatchAt(text, hits[1], "Z"), "aa bb Z");
  assert.deepEqual(replaceAllMatches(text, "AA", "zZ"), { text: "zZ bb zZ", count: 2 });
  assert.deepEqual(replaceAllMatches(text, "nope", "zZ"), { text, count: 0 });
});

test("find: hits split coloured segments without moving a single character", () => {
  const text = "if (x) x";
  const segments = applyTokenSpans(text, [[0, 2, "keyword"]]);
  const marked = markHits(segments, findMatches(text, "x"), 1);
  assert.equal(marked.map((seg) => text.slice(seg.start, seg.end)).join(""), text);
  assert.deepEqual(marked.filter((seg) => seg.hit).map((seg) => seg.start), [4, 7]);
  assert.deepEqual(marked.filter((seg) => seg.current).map((seg) => seg.start), [7]);
  // A hit inside a coloured run keeps the run's kind on both sides of it.
  const split = markHits(applyTokenSpans("abc", [[0, 3, "keyword"]]), findMatches("abc", "b"));
  assert.deepEqual(
    split.map((seg) => [seg.start, seg.end, seg.kind, seg.hit]),
    [[0, 1, "keyword", false], [1, 2, "keyword", true], [2, 3, "keyword", false]],
  );
});

test("tokens: bad spans are dropped and overlaps are clipped", () => {
  const text = "0123456789";
  const tokens = [
    [100, 200, "keyword"],   // past the end
    [5, 5, "keyword"],       // empty
    [8, 3, "keyword"],       // inverted
    [0, 6, "comment"],
    [2, 9, "string"],        // overlaps the comment
    "nonsense",
    { start: 9, end: 10, kind: "number" },
  ];
  const segments = applyTokenSpans(text, tokens);
  assert.deepEqual(segments, [
    { start: 0, end: 6, kind: "comment" },
    { start: 6, end: 9, kind: "string" },
    { start: 9, end: 10, kind: "number" },
  ]);
  assert.equal(segmentsText(text, tokens), text);
  assert.deepEqual([...applyTokenSpans("", [])], []);
  assert.deepEqual([...applyTokenSpans("abc", null)], [{ start: 0, end: 3, kind: "plain" }]);
});

test("tokens: line/column readout matches the caret", () => {
  assert.deepEqual(lineColumn("ab\ncd", 0), { line: 1, column: 1 });
  assert.deepEqual(lineColumn("ab\ncd", 2), { line: 1, column: 3 });
  assert.deepEqual(lineColumn("ab\ncd", 3), { line: 2, column: 1 });
  assert.deepEqual(lineColumn("ab\ncd", 99), { line: 2, column: 3 });
});

test("files: formatListing sorts directories first and formats sizes", () => {
  const now = 1_000_000;
  const listing = {
    files: [
      { path: "tools/e2e.py", size: 2048, mtime: now - 3600, dir: false },
      { path: "examples", size: 0, mtime: now - 10, dir: true },
      { path: "core/src/app.c", size: 500, mtime: now - 90, dir: false },
      { path: "README.md", size: 5 * 1024 * 1024, mtime: now - 86400 * 3, dir: false },
      { path: "", size: 1, mtime: 0, dir: false },
      null,
    ],
    count: 5,
    truncated: true,
  };
  const { rows, count, truncated } = formatListing(listing, { now });
  assert.equal(count, 5);
  assert.equal(truncated, true);
  assert.deepEqual(rows.map((row) => row.path), [
    "examples", "README.md", "core/src/app.c", "tools/e2e.py",
  ]);
  assert.equal(rows[0].dir, true);
  assert.equal(rows[0].name, "examples");
  assert.equal(rows[1].sizeText, "5.0M");
  assert.equal(rows[1].ageText, "3d");
  assert.equal(rows[2].sizeText, "500B");
  assert.equal(rows[3].ageText, "1h");
  assert.deepEqual(formatListing({}).rows, []);
});

test("files: size and age formatting stay readable", () => {
  assert.equal(formatSize(0), "0B");
  assert.equal(formatSize(1023), "1023B");
  assert.equal(formatSize(1024), "1.0K");
  assert.equal(formatSize(1536), "1.5K");
  assert.equal(formatSize(10 * 1024), "10K");
  assert.equal(formatSize(-1), "");
  assert.equal(formatSize(NaN), "");
  assert.equal(formatAge(1000, 1000), "0s");
  assert.equal(formatAge(1000, 1060), "1m");
  assert.equal(formatAge(1000, 1000 + 7200), "2h");
  assert.equal(formatAge(NaN, 0), "");
});

test("files: the filter box understands globs and substrings", () => {
  assert.equal(matchesFilter("examples/hello.yarn", "**/*"), true);
  assert.equal(matchesFilter("examples/hello.yarn", "**/*.yarn"), true);
  assert.equal(matchesFilter("examples/sub/a.yarn", "**/*.yarn"), true);
  assert.equal(matchesFilter("core/src/app.c", "**/*.yarn"), false);
  assert.equal(matchesFilter("core/src/app.c", "app"), true);
  assert.equal(matchesFilter("core/src/app.c", "src/*.c"), false);
  assert.equal(matchesFilter("core/src/app.c", "core/src/*.c"), true);
  assert.equal(matchesFilter("anything", ""), true);
});

/* ------------------------------------------------------------------ */
/* the project view                                                    */
/* ------------------------------------------------------------------ */

/*
 * The project panel is the one surface that has to know the whole workspace at
 * once, so the interesting cases are the ones the `files` card cannot see: what
 * the board has open but the disk does not have any more, and what the kernel
 * never handed over at all.
 *
 * The fixture is what `workspace.list` really returns: the kernel skips
 * `.git`, `.infantgod`, `build`, `node_modules` and friends *while walking*
 * (`IGNORED_DIRS` in `core/src/wksp.c`), so no listing carries them and the
 * panel has nothing to filter. `workspace.info.ignored` names them instead.
 */
const PROJECT_LISTING = {
  files: [
    { path: "core/src/view.c", size: 500, mtime: 900_000, dir: false },
    { path: "core/src/rpc.c", size: 400, mtime: 900_000, dir: false },
    { path: "README.md", size: 100, mtime: 900_000, dir: false },
    { path: "examples/hello.yarn", size: 807, mtime: 900_000, dir: false },
    { path: "core", size: 0, mtime: 900_000, dir: true },
  ],
  count: 5,
  truncated: false,
};

test("project: the project is the files of the workspace, grouped", () => {
  const view = projectRows(PROJECT_LISTING);
  // Root first, then folders alphabetically; folders are the grouping, so a
  // directory entry in the listing is counted but never becomes a row.
  assert.deepEqual(view.groups.map((group) => group.label), ["(root)", "core/src/", "examples/"]);
  assert.deepEqual(view.groups[0].rows.map((row) => row.name), ["README.md"]);
  assert.deepEqual(view.groups[1].rows.map((row) => row.name), ["rpc.c", "view.c"]);
  assert.deepEqual(view.groups[2].rows.map((row) => row.name), ["hello.yarn"]);
  assert.equal(view.groups[1].rows[0].folder, "core/src");
  assert.equal(view.groups[1].rows[0].sizeText, "400B");

  assert.equal(view.counts.files, 4);
  assert.equal(view.counts.dirs, 1);
  assert.equal(view.counts.shown, 4, "every file the kernel returned is shown");
  assert.equal(view.counts.open, 0);
  assert.equal(view.counts.complete, true);
});

test("project: the panel shows what it is given, it does not re-filter it", () => {
  // The kernel decides what a workspace listing contains. If a fork's kernel
  // hands back `build/` after all, the row belongs on screen -- a second,
  // client-side ignore list could only ever disagree with the one in C, and
  // would silently drop rows the user asked to see. `workspace.info.ignored`
  // is how the panel explains an absence; it never invents one.
  const withGenerated = {
    files: [
      { path: "core/src/rpc.c", size: 400, mtime: 900_000, dir: false },
      { path: "build/infantgod.exe", size: 999, mtime: 900_000, dir: false },
      { path: "node_modules/dep/index.js", size: 1, mtime: 900_000, dir: false },
    ],
    truncated: false,
  };
  const view = projectRows(withGenerated);
  assert.equal(view.counts.files, 3);
  assert.deepEqual(view.groups.map((group) => group.label), [
    "build/", "core/src/", "node_modules/dep/",
  ]);
  // The folder the file sits in is never part of the name.
  const rows = view.groups.flatMap((group) => group.rows);
  assert.equal(rows.find((row) => row.path === "node_modules/dep/index.js").name, "index.js");
});

test("project: an open editor is marked, and a file that left the disk is named", () => {
  const view = projectRows(PROJECT_LISTING, {
    open: [
      { id: "c2", path: "core/src/rpc.c", dirty: true },
      { id: "c5", path: "gone/away.c", dirty: false },
      { id: "c1", path: "examples/hello.yarn", dirty: false },
    ],
  });
  const byPath = new Map(view.groups.flatMap((group) => group.rows).map((row) => [row.path, row]));
  assert.equal(byPath.get("core/src/rpc.c").open, true);
  assert.equal(byPath.get("core/src/rpc.c").dirty, true);
  assert.equal(byPath.get("core/src/rpc.c").cardId, "c2");
  assert.equal(byPath.get("core/src/view.c").open, false);

  // The open list is the board's answer to "what am I editing", file order.
  assert.deepEqual(view.openRows.map((row) => row.path), [
    "core/src/rpc.c", "examples/hello.yarn", "gone/away.c",
  ]);
  assert.deepEqual(view.openRows.map((row) => row.present), [true, true, false]);
  assert.deepEqual(view.missingRows.map((row) => row.path), ["gone/away.c"]);
  assert.equal(view.counts.open, 3);
  assert.equal(view.counts.dirty, 1);
  assert.equal(view.counts.missing, 1);

  // Two cards on one file: both are open (the board may carry it), but a row
  // can only point at one of them, and it says so by naming the first.
  const twice = projectRows(PROJECT_LISTING, {
    open: [{ id: "c2", path: "core/src/rpc.c" }, { id: "c9", path: "core/src/rpc.c" }],
  });
  assert.equal(twice.counts.open, 2);
  assert.equal(twice.groups.flatMap((g) => g.rows).find((r) => r.path === "core/src/rpc.c").cardId, "c2");
});

test("project: a missing file is only a fact when the listing is complete", () => {
  const truncated = { ...PROJECT_LISTING, truncated: true };
  const view = projectRows(truncated, { open: [{ id: "c5", path: "gone/away.c" }] });
  assert.equal(view.counts.truncated, true);
  assert.equal(view.counts.complete, false);
  assert.equal(view.missingRows.length, 1, "the row is still reported");
  assert.match(projectSummary(view.counts), /listing truncated/, "...but the summary says why");
});

test("project: the filter narrows the tree and never the open list", () => {
  const view = projectRows(PROJECT_LISTING, {
    filter: "**/*.c",
    open: [{ id: "c1", path: "examples/hello.yarn" }],
  });
  assert.deepEqual(view.groups.map((group) => group.label), ["core/src/"]);
  assert.equal(view.counts.files, 4, "the whole project is still counted");
  assert.equal(view.counts.shown, 2);
  assert.equal(view.counts.open, 1, "an open file stays visible however the tree is filtered");

  const word = projectRows(PROJECT_LISTING, { filter: "view" });
  assert.deepEqual(word.groups.flatMap((group) => group.rows).map((row) => row.path), [
    "core/src/view.c",
  ], "a substring hits the path");
  assert.deepEqual(projectRows(PROJECT_LISTING, { filter: "nothing-matches" }).groups, []);
  assert.deepEqual(projectRows(PROJECT_LISTING, { filter: "build/**" }).groups, [],
    "a filter aimed at a directory the kernel skips matches nothing, which is why the "
    + "empty state names the skipped directories instead of pretending they are empty");
});

test("project: paths are the kernel's, whatever the host put in them", () => {
  assert.equal(dirNameOf("a/b/c.txt"), "a/b");
  assert.equal(dirNameOf("a.txt"), "", "a file at the root has no folder");
  assert.equal(dirNameOf("a/"), "a");
  assert.equal(dirNameOf(""), "");
  assert.equal(dirNameOf("a\\b\\c.txt"), "a/b", "one separator, like the kernel's paths");
});

test("project: the one-line summary counts the workspace and the board", () => {
  assert.equal(projectSummary(projectRows(PROJECT_LISTING).counts),
    "4 files · 1 folders · 0 open");
  assert.equal(projectSummary({
    files: 128, dirs: 6, open: 2, dirty: 1, missing: 1, truncated: true,
  }), "128 files · 6 folders · 2 open · 1 unsaved · 1 missing · listing truncated");
  assert.equal(projectSummary(null), "0 files · 0 open");
  assert.equal(projectSummary({}), "0 files · 0 open");
});

test("runner: the output buffer drops the head rather than growing forever", () => {
  const buffer = new OutputBuffer({ maxChars: 100, maxLines: 5 });
  buffer.append("a".repeat(80));
  assert.equal(buffer.length, 80);
  buffer.append("b".repeat(80));
  assert.equal(buffer.length, 100, "the buffer is capped");
  assert.equal(buffer.dropped, 60);
  const lines = buffer.lines();
  assert.match(lines[0], /earlier characters/);
  assert.equal(lines.length, 2, "one marker line, then the surviving text");

  const many = new OutputBuffer({ maxChars: 100000, maxLines: 3 });
  many.append("1\n2\n3\n4\n5\n");
  assert.deepEqual(many.lines(), [
    "[... 0 earlier characters, 3 earlier lines dropped ...]",
    "4",
    "5",
    "",
  ]);
  many.clear();
  assert.deepEqual(many.lines(), [""]);
});

test("runner: exit codes read as words, not numbers", () => {
  assert.equal(formatExit(0), "exit 0");
  assert.equal(formatExit(2), "exit 2");
  assert.equal(formatExit(-1), "killed (-1)");
  assert.equal(formatExit(null), "running");
  assert.equal(formatExit(undefined), "running");
});

test("command line: quoting, zoom words and card descriptions", () => {
  assert.deepEqual(parseCommandLine("open examples/hello.yarn"), ["open", "examples/hello.yarn"]);
  assert.deepEqual(parseCommandLine('  run  "python tools/e2e.py" "a b.yarn" '), ["run", "python tools/e2e.py", "a b.yarn"]);
  assert.deepEqual(parseCommandLine('link c1 c2 "runs the file"'), ["link", "c1", "c2", "runs the file"]);
  assert.deepEqual(parseCommandLine("note hello world"), ["note", "hello", "world"]);
  assert.deepEqual(parseCommandLine("   "), []);
  assert.deepEqual(parseCommandLine(""), []);

  assert.equal(parseZoomArgument("in", 1), 1.25);
  assert.equal(parseZoomArgument("out", 1), 0.8);
  assert.equal(parseZoomArgument("reset", 3), 1);
  assert.equal(parseZoomArgument("2"), 2);
  assert.equal(parseZoomArgument("50%"), 0.5);
  assert.equal(parseZoomArgument("banana"), null);
  assert.equal(parseZoomArgument(""), null);

  assert.equal(describeCard({ kind: "editor", file: "a.yarn" }), "editor a.yarn");
  assert.equal(describeCard({ kind: "runner", cmd: "ls" }), "runner ls");
  assert.equal(describeCard({ kind: "files" }), "files **/*");
  assert.equal(describeCard(null), "no card selected");
});

/* ------------------------------------------------------------------ */
/* end to end: a real HTTP server speaking the frozen contract          */
/* ------------------------------------------------------------------ */

/**
 * The whole point of this section: the fake-fetch tests above prove the logic,
 * this one proves the *wire*.  A real `node:http` server answers `/rpc` exactly
 * as `node shell/main.mjs serve` promises to and streams `/events` as chunked
 * `text/event-stream`, and the client is left to use real fetch, real sockets
 * and real chunk boundaries.
 */
await testAsync("e2e: a real HTTP host, real SSE and real chunk boundaries", async () => {
  const board = { version: 1, viewport: { x: 0, y: 0, zoom: 1 }, cards: [], links: [] };
  let boardRevision = 3;
  let fileRevision = 11;
  const seenMethods = [];
  const sockets = new Set();

  const server = createServer((req, res) => {
    if (req.url === "/events") {
      res.writeHead(200, { "Content-Type": "text/event-stream", "Cache-Control": "no-cache" });
      const send = (object) => res.write(`data: ${JSON.stringify(object)}\n\n`);
      send({ event: "log", level: "info", message: "hello from the host" });
      // Two events written into a single TCP segment, so the reader has to split
      // a chunk that contains more than one frame.
      res.write(`data: ${JSON.stringify({ event: "log", level: "warn", message: "one" })}\n\n`
        + `data: ${JSON.stringify({ event: "log", level: "info", message: "two" })}\n\n`);
      setTimeout(() => {
        send({ event: "exec.output", run_id: 1, stream: "stdout", data: "out\n" });
        send({ event: "exec.exit", run_id: 1, code: 0 });
        res.end();
      }, 20);
      return;
    }

    let body = "";
    req.on("data", (chunk) => {
      body += chunk;
    });
    req.on("end", () => {
      let parsed = { method: "", params: {} };
      try {
        parsed = JSON.parse(body);
      } catch {
        parsed = { method: "", params: {} };
      }
      seenMethods.push(parsed.method);
      const reply = (value) => {
        // The real host speaks JSON-RPC, so the mock does too: the same id
        // comes back with either a result or an error.  Replying in any other
        // shape would be testing a host that does not exist.
        const body = value.ok === true
          ? { jsonrpc: "2.0", id: parsed.id, result: value.result }
          : { jsonrpc: "2.0", id: parsed.id, error: value.error };
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify(body));
      };
      switch (parsed.method) {
        case "hello":
          reply({ ok: true, result: { protocol: "infantgod/2", kernel_version: "0.1.0", root: "C:/codes/InfantGod Studio", pid: 4242 } });
          return;
        case "view.load":
          // The client names the document it wants; the host answers with that
          // path, exactly as the kernel does.
          reply({ ok: true, result: { path: parsed.params.path, revision: boardRevision, document: board } });
          return;
        case "view.save":
          if (parsed.params.base_revision !== boardRevision) {
            reply({
              ok: false,
              error: {
                code: 409, name: "STALE_REVISION", message: "the view document moved on",
                data: { current_revision: boardRevision },
              },
            });
            return;
          }
          boardRevision += 1;
          reply({ ok: true, result: { path: parsed.params.path, revision: boardRevision, saved: true } });
          return;
        case "file.read":
          // The real first line of `examples/hello.yarn` -- the text the token
          // spans below are the shipped descriptor's answer for.
          reply({ ok: true, result: { path: parsed.params.path, text: "title: Live_Node\n", revision: fileRevision, size: 17, eol: "lf" } });
          return;
        case "file.write":
          if (parsed.params.base_revision !== fileRevision) {
            reply({
              ok: false,
              error: {
                code: 409, name: "STALE_REVISION", message: "file moved on",
                data: { current_revision: fileRevision },
              },
            });
            return;
          }
          fileRevision += 1;
          reply({ ok: true, result: { path: parsed.params.path, revision: fileRevision, size: parsed.params.text.length, eol: "lf" } });
          return;
        case "lang.tokenize":
          // The spans `langs/yarn.lang` really produces for `title: Live_Node\n`:
          // the keyword, the `:` command, the space, the identifier, the newline.
          reply({ ok: true, result: { lang: { id: "yarn", title: "Yarn" }, tokens: [[0, 5, "keyword"], [5, 6, "command"], [6, 7, "ws"], [7, 16, "ident"], [16, 17, "ws"]] } });
          return;
        default:
          reply({ ok: false, error: { code: 404, name: "NO_METHOD", message: `no method ${parsed.method}` } });
      }
    });
  });

  server.on("connection", (socket) => {
    sockets.add(socket);
    socket.on("close", () => sockets.delete(socket));
  });

  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const port = server.address().port;

  try {
    const client = createClient({ origin: `http://127.0.0.1:${port}` });
    const events = [];
    client.on("log", (event) => events.push(event.message));
    client.on("exec.output", (event) => events.push(event.data));
    client.on("exec.exit", (event) => events.push(`exit ${event.code}`));
    client.connect();
    await client.ready();
    assert.equal(client.connected, true);

    const hello = await client.call("hello", {});
    assert.equal(hello.protocol, "infantgod/2");
    assert.equal(hello.pid, 4242);

    const loaded = await client.call("view.load", { path: ".infantgod/board.json" });
    assert.equal(loaded.path, ".infantgod/board.json", "the host answers with the path that was asked for");
    assert.equal(loaded.revision, 3);
    assert.deepEqual(loaded.document.cards, []);

    const saved = await client.call("view.save", { path: ".infantgod/board.json", document: board, base_revision: 3 });
    assert.equal(saved.saved, true);
    assert.equal(saved.revision, 4, "the host bumps the revision");

    const stale = await client.call("view.save", { path: ".infantgod/board.json", document: board, base_revision: 3 }).then(
      () => null,
      (err) => err,
    );
    assert.ok(stale instanceof RpcError, "a stale save must reject");
    assert.equal(stale.code, 409);
    assert.equal(stale.errorName, "STALE_REVISION");
    assert.equal(stale.data.current_revision, 4);
    assert.equal(staleCurrentRevision(stale), 4);
    assert.ok(client.isStaleRevision(stale));

    const read = await client.call("file.read", { path: "examples/hello.yarn" });
    assert.equal(read.revision, 11);
    const written = await client.call("file.write", {
      path: read.path, text: read.text, base_revision: read.revision,
    });
    assert.equal(written.revision, 12);
    const staleWrite = await client.call("file.write", {
      path: read.path, text: "x", base_revision: 11,
    }).then(() => null, (err) => err);
    assert.equal(staleCurrentRevision(staleWrite), 12, "the second writer sees the live revision");

    const tokenized = await client.call("lang.tokenize", { path: read.path, text: read.text });
    assert.equal(tokenized.lang.id, "yarn");
    const segments = applyTokenSpans(read.text, tokenized.tokens);
    assert.equal(segmentsText(read.text, tokenized.tokens), read.text);
    // The whole pipeline over the wire: a Yarn header key is the first span, and
    // the `:` command and the identifier that follow are not swallowed by it.
    assert.deepEqual(segments.map((seg) => seg.kind), ["keyword", "command", "plain", "plain", "plain"]);
    assert.deepEqual(segments.map((seg) => read.text.slice(seg.start, seg.end)),
      ["title", ":", " ", "Live_Node", "\n"]);

    const unknown = await client.call("nope", {}).then(() => null, (err) => err);
    assert.equal(unknown.errorName, "NO_METHOD");
    assert.equal(unknown.code, 404);

    // The stream's frames were split by the real socket, not by the test.
    for (let i = 0; i < 40 && !events.includes("exit 0"); i += 1) {
      await tick(1);
    }
    assert.deepEqual(events, ["hello from the host", "one", "two", "out\n", "exit 0"]);
    assert.equal(client.connected, false, "the host ended the stream, so we report disconnected");

    assert.deepEqual(seenMethods, [
      "hello", "view.load", "view.save", "view.save",
      "file.read", "file.write", "file.write", "lang.tokenize", "nope",
    ]);
    client.close();
  } finally {
    for (const socket of sockets) {
      socket.destroy();
    }
    await new Promise((resolve) => server.close(resolve));
  }
});

/* ------------------------------------------------------------------ */
/* the card-kind hook                                                  */
/* ------------------------------------------------------------------ */

test("hook: the built-in kinds register in a known order", () => {
  assert.deepEqual(knownCardKinds(), [
    "editor", "runner", "note", "files", "project", "sheet", "story", "pixel",
    "mod", "problems", "docs",
  ]);
  for (const kind of knownCardKinds()) {
    const spec = cardKind(kind);
    assert.equal(spec.kind, kind);
    assert.equal(typeof spec.render, "function");
    assert.equal(typeof spec.describe, "function");
    assert.equal(typeof spec.create, "function");
    assert.equal(typeof spec.title, "string");
    assert.ok(Object.isFrozen(spec), `${kind} is frozen so a fork cannot half-edit it`);
    // Every kind must be placeable without a size from the caller.
    assert.ok(DEFAULT_SIZE[kind] && DEFAULT_SIZE[kind].w >= MIN_SIZE.w && DEFAULT_SIZE[kind].h >= MIN_SIZE.h,
      `${kind} needs a usable default size`);
  }
  assert.equal(cardKind("nosuchkind"), null);
  assert.deepEqual(CARD_KIND_CONTRACT.required, ["kind", "render"]);
});

test("hook: a bad registration is refused", () => {
  assert.throws(() => registerCardKind(null), /must be an object/);
  assert.throws(() => registerCardKind({}), /kind must be a non-empty string/);
  assert.throws(() => registerCardKind({ kind: "x" }), /render must be a function/);
  assert.throws(
    () => registerCardKind({ kind: "note", render: () => ({}) }),
    /already registered/,
    "overriding a built-in has to be explicit",
  );
  assert.equal(cardKind("x"), null, "a refused registration leaves nothing behind");
});

test("hook: registerCardKind is the whole extension mechanism", () => {
  const before = knownCardKinds().length;
  const spec = registerCardKind({
    kind: "probe",
    title: "Probe",
    create: () => ({ n: 7 }),
    describe: (card) => `probe n=${card.n}`,
    render: () => ({ el: null, handle: {}, destroy() {} }),
  });
  assert.equal(spec.title, "Probe");
  assert.equal(knownCardKinds().length, before + 1);
  assert.deepEqual(spec.create(), { n: 7 });
  assert.equal(describeCard({ id: "c9", kind: "probe", n: 3 }), "probe n=3");
  /* The board stores any kind, so a new one needs no board change. */
  const board = createBoard();
  const card = board.addCard("probe", 0, 0, spec.create());
  assert.equal(card.n, 7);
  assert.equal(board.serialize().cards[0].kind, "probe");
  /* Clean up so later checks see the shipped set. */
  registerCardKind({ kind: "probe", render: () => ({ el: null, handle: {}, destroy() {} }), replace: true });
});

test("describe: an unregistered or hostile kind cannot break the header", () => {
  assert.match(describeCard({ id: "c1", kind: "mystery" }), /^mystery c1$/);
  assert.equal(describeCard(null), "no card selected");
  assert.match(describeCard({ id: "c2" }), /^\? c2$/);
  registerCardKind({
    kind: "grumpy",
    replace: true,
    render: () => ({ el: null, handle: {}, destroy() {} }),
    describe: () => {
      throw new Error("nope");
    },
  });
  assert.match(describeCard({ id: "c3", kind: "grumpy" }), /^grumpy c3/);
});

/* ------------------------------------------------------------------ */
/* the sheet model -- structured, not textual state                    */
/* ------------------------------------------------------------------ */

test("sheet: emptySheet is a legal one-by-one grid", () => {
  const sheet = emptySheet();
  assert.equal(sheet.columns.length, 1);
  assert.equal(sheet.rows.length, 1);
  assert.equal(sheetSummary(sheet), "1 row x 1 column");
  assert.deepEqual(SHEET_TYPES, ["text", "number", "bool", "choice"]);
  assert.equal(sheetCell(sheet, "row1", "column1"), "");
});

test("sheet: normaliseSheet repairs anything into a usable grid", () => {
  const empty = normaliseSheet(undefined);
  assert.equal(empty.columns.length, 1, "a sheet always has at least one column");

  const repaired = normaliseSheet({
    columns: [
      { id: "a", title: "", type: "number" },
      { id: "a", type: "nosuchtype" },
      "not a column",
      { id: "c", type: "choice", options: ["x", 9, "y"] },
    ],
    rows: [
      { id: "r", cells: { a: "12.5", c: "x" } },
      { id: "r", cells: null },
      "not a row",
    ],
  });
  assert.equal(repaired.columns.length, 3, "the string is not a column");
  assert.equal(repaired.columns[0].title, "a", "a missing title falls back to the id");
  assert.deepEqual(repaired.columns[1].type, "text", "an unknown type becomes text");
  assert.notEqual(repaired.columns[1].id, "a", "a duplicate id is renamed");
  assert.deepEqual(repaired.columns[2].options, ["x", "y"], "non-string options are dropped");
  assert.equal(repaired.rows.length, 2, "the string is not a row");
  assert.equal(repaired.rows[0].cells.a, 12.5, "a number column coerces its cell");
  assert.deepEqual(Object.keys(repaired.rows[1].cells), ["a", repaired.columns[1].id, "c"],
    "a row with no cells still gets one slot per column");
  assert.notEqual(repaired.rows[1].id, "r", "a duplicate row id is renamed");
});

test("sheet: coercion is by column type, and never throws", () => {
  assert.equal(coerceSheetValue("number", "3.5"), 3.5);
  assert.equal(coerceSheetValue("number", "  -2 "), -2);
  assert.equal(coerceSheetValue("number", "banana"), 0);
  assert.equal(coerceSheetValue("number", NaN), 0);
  assert.equal(coerceSheetValue("bool", true), true);
  assert.equal(coerceSheetValue("bool", "true"), true);
  assert.equal(coerceSheetValue("bool", "false"), false);
  assert.equal(coerceSheetValue("bool", 0), false);
  assert.equal(coerceSheetValue("text", null), "");
  assert.equal(coerceSheetValue("text", 42), "42");
  assert.equal(coerceSheetValue("nosuchtype", 42), "42");
});

test("sheet: editing mutates the card's own object, not a copy", () => {
  const doc = emptySheet();
  const identity = doc;
  assert.equal(setSheetCell(doc, "row1", "column1", "hello"), true);
  assert.equal(doc, identity, "card.doc keeps its identity across an edit");
  assert.equal(sheetCell(doc, "row1", "column1"), "hello");
  assert.equal(setSheetCell(doc, "nosuchrow", "column1", "x"), false);
  assert.equal(sheetCell(doc, "nosuchrow", "column1"), "");
});

/* Loaded apart from the static imports above so that a build without the
   header's write path fails THIS check (and says which one) instead of failing
   the whole file at import time -- which is how it reads when the fix is
   reverted to look at the failure. */
const { updateSheetColumn } = await import("./cards.mjs");

await testAsync("sheet: a column edit lands on the live doc, never on a captured column object", async () => {
  assert.equal(typeof updateSheetColumn, "function",
    "the renderer needs a pure write path that resolves a column by id");

  const doc = emptySheet();
  const identity = doc;
  const painted = doc.columns[0];

  /* A header listener holds the column object its paint was handed.  One cell
     edit is all it takes to make that object stale: every write lands fresh
     columns and rows in `doc` through replaceSheet (which is what keeps
     card.doc's identity stable). */
  assert.equal(setSheetCell(doc, "row1", "column1", "typed"), true);
  assert.notEqual(doc.columns[0], painted, "a cell edit replaces the column objects");

  painted.title = "written through the captured object";
  assert.equal(doc.columns[0].title, "column1",
    "a write through the captured object is invisible to the document");
  assert.equal(sheetToTSV(doc).split("\n")[0], "column1",
    "... so the rename is gone at the next repaint");

  /* Resolving by id at event time is what makes the header edits stick. */
  const renamed = updateSheetColumn(doc, "column1", { title: "renamed" });
  assert.notEqual(renamed, null);
  assert.equal(doc, identity, "the write keeps card.doc's identity");
  assert.equal(doc.columns[0].title, "renamed");
  assert.equal(normaliseSheet(doc).columns[0].title, "renamed", "and it survives a re-normalise");
  assert.equal(renamed.rows[0].cells.column1, "typed", "the cell edit is still there");

  /* The same write path serves the type select, which re-normalises the column
     so every cell under it takes the new type. */
  const retyped = updateSheetColumn(doc, "column1", { type: "number" });
  assert.equal(doc.columns[0].type, "number");
  assert.equal(doc.columns[0].title, "renamed", "a type change does not drop the name");
  assert.equal(doc.rows[0].cells.column1, 0, "\"typed\" is not a number, so the cell is 0");
  assert.equal(retyped.columns[0].type, "number", "the write returns the sheet it stored");

  const chosen = updateSheetColumn(doc, "column1", { type: "choice" });
  assert.deepEqual(chosen.columns[0].options, ["one", "two", "three"],
    "a column that becomes a choice gets options to choose from");
  assert.equal(doc.rows[0].cells.column1, "0", "and its cells become option strings");

  assert.equal(updateSheetColumn(doc, "nosuchcolumn", { title: "x" }), null,
    "a column that is not there is not invented");
  assert.equal(doc.columns.length, 1, "... and nothing is added to the sheet");
});

test("sheet: sheetCell still repairs a document it was handed unnormalised", () => {
  /* The paint loop no longer calls this once per cell, but the exported lookup
     keeps its guarantee for external callers: hand it anything, and it
     normalises the document itself first. */
  const hostile = {
    columns: [{ id: "n", type: "number" }, { id: "n", type: "bool" }],
    rows: [{ id: "r", cells: { n: "  -2 " } }, { id: "r", cells: null }, "not a row"],
  };
  const repaired = normaliseSheet(hostile);
  assert.equal(sheetCell(hostile, "r", "n"), -2, "coerced by the column's type");
  assert.equal(sheetCell(hostile, "r", repaired.columns[1].id), false,
    "a row with no cells is still filled in, one slot per column");
  assert.equal(sheetCell(hostile, repaired.rows[1].id, "n"), 0,
    "and every cell in it is coerced for its column");
  assert.equal(sheetCell(hostile, "r", "nosuchcolumn"), "");
  assert.equal(sheetCell(hostile, "nosuchrow", "n"), "");
  assert.equal(sheetCell(undefined, "row1", "column1"), "");
});

test("sheet: rows and columns add and remove, with the edges guarded", () => {
  const doc = emptySheet();
  const column = addSheetColumn(doc, "number");
  assert.equal(doc.columns.length, 2);
  assert.equal(column.type, "number");

  const row = addSheetRow(doc);
  assert.equal(doc.rows.length, 2);
  assert.deepEqual(Object.keys(row.cells), doc.columns.map((c) => c.id),
    "a new row has a cell for every column, including ones added before it");
  assert.equal(row.cells[column.id], 0, "a number cell starts at 0, not at ''");

  assert.equal(removeSheetRow(doc, row.id), true);
  assert.equal(removeSheetRow(doc, row.id), false);
  assert.equal(doc.rows.length, 1);

  assert.equal(removeSheetColumn(doc, column.id), true);
  assert.equal(removeSheetColumn(doc, doc.columns[0].id), false, "the last column stays");
  assert.equal(removeSheetColumn(doc, "nosuchcolumn"), false);
  assert.equal(doc.columns.length, 1);

  /* An empty sheet is legal; only the columns are load-bearing. */
  assert.equal(removeSheetRow(doc, doc.rows[0].id), true);
  assert.equal(doc.rows.length, 0);
  assert.equal(sheetSummary(doc), "0 rows x 1 column");
});

test("sheet: TSV is how structured state leaves the card", () => {
  const doc = normaliseSheet({
    columns: [{ id: "name", title: "name" }, { id: "n", title: "n", type: "number" }],
    rows: [{ id: "r1", cells: { name: "a\tb\nc", n: 5 } }, { id: "r2", cells: { name: "z", n: 0 } }],
  });
  assert.equal(sheetToTSV(doc), "name\tn\na b c\t5\nz\t0\n",
    "tabs and newlines inside a cell become spaces so the grid stays rectangular");
  assert.equal(sheetToTSV(emptySheet()), "column1\n\n");
});

test("sheet: keyboard navigation clamps instead of wrapping", () => {
  const doc = normaliseSheet({
    columns: [{ id: "a" }, { id: "b" }],
    rows: [{ id: "r1" }, { id: "r2" }],
  });
  assert.deepEqual(nextSheetSelection(doc, { row: 0, column: 0 }, 1, 1), { row: 1, column: 1 });
  assert.deepEqual(nextSheetSelection(doc, { row: 1, column: 1 }, 1, 1), { row: 1, column: 1 });
  assert.deepEqual(nextSheetSelection(doc, { row: 0, column: 0 }, -1, -1), { row: 0, column: 0 });
  assert.deepEqual(nextSheetSelection(doc, null, 0, 1), { row: 0, column: 1 });
  assert.equal(nextSheetSelection({ columns: [{ id: "a" }], rows: [] }, null, 1, 0), null);
});

test("protocol: a non-text card payload survives the board verbatim", () => {
  const doc = normaliseSheet({
    columns: [{ id: "k", title: "key" }, { id: "n", title: "n", type: "number" }, { id: "f", type: "bool" }],
    rows: [{ id: "r1", cells: { k: "unicode: \u00e9\u4e2d", n: 1.5, f: true } }],
  });
  const board = createBoard();
  board.load({
    version: 1,
    cards: [{ id: "s1", kind: "sheet", x: 0, y: 0, w: 400, h: 300, z: 1, title: "t", doc }],
    links: [],
  });
  const out = board.serialize();
  assert.equal(out.cards.length, 1);
  assert.equal(out.cards[0].kind, "sheet", "the board does not police card kinds");
  assert.deepEqual(out.cards[0].doc, doc, "nested structured state round-trips unchanged");
  assert.notEqual(out.cards[0].doc, doc, "and it is a copy, not an alias");
  assert.equal(DEFAULT_SIZE.sheet.w, 460);
  assert.ok(CARD_KINDS.includes("sheet"));
});

test("protocol: an unknown kind is preserved, never silently dropped", () => {
  const board = createBoard();
  board.load({
    version: 1,
    cards: [{ id: "u1", kind: "holodeck", x: 1, y: 2, w: 3, h: 4, payload: { deep: [1, 2, { three: true }] } }],
    links: [],
  });
  const out = board.serialize();
  assert.equal(out.cards.length, 1);
  assert.equal(out.cards[0].kind, "holodeck");
  assert.deepEqual(out.cards[0].payload, { deep: [1, 2, { three: true }] });
});

test("protocol: the document's card check is shape, not vocabulary", () => {
  /* The schema (board.mjs) requires id/kind/x/y/w/h and nothing else, which is
     what lets a fork invent kinds without touching C -- and the kernel no
     longer has a card check of its own to disagree with. */
  const shape = normaliseDocument({
    cards: [
      { id: "c1", kind: "sheet", x: 0, y: 0, w: 10, h: 10, doc: { anything: true } },
      { kind: "sheet", x: 0, y: 0, w: 10, h: 10 },
      { id: "c2", kind: "", x: 0, y: 0, w: 10, h: 10 },
      { id: "c3", kind: "note", x: 0, y: 0 },
    ],
  });
  assert.equal(shape.document.cards.length, 1);
  assert.equal(shape.droppedCards.length, 3);
  assert.deepEqual(shape.document.cards[0].doc, { anything: true });
});

/* ------------------------------------------------------------------ */
/* main.mjs -- the two DOM-free helpers behind the browser fixes        */
/* ------------------------------------------------------------------ */

test("cards: renderCard renders a placeholder for null, undefined and unknown kinds", () => {
  const dom = stubDom();
  try {
    // board.json is user-editable, so one malformed entry must not take the
    // whole canvas down: every one of these used to throw, and a throw inside
    // the render loop left the rest of the board unpainted.
    for (const entry of [null, undefined, 42, ["not", "a", "card"], { kind: "nope", id: "c1" }, { id: "c2" }]) {
      let card = null;
      assert.doesNotThrow(() => {
        card = renderCard(entry, {});
      }, `renderCard(${JSON.stringify(entry)}) must not throw`);
      assert.ok(card !== null && card.el, "a placeholder element is produced");
      assert.equal(typeof card.destroy, "function", "a placeholder is still destroyable");
      assert.ok(card.handle && typeof card.handle.focus === "function", "a placeholder is still focusable");
    }

    const missing = renderCard(null, {});
    assert.equal(missing.el.attrs["data-card-id"], "");
    assert.match(dom.text(missing.el), /empty \(null\)/);
    assert.match(dom.text(missing.el), /Known kinds: editor/);
    assert.equal(missing.handle.kind, "(none)");

    const unknown = renderCard({ kind: "nope", id: "c1" }, {});
    assert.equal(unknown.el.attrs["data-card-id"], "c1", "the entry keeps its own id");
    assert.match(dom.text(unknown.el), /No renderer for card kind "nope"/);
    assert.equal(unknown.handle.kind, "nope");

    // The pure decision behind it is checked directly as well, so a stub that
    // silently swallowed a throw could not make the check above pass.
    assert.equal(unknownCardPlaceholder(null).label, "(missing)");
    assert.equal(unknownCardPlaceholder(undefined).kind, "(none)");
    assert.equal(unknownCardPlaceholder(42).kind, "(not a card)");
    assert.equal(unknownCardPlaceholder({ kind: "nope" }).label, "(unknown)");
  } finally {
    dom.restore();
  }
});

await testAsync("main: ask's inline choice strip removes its command-line listener on every exit", async () => {
  /*
   * `ask()` itself is four lines: build a strip, build buttons, hand them to
   * `wireChoiceStrip`.  All listener bookkeeping lives in the helper, so this is
   * the check that the leak the browser had cannot come back: the listener must
   * be gone whether the question was answered, abandoned, or died part-way.
   */
  const strip = () => ({ removed: 0, remove() { this.removed += 1; } });

  // Answered by clicking.
  let command = stubEventTarget();
  let panel = strip();
  let button = stubEventTarget();
  let answer = wireChoiceStrip({ strip: panel, buttons: [{ el: button, value: "yes" }], abandonSource: command });
  assert.equal(command.count("input"), 1, "the question listens while it is open");
  button.fire("click");
  assert.equal(await answer, "yes");
  assert.equal(command.count("input"), 0, "the listener is gone once the question is answered");
  assert.equal(panel.removed, 1, "the strip is detached once");

  // Abandoned by typing.
  command = stubEventTarget();
  panel = strip();
  button = stubEventTarget();
  answer = wireChoiceStrip({ strip: panel, buttons: [{ el: button, value: "yes" }], abandonSource: command });
  command.fire("input");
  assert.equal(await answer, null, "typing means the question is abandoned");
  assert.equal(command.count("input"), 0, "the listener is gone once the question is abandoned");
  assert.equal(panel.removed, 1);

  // A strip that cannot detach must not keep the listener or hang the answer.
  command = stubEventTarget();
  panel = { remove() { throw new Error("already detached"); } };
  button = stubEventTarget();
  answer = wireChoiceStrip({ strip: panel, buttons: [{ el: button, value: "yes" }], abandonSource: command });
  button.fire("click");
  assert.equal(await answer, "yes", "a failing detach still resolves the answer");
  assert.equal(command.count("input"), 0, "the listener is gone even when detaching fails");

  // Several buttons cannot double-settle: the first answer wins and one
  // listener is removed, not two.
  command = stubEventTarget();
  panel = strip();
  const a = stubEventTarget();
  const b = stubEventTarget();
  answer = wireChoiceStrip({
    strip: panel,
    buttons: [{ el: a, value: "first" }, { el: b, value: "second" }],
    abandonSource: command,
  });
  b.fire("click");
  a.fire("click");
  assert.equal(await answer, "second");
  assert.equal(command.count("input"), 0);
  assert.equal(panel.removed, 1);
});

test("main: every save outcome is reported, and a failure never reads as a success", () => {
  const saved = saveOutcomeMessage({ status: "saved", revision: 7 });
  assert.equal(saved.level, "info");
  assert.match(saved.text, /rev 7/);
  // An autosave that worked is the one outcome allowed to stay quiet: a timer
  // is not the user, so a line per tick would be noise.
  assert.equal(saveOutcomeMessage({ status: "saved", revision: 7, auto: true }), null);

  // A write that succeeded without the host reporting a revision is still a
  // success, but the status line has to admit the next save is unguarded.
  const unguarded = saveOutcomeMessage({
    status: "saved",
    revision: null,
    detail: "the host reported no revision, so the next save cannot be guarded against a newer file",
  });
  assert.match(unguarded.text, /rev unknown/);
  assert.match(unguarded.text, /cannot be guarded/);

  // `save` with nothing to write used to say nothing at all, which is
  // indistinguishable from a save that quietly did nothing.
  const unchanged = saveOutcomeMessage({ status: "unchanged" });
  assert.equal(unchanged.level, "info");
  assert.match(unchanged.text, /nothing to write/);

  // A save folded into one already in flight, and a forced one stays forced.
  const deferred = saveOutcomeMessage({ status: "deferred", force: true });
  assert.match(deferred.text, /forced save/);

  // A forced overwrite the host refused -- the case that used to look like a
  // success because `force` was asked for and no error was raised.
  const refused = saveOutcomeMessage({
    status: "refused",
    force: true,
    detail: "the board changed on disk (rev 9)",
  });
  assert.equal(refused.level, "warn");
  assert.match(refused.text, /forced overwrite/);
  assert.match(refused.text, /rev 9/);

  // A save that threw, and a save that could not start.
  const failed = saveOutcomeMessage({ status: "failed", detail: "boom" });
  assert.equal(failed.level, "error");
  assert.match(failed.text, /boom/);
  assert.equal(saveOutcomeMessage({ status: "offline" }).level, "error");

  // An autosave failure is still news: nobody is watching the timer.
  assert.equal(saveOutcomeMessage({ status: "failed", auto: true, detail: "boom" }).level, "error");
  assert.equal(saveOutcomeMessage({ status: "refused", auto: true, detail: "x" }).level, "warn");

  // Nothing below "saved" may be reported as an error-free success, and none of
  // them may claim the board was saved.
  for (const status of ["refused", "failed", "offline"]) {
    const line = saveOutcomeMessage({ status });
    assert.notEqual(line.level, "info", `${status} must not look like a success`);
    assert.doesNotMatch(line.text, /board saved/, `${status} must not claim a save`);
  }
  assert.equal(saveOutcomeMessage({ status: "saved-ish" }), null, "an unknown status claims nothing");
});

/* ------------------------------------------------------------------ */
/* the 幼神 cards' pure helpers                                          */
/* ------------------------------------------------------------------ */

test("mods: severity is counted by kind, and an unknown one counts as info", () => {
  const counts = diagCounts([
    { severity: "error" }, { severity: "error" },
    { severity: "warning" },
    { severity: "info" }, { severity: "info" }, { severity: "info" },
    { severity: "weird" },
    {},
  ]);
  assert.deepEqual(counts, { error: 2, warning: 1, info: 5 });
  assert.deepEqual(diagCounts(null), { error: 0, warning: 0, info: 0 });
  assert.deepEqual(diagCounts([]), { error: 0, warning: 0, info: 0 });
});

test("mods: defines group by type with both levels sorted", () => {
  const grouped = groupDefines([
    { type: "Topic", techName: "B" },
    { type: "Attr", techName: "Z" },
    { type: "Topic", techName: "A" },
    { type: "Topic", techName: "C" },
  ]);
  assert.deepEqual(grouped.map((g) => g.type), ["Attr", "Topic"]);
  assert.deepEqual(grouped[0].items.map((d) => d.techName), ["Z"]);
  assert.deepEqual(grouped[1].items.map((d) => d.techName), ["A", "B", "C"]);
  /* A define with no type must still be shown, not dropped. */
  assert.deepEqual(groupDefines([{ techName: "X" }]).map((g) => g.type), ["(unknown)"]);
  assert.deepEqual(groupDefines(undefined), []);
});

test("mods: the headline names the package and its load order", () => {
  assert.equal(
    modHeadline({ manifest: { name: "MyMod", version: "1.0.0", loadOrder: 0, gameVersion: "1.0" } }),
    "MyMod 1.0.0 — loadOrder 0 · gameVersion 1.0");
  assert.equal(modHeadline(null), "no mod opened");
  assert.equal(modHeadline({}), "(unnamed) ? — loadOrder ? · gameVersion ?");
});

test("mods: mod-relative paths are joined, absolute ones are left alone", () => {
  assert.equal(modPath("Mods/MyMod", "Defines/Attr/A.json"), "Mods/MyMod/Defines/Attr/A.json");
  assert.equal(modPath("Mods/MyMod/", "x.json"), "Mods/MyMod/x.json");
  assert.equal(modPath("Mods\\MyMod", "x.json"), "Mods/MyMod/x.json", "a Windows root still joins with /");
  assert.equal(modPath("Mods/MyMod", "/abs/x.json"), "/abs/x.json");
  assert.equal(modPath("Mods/MyMod", "C:/abs/x.json"), "C:/abs/x.json");
  assert.equal(modPath("", "x.json"), "x.json");
  assert.equal(modPath("Mods/MyMod", ""), "");
});

test("mods: a diagnostic splits into a file and a JSON pointer", () => {
  const diagnostic = { path: "Defines/Goods/Folk.json#/icon", severity: "error" };
  assert.equal(diagFile(diagnostic), "Defines/Goods/Folk.json");
  assert.equal(diagWhere(diagnostic), "/icon");
  /* A package-level diagnostic has no pointer: the whole path is the file. */
  assert.equal(diagFile({ path: "mod.json" }), "mod.json");
  assert.equal(diagWhere({ path: "mod.json" }), "");
  assert.equal(diagFile({}), "");
  assert.equal(diagWhere(null), "");
});

/* ------------------------------------------------------------------ */
/* undo and redo                                                       */
/* ------------------------------------------------------------------ */

/** A board with two cards and one link -- enough for every kind of edit. */
function historyDoc() {
  return {
    version: 1,
    viewport: { x: 0, y: 0, zoom: 1 },
    cards: [
      { id: "c1", kind: "note", x: 0, y: 0, w: 300, h: 180, z: 1, text: "hello" },
      { id: "c2", kind: "editor", x: 400, y: 0, w: 680, h: 460, z: 2, file: "examples/hello.yarn" },
    ],
    links: [{ id: "l1", from: "c1", to: "c2", label: "notes" }],
  };
}

function edited(mutate) {
  const document = historyDoc();
  mutate(document);
  return document;
}

test("history: a fresh history has nothing to undo or redo", () => {
  const history = createHistory();
  history.reset(historyDoc());
  assert.equal(history.canUndo(), false);
  assert.equal(history.canRedo(), false);
  assert.equal(history.size(), 1);
  assert.equal(history.position(), 0);
  assert.equal(history.undo(), null, "undo at the start returns nothing");
  assert.equal(history.redo(), null, "redo when there is nothing ahead returns nothing");
  assert.deepEqual(history.current(), historyDoc(), "current() is the state it was reset to");
  assert.equal(history.label(), "the board as loaded");
});

test("history: an edit is one step and undo puts the document back", () => {
  const history = createHistory();
  const before = historyDoc();
  history.reset(before);
  const after = edited((doc) => {
    doc.cards[0].text = "hello there";
  });
  assert.equal(history.record(after), true, "a real edit pushes a step");
  assert.equal(history.canUndo(), true);
  assert.equal(history.label(), "edited the note card c1");
  const step = history.undo();
  assert.deepEqual(step.document, before, "undo restores the document it recorded from");
  assert.equal(step.label, "edited the note card c1");
  assert.equal(history.canUndo(), false);
  assert.equal(history.canRedo(), true);
  assert.deepEqual(history.redo().document, after, "redo walks forward to the same document");
  assert.equal(history.canRedo(), false);
});

test("history: a snapshot is a copy, so editing the board cannot rewrite the past", () => {
  const history = createHistory();
  const before = historyDoc();
  history.reset(before);
  const after = edited((doc) => {
    doc.cards[0].text = "new";
  });
  history.record(after);
  // The caller keeps mutating the very object it handed over: history must not
  // alias it, or every undo would "restore" the newest state.
  after.cards[0].text = "newer still";
  after.cards.push({ id: "c9", kind: "note", x: 0, y: 0, w: 100, h: 100, z: 3, text: "" });
  assert.deepEqual(history.undo().document, before, "the recorded document is untouched");
});

test("history: nothing changed, and a viewport-only move, are not steps", () => {
  const history = createHistory();
  history.reset(historyDoc());
  assert.equal(history.record(historyDoc()), false, "an identical document is not an edit");
  const panned = edited((doc) => {
    doc.viewport = { x: -120, y: 40, zoom: 1.5 };
  });
  assert.equal(history.record(panned), false, "panning and zooming are navigation, not edits");
  assert.equal(describeChange(historyDoc(), panned), null);
  assert.equal(history.size(), 1);
  const raised = edited((doc) => {
    doc.cards[0].z = 7;
  });
  assert.equal(history.record(raised), false, "raising a card is not an undo step");
});

test("history: a typing burst is one step, and a pause starts the next", () => {
  let clock = 1000;
  const history = createHistory({ now: () => clock });
  history.reset(historyDoc());
  const first = edited((doc) => {
    doc.cards[0].text = "h";
  });
  assert.equal(history.record(first), true, "the first keystroke opens a step");
  clock += 120;
  const second = edited((doc) => {
    doc.cards[0].text = "he";
  });
  assert.equal(history.record(second), false, "the next keystroke folds into it");
  clock += 120;
  const third = edited((doc) => {
    doc.cards[0].text = "hel";
  });
  history.record(third);
  assert.equal(history.size(), 2, "one step so far: the loaded board, then the sentence");
  assert.deepEqual(history.undo().document, historyDoc(), "undo takes back the whole burst");
  clock += 5000;
  history.redo();
  const later = edited((doc) => {
    doc.cards[0].text = "hello again";
  });
  assert.equal(history.record(later), true, "a pause ends the burst: this is a new step");
  assert.equal(history.size(), 3);
});

test("history: a new edit after an undo throws the redo branch away", () => {
  const history = createHistory();
  history.reset(historyDoc());
  const one = edited((doc) => {
    doc.cards[0].text = "one";
  });
  const two = edited((doc) => {
    doc.cards[0].text = "two";
  });
  history.record(one);
  history.record(two);
  assert.equal(history.undo().label, "edited the note card c1");
  assert.equal(history.canRedo(), true);
  const branch = edited((doc) => {
    doc.cards[0].text = "another branch";
  });
  history.record(branch);
  assert.equal(history.canRedo(), false, "the abandoned future is gone");
  assert.equal(history.size(), 2);
  assert.deepEqual(history.current(), branch);
});

test("history: the ring forgets the oldest steps past its limit", () => {
  const history = createHistory({ limit: 3 });
  history.reset(historyDoc());
  for (let n = 1; n <= 5; n += 1) {
    const document = edited((doc) => {
      doc.cards[0].text = `step ${n}`;
    });
    history.record(document, { label: `edit ${n}` });
  }
  assert.equal(history.size(), 3, "the limit is a ceiling, not a suggestion");
  assert.equal(history.position(), 2);
  assert.equal(history.canUndo(), true);
  assert.equal(history.undo().label, "edit 5");
  assert.equal(history.undo().label, "edit 4");
  assert.equal(history.canUndo(), false, "the steps past the limit are gone, not hidden");
  assert.equal(history.size(), 3);
});

test("history: describeChange names the edit a person just made", () => {
  const base = historyDoc();
  const adding = edited((doc) => {
    doc.cards.push({ id: "c3", kind: "note", x: 900, y: 0, w: 200, h: 120, z: 3, text: "" });
  });
  assert.equal(describeChange(base, adding), "added a card c3");
  const removing = edited((doc) => {
    doc.cards = doc.cards.filter((card) => card.id !== "c2");
    doc.links = [];
  });
  assert.equal(describeChange(base, removing), "removed a card c2 and unlinked l1");
  const moving = edited((doc) => {
    doc.cards[0].x += 40;
    doc.cards[0].y += 40;
  });
  assert.equal(describeChange(base, moving), "moved a card c1");
  const resizing = edited((doc) => {
    doc.cards[0].w = 420;
  });
  assert.equal(describeChange(base, resizing), "resized a card c1");
  const editing = edited((doc) => {
    doc.cards[1].file = "examples/sample.json";
  });
  assert.equal(describeChange(base, editing), "edited the editor card c2");
  const linking = edited((doc) => {
    doc.links.push({ id: "l2", from: "c2", to: "c1", label: "back" });
  });
  assert.equal(describeChange(base, linking), "linked c2 to c1");
  const twoThings = edited((doc) => {
    doc.cards[0].x += 10;
    doc.cards[1].text = "something";
  });
  assert.equal(describeChange(base, twoThings), "edited the editor card c2 and moved a card c1");
  assert.equal(describeChange(base, base), null, "no change, no phrase");
});

test("history: clear() empties it and a record after that starts over", () => {
  const history = createHistory();
  history.reset(historyDoc());
  history.record(
    edited((doc) => {
      doc.cards[0].text = "x";
    }),
  );
  history.clear();
  assert.equal(history.size(), 0);
  assert.equal(history.position(), -1);
  assert.equal(history.canUndo(), false);
  assert.equal(history.current(), null);
  const document = edited((doc) => {
    doc.cards[0].text = "after the clear";
  });
  assert.equal(history.record(document), true, "the first record after a clear seeds the ring");
  assert.equal(history.size(), 1);
  assert.deepEqual(history.current(), document);
});

/*
 * The wheel rule the board follows: a card's own scroll region keeps the wheel
 * while it has room in that direction, and the board pans only when it does not.
 * Which ancestor is a scroll container needs a browser; this is the arithmetic
 * that decision rests on.
 */
test("wheel: a scroll region has room only where it can still move", () => {
  assert.equal(scrollRoom(0, 100, 400, 120), 300, "at the top, a downward wheel has the rest to go");
  assert.equal(scrollRoom(300, 100, 400, 120), 0, "at the bottom, a downward wheel has nowhere to go");
  assert.equal(scrollRoom(120, 100, 400, -120), 120, "a wheel up has the part already scrolled past");
  assert.equal(scrollRoom(0, 100, 400, -120), 0, "a wheel up at the top has nowhere to go");
  assert.equal(scrollRoom(0, 400, 400, 120), 0, "content that already fits does not scroll");
  assert.equal(scrollRoom(10, 100, 400, 0), 0, "a wheel that moves nothing owns nothing");
  assert.equal(scrollRoom(NaN, 100, 400, 120), 0, "a broken metric never claims room");
});

/*
 * What to do when a file moves under a card. `main.mjs` asks the kernel and
 * `cards.mjs` obeys; the decision -- reload, warn, or say nothing -- is pure, so
 * it is pinned here without a browser, a kernel or a clock. The rule that
 * matters most is the one a naive watcher gets wrong: an unknown revision is
 * never a licence to reload over someone's typing.
 */

/** A `file.stat` answer: a file that is on disk, holding `revision`. */
function stat(revision) {
  return { exists: true, dir: false, size: 12, mtime: 1, revision };
}

test("watch: a card that has not read the file yet has nothing to compare", () => {
  assert.equal(watchDecision({ revision: null, dirty: false }, stat(7)), WATCH_UNKNOWN);
  assert.equal(watchDecision({ revision: Number.NaN, dirty: false }, stat(7)), WATCH_UNKNOWN);
  assert.equal(watchDecision({}, stat(7)), WATCH_UNKNOWN, "a missing revision is not revision 0");
});

test("watch: a transport failure is not a change", () => {
  assert.equal(watchDecision({ revision: 7 }, null), WATCH_UNKNOWN);
  assert.equal(watchDecision({ revision: 7 }, undefined), WATCH_UNKNOWN);
  assert.equal(watchDecision({ revision: 7 }, { error: new Error("blinked") }), WATCH_UNKNOWN);
});

test("watch: a file that is gone says so, and a directory is gone too", () => {
  assert.equal(watchDecision({ revision: 7 }, { exists: false, dir: false, revision: 0 }), WATCH_GONE);
  assert.equal(watchDecision({ revision: 7 }, { exists: true, dir: true, revision: 0 }), WATCH_GONE);
});

test("watch: cannot-compare warns and never reloads", () => {
  assert.equal(watchDecision({ revision: 7 }, stat(0)), WATCH_WARN, "revision 0 is `cannot say`");
  assert.equal(watchDecision({ revision: 0 }, stat(7)), WATCH_WARN, "a card holding 0 cannot compare either");
  assert.equal(watchDecision({ revision: 0, dirty: false }, stat(9)), WATCH_WARN);
});

test("watch: an empty file has a real revision, not `cannot compare`", () => {
  // 2166136261 is what the kernel's FNV-1a hands an empty buffer. Reading it as
  // 0 would warn about a file that is merely empty, on every poll, forever.
  assert.equal(watchDecision({ revision: 2166136261 }, stat(2166136261)), WATCH_OK);
});

test("watch: the same revision is quiet, a new one reloads a clean card", () => {
  assert.equal(watchDecision({ revision: 7, dirty: false }, stat(7)), WATCH_OK);
  assert.equal(watchDecision({ revision: 7, dirty: false }, stat(8)), WATCH_RELOAD);
});

test("watch: unsaved edits are never overwritten by a reload", () => {
  assert.equal(watchDecision({ revision: 7, dirty: true }, stat(8)), WATCH_WARN);
});

test("watch: a trimmed kernel is smaller, not broken", () => {
  assert.equal(watchTrimmed([{ error: { code: -32601 } }]), true);
  assert.equal(watchTrimmed([{ error: { code: -32601 } }, stat(7)]), true);
  assert.equal(watchTrimmed([stat(7)]), false, "an answer is not a refusal");
  assert.equal(watchTrimmed([{ error: { code: -32602 } }]), false, "another code is not METHOD_NOT_FOUND");
  assert.equal(watchTrimmed([{ error: new Error("offline") }]), false, "a transport error carries no code");
  assert.equal(watchTrimmed([]), false);
});

test("watch: one decision per path per revision is news exactly once", () => {
  const pairs = [{ path: "a.yarn", known: { revision: 7, dirty: false }, stat: stat(8) }];
  const first = watchReport(pairs, new Map());
  assert.equal(first.actions.length, 1);
  assert.equal(first.actions[0].decision, WATCH_RELOAD);
  const again = watchReport(pairs, first.next);
  assert.equal(again.actions.length, 0, "the same answer a poll later is not news");
  const moved = watchReport([{ path: "a.yarn", known: { revision: 7 }, stat: stat(9) }], again.next);
  assert.equal(moved.actions.length, 1, "a new revision is news again");
});

test("watch: quiet and unanswerable decisions are not actions", () => {
  const report = watchReport(
    [
      { path: "same.yarn", known: { revision: 7 }, stat: stat(7) },
      { path: "loading.yarn", known: { revision: null }, stat: stat(9) },
    ],
    new Map(),
  );
  assert.deepEqual(report.actions, [], "ok and unknown report nothing");
  assert.equal(report.next.get("same.yarn"), "ok:7");
  assert.equal(report.next.get("loading.yarn"), "unknown:9");
});

test("watch: a path that is no longer open is forgotten", () => {
  const before = new Map([["gone.yarn", "ok:7"]]);
  const report = watchReport([], before);
  assert.equal(report.next.size, 0, "a long session does not grow the map forever");
});

/* ------------------------------------------------------------------ */
/* the classic view --- */
/*
 * The second way to look at the same board.  What is pinned here is the two
 * promises that make it a *view* rather than a second layout engine: nothing it
 * computes is written back to a card (so `mode board` is exactly the board
 * again), and every card either has one place in the tile or is hidden -- never
 * drawn at 0,0 and never moved.
 *
 * The pixels themselves are checked as arithmetic: the tile's pieces have to
 * add up at any window size, which is the part a browser would otherwise be the
 * only witness to.
 */
/* ------------------------------------------------------------------ */

const cardOf = (id, kind, extras = {}) => ({ id, kind, x: 0, y: 0, w: 100, h: 100, z: 1, ...extras });

test("classic: the sidebar is the project panel, and the file list is second choice", () => {
  assert.deepEqual(CLASSIC_SIDEBAR_KINDS, ["project", "files"]);
  const board = [cardOf("e1", "editor"), cardOf("n", "note"), cardOf("f", "files")];
  assert.equal(classicRoles(board).sidebar, "f", "no project panel, so the file list takes the column");
  assert.equal(classicRoles([...board, cardOf("p", "project")]).sidebar, "p");
});

test("classic: the code area is the focused editor, and the first one without a focus", () => {
  const board = [cardOf("e1", "editor"), cardOf("e2", "editor"), cardOf("n", "note")];
  assert.equal(classicRoles(board, "e2").area, "e2", "the focused file is the one a command would act on");
  assert.equal(classicRoles(board, "n").area, "e1", "a focused note is not a file to edit");
  assert.equal(classicRoles(board, null).area, "e1");
  assert.equal(classicRoles([cardOf("n", "note")]).area, null);
});

test("classic: one card, at most one role -- and everything else is hidden", () => {
  const board = [cardOf("p", "project"), cardOf("e1", "editor"), cardOf("e2", "editor"), cardOf("f", "frame")];
  const roles = classicRoles(board, "e1");
  assert.deepEqual([roles.sidebar, roles.area], ["p", "e1"]);
  assert.deepEqual(roles.tabs, ["e1", "e2"], "every editor is a tab, even the one in the code area");
  assert.deepEqual(roles.hidden, ["e2", "f"], "the second editor is a tab, not a second pane");
  const files = classicRoles([cardOf("f", "files")], "f");
  assert.equal(files.sidebar, "f");
  assert.equal(files.area, null, "a card cannot be the sidebar and the code area at once");
});

test("classic: the tile adds up -- no gap and no overlap at any window size", () => {
  const board = [cardOf("p", "project"), cardOf("e1", "editor")];
  for (const [width, height, top] of [[1200, 800, 30], [500, 400, 0], [100, 50, 26], [0, 0, 0]]) {
    const out = classicLayout(board, { width, height }, { activeId: "e1", top });
    const where = `${width}x${height} top ${top}`;
    assert.equal(out.tabs.x, out.sidebar.x + out.sidebar.w, `the strip starts where the sidebar ends (${where})`);
    assert.equal(out.area.x, out.tabs.x, `the code area is under the strip (${where})`);
    assert.equal(out.area.y, out.tabs.y + out.tabs.h, `and begins where it ends (${where})`);
    assert.equal(out.tabs.y, top, `nothing is drawn under the HUD (${where})`);
    assert.equal(out.area.x + out.area.w, width, `the tile reaches the right edge (${where})`);
    assert.equal(out.sidebar.y + out.sidebar.h, height, `the column reaches the bottom (${where})`);
    assert.equal(out.area.y + out.area.h, height, `the code area reaches the bottom (${where})`);
  }
});

test("classic: with no sidebar card the code area gets the whole width", () => {
  const out = classicLayout([cardOf("e1", "editor")], { width: 900, height: 600 }, { activeId: "e1" });
  assert.equal(out.sidebar, null);
  assert.equal(out.sidebarWidth, 0);
  assert.equal(out.tabs.x, 0);
  assert.equal(out.area.w, 900);
  assert.equal(out.tabHeight, CLASSIC_TAB_H);
});

test("classic: a narrow window squeezes the column, and the code area never goes negative", () => {
  const board = [cardOf("p", "project"), cardOf("e1", "editor")];
  const widthAt = (width) => classicLayout(board, { width, height: 600 }).sidebarWidth;
  assert.equal(widthAt(1400), 280, "the comfortable width is the cap, not 40% of a big window");
  assert.equal(widthAt(500), 200, "40% of 500 is the most it may take");
  assert.equal(widthAt(300), 160, "160 is where its listing stops being readable");
  assert.equal(widthAt(100), 100, "a window narrower than that has no room for two columns");
  assert.equal(classicLayout(board, { width: 100, height: 600 }).area.w, 0);
});

test("classic: the tile starts below the HUD, which floats over the board", () => {
  const out = classicLayout([cardOf("p", "project"), cardOf("e1", "editor")], { width: 1000, height: 500 }, { top: 30 });
  assert.equal(out.tabs.y, 30);
  assert.equal(out.area.y, 30 + CLASSIC_TAB_H);
  assert.equal(out.sidebar.h, 470);
  const squashed = classicLayout([cardOf("e1", "editor")], { width: 1000, height: 20 }, { top: 30 });
  assert.equal(squashed.tabHeight, 0, "a strip taller than what is left is not drawn hanging off the board");
  assert.equal(squashed.area.h, 0);
});

test("classic: a tab is the last segment of the path, either slash", () => {
  assert.equal(classicTabLabel("core/src/wksp.c"), "wksp.c");
  assert.equal(classicTabLabel("shell\\web\\main.mjs"), "main.mjs");
  assert.equal(classicTabLabel("notes"), "notes");
  assert.equal(classicTabLabel("a/b/"), "a/b/", "a trailing slash is not a name");
  assert.equal(classicTabLabel(""), "");
  assert.equal(classicTabLabel(null), "");
  assert.equal(classicTabLabel(undefined), "");
});

test("views: the mode a command names is one of three, and an unknown one is refused", () => {
  assert.deepEqual(VIEWS, ["board", "classic", "mod"]);
  assert.deepEqual(VIEW_LABELS, { board: "Board", classic: "Classic", mod: "Mod" });
  assert.equal(viewName("classic"), "classic");
  assert.equal(viewName("  Mod "), "mod", "the command line is not case-sensitive");
  assert.equal(viewName("tabs"), null, "an unknown word must warn, not fall back silently");
  assert.equal(viewName(""), null);
  assert.equal(viewName(undefined), null);
  assert.equal(viewName(3), null);
});

test("views: the HUD quotes no zoom a tile cannot honour", () => {
  assert.deepEqual(viewHud("classic"), { view: "classic", zoom: "no zoom" });
  assert.deepEqual(viewHud("mod"), { view: "mod", zoom: "no zoom" });
  assert.deepEqual(viewHud("board"), { view: "board", zoom: null });
  assert.deepEqual(viewHud("sideways"), viewHud("board"), "anything else is the board");
  assert.equal(tiledView("board"), false);
  assert.equal(tiledView("classic"), true);
  assert.equal(tiledView("mod"), true);
  assert.equal(tiledView("sideways"), false, "an unknown view is not a tile, so it cannot be drawn");
});

test("views: the window opens on the tile, and the board is a mode rather than a button", () => {
  assert.equal(DEFAULT_VIEW, "classic", "a window opens where a mod author works, not on a canvas");
  assert.ok(VIEWS.indexOf(DEFAULT_VIEW) !== -1, "the default has to be a name `mode` accepts");
  assert.deepEqual(SWITCH_VIEWS, ["classic", "mod"]);
  assert.equal(SWITCH_VIEWS.indexOf("board"), -1, "the board is reachable by name and offered to nobody");
  assert.ok(SWITCH_VIEWS.indexOf(DEFAULT_VIEW) !== -1, "the view a window opens in must be one you can leave");
  for (const view of SWITCH_VIEWS) {
    assert.ok(VIEWS.indexOf(view) !== -1, `${view}: the switch cannot offer a name \`mode\` would refuse`);
  }
});

test("views: a switch button has a label and a tooltip whichever view is on it", () => {
  for (const view of VIEWS) {
    assert.equal(typeof VIEW_LABELS[view], "string", `${view}: a button needs a label`);
    assert.equal(typeof VIEW_TITLES[view], "string", `${view}: a button title of undefined is not a title`);
    assert.ok(VIEW_TITLES[view].length > 20, `${view}: the tooltip says something about the view`);
  }
  assert.deepEqual(
    Object.keys(VIEW_TITLES).sort(),
    [...VIEWS].sort(),
    "and nothing besides the views: a title for no view is dead weight",
  );
});

test("views: every view names the ways out of it and says what it is", () => {
  for (const view of VIEWS) {
    const note = viewNote(view);
    assert.ok(note.indexOf(`the ${view} view`) !== -1, `${view}: the note says where you are`);
    for (const other of VIEWS) {
      if (other !== view) {
        assert.ok(note.indexOf(`mode ${other}`) !== -1, `${view}: the note names how to reach ${other}`);
      }
    }
    assert.ok(viewAbout(view).length > 20, `${view}: it has a sentence of its own`);
  }
  assert.notEqual(viewAbout("board"), viewAbout("mod"), "the mod view is not described as the board");
  assert.equal(viewAbout("sideways"), viewAbout("board"), "an unknown view is the board");
});

test("mod: the package is the sidebar, the report is the panel, both before their fallbacks", () => {
  const board = [cardOf("n", "note"), cardOf("f", "files"), cardOf("p", "project"), cardOf("m", "mod")];
  assert.equal(modRoles(board).sidebar, "m", "a mod package beats the project panel and the file list");
  assert.equal(modRoles([cardOf("p", "project"), cardOf("f", "files")]).sidebar, "p");
  assert.equal(modRoles([cardOf("f", "files")]).sidebar, "f", "the file list is the last resort");
  assert.equal(modRoles([cardOf("n", "note")]).sidebar, null, "a note is not a package tree");
  assert.equal(modRoles([cardOf("x", "problems")]).panel, "x");
  assert.equal(modRoles([cardOf("n", "note")]).panel, null, "no report card, no panel");
});

test("mod: the code area is the focused editor, and a focused note is not one", () => {
  const board = [cardOf("e1", "editor"), cardOf("e2", "editor"), cardOf("n", "note")];
  assert.equal(modRoles(board, "e2").area, "e2", "the focused file is the one a command would act on");
  assert.equal(modRoles(board, "n").area, "e1", "a focused note is not a file to edit");
  assert.equal(modRoles(board, null).area, "e1");
  assert.equal(modRoles([cardOf("n", "note")]).area, null);
  assert.deepEqual(modRoles(board, "e2").tabs, ["e1", "e2"], "every editor is a tab, in board order");
});

test("mod: a card has one part, and the parts do not overlap", () => {
  const board = [cardOf("m", "mod"), cardOf("e1", "editor"), cardOf("x", "problems"), cardOf("n", "note")];
  const roles = modRoles(board, "e1");
  const parts = [roles.sidebar, roles.area, roles.panel];
  assert.equal(new Set(parts).size, 3, "three roles, three different cards");
  for (const id of parts) {
    assert.equal(roles.hidden.indexOf(id), -1, `${id} plays a part, so it is not also hidden`);
  }
  assert.deepEqual(roles.hidden, ["n"], "the note has no part in this view");
  assert.equal(modRoles([cardOf("m", "mod")], "m").area, null, "the package cannot double as the code area");
});

test("mod: the tile has no gap and no overlap, at any size", () => {
  const board = [cardOf("m", "mod"), cardOf("e1", "editor"), cardOf("x", "problems")];
  for (const width of [1600, 1200, 900, 700, 400, 200]) {
    for (const height of [900, 700, 500, 300, 240]) {
      const out = modLayout(board, { width, height }, { activeId: "e1", top: 30 });
      const where = `${width}x${height}`;
      assert.equal(out.tabs.x, out.sidebarWidth, `${where}: the strip starts where the column ends`);
      assert.equal(out.area.x, out.sidebarWidth, `${where}: the code starts where the column ends`);
      assert.equal(out.tabs.y, 30, `${where}: the strip starts under the HUD`);
      assert.equal(out.tabs.y + out.tabs.h, out.area.y, `${where}: the area begins where the strip ends`);
      assert.equal(out.tabs.w, out.area.w, `${where}: strip and area are the same column`);
      if (out.panel !== null) {
        assert.equal(out.area.y + out.area.h, out.panel.y, `${where}: the panel begins where the code ends`);
        assert.equal(out.panel.w, out.area.w, `${where}: the panel is as wide as the code`);
        assert.equal(out.panel.y + out.panel.h, height, `${where}: the panel ends on the bottom edge`);
      } else {
        assert.equal(out.area.y + out.area.h, height, `${where}: with no panel the code reaches the bottom`);
      }
      assert.equal(out.sidebar.y, 30, `${where}: the column starts under the HUD`);
      assert.equal(out.sidebar.y + out.sidebar.h, height, `${where}: the column is as tall as the board`);
      assert.ok(out.sidebar.w + out.area.w <= width, `${where}: column and code fit side by side`);
      assert.ok(out.area.h >= 0, `${where}: the code area is never negative`);
      if (out.panel !== null) {
        assert.ok(out.panel.h >= 0, `${where}: the panel is never negative`);
      }
    }
  }
});

test("mod: the sidebar squeezes to 40%, never below 180, until the window itself is narrower", () => {
  const board = [cardOf("m", "mod"), cardOf("e1", "editor")];
  const widthAt = (width) => modLayout(board, { width, height: 600 }).sidebarWidth;
  assert.equal(widthAt(2000), MOD_SIDEBAR_W, "a wide window gets the comfortable width");
  assert.equal(widthAt(1200), MOD_SIDEBAR_W);
  assert.equal(widthAt(700), 280, "40% of 700 is 280");
  assert.equal(widthAt(500), 200, "40% of 500 is 200");
  assert.equal(widthAt(400), MOD_SIDEBAR_MIN, "below 450 the column stops shrinking at its readable minimum");
  assert.equal(widthAt(100), 100, "a window narrower than the column gives it the whole window");
  assert.equal(modLayout([cardOf("e1", "editor")], { width: 1200, height: 600 }).sidebarWidth, 0, "no sidebar card, no column");
  assert.equal(modLayout(board, { width: 1200, height: 600 }).area.w, 1200 - MOD_SIDEBAR_W);
});

test("mod: a window too short for both drops the panel and gives the height to the code", () => {
  const board = [cardOf("m", "mod"), cardOf("e1", "editor"), cardOf("x", "problems")];
  const tall = modLayout(board, { width: 1200, height: 900 }, { top: 30 });
  assert.equal(tall.panelHeight, MOD_PANEL_H, "a tall window gets the comfortable panel");
  assert.equal(tall.panel.h, MOD_PANEL_H);
  const short = modLayout(board, { width: 1200, height: 240 }, { top: 30 });
  assert.equal(short.panelHeight, 0, "no room to keep both, so the panel goes");
  assert.equal(short.panel, null, "and there is no rectangle to draw it in");
  assert.equal(short.boxes.has("x"), false, "a panel with no height is not placed at 0,0");
  assert.equal(short.area.y + short.area.h, 240, "the code takes the whole column back");
  const justEnough = modLayout(board, { width: 1200, height: 300 }, { top: 30 });
  assert.ok(justEnough.panelHeight >= MOD_PANEL_MIN, "the panel is either readable or absent");
  assert.ok(justEnough.area.h >= MOD_AREA_MIN, "the code keeps its minimum whenever the panel is drawn");
});

test("mod: with no report card the tile is the classic one, plus a package column", () => {
  const board = [cardOf("m", "mod"), cardOf("e1", "editor"), cardOf("n", "note")];
  const out = modLayout(board, { width: 1200, height: 800 }, { activeId: "e1", top: 30 });
  assert.equal(out.panelHeight, 0);
  assert.equal(out.tabHeight, MOD_TAB_H);
  assert.equal(out.boxes.size, 2, "the column and the code area, and nothing else");
  assert.equal(out.boxes.has("n"), false, "the note has no home here: hiding it is the answer");
  assert.deepEqual(out.roles.hidden, ["n"]);
});

test("mod: the layout is a projection -- it never writes to a card", () => {
  const board = [
    cardOf("m", "mod", { x: 40, y: 60 }),
    cardOf("e1", "editor", { x: 700, y: 400, w: 500, h: 400 }),
    cardOf("x", "problems"),
  ];
  const before = JSON.parse(JSON.stringify(board));
  const out = modLayout(board, { width: 1200, height: 800 }, { activeId: "e1", top: 30 });
  assert.notEqual(out.boxes.get("e1").x, 700, "the code area is somewhere else on screen");
  assert.notEqual(out.boxes.get("x").y, out.boxes.get("e1").y, "the report is under the code, not on it");
  assert.deepEqual(board, before, "but the document is untouched -- `mode board` must be the board again");
});

test("mod: a panel kind and a sidebar kind are disjoint by rule, not by accident", () => {
  for (const kind of MOD_SIDEBAR_KINDS) {
    assert.equal(MOD_PANEL_KINDS.indexOf(kind), -1, `${kind} cannot be both the column and the panel`);
  }
});

test("classic: a card with no place in the tile is hidden, not placed at 0,0", () => {
  const board = [cardOf("p", "project"), cardOf("e1", "editor", { x: 700, y: 400 }), cardOf("n", "note")];
  const out = classicLayout(board, { width: 1200, height: 800 }, { activeId: "e1" });
  assert.equal(out.boxes.size, 2, "only the sidebar and the code area are drawn");
  assert.equal(out.boxes.has("n"), false, "the note has no home here: hiding it is the answer");
  assert.deepEqual(out.roles.hidden, ["n"]);
});

test("classic: the layout is a projection -- it never writes to a card", () => {
  const board = [cardOf("p", "project", { x: 40, y: 60 }), cardOf("e1", "editor", { x: 700, y: 400, w: 500, h: 400 })];
  const before = JSON.parse(JSON.stringify(board));
  const out = classicLayout(board, { width: 1200, height: 800 }, { activeId: "e1", top: 30 });
  assert.notEqual(out.boxes.get("e1").x, 700, "the code area is somewhere else on screen");
  assert.deepEqual(board, before, "but the document is untouched -- `mode board` must be the board again");
});

/* ------------------------------------------------------------------ */
/* story.mjs: a `.yarn` file has to come back out the way it went in    */
/* ------------------------------------------------------------------ */

/** A body line's fields, with `edit` dropped: it is the dirty mark, not a field. */
const storyLineShape = (entry) => {
  const copy = { ...entry };
  delete copy.edit;
  return copy;
};

const storyFixture = (lines, eol = "\n", tail = true) => `${lines.join(eol)}${tail ? eol : ""}`;

/**
 * How many body lines a fixture's lines hold, counted the way the parser reads it.
 *
 * The last of them is the blank line a joined fixture leaves behind its final EOL
 * -- a blank line is a body line like any other here, so it is counted rather than
 * skipped.  Derived instead of hard-coded because a fixture is edited far more
 * often than this rule is, and an off-by-one would look like a parser bug.
 */
const storyBodyCount = (lines) => {
  const split = lines.indexOf("---");
  return split === -1 ? lines.length : lines.length - split;
};

/*
 * The fixtures below are shapes taken from the real corpus, not invented: a
 * `when:always` header with no space, `=>Speaker:` with an arrow, a dialogue line
 * whose tag run ends in a space, and an inline `<<if ...>>` all occur in `Mods/`.
 */
const NODE_A_LINES = [
  "title: Morning",
  "subtitle: kitchen",
  "when:always",
  "tags:#hub #reach",
  "---",
  "// 开场",
  "Aistalt: 早。 #state:Idle #line:07c13ab ",
  "    MaoGirl: 嗯。",
  "=>Nerd: 看这个。",
  "Aistalt: 小心。<<if Tech()>=1>> #Tech #line:0123abc",
  "  其他: [strong]重要[/strong]。[excite]哈[/excite]",
  "<<set $X = false>> // 解释",
  "-> 追问",
  "    -> 再问 #line:0abc123",
];

const NODE_A = storyFixture(NODE_A_LINES);

const NODE_B = storyFixture([
  "title: Night",
  "when: always",
  "---",
  "#line:09f0e1d",
  "   ",
  "Aistalt: 睡吧。",
]);

test("story: an LF file with one node is the text it came from, byte for byte", () => {
  assert.equal(serializeStory(parseStory(NODE_A)), NODE_A);
});

test("story: a CRLF file keeps its CRLF -- 2 of the 211 real files are", () => {
  const text = storyFixture(["title: A", "---", "A: x #line:0000001"], "\r\n");
  assert.equal(serializeStory(parseStory(text)), text);
});

test("story: a file with no newline at the end gets none back", () => {
  const text = storyFixture(["title: A", "---", "A: x"], "\n", false);
  assert.equal(serializeStory(parseStory(text)), text);
  assert.equal(parseStory(text).trailingNewline, false, "and the parse says so");
});

test("story: a BOM is kept, and is not mistaken for the first character of a title", () => {
  const text = `\uFEFF${NODE_A}`;
  const story = parseStory(text);
  assert.equal(story.bom, "\uFEFF");
  assert.equal(story.nodes[0].title, "Morning", "the BOM is not part of the header line");
  assert.equal(serializeStory(story), text);
});

test("story: an empty string parses to nothing and prints nothing", () => {
  const story = parseStory("");
  assert.deepEqual(story.nodes, []);
  assert.equal(story.trailingNewline, false);
  assert.equal(serializeStory(story), "");
  assert.equal(parseStory("").lines.length, 0);
});

test("story: a file of nothing but comments is all body, and round-trips", () => {
  const text = storyFixture(["// 一", "// 二", "// 三"]);
  const story = parseStory(text);
  assert.equal(story.nodes.length, 1, "there is no `===`, so the whole file is one node");
  assert.equal(serializeStory(story), text);
  assert.deepEqual(storyLines(story.nodes[0]).map((line) => line.kind), ["comment", "comment", "comment"]);
});

test("story: a node with no `---` keeps its `key:` lines and everything after is body", () => {
  const text = storyFixture(["title: A", "when:always", "Aistalt: 你好。 #line:0a1b2c3"]);
  const story = parseStory(text);
  assert.deepEqual(story.nodes[0].headerLines, ["title: A", "when:always"]);
  assert.equal(story.nodes[0].title, "A");
  assert.equal(story.nodes[0].when, "always");
  assert.deepEqual(storyLines(story.nodes[0]).map((line) => line.kind), ["dialogue"]);
  assert.equal(serializeStory(story), text);
});

test("story: `when:always` and `when: always` are the same header, and both survive", () => {
  const tight = parseStory(storyFixture(["title: A", "when:always", "---", "x"]));
  const loose = parseStory(storyFixture(["title: A", "when: always", "---", "x"]));
  assert.equal(tight.nodes[0].when, "always");
  assert.equal(loose.nodes[0].when, "always");
  assert.equal(serializeStory(tight), storyFixture(["title: A", "when:always", "---", "x"]));
  assert.equal(serializeStory(loose), storyFixture(["title: A", "when: always", "---", "x"]));
});

test("story: a two-node file keeps the `===` and the blank lines around it exactly once", () => {
  const text = `${NODE_A}\n===\n\n${NODE_B}`;
  const story = parseStory(text);
  assert.equal(story.nodes.length, 2);
  assert.deepEqual(story.nodes[1].separator.lines, ["===", ""], "the gap hangs on the node that follows it");
  assert.equal(serializeStory(story), text);
});

test("story: a trailing `===` with no node after it is kept, not dropped", () => {
  const text = storyFixture(["title: A", "---", "x", "===", ""]);
  const story = parseStory(text);
  assert.equal(story.nodes.length, 1);
  assert.deepEqual(story.post, ["===", ""]);
  assert.equal(serializeStory(story), text);
});

test("story: leading blank lines belong to the first node and come back in front of it", () => {
  const text = storyFixture(["", "", "title: A", "---", "x"]);
  const story = parseStory(text);
  assert.deepEqual(story.nodes[0].separator.lines, ["", ""]);
  assert.equal(story.nodes[0].startLine, 3, "the node's own text starts at file line 3");
  assert.equal(serializeStory(story), text);
});

test("story: `===` and `---` are recognised through surrounding whitespace", () => {
  const text = storyFixture(["title: A", "  ---  ", "x", " ===", "title: B", "---", "y"]);
  const story = parseStory(text);
  assert.equal(story.nodes.length, 2, "a padded ` ===` still separates two nodes");
  assert.equal(serializeStory(story), text, "and comes back with its padding");
});

test("story: an indented speaker and a `=>` speaker are both dialogue", () => {
  // Index 0 is the `// 开场` comment, so the speakers below sit one line later
  // than they read in the fixture.
  const lines = storyLines(parseStory(NODE_A).nodes[0]);
  const plain = lines[1];
  const indented = lines[2];
  const arrow = lines[3];
  assert.equal(plain.kind, "dialogue");
  assert.equal(plain.indent, "");
  assert.equal(plain.speaker, "Aistalt");
  assert.equal(plain.text, "早。");
  assert.equal(indented.kind, "dialogue");
  assert.equal(indented.indent, "    ", "the indent is kept, so an edit cannot lose it");
  assert.equal(indented.speaker, "MaoGirl");
  assert.equal(arrow.kind, "dialogue");
  assert.equal(arrow.speaker, "Nerd");
  assert.equal(arrow.raw, "=>Nerd: 看这个。");
});

test("story: a speaker name that is not ASCII is still a speaker", () => {
  const line = storyLines(parseStory(NODE_A).nodes[0])[5];
  assert.equal(line.kind, "dialogue");
  assert.equal(line.speaker, "其他");
  assert.equal(line.text, "[strong]重要[/strong]。[excite]哈[/excite]");
});

test("story: a colon in running text is not a speaker", () => {
  const text = storyFixture(["title: A", "---", "他说: 你好", "note to self: buy milk"]);
  const lines = storyLines(parseStory(text).nodes[0]);
  assert.equal(lines[0].kind, "dialogue", "one name-shaped word before the colon is a speaker, even in CJK");
  assert.equal(lines[1].kind, "other", "a space in front of the colon means this is narration, not a speaker");
  assert.equal(lines[1].speaker, null);
  assert.equal(serializeStory(parseStory(text)), text);
});

test("story: a trailing `#state:`/`#line:` run is read without being moved", () => {
  const line = storyLines(parseStory(NODE_A).nodes[0])[1];
  assert.equal(line.id, "07c13ab");
  assert.equal(line.state, "Idle");
  assert.deepEqual(line.tags, ["#state:Idle", "#line:07c13ab"]);
  assert.equal(line.raw, "Aistalt: 早。 #state:Idle #line:07c13ab ", "the space after the id is part of the line");
  assert.equal(line.text, "早。", "and the text stops before the run");
});

test("story: a line ending in `#line:... ` keeps its trailing space through a round trip", () => {
  const text = storyFixture(["title: A", "---", "A: 你好。 #state:Idle #line:07c13ab "]);
  assert.equal(serializeStory(parseStory(text)), text);
  assert.ok(serializeStory(parseStory(text)).endsWith("#line:07c13ab \n"));
});

test("story: the whole tag run is read, not just its last token", () => {
  const line = storyLines(parseStory(NODE_A).nodes[0])[1];
  assert.deepEqual(line.tags, ["#state:Idle", "#line:07c13ab"], "`#state:` is a tag, not text");
  assert.equal(line.state, "Idle");
});

test("story: inline markup and an inline `<<if>>` stay inside the text", () => {
  const lines = storyLines(parseStory(NODE_A).nodes[0]);
  const inline = lines[4];
  assert.equal(inline.kind, "dialogue");
  assert.equal(inline.text, "小心。<<if Tech()>=1>>");
  assert.deepEqual(inline.tags, ["#Tech", "#line:0123abc"]);
  assert.equal(inline.id, "0123abc");
  assert.equal(lines[5].text, "[strong]重要[/strong]。[excite]哈[/excite]");
  assert.equal(lines[5].speaker, "其他");
});

test("story: a `<<set ...>> // comment` line is a command with its comment split out", () => {
  const line = storyLines(parseStory(NODE_A).nodes[0])[6];
  assert.equal(line.kind, "command");
  assert.equal(line.command, "<<set $X = false>>");
  assert.equal(line.comment, "解释");
  assert.equal(line.raw, "<<set $X = false>> // 解释");
});

test("story: an `-> ` line is an option, indented or not, with its own tag run", () => {
  const lines = storyLines(parseStory(NODE_A).nodes[0]);
  assert.equal(lines[7].kind, "option");
  assert.equal(lines[7].text, "追问");
  assert.equal(lines[8].kind, "option");
  assert.equal(lines[8].indent, "    ");
  assert.equal(lines[8].id, "0abc123");
  assert.equal(lines[8].text, "再问");
});

/* ------------------------------------------------------------------ */
/* the shapes the first pass at the classifier filed as `other`         */
/* ------------------------------------------------------------------ */

test("story: an option written tight against its arrow is still an option", () => {
  // Measured, not invented: 1,046 of the real corpus's option lines look like
  // this, and a lookahead that wanted a space filed every one of them as `other`.
  const text = storyFixture(["title: A", "---", "->49年？<<once>> #line:0749555 ", "    ->不。"]);
  const lines = storyLines(parseStory(text).nodes[0]);
  assert.equal(lines[0].kind, "option", "no space between `->` and the text");
  assert.equal(lines[0].text, "49年？<<once>>");
  assert.equal(lines[0].id, "0749555");
  assert.equal(lines[1].kind, "option");
  assert.equal(lines[1].indent, "    ");
  assert.equal(serializeStory(parseStory(text)), text, "and the tight arrow comes back tight");
});

test("story: `=> Name:` with a space after the arrow is dialogue", () => {
  const raw = "    => Aistalt: 那么预言……<<once if $Terrorist_EatAnotherSpicy == true>> #line:054b614 ";
  const text = storyFixture(["title: A", "---", raw]);
  const line = storyLines(parseStory(text).nodes[0])[0];
  assert.equal(line.kind, "dialogue", "the space belongs to the arrow, not to the name");
  assert.equal(line.indent, "    ");
  assert.equal(line.speaker, "Aistalt");
  assert.equal(line.id, "054b614");
  assert.equal(serializeStory(parseStory(text)), text);
});

test("story: a bare `->` with nothing after it is body text, not an empty option", () => {
  const text = storyFixture(["title: A", "---", "->"]);
  const line = storyLines(parseStory(text).nodes[0])[0];
  assert.equal(line.kind, "other", "there is no option text to show, so no option is claimed");
  assert.equal(serializeStory(parseStory(text)), text, "and it is written back as it was");
});

test("story: a line that is only a `#`-run is its own kind", () => {
  const text = storyFixture(["title: A", "---", "#Tech #line:04d5e6f"]);
  const line = storyLines(parseStory(text).nodes[0])[0];
  assert.equal(line.kind, "hashtag");
  assert.equal(line.id, "04d5e6f");
  assert.deepEqual(line.tags, ["#Tech", "#line:04d5e6f"]);
  assert.equal(serializeStory(parseStory(text)), text);
});

test("story: every line kind the classifier can produce is in the frozen list", () => {
  const kinds = new Set();
  kinds.add(storyLines(parseStory(NODE_A).nodes[0])[0].kind);
  kinds.add(storyLines(parseStory(storyFixture(["// c"])).nodes[0])[0].kind);
  for (const line of storyLines(parseStory(NODE_A).nodes[0])) {
    kinds.add(line.kind);
  }
  for (const kind of kinds) {
    assert.ok(STORY_LINE_KINDS.indexOf(kind) !== -1, `${kind} is a listed kind`);
  }
  assert.ok(Object.isFrozen(STORY_LINE_KINDS), "the list is frozen: a caller cannot add a kind");
  assert.ok(STORY_LINE_KINDS.indexOf("other") !== -1, "`other` exists so no line is ever unrepresentable");
});

test("story: a body line no rule fits is `other`, and is still written back untouched", () => {
  const text = storyFixture(["title: A", "---", "$$$ not yarn $$$"]);
  const line = storyLines(parseStory(text).nodes[0])[0];
  assert.equal(line.kind, "other");
  assert.equal(line.raw, "$$$ not yarn $$$");
  assert.equal(serializeStory(parseStory(text)), text);
});

test("story: a blank line made of spaces keeps those spaces", () => {
  const text = storyFixture(["title: A", "---", "   ", "\t"]);
  const lines = storyLines(parseStory(text).nodes[0]);
  assert.deepEqual(lines.map((line) => line.kind), ["blank", "blank"]);
  assert.equal(serializeStory(parseStory(text)), text);
});

test("story: editing a speaker keeps the `#line:` id and every other line raw", () => {
  const story = parseStory(NODE_A);
  const node = story.nodes[0];
  const before = storyLines(node).map((line) => line.raw);
  const changed = setLineSpeaker(node, 1, "Company");
  assert.equal(changed.speaker, "Company");
  const out = serializeStory(story);
  assert.ok(out.includes("Company: 早。 #state:Idle #line:07c13ab "), "the id and the run stay put");
  assert.ok(!out.includes("Aistalt: 早。"), "the old speaker is gone");
  assert.ok(out.includes("=>Nerd: 看这个。"), "the arrow line is untouched");
  assert.ok(out.includes("    MaoGirl: 嗯。"), "so is the indented one");
  const after = storyLines(story.nodes[0]).map((line) => line.raw);
  assert.deepEqual(after.slice(2), before.slice(2), "no other line moved");
});

test("story: editing a speaker keeps the indent and the `=>`", () => {
  const story = parseStory(NODE_A);
  const node = story.nodes[0];
  assert.equal(setLineSpeaker(node, 2, "Cop").raw, "    Cop: 嗯。");
  assert.equal(setLineSpeaker(node, 3, "Aistalt").raw, "=>Aistalt: 看这个。");
});

test("story: editing text rewrites only the span between the colon and the tag run", () => {
  const story = parseStory(NODE_A);
  const node = story.nodes[0];
  const changed = setLineText(node, 1, "新的台词");
  assert.equal(changed.text, "新的台词");
  const out = serializeStory(story);
  assert.ok(out.includes("Aistalt: 新的台词 #state:Idle #line:07c13ab "), "speaker, tags and trailing space all kept");
  assert.ok(out.includes("=>Nerd: 看这个。"), "and the neighbouring lines are their raw text");
});

test("story: editing a line that is not dialogue changes nothing and says so", () => {
  const story = parseStory(NODE_A);
  const node = story.nodes[0];
  assert.equal(setLineText(node, 0, "x"), null, "a comment has no text span to rewrite");
  assert.equal(setLineSpeaker(node, 0, "x"), null);
  assert.equal(setLineText(node, 999, "x"), null, "an index off the end is not a line");
  assert.equal(serializeStory(story), NODE_A, "and the file is exactly what it was");
});

test("story: a fresh id is seven lowercase hex digits and is never one of `taken`", () => {
  const taken = new Set();
  for (let step = 0; step < 500; step += 1) {
    const id = nextLineId(taken);
    assert.match(id, /^[0-9a-f]{7}$/);
    assert.equal(taken.has(id), false, `${id} is fresh`);
    taken.add(id);
  }
  assert.equal(taken.size, 500, "500 draws, 500 distinct ids");
});

test("story: `nextLineId` steps past a taken id instead of rejecting the draw", () => {
  const first = nextLineId([]);
  assert.notEqual(nextLineId([first]), first, "the id that was just handed out is not handed out again");
  assert.match(nextLineId(new Set([first])), /^[0-9a-f]{7}$/);
});

test("story: `nextLineId` is deterministic -- the same taken set gives the same id", () => {
  const taken = ["07c13ab", "0123abc", "0abc123"];
  assert.equal(nextLineId(taken), nextLineId(taken));
  assert.equal(nextLineId(new Set(taken)), nextLineId(taken), "a Set and an array of the same ids agree");
  assert.notEqual(nextLineId(taken), nextLineId([]), "and a different taken set is a different starting point");
});

test("story: `LINE_ID` reads the marker wherever it sits on the line", () => {
  assert.equal(lineIdOf("A: 你好。 #line:07c13ab"), "07c13ab");
  assert.equal(lineIdOf("-> 再问 #line:0abc123"), "0abc123");
  assert.equal(lineIdOf("<<set $X = 1>> #line:0f0f0f0"), "0f0f0f0");
  assert.equal(lineIdOf("A: 没有标记。"), null);
  assert.equal(lineIdOf(""), null);
  assert.equal(lineIdOf(null), null);
  assert.ok(LINE_ID.test("A: x #line:07c13ab"), "the exported pattern matches a real marker");
  assert.equal(lineIdOf("#line:07c13ab").length, 7, "the corpus writes exactly seven characters");
});

test("story: `storyNodes` is one entry per node, with the header fields a list draws", () => {
  const story = parseStory(`${NODE_A}\n===\n${NODE_B}`);
  const nodes = storyNodes(story);
  assert.equal(nodes.length, 2);
  assert.deepEqual(nodes[0], {
    index: 0,
    title: "Morning",
    subtitle: "kitchen",
    when: "always",
    tags: ["#hub", "#reach"],
    lineCount: storyBodyCount(NODE_A_LINES),
    startLine: 1,
  });
  assert.deepEqual(nodes[1].title, "Night");
  assert.equal(nodes[1].when, "always");
  assert.deepEqual(nodes[1].tags, [], "a node with no `tags:` header has an empty list, not null");
});

test("story: `storyLines` gives every field, with nulls where a kind has none", () => {
  const node = parseStory(NODE_A).nodes[0];
  for (const line of storyLines(node)) {
    assert.equal(typeof line.kind, "string");
    assert.equal(typeof line.raw, "string");
    assert.equal(typeof line.indent, "string");
    assert.ok(Array.isArray(line.tags));
    assert.ok(line.speaker === null || typeof line.speaker === "string");
    assert.ok(line.text === null || typeof line.text === "string");
    assert.ok(line.id === null || typeof line.id === "string");
    assert.ok(line.state === null || typeof line.state === "string");
    assert.ok(line.command === null || typeof line.command === "string");
    assert.ok(line.comment === null || typeof line.comment === "string");
    assert.ok(JSON.stringify(line).length > 0, "an entry survives JSON.stringify");
    assert.equal(Object.prototype.hasOwnProperty.call(line, "edit"), false, "the dirty mark is not a field a caller sees");
  }
});

test("story: a parse of a serialize of a parse is structurally the same story", () => {
  const first = parseStory(`${NODE_A}\n===\n${NODE_B}`);
  const second = parseStory(serializeStory(first));
  assert.equal(serializeStory(second), serializeStory(first));
  assert.equal(second.nodes.length, first.nodes.length);
  assert.equal(second.eol, first.eol);
  assert.equal(second.trailingNewline, first.trailingNewline);
  assert.equal(second.bom, first.bom);
  assert.deepEqual(second.post, first.post);
  for (let at = 0; at < first.nodes.length; at += 1) {
    const left = first.nodes[at];
    const right = second.nodes[at];
    assert.deepEqual(right.separator.lines, left.separator.lines);
    assert.deepEqual(right.headerLines, left.headerLines);
    assert.deepEqual(right.rawBodyLines, left.rawBodyLines);
    assert.equal(right.title, left.title);
    assert.equal(right.when, left.when);
    assert.deepEqual(storyLines(right), storyLines(left), `node ${at} lists the same lines`);
  }
});

test("story: an edit is idempotent -- serializing twice does not rewrite the line again", () => {
  const story = parseStory(NODE_A);
  setLineSpeaker(story.nodes[0], 1, "Company");
  const once = serializeStory(story);
  assert.equal(serializeStory(story), once, "a second serialize is the same text");
  assert.equal(serializeStory(parseStory(once)), once, "and so is a parse and serialize of that text");
});

test("story: `storyAbout` names what was parsed in one line", () => {
  const one = storyAbout(parseStory(NODE_A));
  assert.ok(one.startsWith("yarn story: 1 node, "), one);
  const crlf = storyAbout(parseStory(storyFixture(["title: A", "---", "x"], "\r\n")));
  assert.ok(crlf.includes("CRLF line endings"), crlf);
  const bom = storyAbout(parseStory(`\uFEFF${NODE_A}`));
  assert.ok(bom.includes("a BOM, "), bom);
  const noTail = storyAbout(parseStory(storyFixture(["title: A", "---", "x"], "\n", false)));
  assert.ok(noTail.includes("no newline at the end"), noTail);
  assert.equal(storyAbout(null), "yarn story: nothing was parsed");
});

test("story: the module is pure -- no DOM, no imports, no clock", () => {
  const source = readFileSync(new URL("./story.mjs", import.meta.url), "utf8");
  /*
   * The prose is removed before the grep, and the grep would be wrong without
   * that: the module *documents* that its ids do not come from `Math.random`
   * and calls the file it parses "the document", so reading the raw text finds
   * both words in the sentences that promise the opposite.  What is checked is
   * the code.  (`readFileSync`, not `readFile`: this check has to be counted
   * before the summary at the bottom of this file runs, and a promise settles
   * after it, so a failure here would be reported too late to be seen.)
   */
  const code = source.replace(/\/\*[\s\S]*?\*\//g, " ");
  assert.equal(/^\s*import\s/m.test(code), false, "no imports at all");
  assert.equal(/\bwindow\b|\bdocument\b|\blocalStorage\b/.test(code), false, "no DOM");
  assert.equal(/Math\.random|Date\.now|new Date\(/.test(code), false, "no clock, no randomness");
});

/* ------------------------------------------------------------------ */
/* translation tables                                                  */
/* ------------------------------------------------------------------ */

const CSV_HEAD = `${CSV_BOM}${CSV_COLUMNS.join(",")}\r\n`;

test("storycsv: a quoted row survives a round trip, byte for byte", () => {
  const text =
    CSV_HEAD +
    `en,line:07c13ab,"Aistalt: It means ""the storm is coming."", see?",E:\\tales\\a.yarn,Node,16,43ac4d62,\r\n`;
  const table = parseCsv(text);
  assert.equal(table.rows[0].text, 'Aistalt: It means "the storm is coming.", see?');
  assert.equal(table.rows[0].fieldCount, 8);
  assert.equal(serializeCsv(table), text);
});

test("storycsv: the byte order mark and the line ending are reported, not normalised", () => {
  const crlf = parseCsv(CSV_HEAD + "en,line:a,Hi,f,Node,1,00000000,\r\n");
  assert.equal(crlf.bom, true);
  assert.equal(crlf.eol, "\r\n");
  const lf = parseCsv("a,b\n1,2\n");
  assert.equal(lf.bom, false);
  assert.equal(lf.eol, "\n");
  assert.equal(serializeCsv(lf), "a,b\n1,2\n");
});

test("storycsv: a file with no trailing newline gets none back", () => {
  const text = "a,b\n1,2";
  assert.equal(serializeCsv(parseCsv(text)), text);
});

test("storycsv: a header-only table keeps its one line ending", () => {
  const text = `${CSV_HEAD}`;
  assert.equal(serializeCsv(parseCsv(text)), text);
  assert.equal(parseCsv(text).rows.length, 0);
});

test("storycsv: its SHA-256 agrees with the platform's, including the padding edges", () => {
  const hex = (text) => createHash("sha256").update(text, "utf8").digest("hex").slice(0, 8);
  const cases = ["", "a", "abc", "\u4f60\u597d", "\u{1F600}", "x".repeat(55), "x".repeat(56), "x".repeat(57), "x".repeat(64), "x".repeat(119), "x".repeat(120)];
  for (const text of cases) {
    assert.equal(lockOf(text), hex(text), `len=${text.length}`);
  }
  assert.equal(lockOf(""), "e3b0c442");
  assert.equal(lockOf("abc"), "ba7816bf");
});

test("storycsv: the lock is the first four bytes in big-endian order", () => {
  const digest = createHash("sha256").update("Hello", "utf8").digest();
  assert.equal(lockOf("Hello"), digest.subarray(0, 4).toString("hex"));
  assert.notEqual(lockOf("Hello"), digest.subarray(0, 4).reverse().toString("hex"));
});

test("storycsv: line ids normalise, and a non-hex id is not an id", () => {
  assert.equal(csvLineIdOf("line:07C13AB"), "07c13ab");
  assert.equal(idOfLine("07C13AB"), "line:07c13ab");
  assert.equal(csvLineIdOf("line:e4f5g6h"), null);
  assert.equal(csvLineIdOf("nope"), null);
  assert.notEqual(csvLineIdOf, lineIdOf, "this is not story.mjs's lineIdOf");
});

test("storycsv: line metadata splits into tags and a state", () => {
  const meta = metadataOf("Line metadata: Tech state:Funny");
  assert.deepEqual(meta.tags, ["Tech"]);
  assert.equal(meta.state, "Funny");
  assert.equal(metadataOf("Line metadata: state:Idle").state, "Idle");
  assert.deepEqual(metadataOf("").tags, []);
  assert.equal(metadataOf("").state, "");
});

test("storycsv: speakers come back in first-seen order, and a tight colon is not one", () => {
  const wide = parseCsv(
    "language,id,text,file,node,lineNumber,lock,comment\n" +
      "en,line:a,Aistalt: \u55e8\u3002,f,Node,1,00000000,\n" +
      "en,line:b,NoBody: \u4ec0\u4e48\uff1f,f,Node,2,00000000,\n" +
      "en,line:c,Aistalt: \u53c8\u89c1\u9762\u4e86\u3002,f,Node,3,00000000,\n",
  );
  assert.deepEqual(speakersOf(wide.rows), ["Aistalt", "NoBody"]);
  const tight = parseCsv("h\nen,line:d,Aistalt:\u76d1\u7763\uff0c\u5373\u4fbf,f,Node,4,00000000,\n");
  assert.deepEqual(speakersOf(tight.rows), []);
});

test("storycsv: comparison finds stale, untranslated, missing and orphan rows", () => {
  const head = "language,id,text,file,node,lineNumber,lock,comment\n";
  const source = parseCsv(
    head + `en,line:a,Hello,f,Node,1,${lockOf("Hello")},\n` + `en,line:b,World,f,Node,2,${lockOf("World")},\n`,
  );
  const current = compareTables(
    source,
    parseCsv(
      head +
        `ja,line:a,\u4f60\u597d,f,Node,1,${lockOf("Hello")},\n` +
        `ja,line:b,World,f,Node,2,${lockOf("World")},\n` +
        `ja,line:z,Orphan,f,Node,9,${lockOf("Orphan")},\n`,
    ),
  );
  assert.equal(current.translated, 2);
  assert.deepEqual(current.untranslated.map((row) => row.id), ["line:b"]);
  assert.deepEqual(current.missing, []);
  assert.deepEqual(current.orphan.map((row) => row.id), ["line:z"]);
  assert.deepEqual(current.stale, []);
  assert.equal(current.total, 2);
  assert.equal(current.language, "ja");

  const aged = compareTables(
    source,
    parseCsv(head + `ja,line:a,\u4f60\u597d,f,Node,1,deadbeef,\n`),
  );
  assert.equal(aged.stale.length, 1);
  assert.equal(aged.stale[0].id, "line:a");
  assert.equal(aged.stale[0].was, "deadbeef");
  assert.equal(aged.stale[0].now, lockOf("Hello"));
  assert.deepEqual(aged.missing.map((row) => row.id), ["line:b"]);

  const noLock = compareTables(
    source,
    parseCsv(head + `ja,line:a,\u4f60\u597d,f,Node,1,,\n`),
  );
  assert.deepEqual(noLock.stale, [], "a row with no lock is not called stale");
  assert.equal(noLock.untranslated.length, 0);
});

test("storycsv: editing a column rewrites that row and nothing else", () => {
  const text =
    "language,id,text,file,node,lineNumber,lock,comment\n" +
    `ja,line:a,\u4f60\u597d,f,Node,1,${lockOf("Hello")},\n` +
    `ja,line:b,World,f,Node,2,${lockOf("World")},\n`;
  const table = parseCsv(text);
  setColumn(table.rows[0], "text", "\u4f60\u597d, \u4e16\u754c");
  const lines = serializeCsv(table).split("\n");
  assert.equal(lines[0], text.split("\n")[0]);
  assert.equal(lines[1], `ja,line:a,"\u4f60\u597d, \u4e16\u754c",f,Node,1,${lockOf("Hello")},`);
  assert.equal(lines[2], text.split("\n")[2]);
  assert.throws(() => setColumn(table.rows[0], "nope", "x"), /unknown column/);
  assert.equal(looksLikeLock("deadbeef"), true);
  assert.equal(looksLikeLock("not a lock"), false);
});

test("storycsv: one row's verdict is the same one the summary counts", () => {
  const source = {
    id: "line:a",
    text: "Hello",
    fields: ["en", "line:a", "Hello", "f", "Node", "1", "00000000", ""],
  };
  assert.equal(rowState(source, null), "missing");
  assert.equal(rowState(source, { text: "\u4f60\u597d", lock: lockOf("Hello") }), "ok");
  assert.equal(rowState(source, { text: "Hello", lock: lockOf("Hello") }), "untranslated");
  assert.equal(rowState(source, { text: "\u4f60\u597d", lock: "deadbeef" }), "stale");
  assert.equal(rowState(source, { text: "\u4f60\u597d", lock: "" }), "ok", "no lock is not staleness");
  assert.equal(rowState(source, { text: "\u4f60\u597d", lock: "DEADBEEF" }), "stale", "the lock compares case-insensitively");

  const table = parseCsv("language,id,text,file,node,lineNumber,lock,comment\nja,line:a,\u4f60\u597d,f,Node,1,deadbeef,\n");
  const byId = rowsById(table);
  assert.equal(byId.get("line:a").text, "\u4f60\u597d");
  assert.equal(byId.get("line:b"), undefined);
  assert.equal(rowState(source, byId.get("line:a")), "stale");
});

test("storycsv: a row with an unexpected field count is reported, not silently accepted", () => {
  const table = parseCsv("language,id,text,file,node,lineNumber,lock,comment\nen,line:a,Hello,f\n");
  assert.equal(table.odd.length, 1);
  assert.equal(table.odd[0].fields, 4);
  assert.equal(table.rows.length, 1);
  assert.equal(table.rows[0].fieldCount, 4);
  assert.equal(table.rows[0].comment, "");
});

test("storycsv: the metadata table's five columns and LF endings are kept", () => {
  const text = "id,file,node,lineNumber,metadata\nline:a,E:\\a.yarn,Node,3,state:Happy\n";
  const table = parseCsv(text);
  assert.deepEqual(table.odd, []);
  assert.equal(table.eol, "\n");
  assert.equal(table.rows[0].fieldCount, 5);
  /*
   * The fifth field is `metadata` to the game and the fourth is `lineNumber`,
   * so under the eight names this module knows they land in `node` and `lock`.
   * That mismatch is why a rewrite writes `row.fields` back rather than the
   * named columns, and why this table still round-trips exactly.
   */
  assert.equal(table.rows[0].node, "state:Happy");
  assert.equal(table.rows[0].lock, "");
  assert.equal(serializeCsv(table), text);
});

test("storycsv: the module imports nothing, reads no clock and touches no DOM", () => {
  /*
   * Read synchronously: the summary below runs at module load, so a bare
   * `testAsync` here would record its failure after the `ok N/N` line -- or
   * escape as an unhandled rejection and take the whole summary with it.
   */
  const code = readFileSync(new URL("./storycsv.mjs", import.meta.url), "utf8");
  assert.equal(/^\s*import\b/m.test(code), false, "no imports");
  assert.equal(/\bwindow\b|\bdocument\b|\blocalStorage\b/.test(code), false, "no DOM");
  assert.equal(/Math\.random|Date\.now|new Date\(/.test(code), false, "no clock, no randomness");
});

/* ------------------------------------------------------------------ */
/* a line the story gains is a row the table owes                      */
/* ------------------------------------------------------------------ */

const ADD_TABLE = [
  "language,id,text,file,node,lineNumber,lock,comment",
  "en,line:1111111,Aistalt: Hi.,E:\\UnityProject\\Infant God\\Assets\\YarnScripts\\Logic\\1.Welcome.yarn,Welcome_Node,19,072a7a30,",
  "en,line:2222222,Aistalt: Bye.,E:\\UnityProject\\Infant God\\Assets\\YarnScripts\\Logic\\1.Welcome.yarn,Welcome_Node,23,deadbeef,",
].join("\r\n") + "\r\n";

const ADD_STORY = [
  "title: Welcome_Node",
  "tags: hub",
  "---",
  "Aistalt: Hi. #line:1111111",
  "Aistalt: Bye. #line:2222222",
  "===",
  "",
].join("\n");

/** The story with one line added after its first, re-read the way the card does. */
function withAddedLine() {
  const story = parseStory(ADD_STORY);
  storyAddLine(story, 0, 1, "And again.");
  return parseStory(serializeStory(story));
}

test("story card: a new line is given an id no line had, and moves no other id", () => {
  const before = storyLineIds(parseStory(ADD_STORY));
  const after = storyLineIds(withAddedLine());
  assert.equal(before.length, 2);
  assert.equal(after.length, 3);
  assert.deepEqual(after.slice(0, 1), before.slice(0, 1));
  assert.deepEqual(after.slice(2), before.slice(1));
  assert.equal(before.includes(after[1]), false, "the new id was already in the file");
});

test("story card: a line's words are the ones a table's `text` column holds", () => {
  const lines = storyLines(withAddedLine().nodes[0]);
  assert.equal(storyLineText(lines[1]), "Aistalt: And again.");
  /* A line with no speaker is its own words; a line with no text is empty. */
  const option = storyLines(parseStory("title: T\n---\n-> Say nothing\n===\n").nodes[0]);
  assert.equal(storyLineText(option[0]), "Say nothing");
  assert.equal(storyLineText({ speaker: null, text: null }), "");
});

test("story card: the row for a new line names the id the line was given", () => {
  const story = withAddedLine();
  const table = parseCsv(ADD_TABLE);
  const line = storyLines(story.nodes[0])[1];
  const row = storyRowForLine(story, 0, 1, table);
  assert.equal(row.id, `line:${line.id}`);
  assert.equal(row.text, "Aistalt: And again.");
  assert.equal(row.lock, lockOf(row.text));
  assert.equal(row.language, "en");
  /* The path the game writes is the author's, so it comes from the table. */
  assert.equal(row.file, table.rows[0].file);
  assert.equal(row.node, "Welcome_Node");
  assert.equal(row.lineNumber, 24, "the node's highest line number, plus one");
  assert.equal(row.comment, "");
});

test("story card: a line with no id is owed no row", () => {
  const story = parseStory("title: T\n---\nAistalt: Hi.\n===\n");
  assert.equal(storyRowForLine(story, 0, 0, parseCsv(ADD_TABLE)), null);
  assert.equal(storyRowForLine(story, 0, 0, null), null);
  assert.equal(storyRowForLine(story, 9, 0, parseCsv(ADD_TABLE)), null);
});

test("story card: the row a new line gets reads back as the row that was written", () => {
  const table = parseCsv(ADD_TABLE);
  table.rows.push(rowFor(storyRowForLine(withAddedLine(), 0, 1, table)));
  const round = parseCsv(serializeCsv(table));
  assert.equal(round.rows.length, 3);
  assert.deepEqual(round.rows[2], table.rows[2]);
  assert.equal(round.eol, "\r\n");
  assert.equal(round.bom, false);
  /* Every other row is still the bytes it was. */
  assert.deepEqual(round.rows[0].fields, parseCsv(ADD_TABLE).rows[0].fields);
});

test("story card: a fresh row reads untranslated, and stale once the line changes", () => {
  const story = withAddedLine();
  const table = parseCsv(ADD_TABLE);
  const row = rowFor(storyRowForLine(story, 0, 1, table));
  const words = () => ({ text: storyLineText(storyLines(story.nodes[0])[1]) });
  assert.equal(rowState(words(), row), "untranslated");
  assert.equal(storySetText(story, 0, 1, "And again, changed."), true);
  assert.equal(rowState(words(), row), "stale");
});

/* ------------------------------------------------------------------ */
/* the mod's own command schema                                         */
/* ------------------------------------------------------------------ */

/*
 * An inline schema, not the mod's own 87 KB one: this suite has to run in a
 * checkout that has no `Mods` directory beside it.  Every field here is one the
 * real `InfantGod-generated.ysls.json` really has -- that shape was measured over
 * the whole file before the module was written.
 */
const YSLS_FIXTURE = JSON.stringify({
  version: 2,
  commands: [
    {
      yarnName: "AddAchievement",
      definitionName: "AddAchievement",
      fileName: "Achievements.cs",
      language: "csharp",
      async: false,
      containsErrors: false,
      location: "",
      parameters: [
        { name: "achievementTechName", type: "string", isParamsArray: false, defaultValue: null },
      ],
    },
    {
      yarnName: "AddItems",
      parameters: [{ name: "items", type: "string", isParamsArray: true, defaultValue: "none" }],
    },
    { yarnName: "Broken", containsErrors: true, parameters: [] },
    { yarnName: "", parameters: [] },
  ],
  functions: [
    {
      yarnName: "HasAchievement",
      containsErrors: false,
      parameters: [{ name: "achievementTechName", type: "string" }],
      return: { type: "bool" },
    },
  ],
});

test("ysls: the schema is read as its two lists, in the file's own order", () => {
  const schema = parseYsls(YSLS_FIXTURE);
  assert.equal(schema.error, "");
  assert.equal(schema.version, 2);
  assert.equal(schema.commands.length, 4);
  assert.equal(schema.functions.length, 1);
  assert.deepEqual(schema.entries.map((entry) => entry.name),
    ["AddAchievement", "AddItems", "Broken", "", "HasAchievement"]);
  assert.equal(schema.commands[0].kind, "command");
  assert.equal(schema.functions[0].kind, "function");
  assert.equal(schema.functions[0].returnType, "bool");
  assert.equal(schema.functions[0].return === undefined, true, "no field the shell did not make");
  assert.equal(schema.commands[0].parameters[0].name, "achievementTechName");
  assert.equal(schema.commands[1].parameters[0].isParamsArray, true);
  assert.equal(schema.commands[1].parameters[0].hasDefault, true);
  assert.equal(schema.commands[1].parameters[0].defaultValue, "none");
});

test("ysls: a file that is not a schema is refused, not read as an empty one", () => {
  assert.equal(parseYsls("{ nope").error === "", false);
  assert.equal(parseYsls("[1,2]").error === "", false);
  assert.equal(parseYsls('{"hello":1}').error.includes("not a .ysls.json"), true);
  /* An empty schema is a schema: the game writes both keys, empty or not. */
  const empty = parseYsls('{"version":2,"commands":[],"functions":[]}');
  assert.equal(empty.error, "");
  assert.equal(empty.entries.length, 0);
});

test("ysls: the schema's one sentence counts both lists and the version", () => {
  assert.equal(yslsAbout(parseYsls(YSLS_FIXTURE)), "ysls: 4 commands, 1 functions, version 2");
  assert.equal(yslsAbout(parseYsls("{ nope")).startsWith("ysls: not a schema"), true);
  assert.equal(yslsAbout(null), "ysls: nothing was parsed");
});

test("ysls: a call is written the way the schema draws it", () => {
  const schema = parseYsls(YSLS_FIXTURE);
  const [add, items] = schema.commands;
  assert.equal(yslsSignature(add), "AddAchievement achievementTechName:string");
  assert.equal(yslsSignature(items), "AddItems items:string...");
  assert.equal(yslsSignature(schema.functions[0]),
    "HasAchievement(achievementTechName:string) -> bool");
});

test("ysls: what is offered starts with what was typed, and never a broken name", () => {
  const schema = parseYsls(YSLS_FIXTURE);
  const names = (prefix, limit) => completeYsls(schema, prefix, limit).map((entry) => entry.name);
  assert.deepEqual(names("Add"), ["AddAchievement", "AddItems"]);
  assert.deepEqual(names("add"), ["AddAchievement", "AddItems"], "the match ignores case");
  assert.deepEqual(names("Achieve"), ["AddAchievement", "HasAchievement"],
    "a name that contains it comes after a name that starts with it");
  assert.deepEqual(names(""), ["AddAchievement", "AddItems", "HasAchievement"],
    "an empty prefix offers the file's own order, and skips what is unusable");
  assert.deepEqual(names("Add", 1), ["AddAchievement"], "the limit is the limit");
  assert.deepEqual(names("Broken"), [], "the compiler marked it broken");
  assert.deepEqual(names("zzz"), []);
});

test("ysls: the caret is in a command's name or it is not", () => {
  assert.deepEqual(commandTypedAt("<<Add", 5), { prefix: "Add", start: 2, end: 5 });
  assert.deepEqual(commandTypedAt("Hi <<Add", 8), { prefix: "Add", start: 5, end: 8 });
  assert.deepEqual(commandTypedAt("<<Add", 4), { prefix: "Ad", start: 2, end: 4 },
    "half a name is still inside the name");
  assert.equal(commandTypedAt("<<Add and words", 15), null, "a space ends the name");
  assert.equal(commandTypedAt("<<Add>>", 7), null, "a `>` closes the command");
  assert.equal(commandTypedAt("no command here", 5), null);
  assert.equal(commandTypedAt("Hi there", 99), null, "a caret past the end is no caret");
});

test("ysls: taking a name replaces the typed part and keeps the rest", () => {
  assert.deepEqual(applyCommand("<<Add", 5, "AddAchievement"),
    { text: "<<AddAchievement", caret: 16 });
  assert.deepEqual(applyCommand("Hi <<Add>> there", 8, "AddAchievement"),
    { text: "Hi <<AddAchievement>> there", caret: 19 });
  assert.deepEqual(applyCommand("no command", 5, "AddAchievement"),
    { text: "no command", caret: 5 }, "nothing to replace, nothing replaced");
  assert.deepEqual(applyCommand("<<Add", 5, ""), { text: "<<Add", caret: 5 });
});

test("ysls: the module imports nothing, reads no clock and touches no DOM", () => {
  const code = readFileSync(new URL("./ysls.mjs", import.meta.url), "utf8");
  assert.equal(/^\s*import\b/m.test(code), false, "no imports");
  assert.equal(/\bwindow\b|\bdocument\b|\blocalStorage\b/.test(code), false, "no DOM");
  assert.equal(/Math\.random|Date\.now|new Date\(/.test(code), false, "no clock, no randomness");
});

/* ------------------------------------------------------------------ */
/* the command line, and the schema's completion in the card            */
/* ------------------------------------------------------------------ */

const COMMAND_STORY = [
  "title: T",
  "---",
  "  <<Add>>",
  "Aistalt: Hi. #line:1111111",
  "===",
  "",
].join("\n");

test("story card: a command line is edited as its command, not its indent", () => {
  /* The parser leaves `indent` empty on a command line and keeps the spaces in
     `raw`, so the indent comes off the raw line instead. */
  assert.equal(storyEditableText({ kind: "command", indent: "", raw: "  <<Add>>" }), "<<Add>>");
  assert.equal(storyEditableText({ kind: "command", indent: "", raw: "<<A>>" }), "<<A>>");
  assert.equal(storyEditableText({ kind: "dialogue", text: "Hi." }), "Hi.");
  assert.equal(storyEditableText(null), "");
  assert.equal(storyEditableText({ kind: "command" }), "", "a line with nothing in it is empty");
});

test("story card: writing a command back keeps its indent and the file's other lines", () => {
  const story = parseStory(COMMAND_STORY);
  const line = storyLines(story.nodes[0]).find((entry) => entry.kind === "command");
  assert.ok(line !== undefined, "the fixture has no command line");
  assert.equal(line.raw, "  <<Add>>");
  assert.equal(storyWriteText(story, 0, line.index, line, "<<AddAchievement>>"), true);
  const text = serializeStory(story);
  assert.equal(text.includes("  <<AddAchievement>>"), true, text);
  assert.equal(text.includes("#line:1111111"), true, "the line below is untouched");
  assert.equal(serializeStory(parseStory(text)), text, "and the file still round-trips");
  /* Writing a dialogue line through the same door edits its words, not its raw. */
  const words = storyLines(parseStory(COMMAND_STORY).nodes[0])[1];
  const dialogue = parseStory(COMMAND_STORY);
  assert.equal(storyWriteText(dialogue, 0, 1, words, "Bye."), true);
  assert.equal(serializeStory(dialogue).includes("Aistalt: Bye. #line:1111111"), true,
    serializeStory(dialogue));
});

test("story card: a `<<` in a line is completed from the schema, and prose is not", () => {
  const schema = parseYsls(YSLS_FIXTURE);
  const names = (result) => result.items.map((entry) => entry.name);
  const command = { kind: "command", indent: "", raw: "<<Add" };
  assert.deepEqual(names(storySuggestions(command, 5, schema)), ["AddAchievement", "AddItems"]);
  assert.deepEqual(storySuggestions(command, 5, null).items, [], "no schema, nothing to offer");
  assert.deepEqual(storySuggestions(null, 5, schema).items, []);
  const prose = { kind: "dialogue", text: "Hi.", tags: [] };
  assert.deepEqual(storySuggestions(prose, 3, schema).items, []);
  /* A `<<` inside dialogue is where an author writes a command, so it completes. */
  const inline = { kind: "dialogue", text: "Hi <<Add", tags: [] };
  assert.deepEqual(names(storySuggestions(inline, 13, schema)), ["AddAchievement", "AddItems"]);
  assert.equal(storySuggestions(command, 5, schema).text, "<<Add", "the text comes back too");
});

test("story card: taking a suggestion writes the name and puts the caret after it", () => {
  const command = { kind: "command", indent: "", raw: "<<Add" };
  assert.deepEqual(storyAcceptSuggestion(command, 5, "AddAchievement"),
    { text: "<<AddAchievement", caret: 16 });
  assert.deepEqual(storyAcceptSuggestion(command, 5, ""), { text: "<<Add", caret: 5 });
});

/* ------------------------------------------------------------------ */
/* a PNG is a file, and reading one is the page's own job               */
/* ------------------------------------------------------------------ */

/*
 * The fixtures were written by an independent writer
 * (`build/make_pixel_fixtures.mjs`, which deflates with the platform zlib and
 * computes its own CRCs instead of asking this module): a 4x5 RGBA image whose
 * five rows use filter types 0..4 in turn, the same image deflated into stored
 * blocks, a 2x1 RGB image with no alpha channel, and one real 6x3 export out of
 * the mod corpus. A decoder that inherited this module's bugs cannot have
 * inherited the fixtures too.
 */
const PNG_FILTERED = "iVBORw0KGgoAAAANSUhEUgAAAAQAAAAFCAYAAABirU3bAAAAPElEQVR42mNgYGD4b8Mq+K2CS+ntFn7jJ4zcRuLfbFgFv8MwE7eR+HdkzCyWopenIiPyHYZZwDKsgnAMAEvvGZivNw1JAAAAAElFTkSuQmCC";
const PNG_STORED = "iVBORw0KGgoAAAANSUhEUgAAAAQAAAAFCAYAAABirU3bAAAAYElEQVR4AQFVAKr/AAAAAP88BRH2eAoi7bQPM+QBCzIX9jwFEfc8BRH3PAUR9wILMhf3CzIX9wsyF/cLMhf3AxZkLm4kHBT3JBwU9yQcFPcECzIX9wsFEfcLBRH3CwUR90vvGZjdUsDJAAAAAElFTkSuQmCC";
const PNG_RGB = "iVBORw0KGgoAAAANSUhEUgAAAAIAAAABCAIAAAB7QOjdAAAAD0lEQVR42mPgEpE7MS0FAAUHAf+/Bwq6AAAAAElFTkSuQmCC";
const PNG_CORPUS = "iVBORw0KGgoAAAANSUhEUgAAAAYAAAADCAYAAACwAX77AAAAFUlEQVR4XmNgwAfq49L/w2gYGycAAPfpBspw35zwAAAAAElFTkSuQmCC";

const pngBytes = (base64) => new Uint8Array(Buffer.from(base64, "base64"));

/* What went into PNG_FILTERED, worked out here from the formula the fixture
   writer used. The numbers come from the arithmetic, not from the module, so a
   decoder that is merely self-consistent still fails this. */
function pngFilteredPixels() {
  const expected = new Uint8Array(4 * 5 * 4);
  for (let y = 0; y < 5; y += 1) {
    for (let x = 0; x < 4; x += 1) {
      const at = (y * 4 + x) * 4;
      expected[at] = (x * 60 + y * 11) % 256;
      expected[at + 1] = (x * 5 + y * 50) % 256;
      expected[at + 2] = (x * 17 + y * 23) % 256;
      expected[at + 3] = 255 - (x + y) * 9;
    }
  }
  return expected;
}

const PNG_CRC_TABLE = (() => {
  const table = new Int32Array(256);
  for (let n = 0; n < 256; n += 1) {
    let c = n;
    for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c;
  }
  return table;
})();

function pngCrc32(bytes) {
  let c = 0xffffffff;
  for (const byte of bytes) c = PNG_CRC_TABLE[(c ^ byte) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

test("pixelpng: the module imports nothing, reads no clock and touches no DOM", () => {
  const code = readFileSync(new URL("./pixelpng.mjs", import.meta.url), "utf8");
  assert.equal(/^\s*import\b/m.test(code), false, "no imports");
  assert.equal(/\bwindow\b|\bdocument\b|\blocalStorage\b/.test(code), false, "no DOM");
  assert.equal(/Math\.random|Date\.now|new Date\(/.test(code), false, "no clock, no randomness");
});

test("pixelpng: a blank image is the size asked for, and transparent", () => {
  const blank = blankImage(3, 2);
  assert.equal(blank.width, 3);
  assert.equal(blank.height, 2);
  assert.equal(blank.pixels.length, 24, "three by two, four channels each");
  assert.equal(blank.pixels.every((byte) => byte === 0), true);
  const red = blankImage(2, 1, [255, 0, 0, 255]);
  assert.deepEqual(pixelAt(red, 0, 0), [255, 0, 0, 255]);
  assert.deepEqual(pixelAt(red, 1, 0), [255, 0, 0, 255]);
});

test("pixelpng: a pixel outside the image is null, and writing one is a no-op", () => {
  const image = blankImage(2, 1);
  assert.equal(pixelAt(image, -1, 0), null);
  assert.equal(pixelAt(image, 2, 0), null);
  assert.equal(pixelAt(image, 0, 1), null);
  setPixelAt(image, 9, 9, [1, 2, 3, 4]);
  assert.equal(image.pixels.every((byte) => byte === 0), true, "nothing was written");
  setPixelAt(image, 1, 0, [9, 8, 7, 6]);
  assert.deepEqual(pixelAt(image, 1, 0), [9, 8, 7, 6]);
  assert.deepEqual(pixelAt(image, 0, 0), [0, 0, 0, 0], "its neighbour is untouched");
});

test("pixelpng: all five row filters decode to the pixels that went in", () => {
  const expected = pngFilteredPixels();
  const decoded = decodePng(pngBytes(PNG_FILTERED));
  assert.equal(decoded.width, 4);
  assert.equal(decoded.height, 5);
  assert.deepEqual([...decoded.pixels], [...expected]);
  /* The same pixels, deflated into stored blocks rather than Huffman-coded. */
  assert.deepEqual([...decodePng(pngBytes(PNG_STORED)).pixels], [...expected]);
  /* A Node Buffer is as acceptable as a Uint8Array. */
  assert.deepEqual([...decodePng(Buffer.from(PNG_FILTERED, "base64")).pixels], [...expected]);
});

test("pixelpng: a file with no alpha channel decodes opaque", () => {
  const decoded = decodePng(pngBytes(PNG_RGB));
  assert.equal(decoded.width, 2);
  assert.equal(decoded.height, 1);
  assert.deepEqual(pixelAt(decoded, 0, 0), [10, 20, 30, 255], "no alpha byte means fully opaque");
  assert.deepEqual(pixelAt(decoded, 1, 0), [200, 150, 100, 255]);
});

test("pixelpng: a real exporter's file comes back at the size its own header says", () => {
  const bytes = pngBytes(PNG_CORPUS);
  const decoded = decodePng(bytes);
  /* The width and height are read here, out of the raw IHDR, so the decoder is
     not the only witness to its own answer. */
  assert.equal(decoded.width, bytes[19] | (bytes[18] << 8) | (bytes[17] << 16) | (bytes[16] << 24));
  assert.equal(decoded.height, bytes[23] | (bytes[22] << 8) | (bytes[21] << 16) | (bytes[20] << 24));
  assert.equal(decoded.width, 6);
  assert.equal(decoded.height, 3);
  assert.deepEqual([...decodePng(encodePng(decoded)).pixels], [...decoded.pixels]);
});

test("pixelpng: a PNG this reader does not decode is refused, not guessed at", () => {
  const withByte = (offset, value) => {
    const bytes = pngBytes(PNG_FILTERED);
    bytes[offset] = value;
    return bytes;
  };
  // assert.throws matches its pattern against String(error), which begins with
  // "Error: ", so these patterns are not anchored at the start of the message.
  assert.throws(() => decodePng(withByte(25, 3)), /unsupported PNG: /, "a palette image");
  assert.throws(() => decodePng(withByte(25, 0)), /unsupported PNG: /, "greyscale");
  assert.throws(() => decodePng(withByte(24, 4)), /unsupported PNG: /, "four bits per sample");
  assert.throws(() => decodePng(withByte(28, 1)), /unsupported PNG: /, "interlaced");
  assert.throws(() => decodePng(Buffer.from("title: T\n---\n")), /not a PNG/);
  assert.throws(() => decodePng(new Uint8Array(2)), /not a PNG/);
  assert.throws(() => decodePng(pngBytes(PNG_FILTERED).slice(0, 40)), /damaged PNG: /,
    "a stream that stops early");
});

test("pixelpng: what it writes is a PNG, chunk for chunk", () => {
  const image = blankImage(3, 2);
  setPixelAt(image, 0, 0, [1, 2, 3, 4]);
  setPixelAt(image, 2, 1, [250, 251, 252, 253]);
  const bytes = encodePng(image);
  assert.deepEqual([...bytes.slice(0, 8)], [...PNG_SIGNATURE]);
  const chunks = [];
  for (let at = 8; at + 12 <= bytes.length;) {
    const length = (bytes[at] << 24) | (bytes[at + 1] << 16) | (bytes[at + 2] << 8) | bytes[at + 3];
    const type = String.fromCharCode(...bytes.slice(at + 4, at + 8));
    const data = bytes.slice(at + 8, at + 8 + length);
    /* A chunk's CRC covers its type as well as its data; hashing the data alone
       still leaves a file most readers accept, so this is checked here. */
    const stated = ((bytes[at + 8 + length] << 24) | (bytes[at + 8 + length + 1] << 16)
      | (bytes[at + 8 + length + 2] << 8) | bytes[at + 8 + length + 3]) >>> 0;
    assert.equal(stated, pngCrc32(bytes.slice(at + 4, at + 8 + length)), `${type} chunk CRC`);
    chunks.push({ type, data });
    at += 12 + length;
  }
  assert.deepEqual(chunks.map((chunk) => chunk.type), ["IHDR", "IDAT", "IEND"]);
  assert.deepEqual([...chunks[0].data], [0, 0, 0, 3, 0, 0, 0, 2, 8, 6, 0, 0, 0],
    "three by two, eight bits a sample, colour type 6, not interlaced");
  /* Inside the stream: filter byte zero, then the image's own bytes, twice. */
  const raw = inflateSync(Buffer.from(chunks[1].data));
  assert.equal(raw.length, 2 * (1 + 3 * 4));
  assert.equal(raw[0], 0);
  assert.equal(raw[13], 0, "the second row carries its own filter byte");
  assert.deepEqual([...raw.slice(1, 13)], [...image.pixels.slice(0, 12)]);
  assert.deepEqual([...raw.slice(14)], [...image.pixels.slice(12)]);
});

test("pixelpng: a round trip through the channels comes back the same", () => {
  for (let width = 1; width <= 5; width += 1) {
    const image = blankImage(width, 1);
    for (let x = 0; x < width; x += 1) {
      setPixelAt(image, x, 0, [x * 50, 255 - x * 50, 128, x === 0 ? 0 : 255]);
    }
    const back = decodePng(encodePng(image));
    assert.equal(back.width, width);
    assert.deepEqual([...back.pixels], [...image.pixels], `width ${width}`);
  }
  const one = blankImage(1, 1, [0, 255, 128, 7]);
  assert.deepEqual([...decodePng(encodePng(one)).pixels], [0, 255, 128, 7]);
});

/* ------------------------------------------------------------------ */
/* the pixel card's colour opinion                                     */
/* ------------------------------------------------------------------ */

/*
 * The canvas half of a pixel card needs a browser and is covered by
 * `tools/input_smoke.py` instead. What is left over is the part between the
 * board document and the pixels: a palette is stored as strings, and the card
 * is the only thing that turns them into colours. These four checks pin that
 * down, because a palette that quietly loses an entry would come back on the
 * next board load as a different palette.
 */

test("pixel card: a stored palette is read back as the colours that went in", () => {
  assert.deepEqual(pixelPaletteOf(["#abc", "#112233", "#ABC"]), ["#aabbcc", "#112233", "#aabbcc"]);
});

test("pixel card: a palette with nothing usable in it falls back to the default", () => {
  for (const value of [null, undefined, [], "not a list", ["red", "#12345", 7], [null, {}]]) {
    const palette = pixelPaletteOf(value);
    assert.equal(palette.length, 16, `${JSON.stringify(value)} must give the default palette`);
    for (const colour of palette) {
      assert.match(colour, /^#[0-9a-f]{6}$/, `${JSON.stringify(value)} gave ${colour}`);
    }
  }
  assert.deepEqual(pixelPaletteOf(["nope"]), pixelPaletteOf([]));
});

test("pixel card: a colour is #rrggbb, or #rgb, or it is not a colour", () => {
  assert.deepEqual(pixelColourOf("#ff8000"), [255, 128, 0, 255]);
  assert.deepEqual(pixelColourOf("abc"), [170, 187, 204, 255], "the short form doubles each digit");
  assert.deepEqual(pixelColourOf("  #000000  "), [0, 0, 0, 255], "surrounding space is not part of the colour");
  for (const bad of ["", "#", "#12345", "#1234567", "red", "rgb(1,2,3)", null, 12, {}]) {
    assert.equal(pixelColourOf(bad), null, `${JSON.stringify(bad)} is not a colour`);
  }
});

test("pixel card: the readout shows a pixel's colour, and grey where there is none", () => {
  assert.equal(pixelInkOf([1, 2, 3, 255]), "#010203");
  assert.equal(pixelInkOf([255, 0, 128, 0]), "#ff0080", "a transparent pixel still has a colour to show");
  assert.equal(pixelInkOf(null), pixelInkOf(undefined), "nothing under the pointer is one answer, not two");
  assert.match(pixelInkOf(null), /^#[0-9a-f]{6}$/);
});

/* ------------------------------------------------------------------ */

const passed = checks - failures.length;
/*
 * Said on every run, pass or fail, because a green `ok N/N` is easy to read as
 * "the UI works". It does not: this suite has no browser in it.
 */
const note = `note: ${checks} checks, no DOM -- canvas layout, focus, pointer, keyboard and wheel events are not covered`;
if (failures.length > 0) {
  for (const { name, err } of failures) {
    console.error(`FAIL ${name}\n     ${err && err.message ? err.message : err}`);
    if (err && err.stack && !/^AssertionError/.test(err.name || "")) {
      console.error(String(err.stack).split("\n").slice(1, 4).map((line) => `     ${line.trim()}`).join("\n"));
    }
  }
  console.error(`ok ${passed}/${checks}`);
  console.error(note);
  process.exitCode = 1;
} else {
  console.log(`ok ${passed}/${checks}`);
  console.log(note);
}
