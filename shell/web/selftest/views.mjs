/* ------------------------------------------------------------------ */
/* the two tiled views, and the board they are views of
/* ------------------------------------------------------------------ */

import assert from "node:assert/strict";
import {
  readFileSync,
} from "node:fs";
import {
  CARD_KINDS,
  createBoard,
  normaliseDocument,
} from "../board.mjs";
import {
  knownCardKinds,
} from "../cards.mjs";
import {
  CLASSIC_SIDEBAR_KINDS,
  CLASSIC_TAB_H,
  classicLayout,
  classicNeighbourAfterClose,
  classicRoles,
  classicTabLabel,
} from "../classic.mjs";
import {
  BOOT_VIEW,
  applyCloseAnswer,
  bootPreferencesFrom,
  classifyViewEvent,
  closePlan,
  createApp,
  requestedModFromSearch,
} from "../main.mjs";
import {
  MOD_AREA_MIN,
  MOD_PANEL_H,
  MOD_PANEL_KINDS,
  MOD_PANEL_MIN,
  MOD_SIDEBAR_KINDS,
  MOD_SIDEBAR_MIN,
  MOD_SIDEBAR_W,
  MOD_TAB_H,
  modLayout,
  modRoles,
} from "../modview.mjs";
import {
  DEFAULT_VIEW,
  SWITCH_VIEWS,
  VIEWS,
  VIEW_LABELS,
  VIEW_TITLES,
  tiledView,
  viewAbout,
  viewName,
  viewNote,
} from "../views.mjs";
import {
  stubAppDom,
} from "./fixtures.mjs";
import {
  test,
  testAsync,
} from "./harness.mjs";

/* ------------------------------------------------------------------ */
/* the two tiled views, and the board they are views of                 */
/*
 * The two ways to look at the same board document.  What is pinned here is
 * what makes each one a *view* rather than a second layout engine: nothing it
 * computes is written back to a card (so a switch loses no edit and a save
 * writes the document back untouched), and every card either has one place in
 * the tile or is a tab in the strip -- every kind, so no card can be hidden
 * with no way back (G29) -- and none is ever drawn at 0,0 or moved.
 *
 * The pixels themselves are checked as arithmetic: the tile's pieces have to
 * add up at any window size, which is the part a browser would otherwise be the
 * only witness to.
 */
/* ------------------------------------------------------------------ */

export const cardOf = (id, kind, extras = {}) => ({ id, kind, x: 0, y: 0, w: 100, h: 100, z: 1, ...extras });

/* The shipped registry, walked by the G29 checks so a new kind cannot be born
 * unreachable: these are exactly the kinds `cards.mjs` registers. */
export const ALL_CARD_KINDS = knownCardKinds();

test("G29: the kinds the tiles have to reach are the ones the board ships", () => {
  assert.deepEqual(
    [...CARD_KINDS].sort(),
    ["editor", "runner", "note", "files", "project", "sheet", "story", "pixel", "rig", "mod", "problems", "docs", "settings", "help", "audio", "agent"].sort(),
    "the kinds this suite pins are the kinds the board can hold; a new one is added here knowingly",
  );
  for (const kind of CARD_KINDS) {
    assert.equal(knownCardKinds().includes(kind), true, `${kind} has a renderer, so both tiles can draw it`);
  }
});

test("classic: a lone card of any kind is drawn, never quietly hidden", () => {
  for (const kind of ALL_CARD_KINDS) {
    const roles = classicRoles([cardOf("k", kind)], null);
    const drawn = roles.sidebar === "k" || roles.area === "k";
    assert.equal(drawn || roles.tabs.indexOf("k") !== -1, true, `classic: a lone ${kind} is drawn or has a tab`);
    assert.equal(roles.hidden.length, 0, `classic: a lone ${kind} is reachable -- hidden would be neither`);
  }
});

test("mod: a lone card of any kind is drawn, never quietly hidden", () => {
  for (const kind of ALL_CARD_KINDS) {
    const roles = modRoles([cardOf("k", kind)], null);
    const drawn = roles.sidebar === "k" || roles.area === "k" || roles.panel === "k";
    assert.equal(drawn || roles.tabs.indexOf("k") !== -1, true, `mod: a lone ${kind} is drawn or has a tab`);
    assert.equal(roles.hidden.length, 0, `mod: a lone ${kind} is reachable -- hidden would be neither`);
  }
});

test("G29: every card of a board with one of each kind is reachable in both views", () => {
  const cards = ALL_CARD_KINDS.map((kind, index) => cardOf(`c${index}`, kind));
  cards.push(cardOf("e1", "editor"), cardOf("e2", "editor"));
  for (const [name, rolesOf] of [["classic", classicRoles], ["mod", modRoles]]) {
    const roles = rolesOf(cards, null);
    const reachable = new Set([roles.sidebar, roles.area, roles.panel, ...roles.tabs]);
    for (const card of cards) {
      assert.equal(reachable.has(card.id), true, `${name}: card ${card.id} (${card.kind}) is placed or has a tab`);
    }
    for (const id of roles.hidden) {
      assert.equal(roles.tabs.indexOf(id) !== -1, true, `${name}: hidden card ${id} is still one tab away`);
    }
  }
});

