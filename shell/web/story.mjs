/* story.mjs -- a `.yarn` file, parsed into something a list can draw.
 *
 * The editor that will use this has to rewrite a real mod's story files, and
 * those files are not ours: 211 of them live under `Mods/`, some are CRLF, some
 * start with a BOM, some end without a newline, and `#line:` ids in the wild are
 * as often `TellTruth` or `a201` as they are seven hex digits.  A parser that
 * "normalises" any of that corrupts a file the first time it is merely opened.
 *
 * So the parse is a *view over the lines*, not a replacement for them:
 *
 *   raw      every line keeps the exact characters it had, minus its newline
 *   eol      the file's line ending, remembered once, not per line
 *   edits    a line is regenerated from its parts only after `setLineText` or
 *            `setLineSpeaker` touched it; every other line is emitted as `raw`
 *
 * That is what makes `serializeStory(parseStory(text)) === text` true for *any*
 * input, including files this module cannot fully classify: a line it does not
 * understand is a `raw` line with `kind: "other"`, and it comes back out
 * untouched.  Never rebuilding a line nobody changed is the whole design.
 *
 * Pure, so it runs under Node: no DOM, no clock, no I/O, no imports.
 */

/**
 * The line kinds the classifier produces.
 *
 * `other` is not a failure and not a leftover: it is body text this module has
 * no rule for, kept so a caller can still see it and still write it.  A parser
 * that gives every line a home it does not deserve is how text gets eaten.
 */
export const STORY_LINE_KINDS = Object.freeze([
  "blank",     // empty, or spaces and tabs only
  "comment",   // `// ...`
  "command",   // `<<...>>`, optionally followed by a `// ...`
  "option",    // `-> ...`
  "dialogue",  // `[=>]Name: text` with a trailing `#...` run
  "hashtag",   // nothing but a `#...` run
  "other",     // body text with no rule; kept verbatim
]);

/** The node separator line, and the header/body separator line. */
export const STORY_NODE_SEPARATOR = "===";
export const STORY_HEADER_SEPARATOR = "---";

/** A `key:` header line, with or without a space after the colon. */
const HEADER_LINE = /^([A-Za-z_][A-Za-z0-9_]*)[ \t]*:/;

/**
 * Any `#line:` marker at all, for asking "is this line marked?".
 *
 * Deliberately looser than `LINE_ID`, which is the contract's seven-hex pattern:
 * the corpus also carries short and non-hex markers, and a line that fails the
 * strict pattern is still a marked line, not a header.
 */
const LINE_MARKER = /#line:/;

/**
 * The keys the real mods actually put in a node header.
 *
 * Measured over all 211 files rather than guessed: `when` and `tracking` are the
 * two that carry spaces in their value, and `permission`, `position`, `Character`
 * and `Topic` are rarer than the four a reader would list from memory.
 */
export const STORY_HEADER_KEYS = Object.freeze([
  "title",
  "subtitle",
  "when",
  "tags",
  "permission",
  "position",
  "tracking",
  "Character",
  "Topic",
]);

/**
 * True for a header line, on the file's terms rather than the regex's.
 *
 * `[ \t]*` happily matches no space at all, so shape alone cannot decide: the real
 * corpus holds 7,397 body lines shaped exactly like a header, every one of them a
 * speaker line, and `Aistalt: 嗨。#state:Idle #line:07c13ab ` would be read as a key
 * called `Aistalt`.  What separates them is not the spacing -- `title: Morning` has
 * a space -- but the `#line:` marker and the key itself: a marked line is dialogue,
 * and a key outside `STORY_HEADER_KEYS` is a speaker who happens to be one word
 * long.  A header that is neither would be read as body text, which keeps the lines
 * a list exists to edit in the list.
 */
function isHeaderLine(line) {
  if (LINE_MARKER.test(line)) {
    return false;
  }
  if (!HEADER_LINE.test(line)) {
    return false;
  }
  const colon = line.indexOf(":");
  const key = line.slice(0, colon).trim();
  if (!STORY_HEADER_KEYS.includes(key)) {
    return false;
  }
  if (key === "tags") {
    // `tags:#hub #reach` is the one header whose value is allowed to hold spaces:
    // the corpus writes the list tight against the colon, and the space is part of
    // the value rather than a signal that this is a speaker line.
    return true;
  }
  const after = line.slice(colon + 1);
  return after.startsWith(" ") || after.startsWith("\t") || !/\s/.test(after);
}

