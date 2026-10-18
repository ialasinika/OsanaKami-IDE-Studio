/**
 * cards/card-story.mjs -- the story card: dialogue, translation tables, choices.
 *
 * Part of `cards.mjs`, which re-exports this file; see that file's header for
 * why the card layer is split the way it is.
 */
import {
  lineIdOf,
  parseStory,
  serializeStory,
  storyAbout,
  storyLines,
  storyNodes,
} from "../story.mjs";
import { lockOf, parseCsv, rowFor, rowState, rowsById, serializeCsv, setColumn } from "../storycsv.mjs";
import { parseYsls, yslsAbout, yslsSignature } from "../ysls.mjs";
import { readTextFile, readTextInChunks, writeTextFile, writeTextInChunks } from "./blob.mjs";
import { cardShell, h, makeStatus } from "./dom.mjs";
import {
  storyAcceptSuggestion,
  storyAddLine,
  storyEditableText,
  storyLineText,
  storyNodeAt,
  storyRowForLine,
  storySetSpeaker,
  storySetText,
  storySuggestions,
  storyWriteText,
} from "./story.mjs";
import { formatSize } from "./text.mjs";

/**
 * The dialogue card.
 *
 * Its state is the parsed `.yarn` file, not a string.  The card draws a node
 * list on one side and, for the node that is on, that node's lines: the kind,
 * the speaker, the text and the `#line:` id the game looks each one up by.
 * Editing a speaker or a text edits one span of one line, and saving writes
 * `serializeStory` of the tree the card has been holding -- so opening a story
 * and saving it untouched puts the same bytes back, which is the only reason a
 * modder can trust it with a real mod's files.
 */
