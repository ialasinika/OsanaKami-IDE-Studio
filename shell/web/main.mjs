/**
 * main.mjs -- the only file that knows about the whole app.
 *
 * DELETE THIS FILE and `index.html` has nothing to boot; every other module in
 * `shell/web/` stays importable on its own.  It is the wiring layer:
 *
 *   rpc.mjs    talks to the kernel            (transport)
 *   board.mjs  holds the document             (model)
 *   cards.mjs  renders one kind of card       (view)
 *   main.mjs   the tile, the command line, status (control)
 *
 * There is one document -- the cards and what is written in them -- and there
 * are two ways to look at it: the classic tile (a sidebar, a tab strip, a code
 * area) and the mod tile (a package tree, code, and the problems that go with
 * it).  Both are the same cards in the same document, so switching views cannot
 * lose an edit.  There is no canvas that draws every card exactly where the
 * document put it, and nothing here pans, zooms or saves a viewport.
 *
 * A tile is arithmetic, not a transform: classic.mjs and modview.mjs compute a
 * rectangle per card, this file measures those against `#board` and writes each
 * card's position from the numbers.  The document is therefore in pixels of the
 * board box, and a card's own `x`/`y` are its place in the tile.
 *
 * Nothing here uses `eval`, inline `on*=` attributes, external URLs or a build
 * step; the browser loads these ES modules as written.
 */

import { createClient, isStaleRevision, staleCurrentRevision } from "./rpc.mjs";
import { BOARD_PATH, createBoard, DEFAULT_SIZE, MIN_SIZE } from "./board.mjs";
import { createHistory } from "./history.mjs";
import { classicLayout, classicNeighbourAfterClose, classicTabLabel } from "./classic.mjs";
import { modLayout } from "./modview.mjs";
import {
  SWITCH_VIEWS,
  VIEWS,
  VIEW_LABELS,
  VIEW_TITLES,
  viewAbout,
  viewName,
  viewNote,
} from "./views.mjs";
import {
  WATCH_GONE,
  WATCH_POLL_MAX,
  WATCH_POLL_MIN,
  WATCH_POLL_MS,
  WATCH_RELOAD,
  WATCH_WARN,
  watchDecision,
  watchReport,
  watchTrimmed,
} from "./watch.mjs";
import {
  COMMAND_HELP,
  PIXEL_NEW_SIZE,
  describeCard,
  emptySheet,
  parseCommandLine,
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
  // Escape is "cancel", the same answer as typing something else: the question
  // is a strip over the board, so the key that dismisses every transient thing
  // in the window has to dismiss it too.  Both the strip (where the focus
  // starts, on the cancel button) and the command line (which keeps the
  // keyboard) are listened to, because either can be focused while it is open.
  const onKey = (event) => {
    if (event.key === "Escape") {
      event.preventDefault();
      finish(null);
    }
  };
  abandonSource.addEventListener("input", abandon);
  abandonSource.addEventListener("keydown", onKey);
  if (typeof strip.addEventListener === "function") {
    strip.addEventListener("keydown", onKey);
  }
  unbind = () => {
    abandonSource.removeEventListener("input", abandon);
    abandonSource.removeEventListener("keydown", onKey);
    if (typeof strip.removeEventListener === "function") {
      strip.removeEventListener("keydown", onKey);
    }
  };

  for (const { el: button, value } of buttons) {
    button.addEventListener("click", () => finish(value));
  }
  return promise;
}

/**
 * Should closing this card ask first, and with which answers?
 *
 * A clean card has nothing to lose: closing it is immediate, exactly as it was
 * before the question existed.  A card holding unsaved text is the one case
 * where the close would destroy something the user cannot get back, so it asks
 * -- and offers "save and close" only when the card can actually save itself
 * (an editor can, a docs card cannot).  Escape is wired by `wireChoiceStrip`,
 * and the strip is not a dialog: this app has no dialogs.
 *
 * Pure, so the rule rather than the question is what the checks pin.
 *
 * @param {object|null} handle  the card's mounted handle, or null
 * @returns {{ask: boolean, choices: Array<{label: string, value: string}>}}
 */
export function closePlan(handle) {
  const dirty = handle !== null && handle !== undefined && handle.dirty === true;
  if (!dirty) {
    return { ask: false, choices: [] };
  }
  const choices = [];
  if (typeof handle.save === "function") {
    choices.push({ label: "保存并关闭", value: "save" });
  }
  choices.push({ label: "不保存，关闭", value: "discard" });
  choices.push({ label: "取消", value: "cancel" });
  return { ask: true, choices };
}

/**
 * What an answer to `closePlan` means for the card.
 *
 * `saved` is consulted only for "save": `null` means the save has not run yet
 * (the caller is being told to run it first), `true` means it finished, and
 * `false` means it threw -- the card then stays, with the unsaved text still in
 * it.  "cancel", Escape and `null` (the user turned to the command line) all
 * mean keep.  A plan that did not ask was already decided: delete.
 *
 * @returns {"delete"|"keep"|"saveThenDelete"|"saveFailed"}
 */
export function applyCloseAnswer(plan, answer, saved = null) {
  if (plan === null || plan === undefined || plan.ask !== true) {
    return "delete";
  }
  if (answer === "discard") {
    return "delete";
  }
  if (answer === "save") {
    if (saved === true) {
      return "delete";
    }
    return saved === false ? "saveFailed" : "saveThenDelete";
  }
  return "keep";
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
      return { level: "info", text: `board saved (rev ${revision}) → ${BOARD_PATH}${tail}` };
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
        text: `save refused the ${force ? "forced overwrite" : "write"}${detail === "" ? "" : `: ${detail}`}`,
      };
    case "failed":
      return { level: "error", text: `save failed${detail === "" ? "" : `: ${detail}`}` };
    case "offline":
      return { level: "error", text: "save skipped: no kernel connection" };
    default:
      return null;
  }
}

/* ------------------------------------------------------------------ */
/* the window's boot view and the events that move it                 */
/* ------------------------------------------------------------------ */

/**
 * The view a window opens in.
 *
 * Deliberately not `views.mjs`'s `DEFAULT_VIEW`: that constant is the
 * *fallback* for a word that names no view (`mode board` still has to print
 * something), and the decision that a window opens on the mod view is about the
 * window, not about what a typo should say.  `mode classic` still moves a
 * window to the other tile.
 */
export const BOOT_VIEW = "mod";

/**
 * The preferences a window may act on at boot, out of a `config.get` answer.
 *
 * The shell owns the file and validates it; this function only decides what the
 * *window* can honour without a restart: the view it opens in and how often the
 * cards poll.  Anything else the answer carries -- the AI provider, the
 * workspace, the file paths -- belongs to whoever asked the question, not to a
 * page paint.  An answer that is missing, partial or out of range falls back to
 * the constants this file was built with, so a corrupt preference file can
 * never leave a window with no view at all.
 *
 * Exported and pure so the fallback rules are testable without a browser.
 *
 * @param {unknown} answer  a `config.get` result, or null when the call failed
 * @returns {{bootView: string, watchPollMs: number}}
 */
export function bootPreferencesFrom(answer) {
  const fallback = { bootView: BOOT_VIEW, watchPollMs: null };
  if (answer === null || typeof answer !== "object") {
    return fallback;
  }
  const prefs = answer.prefs;
  if (prefs === null || typeof prefs !== "object") {
    return fallback;
  }
  const view = typeof prefs.bootView === "string" && SWITCH_VIEWS.includes(prefs.bootView)
    ? prefs.bootView
    : BOOT_VIEW;
  const poll = Number.isInteger(prefs.watchPollMs)
    && prefs.watchPollMs >= WATCH_POLL_MIN && prefs.watchPollMs <= WATCH_POLL_MAX
    ? prefs.watchPollMs
    : null;
  return { bootView: view, watchPollMs: poll };
}

/**
 * What one `view.changed` revision means now that the save it may belong to has
 * settled.  `revision` is the event's revision, `boardRevision` the revision of
 * the document on the board (`null` before the first load) and `dirty` whether
 * the board has edits the disk copy does not have.
 *
 * "echo" is our own write coming back.  The kernel notifies *before* it answers
 * the write (core/src/rpc.c), so the page sees that event while `saving` is
 * still true and `boardRevision`/`dirty` still describe the document before the
 * write.  The caller therefore queues events while a save is in flight and asks
 * this function only after the reply has updated both values; without the queue
 * every autosave's own echo was read as another writer's edit and warned.
 */
export function classifyViewEvent({ revision, boardRevision, dirty }) {
  if (revision === boardRevision) return "echo";
  return dirty ? "warn" : "adopt";
}

/**
 * The mod directory a `?mod=` boot asks for, or null when the URL names none.
 *
 * This is how the File menu's "新建模组" hands its result to the window: the
 * Electron main process reloads the page with `?mod=<absolute path>`, and the
 * page opens that package on its mod card.  `search` is `location.search`
 * ("?mod=...", leading `?` included); a blank value is the same as absent.
 */
export function requestedModFromSearch(search) {
  if (typeof search !== "string" || search === "") return null;
  const value = new URLSearchParams(search).get("mod");
  if (typeof value !== "string") return null;
  const dir = value.trim();
  return dir === "" ? null : dir;
}

/* ------------------------------------------------------------------ */
/* the app                                                             */
/* ------------------------------------------------------------------ */

const STATUS_LIST = ["connecting", "ready", "unreachable"];

