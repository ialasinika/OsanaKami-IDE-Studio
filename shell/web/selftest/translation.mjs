/* ------------------------------------------------------------------ */
/* the translation table moves through a session, not in one call
/* ------------------------------------------------------------------ */

import assert from "node:assert/strict";
import {
  BLOB_CHUNK_BYTES,
  base64FromBytes,
  bytesFromBase64,
  formatSize,
  readTextInChunks,
  renderCard,
  writeTextInChunks,
} from "../cards.mjs";
import {
  isStaleRevision,
} from "../rpc.mjs";
import {
  parseCsv,
  rowState,
  serializeCsv,
} from "../storycsv.mjs";
import {
  tick,
} from "./fixtures.mjs";
import {
  test,
  testAsync,
} from "./harness.mjs";
import {
  ADD_TABLE,
} from "./story.mjs";

/* ------------------------------------------------------------------ */
/* the translation table moves through a session, not in one call         */
/* ------------------------------------------------------------------ */

/*
 * The game's own tables are 4.5-5.75 MB -- `NewProject_RU.csv` is 5,751,617
 * bytes -- and one whole-file read of one is the read that never came back, so
 * the kernel refuses it and the card pages through `file.read_bytes` instead.
 * These checks drive that pager, and the card, over a kernel that serves RANGES
 * out of memory and refuses `file.read` of a table too large to open, exactly
 * as the real kernel does; the real 4.68 MB table is opened by the card probe.
 *
 * The suite has no browser, so the card is driven over the same small DOM stub
 * the card probe uses, kept here so this suite still needs nothing but `node`.
 */

export class TableClassList {
  constructor() { this.names = new Set(); }

  add(...names) { for (const name of names) this.names.add(name); }

  remove(...names) { for (const name of names) this.names.delete(name); }

  contains(name) { return this.names.has(name); }

  toggle(name, on) {
    const next = on === undefined ? !this.names.has(name) : on;
    if (next) this.names.add(name); else this.names.delete(name);
    return next;
  }
}

export class TableElement {
  constructor(tag) {
    this.tagName = String(tag).toUpperCase();
    this.classList = new TableClassList();
    this.attributes = new Map();
    this.childNodes = [];
    this.listeners = new Map();
    this.ownText = "";
    this.parent = null;
  }

  get className() { return [...this.classList.names].join(" "); }

  set className(value) {
    this.classList = new TableClassList();
    for (const name of String(value).split(/\s+/)) {
      if (name !== "") this.classList.add(name);
    }
  }

  get textContent() {
    if (this.childNodes.length === 0) return this.ownText;
    return this.childNodes.map((child) => child.textContent).join("");
  }

  /* Assigning text drops the children, the way the real element does: a repaint
     clears a list by setting its `textContent` to an empty string. */
  set textContent(value) {
    this.childNodes = [];
    this.ownText = String(value);
  }

  get value() { return this.attributes.get("value") ?? ""; }

  set value(next) { this.attributes.set("value", String(next)); }

  setAttribute(key, value) { this.attributes.set(String(key), String(value)); }

  getAttribute(key) {
    const name = String(key);
    return this.attributes.has(name) ? this.attributes.get(name) : null;
  }

  append(...nodes) {
    for (const node of nodes) {
      if (node === null || node === undefined) continue;
      node.parent = this;
      this.childNodes.push(node);
    }
  }

  addEventListener(type, fn) {
    if (!this.listeners.has(type)) this.listeners.set(type, []);
    this.listeners.get(type).push(fn);
  }

  dispatch(type, extra = {}) {
    const event = {
      type,
      target: this,
      ctrlKey: false,
      metaKey: false,
      key: "",
      preventDefault() {},
      stopPropagation() {},
      ...extra,
    };
    for (const fn of this.listeners.get(type) || []) fn(event);
    return event;
  }

  matches(selector) {
    const shape = String(selector);
    const attr = /^\[([a-z-]+)(?:="([^"]*)")?\]$/.exec(shape);
    if (attr !== null) {
      const value = this.getAttribute(attr[1]);
      if (value === null) return false;
      return attr[2] === undefined ? true : value === attr[2];
    }
    if (shape.startsWith(".")) return this.classList.contains(shape.slice(1));
    return this.tagName === shape.toUpperCase();
  }

  querySelectorAll(selector) {
    const found = [];
    const walk = (el) => {
      for (const child of el.childNodes) {
        if (!(child instanceof TableElement)) continue;
        if (child.matches(selector)) found.push(child);
        walk(child);
      }
    };
    walk(this);
    return found;
  }