test("classic: the tab the strip offers is what fills the area", () => {
  const board = [cardOf("e1", "editor"), cardOf("n", "note")];
  const out = classicLayout(board, { width: 1200, height: 800 }, { activeId: "n" });
  assert.equal(out.boxes.has("e1"), false, "the editor is the tab that is not showing");
  assert.deepEqual(out.boxes.get("n"), out.area, "the note is drawn where the editor would be");
});

test("mod: the tab the strip offers is what fills the area", () => {
  const board = [cardOf("m", "mod"), cardOf("e1", "editor"), cardOf("n", "note")];
  const out = modLayout(board, { width: 1200, height: 800 }, { activeId: "n" });
  assert.equal(out.boxes.has("e1"), false, "the editor is the tab that is not showing");
  assert.deepEqual(out.boxes.get("n"), out.area, "the note is drawn where the editor would be");
});

test("tabs: a close lands the selection on the right neighbour, else the left, else nowhere", () => {
  assert.equal(classicNeighbourAfterClose(["a", "b", "c"], "b", "b"), "c", "the tab that slides into place takes it");
  assert.equal(classicNeighbourAfterClose(["a", "b", "c"], "a", "a"), "b", "the first tab hands over to the right");
  assert.equal(classicNeighbourAfterClose(["a", "b", "c"], "c", "c"), "b", "the last tab hands over to the left");
  assert.equal(classicNeighbourAfterClose(["a"], "a", "a"), null, "the only tab leaves nothing to select");
  assert.equal(classicNeighbourAfterClose([], "a", null), null, "no strip, nothing to select");
  assert.equal(classicNeighbourAfterClose(["a", "b", "c"], "b", "a"), "a", "closing another tab does not move the selection");
  assert.equal(classicNeighbourAfterClose(["a", "b"], "zz", "a"), "a", "an id that is not a tab changes nothing");
  assert.equal(classicNeighbourAfterClose(["a", "b"], "zz", null), null);
});

test("tabs: closing an active card leaves the strip shorter and the neighbour selected", () => {
  const board = [cardOf("e1", "editor"), cardOf("e2", "editor"), cardOf("n", "note")];
  const before = classicRoles(board, "n");
  assert.deepEqual(before.tabs, ["e1", "e2", "n"]);
  const next = classicNeighbourAfterClose(before.tabs, "n", before.area);
  assert.equal(next, "e2", "the note's tab closes onto the editor before it");
  const after = board.filter((card) => card.id !== "n");
  const roles = classicRoles(after, next);
  assert.deepEqual(roles.tabs, ["e1", "e2"], "the closed card's tab is gone from the strip");
  assert.equal(roles.area, "e2", "and the neighbour is what the area shows");
  // The mod tile shares the strip and therefore the rule.
  const modAfter = modRoles(after, next);
  assert.deepEqual(modAfter.tabs, ["e1", "e2"]);
  assert.equal(modAfter.area, "e2");
});

test("close: the question is only for a card that has something to lose", () => {
  assert.equal(closePlan(null).ask, false, "a card with no handle closes at once");
  assert.equal(closePlan({ dirty: false }).ask, false, "a clean card closes at once");
  const dirtySaver = closePlan({ dirty: true, save() {} });
  assert.equal(dirtySaver.ask, true, "a dirty card asks");
  assert.deepEqual(dirtySaver.choices.map((choice) => choice.value), ["save", "discard", "cancel"],
    "one that can save offers all three");
  const dirtyOnly = closePlan({ dirty: true });
  assert.deepEqual(dirtyOnly.choices.map((choice) => choice.value), ["discard", "cancel"],
    "one that cannot save offers no dead option");
  assert.equal(applyCloseAnswer({ ask: false, choices: [] }, undefined), "delete");
});

test("close: every answer has one outcome, and a failed save keeps the card", () => {
  const plan = closePlan({ dirty: true, save() {} });
  assert.equal(applyCloseAnswer(plan, "discard"), "delete");
  assert.equal(applyCloseAnswer(plan, "cancel"), "keep");
  assert.equal(applyCloseAnswer(plan, null), "keep", "typing in the command line is cancel");
  assert.equal(applyCloseAnswer(plan, "escape"), "keep", "anything else is cancel too");
  assert.equal(applyCloseAnswer(plan, "save"), "saveThenDelete", "save runs before the delete");
  assert.equal(applyCloseAnswer(plan, "save", true), "delete", "a finished save then deletes");
  assert.equal(applyCloseAnswer(plan, "save", false), "saveFailed", "a failed save keeps the card");
});

test("classic: the sidebar is the project panel, and the file list is second choice", () => {
  assert.deepEqual(CLASSIC_SIDEBAR_KINDS, ["project", "files"]);
  const board = [cardOf("e1", "editor"), cardOf("n", "note"), cardOf("f", "files")];
  assert.equal(classicRoles(board).sidebar, "f", "no project panel, so the file list takes the column");
  assert.equal(classicRoles([...board, cardOf("p", "project")]).sidebar, "p");
});

