/**
 * lang.mjs -- `.lang` descriptors: parsing, validation, and the registry.
 *
 * This file is the whole of seIDE's language support, and it lives *outside*
 * `core/` on purpose.  The kernel knows about files, boards and processes; it
 * does not know what a keyword is.  A fork that wants no colouring at all
 * deletes this directory and `core/` still builds and runs.
 *
 * The descriptor grammar is frozen (see langs/README.md).  It is small on
 * purpose: adding a language must cost one text file and zero code.
 *
 *     # seIDE language descriptor
 *     id brainfuck
 *     title Brainfuck
 *     ext .bf
 *     line_comment #
 *     kind command "+" "-" "<" ">" "[" "]" "." ","
 */

import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, extname } from "node:path";

/** Thrown for any malformed descriptor.  `line` is 1-based when known. */
export class LangError extends Error {
  constructor(message, source = "<descriptor>", line = 0) {
    super(line > 0 ? `${source}:${line}: ${message}` : `${source}: ${message}`);
    this.name = "LangError";
    this.source = source;
    this.line = line;
  }
}

/** Token kinds the kernel's wire form uses, plus the ones only the shell does. */
export const TOKEN_KINDS = [
  "keyword",
  "command",
  "type",
  "constant",
  "number",
  "string",
  "comment",
  "ident",
  "punct",
  "ws",
];

/** Kinds a descriptor may declare.  `ws`/`ident`/`punct` are produced, not declared. */
const DECLARABLE_KINDS = new Set([
  "keyword",
  "command",
  "type",
  "constant",
  "number",
  "string",
  "comment",
]);

const ID_RE = /^[A-Za-z_][A-Za-z0-9_-]*$/;
const EXT_RE = /^\.[A-Za-z0-9_+.-]+$/;

const UNESCAPE = { "\\": "\\", '"': '"', n: "\n", t: "\t", r: "\r" };

/* ------------------------------------------------------------------ */
/* lexing helpers for the descriptor itself                            */
/* ------------------------------------------------------------------ */

function isBlank(s) {
  return /^[ \t\r]*$/.test(s);
}

/** Reads one double-quoted token starting at `line[pos] === '"'`. */
function readQuoted(line, pos, source, lineNo) {
  let out = "";
  let i = pos + 1;

  while (i < line.length) {
    const ch = line[i];
    if (ch === "\\") {
      const next = line[i + 1];
      if (next === undefined) {
        throw new LangError("unterminated escape in quoted token", source, lineNo);
      }
      // An unknown escape is kept verbatim rather than silently dropped.
      out += Object.prototype.hasOwnProperty.call(UNESCAPE, next) ? UNESCAPE[next] : next;
      i += 2;
      continue;
    }
    if (ch === '"') {
      return { text: out, end: i + 1 };
    }
    out += ch;
    i += 1;
  }
  throw new LangError("unterminated quoted token", source, lineNo);
}

/**
 * Splits the remainder of a `kind ...` line into quoted tokens.
 * Anything outside quotes other than whitespace is a hard error: a descriptor
 * with an unquoted token is almost always a typo, not an intention.
 */
function readTokenList(rest, source, lineNo) {
  const tokens = [];
  let i = 0;

  while (i < rest.length) {
    const ch = rest[i];
    if (ch === " " || ch === "\t" || ch === "\r") {
      i += 1;
      continue;
    }
    if (ch !== '"') {
      throw new LangError(
        `expected a quoted token at column ${i + 1}, found ${JSON.stringify(ch)}`,
        source,
        lineNo,
      );
    }
    const quoted = readQuoted(rest, i, source, lineNo);
    if (quoted.text.length === 0) {
      throw new LangError("empty token is not allowed", source, lineNo);
    }
    tokens.push(quoted.text);
    i = quoted.end;
  }
  return tokens;
}

/** `line_comment` may be written raw (`#`) or quoted (`"#"`); both are accepted. */
function readMarker(value, source, lineNo) {
  const trimmed = value.trim();
  if (trimmed.startsWith('"')) {
    const quoted = readQuoted(trimmed, 0, source, lineNo);
    if (quoted.end !== trimmed.length) {
      throw new LangError("trailing text after quoted value", source, lineNo);
    }
    return quoted.text;
  }
  if (trimmed.includes(" ") || trimmed.includes("\t")) {
    throw new LangError(`value ${JSON.stringify(trimmed)} must be a single marker`, source, lineNo);
  }
  return trimmed;
}

