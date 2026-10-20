/* ------------------------------------------------------------------ */
/* the card-kind hook and the sheet model
/* ------------------------------------------------------------------ */

import assert from "node:assert/strict";
import {
  CARD_KINDS,
  DEFAULT_SIZE,
  MIN_SIZE,
  createBoard,
  normaliseDocument,
} from "../board.mjs";
import {
  CARD_KIND_CONTRACT,
  SHEET_TYPES,
  addSheetColumn,
  addSheetRow,
  cardKind,
  coerceSheetValue,
  describeCard,
  emptySheet,
  knownCardKinds,
  nextSheetSelection,
  normaliseSheet,
  registerCardKind,
  removeSheetColumn,
  removeSheetRow,
  setSheetCell,
  sheetCell,
  sheetSummary,
  sheetToTSV,
} from "../cards.mjs";
import {
  test,
  testAsync,
} from "./harness.mjs";

/* ------------------------------------------------------------------ */
/* the card-kind hook                                                  */
/* ------------------------------------------------------------------ */

test("hook: the built-in kinds register in a known order", () => {
  assert.deepEqual(knownCardKinds(), [
    "editor", "runner", "note", "files", "project", "sheet", "story", "pixel",
    "rig", "mod", "problems", "docs", "settings", "help", "audio",
  ]);
  for (const kind of knownCardKinds()) {
    const spec = cardKind(kind);
    assert.equal(spec.kind, kind);
    assert.equal(typeof spec.render, "function");
    assert.equal(typeof spec.describe, "function");
    assert.equal(typeof spec.create, "function");
    assert.equal(typeof spec.title, "string");
    assert.ok(Object.isFrozen(spec), `${kind} is frozen so a fork cannot half-edit it`);
    // Every kind must be placeable without a size from the caller.
    assert.ok(DEFAULT_SIZE[kind] && DEFAULT_SIZE[kind].w >= MIN_SIZE.w && DEFAULT_SIZE[kind].h >= MIN_SIZE.h,
      `${kind} needs a usable default size`);
  }
  assert.equal(cardKind("nosuchkind"), null);
  assert.deepEqual(CARD_KIND_CONTRACT.required, ["kind", "render"]);
});

test("hook: a bad registration is refused", () => {
  assert.throws(() => registerCardKind(null), /must be an object/);
  assert.throws(() => registerCardKind({}), /kind must be a non-empty string/);
  assert.throws(() => registerCardKind({ kind: "x" }), /render must be a function/);
  assert.throws(
    () => registerCardKind({ kind: "note", render: () => ({}) }),
    /already registered/,
    "overriding a built-in has to be explicit",
  );
  assert.equal(cardKind("x"), null, "a refused registration leaves nothing behind");
});

test("hook: registerCardKind is the whole extension mechanism", () => {
  const before = knownCardKinds().length;
  const spec = registerCardKind({
    kind: "probe",
    title: "Probe",
    create: () => ({ n: 7 }),
    describe: (card) => `probe n=${card.n}`,
    render: () => ({ el: null, handle: {}, destroy() {} }),
  });
  assert.equal(spec.title, "Probe");
  assert.equal(knownCardKinds().length, before + 1);
  assert.deepEqual(spec.create(), { n: 7 });
  assert.equal(describeCard({ id: "c9", kind: "probe", n: 3 }), "probe n=3");
  /* The board stores any kind, so a new one needs no board change. */
  const board = createBoard();
  const card = board.addCard("probe", 0, 0, spec.create());
  assert.equal(card.n, 7);
  assert.equal(board.serialize().cards[0].kind, "probe");
  /* Clean up so later checks see the shipped set. */
  registerCardKind({ kind: "probe", render: () => ({ el: null, handle: {}, destroy() {} }), replace: true });
});

test("describe: an unregistered or hostile kind cannot break the header", () => {
  assert.match(describeCard({ id: "c1", kind: "mystery" }), /^mystery c1$/);
  assert.equal(describeCard(null), "no card selected");
  assert.match(describeCard({ id: "c2" }), /^\? c2$/);
  registerCardKind({
    kind: "grumpy",
    replace: true,
    render: () => ({ el: null, handle: {}, destroy() {} }),
    describe: () => {
      throw new Error("nope");
    },
  });
  assert.match(describeCard({ id: "c3", kind: "grumpy" }), /^grumpy c3/);
});

