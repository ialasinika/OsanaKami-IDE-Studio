/**
 * cards.mjs -- one renderer and one behaviour set per card kind.
 *
 * DELETE THIS FILE and the board still pans; it just has no cards to put on it.
 * InfantGod Studio has no plugin system: extending the visual vocabulary means forking this
 * file.  What it does have is a *hook* -- `registerCardKind()` -- so that
 * "adding a kind" is one self-contained object instead of an edit to a switch
 * in three places.  Six kinds are registered at the bottom of this file:
 * `editor`, `runner`, `note`, `files`, `project` and `sheet`.
 *
 * `sheet` is there to make the hook honest rather than theoretical.  It is a
 * structured-data editor -- typed cells in a grid, not a textarea -- and it
 * exists to prove that nothing in the board, the protocol or the kernel assumes
 * a card's state is text.  See `docs/SURFACES.md`.
 *
 * `files` answers "what is in this folder"; `project` answers "what is in this
 * *project*, and what do I have open in it".  The second question is the one
 * that makes many-file editing cheap, which is why the panel lists the whole
 * workspace and merges it with the board's editor cards.  See
 * `docs/PROJECT.md`.
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
 * A `**\/*.yarn`-ish glob, as the `files` card's filter box uses it.
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
/* the project view                                                    */
/* ------------------------------------------------------------------ */

/*
 * What the project view can and cannot show.
 *
 * `workspace.list` is the only source of file names here, and the kernel skips
 * whole directories by name while it walks (`IGNORED_DIRS` in
 * `core/src/wksp.c`: `.git`, `.infantgod`, `build`, `node_modules`, ...).  The call
 * has no flag to ask for them, so this side cannot un-hide them -- a panel that
 * filtered them itself would be counting rows that never arrive.
 *
 * So the project view does not filter: it reports what the kernel left out,
 * read from `workspace.info.ignored` (the kernel's own table, so the two can
 * never disagree), and says so when a filter matches nothing.  The `files` card
 * shows the same set for the same reason.
 */

/** `a/b/c.txt` -> `a/b`; a file at the workspace root -> `""`. */
export function dirNameOf(path) {
  const rel = typeof path === "string" ? path.replace(/\\/g, "/") : "";
  const at = rel.lastIndexOf("/");
  return at <= 0 ? "" : rel.slice(0, at);
}

/**
 * Fold `workspace.list` plus the files the board has open into the project
 * view: one row per file, grouped by folder, each carrying its open/dirty
 * state.  Pure -- no DOM, no filesystem -- so `selftest.mjs` can drive it.
 *
 * The project is "the files of this workspace", and the panel exists to make
 * editing many of them convenient: a row that is open jumps to its card, a row
 * that is not opens one, and an editor card whose file is gone from disk is
 * reported as `missing` rather than silently kept.
 *
 * @param {object} listing  the `workspace.list` payload (may be absent)
 * @param {{open?: Array<{id?:string,path?:string,dirty?:boolean}>,
 *          filter?: string, now?: number}} [options]
 * @returns {{groups: Array<{folder:string,label:string,rows:object[]}>,
 *            openRows: object[], missingRows: object[], counts: object}}
 */
