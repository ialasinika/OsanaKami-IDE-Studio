/**
 * cards/card-sheet.mjs -- the sheet card: the grid, the selection, the TSV.
 *
 * Part of `cards.mjs`, which re-exports this file; see that file's header for
 * why the card layer is split the way it is.
 */
import { cardShell, caretAtEnd, caretAtStart, h, makeStatus } from "./dom.mjs";
import {
  SHEET_TYPES,
  addSheetColumn,
  addSheetRow,
  applySheetCell,
  coerceSheetValue,
  nextSheetSelection,
  normaliseSheet,
  removeSheetColumn,
  removeSheetRow,
  sheetCell,
  sheetSummaryOf,
  sheetToTSV,
  updateSheetColumn,
} from "./sheet.mjs";

/**
 * The structured-data card.
 *
 * Nothing here is a textarea: the card's state is a nested object of columns
 * and rows, each cell a typed control.  The renderer never round-trips that
 * state through a string, which is the whole point -- it is the counterexample
 * to "a card is a file with a cursor".
 */
export function renderSheet(card, ctx) {
  const { app } = ctx;
  card.doc = normaliseSheet(card.doc);
  if (typeof card.title !== "string") {
    card.title = "";
  }

  const thead = h("thead");
  const tbody = h("tbody");
  const table = h("table", "sheet-grid", { children: [thead, tbody] });
  const scroll = h("div", "sheet-scroll", { children: [table] });
  const tools = h("div", "sheet-tools", {
    attrs: { "data-role": "sheet-tools" },
  });
  const status = makeStatus();
  const body = h("div", "card-body card-body-sheet", {
    children: [scroll, tools, status],
  });
  const shell = cardShell(card, body);

  const addRowButton = h("button", "sheet-tool", {
    attrs: { type: "button", "data-role": "sheet-add-row" }, text: "+ row",
  });
  const addColumnButton = h("button", "sheet-tool", {
    attrs: { type: "button", "data-role": "sheet-add-column" }, text: "+ column",
  });
  const tsvButton = h("button", "sheet-tool", {
    attrs: { type: "button", "data-role": "sheet-tsv", title: "copy the sheet as TSV" },
    text: "TSV",
  });
  tools.append(addRowButton, addColumnButton, tsvButton);

  /** Focus target that survives a repaint. */
  let lastFocus = null;

  function commit() {
    app.boardTouched(true);
    updateStatus();
  }

  /** Status line for a sheet the caller already normalised. */
  function updateStatusFrom(sheet) {
    status.textContent = `${sheetSummaryOf(sheet)} · structured state, no text`;
    shell.label.textContent = card.title !== "" ? card.title : sheetSummaryOf(sheet);
  }

  function updateStatus() {
    updateStatusFrom(normaliseSheet(card.doc));
  }

  function cellNode(rowIndex, columnIndex) {
    return tbody.querySelector(`[data-cell="${rowIndex}:${columnIndex}"]`);
  }

  function focusCell(selection) {
    if (selection === null) {
      return;
    }
    lastFocus = selection;
    const node = cellNode(selection.row, selection.column);
    if (node !== null) {
      node.focus();
      if (typeof node.select === "function") {
        node.select();
      }
    }
  }

  function moveFrom(event, rowIndex, columnIndex) {
    let dRow = 0;
    let dColumn = 0;
    if (event.key === "ArrowDown" || event.key === "Enter") {
      dRow = 1;
    } else if (event.key === "ArrowUp") {
      dRow = -1;
    } else if (event.key === "ArrowRight" && caretAtEnd(event.target)) {
      dColumn = 1;
    } else if (event.key === "ArrowLeft" && caretAtStart(event.target)) {
      dColumn = -1;
    } else {
      event.stopPropagation();
      return;
    }
    const next = nextSheetSelection(card.doc, { row: rowIndex, column: columnIndex }, dRow, dColumn);
    focusCell(next);
    event.preventDefault();
    event.stopPropagation();
  }

  function bindCellKeys(control, rowIndex, columnIndex) {
    control.addEventListener("keydown", (event) => {
      moveFrom(event, rowIndex, columnIndex);
    });
  }

  function makeCellControl(row, column, rowIndex, columnIndex) {
    /* `row` and `column` belong to the paint's own normalised snapshot, so the
       value below is what `sheetCell(card.doc, ...)` would return, without
       normalising the document once per cell.  The handlers capture ids, never
       these objects: a write hands the document a fresh set of rows and
       columns, so an object captured at paint time is a sheet the card no
       longer holds and a write through it disappears at the next repaint. */
    const rowId = row.id;
    const columnId = column.id;
    const value = coerceSheetValue(column.type, row.cells[columnId]);
    let control;

    if (column.type === "bool") {
      control = h("button", "sheet-toggle", {
        attrs: { type: "button", "data-cell": `${rowIndex}:${columnIndex}` },
      });
      const show = (on) => {
        control.textContent = on ? "true" : "false";
        control.setAttribute("aria-pressed", on ? "true" : "false");
        control.classList.toggle("is-on", on);
      };
      show(value);
      control.addEventListener("click", () => {
        /* Read and write the toggle in one normalise: the stored value comes
           back from the write, so nothing has to look the cell up again. */
        const stored = applySheetCell(card.doc, rowId, columnId, (on) => !on);
        show(stored === undefined ? false : stored);
        commit();
      });
      bindCellKeys(control, rowIndex, columnIndex);
      return control;
    }

    if (column.type === "choice") {
      control = h("select", "sheet-choice", {
        attrs: { "data-cell": `${rowIndex}:${columnIndex}` },
      });
      const options = Array.isArray(column.options) ? column.options.slice() : [];
      if (!options.includes(value)) {
        options.unshift(value);
      }
      for (const option of options) {
        const node = document.createElement("option");
        node.value = option;
        node.textContent = option === "" ? "(empty)" : option;
        control.append(node);
      }
      control.value = value;
      control.addEventListener("change", () => {
        applySheetCell(card.doc, rowId, columnId, () => control.value);
        commit();
      });
      bindCellKeys(control, rowIndex, columnIndex);
      return control;
    }

    control = h("input", "sheet-input", {
      attrs: {
        type: "text",
        spellcheck: "false",
        "data-cell": `${rowIndex}:${columnIndex}`,
      },
    });
    if (column.type === "number") {
      control.setAttribute("inputmode", "decimal");
      control.classList.add("is-number");
    }
    control.value = value === "" ? "" : String(value);
    control.addEventListener("change", () => {
      const stored = applySheetCell(card.doc, rowId, columnId, () => control.value);
      /* Show what the column's type actually stored ("  2  " -> "2"). */
      control.value = stored === undefined ? "" : String(stored);
      commit();
    });
    bindCellKeys(control, rowIndex, columnIndex);
    return control;
  }

  function makeColumnHeader(column, columnIndex) {
    /* `column` is the paint's snapshot; only its id is kept.  Anything the
       handlers below need to change they change in the live document through
       `updateSheetColumn`, which resolves the column by id -- a title typed
       after any cell edit used to land on an object the card had replaced. */
    const columnId = column.id;
    const cell = h("th", "sheet-col", { attrs: { "data-role": "sheet-col" } });

    const titleInput = h("input", "sheet-col-title", {
      attrs: { type: "text", spellcheck: "false", title: "column name" },
    });
    titleInput.value = column.title;
    titleInput.addEventListener("input", () => {
      /* Per keystroke: one normalise, and the status line is refreshed from the
         sheet the write returned instead of normalising a second time. */
      const sheet = updateSheetColumn(card.doc, columnId, { title: titleInput.value });
      if (sheet !== null) {
        updateStatusFrom(sheet);
      }
      app.boardTouched(true);
    });
    titleInput.addEventListener("keydown", (event) => {
      event.stopPropagation();
    });

    const typeSelect = document.createElement("select");
    typeSelect.className = "sheet-col-type";
    typeSelect.setAttribute("title", "column type");
    for (const type of SHEET_TYPES) {
      const option = document.createElement("option");
      option.value = type;
      option.textContent = type;
      typeSelect.append(option);
    }
    typeSelect.value = column.type;
    typeSelect.addEventListener("change", () => {
      /* A type change re-normalises every cell under the column. */
      updateSheetColumn(card.doc, columnId, { type: typeSelect.value });
      paint();
      commit();
    });

    const drop = h("button", "sheet-drop", {
      attrs: { type: "button", title: "remove column" }, text: "\u00d7",
    });
    drop.addEventListener("click", () => {
      if (removeSheetColumn(card.doc, columnId)) {
        paint();
        commit();
      } else {
        app.log("warn", "sheet: a sheet keeps at least one column");
      }
    });

    /* Name and remove share one line; the type selector gets its own, so a
       column reads as "what it is called" then "what it holds". */
    const head = h("div", "sheet-col-head", { children: [titleInput, drop] });
    cell.append(head, typeSelect);
    cell.setAttribute("data-column-index", String(columnIndex));
    return cell;
  }

  function makeRowHeader(row, rowIndex) {
    const rowId = row.id;
    const cell = h("th", "sheet-row-head", { attrs: { "data-role": "sheet-row" } });
    cell.append(h("span", "sheet-row-index", { text: String(rowIndex + 1) }));
    const drop = h("button", "sheet-drop", {
      attrs: { type: "button", title: "remove row" }, text: "\u00d7",
    });
    drop.addEventListener("click", () => {
      removeSheetRow(card.doc, rowId);
      paint();
      commit();
    });
    cell.append(drop);
    return cell;
  }

  function paint() {
    /* Normalise ONCE for the whole grid and paint from that snapshot.
       `sheetCell(doc, ...)` normalises the document it is handed, so calling it
       per cell made a paint cost O(cells x document) -- 2400 cells took ~2 s,
       and a large sheet could freeze the board inside a single paint.  The
       controls read their values out of this snapshot; every write resolves the
       live document by id (see `makeCellControl`). */
    const doc = card.doc;
    const sheet = normaliseSheet(doc);
    thead.textContent = "";
    tbody.textContent = "";

    const headRow = h("tr", "sheet-head-row");
    headRow.append(h("th", "sheet-corner", { attrs: { "data-role": "sheet-corner" } }));
    sheet.columns.forEach((column, columnIndex) => {
      headRow.append(makeColumnHeader(column, columnIndex));
    });
    thead.append(headRow);

    sheet.rows.forEach((row, rowIndex) => {
      const tr = h("tr", "sheet-row", { attrs: { "data-row-id": row.id } });
      tr.append(makeRowHeader(row, rowIndex));
      sheet.columns.forEach((column, columnIndex) => {
        const td = h("td", `sheet-cell is-${column.type}`);
        td.append(makeCellControl(row, column, rowIndex, columnIndex));
        tr.append(td);
      });
      tbody.append(tr);
    });

    if (lastFocus !== null) {
      const wanted = lastFocus;
      lastFocus = null;
      focusCell(wanted);
    }
  }

  addRowButton.addEventListener("click", () => {
    addSheetRow(card.doc);
    paint();
    commit();
  });
  addColumnButton.addEventListener("click", () => {
    addSheetColumn(card.doc);
    paint();
    commit();
  });
  tsvButton.addEventListener("click", () => {
    const tsv = sheetToTSV(card.doc);
    const clipboard = typeof navigator === "object" && navigator !== null ? navigator.clipboard : null;
    if (clipboard !== null && clipboard !== undefined && typeof clipboard.writeText === "function") {
      clipboard.writeText(tsv).then(
        () => app.log("info", `sheet ${card.id}: ${normaliseSheet(card.doc).rows.length} rows copied as TSV`),
        () => {
          app.log("info", "sheet TSV:");
          for (const line of tsv.split("\n")) {
            if (line !== "") {
              app.log("info", line);
            }
          }
        },
      );
      return;
    }
    app.log("info", "sheet TSV:");
    for (const line of tsv.split("\n")) {
      if (line !== "") {
        app.log("info", line);
      }
    }
  });

  paint();
  updateStatus();

  return {
    el: shell.el,
    handle: {
      kind: "sheet",
      repaint: paint,
      focus() {
        focusCell({ row: 0, column: 0 });
      },
    },
    destroy() {},
  };
}

/* -------------------- story -------------------- */
