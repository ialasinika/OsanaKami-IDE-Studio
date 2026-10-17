/**
 * cards.mjs -- one renderer and one behaviour set per card kind.
 *
 * DELETE THIS FILE and the document still opens; it just has no cards to show.
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

/*
 * The story card is built on `story.mjs` rather than on a copy of it.  That
 * parser is the only thing here that knows what a `.yarn` line *is* -- it is
 * verified byte-for-byte against the game's own mod tree -- and a second
 * reading of the format is a second answer that drifts.
 *
 * It imports three pure modules and nothing else: `story.mjs` for what a `.yarn`
 * line is, `storycsv.mjs` for what the game's translation tables say about one, and
 * `ysls.mjs` for the mod's own command schema.  Everything else a card needs
 * arrives through `ctx`, which is what keeps a card from reaching past the board.
 */
import {
  lineIdOf,
  nextLineId,
  parseStory,
  serializeStory,
  setLineRaw,
  setLineSpeaker,
  setLineText,
  storyAbout,
  storyLines,
  storyNodes,
} from "./story.mjs";
import {
  lockOf,
  parseCsv,
  rowFor,
  rowState,
  rowsById,
  serializeCsv,
} from "./storycsv.mjs";
import {
  applyCommand,
  commandTypedAt,
  completeYsls,
  parseYsls,
  yslsAbout,
  yslsSignature,
} from "./ysls.mjs";
/*
 * The pixel card holds no format knowledge of its own: `pixelpng.mjs` is the
 * whole PNG codec, and the board document never sees a pixel.
 */
import {
  blankImage,
  decodePng,
  encodePng,
  pixelAt,
  setPixelAt,
} from "./pixelpng.mjs";

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
 * typing `view` finds `core/src/view.c` without knowing the syntax.
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
  "story <path>             open a .yarn file as nodes and lines, not text",
  "pixel <path.png> [w] [h]     draw a PNG: pixels are the file, not the board",
  "run <cmd>                start a command in a runner card",
  "files [glob]             open the file list card",
  "project [glob]           open the project panel (the workspace as one project)",
  "mod <dir>                幼神 Mod 包卡片（打开目录、列出定义与 Yarn）",
  "problems <dir>           幼神 Mod 校验结果（错误/警告/提示，可跳转）",
  "docs [query]             幼神知识库：136 指令 / 63 函数 / 678 变量 / 1221 节点",
  "link <from> <to> [label] connect two cards",
  "unlink <linkId>          remove a connection",
  "focus <id>               select and centre a card",
  "delete <id>              remove a card",
  "save                     write the board to .infantgod/board.json",
  "undo                     take back the last board edit (Ctrl+Z)",
  "redo                     put it back (Ctrl+Shift+Z or Ctrl+Y)",
  "mode classic|mod        which way of looking at the same document",
  "log                      show or hide the message strip",
  "help                     list these commands (and open the strip to show them)",
  "clear                    empty the message strip",
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

/* -------------------- story -------------------- */

/*
 * The story card's model, exported for the same reason the sheet's is: a card's
 * edit paths have to be able to run under Node, with no DOM, or they are only
 * ever checked by a person clicking.  The renderer below calls these and never
 * reaches into the parsed tree itself.
 */

/** The node at `nodeIndex`, or null when there is no such node. */
function storyNodeAt(story, nodeIndex) {
  const nodes = story !== null && typeof story === "object" && Array.isArray(story.nodes)
    ? story.nodes
    : [];
  const index = Number(nodeIndex);
  const inside = Number.isInteger(index) && index >= 0 && index < nodes.length;
  return inside ? nodes[index] : null;
}

/**
 * Every `#line:` id in the file, in file order.
 *
 * The game finds a line's text by hashing its id, so "did this edit move an id"
 * is the question that decides whether a save is safe -- and it can only be
 * asked of all of them at once.  The view reports an id only where the parser
 * recognised the tag run; an id sitting in the line's bytes is taken just the
 * same, and a new line must not be handed it.
 */
export function storyLineIds(story) {
  const ids = [];
  const nodes = story !== null && typeof story === "object" && Array.isArray(story.nodes)
    ? story.nodes
    : [];
  for (const node of nodes) {
    for (const line of storyLines(node)) {
      const id = typeof line.id === "string" ? line.id : lineIdOf(line.raw);
      if (typeof id === "string") {
        ids.push(id);
      }
    }
  }
  return ids;
}

/**
 * Replace one line's speaker, keeping its colon and everything after it.
 *
 * False for a line that is not dialogue: a speaker is a dialogue line's, and
 * renaming one that is not there would rewrite text nobody pointed at.
 */
export function storySetSpeaker(story, nodeIndex, lineIndex, speaker) {
  const node = storyNodeAt(story, nodeIndex);
  return node !== null && setLineSpeaker(node, lineIndex, speaker) !== null;
}

/** Replace one dialogue line's text, keeping its indent, tags and comment. */
export function storySetText(story, nodeIndex, lineIndex, text) {
  const node = storyNodeAt(story, nodeIndex);
  return node !== null && setLineText(node, lineIndex, text) !== null;
}

/**
 * The text a line is edited as.
 *
 * A dialogue line is edited as its words; the speaker, the tags and the id stay
 * where they are, which is what `setLineText` promises.  A `<<command>>` line has
 * no words to edit -- it *is* the command -- so its whole line is the field, minus
 * the indent, because the indent belongs to the file and writing it twice would
 * move the line.  A command's indent is not in `line.indent` (the parser only
 * fills that for the lines it splits), so it is read off the raw line.
 */
export function storyEditableText(line) {
  if (line === null || typeof line !== "object") {
    return "";
  }
  if (line.kind === "command") {
    const raw = typeof line.raw === "string" ? line.raw : "";
    return raw.replace(/^[ \t]+/, "");
  }
  return line.text === null || line.text === undefined ? "" : String(line.text);
}

/**
 * Write back what a line was edited as, on the kind of line it is.
 *
 * A command is rewritten whole and re-parsed, so a line whose text stops being a
 * command stops being one -- the parser decides, not the card.
 */
export function storyWriteText(story, nodeIndex, lineIndex, line, text) {
  if (line === null || typeof line !== "object") {
    return false;
  }
  if (line.kind === "command") {
    const raw = typeof line.raw === "string" ? line.raw : "";
    const indent = /^[ \t]*/.exec(raw)[0];
    const node = storyNodeAt(story, nodeIndex);
    return node !== null && setLineRaw(node, lineIndex, `${indent}${String(text)}`) !== null;
  }
  return storySetText(story, nodeIndex, lineIndex, text);
}

/**
 * What an author could be typing, from the mod's own command schema.
 *
 * Empty for a caret that is not inside a `<<...>>` name, which is most of the
 * time: a suggestion list that appeared while somebody typed prose would be
 * worse than none.  Pure -- the card calls it on every keystroke and it reads the
 * line, the caret and the schema, and nothing else.
 */
export function storySuggestions(line, caret, schema, limit = 8) {
  const text = storyEditableText(line);
  if (schema === null || typeof schema !== "object") {
    return { text, caret, items: [] };
  }
  const spot = commandTypedAt(text, caret);
  if (spot === null) {
    return { text, caret, items: [] };
  }
  return { text, caret, items: completeYsls(schema, spot.prefix, limit) };
}

/** The line as it would read after a suggestion is taken, and where the caret goes. */
export function storyAcceptSuggestion(line, caret, name) {
  return applyCommand(storyEditableText(line), caret, name);
}

/**
 * The words a translation table would hold for this line.
 *
 * A game table's `text` column is the whole spoken line -- `Aistalt: Hi.`, the
 * speaker, the colon and the words -- while the parser splits those apart, so
 * anything comparing the two has to put them back together the same way the
 * game writes them.  A line with no speaker is its own words.
 */
export function storyLineText(line) {
  const words = line === null || line === undefined || line.text === null
    ? ""
    : String(line.text);
  const speaker = line === null || line === undefined ? null : line.speaker;
  if (typeof speaker !== "string" || speaker === "") {
    return words;
  }
  return `${speaker}: ${words}`;
}

/**
 * The row a new line needs in the table that is open beside it.
 *
 * The id is the one the line was just given, which is the only thing the story
 * and the table share.  `file` and `node` are copied from the rows already in
 * the table, and `lineNumber` continues the highest one: the game writes the
 * author's own absolute path into `file`, so a card on this machine has no
 * honest way to invent it.  The text is the source words and the lock is the
 * hash of exactly those, which is what makes the row read `untranslated` until
 * somebody translates it and `stale` the day the line changes under it.
 *
 * Null when there is nothing to write: no table, no such line, no id.
 */
export function storyRowForLine(story, nodeIndex, lineIndex, table) {
  if (table === null || typeof table !== "object" || !Array.isArray(table.rows)) {
    return null;
  }
  const node = storyNodeAt(story, nodeIndex);
  const lines = node === null ? [] : storyLines(node);
  const line = lines[lineIndex];
  if (line === undefined) {
    return null;
  }
  const id = typeof line.id === "string" ? line.id : lineIdOf(line.raw);
  if (typeof id !== "string" || id === "") {
    return null;
  }
  const text = storyLineText(line);
  const title = node.title === null || node.title === undefined ? "" : String(node.title);

  let file = "";
  let nodeName = "";
  let lineNumber = 0;
  let highest = 0;
  for (const row of table.rows) {
    const at = Number.parseInt(row.lineNumber, 10);
    if (Number.isInteger(at) && at > highest) {
      highest = at;
    }
    if (title === "" || row.node !== title) {
      continue;
    }
    if (file === "") file = row.file;
    if (nodeName === "") nodeName = row.node;
    if (Number.isInteger(at) && at > lineNumber) lineNumber = at;
  }
  if (file === "" && table.rows.length > 0) {
    file = table.rows[0].file;
  }
  if (file === "") {
    file = table.file === undefined ? "" : String(table.file);
  }

  return {
    language: table.rows.length > 0 ? table.rows[0].language : "",
    id: `line:${id}`,
    text,
    file,
    node: nodeName === "" ? title : nodeName,
    lineNumber: lineNumber > 0 ? lineNumber + 1 : highest + 1,
    lock: lockOf(text),
    comment: "",
  };
}

/**
 * The dialogue line a new line borrows its shape from: the nearest one at or
 * above `at`, else the nearest one below it, else none.
 */
function storyAnchorLine(node, at) {
  const lines = storyLines(node);
  for (let index = Math.min(lines.length - 1, at - 1); index >= 0; index -= 1) {
    if (lines[index].kind === "dialogue") {
      return lines[index];
    }
  }
  for (let index = Math.max(0, at); index < lines.length; index += 1) {
    if (lines[index].kind === "dialogue") {
      return lines[index];
    }
  }
  return null;
}

/**
 * The characters a new line needs before its speaker: the indentation and, on
 * an option line, the `=>`.  The view does not carry the arrow as a field of
 * its own, and reading it back off the raw line is how the file already reads.
 */
function storyLineHead(line) {
  if (line === null) {
    return "";
  }
  const rest = line.raw.slice(line.indent.length);
  const arrow = /^(=>\s*)/.exec(rest);
  return `${line.indent}${arrow === null ? "" : arrow[1]}`;
}

/**
 * Insert one dialogue line at `at`, with an id no line in the file already has.
 *
 * `story.mjs` has no insert -- a line is its text plus the id it was written
 * with -- so this writes that text into the node's body and lets the caller
 * re-parse it.  Serialising and parsing again is the identity for every line
 * the user did not touch, and hand-building the entry record here would be a
 * second, drifting idea of what a line is.
 *
 * Returns the index the line landed on, or -1 when the node is not there.
 */
export function storyAddLine(story, nodeIndex, at, text = "") {
  const node = storyNodeAt(story, nodeIndex);
  if (node === null || !Array.isArray(node.bodyLines)) {
    return -1;
  }
  const count = node.bodyLines.length;
  const index = Math.min(Math.max(Number.isInteger(at) ? at : count, 0), count);
  const anchor = storyAnchorLine(node, index);
  const id = nextLineId(storyLineIds(story));
  const head = storyLineHead(anchor);
  const speaker = anchor === null || anchor.speaker === null
    ? "Narrator"
    : anchor.speaker;
  const body = String(text) === "" ? "" : ` ${String(text)}`;
  const raw = `${head}${speaker}:${body} #line:${id}`;
  node.bodyLines.splice(index, 0, { raw, edit: null });
  return index;
}

/* -------------------- moving a file in chunks -------------------- */

/**
 * Bytes one `file.blobRead` or `file.blobAppend` call carries.
 *
 * `SDE_BLOB_MAX_CHUNK`: a frame carries at most this many decoded bytes and a
 * chunk over it is refused rather than truncated, so the limit is the kernel's
 * and this is the client's half of it.  The game's own translation tables are
 * 4.5-5.75 MB (`NewProject_RU.csv` is 5,751,617 bytes) and `file.read` refuses
 * anything over 4 MiB, so a table moves through a blob session instead: a
 * mebibyte a call is six calls for the largest table the game ships, no single
 * frame big enough to matter, and no call that asks for the whole file.
 */
export const BLOB_CHUNK_BYTES = 1024 * 1024;

/** base64 to bytes.  `atob` is the page's decoder; `Buffer` is not here. */
export function bytesFromBase64(base64) {
  const binary = atob(String(base64));
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) {
    bytes[i] = binary.charCodeAt(i);
  }
  return bytes;
}

/** Bytes to base64.  `btoa` is the page's encoder and wants a binary string. */
export function base64FromBytes(bytes) {
  let binary = "";
  const step = 0x8000;
  for (let i = 0; i < bytes.length; i += step) {
    binary += String.fromCharCode.apply(null, bytes.subarray(i, i + step));
  }
  return btoa(binary);
}

/** The chunk size a caller asked for, never more than one frame may carry. */
function chunkBytesOf(options) {
  const wanted = Number.isFinite(options.chunkBytes)
    ? Math.floor(options.chunkBytes)
    : BLOB_CHUNK_BYTES;
  if (wanted < 1) {
    throw new Error(`a chunk of ${options.chunkBytes} bytes is not a chunk`);
  }
  return Math.min(wanted, BLOB_CHUNK_BYTES);
}

