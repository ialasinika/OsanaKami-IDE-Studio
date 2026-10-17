/**
 * cards/sheet.mjs -- the sheet model: a grid of typed cells with stable ids.
 *
 * Part of `cards.mjs`, which re-exports this file; see that file's header for
 * why the card layer is split the way it is.
 */

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

export function sheetId(prefix, taken) {
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
export function replaceSheet(doc, sheet) {
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
export function sheetCellOf(sheet, rowId, columnId) {
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
export function applySheetCell(doc, rowId, columnId, compute) {
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
export function sheetSummaryOf(sheet) {
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
