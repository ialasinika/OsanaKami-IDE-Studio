/**
 * main.mjs -- the only file that knows about the whole app.
 *
 * DELETE THIS FILE and `index.html` has nothing to boot; every other module in
 * `shell/web/` stays importable on its own.  It is the wiring layer:
 *
 *   rpc.mjs    talks to the kernel            (transport)
 *   board.mjs  holds the document             (model)
 *   cards.mjs  renders one kind of card       (view)
 *   main.mjs   gestures, command line, status (control)
 *
 * The board is a 2-D world.  `#stage` carries one CSS transform
 * (`translate(tx,ty) scale(zoom)`), so panning and zooming never touch a card's
 * own coordinates and the link overlay (written in world units) stays aligned
 * for free.  There are no tabs anywhere: a file you open becomes a card at a
 * point in space, and where you put it is part of the project.
 *
 * Nothing here uses `eval`, inline `on*=` attributes, external URLs or a build
 * step; the browser loads these ES modules as written.
 */

import { createClient, isStaleRevision, staleCurrentRevision } from "./rpc.mjs";
import { createBoard, cardsWithin, DEFAULT_SIZE, MIN_SIZE, normaliseRect, ZOOM_MAX, ZOOM_MIN } from "./board.mjs";
import { createHistory } from "./history.mjs";
import {
  COMMAND_HELP,
  describeCard,
  emptySheet,
  parseCommandLine,
  parseZoomArgument,
  renderCard,
} from "./cards.mjs";

/* ------------------------------------------------------------------ */
/* small DOM helpers                                                   */
/* ------------------------------------------------------------------ */

const $ = (id) => document.getElementById(id);

function el(tag, className, text) {
  const node = document.createElement(tag);
  if (className) {
    node.className = className;
  }
  if (text !== undefined) {
    node.textContent = text;
  }
  return node;
}

const SVG_NS = "http://www.w3.org/2000/svg";

function svgEl(tag, className) {
  const node = document.createElementNS(SVG_NS, tag);
  if (className) {
    node.setAttribute("class", className);
  }
  return node;
}

const clamp = (value, lo, hi) => Math.min(hi, Math.max(lo, value));

/* ------------------------------------------------------------------ */
/* board geometry helpers (pure, so they are easy to reason about)     */
/* ------------------------------------------------------------------ */

/** World rect of a card, for computing where a link should attach. */
function cardRect(card) {
  return { x: card.x, y: card.y, w: card.w, h: card.h };
}

/**
 * Where a link leaves `from` and meets `to`: the midpoints of the two facing
 * edges.  Deliberately not a router -- a straight line between the nearest
 * edges is enough to read a board, and it never crosses the cards.
 */
export function linkPoints(a, b) {
  const ra = cardRect(a);
  const rb = cardRect(b);
  const ac = { x: ra.x + ra.w / 2, y: ra.y + ra.h / 2 };
  const bc = { x: rb.x + rb.w / 2, y: rb.y + rb.h / 2 };
  const dx = bc.x - ac.x;
  const dy = bc.y - ac.y;
  let p1;
  let p2;
  if (Math.abs(dx) >= Math.abs(dy)) {
    p1 = { x: dx >= 0 ? ra.x + ra.w : ra.x, y: ac.y };
    p2 = { x: dx >= 0 ? rb.x : rb.x + rb.w, y: bc.y };
  } else {
    p1 = { x: ac.x, y: dy >= 0 ? ra.y + ra.h : ra.y };
    p2 = { x: bc.x, y: dy >= 0 ? rb.y : rb.y + rb.h };
  }
  return { p1, p2, mid: { x: (p1.x + p2.x) / 2, y: (p1.y + p2.y) / 2 } };
}

/** The `overflow` values that make an element a scroll container. */
const SCROLLABLE = new Set(["auto", "scroll", "overlay"]);

/**
 * How many pixels a scroll container can still move along one axis.
 *
 * `delta` is the sign of the wheel's movement (positive scrolls down/right), so
 * the answer is the room *left in that direction*: 0 means the container is
 * already at the end the wheel is pushing towards, and a card that is short
 * enough to fit has no room either way.  Pure arithmetic, exported so the
 * selftest can prove it without a DOM.
 */
export function scrollRoom(scroll, client, total, delta) {
  if (delta === 0 || !Number.isFinite(scroll) || !Number.isFinite(client) || !Number.isFinite(total)) {
    return 0;
  }
  const room = delta < 0 ? scroll : total - client - scroll;
  return Math.max(0, Math.floor(room));
}

/**
 * Zoom keeping the world point under `(px, py)` fixed.
 * `px`/`py` are in the board element's own pixel space (post `getBoundingClientRect`).
 */
export function zoomAbout(viewport, factor, px, py) {
  const zoom = clamp(viewport.zoom * factor, ZOOM_MIN, ZOOM_MAX);
  const scale = zoom / viewport.zoom;
  return {
    zoom,
    x: px - (px - viewport.x) * scale,
    y: py - (py - viewport.y) * scale,
  };
}

/**
 * Drive one inline choice strip: the command line keeps the keyboard, a click
 * answers the question, and typing anything means the user moved on.
 *
 * Exported, and kept out of `ask()`, because what it really is is bookkeeping:
 * it installs an `input` listener on the command line and has to remove it on
 * *every* exit path.  A leaked listener has no visible symptom -- it just fires
 * a dead closure on every later keystroke, forever -- so the guarantee is worth
 * a check against a stub element under Node, where there is no DOM.
 *
 * @param {object} options
 * @param {object} options.strip  the element to insert; needs `remove()`
 * @param {Array<{el: object, value: any}>} options.buttons  already-created buttons
 * @param {object} options.abandonSource  element whose `input` means "cancel"
 * @returns {Promise<any>} the chosen value, or `null` when abandoned
 */
export function wireChoiceStrip({ strip, buttons, abandonSource }) {
  let settle = null;
  const promise = new Promise((resolve) => {
    settle = resolve;
  });
  let settled = false;
  let unbind = null;

  const finish = (value) => {
    if (settled) {
      return;
    }
    settled = true;
    try {
      if (unbind !== null) {
        unbind();
      }
    } finally {
      unbind = null;
      try {
        strip.remove();
      } catch {
        /* a strip that cannot detach must still not hang the answer */
      }
      settle(value);
    }
  };

  const abandon = () => finish(null);
  abandonSource.addEventListener("input", abandon);
  unbind = () => abandonSource.removeEventListener("input", abandon);

  for (const { el: button, value } of buttons) {
    button.addEventListener("click", () => finish(value));
  }
  return promise;
}

/**
 * The one status line a save outcome gets, or `null` for "say nothing".
 *
 * Pure and exported because the interesting cases are exactly the ones that
 * used to report nothing at all -- a `save` with nothing to write, a forced
 * overwrite that was refused, a save that could not start because the kernel is
 * not connected -- and a save that failed must never look like one that
 * succeeded.  `auto` is the one exception: a timer is not the user, so a quiet
 * autosave success stays quiet, while an autosave failure still speaks.
 *
 * @param {object} outcome
 * @param {"saved"|"unchanged"|"deferred"|"refused"|"failed"|"offline"} outcome.status
 * @param {boolean} [outcome.force]
 * @param {boolean} [outcome.auto]
 * @param {number|string|null} [outcome.revision]
 * @param {string} [outcome.detail]
 * @returns {{level: string, text: string}|null}
 */
export function saveOutcomeMessage(outcome) {
  const status = outcome === null || outcome === undefined ? "" : outcome.status;
  const force = Boolean(outcome && outcome.force);
  const auto = Boolean(outcome && outcome.auto);
  const detail = outcome && outcome.detail ? String(outcome.detail) : "";
  const tail = detail === "" ? "" : ` -- ${detail}`;

  switch (status) {
    case "saved": {
      if (auto) {
        return null;
      }
      const revision = outcome.revision === undefined || outcome.revision === null
        ? "unknown"
        : outcome.revision;
      return { level: "info", text: `board saved (rev ${revision}) → .seide/board.json${tail}` };
    }
    case "unchanged":
      // Typing `save` and seeing nothing is indistinguishable from a save that
      // did nothing at all, so this outcome is reported too.
      return auto ? null : { level: "info", text: "board already saved; nothing to write (use `save force` to overwrite)" };
    case "deferred":
      return auto ? null : { level: "info", text: `a save is already in flight; this ${force ? "forced " : ""}save follows it` };
    case "refused":
      return {
        level: "warn",
        text: `board.save refused the ${force ? "forced overwrite" : "write"}${detail === "" ? "" : `: ${detail}`}`,
      };
    case "failed":
      return { level: "error", text: `board.save failed${detail === "" ? "" : `: ${detail}`}` };
    case "offline":
      return { level: "error", text: "board.save skipped: no kernel connection" };
    default:
      return null;
  }
}

