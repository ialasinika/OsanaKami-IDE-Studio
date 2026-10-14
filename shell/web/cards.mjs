/**
 * cards.mjs -- one renderer and one behaviour set per card kind.
 *
 * DELETE THIS FILE and the board still pans; it just has no cards to put on it.
 * seIDE has no plugin system: extending the visual vocabulary means forking this
 * file.  What it does have is a *hook* -- `registerCardKind()` -- so that
 * "adding a kind" is one self-contained object instead of an edit to a switch
 * in three places.  Five kinds are registered at the bottom of this file:
 * `editor`, `runner`, `note`, `files` and `sheet`.
 *
 * `sheet` is there to make the hook honest rather than theoretical.  It is a
 * structured-data editor -- typed cells in a grid, not a textarea -- and it
 * exists to prove that nothing in the board, the protocol or the kernel assumes
 * a card's state is text.  See `docs/SURFACES.md`.
 *
 * The file is split in two halves:
 *
 *   1. pure functions (no `document`, no `window`) -- token spans, the file
 *      listing, command parsing, output buffering, the sheet model.  These are
 *      what `selftest.mjs` checks under Node.
 *   2. DOM renderers, each returning `{ el, handle, destroy }`, driven through
 *      the `ctx` object so a card never talks to the kernel directly.
 *
 * Token colours are applied to a `<pre>` that sits *under* a transparent
 * `<textarea>`, never by rewriting the text itself.  That is what makes the
 * caret survive re-tokenisation: the element being edited is never touched.
 * The cost is that both layers must share identical metrics (see `style.css`)
 * and that the pre must be scrolled in lockstep with the textarea.
 */

/**
 * Kinds the wire may carry, mapped to the class suffix `style.css` styles.
 * `ws` and `ident` are emitted by `langs/tokenize.mjs` even though the contract
 * omits them; both are painted as ordinary text rather than dropped.
 */
const KNOWN_KINDS = new Set([
  "comment", "string", "number", "keyword", "type", "constant",
  "command", "punct", "plain",
]);

const PLAIN_LIKE = new Set(["plain", "ws", "ident", ""]);

/**
 * Map a wire token kind onto one of the contract's kinds.
 * Unknown values become `plain` so an unexpected kind can never produce an
 * unstyled hole in the document.
 */
export function normaliseTokenKind(kind) {
  const name = typeof kind === "string" ? kind : "";
  if (PLAIN_LIKE.has(name)) {
    return "plain";
  }
  return KNOWN_KINDS.has(name) ? name : "plain";
}

/**
 * Turn `text` plus a wire token array into a gap-free list of
 * `{start, end, kind}` segments covering `[0, text.length)`.
 *
 * The contract says tokens need not tile the input ("the gaps between them are
 * implicit default-colored text") while `langs/tokenize.mjs` tiles it anyway.
 * This handles both: gaps become `plain`, out-of-range or inverted spans are
 * dropped, and overlapping spans are clipped rather than allowed to nest.
 */
export function applyTokenSpans(text, tokens) {
  const source = typeof text === "string" ? text : "";
  const length = source.length;
  const spans = [];

  if (Array.isArray(tokens)) {
    for (const token of tokens) {
      let start;
      let end;
      let kind;
      if (Array.isArray(token)) {
        [start, end, kind] = token;
      } else if (token !== null && typeof token === "object") {
        start = token.start;
        end = token.end;
        kind = token.kind;
      } else {
        continue;
      }
      if (!Number.isInteger(start) || !Number.isInteger(end) || end <= start) {
        continue;
      }
      if (start < 0 || start >= length) {
        continue;
      }
      spans.push({ start, end: Math.min(end, length), kind: normaliseTokenKind(kind) });
    }
  }

  spans.sort((a, b) => a.start - b.start || a.end - b.end);

  const out = [];
  let cursor = 0;
  for (const span of spans) {
    if (span.end <= cursor) {
      continue; // fully swallowed by an earlier token
    }
    const start = Math.max(span.start, cursor);
    if (start > cursor) {
      out.push({ start: cursor, end: start, kind: "plain" });
    }
    out.push({ start, end: span.end, kind: span.kind });
    cursor = span.end;
  }
  if (cursor < length) {
    out.push({ start: cursor, end: length, kind: "plain" });
  }
  return out;
}

/** The concatenated text of a segment list; a round-trip check for tests. */
export function segmentsText(text, tokens) {
  return applyTokenSpans(text, tokens).map((seg) => text.slice(seg.start, seg.end)).join("");
}

/** Count segments per kind, e.g. for a status line. */
export function countKinds(segments) {
  const counts = new Map();
  for (const seg of segments) {
    counts.set(seg.kind, (counts.get(seg.kind) || 0) + 1);
  }
  return counts;
}

/** Offset -> 1-based `{line, column}`, for a caret readout. */
export function lineColumn(text, offset) {
  const source = typeof text === "string" ? text : "";
  const at = Math.max(0, Math.min(Number.isInteger(offset) ? offset : 0, source.length));
  let line = 1;
  let lastBreak = -1;
  for (let i = 0; i < at; i += 1) {
    if (source[i] === "\n") {
      line += 1;
      lastBreak = i;
    }
  }
  return { line, column: at - lastBreak };
}

/* ------------------------------------------------------------------ */
/* file listing                                                        */
/* ------------------------------------------------------------------ */

/**
 * Human-readable size, e.g. `4096` -> `4.0K`.  Byte-exact below 1K, because a
 * source file's real size is more useful than a rounded one.
 */
export function formatSize(bytes) {
  if (!Number.isFinite(bytes) || bytes < 0) {
    return "";
  }
  if (bytes < 1024) {
    return `${bytes}B`;
  }
  const units = ["K", "M", "G", "T"];
  let value = bytes / 1024;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }
  return `${value < 10 ? value.toFixed(1) : Math.round(value)}${units[unit]}`;
}

/** Relative age, e.g. `3m`, `2h`, `5d`. Empty when the mtime is unusable. */
export function formatAge(mtimeSeconds, nowSeconds = Math.floor(Date.now() / 1000)) {
  if (!Number.isFinite(mtimeSeconds)) {
    return "";
  }
  const delta = Math.max(0, nowSeconds - mtimeSeconds);
  if (delta < 60) {
    return `${Math.floor(delta)}s`;
  }
  if (delta < 3600) {
    return `${Math.floor(delta / 60)}m`;
  }
  if (delta < 86400) {
    return `${Math.floor(delta / 3600)}h`;
  }
  if (delta < 86400 * 30) {
    return `${Math.floor(delta / 86400)}d`;
  }
  return `${Math.floor(delta / (86400 * 30))}mo`;
}

/**
 * Flatten `workspace.list`'s payload into the rows the `files` card shows:
 * directories first, then files, each group path-sorted.
 *
 * `{files:[{path,size,mtime,dir}], count, truncated}` in, an array of
 * `{path,name,dir,size,mtime,sizeText,ageText}` out.  Pure, so ordering and
 * formatting are testable without a filesystem.
 *
 * @param {object} listing
 * @param {{sort?: "path"|"size"|"mtime", now?: number, dirsFirst?: boolean}} [options]
 */
export function formatListing(listing, options = {}) {
  const { sort = "path", now = Math.floor(Date.now() / 1000), dirsFirst = true } = options;
  const files = listing && Array.isArray(listing.files) ? listing.files : [];

  const rows = [];
  for (const entry of files) {
    if (entry === null || typeof entry !== "object") {
      continue;
    }
    const path = typeof entry.path === "string" ? entry.path : "";
    if (path === "") {
      continue;
    }
    const dir = entry.dir === true;
    const size = dir ? null : (Number.isFinite(entry.size) ? entry.size : null);
    const mtime = Number.isFinite(entry.mtime) ? entry.mtime : null;
    rows.push({
      path,
      name: path.split("/").pop() || path,
      dir,
      size,
      mtime,
      sizeText: size === null ? "" : formatSize(size),
      ageText: mtime === null ? "" : formatAge(mtime, now),
    });
  }

  const byPath = (a, b) => comparePaths(a.path, b.path);
  const compare = {
    path: byPath,
    size: (a, b) => (b.size ?? -1) - (a.size ?? -1) || byPath(a, b),
    mtime: (a, b) => (b.mtime ?? -1) - (a.mtime ?? -1) || byPath(a, b),
  }[sort] || byPath;

  rows.sort((a, b) => {
    if (dirsFirst && a.dir !== b.dir) {
      return a.dir ? -1 : 1;
    }
    return compare(a, b);
  });

  return {
    rows,
    count: Number.isFinite(listing && listing.count) ? listing.count : rows.length,
    truncated: Boolean(listing && listing.truncated),
  };
}

