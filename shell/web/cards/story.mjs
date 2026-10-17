/**
 * cards/story.mjs -- the story model: what a `.yarn` line is, as the card edits it.
 *
 * Part of `cards.mjs`, which re-exports this file; see that file's header for
 * why the card layer is split the way it is.
 */
import {
  lineIdOf,
  nextLineId,
  setLineRaw,
  setLineSpeaker,
  setLineText,
  storyLines,
} from "../story.mjs";
import { lockOf } from "../storycsv.mjs";
import { applyCommand, commandTypedAt, completeYsls } from "../ysls.mjs";

/** The node at `nodeIndex`, or null when there is no such node. */
export function storyNodeAt(story, nodeIndex) {
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
 * A game table's `text` column is the whole spoken line -- `Speaker: Hi.`, the
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
export function storyAnchorLine(node, at) {
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
export function storyLineHead(line) {
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
    ? "Speaker"
    : anchor.speaker;
  const body = String(text) === "" ? "" : ` ${String(text)}`;
  const raw = `${head}${speaker}:${body} #line:${id}`;
  node.bodyLines.splice(index, 0, { raw, edit: null });
  return index;
}

/* -------------------- moving a file in chunks -------------------- */
