/**
 * tokenize.mjs -- the data-driven tokenizer.
 *
 * One function, no per-language branches.  Every language-specific fact lives
 * in the descriptor; if you ever need `if (lang.id === "rust")` here, the
 * descriptor format is missing a key instead.
 *
 * The single branch is on the descriptor's *family*, which names an engine
 * rather than a language: `family sgml` hands the text to `langs/markup.mjs`,
 * whose delimiters are fixed by SGML itself.  A language of either family
 * still costs one `.lang` file and no code.
 *
 * The output is the frozen wire form: an array of `[start, end, kind]` triples
 * that **tiles the whole input** -- every offset from 0 to text.length is
 * covered exactly once, with whitespace reported as `ws`.  A client can
 * therefore colour a document by walking the array once, with no gap logic.
 *
 * Scan order at each offset (frozen, family flat):
 *   block comment -> line comment -> string -> number -> identifier -> literal
 *   -> punctuation
 */

import { TOKEN_KINDS } from "./lang.mjs";
import { tokenizeSgml } from "./markup.mjs";

const KIND_SET = new Set(TOKEN_KINDS);

function isSpace(ch) {
  return ch === " " || ch === "\t" || ch === "\r" || ch === "\n" || ch === "\f" || ch === "\v";
}

function isDigit(ch) {
  return ch >= "0" && ch <= "9";
}

function isIdentStart(ch) {
  return (ch >= "a" && ch <= "z") || (ch >= "A" && ch <= "Z") || ch === "_";
}

function isIdentPart(ch) {
  return isIdentStart(ch) || isDigit(ch);
}

function isNumberPart(ch) {
  return isDigit(ch) || (ch >= "a" && ch <= "z") || (ch >= "A" && ch <= "Z") || ch === "_" || ch === ".";
}

/* ------------------------------------------------------------------ */
/* scanning helpers                                                    */
/* ------------------------------------------------------------------ */

/** Longest string delimiter that matches at `i`, or null. */
function matchString(text, i, lang) {
  if (lang.maxString === 0) {
    return null;
  }
  let best = null;
  for (const delim of lang.strings) {
    if (delim.length >= text.length - i) {
      continue;
    }
    if (text.startsWith(delim, i) && (best === null || delim.length > best.length)) {
      best = delim;
    }
  }
  return best;
}

/** Longest literal entry that matches at `i`, or null.  Table is pre-sorted. */
function matchLiteral(text, i, lang) {
  for (const entry of lang.literals) {
    if (text.startsWith(entry.text, i)) {
      return entry;
    }
  }
  return null;
}

function scanNumber(text, i) {
  let j = i;
  while (j < text.length) {
    const ch = text[j];
    if (isNumberPart(ch)) {
      j += 1;
      continue;
    }
    // A sign only continues a number as part of an exponent (1e-9).
    if ((ch === "+" || ch === "-") && j > i && (text[j - 1] === "e" || text[j - 1] === "E")) {
      j += 1;
      continue;
    }
    break;
  }
  return j;
}

/** Scans a delimited string, honouring backslash escapes and stopping at EOL. */
function scanString(text, i, delim) {
  let j = i + delim.length;
  while (j < text.length) {
    const ch = text[j];
    if (ch === "\\") {
      j += 2;
      continue;
    }
    if (ch === "\n") {
      break; // unterminated: never let one quote darken the rest of the file
    }
    if (text.startsWith(delim, j)) {
      return j + delim.length;
    }
    j += 1;
  }
  return Math.min(j, text.length);
}

/** True when a token of some kind could begin at `i` (used to bound punct runs). */
function startsToken(text, i, lang) {
  const ch = text[i];
  if (ch === undefined) {
    return false;
  }
  if (isSpace(ch) || isDigit(ch) || isIdentStart(ch)) {
    return true;
  }
  if (lang.lineComment !== "" && text.startsWith(lang.lineComment, i)) {
    return true;
  }
  if (lang.blockOpen !== "" && text.startsWith(lang.blockOpen, i)) {
    return true;
  }
  if (matchString(text, i, lang) !== null) {
    return true;
  }
  return matchLiteral(text, i, lang) !== null;
}

/* ------------------------------------------------------------------ */
/* the tokenizer                                                       */
/* ------------------------------------------------------------------ */