/**
 * Read a text file through a `file.blob*` read session.
 *
 * `file.read` carries a file inside one JSON string and refuses anything over
 * 4 MiB, which is every translation table the game ships; a session moves the
 * file in frames instead, and the kernel never holds the whole thing at once.
 * The session is opened once, read until `eof`, and aborted whatever happens --
 * including when a frame fails -- because a session left open holds a file.
 *
 * The bytes are decoded with a STREAMING decoder, so a frame that ends in the
 * middle of a character is completed by the next one instead of becoming a
 * replacement mark, and the final `decode()` flushes the character the last
 * frame may have left open.
 *
 * Returns `{ text, size, revision, chunks }`.  Every way this can go wrong -- a
 * missing file or a refused frame, a session the kernel has forgotten, a frame
 * served from the wrong offset, a frame longer than one may be -- throws an
 * Error whose message is the sentence to show.  There is no partial result: the
 * caller either gets the whole file or gets nothing, because half a translation
 * table shown as the table is the card lying about the mod.
 */
export async function readTextInChunks(client, path, options = {}) {
  const chunkBytes = chunkBytesOf(options);
  const onProgress = typeof options.onProgress === "function" ? options.onProgress : () => {};
  const decoder = new TextDecoder("utf-8", { stream: true });
  const parts = [];

  /* `want_revision` is how a table's base revision is learned: `file.stat`
     reports 0 for a file too large to read whole. */
  const opened = await client.call("file.blobOpen", { path, mode: "read", want_revision: true });
  const session = opened.session;
  const size = Number(opened.size);
  if (!Number.isInteger(size) || size < 0) {
    throw new Error(`the kernel reported a size of ${opened.size} for ${path}`);
  }

  let offset = 0;
  let chunks = 0;
  let eof = false;
  onProgress(0, size);
  try {
    while (!eof) {
      let frame;
      try {
        frame = await client.call("file.blobRead", { session, offset, length: chunkBytes });
      } catch (err) {
        throw new Error(`frame at byte ${offset}: ${err.message}`);
      }

      /* The reply says where the bytes begin.  A kernel that served the wrong
         offset would hand back bytes already read, which reads as a table that
         is fine and is not, so the echo is checked rather than trusted. */
      if (Number(frame.offset) !== offset) {
        throw new Error(`asked for byte ${offset} and got byte ${frame.offset}`);
      }

      let bytes;
      try {
        bytes = bytesFromBase64(frame.data === undefined ? "" : frame.data);
      } catch (err) {
        throw new Error(`the base64 at byte ${offset}: ${err.message}`);
      }
      if (bytes.length > chunkBytes) {
        throw new Error(`the kernel sent ${bytes.length} bytes for a ${chunkBytes} byte frame at byte ${offset}`);
      }

      if (bytes.length === 0) {
        /* Asking past the end is not an error: the answer is an empty frame and
           `eof`.  A kernel that says "not the end" while sending nothing has
           stopped with bytes still to come, and a shorter table passed off as
           the table is the thing this reader exists to refuse. */
        if (frame.eof === true || offset >= size) {
          break;
        }
        throw new Error(`the read stopped at byte ${offset} of ${size}`);
      }

      parts.push(decoder.decode(bytes, { stream: true }));
      offset += bytes.length;
      chunks += 1;
      onProgress(offset, size);

      /* `eof` ends it; the offset reaching the size the kernel last reported is
         the same answer from a kernel that forgets to set it.  A file that grew
         while it was read moves that size on, so the reading follows it. */
      eof = frame.eof === true || offset >= size;
    }
  } finally {
    /* The session holds the file open, so it goes away on every path -- and a
       kernel that has already forgotten it is not worth a second error. */
    try {
      await client.call("file.blobAbort", { session });
    } catch (err) {
      /* the read's own error is the one to report */
    }
  }

  /* Flush: the last frame may have ended in the middle of a character. */
  parts.push(decoder.decode());
  return { text: parts.join(""), size, revision: opened.revision, chunks };
}

/**
 * Write text through a `file.blob*` write session.
 *
 * The bytes are the file, so the text is encoded once, sliced into frames the
 * kernel accepts, appended, and published with `file.blobCommit`, whose
 * `total_size` is the client's own statement that nothing was left out -- the
 * kernel publishes only when it equals the bytes actually written.  A refused
 * commit leaves the session open, so the error the caller sees is the kernel's
 * own sentence; the session is aborted on the way out either way, which takes
 * the session's temporary file with it.
 *
 * Returns `{ size, revision, replaced, chunks }`; `revision` is the next
 * `base_revision` for the file, the number `file.read` would report for it.
 */