export function renderStory(card, ctx) {
  const { client, app } = ctx;

  const nodeList = h("div", "story-nodes", { attrs: { "data-role": "story-nodes" } });
  const lineList = h("div", "story-lines", { attrs: { "data-role": "story-lines" } });
  const panes = h("div", "story-panes", { children: [nodeList, lineList] });
  const tools = h("div", "story-tools", { attrs: { "data-role": "story-tools" } });
  const suggestBox = h("div", "story-suggest", { attrs: { "data-role": "story-suggest" } });
  const status = makeStatus();
  const body = h("div", "card-body card-body-story", {
    children: [panes, tools, suggestBox, status],
  });
  const shell = cardShell(card, body);

  const addLineButton = h("button", "story-tool", {
    attrs: {
      type: "button", "data-role": "story-add-line",
      title: "add a line below the one that is on",
    },
    text: "+ line",
  });
  const saveButton = h("button", "story-tool", {
    attrs: {
      type: "button", "data-role": "story-save", title: "write the file back (Ctrl+S)",
    },
    text: "save",
  });
  const tableLabel = h("span", "story-table", {
    attrs: { "data-role": "story-table" },
  });
  const schemaLabel = h("span", "story-schema", {
    attrs: { "data-role": "story-schema" },
  });
  tools.append(addLineButton, saveButton, tableLabel, schemaLabel);

  const state = {
    path: typeof card.file === "string" ? card.file : "",
    baseRevision: null,
    dirty: false,
    saving: false,
    story: null,
    nodeIndex: 0,
    lineIndex: 0,
    tablePath: typeof card.table === "string" ? card.table : "",
    table: null,
    tableById: null,
    tableRevision: null,
    tableBom: false,
    tableDirty: false,
    schemaPath: typeof card.schema === "string" ? card.schema : "",
    schema: null,
    /* The line whose translation cell is open for editing, or null.  Only one
       cell at a time: the input replaces the words in the same row, and a
       repaint puts the words back. */
    translationAt: null,
    suggest: [],
    suggestAt: -1,
    suggestCaret: 0,
    suggestIndex: 0,
  };

  /** The parsed node the line list is showing, or null. */
  function activeNode() {
    return storyNodeAt(state.story, state.nodeIndex);
  }

  function updateLabel() {
    shell.label.textContent = state.path === "" ? "(no file)" : state.path;
  }

  /**
   * The status line speaks for the file, not for the card: `storyAbout` is the
   * one sentence that says how much story is open, and the dirty mark is the
   * only thing added to it.
   */
  function updateStatus(prefix = null) {
    const about = state.story === null ? "no file" : storyAbout(state.story);
    const parts = prefix === null ? [] : [prefix];
    parts.push(state.dirty ? `${about} \u00b7 unsaved in the card` : about);
    status.textContent = parts.join(" \u00b7 ");
    tableLabel.textContent = state.tablePath === ""
      ? "no translation table"
      : `${state.tablePath} \u00b7 ${state.table === null ? 0 : state.table.rows.length} rows`
        + (state.tableDirty ? " \u00b7 unsaved" : "");
    schemaLabel.textContent = state.schemaPath === ""
      ? "no command schema"
      : `${state.schemaPath} \u00b7 ${state.schema === null ? "not loaded" : yslsAbout(state.schema)}`;
    updateLabel();
  }

  function renderStatus(message) {
    status.textContent = message;
  }

  function paint() {
    paintNodes();
    paintLines();
    updateStatus();
  }

  function paintNodes() {
    nodeList.textContent = "";
    const nodes = state.story === null ? [] : storyNodes(state.story);
    if (nodes.length === 0) {
      nodeList.append(h("p", "story-empty", {
        text: state.story === null ? "no file" : "no nodes",
      }));
      return;
    }
    for (const info of nodes) {
      const meta = [`${info.lineCount} lines`];
      if (info.when !== null && info.when !== undefined && info.when !== "") {
        meta.push(`when: ${info.when}`);
      }
      const row = h("button", "story-node", {
        attrs: {
          type: "button", "data-role": "story-node", "data-node": String(info.index),
        },
        children: [
          h("span", "story-node-title", {
            text: info.title === null || info.title === undefined || info.title === ""
              ? "(untitled)"
              : info.title,
          }),
          h("span", "story-node-meta", { text: meta.join(" \u00b7 ") }),
        ],
      });
      if (info.subtitle !== null && info.subtitle !== undefined && info.subtitle !== "") {
        row.append(h("span", "story-node-tags", { text: info.subtitle }));
      }
      if (info.tags.length > 0) {
        row.append(h("span", "story-node-tags", { text: info.tags.join(" ") }));
      }
      if (info.index === state.nodeIndex) {
        row.classList.add("is-on");
      }
      row.addEventListener("click", () => {
        state.nodeIndex = info.index;
        state.lineIndex = 0;
        state.translationAt = null;
        paint();
      });
      nodeList.append(row);
    }
  }

  function paintLines() {
    /* Every input in the list is about to be replaced, so a suggestion list
       pointing at one of them is stale by the time the new rows exist. */
    clearSuggest();
    lineList.textContent = "";
    const node = activeNode();
    if (node === null) {
      lineList.append(h("p", "story-empty", { text: "no node to show" }));
      return;
    }
    const lines = storyLines(node);
    if (lines.length === 0) {
      lineList.append(h("p", "story-empty", {
        text: "this node is empty \u2014 \u201c+ line\u201d starts it",
      }));
      return;
    }
    lines.forEach((line, index) => {
      lineList.append(lineRow(line, index));
    });
  }

  /**
   * The line's translation, found by the only thing the story file and a
   * translation table share: the `#line:` id.  Null means no table is open,
   * so no column is drawn -- an empty column would only be a lie about the
   * file.  The state is `storycsv.mjs`'s word for the row, not the card's.
   */
  function translationOf(line) {
    if (state.tableById === null) {
      return null;
    }
    const id = line.id === null ? lineIdOf(line.raw) : line.id;
    if (id === null) {
      return null;
    }
    const row = state.tableById.get(`line:${id}`);
    return {
      text: row === undefined ? "" : row.text,
      state: rowState({ text: storyLineText(line) }, row),
      row: row === undefined ? null : row,
    };
  }

  /**
   * Change one line's translation, in the table the card holds.
   *
   * The words are written to the row's `text` column through `setColumn`, which
   * keeps `fields` (what `serializeCsv` writes) in step, so only that one column
   * of that one row changes.  The `lock` column is rewritten to the hash of the
   * source line as it is now: the lock is the source text a translation was made
   * from, so a translation typed here claims the line as it stands -- that is
   * what turns a `stale` row back into `ok` instead of leaving it stale forever.
   *
   * A line whose row is missing (the table was exported before the line existed)
   * gets the row `storyRowForLine` builds for a new line, with the same columns
   * the game writes; without that there is nothing for `setColumn` to change.
   *
   * Nothing is written to disk here: `save` writes the table once, and only when
   * the card changed it.
   */
  function editTranslation(line, index, value) {
    if (state.table === null || state.tablePath === "") {
      return null;
    }
    const id = line.id === null ? lineIdOf(line.raw) : line.id;
    if (id === null) {
      return null;
    }
    let row = state.tableById.get(`line:${id}`);
    if (row === undefined) {
      state.lineIndex = index;
      const built = storyRowForLine(state.story, state.nodeIndex, index, state.table);
      if (built === null) {
        return null;
      }
      row = rowFor(built);
      state.table.rows.push(row);
      app.log("info", `${state.tablePath}: a row for ${row.id} is waiting to be saved`);
    }
    setColumn(row, "text", value);
    setColumn(row, "lock", lockOf(storyLineText(line)));
    state.tableById = rowsById(state.table);
    state.tableDirty = true;
    app.boardTouched(true);
    updateStatus();
    return row;
  }

  /** One body line, drawn as the editor the file is edited in. */
  function lineRow(line, index) {
    const row = h("div", `story-line story-line-${line.kind}`, {
      attrs: {
        "data-role": "story-line", "data-line": String(index), "data-kind": line.kind,
      },
    });
    if (index === state.lineIndex) {
      row.classList.add("is-on");
    }
    row.append(h("span", "story-kind", { text: line.kind }));

    if (line.kind === "dialogue") {
      const speaker = h("input", "story-speaker", {
        attrs: {
          type: "text", value: line.speaker === null ? "" : line.speaker,
          spellcheck: "false", autocomplete: "off",
          "data-role": "story-speaker", "aria-label": `speaker of line ${index + 1}`,
        },
      });
      const text = h("input", "story-text", {
        attrs: {
          type: "text", value: line.text === null ? "" : line.text,
          spellcheck: "false", autocomplete: "off",
          "data-role": "story-text", "aria-label": `text of line ${index + 1}`,
        },
      });
      /* The card rewrites the model as the words arrive but never repaints the
         row: the input being typed in is the one element that must survive the
         keystroke.  Ids cannot move here, so there is nothing a repaint would
         show that the row does not already say. */
      speaker.addEventListener("input", () => {
        storySetSpeaker(state.story, state.nodeIndex, index, speaker.value);
        markEdited(index);
      });
      text.addEventListener("input", () => {
        storySetText(state.story, state.nodeIndex, index, text.value);
        markEdited(index);
      });
      stopTypingKeys(speaker);
      stopTypingKeys(text);
      suggestKeys(text, index);
      row.append(speaker, h("span", "story-colon", { text: ":" }), text);
    } else if (line.kind === "option") {
      row.append(h("span", "story-option", { text: line.raw.trim() }));
    } else if (line.kind === "command") {
      /* A command is the one non-dialogue line an author types, so it is the one
         that is editable: `<<` is where the schema's completion belongs.  The
         indent is the file's, so it is not in the field -- writing it back with
         the text is what would move the line. */
      const command = h("input", "story-command", {
        attrs: {
          type: "text", value: storyEditableText(line),
          spellcheck: "false", autocomplete: "off",
          "data-role": "story-command", "aria-label": `command of line ${index + 1}`,
        },
      });
      command.addEventListener("input", () => {
        storyWriteText(state.story, state.nodeIndex, index, line, command.value);
        markEdited(index);
      });
      stopTypingKeys(command);
      suggestKeys(command, index);
      row.append(command);
    } else if (line.kind !== "blank") {
      /* A comment, a lone tag run or a line no rule fits: shown as it is, so
         the file is never hiding a line from the person editing it. */
      row.append(h("span", "story-raw", { text: line.raw }));
    }

    /* Every tag the file wrote, so nothing on the line is hidden from the
       person editing it.  The id is the one exception: it gets its own badge,
       and the parser does not always recognise it as a tag. */
    const tags = line.tags.filter((tag) => !tag.startsWith("#line:"));
    if (tags.length > 0) {
      row.append(h("span", "story-tags", { text: tags.join(" ") }));
    }
    const id = line.id === null ? lineIdOf(line.raw) : line.id;
    if (id !== null) {
      row.append(h("span", "story-id", { text: `#line:${id}` }));
    }
    const translation = translationOf(line);
    if (translation !== null) {
      if (state.translationAt === index) {
        /* The cell is open for editing: an input in the same row, holding the
           table's words, so the words are changed where they are shown. */
        const cell = h("input", "story-translation-input", {
          attrs: {
            type: "text",
            value: translation.row === null ? "" : translation.row.text,
            placeholder: storyLineText(line),
            spellcheck: "false", autocomplete: "off",
            "data-role": "story-translation-input", "data-state": translation.state,
            "aria-label": `translation of line ${index + 1}`,
          },
        });
        cell.addEventListener("input", () => {
          editTranslation(line, index, cell.value);
        });
        cell.addEventListener("keydown", (event) => {
          if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "s") {
            event.preventDefault();
            save();
            return;
          }
          event.stopPropagation();
          if (event.key === "Enter" || event.key === "Escape") {
            state.translationAt = null;
            paint();
          }
        });
        cell.addEventListener("blur", () => {
          if (state.translationAt === index) {
            state.translationAt = null;
            paint();
          }
        });
        row.append(cell);
      } else {
        const cell = h("span", `story-translation is-${translation.state}`, {
          attrs: {
            "data-role": "story-translation", "data-state": translation.state,
            title: `translation: ${translation.state} \u2014 click to edit`,
          },
          text: translation.text === "" ? translation.state : translation.text,
        });
        cell.addEventListener("click", (event) => {
          /* The row's own click would put the caret in the line's text input;
             the translation cell is the thing that was clicked. */
          event.stopPropagation();
          state.lineIndex = index;
          state.translationAt = index;
          paint();
          focusTranslation();
        });
        row.append(cell);
      }
    }
    if (line.comment !== null) {
      row.append(h("span", "story-comment", { text: `// ${line.comment}` }));
    }
    row.addEventListener("click", (event) => {
      state.lineIndex = index;
      markSelection();
      if (!(event.target instanceof HTMLInputElement)) {
        focusLine(index);
      }
    });
    return row;
  }

  /** Move the "on" line without rebuilding the list the inputs live in. */
  function markSelection() {
    for (const row of lineList.querySelectorAll('[data-role="story-line"]')) {
      const at = Number(row.getAttribute("data-line"));
      row.classList.toggle("is-on", at === state.lineIndex);
    }
  }

  function focusLine(index, caret = null) {
    const row = lineList.querySelector(`[data-line="${index}"]`);
    if (row === null) {
      return;
    }
    const target = row.querySelector('[data-role="story-command"]')
      || row.querySelector('[data-role="story-text"]')
      || row.querySelector('[data-role="story-speaker"]');
    if (target !== null) {
      target.focus();
      if (typeof target.select === "function") {
        target.select();
      }
      if (Number.isInteger(caret)) {
        target.selectionStart = caret;
        target.selectionEnd = caret;
      }
    }
  }

  /** Put the caret in the translation cell the row list has just drawn. */
  function focusTranslation() {
    const cell = lineList.querySelector('[data-role="story-translation-input"]');
    if (cell === null) {
      return;
    }
    cell.focus();
    if (typeof cell.select === "function") {
      cell.select();
    }
  }

  /**
   * The schema's completion, as the caret moves.
   *
   * A card that offered a list while somebody typed prose would be worse than a
   * card that offered none, so the only thing that can open the list is a caret
   * inside a `<<...>>` name.  Everything the list shows comes from the mod's own
   * `.ysls.json`; nothing here knows a command's name.
   */
  function refreshSuggest(index, control) {
    const node = activeNode();
    const line = node === null ? undefined : storyLines(node)[index];
    if (line === undefined || state.schema === null) {
      return clearSuggest();
    }
    const caret = typeof control.selectionStart === "number"
      ? control.selectionStart
      : storyEditableText(line).length;
    const found = storySuggestions(line, caret, state.schema);
    state.suggest = found.items;
    state.suggestAt = index;
    state.suggestCaret = caret;
    state.suggestIndex = 0;
    paintSuggest();
    return found.items;
  }

  function clearSuggest() {
    state.suggest = [];
    state.suggestAt = -1;
    paintSuggest();
    return [];
  }

  function paintSuggest() {
    suggestBox.textContent = "";
    state.suggest.forEach((entry, index) => {
      const item = h("button", `story-suggest-item${index === state.suggestIndex ? " is-current" : ""}`, {
        attrs: {
          type: "button", "data-role": "story-suggest-item",
          "data-command": entry.name, title: yslsSignature(entry),
        },
        text: yslsSignature(entry),
      });
      /* The button takes the click before the input's own blur can close the
         list, because the list is only rebuilt by a keystroke or a caret. */
      item.addEventListener("mousedown", (event) => {
        event.preventDefault();
      });
      item.addEventListener("click", () => {
        acceptSuggest(entry.name);
      });
      suggestBox.append(item);
    });
  }

  /** Take one suggestion: rewrite the line, move the caret past it, repaint. */
  function acceptSuggest(name) {
    const node = activeNode();
    const line = node === null ? undefined : storyLines(node)[state.suggestAt];
    if (line === undefined || typeof name !== "string" || name === "") {
      return;
    }
    const accepted = storyAcceptSuggestion(line, state.suggestCaret, name);
    if (accepted.text === storyEditableText(line)) {
      return;
    }
    storyWriteText(state.story, state.nodeIndex, state.suggestAt, line, accepted.text);
    const at = state.suggestAt;
    state.dirty = true;
    app.boardTouched(true);
    state.lineIndex = at;
    state.suggest = [];
    paintSuggest();
    paint();
    focusLine(at, accepted.caret);
  }

  /**
   * The keys the list owns while it is open.  Tab and Enter take the current
   * one, the arrows move, Escape closes; everything else is the author's.
   */
  function suggestKeys(control, index) {
    const move = (event) => {
      const count = state.suggest.length;
      if (count === 0) {
        return;
      }
      event.preventDefault();
      const step = event.key === "ArrowDown" ? 1 : -1;
      state.suggestIndex = (state.suggestIndex + step + count) % count;
      paintSuggest();
    };
    const take = (event) => {
      if (state.suggest.length === 0) {
        return;
      }
      const current = state.suggest[state.suggestIndex];
      if (current === undefined) {
        return;
      }
      event.preventDefault();
      acceptSuggest(current.name);
    };
    control.addEventListener("keydown", (event) => {
      if (event.key === "Tab" || event.key === "Enter") {
        take(event);
        return;
      }
      if (event.key === "ArrowDown" || event.key === "ArrowUp") {
        move(event);
        return;
      }
      if (event.key === "Escape" && state.suggest.length > 0) {
        clearSuggest();
      }
    });
    const typed = (event) => {
      if (["Tab", "Enter", "ArrowDown", "ArrowUp", "Escape"].includes(event.key)) {
        return;
      }
      refreshSuggest(index, control);
    };
    control.addEventListener("input", () => refreshSuggest(index, control));
    control.addEventListener("keyup", typed);
    control.addEventListener("click", () => refreshSuggest(index, control));
  }

  function markEdited(index) {
    state.lineIndex = index;
    state.dirty = true;
    app.boardTouched(true);
    updateStatus();
  }

  /* The board listens for keys on the document -- delete, undo, the command
     line's own Enter -- and a caret in a line is not the board. */
  function stopTypingKeys(control) {
    control.addEventListener("keydown", (event) => {
      if (event.key === "Escape") {
        control.blur();
      }
      if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "s") {
        event.preventDefault();
        save();
        return;
      }
      event.stopPropagation();
    });
  }

  /**
   * A line the story gained is a line the table owes a row.
   *
   * The id the parser just minted is exactly what the game will look the line
   * up by, so writing the row here is what keeps the two files agreeing.  The
   * row is not written to disk here: `save` writes both files, and only when
   * the card is asked to.
   */
  function appendTableRow() {
    if (state.table === null) {
      return false;
    }
    const row = storyRowForLine(state.story, state.nodeIndex, state.lineIndex, state.table);
    if (row === null) {
      return false;
    }
    state.table.rows.push(rowFor(row));
    state.tableById = rowsById(state.table);
    state.tableDirty = true;
    app.log("info", `${state.tablePath}: a row for ${row.id} is waiting to be saved`);
    return true;
  }

  function addLine() {
    if (activeNode() === null) {
      app.log("warn", "story: this card has no node to add a line to");
      return;
    }
    const index = storyAddLine(state.story, state.nodeIndex, state.lineIndex + 1);
    if (index < 0) {
      return;
    }
    /* The parser decides what the line is -- kind, tags, id -- so the card
       re-reads its own text instead of inventing a second entry shape. */
    state.story = parseStory(serializeStory(state.story));
    state.lineIndex = index;
    state.dirty = true;
    app.boardTouched(true);
    appendTableRow();
    paint();
    focusLine(index);
  }

  /**
   * The table is written only when the card put a row in it -- never because it
   * was read.  The story is already on disk by the time this runs, so a failure
   * here is said out loud rather than turned into a failed save.
   *
   * The bytes go through a `file.blob*` write session for the same reason the
   * reading does: a table of megabytes does not fit in one `file.write` frame,
   * and the kernel publishes the new file only when the commit's own total
   * matches what was appended.  The session's base revision is the one the read
   * session reported, so a file that changed under the card is refused at the
   * open, before a byte of the card's rows is on disk.
   */
  async function saveTable() {
    if (state.table === null || state.tablePath === "" || !state.tableDirty) {
      return true;
    }
    const text = serializeCsv(state.table);
    try {
      const written = await writeTextInChunks(client, state.tablePath, text, {
        baseRevision: state.tableRevision === null ? undefined : state.tableRevision,
        bom: state.tableBom,
      });
      state.tableRevision = written.revision;
      state.tableDirty = false;
      app.log("info", `saved ${state.tablePath} (rev ${written.revision}) \u2014 the table has the new row`);
      return true;
    } catch (err) {
      renderStatus(`the story was saved \u00b7 ${state.tablePath} was not`);
      app.log("error",
        `the story was saved but ${state.tablePath} was not: ` +
        `${err.message} \u2014 save the table again, or the row and the line disagree`);
      return false;
    }
  }

  async function load(path, options = {}) {
    const confirmDiscard = options.confirmDiscard !== false;
    if (state.dirty && confirmDiscard && !app.confirmDiscard(state.path)) {
      return false;
    }
    shell.label.textContent = path;
    let result;
    try {
      /* A `.yarn` is usually a few kilobytes, so `file.read` is the call that
         answers with the line endings in one go.  The 4 MiB refusal is not a
         failed load: the frame reader takes over and assembles the same text,
         which is the read that made a 5 MB table openable.  The mark is put
         back in front of the text because the story carries it as a fact of its
         own (`story.bom`) and a save writes it back from there. */
      result = await readTextFile(client, path);
      if (result.chunked === true && result.bom === true) {
        result = { ...result, text: "\ufeff" + result.text };
      }
    } catch (err) {
      renderStatus(`could not read ${path}`);
      app.log("error", `file.read ${path}: ${err.message}`);
      return false;
    }
    state.path = path;
    card.file = path;
    state.baseRevision = result.revision;
    state.story = parseStory(result.text);
    state.nodeIndex = 0;
    state.lineIndex = 0;
    state.translationAt = null;
    state.dirty = false;
    paint();
    return true;
  }

  /**
   * The translation table is a second file, and it is read through a
   * `file.blob*` session because of its size, not in one piece: the game's own
   * tables are megabytes, and one whole-file read of one is the read that never
   * came back.  The session hands over one mebibyte frame at a time and the
   * assembled text goes to the same parser as before, so a small table parses to
   * exactly the rows it always did.  The status line says how far it has got,
   * and a read that fails is said out loud and leaves no table behind -- a table
   * that is half the file would be the card lying about the mod.
   */
  async function loadTable(path) {
    let read;
    try {
      read = await readTextInChunks(client, path, {
        onProgress: (bytesRead, total) => {
          renderStatus(bytesRead === 0 || total === 0
            ? "reading table\u2026"
            : `reading table\u2026 ${formatSize(bytesRead)}/${formatSize(total)}`);
        },
      });
    } catch (err) {
      renderStatus(`could not read ${path}: ${err.message}`);
      app.log("error", `file.blobRead ${path}: ${err.message}`);
      return false;
    }
    state.tablePath = path;
    state.table = parseCsv(read.text);
    state.tableById = rowsById(state.table);
    state.tableRevision = read.revision;
    state.tableBom = read.bom === true;
    state.tableDirty = false;
    state.translationAt = null;
    paint();
    return true;
  }

  /**
   * The mod's own command schema, read whole in one `file.read` -- a schema is a
   * few kilobytes, and the table's range reading is about the table's size.
   *
   * A `.ysls.json` is what tells a modder's editor which commands exist, so the
   * card reads the file rather than carrying a list of its own: a mod that adds a
   * command gets completion for it the moment its schema is regenerated.  A file
   * that is not a schema is refused here, while the mistake is still a sentence.
   */
  async function loadSchema(path) {
    let result;
    try {
      result = await client.call("file.read", { path });
    } catch (err) {
      renderStatus(`could not read ${path}`);
      app.log("error", `file.read ${path}: ${err.message}`);
      return false;
    }
    const parsed = parseYsls(result.text);
    if (parsed.error !== "") {
      renderStatus(`could not read ${path}`);
      app.log("error", `${path}: ${parsed.error} \u2014 a command schema is a .ysls.json`);
      return false;
    }
    state.schemaPath = path;
    state.schema = parsed;
    card.schema = path;
    paint();
    return true;
  }

  async function save() {
    if (state.path === "" || state.story === null) {
      app.log("warn",
        "story: nothing to save \u2014 open a .yarn file with `story <path>`");
      return false;
    }
    if (state.saving) {
      return false;
    }
    state.saving = true;
    renderStatus("saving\u2026");
    try {
      /* A story that was read in frames goes back in frames: `file.write`
         refuses the same 4 MiB one call.  The serialized text already carries
         the BOM as a character (`serializeStory` puts it back from
         `story.bom`), so there is no separate mark to pass. */
      const result = await writeTextFile(client, state.path, serializeStory(state.story), {
        baseRevision: state.baseRevision,
      });
      state.saving = false;
      state.baseRevision = result.revision;
      state.dirty = false;
      app.log("info", `saved ${state.path} (rev ${result.revision})`);
      /* The table may hold the translation cell's edit, or a row for a line the
         story gained.  The status line is updated after it so it can say the
         table's own state ("unsaved") when the table write did not happen. */
      if (await saveTable()) {
        updateStatus(result.chunked === true ? "saved in frames" : "saved");
      }
      return true;
    } catch (err) {
      state.saving = false;
      if (client.isStaleRevision(err)) {
        const current = err.data && err.data.current_revision !== undefined
          ? err.data.current_revision
          : null;
        renderStatus(`stale \u2014 the file changed on disk (rev ${current})`);
        const choice = await app.resolveStale({
          path: state.path, current, cardId: card.id,
        });
        if (choice === "reload") {
          const reloaded = await load(state.path, { confirmDiscard: false });
          /* The table is locked to the revision it was read at, and the disk has
             moved on, so the rows are read again before the next save -- the
             card says what the file says, or it says nothing. */
          if (reloaded && state.tablePath !== "") {
            await loadTable(state.tablePath);
          }
          return reloaded;
        }
        if (choice === "overwrite") {
          state.baseRevision = current;
          return save();
        }
        app.log("warn", `${state.path} not saved; your lines are still in the card`);
        return false;
      }
      renderStatus(`could not write ${state.path}`);
      app.log("error", `file.write ${state.path}: ${err.message}`);
      return false;
    }
  }

  addLineButton.addEventListener("click", () => addLine());
  saveButton.addEventListener("click", () => save());

  if (state.path !== "") {
    load(state.path, { confirmDiscard: false }).then((opened) => {
      if (opened && state.tablePath !== "") {
        loadTable(state.tablePath);
      }
      if (opened && state.schemaPath !== "") {
        loadSchema(state.schemaPath);
      }
    });
  } else {
    paint();
    renderStatus("no file yet \u2014 open one with `story <path>`");
  }

  return {
    el: shell.el,
    handle: {
      kind: "story",
      save,
      load,
      loadTable,
      loadSchema,
      repaint: paint,
      get path() {
        return state.path;
      },
      get tablePath() {
        return state.tablePath;
      },
      get schemaPath() {
        return state.schemaPath;
      },
      get schema() {
        return state.schema;
      },
      /** The suggestions the card would offer a caret in one of its lines. */
      suggestAt(lineIndex, caret) {
        const node = activeNode();
        const line = node === null ? undefined : storyLines(node)[lineIndex];
        return line === undefined || state.schema === null
          ? []
          : storySuggestions(line, caret, state.schema).items;
      },
      get dirty() {
        return state.dirty;
      },
      get revision() {
        return state.baseRevision;
      },
      hasPath(path) {
        return state.path !== "" && state.path === path;
      },
      /** What a save would write -- the card's own text, for a caller or a test. */
      text() {
        return state.story === null ? "" : serializeStory(state.story);
      },
      focus() {
        focusLine(state.lineIndex);
      },
    },
    destroy() {},
  };
}

/* ------------------------------------------------------------------ */
/* pixel                                                               */
/* ------------------------------------------------------------------ */

/*
 * A drawing surface for a .png, and the one thing it must never do is put
 * pixels in the board document.  The board stores `{file, width, height,
 * palette}` and nothing else: the pixels live in a `Uint8Array` in this card
 * and on disk, so a board save stays a small JSON document and a drawing that
 * was never saved is not silently resurrected by an undo of a card move -- see
 * the undo note in `main.mjs`.  `shell/web/pixelpng.mjs` is the whole codec;
 * this card owns no PNG knowledge at all.
 */
