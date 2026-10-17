// positions.mjs -- the one place where offsets, lines and columns are converted.
//
// Why this file exists
// --------------------
// Two conventions meet here and they are both easy to get wrong:
//
//   * JavaScript strings are sequences of UTF-16 code units. `text.length`,
//     `text[i]`, `String.prototype.slice` and `String.prototype.indexOf` all
//     count code units, so a surrogate pair ("\u{1F600}") is two of them.
//   * A person reading a file counts one "column" per character, and an editor
//     that reports a caret to a language service usually reports UTF-16 code
//     units as well -- but only if it counts the same way we do.
//
// Locked convention for this repository (mirrors the reference language-service
// spec, 05 section 3): **offsets are 0-based UTF-16 code unit indices, lines
// are 1-based, characters (columns) are 0-based UTF-16 code units within the
// line.** Every diagnostic we emit carries ``line``/``col`` with 1-based cols
// for historical reasons; `diagnosticRange()` is the bridge from those to
// offsets and back.
//
// Pure functions only: no IO, no state, no dependencies. That is what lets the
// browser bundle and the Node shell share one implementation and lets the
// selftests reason about them without a filesystem.

// Line terminators accepted by the Yarn files we read: LF, CRLF and a lone CR
// (old Mac files still show up in mod folders). `lineStarts` treats all three
// as one line break and keeps the offsets pointing at the first character after
// the terminator.
const CR = 13;
const LF = 10;

/**
 * Offsets at which each line begins (0-based UTF-16 code units).
 * The first entry is always 0. A trailing line break does not create an extra
 * empty line: "a\n" has one line. "" has one line (the empty line 1).
 * @param {string} text
 * @returns {number[]}
 */
function lineStarts(text) {
  const out = [0];
  if (typeof text !== "string" || text.length === 0) return out;
  for (let i = 0; i < text.length; i += 1) {
    const code = text.charCodeAt(i);
    if (code === LF) {
      out.push(i + 1);
    } else if (code === CR) {
      // CRLF is one break; a lone CR is also one break.
      if (text.charCodeAt(i + 1) === LF) i += 1;
      out.push(i + 1);
    }
  }
  // "a\n" pushed len (== 1) as a start; that is the empty last line an editor
  // shows after the newline. Keep it: editors do, and a caret can sit there.
  return out;
}

/** @param {string} text @returns {number} number of lines (>= 1) */
function lineCount(text) {
  return lineStarts(text).length;
}

/**
 * Clamp anything to a valid code unit offset in [0, text.length].
 * Accepts non-integers by truncating; NaN becomes 0.
 * @param {string} text @param {number} offset @returns {number}
 */
function clampOffset(text, offset) {
  const len = typeof text === "string" ? text.length : 0;
  const n = Number.isFinite(offset) ? Math.trunc(offset) : 0;
  if (n < 0) return 0;
  if (n > len) return len;
  return n;
}

/**
 * Offset -> {line, character}. line is 1-based, character is 0-based UTF-16
 * code units within the line (a tab counts as 1, a surrogate pair as 2).
 * @param {string} text
 * @param {number} offset
 * @param {number[]=} starts precomputed `lineStarts(text)`
 * @returns {{line:number, character:number}}
 */
function offsetToPosition(text, offset, starts) {
  const src = typeof text === "string" ? text : "";
  const startsList = starts || lineStarts(src);
  const at = clampOffset(src, offset);
  // Binary search for the greatest start <= at.
  let lo = 0;
  let hi = startsList.length - 1;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (startsList[mid] <= at) lo = mid;
    else hi = mid - 1;
  }
  return { line: lo + 1, character: at - startsList[lo] };
}

/**
 * {line, character} -> offset. Out-of-range input is clamped rather than
 * rejected: a caret past the end of a line lands at the next line's start,
 * a caret past the last line lands at the end of the text. That matches what
 * an editor does and keeps every caller free of validation branches.
 * @param {string} text
 * @param {{line:number, character:number}} position
 * @param {number[]=} starts
 * @returns {number}
 */