/* ------------------------------------------------------------------ */
/* the sheet model -- structured, not textual state                    */
/* ------------------------------------------------------------------ */

test("sheet: emptySheet is a legal one-by-one grid", () => {
  const sheet = emptySheet();
  assert.equal(sheet.columns.length, 1);
  assert.equal(sheet.rows.length, 1);
  assert.equal(sheetSummary(sheet), "1 row x 1 column");
  assert.deepEqual(SHEET_TYPES, ["text", "number", "bool", "choice"]);
  assert.equal(sheetCell(sheet, "row1", "column1"), "");
});

test("sheet: normaliseSheet repairs anything into a usable grid", () => {
  const empty = normaliseSheet(undefined);
  assert.equal(empty.columns.length, 1, "a sheet always has at least one column");

  const repaired = normaliseSheet({
    columns: [
      { id: "a", title: "", type: "number" },
      { id: "a", type: "nosuchtype" },
      "not a column",
      { id: "c", type: "choice", options: ["x", 9, "y"] },
    ],
    rows: [
      { id: "r", cells: { a: "12.5", c: "x" } },
      { id: "r", cells: null },
      "not a row",
    ],
  });
  assert.equal(repaired.columns.length, 3, "the string is not a column");
  assert.equal(repaired.columns[0].title, "a", "a missing title falls back to the id");
  assert.deepEqual(repaired.columns[1].type, "text", "an unknown type becomes text");
  assert.notEqual(repaired.columns[1].id, "a", "a duplicate id is renamed");
  assert.deepEqual(repaired.columns[2].options, ["x", "y"], "non-string options are dropped");
  assert.equal(repaired.rows.length, 2, "the string is not a row");
  assert.equal(repaired.rows[0].cells.a, 12.5, "a number column coerces its cell");
  assert.deepEqual(Object.keys(repaired.rows[1].cells), ["a", repaired.columns[1].id, "c"],
    "a row with no cells still gets one slot per column");
  assert.notEqual(repaired.rows[1].id, "r", "a duplicate row id is renamed");
});

test("sheet: coercion is by column type, and never throws", () => {
  assert.equal(coerceSheetValue("number", "3.5"), 3.5);
  assert.equal(coerceSheetValue("number", "  -2 "), -2);
  assert.equal(coerceSheetValue("number", "banana"), 0);
  assert.equal(coerceSheetValue("number", NaN), 0);
  assert.equal(coerceSheetValue("bool", true), true);
  assert.equal(coerceSheetValue("bool", "true"), true);
  assert.equal(coerceSheetValue("bool", "false"), false);
  assert.equal(coerceSheetValue("bool", 0), false);
  assert.equal(coerceSheetValue("text", null), "");
  assert.equal(coerceSheetValue("text", 42), "42");
  assert.equal(coerceSheetValue("nosuchtype", 42), "42");
});

test("sheet: editing mutates the card's own object, not a copy", () => {
  const doc = emptySheet();
  const identity = doc;
  assert.equal(setSheetCell(doc, "row1", "column1", "hello"), true);
  assert.equal(doc, identity, "card.doc keeps its identity across an edit");
  assert.equal(sheetCell(doc, "row1", "column1"), "hello");
  assert.equal(setSheetCell(doc, "nosuchrow", "column1", "x"), false);
  assert.equal(sheetCell(doc, "nosuchrow", "column1"), "");
});

/* Loaded apart from the static imports above so that a build without the
   header's write path fails THIS check (and says which one) instead of failing
   the whole file at import time -- which is how it reads when the fix is
   reverted to look at the failure. */
const { updateSheetColumn } = await import("../cards.mjs");