  querySelector(selector) { return this.querySelectorAll(selector)[0] ?? null; }

  focus() { this.focused = true; }

  blur() { this.focused = false; }

  select() { this.selected = true; }
}

export class TableInput extends TableElement {}

/** Install a DOM the story card can be driven through, and how to take it down. */
export function stubTableDom() {
  const had = new Map();
  const install = (name, value) => {
    had.set(name, Object.prototype.hasOwnProperty.call(globalThis, name) ? globalThis[name] : undefined);
    globalThis[name] = value;
  };
  install("document", {
    createElement: (tag) => (String(tag).toLowerCase() === "input" ? new TableInput(tag) : new TableElement(tag)),
  });
  install("HTMLInputElement", TableInput);
  return {
    restore() {
      for (const [name, value] of had) {
        if (value === undefined) delete globalThis[name]; else globalThis[name] = value;
      }
    },
  };
}

/**
 * A kernel that answers from memory, with the two things the real kernel does
 * that matter here: `file.read` refuses a table too large to open, while a
 * `file.blob*` read session hands the same file over in frames of at most one
 * mebibyte.  The options name the ways a kernel can misbehave, so the reader's
 * own guards can be driven without a broken kernel anywhere on the disk.
 */
export function tableKernel(files, options = {}) {
  const calls = [];
  const aborted = [];
  const sessions = new Map();
  const cap = options.cap ?? 4 * 1024 * 1024;
  const frameCap = options.frameCap ?? BLOB_CHUNK_BYTES;
  let revision = 5;
  let nextSession = 0;
  const client = {
    call: async (method, params) => {
      const record = { method, params };
      calls.push(record);
      if (method === "file.read") {
        const raw = files[params.path];
        if (raw === undefined) throw new Error(`no stub file at ${params.path}`);
        const text = Buffer.isBuffer(raw) ? raw.toString("utf8") : raw;
        const bytes = Buffer.from(text, "utf8");
        if (bytes.length > cap) throw new Error(`${params.path} is too large to open`);
        record.result = { text, revision: 5, eol: "crlf", size: bytes.length };
        return record.result;
      }
      if (method === "file.blobOpen") {
        const raw = files[params.path];
        const asBuffer = Buffer.isBuffer(raw);
        if (params.mode === "read" && typeof raw !== "string" && !asBuffer) {
          throw new Error(`no stub file at ${params.path}`);
        }
        if (params.mode === "write" && options.stale === true) {
          throw new Error(`${params.path} changed on disk (rev 9)`);
        }
        const session = `s${nextSession += 1}`;
        if (options.forget !== true) {
          sessions.set(session, {
            path: params.path,
            mode: params.mode,
            asBuffer,
            bytes: params.mode === "read"
              ? (asBuffer ? Buffer.from(raw) : Buffer.from(raw, "utf8"))
              : Buffer.from("", "utf8"),
            offset: 0,
          });
        }
        record.result = {
          session,
          path: params.path,
          size: params.mode === "read"
            ? (asBuffer ? raw.length : Buffer.byteLength(raw, "utf8"))
            : 0,
          revision: params.mode === "write" ? 9 : 5,
        };
        return record.result;
      }
      if (method === "file.blobRead") {
        const open = sessions.get(params.session);
        if (open === undefined) throw new Error("no such blob session");
        if (typeof options.onFrame === "function") options.onFrame({ params, calls });
        if (options.refuseAt !== undefined && params.offset === options.refuseAt) {
          throw new Error("the disk went away");
        }
        if (!Number.isInteger(params.length) || params.length < 1 || params.length > frameCap) {
          throw new Error(`a frame is between 1 and ${frameCap} bytes, not ${params.length}`);
        }
        if (options.holeAt !== undefined && params.offset === options.holeAt) {
          record.result = {
            session: params.session, offset: params.offset, size: open.bytes.length, eof: false, data: "",
          };
          return record.result;
        }
        const wanted = options.shortFirst !== undefined && params.offset === 0
          ? Math.min(options.shortFirst, params.length)
          : params.length;
        const start = Math.min(params.offset, open.bytes.length);
        const end = Math.min(open.bytes.length, start + wanted);
        open.offset = end;
        record.result = {
          session: params.session,
          offset: options.misreportOffset === true ? 0 : params.offset,
          size: open.bytes.length,
          eof: end >= open.bytes.length,
          data: Buffer.from(open.bytes.subarray(start, end)).toString("base64"),
        };
        return record.result;
      }
      if (method === "file.blobAppend") {
        const open = sessions.get(params.session);
        if (open === undefined) throw new Error("no such blob session");
        if (params.offset !== open.offset) {
          throw new Error(`a write session ends at byte ${open.offset}, not byte ${params.offset}`);
        }
        const chunk = Buffer.from(String(params.data === undefined ? "" : params.data), "base64");
        open.bytes = Buffer.concat([open.bytes, chunk]);
        open.offset = open.bytes.length;
        record.result = { session: params.session, offset: open.offset, size: open.offset };
        return record.result;
      }
      if (method === "file.blobCommit") {
        const open = sessions.get(params.session);
        if (open === undefined) throw new Error("no such blob session");
        if (params.total_size !== open.bytes.length) {
          throw new Error(`${open.path}: the commit says ${params.total_size} bytes and ${open.bytes.length} were appended`);
        }
        files[open.path] = open.asBuffer ? open.bytes : open.bytes.toString("utf8");
        revision += 1;
        record.result = { path: open.path, size: open.bytes.length, revision, replaced: true };
        return record.result;
      }
      if (method === "file.blobAbort") {
        if (sessions.has(params.session)) {
          aborted.push(params.session);
          sessions.delete(params.session);
        }
        record.result = { session: params.session };
        return record.result;
      }
      if (method === "file.write") {
        files[params.path] = params.text;
        revision += 1;
        record.result = { revision };
        return record.result;
      }
      throw new Error(`stub client was asked for ${method}`);
    },
    isStaleRevision: () => false,
  };
  const app = { log() {}, boardTouched() {}, confirmDiscard: () => true, resolveStale: async () => "reload" };
  return { client, app, calls, aborted, sessions, files };
}