test("classic: the area follows the focused card, and falls back to the first editor", () => {
  const board = [cardOf("e1", "editor"), cardOf("e2", "editor"), cardOf("n", "note")];
  assert.equal(classicRoles(board, "e2").area, "e2", "the focused file is the one a command would act on");
  assert.equal(classicRoles(board, "n").area, "n", "a note the strip offers fills the area too: pressing its tab has to show it");
  assert.equal(classicRoles(board, null).area, "e1");
  assert.equal(classicRoles([cardOf("n", "note")]).area, "n", "a board whose only card is a note still draws the note");
});

test("classic: one card, at most one role -- and everything else is a tab", () => {
  const board = [cardOf("p", "project"), cardOf("e1", "editor"), cardOf("e2", "editor"), cardOf("f", "frame")];
  const roles = classicRoles(board, "e1");
  assert.deepEqual([roles.sidebar, roles.area], ["p", "e1"]);
  assert.deepEqual(roles.tabs, ["e1", "e2", "f"], "every card with no other part is a tab, in board order");
  assert.deepEqual(roles.hidden, ["e2", "f"], "the second editor is a tab, not a second pane");
  const files = classicRoles([cardOf("f", "files")], "f");
  assert.equal(files.sidebar, "f");
  assert.deepEqual(files.tabs, [], "a card cannot be the sidebar and a tab at once");
  assert.equal(files.area, null, "nor the sidebar and the code area");
});

test("classic: the tile adds up -- no gap and no overlap at any window size", () => {
  const board = [cardOf("p", "project"), cardOf("e1", "editor")];
  for (const [width, height, top] of [[1200, 800, 30], [500, 400, 0], [100, 50, 26], [0, 0, 0]]) {
    const out = classicLayout(board, { width, height }, { activeId: "e1", top });
    const where = `${width}x${height} top ${top}`;
    assert.equal(out.tabs.x, out.sidebar.x + out.sidebar.w, `the strip starts where the sidebar ends (${where})`);
    assert.equal(out.area.x, out.tabs.x, `the code area is under the strip (${where})`);
    assert.equal(out.area.y, out.tabs.y + out.tabs.h, `and begins where it ends (${where})`);
    assert.equal(out.tabs.y, top, `nothing is drawn under the HUD (${where})`);
    assert.equal(out.area.x + out.area.w, width, `the tile reaches the right edge (${where})`);
    assert.equal(out.sidebar.y + out.sidebar.h, height, `the column reaches the bottom (${where})`);
    assert.equal(out.area.y + out.area.h, height, `the code area reaches the bottom (${where})`);
  }
});

test("classic: with no sidebar card the code area gets the whole width", () => {
  const out = classicLayout([cardOf("e1", "editor")], { width: 900, height: 600 }, { activeId: "e1" });
  assert.equal(out.sidebar, null);
  assert.equal(out.sidebarWidth, 0);
  assert.equal(out.tabs.x, 0);
  assert.equal(out.area.w, 900);
  assert.equal(out.tabHeight, CLASSIC_TAB_H);
});

test("classic: a narrow window squeezes the column, and the code area never goes negative", () => {
  const board = [cardOf("p", "project"), cardOf("e1", "editor")];
  const widthAt = (width) => classicLayout(board, { width, height: 600 }).sidebarWidth;
  assert.equal(widthAt(1400), 280, "the comfortable width is the cap, not 40% of a big window");
  assert.equal(widthAt(500), 200, "40% of 500 is the most it may take");
  assert.equal(widthAt(300), 160, "160 is where its listing stops being readable");
  assert.equal(widthAt(100), 100, "a window narrower than that has no room for two columns");
  assert.equal(classicLayout(board, { width: 100, height: 600 }).area.w, 0);
});

test("classic: the tile starts below the HUD, which floats over the board", () => {
  const out = classicLayout([cardOf("p", "project"), cardOf("e1", "editor")], { width: 1000, height: 500 }, { top: 30 });
  assert.equal(out.tabs.y, 30);
  assert.equal(out.area.y, 30 + CLASSIC_TAB_H);
  assert.equal(out.sidebar.h, 470);
  const squashed = classicLayout([cardOf("e1", "editor")], { width: 1000, height: 20 }, { top: 30 });
  assert.equal(squashed.tabHeight, 0, "a strip taller than what is left is not drawn hanging off the board");
  assert.equal(squashed.area.h, 0);
});

test("classic: a tab is the last segment of the path, either slash", () => {
  assert.equal(classicTabLabel("core/src/wksp.c"), "wksp.c");
  assert.equal(classicTabLabel("shell\\web\\main.mjs"), "main.mjs");
  assert.equal(classicTabLabel("notes"), "notes");
  assert.equal(classicTabLabel("a/b/"), "a/b/", "a trailing slash is not a name");
  assert.equal(classicTabLabel(""), "");
  assert.equal(classicTabLabel(null), "");
  assert.equal(classicTabLabel(undefined), "");
});

