/* ------------------------------------------------------------------ */
/* board.mjs
/* ------------------------------------------------------------------ */

import assert from "node:assert/strict";
import {
  CARD_KINDS,
  MIN_SIZE,
  ZOOM_MAX,
  ZOOM_MIN,
  clampViewport,
  createBoard,
  normaliseDocument,
} from "../board.mjs";
import {
  test,
} from "./harness.mjs";

/* ------------------------------------------------------------------ */
/* board.mjs                                                           */
/* ------------------------------------------------------------------ */

test("board: addCard/moveCard/linkCards/serialize round-trips", () => {
  let next = 1;
  const board = createBoard(undefined, { idFactory: () => `c${next++}` });
  const a = board.addCard("editor", 40, 60, { file: "examples/hello.yarn" });
  const b = board.addCard("runner", 720, 300, { cmd: "python tools/e2e.py examples/hello.yarn", cwd: "." });
  const link = board.linkCards(a.id, b.id, "runs");

  assert.equal(a.id, "c1");
  assert.equal(b.id, "c2");
  assert.equal(link.id, "l1");
  assert.equal(a.z < b.z, true, "a later card is raised above an earlier one");

  board.moveCard(a.id, 100, 120);
  assert.equal(a.x, 100);
  assert.equal(a.y, 120);

  const doc = board.serialize();
  assert.equal(doc.version, 1);
  assert.deepEqual(doc.viewport, { x: 0, y: 0, zoom: 1 });
  assert.equal(doc.cards.length, 2);
  assert.deepEqual(doc.links, [{ id: "l1", from: "c1", to: "c2", label: "runs" }]);
  assert.deepEqual(doc.cards[0], {
    id: "c1", kind: "editor", x: 100, y: 120, w: 640, h: 420, z: 1, file: "examples/hello.yarn",
  });
  // A second card re-loads from exactly what serialize() produced.
  const again = createBoard(doc);
  assert.deepEqual(again.serialize(), doc);
  assert.equal(CARD_KINDS.includes("files"), true);
});

test("board: serialize returns a copy, so mutating it cannot corrupt the model", () => {
  const board = createBoard(undefined, { idFactory: () => "c9" });
  board.addCard("note", 0, 0, { text: "scratch" });
  const doc = board.serialize();
  doc.cards[0].x = 9999;
  doc.cards.push({ id: "ghost", kind: "note", x: 0, y: 0, w: 1, h: 1 });
  doc.viewport.zoom = 99;
  assert.equal(board.cards.length, 1);
  assert.equal(board.cards[0].x, 0);
  assert.equal(board.viewport.zoom, 1);
});

test("board: removeCard drops the links that pointed at it", () => {
  const ids = ["c1", "c2", "c3"];
  const board = createBoard(undefined, { idFactory: () => ids.shift() });
  const a = board.addCard("editor", 0, 0);
  const b = board.addCard("note", 10, 10);
  const c = board.addCard("runner", 20, 20);
  board.linkCards(a.id, b.id);
  board.linkCards(b.id, c.id);
  assert.equal(board.links.length, 2);
  assert.equal(board.removeCard(b.id), true);
  assert.equal(board.links.length, 0, "a link to a dead card is not a document this format can write");
  assert.equal(board.removeCard("nope"), false);
});

test("board: an unreadable document is repaired on load", () => {
  const result = normaliseDocument({
    version: 1,
    viewport: { x: "nope", y: 5, zoom: 900 },
    cards: [
      { id: "c1", kind: "note", x: 0, y: 0, w: 0, h: -20 },
      { id: "c1", kind: "note", x: 1, y: 1, w: 10, h: 10 },
      { id: "", kind: "note", x: 1, y: 1, w: 10, h: 10 },
      "not a card",
      { id: "c2", kind: "runner", x: 2, y: 2, w: 10, h: 10 },
    ],
    links: [
      { id: "l1", from: "c1", to: "c2" },
      { id: "l2", from: "c1", to: "ghost" },
      { id: "l3", from: "ghost", to: "c2" },
    ],
  });
  assert.equal(result.document.cards.length, 2, "the duplicate and the malformed card are dropped");
  assert.equal(result.droppedCards.length, 3);
  assert.equal(result.droppedLinks, 2);
  assert.equal(result.document.cards[0].w, MIN_SIZE.w, "a zero width is repaired, not fatal");
  assert.equal(result.document.cards[0].h, MIN_SIZE.h);
  assert.equal(result.document.cards[0].z, 0, "a missing z defaults to 0, as normaliseCard does");
  assert.equal(result.document.viewport.x, 0);
  assert.equal(result.document.viewport.y, 5);
  assert.equal(result.document.viewport.zoom, ZOOM_MAX);
});