export const TABLE_PATH = "Yarn\\NewProject_RU.csv";
export const TABLE_EN_PATH = "Yarn\\NewProject_EN.csv";
export const TABLE_STORY_PATH = "Logic\\1.Welcome.yarn";
export const TABLE_STORY = [
  "title: Welcome_Node",
  "---",
  "Aistalt: Hi. #line:1111111",
  "===",
  "",
].join("\n");

/* A three-byte character, so a range boundary can fall inside it. */
export const WIDE_TABLE_CHAR = "\u65e5";
export const TABLE_HEAD = "language,id,text,file,node,lineNumber,lock,comment\r\n";
export const TABLE_FILE_FIELD = "E:\\UnityProject\\Infant God\\Assets\\YarnScripts\\Logic\\1.Welcome.yarn";

/**
 * A table past any whole-file read the kernel allows, with its first mebibyte
 * boundary inside `WIDE_TABLE_CHAR`: the filler is counted so that character's
 * first byte is the last byte of the first range.
 */
export let bigTableText = null;
export function bigTable() {
  if (bigTableText !== null) return bigTableText;
  const before = (filler) => TABLE_HEAD
    + `en,line:1000000,${filler},${TABLE_FILE_FIELD},Welcome_Node,1,00000000,\r\n`
    + "en,line:1111111,Aistalt: ";
  const pad = BLOB_CHUNK_BYTES - 1 - Buffer.byteLength(before(""));
  assert.ok(pad > 0, `there is room for a mebibyte of filler: ${pad}`);
  bigTableText = before("x".repeat(pad))
    + WIDE_TABLE_CHAR + `\u3068 hi.,${TABLE_FILE_FIELD},Welcome_Node,19,072a7a30,\r\n`
    + "en,line:3333333," + "y".repeat(4 * BLOB_CHUNK_BYTES)
    + `,${TABLE_FILE_FIELD},Welcome_Node,40,abcdef01,\r\n`;
  return bigTableText;
}

