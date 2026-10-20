/* ------------------------------------------------------------------ */
/* main.mjs, the game layer's pure helpers, undo and redo
/* ------------------------------------------------------------------ */

import assert from "node:assert/strict";
import {
  diagCounts,
  diagFile,
  diagWhere,
  groupDefines,
  modHeadline,
  modPath,
  renderCard,
  unknownCardPlaceholder,
} from "../cards.mjs";
import {
  createHistory,
  describeChange,
} from "../history.mjs";
import {
  saveOutcomeMessage,
  wireChoiceStrip,
} from "../main.mjs";
import {
  isAbsolutePath,
  isInsideWorkspace,
} from "../openpath.mjs";
import {
  WATCH_GONE,
  WATCH_OK,
  WATCH_RELOAD,
  WATCH_UNKNOWN,
  WATCH_WARN,
  watchDecision,
  watchReport,
  watchStateOf,
  watchTarget,
  watchTrimmed,
} from "../watch.mjs";
import {
  stubDom,
  stubEventTarget,
  tick,
} from "./fixtures.mjs";
import {
  test,
  testAsync,
} from "./harness.mjs";

/* ------------------------------------------------------------------ */
/* main.mjs -- the two DOM-free helpers behind the browser fixes        */
/* ------------------------------------------------------------------ */

test("cards: renderCard renders a placeholder for null, undefined and unknown kinds", () => {
  const dom = stubDom();
  try {
    // board.json is user-editable, so one malformed entry must not take the
    // whole tile down: every one of these used to throw, and a throw inside
    // the render loop left the rest of the board unpainted.
    for (const entry of [null, undefined, 42, ["not", "a", "card"], { kind: "nope", id: "c1" }, { id: "c2" }]) {
      let card = null;
      assert.doesNotThrow(() => {
        card = renderCard(entry, {});
      }, `renderCard(${JSON.stringify(entry)}) must not throw`);
      assert.ok(card !== null && card.el, "a placeholder element is produced");
      assert.equal(typeof card.destroy, "function", "a placeholder is still destroyable");
      assert.ok(card.handle && typeof card.handle.focus === "function", "a placeholder is still focusable");
    }

    const missing = renderCard(null, {});
    assert.equal(missing.el.attrs["data-card-id"], "");
    assert.match(dom.text(missing.el), /empty \(null\)/);
    assert.match(dom.text(missing.el), /Known kinds: editor/);
    assert.equal(missing.handle.kind, "(none)");

    const unknown = renderCard({ kind: "nope", id: "c1" }, {});
    assert.equal(unknown.el.attrs["data-card-id"], "c1", "the entry keeps its own id");
    assert.match(dom.text(unknown.el), /No renderer for card kind "nope"/);
    assert.equal(unknown.handle.kind, "nope");

    // The pure decision behind it is checked directly as well, so a stub that
    // silently swallowed a throw could not make the check above pass.
    assert.equal(unknownCardPlaceholder(null).label, "(missing)");
    assert.equal(unknownCardPlaceholder(undefined).kind, "(none)");
    assert.equal(unknownCardPlaceholder(42).kind, "(not a card)");
    assert.equal(unknownCardPlaceholder({ kind: "nope" }).label, "(unknown)");
  } finally {
    dom.restore();
  }
});