/*
 * `views.mjs` is the whole vocabulary of the `mode` command, so what it holds
 * is pinned here: two tiled views, and no third word the shell has to keep
 * alive.  Whether `mode board` *runs* is a different question, asked further
 * down through the real command line, where the warning it must print lives.
 */
test("views: the two tiles are the whole registry, and any other name is refused", () => {
  assert.deepEqual(VIEWS, ["classic", "mod"], "the canvas view is gone from the list");
  assert.equal(viewName("classic"), "classic");
  assert.equal(viewName("  Mod "), "mod", "the command line is not case-sensitive");
  assert.equal(viewName("board"), null, "the word that named the canvas view names no view now");
  assert.equal(viewName("Board"), null, "and not in another case either");
  assert.equal(viewName("  board  "), null, "nor with the whitespace a person might type");
  assert.equal(viewName("tabs"), null, "an unknown word must warn, not fall back silently");
  assert.equal(viewName(""), null);
  assert.equal(viewName(undefined), null);
  assert.equal(viewName(3), null);
});

test("views: every view is a tile, and nothing else is one", () => {
  for (const view of VIEWS) {
    assert.equal(tiledView(view), true, `${view}: every view there is draws a tile`);
  }
  assert.equal(tiledView("board"), false, "the canvas is not a tile, because it is not a view any more");
  assert.equal(tiledView("sideways"), false, "an unknown view is not a tile, so it cannot be drawn");
});

test("views: the window opens on the mod view, and the switch offers every view there is", () => {
  assert.equal(BOOT_VIEW, "mod", "a window opens where a mod author works: the mod view");
  assert.equal(VIEWS.indexOf(BOOT_VIEW) !== -1, true, "the boot view has to be a name `mode` accepts");
  assert.ok(VIEWS.length > 1, "there is more than one view, so booting in one leaves a way out");
  assert.equal(DEFAULT_VIEW, "classic", "the *fallback* word stays classic: only the window's own choice moved");
  assert.equal(VIEWS.indexOf(DEFAULT_VIEW) !== -1, true, "the fallback still has to be a name `mode` accepts");
  assert.deepEqual(SWITCH_VIEWS, VIEWS, "every view is on the switch, and no switch offers a name `mode` refuses");
  assert.equal(SWITCH_VIEWS.indexOf(BOOT_VIEW) !== -1, true, "the view a window opens in must be one you can leave");
  assert.equal(VIEWS.indexOf("board"), -1, "the board is a document and a file, not a way to look at them");
  assert.equal(SWITCH_VIEWS.indexOf("board"), -1);
});

test("settings: the boot view and the poll interval come from the file, with fallbacks", () => {
  // A window with no answer (an older shell, a trimmed build) is the constants.
  assert.deepEqual(bootPreferencesFrom(null), { bootView: BOOT_VIEW, watchPollMs: null });
  assert.deepEqual(bootPreferencesFrom({}), { bootView: BOOT_VIEW, watchPollMs: null });
  assert.deepEqual(bootPreferencesFrom({ prefs: null }), { bootView: BOOT_VIEW, watchPollMs: null });

  // What the file says, when it says something a window can honour.
  assert.deepEqual(
    bootPreferencesFrom({ prefs: { bootView: "classic", watchPollMs: 750 } }),
    { bootView: "classic", watchPollMs: 750 },
    "the file names the view and the interval, and both travel",
  );

  // A view `mode` does not accept, or an interval outside the range the form
  // offers, falls back rather than half-applying: a window does not open on a
  // view that does not exist, and does not poll every millisecond.
  for (const view of ["board", "", "MOD", 7, null]) {
    assert.equal(bootPreferencesFrom({ prefs: { bootView: view } }).bootView, BOOT_VIEW,
      `${JSON.stringify(view)} is not a view a window can open in`);
  }
  for (const poll of [0, 10, 249, 60001, -1, 1.5, "1500", null]) {
    assert.equal(bootPreferencesFrom({ prefs: { watchPollMs: poll } }).watchPollMs, null,
      `${JSON.stringify(poll)} is not an interval the window may use`);
  }
  assert.equal(bootPreferencesFrom({ prefs: { watchPollMs: 250 } }).watchPollMs, 250,
    "the low end of the form's range is honoured");
  assert.equal(bootPreferencesFrom({ prefs: { watchPollMs: 60000 } }).watchPollMs, 60000,
    "the high end of the form's range is honoured");
});

test("views: a switch button has a label and a tooltip whichever view is on it", () => {
  for (const view of VIEWS) {
    assert.equal(typeof VIEW_LABELS[view], "string", `${view}: a button needs a label`);
    assert.equal(typeof VIEW_TITLES[view], "string", `${view}: a button title of undefined is not a title`);
    assert.ok(VIEW_TITLES[view].length > 20, `${view}: the tooltip says something about the view`);
  }
  assert.deepEqual(
    Object.keys(VIEW_TITLES).sort(),
    [...VIEWS].sort(),
    "and nothing besides the views: a title for no view is dead weight",
  );
  assert.deepEqual(
    Object.keys(VIEW_LABELS).sort(),
    [...VIEWS].sort(),
    "a label for a view that is gone is dead weight too",
  );
});