test("board: viewport zoom is clamped and non-finite input falls back", () => {
  assert.deepEqual(clampViewport({ zoom: 100 }), { x: 0, y: 0, zoom: ZOOM_MAX });
  assert.deepEqual(clampViewport({ zoom: 0 }), { x: 0, y: 0, zoom: ZOOM_MIN });
  assert.deepEqual(clampViewport({ zoom: NaN, x: Infinity }), { x: 0, y: 0, zoom: 1 });
  assert.deepEqual(clampViewport(undefined), { x: 0, y: 0, zoom: 1 });
  assert.deepEqual(clampViewport({ x: 99, y: -99, zoom: 2.5 }), { x: 99, y: -99, zoom: 2.5 });

  const board = createBoard();
  assert.equal(board.setViewport({ zoom: 500 }).zoom, ZOOM_MAX);
  assert.equal(board.setViewport({ zoom: 0.001 }).zoom, ZOOM_MIN);
  assert.equal(board.setViewport({ x: 10 }).zoom, ZOOM_MIN, "an omitted zoom keeps its value");
});

test("board: resize clamps to the minimum, raise puts a card on top", () => {
  const ids = ["c1", "c2"];
  const board = createBoard(undefined, { idFactory: () => ids.shift() });
  const a = board.addCard("note", 0, 0);
  const b = board.addCard("note", 0, 0);
  board.resizeCard(a.id, 1, 1);
  assert.equal(a.w, MIN_SIZE.w);
  assert.equal(a.h, MIN_SIZE.h);
  board.raiseCard(a.id);
  assert.ok(a.z > b.z);
});

test("board: unknown card kinds and extra fields survive a round trip", () => {
  const board = createBoard({
    version: 1,
    cards: [{ id: "c1", kind: "timeline", x: 1, y: 2, w: 3, h: 4, marks: [1, 2, 3] }],
    links: [],
  });
  const doc = board.serialize();
  assert.equal(doc.cards[0].kind, "timeline");
  assert.deepEqual(doc.cards[0].marks, [1, 2, 3]);
});

test("board: adding a card with an id that is already in use throws", () => {
  const board = createBoard(undefined, { idFactory: () => "c1" });
  board.addCard("note", 0, 0);
  assert.throws(() => board.addCard("note", 0, 0), /already used/);
});

test("board: link ids are unique board-wide, and unlink removes exactly one", () => {
  const board = createBoard();
  const a = board.addCard("editor", 0, 0);
  const b = board.addCard("runner", 400, 0);

  const first = board.addLink(a.id, b.id, "runs", "L1");
  assert.equal(first.id, "L1");
  // Accepting the collision would let the UI build a document its own writer
  // refuses, so it is an error, not a second link.
  assert.throws(() => board.addLink(a.id, b.id, "second", "L1"), /already used/,
    "an id that is already in use must be refused");
  assert.throws(() => board.addLink(a.id, b.id, "empty", ""), /must not be empty/);
  assert.equal(board.links.length, 1, "a refused link is not in the document");
  assert.deepEqual(board.links.map((link) => link.id), ["L1"]);

  /*
   * A file can still carry the collision even though the API now refuses it.
   * The loader keeps both edges and renames the second: losing a connection the
   * user can see is the worse repair, and a document with two links named `L1`
   * is one this format cannot write back.
   */
  const doc = board.serialize();
  doc.links = [{ ...doc.links[0] }, { ...doc.links[0] }];
  const repaired = normaliseDocument(doc);
  assert.deepEqual(repaired.repairedLinkIds, ["L1"], "the renamed id is reported, not just counted");
  assert.equal(repaired.document.links.length, 2, "the duplicate edge is kept, not dropped");
  assert.equal(new Set(repaired.document.links.map((link) => link.id)).size, 2);
  board.load(repaired.document);
  assert.doesNotThrow(() => board.serialize(), "the repaired board is a document this format accepts");

  /*
   * The API cannot build a collision any more, so make one behind its back.
   * `unlink <id>` has to remove one edge: `findIndex`/`splice` where a `filter`
   * used to remove every link that shared the id.
   */
  board.document.links.push({ id: "L1", from: a.id, to: b.id });
  assert.equal(board.links.length, 3);
  assert.throws(() => board.serialize(), /repeats link id "L1"/,
    "serialize refuses a document it cannot write");
  assert.equal(board.unlink("L1"), true);
  assert.equal(board.links.length, 2, "exactly one link was removed");
  assert.equal(board.links.filter((link) => link.id === "L1").length, 1, "the other link keeps its id");
  assert.equal(board.unlink("L1"), true, "the second link with that id is still there to remove");
  assert.equal(board.unlink("L1"), false, "removing a missing link reports false");
});

test("board: serialize refuses an invalid card instead of dropping it quietly", () => {
  const board = createBoard();
  board.addCard("note", 0, 0, { text: "keep me" });
  assert.equal(board.serialize().cards.length, 1);

  /*
   * A save that trims the card out reports success while the card is missing
   * from disk -- the one outcome a board-first editor must never produce. The
   * bad entry is kept in the model and named in the error instead.
   */
  board.document.cards.push({ id: "", kind: "note", x: 0, y: 0, w: 10, h: 10, z: 1 });
  assert.throws(() => board.serialize(), /cards\[1\] is not a valid card/);
  assert.equal(board.document.cards.length, 2, "the invalid card is kept, not silently dropped");

  // A repeated card id is refused for the same reason.
  board.document.cards.pop();
  board.document.cards.push({ ...board.document.cards[0] });
  assert.throws(() => board.serialize(), /repeats card id "c1"/);
  assert.equal(board.document.cards.length, 2);
});