await testAsync("main: ask's inline choice strip removes its command-line listener on every exit", async () => {
  /*
   * `ask()` itself is four lines: build a strip, build buttons, hand them to
   * `wireChoiceStrip`.  All listener bookkeeping lives in the helper, so this is
   * the check that the leak the browser had cannot come back: the listener must
   * be gone whether the question was answered, abandoned, or died part-way.
   */
  const strip = () => ({ removed: 0, remove() { this.removed += 1; } });

  // Answered by clicking.
  let command = stubEventTarget();
  let panel = strip();
  let button = stubEventTarget();
  let answer = wireChoiceStrip({ strip: panel, buttons: [{ el: button, value: "yes" }], abandonSource: command });
  assert.equal(command.count("input"), 1, "the question listens while it is open");
  button.fire("click");
  assert.equal(await answer, "yes");
  assert.equal(command.count("input"), 0, "the listener is gone once the question is answered");
  assert.equal(panel.removed, 1, "the strip is detached once");

  // Abandoned by typing.
  command = stubEventTarget();
  panel = strip();
  button = stubEventTarget();
  answer = wireChoiceStrip({ strip: panel, buttons: [{ el: button, value: "yes" }], abandonSource: command });
  command.fire("input");
  assert.equal(await answer, null, "typing means the question is abandoned");
  assert.equal(command.count("input"), 0, "the listener is gone once the question is abandoned");
  assert.equal(panel.removed, 1);

  // Escape is cancel, from the strip itself (where the focus starts) -- and the
  // command-line listener goes with it, not just the input one.
  command = stubEventTarget();
  panel = stubEventTarget();
  button = stubEventTarget();
  answer = wireChoiceStrip({ strip: panel, buttons: [{ el: button, value: "yes" }], abandonSource: command });
  panel.fire("keydown", { key: "Escape", preventDefault() {} });
  assert.equal(await answer, null, "Escape means the question was cancelled");
  assert.equal(command.count("input"), 0, "Escape removes the command-line input listener");
  assert.equal(command.count("keydown"), 0, "and the Escape listener it installed there");

  // A strip that cannot detach must not keep the listener or hang the answer.
  command = stubEventTarget();
  panel = { remove() { throw new Error("already detached"); } };
  button = stubEventTarget();
  answer = wireChoiceStrip({ strip: panel, buttons: [{ el: button, value: "yes" }], abandonSource: command });
  button.fire("click");
  assert.equal(await answer, "yes", "a failing detach still resolves the answer");
  assert.equal(command.count("input"), 0, "the listener is gone even when detaching fails");

  // Several buttons cannot double-settle: the first answer wins and one
  // listener is removed, not two.
  command = stubEventTarget();
  panel = strip();
  const a = stubEventTarget();
  const b = stubEventTarget();
  answer = wireChoiceStrip({
    strip: panel,
    buttons: [{ el: a, value: "first" }, { el: b, value: "second" }],
    abandonSource: command,
  });
  b.fire("click");
  a.fire("click");
  assert.equal(await answer, "second");
  assert.equal(command.count("input"), 0);
  assert.equal(panel.removed, 1);
});

test("main: every save outcome is reported, and a failure never reads as a success", () => {
  const saved = saveOutcomeMessage({ status: "saved", revision: 7 });
  assert.equal(saved.level, "info");
  assert.match(saved.text, /rev 7/);
  // An autosave that worked is the one outcome allowed to stay quiet: a timer
  // is not the user, so a line per tick would be noise.
  assert.equal(saveOutcomeMessage({ status: "saved", revision: 7, auto: true }), null);

  // A write that succeeded without the host reporting a revision is still a
  // success, but the status line has to admit the next save is unguarded.
  const unguarded = saveOutcomeMessage({
    status: "saved",
    revision: null,
    detail: "the host reported no revision, so the next save cannot be guarded against a newer file",
  });
  assert.match(unguarded.text, /rev unknown/);
  assert.match(unguarded.text, /cannot be guarded/);

  // `save` with nothing to write used to say nothing at all, which is
  // indistinguishable from a save that quietly did nothing.
  const unchanged = saveOutcomeMessage({ status: "unchanged" });
  assert.equal(unchanged.level, "info");
  assert.match(unchanged.text, /nothing to write/);

  // A save folded into one already in flight, and a forced one stays forced.
  const deferred = saveOutcomeMessage({ status: "deferred", force: true });
  assert.match(deferred.text, /forced save/);

  // A forced overwrite the host refused -- the case that used to look like a
  // success because `force` was asked for and no error was raised.
  const refused = saveOutcomeMessage({
    status: "refused",
    force: true,
    detail: "the board changed on disk (rev 9)",
  });
  assert.equal(refused.level, "warn");
  assert.match(refused.text, /forced overwrite/);
  assert.match(refused.text, /rev 9/);

  // A save that threw, and a save that could not start.
  const failed = saveOutcomeMessage({ status: "failed", detail: "boom" });
  assert.equal(failed.level, "error");
  assert.match(failed.text, /boom/);
  assert.equal(saveOutcomeMessage({ status: "offline" }).level, "error");

  // An autosave failure is still news: nobody is watching the timer.
  assert.equal(saveOutcomeMessage({ status: "failed", auto: true, detail: "boom" }).level, "error");
  assert.equal(saveOutcomeMessage({ status: "refused", auto: true, detail: "x" }).level, "warn");

  // Nothing below "saved" may be reported as an error-free success, and none of
  // them may claim the board was saved.
  for (const status of ["refused", "failed", "offline"]) {
    const line = saveOutcomeMessage({ status });
    assert.notEqual(line.level, "info", `${status} must not look like a success`);
    assert.doesNotMatch(line.text, /board saved/, `${status} must not claim a save`);
  }
  assert.equal(saveOutcomeMessage({ status: "saved-ish" }), null, "an unknown status claims nothing");
});