export function projectRows(listing, options = {}) {
  const {
    open = [],
    filter = "**/*",
    now = Math.floor(Date.now() / 1000),
  } = options;

  // The open set first: it marks rows and it is what "missing" is built from.
  const openByPath = new Map();
  const openList = [];
  for (const item of Array.isArray(open) ? open : []) {
    if (item === null || typeof item !== "object") {
      continue;
    }
    const path = typeof item.path === "string" ? item.path.replace(/\\/g, "/") : "";
    if (path === "") {
      continue;
    }
    const record = {
      id: typeof item.id === "string" ? item.id : "",
      path,
      name: path.split("/").pop() || path,
      folder: dirNameOf(path),
      dirty: item.dirty === true,
    };
    openList.push(record);
    if (!openByPath.has(path)) {
      openByPath.set(path, record);
    }
  }

  const { rows } = formatListing(listing, { now });
  const onDisk = new Set();
  const byFolder = new Map();
  let files = 0;
  let dirs = 0;

  for (const row of rows) {
    if (row.dir) {
      dirs += 1;
      continue; // folders are the grouping, not a row of their own
    }
    files += 1;
    onDisk.add(row.path);

    const seen = openByPath.get(row.path);
    const entry = {
      path: row.path,
      name: row.name,
      folder: dirNameOf(row.path),
      sizeText: row.sizeText,
      ageText: row.ageText,
      open: seen !== undefined,
      dirty: seen !== undefined && seen.dirty,
      cardId: seen === undefined ? null : seen.id,
    };

    if (!matchesFilter(entry.path, filter)) {
      continue;
    }
    if (!byFolder.has(entry.folder)) {
      byFolder.set(entry.folder, []);
    }
    byFolder.get(entry.folder).push(entry);
  }

  const groups = [];
  for (const folder of [...byFolder.keys()].sort(comparePaths)) {
    const groupRows = byFolder.get(folder);
    groupRows.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
    groups.push({
      folder,
      label: folder === "" ? "(root)" : `${folder}/`,
      rows: groupRows,
    });
  }

  // An open editor whose path is not in the listing is a file that moved or
  // was deleted while its card stayed on the board.  On a truncated listing
  // that judgement is not safe, which the counts record as `complete`.
  const openRows = [];
  const missingRows = [];
  for (const record of openList.slice().sort((a, b) => comparePaths(a.path, b.path))) {
    const summary = { ...record, present: onDisk.has(record.path) };
    openRows.push(summary);
    if (!summary.present) {
      missingRows.push(summary);
    }
  }

  let shown = 0;
  for (const group of groups) {
    shown += group.rows.length;
  }

  return {
    groups,
    openRows,
    missingRows,
    counts: {
      files,
      dirs,
      shown,
      groups: groups.length,
      open: openList.length,
      dirty: openList.filter((row) => row.dirty).length,
      missing: missingRows.length,
      truncated: Boolean(listing && listing.truncated),
      complete: !(listing && listing.truncated),
    },
  };
}