function titleFromId(id) {
  return id
    .replace(/[-_]+/g, " ")
    .split(" ")
    .filter(Boolean)
    .map((w) => w[0].toUpperCase() + w.slice(1))
    .join(" ");
}

/* ------------------------------------------------------------------ */
/* descriptor parsing                                                  */
/* ------------------------------------------------------------------ */

/**
 * Parses one descriptor.  Throws LangError on anything the grammar does not
 * allow -- in particular unknown keys, because silently ignoring a key the
 * author believed in is how descriptors rot.
 *
 * @param {string} text
 * @param {string} source  path or label used in error messages
 * @returns {object} a language definition
 */
export function parseDescriptor(text, source = "<descriptor>") {
  const lang = {
    id: "",
    title: "",
    extensions: [],
    lineComment: "",
    blockOpen: "",
    blockClose: "",
    strings: [],
    /** literal (punctuation) entries, longest first at match time */
    literals: [],
    /** word entries: exact identifier -> kind */
    words: new Map(),
  };

  // A UTF-8 BOM would make the first `#` line a key line and confuse everyone.
  const lines = text.replace(/^\uFEFF/, "").split(/\r?\n/);

  for (let n = 0; n < lines.length; n += 1) {
    const raw = lines[n];
    // Only a '#' in column 0 starts a comment; an indented '#' is a bad key.
    if (raw.startsWith("#") || isBlank(raw)) {
      continue;
    }
    const lineNo = n + 1;
    const m = /^([A-Za-z_][A-Za-z0-9_]*)[ \t]*(.*)$/.exec(raw);
    if (!m) {
      throw new LangError(`cannot parse ${JSON.stringify(raw)}`, source, lineNo);
    }
    const key = m[1];
    const rest = m[2];

    switch (key) {
      case "id": {
        const value = rest.trim();
        if (!ID_RE.test(value)) {
          throw new LangError(`invalid id ${JSON.stringify(value)}`, source, lineNo);
        }
        lang.id = value;
        break;
      }
      case "title": {
        const value = rest.trim();
        if (value.length === 0) {
          throw new LangError("title must not be empty", source, lineNo);
        }
        lang.title = value;
        break;
      }
      case "ext": {
        const value = rest.trim();
        if (!EXT_RE.test(value)) {
          throw new LangError(
            `invalid extension ${JSON.stringify(value)} (want something like .bf)`,
            source,
            lineNo,
          );
        }
        if (!lang.extensions.includes(value)) {
          lang.extensions.push(value);
        }
        break;
      }
      case "line_comment":
        lang.lineComment = readMarker(rest, source, lineNo);
        break;
      case "block_comment_open":
        lang.blockOpen = readMarker(rest, source, lineNo);
        break;
      case "block_comment_close":
        lang.blockClose = readMarker(rest, source, lineNo);
        break;
      case "string": {
        const value = readMarker(rest, source, lineNo);
        if (value.length === 0) {
          throw new LangError("empty string delimiter", source, lineNo);
        }
        if (!lang.strings.includes(value)) {
          lang.strings.push(value);
        }
        break;
      }
      case "kind": {
        const kindMatch = /^([A-Za-z_][A-Za-z0-9_-]*)/.exec(rest);
        if (!kindMatch) {
          throw new LangError("kind needs a kind name", source, lineNo);
        }
        const kindName = kindMatch[1];
        if (!DECLARABLE_KINDS.has(kindName)) {
          throw new LangError(
            `unknown token kind ${JSON.stringify(kindName)} ` +
              `(expected one of ${[...DECLARABLE_KINDS].join(", ")})`,
            source,
            lineNo,
          );
        }
        const tokens = readTokenList(rest.slice(kindMatch[0].length), source, lineNo);
        if (tokens.length === 0) {
          throw new LangError(`kind ${kindName} declares no tokens`, source, lineNo);
        }
        for (const token of tokens) {
          if (/\s/.test(token)) {
            throw new LangError(
              `token ${JSON.stringify(token)} contains whitespace`,
              source,
              lineNo,
            );
          }
          // The spec's rule: the *text* decides how it is matched, not the kind.
          const word = /^[A-Za-z_]/.test(token);
          if (word) {
            lang.words.set(token, kindName);
          } else {
            const existing = lang.literals.find((e) => e.text === token);
            if (existing) {
              existing.kind = kindName;
            } else {
              lang.literals.push({ text: token, kind: kindName });
            }
          }
        }
        break;
      }
      default:
        throw new LangError(`unknown key ${JSON.stringify(key)}`, source, lineNo);
    }
  }

  if (lang.id === "") {
    throw new LangError("descriptor has no `id`", source, 0);
  }
  if (lang.title === "") {
    lang.title = titleFromId(lang.id);
  }
  if (lang.blockOpen !== "" && lang.blockClose === "") {
    throw new LangError("block_comment_open without block_comment_close", source, 0);
  }
  if (lang.blockClose !== "" && lang.blockOpen === "") {
    throw new LangError("block_comment_close without block_comment_open", source, 0);
  }

  // Longest-first means the tokenizer can stop at the first literal that fits
  // and still be correct even when one token is a prefix of another (`<` vs `<<`).
  lang.literals.sort((a, b) => b.text.length - a.text.length || (a.text < b.text ? -1 : 1));
  lang.maxLiteral = lang.literals.reduce((n, e) => Math.max(n, e.text.length), 0);
  lang.maxString = lang.strings.reduce((n, s) => Math.max(n, s.length), 0);
  return lang;
}