export async function writeTextInChunks(client, path, text, options = {}) {
  const chunkBytes = chunkBytesOf(options);
  const onProgress = typeof options.onProgress === "function" ? options.onProgress : () => {};
  const bytes = new TextEncoder().encode(text);
  const params = { path, mode: "write" };
  if (options.baseRevision !== undefined && options.baseRevision !== null) {
    params.base_revision = options.baseRevision;
  }

  const opened = await client.call("file.blobOpen", params);
  const session = opened.session;
  let offset = 0;
  let chunks = 0;
  onProgress(0, bytes.length);
  try {
    while (offset < bytes.length) {
      const frame = bytes.subarray(offset, offset + chunkBytes);
      const appended = await client.call("file.blobAppend", {
        session, data: base64FromBytes(frame), offset,
      });
      const moved = Number(appended.offset);
      if (!Number.isInteger(moved) || moved !== offset + frame.length) {
        throw new Error(`appended ${frame.length} bytes at byte ${offset} and the kernel reported byte ${appended.offset}`);
      }
      offset = moved;
      chunks += 1;
      onProgress(offset, bytes.length);
    }
    const committed = await client.call("file.blobCommit", { session, total_size: bytes.length });
    return {
      size: bytes.length,
      revision: committed.revision,
      replaced: committed.replaced === true,
      chunks,
    };
  } finally {
    try {
      await client.call("file.blobAbort", { session });
    } catch (err) {
      /* committed above, or the write's own error is the one to report */
    }
  }
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

/**
 * Fill a `<pre>` with one text node or `<span>` per segment.
 *
 * `hits` (from `findMatches`) widen each segment with a flag, and every matched
 * piece is wrapped in a `<mark>` so it shows through the transparent textarea
 * above.  `current` is the match the find bar is standing on.
 */
function paintTokens(pre, text, tokens, hits = [], current = -1) {
  const segments = markHits(applyTokenSpans(text, tokens), hits, current);
  pre.textContent = "";
  const frag = document.createDocumentFragment();
  for (const seg of segments) {
    const chunk = text.slice(seg.start, seg.end);
    let node;
    if (seg.kind === "plain") {
      node = document.createTextNode(chunk);
    } else {
      node = h("span", `tok-${seg.kind}`, { text: chunk });
    }
    if (seg.hit) {
      node = h("mark", seg.current ? "ed-hit is-current" : "ed-hit", {
        attrs: { "data-role": "find-hit" },
        children: [node],
      });
    }
    frag.append(node);
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

/* -------------------- editing text -------------------- */

/** One indent step: four spaces, the step the tree's C and JS already use. */
export const INDENT_UNIT = "    ";

/** A line ending in one of these opens a block, so the next line steps in. */
const BLOCK_OPENERS = "{([";

/** Clamp to a real position in `text`, and never return an inverted range. */
function clampRange(text, start, end) {
  const limit = text.length;
  const from = Math.max(0, Math.min(limit, Number.isFinite(start) ? Math.trunc(start) : 0));
  const to = Math.max(from, Math.min(limit, Number.isFinite(end) ? Math.trunc(end) : from));
  return { from, to };
}

/**
 * Indent or outdent the lines the selection touches, and say what to select
 * afterwards.
 *
 * Pure, so `selftest.mjs` can check every branch without a browser.  A caret
 * with nothing selected gets one step inserted in place; anything else is
 * line-wise, which is what makes Tab repeatable while a region stays selected.
 * Outdenting removes one tab or up to one step of leading spaces, never a
 * character that was not indentation.
 *
 * @param {string} text
 * @param {number} start  selection start (a string index, not a byte offset)
 * @param {number} end    selection end
 * @param {{unit?: string, outdent?: boolean}} [options]
 * @returns {{text: string, selectionStart: number, selectionEnd: number}}
 */
export function indentSelection(text, start, end, options = {}) {
  const { unit = INDENT_UNIT, outdent = false } = options;
  const { from, to } = clampRange(text, start, end);
  if (!outdent && from === to) {
    return {
      text: text.slice(0, from) + unit + text.slice(from),
      selectionStart: from + unit.length,
      selectionEnd: from + unit.length,
    };
  }
  const regionStart = text.lastIndexOf("\n", from - 1) + 1;
  // A selection that stops just past a newline does not reach into the next
  // line, so that line is left alone.
  const tail = to > from && text[to - 1] === "\n" ? to - 1 : to;
  const newline = text.indexOf("\n", tail);
  const regionEnd = newline === -1 ? text.length : newline;
  const lines = text.slice(regionStart, regionEnd).split("\n").map((line) => {
    if (!outdent) {
      return unit + line;
    }
    if (line.startsWith("\t")) {
      return line.slice(1);
    }
    let cut = 0;
    while (cut < unit.length && line[cut] === " ") {
      cut += 1;
    }
    return line.slice(cut);
  });
  const body = lines.join("\n");
  return {
    text: text.slice(0, regionStart) + body + text.slice(regionEnd),
    selectionStart: regionStart,
    selectionEnd: regionStart + body.length,
  };
}

/**
 * What to insert after a newline: the line's own indentation, plus one step
 * when that line opens a block.  `lineBefore` is the text between the start of
 * the line and the caret.
 *
 * Deliberately one-way: a closing brace does not step back out, because the
 * guess would be wrong as often as it is right.
 */
export function indentAfterEnter(lineBefore, options = {}) {
  const { unit = INDENT_UNIT } = options;
  const match = /^[ \t]*/.exec(lineBefore);
  const indent = match === null ? "" : match[0];
  const trimmed = lineBefore.replace(/\s+$/, "");
  if (trimmed === "" || !BLOCK_OPENERS.includes(trimmed.slice(-1))) {
    return indent;
  }
  return indent + unit;
}

/**
 * Every literal occurrence of `query`, left to right, never overlapping.
 *
 * Case-insensitive unless asked otherwise -- and case-sensitive anyway when
 * folding would change the string's length, because the offsets this returns
 * index the original text and must stay valid.
 *
 * @returns {Array<{start: number, end: number}>}
 */
export function findMatches(text, query, options = {}) {
  const { caseSensitive = false } = options;
  if (typeof query !== "string" || query === "" || typeof text !== "string") {
    return [];
  }
  const folded = text.toLowerCase();
  const foldable = folded.length === text.length && query.toLowerCase().length === query.length;
  const useCase = caseSensitive || !foldable;
  const haystack = useCase ? text : folded;
  const needle = useCase ? query : query.toLowerCase();
  const hits = [];
  let at = haystack.indexOf(needle);
  while (at !== -1) {
    hits.push({ start: at, end: at + needle.length });
    at = haystack.indexOf(needle, at + needle.length);
  }
  return hits;
}

/** Replace one match in place; `hit` comes from `findMatches`. */
export function replaceMatchAt(text, hit, replacement) {
  if (hit === null || hit === undefined || hit.start < 0 || hit.end > text.length) {
    return text;
  }
  return text.slice(0, hit.start) + replacement + text.slice(hit.end);
}

/** Replace every match at once, and report how many there were. */
export function replaceAllMatches(text, query, replacement, options = {}) {
  const hits = findMatches(text, query, options);
  if (hits.length === 0) {
    return { text, count: 0 };
  }
  let out = "";
  let at = 0;
  for (const hit of hits) {
    out += text.slice(at, hit.start) + replacement;
    at = hit.end;
  }
  return { text: out + text.slice(at), count: hits.length };
}

/**
 * Split coloured segments so each piece carries its own find-hit flag, which is
 * how a match stays visible behind the transparent textarea while the caret is
 * somewhere else entirely.
 *
 * `hits` must be ascending and non-overlapping, as `findMatches` returns them.
 * Pure, so the selftest can check the seam cases.
 *
 * @param {Array<{start: number, end: number, kind: string}>} segments
 * @param {Array<{start: number, end: number}>} hits
 * @param {number} [current]  index into `hits` of the match being visited
 * @returns {Array<{start: number, end: number, kind: string, hit: boolean, current: boolean}>}
 */
export function markHits(segments, hits, current = -1) {
  const marks = Array.isArray(hits) ? hits : [];
  const out = [];
  for (const seg of segments) {
    let at = seg.start;
    for (let index = 0; index < marks.length; index += 1) {
      const hit = marks[index];
      if (hit.end <= at) {
        continue;
      }
      if (hit.start >= seg.end) {
        break;
      }
      const from = Math.max(hit.start, at);
      const to = Math.min(hit.end, seg.end);
      if (from > at) {
        out.push({ start: at, end: from, kind: seg.kind, hit: false, current: false });
      }
      out.push({ start: from, end: to, kind: seg.kind, hit: true, current: index === current });
      at = to;
    }
    if (at < seg.end) {
      out.push({ start: at, end: seg.end, kind: seg.kind, hit: false, current: false });
    }
  }
  return out;
}

/* -------------------- editor -------------------- */

function renderEditor(card, ctx) {
  const { client, app } = ctx;

  const pre = h("pre", "ed-view", { attrs: { "aria-hidden": "true" } });
  const area = h("textarea", "ed-input", {
    attrs: { spellcheck: "false", autocomplete: "off", wrap: "off" },
  });
  const scroller = h("div", "ed-scroll", { children: [pre] });
  /*
   * Line numbers, on by default: the first thing anyone asks about a diagnostic
   * is which line it is on, and that answer should not cost a click.  A click
   * on the gutter turns them off for the sessions where the columns matter
   * more.  The numbers are one text node in a <pre> carrying the code's own
   * font, line height and top padding, so line N lands on line N with no
   * per-row layout at all -- only the textarea's vertical scroll is mirrored.
   */
  const gutterNumbers = h("pre", "ed-gutter-numbers", { attrs: { "aria-hidden": "true" } });
  const gutter = h("div", "ed-gutter", {
    attrs: {
      "data-role": "gutter", "data-on": "on", "data-lines": "1", "aria-hidden": "true",
      title: "line numbers \u2014 click to hide",
    },
    children: [gutterNumbers],
  });
  const surface = h("div", "ed-surface has-gutter", { children: [gutter, scroller, area] });

  /* The find bar.  It is part of the card, not a browser dialog: everything
     here has to keep working offline, and a modal would swallow the caret. */
  const findQuery = h("input", "ed-find-input", {
    attrs: {
      type: "text", placeholder: "find", spellcheck: "false", autocomplete: "off",
      "data-role": "find-query", "aria-label": "find in this file",
    },
  });
  const findCount = h("span", "ed-find-count", {
    attrs: { "data-role": "find-count", "aria-live": "polite" },
  });
  const findPrev = h("button", "ed-find-btn", {
    text: "\u2191",
    attrs: { type: "button", title: "previous match (shift+enter)", "data-role": "find-prev" },
  });
  const findNext = h("button", "ed-find-btn", {
    text: "\u2193",
    attrs: { type: "button", title: "next match (enter)", "data-role": "find-next" },
  });
  const findClose = h("button", "ed-find-btn", {
    text: "\u00d7",
    attrs: { type: "button", title: "close the find bar (esc)", "data-role": "find-close" },
  });
  const replaceText = h("input", "ed-find-input", {
    attrs: {
      type: "text", placeholder: "replace with", spellcheck: "false", autocomplete: "off",
      "data-role": "replace-text", "aria-label": "replace with",
    },
  });
  const replaceOne = h("button", "ed-find-btn ed-find-wide", {
    text: "replace",
    attrs: { type: "button", title: "replace this match", "data-role": "replace-one" },
  });
  const replaceAll = h("button", "ed-find-btn ed-find-wide", {
    text: "all",
    attrs: { type: "button", title: "replace every match", "data-role": "replace-all" },
  });
  const findBar = h("div", "ed-find", {
    attrs: { hidden: "", "data-role": "find-bar" },
    children: [
      h("div", "ed-find-row", { children: [findQuery, findCount, findPrev, findNext, findClose] }),
      h("div", "ed-find-row", { children: [replaceText, replaceOne, replaceAll] }),
    ],
  });

  const status = makeStatus();
  const body = h("div", "card-body card-body-editor", { children: [findBar, surface, status] });

  const state = {
    path: typeof card.file === "string" ? card.file : "",
    baseRevision: null,
    dirty: false,
    saving: false,
    tokens: [],
    timer: null,
    tokenSeq: 0,
    findOpen: false,
    hits: [],
    hitIndex: -1,
    // The line-number gutter: on unless the reader hid it, and the line count
    // the numbers were painted for.
    gutterOn: true,
    gutterLines: 0,
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

  /**
   * The numbers are one text node.  A file's line count only changes when a
   * newline is added or removed, so the string is rebuilt then and not on every
   * keystroke; the gutter never lays out a row per line.
   */
  function paintGutter() {
    const lines = area.value === "" ? 1 : area.value.split("\n").length;
    if (state.gutterLines !== lines) {
      let text = "1";
      for (let n = 2; n <= lines; n++) {
        text += `\n${n}`;
      }
      gutterNumbers.textContent = text;
      state.gutterLines = lines;
    }
    gutter.dataset.lines = String(lines);
  }

  function showGutter(on) {
    state.gutterOn = on === true;
    gutter.dataset.on = state.gutterOn ? "on" : "off";
    // Hiding the gutter hands its columns back to the code, so the scroller and
    // the textarea move left again -- they are inset behind it, one width.
    surface.classList.toggle("has-gutter", state.gutterOn);
    surface.classList.toggle("no-gutter", !state.gutterOn);
    gutter.title = state.gutterOn ? "line numbers \u2014 click to hide" : "line numbers \u2014 click to show";
  }

  gutter.addEventListener("mousedown", (event) => {
    event.preventDefault();
    showGutter(!state.gutterOn);
    app.log("info", `line numbers ${state.gutterOn ? "on" : "off"}`);
  });

  function repaint() {
    paintTokens(pre, area.value, state.tokens, state.hits, state.hitIndex);
    paintGutter();
    syncScroll();
  }

  /**
   * Bookkeeping for the edits this card makes itself (indent, auto-indent,
   * replace): the same work the `input` event does, plus the selection the
   * operation asked to restore.
   */
  function edited(message, selectionStart, selectionEnd) {
    if (selectionStart !== undefined) {
      area.setSelectionRange(selectionStart, selectionEnd === undefined ? selectionStart : selectionEnd);
    }
    state.dirty = true;
    renderStatus(message);
    scheduleTokenize();
    app.boardTouched(true);
    syncFind({ reveal: false });
  }

  /**
   * Insert text through the browser's own editing command, if it will.
   *
   * Writing `.value` directly throws the textarea's undo stack away, which
   * would mean that one press of Tab costs the user every earlier Ctrl+Z in
   * that card.  `document.execCommand("insertText")` is deprecated, but it is
   * the only remaining way to make the edit an undoable user edit, and this
   * window only ever runs on Chromium.  Returns false when the command is
   * missing or refused, so the caller can fall back to a plain write.
   */
  function typeIn(text) {
    try {
      if (typeof document.execCommand === "function") {
        return document.execCommand("insertText", false, text) === true;
      }
    } catch {
      // Nothing to do here: the fallback below keeps the buffer correct.
    }
    return false;
  }

  /**
   * Replace the whole buffer and restore the selection the operation asked for.
   * The text goes in as one user edit when the browser cooperates, so a single
   * Ctrl+Z takes the whole operation back rather than clearing the undo stack.
   *
   * @returns {boolean} whether the browser's own insert path was used
   */
  function rewrite(nextText, selectionStart, selectionEnd, message) {
    let typed = false;
    if (nextText !== area.value) {
      area.select();
      typed = typeIn(nextText);
      if (!typed) {
        area.value = nextText;
      }
    }
    edited(message, selectionStart, selectionEnd);
    return typed;
  }

  function syncScroll() {
    scroller.scrollTop = area.scrollTop;
    scroller.scrollLeft = area.scrollLeft;
    // The numbers ride the same offset.  A transform keeps the gutter out of
    // the layout, so a scroll costs one compositor step and no reflow.
    gutterNumbers.style.transform = `translateY(${-area.scrollTop}px)`;
  }

  area.addEventListener("scroll", syncScroll);

  /* ---- find and replace ---- */

  function showCount() {
    if (!state.findOpen) {
      findCount.textContent = "";
      return;
    }
    if (findQuery.value === "") {
      findCount.textContent = "";
    } else if (state.hits.length === 0) {
      findCount.textContent = "no match";
    } else {
      findCount.textContent = `${state.hitIndex + 1}/${state.hits.length}`;
    }
  }

  /** Start from the first match at or after the caret, else from the top. */
  function seedIndex() {
    if (state.hits.length === 0) {
      state.hitIndex = -1;
      return;
    }
    const caret = area.selectionStart;
    const found = state.hits.findIndex((hit) => hit.start >= caret);
    state.hitIndex = found === -1 ? 0 : found;
  }

  /**
   * Recompute the matches and repaint.  `reveal` scrolls the current one into
   * view; `seed` picks a new current match rather than keeping the old index.
   */
  function syncFind(options = {}) {
    const { reveal = true, seed = false } = options;
    state.hits = state.findOpen ? findMatches(area.value, findQuery.value) : [];
    if (state.hits.length === 0) {
      state.hitIndex = -1;
    } else if (seed) {
      seedIndex();
    } else if (state.hitIndex >= state.hits.length) {
      state.hitIndex = state.hits.length - 1;
    } else if (state.hitIndex < 0) {
      state.hitIndex = 0;
    }
    showCount();
    repaint();
    if (reveal && state.hitIndex >= 0) {
      standOnHit();
    }
  }

  /** The text node holding a string index, and the offset inside it. */
  function pointAt(target) {
    let seen = 0;
    function walk(node) {
      for (const child of node.childNodes) {
        if (child.nodeType === 3) {
          const length = child.data.length;
          if (target <= seen + length) {
            return { node: child, offset: target - seen };
          }
          seen += length;
        } else {
          const found = walk(child);
          if (found !== null) {
            return found;
          }
        }
      }
      return null;
    }
    return walk(pre);
  }

  /**
   * Scroll the current match into view.
   *
   * The measurement is taken from the same text in the `<pre>`, which shares
   * the textarea's metrics; the delta is then applied to the textarea's own
   * scroll position, which `syncScroll` mirrors back onto the `<pre>`.
   */
  function revealHit(hit) {
    const first = pointAt(hit.start);
    const last = pointAt(hit.end);
    if (first === null || last === null) {
      return;
    }
    const range = document.createRange();
    range.setStart(first.node, first.offset);
    range.setEnd(last.node, last.offset);
    const box = range.getBoundingClientRect();
    if (box.width === 0 && box.height === 0) {
      return;
    }
    const frame = surface.getBoundingClientRect();
    let dy = 0;
    let dx = 0;
    if (box.top < frame.top) {
      dy = box.top - frame.top - 6;
    } else if (box.bottom > frame.bottom) {
      dy = box.bottom - frame.bottom + 6;
    }
    if (box.left < frame.left) {
      dx = box.left - frame.left - 6;
    } else if (box.right > frame.right) {
      dx = box.right - frame.right + 6;
    }
    if (dy !== 0) {
      area.scrollTop += dy;
    }
    if (dx !== 0) {
      area.scrollLeft += dx;
    }
    syncScroll();
  }

  /** Stand on the current match: select it and bring it into view. */
  function standOnHit() {
    const hit = state.hits[state.hitIndex];
    if (hit === undefined) {
      return;
    }
    area.setSelectionRange(hit.start, hit.end);
    revealHit(hit);
  }

  /** Move to the next (or previous) match, wrapping around. */
  function stepHit(delta) {
    const count = state.hits.length;
    if (count === 0) {
      syncFind({ reveal: false, seed: true });
      return;
    }
    const base = state.hitIndex < 0 ? (delta > 0 ? -1 : 0) : state.hitIndex;
    state.hitIndex = ((base + delta) % count + count) % count;
    showCount();
    repaint();
    standOnHit();
  }

  function openFind() {
    const selected = area.value.slice(area.selectionStart, area.selectionEnd);
    if (!state.findOpen && selected !== "" && !selected.includes("\n")) {
      findQuery.value = selected;
    }
    state.findOpen = true;
    findBar.hidden = false;
    syncFind({ reveal: true, seed: true });
    findQuery.focus();
    findQuery.select();
  }

  function closeFind() {
    state.findOpen = false;
    findBar.hidden = true;
    state.hits = [];
    state.hitIndex = -1;
    showCount();
    repaint();
    area.focus();
  }

  function replaceCurrent() {
    const hit = state.hits[state.hitIndex];
    if (hit === undefined) {
      openFind();
      return;
    }
    const replacement = replaceText.value;
    const caret = hit.start + replacement.length;
    rewrite(replaceMatchAt(area.value, hit, replacement), caret, undefined, "replaced 1");
  }

  function replaceEvery() {
    const query = findQuery.value;
    const hits = findMatches(area.value, query);
    if (hits.length === 0) {
      renderStatus("nothing to replace");
      return;
    }
    const replacement = replaceText.value;
    const caret = hits[0].start + replacement.length;
    rewrite(replaceAllMatches(area.value, query, replacement).text, caret, undefined,
      `replaced ${hits.length}`);
  }

  findQuery.addEventListener("input", () => {
    syncFind({ reveal: true, seed: true });
  });
  findQuery.addEventListener("keydown", (event) => {
    event.stopPropagation();
    if (event.key === "Enter") {
      event.preventDefault();
      stepHit(event.shiftKey ? -1 : 1);
    } else if (event.key === "Escape") {
      event.preventDefault();
      closeFind();
    } else if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "f") {
      event.preventDefault();
      openFind();
    }
  });
  replaceText.addEventListener("keydown", (event) => {
    event.stopPropagation();
    if (event.key === "Enter") {
      event.preventDefault();
      replaceCurrent();
    } else if (event.key === "Escape") {
      event.preventDefault();
      closeFind();
    }
  });
  findPrev.addEventListener("click", () => stepHit(-1));
  findNext.addEventListener("click", () => stepHit(1));
  findClose.addEventListener("click", closeFind);
  replaceOne.addEventListener("click", replaceCurrent);
  replaceAll.addEventListener("click", replaceEvery);

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
    const { confirmDiscard = true, status = null } = options;
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
      if (status !== null) {
        // Why this load happened. "loaded · lf · 14 bytes" is the same line
        // whether the user asked for the file or the watcher re-read it, and
        // after an external change the difference is the whole story.
        renderStatus(status);
      }
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
    if (state.findOpen) {
      syncFind({ reveal: false });
    }
  });

  area.addEventListener("keydown", (event) => {
    const mod = event.ctrlKey || event.metaKey;
    if (mod && event.key.toLowerCase() === "s") {
      event.preventDefault();
      save();
      return;
    }
    if (mod && event.key.toLowerCase() === "f") {
      event.preventDefault();
      openFind();
      return;
    }
    if (event.key === "Escape" && state.findOpen) {
      event.preventDefault();
      closeFind();
      return;
    }
    // Tab indents: this is a text editor, and Tab is how text is indented.
    // Shift+Tab takes one step back off the lines the selection touches.
    if (event.key === "Tab") {
      event.preventDefault();
      const result = indentSelection(area.value, area.selectionStart, area.selectionEnd, {
        outdent: event.shiftKey,
      });
      if (result.text !== area.value) {
        rewrite(result.text, result.selectionStart, result.selectionEnd);
      }
      return;
    }
    // Enter keeps the line's indentation (plus one step after an opener).  A
    // top-level line is left to the browser, and the lines we do handle go in
    // through the browser's own insert command, so Ctrl+Z still has them.
    if (event.key === "Enter" && !mod && !event.altKey && !event.shiftKey
      && area.selectionStart === area.selectionEnd) {
      const before = area.value.slice(0, area.selectionStart);
      const indent = indentAfterEnter(before.slice(before.lastIndexOf("\n") + 1));
      if (indent !== "") {
        event.preventDefault();
        const at = area.selectionStart;
        rewrite(`${before}\n${indent}${area.value.slice(at)}`, at + 1 + indent.length);
        return;
      }
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
      /**
       * The revision this card last read (or wrote), or `null` before the first
       * read answers. `file.stat` is compared against it.
       */
      get revision() {
        return state.baseRevision;
      },
      /**
       * Adopt the file as it is on disk now, discarding the buffer.
       *
       * Only a clean card is ever asked: the rule that decides is in
       * `watch.mjs`, and it warns instead of reloading whenever `dirty` is set.
       * The guard here is for the race (the user typed between the decision and
       * this call), not for the normal path.
       */
      reload() {
        if (state.dirty) {
          return Promise.resolve(false);
        }
        return load(state.path, { confirmDiscard: false, status: "reloaded from disk" });
      },
      /** The file is gone from disk: say so. The text stays, `^S` writes it back. */
      onFileGone() {
        renderStatus("gone from disk — ^S writes it back");
        app.log("warn", `${state.path} is gone from disk`);
      },
      /** Open the find bar (the smoke test drives it through real keys too). */
      find() {
        openFind();
        return { query: findQuery.value, hits: state.hits.length, index: state.hitIndex };
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

/* -------------------- story -------------------- */

/**
 * The dialogue card.
 *
 * Its state is the parsed `.yarn` file, not a string.  The card draws a node
 * list on one side and, for the node that is on, that node's lines: the kind,
 * the speaker, the text and the `#line:` id the game looks each one up by.
 * Editing a speaker or a text edits one span of one line, and saving writes
 * `serializeStory` of the tree the card has been holding -- so opening a story
 * and saving it untouched puts the same bytes back, which is the only reason a
 * modder can trust it with a real mod's files.
 */
function renderStory(card, ctx) {
  const { client, app } = ctx;

  const nodeList = h("div", "story-nodes", { attrs: { "data-role": "story-nodes" } });
  const lineList = h("div", "story-lines", { attrs: { "data-role": "story-lines" } });
  const panes = h("div", "story-panes", { children: [nodeList, lineList] });
  const tools = h("div", "story-tools", { attrs: { "data-role": "story-tools" } });
  const suggestBox = h("div", "story-suggest", { attrs: { "data-role": "story-suggest" } });
  const status = makeStatus();
  const body = h("div", "card-body card-body-story", {
    children: [panes, tools, suggestBox, status],
  });
  const shell = cardShell(card, body);

  const addLineButton = h("button", "story-tool", {
    attrs: {
      type: "button", "data-role": "story-add-line",
      title: "add a line below the one that is on",
    },
    text: "+ line",
  });
  const saveButton = h("button", "story-tool", {
    attrs: {
      type: "button", "data-role": "story-save", title: "write the file back (Ctrl+S)",
    },
    text: "save",
  });
  const tableLabel = h("span", "story-table", {
    attrs: { "data-role": "story-table" },
  });
  const schemaLabel = h("span", "story-schema", {
    attrs: { "data-role": "story-schema" },
  });
  tools.append(addLineButton, saveButton, tableLabel, schemaLabel);

  const state = {
    path: typeof card.file === "string" ? card.file : "",
    baseRevision: null,
    dirty: false,
    saving: false,
    story: null,
    nodeIndex: 0,
    lineIndex: 0,
    tablePath: typeof card.table === "string" ? card.table : "",
    table: null,
    tableById: null,
    tableRevision: null,
    tableDirty: false,
    schemaPath: typeof card.schema === "string" ? card.schema : "",
    schema: null,
    suggest: [],
    suggestAt: -1,
    suggestCaret: 0,
    suggestIndex: 0,
  };

  /** The parsed node the line list is showing, or null. */
  function activeNode() {
    return storyNodeAt(state.story, state.nodeIndex);
  }

  function updateLabel() {
    shell.label.textContent = state.path === "" ? "(no file)" : state.path;
  }

  /**
   * The status line speaks for the file, not for the card: `storyAbout` is the
   * one sentence that says how much story is open, and the dirty mark is the
   * only thing added to it.
   */
  function updateStatus(prefix = null) {
    const about = state.story === null ? "no file" : storyAbout(state.story);
    const parts = prefix === null ? [] : [prefix];
    parts.push(state.dirty ? `${about} \u00b7 unsaved in the card` : about);
    status.textContent = parts.join(" \u00b7 ");
    tableLabel.textContent = state.tablePath === ""
      ? "no translation table"
      : `${state.tablePath} \u00b7 ${state.table === null ? 0 : state.table.rows.length} rows`;
    schemaLabel.textContent = state.schemaPath === ""
      ? "no command schema"
      : `${state.schemaPath} \u00b7 ${state.schema === null ? "not loaded" : yslsAbout(state.schema)}`;
    updateLabel();
  }

  function renderStatus(message) {
    status.textContent = message;
  }

  function paint() {
    paintNodes();
    paintLines();
    updateStatus();
  }

  function paintNodes() {
    nodeList.textContent = "";
    const nodes = state.story === null ? [] : storyNodes(state.story);
    if (nodes.length === 0) {
      nodeList.append(h("p", "story-empty", {
        text: state.story === null ? "no file" : "no nodes",
      }));
      return;
    }
    for (const info of nodes) {
      const meta = [`${info.lineCount} lines`];
      if (info.when !== null && info.when !== undefined && info.when !== "") {
        meta.push(`when: ${info.when}`);
      }
      const row = h("button", "story-node", {
        attrs: {
          type: "button", "data-role": "story-node", "data-node": String(info.index),
        },
        children: [
          h("span", "story-node-title", {
            text: info.title === null || info.title === undefined || info.title === ""
              ? "(untitled)"
              : info.title,
          }),
          h("span", "story-node-meta", { text: meta.join(" \u00b7 ") }),
        ],
      });
      if (info.subtitle !== null && info.subtitle !== undefined && info.subtitle !== "") {
        row.append(h("span", "story-node-tags", { text: info.subtitle }));
      }
      if (info.tags.length > 0) {
        row.append(h("span", "story-node-tags", { text: info.tags.join(" ") }));
      }
      if (info.index === state.nodeIndex) {
        row.classList.add("is-on");
      }
      row.addEventListener("click", () => {
        state.nodeIndex = info.index;
        state.lineIndex = 0;
        paint();
      });
      nodeList.append(row);
    }
  }

  function paintLines() {
    /* Every input in the list is about to be replaced, so a suggestion list
       pointing at one of them is stale by the time the new rows exist. */
    clearSuggest();
    lineList.textContent = "";
    const node = activeNode();
    if (node === null) {
      lineList.append(h("p", "story-empty", { text: "no node to show" }));
      return;
    }
    const lines = storyLines(node);
    if (lines.length === 0) {
      lineList.append(h("p", "story-empty", {
        text: "this node is empty \u2014 \u201c+ line\u201d starts it",
      }));
      return;
    }
    lines.forEach((line, index) => {
      lineList.append(lineRow(line, index));
    });
  }

  /**
   * The line's translation, found by the only thing the story file and a
   * translation table share: the `#line:` id.  Null means no table is open,
   * so no column is drawn -- an empty column would only be a lie about the
   * file.  The state is `storycsv.mjs`'s word for the row, not the card's.
   */
  function translationOf(line) {
    if (state.tableById === null) {
      return null;
    }
    const id = line.id === null ? lineIdOf(line.raw) : line.id;
    if (id === null) {
      return null;
    }
    const row = state.tableById.get(`line:${id}`);
    return {
      text: row === undefined ? "" : row.text,
      state: rowState({ text: storyLineText(line) }, row),
    };
  }

  /** One body line, drawn as the editor the file is edited in. */
  function lineRow(line, index) {
    const row = h("div", `story-line story-line-${line.kind}`, {
      attrs: {
        "data-role": "story-line", "data-line": String(index), "data-kind": line.kind,
      },
    });
    if (index === state.lineIndex) {
      row.classList.add("is-on");
    }
    row.append(h("span", "story-kind", { text: line.kind }));

    if (line.kind === "dialogue") {
      const speaker = h("input", "story-speaker", {
        attrs: {
          type: "text", value: line.speaker === null ? "" : line.speaker,
          spellcheck: "false", autocomplete: "off",
          "data-role": "story-speaker", "aria-label": `speaker of line ${index + 1}`,
        },
      });
      const text = h("input", "story-text", {
        attrs: {
          type: "text", value: line.text === null ? "" : line.text,
          spellcheck: "false", autocomplete: "off",
          "data-role": "story-text", "aria-label": `text of line ${index + 1}`,
        },
      });
      /* The card rewrites the model as the words arrive but never repaints the
         row: the input being typed in is the one element that must survive the
         keystroke.  Ids cannot move here, so there is nothing a repaint would
         show that the row does not already say. */
      speaker.addEventListener("input", () => {
        storySetSpeaker(state.story, state.nodeIndex, index, speaker.value);
        markEdited(index);
      });
      text.addEventListener("input", () => {
        storySetText(state.story, state.nodeIndex, index, text.value);
        markEdited(index);
      });
      stopTypingKeys(speaker);
      stopTypingKeys(text);
      suggestKeys(text, index);
      row.append(speaker, h("span", "story-colon", { text: ":" }), text);
    } else if (line.kind === "option") {
      row.append(h("span", "story-option", { text: line.raw.trim() }));
    } else if (line.kind === "command") {
      /* A command is the one non-dialogue line an author types, so it is the one
         that is editable: `<<` is where the schema's completion belongs.  The
         indent is the file's, so it is not in the field -- writing it back with
         the text is what would move the line. */
      const command = h("input", "story-command", {
        attrs: {
          type: "text", value: storyEditableText(line),
          spellcheck: "false", autocomplete: "off",
          "data-role": "story-command", "aria-label": `command of line ${index + 1}`,
        },
      });
      command.addEventListener("input", () => {
        storyWriteText(state.story, state.nodeIndex, index, line, command.value);
        markEdited(index);
      });
      stopTypingKeys(command);
      suggestKeys(command, index);
      row.append(command);
    } else if (line.kind !== "blank") {
      /* A comment, a lone tag run or a line no rule fits: shown as it is, so
         the file is never hiding a line from the person editing it. */
      row.append(h("span", "story-raw", { text: line.raw }));
    }

    /* Every tag the file wrote, so nothing on the line is hidden from the
       person editing it.  The id is the one exception: it gets its own badge,
       and the parser does not always recognise it as a tag. */
    const tags = line.tags.filter((tag) => !tag.startsWith("#line:"));
    if (tags.length > 0) {
      row.append(h("span", "story-tags", { text: tags.join(" ") }));
    }
    const id = line.id === null ? lineIdOf(line.raw) : line.id;
    if (id !== null) {
      row.append(h("span", "story-id", { text: `#line:${id}` }));
    }
    const translation = translationOf(line);
    if (translation !== null) {
      row.append(h("span", `story-translation is-${translation.state}`, {
        attrs: {
          "data-role": "story-translation", "data-state": translation.state,
          title: `translation: ${translation.state}`,
        },
        text: translation.text === "" ? translation.state : translation.text,
      }));
    }
    if (line.comment !== null) {
      row.append(h("span", "story-comment", { text: `// ${line.comment}` }));
    }
    row.addEventListener("click", (event) => {
      state.lineIndex = index;
      markSelection();
      if (!(event.target instanceof HTMLInputElement)) {
        focusLine(index);
      }
    });
    return row;
  }

  /** Move the "on" line without rebuilding the list the inputs live in. */
  function markSelection() {
    for (const row of lineList.querySelectorAll('[data-role="story-line"]')) {
      const at = Number(row.getAttribute("data-line"));
      row.classList.toggle("is-on", at === state.lineIndex);
    }
  }

  function focusLine(index, caret = null) {
    const row = lineList.querySelector(`[data-line="${index}"]`);
    if (row === null) {
      return;
    }
    const target = row.querySelector('[data-role="story-command"]')
      || row.querySelector('[data-role="story-text"]')
      || row.querySelector('[data-role="story-speaker"]');
    if (target !== null) {
      target.focus();
      if (typeof target.select === "function") {
        target.select();
      }
      if (Number.isInteger(caret)) {
        target.selectionStart = caret;
        target.selectionEnd = caret;
      }
    }
  }

  /**
   * The schema's completion, as the caret moves.
   *
   * A card that offered a list while somebody typed prose would be worse than a
   * card that offered none, so the only thing that can open the list is a caret
   * inside a `<<...>>` name.  Everything the list shows comes from the mod's own
   * `.ysls.json`; nothing here knows a command's name.
   */
  function refreshSuggest(index, control) {
    const node = activeNode();
    const line = node === null ? undefined : storyLines(node)[index];
    if (line === undefined || state.schema === null) {
      return clearSuggest();
    }
    const caret = typeof control.selectionStart === "number"
      ? control.selectionStart
      : storyEditableText(line).length;
    const found = storySuggestions(line, caret, state.schema);
    state.suggest = found.items;
    state.suggestAt = index;
    state.suggestCaret = caret;
    state.suggestIndex = 0;
    paintSuggest();
    return found.items;
  }

  function clearSuggest() {
    state.suggest = [];
    state.suggestAt = -1;
    paintSuggest();
    return [];
  }

  function paintSuggest() {
    suggestBox.textContent = "";
    state.suggest.forEach((entry, index) => {
      const item = h("button", `story-suggest-item${index === state.suggestIndex ? " is-current" : ""}`, {
        attrs: {
          type: "button", "data-role": "story-suggest-item",
          "data-command": entry.name, title: yslsSignature(entry),
        },
        text: yslsSignature(entry),
      });
      /* The button takes the click before the input's own blur can close the
         list, because the list is only rebuilt by a keystroke or a caret. */
      item.addEventListener("mousedown", (event) => {
        event.preventDefault();
      });
      item.addEventListener("click", () => {
        acceptSuggest(entry.name);
      });
      suggestBox.append(item);
    });
  }

  /** Take one suggestion: rewrite the line, move the caret past it, repaint. */
  function acceptSuggest(name) {
    const node = activeNode();
    const line = node === null ? undefined : storyLines(node)[state.suggestAt];
    if (line === undefined || typeof name !== "string" || name === "") {
      return;
    }
    const accepted = storyAcceptSuggestion(line, state.suggestCaret, name);
    if (accepted.text === storyEditableText(line)) {
      return;
    }
    storyWriteText(state.story, state.nodeIndex, state.suggestAt, line, accepted.text);
    const at = state.suggestAt;
    state.dirty = true;
    app.boardTouched(true);
    state.lineIndex = at;
    state.suggest = [];
    paintSuggest();
    paint();
    focusLine(at, accepted.caret);
  }

  /**
   * The keys the list owns while it is open.  Tab and Enter take the current
   * one, the arrows move, Escape closes; everything else is the author's.
   */
  function suggestKeys(control, index) {
    const move = (event) => {
      const count = state.suggest.length;
      if (count === 0) {
        return;
      }
      event.preventDefault();
      const step = event.key === "ArrowDown" ? 1 : -1;
      state.suggestIndex = (state.suggestIndex + step + count) % count;
      paintSuggest();
    };
    const take = (event) => {
      if (state.suggest.length === 0) {
        return;
      }
      const current = state.suggest[state.suggestIndex];
      if (current === undefined) {
        return;
      }
      event.preventDefault();
      acceptSuggest(current.name);
    };
    control.addEventListener("keydown", (event) => {
      if (event.key === "Tab" || event.key === "Enter") {
        take(event);
        return;
      }
      if (event.key === "ArrowDown" || event.key === "ArrowUp") {
        move(event);
        return;
      }
      if (event.key === "Escape" && state.suggest.length > 0) {
        clearSuggest();
      }
    });
    const typed = (event) => {
      if (["Tab", "Enter", "ArrowDown", "ArrowUp", "Escape"].includes(event.key)) {
        return;
      }
      refreshSuggest(index, control);
    };
    control.addEventListener("input", () => refreshSuggest(index, control));
    control.addEventListener("keyup", typed);
    control.addEventListener("click", () => refreshSuggest(index, control));
  }

  function markEdited(index) {
    state.lineIndex = index;
    state.dirty = true;
    app.boardTouched(true);
    updateStatus();
  }

  /* The board listens for keys on the document -- delete, undo, the command
     line's own Enter -- and a caret in a line is not the board. */
  function stopTypingKeys(control) {
    control.addEventListener("keydown", (event) => {
      if (event.key === "Escape") {
        control.blur();
      }
      if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "s") {
        event.preventDefault();
        save();
        return;
      }
      event.stopPropagation();
    });
  }

  /**
   * A line the story gained is a line the table owes a row.
   *
   * The id the parser just minted is exactly what the game will look the line
   * up by, so writing the row here is what keeps the two files agreeing.  The
   * row is not written to disk here: `save` writes both files, and only when
   * the card is asked to.
   */
  function appendTableRow() {
    if (state.table === null) {
      return false;
    }
    const row = storyRowForLine(state.story, state.nodeIndex, state.lineIndex, state.table);
    if (row === null) {
      return false;
    }
    state.table.rows.push(rowFor(row));
    state.tableById = rowsById(state.table);
    state.tableDirty = true;
    app.log("info", `${state.tablePath}: a row for ${row.id} is waiting to be saved`);
    return true;
  }

  function addLine() {
    if (activeNode() === null) {
      app.log("warn", "story: this card has no node to add a line to");
      return;
    }
    const index = storyAddLine(state.story, state.nodeIndex, state.lineIndex + 1);
    if (index < 0) {
      return;
    }
    /* The parser decides what the line is -- kind, tags, id -- so the card
       re-reads its own text instead of inventing a second entry shape. */
    state.story = parseStory(serializeStory(state.story));
    state.lineIndex = index;
    state.dirty = true;
    app.boardTouched(true);
    appendTableRow();
    paint();
    focusLine(index);
  }

  /**
   * The table is written only when the card put a row in it -- never because it
   * was read.  The story is already on disk by the time this runs, so a failure
   * here is said out loud rather than turned into a failed save.
   *
   * The bytes go through a `file.blob*` write session for the same reason the
   * reading does: a table of megabytes does not fit in one `file.write` frame,
   * and the kernel publishes the new file only when the commit's own total
   * matches what was appended.  The session's base revision is the one the read
   * session reported, so a file that changed under the card is refused at the
   * open, before a byte of the card's rows is on disk.
   */
  async function saveTable() {
    if (state.table === null || state.tablePath === "" || !state.tableDirty) {
      return true;
    }
    const text = serializeCsv(state.table);
    try {
      const written = await writeTextInChunks(client, state.tablePath, text, {
        baseRevision: state.tableRevision === null ? undefined : state.tableRevision,
      });
      state.tableRevision = written.revision;
      state.tableDirty = false;
      app.log("info", `saved ${state.tablePath} (rev ${written.revision}) \u2014 the table has the new row`);
      return true;
    } catch (err) {
      renderStatus(`the story was saved \u00b7 ${state.tablePath} was not`);
      app.log("error",
        `the story was saved but ${state.tablePath} was not: ` +
        `${err.message} \u2014 save the table again, or the row and the line disagree`);
      return false;
    }
  }

  async function load(path, options = {}) {
    const confirmDiscard = options.confirmDiscard !== false;
    if (state.dirty && confirmDiscard && !app.confirmDiscard(state.path)) {
      return false;
    }
    shell.label.textContent = path;
    let result;
    try {
      result = await client.call("file.read", { path });
    } catch (err) {
      renderStatus(`could not read ${path}`);
      app.log("error", `file.read ${path}: ${err.message}`);
      return false;
    }
    state.path = path;
    card.file = path;
    state.baseRevision = result.revision;
    state.story = parseStory(result.text);
    state.nodeIndex = 0;
    state.lineIndex = 0;
    state.dirty = false;
    paint();
    return true;
  }

  /**
   * The translation table is a second file, and it is read through a
   * `file.blob*` session because of its size, not in one piece: the game's own
   * tables are megabytes, and one whole-file read of one is the read that never
   * came back.  The session hands over one mebibyte frame at a time and the
   * assembled text goes to the same parser as before, so a small table parses to
   * exactly the rows it always did.  The status line says how far it has got,
   * and a read that fails is said out loud and leaves no table behind -- a table
   * that is half the file would be the card lying about the mod.
   */
  async function loadTable(path) {
    let read;
    try {
      read = await readTextInChunks(client, path, {
        onProgress: (bytesRead, total) => {
          renderStatus(bytesRead === 0 || total === 0
            ? "reading table\u2026"
            : `reading table\u2026 ${formatSize(bytesRead)}/${formatSize(total)}`);
        },
      });
    } catch (err) {
      renderStatus(`could not read ${path}: ${err.message}`);
      app.log("error", `file.blobRead ${path}: ${err.message}`);
      return false;
    }
    state.tablePath = path;
    state.table = parseCsv(read.text);
    state.tableById = rowsById(state.table);
    state.tableRevision = read.revision;
    state.tableDirty = false;
    paint();
    return true;
  }

  /**
   * The mod's own command schema, read whole in one `file.read` -- a schema is a
   * few kilobytes, and the table's range reading is about the table's size.
   *
   * A `.ysls.json` is what tells a modder's editor which commands exist, so the
   * card reads the file rather than carrying a list of its own: a mod that adds a
   * command gets completion for it the moment its schema is regenerated.  A file
   * that is not a schema is refused here, while the mistake is still a sentence.
   */
  async function loadSchema(path) {
    let result;
    try {
      result = await client.call("file.read", { path });
    } catch (err) {
      renderStatus(`could not read ${path}`);
      app.log("error", `file.read ${path}: ${err.message}`);
      return false;
    }
    const parsed = parseYsls(result.text);
    if (parsed.error !== "") {
      renderStatus(`could not read ${path}`);
      app.log("error", `${path}: ${parsed.error} \u2014 a command schema is a .ysls.json`);
      return false;
    }
    state.schemaPath = path;
    state.schema = parsed;
    card.schema = path;
    paint();
    return true;
  }

  async function save() {
    if (state.path === "" || state.story === null) {
      app.log("warn",
        "story: nothing to save \u2014 open a .yarn file with `story <path>`");
      return false;
    }
    if (state.saving) {
      return false;
    }
    state.saving = true;
    renderStatus("saving\u2026");
    const params = { path: state.path, text: serializeStory(state.story) };
    if (state.baseRevision !== null) {
      params.base_revision = state.baseRevision;
    }
    try {
      const result = await client.call("file.write", params);
      state.saving = false;
      state.baseRevision = result.revision;
      state.dirty = false;
      updateStatus("saved");
      app.log("info", `saved ${state.path} (rev ${result.revision})`);
      await saveTable();
      return true;
    } catch (err) {
      state.saving = false;
      if (client.isStaleRevision(err)) {
        const current = err.data && err.data.current_revision !== undefined
          ? err.data.current_revision
          : null;
        renderStatus(`stale \u2014 the file changed on disk (rev ${current})`);
        const choice = await app.resolveStale({
          path: state.path, current, cardId: card.id,
        });
        if (choice === "reload") {
          const reloaded = await load(state.path, { confirmDiscard: false });
          /* The table is locked to the revision it was read at, and the disk has
             moved on, so the rows are read again before the next save -- the
             card says what the file says, or it says nothing. */
          if (reloaded && state.tablePath !== "") {
            await loadTable(state.tablePath);
          }
          return reloaded;
        }
        if (choice === "overwrite") {
          state.baseRevision = current;
          return save();
        }
        app.log("warn", `${state.path} not saved; your lines are still in the card`);
        return false;
      }
      renderStatus(`could not write ${state.path}`);
      app.log("error", `file.write ${state.path}: ${err.message}`);
      return false;
    }
  }

  addLineButton.addEventListener("click", () => addLine());
  saveButton.addEventListener("click", () => save());

  if (state.path !== "") {
    load(state.path, { confirmDiscard: false }).then((opened) => {
      if (opened && state.tablePath !== "") {
        loadTable(state.tablePath);
      }
      if (opened && state.schemaPath !== "") {
        loadSchema(state.schemaPath);
      }
    });
  } else {
    paint();
    renderStatus("no file yet \u2014 open one with `story <path>`");
  }

  return {
    el: shell.el,
    handle: {
      kind: "story",
      save,
      load,
      loadTable,
      loadSchema,
      repaint: paint,
      get path() {
        return state.path;
      },
      get tablePath() {
        return state.tablePath;
      },
      get schemaPath() {
        return state.schemaPath;
      },
      get schema() {
        return state.schema;
      },
      /** The suggestions the card would offer a caret in one of its lines. */
      suggestAt(lineIndex, caret) {
        const node = activeNode();
        const line = node === null ? undefined : storyLines(node)[lineIndex];
        return line === undefined || state.schema === null
          ? []
          : storySuggestions(line, caret, state.schema).items;
      },
      get dirty() {
        return state.dirty;
      },
      get revision() {
        return state.baseRevision;
      },
      hasPath(path) {
        return state.path !== "" && state.path === path;
      },
      /** What a save would write -- the card's own text, for a caller or a test. */
      text() {
        return state.story === null ? "" : serializeStory(state.story);
      },
      focus() {
        focusLine(state.lineIndex);
      },
    },
    destroy() {},
  };
}

/* ------------------------------------------------------------------ */
/* pixel                                                               */
/* ------------------------------------------------------------------ */

/*
 * A drawing surface for a .png, and the one thing it must never do is put
 * pixels in the board document.  The board stores `{file, width, height,
 * palette}` and nothing else: the pixels live in a `Uint8Array` in this card
 * and on disk, so a board save stays a small JSON document and a drawing that
 * was never saved is not silently resurrected by an undo of a card move -- see
 * the undo note in `main.mjs`.  `shell/web/pixelpng.mjs` is the whole codec;
 * this card owns no PNG knowledge at all.
 */

/** Tools a pixel card offers; the current one is held in `state.tool`. */
const PIXEL_TOOLS = [
  { name: "pencil", hint: "pencil: draw with the current colour (B)" },
  { name: "eraser", hint: "eraser: clear a pixel to transparent (E)" },
  { name: "fill", hint: "fill: flood the same-coloured region under the pointer (G)" },
  { name: "eyedropper", hint: "eyedropper: take the colour under the pointer (I)" },
  { name: "hand", hint: "hand: pan the image; the middle button pans with any tool" },
];

/** The default `#rrggbb` palette a new pixel card starts from. */
const PIXEL_PALETTE = [
  "#000000", "#ffffff", "#7f7f7f", "#c8c8c8",
  "#803c14", "#e08020", "#3c3c28", "#f0d890",
  "#7c1c14", "#d04028", "#204018", "#489030",
  "#202048", "#4060a8", "#5a2c5c", "#a058a0",
];

/**
 * The size a missing sprite is declared at before the person changes it, and
 * the size a card opened without one is given: 96x96, the game's own
 * `Sprites\Situation_96` convention.  Exported so `main.mjs`'s `openPixelCard`
 * declares exactly the number this kind's `create()` seeds, and so the D006 row
 * that opens a sprite the mod does not carry lands at a usable size.
 */
export const PIXEL_NEW_SIZE = 96;

/** The single-letter tool keys, so the hints above are not just words. */
const PIXEL_TOOL_KEYS = { b: "pencil", e: "eraser", g: "fill", i: "eyedropper", h: "hand" };

const PIXEL_ZOOM_MIN = 1;
const PIXEL_ZOOM_MAX = 32;
/** How many gestures a card can take back. */
const PIXEL_HISTORY = 64;

/**
 * The colour the hand/eyedropper readout shows: the pixel's own colour, or a
 * near-black that is visible on the checkerboard when the pixel is transparent.
 *
 * Exported, with the two below it, for the suite: this is the card's whole
 * opinion about colour, and it is testable without a canvas.
 */
export function pixelInkOf(rgba) {
  if (rgba === null || rgba === undefined) {
    return "#4a4a4a";
  }
  return `#${[rgba[0], rgba[1], rgba[2]].map((byte) => Number(byte).toString(16).padStart(2, "0")).join("")}`;
}

/** `#rrggbb` (or `#rgb`) to `[r, g, b, 255]`, or null for anything else. */
export function pixelColourOf(text) {
  const raw = typeof text === "string" ? text.trim().replace(/^#/, "") : "";
  const hex = raw.length === 3 ? raw.split("").map((c) => c + c).join("") : raw;
  if (!/^[0-9a-fA-F]{6}$/.test(hex)) {
    return null;
  }
  return [
    parseInt(hex.slice(0, 2), 16),
    parseInt(hex.slice(2, 4), 16),
    parseInt(hex.slice(4, 6), 16),
    255,
  ];
}

/** The palette in the board document, as a list of usable `#rrggbb` strings. */
export function pixelPaletteOf(value) {
  const wanted = Array.isArray(value) ? value : [];
  const out = [];
  for (const entry of wanted) {
    const colour = pixelColourOf(entry);
    if (colour !== null) {
      out.push(pixelInkOf(colour));
    }
  }
  return out.length === 0 ? PIXEL_PALETTE.slice() : out;
}

function renderPixel(card, ctx) {
  const { client, app } = ctx;

  const state = {
    /** The file the pixels belong to; also mirrored into the board document. */
    file: typeof card.file === "string" ? card.file : "",
    /** `{width, height, pixels}` -- the only copy of the artwork in memory. */
    image: null,
    /** The kernel's revision for the bytes on disk, or null when there is none. */
    baseRevision: null,
    /** Set when the file could not be decoded: a save would clobber it. */
    readError: null,
    /** How the pixels in `image` got here, for the label and the status line. */
    origin: "new",
    palette: pixelPaletteOf(card.palette),
    tool: "pencil",
    colour: "#000000",
    zoom: PIXEL_ZOOM_MIN,
    panX: 0,
    panY: 0,
    pointer: null,
    pending: null,
    history: [],
    /** Index of the last applied step, or -1 when the image is at the start. */
    index: -1,
    saving: false,
    busy: false,
  };

  /* -- the chrome ---------------------------------------------------- */

  const toolsBar = h("div", "pixel-tools", { attrs: { "data-role": "pixel-tools" } });
  const toolButtons = new Map();
  for (const tool of PIXEL_TOOLS) {
    const el = h("button", "pixel-tool", {
      attrs: { type: "button", title: tool.hint, "data-role": `pixel-tool-${tool.name}`, "data-tool": tool.name },
      text: tool.name,
    });
    el.addEventListener("click", () => selectTool(tool.name));
    toolButtons.set(tool.name, el);
    toolsBar.append(el);
  }

  const colourInput = h("input", "pixel-colour", {
    attrs: { type: "color", value: state.colour, "data-role": "pixel-colour", title: "the colour the pencil draws with" },
  });
  colourInput.value = state.colour;
  colourInput.addEventListener("input", () => {
    state.colour = String(colourInput.value || state.colour);
    paintSwatches();
  });

  const swatches = h("div", "pixel-swatches", { attrs: { "data-role": "pixel-palette" } });
  toolsBar.append(colourInput, swatches);

  const widthInput = h("input", "pixel-size", {
    attrs: { type: "number", min: "1", max: "4096", "data-role": "pixel-width", title: "declared width of a new image" },
  });
  const heightInput = h("input", "pixel-size", {
    attrs: { type: "number", min: "1", max: "4096", "data-role": "pixel-height", title: "declared height of a new image" },
  });
  const newButton = h("button", "pixel-button", {
    attrs: { type: "button", "data-role": "pixel-new", title: "throw the pixels away and start a blank image at this size" },
    text: "New",
  });
  newButton.addEventListener("click", () => newImage());
  const sizeGroup = h("div", "pixel-group pixel-sizes", {
    children: [widthInput, h("span", "pixel-times", { text: "×" }), heightInput, newButton],
  });

  const zoomOut = h("button", "pixel-button", {
    attrs: { type: "button", "data-role": "pixel-zoom-out", title: "zoom out (Ctrl+wheel)" },
    text: "−",
  });
  const zoomIn = h("button", "pixel-button", {
    attrs: { type: "button", "data-role": "pixel-zoom-in", title: "zoom in (Ctrl+wheel)" },
    text: "+",
  });
  const zoomReadout = h("span", "pixel-zoom-label", { attrs: { "data-role": "pixel-zoom" } });
  zoomOut.addEventListener("click", () => setZoom(Math.floor(state.zoom / 2)));
  zoomIn.addEventListener("click", () => setZoom(state.zoom * 2));
  const zoomGroup = h("div", "pixel-group pixel-zooms", { children: [zoomOut, zoomIn, zoomReadout] });

  const saveButton = h("button", "pixel-button is-primary", {
    attrs: { type: "button", "data-role": "pixel-save", title: "write the PNG back through file.write_bytes (Ctrl+S in the card)" },
    text: "save",
  });
  saveButton.addEventListener("click", () => save());

  const tools = h("div", "pixel-groups", { children: [sizeGroup, zoomGroup, saveButton] });

  const canvas = h("canvas", "pixel-canvas", {
    attrs: { "data-role": "pixel-canvas", tabindex: "0", title: "wheel to zoom · middle button or the hand tool to pan" },
  });
  const surface = h("div", "pixel-surface", { attrs: { "data-role": "pixel-surface" }, children: [canvas] });
  const status = makeStatus();
  const body = h("div", "card-body card-body-pixel", { children: [toolsBar, surface, tools, status] });
  const shell = cardShell(card, body);

  const context = typeof canvas.getContext === "function" ? canvas.getContext("2d") : null;

  /*
   * `putImageData` ignores the CTM, the clip and the alpha, so the zoom/pan
   * transform cannot be applied to the image directly.  The image is put,
   * untransformed, into an offscreen bitmap at its own size and handed back to
   * the visible canvas with `drawImage`, which *does* honour the transform --
   * with smoothing off, still on crisp pixel edges.  Created lazily, and sized
   * from the image rather than from the surface.
   */
  let offscreen = null;
  let offscreenContext = null;
  /** True while the window is listening for the end of the live gesture. */
  let gestureBound = false;
  /*
   * Clicks that arrived once the card was on screen but before its file read had
   * answered.  There is no image to stamp into yet, so the press is refused --
   * and that refusal must not vanish.  The load's own report lands right after
   * it and would otherwise wipe the one sign that the click did nothing, and the
   * person would go on to save an image they never drew on.  So they are counted
   * here and said again as soon as there is an image to draw on.
   */
  let ignoredWhileLoading = 0;

  /** The "and N clicks did nothing" tail for a report; empty when there were none. */
  function ignoredNote() {
    if (ignoredWhileLoading === 0) {
      return "";
    }
    const count = ignoredWhileLoading;
    ignoredWhileLoading = 0;
    return ` (${count} click${count === 1 ? "" : "s"} before the image was ready did nothing)`;
  }

  /* -- painting ------------------------------------------------------ */

  /** Pick a tool by name, the one place that changes it. */
  function selectTool(name) {
    if (!toolButtons.has(name)) {
      return;
    }
    state.tool = name;
    paintTools();
  }

  function paintTools() {
    for (const [name, el] of toolButtons) {
      el.classList.toggle("is-on", name === state.tool);
    }
    colourInput.value = state.colour;
    canvas.classList.toggle("is-hand", state.tool === "hand");
  }

  function paintSwatches() {
    swatches.textContent = "";
    for (const colour of state.palette) {
      const swatch = h("button", "pixel-swatch", {
        attrs: { type: "button", title: colour, "data-role": "pixel-swatch", "data-colour": colour },
      });
      swatch.style = { backgroundColor: colour };
      if (colour.toLowerCase() === String(state.colour).toLowerCase()) {
        swatch.classList.add("is-on");
      }
      swatch.addEventListener("click", () => {
        state.colour = colour;
        paintTools();
        paintSwatches();
      });
      swatches.append(swatch);
    }
  }

  /**
   * The pixels on screen: the image goes into the offscreen bitmap whole and
   * untransformed, and the visible canvas gets it back with one `drawImage`
   * inside the zoom/pan transform.  `putImageData` cannot take a transform at
   * all, so painting the image straight onto the visible canvas would ignore
   * zoom and pan -- and leave a click painting a different pixel than the one
   * under the cursor.  Nothing is composed per pixel, so a repaint cannot
   * disagree with `state.image` -- and a stub context sees exactly the image
   * the card holds, which is what makes this card testable without a browser.
   */
  function paintCanvas() {
    const image = state.image;
    if (image === null || context === null) {
      return;
    }
    const view = surface.getBoundingClientRect ? surface.getBoundingClientRect() : { width: 0, height: 0 };
    const width = Math.max(1, Math.floor(view.width || 0));
    const height = Math.max(1, Math.floor(view.height || 0));
    if (canvas.width !== width || canvas.height !== height) {
      canvas.width = width;
      canvas.height = height;
    }
    if (offscreen === null || offscreenContext === null) {
      offscreen = document.createElement("canvas");
      offscreenContext = typeof offscreen.getContext === "function" ? offscreen.getContext("2d") : null;
    }
    if (offscreenContext === null) {
      return;
    }
    if (offscreen.width !== image.width || offscreen.height !== image.height) {
      offscreen.width = image.width;
      offscreen.height = image.height;
    }
    const source = offscreenContext.createImageData(image.width, image.height);
    source.data.set(image.pixels);
    offscreenContext.putImageData(source, 0, 0);

    context.setTransform(1, 0, 0, 1, 0, 0);
    context.clearRect(0, 0, canvas.width, canvas.height);
    const originX = Math.round(state.panX);
    const originY = Math.round(state.panY);
    context.setTransform(state.zoom, 0, 0, state.zoom, originX, originY);
    if (typeof context.imageSmoothingEnabled === "boolean") {
      context.imageSmoothingEnabled = false;
    }
    context.drawImage(offscreen, 0, 0);
  }

  function updateLabel() {
    shell.label.textContent = state.file === "" ? "(no file)" : state.file;
    shell.label.title = state.file;
    const image = state.image;
    if (image !== null) {
      widthInput.value = String(image.width);
      heightInput.value = String(image.height);
    }
    zoomReadout.textContent = `${state.zoom}×`;
  }

  function updateStatus(extra = null) {
    const image = state.image;
    const parts = [];
    if (extra !== null) {
      parts.push(extra);
    }
    if (state.file === "") {
      parts.push("no file");
    } else {
      parts.push(`${state.file}${state.origin === "file" ? "" : ` (${state.origin})`}`);
    }
    if (image !== null) {
      parts.push(`${image.width}×${image.height}`);
    }
    parts.push(`${state.zoom}×`);
    parts.push(state.tool);
    parts.push(state.colour);
    if (state.pointer !== null && image !== null) {
      const [r, g, b, a] = state.pointer;
      parts.push(a === 0 ? "transparent" : `${r},${g},${b}·${Math.round((a / 255) * 100)}%`);
    }
    if (state.readError !== null) {
      parts.push("not writable until it reloads");
    }
    if (state.baseRevision === null && state.origin === "new") {
      parts.push("reading…");
    }
    status.textContent = parts.join(" · ");
  }

  function paint() {
    paintTools();
    paintCanvas();
    updateLabel();
    updateStatus();
  }

  function renderStatus(message) {
    updateStatus(message);
  }

  function report(message, level = "info") {
    app.log(level, message);
    renderStatus(message);
  }

  /* -- the board field ------------------------------------------------- */

  /**
   * Keep the board document's four fields in step with the card.  `record:
   * false` because opening a file or declaring a size is not an edit anybody
   * wants to take back with Ctrl+Z -- the pixels are the edits, and they live
   * in this card's own ring.
   */
  function writeToBoard() {
    if (state.file !== card.file) {
      card.file = state.file;
    }
    if (state.image !== null) {
      if (card.width !== state.image.width) {
        card.width = state.image.width;
      }
      if (card.height !== state.image.height) {
        card.height = state.image.height;
      }
    }
    card.palette = state.palette.slice();
    app.boardTouched(true, { record: false });
  }

  /* -- history: this card's own ring ---------------------------------- */

  /** True when the pixels are exactly what was last loaded or saved. */
  function atClean() {
    const step = state.index < 0 ? null : state.history[state.index];
    return step !== null && step.clean === true;
  }

  function resetHistory() {
    state.history = [];
    state.index = -1;
    // Nothing has been saved yet, so no position in the ring is "clean"; the
    // empty stack is what says so.
  }

  function markClean() {
    for (const step of state.history) {
      step.clean = false;
    }
    if (state.index >= 0) {
      state.history[state.index].clean = true;
    }
  }

  function pushStep(before, after, label) {
    state.history = state.history.slice(0, state.index + 1);
    state.history.push({ before, after, label, clean: false });
    while (state.history.length > PIXEL_HISTORY) {
      state.history.shift();
    }
    state.index = state.history.length - 1;
  }

  /** Write one side of one touched pixel back. */
  function restorePixel(pixel, x, y) {
    const image = state.image;
    if (image === null) {
      return;
    }
    setPixelAt(image, x, y, [pixel.r, pixel.g, pixel.b, pixel.a]);
  }

  function cardUndo() {
    if (state.image === null || state.index < 0) {
      return false;
    }
    const step = state.history[state.index];
    for (const pixel of step.before) {
      restorePixel(pixel, pixel.x, pixel.y);
    }
    state.index -= 1;
    paintCanvas();
    updateStatus(`undid: the ${step.label}`);
    return true;
  }

  function cardRedo() {
    if (state.image === null || state.index + 1 >= state.history.length) {
      return false;
    }
    const step = state.history[state.index + 1];
    for (const pixel of step.after) {
      restorePixel(pixel, pixel.x, pixel.y);
    }
    state.index += 1;
    paintCanvas();
    updateStatus(`redid: the ${step.label}`);
    return true;
  }

  /* -- gestures ------------------------------------------------------- */

  function pixelTarget() {
    return state.tool === "eraser" ? [0, 0, 0, 0] : (pixelColourOf(state.colour) || [0, 0, 0, 0]);
  }

  function pixelLabel() {
    if (state.tool === "eraser") return "eraser stroke";
    if (state.tool === "fill") return "fill";
    if (state.tool === "eyedropper") return "eyedropper";
    return "pencil stroke";
  }

  /**
   * One pixel, recorded into the pending step.  `fill` says the caller already
   * knew the pixel's colour from `pixelAt`, so the read after the write is
   * skipped -- a flood fill over a transparent region would otherwise do one
   * `pixelAt` per pixel for an answer it already had.
   */
  function stamp(x, y, rgba, known) {
    const image = state.image;
    if (image === null || state.pending === null) {
      return;
    }
    const before = known === undefined ? pixelAt(image, x, y) : known;
    if (before === null) {
      return;
    }
    if (before[0] === rgba[0] && before[1] === rgba[1] && before[2] === rgba[2] && before[3] === rgba[3]) {
      return;
    }
    setPixelAt(image, x, y, rgba);
    const after = [rgba[0], rgba[1], rgba[2], rgba[3]];
    state.pending.touched.set(y * image.width + x, { x, y, before, after });
    state.pending.count += 1;
  }

  /**
   * Walk the line between two pixels.  A pointer move can jump many pixels, so
   * a stamp per event leaves gaps; Bresenham is what makes a fast drag a line.
   */
  function strokeLine(x0, y0, x1, y1) {
    const rgba = pixelTarget();
    let x = x0;
    let y = y0;
    const dx = Math.abs(x1 - x0);
    const dy = -Math.abs(y1 - y0);
    const sx = x0 < x1 ? 1 : -1;
    const sy = y0 < y1 ? 1 : -1;
    let err = dx + dy;
    let guard = 0;
    const limit = dx - dy + 2;
    for (;;) {
      stamp(x, y, rgba);
      if ((x === x1 && y === y1) || guard > limit) {
        return;
      }
      const twice = 2 * err;
      if (twice >= dy) {
        err += dy;
        x += sx;
      }
      if (twice <= dx) {
        err += dx;
        y += sy;
      }
      guard += 1;
    }
  }

  /** 4-way flood fill of the same-coloured region under the pointer. */
  function floodFill(x, y) {
    const image = state.image;
    if (image === null) {
      return;
    }
    const seed = pixelAt(image, x, y);
    const rgba = pixelTarget();
    if (seed === null
      || (seed[0] === rgba[0] && seed[1] === rgba[1] && seed[2] === rgba[2] && seed[3] === rgba[3])) {
      return;
    }
    const queued = new Set();
    const queue = [[x, y]];
    queued.add(y * image.width + x);
    while (queue.length > 0) {
      const [cx, cy] = queue.pop();
      const here = pixelAt(image, cx, cy);
      if (here === null
        || here[0] !== seed[0] || here[1] !== seed[1] || here[2] !== seed[2] || here[3] !== seed[3]) {
        continue;
      }
      stamp(cx, cy, rgba, here);
      for (const [nx, ny] of [[cx + 1, cy], [cx - 1, cy], [cx, cy + 1], [cx, cy - 1]]) {
        if (nx < 0 || ny < 0 || nx >= image.width || ny >= image.height) {
          continue;
        }
        const key = ny * image.width + nx;
        if (queued.has(key)) {
          continue;
        }
        queued.add(key);
        queue.push([nx, ny]);
      }
    }
  }

  /** The pointer's position in image pixels, from any event with clientX/Y. */
  function imagePoint(event) {
    const rect = typeof canvas.getBoundingClientRect === "function"
      ? canvas.getBoundingClientRect()
      : { left: 0, top: 0 };
    return {
      x: Math.floor(((event.clientX || 0) - (rect.left || 0) - state.panX) / state.zoom),
      y: Math.floor(((event.clientY || 0) - (rect.top || 0) - state.panY) / state.zoom),
    };
  }

  function stampAt(event) {
    const at = imagePoint(event);
    if (state.tool === "fill") {
      floodFill(at.x, at.y);
    } else {
      strokeLine(at.x, at.y, at.x, at.y);
    }
  }

  function readPixel(event) {
    const image = state.image;
    if (image === null) {
      return;
    }
    const at = imagePoint(event);
    const rgba = pixelAt(image, at.x, at.y);
    if (rgba === null) {
      return;
    }
    state.pointer = rgba;
    if (state.tool === "eyedropper") {
      state.colour = pixelInkOf(rgba);
      paintTools();
      paintSwatches();
    }
    updateStatus();
  }

  function panBy(dx, dy) {
    state.panX += dx;
    state.panY += dy;
    paintCanvas();
  }

  function startStroke(event) {
    const image = state.image;
    if (image === null) {
      ignoredWhileLoading += 1;
      report("no image loaded", "warn");
      return false;
    }
    if (state.tool === "eyedropper") {
      readPixel(event);
      return false;
    }
    state.pending = { touched: new Map(), count: 0, label: pixelLabel() };
    const at = imagePoint(event);
    stampAt(event);
    /*
     * Remember the down point.  Without it the first `pointermove` of a fast
     * drag would find `state.last` empty and stamp one pixel there instead of
     * drawing the line the drag actually covered.
     */
    state.last = state.tool === "fill" ? null : at;
    paintCanvas();
    return true;
  }

  function endStroke() {
    // Whatever ended the gesture, the window no longer needs to hear about it:
    // the listeners exist for exactly the length of one gesture.
    unbindGestureEnd();
    const pending = state.pending;
    state.pending = null;
    if (pending === null || pending.count === 0) {
      return;
    }
    // Only the pixels the gesture touched travel into the ring: an undo of one
    // pixel on a 96x96 sprite must not carry 36 KB of untouched pixels with it.
    // The two sides are separate copies -- a step that carried the same array
    // for both would restore the colour it was meant to take back.
    const touched = [...pending.touched.values()];
    const side = (pixel, key) => {
      const rgba = pixel[key];
      return { x: pixel.x, y: pixel.y, r: rgba[0], g: rgba[1], b: rgba[2], a: rgba[3] };
    };
    pushStep(touched.map((pixel) => side(pixel, "before")),
      touched.map((pixel) => side(pixel, "after")), pending.label);
    writeToBoard();
    updateStatus();
  }

  /*
   * A gesture that ends off the card still has to end.  The surface's own
   * `pointerup` never fires when the pointer is released over the toolbar, the
   * desk or another card, and an uncommitted stroke would leave the pixels
   * changed with nothing on the undo ring -- and the next gesture would carry
   * on from the old endpoint.  So the window is listened to for exactly as long
   * as a gesture is live: bound by the `pointerdown` that starts one, released
   * by `endStroke`, and the surface's own pointerup takes the same path.
   */
  function finishGesture() {
    if (state.panning !== undefined && state.panning !== null) {
      state.panning = null;
      canvas.classList.remove("is-panning");
      endStroke();
      return;
    }
    state.drawing = false;
    state.last = null;
    endStroke();
  }

  function bindGestureEnd() {
    if (gestureBound || typeof window === "undefined" || window === null
      || typeof window.addEventListener !== "function") {
      return;
    }
    gestureBound = true;
    window.addEventListener("pointerup", finishGesture);
    window.addEventListener("pointercancel", finishGesture);
  }

  function unbindGestureEnd() {
    if (!gestureBound) {
      return;
    }
    gestureBound = false;
    if (typeof window !== "undefined" && window !== null && typeof window.removeEventListener === "function") {
      window.removeEventListener("pointerup", finishGesture);
      window.removeEventListener("pointercancel", finishGesture);
    }
  }

  canvas.addEventListener("pointerdown", (event) => {
    if (event.button === 1 || (event.button === 0 && state.tool === "hand")) {
      state.panning = { x: event.clientX, y: event.clientY };
      canvas.classList.add("is-panning");
      bindGestureEnd();
      event.preventDefault();
      return;
    }
    if (event.button !== 0) {
      return;
    }
    if (startStroke(event)) {
      state.drawing = true;
      bindGestureEnd();
    }
    event.preventDefault();
  });

  surface.addEventListener("pointermove", (event) => {
    readPixel(event);
    if (state.panning !== undefined && state.panning !== null) {
      panBy(event.clientX - state.panning.x, event.clientY - state.panning.y);
      state.panning = { x: event.clientX, y: event.clientY };
      return;
    }
    if (!state.drawing) {
      return;
    }
    const image = state.image;
    if (image === null) {
      return;
    }
    const at = imagePoint(event);
    if (state.last !== undefined && state.last !== null) {
      strokeLine(state.last.x, state.last.y, at.x, at.y);
    } else {
      stampAt(event);
    }
    state.last = at;
    paintCanvas();
  });

  surface.addEventListener("pointerup", () => finishGesture());

  surface.addEventListener("pointerleave", () => {
    state.pointer = null;
    updateStatus();
  });

  canvas.addEventListener("wheel", (event) => {
    event.preventDefault();
    setZoom(state.zoom * (event.deltaY < 0 ? 2 : 0.5));
  });

  /* The canvas keeps its own history keystrokes: without this, Ctrl+Z over a
     drawing would move the *board* under it, because the pixels are
     deliberately not in the board's ring. */
  canvas.addEventListener("keydown", (event) => {
    /* The tool letters the button hints promise (B, E, G, I, H). */
    if (!event.ctrlKey && !event.metaKey && !event.altKey && PIXEL_TOOL_KEYS[String(event.key).toLowerCase()] !== undefined) {
      selectTool(PIXEL_TOOL_KEYS[String(event.key).toLowerCase()]);
      event.stopPropagation();
      event.preventDefault();
      return;
    }
    if (!(event.ctrlKey || event.metaKey) || event.key.toLowerCase() !== "z") {
      return;
    }
    event.stopPropagation();
    event.preventDefault();
    if (event.shiftKey) {
      if (!cardRedo()) {
        report("nothing to redo");
      }
      return;
    }
    if (!cardUndo()) {
      report("nothing to undo");
    }
  });

  canvas.addEventListener("contextmenu", (event) => event.preventDefault());

  function setZoom(wanted) {
    const next = Math.max(PIXEL_ZOOM_MIN, Math.min(PIXEL_ZOOM_MAX, Math.floor(Number(wanted) || PIXEL_ZOOM_MIN)));
    if (next === state.zoom) {
      return;
    }
    const rect = typeof canvas.getBoundingClientRect === "function"
      ? canvas.getBoundingClientRect()
      : { width: 0, height: 0 };
    const at = { x: (rect.width || 0) / 2, y: (rect.height || 0) / 2 };
    const before = { x: (at.x - state.panX) / state.zoom, y: (at.y - state.panY) / state.zoom };
    state.zoom = next;
    state.panX = Math.round(at.x - before.x * next);
    state.panY = Math.round(at.y - before.y * next);
    paintCanvas();
    updateLabel();
    updateStatus();
  }

  /* -- load, new, save ------------------------------------------------ */

  /** A kernel `NOT_FOUND` (1002) is not a failure: it is a file not written yet. */
  function isMissingFile(err) {
    const parts = [err && err.code, err && err.symbol, err && err.errorName, err && err.name];
    if (err && err.data && typeof err.data === "object") {
      parts.push(err.data.code, err.data.name);
    }
    return parts.some((part) => part === 1002 || String(part ?? "").includes("NOT_FOUND"));
  }

  function adoptBlank(width, height, origin) {
    state.image = blankImage(width, height, [0, 0, 0, 0]);
    state.origin = origin;
    state.baseRevision = null;
    resetHistory();
  }

  function newImage() {
    const width = Math.max(1, Math.min(4096, Math.floor(Number(widthInput.value) || PIXEL_NEW_SIZE)));
    const height = Math.max(1, Math.min(4096, Math.floor(Number(heightInput.value) || PIXEL_NEW_SIZE)));
    adoptBlank(width, height, "new");
    writeToBoard();
    report(`new image, ${width}×${height} — save to write it`);
    paint();
  }

  /**
   * Read the PNG.  A file that is not there yet is a new image; a file that is
   * there but cannot be decoded is a refusal: `state.readError` makes `save`
   * decline, so a card that cannot read a PNG never writes over it.
   */
  async function load(path) {
    if (state.busy) {
      return false;
    }
    state.busy = true;
    const wanted = typeof path === "string" && path.trim() !== "" ? path.trim().replace(/\\/g, "/") : state.file;
    state.file = wanted;
    state.readError = null;
    renderStatus("reading…");
    try {
      const result = await client.call("file.read_bytes", { path: wanted });
      state.baseRevision = result.revision === undefined ? null : result.revision;
      let bytes;
      try {
        const binary = atob(String(result.base64 || ""));
        bytes = new Uint8Array(binary.length);
        for (let i = 0; i < binary.length; i += 1) {
          bytes[i] = binary.charCodeAt(i);
        }
      } catch (err) {
        bytes = null;
        state.readError = `base64: ${err.message}`;
      }
      if (bytes !== null) {
        try {
          state.image = decodePng(bytes);
          state.origin = "file";
          resetHistory();
          writeToBoard();
          paint();
          report(`loaded ${state.image.width}×${state.image.height} — ${bytes.length} bytes${ignoredNote()}`);
          state.busy = false;
          return true;
        } catch (err) {
          state.readError = err.message;
        }
      }
    } catch (err) {
      if (!isMissingFile(err)) {
        state.image = null;
        report(`could not read ${wanted}: ${err.message}`, "error");
        paint();
        state.busy = false;
        return false;
      }
      // No file yet.  The declared size is what the person typed, or the size
      // the caller asked for; nothing is written until they press save.
      const width = Math.max(1, Math.min(4096, Math.floor(Number(widthInput.value) || Number(card.width) || PIXEL_NEW_SIZE)));
      const height = Math.max(1, Math.min(4096, Math.floor(Number(heightInput.value) || Number(card.height) || PIXEL_NEW_SIZE)));
      adoptBlank(width, height, "new");
      writeToBoard();
      paint();
      report(`new image, ${width}×${height} — save to write it${ignoredNote()}`, "warn");
      state.busy = false;
      return true;
    }
    // The bytes arrived but they are not a PNG this reader understands.
    const width = Math.max(1, Math.min(4096, Math.floor(Number(card.width) || PIXEL_NEW_SIZE)));
    const height = Math.max(1, Math.min(4096, Math.floor(Number(card.height) || PIXEL_NEW_SIZE)));
    adoptBlank(width, height, "unreadable");
    paint();
    report(`${wanted}: ${state.readError} — not saving over it${ignoredNote()}`, "error");
    state.busy = false;
    return false;
  }

  /** `Uint8Array` to base64, without `Buffer`: this page has `btoa`. */
  function base64Of(bytes) {
    let binary = "";
    const step = 0x8000;
    for (let i = 0; i < bytes.length; i += step) {
      binary += String.fromCharCode.apply(null, bytes.subarray(i, i + step));
    }
    return btoa(binary);
  }

  async function save() {
    if (state.image === null) {
      report("nothing to save", "warn");
      return false;
    }
    if (state.file === "") {
      report("no file to write — open one with `pixel <path.png>`", "warn");
      return false;
    }
    if (state.readError !== null) {
      report(`not saving: the file did not decode (${state.readError})`, "error");
      return false;
    }
    if (state.saving) {
      return false;
    }
    state.saving = true;
    const note = `${state.image.width}×${state.image.height}`;
    renderStatus("saving…");
    const base64 = base64Of(encodePng(state.image));
    const params = { path: state.file, base64 };
    if (state.baseRevision !== null) {
      params.base_revision = state.baseRevision;
    }
    try {
      const result = await client.call("file.write_bytes", params);
      state.baseRevision = result.revision === undefined ? state.baseRevision : result.revision;
      state.origin = "file";
      markClean();
      report(`saved ${note} — revision ${state.baseRevision}`,
        state.baseRevision === null ? "warn" : "info");
      return true;
    } catch (err) {
      if (client.isStaleRevision(err)) {
        // The file moved under us.  `resolveStale` is the app's own question,
        // so the answer is the same one an editor card gets; the one thing this
        // must never do is write anyway.
        const current = err.data === null || err.data === undefined
          ? null
          : (typeof err.data === "object" ? err.data.current_revision : err.data);
        const choice = app.resolveStale
          ? await app.resolveStale({ path: state.file, current, cardId: card.id })
          : "cancel";
        state.saving = false;
        if (choice === "overwrite") {
          state.baseRevision = typeof current === "number" ? current : null;
          return save();
        }
        if (choice === "reload") {
          await load(state.file);
          return false;
        }
        report(`${state.file} changed on disk; nothing was written`, "warn");
        return false;
      }
      report(`save failed: ${err.message}`, "error");
      return false;
    } finally {
      state.saving = false;
    }
  }

  /* -- go ------------------------------------------------------------- */

  // A caller can hand the declared size in through the card fields, which is
  // how the D006 row opens a missing sprite at a usable size.
  widthInput.value = String(Math.max(1, Math.floor(Number(card.width) || PIXEL_NEW_SIZE)));
  heightInput.value = String(Math.max(1, Math.floor(Number(card.height) || PIXEL_NEW_SIZE)));
  paintTools();
  paintSwatches();
  paint();

  const startPath = state.file !== ""
    ? state.file
    : (typeof card.file === "string" ? card.file : "");
  if (startPath !== "") {
    load(startPath);
  } else {
    adoptBlank(
      Math.max(1, Math.floor(Number(card.width) || PIXEL_NEW_SIZE)),
      Math.max(1, Math.floor(Number(card.height) || PIXEL_NEW_SIZE)),
      "new",
    );
    writeToBoard();
    paint();
    renderStatus("no file yet — open one with `pixel <path.png>`, or save this one");
  }

  /*
   * The first paint above runs while the card is still being assembled, so the
   * surface can measure a detached 0x0 rect and the bitmap would stay 1x1 until
   * the person happened to interact with it.  Nothing re-measures after layout,
   * so one repaint is scheduled for the next frame -- where the environment has
   * frames at all (the probe has none, and does not need one; it paints again
   * through the same `paintCanvas` once it lays the surface out).
   */
  if (typeof requestAnimationFrame === "function") {
    requestAnimationFrame(() => paint());
  }

  return {
    el: shell.el,
    handle: {
      kind: "pixel",
      // The app asks the focused card to take the step first; `true` means the
      // board's own undo ring must not move as well.
      undo: cardUndo,
      redo: cardRedo,
      save,
      load,
      newImage,
      canUndo() {
        return state.index >= 0;
      },
      canRedo() {
        return state.index + 1 < state.history.length;
      },
      /** How many gestures are on the card's own ring. */
      steps() {
        return state.history.length;
      },
      /** The pixels, for a caller or a test: `{width, height, pixels}`. */
      image() {
        return state.image;
      },
      /** The PNG a save would write, as bytes. */
      bytes() {
        return state.image === null ? null : encodePng(state.image);
      },
      get path() {
        return state.file;
      },
      get revision() {
        return state.baseRevision;
      },
      get dirty() {
        return !atClean() && state.index >= 0;
      },
      get readError() {
        return state.readError;
      },
      hasPath(path) {
        return state.file !== "" && state.file === path;
      },
      focus() {
        canvas.focus();
      },
    },
    destroy() {
      // Every listener lives on an element inside this card, so removing the
      // element removes them; the only things that outlive it are the pending
      // stroke and the window's gesture-end listener, and neither is worth
      // anything without the image.
      state.drawing = false;
      state.panning = null;
      state.pending = null;
      unbindGestureEnd();
    },
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

/**
 * The mod-root-relative path of one define entry, or "".  `mod.open` names it
 * `file`; a host that still says `path` is read too, because a heading and a row
 * that cannot name their file are the same dead click.
 */
export function defineRel(item) {
  if (item === null || typeof item !== "object") {
    return "";
  }
  if (typeof item.file === "string" && item.file !== "") {
    return item.file;
  }
  return typeof item.path === "string" ? item.path : "";
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
 * `empty: true` marks the one placeholder row of a section with nothing in it,
 * and `severity` tints the row with the shared `.sev-*` colours.  `extra` is one
 * more control on the row -- `{label, onClick, title}` -- for a row whose
 * second target would otherwise be unreachable (a D006 sprite row points at
 * two files: the image that is missing and the JSON that asks for it).
 *
 * `onClick` makes the *title* a target too, which is how the mod card's three
 * section headings open the file they head.  It is a keyboard-reachable div and
 * not a <button>: the stylesheet draws the heading as an inert label, and a
 * button element would paint its own chrome over it.
 */
function section(className, title, count, onClick) {
  const label = count === undefined ? title : `${title} (${count})`;
  const head = h("div", "mod-section-title", {
    text: label,
    attrs: onClick
      ? { role: "button", tabindex: "0", title: `open the ${title} file` }
      : {},
  });
  if (onClick) {
    head.style.cursor = "pointer";
    head.addEventListener("click", onClick);
    head.addEventListener("keydown", (event) => {
      if (event.key !== "Enter" && event.key !== " ") {
        return;
      }
      event.preventDefault();
      onClick(event);
    });
  }
  const rows = h("div", "mod-rows");
  return { el: h("div", `mod-section ${className}`, { children: [head, rows] }), rows };
}

function fillRows(container, rows) {
  const frag = document.createDocumentFragment();
  for (const row of rows) {
    const classes = ["mod-row"];
    if (row.dir) classes.push("is-dir");
    if (row.empty) classes.push("mod-row-empty");
    if (row.severity) classes.push(`sev-${row.severity}`);
    const el = h(row.onClick ? "button" : "div", classes.join(" "), {
      attrs: row.onClick ? { type: "button", title: row.title ?? "" } : {},
    });
    el.append(h("span", "mod-row-name", { text: row.label }));
    if (row.meta !== undefined && row.meta !== "") {
      el.append(h("span", "mod-row-meta", { text: row.meta }));
    }
    if (row.extra) {
      const extra = h("span", "mod-row-extra", {
        attrs: { role: "button", tabindex: "0", title: row.extra.title ?? "", "data-role": "mod-row-extra" },
        text: row.extra.label,
      });
      extra.addEventListener("click", (event) => {
        event.stopPropagation();
        row.extra.onClick(event);
      });
      extra.addEventListener("keydown", (event) => {
        if (event.key !== "Enter" && event.key !== " ") {
          return;
        }
        event.stopPropagation();
        event.preventDefault();
        row.extra.onClick(event);
      });
      el.append(extra);
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
    attrs: {
      type: "text",
      spellcheck: "false",
      // `Mods/MyMod` pointed at `<workspace>/Mods/MyMod`, which is not where
      // `mod.open` resolves a relative name: it joins the *mods root* (the
      // workspace itself under `serve`). The example has to be a name that
      // works, and the hint under it says how relative paths are read.
      placeholder: "NewMod",
      title: "a name relative to the mods root, or an absolute path",
    },
  });
  dirInput.value = typeof card.dir === "string" ? card.dir : "";

  const openButton = button("open", "read mod.json and list the package", () => openMod());
  const validateButton = button("validate", "check every define and Yarn file", () => validate());
  const controls = h("div", "mod-controls", { children: [dirInput, openButton, validateButton] });

  const headline = h("div", "mod-headline");
  const counts = h("div", "mod-counts");
  const modJsonSection = section("mod-manifest", "mod.json", undefined, () => openSectionFile("mod.json"));
  const definesSection = section("mod-defines", "Defines", undefined, () => openSectionFile("defines"));
  const yarnSection = section("mod-yarn", "Yarn", undefined, () => openSectionFile("yarn"));
  const status = makeStatus();

  /** What the last successful `mod.open` returned, or null before the first. */
  let opened = null;

  const body = h("div", "card-body card-body-mod", {
    children: [controls, headline, counts, modJsonSection.el, definesSection.el, yarnSection.el, status],
  });
  const shell = cardShell(card, body);
  shell.label.textContent = dirInput.value === "" ? "(no dir)" : dirInput.value;

  let requestSeq = 0;

  /**
   * The file a section heading opens, or null when the package has nothing for
   * that section yet.  `mod.json` is always `<root>/mod.json`; Defines opens the
   * first define file and Yarn the first Yarn file, in the order the rows list
   * them, so the heading that names a file does open that file.
   */
  function sectionFile(kind) {
    const root = opened !== null && typeof opened.root === "string" && opened.root !== ""
      ? opened.root
      : dirInput.value.trim();
    if (root === "") {
      return null;
    }
    if (kind === "mod.json") {
      return modPath(root, "mod.json");
    }
    if (kind === "defines") {
      // `mod.open` names a define's file `file`; older hosts called it `path`.
      const first = groupDefines(opened === null ? [] : opened.defines)
        .flatMap((group) => group.items)
        .map((item) => defineRel(item))
        .find((rel) => rel !== "");
      return first === undefined ? null : modPath(root, first);
    }
    const yarnFiles = opened !== null && Array.isArray(opened.yarnFiles) ? opened.yarnFiles : [];
    const first = yarnFiles.find((entry) => typeof (typeof entry === "string" ? entry : entry.path) === "string");
    if (first === undefined) {
      return null;
    }
    return modPath(root, typeof first === "string" ? first : first.path);
  }

  const SECTION_NAMES = { "mod.json": "mod.json", defines: "Defines", yarn: "Yarn" };

  function openSectionFile(kind) {
    const path = sectionFile(kind);
    if (path === null || path === "") {
      app.log("warn", `the ${SECTION_NAMES[kind] ?? kind} section has nothing to open yet`);
      return;
    }
    app.openFile(path);
  }

  /** Fill a section, or its one placeholder row when there is nothing in it. */
  function fillOrEmpty(sectionEl, rows) {
    fillRows(sectionEl.rows, rows.length === 0 ? [{ label: "（空）", empty: true }] : rows);
  }

  async function openMod() {
    const dir = dirInput.value.trim();
    if (dir === "") {
      status.textContent = "give a mod directory first";
      app.log("warn", "mod: type NewMod (relative to the mods root) or an absolute path first");
      return;
    }
    const seq = requestSeq + 1;
    requestSeq = seq;
    status.textContent = "opening…";
    let result;
    try {
      result = await client.call("mod.open", { dir });
    } catch (err) {
      status.textContent = `open failed: ${err.message}`;
      // A failed open used to leave only this one line inside the card, which
      // is clipped in the default tile layout: the log gives it a second exit.
      app.log("warn", `cannot open ${dir}: ${err.message}`);
      return;
    }
    if (seq !== requestSeq) {
      return;
    }
    opened = result;

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
    fillOrEmpty(modJsonSection, Object.keys(manifest).map((key) => ({
      label: key,
      meta: typeof manifest[key] === "object" ? JSON.stringify(manifest[key]) : String(manifest[key]),
    })));

    const root = opened.root ?? dir;
    const grouped = groupDefines(opened.defines);
    fillOrEmpty(definesSection, grouped.flatMap((group) => [
      { label: group.type, meta: `${group.items.length}`, title: group.type },
      ...group.items.map((item) => {
        const rel = defineRel(item);
        return {
          label: `  ${item.techName}`,
          meta: rel,
          title: rel,
          onClick: rel === "" ? undefined : () => app.openFile(modPath(root, rel)),
        };
      }),
    ]));

    const yarnFiles = Array.isArray(opened.yarnFiles) ? opened.yarnFiles : [];
    fillOrEmpty(yarnSection, yarnFiles.map((entry) => {
      const rel = typeof entry === "string" ? entry : entry.path;
      return {
        label: typeof rel === "string" ? rel.split("/").pop() : String(rel),
        meta: typeof rel === "string" ? rel.split("/").slice(0, -1).join("/") : "",
        title: rel,
        onClick: () => app.openFile(modPath(root, rel)),
      };
    }));

    /*
     * `mod.open` is tolerant by design: a missing directory, a broken mod.json
     * and an unreadable file all come back as diagnostics rather than an error,
     * so the card can still list whatever it did find.  Tolerant is not the same
     * as silent -- a package the host called an error (`OPEN001` when the path is
     * not a directory, `M001` for a missing or broken manifest) is a failed open,
     * and before this it kept the "opened <root>" line and hid the reason.
     */
    const diagnostics = Array.isArray(opened.diagnostics) ? opened.diagnostics : [];
    const errors = diagnostics.filter((one) => one !== null && one !== undefined && one.severity === "error");
    if (errors.length > 0) {
      const first = errors[0];
      const reason = typeof first.message === "string" && first.message !== ""
        ? first.message
        : String(first.code ?? "the package cannot be opened");
      status.textContent = `open failed: ${reason}`;
      app.log("warn", `cannot open ${dir}: ${reason}`);
    } else {
      status.textContent = `opened ${root}`;
      app.log("info", `opened ${root}`);
    }
    app.boardTouched(true);
  }

  async function validate() {
    const dir = dirInput.value.trim();
    if (dir === "") {
      status.textContent = "give a mod directory first";
      app.log("warn", "mod validate: type NewMod (relative to the mods root) or an absolute path first");
      return;
    }
    status.textContent = "validating…";
    let report;
    try {
      report = await client.call("mod.validate", { root: dir });
    } catch (err) {
      status.textContent = `validate failed: ${err.message}`;
      app.log("warn", `cannot validate ${dir}: ${err.message}`);
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

  // An unopened card says how the input is read and shows each section's
  // placeholder: a blank rectangle gave no clue that `Mods/MyMod` was wrong.
  counts.textContent = "relative paths resolve against the mods root; an absolute path also works";
  fillOrEmpty(modJsonSection, []);
  fillOrEmpty(definesSection, []);
  fillOrEmpty(yarnSection, []);

  if (dirInput.value !== "") {
    openMod();
  } else {
    status.textContent = "NewMod (relative to the mods root) or an absolute path, then Enter";
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
      const row = {
        label: `${diagnostic?.code ?? "?"} ${diagnostic?.message ?? ""}`,
        meta: where === "" ? target : `${target} ${where}`,
        title: diagnostic?.message ?? "",
        severity: diagnostic?.severity ?? "info",
        onClick: target === "" ? undefined : () => app.openFile(modPath(root, target)),
      };
      /*
       * D006 is the one diagnostic whose *subject* is another file: the JSON is
       * fine, the sprite it names is not there.  The sprite path is `actual`
       * (mod-root-relative, never carrying the `#json/pointer` that `path`
       * does), so the row opens a pixel card for it -- and the declaring JSON
       * stays one click away on the meta line rather than being replaced.
       */
      if (row.label.startsWith("D006") && typeof diagnostic.actual === "string") {
        const sprite = diagnostic.actual.replace(/\\/g, "/").split("#")[0];
        if (sprite !== "" && typeof app.openPixelCard === "function") {
          row.onClick = () => app.openPixelCard(modPath(root, sprite));
          row.extra = {
            label: target === "" ? "declaring file" : `declared in ${target}`,
            title: `open ${target}, the file that declares this sprite`,
            onClick: () => app.openFile(modPath(root, target)),
          };
        }
      }
      return row;
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

registerCardKind({
  kind: "story",
  title: "Story",
  describe: (card) => `story ${card.file || "(no file)"}`,
  create: () => ({ file: "" }),
  render: renderStory,
});

registerCardKind({
  kind: "pixel",
  title: "Pixel",
  describe: (card) => `pixel ${card.file || "(no file)"}`,
  // The four fields are the whole board-side card.  `width`/`height` are the
  // *declared* size a missing file is created at -- the game's own 96x96 sprite
  // convention -- and `palette` travels in the document so a fork's colours come
  // back with the board.
  create: () => ({ file: "", width: PIXEL_NEW_SIZE, height: PIXEL_NEW_SIZE, palette: PIXEL_PALETTE.slice() }),
  render: renderPixel,
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
