// Translation tables. The game exports every line of every node into
// `NewProject_<language>.csv` next to the source table `NewProject.csv`, one row
// per line, joined by the `line:<id>` key that the yarn files already carry.
//
// Deliberately imports nothing and touches no DOM, so it runs under Node for
// tests and in the page for the editor, and so it stays independent of
// story.mjs while that module settles.
//
// Two facts about the real files, measured on all 18609 rows of the source
// table, that the code below depends on:
//
//   * Quoting is real. A naive `split(",")` is wrong for 8432 of the 18609 rows
//     of `NewProject_EN.csv` -- the text of a line routinely contains commas,
//     and an embedded `"` is written as `""`.
//   * `lock` is the first four bytes of SHA-256 of the SOURCE text, big-endian,
//     lower-case hex. It matched 18609/18609 rows of the source table, and every
//     language table carries the source row's lock rather than its own. That is
//     the whole staleness test: a translation is out of date when the lock it
//     recorded no longer matches the hash of the source line it came from.

export const CSV_COLUMNS = Object.freeze([
  "language",
  "id",
  "text",
  "file",
  "node",
  "lineNumber",
  "lock",
  "comment",
]);

/** The export starts with a byte order mark and uses CRLF throughout. */
export const CSV_BOM = "\ufeff";
export const CSV_HEADER = CSV_BOM + CSV_COLUMNS.join(",");
export const CSV_EOL = "\r\n";

/** Line ids in this project are always `line:` plus seven hex digits. */
const LINE_ID = /^line:([0-9a-fA-F]+)$/;

/**
 * The id column of a translation table, parsed. Named apart from the identically
 * named export of `story.mjs` on purpose: that one finds a `#line:` marker
 * inside a line of yarn, this one reads the `line:<id>` key that the export
 * writes into the `id` column. They are not interchangeable.
 */
export function csvLineIdOf(id) {
  const match = LINE_ID.exec(String(id).trim());
  return match ? match[1].toLowerCase() : null;
}

export function idOfLine(lineId) {
  return `line:${String(lineId).trim().toLowerCase()}`;
}