await testAsync("table read: a 5 MB table moves through a blob session in mebibyte frames, byte for byte", async () => {
  const text = bigTable();
  const bytes = Buffer.from(text, "utf8");
  assert.ok(bytes.length > 4 * BLOB_CHUNK_BYTES, `the fixture is ${bytes.length} bytes`);
  assert.equal(bytes[BLOB_CHUNK_BYTES] & 0xc0, 0x80, "the first boundary lands inside a character");

  const kernel = tableKernel({ [TABLE_PATH]: text });
  const read = await readTextInChunks(kernel.client, TABLE_PATH);

  assert.equal(read.text, text, "the assembled text is the file");
  assert.equal(read.size, bytes.length);
  assert.equal(read.revision, 5, "the revision the session opened at is the table's base revision");
  assert.ok(read.chunks > 1, `${read.chunks} frames`);

  const opens = kernel.calls.filter((call) => call.method === "file.blobOpen");
  assert.equal(opens.length, 1, "one session, opened once");
  assert.equal(opens[0].params.mode, "read");
  assert.equal(opens[0].params.want_revision, true, "the base revision is asked for at the open");
  const session = opens[0].result.session;

  const frames = kernel.calls.filter((call) => call.method === "file.blobRead");
  assert.equal(frames.length, read.chunks);
  let next = 0;
  for (const call of frames) {
    assert.equal(call.params.session, session, "every frame belongs to the one session");
    assert.equal(call.params.length, BLOB_CHUNK_BYTES, "a frame is never the whole table");
    assert.equal(call.params.offset, next, "the frames tile the file with no gap and no overlap");
    assert.ok(call.params.offset < bytes.length, "every frame starts inside the file");
    next += bytesFromBase64(call.result.data).length;
  }
  assert.equal(next, bytes.length, "the frames cover the file exactly");
  assert.equal(kernel.aborted.length, 1, "the session was given back");
  assert.equal(kernel.calls.filter((call) => call.method === "file.read").length, 0, "the table was never read whole");

  const rows = parseCsv(read.text);
  assert.equal(rows.rows.length, 3);
  assert.equal(rows.rows[1].text, `Aistalt: ${WIDE_TABLE_CHAR}\u3068 hi.`);
  assert.deepEqual(rows, parseCsv(text), "the same rows a whole read of the same table gives");
});

await testAsync("table read: the card opens a 5 MB table in frames and shows the row the parser read", async () => {
  const dom = stubTableDom();
  try {
    const text = bigTable();
    const kernel = tableKernel({ [TABLE_STORY_PATH]: TABLE_STORY, [TABLE_PATH]: text });
    const mounted = renderCard({ id: "big-table", kind: "story", file: TABLE_STORY_PATH }, kernel);
    await mounted.handle.load(TABLE_STORY_PATH);
    await tick(4);
    assert.equal(await mounted.handle.loadTable(TABLE_PATH), true, "a 5 MB table opens");

    const whole = parseCsv(text);
    const frames = kernel.calls.filter((call) => call.method === "file.blobRead");
    assert.ok(frames.length > 1, `${frames.length} frames`);
    assert.equal(frames.filter((call) => call.params.length !== BLOB_CHUNK_BYTES).length, 0);
    assert.equal(
      kernel.calls.filter((call) => call.method === "file.read" && call.params.path === TABLE_PATH).length,
      0,
      "the card never asked for the whole table",
    );

    const label = mounted.el.querySelector('[data-role="story-table"]');
    assert.ok(label.textContent.includes(`${whole.rows.length} rows`), label.textContent);
    assert.equal(mounted.handle.tablePath, TABLE_PATH);

    mounted.el.querySelectorAll('[data-role="story-node"]')[0].dispatch("click");
    const line = mounted.el.querySelector('[data-line="0"]');
    assert.ok(line !== null, "the line the table knows is drawn");
    const cell = line.querySelector('[data-role="story-translation"]');
    assert.ok(cell !== null, "the translation column is drawn");
    const row = whole.rows.find((entry) => entry.id === "line:1111111");
    assert.equal(cell.textContent, row.text, "the cell shows the table's own words");
    assert.ok(row.text.includes(WIDE_TABLE_CHAR), "the character the boundary falls inside came back");
    assert.equal(cell.getAttribute("data-state"), rowState({ text: "Aistalt: Hi." }, row));
  } finally {
    dom.restore();
  }
});