/* ------------------------------------------------------------------ */
/* the 幼神 cards' pure helpers                                          */
/* ------------------------------------------------------------------ */

test("mods: severity is counted by kind, and an unknown one counts as info", () => {
  const counts = diagCounts([
    { severity: "error" }, { severity: "error" },
    { severity: "warning" },
    { severity: "info" }, { severity: "info" }, { severity: "info" },
    { severity: "weird" },
    {},
  ]);
  assert.deepEqual(counts, { error: 2, warning: 1, info: 5 });
  assert.deepEqual(diagCounts(null), { error: 0, warning: 0, info: 0 });
  assert.deepEqual(diagCounts([]), { error: 0, warning: 0, info: 0 });
});

test("mods: defines group by type with both levels sorted", () => {
  const grouped = groupDefines([
    { type: "Topic", techName: "B" },
    { type: "Attr", techName: "Z" },
    { type: "Topic", techName: "A" },
    { type: "Topic", techName: "C" },
  ]);
  assert.deepEqual(grouped.map((g) => g.type), ["Attr", "Topic"]);
  assert.deepEqual(grouped[0].items.map((d) => d.techName), ["Z"]);
  assert.deepEqual(grouped[1].items.map((d) => d.techName), ["A", "B", "C"]);
  /* A define with no type must still be shown, not dropped. */
  assert.deepEqual(groupDefines([{ techName: "X" }]).map((g) => g.type), ["(unknown)"]);
  assert.deepEqual(groupDefines(undefined), []);
});

test("mods: the headline names the package and its load order", () => {
  assert.equal(
    modHeadline({ manifest: { name: "MyMod", version: "1.0.0", loadOrder: 0, gameVersion: "1.0" } }),
    "MyMod 1.0.0 — loadOrder 0 · gameVersion 1.0");
  assert.equal(modHeadline(null), "no mod opened");
  assert.equal(modHeadline({}), "(unnamed) ? — loadOrder ? · gameVersion ?");
});

test("mods: mod-relative paths are joined, absolute ones are left alone", () => {
  assert.equal(modPath("Mods/MyMod", "Defines/Attr/A.json"), "Mods/MyMod/Defines/Attr/A.json");
  assert.equal(modPath("Mods/MyMod/", "x.json"), "Mods/MyMod/x.json");
  assert.equal(modPath("Mods\\MyMod", "x.json"), "Mods/MyMod/x.json", "a Windows root still joins with /");
  assert.equal(modPath("Mods/MyMod", "/abs/x.json"), "/abs/x.json");
  assert.equal(modPath("Mods/MyMod", "C:/abs/x.json"), "C:/abs/x.json");
  assert.equal(modPath("", "x.json"), "x.json");
  assert.equal(modPath("Mods/MyMod", ""), "");
});

test("mods: a diagnostic splits into a file and a JSON pointer", () => {
  const diagnostic = { path: "Defines/Goods/Folk.json#/icon", severity: "error" };
  assert.equal(diagFile(diagnostic), "Defines/Goods/Folk.json");
  assert.equal(diagWhere(diagnostic), "/icon");
  /* A package-level diagnostic has no pointer: the whole path is the file. */
  assert.equal(diagFile({ path: "mod.json" }), "mod.json");
  assert.equal(diagWhere({ path: "mod.json" }), "");
  assert.equal(diagFile({}), "");
  assert.equal(diagWhere(null), "");
});

/* ------------------------------------------------------------------ */
/* undo and redo                                                       */
/* ------------------------------------------------------------------ */