/**
 * `-> text`, an option, indented or not.
 *
 * No lookahead for a space: 1,046 of the corpus's option lines are written
 * `->49年？<<once>> #line:0749555`, tight against the arrow.  What follows the
 * arrow is a character, so the text after it is a slice that cannot be empty --
 * a bare `->` has no option text to show and is left as body text.
 */
const OPTION_LINE = /^\s*->./;

/** `<<...>>`, an if/else block included, since Yarn writes those on one line. */
const COMMAND_LINE = /^\s*<</;

/** A line that is nothing but a `#...` run. */
const HASHTAG_LINE = /^\s*#\S/;

/**
 * `#line:` and whatever follows it.
 *
 * Deliberately not `[0-9a-f]{7}`: the real corpus also carries
 * `#line:TellTruth`, `#line:a201`, `#line:new_007` and `#line:0y7z8a9`, so an
 * id is any run of non-space, non-`#` characters.  `lineIdOf` is its only
 * reader, and the last `g` in the file is reset by every use.
 */
export const LINE_ID = /#line:([^\s#]+)/g;

/** A fresh id is always this shape: seven lowercase hex digits. */
const FRESH_ID_DIGITS = 7;

/** True for a line that is exactly the given marker, once trimmed. */
function isMarker(line, marker) {
  return line.trim() === marker;
}

/** True for a line with nothing on it but spaces and tabs. */
function isBlank(line) {
  return line.trim() === "";
}

/**
 * The index where a trailing `//` comment starts, or -1.
 *
 * Yarn needs whitespace before the `//`, which is what keeps a `https://` inside
 * a string literal out of the comment branch -- the corpus does not exercise
 * that, a fork's mod would.
 */
function commentStart(text) {
  for (let at = text.indexOf("//"); at !== -1; at = text.indexOf("//", at + 1)) {
    if (at > 0 && (text[at - 1] === " " || text[at - 1] === "\t")) {
      return at;
    }
  }
  return -1;
}

/**
 * Split the trailing run of `#`-tokens off a body line.
 *
 * The scan goes *forward*, and the first `#` that has nothing but space-separated
 * `#`-tokens after it starts the run, so a dialogue line's
 * `#state:Idle #Tech #line:...` comes back as one run and the text in front of it
 * is not polluted by any of it.  Walking backwards from the last `#` settles for
 * the final token and leaves `#state:` in the text -- which is how a state marker
 * went missing.  A line that is nothing but a run takes the run as its whole body,
 * and a line with no run at all comes back with an empty `tags`.
 *
 * `head` is kept character for character -- the space that separated text from
 * tags and the trailing space after them are the line's -- because only a caller's
 * edit may change a line, never this split.
 */
function splitTagRun(text) {
  /** True for one `#`-token: `#`, then no more `#` and no whitespace. */
  const isTag = (token) => /^#[^\s#]+$/.test(token);
  for (let at = text.indexOf("#"); at !== -1; at = text.indexOf("#", at + 1)) {
    if (at > 0 && !/\s/.test(text[at - 1])) {
      continue;
    }
    const tokens = text.slice(at).split(" ").filter((token) => token !== "");
    if (tokens.length > 0 && tokens.every(isTag)) {
      // The run is sliced, not re-joined from its tokens: a `#line:` marker at the
      // end of a line is followed by a space in the corpus, and rejoining would
      // delete it, so the line would not come back the way it went in.
      return { head: text.slice(0, at), tags: text.slice(at) };
    }
  }
  return { head: text, tags: "" };
}

/**
 * The parts of a dialogue line, or null when the line is not one.
 *
 * The speaker is whatever sits between the line's start and a colon with no
 * whitespace in it: `Aistalt`, `MaoGirl` and the corpus's `其他` are all speakers,
 * while `他说：` is not, because the colon there is full-width and a `:` inside
 * running text has a space in front of it by then.  `separator` is the index just
 * past the colon and the whitespace after it, so replacing the text of the line
 * cannot disturb either.
 */