await testAsync("sheet: a column edit lands on the live doc, never on a captured column object", async () => {
  assert.equal(typeof updateSheetColumn, "function",
    "the renderer needs a pure write path that resolves a column by id");

  const doc = emptySheet();
  const identity = doc;
  const painted = doc.columns[0];

  /* A header listener holds the column object its paint was handed.  One cell
     edit is all it takes to make that object stale: every write lands fresh
     columns and rows in `doc` through replaceSheet (which is what keeps
     card.doc's identity stable). */
  assert.equal(setSheetCell(doc, "row1", "column1", "typed"), true);
  assert.notEqual(doc.columns[0], painted, "a cell edit replaces the column objects");

  painted.title = "written through the captured object";
  assert.equal(doc.columns[0].title, "column1",
    "a write through the captured object is invisible to the document");
  assert.equal(sheetToTSV(doc).split("\n")[0], "column1",
    "... so the rename is gone at the next repaint");

  /* Resolving by id at event time is what makes the header edits stick. */
  const renamed = updateSheetColumn(doc, "column1", { title: "renamed" });
  assert.notEqual(renamed, null);
  assert.equal(doc, identity, "the write keeps card.doc's identity");
  assert.equal(doc.columns[0].title, "renamed");
  assert.equal(normaliseSheet(doc).columns[0].title, "renamed", "and it survives a re-normalise");
  assert.equal(renamed.rows[0].cells.column1, "typed", "the cell edit is still there");

  /* The same write path serves the type select, which re-normalises the column
     so every cell under it takes the new type. */
  const retyped = updateSheetColumn(doc, "column1", { type: "number" });
  assert.equal(doc.columns[0].type, "number");
  assert.equal(doc.columns[0].title, "renamed", "a type change does not drop the name");
  assert.equal(doc.rows[0].cells.column1, 0, "\"typed\" is not a number, so the cell is 0");
  assert.equal(retyped.columns[0].type, "number", "the write returns the sheet it stored");

  const chosen = updateSheetColumn(doc, "column1", { type: "choice" });
  assert.deepEqual(chosen.columns[0].options, ["one", "two", "three"],
    "a column that becomes a choice gets options to choose from");
  assert.equal(doc.rows[0].cells.column1, "0", "and its cells become option strings");

  assert.equal(updateSheetColumn(doc, "nosuchcolumn", { title: "x" }), null,
    "a column that is not there is not invented");
  assert.equal(doc.columns.length, 1, "... and nothing is added to the sheet");
});

test("sheet: sheetCell still repairs a document it was handed unnormalised", () => {
  /* The paint loop no longer calls this once per cell, but the exported lookup
     keeps its guarantee for external callers: hand it anything, and it
     normalises the document itself first. */
  const hostile = {
    columns: [{ id: "n", type: "number" }, { id: "n", type: "bool" }],
    rows: [{ id: "r", cells: { n: "  -2 " } }, { id: "r", cells: null }, "not a row"],
  };
  const repaired = normaliseSheet(hostile);
  assert.equal(sheetCell(hostile, "r", "n"), -2, "coerced by the column's type");
  assert.equal(sheetCell(hostile, "r", repaired.columns[1].id), false,
    "a row with no cells is still filled in, one slot per column");
  assert.equal(sheetCell(hostile, repaired.rows[1].id, "n"), 0,
    "and every cell in it is coerced for its column");
  assert.equal(sheetCell(hostile, "r", "nosuchcolumn"), "");
  assert.equal(sheetCell(hostile, "nosuchrow", "n"), "");
  assert.equal(sheetCell(undefined, "row1", "column1"), "");
});

test("sheet: rows and columns add and remove, with the edges guarded", () => {
  const doc = emptySheet();
  const column = addSheetColumn(doc, "number");
  assert.equal(doc.columns.length, 2);
  assert.equal(column.type, "number");

  const row = addSheetRow(doc);
  assert.equal(doc.rows.length, 2);
  assert.deepEqual(Object.keys(row.cells), doc.columns.map((c) => c.id),
    "a new row has a cell for every column, including ones added before it");
  assert.equal(row.cells[column.id], 0, "a number cell starts at 0, not at ''");

  assert.equal(removeSheetRow(doc, row.id), true);
  assert.equal(removeSheetRow(doc, row.id), false);
  assert.equal(doc.rows.length, 1);

  assert.equal(removeSheetColumn(doc, column.id), true);
  assert.equal(removeSheetColumn(doc, doc.columns[0].id), false, "the last column stays");
  assert.equal(removeSheetColumn(doc, "nosuchcolumn"), false);
  assert.equal(doc.columns.length, 1);

  /* An empty sheet is legal; only the columns are load-bearing. */
  assert.equal(removeSheetRow(doc, doc.rows[0].id), true);
  assert.equal(doc.rows.length, 0);
  assert.equal(sheetSummary(doc), "0 rows x 1 column");
});