/** A board with two cards and one link -- enough for every kind of edit. */
export function historyDoc() {
  return {
    version: 1,
    viewport: { x: 0, y: 0, zoom: 1 },
    cards: [
      { id: "c1", kind: "note", x: 0, y: 0, w: 300, h: 180, z: 1, text: "hello" },
      { id: "c2", kind: "editor", x: 400, y: 0, w: 680, h: 460, z: 2, file: "examples/hello.yarn" },
    ],
    links: [{ id: "l1", from: "c1", to: "c2", label: "notes" }],
  };
}

export function edited(mutate) {
  const document = historyDoc();
  mutate(document);
  return document;
}

test("history: a fresh history has nothing to undo or redo", () => {
  const history = createHistory();
  history.reset(historyDoc());
  assert.equal(history.canUndo(), false);
  assert.equal(history.canRedo(), false);
  assert.equal(history.size(), 1);
  assert.equal(history.position(), 0);
  assert.equal(history.undo(), null, "undo at the start returns nothing");
  assert.equal(history.redo(), null, "redo when there is nothing ahead returns nothing");
  assert.deepEqual(history.current(), historyDoc(), "current() is the state it was reset to");
  assert.equal(history.label(), "the board as loaded");
});

test("history: an edit is one step and undo puts the document back", () => {
  const history = createHistory();
  const before = historyDoc();
  history.reset(before);
  const after = edited((doc) => {
    doc.cards[0].text = "hello there";
  });
  assert.equal(history.record(after), true, "a real edit pushes a step");
  assert.equal(history.canUndo(), true);
  assert.equal(history.label(), "edited the note card c1");
  const step = history.undo();
  assert.deepEqual(step.document, before, "undo restores the document it recorded from");
  assert.equal(step.label, "edited the note card c1");
  assert.equal(history.canUndo(), false);
  assert.equal(history.canRedo(), true);
  assert.deepEqual(history.redo().document, after, "redo walks forward to the same document");
  assert.equal(history.canRedo(), false);
});

test("history: a snapshot is a copy, so editing the board cannot rewrite the past", () => {
  const history = createHistory();
  const before = historyDoc();
  history.reset(before);
  const after = edited((doc) => {
    doc.cards[0].text = "new";
  });
  history.record(after);
  // The caller keeps mutating the very object it handed over: history must not
  // alias it, or every undo would "restore" the newest state.
  after.cards[0].text = "newer still";
  after.cards.push({ id: "c9", kind: "note", x: 0, y: 0, w: 100, h: 100, z: 3, text: "" });
  assert.deepEqual(history.undo().document, before, "the recorded document is untouched");
});

test("history: nothing changed, and a viewport-only move, are not steps", () => {
  const history = createHistory();
  history.reset(historyDoc());
  assert.equal(history.record(historyDoc()), false, "an identical document is not an edit");
  const panned = edited((doc) => {
    doc.viewport = { x: -120, y: 40, zoom: 1.5 };
  });
  assert.equal(history.record(panned), false, "panning and zooming are navigation, not edits");
  assert.equal(describeChange(historyDoc(), panned), null);
  assert.equal(history.size(), 1);
  const raised = edited((doc) => {
    doc.cards[0].z = 7;
  });
  assert.equal(history.record(raised), false, "raising a card is not an undo step");
});

test("history: a typing burst is one step, and a pause starts the next", () => {
  let clock = 1000;
  const history = createHistory({ now: () => clock });
  history.reset(historyDoc());
  const first = edited((doc) => {
    doc.cards[0].text = "h";
  });
  assert.equal(history.record(first), true, "the first keystroke opens a step");
  clock += 120;
  const second = edited((doc) => {
    doc.cards[0].text = "he";
  });
  assert.equal(history.record(second), false, "the next keystroke folds into it");
  clock += 120;
  const third = edited((doc) => {
    doc.cards[0].text = "hel";
  });
  history.record(third);
  assert.equal(history.size(), 2, "one step so far: the loaded board, then the sentence");
  assert.deepEqual(history.undo().document, historyDoc(), "undo takes back the whole burst");
  clock += 5000;
  history.redo();
  const later = edited((doc) => {
    doc.cards[0].text = "hello again";
  });
  assert.equal(history.record(later), true, "a pause ends the burst: this is a new step");
  assert.equal(history.size(), 3);
});