await testAsync("table read: the status line shows how far the reading has got", async () => {
  const dom = stubTableDom();
  try {
    const text = bigTable();
    const bytes = Buffer.from(text, "utf8");
    const seen = [];
    let mounted = null;
    const kernel = tableKernel({ [TABLE_STORY_PATH]: TABLE_STORY, [TABLE_PATH]: text }, {
      onFrame: () => {
        if (mounted !== null) seen.push(mounted.el.querySelector('[data-role="card-status"]').textContent);
      },
    });
    mounted = renderCard({ id: "progress", kind: "story", file: TABLE_STORY_PATH }, kernel);
    await mounted.handle.load(TABLE_STORY_PATH);
    await tick(4);
    assert.equal(await mounted.handle.loadTable(TABLE_PATH), true);

    const frames = kernel.calls.filter((call) => call.method === "file.blobRead");
    assert.equal(seen.length, frames.length, "the status was seen once per frame");
    assert.equal(seen[0], "reading table\u2026", "before the first byte the line says only that it is reading");
    for (let i = 1; i < seen.length; i += 1) {
      assert.equal(
        seen[i],
        `reading table\u2026 ${formatSize(frames[i].params.offset)}/${formatSize(bytes.length)}`,
        `the line at frame ${i}`,
      );
    }
    const last = mounted.el.querySelector('[data-role="card-status"]');
    assert.equal(last.textContent.includes("reading table"), false, "the reading line gave way to what was read");
  } finally {
    dom.restore();
  }
});

await testAsync("table read: the next frame starts where the bytes the kernel sent ended", async () => {
  const text = bigTable();
  const bytes = Buffer.from(text, "utf8");
  const kernel = tableKernel({ [TABLE_PATH]: text }, { shortFirst: 100000 });
  const read = await readTextInChunks(kernel.client, TABLE_PATH);

  assert.equal(read.text, text, "a short frame loses nothing and repeats nothing");
  const frames = kernel.calls.filter((call) => call.method === "file.blobRead");
  assert.equal(frames[0].params.offset, 0);
  assert.equal(frames[1].params.offset, 100000, "the next frame starts after what was sent, not after what was asked");
  let next = 0;
  for (const call of frames) {
    assert.equal(call.params.offset, next, "the frames still tile the file");
    next += bytesFromBase64(call.result.data).length;
  }
  assert.equal(next, bytes.length);
  assert.ok(read.chunks > 5, `${read.chunks} frames`);
});

await testAsync("table read: a frame that fails is named on the card and leaves no table behind", async () => {
  const dom = stubTableDom();
  try {
    const kernel = tableKernel(
      { [TABLE_STORY_PATH]: TABLE_STORY, [TABLE_PATH]: bigTable(), [TABLE_EN_PATH]: ADD_TABLE },
      { refuseAt: BLOB_CHUNK_BYTES },
    );
    const mounted = renderCard({ id: "half", kind: "story", file: TABLE_STORY_PATH }, kernel);
    await mounted.handle.load(TABLE_STORY_PATH);
    await tick(4);

    assert.equal(await mounted.handle.loadTable(TABLE_PATH), false, "a refused frame is a failure, not a shorter table");
    const status = mounted.el.querySelector('[data-role="card-status"]');
    assert.ok(status.textContent.includes(TABLE_PATH), status.textContent);
    assert.ok(status.textContent.includes("the disk went away"), status.textContent);
    assert.equal(mounted.handle.tablePath, "", "a failed read leaves no table claimed");
    assert.equal(kernel.aborted.length, 1, "the session was given back even though the read failed");
    assert.ok(
      mounted.el.querySelector('[data-role="story-table"]').textContent.includes("no translation table"),
      "the card says it has no table",
    );

    /* The card is still a card: the story it did open is drawn, and there is no
       half-table column pretending to be the table. */
    mounted.el.querySelectorAll('[data-role="story-node"]')[0].dispatch("click");
    assert.equal(mounted.el.querySelectorAll('[data-role="story-line"]').length, 1);
    assert.equal(mounted.el.querySelectorAll('[data-role="story-translation"]').length, 0);

    /* And a table that does read still opens afterwards. */
    assert.equal(await mounted.handle.loadTable(TABLE_EN_PATH), true);
    assert.equal(mounted.handle.tablePath, TABLE_EN_PATH);
    assert.ok(mounted.el.querySelector('[data-role="story-table"]').textContent.includes("2 rows"));
    mounted.el.querySelectorAll('[data-role="story-node"]')[0].dispatch("click");
    const cell = mounted.el.querySelector('[data-line="0"]').querySelector('[data-role="story-translation"]');
    assert.equal(cell.textContent, parseCsv(ADD_TABLE).rows[0].text);
  } finally {
    dom.restore();
  }
});