test("sheet: TSV is how structured state leaves the card", () => {
  const doc = normaliseSheet({
    columns: [{ id: "name", title: "name" }, { id: "n", title: "n", type: "number" }],
    rows: [{ id: "r1", cells: { name: "a\tb\nc", n: 5 } }, { id: "r2", cells: { name: "z", n: 0 } }],
  });
  assert.equal(sheetToTSV(doc), "name\tn\na b c\t5\nz\t0\n",
    "tabs and newlines inside a cell become spaces so the grid stays rectangular");
  assert.equal(sheetToTSV(emptySheet()), "column1\n\n");
});

test("sheet: keyboard navigation clamps instead of wrapping", () => {
  const doc = normaliseSheet({
    columns: [{ id: "a" }, { id: "b" }],
    rows: [{ id: "r1" }, { id: "r2" }],
  });
  assert.deepEqual(nextSheetSelection(doc, { row: 0, column: 0 }, 1, 1), { row: 1, column: 1 });
  assert.deepEqual(nextSheetSelection(doc, { row: 1, column: 1 }, 1, 1), { row: 1, column: 1 });
  assert.deepEqual(nextSheetSelection(doc, { row: 0, column: 0 }, -1, -1), { row: 0, column: 0 });
  assert.deepEqual(nextSheetSelection(doc, null, 0, 1), { row: 0, column: 1 });
  assert.equal(nextSheetSelection({ columns: [{ id: "a" }], rows: [] }, null, 1, 0), null);
});

test("protocol: a non-text card payload survives the board verbatim", () => {
  const doc = normaliseSheet({
    columns: [{ id: "k", title: "key" }, { id: "n", title: "n", type: "number" }, { id: "f", type: "bool" }],
    rows: [{ id: "r1", cells: { k: "unicode: \u00e9\u4e2d", n: 1.5, f: true } }],
  });
  const board = createBoard();
  board.load({
    version: 1,
    cards: [{ id: "s1", kind: "sheet", x: 0, y: 0, w: 400, h: 300, z: 1, title: "t", doc }],
    links: [],
  });
  const out = board.serialize();
  assert.equal(out.cards.length, 1);
  assert.equal(out.cards[0].kind, "sheet", "the board does not police card kinds");
  assert.deepEqual(out.cards[0].doc, doc, "nested structured state round-trips unchanged");
  assert.notEqual(out.cards[0].doc, doc, "and it is a copy, not an alias");
  assert.equal(DEFAULT_SIZE.sheet.w, 460);
  assert.ok(CARD_KINDS.includes("sheet"));
});

test("protocol: an unknown kind is preserved, never silently dropped", () => {
  const board = createBoard();
  board.load({
    version: 1,
    cards: [{ id: "u1", kind: "holodeck", x: 1, y: 2, w: 3, h: 4, payload: { deep: [1, 2, { three: true }] } }],
    links: [],
  });
  const out = board.serialize();
  assert.equal(out.cards.length, 1);
  assert.equal(out.cards[0].kind, "holodeck");
  assert.deepEqual(out.cards[0].payload, { deep: [1, 2, { three: true }] });
});

test("protocol: the document's card check is shape, not vocabulary", () => {
  /* The schema (board.mjs) requires id/kind/x/y/w/h and nothing else, which is
     what lets a fork invent kinds without touching C -- and the kernel no
     longer has a card check of its own to disagree with. */
  const shape = normaliseDocument({
    cards: [
      { id: "c1", kind: "sheet", x: 0, y: 0, w: 10, h: 10, doc: { anything: true } },
      { kind: "sheet", x: 0, y: 0, w: 10, h: 10 },
      { id: "c2", kind: "", x: 0, y: 0, w: 10, h: 10 },
      { id: "c3", kind: "note", x: 0, y: 0 },
    ],
  });
  assert.equal(shape.document.cards.length, 1);
  assert.equal(shape.droppedCards.length, 3);
  assert.deepEqual(shape.document.cards[0].doc, { anything: true });
});

test("protocol: a board that says `spine` loads the card that is now called `rig`", () => {
  /* The card is renamed before any release, but a board written during
     development still carries the format's name in `kind`.  Dropping it
     would look like the card had been deleted, so the loader maps it. */
  const shape = normaliseDocument({
    cards: [{ id: "s1", kind: "spine", x: 0, y: 0, w: 660, h: 560, file: "Cop.skel.bytes" }],
  });
  assert.equal(shape.document.cards.length, 1);
  assert.equal(shape.document.cards[0].kind, "rig");
  assert.equal(shape.document.cards[0].file, "Cop.skel.bytes");
});
