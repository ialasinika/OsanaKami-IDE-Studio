/**
 * cards/card-editor.mjs -- the text editor card: token colours under a transparent textarea.
 *
 * Part of `cards.mjs`, which re-exports this file; see that file's header for
 * why the card layer is split the way it is.
 */
import { cardShell, h, makeStatus, paintTokens } from "./dom.mjs";
import { readTextFile, writeTextFile } from "./blob.mjs";
import {
  applyCompletion,
  completionState,
  findMatches,
  formatSize,
  hoverLine,
  indentAfterEnter,
  indentSelection,
  isYarnPath,
  lineColumn,
  lineStartOffset,
  pointerOffset,
  replaceAllMatches,
  replaceMatchAt,
  stepCompletion,
} from "./text.mjs";

export function renderEditor(card, ctx) {
  const { client, app } = ctx;

  const pre = h("pre", "ed-view", { attrs: { "aria-hidden": "true" } });
  const area = h("textarea", "ed-input", {
    attrs: { spellcheck: "false", autocomplete: "off", wrap: "off" },
  });
  const scroller = h("div", "ed-scroll", { children: [pre] });
  /*
   * Line numbers, on by default: the first thing anyone asks about a diagnostic
   * is which line it is on, and that answer should not cost a click.  A click
   * on the gutter turns them off for the sessions where the columns matter
   * more.  The numbers are one text node in a <pre> carrying the code's own
   * font, line height and top padding, so line N lands on line N with no
   * per-row layout at all -- only the textarea's vertical scroll is mirrored.
   */
  const gutterNumbers = h("pre", "ed-gutter-numbers", { attrs: { "aria-hidden": "true" } });
  const gutter = h("div", "ed-gutter", {
    attrs: {
      "data-role": "gutter", "data-on": "on", "data-lines": "1", "aria-hidden": "true",
      title: "line numbers \u2014 click to hide",
    },
    children: [gutterNumbers],
  });
  const surface = h("div", "ed-surface has-gutter", { children: [gutter, scroller, area] });

  /* The find bar.  It is part of the card, not a browser dialog: everything
     here has to keep working offline, and a modal would swallow the caret. */
  const findQuery = h("input", "ed-find-input", {
    attrs: {
      type: "text", placeholder: "find", spellcheck: "false", autocomplete: "off",
      "data-role": "find-query", "aria-label": "find in this file",
    },
  });
  const findCount = h("span", "ed-find-count", {
    attrs: { "data-role": "find-count", "aria-live": "polite" },
  });
  const findPrev = h("button", "ed-find-btn", {
    text: "\u2191",
    attrs: { type: "button", title: "previous match (shift+enter)", "data-role": "find-prev" },
  });
  const findNext = h("button", "ed-find-btn", {
    text: "\u2193",
    attrs: { type: "button", title: "next match (enter)", "data-role": "find-next" },
  });
  const findClose = h("button", "ed-find-btn", {
    text: "\u00d7",
    attrs: { type: "button", title: "close the find bar (esc)", "data-role": "find-close" },
  });
  const replaceText = h("input", "ed-find-input", {
    attrs: {
      type: "text", placeholder: "replace with", spellcheck: "false", autocomplete: "off",
      "data-role": "replace-text", "aria-label": "replace with",
    },
  });
  const replaceOne = h("button", "ed-find-btn ed-find-wide", {
    text: "replace",
    attrs: { type: "button", title: "replace this match", "data-role": "replace-one" },
  });
  const replaceAll = h("button", "ed-find-btn ed-find-wide", {
    text: "all",
    attrs: { type: "button", title: "replace every match", "data-role": "replace-all" },
  });
  const findBar = h("div", "ed-find", {
    attrs: { hidden: "", "data-role": "find-bar" },
    children: [
      h("div", "ed-find-row", { children: [findQuery, findCount, findPrev, findNext, findClose] }),
      h("div", "ed-find-row", { children: [replaceText, replaceOne, replaceAll] }),
    ],
  });

  /*
   * The language strips.  Completion is a list at the bottom of the card rather
   * than a popup at the caret: the card is a box in a tiled document, and a
   * caret-anchored popup would have to be repositioned on every scroll, resize
   * and view switch.  A list under the code cannot be misplaced, and the same
   * list is what the keyboard moves through.  Hover is one line under it.
   *
   * Both are decoration: a card that cannot reach the mod layer has no menu and
   * still edits, saves and closes like any other.
   */
  const completeList = h("ul", "ed-complete-list", {
    attrs: { "data-role": "completion-list", "aria-label": "completion candidates" },
  });
  const completeBar = h("div", "ed-complete", {
    attrs: { hidden: "", "data-role": "completion-bar" },
    children: [completeList],
  });
  const hoverBar = h("div", "ed-hover", {
    attrs: { hidden: "", "data-role": "hover-bar", "aria-live": "polite" },
  });

  const status = makeStatus();
  /* Order is the layout the brief asks for: the code, the menu between the code
     and the status line, the status line, then the hover line at the very
     bottom of the card. */
  const body = h("div", "card-body card-body-editor", {
    children: [findBar, surface, completeBar, status, hoverBar],
  });

  const state = {
    path: typeof card.file === "string" ? card.file : "",
    baseRevision: null,
    dirty: false,
    saving: false,
    // How the file arrived, because the way back depends on it: a file read
    // whole has its BOM inside the text, a file read in frames has it reported
    // as a flag and removed, and a file too large for `file.write` must be
    // written through a session.  The editor remembers both facts for the save.
    chunked: false,
    bom: false,
    tokens: [],
    timer: null,
    tokenSeq: 0,
    findOpen: false,
    hits: [],
    hitIndex: -1,
    // The line-number gutter: on unless the reader hid it, and the line count
    // the numbers were painted for.
    gutterOn: true,
    gutterLines: 0,
    // The language service: the open menu (a completionState() result, or
    // null), where the keyboard stands in it, and the debounce timers.  The
    // sequence numbers are how a slow answer that arrived after the user typed
    // on is thrown away instead of painted.
    complete: null,
    completeIndex: 0,
    completeSeq: 0,
    completeTimer: null,
    hoverSeq: 0,
    hoverTimer: null,
    // Set when the mod layer answered with an error once.  A shell built
    // without the layer must not be asked on every keystroke for the rest of
    // the session; completion is simply off.
    langOff: false,
    // Whether `area` holds a file that was read successfully.  A card is made
    // before its read answers, so this is what tells `reveal()` there is text
    // to stand on.
    loaded: false,
  };

  const shell = cardShell(card, body);
  shell.label.textContent = state.path || "(no file)";
  shell.label.title = state.path;

  function renderStatus(message) {
    const bits = [];
    if (state.path === "") {
      bits.push("no file — type `open <path>` below");
    } else {
      bits.push(state.path);
      if (state.dirty) {
        bits.push("modified");
      } else if (state.baseRevision !== null) {
        bits.push(`rev ${state.baseRevision}`);
      }
      if (state.saving) {
        bits.push("saving…");
      }
    }
    if (message) {
      bits.push(message);
    }
    status.textContent = bits.join(" · ");
  }

  /**
   * The numbers are one text node.  A file's line count only changes when a
   * newline is added or removed, so the string is rebuilt then and not on every
   * keystroke; the gutter never lays out a row per line.
   */
  function paintGutter() {
    const lines = area.value === "" ? 1 : area.value.split("\n").length;
    if (state.gutterLines !== lines) {
      let text = "1";
      for (let n = 2; n <= lines; n++) {
        text += `\n${n}`;
      }
      gutterNumbers.textContent = text;
      state.gutterLines = lines;
    }
    gutter.dataset.lines = String(lines);
  }

  function showGutter(on) {
    state.gutterOn = on === true;
    gutter.dataset.on = state.gutterOn ? "on" : "off";
    // Hiding the gutter hands its columns back to the code, so the scroller and
    // the textarea move left again -- they are inset behind it, one width.
    surface.classList.toggle("has-gutter", state.gutterOn);
    surface.classList.toggle("no-gutter", !state.gutterOn);
    gutter.title = state.gutterOn ? "line numbers \u2014 click to hide" : "line numbers \u2014 click to show";
  }

  gutter.addEventListener("mousedown", (event) => {
    event.preventDefault();
    showGutter(!state.gutterOn);
    app.log("info", `line numbers ${state.gutterOn ? "on" : "off"}`);
  });

  function repaint() {
    paintTokens(pre, area.value, state.tokens, state.hits, state.hitIndex);
    paintGutter();
    syncScroll();
  }

  /**
   * Bookkeeping for the edits this card makes itself (indent, auto-indent,
   * replace): the same work the `input` event does, plus the selection the
   * operation asked to restore.
   */
  function edited(message, selectionStart, selectionEnd) {
    if (selectionStart !== undefined) {
      area.setSelectionRange(selectionStart, selectionEnd === undefined ? selectionStart : selectionEnd);
    }
    state.dirty = true;
    renderStatus(message);
    scheduleTokenize();
    app.boardTouched(true);
    syncFind({ reveal: false });
  }

  /**
   * Insert text through the browser's own editing command, if it will.
   *
   * Writing `.value` directly throws the textarea's undo stack away, which
   * would mean that one press of Tab costs the user every earlier Ctrl+Z in
   * that card.  `document.execCommand("insertText")` is deprecated, but it is
   * the only remaining way to make the edit an undoable user edit, and this
   * window only ever runs on Chromium.  Returns false when the command is
   * missing or refused, so the caller can fall back to a plain write.
   */
  function typeIn(text) {
    try {
      if (typeof document.execCommand === "function") {
        return document.execCommand("insertText", false, text) === true;
      }
    } catch {
      // Nothing to do here: the fallback below keeps the buffer correct.
    }
    return false;
  }

  /**
   * Replace the whole buffer and restore the selection the operation asked for.
   * The text goes in as one user edit when the browser cooperates, so a single
   * Ctrl+Z takes the whole operation back rather than clearing the undo stack.
   *
   * @returns {boolean} whether the browser's own insert path was used
   */
  function rewrite(nextText, selectionStart, selectionEnd, message) {
    let typed = false;
    if (nextText !== area.value) {
      area.select();
      typed = typeIn(nextText);
      if (!typed) {
        area.value = nextText;
      }
    }
    edited(message, selectionStart, selectionEnd);
    return typed;
  }

  function syncScroll() {
    scroller.scrollTop = area.scrollTop;
    scroller.scrollLeft = area.scrollLeft;
    // The numbers ride the same offset.  A transform keeps the gutter out of
    // the layout, so a scroll costs one compositor step and no reflow.
    gutterNumbers.style.transform = `translateY(${-area.scrollTop}px)`;
  }

  area.addEventListener("scroll", syncScroll);

  /* ---- completion and hover (the Yarn language service) ---- */

  function hideHover() {
    hoverBar.hidden = true;
    hoverBar.textContent = "";
  }

  function hideComplete() {
    state.complete = null;
    state.completeIndex = 0;
    completeBar.hidden = true;
    completeBar.removeAttribute("data-kind");
    completeBar.title = "";
    completeList.textContent = "";
  }

  /** Paint the open menu, with the active row marked for the keyboard. */
  function paintComplete() {
    completeList.textContent = "";
    const current = state.complete;
    if (current === null) {
      hideComplete();
      return;
    }
    current.items.forEach((item, index) => {
      const row = h("li", "ed-complete-item", {
        attrs: { "data-index": String(index) },
        children: [
          h("span", "ed-complete-label", { text: item.label }),
          h("span", "ed-complete-insert", { text: item.insertText }),
        ],
      });
      if (item.detail !== "") {
        row.appendChild(h("span", "ed-complete-detail", { text: item.detail }));
      }
      if (index === state.completeIndex) {
        row.classList.add("is-active");
        row.setAttribute("aria-selected", "true");
      }
      /* The list must not take the caret: a click is an accept, not a focus
         change, and `preventDefault` on mousedown is what keeps the textarea
         focused through the click. */
      row.addEventListener("mousedown", (event) => { event.preventDefault(); });
      row.addEventListener("click", () => acceptIndex(index));
      completeList.appendChild(row);
    });
    completeBar.hidden = false;
    completeBar.dataset.kind = current.kind;
    completeBar.title = current.kindLabel;
    if (current.more) {
      /* The count is the honest part of the menu: 8 rows of 137 answers is
         still "137 answers", not "8". */
      completeBar.title = `${current.kindLabel} · ${current.total}`;
    }
  }

  /** Accept the row at `index`; the caret lands after the inserted text. */
  function acceptIndex(index) {
    const current = state.complete;
    if (current === null) {
      return;
    }
    /* The menu is a promise about the document and the caret it was asked
       about.  If either moved -- an arrow key, a click, a find jump, an undo --
       accepting here would put the text somewhere the author is not looking.
       Cash the promise only when it still holds; otherwise ask again about the
       caret that exists now. */
    if (area.value !== current.text || area.selectionStart !== current.caret) {
      hideComplete();
      scheduleComplete();
      return;
    }
    const item = current.items[index];
    if (item === undefined) {
      return;
    }
    const applied = applyCompletion(current, item);
    hideComplete();
    if (applied.text === area.value) {
      area.setSelectionRange(applied.caret, applied.caret);
    } else {
      rewrite(applied.text, applied.caret, applied.caret);
    }
    // After a command the caret sits in the argument slot, so ask again for
    // what belongs there.
    scheduleComplete();
  }

  async function completeNow() {
    if (state.langOff || !isYarnPath(state.path) || state.findOpen) {
      return;
    }
    const text = area.value;
    const caret = area.selectionStart;
    const seq = state.completeSeq + 1;
    state.completeSeq = seq;
    let answer = null;
    try {
      answer = await client.call("mod.complete", { text, caret, limit: 200 });
    } catch {
      // No mod layer (or an older shell): stop asking, show nothing.  This is a
      // missing feature, not an error to put in front of the author.
      state.langOff = true;
      hideComplete();
      hideHover();
      return;
    }
    if (seq !== state.completeSeq || area.value !== text || area.selectionStart !== caret) {
      return;
    }
    const next = completionState(text, caret, answer);
    state.complete = next.open ? next : null;
    state.completeIndex = 0;
    if (state.complete === null) {
      hideComplete();
      return;
    }
    paintComplete();
  }

  function scheduleComplete() {
    if (state.completeTimer !== null) {
      clearTimeout(state.completeTimer);
    }
    state.completeTimer = setTimeout(() => {
      state.completeTimer = null;
      completeNow();
    }, 160);
  }

  async function hoverNow() {
    if (state.langOff || !isYarnPath(state.path) || state.findOpen) {
      return;
    }
    const text = area.value;
    const caret = area.selectionStart;
    const seq = state.hoverSeq + 1;
    state.hoverSeq = seq;
    let answer = null;
    try {
      answer = await client.call("mod.hover", { text, caret });
    } catch {
      state.langOff = true;
      hideComplete();
      hideHover();
      return;
    }
    if (seq !== state.hoverSeq || area.value !== text || area.selectionStart !== caret) {
      return;
    }
    const line = hoverLine(answer);
    hoverBar.textContent = line;
    hoverBar.hidden = line === "";
  }

  function scheduleHover() {
    if (state.hoverTimer !== null) {
      clearTimeout(state.hoverTimer);
    }
    state.hoverTimer = setTimeout(() => {
      state.hoverTimer = null;
      hoverNow();
    }, 300);
  }

  /* ---- find and replace ---- */

  function showCount() {
    if (!state.findOpen) {
      findCount.textContent = "";
      return;
    }
    if (findQuery.value === "") {
      findCount.textContent = "";
    } else if (state.hits.length === 0) {
      findCount.textContent = "no match";
    } else {
      findCount.textContent = `${state.hitIndex + 1}/${state.hits.length}`;
    }
  }

  /** Start from the first match at or after the caret, else from the top. */
  function seedIndex() {
    if (state.hits.length === 0) {
      state.hitIndex = -1;
      return;
    }
    const caret = area.selectionStart;
    const found = state.hits.findIndex((hit) => hit.start >= caret);
    state.hitIndex = found === -1 ? 0 : found;
  }

  /**
   * Recompute the matches and repaint.  `reveal` scrolls the current one into
   * view; `seed` picks a new current match rather than keeping the old index.
   */
  function syncFind(options = {}) {
    const { reveal = true, seed = false } = options;
    state.hits = state.findOpen ? findMatches(area.value, findQuery.value) : [];
    if (state.hits.length === 0) {
      state.hitIndex = -1;
    } else if (seed) {
      seedIndex();
    } else if (state.hitIndex >= state.hits.length) {
      state.hitIndex = state.hits.length - 1;
    } else if (state.hitIndex < 0) {
      state.hitIndex = 0;
    }
    showCount();
    repaint();
    if (reveal && state.hitIndex >= 0) {
      standOnHit();
    }
  }

  /** The text node holding a string index, and the offset inside it. */
  function pointAt(target) {
    let seen = 0;
    function walk(node) {
      for (const child of node.childNodes) {
        if (child.nodeType === 3) {
          const length = child.data.length;
          if (target <= seen + length) {
            return { node: child, offset: target - seen };
          }
          seen += length;
        } else {
          const found = walk(child);
          if (found !== null) {
            return found;
          }
        }
      }
      return null;
    }
    return walk(pre);
  }

  /**
   * Scroll the current match into view.
   *
   * The measurement is taken from the same text in the `<pre>`, which shares
   * the textarea's metrics; the delta is then applied to the textarea's own
   * scroll position, which `syncScroll` mirrors back onto the `<pre>`.
   */
  function revealHit(hit) {
    const first = pointAt(hit.start);
    const last = pointAt(hit.end);
    if (first === null || last === null) {
      return;
    }
    const range = document.createRange();
    range.setStart(first.node, first.offset);
    range.setEnd(last.node, last.offset);
    const box = range.getBoundingClientRect();
    if (box.width === 0 && box.height === 0) {
      return;
    }
    const frame = surface.getBoundingClientRect();
    let dy = 0;
    let dx = 0;
    if (box.top < frame.top) {
      dy = box.top - frame.top - 6;
    } else if (box.bottom > frame.bottom) {
      dy = box.bottom - frame.bottom + 6;
    }
    if (box.left < frame.left) {
      dx = box.left - frame.left - 6;
    } else if (box.right > frame.right) {
      dx = box.right - frame.right + 6;
    }
    if (dy !== 0) {
      area.scrollTop += dy;
    }
    if (dx !== 0) {
      area.scrollLeft += dx;
    }
    syncScroll();
  }

  /** Stand on the current match: select it and bring it into view. */
  function standOnHit() {
    const hit = state.hits[state.hitIndex];
    if (hit === undefined) {
      return;
    }
    area.setSelectionRange(hit.start, hit.end);
    revealHit(hit);
  }

  /** Move to the next (or previous) match, wrapping around. */
  function stepHit(delta) {
    const count = state.hits.length;
    if (count === 0) {
      syncFind({ reveal: false, seed: true });
      return;
    }
    const base = state.hitIndex < 0 ? (delta > 0 ? -1 : 0) : state.hitIndex;
    state.hitIndex = ((base + delta) % count + count) % count;
    showCount();
    repaint();
    standOnHit();
  }

  function openFind() {
    const selected = area.value.slice(area.selectionStart, area.selectionEnd);
    if (!state.findOpen && selected !== "" && !selected.includes("\n")) {
      findQuery.value = selected;
    }
    state.findOpen = true;
    findBar.hidden = false;
    syncFind({ reveal: true, seed: true });
    findQuery.focus();
    findQuery.select();
  }

  function closeFind() {
    state.findOpen = false;
    findBar.hidden = true;
    state.hits = [];
    state.hitIndex = -1;
    showCount();
    repaint();
    area.focus();
  }

  function replaceCurrent() {
    const hit = state.hits[state.hitIndex];
    if (hit === undefined) {
      openFind();
      return;
    }
    const replacement = replaceText.value;
    const caret = hit.start + replacement.length;
    rewrite(replaceMatchAt(area.value, hit, replacement), caret, undefined, "replaced 1");
  }

  function replaceEvery() {
    const query = findQuery.value;
    const hits = findMatches(area.value, query);
    if (hits.length === 0) {
      renderStatus("nothing to replace");
      return;
    }
    const replacement = replaceText.value;
    const caret = hits[0].start + replacement.length;
    rewrite(replaceAllMatches(area.value, query, replacement).text, caret, undefined,
      `replaced ${hits.length}`);
  }

  findQuery.addEventListener("input", () => {
    syncFind({ reveal: true, seed: true });
  });
  findQuery.addEventListener("keydown", (event) => {
    event.stopPropagation();
    if (event.key === "Enter") {
      event.preventDefault();
      stepHit(event.shiftKey ? -1 : 1);
    } else if (event.key === "Escape") {
      event.preventDefault();
      closeFind();
    } else if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "f") {
      event.preventDefault();
      openFind();
    }
  });
  replaceText.addEventListener("keydown", (event) => {
    event.stopPropagation();
    if (event.key === "Enter") {
      event.preventDefault();
      replaceCurrent();
    } else if (event.key === "Escape") {
      event.preventDefault();
      closeFind();
    }
  });
  findPrev.addEventListener("click", () => stepHit(-1));
  findNext.addEventListener("click", () => stepHit(1));
  findClose.addEventListener("click", closeFind);
  replaceOne.addEventListener("click", replaceCurrent);
  replaceAll.addEventListener("click", replaceEvery);

  /**
   * Re-tokenise and repaint.
   *
   * The textarea is never rewritten, so the caret and the selection survive;
   * only the `<pre>` underneath is replaced.  A stale reply (the user typed
   * while the kernel was answering) is discarded.
   */
  async function tokenizeNow() {
    const text = area.value;
    const path = state.path;
    if (path === "") {
      state.tokens = [];
      repaint();
      return;
    }
    const seq = state.tokenSeq + 1;
    state.tokenSeq = seq;
    if (state.chunked) {
      /* A file that arrived in frames is over the frame limit by definition,
         and `lang.tokenize` is one call carrying the whole text: asking would
         put the file back on the wire the session exists to keep it off, only
         to be refused.  Colouring is decoration, so it is the thing given up. */
      state.tokens = [];
      repaint();
      return;
    }
    let tokens = [];
    try {
      const result = await client.call("lang.tokenize", { path, text });
      tokens = Array.isArray(result && result.tokens) ? result.tokens : [];
    } catch {
      // Colouring is decoration: a failing tokenizer must not disturb editing.
      tokens = [];
    }
    if (seq !== state.tokenSeq || area.value !== text) {
      return;
    }
    state.tokens = tokens;
    repaint();
  }

  function scheduleTokenize() {
    if (state.timer !== null) {
      clearTimeout(state.timer);
    }
    state.timer = setTimeout(() => {
      state.timer = null;
      tokenizeNow();
    }, 120);
  }

  /** Load (or reload) the file. Local edits are only discarded after a prompt. */
  async function load(path, options = {}) {
    const { confirmDiscard = true, status = null } = options;
    if (state.dirty && confirmDiscard && !app.confirmDiscard(state.path)) {
      return false;
    }
    state.path = path;
    card.file = path;
    state.loaded = false;
    // The strips belong to the file that was open: a new one starts with
    // nothing known, and a non-Yarn file never asks.
    hideComplete();
    hideHover();
    shell.label.textContent = path;
    shell.label.title = path;
    renderStatus("loading…");
    try {
      /* Small files arrive whole, in one call, with their line endings; a file
         over the kernel's 4 MiB frame arrives a mebibyte at a time instead,
         because `file.read` would refuse it and a translation table is a file
         the editor is expected to open too.  Either way what is left here is
         the whole text or an error -- never half a file. */
      const result = await readTextFile(client, path, {
        onProgress: (bytesRead, total) => {
          renderStatus(bytesRead === 0 || total === 0
            ? "reading…"
            : `reading… ${formatSize(bytesRead)}/${formatSize(total)}`);
        },
      });
      area.value = result.text;
      state.baseRevision = result.revision;
      state.chunked = result.chunked === true;
      state.bom = result.bom === true;
      state.dirty = false;
      state.loaded = true;
      const parts = ["loaded", state.chunked ? "in frames" : (result.eol || "lf")];
      if (Number.isFinite(result.size)) {
        parts.push(`${result.size} bytes`);
      }
      renderStatus(parts.join(" · "));
      if (status !== null) {
        // Why this load happened. "loaded · lf · 14 bytes" is the same line
        // whether the user asked for the file or the watcher re-read it, and
        // after an external change the difference is the whole story.
        renderStatus(status);
      }
      scheduleTokenize();
      return true;
    } catch (err) {
      renderStatus("could not read");
      app.log("error", `file.read ${path}: ${err.message}`);
      return false;
    }
  }

  /**
   * Stand on a place inside the text: caret there, that line in view.
   *
   * `line` is 1-based and wins over `pointer` when both are given; `pointer` is
   * the part of a diagnostic's path after its `#` (`voiceOverFiles[0]`), and
   * only its final key is looked up.  Before the file arrives there is nothing
   * to stand on, and a place that is not in the text is a no-op rather than a
   * jump to an arbitrary offset -- the caller is told which of the two
   * happened by the return value.
   */
  function reveal(options = {}) {
    if (!state.loaded) {
      return false;
    }
    const text = area.value;
    let at = -1;
    if (Number.isInteger(options.line) && options.line > 0) {
      at = lineStartOffset(text, options.line);
    } else if (typeof options.pointer === "string" && options.pointer !== "") {
      at = pointerOffset(text, options.pointer);
    }
    if (at < 0) {
      return false;
    }
    area.focus();
    area.setSelectionRange(at, at);
    /*
     * The textarea lays the text out one line box per line, so the line's share
     * of the scrollable height is the offset to ask for.  The line is measured
     * from the offset that was just chosen -- a pointer lands mid-line, and the
     * scroll still belongs to the whole line.  `syncScroll` mirrors the same
     * number into the <pre>.  A hidden card has no height to scroll; that is
     * the view's problem (a tile that is not showing), not the place's.
     */
    const { line } = lineColumn(text, at);
    const lines = text === "" ? 1 : text.split("\n").length;
    const scrollable = Math.max(0, area.scrollHeight - area.clientHeight);
    area.scrollTop = lines <= 1 ? 0 : Math.round(((line - 1) / (lines - 1)) * scrollable);
    syncScroll();
    return true;
  }

  /**
   * Write the buffer.
   *
   * `base_revision` is the revision from the last read or write.  If another
   * writer got there first the kernel answers `STALE_REVISION`; nothing is
   * overwritten and the user is asked what to do (`app.resolveStale`).
   */
  async function save() {
    if (state.path === "" || state.saving) {
      return false;
    }
    state.saving = true;
    renderStatus();
    try {
      /* The same two paths as the read.  A file that came in frames goes back
         in frames -- `file.write` would refuse its size -- and the BOM the
         frame reader reported as a flag (rather than a character of the text)
         goes back in front of it.  A small file keeps the one call it always
         used: same line-ending handling, same revision answer. */
      const result = await writeTextFile(client, state.path, area.value, {
        baseRevision: state.baseRevision,
        bom: state.bom === true,
      });
      state.baseRevision = result.revision;
      state.chunked = result.chunked === true;
      state.dirty = false;
      renderStatus(state.chunked ? "saved in frames" : "saved");
      app.log("info", `saved ${state.path} (rev ${result.revision})`);
      return true;
    } catch (err) {
      if (client.isStaleRevision(err)) {
        const current = err.data && err.data.current_revision !== undefined
          ? err.data.current_revision
          : null;
        renderStatus(`stale — the file changed on disk (rev ${current})`);
        const choice = await app.resolveStale({ path: state.path, current, cardId: card.id });
        if (choice === "reload") {
          state.saving = false;
          state.dirty = false;
          return load(state.path, { confirmDiscard: false });
        }
        if (choice === "overwrite") {
          state.baseRevision = current;
          state.saving = false;
          return save();
        }
        app.log("warn", `${state.path} not saved; your text is still in the card`);
        return false;
      }
      renderStatus("write failed");
      app.log("error", `file.write ${state.path}: ${err.message}`);
      return false;
    } finally {
      if (state.saving) {
        // Only clear it when we are really finished (the stale path re-enters).
        state.saving = false;
      }
      renderStatus();
    }
  }

  area.addEventListener("input", () => {
    state.dirty = true;
    renderStatus();
    scheduleTokenize();
    app.boardTouched(true);
    if (state.findOpen) {
      syncFind({ reveal: false });
    }
    // Typing changes both answers: the menu under the caret and the line about
    // the token under it.
    scheduleComplete();
    scheduleHover();
  });

  // The caret moves with the pointer too -- a click, a drag, a scroll.  Hover
  // follows the caret, not the pointer, so all three mean "ask again".  The
  // menu was asked about a caret the pointer just moved away from, so it closes
  // rather than offering rows for a place that is no longer under the caret.
  area.addEventListener("keyup", scheduleHover);
  area.addEventListener("click", () => {
    hideComplete();
    scheduleHover();
  });
  area.addEventListener("mouseup", () => {
    hideComplete();
    scheduleHover();
  });
  // Losing focus closes the menu: a candidate clicked elsewhere is not accepted.
  area.addEventListener("blur", hideComplete);

  area.addEventListener("keydown", (event) => {
    const mod = event.ctrlKey || event.metaKey;
    // A menu that is open owns the arrows, Enter, Tab and Escape.  It only
    // exists while there is something to accept, so the editor's own keys are
    // untouched the rest of the time.
    if (state.complete !== null) {
      if (event.key === "ArrowDown" || event.key === "ArrowUp") {
        event.preventDefault();
        state.completeIndex = stepCompletion(
          { items: state.complete.items, index: state.completeIndex },
          event.key === "ArrowDown" ? 1 : -1,
        );
        paintComplete();
        return;
      }
      if (event.key === "Enter" || event.key === "Tab") {
        event.preventDefault();
        acceptIndex(state.completeIndex);
        return;
      }
      if (event.key === "Escape") {
        event.preventDefault();
        hideComplete();
        return;
      }
      /* Keys that move the caret without changing the text: the menu was
         asked about the old caret, so it has to go before the caret does.
         The key itself is not prevented -- the browser still moves. */
      if (event.key === "ArrowLeft" || event.key === "ArrowRight"
        || event.key === "Home" || event.key === "End"
        || event.key === "PageUp" || event.key === "PageDown") {
        hideComplete();
      }
    }
    // Ctrl+Space asks for the menu even when the debounce has not fired: it is
    // the gesture the author reaches for when they know what they want.
    if (mod && event.key === " ") {
      event.preventDefault();
      completeNow();
      return;
    }
    if (mod && event.key.toLowerCase() === "s") {
      event.preventDefault();
      save();
      return;
    }
    if (mod && event.key.toLowerCase() === "f") {
      event.preventDefault();
      openFind();
      return;
    }
    if (event.key === "Escape" && state.findOpen) {
      event.preventDefault();
      closeFind();
      return;
    }
    // Tab indents: this is a text editor, and Tab is how text is indented.
    // Shift+Tab takes one step back off the lines the selection touches.
    if (event.key === "Tab") {
      event.preventDefault();
      const result = indentSelection(area.value, area.selectionStart, area.selectionEnd, {
        outdent: event.shiftKey,
      });
      if (result.text !== area.value) {
        rewrite(result.text, result.selectionStart, result.selectionEnd);
      }
      return;
    }
    // Enter keeps the line's indentation (plus one step after an opener).  A
    // top-level line is left to the browser, and the lines we do handle go in
    // through the browser's own insert command, so Ctrl+Z still has them.
    if (event.key === "Enter" && !mod && !event.altKey && !event.shiftKey
      && area.selectionStart === area.selectionEnd) {
      const before = area.value.slice(0, area.selectionStart);
      const indent = indentAfterEnter(before.slice(before.lastIndexOf("\n") + 1));
      if (indent !== "") {
        event.preventDefault();
        const at = area.selectionStart;
        rewrite(`${before}\n${indent}${area.value.slice(at)}`, at + 1 + indent.length);
        return;
      }
    }
    // Card-level shortcuts must not fire while typing.
    event.stopPropagation();
  });

  if (state.path !== "") {
    /* A card can be made *at* a place: `openFile(path, {line, pointer})` keeps
       the place on the card fields, and the reveal waits for the text to
       arrive -- standing on a line before the read answers has nothing to
       stand on. */
    const pending = {
      line: Number.isInteger(card.line) ? card.line : undefined,
      pointer: typeof card.pointer === "string" ? card.pointer : undefined,
    };
    load(state.path, { confirmDiscard: false }).then((loaded) => {
      if (loaded) {
        reveal(pending);
      }
    });
  } else {
    repaint();
    renderStatus();
  }

  return {
    el: shell.el,
    handle: {
      kind: "editor",
      save,
      load,
      focus() {
        area.focus();
      },
      /**
       * Stand on a `{line, pointer}` place (see the inner `reveal`); false when
       * the file has not loaded yet or the place is not in this text.
       */
      reveal(options = {}) {
        return reveal(options);
      },
      get path() {
        return state.path;
      },
      /**
       * The text currently in the buffer, unsaved edits included (G49: the
       * `card.editor.read` tool answers with what the user sees, not with what
       * is on disk -- a difference that matters while a line is half-typed).
       */
      text() {
        return area.value;
      },
      get dirty() {
        return state.dirty;
      },
      hasPath(path) {
        return state.path === path;
      },
      /**
       * The revision this card last read (or wrote), or `null` before the first
       * read answers. `file.stat` is compared against it.
       */
      get revision() {
        return state.baseRevision;
      },
      /**
       * Adopt the file as it is on disk now, discarding the buffer.
       *
       * Only a clean card is ever asked: the rule that decides is in
       * `watch.mjs`, and it warns instead of reloading whenever `dirty` is set.
       * The guard here is for the race (the user typed between the decision and
       * this call), not for the normal path.
       */
      reload() {
        if (state.dirty) {
          return Promise.resolve(false);
        }
        return load(state.path, { confirmDiscard: false, status: "reloaded from disk" });
      },
      /** The file is gone from disk: say so. The text stays, `^S` writes it back. */
      onFileGone() {
        renderStatus("gone from disk — ^S writes it back");
        app.log("warn", `${state.path} is gone from disk`);
      },
      /** Open the find bar (the smoke test drives it through real keys too). */
      find() {
        openFind();
        return { query: findQuery.value, hits: state.hits.length, index: state.hitIndex };
      },
      /** External change: report it, never auto-reload over unsaved edits. */
      onFileChanged(revision) {
        if (revision !== null && revision === state.baseRevision) {
          return;
        }
        renderStatus(`changed on disk (rev ${revision}) — ^S overwrites`);
        app.log("warn", `${state.path} changed on disk (rev ${revision})`);
      },
    },
    destroy() {
      if (state.timer !== null) {
        clearTimeout(state.timer);
      }
      state.tokenSeq += 1;
    },
  };
}

/* -------------------- runner -------------------- */