/** The welcome card a brand-new project gets. It is an ordinary note card. */
const HINT_SIZE = { w: 380, h: 340 };
const HINT_TEXT = [
  "One document, two ways to look at it.",
  "",
  "This is the mod view: the package on the left, the code in the middle, the",
  "problems it reports underneath.  `mode classic` shows the same cards as a",
  "sidebar, a tab strip and a code area.",
  "Neither view is saved anywhere — switching is free.",
  "Ctrl+Z takes back a board edit, Ctrl+Shift+Z puts it back.  In a text field",
  "those keys undo the typing, as they do anywhere else.",
  "",
  "游戏 Mod 面板 / Mod surfaces:",
  "  story <path.yarn> [translation.csv] [commands.json]  edit a story, its",
  "                  translations and the commands its own schema allows",
  "  mod <dir>       open a mod package (defines, Yarn, sprites)",
  "  problems <dir>  validate it; click a row to open the file",
  "  docs [query]    search the game's own 136 commands / 63 functions",
  "",
  "Commands go on the line at the bottom:",
  "  open <path> · run <cmd> · files · note <text> · sheet [title]",
  "  project [glob] · link <from> <to> · focus <id>",
  "  delete <id> · undo · redo · save · mode classic|mod",
  "",
  "This arrangement is saved in .infantgod/board.json, not a tab history.",
  "Delete this card once it has told you what you need (`delete` on it).",
].join("\n");