/** Component-wise path order, so `a/b` sorts before `a/b/c`. */
function comparePaths(a, b) {
  const as = a.split("/");
  const bs = b.split("/");
  const depth = Math.min(as.length, bs.length);
  for (let i = 0; i < depth; i += 1) {
    if (as[i] !== bs[i]) {
      return as[i] < bs[i] ? -1 : 1;
    }
  }
  return as.length - bs.length;
}

/**
 * A `**\/*.bf`-ish glob, as the `files` card's filter box uses it.
 * `**` crosses directories, `*` does not.  A plain substring also matches, so
 * typing `board` finds `core/src/board.c` without knowing the syntax.
 */
export function matchesFilter(path, filter) {
  const want = typeof filter === "string" ? filter.trim() : "";
  if (want === "" || want === "**/*") {
    return true;
  }
  // `**` must be rewritten before `*`; the placeholder keeps the single-`*`
  // pass from eating the `(?:.*/)?` that `**/` degrades into.
  const DOTSTAR = "\u0000";
  const escaped = want
    .replace(/[.+^${}()|[\]\\]/g, "\\$&")
    .replace(/\*\*\//g, DOTSTAR)
    .replace(/\*\*/g, ".*")
    .replace(/\*/g, "[^/]*")
    .replace(/\?/g, "[^/]")
    .split(DOTSTAR)
    .join("(?:.*/)?");
  // A pattern that names directories is anchored at the workspace root, so
  // `core/src/*.c` does not also match `vendor/core/src/x.c`; a bare word stays
  // a substring search, because guessing intent there would be worse.
  const anchored = want.includes("/") ? escaped : `(?:.*/)?${escaped}`;
  try {
    return new RegExp(`^${anchored}$`).test(path) || path.includes(want);
  } catch {
    return path.includes(want);
  }
}

/* ------------------------------------------------------------------ */
/* command line                                                        */
/* ------------------------------------------------------------------ */

/** Split a command line on whitespace, honouring double quotes. */
export function parseCommandLine(line) {
  const text = typeof line === "string" ? line : "";
  const tokens = [];
  let current = "";
  let started = false;
  let quote = false;

  for (let i = 0; i < text.length; i += 1) {
    const ch = text[i];
    if (ch === '"') {
      quote = !quote;
      started = true;
      continue;
    }
    if (!quote && (ch === " " || ch === "\t")) {
      if (started) {
        tokens.push(current);
        current = "";
        started = false;
      }
      continue;
    }
    current += ch;
    started = true;
  }
  if (started) {
    tokens.push(current);
  }
  return tokens;
}

/** `in`/`out` are relative; a number (or `50%`) is absolute. `null` = unusable. */
export function parseZoomArgument(arg, current = 1) {
  const word = typeof arg === "string" ? arg.trim().toLowerCase() : "";
  if (word === "") {
    return null;
  }
  if (word === "in") {
    return current * 1.25;
  }
  if (word === "out") {
    return current / 1.25;
  }
  if (word === "reset") {
    return 1;
  }
  const value = Number(word.endsWith("%") ? word.slice(0, -1) / 100 : word);
  return Number.isFinite(value) && value > 0 ? value : null;
}

/* ------------------------------------------------------------------ */
/* run output                                                          */
/* ------------------------------------------------------------------ */

/**
 * A bounded text accumulator for `exec.output`.
 *
 * Runs can emit unbounded output; keeping all of it would eventually freeze the
 * window, so once the cap is passed the *head* is dropped -- both in characters
 * and in whole lines -- and a marker says how much went.  Recent output is what
 * a build log is read for, which is why it is the tail that survives.
 */
export class OutputBuffer {
  constructor(options = {}) {
    const { maxChars = 200000, maxLines = 2000 } = options;
    this.maxChars = maxChars;
    this.maxLines = maxLines;
    this.text = "";
    this.dropped = 0;
    this.droppedLines = 0;
  }

  append(chunk) {
    if (typeof chunk !== "string" || chunk === "") {
      return;
    }
    this.text += chunk;
    if (this.text.length > this.maxChars) {
      const cut = this.text.length - this.maxChars;
      this.text = this.text.slice(cut);
      this.dropped += cut;
    }
    // Cap whole lines too: a long run of short lines would otherwise grow the
    // DOM without bound even though the character cap was never reached.
    //
    // The splitter must be the one `lines()` renders with.  Counting with
    // plain "\n" while rendering with /\r?\n/ made the cap and the view
    // disagree on every CRLF line -- which is every line a Windows command
    // writes -- so the buffer kept one line more than it claimed to.
    const lines = this.text.split(/\r?\n/);
    if (lines.length > this.maxLines) {
      const cut = lines.length - this.maxLines;
      this.droppedLines += cut;
      // Rejoining with "\n" is deliberate: the retained tail is normalised to
      // LF so that slicing it again is idempotent.
      this.text = lines.slice(cut).join("\n");
    }
  }

  /** The tail of the buffer as whole lines, oldest first. */
  lines() {
    const all = this.text.split(/\r?\n/);
    const head = this.dropped > 0 || this.droppedLines > 0
      ? [`[... ${this.dropped} earlier characters, ${this.droppedLines} earlier lines dropped ...]`]
      : [];
    return head.concat(all);
  }

  clear() {
    this.text = "";
    this.dropped = 0;
    this.droppedLines = 0;
  }

  get length() {
    return this.text.length;
  }
}

/** `exec.exit` -> the short suffix the runner card shows. */
export function formatExit(code) {
  if (code === null || code === undefined) {
    return "running";
  }
  const n = Number(code);
  if (!Number.isFinite(n)) {
    return "exited";
  }
  if (n === 0) {
    return "exit 0";
  }
  return n < 0 ? `killed (${n})` : `exit ${n}`;
}

/* ------------------------------------------------------------------ */
/* the card-kind hook                                                     */
/* ------------------------------------------------------------------ */

/**
 * Every registered kind, in registration order, keyed by `card.kind`.
 *
 * This map is the single extension point of the board's visual vocabulary.
 * It is a hook, not a plugin system: there is no loading, no sandbox, no
 * manifest, no version negotiation and no discovery.  A fork registers its
 * kinds in this file, or in a file it adds next to this one.
 */
const KIND_REGISTRY = new Map();

/**
 * The shape `registerCardKind` accepts.  Documentation, not enforcement --
 * but it is the exact list `selftest.mjs` holds new kinds to.
 *
 * A kind is one object:
 *
 *   kind      string   must equal `card.kind` on the wire
 *   title     string   human name, used by the board's own UI
 *   describe  card => string
 *                      one line for the header; may not throw
 *   render    (card, ctx) => {el, handle, destroy}
 *                      the only required member
 *   create    () => object
 *                      the extra fields a *new* card of this kind starts with
 *
 * `render` gets `ctx = {client, app}` and owns its own DOM.  It reads and
 * writes whatever fields it likes on `card`, which for `sheet` is a nested
 * object rather than a string: nothing in the board, the protocol or the
 * kernel assumes a card's state is text.
 */
export const CARD_KIND_CONTRACT = Object.freeze({
  required: Object.freeze(["kind", "render"]),
  optional: Object.freeze(["title", "describe", "create"]),
});

/**
 * Register one card kind.  Returns the frozen spec, so the caller can hold on
 * to it and see exactly what the registry kept.
 *
 * Re-registering an existing kind throws unless `replace: true` is passed, so
 * a fork that means to override a built-in has to say so.
 */
export function registerCardKind(spec) {
  if (spec === null || typeof spec !== "object") {
    throw new TypeError("registerCardKind: spec must be an object");
  }
  const { kind } = spec;
  if (typeof kind !== "string" || kind === "") {
    throw new TypeError("registerCardKind: spec.kind must be a non-empty string");
  }
  if (typeof spec.render !== "function") {
    throw new TypeError(`registerCardKind: ${kind}.render must be a function`);
  }
  if (KIND_REGISTRY.has(kind) && spec.replace !== true) {
    throw new Error(`registerCardKind: card kind ${JSON.stringify(kind)} is already registered`);
  }
  const frozen = Object.freeze({
    title: kind,
    describe: (card) => `${kind} ${card.id}`,
    create: () => ({}),
    ...spec,
  });
  KIND_REGISTRY.set(kind, frozen);
  return frozen;
}

/** The spec registered for `kind`, or null. */
export function cardKind(kind) {
  return KIND_REGISTRY.get(kind) ?? null;
}

/** Every registered kind name, in registration order. */
export function knownCardKinds() {
  return [...KIND_REGISTRY.keys()];
}

/** One-line description of a card, used by the board header. */
export function describeCard(card) {
  if (card === null || typeof card !== "object") {
    return "no card selected";
  }
  const kind = typeof card.kind === "string" ? card.kind : "?";
  const spec = KIND_REGISTRY.get(kind);
  if (spec !== undefined) {
    try {
      const line = spec.describe(card);
      if (typeof line === "string" && line !== "") {
        return line;
      }
    } catch (err) {
      /* A kind whose describe() throws must not take the whole header down. */
      return `${kind} ${card.id} (describe threw)`;
    }
  }
  return `${kind} ${card.id}`;
}

/** The command line's `help` text. Kept here so README and UI agree. */
export const COMMAND_HELP = [
  "open <path>              open a file in a new editor card",
  "note <text>              drop a note card",
  "sheet [title]            drop a structured-data card (typed cells, not text)",
  "run <cmd>                start a command in a runner card",
  "files [glob]             open the file list card",
  "link <from> <to> [label] connect two cards",
  "unlink <linkId>          remove a connection",
  "zoom <n> | in | out | reset",
  "focus <id>               select and centre a card",
  "delete <id>              remove a card",
  "save                     write the board to .seide/board.json",
];

/* ------------------------------------------------------------------ */
/* the sheet model (pure)                                                 */
/* ------------------------------------------------------------------ */

/**
 * A sheet is structured state, not source text: named columns with types, and
 * rows holding one value per column.  It is the prototype's proof that the
 * board carries arbitrary card payloads -- the kernel stores it verbatim, the
 * board's normaliser clones it verbatim, and the protocol never sees it as a
 * string.  See `docs/SURFACES.md`.
 */
export const SHEET_TYPES = Object.freeze(["text", "number", "bool", "choice"]);

/** Cell values that survive a trip through JSON and back. */
export function coerceSheetValue(type, value) {
  switch (type) {
    case "number": {
      if (typeof value === "number" && Number.isFinite(value)) {
        return value;
      }
      const n = typeof value === "string" ? Number(value.trim()) : NaN;
      return Number.isFinite(n) ? n : 0;
    }
    case "bool":
      return value === true || value === "true" || value === 1;
    default: {
      if (value === null || value === undefined) {
        return "";
      }
      return typeof value === "string" ? value : String(value);
    }
  }
}

/**
 * A fresh one-by-one sheet.
 *
 * `normaliseSheet` treats zero rows as legal (a header-only grid is a real
 * thing to want), but a *new* card has to open with somewhere to type, so the
 * starting point is one column and one row.
 */
export function emptySheet() {
  return normaliseSheet({
    columns: [{ id: "column1", title: "column1", type: "text" }],
    rows: [{ id: "row1", cells: { column1: "" } }],
  });
}

function sheetId(prefix, taken) {
  let n = 1;
  while (taken.has(`${prefix}${n}`)) {
    n += 1;
  }
  return `${prefix}${n}`;
}

/**
 * Repair anything into a usable sheet.  Never throws: a card whose payload was
 * written by an older or a buggier build still has to render.
 */
export function normaliseSheet(doc) {
  const input = doc !== null && typeof doc === "object" ? doc : {};
  const rawColumns = Array.isArray(input.columns) ? input.columns : [];
  const columns = [];
  const columnIds = new Set();
  for (const raw of rawColumns) {
    if (raw === null || typeof raw !== "object") {
      continue;
    }
    let id = typeof raw.id === "string" && raw.id !== "" ? raw.id : sheetId("column", columnIds);
    if (columnIds.has(id)) {
      id = sheetId(id, columnIds);
    }
    const type = SHEET_TYPES.includes(raw.type) ? raw.type : "text";
    const column = { id, title: typeof raw.title === "string" && raw.title !== "" ? raw.title : id, type };
    if (type === "choice") {
      column.options = Array.isArray(raw.options)
        ? raw.options.filter((o) => typeof o === "string")
        : [];
    }
    columnIds.add(id);
    columns.push(column);
  }
  if (columns.length === 0) {
    columns.push({ id: "column1", title: "column1", type: "text" });
  }

  const rawRows = Array.isArray(input.rows) ? input.rows : [];
  const rows = [];
  const rowIds = new Set();
  for (const raw of rawRows) {
    if (raw === null || typeof raw !== "object") {
      continue;
    }
    let id = typeof raw.id === "string" && raw.id !== "" ? raw.id : sheetId("row", rowIds);
    if (rowIds.has(id)) {
      id = sheetId(id, rowIds);
    }
    const given = raw.cells !== null && typeof raw.cells === "object" ? raw.cells : {};
    const cells = {};
    for (const column of columns) {
      cells[column.id] = coerceSheetValue(column.type, given[column.id]);
    }
    rowIds.add(id);
    rows.push({ id, cells });
  }
  return { columns, rows };
}

/**
 * Write a normalised sheet back into the caller's object.
 *
 * Every mutator below works on a normalised copy and then lands the result
 * here, so `card.doc` keeps its identity across edits -- which is what lets the
 * board's dirty flag and `serialize()` see the change without re-registering
 * the card.
 */
function replaceSheet(doc, sheet) {
  doc.columns = sheet.columns;
  doc.rows = sheet.rows;
  return doc;
}

/**
 * One cell's value out of a sheet that is already normalised, or "" when either
 * end of the lookup is missing.
 *
 * The paint loop holds one normalised sheet for the whole grid and must not
 * normalise once per cell, so the lookup is split out of `sheetCell` here.
 */
function sheetCellOf(sheet, rowId, columnId) {
  const row = sheet.rows.find((r) => r.id === rowId);
  if (row === undefined) {
    return "";
  }
  const column = sheet.columns.find((c) => c.id === columnId);
  if (column === undefined) {
    return "";
  }
  return coerceSheetValue(column.type, row.cells[columnId]);
}

/** One cell's value, or "" when either end of the lookup is missing. */
export function sheetCell(doc, rowId, columnId) {
  return sheetCellOf(normaliseSheet(doc), rowId, columnId);
}

/**
 * The one write path for a cell: normalise the document once, hand the cell's
 * current value to `compute`, coerce what comes back by the column's type, and
 * land the copy in `doc` through `replaceSheet`.  Returns the value that was
 * stored, or undefined when the cell is gone.
 *
 * It returns the stored value rather than a flag because a handler that has to
 * show the coerced value ("  2  " -> "2") would otherwise read the cell back
 * through `sheetCell`, normalising the whole document a second time.
 */
function applySheetCell(doc, rowId, columnId, compute) {
  const sheet = normaliseSheet(doc);
  const row = sheet.rows.find((r) => r.id === rowId);
  const column = sheet.columns.find((c) => c.id === columnId);
  if (row === undefined || column === undefined) {
    return undefined;
  }
  const stored = coerceSheetValue(column.type, compute(coerceSheetValue(column.type, row.cells[columnId])));
  row.cells[columnId] = stored;
  replaceSheet(doc, sheet);
  return stored;
}

/**
 * Set one cell, coercing by the column's type so a number column stays numeric
 * on the wire.  Mutates `doc` in place and returns true when the cell existed.
 */
export function setSheetCell(doc, rowId, columnId, value) {
  return applySheetCell(doc, rowId, columnId, () => value) !== undefined;
}

/** Append a row (or insert at `index`), filling every column with its zero value. */
export function addSheetRow(doc, index = -1) {
  const sheet = normaliseSheet(doc);
  const id = sheetId("row", new Set(sheet.rows.map((r) => r.id)));
  const cells = {};
  for (const column of sheet.columns) {
    cells[column.id] = coerceSheetValue(column.type, "");
  }
  const row = { id, cells };
  const at = index < 0 || index >= sheet.rows.length ? sheet.rows.length : index;
  sheet.rows.splice(at, 0, row);
  replaceSheet(doc, sheet);
  return row;
}

/** Remove a row.  The last row may go: an empty sheet is a legal sheet. */
export function removeSheetRow(doc, rowId) {
  const sheet = normaliseSheet(doc);
  const before = sheet.rows.length;
  sheet.rows = sheet.rows.filter((r) => r.id !== rowId);
  const removed = sheet.rows.length !== before;
  if (removed) {
    replaceSheet(doc, sheet);
  }
  return removed;
}

/**
 * Append a column (or insert at `index`).  Every existing row gains a cell,
 * because a row is a map keyed by column id and a half-populated row would
 * make `sheetCell` and the renderer disagree.
 */
export function addSheetColumn(doc, type = "text", index = -1) {
  const sheet = normaliseSheet(doc);
  const id = sheetId("column", new Set(sheet.columns.map((c) => c.id)));
  const column = { id, title: id, type: SHEET_TYPES.includes(type) ? type : "text" };
  if (column.type === "choice") {
    column.options = ["one", "two", "three"];
  }
  const at = index < 0 || index >= sheet.columns.length ? sheet.columns.length : index;
  sheet.columns.splice(at, 0, column);
  for (const row of sheet.rows) {
    row.cells[id] = coerceSheetValue(column.type, "");
  }
  replaceSheet(doc, sheet);
  return column;
}

/** Remove a column and every cell under it.  The last column may not go. */
export function removeSheetColumn(doc, columnId) {
  const sheet = normaliseSheet(doc);
  if (sheet.columns.length <= 1) {
    return false;
  }
  const before = sheet.columns.length;
  sheet.columns = sheet.columns.filter((c) => c.id !== columnId);
  if (sheet.columns.length === before) {
    return false;
  }
  for (const row of sheet.rows) {
    delete row.cells[columnId];
  }
  replaceSheet(doc, sheet);
  return true;
}

/**
 * Write a column's header fields, resolving the column in the LIVE document by
 * id.
 *
 * `columnId` is the only column handle a caller may keep across a write: every
 * write lands a fresh set of column objects in `doc` (`replaceSheet`), so a DOM
 * listener that closed over the column object its paint was handed writes the
 * rename into a sheet the card no longer holds, and the next repaint shows the
 * old title again.
 *
 * `patch.title` and `patch.type` are what the header edits.  A type change
 * re-normalises, because every cell under the column takes the new type and
 * `normaliseSheet` is where that coercion lives.
 *
 * Returns the normalised sheet it wrote back, so a caller can refresh whatever
 * it derives from the sheet without normalising a second time, or null when no
 * column has that id.
 */
export function updateSheetColumn(doc, columnId, patch) {
  let sheet = normaliseSheet(doc);
  const column = sheet.columns.find((c) => c.id === columnId);
  if (column === undefined) {
    return null;
  }
  const input = patch !== null && typeof patch === "object" ? patch : {};
  if (typeof input.title === "string") {
    column.title = input.title;
  }
  if (SHEET_TYPES.includes(input.type) && input.type !== column.type) {
    column.type = input.type;
    if (column.type === "choice") {
      if (!Array.isArray(column.options)) {
        column.options = ["one", "two", "three"];
      }
    } else {
      delete column.options;
    }
    sheet = normaliseSheet(sheet);
  }
  replaceSheet(doc, sheet);
  return sheet;
}

/** "3 rows x 4 columns" out of an already-normalised sheet, singularised. */
function sheetSummaryOf(sheet) {
  const r = sheet.rows.length;
  const c = sheet.columns.length;
  return `${r} row${r === 1 ? "" : "s"} x ${c} column${c === 1 ? "" : "s"}`;
}

/** "3 rows x 4 columns", singularised. */
export function sheetSummary(doc) {
  return sheetSummaryOf(normaliseSheet(doc));
}

/**
 * The sheet as tab-separated text: a header line, then one line per row.
 * This is how structured state leaves the card -- hand it to a runner card,
 * paste it into an editor card, or write it to a file.
 */
export function sheetToTSV(doc) {
  const sheet = normaliseSheet(doc);
  const escape = (value) => String(value).replace(/\t/g, " ").replace(/\r?\n/g, " ");
  const lines = [sheet.columns.map((c) => escape(c.title)).join("\t")];
  for (const row of sheet.rows) {
    lines.push(sheet.columns.map((c) => escape(row.cells[c.id])).join("\t"));
  }
  return `${lines.join("\n")}\n`;
}

/**
 * Grid navigation: the next `{row, column}` index from `{row, column}` moved by
 * `dRow`/`dColumn`, clamped at the edges.  Returns null on an empty sheet.
 */
export function nextSheetSelection(doc, selection, dRow, dColumn) {
  const sheet = normaliseSheet(doc);
  if (sheet.rows.length === 0 || sheet.columns.length === 0) {
    return null;
  }
  const rowCount = sheet.rows.length;
  const columnCount = sheet.columns.length;
  let row = selection === null || typeof selection !== "object" ? 0 : Number(selection.row) || 0;
  let column = selection === null || typeof selection !== "object" ? 0 : Number(selection.column) || 0;
  row = Math.min(rowCount - 1, Math.max(0, row + (Number(dRow) || 0)));
  column = Math.min(columnCount - 1, Math.max(0, column + (Number(dColumn) || 0)));
  return { row, column };
}

/* ------------------------------------------------------------------ */
/* DOM                                                                    */
/* ------------------------------------------------------------------ */

/** Create an element with class names, text, attributes and children. */
function h(tag, className, options = {}) {
  const el = document.createElement(tag);
  if (className) {
    el.className = className;
  }
  if (options.text !== undefined) {
    el.textContent = options.text;
  }
  if (options.attrs) {
    for (const key of Object.keys(options.attrs)) {
      el.setAttribute(key, options.attrs[key]);
    }
  }
  if (options.children) {
    for (const child of options.children) {
      el.append(child);
    }
  }
  return el;
}

/**
 * Wrap a card body in the shell every kind shares: a title bar (the drag
 * handle), the body, and a corner grip (the resize handle).  `main.mjs` binds
 * its pointer gestures to `[data-role="card-title"]` and `[data-role="grip"]`.
 */
function cardShell(card, body, options = {}) {
  const title = h("div", "card-title", { attrs: { "data-role": "card-title" } });
  title.append(h("span", "card-kind", { text: card.kind }));
  const label = h("span", "card-label", { attrs: { "data-role": "card-label" } });
  title.append(label);
  const tools = h("span", "card-tools", { attrs: { "data-role": "card-tools" } });
  title.append(tools);

  const grip = h("div", "card-grip", { attrs: { "data-role": "grip", title: "drag to resize" } });
  const el = h("div", `card card-${card.kind}`, {
    attrs: { "data-card-id": card.id },
    children: [title, body, grip],
  });
  if (options.accent) {
    el.classList.add("is-accent");
  }
  return { el, title, label, tools };
}

/** Fill a `<pre>` with one text node or `<span>` per segment. */
function paintTokens(pre, text, tokens) {
  const segments = applyTokenSpans(text, tokens);
  pre.textContent = "";
  const frag = document.createDocumentFragment();
  for (const seg of segments) {
    const chunk = text.slice(seg.start, seg.end);
    if (seg.kind === "plain") {
      frag.append(document.createTextNode(chunk));
    } else {
      frag.append(h("span", `tok-${seg.kind}`, { text: chunk }));
    }
  }
  pre.append(frag);
  return segments.length;
}

function makeStatus() {
  return h("div", "card-status", { attrs: { "data-role": "card-status" } });
}

/**
 * Build one card.
 *
 * @param {object} card  the board card; its extra fields are the card's state
 * @param {object} ctx   `{client, app}` -- the only way out of a card
 * @returns {{el: HTMLElement, handle: object, destroy: Function}}
 */
export function renderCard(card, ctx) {
  const spec = card !== null && typeof card === "object" && !Array.isArray(card)
    ? KIND_REGISTRY.get(card.kind)
    : undefined;
  return spec === undefined ? renderUnknown(card) : spec.render(card, ctx);
}

/**
 * What to show for a board entry that has no renderer: a kind this build does
 * not know, or -- because board.json is user-editable -- an entry that is not a
 * card at all.
 *
 * Pure and exported on purpose.  This is the one render path that must never
 * throw: one malformed entry in the file must not take the whole canvas down,
 * and its message is therefore worth checking without a browser.
 *
 * @param {object|null|undefined} card
 * @returns {{id: string, kind: string, label: string, message: string}}
 */
export function unknownCardPlaceholder(card) {
  const known = `Known kinds: ${knownCardKinds().join(", ")}.`;
  if (card === null || card === undefined) {
    return {
      id: "",
      kind: "(none)",
      label: "(missing)",
      message: "This board entry is empty (null), so there is nothing to render. "
        + `The entry is preserved in board.json until it is fixed there.  ${known}`,
    };
  }
  if (typeof card !== "object" || Array.isArray(card)) {
    return {
      id: "",
      kind: "(not a card)",
      label: "(malformed)",
      message: `This board entry is ${JSON.stringify(card)}, not a card object. `
        + `The entry is preserved in board.json until it is fixed there.  ${known}`,
    };
  }
  const kind = typeof card.kind === "string" && card.kind !== "" ? card.kind : "(no kind)";
  return {
    id: typeof card.id === "string" ? card.id : "",
    kind,
    label: "(unknown)",
    message: `No renderer for card kind ${JSON.stringify(card.kind)}. `
      + "The card is preserved in board.json; register a kind in cards.mjs."
      + `  ${known}`,
  };
}

/** Unknown kinds are preserved and shown, never silently deleted. */
function renderUnknown(card) {
  const notice = unknownCardPlaceholder(card);
  const body = h("div", "card-body card-body-unknown", {
    children: [h("p", "card-message", { text: notice.message })],
  });
  // `cardShell` reads `id`/`kind` off its argument, so it gets the repaired
  // values rather than the malformed entry: a null still has to produce a card.
  const shell = cardShell({ id: notice.id, kind: notice.kind }, body);
  shell.label.textContent = notice.label;
  return {
    el: shell.el,
    handle: { kind: notice.kind, focus() {} },
    destroy() {},
  };
}

/* -------------------- editor -------------------- */

function renderEditor(card, ctx) {
  const { client, app } = ctx;

  const pre = h("pre", "ed-view", { attrs: { "aria-hidden": "true" } });
  const area = h("textarea", "ed-input", {
    attrs: { spellcheck: "false", autocomplete: "off", wrap: "off" },
  });
  const scroller = h("div", "ed-scroll", { children: [pre] });
  const surface = h("div", "ed-surface", { children: [scroller, area] });
  const status = makeStatus();
  const body = h("div", "card-body card-body-editor", { children: [surface, status] });

  const state = {
    path: typeof card.file === "string" ? card.file : "",
    baseRevision: null,
    dirty: false,
    saving: false,
    tokens: [],
    timer: null,
    tokenSeq: 0,
  };

  const shell = cardShell(card, body);
  shell.label.textContent = state.path || "(no file)";
  shell.label.title = state.path;

  function renderStatus(message) {
    const bits = [];
    if (state.path === "") {
      bits.push("no file — type `open <path>` below");
    } else {
      bits.push(state.path);
      if (state.dirty) {
        bits.push("modified");
      } else if (state.baseRevision !== null) {
        bits.push(`rev ${state.baseRevision}`);
      }
      if (state.saving) {
        bits.push("saving…");
      }
    }
    if (message) {
      bits.push(message);
    }
    status.textContent = bits.join(" · ");
  }

  function repaint() {
    paintTokens(pre, area.value, state.tokens);
    syncScroll();
  }

  function syncScroll() {
    scroller.scrollTop = area.scrollTop;
    scroller.scrollLeft = area.scrollLeft;
  }

  area.addEventListener("scroll", syncScroll);

  /**
   * Re-tokenise and repaint.
   *
   * The textarea is never rewritten, so the caret and the selection survive;
   * only the `<pre>` underneath is replaced.  A stale reply (the user typed
   * while the kernel was answering) is discarded.
   */
  async function tokenizeNow() {
    const text = area.value;
    const path = state.path;
    if (path === "") {
      state.tokens = [];
      repaint();
      return;
    }
    const seq = state.tokenSeq + 1;
    state.tokenSeq = seq;
    let tokens = [];
    try {
      const result = await client.call("lang.tokenize", { path, text });
      tokens = Array.isArray(result && result.tokens) ? result.tokens : [];
    } catch {
      // Colouring is decoration: a failing tokenizer must not disturb editing.
      tokens = [];
    }
    if (seq !== state.tokenSeq || area.value !== text) {
      return;
    }
    state.tokens = tokens;
    repaint();
  }

  function scheduleTokenize() {
    if (state.timer !== null) {
      clearTimeout(state.timer);
    }
    state.timer = setTimeout(() => {
      state.timer = null;
      tokenizeNow();
    }, 120);
  }

  /** Load (or reload) the file. Local edits are only discarded after a prompt. */
  async function load(path, options = {}) {
    const { confirmDiscard = true } = options;
    if (state.dirty && confirmDiscard && !app.confirmDiscard(state.path)) {
      return false;
    }
    state.path = path;
    card.file = path;
    shell.label.textContent = path;
    shell.label.title = path;
    renderStatus("loading…");
    try {
      const result = await client.call("file.read", { path });
      area.value = typeof result.text === "string" ? result.text : "";
      state.baseRevision = result.revision;
      state.dirty = false;
      const parts = ["loaded", result.eol || "lf"];
      if (Number.isFinite(result.size)) {
        parts.push(`${result.size} bytes`);
      }
      renderStatus(parts.join(" · "));
      scheduleTokenize();
      return true;
    } catch (err) {
      renderStatus("could not read");
      app.log("error", `file.read ${path}: ${err.message}`);
      return false;
    }
  }

  /**
   * Write the buffer.
   *
   * `base_revision` is the revision from the last read or write.  If another
   * writer got there first the kernel answers `STALE_REVISION`; nothing is
   * overwritten and the user is asked what to do (`app.resolveStale`).
   */
  async function save() {
    if (state.path === "" || state.saving) {
      return false;
    }
    state.saving = true;
    renderStatus();
    const params = { path: state.path, text: area.value };
    if (state.baseRevision !== null) {
      params.base_revision = state.baseRevision;
    }
    try {
      const result = await client.call("file.write", params);
      state.baseRevision = result.revision;
      state.dirty = false;
      renderStatus("saved");
      app.log("info", `saved ${state.path} (rev ${result.revision})`);
      return true;
    } catch (err) {
      if (client.isStaleRevision(err)) {
        const current = err.data && err.data.current_revision !== undefined
          ? err.data.current_revision
          : null;
        renderStatus(`stale — the file changed on disk (rev ${current})`);
        const choice = await app.resolveStale({ path: state.path, current, cardId: card.id });
        if (choice === "reload") {
          state.saving = false;
          state.dirty = false;
          return load(state.path, { confirmDiscard: false });
        }
        if (choice === "overwrite") {
          state.baseRevision = current;
          state.saving = false;
          return save();
        }
        app.log("warn", `${state.path} not saved; your text is still in the card`);
        return false;
      }
      renderStatus("write failed");
      app.log("error", `file.write ${state.path}: ${err.message}`);
      return false;
    } finally {
      if (state.saving) {
        // Only clear it when we are really finished (the stale path re-enters).
        state.saving = false;
      }
      renderStatus();
    }
  }

  area.addEventListener("input", () => {
    state.dirty = true;
    renderStatus();
    scheduleTokenize();
    app.boardTouched(true);
  });

  area.addEventListener("keydown", (event) => {
    if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "s") {
      event.preventDefault();
      save();
      return;
    }
    // Card-level shortcuts must not fire while typing.
    event.stopPropagation();
  });

  if (state.path !== "") {
    load(state.path, { confirmDiscard: false });
  } else {
    repaint();
    renderStatus();
  }

  return {
    el: shell.el,
    handle: {
      kind: "editor",
      save,
      load,
      focus() {
        area.focus();
      },
      get path() {
        return state.path;
      },
      get dirty() {
        return state.dirty;
      },
      hasPath(path) {
        return state.path === path;
      },
      /** External change: report it, never auto-reload over unsaved edits. */
      onFileChanged(revision) {
        if (revision !== null && revision === state.baseRevision) {
          return;
        }
        renderStatus(`changed on disk (rev ${revision}) — ^S overwrites`);
        app.log("warn", `${state.path} changed on disk (rev ${revision})`);
      },
    },
    destroy() {
      if (state.timer !== null) {
        clearTimeout(state.timer);
      }
      state.tokenSeq += 1;
    },
  };
}