/* ------------------------------------------------------------------ */
/* loading                                                             */
/* ------------------------------------------------------------------ */

/**
 * Reads every `.lang` file in `dir`.  Unreadable or malformed files are
 * reported through `onError` and skipped: one bad descriptor must not take
 * the editor's colouring down with it.
 *
 * @returns {object[]} successfully parsed languages, ordered by id
 */
export function loadLanguages(dir, { onError = null, strict = false } = {}) {
  let names;
  try {
    names = readdirSync(dir).filter((n) => n.endsWith(".lang"));
  } catch (err) {
    if (strict) {
      throw new LangError(`cannot read language directory: ${err.message}`, dir, 0);
    }
    return [];
  }

  const langs = [];
  for (const name of names.sort()) {
    const path = join(dir, name);
    try {
      if (!statSync(path).isFile()) {
        continue;
      }
      langs.push(parseDescriptor(readFileSync(path, "utf8"), path));
    } catch (err) {
      if (strict) {
        throw err;
      }
      if (onError) {
        onError(path, err);
      }
    }
  }
  langs.sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  return langs;
}

/** The registry the shell and any tool talks to. */
export class LangRegistry {
  constructor(langs = []) {
    this.langs = langs;
  }

  static fromDir(dir, opts) {
    return new LangRegistry(loadLanguages(dir, opts));
  }

  /** Wire form for `lang.list`. */
  list() {
    return this.langs.map((l) => ({
      id: l.id,
      title: l.title,
      extensions: l.extensions.slice(),
    }));
  }

  byId(id) {
    return this.langs.find((l) => l.id === id) || null;
  }

  byExtension(ext) {
    const want = ext.startsWith(".") ? ext.toLowerCase() : `.${ext.toLowerCase()}`;
    return this.langs.find((l) => l.extensions.some((e) => e.toLowerCase() === want)) || null;
  }

  /** Picks a language from a path's extension; returns null for unknown files. */
  detect(path) {
    if (typeof path !== "string" || path === "") {
      return null;
    }
    return this.byExtension(extname(path));
  }

  /**
   * Resolves a `lang.tokenize` request: an explicit `lang` id wins, otherwise
   * the path's extension decides.  Returns null when nothing applies, which
   * the caller renders as "plain text, no colouring".
   */
  resolve({ lang = null, path = null } = {}) {
    if (lang) {
      return this.byId(lang);
    }
    return this.detect(path);
  }
}
