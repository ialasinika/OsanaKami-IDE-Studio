/**
 * cards/text.mjs -- the pure text side of a card -- tokens, listings, commands, output, search, completion.
 *
 * Part of `cards.mjs`, which re-exports this file; see that file's header for
 * why the card layer is split the way it is.
 */

/**
 * Kinds the wire may carry, mapped to the class suffix `style.css` styles.
 * `ws` and `ident` are emitted by `langs/tokenize.mjs` even though the contract
 * omits them; both are painted as ordinary text rather than dropped.
 */
export const KNOWN_KINDS = new Set([
  "comment", "string", "number", "keyword", "type", "constant",
  "command", "punct", "plain",
]);

export const PLAIN_LIKE = new Set(["plain", "ws", "ident", ""]);

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
export function comparePaths(a, b) {
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

/** One indent step: four spaces, the step the tree's C and JS already use. */
export const INDENT_UNIT = "    ";

/** A line ending in one of these opens a block, so the next line steps in. */
export const BLOCK_OPENERS = "{([";

/** Clamp to a real position in `text`, and never return an inverted range. */
export function clampRange(text, start, end) {
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

/* -------------------- the Yarn language service, card side -------------------- */

/*
 * The shell's `mod.complete` / `mod.hover` answer questions about the text in
 * the editor, never about a file on disk: an author asks about the line they are
 * typing, which is usually unsaved.  The two verbs are in `shell/main.mjs` and
 * the answers come from `shell/mods/complete.js`; what lives here is the part
 * that decides what a card shows and where an accepted candidate goes -- pure
 * functions, so the selftest can hold the arithmetic still without a browser.
 *
 * A shell without the mod layer (an older kernel, a build with the layer cut)
 * answers with an error.  That is not a reason to break editing: every function
 * below treats an absent answer as "nothing to show", and the editor simply has
 * no menu.  The card stops asking after the first error rather than retrying on
 * every keystroke.
 */

/** The most candidates the menu shows.  The service answers up to 200. */
export const COMPLETION_LIMIT = 8;

/**
 * How each context kind is named in the menu's own line.
 *
 * The keys are the `kind` values `classify()` returns in
 * `shell/mods/complete.js`; `none` has no label because there is no menu.
 */
export const COMPLETION_KIND_LABELS = Object.freeze({
  command: "指令",
  argument: "参数",
  variable: "变量",
  character: "角色",
  speaker: "角色",
  tag: "标签",
  tagvalue: "标签值",
  none: "",
});

/** The label for a context kind, or the kind itself when it is one we do not know. */
export function completionKindLabel(kind) {
  const key = typeof kind === "string" ? kind : "";
  return Object.prototype.hasOwnProperty.call(COMPLETION_KIND_LABELS, key)
    ? COMPLETION_KIND_LABELS[key]
    : key;
}

/** Whether this card should ask the language service at all: it is a `.yarn` file. */
export function isYarnPath(path) {
  return typeof path === "string" && /\.yarn$/i.test(path);
}

/**
 * One candidate, copied into the shape the menu uses: every field is a string,
 * and the span it replaces is always a real `{startOffset, endOffset}`.
 *
 * The service sends the span on each item *and* on the context; the item's own
 * copy wins, the context is the fallback for a shell that sends only one.
 */
export function completionCandidate(raw, fallback) {
  const item = raw === null || typeof raw !== "object" ? {} : raw;
  const span = item.replace === null || typeof item.replace !== "object" ? fallback : item.replace;
  const start = Number.isInteger(span && span.startOffset) ? span.startOffset : fallback.startOffset;
  const end = Number.isInteger(span && span.endOffset) ? span.endOffset : start;
  return {
    label: item.label == null ? "" : String(item.label),
    kind: item.kind == null ? "" : String(item.kind),
    detail: item.detail == null ? "" : String(item.detail),
    insertText: item.insertText == null
      ? (item.label == null ? "" : String(item.label))
      : String(item.insertText),
    replace: { startOffset: start, endOffset: end < start ? start : end },
  };
}

/**
 * What to show for one `mod.complete` answer at one caret.
 *
 * Answers `{open, text, caret, kind, kindLabel, prefix, replace, items, total,
 * more}`: `items` is at most `COMPLETION_LIMIT` long, `total` is how many the
 * service offered and `more` says the menu is hiding some.  `open` is false when
 * there is nothing to show -- an empty list, a missing answer, or a shell that
 * answered with junk -- and then `items` is empty and the caller closes the menu.
 *
 * @param {string} text   the document as the editor holds it
 * @param {number} caret  0-based UTF-16 offset, the same unit the service uses
 * @param {object|null} answer  the `mod.complete` result
 */
export function completionState(text, caret, answer) {
  const src = typeof text === "string" ? text : "";
  const at = Number.isInteger(caret) && caret >= 0 && caret <= src.length ? caret : src.length;
  const none = {
    open: false,
    text: src,
    caret: at,
    kind: "",
    kindLabel: "",
    prefix: "",
    replace: { startOffset: at, endOffset: at },
    items: [],
    total: 0,
    more: false,
  };
  if (answer === null || typeof answer !== "object") {
    return none;
  }
  const context = answer.context === null || typeof answer.context !== "object" ? {} : answer.context;
  const contextSpan = context.replace === null || typeof context.replace !== "object"
    ? { startOffset: at, endOffset: at }
    : {
      startOffset: Number.isInteger(context.replace.startOffset) ? context.replace.startOffset : at,
      endOffset: Number.isInteger(context.replace.endOffset) ? context.replace.endOffset : at,
    };
  const raw = Array.isArray(answer.items) ? answer.items : [];
  const items = raw.map((item) => completionCandidate(item, contextSpan));
  const kind = typeof context.kind === "string" ? context.kind : "";
  if (items.length === 0) {
    return Object.assign(none, { kind, kindLabel: completionKindLabel(kind), prefix: String(context.prefix == null ? "" : context.prefix) });
  }
  return {
    open: true,
    text: src,
    caret: at,
    kind,
    kindLabel: completionKindLabel(kind),
    prefix: String(context.prefix == null ? "" : context.prefix),
    replace: contextSpan,
    items: items.slice(0, COMPLETION_LIMIT),
    total: items.length,
    more: items.length > COMPLETION_LIMIT,
  };
}

/**
 * Put one accepted candidate into the document.
 *
 * The candidate's own span is replaced with its `insertText` and the caret ends
 * up after the inserted text -- the service already decided what the insertion
 * looks like (`jump ` for a command, `Speaker: ` for a speaker), so nothing here
 * adds separators of its own.
 *
 * @returns {{text: string, caret: number}}
 */
export function applyCompletion(state, item) {
  const current = state === null || typeof state !== "object" ? {} : state;
  const text = typeof current.text === "string" ? current.text : "";
  const candidate = item === null || typeof item !== "object" ? {} : item;
  const fallback = current.replace === null || typeof current.replace !== "object"
    ? { startOffset: text.length, endOffset: text.length }
    : current.replace;
  const span = candidate.replace === null || typeof candidate.replace !== "object"
    ? fallback
    : candidate.replace;
  const start = Math.max(0, Math.min(text.length,
    Number.isInteger(span.startOffset) ? span.startOffset : text.length));
  const end = Math.max(start, Math.min(text.length,
    Number.isInteger(span.endOffset) ? span.endOffset : start));
  const inserted = candidate.insertText == null ? "" : String(candidate.insertText);
  return {
    text: `${text.slice(0, start)}${inserted}${text.slice(end)}`,
    caret: start + inserted.length,
  };
}

/**
 * The index the menu should stand on after moving `delta` rows, wrapping at both
 * ends.  `-1` when the menu is closed -- there is nothing to move through.
 */
export function stepCompletion(state, delta) {
  const current = state === null || typeof state !== "object" ? null : state;
  const count = current !== null && Array.isArray(current.items) ? current.items.length : 0;
  if (count === 0) {
    return -1;
  }
  const from = Number.isInteger(current.index) ? current.index : 0;
  const step = Number.isInteger(delta) ? delta : 0;
  return ((from + step) % count + count) % count;
}

/**
 * The one line to show under the code for a `mod.hover` answer, as plain text.
 *
 * The service marks its prose up in markdown; the card has no renderer and does
 * not want one, so the markers are collapsed to spaces and runs of whitespace
 * become one space.  An answer with no content -- null, or an empty `contents`
 * list -- clears the line, which is the honest state: nothing is known here.
 *
 * @param {object|null} answer
 * @returns {string}
 */
export function hoverLine(answer) {
  if (answer === null || typeof answer !== "object") {
    return "";
  }
  const contents = Array.isArray(answer.contents) ? answer.contents : [];
  if (contents.length === 0) {
    return "";
  }
  const first = contents[0];
  const value = first !== null && typeof first === "object" && typeof first.value === "string"
    ? first.value
    : "";
  // One line: markdown emphasis and heading marks go, the little arrows that
  // are part of the language's own spelling (`<<jump>>`) stay.
  return value.replace(/[#*_`]/g, " ").replace(/\s+/g, " ").trim();
}

/* -------------------- editor -------------------- */