test("history: a new edit after an undo throws the redo branch away", () => {
  const history = createHistory();
  history.reset(historyDoc());
  const one = edited((doc) => {
    doc.cards[0].text = "one";
  });
  const two = edited((doc) => {
    doc.cards[0].text = "two";
  });
  history.record(one);
  history.record(two);
  assert.equal(history.undo().label, "edited the note card c1");
  assert.equal(history.canRedo(), true);
  const branch = edited((doc) => {
    doc.cards[0].text = "another branch";
  });
  history.record(branch);
  assert.equal(history.canRedo(), false, "the abandoned future is gone");
  assert.equal(history.size(), 2);
  assert.deepEqual(history.current(), branch);
});

test("history: the ring forgets the oldest steps past its limit", () => {
  const history = createHistory({ limit: 3 });
  history.reset(historyDoc());
  for (let n = 1; n <= 5; n += 1) {
    const document = edited((doc) => {
      doc.cards[0].text = `step ${n}`;
    });
    history.record(document, { label: `edit ${n}` });
  }
  assert.equal(history.size(), 3, "the limit is a ceiling, not a suggestion");
  assert.equal(history.position(), 2);
  assert.equal(history.canUndo(), true);
  assert.equal(history.undo().label, "edit 5");
  assert.equal(history.undo().label, "edit 4");
  assert.equal(history.canUndo(), false, "the steps past the limit are gone, not hidden");
  assert.equal(history.size(), 3);
});

test("history: describeChange names the edit a person just made", () => {
  const base = historyDoc();
  const adding = edited((doc) => {
    doc.cards.push({ id: "c3", kind: "note", x: 900, y: 0, w: 200, h: 120, z: 3, text: "" });
  });
  assert.equal(describeChange(base, adding), "added a card c3");
  const removing = edited((doc) => {
    doc.cards = doc.cards.filter((card) => card.id !== "c2");
    doc.links = [];
  });
  assert.equal(describeChange(base, removing), "removed a card c2 and unlinked l1");
  const moving = edited((doc) => {
    doc.cards[0].x += 40;
    doc.cards[0].y += 40;
  });
  assert.equal(describeChange(base, moving), "moved a card c1");
  const resizing = edited((doc) => {
    doc.cards[0].w = 420;
  });
  assert.equal(describeChange(base, resizing), "resized a card c1");
  const editing = edited((doc) => {
    doc.cards[1].file = "examples/sample.json";
  });
  assert.equal(describeChange(base, editing), "edited the editor card c2");
  const linking = edited((doc) => {
    doc.links.push({ id: "l2", from: "c2", to: "c1", label: "back" });
  });
  assert.equal(describeChange(base, linking), "linked c2 to c1");
  const twoThings = edited((doc) => {
    doc.cards[0].x += 10;
    doc.cards[1].text = "something";
  });
  assert.equal(describeChange(base, twoThings), "edited the editor card c2 and moved a card c1");
  assert.equal(describeChange(base, base), null, "no change, no phrase");
});

test("history: clear() empties it and a record after that starts over", () => {
  const history = createHistory();
  history.reset(historyDoc());
  history.record(
    edited((doc) => {
      doc.cards[0].text = "x";
    }),
  );
  history.clear();
  assert.equal(history.size(), 0);
  assert.equal(history.position(), -1);
  assert.equal(history.canUndo(), false);
  assert.equal(history.current(), null);
  const document = edited((doc) => {
    doc.cards[0].text = "after the clear";
  });
  assert.equal(history.record(document), true, "the first record after a clear seeds the ring");
  assert.equal(history.size(), 1);
  assert.deepEqual(history.current(), document);
});

/*
 * There is no wheel rule left to pin here: the canvas that panned is gone, and
 * in a tiled view a wheel over a card belongs to the card.  Whether an ancestor
 * is a scroll container needs a browser either way.
 */

/*
 * What to do when a file moves under a card. `main.mjs` asks the kernel and
 * `cards.mjs` obeys; the decision -- reload, warn, or say nothing -- is pure, so
 * it is pinned here without a browser, a kernel or a clock. The rule that
 * matters most is the one a naive watcher gets wrong: an unknown revision is
 * never a licence to reload over someone's typing.
 */

/** A `file.stat` answer: a file that is on disk, holding `revision`. */
export function stat(revision) {
  return { exists: true, dir: false, size: 12, mtime: 1, revision };
}

