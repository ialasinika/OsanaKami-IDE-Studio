/**
 * markup.mjs -- the SGML family: HTML, XML, SVG, and their relatives.
 *
 * `langs/tokenize.mjs` dispatches here for a descriptor that says
 * `family sgml`.  The delimiters are not configurable, because they are not
 * taste: `<`, `&`, `<!--`, `<![CDATA[` and `]]>` are SGML's own syntax, and
 * members that disagreed about them would not be a family.  What a member
 * still says for itself is which elements hold raw text
 * (`raw_element "script" "style"`), because that is where HTML and XML
 * actually part ways.
 *
 * The output is the frozen wire form: `[start, end, kind]` triples that tile
 * the whole input, whitespace included.  Only documented kinds are used, so
 * the browser layer needs no new palette entry:
 *
 *     element, instruction and declaration names    keyword
 *     attribute names                               type
 *     attribute values, CDATA sections              string
 *     entities (&amp;, &#38;)                        constant
 *     comments                                      comment
 *     raw element bodies and prose                  ident / number / punct / ws
 *
 * Prose stays `ident`/`punct`/`ws`, which the browser renders as plain text
 * (`punct` is dimmer).  Colouring every word of a paragraph as punctuation
 * would make prose grey, which is worse than not colouring it at all.
 *
 * There is no error path: a document that is not well formed is still
 * tokenized, because an editor shows half-typed documents all day.  A `<`
 * that cannot start a tag is punctuation, an unterminated quote stops at the
 * end of its line, and an unterminated comment runs to the end of the file.
 */

/* ------------------------------------------------------------------ */
/* character classes                                                   */
/* ------------------------------------------------------------------ */

function isSpace(ch) {
  return ch === " " || ch === "\t" || ch === "\n" || ch === "\r" || ch === "\f";
}

function isDigit(ch) {
  return ch >= "0" && ch <= "9";
}

/** XML's NameStartChar, minus the ranges outside ASCII. */
function isNameStart(ch) {
  return (ch >= "A" && ch <= "Z") || (ch >= "a" && ch <= "z") || ch === "_" || ch === ":";
}

/** XML's NameChar, minus the ranges outside ASCII. */
function isNamePart(ch) {
  return isNameStart(ch) || isDigit(ch) || ch === "-" || ch === ".";
}

/** A word in prose is looser than a name: `don't` and `well-known` are one word. */
function isWordStart(ch) {
  return (ch >= "A" && ch <= "Z") || (ch >= "a" && ch <= "z") || ch === "_";
}

function isWordPart(ch) {
  return isWordStart(ch) || isDigit(ch) || ch === "-";
}

function isNumberPart(ch) {
  return isDigit(ch) || (ch >= "A" && ch <= "Z") || (ch >= "a" && ch <= "z") || ch === "." || ch === "_";
}

/** ASCII lower case; anything else is returned unchanged. */
function fold(ch) {
  return ch >= "A" && ch <= "Z" ? String.fromCharCode(ch.charCodeAt(0) + 32) : ch;
}

function emit(out, start, end, kind) {
  if (end > start) {
    out.push([start, end, kind]);
  }
}

/* ------------------------------------------------------------------ */
/* small scanners                                                      */
/* ------------------------------------------------------------------ */