/* -------------------- runner -------------------- */

function renderRunner(card, ctx) {
  const { client, app } = ctx;
  const output = new OutputBuffer();
  const state = {
    runId: card.run_id !== undefined && card.run_id !== null ? card.run_id : null,
    running: false,
    exit: null,
    timer: null,
  };

  const cmdInput = h("input", "run-cmd", {
    attrs: { type: "text", spellcheck: "false", placeholder: "command…" },
  });
  cmdInput.value = typeof card.cmd === "string" ? card.cmd : "";

  const runButton = h("button", "card-button", { text: "run", attrs: { type: "button" } });
  const stopButton = h("button", "card-button", { text: "stop", attrs: { type: "button" } });
  const clearButton = h("button", "card-button", { text: "clear", attrs: { type: "button" } });
  const controls = h("div", "run-controls", {
    children: [cmdInput, runButton, stopButton, clearButton],
  });
  const view = h("pre", "run-out");
  const status = makeStatus();
  const body = h("div", "card-body card-body-runner", { children: [controls, view, status] });

  const shell = cardShell(card, body);
  const exitTag = h("span", "run-exit", { text: formatExit(state.exit) });
  shell.tools.append(exitTag);
  shell.label.textContent = "";

  function paint() {
    view.textContent = output.lines().join("\n");
    view.scrollTop = view.scrollHeight;
    exitTag.textContent = formatExit(state.exit);
    if (state.runId !== null) {
      status.textContent = `run ${state.runId} · ${state.running ? "running" : formatExit(state.exit)}`;
    } else {
      status.textContent = state.exit === null ? "not started" : formatExit(state.exit);
    }
    cmdInput.disabled = state.running;
    stopButton.disabled = !state.running;
  }

  /** Coalesce output into at most one repaint per interval. */
  function schedulePaint() {
    if (state.timer !== null) {
      return;
    }
    state.timer = setTimeout(() => {
      state.timer = null;
      paint();
    }, 60);
  }

  async function start() {
    const cmd = cmdInput.value.trim();
    if (cmd === "") {
      app.log("warn", "run: empty command");
      return;
    }
    if (state.running) {
      app.log("warn", `card ${card.id} is already running`);
      return;
    }
    card.cmd = cmd;
    app.boardTouched(true);
    output.clear();
    state.exit = null;
    paint();
    try {
      const result = await client.call("exec.start", {
        card_id: card.id,
        cmd,
        cwd: typeof card.cwd === "string" && card.cwd !== "" ? card.cwd : ".",
      });
      state.runId = result.run_id;
      state.running = true;
      card.run_id = state.runId;
      app.registerRun(result.run_id, card.id);
      paint();
    } catch (err) {
      status.textContent = `could not start: ${err.message}`;
      app.log("error", `exec.start failed: ${err.message}`);
    }
  }

  async function stop() {
    if (state.runId === null) {
      return;
    }
    try {
      await client.call("exec.stop", { run_id: state.runId });
    } catch (err) {
      app.log("error", `exec.stop failed: ${err.message}`);
    }
  }

  runButton.addEventListener("click", start);
  stopButton.addEventListener("click", stop);
  clearButton.addEventListener("click", () => {
    output.clear();
    paint();
  });
  cmdInput.addEventListener("keydown", (event) => {
    if (event.key === "Enter") {
      event.preventDefault();
      start();
      return;
    }
    event.stopPropagation();
  });
  cmdInput.addEventListener("input", () => {
    card.cmd = cmdInput.value;
    app.boardTouched(true);
  });

  paint();

  return {
    el: shell.el,
    handle: {
      kind: "runner",
      start,
      stop,
      focus() {
        cmdInput.focus();
        cmdInput.select();
      },
      owns(runId) {
        return state.runId !== null && state.runId === runId;
      },
      /**
       * Adopt a run started before its reply landed, so output emitted in that
       * window is not dropped on the floor.
       */
      adopt(runId) {
        if (state.runId !== null && state.runId !== runId) {
          return false;
        }
        state.runId = runId;
        state.running = true;
        card.run_id = runId;
        paint();
        return true;
      },
      output(data) {
        output.append(data);
        schedulePaint();
      },
      exit(code) {
        state.exit = code;
        state.running = false;
        state.runId = null;
        paint();
        app.boardTouched(true);
      },
    },
    destroy() {
      if (state.timer !== null) {
        clearTimeout(state.timer);
      }
    },
  };
}