test("watch: a card that has not read the file yet has nothing to compare", () => {
  assert.equal(watchDecision({ revision: null, dirty: false }, stat(7)), WATCH_UNKNOWN);
  assert.equal(watchDecision({ revision: Number.NaN, dirty: false }, stat(7)), WATCH_UNKNOWN);
  assert.equal(watchDecision({}, stat(7)), WATCH_UNKNOWN, "a missing revision is not revision 0");
});

test("watch: a transport failure is not a change", () => {
  assert.equal(watchDecision({ revision: 7 }, null), WATCH_UNKNOWN);
  assert.equal(watchDecision({ revision: 7 }, undefined), WATCH_UNKNOWN);
  assert.equal(watchDecision({ revision: 7 }, { error: new Error("blinked") }), WATCH_UNKNOWN);
});

test("watch: a file that is gone says so, and a directory is gone too", () => {
  assert.equal(watchDecision({ revision: 7 }, { exists: false, dir: false, revision: 0 }), WATCH_GONE);
  assert.equal(watchDecision({ revision: 7 }, { exists: true, dir: true, revision: 0 }), WATCH_GONE);
});

test("watch: cannot-compare warns and never reloads", () => {
  assert.equal(watchDecision({ revision: 7 }, stat(0)), WATCH_WARN, "revision 0 is `cannot say`");
  assert.equal(watchDecision({ revision: 0 }, stat(7)), WATCH_WARN, "a card holding 0 cannot compare either");
  assert.equal(watchDecision({ revision: 0, dirty: false }, stat(9)), WATCH_WARN);
});

test("watch: an empty file has a real revision, not `cannot compare`", () => {
  // 2166136261 is what the kernel's FNV-1a hands an empty buffer. Reading it as
  // 0 would warn about a file that is merely empty, on every poll, forever.
  assert.equal(watchDecision({ revision: 2166136261 }, stat(2166136261)), WATCH_OK);
});

test("watch: the same revision is quiet, a new one reloads a clean card", () => {
  assert.equal(watchDecision({ revision: 7, dirty: false }, stat(7)), WATCH_OK);
  assert.equal(watchDecision({ revision: 7, dirty: false }, stat(8)), WATCH_RELOAD);
});

test("watch: unsaved edits are never overwritten by a reload", () => {
  assert.equal(watchDecision({ revision: 7, dirty: true }, stat(8)), WATCH_WARN);
});

test("watch: a trimmed kernel is smaller, not broken", () => {
  assert.equal(watchTrimmed([{ error: { code: -32601 } }]), true);
  assert.equal(watchTrimmed([{ error: { code: -32601 } }, stat(7)]), true);
  assert.equal(watchTrimmed([stat(7)]), false, "an answer is not a refusal");
  assert.equal(watchTrimmed([{ error: { code: -32602 } }]), false, "another code is not METHOD_NOT_FOUND");
  assert.equal(watchTrimmed([{ error: new Error("offline") }]), false, "a transport error carries no code");
  assert.equal(watchTrimmed([]), false);
});

test("watch: one decision per path per revision is news exactly once", () => {
  const pairs = [{ path: "a.yarn", known: { revision: 7, dirty: false }, stat: stat(8) }];
  const first = watchReport(pairs, new Map());
  assert.equal(first.actions.length, 1);
  assert.equal(first.actions[0].decision, WATCH_RELOAD);
  const again = watchReport(pairs, first.next);
  assert.equal(again.actions.length, 0, "the same answer a poll later is not news");
  const moved = watchReport([{ path: "a.yarn", known: { revision: 7 }, stat: stat(9) }], again.next);
  assert.equal(moved.actions.length, 1, "a new revision is news again");
});

test("watch: quiet and unanswerable decisions are not actions", () => {
  const report = watchReport(
    [
      { path: "same.yarn", known: { revision: 7 }, stat: stat(7) },
      { path: "loading.yarn", known: { revision: null }, stat: stat(9) },
    ],
    new Map(),
  );
  assert.deepEqual(report.actions, [], "ok and unknown report nothing");
  assert.equal(report.next.get("same.yarn"), "ok:7");
  assert.equal(report.next.get("loading.yarn"), "unknown:9");
});