await testAsync("table read: a small table is one frame and parses to the rows it always did", async () => {
  const kernel = tableKernel({ [TABLE_PATH]: ADD_TABLE });
  const read = await readTextInChunks(kernel.client, TABLE_PATH);

  assert.equal(read.text, ADD_TABLE);
  assert.equal(read.chunks, 1, "a small table is one frame");
  const frames = kernel.calls.filter((call) => call.method === "file.blobRead");
  assert.equal(frames.length, 1);
  assert.equal(frames[0].params.offset, 0);
  assert.equal(frames[0].params.length, BLOB_CHUNK_BYTES);
  assert.equal(read.revision, 5, "the revision comes from the open, not from the frame");
  assert.deepEqual(parseCsv(read.text), parseCsv(ADD_TABLE));
  assert.equal(kernel.calls.some((call) => call.method === "file.read"), false, "a small table is not read whole either");
});

await testAsync("table read: the card still opens the small table it was created with", async () => {
  const dom = stubTableDom();
  try {
    const kernel = tableKernel({ [TABLE_STORY_PATH]: TABLE_STORY, [TABLE_PATH]: ADD_TABLE });
    const mounted = renderCard(
      { id: "small-table", kind: "story", file: TABLE_STORY_PATH, table: TABLE_PATH },
      kernel,
    );
    await mounted.handle.load(TABLE_STORY_PATH);
    await tick(20);
    assert.equal(mounted.handle.tablePath, TABLE_PATH, "the card opened its own table");
    assert.ok(mounted.el.querySelector('[data-role="story-table"]').textContent.includes("2 rows"));

    mounted.el.querySelectorAll('[data-role="story-node"]')[0].dispatch("click");
    const cell = mounted.el.querySelector('[data-line="0"]').querySelector('[data-role="story-translation"]');
    const row = parseCsv(ADD_TABLE).rows[0];
    assert.equal(cell.textContent, row.text);
    assert.equal(cell.getAttribute("data-state"), rowState({ text: "Aistalt: Hi." }, row));
  } finally {
    dom.restore();
  }
});

await testAsync("table read: a range that ends inside a character does not corrupt it", async () => {
  const text = TABLE_HEAD + "ja,line:a,Aistalt: \u65e5\u672c\u8a9e\u3068\u3053\u3053,f,Node,1,00000000,\r\n";
  const bytes = Buffer.from(text, "utf8");
  const kernel = tableKernel({ [TABLE_PATH]: text });
  const read = await readTextInChunks(kernel.client, TABLE_PATH, { chunkBytes: 1 });

  assert.equal(read.chunks, bytes.length, "one byte per range, so every boundary is inside a character");
  assert.equal(read.text.includes("\ufffd"), false, "no character became a replacement mark");
  assert.equal(read.text, text);
  assert.deepEqual(parseCsv(read.text), parseCsv(text));
  assert.ok(bigTable().includes(WIDE_TABLE_CHAR), "the 5 MB fixture holds the character the boundary splits");
});

await testAsync("table read: a kernel that stops mid-file is a named failure, not a shorter table", async () => {
  const text = TABLE_HEAD + "en,line:a,Hi,f,Node,1,00000000,\r\n";
  const bytes = Buffer.from(text, "utf8");
  const kernel = tableKernel({ [TABLE_PATH]: text }, { holeAt: 8 });
  await assert.rejects(
    () => readTextInChunks(kernel.client, TABLE_PATH, { chunkBytes: 8 }),
    new RegExp(`the read stopped at byte 8 of ${bytes.length}`),
  );
  assert.equal(
    kernel.calls.filter((call) => call.method === "file.blobRead").length,
    2,
    "it stopped asking, it did not loop",
  );
  assert.equal(kernel.aborted.length, 1, "the session was given back");
});

await testAsync("table read: a frame served from the wrong offset is a failure, not the same bytes twice", async () => {
  const kernel = tableKernel({ [TABLE_PATH]: bigTable() }, { misreportOffset: true });
  await assert.rejects(
    () => readTextInChunks(kernel.client, TABLE_PATH),
    /asked for byte 1048576 and got byte 0/,
  );
  assert.equal(
    kernel.calls.filter((call) => call.method === "file.blobRead").length,
    2,
    "it stopped asking, it did not loop",
  );
  assert.equal(kernel.aborted.length, 1, "the session was given back");
});

await testAsync("table read: a session the kernel no longer knows is a named failure", async () => {
  const kernel = tableKernel({ [TABLE_PATH]: bigTable() }, { forget: true });
  await assert.rejects(
    () => readTextInChunks(kernel.client, TABLE_PATH),
    /no such blob session/,
  );
  assert.equal(kernel.aborted.length, 0, "there was no session left to give back");
});