/* -------------------- note -------------------- */

function renderNote(card, ctx) {
  const { app } = ctx;
  const area = h("textarea", "note-input", {
    attrs: { spellcheck: "false", placeholder: "scratch…" },
  });
  area.value = typeof card.text === "string" ? card.text : "";
  const status = makeStatus();
  const body = h("div", "card-body card-body-note", { children: [area, status] });
  const shell = cardShell(card, body);

  function update() {
    const text = area.value;
    status.textContent = `${text.length} chars · stored in the board`;
    shell.label.textContent = text.split("\n")[0].slice(0, 48);
  }

  area.addEventListener("input", () => {
    card.text = area.value;
    update();
    app.boardTouched(true);
  });
  area.addEventListener("keydown", (event) => {
    event.stopPropagation();
  });
  update();

  return {
    el: shell.el,
    handle: {
      kind: "note",
      focus() {
        area.focus();
      },
    },
    destroy() {},
  };
}

/* -------------------- files -------------------- */

function renderFiles(card, ctx) {
  const { client, app } = ctx;
  const filterInput = h("input", "files-filter", {
    attrs: { type: "text", spellcheck: "false", placeholder: "**/*" },
  });
  filterInput.value = typeof card.filter === "string" && card.filter !== "" ? card.filter : "**/*";
  const list = h("div", "files-list");
  const status = makeStatus();
  const body = h("div", "card-body card-body-files", {
    children: [filterInput, list, status],
  });
  const shell = cardShell(card, body);
  shell.label.textContent = filterInput.value;

  let timer = null;
  let requestSeq = 0;

  async function refresh() {
    const seq = requestSeq + 1;
    requestSeq = seq;
    const filter = filterInput.value.trim() || "**/*";
    status.textContent = "listing…";
    let listing;
    try {
      listing = await client.call("workspace.list", { glob: filter, limit: 4000 });
    } catch (err) {
      status.textContent = `list failed: ${err.message}`;
      return;
    }
    if (seq !== requestSeq) {
      return; // a newer request overtook this one
    }
    const now = Math.floor(Date.now() / 1000);
    const { rows, count, truncated } = formatListing(listing, { now });
    const frag = document.createDocumentFragment();
    for (const row of rows) {
      const button = h("button", `file-row${row.dir ? " is-dir" : ""}`, {
        attrs: { type: "button", title: row.path },
      });
      button.append(h("span", "file-name", { text: row.dir ? `${row.name}/` : row.name }));
      button.append(h("span", "file-meta", {
        text: [row.sizeText, row.ageText].filter(Boolean).join(" "),
      }));
      button.addEventListener("click", () => {
        if (row.dir) {
          filterInput.value = `${row.path}/**/*`;
          card.filter = filterInput.value;
          shell.label.textContent = filterInput.value;
          app.boardTouched(true);
          refresh();
          return;
        }
        app.openFile(row.path);
      });
      frag.append(button);
    }
    list.textContent = "";
    list.append(frag);
    status.textContent = `${rows.length}/${count} entries${truncated ? " · truncated" : ""}`;
  }

  function scheduleRefresh() {
    if (timer !== null) {
      clearTimeout(timer);
    }
    timer = setTimeout(() => {
      timer = null;
      refresh();
    }, 180);
  }

  filterInput.addEventListener("input", () => {
    card.filter = filterInput.value;
    shell.label.textContent = filterInput.value;
    app.boardTouched(true);
    scheduleRefresh();
  });
  filterInput.addEventListener("keydown", (event) => {
    if (event.key === "Escape") {
      filterInput.blur();
    }
    event.stopPropagation();
  });

  refresh();

  return {
    el: shell.el,
    handle: {
      kind: "files",
      refresh,
      focus() {
        filterInput.focus();
        filterInput.select();
      },
    },
    destroy() {
      if (timer !== null) {
        clearTimeout(timer);
      }
      requestSeq += 1;
    },
  };
}