function splitDialogue(line) {
  const indent = line.slice(0, line.length - line.trimStart().length);
  let rest = line.slice(indent.length);
  let arrow = "";
  if (rest.startsWith("=>")) {
    arrow = "=>";
    rest = rest.slice(2);
    // Space between the arrow and the name: `=> Aistalt: 那么预言……` is how 28 of
    // the corpus's lines are written, and skipping it here keeps the indent, the
    // arrow and the name in three separate pieces, so an edit cannot drop either.
    const gap = rest.slice(0, rest.length - rest.trimStart().length);
    if (gap !== "") {
      arrow += gap;
      rest = rest.slice(gap.length);
    }
  }
  const colon = rest.indexOf(":");
  if (colon <= 0) {
    return null;
  }
  const speaker = rest.slice(0, colon);
  if (/\s/.test(speaker) || !/^[\p{L}\p{N}_]+$/u.test(speaker)) {
    // A speaker is one name-shaped word.  `他说: 你好` is running text whose colon
    // happens to be half-width, and calling `他说` a speaker would put a narration
    // line in the dialogue list and let an edit rewrite the wrong span.
    return null;
  }
  const after = rest.slice(colon + 1);
  const lead = after.slice(0, after.length - after.trimStart().length);
  return { indent, arrow, speaker, separator: indent.length + arrow.length + colon + 1 + lead.length };
}

/** One entry per `#`-token in a run, `#` and all. */
function tagList(tags) {
  return tags === "" ? [] : tags.split(" ").filter((token) => token !== "");
}

/** The first attribute written as `key:value` in a run, or null. */
function attributeOf(tags, key) {
  const wanted = `#${key}:`;
  for (const tag of tagList(tags)) {
    if (tag.startsWith(wanted)) {
      return tag.slice(wanted.length);
    }
  }
  return null;
}

/** Every `#line:` id in the text, in order, ids only. */
function lineIdsIn(text) {
  const found = [];
  const pattern = new RegExp(LINE_ID.source, "g");
  for (let match = pattern.exec(text); match !== null; match = pattern.exec(text)) {
    found.push(match[1]);
  }
  return found;
}

/** The first `#line:` id in the text, or null -- the common case. */
function firstLineId(text) {
  const found = lineIdsIn(text);
  return found.length === 0 ? null : found[0];
}

/**
 * Classify one body line and read every field a list would want.
 *
 * `kind` and `raw` are always set, including for a line no rule fits: a caller
 * showing a line this module cannot name still has something to show, and
 * `serializeStory` still has something to write.
 */
function readBodyLine(line, index) {
  const base = { index, raw: line, indent: "", speaker: null, text: null, id: null,
    state: null, tags: [], command: null, comment: null };
  if (isBlank(line)) {
    return { ...base, kind: "blank" };
  }
  const body = line.trimStart();
  if (body.startsWith("//")) {
    return { ...base, kind: "comment", comment: body.slice(2).trim() };
  }
  if (COMMAND_LINE.test(line)) {
    const open = line.indexOf("<");
    const end = line.indexOf(">>");
    const command = end === -1 ? body : line.slice(open, end + 2);
    const tail = end === -1 ? "" : line.slice(end + 2);
    const commentAt = commentStart(tail);
    return {
      ...base,
      kind: "command",
      command,
      comment: commentAt === -1 ? null : tail.slice(commentAt + 2).trim(),
      tags: tagList(splitTagRun(commentAt === -1 ? tail : tail.slice(0, commentAt)).tags),
    };
  }
  if (OPTION_LINE.test(line)) {
    const arrow = line.indexOf("->") + 2;
    const split = splitTagRun(line.slice(arrow));
    const commentAt = commentStart(split.head);
    return {
      ...base,
      kind: "option",
      indent: line.slice(0, line.length - body.length),
      text: (commentAt === -1 ? split.head : split.head.slice(0, commentAt)).trim(),
      comment: commentAt === -1 ? null : split.head.slice(commentAt + 2).trim(),
      tags: tagList(split.tags),
      id: firstLineId(split.tags),
      state: attributeOf(split.tags, "state"),
    };
  }
  const dialogue = splitDialogue(line);
  if (dialogue !== null) {
    const split = splitTagRun(line.slice(dialogue.separator));
    const commentAt = commentStart(split.head);
    return {
      ...base,
      kind: "dialogue",
      indent: dialogue.indent,
      arrow: dialogue.arrow === "" ? null : dialogue.arrow,
      speaker: dialogue.speaker,
      text: (commentAt === -1 ? split.head : split.head.slice(0, commentAt)).trim(),
      comment: commentAt === -1 ? null : split.head.slice(commentAt + 2).trim(),
      tags: tagList(split.tags),
      id: firstLineId(split.tags),
      state: attributeOf(split.tags, "state"),
    };
  }
  if (HASHTAG_LINE.test(line)) {
    const split = splitTagRun(body);
    return {
      ...base,
      kind: "hashtag",
      indent: line.slice(0, line.length - body.length),
      tags: tagList(split.tags),
      id: firstLineId(split.tags),
      state: attributeOf(split.tags, "state"),
    };
  }
  if (HEADER_LINE.test(line)) {
    // A `key:` line that reached the body, which is what a node with no `---`
    // and a stray header line produces.  Naming it beats calling it `other`.
    // The regex is right here and `isHeaderLine` would be wrong: a body line that
    // reads as `key: value` is still worth naming, whatever its value looks like.
    const colon = line.indexOf(":");
    return { ...base, kind: "other", key: line.slice(0, colon), value: line.slice(colon + 1).trim() };
  }
  return { ...base, kind: "other" };
}