const ENTITY_RE = /&(#[0-9]{1,7}|#[xX][0-9A-Fa-f]{1,6}|[A-Za-z][A-Za-z0-9]{1,31});/y;

/**
 * `&amp;` and friends, or 0 when this `&` is not an entity.
 *
 * The terminating semicolon is required, which is XML's rule rather than
 * HTML's; a bare `&` stays punctuation, which is what a half-typed `&` in a
 * query string or a script should look like anyway.
 */
function scanEntity(text, i) {
  ENTITY_RE.lastIndex = i;
  const m = ENTITY_RE.exec(text);
  return m ? i + m[0].length : 0;
}

/** Stops at the closing quote, or at `>`/end of line/EOF when it never closes. */
function scanQuoted(text, i) {
  const quote = text[i];
  const n = text.length;
  let j = i + 1;
  while (j < n) {
    const ch = text[j];
    if (ch === quote) {
      return j + 1;
    }
    if (ch === ">" || ch === "\n") {
      return j;
    }
    j += 1;
  }
  return n;
}

function scanName(text, i) {
  const n = text.length;
  if (i >= n || !isNameStart(text[i])) {
    return i;
  }
  let j = i + 1;
  while (j < n && isNamePart(text[j])) {
    j += 1;
  }
  return j;
}

/** True when `text[i..]` starts with `needle`, ignoring ASCII case. */
function startsWithFold(text, i, needle) {
  if (i + needle.length > text.length) {
    return false;
  }
  for (let k = 0; k < needle.length; k += 1) {
    if (fold(text[i + k]) !== fold(needle[k])) {
      return false;
    }
  }
  return true;
}

/**
 * The index of `</name` at or after `from`, or -1.
 *
 * A closing tag only counts when the name ends there: `</scripts>` does not
 * close a `script` element.
 */
function findCloseTag(text, from, name) {
  const n = text.length;
  for (let i = from; i + name.length + 2 <= n; i += 1) {
    if (text[i] !== "<" || text[i + 1] !== "/") {
      continue;
    }
    let ok = true;
    for (let k = 0; k < name.length; k += 1) {
      if (fold(text[i + 2 + k]) !== name[k]) {
        ok = false;
        break;
      }
    }
    if (!ok) {
      continue;
    }
    const after = text[i + 2 + name.length];
    if (after === undefined || !isNamePart(after)) {
      return i;
    }
  }
  return -1;
}

/* ------------------------------------------------------------------ */
/* text (and raw element bodies)                                       */
/* ------------------------------------------------------------------ */

/** True when `ch` begins something that ends a punctuation run. */
function isPunctBoundary(ch, inRaw) {
  return (
    isSpace(ch) ||
    isDigit(ch) ||
    isWordStart(ch) ||
    ch === "&" ||
    (inRaw !== true && ch === "<")
  );
}

/**
 * One text token.  Returns the index after it, always greater than `i`, so a
 * caller that loops on this tiles the input.
 *
 * `limit` is where the text stops even if the character class would continue:
 * a raw element body ends at its closing tag, and the scanner must not run
 * past that into the tag itself.
 */
function stepText(text, out, i, inRaw, limit) {
  const n = limit === undefined ? text.length : limit;
  const ch = text[i];

  if (isSpace(ch)) {
    let j = i + 1;
    while (j < n && isSpace(text[j])) {
      j += 1;
    }
    emit(out, i, j, "ws");
    return j;
  }

  if (ch === "&") {
    const end = scanEntity(text, i);
    if (end > 0) {
      emit(out, i, end, "constant");
      return end;
    }
  }

  if (isDigit(ch)) {
    let j = i + 1;
    while (j < n && isNumberPart(text[j])) {
      j += 1;
    }
    emit(out, i, j, "number");
    return j;
  }

  if (isWordStart(ch)) {
    let j = i + 1;
    while (j < n && isWordPart(text[j])) {
      j += 1;
    }
    emit(out, i, j, "ident");
    return j;
  }

  let j = i + 1;
  while (j < n && !isPunctBoundary(text[j], inRaw)) {
    j += 1;
  }
  emit(out, i, j, "punct");
  return j;
}

/* ------------------------------------------------------------------ */
/* markup                                                              */
/* ------------------------------------------------------------------ */

/**
 * A processing instruction (`<?xml ... ?>`) or a declaration
 * (`<!DOCTYPE html>`).  Quoted parts are strings even when they contain the
 * terminator, which is what a doctype's public identifier needs.
 */
function scanInstruction(text, out, i, terminator) {
  const n = text.length;
  emit(out, i, i + 2, "punct");
  let k = i + 2;
  if (k < n && isNameStart(text[k])) {
    const end = scanName(text, k);
    emit(out, k, end, "keyword");
    k = end;
  }
  while (k < n) {
    if (startsWithFold(text, k, terminator)) {
      emit(out, k, k + terminator.length, "punct");
      return k + terminator.length;
    }
    const ch = text[k];
    if (isSpace(ch)) {
      let j = k + 1;
      while (j < n && isSpace(text[j])) {
        j += 1;
      }
      emit(out, k, j, "ws");
      k = j;
      continue;
    }
    if (ch === '"' || ch === "'") {
      const end = scanQuoted(text, k);
      emit(out, k, end, "string");
      k = end;
      continue;
    }
    if (isNameStart(ch)) {
      const end = scanName(text, k);
      emit(out, k, end, "type");
      k = end;
      continue;
    }
    emit(out, k, k + 1, "punct");
    k += 1;
  }
  return n;
}

/**
 * One tag, starting at its `<`.  Returns `{ end, raw }` where `raw` is the
 * lower-cased name of an element whose body must be scanned as text, or null.
 */
function scanTag(text, out, i, rawNames) {
  const n = text.length;
  const closing = text[i + 1] === "/";
  const nameStart = closing ? i + 2 : i + 1;
  const nameEnd = scanName(text, nameStart);

  if (nameEnd === nameStart) {
    // `a < b`, or a tag being typed: a lone `<` is punctuation.
    emit(out, i, i + 1, "punct");
    return { end: i + 1, raw: null };
  }

  emit(out, i, nameStart, "punct");
  emit(out, nameStart, nameEnd, "keyword");

  let k = nameEnd;
  while (k < n) {
    const ch = text[k];

    if (isSpace(ch)) {
      let j = k + 1;
      while (j < n && isSpace(text[j])) {
        j += 1;
      }
      emit(out, k, j, "ws");
      k = j;
      continue;
    }
    if (ch === ">") {
      emit(out, k, k + 1, "punct");
      k += 1;
      break;
    }
    if (ch === "/") {
      if (text[k + 1] === ">") {
        emit(out, k, k + 2, "punct");
        k += 2;
        break;
      }
      emit(out, k, k + 1, "punct");
      k += 1;
      continue;
    }
    if (ch === '"' || ch === "'") {
      const end = scanQuoted(text, k);
      emit(out, k, end, "string");
      k = end;
      continue;
    }
    if (ch === "=") {
      emit(out, k, k + 1, "punct");
      k += 1;
      continue;
    }
    if (isNameStart(ch)) {
      const end = scanName(text, k);
      emit(out, k, end, "type");
      k = end;
      continue;
    }
    if (ch === "<") {
      // A forgotten `>`: the previous tag ends here and a new one starts.
      break;
    }
    emit(out, k, k + 1, "punct");
    k += 1;
  }

  const name = text.slice(nameStart, nameEnd).toLowerCase();
  const raw = !closing && rawNames.has(name) ? name : null;
  return { end: k, raw };
}

/** A comment, CDATA section, instruction, declaration or tag. */
function scanMarkup(text, out, i, rawNames) {
  const n = text.length;

  if (text.startsWith("<!--", i)) {
    const end = text.indexOf("-->", i + 4);
    const stop = end < 0 ? n : end + 3;
    emit(out, i, stop, "comment");
    return { end: stop, raw: null };
  }

  if (text.startsWith("<![CDATA[", i)) {
    const start = i + 9;
    const end = text.indexOf("]]>", start);
    const bodyEnd = end < 0 ? n : end;
    emit(out, i, start, "punct");
    emit(out, start, bodyEnd, "string");
    if (end >= 0) {
      emit(out, end, end + 3, "punct");
      return { end: end + 3, raw: null };
    }
    return { end: n, raw: null };
  }

  if (text.startsWith("<?", i)) {
    return { end: scanInstruction(text, out, i, "?>"), raw: null };
  }

  if (text.startsWith("<!", i)) {
    return { end: scanInstruction(text, out, i, ">"), raw: null };
  }

  return scanTag(text, out, i, rawNames);
}

/* ------------------------------------------------------------------ */
/* entry point                                                         */
/* ------------------------------------------------------------------ */

function rawElementNames(lang) {
  const names = new Set();
  if (lang && Array.isArray(lang.rawElements)) {
    for (const name of lang.rawElements) {
      if (typeof name === "string" && name !== "") {
        names.add(name.toLowerCase());
      }
    }
  }
  return names;
}

/**
 * Tokenizes one SGML document.
 *
 * @param {object} lang  a descriptor parsed by `lang.mjs` with `family sgml`
 * @param {string} text
 * @returns {number[][]} `[start, end, kind]` triples tiling `text`
 */
export function tokenizeSgml(lang, text) {
  const out = [];
  const n = text.length;
  const rawNames = rawElementNames(lang);
  let raw = null;
  let i = 0;

  while (i < n) {
    if (raw !== null) {
      const close = findCloseTag(text, i, raw);
      const stop = close < 0 ? n : close;
      while (i < stop) {
        i = stepText(text, out, i, true, stop);
      }
      if (close < 0) {
        // An unclosed raw element runs to the end of the file, which is what
        // a browser does with `<script>` too.
        break;
      }
      raw = null;
      continue;
    }

    if (text[i] === "<") {
      const step = scanMarkup(text, out, i, rawNames);
      i = step.end;
      raw = step.raw;
      continue;
    }

    i = stepText(text, out, i, false);
  }

  return out;
}