/* -------------------- sheet -------------------- */

/** True when the caret sits at the very start of a text-like control. */
function caretAtStart(node) {
  return typeof node.selectionStart !== "number" || node.selectionStart === 0;
}

/** True when the caret sits at the very end, or the control has no caret. */
function caretAtEnd(node) {
  return typeof node.selectionEnd !== "number" || node.selectionEnd >= node.value.length;
}

/**
 * The structured-data card.
 *
 * Nothing here is a textarea: the card's state is a nested object of columns
 * and rows, each cell a typed control.  The renderer never round-trips that
 * state through a string, which is the whole point -- it is the counterexample
 * to "a card is a file with a cursor".
 */
function renderSheet(card, ctx) {
  const { app } = ctx;
  card.doc = normaliseSheet(card.doc);
  if (typeof card.title !== "string") {
    card.title = "";
  }

  const thead = h("thead");
  const tbody = h("tbody");
  const table = h("table", "sheet-grid", { children: [thead, tbody] });
  const scroll = h("div", "sheet-scroll", { children: [table] });
  const tools = h("div", "sheet-tools", {
    attrs: { "data-role": "sheet-tools" },
  });
  const status = makeStatus();
  const body = h("div", "card-body card-body-sheet", {
    children: [scroll, tools, status],
  });
  const shell = cardShell(card, body);

  const addRowButton = h("button", "sheet-tool", {
    attrs: { type: "button", "data-role": "sheet-add-row" }, text: "+ row",
  });
  const addColumnButton = h("button", "sheet-tool", {
    attrs: { type: "button", "data-role": "sheet-add-column" }, text: "+ column",
  });
  const tsvButton = h("button", "sheet-tool", {
    attrs: { type: "button", "data-role": "sheet-tsv", title: "copy the sheet as TSV" },
    text: "TSV",
  });
  tools.append(addRowButton, addColumnButton, tsvButton);

  /** Focus target that survives a repaint. */
  let lastFocus = null;

  function commit() {
    app.boardTouched(true);
    updateStatus();
  }

  /** Status line for a sheet the caller already normalised. */
  function updateStatusFrom(sheet) {
    status.textContent = `${sheetSummaryOf(sheet)} · structured state, no text`;
    shell.label.textContent = card.title !== "" ? card.title : sheetSummaryOf(sheet);
  }

  function updateStatus() {
    updateStatusFrom(normaliseSheet(card.doc));
  }

  function cellNode(rowIndex, columnIndex) {
    return tbody.querySelector(`[data-cell="${rowIndex}:${columnIndex}"]`);
  }

  function focusCell(selection) {
    if (selection === null) {
      return;
    }
    lastFocus = selection;
    const node = cellNode(selection.row, selection.column);
    if (node !== null) {
      node.focus();
      if (typeof node.select === "function") {
        node.select();
      }
    }
  }

  function moveFrom(event, rowIndex, columnIndex) {
    let dRow = 0;
    let dColumn = 0;
    if (event.key === "ArrowDown" || event.key === "Enter") {
      dRow = 1;
    } else if (event.key === "ArrowUp") {
      dRow = -1;
    } else if (event.key === "ArrowRight" && caretAtEnd(event.target)) {
      dColumn = 1;
    } else if (event.key === "ArrowLeft" && caretAtStart(event.target)) {
      dColumn = -1;
    } else {
      event.stopPropagation();
      return;
    }
    const next = nextSheetSelection(card.doc, { row: rowIndex, column: columnIndex }, dRow, dColumn);
    focusCell(next);
    event.preventDefault();
    event.stopPropagation();
  }

  function bindCellKeys(control, rowIndex, columnIndex) {
    control.addEventListener("keydown", (event) => {
      moveFrom(event, rowIndex, columnIndex);
    });
  }

  function makeCellControl(row, column, rowIndex, columnIndex) {
    /* `row` and `column` belong to the paint's own normalised snapshot, so the
       value below is what `sheetCell(card.doc, ...)` would return, without
       normalising the document once per cell.  The handlers capture ids, never
       these objects: a write hands the document a fresh set of rows and
       columns, so an object captured at paint time is a sheet the card no
       longer holds and a write through it disappears at the next repaint. */
    const rowId = row.id;
    const columnId = column.id;
    const value = coerceSheetValue(column.type, row.cells[columnId]);
    let control;

    if (column.type === "bool") {
      control = h("button", "sheet-toggle", {
        attrs: { type: "button", "data-cell": `${rowIndex}:${columnIndex}` },
      });
      const show = (on) => {
        control.textContent = on ? "true" : "false";
        control.setAttribute("aria-pressed", on ? "true" : "false");
        control.classList.toggle("is-on", on);
      };
      show(value);
      control.addEventListener("click", () => {
        /* Read and write the toggle in one normalise: the stored value comes
           back from the write, so nothing has to look the cell up again. */
        const stored = applySheetCell(card.doc, rowId, columnId, (on) => !on);
        show(stored === undefined ? false : stored);
        commit();
      });
      bindCellKeys(control, rowIndex, columnIndex);
      return control;
    }

    if (column.type === "choice") {
      control = h("select", "sheet-choice", {
        attrs: { "data-cell": `${rowIndex}:${columnIndex}` },
      });
      const options = Array.isArray(column.options) ? column.options.slice() : [];
      if (!options.includes(value)) {
        options.unshift(value);
      }
      for (const option of options) {
        const node = document.createElement("option");
        node.value = option;
        node.textContent = option === "" ? "(empty)" : option;
        control.append(node);
      }
      control.value = value;
      control.addEventListener("change", () => {
        applySheetCell(card.doc, rowId, columnId, () => control.value);
        commit();
      });
      bindCellKeys(control, rowIndex, columnIndex);
      return control;
    }

    control = h("input", "sheet-input", {
      attrs: {
        type: "text",
        spellcheck: "false",
        "data-cell": `${rowIndex}:${columnIndex}`,
      },
    });
    if (column.type === "number") {
      control.setAttribute("inputmode", "decimal");
      control.classList.add("is-number");
    }
    control.value = value === "" ? "" : String(value);
    control.addEventListener("change", () => {
      const stored = applySheetCell(card.doc, rowId, columnId, () => control.value);
      /* Show what the column's type actually stored ("  2  " -> "2"). */
      control.value = stored === undefined ? "" : String(stored);
      commit();
    });
    bindCellKeys(control, rowIndex, columnIndex);
    return control;
  }

  function makeColumnHeader(column, columnIndex) {
    /* `column` is the paint's snapshot; only its id is kept.  Anything the
       handlers below need to change they change in the live document through
       `updateSheetColumn`, which resolves the column by id -- a title typed
       after any cell edit used to land on an object the card had replaced. */
    const columnId = column.id;
    const cell = h("th", "sheet-col", { attrs: { "data-role": "sheet-col" } });

    const titleInput = h("input", "sheet-col-title", {
      attrs: { type: "text", spellcheck: "false", title: "column name" },
    });
    titleInput.value = column.title;
    titleInput.addEventListener("input", () => {
      /* Per keystroke: one normalise, and the status line is refreshed from the
         sheet the write returned instead of normalising a second time. */
      const sheet = updateSheetColumn(card.doc, columnId, { title: titleInput.value });
      if (sheet !== null) {
        updateStatusFrom(sheet);
      }
      app.boardTouched(true);
    });
    titleInput.addEventListener("keydown", (event) => {
      event.stopPropagation();
    });

    const typeSelect = document.createElement("select");
    typeSelect.className = "sheet-col-type";
    typeSelect.setAttribute("title", "column type");
    for (const type of SHEET_TYPES) {
      const option = document.createElement("option");
      option.value = type;
      option.textContent = type;
      typeSelect.append(option);
    }
    typeSelect.value = column.type;
    typeSelect.addEventListener("change", () => {
      /* A type change re-normalises every cell under the column. */
      updateSheetColumn(card.doc, columnId, { type: typeSelect.value });
      paint();
      commit();
    });

    const drop = h("button", "sheet-drop", {
      attrs: { type: "button", title: "remove column" }, text: "\u00d7",
    });
    drop.addEventListener("click", () => {
      if (removeSheetColumn(card.doc, columnId)) {
        paint();
        commit();
      } else {
        app.log("warn", "sheet: a sheet keeps at least one column");
      }
    });

    /* Name and remove share one line; the type selector gets its own, so a
       column reads as "what it is called" then "what it holds". */
    const head = h("div", "sheet-col-head", { children: [titleInput, drop] });
    cell.append(head, typeSelect);
    cell.setAttribute("data-column-index", String(columnIndex));
    return cell;
  }

  function makeRowHeader(row, rowIndex) {
    const rowId = row.id;
    const cell = h("th", "sheet-row-head", { attrs: { "data-role": "sheet-row" } });
    cell.append(h("span", "sheet-row-index", { text: String(rowIndex + 1) }));
    const drop = h("button", "sheet-drop", {
      attrs: { type: "button", title: "remove row" }, text: "\u00d7",
    });
    drop.addEventListener("click", () => {
      removeSheetRow(card.doc, rowId);
      paint();
      commit();
    });
    cell.append(drop);
    return cell;
  }

  function paint() {
    /* Normalise ONCE for the whole grid and paint from that snapshot.
       `sheetCell(doc, ...)` normalises the document it is handed, so calling it
       per cell made a paint cost O(cells x document) -- 2400 cells took ~2 s,
       and a large sheet could freeze the board inside a single paint.  The
       controls read their values out of this snapshot; every write resolves the
       live document by id (see `makeCellControl`). */
    const doc = card.doc;
    const sheet = normaliseSheet(doc);
    thead.textContent = "";
    tbody.textContent = "";

    const headRow = h("tr", "sheet-head-row");
    headRow.append(h("th", "sheet-corner", { attrs: { "data-role": "sheet-corner" } }));
    sheet.columns.forEach((column, columnIndex) => {
      headRow.append(makeColumnHeader(column, columnIndex));
    });
    thead.append(headRow);

    sheet.rows.forEach((row, rowIndex) => {
      const tr = h("tr", "sheet-row", { attrs: { "data-row-id": row.id } });
      tr.append(makeRowHeader(row, rowIndex));
      sheet.columns.forEach((column, columnIndex) => {
        const td = h("td", `sheet-cell is-${column.type}`);
        td.append(makeCellControl(row, column, rowIndex, columnIndex));
        tr.append(td);
      });
      tbody.append(tr);
    });

    if (lastFocus !== null) {
      const wanted = lastFocus;
      lastFocus = null;
      focusCell(wanted);
    }
  }

  addRowButton.addEventListener("click", () => {
    addSheetRow(card.doc);
    paint();
    commit();
  });
  addColumnButton.addEventListener("click", () => {
    addSheetColumn(card.doc);
    paint();
    commit();
  });
  tsvButton.addEventListener("click", () => {
    const tsv = sheetToTSV(card.doc);
    const clipboard = typeof navigator === "object" && navigator !== null ? navigator.clipboard : null;
    if (clipboard !== null && clipboard !== undefined && typeof clipboard.writeText === "function") {
      clipboard.writeText(tsv).then(
        () => app.log("info", `sheet ${card.id}: ${normaliseSheet(card.doc).rows.length} rows copied as TSV`),
        () => {
          app.log("info", "sheet TSV:");
          for (const line of tsv.split("\n")) {
            if (line !== "") {
              app.log("info", line);
            }
          }
        },
      );
      return;
    }
    app.log("info", "sheet TSV:");
    for (const line of tsv.split("\n")) {
      if (line !== "") {
        app.log("info", line);
      }
    }
  });

  paint();
  updateStatus();

  return {
    el: shell.el,
    handle: {
      kind: "sheet",
      repaint: paint,
      focus() {
        focusCell({ row: 0, column: 0 });
      },
    },
    destroy() {},
  };
}