/**
 * Rebuild one edited line from its fields.
 *
 * Only ever called for a line a setter marked dirty, and only the parts the
 * setter put in `edit` are used: the indent, the `=>`, the exact whitespace after
 * the colon and the whole trailing tag run were carried through character for
 * character, which is what keeps a `#line:` id and its neighbours where the file
 * had them.
 */
function renderBodyLine(entry) {
  if (entry === null || typeof entry !== "object") {
    return typeof entry === "string" ? entry : "";
  }
  if (entry.edit === null || entry.edit === undefined) {
    return typeof entry.raw === "string" ? entry.raw : "";
  }
  return entry.edit.head + entry.edit.tail;
}

/**
 * Re-read a line the caller just edited, so a list still holding this entry
 * shows the new text instead of the one it was parsed with.
 */
function refreshEntry(entry) {
  const fields = readBodyLine(renderBodyLine(entry), entry.index);
  Object.assign(entry, fields);
  entry.edit = null;
  return entry;
}

/**
 * Split body lines into stored entries.
 *
 * An entry holds the parsed fields *and* `raw`, so a caller can read `line.text`
 * without asking first.  `edit` is the dirty mark and starts null; it is the one
 * key `storyLines` never exposes.
 */
function bodyEntries(lines) {
  return lines.map((line, index) => ({ ...readBodyLine(line, index), edit: null }));
}

/** The body entry at an index, or null when the node or index is not one. */
function lineAt(node, index) {
  if (node === null || typeof node !== "object" || !Array.isArray(node.bodyLines)) {
    return null;
  }
  const at = Number(index);
  if (!Number.isInteger(at) || at < 0 || at >= node.bodyLines.length) {
    return null;
  }
  return node.bodyLines[at];
}

/**
 * A stable 32-bit fold of a string iterable.
 *
 * `nextLineId` must hand out an id that depends on what is already used -- so
 * two different taken sets give different ids, and a test can assert on the
 * value -- but it must not depend on `Math.random`, or opening the same document
 * twice would offer two different ids.  FNV-1a is short, fixed, and enough.
 */
function hashOf(values) {
  let hash = 0x811c9dc5;
  for (const value of values) {
    const text = String(value);
    for (let at = 0; at < text.length; at += 1) {
      hash ^= text.charCodeAt(at);
      hash = Math.imul(hash, 0x01000193);
    }
    // The length, so ["ab","c"] and ["a","bc"] do not fold alike.
    hash ^= text.length;
    hash = Math.imul(hash, 0x01000193);
  }
  return hash >>> 0;
}

/** A 32-bit value as exactly `FRESH_ID_DIGITS` lowercase hex digits. */
function hexId(value) {
  let text = (value >>> 0).toString(16);
  while (text.length < FRESH_ID_DIGITS) {
    text = `0${text}`;
  }
  return text.slice(-FRESH_ID_DIGITS);
}

/**
 * A fresh `#line:` id that is not in `taken`.
 *
 * The starting point comes from the taken set -- not from a clock or a random
 * number -- so the same document always gets the same next id and `selftest` can
 * assert on it.  Scanning forward from there is what makes "never collides" true
 * by construction rather than by probability: a used slot is simply skipped.
 */
export function nextLineId(taken = []) {
  const used = new Set();
  if (taken !== null && taken !== undefined) {
    for (const value of taken) {
      used.add(String(value));
    }
  }
  const span = 16 ** FRESH_ID_DIGITS;
  const start = hashOf(used) % span;
  for (let step = 0; step < span; step += 1) {
    const candidate = hexId((start + step) % span);
    if (!used.has(candidate)) {
      return candidate;
    }
  }
  // Every id in the space is taken, so nothing fresh can be handed out; saying
  // so beats writing a marker that already means another line.
  throw new Error("no free #line: id remains");
}