/* ------------------------------------------------------------------ */
/* the app                                                             */
/* ------------------------------------------------------------------ */

const STATUS_LIST = ["connecting", "ready", "unreachable"];

/** The welcome card a brand-new project gets. It is an ordinary note card. */
const HINT_SIZE = { w: 380, h: 300 };
const HINT_TEXT = [
  "Board: no tabs, no tree.",
  "",
  "Drag empty space to pan · wheel pans, but a wheel over a card's own contents",
  "scrolls the card first · ^wheel to zoom about the cursor.",
  "Drag a card title to move it · drag its corner to resize.",
  "Shift+drag empty space for a rubber band, ctrl/shift+click to add one card,",
  "Ctrl+A for all of them.  Drag any selected card to move the whole set;",
  "Delete removes it (one undo step).",
  "Double-click empty space for a note.",
  "Ctrl+Z takes back a board edit, Ctrl+Shift+Z puts it back.  In a text field",
  "those keys undo the typing, as they do anywhere else.",
  "",
  "Commands go on the line at the bottom:",
  "  open <path> · run <cmd> · files · note <text> · sheet [title]",
  "  project [glob] · link <from> <to> · zoom in|out|reset · focus <id>",
  "  delete <id> · undo · redo · save",
  "",
  "This arrangement is saved in .seide/board.json, not a tab history.",
  "Delete this card once it has told you what you need (`delete` on it).",
].join("\n");