function createApp() {
  /* -- elements -- */
  const boardEl = $("board");
  const cardsEl = $("cards");
  const emptyEl = $("empty-state");
  const statusEl = $("kernel-status");
  const selectionEl = $("hud-selection");
  const revEl = $("hud-revision");
  const dirtyEl = $("hud-dirty");
  const logEl = $("log");
  const logToggle = $("log-toggle");
  const barEl = $("bar");
  const commandEl = $("command");
  const hintEl = $("command-hint");
  const reloadButton = $("reload-board");
  const tabsEl = $("tabs");
  const sideHintEl = $("side-hint");
  const modeSwitch = $("mode-switch");
  /* One button per view the switch offers, built from the registry rather than
     written out, so a view added to `SWITCH_VIEWS` cannot be missing from the
     switch.  A switch and not a cycle: with two views a single button that
     "names the next one" makes the reader work out an order that is not part of
     the document. */
  const modeButtons = SWITCH_VIEWS.map((name) => {
    const button = el("button", "hud-switch-button", VIEW_LABELS[name]);
    button.type = "button";
    button.dataset.view = name;
    button.title = VIEW_TITLES[name];
    button.setAttribute("aria-pressed", name === BOOT_VIEW ? "true" : "false");
    modeSwitch.append(button);
    return button;
  });

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
  /* Which of the two views is on screen: "classic" or "mod".  Never part of the
     *document* -- the document is the cards, and a view stored inside board.json
     would make the file describe how it is looked at.  A preference file may
     name the view a window opens in (G48), which is the one place this value
     comes from anywhere but this process; a reload with no preference still
     starts in `BOOT_VIEW` (the mod view). */
  let viewMode = BOOT_VIEW;
  /* Revisions the kernel announced while a save was in flight.  They cannot be
     classified until the reply to that save has updated `boardRevision` and
     `dirty` -- the kernel notifies before it answers, so classifying on arrival
     reads our own echo as another writer.  Drained in `saveBoard`'s `finally`. */
  let queuedViewRevisions = [];
  /* A `?mod=` boot is handled once per page: a reconnect boots again, and
     re-opening the same package would dirty the board for nothing. */
  let requestedModHandled = false;
  /* The view's class on `<body>` is the stylesheet's half of the switch, and a
     window opens *in* a view: it is painted here, before anything is drawn, not
     only when a switch changes it.  `setView` returns early when the mode asked
     for is the one already on, which is exactly what a boot would ask. */
  paintView();
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
  /** runId -> cardId, so exec.output finds its runner even before the reply lands */
  const runs = new Map();

  // The model is the single source of truth: anything that changes it schedules
  // one frame of redraw, so a card never paints itself.
  board.subscribe(() => scheduleRender());

  /**
   * The set of *open editors* is a second, smaller source of truth: cards that
   * need it (the project panel) hear about it here.  It is deliberately not
   * "the board changed" -- the document changes on every keystroke and every
   * render, and a listener that re-listed the workspace would do so on each one.
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

  /* The strip is where every refusal, warning and unknown command lands -- the
     whole of OsanaKami IDE Studio's dialog system -- and it starts closed.  A window is
     for writing, and 132px of mostly-routine chatter along the bottom of it is
     132px nobody asked for.  The price of closing it is that "closed" has to be
     able to say "something happened", which is what the HUD button does.  It is
     not a notification system: the button counts lines and remembers the worst
     level, nothing per-message, because the strip itself is one click away. */
  let logOpen = false;
  let logUnseen = 0;
  let logWorst = "info";
  /* Boot is the window saying it started -- version, protocol, workspace, the
     board it read -- not news.  Until it finishes, the strip stays out of the
     way and the button counts nothing, or every window would open on `log · 4`
     with nothing in it worth reading. */
  let logSettled = false;

  const LOG_LEVELS = ["info", "warn", "error"];

  function paintLogToggle() {
    const worst = LOG_LEVELS.indexOf(logWorst);
    logToggle.textContent = logOpen || logUnseen === 0 ? "log" : `log · ${logUnseen}`;
    logToggle.setAttribute("aria-expanded", logOpen ? "true" : "false");
    logToggle.classList.toggle("is-hot", !logOpen && worst >= 1);
    logToggle.classList.toggle("is-error", !logOpen && worst >= 2);
    logToggle.title = logOpen
      ? "hide the message strip"
      : logUnseen === 0
        ? "messages — nothing new"
        : `${logUnseen} message${logUnseen === 1 ? "" : "s"} since you last looked`;
  }

  /**
   * Open or close the message strip.
   *
   * Opening it is also how you acknowledge it: the count and the colour are
   * about what arrived while it was shut, so they clear the moment it is read.
   */
  function showLog(open) {
    logOpen = open;
    logEl.hidden = !open;
    if (open) {
      logUnseen = 0;
      logWorst = "info";
      logEl.scrollTop = logEl.scrollHeight;
    }
    paintLogToggle();
  }

  /**
   * The window has finished starting, so the strip's count starts from here.
   *
   * Called at the end of `boot()`, which is what emits the banner the count
   * would otherwise include.  Nothing else clears it: from here on, a line that
   * arrives while the strip is shut is a line somebody has not read.
   */
  function settleLog() {
    logSettled = true;
    logUnseen = 0;
    logWorst = "info";
    paintLogToggle();
  }

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
    if (level === "error") {
      // A failure is the one thing that must not wait to be noticed, whether or
      // not the window has finished starting.
      showLog(true);
    } else if (logSettled && !logOpen) {
      logUnseen += 1;
      if (LOG_LEVELS.indexOf(level) > LOG_LEVELS.indexOf(logWorst)) {
        logWorst = level;
      }
      paintLogToggle();
    }
    return line;
  }

  /**
   * An inline choice strip above the command line.
   *
   * Returns a promise that resolves with the chosen value, or `null` if the
   * user typed something else into the command line first.  Deliberately not a
   * modal: OsanaKami IDE Studio has no dialogs, so a decision is a row of buttons on the board.
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
    // The focus starts on "cancel", not on the first button: closing is the
    // destructive half and nothing destructive may be one Enter away by
    // accident.  Keyboard users reach the other answers with Tab/Shift+Tab
    // (they are real buttons); the command line keeps working as the escape
    // hatch it already was.
    const focusFirst = buttons.filter((button) => button.value === "cancel").pop()
      || buttons[buttons.length - 1];
    if (focusFirst !== undefined) {
      focusFirst.el.focus();
    }
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
    // The layout is computed once per frame and handed to everything that draws
    // from it; the cards and the chrome can never disagree about where the code
    // area is, and the mode is one string read by all of them.
    const layout = currentLayout();
    renderCards(layout);
    renderHud();
    renderTabs(layout);
    renderSideHint(layout);
  }

  /**
   * Paint the view's class on `<body>` -- the stylesheet's half of the switch.
   *
   * Separate from `setView` because it is not a transition: the first paint of a
   * window is already in a view, and `setView` refuses to act when the mode it is
   * handed is the one already on.
   */
  function paintView() {
    document.body.classList.toggle("is-classic", viewMode === "classic");
    document.body.classList.toggle("is-mod", viewMode === "mod");
  }

  /**
   * Switch between the classic view and the mod view.
   *
   * The whole transition is one class on `<body>` (the stylesheet's switch) plus
   * a render: no card is mounted, unmounted or moved in the document, so nothing
   * can be lost on the way.  Returns the mode it ended in.
   */
  function setView(mode) {
    if (VIEWS.indexOf(mode) === -1) {
      return viewMode;
    }
    if (mode === viewMode) {
      return viewMode;
    }
    viewMode = mode;
    paintView();
    renderAll();
    return viewMode;
  }

  /**
   * How big the board element is, in its own pixels.
   *
   * `getBoundingClientRect` is the only measurement this file trusts, and the
   * classic view needs it on every render -- a window resize, a card opening
   * and a mode change all have to re-tile.  Falls back to zero rather than NaN:
   * a hidden board (the empty state) measures 0x0 and every rectangle from that
   * is empty, which is the truthful answer.
   */
  function boardPixelSize() {
    const rect = boardEl.getBoundingClientRect();
    return { width: Math.max(0, Math.round(rect.width)), height: Math.max(0, Math.round(rect.height)) };
  }

  /** How much of the board the floating HUD covers along its top edge. */
  function hudHeight() {
    const rect = $("hud").getBoundingClientRect();
    return Math.max(0, Math.round(rect.height));
  }

  /**
   * The layout the current view is drawing right now.
   *
   * Both tiles take the same two arguments and return the same shape, so
   * everything downstream -- `renderCards`, `renderTabs`, `renderSideHint` --
   * works without knowing which view asked for it.  `viewMode` is only ever a
   * name in `VIEWS`, and both of those are tiles, so this always has an answer.
   */
  function currentLayout() {
    const box = boardPixelSize();
    const options = { activeId: board.selectedId, top: hudHeight() };
    return viewMode === "mod"
      ? modLayout(board.cards, box, options)
      : classicLayout(board.cards, box, options);
  }

  /**
   * The tab strip: one tab per open card, in board order.
   *
   * A tab for *every* card the current tile does not draw elsewhere -- not just
   * editors.  The canvas could show every card at once; a tile cannot, so the
   * strip is what keeps a note, a runner, a sheet, a pixel card, a story card, a
   * docs card or the report reachable (G29).  The tab is the card's handle:
   * pressing it selects the card, and both tiles put the selection in the area.
   *
   * Each tab is a container with two real `<button>`s: the name (which selects
   * the card, so tab/enter/space work without a key handler of ours) and a close
   * control.  A button inside a button is not HTML, and the close control has to
   * be its own tab stop -- an unfocusable span would make closing keyboard-only
   * in theory and impossible in practice.  Every close path (the x, a middle
   * click, Ctrl+W) funnels through `closeTab`, which calls the card's own
   * `app.closeCard`: one way to take a card off the board, not two.
   *
   * Rebuilt rather than diffed.  There can be as many tabs as there are open
   * cards and each is a dozen nodes, so a diff would be more code than it saves;
   * what matters is that it is rebuilt from `board.cards` and not kept as a
   * second list that could go stale.  A path that is dirty gets a dot, which is
   * the same fact the card's own status line shows.
   */
  function renderTabs(layout) {
    const roles = layout.roles;
    tabsEl.hidden = roles.tabs.length === 0;
    if (tabsEl.hidden) {
      tabsEl.replaceChildren();
      return;
    }

    tabsEl.style.left = `${layout.tabs.x}px`;
    tabsEl.style.top = `${layout.tabs.y}px`;
    tabsEl.style.width = `${layout.tabs.w}px`;
    tabsEl.style.height = `${layout.tabs.h}px`;

    const tabs = [];
    for (const id of roles.tabs) {
      const card = board.findCard(id);
      const entry = mounted.get(id);
      const path = entry && entry.handle && entry.handle.path ? entry.handle.path : "";
      const label = classicTabLabel(path) || describeCard(card);
      const tab = el("div", "tab");
      // The id lives on the container, not on the open button: a press anywhere
      // on the tab (its padding included) selects the card, and the close button
      // next to it stays a separate control inside that container.
      tab.dataset.cardId = id;
      tab.dataset.kind = card === null || card === undefined ? "" : card.kind;
      if (id === roles.area) {
        tab.classList.add("is-active");
        tab.setAttribute("aria-current", "true");
      }

      const open = el("button", "tab-open");
      open.type = "button";
      open.append(el("span", "tab-name", label));
      if (entry && entry.handle && entry.handle.dirty) {
        open.append(el("span", "tab-dirty", "•"));
      }
      open.title = path === "" ? describeCard(card) : path;
      open.setAttribute("aria-label", path === "" ? describeCard(card) : path);

      const close = el("button", "tab-close", "×");
      close.type = "button";
      close.dataset.closeId = id;
      close.title = `close ${label} (Ctrl+W)`;
      close.setAttribute("aria-label", `close ${label}`);

      tab.append(open, close);
      tabs.push(tab);
    }
    tabsEl.replaceChildren(...tabs);
  }

  /* Where the keyboard lands after a tab press: the card the tab opened, by its
   * own focus if it has one, else the card root.  `tabIndex = -1` on every root
   * is what makes the second step possible. */
  function focusCardNode(id) {
    const entry = mounted.get(id);
    if (entry === undefined) {
      return;
    }
    if (entry.handle && typeof entry.handle.focus === "function") {
      // A card with no focused control (the empty-state hint, a docs card) has
      // a focus() that is deliberately a no-op; check the result instead of
      // trusting the call.
      entry.handle.focus();
    }
    if (!focusLanded(entry.el)) {
      entry.el.focus();
    }
  }

  /** Did the focus land on or inside `node`?  Guards for a missing DOM too. */
  function focusLanded(node) {
    const active = typeof document === "undefined" ? null : document.activeElement;
    if (active === null || active === undefined) {
      return false;
    }
    if (active === node) {
      return true;
    }
    return typeof node.contains === "function" && node.contains(active);
  }

  /** Pressing a tab: select the card, re-tile (so it is in the area), then focus. */
  function selectTab(id) {
    if (board.findCard(id) === null) {
      return false;
    }
    board.setSelection(id);
    // Render before focusing: the handler used to focus first, while the card
    // was still `display: none` from the previous arrangement, and focus() on a
    // hidden element does nothing -- the keyboard stayed on the old card.
    renderAll();
    notifyShown(id);
    focusCardNode(id);
    return true;
  }

  /**
   * Close a tab.
   *
   * Everything about *how* a close happens -- the question for unsaved text, the
   * removal, the neighbour that takes the selection -- is `app.closeCard`, so the
   * three strip gestures (x, middle click, Ctrl+W) and the card's own close
   * cannot drift apart.  This wrapper only refuses an id the strip is not
   * actually showing.
   */
  async function closeTab(id) {
    if (id === null || id === undefined) {
      return false;
    }
    if (currentLayout().roles.tabs.indexOf(id) === -1) {
      log("warn", "that card is not a tab of this view, so there is no tab to close");
      return false;
    }
    return appApi.closeCard(id);
  }

  /** What stands in the sidebar column when no card can. */
  function renderSideHint(layout) {
    const missing = layout.sidebar === null;
    // A tile with no sidebar card has no column to stand in: `layout.tabs.x` is
    // 0, and advice laid out in a zero-width box is not a hint, it is a smear of
    // clipped words -- which is what the classic view drew, whose sidebar is the
    // optional one.  There the hint becomes a notice over the code area instead,
    // and a notice over the code is only worth its cost when there is no code
    // under it yet: an empty tile explaining how to fill it, not a banner
    // covering the first two lines of the file you just opened.
    const columnWidth = Math.max(0, layout.tabs.x);
    const overlay = columnWidth === 0;
    sideHintEl.hidden = !missing || (overlay && layout.roles.area !== null);
    if (sideHintEl.hidden) {
      return;
    }
    // Each tile names the card it wanted, because "no project card" is the wrong
    // advice to give someone who opened the mod view to look at a mod.
    sideHintEl.textContent = viewMode === "mod"
      ? "no mod card: `mod <dir>` puts the package here"
      : "no project card: `project` puts the workspace here";
    // The column is where the sidebar card would have been: from the HUD down,
    // to the bottom of the tile.  `panel` only exists in the mod view, and when
    // it does it -- not the code area -- is what reaches the bottom edge.
    const top = layout.tabs.y;
    const bottom = layout.panel ? layout.panel.y + layout.panel.h : layout.area.y + layout.area.h;
    sideHintEl.classList.toggle("is-notice", overlay);
    sideHintEl.style.left = "0px";
    if (!overlay) {
      sideHintEl.style.top = `${top}px`;
      sideHintEl.style.width = `${columnWidth}px`;
      sideHintEl.style.height = `${Math.max(0, bottom - top)}px`;
    } else {
      // Below the tab strip, not over it: with no sidebar card the tabs start at
      // the tile's left edge, so a notice at `top` would cover the very tab the
      // code it covers is in.  A tile with nothing open has no strip to clear.
      sideHintEl.style.top = `${tabsEl.hidden ? top : top + layout.tabs.h}px`;
      sideHintEl.style.width = `${Math.min(280, Math.max(180, Math.round(layout.tabs.w * 0.3)))}px`;
      sideHintEl.style.height = "auto";
    }
  }

  function renderHud() {
    const card = selectedCard();
    selectionEl.textContent = card === null ? "no card" : `${describeCard(card)} — ${card.id}`;
    revEl.textContent = boardRevision === null ? "unsaved" : `rev ${boardRevision}`;
    dirtyEl.textContent = dirty ? "unsaved changes" : "saved";
    dirtyEl.classList.toggle("is-dirty", dirty);
    for (const button of modeButtons) {
      const current = button.dataset.view === viewMode;
      button.classList.toggle("is-current", current);
      button.setAttribute("aria-pressed", current ? "true" : "false");
    }
  }

  /**
   * Paint the cards, each one from its rectangle in the current tile.
   *
   * `layout` is the arrangement to draw; the default is "work it out from where
   * we are now", which is what the many callers inside gestures and commands
   * want.  `renderAll` passes its own layout so the cards and the chrome are
   * always drawn from one measurement.
   */
  function renderCards(layout = currentLayout()) {
    const seen = new Set();

    for (const card of board.cards) {
      seen.add(card.id);
      let entry = mounted.get(card.id);
      if (entry === undefined) {
        const node = renderCard(card, { client, app });
        node.el.style.width = `${card.w}px`;
        node.el.style.height = `${card.h}px`;
        node.el.dataset.kind = card.kind;
        // Programmatically focusable, not a tab stop of its own: the strip is
        // the keyboard's way in, and after a tab press the card it opened has
        // to be able to take the focus.  A card root without this can be shown
        // but never focused, which is half of being unreachable.
        node.el.tabIndex = -1;
        entry = { ...node, card };
        mounted.set(card.id, entry);
        cardsEl.append(node.el);
      }
      entry.card = card;
      const node = entry.el;
      // A card the current tile has no place for is hidden, never removed: its
      // unsaved text, its scroll position and its listeners survive the card
      // being out of the arrangement and back.  `box === undefined` is exactly
      // "this tile does not draw it".
      const box = layout.boxes.get(card.id);
      node.classList.toggle("is-hidden", box === undefined);
      if (box !== undefined) {
        node.style.transform = `translate(${box.x}px, ${box.y}px)`;
        node.style.width = `${box.w}px`;
        node.style.height = `${box.h}px`;
      }
      // z-index only orders hit-testing and shadows; positions are the tile's.
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

  /* ------------------------------------------------------------------ */
  /* board mutations                                                     */
  /* ------------------------------------------------------------------ */

  /**
   * Something changed the board.  `detail.record` false means it is worth
   * saving but not worth an undo step (raising a card to the front is a
   * consequence of clicking it, not an edit anybody wants to take back).
   */
  function boardTouched(isDirty = true, detail = {}) {
    if (isDirty) {
      dirty = true;
      boardGeneration += 1;
      if (detail.record !== false && !applyingHistory) {
        // `history.record` copies what it is given, so this is safe to call on
        // every edit.
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
   * `loadDocument` an external reload uses, so cards are mounted and the HUD
   * repainted exactly as they are for any other load; the only difference is
   * that history is left alone and the result is marked dirty, because the
   * board on screen and the board on disk now differ.
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
      const params = { path: BOARD_PATH, document: document_ };
      if (force) {
        // Re-read the current revision so the kernel accepts the overwrite.
        try {
          const fresh = await client.call("view.load", { path: BOARD_PATH });
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
      const result = await client.call("view.save", params);
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
      // Now that the reply has updated `boardRevision`/`dirty`, the events that
      // arrived while this write was in flight can be told apart: our own echo
      // compares equal, another writer does not (D3's race).
      settleQueuedViewChanges();
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

  /**
   * The Electron main process asks for this before it reloads the window: a
   * reload started from the main process is decided before the old page can
   * answer `beforeunload`, so the page exposes the save itself.  It answers
   * `{status}`; the caller logs "failed", and the reload still happens -- the
   * mod the user just created has to be shown.
   */
  async function flushBoard() {
    for (let attempt = 0; attempt < 20; attempt += 1) {
      if (!dirty) {
        return { status: "clean" };
      }
      if (saving) {
        // A save is already running; its own `finally` clears `saving`.
        await new Promise((resolve) => setTimeout(resolve, 25));
        continue;
      }
      if (await saveBoard({})) {
        return { status: "saved" };
      }
      return { status: "failed", detail: "the log says why the board could not be written" };
    }
    return { status: "failed", detail: "a save was still in flight" };
  }

  if (typeof window !== "undefined") {
    window.__infantgodFlushBoard = flushBoard;
  }

  /**
   * Where a new card is dropped.
   *
   * It used to be the middle of what the board was showing, because a card's
   * place in the world was something the user chose.  There is no world any
   * more: a tile computes every rectangle itself, so this is only the *document*
   * position a new card starts with.  Two things still matter: the value has to
   * be numeric, because `board.mjs` refuses a card without a numeric x/y, and
   * two cards dropped one after another must not land on the same pixel -- that
   * is what a reader would see as one card.
   *
   * So it walks a short cascade, one step across per card and a new row every
   * sixth, which is bounded in x, grows in y and never repeats a point.
   */
  function centreWorld() {
    const n = board.cards.length;
    return { x: 160 + (n % 6) * 90, y: 140 + Math.floor(n / 6) * 80 };
  }

  function addCard(kind, x, y, fields = {}, geometry = {}) {
    const card = board.addCard(kind, x, y, fields, geometry);
    renderCards();
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
    notifyShown(id);
    return true;
  }

  /** Take a card off the board, no question asked: the bottom of every close. */
  function removeCardNow(id) {
    if (!board.removeCard(id)) {
      log("warn", `no card ${id}`);
      return false;
    }
    renderCards();
    boardTouched();
    return true;
  }

  /** What a question about this card should call it: its path, else its title. */
  function closeName(card, handle) {
    const path = handle !== null && handle !== undefined && typeof handle.path === "string"
      ? handle.path
      : "";
    if (path !== "") {
      return path;
    }
    const title = card !== null && card !== undefined && typeof card.title === "string"
      ? card.title
      : "";
    return title !== "" ? title : describeCard(card);
  }

  /**
   * Close a card -- the one path every close goes through.
   *
   * A card with unsaved text is asked about first, through `ask()` (the inline
   * strip, not a dialog: this app has no dialogs).  "save and close" runs the
   * card's own save and leaves the card alone if that fails, text and all;
   * "cancel", Escape and typing in the command line keep it; only an explicit
   * discard removes it.  After removal the selection follows the tab strip's
   * neighbour rule, so closing the active tab lands the keyboard next to it
   * instead of nowhere.
   */
  async function closeCard(id) {
    const card = board.findCard(id);
    if (card === null) {
      log("warn", `no card ${id}`);
      return false;
    }
    const entry = mounted.get(id);
    const handle = entry === undefined || entry.handle === null ? null : entry.handle;
    const plan = closePlan(handle);
    const layout = currentLayout();
    const tabbed = layout.roles.tabs.indexOf(id) !== -1;
    const next = tabbed ? classicNeighbourAfterClose(layout.roles.tabs, id, layout.roles.area) : null;
    if (plan.ask) {
      const answer = await ask(`${closeName(card, handle)} has unsaved text.`, plan.choices);
      const action = applyCloseAnswer(plan, answer);
      if (action === "keep") {
        // Deleting nothing must not also lose the keyboard: the strip is gone, so
        // the card that asked the question takes the focus back.
        renderAll();
        focusCardNode(id);
        return false;
      }
      if (action === "saveThenDelete") {
        try {
          await handle.save();
        } catch (err) {
          // The card stays and its text stays with it: a failed save is not a
          // reason to be rid of the only copy.
          log("error", `could not save ${closeName(card, handle)}: ${err.message}`);
          return false;
        }
        if (applyCloseAnswer(plan, answer, true) !== "delete") {
          return false;
        }
      }
    }
    if (!removeCardNow(id)) {
      return false;
    }
    if (next !== null && board.findCard(next) !== null) {
      board.setSelection(next);
    }
    renderAll();
    if (next !== null && board.findCard(next) !== null) {
      focusCardNode(next);
    }
    return true;
  }

  /**
   * Show a card: focus it, then re-tile.
   *
   * The name is left over from the board view, where this panned the world until
   * the card was in the middle of the window.  A tile has nowhere to pan -- it
   * puts every card where its own arithmetic says -- so there is nothing left
   * but the render, which is what makes `focus <id>` show the card as the code
   * area when it is an editor, the only place a tile has room for it.
   */
  function centreOn(card) {
    // The caller has already focused the card it names; a tile has no scroll
    // offset to move, so the render is the whole of "show me that card".
    void card;
    renderAll();
  }

  /* ------------------------------------------------------------------ */
  /* opening files                                                       */
  /* ------------------------------------------------------------------ */

  /**
   * The editor cards currently on the board, as plain data.
   *
   * This is what "open file" means in OsanaKami IDE Studio: the board is the
   * document list -- a file is open exactly when a card holds it.  It is what
   * the board listeners diff and what the file-facing commands walk; the tab
   * strip is built from the tile's own roles, which now cover every card kind,
   * so the strip and this list are not the same question any more.
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

  /**
   * Whether the kernel will read this path at all.
   *
   * A path reaches `openFile` in either form: workspace-relative (the command
   * line, a link from the docs, the mod card's package name) and absolute (a
   * card that knows the resolved root from a kernel reply, such as the problems
   * panel).  The kernel reads both, but only while the file lands inside the
   * workspace -- outside it refuses with "path escapes the workspace", which an
   * editor card would show as a load failure.  Keeping the form the caller used
   * is deliberate: a diagnostic row's absolute path is also the proof the row
   * used the package root `mod.validate` answered, and the label reading the
   * resolved path is what the smoke test checks (G51).  This guard is only the
   * outside-the-workspace sentence.
   */
  function isInsideWorkspace(path) {
    const clean = path.replace(/\\/g, "/");
    const root = String(workspace && workspace.root ? workspace.root : "")
      .replace(/\\/g, "/")
      .replace(/\/+$/, "");
    if (root === "") {
      // No workspace yet: a relative name means whatever the kernel will make
      // of it, and an absolute one is by definition outside it.
      return !/^([A-Za-z]:\/|\/)/.test(clean);
    }
    const folded = clean.toLowerCase();
    const foldedRoot = root.toLowerCase();
    return folded === foldedRoot || folded.startsWith(`${foldedRoot}/`);
  }

  /**
   * Tell a card it has just become visible.
   *
   * Some cards can only measure themselves while they are actually laid out: a
   * pixel card's canvas reports 0x0 while its card sits behind another tab, and
   * a deferred repaint does not fix that because the card is still hidden
   * (G52).  The tile is the one place that knows a card crossed into view, so
   * it calls the card's optional `shown()` right after the render that did it.
   */
  function notifyShown(id) {
    const entry = mounted.get(id);
    if (entry !== undefined && entry.handle && typeof entry.handle.shown === "function") {
      entry.handle.shown();
    }
  }

  function openFile(path, options = {}) {
    if (typeof path !== "string" || path.trim() === "") {
      log("warn", "open: give a path inside the workspace");
      return null;
    }
    const wanted = path.trim().replace(/\\/g, "/");
    if (!isInsideWorkspace(wanted)) {
      // G51-b: the kernel refuses every path outside the workspace, so name the
      // reason here instead of letting an editor card fail with a kernel error.
      // Opening a real game's Mods folder (outside the workspace by default)
      // still needs a product decision; this is the honest interim sentence.
      log("warn", `open: ${path.trim()} is outside the workspace, and the editor only reads files under it`);
      return null;
    }
    // A rig has a card of its own: the editor would show bytes it cannot read.
    if (/\.(skel\.bytes|atlas\.txt)$/i.test(wanted)) {
      return openRigCard(wanted);
    }
    // Where to put the caret when the file opens (G16): a diagnostic row knows
    // its line, a define pointer knows its JSON path.  They are card fields
    // rather than a scroll after the fact, so a re-render keeps them.
    const target = {};
    if (Number.isInteger(options.line) && options.line > 0) {
      target.line = options.line;
    }
    if (typeof options.pointer === "string" && options.pointer !== "") {
      target.pointer = options.pointer;
    }
    for (const entry of mounted.values()) {
      if (entry.handle.kind === "editor" && entry.handle.hasPath && entry.handle.hasPath(wanted)) {
        // The file is already open: reveal the caret's target in that card
        // rather than opening a second one, so clicking two diagnostics of the
        // same file leaves one editor.
        if (typeof entry.handle.reveal === "function") {
          entry.handle.reveal(target);
        }
        focusCard(entry.card.id);
        centreOn(entry.card);
        return entry.card;
      }
    }
    const centre = options.at || centreWorld();
    const size = { w: 680, h: 460 };
    return addCard("editor", Math.round(centre.x - size.w / 2), Math.round(centre.y - size.h / 2), {
      file: wanted,
      ...target,
    }, size);
  }

  /**
   * Show the problems panel for `root`, creating one when the board has none.
   *
   * The mod card calls this after `validate` finds something to fix, so the
   * list of findings appears where the person already is (G17).  There is one
   * panel per package: an existing card showing the same root is brought
   * forward instead of a second copy being stacked on it.
   */
  function openProblemsCard(root, options = {}) {
    const wanted = typeof root === "string" ? root.trim().replace(/\\/g, "/") : "";
    if (wanted === "") {
      log("warn", "problems: give a mod directory");
      return null;
    }
    for (const entry of mounted.values()) {
      if (entry.handle.kind === "problems" && typeof entry.handle.root === "function" &&
          entry.handle.root() === wanted) {
        focusCard(entry.card.id);
        centreOn(entry.card);
        return entry.card;
      }
    }
    const centre = options.at || centreWorld();
    const size = { w: 640, h: 380 };
    return addCard("problems", Math.round(centre.x - size.w / 2), Math.round(centre.y - size.h / 2), {
      root: wanted,
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

  /**
   * Undo, focused card first.
   *
   * The board ring holds *documents* -- which cards exist, where they sit --
   * and pixels are deliberately not in them, because the pixels are the file
   * and not the board.  So a drawing that could not take its own step back
   * would make Ctrl+Z over it either do nothing or silently move the board
   * underneath, which is the one thing worse than doing nothing.  The rule:
   * ask the selected card's handle first; `true` means it took the step and
   * the board ring must stay put.
   */
  function cardUndoOrRing() {
    const entry = board.selectedId === null ? undefined : mounted.get(board.selectedId);
    const handle = entry === undefined ? null : entry.handle;
    if (handle !== null && typeof handle.undo === "function" && handle.undo() === true) {
      return true;
    }
    undoBoard();
    return false;
  }

  /** Redo, the same way round: the card's ring first, then the board's. */
  function cardRedoOrRing() {
    const entry = board.selectedId === null ? undefined : mounted.get(board.selectedId);
    const handle = entry === undefined ? null : entry.handle;
    if (handle !== null && typeof handle.redo === "function" && handle.redo() === true) {
      return true;
    }
    redoBoard();
    return false;
  }

  /**
   * The pixel card holding a file, if there is one.
   *
   * One file, one card: two pixel cards on the same path are two buffers that
   * save over each other, and both look right until one does.  `path` must be
   * normalised the way the command line normalises it.
   */
  function pixelCardFor(path) {
    for (const entry of mounted.values()) {
      if (entry.handle.kind !== "pixel" || typeof entry.handle.hasPath !== "function") {
        continue;
      }
      if (entry.handle.hasPath(path)) {
        return entry;
      }
    }
    return null;
  }

  /**
   * Put a pixel card on the board for one `.png`, declaring a size when the
   * file is not there yet.  The pixels are never in the document: the card
   * carries `{file, width, height, palette}` and the bytes stay on disk, so
   * this is the entry point both the `pixel` command and a D006 row use.
   *
   * `options.width`/`options.height` are the size the card declares for a file
   * that does not exist.  Omit them and the game's 96x96 sprite convention is
   * used -- the number `create()` seeds and the usable size the D006 row needs
   * for a sprite the mod does not carry.
   */
  function openPixelCard(path, options = {}) {
    if (typeof path !== "string" || path.trim() === "") {
      log("warn", "pixel: give a workspace-relative .png path");
      return null;
    }
    const wanted = path.trim().replace(/\\/g, "/");
    const existing = pixelCardFor(wanted);
    if (existing !== null) {
      // A second command for the same file focuses the card it already has.
      focusCard(existing.card.id);
      centreOn(existing.card);
      log("info", `pixel card focused (${wanted}) — pixels are the file, not the board`);
      return existing.card;
    }
    const size = DEFAULT_SIZE.pixel;
    const centre = centreWorld();
    /*
     * `board.addCard` copies the fields it is handed and never consults the
     * kind's `create()`, so the declared size has to be written here: a row
     * that names no size at all -- the D006 row -- would otherwise leave the
     * card with no `width`/`height` and whatever the last command said.
     */
    const fields = {
      file: wanted,
      width: Number.isFinite(options.width) && options.width > 0
        ? Math.floor(options.width)
        : PIXEL_NEW_SIZE,
      height: Number.isFinite(options.height) && options.height > 0
        ? Math.floor(options.height)
        : PIXEL_NEW_SIZE,
    };
    const card = addCard("pixel", Math.round(centre.x - size.w / 2), Math.round(centre.y - size.h / 2), fields, size);
    log("info",
      `pixel card added (${wanted}) — a drawing surface; the pixels are the file, not the board`);
    return card;
  }

  /**
   * The rig card showing a rig, if there is one.
   *
   * One skeleton, one card: the card's view state (animation, skin, playhead)
   * is worth keeping, and a second card on the same rig would only be a second
   * copy of the same picture.  `path` is either half of the pair -- the atlas
   * and the skeleton are found from each other.
   */
  function rigCardFor(path) {
    for (const entry of mounted.values()) {
      if (entry.handle.kind !== "rig" || typeof entry.handle.hasPath !== "function") {
        continue;
      }
      if (entry.handle.hasPath(path)) {
        return entry;
      }
    }
    return null;
  }

  /**
   * Put a rig card on the board for one `.skel.bytes` (or its
   * `.atlas.txt`).  The card reads both files and the page images beside them;
   * the document only remembers which rig is shown and how it was framed.
   */
  function openRigCard(path, options = {}) {
    if (typeof path !== "string" || path.trim() === "") {
      log("warn", "rig: give a workspace-relative .skel.bytes path");
      return null;
    }
    const wanted = path.trim().replace(/\\/g, "/");
    const existing = rigCardFor(wanted);
    if (existing !== null) {
      focusCard(existing.card.id);
      centreOn(existing.card);
      log("info", `rig card focused (${wanted}) — the rig is on the board already`);
      return existing.card;
    }
    const size = DEFAULT_SIZE.rig;
    const centre = centreWorld();
    const card = addCard(
      "rig",
      Math.round(centre.x - size.w / 2),
      Math.round(centre.y - size.h / 2),
      { file: wanted, animation: "", skin: "", bones: true },
      size,
    );
    log("info",
      `rig card added (${wanted}) — bones, skins and the timeline; edits save back to the rig`);
    return card;
  }

  /**
   * The settings card, if the board already has one.
   *
   * Settings describe the machine, not the project, so one card is enough: a
   * second copy would be a second form for the same preference file, and the
   * two would show different answers until one of them reloaded.
   */
  function settingsCard() {
    for (const entry of mounted.values()) {
      if (entry.handle.kind === "settings") {
        return entry;
      }
    }
    return null;
  }

  /**
   * Put the settings card on the board (G48).  It edits the AI provider and the
   * two preferences a window reads on boot; the rest it shows is a process
   * argument and needs a restart, which the card says rather than pretending.
   */
  function openSettingsCard() {
    const existing = settingsCard();
    if (existing !== null) {
      focusCard(existing.card.id);
      centreOn(existing.card);
      log("info", "settings card focused — one form for one preference file");
      return existing.card;
    }
    const size = DEFAULT_SIZE.settings;
    const centre = centreWorld();
    const card = addCard(
      "settings",
      Math.round(centre.x - size.w / 2),
      Math.round(centre.y - size.h / 2),
      {},
      size,
    );
    log("info", "settings card added — the AI provider and the view a window opens in");
    return card;
  }

  /**
   * Create one file from the game's own schema (G50), then open it.
   *
   * The shell owns the generator and the knowledge base; this side only names
   * the three things the verb wants -- what kind of file, which package, what to
   * call it -- and opens the path the answer names rather than a guess at where
   * the verb would have put it.  A sprite opens in the pixel card, because its
   * file is pixels; everything else opens as text.
   */
  async function createNewFile(type, dir, name) {
    const answer = await client.call("mod.newFile", { dir, type, name });
    const file = typeof answer.file === "string" && answer.file !== "" ? answer.file : answer.path;
    log("info", `new ${type} (${answer.path}, ${answer.bytes} bytes) — the game's schema filled what it requires`);
    if (type === "sprite") {
      openPixelCard(file);
    } else {
      openFile(file);
    }
    return answer;
  }

  /**
   * Copy an existing file into a package (the other half of G50), then open it.
   *
   * `from` may be any file the shell can read; `to` names the place inside the
   * package and is only needed when the file's own name does not say where it
   * belongs.  The verb copies the bytes verbatim and validates them as they
   * land; this side opens what the answer names.
   */
  async function importNewFile(from, dir, to) {
    const answer = await client.call("mod.importFile", {
      dir,
      from,
      ...(to === undefined || to === "" ? {} : { to }),
    });
    const file = typeof answer.file === "string" && answer.file !== "" ? answer.file : answer.path;
    log("info", `imported ${answer.path} (${answer.bytes} bytes) — copied byte for byte`);
    if (answer.kind === "sprite" || /\.png$/i.test(answer.path)) {
      openPixelCard(file);
    } else {
      openFile(file);
    }
    return answer;
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
    openPixelCard,
    openRigCard,
    openSettingsCard,
    openProblemsCard,
    // The board's undo ring snapshots *documents*, and a pixel card's artwork
    // deliberately is not one -- the pixels are the file.  So undo asks the
    // selected card first: a handle that answers `true` took the step itself
    // (given back a pencil stroke, say) and the ring must not move as well.
    // A `false` -- or a card with no opinion -- falls through to the ring.
    undo() {
      return cardUndoOrRing();
    },
    redo() {
      return cardRedoOrRing();
    },
    // Same behaviour as `delete <id>`: the card leaves the board, the file on
    // disk is not touched, and unsaved text is named rather than discarded.
    closeCard,
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

  /**
   * What a click on the surface means, now that nothing pans or zooms:
   *   empty space -> clear the selection
   *   card        -> select it and bring it to the front
   *
   * A tile has no empty board to pan: the code area and the sidebar *are* cards,
   * and the pixels between them belong to the layout.  Dragging a card left with
   * the world it moved in -- the tile decides where every card is -- and the
   * wheel and the double-click belong to whatever is under them.  These two
   * listeners, and the one that keeps the browser's own menu off the surface,
   * are all the delegation that is left.
   */
  function installGestures() {
    boardEl.addEventListener("pointerdown", (event) => {
      if (event.button !== 0) {
        return;
      }
      const target = event.target;
      if (target instanceof Element && target.closest("input, textarea, button, select")) {
        return; // let the control have the click
      }
      const cardNode = target instanceof Element ? target.closest("[data-card-id]") : null;
      if (cardNode === null) {
        board.setSelection(null);
        renderCards(currentLayout());
        renderHud();
        return;
      }
      const card = board.findCard(cardNode.dataset.cardId);
      if (card === null) {
        return;
      }
      board.setSelection(card.id);
      // Bringing a card to the front changes `z`, which is part of the document,
      // so it has to be marked dirty or the HUD says "saved" and the stack order
      // is gone after a reload.  It is not an undo step: nobody means to take
      // back "I clicked that card".
      board.raiseCard(card.id);
      boardTouched(true, { record: false });
      renderCards();
      renderHud();
    });

    boardEl.addEventListener("contextmenu", (event) => event.preventDefault());
  }

  /* ------------------------------------------------------------------ */
  /* the command line                                                    */
  /* ------------------------------------------------------------------ */

  /* The vocabulary, derived from the one place it is written down.  `COMMAND_HELP`
     is what `help` prints and what the hint reads, so taking the first word of
     each row means a command cannot be spellable but unlisted, or listed but
     unspellable -- which is how `clear` came to be a command the hint knew
     nothing about. */
  const KNOWN_COMMANDS = COMMAND_HELP.map((row) => row.trim().split(/\s+/)[0]);

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
      case "story": {
        /* Two optional files can follow the story: the translation table and the
           command schema, told apart by their extensions -- so `story a b.yarn`
           stays a path with a space in it while `story a.yarn zh.csv` reads as the
           pair it is. */
        const rest = line.replace(/^\s*story\s*/i, "").trim();
        const words = rest.split(/\s+/);
        let table = "";
        let schema = "";
        if (words.length > 1 && /\.json$/i.test(words[words.length - 1])) {
          schema = words.pop().replace(/\\/g, "/");
        }
        if (words.length > 1 && /\.csv$/i.test(words[words.length - 1])) {
          table = words.pop().replace(/\\/g, "/");
        }
        const wanted = words.join(" ").replace(/\\/g, "/");
        if (wanted === "") {
          log("warn", "usage: story <path.yarn> [translation.csv] [commands.json]");
          return;
        }
        /* One card per file: a second story card on the same path would be two
           editors saving over each other, and both would look right. */
        for (const entry of mounted.values()) {
          if (entry.handle.kind !== "story" || !entry.handle.hasPath) {
            continue;
          }
          if (entry.handle.hasPath(wanted)) {
            if (table !== "" && entry.handle.tablePath !== table) {
              entry.handle.loadTable(table);
            }
            if (schema !== "" && entry.handle.schemaPath !== schema) {
              entry.handle.loadSchema(schema);
            }
            focusCard(entry.card.id);
            centreOn(entry.card);
            return;
          }
        }
        const size = DEFAULT_SIZE.story;
        const centre = centreWorld();
        addCard("story", Math.round(centre.x - size.w / 2), Math.round(centre.y - size.h / 2), {
          file: wanted,
          table,
          schema,
        }, size);
        log("info",
          `story card added (${wanted}) \u2014 nodes, lines and translations, not the raw file`);
        return;
      }
      case "pixel": {
        /* `pixel <path.png> [width] [height]`.  A path with a space in it is a
           path, so the numbers are only read off the end. */
        const rest = line.replace(/^\s*pixel\s*/i, "").trim();
        if (rest === "") {
          log("warn", "usage: pixel <path.png> [width] [height]");
          return;
        }
        const words = rest.split(/\s+/);
        let height = null;
        let width = null;
        if (words.length > 2 && /^\d+$/.test(words[words.length - 1]) && /^\d+$/.test(words[words.length - 2])) {
          height = Number(words.pop());
          width = Number(words.pop());
        } else if (words.length > 1 && /^\d+$/.test(words[words.length - 1])) {
          width = Number(words.pop());
        }
        const wanted = words.join(" ").replace(/\\/g, "/");
        if (wanted === "") {
          log("warn", "usage: pixel <path.png> [width] [height]");
          return;
        }
        const options = {};
        if (width !== null) {
          options.width = width;
        }
        if (height !== null) {
          options.height = height;
        }
        openPixelCard(wanted, options);
        return;
      }
      case "rig": {
        /* `rig <path.skel.bytes>` (or its `.atlas.txt`): a path with a space
           in it is a path, so the whole rest of the line is the file. */
        const wanted = line.replace(/^\s*rig\s*/i, "").trim().replace(/\\/g, "/");
        if (wanted === "") {
          log("warn", "usage: rig <path.skel.bytes>");
          return;
        }
        openRigCard(wanted);
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
      case "mod": {
        // One mod at a time, like one project: a second `mod` re-points the
        // card you already have, and `docs`/`problems` follow it.
        const dir = arg(0) === undefined ? "" : tokens.slice(1).join(" ");
        const existing = board.cards.find((card) => card.kind === "mod");
        if (existing !== undefined) {
          const entry = mounted.get(existing.id);
          if (entry !== undefined && typeof entry.handle.setDir === "function") {
            entry.handle.setDir(dir);
          }
          revealCard(existing.id);
          return;
        }
        const size = DEFAULT_SIZE.mod;
        const centre = centreWorld();
        addCard("mod", Math.round(centre.x - size.w / 2), Math.round(centre.y - size.h / 2), { dir }, size);
        return;
      }
      case "example": {
        /*
         * The demo package ships beside the editor, which is outside the mods
         * folder and therefore outside what any card may open.  So this command
         * asks the shell to copy it in first, then opens it exactly like `mod`
         * would -- which is also why it stays editable.
         */
        const wanted = arg(0) === undefined ? "" : tokens.slice(1).join(" ");
        const openInstalled = (answer) => {
          log(answer.installed ? "info" : "warn",
            answer.installed
              ? `example ${answer.dir}: ${answer.files} file(s) copied into the mods folder`
              : `example ${answer.dir}: already in the mods folder`);
          runCommand("mod " + answer.dir).catch((err) => {
            log("error", `example: ${err.message}`);
          });
        };
        client.call("mod.example", wanted === "" ? {} : { name: wanted }).then(openInstalled, (err) => {
          log("warn", `example: ${err.message}`);
        });
        return;
      }
      case "problems": {
        const root = arg(0) === undefined ? "" : tokens.slice(1).join(" ");
        const size = DEFAULT_SIZE.problems;
        const centre = centreWorld();
        addCard("problems", Math.round(centre.x - size.w / 2), Math.round(centre.y - size.h / 2), { root }, size);
        return;
      }
      case "docs": {
        const query = arg(0) === undefined ? "" : tokens.slice(1).join(" ");
        const size = DEFAULT_SIZE.docs;
        const centre = centreWorld();
        addCard("docs", Math.round(centre.x - size.w / 2), Math.round(centre.y - size.h / 2), { query }, size);
        return;
      }
      case "new": {
        // The three arguments the verb takes: what kind of file, which package,
        // what to call it.  `dir` is a package directory (absolute, or relative
        // to the mods root) or any directory inside one -- the shell walks up
        // for mod.json.  The name is everything after it, which is how a name
        // with a space in it gets refused by the verb rather than mangled here.
        if (argc < 3) {
          log("warn", "usage: new <type> <dir> <name>  (type: a define type, yarn, translation or sprite)");
          return;
        }
        createNewFile(arg(0), arg(1), tokens.slice(2).join(" ")).catch((err) => {
          log("warn", `new: ${err.message}`);
        });
        return;
      }
      case "import": {
        // `from` is quoted when its path has spaces; the rest is the package
        // (`dir`) and, when the name does not say where the file belongs, the
        // target inside it.  The verb refuses a define without a target instead
        // of guessing its type.
        if (argc < 2) {
          log("warn", 'usage: import <from> <dir> [to]  (quote a path with spaces in it)');
          return;
        }
        const to = tokens.length > 2 ? tokens.slice(2).join(" ") : undefined;
        importNewFile(arg(0), arg(1), to).catch((err) => {
          log("warn", `import: ${err.message}`);
        });
        return;
      }
      case "settings": {
        openSettingsCard();
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
          boardTouched();
        } else {
          log("warn", `no link ${arg(0)}`);
        }
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
        await closeCard(id);
        return;
      }
      case "save": {
        await saveBoard({ force: arg(0) === "force" });
        return;
      }
      case "undo": {
        // The selected card first, exactly as Ctrl+Z does: `undo` in the
        // command line is the same request as the keystroke.
        cardUndoOrRing();
        return;
      }
      case "redo": {
        cardRedoOrRing();
        return;
      }
      case "help": {
        // An answer to a question is not something to go looking for: the strip
        // opens itself so that what was asked for is on screen.
        showLog(true);
        log("info", "commands:");
        for (const row of COMMAND_HELP) {
          log("info", `  ${row}`);
        }
        return;
      }
      case "log": {
        // A toggle rather than `log on` / `log off`, because the HUD button is the
        // same toggle and either way the answer is the strip itself.
        showLog(!logOpen);
        if (logOpen) {
          log("info", "the message strip is open; `log` or the HUD button closes it");
        }
        return;
      }
      case "mode": {
        if (argc < 1) {
          log("info", viewNote(viewMode));
          return;
        }
        const wanted = viewName(arg(0));
        if (wanted === null) {
          log("warn", `unknown view "${arg(0)}". Try \`mode ${VIEWS.join("`, `mode ")}\`.`);
          return;
        }
        if (wanted === viewMode) {
          log("info", `already in the ${wanted} view`);
          return;
        }
        setView(wanted);
        log("info", viewAbout(wanted));
        return;
      }
      case "clear": {
        logEl.textContent = "";
        logLines.length = 0;
        logUnseen = 0;
        logWorst = "info";
        paintLogToggle();
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
  /* the classic view's two controls                                     */
  /* ------------------------------------------------------------------ */

  /**
   * The mode button in the HUD and the tab strip.
   *
   * Both are delegated listeners on containers that are rebuilt every render
   * (the tabs are replaced wholesale), so they are installed once, here, and
   * never have to be re-attached: a listener on the strip outlives every button
   * inside it.  Choosing a tab selects its card, which is what makes it the code
   * area -- the same route `focus <id>` takes, so there is one idea of "the
   * focused card" rather than a second one for the strip.
   */
  function installView() {
    // A window that changes size re-tiles: both views measure the element they
    // fill and place every card from that arithmetic, so there is nothing else
    // to do about it.
    window.addEventListener("resize", () => {
      renderAll();
    });

    /* The log strip's door.  One listener here rather than a click handler per
       render, like the switch above: the button is in index.html and is never
       rebuilt. */
    logToggle.addEventListener("click", () => showLog(!logOpen));
    paintLogToggle();

    for (const button of modeButtons) {
      button.addEventListener("click", () => {
        const wanted = button.dataset.view;
        if (wanted === viewMode) {
          return;
        }
        setView(wanted);
        log("info", viewAbout(wanted));
      });
    }

    tabsEl.addEventListener("click", (event) => {
      const target = event.target instanceof Element ? event.target : null;
      if (target === null) {
        return;
      }
      // The close control is checked first: it sits inside the tab container, so
      // a plain "did the press land on a tab" test would open the card instead
      // of closing it.
      const close = target.closest(".tab-close");
      if (close !== null) {
        void closeTab(close.dataset.closeId);
        return;
      }
      const tab = target.closest("[data-card-id]");
      if (tab === null) {
        return;
      }
      selectTab(tab.dataset.cardId);
    });

    // A middle click closes the tab under the pointer, active or not -- the
    // browser-tab gesture, on the same `closeTab` as the x.  `auxclick` is the
    // event for buttons other than the primary one; without preventDefault the
    // middle button would also start the browser's autoscroll.
    tabsEl.addEventListener("auxclick", (event) => {
      if (event.button !== 1) {
        return;
      }
      const target = event.target instanceof Element ? event.target : null;
      const tab = target === null ? null : target.closest("[data-card-id]");
      if (tab === null) {
        return;
      }
      event.preventDefault();
      void closeTab(tab.dataset.cardId);
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
      // The kernel announcing one of its own writes. It gets the same answer as
      // a change the poll finds: the revision is the whole message, so it is
      // handed to the same rule as a `file.stat` reply.
      applyFileChange(event.path, {
        path: event.path,
        exists: true,
        dir: false,
        revision: event.revision,
      });
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
    client.on("view.changed", (event) => {
      if (saving) {
        // Our own save may be the writer -- the kernel notifies before it
        // answers it -- and until the reply lands `boardRevision` and `dirty`
        // still describe the document before the write.  Queue the revision and
        // decide once the reply has had its say, or every autosave's echo is
        // read as another writer's edit and warns.
        queuedViewRevisions.push(event.revision);
        return;
      }
      settleViewChange(event.revision);
    });
  }

  /**
   * Answer one `view.changed` revision.  Both the idle path and the queue drain
   * end here, so a queued echo and an arriving one cannot be judged differently.
   */
  function settleViewChange(revision) {
    const verdict = classifyViewEvent({ revision, boardRevision, dirty });
    if (verdict === "echo") {
      return;
    }
    if (verdict === "warn") {
      log("warn", `the board on disk is now rev ${revision}; you have unsaved changes.`);
      return;
    }
    // Nothing local to lose, so follow the disk.
    adoptDiskBoard(`another writer moved the board to rev ${revision}`).catch(
      (err) => log("error", `reloading the board failed: ${err.message}`),
    );
  }

  /**
   * Decide the revisions that arrived while a save was in flight.  Called from
   * `saveBoard`'s `finally`, after the reply has updated `boardRevision` and
   * `dirty`: our own echo now compares equal and stays quiet, while a genuine
   * external write keeps the old rules (dirty -> warn, clean -> adopt).
   */
  function settleQueuedViewChanges() {
    if (queuedViewRevisions.length === 0) {
      return;
    }
    const revisions = queuedViewRevisions;
    queuedViewRevisions = [];
    for (const revision of revisions) {
      settleViewChange(revision);
    }
  }

  /* ------------------------------------------------------------------ */
  /* changes nothing announces                                           */
  /* ------------------------------------------------------------------ */

  /*
   * `file.changed` only ever says what the kernel did. A file rewritten by git,
   * by a build, or by any editor that is not this one is invisible to it, and a
   * card that quietly keeps showing yesterday's bytes is the failure mode that
   * matters: the user finds out when they save over somebody else's work.
   *
   * `file.stat` answers the only question that needs asking -- is this still the
   * revision I hold? -- and moves no bytes doing it, so the shell asks about the
   * files on the board on a timer. The rules live in `watch.mjs` (pure, pinned
   * by `selftest.mjs`); what is here is the asking.
   */
  let watchTimer = null;
  let watchBusy = false;
  let watchSeen = new Map();
  /* How often to ask.  The file's preference may move this once at boot
     (`bootPreferencesFrom`); the constant is what a window that was never told
     anything uses. */
  let watchPollMs = WATCH_POLL_MS;
  /** A kernel without `file.stat` (a trimmed fork): stop asking, say so once. */
  let watchUnavailable = false;

  /** Every editor card currently holding `path`. */
  function editorsOn(path) {
    const out = [];
    for (const entry of mounted.values()) {
      const handle = entry.handle;
      if (handle === undefined || handle === null || handle.kind !== "editor") {
        continue;
      }
      if (typeof handle.hasPath === "function" && handle.hasPath(path)) {
        out.push(handle);
      }
    }
    return out;
  }

  /**
   * One change, one answer -- whether it arrived as a notification or as the
   * answer to a poll. Each card is judged on its own: two cards on one file can
   * hold two revisions, and only one of them may have unsaved edits.
   */
  function applyFileChange(path, stat) {
    for (const handle of editorsOn(path)) {
      const decision = watchDecision(
        { revision: handle.revision, dirty: handle.dirty === true },
        stat,
      );
      if (decision === WATCH_RELOAD) {
        handle.reload().then((reloaded) => {
          if (reloaded) {
            log("info", `${path} changed on disk -- reloaded`);
          }
        }).catch((err) => log("error", `file.read ${path}: ${err.message}`));
      } else if (decision === WATCH_WARN) {
        handle.onFileChanged(Number.isFinite(stat.revision) ? stat.revision : null);
      } else if (decision === WATCH_GONE) {
        handle.onFileGone();
      }
    }
  }

  /** The files on the board, grouped by path: two cards, one question. */
  function watchedPaths() {
    const groups = new Map();
    for (const entry of mounted.values()) {
      const handle = entry.handle;
      if (handle === undefined || handle === null || handle.kind !== "editor") {
        continue;
      }
      const path = String(handle.path || "").replace(/\\/g, "/");
      if (path === "") {
        continue;
      }
      if (!groups.has(path)) {
        groups.set(path, []);
      }
      groups.get(path).push(handle);
    }
    return groups;
  }

  /**
   * What the whole group holds: the oldest revision anyone has, and whether
   * anyone has unsaved edits. A card still loading has no revision to compare,
   * so the group says "unknown" and the next poll asks again.
   */
  function groupKnown(handles) {
    let revision = null;
    let loading = false;
    let dirty = false;
    for (const handle of handles) {
      const held = handle.revision;
      if (!Number.isFinite(held)) {
        loading = true;
      } else if (revision === null || held < revision) {
        revision = held;
      }
      if (handle.dirty === true) {
        dirty = true;
      }
    }
    return { revision: loading ? null : revision, dirty };
  }

  async function pollForChanges() {
    const groups = watchedPaths();
    if (groups.size === 0) {
      watchSeen = new Map();
      return;
    }
    const paths = [...groups.keys()];
    const stats = await Promise.all(paths.map(async (path) => {
      try {
        return await client.call("file.stat", { path });
      } catch (err) {
        return { error: err };
      }
    }));
    if (watchTrimmed(stats)) {
      // `METHOD_NOT_FOUND`: this kernel was built without the method. Not an
      // error -- the board simply keeps whatever the kernel last said, which is
      // exactly what the shell did before this poll existed.
      watchUnavailable = true;
      stopWatching();
      log("warn", "this kernel has no `file.stat`: changes made outside OsanaKami IDE Studio will be"
        + " noticed when the file is opened again, not while it is on the board");
      return;
    }
    const pairs = paths.map((path, index) => ({
      path,
      stat: stats[index],
      known: groupKnown(groups.get(path)),
    }));
    const report = watchReport(pairs, watchSeen);
    watchSeen = report.next;
    for (const action of report.actions) {
      applyFileChange(action.path, action.stat);
    }
  }

  function startWatching() {
    if (watchUnavailable || watchTimer !== null) {
      return;
    }
    watchTimer = setInterval(() => {
      // One question at a time: a kernel that is slow to answer must not build
      // a queue of polls behind it.
      if (watchBusy) {
        return;
      }
      watchBusy = true;
      pollForChanges()
        .catch((err) => log("warn", `file.stat poll failed: ${err.message}`))
        .finally(() => {
          watchBusy = false;
        });
    }, watchPollMs);
  }

  function stopWatching() {
    if (watchTimer !== null) {
      clearInterval(watchTimer);
      watchTimer = null;
    }
  }

  async function adoptDiskBoard(reason) {
    const loaded = await client.call("view.load", { path: BOARD_PATH });
    boardRevision = loaded.revision;
    loadDocument(loaded.document);
    log("info", `reloaded the board (${reason})`);
  }

  /**
   * Put a document on the board.  `history` is "reset" for a board that came
   * from somewhere else (boot, or another writer's `view.changed`): the undo
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
   * Open the package a `?mod=` URL named.  This is how the File menu's
   * "新建模组" hands its result to the window: main.js reloads the page with
   * the directory in the query string, and boot calls this once the board is
   * mounted.  The directory goes on the mod card -- a board card, so the next
   * boot opens it from the document, not from the URL -- and `setDir` runs the
   * same `mod.open` a click on the card would.
   *
   * The card the shortcut needs usually already exists (the scaffolded board
   * has one with `dir: ""`); a board without one gets a mod card rather than
   * silently doing nothing.
   */
  async function openRequestedMod() {
    const requested = requestedModFromSearch(typeof location === "undefined" ? "" : location.search);
    if (requested === null || requestedModHandled) {
      return;
    }
    requestedModHandled = true;
    let target = null;
    for (const card of board.cards) {
      if (card.kind === "mod") {
        target = card;
      }
    }
    if (target === null) {
      target = addCard("mod", 80, 200, { dir: requested });
    }
    const entry = target === null ? undefined : mounted.get(target.id);
    if (entry === undefined || entry === null || entry.handle === null || entry.handle === undefined
        || typeof entry.handle.setDir !== "function") {
      log("warn", `could not open ${requested}: the board has no mod card to put it on`);
      return;
    }
    setView("mod");
    await entry.handle.setDir(requested);
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

    // G48: the user's preference file can name the view a window opens in and
    // how often the cards poll.  Both are read here, before the first paint, so
    // a window told to open in the classic tile never flashes the mod one.  A
    // shell that does not answer `config.get` (an older one, or a trimmed
    // build) is not an error: the constants in this file are the fallback.
    const settings = await client.call("config.get", {}).catch(() => null);
    const bootPrefs = bootPreferencesFrom(settings);
    if (bootPrefs.bootView !== viewMode) {
      viewMode = bootPrefs.bootView;
      paintView();
    }
    if (bootPrefs.watchPollMs !== null) {
      watchPollMs = bootPrefs.watchPollMs;
    }

    let loaded;
    try {
      loaded = await client.call("view.load", { path: BOARD_PATH });
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
      log("info", `OsanaKami IDE Studio ${stamp.kernel_version} · protocol ${stamp.protocol} · pid ${stamp.pid}`);
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
      // the board dirty, or merely opening OsanaKami IDE Studio would write a board.json.
      const wasDirty = dirty;
      addCard("note", 80, 80, { text: HINT_TEXT }, { w: HINT_SIZE.w, h: HINT_SIZE.h });
      dirty = wasDirty;
      renderHud();
    }
    initializing = false;
    renderAll();
    // The File menu's new-mod shortcut reloads the window with `?mod=`; the
    // board is mounted by now, so the package can be opened on its card.
    await openRequestedMod();
    // The cards exist now, so there is something to watch. A reconnect re-tests
    // the kernel (it may have been replaced by one without `file.stat`), but the
    // timer itself is never doubled.
    watchSeen = new Map();
    watchUnavailable = false;
    startWatching();
    // The banner is written; from here a message with the strip shut is news.
    settleLog();
  }

  /* ------------------------------------------------------------------ */
  /* start                                                               */
  /* ------------------------------------------------------------------ */

  function start() {
    installGestures();
    installCommandLine();
    installView();
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
      // Ctrl+W closes the active tab, not the window.  It is always ours: letting
      // it fall through would close the Electron window the board lives in, which
      // is the one thing worse than doing nothing.  Any unsaved text still gets
      // its question -- this is the same `closeTab` as the x and the middle click.
      if ((event.ctrlKey || event.metaKey) && key === "w") {
        event.preventDefault();
        void closeTab(currentLayout().roles.area);
        return;
      }
      /*
       * Undo and redo.  A text field keeps the browser's own undo -- taking a
       * sentence back inside a note should touch the note, not the board -- so
       * this only fires when the keystroke did not land in one.  The editor and
       * note textareas stop propagation anyway; this is the belt to that
       * braces, and it also covers inputs that do not.
       *
       * The card gets first refusal, and that is load-bearing for the pixel
       * card: its pixels are not in the board document, so the board's ring
       * cannot give a pencil stroke back.  `cardUndoOrRing` asks the selected
       * card's handle, and only moves the ring when the card answered `false`.
       * A pixel canvas also handles Ctrl+Z itself and stops propagation, so
       * the keystroke never reaches here while the canvas has focus.
       */
      const typing = event.target instanceof HTMLInputElement
        || event.target instanceof HTMLTextAreaElement
        || (event.target instanceof HTMLElement && event.target.isContentEditable);
      if ((event.ctrlKey || event.metaKey) && !typing && (key === "z" || key === "y")) {
        event.preventDefault();
        if (key === "y" || event.shiftKey) {
          cardRedoOrRing();
        } else {
          cardUndoOrRing();
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
  "Token offsets from lang.tokenize are JS string indices (UTF-16 code units), not",
  "bytes -- verified for Chinese prose; an astral character counts as two units.",
  "Board chunks below MIN_SIZE (" + MIN_SIZE.w + "x" + MIN_SIZE.h + ") are clamped, and a link is",
  "document data with no renderer: `link` and `unlink` edit board.json, but neither view",
  "draws a line for one.",
  "Undo is document-level and in memory: Ctrl+Z takes back edits in this window,",
  "not the typing inside a card, and a reload forgets the steps.",
  "Every view is a projection, never a document: nothing about the tile is saved, a",
  "reload starts in the mod view, and a card the tile has no place for is hidden, not moved.",
  "It tiles the cards the document already has -- one code area (the focused editor), no",
  "split panes -- and every other open card gets a tab, which closes with its x, a middle",
  "click or Ctrl+W; a card with unsaved text is asked about first (save/discard/cancel),",
  "and an editor still open in the window is never dismissed without an answer.",
  "Closing the window asks before dropping unsaved board edits; a reload started by the",
  "Electron main process saves them first (window.__infantgodFlushBoard) because a",
  "main-process reload is decided before beforeunload can say no.",
];