await testAsync("table write: a 5 MB table is appended in frames and committed with its own total", async () => {
  const text = bigTable();
  const bytes = Buffer.from(text, "utf8");
  const kernel = tableKernel({ [TABLE_PATH]: "old contents" });
  const written = await writeTextInChunks(kernel.client, TABLE_PATH, text, { baseRevision: 5 });

  assert.equal(written.size, bytes.length);
  assert.equal(written.revision, 6, "the commit's revision is the next base revision");
  assert.equal(written.replaced, true);
  assert.ok(written.chunks > 1, `${written.chunks} frames`);

  const opens = kernel.calls.filter((call) => call.method === "file.blobOpen");
  assert.equal(opens.length, 1, "one write session");
  assert.equal(opens[0].params.mode, "write");
  assert.equal(opens[0].params.base_revision, 5, "the session is locked to the revision the read reported");

  const appends = kernel.calls.filter((call) => call.method === "file.blobAppend");
  assert.equal(appends.length, written.chunks);
  let next = 0;
  for (const call of appends) {
    assert.equal(call.params.session, opens[0].result.session, "every frame belongs to the one session");
    assert.equal(call.params.offset, next, "each append starts where the session ended");
    const sent = bytesFromBase64(call.params.data).length;
    assert.ok(sent <= BLOB_CHUNK_BYTES, `a frame is at most one mebibyte: ${sent}`);
    next += sent;
  }
  assert.equal(next, bytes.length, "the frames cover the text exactly");

  const commits = kernel.calls.filter((call) => call.method === "file.blobCommit");
  assert.equal(commits.length, 1);
  assert.equal(commits[0].params.total_size, bytes.length, "the commit states the whole size, so nothing is left out");
  assert.equal(kernel.files[TABLE_PATH], text, "the file is the text that was written");
  assert.equal(kernel.aborted.length, 1, "the session was given back after the commit");
  assert.equal(kernel.sessions.size, 0, "no session was left open");
});

await testAsync("table write: a refused open leaves the file exactly as it was", async () => {
  const kernel = tableKernel({ [TABLE_PATH]: "old contents" }, { stale: true });
  await assert.rejects(
    () => writeTextInChunks(kernel.client, TABLE_PATH, bigTable(), { baseRevision: 5 }),
    /changed on disk/,
  );
  assert.equal(kernel.files[TABLE_PATH], "old contents", "nothing was published");
  assert.equal(kernel.calls.filter((call) => call.method === "file.blobAppend").length, 0);
  assert.equal(kernel.calls.filter((call) => call.method === "file.blobCommit").length, 0);
});

/*
 * The table's bytes are the table (G42).  The game's own tables open with a
 * byte-order mark; a read that ate it and a write that did not put it back would
 * hand the game a different file.  And a lenient decode turns a table that is not
 * UTF-8 into U+FFFD, which the next save writes over the modder's own
 * characters.  Both are pinned with real bytes, not strings.
 */
export const SMALL_TABLE = "id,text\r\nen,line:1,a\r\n";
export function withBom(text) {
  return Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from(text, "utf8")]);
}

await testAsync("table read: a byte-order mark is a fact about the file, not a character of it", async () => {
  const bytes = withBom(SMALL_TABLE);
  const kernel = tableKernel({ [TABLE_PATH]: bytes });
  const read = await readTextInChunks(kernel.client, TABLE_PATH);

  assert.equal(read.bom, true, "the mark is reported");
  assert.equal(read.text, SMALL_TABLE, "and it is not part of the table's text");
  assert.equal(read.size, bytes.length, "the size still counts the mark");
  assert.equal(parseCsv(read.text).bom, false, "the parser was handed text without a mark");
  assert.equal(serializeCsv(parseCsv(read.text)), SMALL_TABLE, "so the rows are what the parser was given");
});

await testAsync("table write: the mark the reader reported comes back byte for byte", async () => {
  const bytes = withBom(SMALL_TABLE);
  const kernel = tableKernel({ [TABLE_PATH]: bytes });
  const read = await readTextInChunks(kernel.client, TABLE_PATH);
  await writeTextInChunks(kernel.client, TABLE_PATH, read.text, {
    baseRevision: read.revision,
    bom: read.bom,
  });

  const after = kernel.files[TABLE_PATH];
  assert.ok(Buffer.isBuffer(after), "the stub recorded bytes");
  assert.deepEqual(Array.from(after.subarray(0, 3)), [0xef, 0xbb, 0xbf], "the mark is the first thing in the file");
  assert.ok(after.equals(bytes), "the file that comes back is the file that was read");
});