/** The one-line summary of a project view, e.g. `128 files · 6 open`. */
export function projectSummary(counts) {
  const c = counts && typeof counts === "object" ? counts : {};
  const parts = [`${c.files || 0} files`];
  if (c.dirs) {
    parts.push(`${c.dirs} folders`);
  }
  parts.push(`${c.open || 0} open`);
  if (c.dirty) {
    parts.push(`${c.dirty} unsaved`);
  }
  if (c.missing) {
    parts.push(`${c.missing} missing`);
  }
  if (c.truncated) {
    parts.push("listing truncated");
  }
  return parts.join(" · ");
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
  "project [glob]           open the project panel (the workspace as one project)",
  "mod <dir>                幼神 Mod 包卡片（打开目录、列出定义与 Yarn）",
  "problems <dir>           幼神 Mod 校验结果（错误/警告/提示，可跳转）",
  "docs [query]             幼神知识库：136 指令 / 63 函数 / 678 变量 / 1221 节点",
  "link <from> <to> [label] connect two cards",
  "unlink <linkId>          remove a connection",
  "zoom <n> | in | out | reset",
  "focus <id>               select and centre a card",
  "delete <id>              remove a card",
  "save                     write the board to .infantgod/board.json",
  "undo                     take back the last board edit (Ctrl+Z)",
  "redo                     put it back (Ctrl+Shift+Z or Ctrl+Y)",
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

/* -------------------- project -------------------- */

/**
 * The project panel: the one surface that treats the workspace as *one
 * project*.
 *
 * A normal IDE keeps a project so that editing many files is cheap: you can
 * see what the project contains and what you already have open, and you can
 * get from one to the other without hunting for a rectangle on the plane.
 * That is exactly what this card is -- `workspace.list` merged with the
 * board's editor cards -- and it is why it is a card and not a side panel:
 * where it sits is project state like everything else.
 *
 * It deliberately lists the *whole* workspace -- every file the kernel will
 * hand over, not just the ones the filter matches -- because the useful
 * sentence it can say is "this file is gone and a card still points at it",
 * and that needs the whole project.  Its one piece of state is `filter`, which
 * lives on the card and therefore in `.infantgod/board.json`.
 */
function renderProject(card, ctx) {
  const { client, app } = ctx;

  const rootLine = h("div", "project-root");
  const filterInput = h("input", "project-filter", {
    attrs: { type: "text", spellcheck: "false", placeholder: "**/*  (folder glob or a word)" },
  });
  filterInput.value = typeof card.filter === "string" && card.filter !== "" ? card.filter : "**/*";
  const refreshButton = h("button", "project-button", {
    attrs: { type: "button", title: "list the workspace again" },
    text: "refresh",
  });
  const controls = h("div", "project-controls", {
    children: [filterInput, refreshButton],
  });
  const openSection = h("div", "project-section project-open");
  const treeSection = h("div", "project-section project-tree");
  const status = makeStatus();
  const body = h("div", "card-body card-body-project", {
    children: [rootLine, controls, openSection, treeSection, status],
  });
  const shell = cardShell(card, body);

  let timer = null;
  let requestSeq = 0;
  let lastOpenSignature = null;

  /**
   * The directories the kernel never lists, as names (`workspace.info.ignored`).
   * Empty when an older or forked kernel does not report them, in which case the
   * panel simply says less instead of guessing.
   */
  function hiddenDirs() {
    const info = app.workspace();
    const names = info && Array.isArray(info.ignored) ? info.ignored : [];
    return names.filter((name) => typeof name === "string" && name !== "");
  }

  function updateLabel() {
    const filter = filterInput.value.trim() || "**/*";
    shell.label.textContent = filter === "**/*" ? "workspace" : filter;
  }

  /** What the board has open, as one string: the panel re-lists only on change. */
  function openSignature() {
    const parts = [];
    for (const entry of app.openEditors()) {
      parts.push(`${entry.id}:${entry.path}:${entry.dirty ? 1 : 0}`);
    }
    return parts.join("|");
  }

  function renderRoot() {
    const info = app.workspace();
    if (info === null || info === undefined) {
      rootLine.textContent = "workspace: the path was not reported by the kernel";
      return;
    }
    const name = typeof info.name === "string" && info.name !== "" ? info.name : info.root;
    rootLine.textContent = `${name} — ${info.root}`;
    // The tooltip is where "why is build/ missing?" gets answered: the kernel
    // skips these directory names while it walks and says so in this list.
    const hidden = hiddenDirs();
    rootLine.title = hidden.length === 0
      ? String(info.root)
      : `${info.root}\nnot listed by the kernel: ${hidden.join(", ")}`;
  }

  /** Open a project file: an existing card is revealed, a new one is placed. */
  function openProjectFile(path) {
    const card_ = app.openFile(path, { at: { x: card.x + card.w + 400, y: card.y + 240 } });
    if (card_ !== null && card_ !== undefined) {
      app.revealCard(card_.id);
    }
  }

  /** One row of the open list: click reveals the card, the x closes it. */
  function openRow(entry) {
    const classes = ["project-row", "is-open"];
    if (entry.dirty) {
      classes.push("is-dirty");
    }
    if (!entry.present) {
      classes.push("is-missing");
    }
    const row = h("div", classes.join(" "));
    const button = h("button", "project-file", { attrs: { type: "button", title: entry.path } });
    button.append(h("span", "project-name", { text: entry.name }));
    button.append(h("span", "project-meta", {
      text: [
        entry.folder === "" ? "" : `${entry.folder}/`,
        entry.dirty ? "unsaved" : "",
        entry.present ? "" : "file is gone",
      ].filter(Boolean).join(" · "),
    }));
    button.addEventListener("click", () => openProjectFile(entry.path));
    row.append(button);
    if (entry.id !== "") {
      const close = h("button", "project-close", {
        attrs: { type: "button", title: `take the card for ${entry.path} off the board (the file is not touched)` },
        text: "\u00d7",
      });
      close.addEventListener("click", (event) => {
        event.stopPropagation();
        app.closeCard(entry.id);
      });
      row.append(close);
    }
    return row;
  }

  /** One row of the tree: click opens the file, or reveals it if it is open. */
  function treeRow(entry) {
    const classes = ["project-row"];
    if (entry.open) {
      classes.push("is-open");
    }
    if (entry.dirty) {
      classes.push("is-dirty");
    }
    const row = h("div", classes.join(" "));
    const button = h("button", "project-file", { attrs: { type: "button", title: entry.path } });
    button.append(h("span", "project-dot", { text: entry.open ? "\u25cf" : "" }));
    button.append(h("span", "project-name", { text: entry.name }));
    button.append(h("span", "project-meta", {
      text: [entry.dirty ? "unsaved" : "", entry.sizeText, entry.ageText].filter(Boolean).join(" "),
    }));
    button.addEventListener("click", () => openProjectFile(entry.path));
    row.append(button);
    return row;
  }

  function renderOpen(result) {
    openSection.textContent = "";
    if (result.openRows.length === 0) {
      openSection.append(h("div", "project-empty", { text: "nothing open yet — click a file below" }));
      return;
    }
    openSection.append(h("div", "project-heading", { text: `open · ${result.openRows.length}` }));
    for (const entry of result.openRows) {
      openSection.append(openRow(entry));
    }
  }

  function renderTree(result) {
    treeSection.textContent = "";
    if (result.groups.length === 0) {
      // A filter that matches nothing is usually a filter aimed at a directory
      // the kernel does not hand over, so name those directories here.
      const hidden = hiddenDirs();
      const why = result.counts.files === 0
        ? "this workspace has no files"
        : "no file matches the filter";
      treeSection.append(h("div", "project-empty", {
        text: hidden.length === 0 || result.counts.files === 0
          ? why
          : `${why} · the kernel does not list ${hidden.join(", ")}`,
      }));
      return;
    }
    for (const group of result.groups) {
      treeSection.append(h("div", "project-heading", { text: group.label }));
      for (const entry of group.rows) {
        treeSection.append(treeRow(entry));
      }
    }
  }

  async function refresh() {
    const seq = requestSeq + 1;
    requestSeq = seq;
    const filter = filterInput.value.trim() || "**/*";
    status.textContent = "listing…";
    let listing;
    try {
      listing = await client.call("workspace.list", { glob: "**/*", limit: 4000 });
    } catch (err) {
      status.textContent = `list failed: ${err.message}`;
      return;
    }
    if (seq !== requestSeq) {
      return; // a newer request overtook this one
    }
    const result = projectRows(listing, {
      open: app.openEditors(),
      filter,
    });
    lastOpenSignature = openSignature();
    renderRoot();
    renderOpen(result);
    renderTree(result);
    status.textContent = projectSummary(result.counts)
      + (result.counts.complete ? "" : " · truncated, so “missing” may over-report");
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

  // The board is the source of truth for what is open, so opening or closing
  // an editor anywhere -- a command, the files card, this panel -- re-lists.
  // The signature check keeps a pan (which re-renders every card) from
  // re-listing, and a pan happens on every animation frame.
  const off = app.onBoardChanged(() => {
    if (openSignature() === lastOpenSignature) {
      return;
    }
    refresh();
  });

  filterInput.addEventListener("input", () => {
    card.filter = filterInput.value;
    updateLabel();
    app.boardTouched(true);
    scheduleRefresh();
  });
  filterInput.addEventListener("keydown", (event) => {
    if (event.key === "Escape") {
      filterInput.blur();
    }
    event.stopPropagation();
  });
  refreshButton.addEventListener("click", () => refresh());

  updateLabel();
  refresh();

  return {
    el: shell.el,
    handle: {
      kind: "project",
      refresh,
      /** Re-point the filter from outside (the `project <glob>` command). */
      setFilter(value) {
        const text = typeof value === "string" && value.trim() !== "" ? value.trim() : "**/*";
        if (filterInput.value !== text) {
          filterInput.value = text;
          card.filter = text;
          updateLabel();
          app.boardTouched(true);
        }
        refresh();
      },
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
      off();
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
/* 《幼神》 mod surfaces                                                  */
/* ------------------------------------------------------------------ */

/*
 * Three card kinds that make this board a mod IDE for 《幼神》 instead of a
 * generic canvas.  All three are read-mostly: they call the shell's `mod.*`
 * verbs (which own the game knowledge) and hand paths to the `editor` card
 * that already exists.  None of them reaches the kernel directly, and none of
 * them needs a kernel change, because a card's payload is stored verbatim.
 */

/** Count diagnostics by severity; anything unrecognised counts as info. */
export function diagCounts(diagnostics) {
  const counts = { error: 0, warning: 0, info: 0 };
  for (const diagnostic of Array.isArray(diagnostics) ? diagnostics : []) {
    const raw = diagnostic && typeof diagnostic.severity === "string" ? diagnostic.severity : "";
    const severity = Object.prototype.hasOwnProperty.call(counts, raw) ? raw : "info";
    counts[severity] += 1;
  }
  return counts;
}

/** A define list grouped by type, types and names in alphabetical order. */
export function groupDefines(defines) {
  const byType = new Map();
  for (const define of Array.isArray(defines) ? defines : []) {
    const type = define && typeof define.type === "string" ? define.type : "(unknown)";
    if (!byType.has(type)) byType.set(type, []);
    byType.get(type).push(define);
  }
  return [...byType.entries()]
    .sort((a, b) => a[0].localeCompare(b[0]))
    .map(([type, items]) => ({
      type,
      items: items.slice().sort((a, b) => String(a.techName ?? "").localeCompare(String(b.techName ?? ""))),
    }));
}

/** The headline a `mod` card shows for an opened package. */
export function modHeadline(opened) {
  if (opened === null || typeof opened !== "object") {
    return "no mod opened";
  }
  const manifest = opened.manifest ?? {};
  const name = typeof manifest.name === "string" && manifest.name !== "" ? manifest.name : "(unnamed)";
  const version = typeof manifest.version === "string" && manifest.version !== "" ? manifest.version : "?";
  const order = typeof manifest.loadOrder === "number" ? manifest.loadOrder : "?";
  const game = typeof manifest.gameVersion === "string" && manifest.gameVersion !== "" ? manifest.gameVersion : "?";
  return `${name} ${version} — loadOrder ${order} · gameVersion ${game}`;
}

/**
 * Join a mod-relative path onto its root, so a card can hand the result to
 * `app.openFile`.  Absolute paths are left alone: `mod.*` results are
 * root-relative, but a fork that ever returns absolute ones still works.
 */
export function modPath(root, rel) {
  if (typeof rel !== "string" || rel === "") {
    return "";
  }
  const clean = rel.replace(/\\/g, "/");
  if (clean.startsWith("/") || /^[A-Za-z]:/.test(clean)) {
    return clean;
  }
  const base = typeof root === "string" ? root.replace(/\\/g, "/").replace(/\/+$/, "") : "";
  return base === "" ? clean : `${base}/${clean}`;
}

/** The file a diagnostic points at, without its `#json/pointer` suffix. */
export function diagFile(diagnostic) {
  const raw = diagnostic && typeof diagnostic.path === "string" ? diagnostic.path : "";
  return raw.split("#")[0];
}

/** Where inside that file the diagnostic sits, or the empty string. */
export function diagWhere(diagnostic) {
  const raw = diagnostic && typeof diagnostic.path === "string" ? diagnostic.path : "";
  const hash = raw.indexOf("#");
  return hash < 0 ? "" : raw.slice(hash + 1);
}

function button(label, title, onClick) {
  const el = h("button", "card-button", { text: label, attrs: { type: "button", title } });
  el.addEventListener("click", onClick);
  return el;
}

/**
 * A collapsible-looking section: a heading plus clickable rows.  Every row is
 * `{label, meta, onClick, severity}`; a row without `onClick` is inert text,
 * and `severity` tints it with the shared `.sev-*` colours.
 */
function section(className, title, count) {
  const head = h("div", "mod-section-title", { text: count === undefined ? title : `${title} (${count})` });
  const rows = h("div", "mod-rows");
  return { el: h("div", `mod-section ${className}`, { children: [head, rows] }), rows };
}

function fillRows(container, rows) {
  const frag = document.createDocumentFragment();
  for (const row of rows) {
    const classes = ["mod-row"];
    if (row.dir) classes.push("is-dir");
    if (row.severity) classes.push(`sev-${row.severity}`);
    const el = h(row.onClick ? "button" : "div", classes.join(" "), {
      attrs: row.onClick ? { type: "button", title: row.title ?? "" } : {},
    });
    el.append(h("span", "mod-row-name", { text: row.label }));
    if (row.meta !== undefined && row.meta !== "") {
      el.append(h("span", "mod-row-meta", { text: row.meta }));
    }
    if (row.onClick) {
      el.addEventListener("click", row.onClick);
    }
    frag.append(el);
  }
  container.textContent = "";
  container.append(frag);
}

/* -- kind: mod -- the package itself ---------------------------------- */

function renderMod(card, ctx) {
  const { client, app } = ctx;

  const dirInput = h("input", "mod-dir", {
    attrs: { type: "text", spellcheck: "false", placeholder: "Mods/MyMod" },
  });
  dirInput.value = typeof card.dir === "string" ? card.dir : "";

  const openButton = button("open", "read mod.json and list the package", () => refresh());
  const validateButton = button("validate", "check every define and Yarn file", () => validate());
  const controls = h("div", "mod-controls", { children: [dirInput, openButton, validateButton] });

  const headline = h("div", "mod-headline");
  const counts = h("div", "mod-counts");
  const modJsonSection = section("mod-manifest", "mod.json");
  const definesSection = section("mod-defines", "Defines");
  const yarnSection = section("mod-yarn", "Yarn");
  const status = makeStatus();

  const body = h("div", "card-body card-body-mod", {
    children: [controls, headline, counts, modJsonSection.el, definesSection.el, yarnSection.el, status],
  });
  const shell = cardShell(card, body);
  shell.label.textContent = dirInput.value === "" ? "(no dir)" : dirInput.value;

  let requestSeq = 0;

  async function openMod() {
    const dir = dirInput.value.trim();
    if (dir === "") {
      status.textContent = "give a mod directory first";
      return;
    }
    const seq = requestSeq + 1;
    requestSeq = seq;
    status.textContent = "opening…";
    let opened;
    try {
      opened = await client.call("mod.open", { dir });
    } catch (err) {
      status.textContent = `open failed: ${err.message}`;
      return;
    }
    if (seq !== requestSeq) {
      return;
    }

    card.dir = dir;
    shell.label.textContent = dir;
    headline.textContent = modHeadline(opened);
    const summary = opened.summary ?? {};
    counts.textContent = [
      `${summary.defines ?? 0} defines`,
      `${summary.yarnFiles ?? summary.yarn ?? 0} yarn`,
      `${summary.csvFiles ?? summary.csv ?? 0} csv`,
      `${summary.sprites ?? 0} sprites`,
    ].join(" · ");

    const manifest = opened.manifest ?? {};
    fillRows(modJsonSection.rows, Object.keys(manifest).map((key) => ({
      label: key,
      meta: typeof manifest[key] === "object" ? JSON.stringify(manifest[key]) : String(manifest[key]),
    })));

    const root = opened.root ?? dir;
    const grouped = groupDefines(opened.defines);
    fillRows(definesSection.rows, grouped.flatMap((group) => [
      { label: group.type, meta: `${group.items.length}`, title: group.type },
      ...group.items.map((item) => ({
        label: `  ${item.techName}`,
        meta: item.path ?? "",
        title: item.path ?? "",
        onClick: item.path ? () => app.openFile(modPath(root, item.path)) : undefined,
      })),
    ]));

    const yarnFiles = Array.isArray(opened.yarnFiles) ? opened.yarnFiles : [];
    fillRows(yarnSection.rows, yarnFiles.map((entry) => {
      const rel = typeof entry === "string" ? entry : entry.path;
      return {
        label: typeof rel === "string" ? rel.split("/").pop() : String(rel),
        meta: typeof rel === "string" ? rel.split("/").slice(0, -1).join("/") : "",
        title: rel,
        onClick: () => app.openFile(modPath(root, rel)),
      };
    }));

    status.textContent = `opened ${opened.root ?? dir}`;
    app.boardTouched(true);
  }

  async function validate() {
    const dir = dirInput.value.trim();
    if (dir === "") {
      status.textContent = "give a mod directory first";
      return;
    }
    status.textContent = "validating…";
    let report;
    try {
      report = await client.call("mod.validate", { root: dir });
    } catch (err) {
      status.textContent = `validate failed: ${err.message}`;
      return;
    }
    const s = report.summary ?? {};
    const counts2 = diagCounts(report.diagnostics);
    status.textContent = `${s.files ?? 0} files · ${counts2.error} errors · ${counts2.warning} warnings · ${counts2.info} infos`;
    app.log(counts2.error === 0 ? "info" : "warn",
      `${dir}: ${counts2.error} errors, ${counts2.warning} warnings, ${counts2.info} infos`);
  }

  openButton.addEventListener("click", () => openMod());
  dirInput.addEventListener("keydown", (event) => {
    event.stopPropagation();
    if (event.key === "Enter") {
      openMod();
    }
  });

  if (dirInput.value !== "") {
    openMod();
  } else {
    status.textContent = "open a mod directory, e.g. Mods/MyMod";
  }

  return {
    el: shell.el,
    handle: {
      kind: "mod",
      focus() {
        dirInput.focus();
      },
      refresh: openMod,
      setDir(dir) {
        dirInput.value = typeof dir === "string" ? dir : "";
        return openMod();
      },
      root() {
        return dirInput.value.trim();
      },
    },
    destroy() {},
  };
}

/* -- kind: problems -- validation output ------------------------------ */

function renderProblems(card, ctx) {
  const { client, app } = ctx;

  const rootInput = h("input", "problems-root", {
    attrs: { type: "text", spellcheck: "false", placeholder: "Mods/MyMod" },
  });
  rootInput.value = typeof card.root === "string" ? card.root : "";

  const runButton = button("validate", "validate the package and its Yarn", () => run());
  const controls = h("div", "mod-controls", { children: [rootInput, runButton] });
  const summaryEl = h("div", "mod-counts");
  const list = h("div", "mod-rows problems-rows");
  const status = makeStatus();

  const body = h("div", "card-body card-body-problems", {
    children: [controls, summaryEl, list, status],
  });
  const shell = cardShell(card, body);
  shell.label.textContent = rootInput.value === "" ? "(no mod)" : rootInput.value;

  function paint(diagnostics, root) {
    const counts = diagCounts(diagnostics);
    summaryEl.textContent = `${counts.error} errors · ${counts.warning} warnings · ${counts.info} infos`;
    const order = { error: 0, warning: 1, info: 2 };
    const sorted = (Array.isArray(diagnostics) ? diagnostics : [])
      .slice()
      .sort((a, b) => (order[a?.severity] ?? 3) - (order[b?.severity] ?? 3));
    fillRows(list, sorted.map((diagnostic) => {
      const where = diagWhere(diagnostic);
      const target = diagFile(diagnostic);
      return {
        label: `${diagnostic?.code ?? "?"} ${diagnostic?.message ?? ""}`,
        meta: where === "" ? target : `${target} ${where}`,
        title: diagnostic?.message ?? "",
        severity: diagnostic?.severity ?? "info",
        onClick: target === "" ? undefined : () => app.openFile(modPath(root, target)),
      };
    }));
    if (sorted.length === 0) {
      list.append(h("div", "mod-row mod-row-empty", { text: "nothing to report" }));
    }
  }

  async function run() {
    const root = rootInput.value.trim();
    if (root === "") {
      status.textContent = "give a mod directory first";
      return;
    }
    status.textContent = "validating…";
    let report;
    try {
      report = await client.call("mod.validate", { root });
    } catch (err) {
      status.textContent = `validate failed: ${err.message}`;
      return;
    }
    card.root = root;
    shell.label.textContent = root;
    paint(report.diagnostics, root);
    const counts = diagCounts(report.diagnostics);
    status.textContent = `${report.summary?.files ?? 0} files checked`;
    app.log(counts.error === 0 ? "info" : "warn",
      `${root}: ${counts.error} errors, ${counts.warning} warnings`);
  }

  rootInput.addEventListener("keydown", (event) => {
    event.stopPropagation();
    if (event.key === "Enter") {
      run();
    }
  });

  if (rootInput.value !== "") {
    run();
  } else {
    status.textContent = "validate a mod directory, e.g. Mods/MyMod";
  }

  return {
    el: shell.el,
    handle: {
      kind: "problems",
      focus() {
        rootInput.focus();
      },
      run,
      root() {
        return rootInput.value.trim();
      },
    },
    destroy() {},
  };
}

/* -- kind: docs -- the knowledge base --------------------------------- */

function renderDocs(card, ctx) {
  const { client } = ctx;

  const queryInput = h("input", "docs-query", {
    attrs: { type: "text", spellcheck: "false", placeholder: "Love, jump, Aistalt, Goods_Folk…" },
  });
  queryInput.value = typeof card.query === "string" ? card.query : "";

  const hbButton = button("window", "what the game hooks into", () => loadWindow());
  const controls = h("div", "mod-controls", { children: [queryInput, hbButton] });
  const list = h("div", "mod-rows docs-rows");
  const doc = h("pre", "docs-text");
  const status = makeStatus();

  const body = h("div", "card-body card-body-docs", {
    children: [controls, list, doc, status],
  });
  const shell = cardShell(card, body);
  shell.label.textContent = queryInput.value === "" ? "knowledge base" : queryInput.value;

  let requestSeq = 0;

  async function show(kind, name) {
    status.textContent = `reading ${kind} ${name}…`;
    try {
      const text = await client.call("mod.docFor", { kind, name });
      doc.textContent = typeof text === "string" ? text : String(text ?? "");
      doc.scrollTop = 0;
      status.textContent = `${kind} ${name}`;
    } catch (err) {
      status.textContent = `doc failed: ${err.message}`;
    }
  }

  async function search() {
    const query = queryInput.value.trim();
    const seq = requestSeq + 1;
    requestSeq = seq;
    if (query === "") {
      await loadWindow();
      return;
    }
    card.query = query;
    shell.label.textContent = query;
    status.textContent = "searching…";
    let hits;
    try {
      hits = await client.call("mod.search", { query, limit: 80 });
    } catch (err) {
      status.textContent = `search failed: ${err.message}`;
      return;
    }
    if (seq !== requestSeq) {
      return;
    }
    const items = Array.isArray(hits) ? hits : (hits?.results ?? []);
    fillRows(list, items.map((hit) => ({
      label: hit.name ?? hit.label ?? "?",
      meta: hit.kind ?? "",
      title: hit.detail ?? hit.documentation ?? "",
      onClick: () => show(hit.kind ?? "command", hit.name ?? hit.label),
    })));
    status.textContent = `${items.length} hit${items.length === 1 ? "" : "s"}`;
  }

  async function loadWindow() {
    status.textContent = "reading the knowledge base…";
    let stats;
    try {
      stats = await client.call("mod.stats", {});
    } catch (err) {
      status.textContent = `knowledge base unavailable: ${err.message}`;
      return;
    }
    const keys = Object.keys(stats ?? {});
    fillRows(list, keys.map((key) => ({
      label: key,
      meta: String(stats[key]),
      title: `${key} = ${stats[key]}`,
    })));
    let types = [];
    try {
      types = await client.call("mod.types", {});
    } catch {
      types = [];
    }
    fillRows(list, [
      ...keys.map((key) => ({ label: key, meta: String(stats[key]) })),
      ...(Array.isArray(types) ? types : []).map((type) => ({
        label: type.type,
        meta: `${type.count ?? 0} baseline`,
        title: `required: ${(type.required ?? []).join(", ")}`,
        onClick: () => show("type", type.type),
      })),
    ]);
    doc.textContent = "";
    status.textContent = "search the knowledge base, or click a type";
  }

  queryInput.addEventListener("keydown", (event) => {
    event.stopPropagation();
    if (event.key === "Enter") {
      search();
    }
  });
  queryInput.addEventListener("input", () => {
    if (queryInput.value.trim() === "") {
      loadWindow();
    }
  });

  if (queryInput.value !== "") {
    search();
  } else {
    loadWindow();
  }

  return {
    el: shell.el,
    handle: {
      kind: "docs",
      focus() {
        queryInput.focus();
      },
      search,
      show,
      query() {
        return queryInput.value.trim();
      },
    },
    destroy() {},
  };
}

/* ------------------------------------------------------------------ */
/* registrations                                                          */
/* ------------------------------------------------------------------ */

/*
 * The kinds this fork ships: the prototype's six, plus the three 幼神 surfaces
 * at the bottom.  Each registration is self-contained: a fork that wants a
 * different note card replaces this object, not a case in a switch three
 * hundred lines away.  Adding one is one more call, and the board, the command
 * line and the kernel need no change at all -- `card.kind` is already an open
 * string everywhere else.
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
  kind: "project",
  title: "Project",
  describe: (card) => `project ${card.filter || "**/*"}`,
  create: () => ({ filter: "**/*" }),
  render: renderProject,
});

registerCardKind({
  kind: "sheet",
  title: "Sheet",
  describe: (card) => `sheet ${card.title !== "" && card.title !== undefined ? card.title : sheetSummary(card.doc)}`,
  create: () => ({ title: "", doc: emptySheet() }),
  render: renderSheet,
});

/* -- the three 幼神 surfaces ------------------------------------------ */

registerCardKind({
  kind: "mod",
  title: "Mod",
  describe: (card) => `mod ${card.dir || "(no dir)"}`,
  create: () => ({ dir: "" }),
  render: renderMod,
});

registerCardKind({
  kind: "problems",
  title: "Problems",
  describe: (card) => `problems ${card.root || "(no mod)"}`,
  create: () => ({ root: "" }),
  render: renderProblems,
});

registerCardKind({
  kind: "docs",
  title: "Docs",
  describe: (card) => `docs ${card.query || "(knowledge base)"}`,
  create: () => ({ query: "" }),
  render: renderDocs,
});