test("views: every view names the ways out of it and says what it is", () => {
  for (const view of VIEWS) {
    const note = viewNote(view);
    assert.ok(note.indexOf(`the ${view} view`) !== -1, `${view}: the note says where you are`);
    for (const other of VIEWS) {
      if (other !== view) {
        assert.ok(note.indexOf(`mode ${other}`) !== -1, `${view}: the note names how to reach ${other}`);
      }
    }
    assert.ok(viewAbout(view).length > 20, `${view}: it has a sentence of its own`);
  }
  assert.notEqual(viewAbout("mod"), viewAbout("classic"), "the two tiles are described differently");
  assert.equal(viewAbout("board"), viewAbout(DEFAULT_VIEW), "a word naming no view falls back to the one a window opens in");
  assert.equal(viewNote("board"), viewNote(DEFAULT_VIEW), "the note does too, so a stray word cannot leave a blank line");
});

/*
 * The document did not go away with the view that drew every card whole.  A
 * `.infantgod/board.json` still carries cards, links and a viewport, and a
 * load/save pair still has to be the identity on it -- opening a file written
 * before the canvas went must not rewrite it.
 */
test("views: the board document still round-trips, viewport and links included", () => {
  const doc = {
    version: 1,
    viewport: { x: -140, y: 60, zoom: 0.75 },
    cards: [
      { id: "a", kind: "note", x: 12, y: -34, w: 260, h: 180, z: 1, text: "hello" },
      { id: "b", kind: "editor", x: -40, y: 8, w: 420, h: 300, z: 2, file: "src/a.yarn" },
    ],
    links: [{ id: "l1", from: "a", to: "b", label: "runs" }],
  };
  const board = createBoard(JSON.parse(JSON.stringify(doc)));
  assert.deepEqual(board.serialize(), doc, "load and save are the identity on a document that needs no repair");
  assert.deepEqual(board.serialize().viewport, doc.viewport, "the pan and the zoom are fields a save still keeps");
  const reloaded = normaliseDocument(JSON.parse(JSON.stringify(doc)));
  assert.deepEqual(reloaded.document, doc, "and the repair pass has nothing to repair in an old file");
});

/*
 * The registry cannot say whether `mode board` *runs*; only `createApp` can,
 * because the warning lives inside its `mode` branch.  So the whole shell is
 * built under the element stub above, a real command is typed at it, and the
 * view it paints onto `<body>` is read back: `mode mod` has to move it, and
 * `mode board` has to leave it exactly where it was while saying why.
 */
await testAsync("views: `mode board` is refused by the real command line, and moves nothing", async () => {
  const unknownView = 'unknown view "board". Try `mode classic`, `mode mod`.';
  const dom = stubAppDom();
  try {
    const app = createApp();
    assert.deepEqual(dom.viewClasses(), ["is-mod"], "a window opens in the mod view");
    await app.runCommand("mode classic");
    assert.deepEqual(dom.viewClasses(), ["is-classic"], "`mode classic` moves the view, so the next check says something");
    await app.runCommand("mode board");
    assert.deepEqual(dom.viewClasses(), ["is-classic"], "`mode board` cannot move a view that no longer exists");
    const lines = dom.logLines();
    const last = lines[lines.length - 1];
    assert.ok(last !== undefined, "the command answered");
    assert.match(String(last.className), /log-warn/, "an unknown view is a warning, not a silent no-op");
    assert.ok(
      dom.text(last).endsWith(unknownView),
      `the warning names the two views there are, got: ${dom.text(last)}`,
    );
  } finally {
    dom.restore();
  }
});

/*
 * G29: the canvas could show a note, a sheet or a runner at the same time as
 * the code; a tile cannot, so the strip is what keeps every other kind one
 * press away.  This drives the real shell: a note opened from the command line
 * has to appear as a real button in `#tabs` (not as a hidden card with a div
 * where its tab should be), the card root has to accept the focus that tab
 * sends it, and selecting it has to put it in the area instead of leaving it
 * hidden.  Stub DOM: no layout, no focus -- so the classes and the tab data are
 * the evidence.
 */