/** The id of a `#line:` marker on one line, or null when it has none. */
export function lineIdOf(line) {
  return typeof line === "string" ? firstLineId(line) : null;
}

/**
 * Parse one node's lines: the header lines, then the body lines.
 *
 * The body starts after the first `---` at the top of the node, because a node
 * may carry several header blocks (25 in the corpus carry three or more) and only
 * the run that reaches `---` is a header.  A node with no `---` at all still has
 * headers -- its leading `key:` lines -- and everything after them is body, which
 * is the only reading that loses nothing.
 */
function parseNode(rawLines, startLine, first) {
  let split = -1;
  for (let at = 0; at < rawLines.length; at += 1) {
    if (isMarker(rawLines[at], STORY_HEADER_SEPARATOR)) {
      split = at;
      break;
    }
    if (!isHeaderLine(rawLines[at]) && !isBlank(rawLines[at])) {
      break;
    }
  }

  let headerLines = [];
  let bodyLines = [];
  // The `---` line itself, kept as it was written: `isMarker` trims, so a file may
  // pad it, and rebuilding it from the constant would quietly delete that padding.
  let splitLine = null;
  let normalized = rawLines;
  if (split === -1) {
    // No `---`, so the header is the run of `key: value` lines at the very top.
    // A line that is not one ends the run for good: `Aistalt: 你好。` is dialogue
    // that happens to have a colon, and a list that showed it as a header would be
    // showing the wrong thing.  Body text can still carry a `key: value` line of
    // its own further down, and that is a body line too.
    let at = 0;
    while (at < rawLines.length && isHeaderLine(rawLines[at])) {
      headerLines.push(rawLines[at]);
      at += 1;
    }
    bodyLines = rawLines.slice(at);
  } else {
    headerLines = rawLines.slice(0, split);
    bodyLines = rawLines.slice(split + 1);
    splitLine = rawLines[split];
    // Header lines are compacted and parked back at the top, so serializeStory can
    // write headerLines, then the `---`, then bodyLines without guessing where the
    // `---` used to sit among blank lines -- 20 of the 211 real files have air
    // between their header and their separator, and that air is written back here.
    normalized = bodyLines.slice();
    normalized.unshift(...headerLines, splitLine);
  }

  const headers = headerLines.map((line, index) => {
    const match = HEADER_LINE.exec(line);
    const colon = line.indexOf(":");
    return {
      index,
      key: match === null ? null : match[1],
      value: colon === -1 ? "" : line.slice(colon + 1).trim(),
      raw: line,
    };
  });
  const headerValue = (wanted) => {
    const found = headers.find((header) => header.key === wanted);
    return found === undefined ? null : found.value;
  };
  const tags = headerValue("tags");

  return {
    index: 0,
    startLine,
    first,
    separator: null,
    headers,
    headerLines,
    rawHeaderLines: headerLines.slice(),
    bodyLines: bodyEntries(bodyLines),
    rawBodyLines: bodyLines.slice(),
    splitLine,
    _split: split,
    title: headerValue("title"),
    subtitle: headerValue("subtitle"),
    when: headerValue("when"),
    tags: tags === null ? [] : tags.split(/\s+/).filter((token) => token !== ""),
  };
}

/** How many leading lines of a file sit before its first node. */
function leadingLines(lines) {
  let at = 0;
  while (at < lines.length && isBlank(lines[at])) {
    at += 1;
  }
  return at;
}

/**
 * Parse a `.yarn` file into nodes and the text around it.
 *
 * What comes back holds the file's EOL string, whether it ended with a newline,
 * its BOM if it had one, the leading and trailing text, and one entry per node.
 * A node carries a `separator` for the `===` line and the blank lines in front of
 * it: that gap belongs to the file rather than to either neighbour, so keeping it
 * on the separator is what stops a round trip from shuffling blank lines.  Every
 * node gets one -- the first separator is the file's leading text, which is where
 * a file's blank first lines live.
 */