function positionToOffset(text, position, starts) {
  const src = typeof text === "string" ? text : "";
  const startsList = starts || lineStarts(src);
  const lineRaw = position && Number.isFinite(position.line) ? Math.trunc(position.line) : 1;
  // A line past the document is a caret past the end: clamp to the end of the
  // text, not to the start of the last line.
  if (lineRaw > startsList.length) return src.length;
  const line = Math.max(lineRaw, 1);
  const lineStart = startsList[line - 1];
  const lineEnd = line < startsList.length ? startsList[line] : src.length;
  const charRaw = position && Number.isFinite(position.character) ? Math.trunc(position.character) : 0;
  const character = Math.max(0, charRaw);
  return Math.min(lineStart + character, lineEnd);
}

/**
 * Column of an offset inside its own line (0-based). Cheap helper for places
 * that already know the line but need the column.
 * @param {string} text @param {number} offset @returns {number}
 */
function columnAt(text, offset) {
  return offsetToPosition(text, offset).character;
}

/**
 * The text of one 1-based line, without its terminator.
 * @param {string} text @param {number} line
 * @returns {string}
 */
function lineText(text, line) {
  const src = typeof text === "string" ? text : "";
  const starts = lineStarts(src);
  const n = Math.min(Math.max(Math.trunc(line) || 1, 1), starts.length);
  const start = starts[n - 1];
  const end = n < starts.length ? starts[n] : src.length;
  return src.slice(start, lineBodyEnd(src, end));
}

/**
 * End of the line body for a line that ends at `lineEnd` (the offset just past
 * its terminator). Strips CRLF, LF and a lone CR.
 * @param {string} text @param {number} lineEnd @returns {number}
 */
function lineBodyEnd(text, lineEnd) {
  let end = lineEnd;
  if (end > 0 && text.charCodeAt(end - 1) === LF) end -= 1;
  if (end > 0 && text.charCodeAt(end - 1) === CR) end -= 1;
  return end;
}

/**
 * Build a range object from two code unit offsets.
 * @param {string} text @param {number} startOffset @param {number} endOffset
 * @returns {{start:{line:number,character:number}, end:{line:number,character:number}, startOffset:number, endOffset:number}}
 */
function rangeBetween(text, startOffset, endOffset) {
  const src = typeof text === "string" ? text : "";
  const starts = lineStarts(src);
  let a = clampOffset(src, startOffset);
  let b = clampOffset(src, endOffset);
  if (b < a) { const t = a; a = b; b = t; }
  return {
    start: offsetToPosition(src, a, starts),
    end: offsetToPosition(src, b, starts),
    startOffset: a,
    endOffset: b,
  };
}

/**
 * The range of one 1-based line, from 1-based start column (inclusive) to
 * 1-based end column (exclusive). This is how the existing Yarn validators
 * describe what they are pointing at: `col` is the 1-based column of the first
 * offending character, and `length` (or `endCol`) is how many code units the
 * offending token spans.
 *
 * `endCol1 <= startCol1` means "the whole rest of the line", which is what a
 * diagnostic about the line itself wants.
 * @param {string} text @param {number} line @param {number} startCol1 @param {number} endCol1
 */
function rangeOfLineCols(text, line, startCol1, endCol1) {
  const src = typeof text === "string" ? text : "";
  const starts = lineStarts(src);
  const n = Math.min(Math.max(Math.trunc(line) || 1, 1), starts.length);
  const lineStart = starts[n - 1];
  const lineEnd = n < starts.length ? starts[n] : src.length;
  const bodyEnd = lineBodyEnd(src, lineEnd);
  const bodyLength = Math.max(bodyEnd - lineStart, 0);
  const from = Math.min(Math.max(Math.trunc(startCol1) || 1, 1) - 1, bodyLength);
  const want = Number.isFinite(endCol1) && endCol1 > startCol1 ? Math.trunc(endCol1) - 1 : bodyLength;
  const to = Math.min(Math.max(want, from), bodyLength);
  return rangeBetween(src, lineStart + from, lineStart + to);
}