await testAsync("G29: a note opened from the command line gets a tab, and that tab puts it in the area", async () => {
  const dom = stubAppDom();
  // The shell draws on a frame (`scheduleRender`), and the stub's frame is a
  // zero-delay timer: assertions about what the strip shows have to let it run.
  const settle = () => new Promise((resolve) => setTimeout(resolve, 20));
  try {
    const app = createApp();
    assert.equal(dom.viewClasses().includes("is-mod"), true, "a window opens in the mod view");
    await app.runCommand("note hello from the strip");
    await settle();
    const cards = dom.element("cards").children;
    assert.equal(cards.length, 1, "the note card is mounted");
    const note = cards[0];
    const id = note.getAttribute("data-card-id");
    assert.equal(id, app.board.cards[0].id, "the root is the card the board holds");
    assert.equal(note.dataset.kind, "note");
    assert.equal(note.tabIndex, -1, "the card root can take the focus a tab sends it");
    let tabs = dom.element("tabs").children;
    assert.equal(tabs.length, 1, "the strip offers the note: one button per open card the tile has no place for");
    assert.equal(tabs[0].dataset.cardId, id);
    assert.equal(tabs[0].dataset.kind, "note", "the tab knows which kind it opens");
    assert.equal(
      note.classList.contains("is-hidden"),
      false,
      "with nothing else open the note takes the area -- the tab is where the other kinds come from",
    );
    // A code card takes the area the moment there is one, and the note keeps its
    // tab: that is the whole point -- the kind the tile used to hide is one press
    // from the area instead of unreachable.
    app.board.addCard("editor", 40, 40, { path: "Mods/NewMod/mod.json" }, { w: 600, h: 400 });
    await settle();
    assert.equal(note.classList.contains("is-hidden"), true, "a code card takes the area, the note waits in the strip");
    assert.equal(dom.element("tabs").children.length, 2, "the note kept its tab");
    await app.runCommand(`focus ${id}`);
    await settle();
    assert.equal(note.classList.contains("is-hidden"), false, "selecting the note draws it in the area");
    assert.match(String(note.style.transform), /^translate\(/, "in the area, not at 0,0");
    tabs = dom.element("tabs").children;
    const active = tabs.filter((tab) => tab.getAttribute("aria-current") === "true");
    assert.equal(active.length, 1, "one tab says it is the one showing");
    assert.equal(active[0].dataset.cardId, id, "and it is the note's");
    assert.equal(active[0].classList.contains("is-active"), true, "the strip marks it too");
    // The frame that drew all of this has landed; a frame still queued when the
    // document is swapped back would draw into the next test's stub.
    await settle();
  } finally {
    dom.restore();
  }
});

/*
 * D3: the user saw "the board on disk is now rev N; you have unsaved changes"
 * after their own autosave.  The kernel notifies *before* it answers the write,
 * so the event arrives while `saving` is still true and `boardRevision` still
 * names the document before it; judging on arrival made every save's own echo
 * look like another writer.  The rule below is the whole decision, and it is
 * asked only after the reply has updated the two values it reads.
 */
test("D3: a view.changed revision is our own echo, a warning, or news to follow", () => {
  assert.equal(classifyViewEvent({ revision: 7, boardRevision: 7, dirty: false }), "echo", "our own write: quiet");
  assert.equal(classifyViewEvent({ revision: 7, boardRevision: 7, dirty: true }), "echo", "even with more edits pending");
  assert.equal(
    classifyViewEvent({ revision: 8, boardRevision: 7, dirty: true }),
    "warn",
    "another writer arriving while we have unsaved edits: warn, never overwrite",
  );
  assert.equal(
    classifyViewEvent({ revision: 8, boardRevision: 7, dirty: false }),
    "adopt",
    "another writer with nothing of ours to lose: follow the disk",
  );
  assert.equal(
    classifyViewEvent({ revision: 8, boardRevision: null, dirty: false }),
    "adopt",
    "an event before any revision is known has nothing to be an echo of",
  );
});

/*
 * D1: File -> "新建模组" used to reload the window and leave the scaffolded
 * package invisible, because the board on disk still held `mod(dir: "")`.  The
 * reload now carries the directory in the URL; this is the reader for it.
 */
test("D1: a ?mod= boot reads the package directory out of the query string", () => {
  assert.equal(
    requestedModFromSearch("?mod=C%3A%5Cwork%5CNewMod"),
    "C:\\work\\NewMod",
    "the path is decoded, backslashes included",
  );
  assert.equal(requestedModFromSearch("?mod=/tmp/NewMod"), "/tmp/NewMod", "an absolute POSIX path survives");
  assert.equal(requestedModFromSearch("?a=1&mod=Mods%2FNewMod"), "Mods/NewMod", "not just the first parameter");
  assert.equal(requestedModFromSearch("?mod="), null, "an empty value names no package");
  assert.equal(requestedModFromSearch("?mod=%20"), null, "nor does whitespace");
  assert.equal(requestedModFromSearch(""), null, "no query string: nothing to open");
  assert.equal(requestedModFromSearch("?mod"), null, "a flag with no value: nothing to open");
  assert.equal(requestedModFromSearch(undefined), null, "a non-string search is not a crash");
});

/*
 * The three files that used to carry the canvas cannot be trusted to have let
 * go of it just because the registry did.  Read as text, so a leftover is a
 * failure here rather than a surprise in a browser nobody has open.
 */
test("views: no source still carries the canvas view, its zoom or its link layer", () => {
  const main = readFileSync(new URL("../main.mjs", import.meta.url), "utf8");
  const views = readFileSync(new URL("../views.mjs", import.meta.url), "utf8");
  const html = readFileSync(new URL("../index.html", import.meta.url), "utf8");
  assert.doesNotMatch(main, /zoomAbout/, "the zoom arithmetic went with the canvas");
  assert.doesNotMatch(main, /viewportTouched/, "so did the flag that said the viewport had been panned");
  assert.doesNotMatch(main, /"hud-zoom"/, "and the HUD readout that showed it");
  assert.doesNotMatch(views, /viewHud/, "the registry no longer answers a question only a canvas had");
  assert.doesNotMatch(html, /id="hud-zoom"/, "the readout's element left the page with it");
  assert.doesNotMatch(html, /id="links"/, "the drawn link layer went too: links are document data, not lines");
  assert.match(html, /id="board"/, "the board host itself stays: it is the document's one element");
});

test("mod: the package is the sidebar, the report is the panel, both before their fallbacks", () => {
  const board = [cardOf("n", "note"), cardOf("f", "files"), cardOf("p", "project"), cardOf("m", "mod")];
  assert.equal(modRoles(board).sidebar, "m", "a mod package beats the project panel and the file list");
  assert.equal(modRoles([cardOf("p", "project"), cardOf("f", "files")]).sidebar, "p");
  assert.equal(modRoles([cardOf("f", "files")]).sidebar, "f", "the file list is the last resort");
  assert.equal(modRoles([cardOf("n", "note")]).sidebar, null, "a note is not a package tree");
  assert.equal(modRoles([cardOf("x", "problems")]).panel, "x");
  assert.equal(modRoles([cardOf("n", "note")]).panel, null, "no report card, no panel");
});

test("mod: the area follows the focused card, and a focused note is not a file", () => {
  const board = [cardOf("e1", "editor"), cardOf("e2", "editor"), cardOf("n", "note")];
  assert.equal(modRoles(board, "e2").area, "e2", "the focused file is the one a command would act on");
  assert.equal(modRoles(board, "n").area, "n", "a note the strip offers fills the area: pressing its tab shows it");
  assert.equal(modRoles(board, null).area, "e1");
  assert.equal(modRoles([cardOf("n", "note")]).area, "n", "a view whose only card is a note still draws the note");
  assert.deepEqual(modRoles(board, "e2").tabs, ["e1", "e2", "n"], "every card with no part is a tab, in board order");
});

test("mod: a card has one part, and the parts do not overlap", () => {
  const board = [cardOf("m", "mod"), cardOf("e1", "editor"), cardOf("x", "problems"), cardOf("n", "note")];
  const roles = modRoles(board, "e1");
  const parts = [roles.sidebar, roles.area, roles.panel];
  assert.equal(new Set(parts).size, 3, "three roles, three different cards");
  for (const id of parts) {
    assert.equal(roles.hidden.indexOf(id), -1, `${id} plays a part, so it is not also hidden`);
  }
  assert.deepEqual(roles.hidden, ["n"], "the note is a tab, not a second pane");
  assert.deepEqual(roles.tabs, ["e1", "n"], "and the strip is what keeps it reachable");
  assert.equal(modRoles([cardOf("m", "mod")], "m").area, null, "the package cannot double as the code area");
});

test("mod: the tile has no gap and no overlap, at any size", () => {
  const board = [cardOf("m", "mod"), cardOf("e1", "editor"), cardOf("x", "problems")];
  for (const width of [1600, 1200, 900, 700, 400, 200]) {
    for (const height of [900, 700, 500, 300, 240]) {
      const out = modLayout(board, { width, height }, { activeId: "e1", top: 30 });
      const where = `${width}x${height}`;
      assert.equal(out.tabs.x, out.sidebarWidth, `${where}: the strip starts where the column ends`);
      assert.equal(out.area.x, out.sidebarWidth, `${where}: the code starts where the column ends`);
      assert.equal(out.tabs.y, 30, `${where}: the strip starts under the HUD`);
      assert.equal(out.tabs.y + out.tabs.h, out.area.y, `${where}: the area begins where the strip ends`);
      assert.equal(out.tabs.w, out.area.w, `${where}: strip and area are the same column`);
      if (out.panel !== null) {
        assert.equal(out.area.y + out.area.h, out.panel.y, `${where}: the panel begins where the code ends`);
        assert.equal(out.panel.w, out.area.w, `${where}: the panel is as wide as the code`);
        assert.equal(out.panel.y + out.panel.h, height, `${where}: the panel ends on the bottom edge`);
      } else {
        assert.equal(out.area.y + out.area.h, height, `${where}: with no panel the code reaches the bottom`);
      }
      assert.equal(out.sidebar.y, 30, `${where}: the column starts under the HUD`);
      assert.equal(out.sidebar.y + out.sidebar.h, height, `${where}: the column is as tall as the board`);
      assert.ok(out.sidebar.w + out.area.w <= width, `${where}: column and code fit side by side`);
      assert.ok(out.area.h >= 0, `${where}: the code area is never negative`);
      if (out.panel !== null) {
        assert.ok(out.panel.h >= 0, `${where}: the panel is never negative`);
      }
    }
  }
});

test("mod: the sidebar squeezes to 40%, never below 180, until the window itself is narrower", () => {
  const board = [cardOf("m", "mod"), cardOf("e1", "editor")];
  const widthAt = (width) => modLayout(board, { width, height: 600 }).sidebarWidth;
  assert.equal(widthAt(2000), MOD_SIDEBAR_W, "a wide window gets the comfortable width");
  assert.equal(widthAt(1200), MOD_SIDEBAR_W);
  assert.equal(widthAt(700), 280, "40% of 700 is 280");
  assert.equal(widthAt(500), 200, "40% of 500 is 200");
  assert.equal(widthAt(400), MOD_SIDEBAR_MIN, "below 450 the column stops shrinking at its readable minimum");
  assert.equal(widthAt(100), 100, "a window narrower than the column gives it the whole window");
  assert.equal(modLayout([cardOf("e1", "editor")], { width: 1200, height: 600 }).sidebarWidth, 0, "no sidebar card, no column");
  assert.equal(modLayout(board, { width: 1200, height: 600 }).area.w, 1200 - MOD_SIDEBAR_W);
});

test("mod: a window too short for both drops the panel and gives the height to the code", () => {
  const board = [cardOf("m", "mod"), cardOf("e1", "editor"), cardOf("x", "problems")];
  const tall = modLayout(board, { width: 1200, height: 900 }, { top: 30 });
  assert.equal(tall.panelHeight, MOD_PANEL_H, "a tall window gets the comfortable panel");
  assert.equal(tall.panel.h, MOD_PANEL_H);
  const short = modLayout(board, { width: 1200, height: 240 }, { top: 30 });
  assert.equal(short.panelHeight, 0, "no room to keep both, so the panel goes");
  assert.equal(short.panel, null, "and there is no rectangle to draw it in");
  assert.equal(short.boxes.has("x"), false, "a panel with no height is not placed at 0,0");
  assert.equal(short.area.y + short.area.h, 240, "the code takes the whole column back");
  const justEnough = modLayout(board, { width: 1200, height: 300 }, { top: 30 });
  assert.ok(justEnough.panelHeight >= MOD_PANEL_MIN, "the panel is either readable or absent");
  assert.ok(justEnough.area.h >= MOD_AREA_MIN, "the code keeps its minimum whenever the panel is drawn");
});

test("mod: with no report card the tile is the classic one, plus a package column", () => {
  const board = [cardOf("m", "mod"), cardOf("e1", "editor"), cardOf("n", "note")];
  const out = modLayout(board, { width: 1200, height: 800 }, { activeId: "e1", top: 30 });
  assert.equal(out.panelHeight, 0);
  assert.equal(out.tabHeight, MOD_TAB_H);
  assert.equal(out.boxes.size, 2, "the column and the code area, and nothing else");
  assert.equal(out.boxes.has("n"), false, "the note has no home here: hiding it is the answer");
  assert.deepEqual(out.roles.hidden, ["n"]);
});

test("mod: the layout is a projection -- it never writes to a card", () => {
  const board = [
    cardOf("m", "mod", { x: 40, y: 60 }),
    cardOf("e1", "editor", { x: 700, y: 400, w: 500, h: 400 }),
    cardOf("x", "problems"),
  ];
  const before = JSON.parse(JSON.stringify(board));
  const out = modLayout(board, { width: 1200, height: 800 }, { activeId: "e1", top: 30 });
  assert.notEqual(out.boxes.get("e1").x, 700, "the code area is somewhere else on screen");
  assert.notEqual(out.boxes.get("x").y, out.boxes.get("e1").y, "the report is under the code, not on it");
  assert.deepEqual(board, before, "but the document is untouched -- a switch to the other tile has to lose no card");
});

test("mod: a panel kind and a sidebar kind are disjoint by rule, not by accident", () => {
  for (const kind of MOD_SIDEBAR_KINDS) {
    assert.equal(MOD_PANEL_KINDS.indexOf(kind), -1, `${kind} cannot be both the column and the panel`);
  }
});

test("classic: a card with no place in the tile is hidden, not placed at 0,0", () => {
  const board = [cardOf("p", "project"), cardOf("e1", "editor", { x: 700, y: 400 }), cardOf("n", "note")];
  const out = classicLayout(board, { width: 1200, height: 800 }, { activeId: "e1" });
  assert.equal(out.boxes.size, 2, "only the sidebar and the code area are drawn");
  assert.equal(out.boxes.has("n"), false, "the note has no home here: hiding it is the answer");
  assert.deepEqual(out.roles.hidden, ["n"]);
});

test("classic: the layout is a projection -- it never writes to a card", () => {
  const board = [cardOf("p", "project", { x: 40, y: 60 }), cardOf("e1", "editor", { x: 700, y: 400, w: 500, h: 400 })];
  const before = JSON.parse(JSON.stringify(board));
  const out = classicLayout(board, { width: 1200, height: 800 }, { activeId: "e1", top: 30 });
  assert.notEqual(out.boxes.get("e1").x, 700, "the code area is somewhere else on screen");
  assert.deepEqual(board, before, "but the document is untouched -- a switch to the other tile has to lose no card");
});