/** A field is quoted when it holds a comma or a quote; nothing else needs it. */
export function needsQuoting(field) {
  return /[",\r\n]/.test(field);
}

export function joinField(field) {
  return needsQuoting(field) ? `"${field.replace(/"/g, '""')}"` : field;
}

/**
 * One CSV record, quote aware. Returns the fields in column order; a short row
 * is not padded and a long one is not truncated, so the caller can notice.
 */
export function splitCsvRow(line) {
  const fields = [];
  let at = 0;
  for (;;) {
    if (line[at] === '"') {
      let field = "";
      at += 1;
      while (at < line.length) {
        if (line[at] === '"' && line[at + 1] === '"') {
          field += '"';
          at += 2;
          continue;
        }
        if (line[at] === '"') {
          at += 1;
          break;
        }
        field += line[at];
        at += 1;
      }
      fields.push(field);
    } else {
      const next = line.indexOf(",", at);
      if (next === -1) {
        fields.push(line.slice(at));
        break;
      }
      fields.push(line.slice(at, next));
      at = next;
    }
    if (line[at] !== ",") break;
    at += 1;
  }
  return fields;
}

export function joinCsvRow(fields) {
  return fields.map(joinField).join(",");
}

/**
 * A row with the columns named, plus the exact fields it was parsed from. The
 * fields are the source of truth for writing back: not every table in this
 * folder has the eight columns above -- `NewProject-metadata.csv` has five and
 * uses LF instead of CRLF -- so a rewrite must give back the shape it read.
 */
function rowOf(fields) {
  const row = { fields: fields.slice() };
  CSV_COLUMNS.forEach((name, index) => {
    row[name] = fields[index] === undefined ? "" : fields[index];
  });
  row.fieldCount = fields.length;
  row.lineId = csvLineIdOf(row.id);
  return row;
}

/**
 * Change one named column, keeping the exact fields in step so a rewrite emits
 * the edit and leaves every other byte of the row alone.
 */
export function setColumn(row, name, value) {
  const index = CSV_COLUMNS.indexOf(name);
  if (index === -1) throw new Error(`unknown column: ${name}`);
  row[name] = value;
  while (row.fields.length <= index) row.fields.push("");
  row.fields[index] = value;
  if (name === "id") row.lineId = csvLineIdOf(value);
  row.fieldCount = row.fields.length;
  return row;
}

/**
 * The whole table. `header`, the line ending and the byte order mark are kept
 * exactly as read, so `serializeCsv` can give the same bytes back.
 */
export function parseCsv(text) {
  const bom = text.startsWith(CSV_BOM);
  const body = bom ? text.slice(CSV_BOM.length) : text;
  const eol = body.includes("\r\n") ? "\r\n" : "\n";
  const endsWithEol = body.endsWith("\n");
  const lines = body.split("\n");
  if (endsWithEol) lines.pop();
  const header = lines.length > 0 ? lines[0].replace(/\r$/, "") : "";
  const rows = [];
  const odd = [];
  for (let at = 1; at < lines.length; at += 1) {
    const line = lines[at].replace(/\r$/, "");
    if (line === "") continue;
    const fields = splitCsvRow(line);
    if (fields.length !== CSV_COLUMNS.length && fields.length !== 5) odd.push({ line: at + 1, fields: fields.length });
    rows.push(rowOf(fields));
  }
  return { bom, header, eol, endsWithEol, rows, odd };
}

export function serializeCsv(table) {
  const eol = table.eol || CSV_EOL;
  const lines = [table.header, ...table.rows.map((row) => row.fields.map(joinField).join(","))];
  return (table.bom ? CSV_BOM : "") + lines.join(eol) + (table.endsWithEol ? eol : "");
}

/* ------------------------------------------------------------------ locks */

// SHA-256 over UTF-8, then the first four bytes as lower-case hex. Written out
// rather than imported so this module has no dependencies and no async step.
const K = new Uint32Array([
  0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5,
  0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174,
  0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
  0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967,
  0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85,
  0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
  0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
  0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2,
]);

export function sha256(bytes) {
  const length = bytes.length;
  const withPad = new Uint8Array((((length + 8) >> 6) + 1) * 64);
  withPad.set(bytes);
  withPad[length] = 0x80;
  const view = new DataView(withPad.buffer);
  // Bit length as a 64-bit big-endian value; JS text never reaches 2^53 bits.
  view.setUint32(withPad.length - 8, Math.floor(length / 0x20000000));
  view.setUint32(withPad.length - 4, (length << 3) >>> 0);

  const h = new Uint32Array([
    0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a, 0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19,
  ]);
  const w = new Uint32Array(64);
  const rotr = (x, n) => ((x >>> n) | (x << (32 - n))) >>> 0;

  for (let block = 0; block < withPad.length; block += 64) {
    for (let i = 0; i < 16; i += 1) w[i] = view.getUint32(block + i * 4);
    for (let i = 16; i < 64; i += 1) {
      const s0 = rotr(w[i - 15], 7) ^ rotr(w[i - 15], 18) ^ (w[i - 15] >>> 3);
      const s1 = rotr(w[i - 2], 17) ^ rotr(w[i - 2], 19) ^ (w[i - 2] >>> 10);
      w[i] = (w[i - 16] + s0 + w[i - 7] + s1) >>> 0;
    }
    let [a, b, c, d, e, f, g, hh] = h;
    for (let i = 0; i < 64; i += 1) {
      const S1 = rotr(e, 6) ^ rotr(e, 11) ^ rotr(e, 25);
      const ch = (e & f) ^ (~e & g);
      const t1 = (hh + S1 + ch + K[i] + w[i]) >>> 0;
      const S0 = rotr(a, 2) ^ rotr(a, 13) ^ rotr(a, 22);
      const maj = (a & b) ^ (a & c) ^ (b & c);
      const t2 = (S0 + maj) >>> 0;
      hh = g; g = f; f = e; e = (d + t1) >>> 0;
      d = c; c = b; b = a; a = (t1 + t2) >>> 0;
    }
    const next = [a, b, c, d, e, f, g, hh];
    for (let i = 0; i < 8; i += 1) h[i] = (h[i] + next[i]) >>> 0;
  }

  const out = new Uint8Array(32);
  const outView = new DataView(out.buffer);
  for (let i = 0; i < 8; i += 1) outView.setUint32(i * 4, h[i]);
  return out;
}

/** The lock the game records for a piece of source text. */
export function lockOf(text) {
  const digest = sha256(new TextEncoder().encode(text));
  let out = "";
  for (let i = 0; i < 4; i += 1) out += digest[i].toString(16).padStart(2, "0");
  return out;
}

export function looksLikeLock(value) {
  return /^[0-9a-fA-F]{8}$/.test(String(value).trim());
}

/* -------------------------------------------------------------- line meta */

/**
 * The `comment` column carries the line's ysls metadata, e.g.
 * `Line metadata: state:Idle` or `Line metadata: Tech state:Funny`.
 */
export function metadataOf(comment) {
  const raw = String(comment ?? "").trim();
  const body = raw.replace(/^Line metadata:\s*/, "");
  const tags = [];
  let state = "";
  for (const token of body.split(/\s+/)) {
    if (token === "") continue;
    const colon = token.indexOf(":");
    if (colon > 0 && token.slice(0, colon) === "state") state = token.slice(colon + 1);
    else tags.push(token);
  }
  return { raw, tags, state };
}

/**
 * Every speaker the table uses, in the order they first appear. The editor
 * offers these as completions, the same way it offers node names.
 */
export function speakersOf(rows) {
  const seen = new Set();
  for (const row of rows) {
    const match = /^([^\s:]+):\s/.exec(row.text ?? "");
    if (match) seen.add(match[1]);
  }
  return [...seen];
}

/* --------------------------------------------------------------- compare */

/** Every row of a table keyed by its `id` column, which is what yarn carries. */
export function rowsById(table) {
  const byId = new Map();
  for (const row of table.rows) byId.set(row.id, row);
  return byId;
}

/**
 * How one row of a translation table stands against the source row it was made
 * from. `compareTables` below is this verdict counted over a whole table, so the
 * editor can put a single line on screen and get the same answer the summary
 * gives. `missing` is the only state that needs no row; a row with no usable
 * lock is never called `stale`, because there is nothing to compare it to.
 */
export function rowState(source, row) {
  if (!row) return "missing";
  if (looksLikeLock(row.lock) && row.lock.toLowerCase() !== lockOf(source.text)) return "stale";
  if (row.text === source.text) return "untranslated";
  return "ok";
}

/**
 * How a translation table stands against the source table it was made from.
 *
 * A row is `stale` when the source text it was translated from has changed
 * since -- the recorded lock no longer matches the hash of the source line.
 * It is `untranslated` when the text is still byte-identical to the source.
 * Ids the source has and the translation does not are `missing`; ids the
 * translation has and the source does not are `orphan`.
 */
export function compareTables(base, translation) {
  const translated = rowsById(translation);

  const stale = [];
  const untranslated = [];
  const missing = [];
  const seen = new Set();

  for (const source of base.rows) {
    const row = translated.get(source.id);
    const state = rowState(source, row);
    if (state === "missing") {
      missing.push({ id: source.id, lineId: source.lineId, text: source.text });
      continue;
    }
    seen.add(source.id);
    if (state === "stale") {
      stale.push({ id: source.id, lineId: source.lineId, was: row.lock, now: lockOf(source.text), source: source.text, text: row.text });
    }
    if (state === "untranslated") untranslated.push({ id: source.id, lineId: source.lineId, text: row.text });
  }

  const baseIds = new Set(base.rows.map((row) => row.id));
  const orphan = [];
  for (const row of translation.rows) {
    if (!baseIds.has(row.id)) orphan.push({ id: row.id, lineId: row.lineId, text: row.text });
  }

  return {
    language: translation.rows.length > 0 ? translation.rows[0].language : "",
    total: base.rows.length,
    translated: seen.size,
    stale,
    untranslated,
    missing,
    orphan,
  };
}