/**
 * Bridge from a diagnostic as the validators produce it (`{line, col, length?,
 * endCol?}`) to an offset range. Missing length means "to the end of the line" --
 * deliberate: a diagnostic that only knows its line must not pretend to know
 * more.
 * @param {string} text
 * @param {{line:number, col?:number, length?:number, endCol?:number}} diagnostic
 */
function diagnosticRange(text, diagnostic) {
  const d = diagnostic || {};
  const col = Number.isFinite(d.col) && d.col > 0 ? d.col : 1;
  if (Number.isFinite(d.endCol) && d.endCol > col) return rangeOfLineCols(text, d.line, col, d.endCol);
  if (Number.isFinite(d.length) && d.length > 0) return rangeOfLineCols(text, d.line, col, col + d.length);
  return rangeOfLineCols(text, d.line, col, col);
}

/**
 * The "word" around an offset, for hover / go-to-definition and for completion
 * prefix matching. Identifiers in Yarn are deliberately loose (CJK node titles,
 * `$vars`, `<<commands>>`), so this spans a run of characters that are not
 * whitespace and not punctuation from `DELIMITERS`. Returns `{startOffset,
 * endOffset, text}`; the caret may sit at either edge and still match.
 * @param {string} text @param {number} offset
 */
function wordAt(text, offset) {
  const src = typeof text === "string" ? text : "";
  const at = clampOffset(src, offset);
  const isWordCode = (code) => {
    if (code === 32 || code === 9 || code === 10 || code === 13) return false;
    const ch = String.fromCharCode(code);
    return !DELIMITERS.has(ch);
  };
  let start = at;
  let end = at;
  while (start > 0 && isWordCode(src.charCodeAt(start - 1))) start -= 1;
  while (end < src.length && isWordCode(src.charCodeAt(end))) end += 1;
  return { startOffset: start, endOffset: end, text: src.slice(start, end) };
}

const DELIMITERS = new Set(["<", ">", "(", ")", "[", "]", "{", "}", ",", ";", "#", ":", "\"", "'", "=", "/", "\\", "|", "+", "*", "&", "^", "%", "!", "?", "."]);

/**
 * True when `range` is inside `text` and has non-zero width.
 * @param {string} text @param {{startOffset:number,endOffset:number}} range
 */
function isRangeInText(text, range) {
  if (!range || typeof text !== "string") return false;
  return (
    Number.isFinite(range.startOffset) &&
    Number.isFinite(range.endOffset) &&
    range.startOffset >= 0 &&
    range.endOffset <= text.length &&
    range.endOffset > range.startOffset
  );
}

/**
 * Shift a range by a known amount of text, for when a caller has an offset
 * relative to a slice. Returns a plain offset range, not a position pair.
 * @param {{startOffset:number,endOffset:number}} range @param {number} delta
 */
function shiftRange(range, delta) {
  const d = Number.isFinite(delta) ? Math.trunc(delta) : 0;
  return {
    startOffset: range.startOffset + d,
    endOffset: range.endOffset + d,
  };
}

/**
 * Describe a range the way a status line or an error message wants it:
 * `"12:5-12:9"`.
 * @param {{start:{line:number,character:number}, end:{line:number,character:number}}} range
 */
function formatRange(range) {
  if (!range || !range.start || !range.end) return "";
  const s = range.start;
  const e = range.end;
  return `${s.line}:${s.character}-${e.line}:${e.character}`;
}


module.exports = {
  lineStarts,
  lineCount,
  clampOffset,
  offsetToPosition,
  positionToOffset,
  columnAt,
  lineText,
  rangeBetween,
  rangeOfLineCols,
  diagnosticRange,
  wordAt,
  isRangeInText,
  shiftRange,
  formatRange,
};