await testAsync("table read: bytes that are not UTF-8 are refused, not replaced", async () => {
  const bytes = Buffer.from([0x69, 0x64, 0x2c, 0xff, 0xfe, 0x0d, 0x0a]);
  const kernel = tableKernel({ [TABLE_PATH]: bytes });
  await assert.rejects(
    () => readTextInChunks(kernel.client, TABLE_PATH),
    /not UTF-8/,
  );
  assert.equal(kernel.aborted.length, 1, "the session was given back");
  assert.equal(kernel.sessions.size, 0, "no session was left open");
});

await testAsync("table: the card keeps the mark across a read and a write", async () => {
  const dom = stubTableDom();
  try {
    const tableBytes = withBom(ADD_TABLE);
    const kernel = tableKernel({ [TABLE_STORY_PATH]: TABLE_STORY, [TABLE_PATH]: tableBytes });
    const mounted = renderCard(
      { id: "bom-table", kind: "story", file: TABLE_STORY_PATH, table: TABLE_PATH },
      kernel,
    );
    await mounted.handle.load(TABLE_STORY_PATH);
    await tick(20);
    mounted.el.querySelector('[data-role="story-add-line"]').dispatch("click");
    assert.equal(await mounted.handle.save(), true, "the save goes through");

    const after = kernel.files[TABLE_PATH];
    assert.ok(Buffer.isBuffer(after), "the table was written as bytes");
    assert.deepEqual(Array.from(after.subarray(0, 3)), [0xef, 0xbb, 0xbf],
      "the card's table still opens with the mark it was read with");
    assert.equal(parseCsv(after.toString("utf8").slice(1)).rows.length,
      parseCsv(ADD_TABLE).rows.length + 1, "and the new row is in it");
  } finally {
    dom.restore();
  }
});

await testAsync("table write: the card saves a new row through a write session, not a whole-file write", async () => {
  const dom = stubTableDom();
  try {
    const kernel = tableKernel({ [TABLE_STORY_PATH]: TABLE_STORY, [TABLE_PATH]: ADD_TABLE });
    const mounted = renderCard(
      { id: "save-table", kind: "story", file: TABLE_STORY_PATH, table: TABLE_PATH },
      kernel,
    );
    await mounted.handle.load(TABLE_STORY_PATH);
    await tick(20);
    mounted.el.querySelector('[data-role="story-add-line"]').dispatch("click");
    assert.equal(await mounted.handle.save(), true, "the save goes through");

    const storyWrites = kernel.calls.filter((call) => call.method === "file.write");
    assert.equal(storyWrites.length, 1, "the story is still one whole write");
    assert.equal(storyWrites[0].params.path, TABLE_STORY_PATH);
    assert.equal(
      kernel.calls.filter((call) => call.method === "file.write" && call.params.path === TABLE_PATH).length,
      0,
      "the table was never written whole",
    );

    const commits = kernel.calls.filter((call) => call.method === "file.blobCommit");
    assert.equal(commits.length, 1, "the table went through a session");
    const writeOpens = kernel.calls
      .filter((call) => call.method === "file.blobOpen" && call.params.mode === "write");
    assert.equal(writeOpens.length, 1, "one write session, for the table");
    assert.equal(writeOpens[0].params.path, TABLE_PATH);
    const written = parseCsv(kernel.files[TABLE_PATH]);
    assert.equal(written.rows.length, parseCsv(ADD_TABLE).rows.length + 1, "the row is in the committed file");
    assert.equal(written.rows[written.rows.length - 1].text, "Aistalt: ", "and it is the row the new line owes");
    assert.equal(mounted.handle.tablePath, TABLE_PATH, "the card still holds the table it read");
  } finally {
    dom.restore();
  }
});

test("base64: the bytes a frame carries survive the page's own encoder", () => {
  const small = new TextEncoder().encode("Aistalt: \u65e5\u672c\u8a9e A\u0000\u00ff\u{1f600}");
  assert.deepEqual(Array.from(bytesFromBase64(base64FromBytes(small))), Array.from(small));
  const big = new Uint8Array(0x8123);
  for (let i = 0; i < big.length; i += 1) big[i] = i & 0xff;
  assert.deepEqual(Array.from(bytesFromBase64(base64FromBytes(big))), Array.from(big));
});