export function parseStory(text) {
  const source = typeof text === "string" ? text : "";
  let bom = "";
  let rest = source;
  if (rest.startsWith("\uFEFF")) {
    bom = "\uFEFF";
    rest = rest.slice(1);
  }
  // The EOL is detected once, for the whole file: the corpus is 209 LF files and
  // 2 CRLF ones, and a file that mixed the two would not round-trip even if every
  // line remembered its own ending.
  const eol = rest.indexOf("\r\n") !== -1 ? "\r\n" : "\n";
  const trailingNewline = rest.endsWith(eol);
  const lines = rest.split(eol);
  if (trailingNewline) {
    lines.pop();
  }
  if (rest === "") {
    // An empty file has no lines at all, and `"".split` says it has one blank
    // line.  A line list that offers a line to a file with nothing in it is the
    // one place a count is wrong even though the text is right.
    lines.length = 0;
  }

  const nodes = [];
  const first = leadingLines(lines);
  let cursor = first;
  // Text that follows the last node: blank lines, or a stray `===` with nothing
  // after it.  Without a node to hang it on it would be dropped by a round trip,
  // so the story keeps it as `post` and writes it back after the last node.
  let post = [];
  // The `===` and blank lines that sit in front of the node the loop is about to
  // read.  It is filled at the end of one pass and consumed at the start of the
  // next, so the gap is written exactly once, by the node that follows it.
  let pendingSeparator = [];
  while (cursor < lines.length) {
    // A node's own text stops at the `===` that closes it; that `===` is then
    // walked as the *next* node's separator, which is where it belongs, because a
    // node list UI wants the line "before me", not a trailing line "after me".
    const startLine = cursor + 1;
    let end = cursor;
    while (end < lines.length && !isMarker(lines[end], STORY_NODE_SEPARATOR)) {
      end += 1;
    }
    const node = parseNode(lines.slice(cursor, end), startLine, nodes.length === 0);
    node.index = nodes.length;
    node.separator = { lines: pendingSeparator.slice() };
    pendingSeparator = [];
    if (nodes.length === 0 && first > 0) {
      // The file's own leading blank lines belong to the first node: they are the
      // only text before it, and a round trip has exactly one place to put them.
      node.separator.lines = lines.slice(0, first);
    }
    nodes.push(node);
    cursor = end;
    if (cursor >= lines.length) {
      break;
    }
    const gap = [];
    gap.push(lines[cursor]);
    cursor += 1;
    while (cursor < lines.length && isBlank(lines[cursor])
      && !isMarker(lines[cursor], STORY_NODE_SEPARATOR)) {
      gap.push(lines[cursor]);
      cursor += 1;
    }
    // `parseNode` already ate this node's header and body, so the gap is parked on
    // the next node; if there is no next node it becomes the story's `post`.
    if (cursor < lines.length) {
      pendingSeparator = gap;
    } else {
      post = gap;
    }
  }

  return {
    eol,
    trailingNewline,
    bom,
    pre: [],
    nodes,
    post: post.slice(),
    lines: lines.slice(),
  };
}

/**
 * Write a parsed story back out.
 *
 * The result is the input, character for character, unless a setter marked a line
 * dirty: untouched lines are their recorded `raw`, and only an edited line is
 * rebuilt from its fields.
 */
export function serializeStory(story) {
  if (story === null || typeof story !== "object") {
    return "";
  }
  const eol = typeof story.eol === "string" && story.eol !== "" ? story.eol : "\n";
  const pieces = [];
  for (const node of Array.isArray(story.nodes) ? story.nodes : []) {
    for (const line of node.separator.lines) {
      pieces.push(line);
    }
    for (const line of node.headerLines) {
      pieces.push(line);
    }
    if (node._split !== -1) {
      pieces.push(typeof node.splitLine === "string" ? node.splitLine : STORY_HEADER_SEPARATOR);
    }
    for (const entry of node.bodyLines) {
      pieces.push(renderBodyLine(entry));
    }
  }
  for (const line of Array.isArray(story.post) ? story.post : []) {
    pieces.push(line);
  }
  const text = pieces.join(eol);
  const joined = story.trailingNewline === true && pieces.length > 0 ? `${text}${eol}` : text;
  return `${typeof story.bom === "string" ? story.bom : ""}${joined}`;
}

/**
 * One entry per node, for a node list.
 *
 * `lineCount` counts the body lines a dialogue list would show, and `startLine`
 * is the file line the node's own text starts on -- the line after its `===`, so
 * the two numbers answer "where am I" and "how much is there" without the caller
 * re-deriving either.
 */