/**
 * @param {object|null} lang  a parsed descriptor, or null for plain text
 * @param {string} text
 * @returns {Array<[number, number, string]>} contiguous spans covering text
 */
export function tokenize(lang, text) {
  if (lang !== null && lang !== undefined && lang.family === "sgml") {
    return tokenizeSgml(lang, text);
  }

  const out = [];
  const n = text.length;
  const plain = lang === null || lang === undefined;

  let i = 0;
  while (i < n) {
    // whitespace
    if (isSpace(text[i])) {
      let j = i + 1;
      while (j < n && isSpace(text[j])) {
        j += 1;
      }
      out.push([i, j, "ws"]);
      i = j;
      continue;
    }

    if (!plain) {
      // block comment
      if (lang.blockOpen !== "" && text.startsWith(lang.blockOpen, i)) {
        const closeAt = text.indexOf(lang.blockClose, i + lang.blockOpen.length);
        const end = closeAt < 0 ? n : closeAt + lang.blockClose.length;
        out.push([i, end, "comment"]);
        i = end;
        continue;
      }

      // line comment
      if (lang.lineComment !== "" && text.startsWith(lang.lineComment, i)) {
        const nl = text.indexOf("\n", i);
        const end = nl < 0 ? n : nl;
        out.push([i, end, "comment"]);
        i = end;
        continue;
      }

      // string
      const delim = matchString(text, i, lang);
      if (delim !== null) {
        const end = scanString(text, i, delim);
        out.push([i, end, "string"]);
        i = end;
        continue;
      }

      // number
      if (isDigit(text[i])) {
        const end = scanNumber(text, i);
        out.push([i, end, "number"]);
        i = end;
        continue;
      }

      // identifier -> declared word kind, else ident
      if (isIdentStart(text[i])) {
        let j = i + 1;
        while (j < n && isIdentPart(text[j])) {
          j += 1;
        }
        const word = text.slice(i, j);
        const kind = lang.words.get(word);
        out.push([i, j, kind === undefined ? "ident" : kind]);
        i = j;
        continue;
      }

      // literal (punctuation that a descriptor gave a meaning to)
      const lit = matchLiteral(text, i, lang);
      if (lit !== null) {
        out.push([i, i + lit.text.length, lit.kind]);
        i += lit.text.length;
        continue;
      }
    }

    // anything else: merge a run of unmatched characters into one `punct` span
    let j = i + 1;
    if (plain) {
      // With no language every non-blank run is one plain span, so a fork that
      // deleted the descriptors still gets one token per word instead of one
      // per character.
      while (j < n && !isSpace(text[j])) {
        j += 1;
      }
    } else {
      while (j < n && !startsToken(text, j, lang)) {
        j += 1;
      }
    }
    out.push([i, j, "punct"]);
    i = j;
  }

  return out;
}

/** Shared empty descriptor so the `plain` path needs no null checks in helpers. */
const EMPTY_LANG = {
  lineComment: "",
  blockOpen: "",
  blockClose: "",
  strings: [],
  literals: [],
  maxString: 0,
  words: new Map(),
};

/** Tokenizes with no language: whitespace and punctuation only. */
export function tokenizePlain(text) {
  return tokenize(null, text);
}

/**
 * Line-oriented wrapper: returns spans grouped per line, which is what an
 * incremental editor wants when only one line changed.
 *
 * @returns {Array<Array<[number, number, string]>>} one array of spans per line
 */
export function tokenizeLines(lang, text) {
  const starts = [0];
  for (let i = 0; i < text.length; i += 1) {
    if (text[i] === "\n") {
      starts.push(i + 1);
    }
  }

  const lines = starts.map(() => []);
  let line = 0;

  for (const [start, end, kind] of tokenize(lang, text)) {
    let pos = start;
    while (pos < end) {
      while (line + 1 < starts.length && starts[line + 1] <= pos) {
        line += 1;
      }
      const lineEnd = line + 1 < starts.length ? starts[line + 1] : text.length;
      const stop = Math.min(end, lineEnd);
      lines[line].push([pos, stop, kind]);
      pos = stop;
    }
  }
  return lines;
}

/** Validates a kind name; used by `lang.check`-style tooling. */
export function isTokenKind(kind) {
  return KIND_SET.has(kind);
}