test("watch: a path that is no longer open is forgotten", () => {
  const before = new Map([["gone.yarn", "ok:7"]]);
  const report = watchReport([], before);
  assert.equal(report.next.size, 0, "a long session does not grow the map forever");
});

test("watch: any card with a file and a reload joins, whatever its kind", () => {
  // The editor's revision and dirty are getters; the rig's are methods. The poll
  // asks both, so the difference is read once here instead of at every call site.
  const editor = {
    kind: "editor",
    path: "Spine\\Hero.skel.bytes",
    hasPath: () => true,
    reload() {},
    get revision() {
      return 9;
    },
    get dirty() {
      return true;
    },
  };
  assert.equal(watchTarget(editor), "Spine/Hero.skel.bytes");
  assert.deepEqual(watchStateOf(editor), { revision: 9, dirty: true });

  const rig = {
    kind: "rig",
    get path() {
      return "Spine/Hero.skel.bytes";
    },
    hasPath: () => true,
    reload() {},
    revision() {
      return 12;
    },
    dirty() {
      return false;
    },
  };
  assert.equal(watchTarget(rig), "Spine/Hero.skel.bytes");
  assert.deepEqual(watchStateOf(rig), { revision: 12, dirty: false });

  // A mod card holds a folder and a docs card a query: neither is a file, and a
  // card without `reload` cannot take a change, so none of them keeps the poll
  // asking about a path that is not a file.
  assert.equal(watchTarget({ kind: "mod", path: "MyMod" }), null);
  assert.equal(watchTarget({ kind: "docs", hasPath: () => true }), null);
  assert.equal(watchTarget({ kind: "editor", path: "", hasPath: () => true, reload() {} }), null);
  assert.equal(watchTarget(null), null);
  assert.equal(watchTarget({}), null);

  // "Cannot compare" is not revision 0: a card that has not read the file yet
  // keeps the group unknown so the next poll asks again.
  assert.deepEqual(watchStateOf({ revision: Number.NaN, dirty: "yes" }), { revision: null, dirty: false });
  assert.equal(watchTarget({ path: "yarn/a.yarn", hasPath: () => true, get reload() { return "not a hook"; } }), null);
});

test("openpath: a relative open is inside, an absolute one only under the root", () => {
  const root = "C:\\work\\Mods\\MyMod";

  // The bug this pins: a relative name is resolved by the kernel against its
  // own workspace, so `open README.md` is inside by construction.  It used to
  // be compared against the absolute root as a string and refused, which closed
  // every relative open in the window while the pure suites stayed green.
  assert.equal(isAbsolutePath("README.md"), false);
  assert.equal(isAbsolutePath("./README.md"), false);
  assert.equal(isAbsolutePath("Yarn/Mod.yarn"), false);
  assert.equal(isInsideWorkspace("README.md", root), true);
  assert.equal(isInsideWorkspace("./sprites/a.png", root), true);

  // An absolute path has to land under the root, in either separator spelling
  // and in either case (the kernel folds case on Windows).
  assert.equal(isAbsolutePath("C:\\work\\Mods\\MyMod\\mod.json"), true);
  assert.equal(isAbsolutePath("C:/work/Mods/MyMod/mod.json"), true);
  assert.equal(isInsideWorkspace("C:\\work\\Mods\\MyMod\\mod.json", root), true);
  assert.equal(isInsideWorkspace("c:/work/mods/mymod/Yarn/a.yarn", root), true);
  assert.equal(isInsideWorkspace(root + "\\", root), true);

  // Outside is outside: a sibling with the root as a prefix, another drive and
  // a UNC share all read as someone else's file.
  assert.equal(isInsideWorkspace("C:\\work\\Mods\\MyMod2\\mod.json", root), false);
  assert.equal(isInsideWorkspace("D:\\Mods\\MyMod\\mod.json", root), false);
  assert.equal(isInsideWorkspace("\\\\fileserver\\share\\Mods\\a.yarn", root), false);

  // Before the workspace reply arrives there is no root to compare an absolute
  // path against; a relative name is still left to the kernel.
  assert.equal(isInsideWorkspace("README.md", null), true);
  assert.equal(isInsideWorkspace("C:\\Mods\\MyMod\\mod.json", null), false);
  assert.equal(isInsideWorkspace("", root), true);
});
