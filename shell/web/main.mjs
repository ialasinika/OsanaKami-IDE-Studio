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
import { createBoard, DEFAULT_SIZE, MIN_SIZE, ZOOM_MAX, ZOOM_MIN } from "./board.mjs";
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

/* ------------------------------------------------------------------ */
/* the app                                                             */
/* ------------------------------------------------------------------ */

const STATUS_LIST = ["connecting", "ready", "unreachable"];

/** The welcome card a brand-new project gets. It is an ordinary note card. */
const HINT_SIZE = { w: 380, h: 300 };
const HINT_TEXT = [
  "Board: no tabs, no tree.",
  "",
  "Drag empty space to pan · wheel to pan · ^wheel to zoom about the cursor.",
  "Drag a card title to move it · drag its corner to resize.",
  "Double-click empty space for a note.",
  "",
  "Commands go on the line at the bottom:",
  "  open <path> · run <cmd> · files · note <text> · sheet [title]",
  "  link <from> <to> · zoom in|out|reset · focus <id> · delete <id> · save",
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
  let initializing = true;
  let connected = false;
  let autosave = true;
  let autosaveTimer = null;
  let reconnectTimer = null;
  let reconnectDelay = 800;
  let renderQueued = false;

  /** cardId -> {el, handle, destroy, card} */
  const mounted = new Map();
  /** linkId -> {group, path, label, bg} */
  const linkNodes = new Map();
  /** runId -> cardId, so exec.output finds its runner even before the reply lands */
  const runs = new Map();

  // The model is the single source of truth: anything that changes it schedules
  // one frame of redraw, so a card never paints itself.
  board.subscribe(() => scheduleRender());

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
    return new Promise((resolve) => {
      const strip = el("div", "ask");
      strip.append(el("span", "ask-text", message));
      let settled = false;
      const finish = (value) => {
        if (settled) {
          return;
        }
        settled = true;
        strip.remove();
        resolve(value);
      };
      for (const choice of choices) {
        const button = el("button", "ask-button", choice.label);
        button.type = "button";
        button.addEventListener("click", () => finish(choice.value));
        strip.append(button);
      }
      barEl.before(strip);
      // Any command-line use means the user moved on; do not leave it hanging.
      const abandon = () => finish(null);
      commandEl.addEventListener("input", abandon);
      const cleanup = () => commandEl.removeEventListener("input", abandon);
      strip.addEventListener("click", cleanup, { once: true });
    });
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
    const card = selectedCard();
    selectionEl.textContent = card === null ? "no card" : `${describeCard(card)} — ${card.id}`;
    revEl.textContent = boardRevision === null ? "unsaved" : `rev ${boardRevision}`;
    dirtyEl.textContent = dirty ? "unsaved changes" : "saved";
    dirtyEl.classList.toggle("is-dirty", dirty);
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
      node.classList.toggle("is-selected", card.id === board.selectedId);
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

  function boardTouched(isDirty = true) {
    if (isDirty) {
      dirty = true;
    }
    renderHud();
    if (isDirty && autosave && !initializing) {
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

  async function saveBoard({ force = false, auto = false } = {}) {
    if (client === null || saving) {
      return false;
    }
    if (!force && boardRevision !== null && !dirty) {
      return true;
    }
    saving = true;
    if (!auto) {
      log("info", "saving board…");
    }
    try {
      const params = { document: board.serialize() };
      if (force) {
        // Re-read the current revision so the kernel accepts the overwrite.
        try {
          const fresh = await client.call("board.load", {});
          params.base_revision = fresh.revision;
          boardRevision = fresh.revision;
        } catch {
          /* fall through: saves without a base_revision are allowed */
        }
      } else if (boardRevision !== null) {
        params.base_revision = boardRevision;
      }
      const result = await client.call("board.save", params);
      boardRevision = result.revision;
      dirty = false;
      renderHud();
      if (!auto) {
        log("info", `board saved (rev ${result.revision}) → .seide/board.json`);
      }
      return true;
    } catch (err) {
      if (isStaleRevision(err)) {
        const current = staleCurrentRevision(err);
        dirty = true;
        renderHud();
        log("warn", `the board changed on disk (rev ${current}). Your layout is kept in memory;`
          + " type `save force` to overwrite it.");
      } else {
        log("error", `board.save failed: ${err.message}`);
      }
      return false;
    } finally {
      saving = false;
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

  function deleteCard(id) {
    const entry = mounted.get(id);
    if (entry !== undefined && entry.handle.dirty) {
      log("warn", `card ${id} has unsaved text; saving is not implicit — use ^S in the card first`);
    }
    if (!board.removeCard(id)) {
      log("warn", `no card ${id}`);
      return false;
    }
    renderCards();
    renderLinks();
    boardTouched();
    return true;
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

  function openFile(path, options = {}) {
    if (typeof path !== "string" || path.trim() === "") {
      log("warn", "open: give a workspace-relative path");
      return null;
    }
    const wanted = path.trim().replace(/\\/g, "/");
    for (const entry of mounted.values()) {
      if (entry.handle.kind === "editor" && entry.handle.hasPath && entry.handle.hasPath(wanted)) {
        focusCard(entry.card.id);
        centreOn(entry.card);
        return entry.card;
      }
    }
    const centre = options.at || centreWorld();
    const size = { w: 680, h: 460 };
    return addCard("editor", Math.round(centre.x - size.w / 2), Math.round(centre.y - size.h / 2), {
      file: wanted,
    }, size);
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
   *   empty space  -> pan
   *   card         -> focus + raise
   *   card-title   -> move
   *   grip         -> resize
   */
  function installGestures() {
    let gesture = null;

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
      const zoom = board.viewport.zoom;

      if (cardNode === null) {
        gesture = { kind: "pan", startX: board.viewport.x, startY: board.viewport.y, px: event.clientX, py: event.clientY };
        board.setSelection(null);
        renderCards();
        renderHud();
      } else {
        const card = board.findCard(cardNode.dataset.cardId);
        if (card === null) {
          return;
        }
        board.setSelection(card.id);
        board.raiseCard(card.id);
        if (role === "card-title") {
          const world = screenToWorld(event.clientX, event.clientY);
          gesture = { kind: "move", card, dx: world.x - card.x, dy: world.y - card.y };
        } else if (role === "grip") {
          const world = screenToWorld(event.clientX, event.clientY);
          gesture = { kind: "resize", card, dx: world.x - card.x, dy: world.y - card.y };
        } else {
          gesture = { kind: "focus", card };
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
      } else if (gesture.kind === "move") {
        const world = screenToWorld(event.clientX, event.clientY);
        board.moveCard(gesture.card.id, Math.round(world.x - gesture.dx), Math.round(world.y - gesture.dy));
      } else if (gesture.kind === "resize") {
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
      if (gesture.kind === "move" || gesture.kind === "resize") {
        boardTouched();
      }
      if (boardEl.hasPointerCapture && boardEl.hasPointerCapture(event.pointerId)) {
        boardEl.releasePointerCapture(event.pointerId);
      }
      gesture = null;
    };
    boardEl.addEventListener("pointerup", endGesture);
    boardEl.addEventListener("pointercancel", endGesture);

    // Wheel: plain scroll pans, ctrl/⌘ or the wheel alone with shift zooms about
    // the cursor.  Zooming about the cursor is what makes a 2-D board feel solid.
    boardEl.addEventListener("wheel", (event) => {
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
    "open", "note", "run", "files", "link", "unlink", "zoom", "focus",
    "delete", "save", "help", "clear",
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
        const id = arg(0) !== undefined ? arg(0) : board.selectedId;
        if (id === null || id === undefined) {
          log("warn", "usage: delete <id> (or select a card first)");
          return;
        }
        deleteCard(id);
        return;
      }
      case "save": {
        await saveBoard({ force: arg(0) === "force" });
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

  function loadDocument(document_) {
    const { droppedCards, droppedLinks } = board.load(document_);
    if (droppedCards.length > 0) {
      log("warn", `dropped ${droppedCards.length} unreadable card(s) while loading the board`);
    }
    if (droppedLinks.length > 0) {
      log("warn", `dropped ${droppedLinks.length} link(s) that named missing cards`);
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
    boardRevision = loaded.revision;
    loadDocument(loaded.document);
    const stamp = await client.call("hello", {}).catch(() => null);
    if (stamp !== null && !quiet) {
      log("info", `seIDE ${stamp.kernel_version} · protocol ${stamp.protocol} · pid ${stamp.pid}`);
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
      log("warn", "the UI is up and the board stays editable; nothing is lost. It retries on its own.");
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
  "Byte offsets from lang.tokenize are treated as string indices, which is only the",
  "same thing for ASCII. Non-ASCII in a card can shift a colour by a few glyphs.",
  "Board chunks below MIN_SIZE (" + MIN_SIZE.w + "x" + MIN_SIZE.h + ") are clamped, and links are straight",
  "lines -- there is no router and no automatic layout.",
];