function createApp() {
  /* -- elements -- */
  const boardEl = $("board");
  const stageEl = $("stage");
  const cardsEl = $("cards");
  const linksSvg = $("links");
  const emptyEl = $("empty-state");
  const statusEl = $("kernel-status");
  const selectionEl = $("hud-selection");
  const zoomEl = $("hud-zoom");
  const revEl = $("hud-revision");
  const dirtyEl = $("hud-dirty");
  const logEl = $("log");
  const barEl = $("bar");
  const commandEl = $("command");
  const hintEl = $("command-hint");
  const reloadButton = $("reload-board");

  /* -- state -- */
  const board = createBoard();
  let client = null;
  let boardRevision = null;
  let dirty = false;
  let saving = false;
  /* Every change to the in-memory board bumps this.  A save records it just
     before it serializes and only clears `dirty` when the board has not moved
     on since -- otherwise the reply to an older document marks a newer edit as
     saved and that edit is never written anywhere. */
  let boardGeneration = 0;
  /* A save requested while one is in flight is folded into exactly one more
     run instead of being dropped, so two `save`s in a row cannot lose the
     second one. */
  let saveAgain = false;
  /* Whether the save that was folded into the run in flight was a `save force`.
     Without this the follow-up run would downgrade an explicit overwrite into a
     plain save, which the newer file on disk then refuses. */
  let saveAgainForce = false;
  let initializing = true;
  let connected = false;
  let autosave = true;
  let autosaveTimer = null;
  let reconnectTimer = null;
  let reconnectDelay = 800;
  let renderQueued = false;

  /* Undo/redo for the board document -- see history.mjs.  `applyingHistory` is
     set while a step is being put back, so putting it back is not itself
     recorded as an edit (it would be, and the stack would never end). */
  const history = createHistory();
  let applyingHistory = false;

  /** cardId -> {el, handle, destroy, card} */
  const mounted = new Map();
  /** linkId -> {group, path, label, bg} */
  const linkNodes = new Map();
  /** runId -> cardId, so exec.output finds its runner even before the reply lands */
  const runs = new Map();

  // The model is the single source of truth: anything that changes it schedules
  // one frame of redraw, so a card never paints itself.
  board.subscribe(() => scheduleRender());

  /**
   * The set of *open editors* is a second, smaller source of truth: cards that
   * need it (the project panel) hear about it here.  It is deliberately not
   * "the board changed" -- the viewport changes on every pan frame, and a
   * listener that re-listed the workspace would do so sixty times a second.
   */
  const boardListeners = new Set();
  let boardSignature = null;

  /** Where the kernel was pointed. Not on the board: it is context, not state. */
  let workspace = null;

  function onBoardChanged(listener) {
    boardListeners.add(listener);
    return () => boardListeners.delete(listener);
  }

  function notifyBoardChanged() {
    const signature = openEditors()
      .map((entry) => `${entry.id}:${entry.path}:${entry.dirty ? 1 : 0}`)
      .join("|");
    if (signature === boardSignature) {
      return;
    }
    boardSignature = signature;
    for (const listener of boardListeners) {
      try {
        listener();
      } catch (err) {
        log("warn", `a board listener failed: ${err.message}`);
      }
    }
  }

  /* ------------------------------------------------------------------ */
  /* logging (never a modal: everything lands on the bottom line)        */
  /* ------------------------------------------------------------------ */

  const logLines = [];
  function log(level, message, path) {
    const text = typeof message === "string" ? message : String(message);
    const stamp = new Date().toLocaleTimeString([], { hour12: false });
    logLines.push({ level, text, path, stamp });
    if (logLines.length > 60) {
      logLines.shift();
    }
    const line = el("div", `log-line log-${level}`);
    line.append(el("span", "log-time", stamp));
    line.append(el("span", "log-text", path ? `${text}  (${path})` : text));
    logEl.append(line);
    while (logEl.childElementCount > 60) {
      logEl.firstElementChild.remove();
    }
    logEl.scrollTop = logEl.scrollHeight;
    return line;
  }

  /**
   * An inline choice strip above the command line.
   *
   * Returns a promise that resolves with the chosen value, or `null` if the
   * user typed something else into the command line first.  Deliberately not a
   * modal: seIDE has no dialogs, so a decision is a row of buttons on the board.
   */
  function ask(message, choices) {
    const strip = el("div", "ask");
    strip.append(el("span", "ask-text", message));
    const buttons = [];
    for (const choice of choices) {
      const button = el("button", "ask-button", choice.label);
      button.type = "button";
      strip.append(button);
      buttons.push({ el: button, value: choice.value });
    }
    barEl.before(strip);
    // The strip owns the answer and the listener; `wireChoiceStrip` guarantees
    // the listener is gone however the question ends.
    return wireChoiceStrip({ strip, buttons, abandonSource: commandEl });
  }

  /* ------------------------------------------------------------------ */
  /* rendering                                                           */
  /* ------------------------------------------------------------------ */

  function selectedCard() {
    return board.selectedId === null ? null : board.findCard(board.selectedId);
  }

  /** Queue one animation frame of geometry work. */
  function scheduleRender() {
    if (renderQueued) {
      return;
    }
    renderQueued = true;
    requestAnimationFrame(() => {
      renderQueued = false;
      renderAll();
    });
  }

  function renderAll() {
    renderStage();
    renderCards();
    renderLinks();
    renderHud();
  }

  function renderStage() {
    const { x, y, zoom } = board.viewport;
    stageEl.style.transform = `translate(${x}px, ${y}px) scale(${zoom})`;

    // The dot grid is drawn on the board itself and offset by the pan, so the
    // whole surface reads as one continuous plane rather than a scrolling list.
    const step = 24 * zoom;
    boardEl.style.backgroundSize = `${step}px ${step}px, ${step}px ${step}px`;
    boardEl.style.backgroundPosition = `${x}px ${y}px, ${x}px ${y}px`;

    zoomEl.textContent = `${Math.round(zoom * 100)}%`;
  }

  function renderHud() {
    selectionEl.textContent = describeSelection();
    revEl.textContent = boardRevision === null ? "unsaved" : `rev ${boardRevision}`;
    dirtyEl.textContent = dirty ? "unsaved changes" : "saved";
    dirtyEl.classList.toggle("is-dirty", dirty);
  }

  /**
   * What the selection line says.
   *
   * One card reads as itself.  Several read as a count *and* their ids: "3
   * cards" alone is untraceable on a board where two of them can be off screen,
   * and the ids are what a following `delete`/`focus` takes.
   */
  function describeSelection() {
    const ids = board.selection;
    if (ids.length === 0) {
      return "no card";
    }
    if (ids.length === 1) {
      const only = selectedCard();
      return only === null ? "no card" : `${describeCard(only)} — ${only.id}`;
    }
    const names = ids.slice(0, 3).join(", ");
    return `${ids.length} cards — ${names}${ids.length > 3 ? `, +${ids.length - 3}` : ""}`;
  }

  function renderCards() {
    const seen = new Set();

    for (const card of board.cards) {
      seen.add(card.id);
      let entry = mounted.get(card.id);
      if (entry === undefined) {
        const node = renderCard(card, { client, app });
        node.el.style.width = `${card.w}px`;
        node.el.style.height = `${card.h}px`;
        node.el.dataset.kind = card.kind;
        entry = { ...node, card };
        mounted.set(card.id, entry);
        cardsEl.append(node.el);
      }
      entry.card = card;
      const node = entry.el;
      node.style.transform = `translate(${card.x}px, ${card.y}px)`;
      node.style.width = `${card.w}px`;
      node.style.height = `${card.h}px`;
      // z-index only orders hit-testing and shadows; positions stay world-space.
      node.style.zIndex = String(Math.round(card.z) || 0);
      // One class for "in the selection" and a second for "the one a command
      // with no argument acts on", so a multi-selection still has a leader.
      node.classList.toggle("is-selected", board.isSelected(card.id));
      node.classList.toggle("is-primary", card.id === board.selectedId && board.selectionCount > 1);
    }

    for (const [id, entry] of mounted) {
      if (!seen.has(id)) {
        try {
          entry.destroy();
        } catch (err) {
          log("warn", `card ${id} failed to clean up: ${err.message}`);
        }
        entry.el.remove();
        mounted.delete(id);
      }
    }

    renderEmptyState();
    notifyBoardChanged();
  }

  /**
   * The board's only always-visible explanation.
   *
   * It is driven by status as well as by card count, because the unreachable
   * state has to be reachable *before the first board ever loads*: when the
   * kernel is down `boot()` rejects at `client.ready()`, long before the
   * `renderAll()` at the end of a successful boot, so a panel that only ever
   * updates from `renderCards()` stays hidden forever.  Worse, the "try to
   * connect again" button lives in here -- so a panel that waits for a render
   * can never be clicked to retry.
   */
  function renderEmptyState() {
    emptyEl.hidden = board.cards.length > 0 || connected;
    // The hint is a card, not a dialog: it lives in the board's log line.
    emptyEl.querySelector(".empty-title").textContent = connected
      ? "the board is empty"
      : "kernel not reachable";
    emptyEl.querySelector(".empty-text").textContent = connected
      ? "Type `note hello` or `open <path>` on the line at the bottom."
      : `The UI is served by \`node shell/main.mjs serve\` on 127.0.0.1. Start it, then reload — the board keeps retrying in the background. (${lastErrorText()})`;
  }

  function lastErrorText() {
    const err = client && client.lastError;
    if (!err) {
      return "no connection";
    }
    return err.message || String(err);
  }

  function renderLinks() {
    const seen = new Set();
    for (const link of board.links) {
      seen.add(link.id);
      const from = board.findCard(link.from);
      const to = board.findCard(link.to);
      if (from === null || to === null) {
        continue;
      }
      const { p1, p2, mid } = linkPoints(from, to);
      let node = linkNodes.get(link.id);
      if (node === undefined) {
        const group = svgEl("g", "link");
        group.dataset.linkId = link.id;
        const bg = svgEl("path", "link-bg");
        const path = svgEl("path", "link-path");
        const label = svgEl("text", "link-label");
        const labelBg = svgEl("rect", "link-label-bg");
        group.append(bg, path, labelBg, label);
        node = { group, path, bg, label, labelBg };
        linkNodes.set(link.id, node);
        linksSvg.append(group);
      }
      const d = `M ${p1.x} ${p1.y} L ${p2.x} ${p2.y}`;
      node.path.setAttribute("d", d);
      node.bg.setAttribute("d", d);
      const text = link.label || "";
      node.label.textContent = text;
      node.label.setAttribute("x", String(mid.x));
      node.label.setAttribute("y", String(mid.y - 6));
      node.label.classList.toggle("is-empty", text === "");
      // A backing rect so a label stays readable over the grid. Sized from the
      // label's own measured box, which is why this happens after painting.
      if (text === "") {
        node.labelBg.setAttribute("width", "0");
        node.labelBg.setAttribute("height", "0");
      } else {
        const box = node.label.getBBox();
        node.labelBg.setAttribute("x", String(box.x - 4));
        node.labelBg.setAttribute("y", String(box.y - 1));
        node.labelBg.setAttribute("width", String(box.width + 8));
        node.labelBg.setAttribute("height", String(box.height + 2));
      }
    }

    for (const [id, node] of linkNodes) {
      if (!seen.has(id)) {
        node.group.remove();
        linkNodes.delete(id);
      }
    }
  }

  /* ------------------------------------------------------------------ */
  /* board mutations                                                     */
  /* ------------------------------------------------------------------ */

  /**
   * Something changed the board.  `isDirty` false means the change is not worth
   * saving (a live pan, whose end will mark the board dirty once), and
   * `detail.record` false means it is worth saving but not worth an undo step
   * (raising a card to the front is a consequence of clicking it, not an edit
   * anybody wants to take back).
   */
  function boardTouched(isDirty = true, detail = {}) {
    if (isDirty) {
      dirty = true;
      boardGeneration += 1;
      if (detail.record !== false && !applyingHistory) {
        // `history.record` copies what it is given, and ignores documents that
        // differ only in the viewport, so this is safe to call on every edit.
        history.record(board.serialize(), detail.label ? { label: detail.label } : {});
      }
    }
    renderHud();
    if (isDirty && autosave && !initializing) {
      scheduleAutosave();
    }
  }

  /**
   * Put one history step back on the board.  The document goes through the same
   * `loadDocument` an external reload uses, so cards are mounted, links
   * redrawn and the HUD repainted exactly as they are for any other load; the
   * only difference is that history is left alone and the result is marked
   * dirty, because the board on screen and the board on disk now differ.
   */
  function applyHistoryStep(step, verb) {
    if (step === null) {
      log("warn", `nothing to ${verb}`);
      return false;
    }
    applyingHistory = true;
    try {
      loadDocument(step.document, { history: "keep" });
    } finally {
      applyingHistory = false;
    }
    log("info", `${verb === "undo" ? "undid" : "redid"}: ${step.label}`);
    boardTouched(true, { record: false });
    return true;
  }

  function undoBoard() {
    return applyHistoryStep(history.undo(), "undo");
  }

  function redoBoard() {
    return applyHistoryStep(history.redo(), "redo");
  }

  /*
   * The viewport lives inside the board document, so panning and zooming are
   * board edits: without this the layout the user just arranged is reported as
   * "saved" and is gone on the next reload.  This runs many times a second
   * while a gesture is live, so it deliberately skips renderHud() -- the HUD is
   * repainted once the gesture ends.
   */
  function viewportTouched() {
    dirty = true;
    boardGeneration += 1;
    if (autosave && !initializing) {
      scheduleAutosave();
    }
  }

  function scheduleAutosave() {
    if (autosaveTimer !== null) {
      clearTimeout(autosaveTimer);
    }
    autosaveTimer = setTimeout(() => {
      autosaveTimer = null;
      saveBoard({ auto: true });
    }, 1500);
  }

  /**
   * Put one save outcome on the status line.  Every exit path of `saveBoard`
   * goes through here, so no outcome -- including "nothing to write" and
   * "refused" -- can stay invisible.
   */
  function reportSave(outcome) {
    const line = saveOutcomeMessage(outcome);
    if (line !== null) {
      log(line.level, line.text);
    }
    return line;
  }

  async function saveBoard({ force = false, auto = false } = {}) {
    if (client === null) {
      // The kernel is the only writer; saying so beats a silent `false` that
      // the user only notices when the board is gone after a reload.
      reportSave({ status: "offline", force, auto });
      return false;
    }
    if (saving) {
      // Fold this request into the run that is already in flight rather than
      // dropping it on the floor: the `finally` below re-runs once if the
      // board moved on, which covers both "the user kept editing" and
      // "the user asked again".  `force` travels with it -- dropping the flag
      // would quietly turn "overwrite the newer file" into a stale refusal.
      saveAgain = true;
      saveAgainForce = saveAgainForce || force;
      reportSave({ status: "deferred", force, auto });
      return false;
    }
    if (!force && boardRevision !== null && !dirty) {
      reportSave({ status: "unchanged", force, auto });
      return true;
    }
    saving = true;
    const generation = boardGeneration;
    // Every caveat that applied to this write, so the outcome line can carry all
    // of them instead of the last one winning.
    const notes = [];
    if (!auto) {
      log("info", "saving board…");
    }
    try {
      let document_ = null;
      try {
        document_ = board.serialize();
      } catch (err) {
        // A model the kernel would reject cannot be written, and trimming it
        // silently would lose work: name what is wrong and write nothing.
        reportSave({ status: "refused", force, auto, detail: err.message });
        return false;
      }
      const params = { document: document_ };
      if (force) {
        // Re-read the current revision so the kernel accepts the overwrite.
        try {
          const fresh = await client.call("board.load", {});
          params.base_revision = fresh.revision;
          boardRevision = fresh.revision;
        } catch (err) {
          // Falling through writes without a guard, which is a blind
          // overwrite. Say so rather than letting `force` look like it worked.
          const caveat = `could not re-read the board before forcing: ${err.message}`
            + " -- this save has no staleness guard";
          notes.push(caveat);
          log("warn", caveat);
        }
      } else if (boardRevision !== null) {
        params.base_revision = boardRevision;
      }
      const result = await client.call("board.save", params);
      boardRevision = result.revision;
      // A host that answers without a revision leaves the next save unguarded.
      // That is worth saying out loud, because the write itself succeeded and
      // the status line is the only place it would ever show.
      if (result.revision === undefined || result.revision === null) {
        notes.push("the host reported no revision, so the next save cannot be guarded against a newer file");
      }
      // What is on disk now is the document serialized above, and nothing
      // newer. If the user edited while this was in flight, `dirty` has to
      // stay true or that edit is marked saved and never written.
      if (boardGeneration === generation) {
        dirty = false;
      }
      renderHud();
      reportSave({ status: "saved", force, auto, revision: result.revision, detail: notes.join("; ") });
      return true;
    } catch (err) {
      if (isStaleRevision(err)) {
        const current = staleCurrentRevision(err);
        dirty = true;
        renderHud();
        // The refused overwrite is the case that used to look like a success:
        // `force` was asked for and nothing was written.
        reportSave({
          status: "refused",
          force,
          auto,
          detail: `the board changed on disk (rev ${current}); your layout is kept in memory`
            + " -- type `save force` to overwrite it",
        });
      } else {
        reportSave({ status: "failed", force, auto, detail: err.message });
      }
      return false;
    } finally {
      saving = false;
      if (saveAgain) {
        saveAgain = false;
        const againForce = saveAgainForce;
        saveAgainForce = false;
        // One more run covers everything that arrived during this one. A forced
        // request is repeated even when nothing is dirty: `save force` means
        // "write it", not "write it if it changed".
        if (dirty || againForce) {
          void saveBoard({ force: againForce, auto });
        }
      }
    }
  }

  /** Place a new card near the middle of what the user is looking at. */
  function centreWorld() {
    const { x, y, zoom } = board.viewport;
    const rect = boardEl.getBoundingClientRect();
    return {
      x: (rect.width / 2 - x) / zoom,
      y: (rect.height / 2 - y) / zoom,
    };
  }

  function addCard(kind, x, y, fields = {}, geometry = {}) {
    const card = board.addCard(kind, x, y, fields, geometry);
    renderCards();
    renderLinks();
    boardTouched();
    return card;
  }

  function focusCard(id) {
    if (!board.setSelection(id)) {
      log("warn", `no card ${id}`);
      return false;
    }
    const entry = mounted.get(id);
    if (entry !== undefined && entry.handle.focus) {
      entry.handle.focus();
    }
    renderCards();
    renderHud();
    return true;
  }

  /** Unsaved text is never discarded silently, so it is named before any delete. */
  function warnUnsaved(id) {
    const entry = mounted.get(id);
    if (entry !== undefined && entry.handle.dirty) {
      log("warn", `card ${id} has unsaved text; saving is not implicit — use ^S in the card first`);
    }
  }

  function deleteCard(id) {
    warnUnsaved(id);
    if (!board.removeCard(id)) {
      log("warn", `no card ${id}`);
      return false;
    }
    renderCards();
    renderLinks();
    boardTouched();
    return true;
  }

  /**
   * Delete everything selected (the Delete key, or `delete` with no argument).
   *
   * One removal, so it is one undo step and one save: the cards and the links
   * between them come back together.  Unsaved text is named first, exactly as
   * for a single card -- a group delete must not become the quiet way to lose a
   * buffer.
   *
   * @returns {number} how many cards left the board
   */
  function deleteSelection() {
    const ids = board.selection;
    if (ids.length === 0) {
      log("warn", "nothing is selected (Ctrl+A selects every card)");
      return 0;
    }
    for (const id of ids) {
      warnUnsaved(id);
    }
    const removed = board.removeCards(ids);
    renderCards();
    renderLinks();
    boardTouched();
    return removed.length;
  }

  /** Scroll a card into view by panning, keeping the zoom. */
  function centreOn(card) {
    const rect = boardEl.getBoundingClientRect();
    const { zoom } = board.viewport;
    board.setViewport({
      x: rect.width / 2 - (card.x + card.w / 2) * zoom,
      y: rect.height / 2 - (card.y + card.h / 2) * zoom,
    });
    scheduleRender();
  }

  /* ------------------------------------------------------------------ */
  /* opening files                                                       */
  /* ------------------------------------------------------------------ */

  /**
   * The editor cards currently on the board, as plain data.
   *
   * This is what "open" means in seIDE: there is no tab strip and no document
   * list outside the board -- a file is open exactly when a card holds it.
   */
  function openEditors() {
    const out = [];
    for (const entry of mounted.values()) {
      if (entry.handle.kind !== "editor") {
        continue;
      }
      out.push({
        id: entry.card.id,
        path: String(entry.handle.path || "").replace(/\\/g, "/"),
        dirty: entry.handle.dirty === true,
      });
    }
    out.sort((a, b) => {
      if (a.path !== b.path) {
        return a.path < b.path ? -1 : 1;
      }
      return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
    });
    return out;
  }

  /** Focus a card and pan to it if it is off-screen. */
  function revealCard(id) {
    if (!focusCard(id)) {
      return false;
    }
    const entry = mounted.get(id);
    if (entry !== undefined) {
      centreOn(entry.card);
    }
    return true;
  }

  function openFile(path, options = {}) {
    if (typeof path !== "string" || path.trim() === "") {
      log("warn", "open: give a workspace-relative path");
      return null;
    }
    const wanted = path.trim().replace(/\\/g, "/");
    const line = Number.isFinite(options.line) ? Math.floor(options.line) : 0;
    for (const entry of mounted.values()) {
      if (entry.handle.kind === "editor" && entry.handle.hasPath && entry.handle.hasPath(wanted)) {
        focusCard(entry.card.id);
        centreOn(entry.card);
        revealLine(entry, line);
        return entry.card;
      }
    }
    const centre = options.at || centreWorld();
    const size = { w: 680, h: 460 };
    const card = addCard("editor", Math.round(centre.x - size.w / 2), Math.round(centre.y - size.h / 2), {
      file: wanted,
    }, size);
    revealLine(mounted.get(card.id), line);
    return card;
  }

  /**
   * Put an editor's caret on a line, without waiting for it.
   *
   * The card may still be reading its file, so `goToLine` waits for the load
   * itself; a failed jump is a message in the log, never a broken click.
   */
  function revealLine(entry, line) {
    if (line < 1 || entry === undefined || typeof entry.handle.goToLine !== "function") {
      return;
    }
    Promise.resolve(entry.handle.goToLine(line)).catch((err) => {
      log("warn", `could not jump to line ${line}: ${err.message}`);
    });
  }

  function openRunner(cmd, options = {}) {
    const centre = options.at || centreWorld();
    const size = { w: 560, h: 300 };
    const card = addCard("runner",
      Math.round(centre.x - size.w / 2),
      Math.round(centre.y - size.h / 2),
      { cmd, cwd: "." }, size);
    if (options.run !== false) {
      const entry = mounted.get(card.id);
      if (entry !== undefined && entry.handle.start) {
        entry.handle.start();
      }
    }
    return card;
  }

  /* ------------------------------------------------------------------ */
  /* notification bus                                                    */
  /* ------------------------------------------------------------------ */

  function registerRun(runId, cardId) {
    runs.set(runId, cardId);
  }

  /**
   * Ask what to do about a file that changed under an editor card.
   * Nothing is overwritten and nothing is discarded on its own.
   */
  function resolveStale({ path, current, cardId }) {
    log("warn", `${path} changed on disk (rev ${current}); your buffer was not written.`);
    return ask(`${path} changed on disk (rev ${current}). Keep your text?`, [
      { label: "reload from disk", value: "reload" },
      { label: "overwrite", value: "overwrite" },
      { label: "leave it", value: "cancel" },
    ]).then((choice) => {
      if (choice === null) {
        return "cancel";
      }
      return choice;
    });
  }

  /** Un-saved editor text is never thrown away silently. */
  function confirmDiscard(path) {
    log("warn", `${path} has unsaved text. Save it with ^S in the card, then reload.`);
    return false;
  }

  const app = {
    log,
    boardTouched,
    registerRun,
    resolveStale,
    confirmDiscard,
    openFile,
    openEditors,
    revealCard,
    // Same behaviour as `delete <id>`: the card leaves the board, the file on
    // disk is not touched, and unsaved text is named rather than discarded.
    closeCard: deleteCard,
    onBoardChanged,
    workspace() {
      return workspace;
    },
    get client() {
      return client;
    },
  };

  /* ------------------------------------------------------------------ */
  /* gestures                                                            */
  /* ------------------------------------------------------------------ */

  function screenToWorld(clientX, clientY) {
    const rect = boardEl.getBoundingClientRect();
    const { x, y, zoom } = board.viewport;
    return {
      x: (clientX - rect.left - x) / zoom,
      y: (clientY - rect.top - y) / zoom,
    };
  }

  /**
   * One delegated pointer gesture for the whole surface:
   *   empty space      -> pan
   *   shift+empty      -> rubber band (ctrl/shift adds to the selection)
   *   card             -> focus + raise, and select it (ctrl/shift = toggle)
   *   card-title       -> move (every selected card moves together)
   *   grip             -> resize
   *
   * Selection is not part of the document, so deciding what is selected is not a
   * board edit: only the gestures that move or remove cards call
   * `boardTouched`, and each of them calls it once, at the end.
   */
  function installGestures() {
    let gesture = null;
    /** A pointer that moved less than this was a click, not a drag. */
    const CLICK_SLOP = 3;
    const bandEl = el("div", "marquee");
    bandEl.hidden = true;
    stageEl.append(bandEl);

    const farEnough = (event, from) => Math.abs(event.clientX - from.px) > CLICK_SLOP
      || Math.abs(event.clientY - from.py) > CLICK_SLOP;

    function renderBand() {
      if (gesture === null || gesture.kind !== "band") {
        bandEl.hidden = true;
        return;
      }
      const rect = normaliseRect({ x: gesture.ox, y: gesture.oy }, { x: gesture.x, y: gesture.y });
      bandEl.hidden = false;
      bandEl.style.transform = `translate(${rect.x}px, ${rect.y}px)`;
      bandEl.style.width = `${rect.w}px`;
      bandEl.style.height = `${rect.h}px`;
    }

    boardEl.addEventListener("pointerdown", (event) => {
      if (event.button !== 0) {
        return;
      }
      const target = event.target;
      if (target instanceof Element && target.closest("input, textarea, button, select")) {
        return; // let the control have the click
      }
      const cardNode = target instanceof Element ? target.closest("[data-card-id]") : null;
      const role = target instanceof Element && target.dataset ? target.dataset.role : null;
      const additive = event.ctrlKey || event.metaKey || event.shiftKey;

      if (cardNode === null) {
        const world = screenToWorld(event.clientX, event.clientY);
        if (event.shiftKey) {
          // A band replaces the selection; holding ctrl as well adds to it.
          const keep = event.ctrlKey || event.metaKey;
          gesture = {
            kind: "band",
            ox: world.x,
            oy: world.y,
            x: world.x,
            y: world.y,
            base: board.selection,
            keep,
            moved: false,
            px: event.clientX,
            py: event.clientY,
          };
          if (!keep) {
            board.clearSelection();
          }
          renderBand();
          renderCards();
          renderHud();
        } else {
          gesture = { kind: "pan", startX: board.viewport.x, startY: board.viewport.y, px: event.clientX, py: event.clientY };
          board.setSelection(null);
          renderCards();
          renderHud();
        }
      } else {
        const card = board.findCard(cardNode.dataset.cardId);
        if (card === null) {
          return;
        }
        const already = board.isSelected(card.id);
        if (additive) {
          board.toggleSelection(card.id);
        } else if (already) {
          // Clicking one of several keeps the set (a drag then moves them all)
          // and only makes this card the leader; the collapse to a single card
          // is decided on pointerup, if the pointer never moved.
          board.applySelection(board.selection, card.id);
        } else {
          board.setSelection(card.id);
        }
        // Bringing a card to the front changes `z`, which is part of the
        // document, so it has to be marked dirty or the HUD says "saved" and
        // the stack order is gone after a reload.  It is not an undo step:
        // nobody means to take back "I clicked that card".
        board.raiseCard(card.id);
        boardTouched(true, { record: false });
        const collapse = !additive && already && board.selectionCount > 1;
        if (role === "card-title") {
          const world = screenToWorld(event.clientX, event.clientY);
          // Where every selected card started, so the whole group can be dragged
          // by whichever one the pointer happens to be on.
          const start = new Map();
          for (const id of board.selection) {
            const other = board.findCard(id);
            if (other !== null) {
              start.set(id, { x: other.x, y: other.y });
            }
          }
          gesture = {
            kind: "move",
            card,
            start,
            ox: world.x,
            oy: world.y,
            collapse,
            moved: false,
            px: event.clientX,
            py: event.clientY,
          };
        } else if (role === "grip") {
          const world = screenToWorld(event.clientX, event.clientY);
          gesture = { kind: "resize", card, dx: world.x - card.x, dy: world.y - card.y };
        } else {
          gesture = {
            kind: "focus",
            card,
            collapse,
            px: event.clientX,
            py: event.clientY,
          };
          renderCards();
          renderHud();
          return;
        }
        renderCards();
        renderHud();
      }

      // Capture is a convenience: it keeps the gesture alive when the pointer
      // leaves the window.  It throws when the pointer is already gone (a
      // synthetic event, or a device that vanished mid-drag), and that must not
      // cost us the gesture we just started.
      try {
        boardEl.setPointerCapture(event.pointerId);
      } catch {
        /* the gesture still works, it just stops at the window edge */
      }
      event.preventDefault();
    });

    boardEl.addEventListener("pointermove", (event) => {
      if (gesture === null) {
        return;
      }
      const zoom = board.viewport.zoom;
      if (gesture.kind === "pan") {
        board.setViewport({
          x: gesture.startX + (event.clientX - gesture.px),
          y: gesture.startY + (event.clientY - gesture.py),
        });
        viewportTouched();
      } else if (gesture.kind === "band") {
        const world = screenToWorld(event.clientX, event.clientY);
        gesture.x = world.x;
        gesture.y = world.y;
        gesture.moved = gesture.moved || farEnough(event, gesture);
        const rect = normaliseRect({ x: gesture.ox, y: gesture.oy }, { x: world.x, y: world.y });
        const touched = cardsWithin(board.cards, rect);
        board.applySelection(gesture.keep ? [...gesture.base, ...touched] : touched, null);
        renderBand();
        renderCards();
        renderHud();
      } else if (gesture.kind === "move") {
        // The card can vanish under the pointer -- another writer's
        // board.changed, or a `delete`.  board.moveCards ignores an unknown id,
        // but a gesture on a card that is gone has nothing left to move.
        if (board.findCard(gesture.card.id) === null) {
          gesture = null;
          return;
        }
        const world = screenToWorld(event.clientX, event.clientY);
        gesture.moved = gesture.moved || farEnough(event, gesture);
        const dx = world.x - gesture.ox;
        const dy = world.y - gesture.oy;
        const moves = [];
        for (const [id, from] of gesture.start) {
          moves.push({ id, x: Math.round(from.x + dx), y: Math.round(from.y + dy) });
        }
        board.moveCards(moves);
      } else if (gesture.kind === "resize") {
        if (board.findCard(gesture.card.id) === null) {
          gesture = null;
          return;
        }
        const world = screenToWorld(event.clientX, event.clientY);
        board.resizeCard(
          gesture.card.id,
          Math.max(MIN_SIZE.w, Math.round(world.x - gesture.dx)),
          Math.max(MIN_SIZE.h, Math.round(world.y - gesture.dy)),
        );
      }
      scheduleRender();
      void zoom;
    });

    const endGesture = (event) => {
      if (gesture === null) {
        return;
      }
      if (gesture.kind === "band") {
        gesture = null;
        renderBand();
        renderCards();
        renderHud();
        if (boardEl.hasPointerCapture && boardEl.hasPointerCapture(event.pointerId)) {
          boardEl.releasePointerCapture(event.pointerId);
        }
        return;
      }
      if ((gesture.kind === "move" || gesture.kind === "focus")
          && gesture.collapse === true && gesture.moved !== true) {
        // A click that never became a drag collapses the set to the card it
        // landed on -- the other half of "drag one of three moves all three".
        board.setSelection(gesture.card.id);
        renderCards();
        renderHud();
      }
      if (gesture.kind === "move" || gesture.kind === "resize" || gesture.kind === "pan") {
        // For a pan this is also where the HUD catches up, since the movement
        // path deliberately skips it.  A group move is one undo step for the
        // whole selection, not one per card.
        boardTouched(gesture.kind !== "pan");
      }
      if (boardEl.hasPointerCapture && boardEl.hasPointerCapture(event.pointerId)) {
        boardEl.releasePointerCapture(event.pointerId);
      }
      gesture = null;
    };
    boardEl.addEventListener("pointerup", endGesture);
    boardEl.addEventListener("pointercancel", endGesture);

    // Wheel: a card's own scroll region keeps the wheel while it has somewhere
    // to go; otherwise plain scroll pans, and ctrl/⌘ (or shift) zooms about the
    // cursor.  Zooming about the cursor is what makes a 2-D board feel solid.
    //
    // A card's contents (an editor's text, a sheet, a runner's output) are a
    // scroll region *inside* the board, and the wheel event bubbles up to
    // `boardEl` from there -- so panning unconditionally meant the board moved
    // and the card never did.  The nearest container below the board that can
    // still move in this direction wins; at its end the wheel pans again, the
    // way nested scrolling usually chains.
    function scrollTarget(node, deltaX, deltaY) {
      for (let el = node instanceof Element ? node : null; el && el !== boardEl; el = el.parentElement) {
        const style = getComputedStyle(el);
        // A textarea scrolls even where `overflow` computes to something else.
        const vertical = SCROLLABLE.has(style.overflowY) || el.tagName === "TEXTAREA";
        if (vertical && scrollRoom(el.scrollTop, el.clientHeight, el.scrollHeight, deltaY) > 0) {
          return el;
        }
        if (SCROLLABLE.has(style.overflowX) && scrollRoom(el.scrollLeft, el.clientWidth, el.scrollWidth, deltaX) > 0) {
          return el;
        }
      }
      return null;
    }

    boardEl.addEventListener("wheel", (event) => {
      const overCard = !event.ctrlKey && !event.metaKey && scrollTarget(event.target, event.deltaX, event.deltaY) !== null;
      if (overCard) {
        return; // the card scrolls; the board stays where it is
      }
      event.preventDefault();
      if (event.ctrlKey || event.metaKey) {
        const rect = boardEl.getBoundingClientRect();
        const factor = Math.exp(-event.deltaY * 0.0015);
        const next = zoomAbout(board.viewport, factor, event.clientX - rect.left, event.clientY - rect.top);
        board.setViewport(next);
      } else if (event.shiftKey) {
        board.setViewport({ x: board.viewport.x - event.deltaY });
      } else {
        board.setViewport({
          x: board.viewport.x - event.deltaX,
          y: board.viewport.y - event.deltaY,
        });
      }
      viewportTouched();
      renderHud();
      renderStage();
    }, { passive: false });

    boardEl.addEventListener("dblclick", (event) => {
      const cardNode = event.target instanceof Element ? event.target.closest("[data-card-id]") : null;
      if (cardNode === null) {
        // Double-click on empty space drops a note exactly there.
        const world = screenToWorld(event.clientX, event.clientY);
        addCard("note", Math.round(world.x - 120), Math.round(world.y - 80), { text: "" });
      }
    });

    boardEl.addEventListener("contextmenu", (event) => event.preventDefault());
  }

  /* ------------------------------------------------------------------ */
  /* the command line                                                    */
  /* ------------------------------------------------------------------ */

  const KNOWN_COMMANDS = [
    "open", "note", "run", "files", "find", "project", "link", "unlink", "zoom",
    "focus", "select", "delete", "save", "undo", "redo", "help", "clear",
  ];

  async function runCommand(raw) {
    const line = raw.trim();
    if (line === "") {
      return;
    }
    const tokens = parseCommandLine(line);
    const head = tokens[0] === undefined ? "" : tokens[0].toLowerCase();
    const argc = tokens.length - 1;
    const arg = (n) => tokens[n + 1];

    switch (head) {
      case "open": {
        if (argc < 1) {
          log("warn", "usage: open <path>");
          return;
        }
        openFile(tokens.slice(1).join(" "));
        return;
      }
      case "note": {
        const text = line.replace(/^\s*note\s*/i, "");
        const centre = centreWorld();
        addCard("note", Math.round(centre.x - 140), Math.round(centre.y - 90), { text });
        return;
      }
      case "sheet": {
        const title = line.replace(/^\s*sheet\s*/i, "").trim();
        const size = DEFAULT_SIZE.sheet;
        const centre = centreWorld();
        addCard("sheet", Math.round(centre.x - size.w / 2), Math.round(centre.y - size.h / 2), {
          title,
          doc: emptySheet(),
        });
        log("info", `sheet card added${title === "" ? "" : ` (${title})`} — a grid of typed cells, not text`);
        return;
      }
      case "run": {
        const cmd = line.replace(/^\s*run\s*/i, "").trim();
        if (cmd === "") {
          log("warn", "usage: run <cmd>");
          return;
        }
        openRunner(cmd);
        return;
      }
      case "files": {
        const filter = arg(0) === undefined ? "**/*" : tokens.slice(1).join(" ");
        const centre = centreWorld();
        const size = { w: 360, h: 560 };
        addCard("files", Math.round(centre.x - size.w / 2), Math.round(centre.y - size.h / 2), { filter }, size);
        return;
      }
      case "find": {
        // One search card, like the project panel: `find` re-points the card you
        // already have instead of stacking a second one next to it.
        const query = tokens.slice(1).join(" ").trim();
        if (query === "") {
          log("warn", "usage: find <text>");
          return;
        }
        const existing = board.cards.find((card) => card.kind === "search");
        if (existing !== undefined) {
          const entry = mounted.get(existing.id);
          revealCard(existing.id);
          if (entry !== undefined && typeof entry.handle.setQuery === "function") {
            await entry.handle.setQuery(query);
          }
          return;
        }
        const centre = centreWorld();
        const size = DEFAULT_SIZE.search;
        addCard("search",
          Math.round(centre.x - size.w / 2),
          Math.round(centre.y - size.h / 2),
          { query, glob: "**/*", caseSensitive: false },
          size);
        return;
      }
      case "project": {
        // There is one project, so there is one project panel: a second
        // `project` reveals the card you already have rather than stacking a
        // duplicate, and an argument re-points its filter.
        const filter = arg(0) === undefined ? null : tokens.slice(1).join(" ");
        const existing = board.cards.find((card) => card.kind === "project");
        if (existing !== undefined) {
          const entry = mounted.get(existing.id);
          if (filter !== null && entry !== undefined && typeof entry.handle.setFilter === "function") {
            entry.handle.setFilter(filter);
          }
          revealCard(existing.id);
          return;
        }
        const centre = centreWorld();
        const size = DEFAULT_SIZE.project;
        addCard("project",
          Math.round(centre.x - size.w / 2),
          Math.round(centre.y - size.h / 2),
          { filter: filter === null ? "**/*" : filter },
          size);
        return;
      }
      case "link": {
        if (argc < 2) {
          log("warn", "usage: link <fromId> <toId> [label]");
          return;
        }
        if (board.findCard(arg(0)) === null || board.findCard(arg(1)) === null) {
          log("warn", `link: one of ${arg(0)} / ${arg(1)} is not a card`);
          return;
        }
        const link = board.linkCards(arg(0), arg(1), argc >= 3 ? tokens.slice(3).join(" ") : "");
        renderLinks();
        boardTouched();
        log("info", `linked ${arg(0)} → ${arg(1)} (${link.id})`);
        return;
      }
      case "unlink": {
        if (argc < 1) {
          log("warn", "usage: unlink <linkId>");
          return;
        }
        if (board.unlink(arg(0))) {
          renderLinks();
          boardTouched();
        } else {
          log("warn", `no link ${arg(0)}`);
        }
        return;
      }
      case "zoom": {
        const target = parseZoomArgument(arg(0), board.viewport.zoom);
        if (target === null) {
          log("warn", "usage: zoom <n> | in | out | reset");
          return;
        }
        const rect = boardEl.getBoundingClientRect();
        const factor = target / board.viewport.zoom;
        board.setViewport(zoomAbout(board.viewport, factor, rect.width / 2, rect.height / 2));
        viewportTouched();
        renderHud();
        renderStage();
        return;
      }
      case "focus": {
        if (argc < 1) {
          log("warn", "usage: focus <id>");
          return;
        }
        const card = board.findCard(arg(0));
        if (card === null) {
          log("warn", `no card ${arg(0)}`);
          return;
        }
        focusCard(card.id);
        centreOn(card);
        return;
      }
      case "delete": {
        if (argc < 1) {
          // No argument means "what is selected", which is now a set.
          deleteSelection();
          return;
        }
        deleteCard(arg(0));
        return;
      }
      case "select": {
        const first = (arg(0) || "").toLowerCase();
        if (argc < 1 || first === "all") {
          const count = board.selectAll();
          log("info", count === 0 ? "no cards to select" : `selected ${count} card${count === 1 ? "" : "s"}`);
        } else if (first === "none") {
          board.clearSelection();
          log("info", "selection cleared");
        } else {
          const wanted = tokens.slice(1);
          const known = wanted.filter((id) => board.findCard(id) !== null);
          const missing = wanted.filter((id) => board.findCard(id) === null);
          if (missing.length > 0) {
            log("warn", `no card ${missing.join(", ")}`);
          }
          if (known.length === 0) {
            return;
          }
          board.applySelection(known, known[known.length - 1]);
          log("info", `selected ${board.selection.join(", ")}`);
        }
        renderCards();
        renderHud();
        return;
      }
      case "save": {
        await saveBoard({ force: arg(0) === "force" });
        return;
      }
      case "undo": {
        undoBoard();
        return;
      }
      case "redo": {
        redoBoard();
        return;
      }
      case "help": {
        log("info", "commands:");
        for (const row of COMMAND_HELP) {
          log("info", `  ${row}`);
        }
        log("info", "  clear                    empty the log");
        return;
      }
      case "clear": {
        logEl.textContent = "";
        logLines.length = 0;
        return;
      }
      default: {
        const guess = KNOWN_COMMANDS.filter((name) => name.startsWith(head.slice(0, 2)));
        log("warn", `unknown command "${head}".${guess.length ? ` Did you mean ${guess.join(" / ")}?` : ""} Type \`help\`.`);
      }
    }
  }

  function installCommandLine() {
    commandEl.addEventListener("keydown", (event) => {
      event.stopPropagation();
      if (event.key === "Enter") {
        event.preventDefault();
        const value = commandEl.value;
        commandEl.value = "";
        hintEl.textContent = "";
        runCommand(value).catch((err) => log("error", `command failed: ${err.message}`));
        return;
      }
      if (event.key === "Escape") {
        commandEl.value = "";
        commandEl.blur();
        return;
      }
      if (event.key === "Tab") {
        event.preventDefault();
        const partial = commandEl.value.trim().split(/\s+/)[0] || "";
        const match = KNOWN_COMMANDS.find((name) => name.startsWith(partial));
        if (match !== undefined) {
          commandEl.value = `${match} `;
        }
        return;
      }
      if (event.key === "ArrowUp") {
        const last = logLines.filter((entry) => entry.level !== "error").pop();
        if (last !== undefined) {
          hintEl.textContent = last.text;
        }
      }
    });

    commandEl.addEventListener("input", () => {
      const partial = commandEl.value.trim();
      if (partial === "") {
        hintEl.textContent = "";
        return;
      }
      const word = partial.split(/\s+/)[0].toLowerCase();
      if (KNOWN_COMMANDS.includes(word)) {
        const usage = COMMAND_HELP.find((row) => row.startsWith(`${word} `) || row.startsWith(`${word}\t`));
        hintEl.textContent = usage === undefined ? "" : usage.replace(/\s+/g, " ").trim();
        return;
      }
      const matches = KNOWN_COMMANDS.filter((name) => name.startsWith(word));
      hintEl.textContent = matches.length === 0 ? `unknown command "${word}"` : matches.join(" · ");
    });
  }

  /* ------------------------------------------------------------------ */
  /* kernel wiring                                                       */
  /* ------------------------------------------------------------------ */

  function setStatus(state) {
    statusEl.dataset.state = state;
    statusEl.textContent = {
      connecting: "connecting…",
      ready: "kernel ready",
      unreachable: "kernel not reachable",
    }[state] || state;
    statusEl.title = state === "ready"
      ? "shell/main.mjs is answering on /rpc"
      : lastErrorText();
    for (const name of STATUS_LIST) {
      statusEl.classList.toggle(`is-${name}`, name === state);
    }
    renderEmptyState();
  }

  function installEvents() {
    client.on("log", (event) => log(event.level || "info", event.message || "", event.path));
    client.on("file.changed", (event) => {
      for (const entry of mounted.values()) {
        if (entry.handle.kind === "editor" && entry.handle.hasPath && entry.handle.hasPath(event.path)) {
          entry.handle.onFileChanged(event.revision);
        }
      }
    });
    client.on("exec.output", (event) => {
      const cardId = runs.get(event.run_id);
      const entry = cardId === undefined ? undefined : mounted.get(cardId);
      if (entry !== undefined && entry.handle.output) {
        entry.handle.output(event.data);
      }
    });
    client.on("exec.exit", (event) => {
      const cardId = runs.get(event.run_id);
      runs.delete(event.run_id);
      const entry = cardId === undefined ? undefined : mounted.get(cardId);
      if (entry !== undefined && entry.handle.exit) {
        entry.handle.exit(event.code);
      }
      log(event.code === 0 ? "info" : "warn", `run ${event.run_id} finished (exit ${event.code})`);
    });
    client.on("board.changed", (event) => {
      if (event.revision === boardRevision) {
        return; // our own save echoing back
      }
      if (dirty) {
        log("warn", `the board on disk is now rev ${event.revision}; you have unsaved changes.`);
        return;
      }
      // Nothing local to lose, so follow the disk.
      adoptDiskBoard(`another writer moved the board to rev ${event.revision}`).catch(
        (err) => log("error", `board.load failed: ${err.message}`),
      );
    });
  }

  async function adoptDiskBoard(reason) {
    const loaded = await client.call("board.load", {});
    boardRevision = loaded.revision;
    loadDocument(loaded.document);
    log("info", `reloaded the board (${reason})`);
  }

  /**
   * Put a document on the board.  `history` is "reset" for a board that came
   * from somewhere else (boot, or another writer's `board.changed`): the undo
   * stack is thrown away there, because undoing across somebody else's edit
   * would resurrect the cards they just deleted.  An undo or redo of our own
   * passes "keep", since it is the stack walking itself.
   */
  function loadDocument(document_, options = {}) {
    const { history: historyMode = "reset" } = options;
    const { droppedCards, droppedLinks, repairedLinkIds = [] } = board.load(document_);
    if (droppedCards.length > 0) {
      log("warn", `dropped ${droppedCards.length} unreadable card(s) while loading the board`);
    }
    if (droppedLinks.length > 0) {
      log("warn", `dropped ${droppedLinks.length} link(s) that named missing cards`);
    }
    if (repairedLinkIds.length > 0) {
      const ids = repairedLinkIds.map((id) => `\`${id}\``).join(", ");
      log("warn", `renamed duplicate link id${repairedLinkIds.length === 1 ? "" : "s"} ${ids}`
        + " on load -- link ids must be unique across the board");
    }
    // Mounts are rebuilt from scratch: the document may be a different board.
    for (const [, entry] of mounted) {
      try {
        entry.destroy();
      } catch {
        /* a card that cannot clean up must still be removed */
      }
      entry.el.remove();
    }
    mounted.clear();
    linkNodes.forEach((node) => node.group.remove());
    linkNodes.clear();
    if (historyMode === "reset") {
      // What is on the board now is step zero: the first thing Ctrl+Z can take
      // back is the first edit made after this load.
      history.reset(board.serialize());
    }
    renderAll();
  }

  function mountClient() {
    client = createClient({
      origin: location.origin,
      onStatus: (state) => {
        if (!state.connected && connected) {
          connected = false;
          setStatus("connecting");
          log("warn", "the event stream dropped; reconnecting…");
          scheduleReconnect();
        }
      },
    });
    installEvents();
  }

  function scheduleReconnect() {
    if (reconnectTimer !== null) {
      return;
    }
    reconnectTimer = setTimeout(async () => {
      reconnectTimer = null;
      try {
        await boot({ quiet: true });
        reconnectDelay = 800;
      } catch {
        reconnectDelay = Math.min(reconnectDelay * 2, 8000);
        scheduleReconnect();
      }
    }, reconnectDelay);
  }

  /**
   * Connect, then load the board.  Safe to call again after a failure, which is
   * how the "kernel not reachable" state recovers without a page reload: each
   * attempt builds a fresh client, so a dead event stream is never reused and
   * its handlers cannot accumulate.
   */
  async function boot({ quiet = false } = {}) {
    setStatus("connecting");
    mountClient();
    await client.ready();
    connected = true;
    setStatus("ready");

    let loaded;
    try {
      loaded = await client.call("board.load", {});
    } catch (err) {
      connected = false;
      setStatus("unreachable");
      throw err;
    }
    // A boot is also a reload: the button and the reconnect path both land
    // here. Replacing the board the user is looking at with the older copy on
    // disk would silently discard whatever they have not saved yet, so any
    // unsaved work is flushed first. If that cannot be done, the in-memory
    // board is kept and the disk copy is left alone -- the log says which.
    let takeDiskCopy = true;
    if (dirty) {
      if (boardRevision === null) {
        takeDiskCopy = false;
        log("warn", "this board exists only in memory -- the kernel was unreachable when it"
          + " was made -- so the copy on disk was not loaded. `save force` overwrites that copy.");
      } else if (!(await saveBoard({}))) {
        takeDiskCopy = false;
        log("warn", "your unsaved board could not be written, so the copy on disk was not"
          + " loaded. The board you have is intact.");
      }
    }
    boardRevision = loaded.revision;
    if (takeDiskCopy) {
      loadDocument(loaded.document);
    }
    const stamp = await client.call("hello", {}).catch(() => null);
    if (stamp !== null && !quiet) {
      log("info", `seIDE ${stamp.kernel_version} · protocol ${stamp.protocol} · pid ${stamp.pid}`);
    }

    // Where the kernel was pointed. It is the one piece of project context that
    // is not on the board, so the project panel cannot read it from anywhere
    // else. A failure here is not fatal: the panel says so and everything else
    // works, because paths are already workspace-relative.
    workspace = await client.call("workspace.info", {}).catch(() => null);
    if (workspace !== null && !quiet) {
      log("info", `workspace ${workspace.root}`);
    }

    // The board is painted before this call answers -- cards render as soon as
    // the document loads -- so a project panel that is already on screen has
    // listed the workspace with no root to show and no ignore list to explain
    // itself with. Tell the panels that are already mounted to re-read it;
    // `renderAll()` below only paints cards that do not exist yet.
    if (workspace !== null) {
      for (const entry of mounted.values()) {
        if (entry.handle !== null && entry.handle !== undefined
            && entry.handle.kind === "project"
            && typeof entry.handle.refresh === "function") {
          entry.handle.refresh();
        }
      }
    }

    if (board.cards.length === 0) {
      // A brand-new project: one note card explains the paradigm on the board
      // itself, and is deleted like any other card. Creating it must not mark
      // the board dirty, or merely opening seIDE would write a board.json.
      const wasDirty = dirty;
      addCard("note", 80, 80, { text: HINT_TEXT }, { w: HINT_SIZE.w, h: HINT_SIZE.h });
      dirty = wasDirty;
      renderHud();
    }
    initializing = false;
    renderAll();
  }

  /* ------------------------------------------------------------------ */
  /* start                                                               */
  /* ------------------------------------------------------------------ */

  function start() {
    installGestures();
    installCommandLine();
    setStatus("connecting");

    reloadButton.addEventListener("click", () => {
      boot().catch((err) => {
        setStatus("unreachable");
        log("error", `kernel not reachable: ${err.message}`);
      });
    });

    document.addEventListener("keydown", (event) => {
      const key = event.key.toLowerCase();
      if ((event.ctrlKey || event.metaKey) && key === "s") {
        event.preventDefault();
        saveBoard({});
        return;
      }
      /*
       * Undo and redo.  A text field keeps the browser's own undo -- taking a
       * sentence back inside a note should touch the note, not the board -- so
       * this only fires when the keystroke did not land in one.  The editor and
       * note textareas stop propagation anyway; this is the belt to that
       * braces, and it also covers inputs that do not.
       */
      const typing = event.target instanceof HTMLInputElement
        || event.target instanceof HTMLTextAreaElement
        || (event.target instanceof HTMLElement && event.target.isContentEditable);
      if ((event.ctrlKey || event.metaKey) && !typing && key === "a") {
        // Ctrl+A means "all the cards" on the board and "all the text" in a
        // field; the check above is what keeps those two from fighting.
        event.preventDefault();
        const count = board.selectAll();
        log("info", count === 0 ? "no cards to select" : `selected ${count} card${count === 1 ? "" : "s"}`);
        renderCards();
        renderHud();
        return;
      }
      if (!typing && (key === "delete" || key === "backspace") && board.selectionCount > 0) {
        // Backspace would otherwise be "go back" outside a field.
        event.preventDefault();
        deleteSelection();
        return;
      }
      if ((event.ctrlKey || event.metaKey) && !typing && (key === "z" || key === "y")) {
        event.preventDefault();
        if (key === "y" || event.shiftKey) {
          redoBoard();
        } else {
          undoBoard();
        }
        return;
      }
      // `:` focuses the command line, vim-style, but only outside a text field.
      if (key === ":" && !(event.target instanceof HTMLInputElement)
        && !(event.target instanceof HTMLTextAreaElement)) {
        event.preventDefault();
        commandEl.focus();
        return;
      }
      if (key === "escape" && document.activeElement === commandEl) {
        commandEl.blur();
      }
    });

    window.addEventListener("beforeunload", (event) => {
      if (dirty) {
        event.preventDefault();
        event.returnValue = "";
      }
    });

    boot().catch((err) => {
      setStatus("unreachable");
      log("error", `kernel not reachable: ${err.message}`);
      log("warn", "the UI is up and the board stays editable. Retrying on its own; anything you"
        + " put on the board is kept in memory until the kernel comes back.");
      scheduleReconnect();
    });
    matchMedia("(prefers-reduced-motion: reduce)").matches
      ? document.body.classList.add("reduce-motion")
      : document.body.classList.add("motion");
  }

  const appApi = {
    ...app,
    board,
    start,
    boot,
    runCommand,
    log,
    window: { zoomAbout, linkPoints },
  };

  Object.defineProperty(appApi, "client", { get: () => client });
  return appApi;
}

/**
 * The browser only.  `createApp` reaches for `document` the moment it runs, so
 * the module must stay importable (and therefore testable) under Node, where
 * there is no DOM: importing it must be a no-op that exports functions.
 */
const app = typeof document === "undefined" || document.getElementById("board") === null
  ? null
  : createApp();

export { createApp };
export default app;

// The one line of boot the task allows instead of logic in index.html.
if (app !== null) {
  app.start();
}

// Keep the UI honest about which papercut we know about.
export const LIMITATIONS = [
  "Token colours are painted on a <pre> under a transparent <textarea>; the two share",
  "fixed metrics, so a font with different line heights would shear them apart.",
  "Token offsets from lang.tokenize are string indices (UTF-16 code units), so",
  "non-ASCII colours correctly; a client that counts bytes has to convert.",
  "Board chunks below MIN_SIZE (" + MIN_SIZE.w + "x" + MIN_SIZE.h + ") are clamped, and links are straight",
  "lines -- there is no router and no automatic layout.",
  "Undo is board-level and in memory: Ctrl+Z takes back board edits in this window,",
  "not the typing inside a card, and a reload forgets the steps.",
];