/* ------------------------------------------------------------------ */
/* registrations                                                          */
/* ------------------------------------------------------------------ */

/*
 * The five kinds the prototype ships.  Each registration is self-contained: a
 * fork that wants a different note card replaces this object, not a case in a
 * switch three hundred lines away.  Adding a sixth is one more call, and the
 * board, the command line and the kernel need no change at all -- `card.kind`
 * is already an open string everywhere else.
 */

registerCardKind({
  kind: "editor",
  title: "Editor",
  describe: (card) => `editor ${card.file || "(no file)"}`,
  create: () => ({ file: "" }),
  render: renderEditor,
});

registerCardKind({
  kind: "runner",
  title: "Runner",
  describe: (card) => `runner ${card.cmd || "(no command)"}`,
  create: () => ({ cmd: "", cwd: "" }),
  render: renderRunner,
});

registerCardKind({
  kind: "note",
  title: "Note",
  describe: (card) => `note ${card.id}`,
  create: () => ({ text: "" }),
  render: renderNote,
});

registerCardKind({
  kind: "files",
  title: "Files",
  describe: (card) => `files ${card.filter || "**/*"}`,
  create: () => ({ filter: "**/*" }),
  render: renderFiles,
});

registerCardKind({
  kind: "sheet",
  title: "Sheet",
  describe: (card) => `sheet ${card.title !== "" && card.title !== undefined ? card.title : sheetSummary(card.doc)}`,
  create: () => ({ title: "", doc: emptySheet() }),
  render: renderSheet,
});