export function storyNodes(story) {
  const nodes = story !== null && typeof story === "object" && Array.isArray(story.nodes)
    ? story.nodes
    : [];
  return nodes.map((node, index) => ({
    index,
    title: node.title,
    subtitle: node.subtitle,
    when: node.when,
    tags: node.tags.slice(),
    lineCount: node.bodyLines.length,
    startLine: node.startLine,
  }));
}

/**
 * One entry per body line of a node, for a dialogue list.
 *
 * A field that does not apply to a line's kind is `null`, and `tags` is always an
 * array: an entry is what a card writes to disk, and `JSON.stringify` of a sparse
 * object comes back with the missing keys simply gone.
 */
export function storyLines(node) {
  const body = node !== null && typeof node === "object" && Array.isArray(node.bodyLines)
    ? node.bodyLines
    : [];
  return body.map((entry, index) => ({
    index,
    kind: typeof entry.kind === "string" ? entry.kind : "other",
    raw: typeof entry.raw === "string" ? entry.raw : "",
    indent: typeof entry.indent === "string" ? entry.indent : "",
    speaker: typeof entry.speaker === "string" ? entry.speaker : null,
    text: typeof entry.text === "string" ? entry.text : null,
    id: typeof entry.id === "string" ? entry.id : null,
    state: typeof entry.state === "string" ? entry.state : null,
    tags: Array.isArray(entry.tags) ? entry.tags.slice() : [],
    command: typeof entry.command === "string" ? entry.command : null,
    comment: typeof entry.comment === "string" ? entry.comment : null,
  }));
}

/**
 * Replace one line's text, keeping everything around it.
 *
 * The indentation, the `=>`, the whitespace after the colon, the whole trailing
 * `#`-run and any comment are the line's, not the text's: only the span between
 * the colon and the tag run is rewritten, which is why a `#line:` id keeps its
 * exact place and the game's hash-to-line mapping survives an edit.
 */
export function setLineText(node, index, text) {
  const entry = lineAt(node, index);
  if (entry === null) {
    return null;
  }
  const shape = splitDialogue(entry.raw);
  if (shape === null) {
    return null;
  }
  const split = splitTagRun(entry.raw.slice(shape.separator));
  const commentAt = commentStart(split.head);
  const comment = commentAt === -1 ? "" : split.head.slice(commentAt);
  const tags = split.tags === "" ? "" : ` ${split.tags}`;
  entry.edit = {
    head: entry.raw.slice(0, shape.separator),
    tail: `${String(text)}${comment}${tags}`,
  };
  entry.text = String(text);
  return refreshEntry(entry);
}

/**
 * Replace one line's speaker, keeping the `#line:` id and the rest.
 *
 * Only the characters before the colon are rewritten, so the `=>`, the indent and
 * every tag survive; a long line's id does not move because its speaker changed.
 * The whitespace after the colon is carried over from the line, because `Cop: 嗯`
 * and `Cop:嗯` are different lines and only the name was asked to change.
 */
export function setLineSpeaker(node, index, speaker) {
  const entry = lineAt(node, index);
  if (entry === null) {
    return null;
  }
  const shape = splitDialogue(entry.raw);
  if (shape === null) {
    return null;
  }
  const afterColon = entry.raw.slice(shape.indent.length + shape.arrow.length + shape.speaker.length + 1);
  const lead = afterColon.slice(0, afterColon.length - afterColon.trimStart().length);
  entry.edit = {
    head: `${shape.indent}${shape.arrow}${String(speaker)}:${lead}`,
    tail: entry.raw.slice(shape.separator),
  };
  entry.speaker = String(speaker);
  return refreshEntry(entry);
}

/** One line of prose naming what was parsed, in the voice of `viewAbout`. */
export function storyAbout(story) {
  if (story === null || typeof story !== "object") {
    return "yarn story: nothing was parsed";
  }
  const nodes = Array.isArray(story.nodes) ? story.nodes : [];
  const lines = nodes.reduce((total, node) => total + node.bodyLines.length, 0);
  const count = nodes.length === 1 ? "1 node" : `${nodes.length} nodes`;
  const bom = typeof story.bom === "string" && story.bom !== "" ? "a BOM, " : "";
  const endings = story.eol === "\r\n" ? "CRLF line endings" : "LF line endings";
  const close = story.trailingNewline === true ? "" : ", no newline at the end";
  return `yarn story: ${count}, ${lines} body lines, ${bom}${endings}${close}`;
}
