"""input_smoke.py -- drive the real window: the undo keys, the editor keys, who
owns a wheel, a file that changes while nobody is looking, and the classic view
that tiles the same board into a sidebar, a tab strip and a code area.

The board's *input paths* were the one part of the app that no shipped suite
could reach: ``selftest.mjs`` proves the undo ring (documents, coalescing, the
redo branch), the editor's text operations and ``classic.mjs``'s tile with no DOM
at all, and this proves the wiring on top of them.  ``--dump-dom`` drives no
pointer, no keyboard and no wheel, so those events are dispatched from a page
this test owns.

How, without a web driver or CDP: the shell serves every file under
``shell/web/``, so this test writes one small wrapper page there for the length
of the run, deletes it in a ``finally``, and refuses to start if the name is
already taken.  The wrapper is same-origin with the app it frames, so it can
reach into the iframe and do what a person does:

1. wait for the app to reach "kernel ready", and read which view the window
   opened on: every step below is the board's -- the empty-space double-click,
   the pan, the zoom, the wheel over bare board -- so the wrapper says `mode
   board` and reports both, rather than inheriting whatever the product happens
   to open on;
2. double-click empty space -- a real board change through the real gesture;
3. dispatch ``keydown`` with ``ctrlKey`` for ``z``, then for ``shift+z``;
4. count the card elements in the iframe's DOM after each step;
5. press Ctrl+Z while a text field has the keystroke, and check that the board
   did not move: text undo belongs to the textarea;
6. open a file so that one card has content taller than its own box, then
   dispatch ``wheel`` over that card's scroll region and over bare board, and
   ask which of them acted: the card's wheel must scroll the card and leave the
   viewport where it was, the board's wheel must pan it, and ctrl+wheel over the
   card must still zoom.  Nothing forces the issue by looking for a scrollable
   card and giving up: the run *makes* one, through the same ``open`` command a
   person would type, so the check either proves the behaviour or fails;
7. rewrite a file **with a real child process** (``cmd /c echo``) while an editor
   card holds it, and read the card's status back through ``file.read``: a clean
   card reloads, a card with unsaved edits keeps its text and says the file
   changed, a deleted file is reported instead of written back, and a card never
   claims a revision it did not read.  This is the one case ``file.changed``
   cannot cover, because the kernel announces its own writes and nothing else;
8. drive that editor card's own keys -- ``Tab`` and ``shift+Tab`` over the file,
   ``Enter`` after an opener, ``Ctrl+F`` and the find bar, replace-all and
   ``Escape`` -- and read the buffer and the painted hits back out of the DOM.
   The last check is the one only a real browser can make: the card's own edits
   go in through ``document.execCommand("insertText")``, so ``Ctrl+Z`` still has
   them, and a card that assigned to ``value`` would fail it, and read the
   line-number gutter: one number per line, on by default, hidden by a click on
   it and back by a second one;
9. type ``mode classic`` and measure the tile in the board's own pixels: the tab
   strip under the HUD, the code area filling the right column down to the bottom
   edge, the sidebar on the left, every other card hidden; click a tab and check
   the code area moved to that file; wheel the code area and the strip and check
   the viewport did not move; then ``mode board`` and check every card, every
   size and the pan and zoom came back exactly.

The board is backed up and restored byte-for-byte, and the host is killed by pid.
The file step 7 rewrites lives at ``build/__watch_smoke.txt`` and is removed in
the same ``finally`` as the wrapper page.

    python tools/input_smoke.py [--edge PATH] [--port N] [--timeout S] [--keep]

Exit codes: 0 pass or skipped, 1 a check failed, 2 could not run, 3 usage.

The host, the browser lookup and the board backup come from
``tools/browser_smoke.py`` rather than being copied: both tests drive the same
window and the same ``serve`` child, and a second copy of that plumbing is a
second thing to keep fixed.  What this test does *not* take from there is
``install_if_absent`` -- the starter board would paint five cards, and this test
counts card *deltas* from whatever the workspace already holds.
"""

import argparse
import re
import shutil
import subprocess
import sys
import tempfile
import zlib
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))

from browser_smoke import (  # noqa: E402  (the import needs the path above)
    BOARD_PATH,
    EDGE_FLAGS,
    REPO_ROOT,
    SHELL_MAIN,
    BoardBackup,
    DriverError,
    Host,
    find_edge,
    free_port,
    terminate,
)

WRAPPER_NAME = "__input_smoke.html"
WRAPPER = REPO_ROOT / "shell" / "web" / WRAPPER_NAME
RESULT_RE = re.compile(r'<pre id="result">(.*?)</pre>', re.S)

#: The file the watch half rewrites from a second process.  It lives under
#: ``build/`` (gitignored, next to the kernel the run already built) and the run
#: deletes it whether or not the checks got as far as writing it.
SCRATCH_REL = "build/__watch_smoke.txt"
SCRATCH = REPO_ROOT / "build" / "__watch_smoke.txt"

#: The file the wheel half opens.  Any file taller than a card's own box would
#: do; this one is in the repository, so the run cannot depend on the workspace.
SCROLL_FILE = "core/src/main.c"

#: The pixel half opens one card per stroke, on paths that do not exist yet and
#: live under ``build/``: the first save creates the file, so the repository's own
#: art is never written to.  The .png each save leaves behind is what the checks
#: decode, and all of them are removed in the same ``finally`` as the wrapper.
PIXEL_STROKES = (
    ("pencil", "build/__input_smoke_pixel.png"),
    ("eraser", "build/__input_smoke_eraser.png"),
    ("fill", "build/__input_smoke_fill.png"),
)
PIXEL_PNGS = tuple(REPO_ROOT / relative for _, relative in PIXEL_STROKES)

#: The mod beside the repository whose PROBLEMS card carries the D006 rows
#: ("Sprite file not found") the pixel card's click-through is for.  ``serve``
#: resolves every ``mod.*`` root under ``--mods-root`` (default: the workspace),
#: so this directory goes on the host's command line.
MODS_ROOT = REPO_ROOT.parent / "Mods"
MOD_NAME = "SODefines"

#: Gives the page as much virtual time as it needs for five settled steps plus
#: the wheel half; the real limit is ``--timeout`` on the browser process.
BUDGET_MS = 45000


PAGE = """<!doctype html>
<html lang="en"><head><meta charset="utf-8"><title>input smoke</title>
<style>body{margin:0;font:12px monospace}iframe{width:900px;height:600px;border:0}
pre{white-space:pre-wrap}</style></head>
<body>
<iframe id="app" src="/"></iframe>
<pre id="result">pending</pre>
<script>
const frame = document.getElementById("app");
const out = [];
const say = (line) => { out.push(line); document.getElementById("result").textContent = out.join("\\n"); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
/* Wait for something the app does in its own time -- a workspace read is as slow
   as the workspace is big, and a fixed sleep would be a race with the disk. */
async function waitUntil(predicate, tries = 150, step = 200) {
  for (let i = 0; i < tries; i++) {
    if (predicate()) return true;
    await sleep(step);
  }
  return predicate();
}
const cardCount = () => frame.contentDocument.querySelectorAll("#cards [data-card-id]").length;
const logTail = () => {
  const el = frame.contentDocument.getElementById("log");
  return (el ? el.textContent : "").replace(/\\s+/g, " ").trim().slice(-140);
};
const key = (win, doc, init) => doc.dispatchEvent(new win.KeyboardEvent("keydown", Object.assign({ bubbles: true, cancelable: true }, init)));
const stageTransform = () => {
  const el = frame.contentDocument.getElementById("stage");
  return el ? el.style.transform : "";
};
const hudZoom = () => {
  const el = frame.contentDocument.getElementById("hud-zoom");
  return el ? (el.textContent || "").trim() : "";
};
/* What the pointer actually lands on, and the nearest box below it that can
   scroll the way this wheel asks: a textarea scrolls by UA style, an editor's
   overflow:hidden shim does not, and an overflow:auto/scroll box only counts
   while it has room left in that direction. */
const scrollRegionAt = (doc, x, y, deltaY) => {
  const view = doc.defaultView;
  let node = doc.elementFromPoint(x, y);
  const card = node && node.closest ? node.closest("[data-card-id]") : null;
  for (; node; node = node.parentElement) {
    const style = view.getComputedStyle(node);
    const scrolls = style.overflowY === "auto" || style.overflowY === "scroll"
      || node.tagName === "TEXTAREA";
    const room = deltaY >= 0
      ? node.scrollHeight - node.clientHeight - node.scrollTop
      : node.scrollTop;
    if (scrolls && room > 0) return { el: node, card };
  }
  return { el: null, card };
};
const describe = (el) => (el.tagName.toLowerCase()
  + (el.className ? "." + String(el.className).trim().replace(/\\s+/g, ".") : ""))
  + ", " + el.clientHeight + "px of " + el.scrollHeight + "px, scrollTop " + el.scrollTop;
/* A card whose own scroll region sits under the pointer.  Three points per card,
   because cards overlap and a centre can land on the card above. */
const regionInSomeCard = (doc, deltaY) => {
  const notes = [];
  const view = doc.defaultView;
  for (const card of doc.querySelectorAll("#cards [data-card-id]")) {
    const rect = card.getBoundingClientRect();
    if (rect.width < 60 || rect.height < 60) continue;
    for (const [fx, fy] of [[0.5, 0.5], [0.3, 0.4], [0.7, 0.6]]) {
      const x = Math.round(rect.left + rect.width * fx);
      const y = Math.round(rect.top + rect.height * fy);
      if (x < 2 || y < 2 || x > view.innerWidth - 2 || y > view.innerHeight - 2) {
        if (notes.length < 4) notes.push("card " + card.dataset.cardId + " point off screen");
        continue;
      }
      const under = doc.elementFromPoint(x, y);
      const region = scrollRegionAt(doc, x, y, deltaY);
      if (region.el && region.card === card) return { x, y, el: region.el, notes };
      if (notes.length < 4) {
        notes.push("card " + card.dataset.cardId + " @ " + x + "," + y + " -> "
          + (under ? describe(under) : "nothing")
          + (region.card === card ? " (the card's)" : " (another card's)"));
      }
    }
  }
  return { x: 0, y: 0, el: null, notes };
};
const wheel = (win, target, init) => {
  const event = new win.WheelEvent("wheel", Object.assign({ bubbles: true, cancelable: true }, init));
  target.dispatchEvent(event);
  return event;
};

async function ready() {
  for (let i = 0; i < 300; i++) {
    const doc = frame.contentDocument;
    const status = doc && doc.getElementById("kernel-status");
    if (status && /ready/.test(status.textContent || "")) return true;
    await sleep(100);
  }
  return false;
}

async function main() {
  await new Promise((resolve) => {
    if (frame.contentDocument && frame.contentDocument.readyState === "complete") resolve();
    else frame.addEventListener("load", resolve, { once: true });
  });
  if (!(await ready())) { say("RESULT: FAILED -- the app never reached kernel ready"); return; }
  say("kernel ready: true");
  const doc = frame.contentDocument, win = frame.contentWindow;
  await sleep(400);

  /* This window opens on the classic tile.  The steps below are about the board
     -- the double-click that drops a note, the pan, the zoom, the wheel over
     bare board -- so this says which one is being measured rather than inheriting
     whatever the product opens on.  The default is reported first: it is a claim
     the product makes (views.mjs's DEFAULT_VIEW), and this is the only suite that
     can see a running window make it. */
  say("view-default: classic=" + doc.body.classList.contains("is-classic"));

  /* The message strip is the app's only voice and it starts folded: a window
     that opened with it open is the regression this measures.  The two clicks
     are the same `#log-toggle` a reader would use, so the button is measured as
     the way in rather than as an element that merely exists. */
  const logEl = doc.getElementById("log"), logToggleEl = doc.getElementById("log-toggle");
  const logAtBoot = logEl.hidden === true && logEl.getBoundingClientRect().height === 0;
  logToggleEl.click();
  await sleep(400);
  const logWhenOpened = logEl.hidden === false && logEl.getBoundingClientRect().height > 0;
  logToggleEl.click();
  await sleep(400);
  const logWhenShut = logEl.hidden === true;
  say("log-boot: hidden=" + logAtBoot + " open=" + logWhenOpened + " shut=" + logWhenShut
    + ' button="' + (logToggleEl.textContent || "").trim() + '"');

  const commandEl = doc.getElementById("command");
  commandEl.value = "mode board";
  commandEl.dispatchEvent(new win.KeyboardEvent("keydown", { bubbles: true, cancelable: true, key: "Enter" }));
  await sleep(500);
  say("view-board: classic=" + doc.body.classList.contains("is-classic")
    + " mod=" + doc.body.classList.contains("is-mod"));

  const before = cardCount();
  say("cards at boot: " + before);

  const board = doc.getElementById("board");
  board.dispatchEvent(new win.MouseEvent("dblclick", { bubbles: true, cancelable: true, clientX: 600, clientY: 500 }));
  await sleep(600);
  const added = cardCount();
  say("cards after a double-click on empty space: " + added + "  | log: " + logTail());

  key(win, doc, { key: "z", ctrlKey: true });
  await sleep(600);
  const undone = cardCount();
  say("cards after Ctrl+Z: " + undone + "  | log: " + logTail());

  key(win, doc, { key: "Z", ctrlKey: true, shiftKey: true });
  await sleep(600);
  const redone = cardCount();
  say("cards after Ctrl+Shift+Z: " + redone + "  | log: " + logTail());

  const input = doc.getElementById("command");
  input.value = "this text is never submitted";
  input.dispatchEvent(new win.KeyboardEvent("keydown", { bubbles: true, cancelable: true, key: "z", ctrlKey: true }));
  await sleep(400);
  const inField = cardCount();
  say("cards after Ctrl+Z while a text field has the keystroke: " + inField + "  (the board must not move)");

  const ok = added === before + 1 && undone === before && redone === added && inField === redone;
  say("counts: boot=" + before + " added=" + added + " undone=" + undone
    + " redone=" + redone + " in-field=" + inField);

  /* --- who owns a wheel event --- */
  const cmd = doc.getElementById("command");
  cmd.focus();
  cmd.value = "open @@FILE@@";
  cmd.dispatchEvent(new win.KeyboardEvent("keydown", { bubbles: true, cancelable: true, key: "Enter" }));
  let region = regionInSomeCard(doc, 120);
  for (let attempt = 0; attempt < 25 && region.el === null; attempt++) {
    await sleep(200);
    region = regionInSomeCard(doc, 120);
  }
  say("wheel-setup: opened @@FILE@@ -> cards now: " + cardCount());

  let wheelOk = true;
  try {
    if (region.el === null) {
      say("wheel-card: none -- no card's own scroll region is under the pointer  ["
        + region.notes.join(" | ") + "]");
    } else {
      const at = { clientX: region.x, clientY: region.y };
      const view = stageTransform();
      const overCard = wheel(win, region.el, Object.assign({ deltaY: 120 }, at));
      const moved = stageTransform() !== view;
      wheelOk = wheelOk && !overCard.defaultPrevented && !moved;
      say("wheel-card: defaultPrevented=" + overCard.defaultPrevented
        + " viewport-moved=" + moved
        + "  (" + describe(region.el) + ")");
    }

    const view2 = stageTransform();
    const overBoard = wheel(win, doc.getElementById("board"), { deltaY: 120, clientX: 30, clientY: 240 });
    say("wheel-board: defaultPrevented=" + overBoard.defaultPrevented
      + " viewport-moved=" + (stageTransform() !== view2));

    const zoomBefore = hudZoom();
    const zoomAt = region.el === null ? { clientX: 600, clientY: 400 } : { clientX: region.x, clientY: region.y };
    const zoomOn = doc.elementFromPoint(zoomAt.clientX, zoomAt.clientY) || doc.getElementById("board");
    wheel(win, zoomOn, Object.assign({ deltaY: -240, ctrlKey: true }, zoomAt));
    say("wheel-ctrl: " + zoomBefore + " -> " + hudZoom());
  } catch (error) {
    wheelOk = false;
    say("wheel-error: " + (error && error.message ? error.message : String(error)));
  }

  /* --- watch: a change made on disk that nobody announced ---
     The kernel announces its own writes; a file rewritten by another program is
     the case no announcement covers.  So this rewrites one with a real child
     process -- `cmd /c echo` -- and reads back what the card holding it says. */
  let watchOk = true;
  try {
    if (doc.activeElement && doc.activeElement.blur) doc.activeElement.blur();
    const scratch = "@@SCRATCH@@";
    // cmd.exe wants backslashes; make one without typing one.
    const nativePath = scratch.split("/").join(String.fromCharCode(92));
    let nextId = 0;
    const rpc = async (method, params) => {
      const answer = await fetch("/rpc", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ jsonrpc: "2.0", id: ++nextId, method, params }),
      });
      const body = await answer.json();
      if (body.error) throw new Error(method + ": " + body.error.message);
      return body.result;
    };
    const outside = (text) => rpc("exec.start", {
      cmd: 'cmd /c echo ' + text + '> "' + nativePath + '"',
      card_id: "",
    });
    /* Waiting for that child is a *real* wait: every probe is a round trip to
       the host, and virtual time stands still while a request is in flight. */
    const readBack = async (want) => {
      let last = "";
      for (let i = 0; i < 60; i++) {
        try {
          const result = await rpc("file.read", { path: scratch });
          if (typeof result.text === "string" && result.text.indexOf(want) !== -1) return result;
        } catch (error) {
          last = error.message;
        }
        await sleep(250);
      }
      say("watch-note: never read " + JSON.stringify(want) + " back: " + last);
      return null;
    };
    const vanished = async () => {
      for (let i = 0; i < 60; i++) {
        try {
          const answer = await rpc("file.stat", { path: scratch });
          if (answer.exists !== true) return answer;
        } catch (error) {
          return null;
        }
        await sleep(250);
      }
      return null;
    };
    const editorHolding = () => {
      for (const node of doc.querySelectorAll("#cards [data-card-id]")) {
        const area = node.querySelector("textarea.ed-input");
        const label = node.querySelector(".card-label");
        if (area !== null && label !== null && label.textContent.indexOf("__watch_smoke") !== -1) {
          return { node, area };
        }
      }
      return null;
    };
    const statusOf = (held) => {
      const node = held === null ? null : held.node.querySelector('[data-role="card-status"]');
      return node === null ? "" : (node.textContent || "").trim();
    };
    const runLine = (text) => {
      const box = doc.getElementById("command");
      box.value = text;
      box.dispatchEvent(new win.KeyboardEvent("keydown", { bubbles: true, cancelable: true, key: "Enter" }));
    };

    /* The file first exists before any card holds it -- nothing to tell. */
    await outside("one");
    const first = await readBack("one");
    runLine("open " + scratch);
    await waitUntil(() => editorHolding() !== null, 60, 250);
    const held = editorHolding();
    /* Wait for the read to answer: a card that has been made but has not read
       the file yet holds no revision, which is the one thing this section is
       about. */
    if (held !== null) await waitUntil(() => held.area.value.indexOf("one") === 0, 60, 250);
    say("watch-open: open=" + (held !== null)
      + " text=" + JSON.stringify(held === null ? "" : held.area.value)
      + " status=" + JSON.stringify(statusOf(held)));

    /* A second writer rewrites it.  A clean card takes the bytes. */
    await outside("two");
    await readBack("two");
    const reloaded = await waitUntil(() => statusOf(held).indexOf("reloaded from disk") !== -1, 60, 250);
    say("watch-reload: reloaded=" + reloaded
      + " text=" + JSON.stringify(held === null ? "" : held.area.value)
      + " status=" + JSON.stringify(statusOf(held)));

    /* The same write, but this card has unsaved edits: it is told, and the text
       stays.  An editor that silently overwrites typing is worse than one that
       never reloads at all. */
    const kept = "mine, unsaved\\n";
    if (held !== null) {
      held.area.focus();
      held.area.value = kept;
      held.area.dispatchEvent(new win.Event("input", { bubbles: true }));
    }
    await sleep(80);
    await outside("three");
    await readBack("three");
    const warned = await waitUntil(() => statusOf(held).indexOf("changed on disk") !== -1, 60, 250);
    say("watch-warn: warned=" + warned
      + " kept=" + (held !== null && held.area.value === kept)
      + " status=" + JSON.stringify(statusOf(held)));

    /* The file disappears under the card.  Said, not silently written back. */
    await rpc("exec.start", { cmd: 'cmd /c del "' + nativePath + '"', card_id: "" });
    const gone = await vanished();
    const reported = gone !== null
      && await waitUntil(() => statusOf(held).indexOf("gone from disk") !== -1, 60, 250);
    say("watch-gone: gone=" + reported
      + " kept=" + (held !== null && held.area.value === kept)
      + " status=" + JSON.stringify(statusOf(held)));

    watchOk = first !== null && held !== null && reloaded && warned && reported
      && held.area.value === kept;
  } catch (error) {
    watchOk = false;
    say("watch-error: " + (error && error.message ? error.message : String(error)));
  }

  /* --- the editor's own keys: indent, auto-indent, find and replace ---
     Step 6 opened a file through the real command line, so there is a real
     editor card holding real text; these press the keys a person presses in it.
     Nothing here reaches into the card's own state: the buffer and the painted
     hits are read back out of the DOM. */
  let editorOk = true;
  try {
    const cardNode = (() => {
      for (const node of doc.querySelectorAll("#cards [data-card-id]")) {
        if (node.querySelector("textarea.ed-input") !== null) return node;
      }
      return null;
    })();
    const area = cardNode === null ? null : cardNode.querySelector("textarea.ed-input");
    const press = (key, extra) => area.dispatchEvent(new win.KeyboardEvent("keydown", Object.assign(
      { bubbles: true, cancelable: true, key }, extra || {})));
    if (area === null) {
      editorOk = false;
      say("editor: none -- no editor card is on the board");
    } else {
      const original = area.value;
      area.focus();
      area.setSelectionRange(0, 0);
      press("Tab");
      const tab = area.value.slice(0, 4);
      const caret = area.selectionStart;
      press("Tab", { shiftKey: true });
      const restores = area.value === original;
      editorOk = editorOk && tab === "    " && caret === 4 && restores;
      say("editor-indent: tab=" + JSON.stringify(tab) + " caret=" + caret
        + " shift-tab-restores=" + restores);

      /* Auto-indent: a line opening a block gets one more step for the next. */
      area.value = "foo {\\nbar";
      area.dispatchEvent(new win.Event("input", { bubbles: true }));
      area.setSelectionRange(5, 5);
      press("Enter");
      const auto = area.value === "foo {\\n    \\nbar" && area.selectionStart === 10;
      editorOk = editorOk && auto;
      say("editor-enter: " + JSON.stringify(area.value) + " caret=" + area.selectionStart);

      /* Find: the bar opens on Ctrl+F and every hit is painted below. */
      press("f", { ctrlKey: true });
      const bar = cardNode.querySelector('[data-role="find-bar"]');
      const query = cardNode.querySelector('[data-role="find-query"]');
      const count = cardNode.querySelector('[data-role="find-count"]');
      const open = bar !== null && bar.hidden === false;
      query.value = "o";
      query.dispatchEvent(new win.Event("input", { bubbles: true }));
      const marks = cardNode.querySelectorAll('mark[data-role="find-hit"]');
      const counted = count ? (count.textContent || "").trim() : "";
      const firstOk = open && marks.length === 2 && counted === "1/2";
      editorOk = editorOk && firstOk;
      say("editor-find: open=" + open + " hits=" + marks.length + " count=" + JSON.stringify(counted));

      /* Next steps to the second hit, and only that one is current. */
      const next = cardNode.querySelector('[data-role="find-next"]');
      if (next) next.click();
      const second = count ? (count.textContent || "").trim() : "";
      const current = cardNode.querySelectorAll("mark.is-current").length;
      editorOk = editorOk && second === "2/2" && current === 1;
      say("editor-find-next: count=" + JSON.stringify(second) + " current=" + current);

      /* Replace all, and Escape closes the bar. */
      const replacement = cardNode.querySelector('[data-role="replace-text"]');
      const replaceAll = cardNode.querySelector('[data-role="replace-all"]');
      replacement.value = "zz";
      if (replaceAll) replaceAll.click();
      const replaced = area.value === "fzzzz {\\n    \\nbar";
      press("Escape");
      const closed = bar !== null && bar.hidden === true;
      editorOk = editorOk && replaced && closed;
      say("editor-replace: " + JSON.stringify(area.value) + " closed=" + closed);

      /* The card puts its own edits in through the browser's insert command, so
         the textarea's undo stack still holds them.  Undo the last one. */
      area.focus();
      area.setSelectionRange(0, 0);
      const beforeUndo = area.value;
      press("Tab");
      const typed = area.value !== beforeUndo;
      const undid = typeof doc.execCommand === "function" ? doc.execCommand("undo") : false;
      const restoredByUndo = area.value === beforeUndo;
      editorOk = editorOk && typed && undid === true && restoredByUndo;
      say("editor-undo: typed=" + typed + " command=" + undid + " restored=" + restoredByUndo);

      /* The line-number gutter: on by default, one number per line of the
         buffer, and a click on it hides it without losing the numbers. */
      const gutter = cardNode.querySelector('[data-role="gutter"]');
      const gutterRows = gutter === null ? [] : String(gutter.textContent || "").split("\\n");
      const gutterLines = area.value.split("\\n").length;
      const gutterOn = gutter !== null && gutter.dataset.on === "on" && gutter.offsetWidth > 0;
      say("editor-gutter: " + (gutter !== null) + " on=" + (gutter === null ? "" : String(gutter.dataset.on))
        + " rows=" + gutterRows.length + " lines=" + gutterLines
        + " first=" + JSON.stringify(gutterRows.length > 0 ? gutterRows[0] : "")
        + " last=" + JSON.stringify(gutterRows.length > 0 ? gutterRows[gutterRows.length - 1] : ""));
      let gutterToggled = false;
      if (gutter !== null) {
        gutter.dispatchEvent(new win.MouseEvent("mousedown", { bubbles: true, cancelable: true }));
        gutterToggled = gutter.dataset.on === "off" && gutter.offsetWidth === 0;
        gutter.dispatchEvent(new win.MouseEvent("mousedown", { bubbles: true, cancelable: true }));
      }
      say("editor-gutter-toggle: " + gutterToggled
        + " back=" + (gutter === null ? "" : String(gutter.dataset.on)));
      editorOk = editorOk && gutterOn && gutterToggled && gutterRows.length === gutterLines;
    }
  } catch (error) {
    editorOk = false;
    say("editor-error: " + (error && error.message ? error.message : String(error)));
  }

  /* --- classic view: the same board, tiled as a sidebar, tabs and a code area ---
     classic.mjs's arithmetic is pinned by the pure suite; what a browser has to
     witness is the pixels.  The strip has to be a band under the HUD, the code
     area has to fill what is left of the right column, the sidebar the left, and
     the two have to end on the board's bottom edge together -- while a card with
     no place in the tile is hidden, never moved off screen.  Then `mode board`
     has to put every card back exactly where the document says it was: that is
     what makes the view a projection of the board and not a second board. */
  let classicOk = true;
  try {
    if (doc.activeElement && doc.activeElement.blur) doc.activeElement.blur();
    const cardsNow = () => Array.from(doc.querySelectorAll("#cards [data-card-id]"));
    const drawn = (node) => win.getComputedStyle(node).display !== "none";
    const near = (a, b) => Math.abs(a - b) <= 2;
    const strip = () => doc.getElementById("tabs");
    const tabButtons = () => Array.from(strip().querySelectorAll("button[data-card-id]"));
    const selectionLine = () => (doc.getElementById("hud-selection").textContent || "").trim();
    const runLine = (text) => {
      const box = doc.getElementById("command");
      box.value = text;
      box.dispatchEvent(new win.KeyboardEvent("keydown", { bubbles: true, cancelable: true, key: "Enter" }));
    };
    /* What a round trip through the classic view has to preserve: the board's own
       pan and zoom, the link layer, and every card's place, size and visibility. */
    const snapshot = () => {
      const parts = ["stage=" + stageTransform(), "zoom=" + hudZoom(),
        "links=" + (doc.getElementById("links").hidden ? "hidden" : "shown")];
      for (const node of cardsNow()) {
        parts.push([node.dataset.cardId, node.style.transform, node.style.width,
          node.style.height, win.getComputedStyle(node).display].join(" "));
      }
      return parts.join(" | ");
    };

    const before = snapshot();
    const editors = cardsNow().filter((node) => node.dataset.kind === "editor").map((node) => node.dataset.cardId);
    runLine("mode classic");
    await waitUntil(() => doc.body.classList.contains("is-classic"), 40, 100);
    const isClassic = doc.body.classList.contains("is-classic");
    const modeText = (() => {
      const switchNode = doc.getElementById("mode-switch");
      const current = switchNode === null ? null : switchNode.querySelector("button.is-current");
      return current === null ? "" : (current.textContent || "").trim();
    })();
    const buttons = tabButtons();
    const shownCards = cardsNow().filter(drawn);
    const areaNode = shownCards.find((node) => node.dataset.kind === "editor") || null;
    const sideNode = shownCards.find((node) => node !== areaNode) || null;
    const boardRect = doc.getElementById("board").getBoundingClientRect();
    const hudRect = doc.getElementById("hud").getBoundingClientRect();
    const stripRect = strip().getBoundingClientRect();
    const areaRect = areaNode === null ? null : areaNode.getBoundingClientRect();
    const sideRect = sideNode === null ? null : sideNode.getBoundingClientRect();
    /* The tile is in the board's own pixels, so measure from the board's corner:
       `hudBottom` is where classic.mjs starts the strip (it asks the HUD how tall
       it is), and the two columns end on the board's bottom edge together. */
    const hudBottom = hudRect.bottom - boardRect.top;
    const relTop = (rect) => rect.top - boardRect.top;
    const relLeft = (rect) => rect.left - boardRect.left;
    /* One place each: what is drawn is the code area and -- when the board has a
       card that can stand in the sidebar -- the sidebar, and nothing else. */
    const places = shownCards.length === (sideNode === null ? 1 : 2)
      && shownCards.every((node) => node === areaNode || node === sideNode);
    const tile = isClassic && areaRect !== null && stripRect.height > 0
      && near(relTop(stripRect), hudBottom)
      && near(relTop(areaRect), relTop(stripRect) + stripRect.height)
      && (sideRect === null
        ? near(relLeft(stripRect), 0)
        : near(relLeft(stripRect), relLeft(sideRect) + sideRect.width)
          && near(relTop(sideRect), hudBottom)
          && near(sideRect.bottom, boardRect.bottom))
      && near(areaRect.right, boardRect.right)
      && near(areaRect.bottom, boardRect.bottom);
    say("classic-mode: on=" + isClassic + " tabs=" + buttons.length + " editors=" + editors.length
      + " shown=" + shownCards.map((node) => node.dataset.cardId).join(",")
      + " places=" + places + " tile=" + tile + " strip=" + Math.round(stripRect.height)
      + " button=" + JSON.stringify(modeText) + " zoom=" + JSON.stringify(hudZoom()));
    say("classic-rect: board=" + Math.round(boardRect.width) + "x" + Math.round(boardRect.height)
      + " hud-bottom=" + Math.round(hudBottom)
      + " tabs=" + Math.round(relLeft(stripRect)) + "," + Math.round(relTop(stripRect))
      + "+" + Math.round(stripRect.width) + "x" + Math.round(stripRect.height)
      + " area=" + (areaRect === null ? "-" : Math.round(relLeft(areaRect)) + "," + Math.round(relTop(areaRect))
        + "+" + Math.round(areaRect.width) + "x" + Math.round(areaRect.height))
      + " side=" + (sideRect === null ? "-" : Math.round(relLeft(sideRect)) + "," + Math.round(relTop(sideRect))
        + "+" + Math.round(sideRect.width) + "x" + Math.round(sideRect.height)));

    /* A tab is a file: clicking one makes it the code area, on the same pixels
       the previous one had, and selects it -- the route `focus` takes. */
    let tabClick = false;
    let clickedId = "";
    let tabWhy = "no second tab to click";
    if (buttons.length >= 2 && areaRect !== null) {
      const other = buttons.find((button) => button.dataset.cardId !== areaNode.dataset.cardId);
      clickedId = other.dataset.cardId;
      other.click();
      await sleep(200);
      const moved = cardsNow().find((node) => node.dataset.cardId === clickedId);
      const movedRect = moved.getBoundingClientRect();
      const active = strip().querySelector("button.is-active");
      /* Split the verdict so a failure says which of the three it was: the box,
         the strip's own idea of the current tab, or the selection line. */
      const sameBox = drawn(moved) && near(relLeft(movedRect), relLeft(areaRect))
        && near(relTop(movedRect), relTop(areaRect))
        && near(movedRect.width, areaRect.width) && near(movedRect.height, areaRect.height);
      const isActive = active !== null && active.dataset.cardId === clickedId;
      const selected = selectionLine().indexOf(clickedId) !== -1;
      tabClick = sameBox && isActive && selected;
      tabWhy = "box=" + sameBox + " drawn=" + drawn(moved) + " active=" + isActive
        + " selected=" + selected
        + " at=" + Math.round(relLeft(movedRect)) + "," + Math.round(relTop(movedRect))
        + "+" + Math.round(movedRect.width) + "x" + Math.round(movedRect.height)
        + " area=" + Math.round(relLeft(areaRect)) + "," + Math.round(relTop(areaRect))
        + "+" + Math.round(areaRect.width) + "x" + Math.round(areaRect.height);
    }
    say("classic-tab: clicked=" + JSON.stringify(clickedId) + " moved=" + tabClick
      + " selection=" + JSON.stringify(selectionLine()) + " -- " + tabWhy);

    /* The wheel is the board's gesture and the board is not on screen: neither a
       ctrl+wheel over the code area nor a plain wheel over the strip may move the
       viewport, and the HUD has to keep saying there is no zoom to speak of. */
    const stageBefore = stageTransform();
    const zoomBefore = hudZoom();
    const areaNow = cardsNow().find((node) => node.dataset.kind === "editor" && drawn(node)) || null;
    if (areaNow !== null) {
      const rect = areaNow.getBoundingClientRect();
      const at = { clientX: Math.round(rect.left + rect.width / 2),
        clientY: Math.round(rect.top + Math.min(40, Math.max(1, rect.height / 2))) };
      wheel(win, doc.elementFromPoint(at.clientX, at.clientY) || areaNow,
        Object.assign({ deltaY: -240, ctrlKey: true }, at));
    }
    await sleep(120);
    wheel(win, doc.getElementById("board"), { deltaY: 160,
      clientX: Math.round(stripRect.left + 4), clientY: Math.round(stripRect.top + 2) });
    await sleep(120);
    const frozen = stageTransform() === stageBefore && hudZoom() === zoomBefore
      && hudZoom() === "no zoom";
    say("classic-wheel: frozen=" + frozen + " stage=" + JSON.stringify(stageBefore)
      + "->" + JSON.stringify(stageTransform()) + " zoom=" + JSON.stringify(zoomBefore)
      + "->" + JSON.stringify(hudZoom()));

    /* And back: the same document, on the same pixels, with the viewport exactly
       where it was -- nothing was mounted, unmounted or moved while away. */
    runLine("mode board");
    await sleep(250);
    const back = !doc.body.classList.contains("is-classic") && snapshot() === before;
    say("classic-back: restored=" + back + " classic=" + doc.body.classList.contains("is-classic"));

    classicOk = isClassic && editors.length > 0 && buttons.length === editors.length
      && places && tile && tabClick && frozen && back;
  } catch (error) {
    classicOk = false;
    say("classic-error: " + (error && error.message ? error.message : String(error)));
  }

  /* --- pixel cards: one file, one card, and the pixels are the file --------------
     The board document keeps a pixel card's path and size; the pixels are the .png
     on disk, and Ctrl+Z over the canvas is the card's own ring (main.mjs's
     cardUndoOrRing) before it can ever be the board's.  This half presses, drags
     and releases on the canvas with the events a real mouse sends, reads the image
     back with the card's own eyedropper -- the card's own report of what is under
     the pointer -- and then saves, so the Python side can decode the file the card
     really wrote.  Every path is fresh under build/, so no file in the repository
     is ever touched, and the cards are deleted again at the end. */
  let pixelOk = false;
  try {
    const pixelPaths = { pencil: "@@PIXEL@@", eraser: "@@PIXEL2@@", fill: "@@PIXEL3@@" };
    const cardsNow = () => Array.from(doc.querySelectorAll("#cards [data-card-id]"));
    const find = (node, selector) => node.querySelector(selector);
    const textOf = (node, selector) => {
      const el = find(node, selector);
      return el === null ? "" : (el.textContent || "").trim();
    };
    const valueOf = (node, selector) => {
      const el = find(node, selector);
      return el === null ? "" : String(el.value || "").trim();
    };
    const runLine = (text) => {
      const box = doc.getElementById("command");
      box.value = text;
      box.dispatchEvent(new win.KeyboardEvent("keydown", { bubbles: true, cancelable: true, key: "Enter" }));
    };
    const pixelsNow = () => cardsNow().filter((node) => node.dataset.kind === "pixel");
    const cardOf = (label) => pixelsNow().find((node) => textOf(node, ".card-label") === label) || null;
    const statusOf = (node) => textOf(node, '[data-role="card-status"]');
    /* The DOM order of the cards is not the document's, so compare the same cards
       rather than the same list. */
    const geometry = () => cardsNow()
      .map((node) => node.dataset.cardId + "@" + node.style.transform).sort().join(" | ");
    const zoomOf = (node) => Math.max(1,
      Number(textOf(node, '[data-role="pixel-zoom"]').replace(/[^0-9]/g, "")) || 8);
    /* The card's own arithmetic: a pointer at the centre of image pixel (x, y) is
       `zoom` canvas pixels from the canvas' corner, less the pan.  Nothing is
       panned here, and the click has to follow the card's mapping (not the bitmap,
       which is 1:1 with the box today) or it would edit a pixel the card
       disagrees about.  A client coordinate is an integer and the canvas' corner
       is not, so aim at the pixel's first column and row: rounding a centre
       crossed into the next pixel whenever the zoom was 1. */
    const pointAt = (node, x, y) => {
      const rect = find(node, '[data-role="pixel-canvas"]').getBoundingClientRect();
      const zoom = zoomOf(node);
      return {
        clientX: Math.ceil(rect.left + x * zoom),
        clientY: Math.ceil(rect.top + y * zoom),
      };
    };
    const pointer = (node, target, type, x, y, buttons) => {
      const at = pointAt(node, x, y);
      target.dispatchEvent(new win.PointerEvent(type, Object.assign({
        bubbles: true, cancelable: true, button: 0, buttons: buttons,
        pointerId: 1, pointerType: "mouse", isPrimary: true,
      }, at)));
    };
    /* Press, drag across the pixels in between, release: the canvas hears the
       press, the surface hears the moves and the release. */
    const dragTo = async (node, from, to) => {
      const canvas = find(node, '[data-role="pixel-canvas"]');
      const surface = find(node, '[data-role="pixel-surface"]');
      pointer(node, canvas, "pointerdown", from[0], from[1], 1);
      await sleep(40);
      for (let step = 1; step <= 6; step++) {
        const x = Math.round(from[0] + (to[0] - from[0]) * step / 6);
        const y = Math.round(from[1] + (to[1] - from[1]) * step / 6);
        pointer(node, surface, "pointermove", x, y, 1);
        await sleep(10);
      }
      pointer(node, surface, "pointerup", to[0], to[1], 0);
      await sleep(80);
    };
    const press = async (node, x, y) => {
      pointer(node, find(node, '[data-role="pixel-canvas"]'), "pointerdown", x, y, 1);
      await sleep(40);
      pointer(node, find(node, '[data-role="pixel-surface"]'), "pointerup", x, y, 0);
      await sleep(80);
    };
    const pickTool = (node, tool) => { find(node, '[data-role="pixel-tool-' + tool + '"]').click(); };
    /* A swatch that is not the one already in hand: the palette is the card's. */
    const pickSwatch = (node, not) => {
      const swatch = Array.from(node.querySelectorAll('[data-role="pixel-swatch"]'))
        .find((button) => button.dataset.colour && button.dataset.colour !== not) || null;
      if (swatch === null) return "";
      swatch.click();
      return swatch.dataset.colour;
    };
    const saveNow = async (node) => {
      find(node, '[data-role="pixel-save"]').click();
      await waitUntil(() => /saved |not saving|nothing to save/.test(statusOf(node)), 40, 250);
      return statusOf(node);
    };
    /* What is under the pointer, in the card's own words: the eyedropper reads the
       live image and the status line then ends with that pixel's ink. */
    const inkAt = async (node, x, y) => {
      pickTool(node, "eyedropper");
      await press(node, x, y);
      const found = statusOf(node).match(/#[0-9a-fA-F]{6}|transparent/g);
      return found === null ? "" : found[found.length - 1];
    };
    /* Both the card and this half map a pointer through getBoundingClientRect, so
       press only once the canvas has a laid-out box -- and the box is not enough:
       CSS sizes the canvas from the moment the card exists, while the image only
       arrives with the file the card reads.  A press before that is dropped (the
       card has nothing to draw on) and the stroke leaves no trace at all, so wait
       for the status line to carry the image's WxH, which the card only prints
       once it has one.  A re-render replaces the node, so this returns the card as
       it is now, not the one that was handed in. */
    const settle = async (label) => {
      await waitUntil(() => {
        const node = cardOf(label);
        if (node === null) return false;
        const canvas = find(node, '[data-role="pixel-canvas"]');
        const box = canvas === null ? null : canvas.getBoundingClientRect();
        return box !== null && box.width > 0 && box.height > 0
          && /[0-9]+×[0-9]+/.test(statusOf(node));
      }, 60, 100);
      return cardOf(label);
    };
    /* A fresh 8x8 card on a path that does not exist yet: the first save creates
       the file, so nothing in the repository is overwritten. */
    const openCard = async (label, width, height) => {
      runLine("pixel " + label + " " + width + " " + height);
      await waitUntil(() => cardOf(label) !== null, 40, 100);
      return await settle(label);
    };
    const startedWith = cardsNow().map((node) => node.dataset.cardId);

    /* 1. the pencil: press at one pixel, drag across four, release, save -- and
       then let the card itself say what its image holds. */
    let pencilOk = false;
    let pencilLine = "pixel-pencil: the card never opened";
    const pencilCard = await openCard(pixelPaths.pencil, 8, 8);
    if (pencilCard !== null) {
      pickTool(pencilCard, "pencil");
      const drew = pickSwatch(pencilCard, "#000000");
      await dragTo(pencilCard, [1, 1], [4, 1]);
      const saved = await saveNow(pencilCard);
      const inPress = await inkAt(pencilCard, 1, 1);
      const pastIt = await inkAt(pencilCard, 5, 5);
      pencilOk = drew !== "" && inPress === drew && saved.indexOf("saved ") === 0;
      pencilLine = "pixel-pencil: file=" + JSON.stringify(pixelPaths.pencil)
        + " drew=" + JSON.stringify(drew) + " press=" + JSON.stringify(inPress)
        + " far=" + JSON.stringify(pastIt) + " zoom=" + zoomOf(pencilCard)
        + " saved=" + JSON.stringify(saved);
    }
    say(pencilLine);

    /* 2. the eraser over the pixel the pencil left, and the file that says it is
       gone: a second card, so the pencil's own file above is still there. */
    let eraserOk = false;
    let eraserLine = "pixel-eraser: the card never opened";
    const eraserCard = await openCard(pixelPaths.eraser, 8, 8);
    if (eraserCard !== null) {
      pickTool(eraserCard, "pencil");
      const drew = pickSwatch(eraserCard, "#000000");
      await dragTo(eraserCard, [1, 1], [2, 1]);
      const painted = await inkAt(eraserCard, 1, 1);
      pickTool(eraserCard, "eraser");
      await dragTo(eraserCard, [1, 1], [2, 1]);
      const cleared = await inkAt(eraserCard, 1, 1);
      const saved = await saveNow(eraserCard);
      eraserOk = drew !== "" && painted === drew && cleared === "transparent"
        && saved.indexOf("saved ") === 0;
      eraserLine = "pixel-eraser: file=" + JSON.stringify(pixelPaths.eraser)
        + " before=" + JSON.stringify(painted) + " after=" + JSON.stringify(cleared)
        + " saved=" + JSON.stringify(saved);
    }
    say(eraserLine);

    /* 3. the fill on an empty region: a third card, blank from top to bottom, so
       the region under the pointer is the whole image and one press is enough. */
    let fillOk = false;
    let fillLine = "pixel-fill: the card never opened";
    const fillCard = await openCard(pixelPaths.fill, 8, 8);
    let filledWith = "";
    if (fillCard !== null) {
      pickTool(fillCard, "fill");
      filledWith = pickSwatch(fillCard, "#000000");
      await press(fillCard, 0, 0);
      const saved = await saveNow(fillCard);
      const inPress = await inkAt(fillCard, 0, 0);
      const far = await inkAt(fillCard, 7, 7);
      fillOk = filledWith !== "" && inPress === filledWith && far === filledWith
        && saved.indexOf("saved ") === 0;
      fillLine = "pixel-fill: file=" + JSON.stringify(pixelPaths.fill)
        + " filled=" + JSON.stringify(filledWith) + " press=" + JSON.stringify(inPress)
        + " far=" + JSON.stringify(far) + " saved=" + JSON.stringify(saved);
    }
    say(fillLine);

    /* 4. Ctrl+Z over the focused canvas: the card's own ring has to take the
       stroke back, and the board -- the document that says which cards exist and
       where they sit -- must not move.  That is what cardUndoOrRing is for. */
    let undoOk = false;
    let redoOk = false;
    let undoLine = "pixel-undo: no card to draw on";
    let redoLine = "pixel-redo: no card to draw on";
    if (fillCard !== null) {
      const second = pickSwatch(fillCard, filledWith);
      pickTool(fillCard, "pencil");
      await press(fillCard, 7, 7);
      const afterStroke = await inkAt(fillCard, 7, 7);
      runLine("focus " + fillCard.dataset.cardId);
      await sleep(200);
      const focused = await settle(pixelPaths.fill);
      const canvas = focused === null ? null : find(focused, '[data-role="pixel-canvas"]');
      const hasFocus = canvas !== null && doc.activeElement === canvas;
      const placed = geometry();
      const viewport = stageTransform() + " / " + hudZoom();
      key(win, canvas, { key: "z", ctrlKey: true });
      await sleep(250);
      const afterUndo = await inkAt(focused, 7, 7);
      const undoStatus = statusOf(focused);
      const kept = geometry() === placed;
      const still = stageTransform() + " / " + hudZoom() === viewport;
      key(win, canvas, { key: "z", ctrlKey: true, shiftKey: true });
      await sleep(250);
      const afterRedo = await inkAt(focused, 7, 7);
      undoOk = hasFocus && afterStroke === second && afterUndo === filledWith
        && afterUndo !== afterStroke && kept && still;
      redoOk = afterRedo === second;
      undoLine = "pixel-undo: focused=" + hasFocus + " stroke=" + JSON.stringify(afterStroke)
        + " after-ctrl+z=" + JSON.stringify(afterUndo) + " board-document=" + kept
        + " viewport=" + still + " status=" + JSON.stringify(undoStatus);
      redoLine = "pixel-redo: after-ctrl+shift+z=" + JSON.stringify(afterRedo)
        + " status=" + JSON.stringify(statusOf(focused));
    }
    say(undoLine);
    say(redoLine);

    /* 5. the PROBLEMS card's D006 row: it names a sprite file that is not on
       disk, and clicking it has to open a pixel card on that sprite -- not on the
       define JSON that declared it, which stays one row-extra away. */
    let d006Ok = false;
    let sizeOk = false;
    let d006Line = "pixel-d006: no D006 row";
    const modName = "@@MOD@@";
    const problemsCard = () => cardsNow()
      .find((node) => node.dataset.kind === "problems" && textOf(node, ".card-label") === modName) || null;
    const rowsOf = (node) => Array.from(node.querySelectorAll(".problems-rows .mod-row"));
    const isD006 = (row) => textOf(row, ".mod-row-name").indexOf("D006") === 0;
    const d006Row = () => {
      const host = problemsCard();
      return host === null ? null : rowsOf(host).find(isD006) || null;
    };
    runLine("problems " + modName);
    await waitUntil(() => d006Row() !== null, 120, 250);
    const row = d006Row();
    if (row === null) {
      const host = problemsCard();
      d006Line = "pixel-d006: no D006 row in " + JSON.stringify(modName)
        + " -- " + JSON.stringify(host === null ? "no problems card" : statusOf(host));
    } else {
      const host = problemsCard();
      const extra = find(row, '[data-role="mod-row-extra"]');
      const extraText = extra === null ? "" : (extra.textContent || "").trim();
      const declaredIn = extraText.indexOf("declared in ") === 0
        ? extraText.slice("declared in ".length).trim() : "";
      /* The row's own message names the sprite: `...不存在：<sprite>（在 Mod ...` */
      const named = (textOf(row, ".mod-row-name").match(/：([^（]+)（/) || [null, ""])[1];
      const rows = rowsOf(host).length;
      const d006Rows = rowsOf(host).filter(isD006).length;
      const before = pixelsNow().map((node) => textOf(node, ".card-label"));
      row.click();
      await waitUntil(() => pixelsNow().some((node) => before.indexOf(textOf(node, ".card-label")) < 0), 40, 100);
      const opened = pixelsNow().find((node) => before.indexOf(textOf(node, ".card-label")) < 0) || null;
      const sprite = opened === null ? null : await settle(textOf(opened, ".card-label"));
      if (sprite === null) {
        d006Line = "pixel-d006: rows=" + rows + " d006=" + d006Rows
          + " clicked=" + JSON.stringify(named) + " but no pixel card: " + JSON.stringify(statusOf(host));
      } else {
        const spriteLabel = textOf(sprite, ".card-label");
        const size = valueOf(sprite, '[data-role="pixel-width"]') + "x"
          + valueOf(sprite, '[data-role="pixel-height"]');
        const box = find(sprite, '[data-role="pixel-canvas"]').getBoundingClientRect();
        pickTool(sprite, "pencil");
        const drew = pickSwatch(sprite, "#000000");
        await dragTo(sprite, [6, 2], [14, 2]);
        const inPress = await inkAt(sprite, 6, 2);
        const far = await inkAt(sprite, 12, 12);
        d006Ok = rows > 0 && d006Rows > 0 && declaredIn !== "" && named !== ""
          && spriteLabel === modName + "/" + named && spriteLabel !== declaredIn
          && spriteLabel.indexOf(modName + "/") === 0 && /[.]png$/.test(spriteLabel)
          && /[.]json$/.test(declaredIn);
        sizeOk = size === "96x96" && drew !== "" && inPress === drew && far === "transparent";
        d006Line = "pixel-d006: rows=" + rows + " d006=" + d006Rows
          + " declared=" + (declaredIn !== "") + " named=" + JSON.stringify(named)
          + " sprite=" + JSON.stringify(spriteLabel) + " json=" + JSON.stringify(declaredIn)
          + " size=" + JSON.stringify(size) + " zoom=" + zoomOf(sprite)
          + " box=" + Math.round(box.width) + "x" + Math.round(box.height)
          + " drew=" + JSON.stringify(drew)
          + " press=" + JSON.stringify(inPress) + " far=" + JSON.stringify(far);
      }
    }
    say(d006Line);

    /* 6. and nothing is left behind: the cards this half opened, not the ones the
       workspace came with.  The sprite card was never saved, so no file was
       created for it either. */
    const added = cardsNow().map((node) => node.dataset.cardId)
      .filter((id) => startedWith.indexOf(id) < 0);
    for (const id of added) runLine("delete " + id);
    await sleep(300);
    const left = added.filter((id) => cardsNow().some((node) => node.dataset.cardId === id)).length;
    const others = pixelsNow().map((node) => textOf(node, ".card-label")).sort().join(",");
    say("pixel-cards: added=" + added.length + " left=" + left + " others=" + JSON.stringify(others));
    pixelOk = pencilOk && eraserOk && fillOk && undoOk && redoOk && d006Ok && sizeOk && left === 0;
  } catch (error) {
    pixelOk = false;
    say("pixel-error: " + (error && error.message ? error.message : String(error)));
  }

  say("RESULT: " + (ok && wheelOk && watchOk && editorOk && classicOk && pixelOk
    ? "undo, redo, wheel ownership, a watched file, the editor keys, the classic view and the pixel cards all work in a real browser"
    : "FAILED -- see the counts, the wheel, the watch, the editor, the classic and the pixel lines above"));
  document.title = "input smoke done";
}

main();
</script>
</body></html>
"""

#: The wrapper says "@@FILE@@"; the run fills in the file the wheel half opens.
PAGE = PAGE.replace("@@FILE@@", SCROLL_FILE)
#: ...and "@@SCRATCH@@", the file the watch half rewrites from a second process.
PAGE = PAGE.replace("@@SCRATCH@@", SCRATCH_REL)
#: ...and the three fresh .png paths the pixel half draws on.
PAGE = PAGE.replace("@@PIXEL@@", PIXEL_STROKES[0][1])
PAGE = PAGE.replace("@@PIXEL2@@", PIXEL_STROKES[1][1])
PAGE = PAGE.replace("@@PIXEL3@@", PIXEL_STROKES[2][1])
#: ...and the mod whose D006 rows its problems card has to offer.
PAGE = PAGE.replace("@@MOD@@", MOD_NAME)


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        prog="input_smoke.py",
        description=(
            "Boot the real app in the system browser, make a board change, press "
            "Ctrl+Z and Ctrl+Shift+Z, dispatch a wheel over a card's own scroll "
            "region and over the board, watch a file change under an open card, "
            "drive the editor card's indent, auto-indent, find and replace keys, "
            "and switch to the classic view -- the same cards as a sidebar, a tab "
            "strip and a code area -- click a tab, wheel it and come back to the "
            "board. Exit codes: 0 pass or skipped, 1 a check failed, 2 could not "
            "run, 3 usage."
        ),
    )
    parser.add_argument("--edge", help="path to msedge.exe (default: $INFANTGOD_BROWSER, then the usual two places)")
    parser.add_argument("--port", type=int, default=0, help="port for the host (default: a free one)")
    parser.add_argument("--timeout", type=float, default=180.0, help="seconds to allow the browser")
    parser.add_argument("--keep", action="store_true", help="keep the wrapper page for debugging")
    return parser


class Results:
    """The PASS/FAIL lines and the summary."""

    def __init__(self) -> None:
        self.checks = []

    def check(self, name: str, ok: bool, detail: str = "") -> None:
        self.checks.append((name, bool(ok), detail))
        mark = "PASS" if ok else "FAIL"
        print(f"[{mark}] {name}" + (f": {detail}" if detail else ""))

    def report(self, attempts: int) -> int:
        passed = sum(1 for _, ok, _ in self.checks if ok)
        failed = len(self.checks) - passed
        print(f"summary: {passed} passed, {failed} failed ({len(self.checks)} checks, "
              f"{attempts} browser launch(es))")
        return 0 if failed == 0 else 1


COUNT_RE = re.compile(r"counts: boot=(\d+) added=(\d+) undone=(\d+) redone=(\d+) in-field=(\d+)")

#: Each wheel line the wrapper writes, as ``name -> pattern``.
WHEEL_RES = (
    ("card", re.compile(r"wheel-card: defaultPrevented=(\w+) viewport-moved=(\w+)(?:  \((.+)\))?")),
    ("board", re.compile(r"wheel-board: defaultPrevented=(\w+) viewport-moved=(\w+)")),
    ("ctrl", re.compile(r"wheel-ctrl: (\S+) -> (\S+)")),
)


def parse_counts(body: str) -> dict:
    found = COUNT_RE.search(body)
    if found is None:
        return {}
    keys = ["boot", "added", "undone", "redone", "inField"]
    return dict(zip(keys, (int(value) for value in found.groups())))


def parse_wheel(body: str) -> dict:
    """The wheel lines the wrapper wrote, keyed by name."""
    found = {}
    for name, pattern in WHEEL_RES:
        match = pattern.search(body)
        if match is not None:
            found[name] = match.groups()
    none = re.search(r"wheel-card: none -- .*?\[(.+)\]", body)
    if none is not None:
        found["card_none"] = none.group(1)
    return found


def parse_watch(body: str) -> dict:
    """The watched-file lines the wrapper wrote, as tuples of raw strings."""
    found = {}
    patterns = (
        ("open", r'watch-open: open=(\w+) text="([^"]*)" status="([^"]*)"'),
        ("reload", r'watch-reload: reloaded=(\w+) text="([^"]*)" status="([^"]*)"'),
        ("warn", r'watch-warn: warned=(\w+) kept=(\w+) status="([^"]*)"'),
        ("gone", r'watch-gone: gone=(\w+) kept=(\w+) status="([^"]*)"'),
    )
    for key, pattern in patterns:
        match = re.search(pattern, body)
        if match is not None:
            found[key] = match.groups()
    none = re.search(r"watch-(?:error|note): (.+)", body)
    if none is not None:
        found["error"] = (none.group(1),)
    return found


def parse_editor(body: str) -> dict:
    """The editor-key lines the wrapper wrote, as tuples of raw strings."""
    found = {}
    patterns = (
        ("indent", r'editor-indent: tab="([^"]*)" caret=(\d+) shift-tab-restores=(\w+)'),
        ("enter", r'editor-enter: "([^"]*)" caret=(\d+)'),
        ("find", r'editor-find: open=(\w+) hits=(\d+) count="([^"]*)"'),
        ("next", r'editor-find-next: count="([^"]*)" current=(\d+)'),
        ("replace", r'editor-replace: "([^"]*)" closed=(\w+)'),
        ("undo", r"editor-undo: typed=(\w+) command=(\w+) restored=(\w+)"),
        ("gutter", r'editor-gutter: (true|false) on=(\w+) rows=(\d+) lines=(\d+)'
                   r' first="([^"]*)" last="([^"]*)"'),
        ("gutter_toggle", r"editor-gutter-toggle: (true|false) back=(\w+)"),
    )
    for key, pattern in patterns:
        match = re.search(pattern, body)
        if match is not None:
            found[key] = match.groups()
    none = re.search(r"editor-(?:none|error):? --? ?(.+)", body)
    if none is not None:
        found["none"] = (none.group(1),)
    return found


def parse_classic(body: str) -> dict:
    """The four classic-view lines the wrapper wrote, as tuples of strings."""
    found = {}
    patterns = (
        ("mode", r'classic-mode: on=(\w+) tabs=(\d+) editors=(\d+) shown=(\S*)'
                 r' places=(\w+) tile=(\w+) strip=(\d+) button=("[^"]*") zoom=("[^"]*")'),
        ("tab", r'classic-tab: clicked=("[^"]*") moved=(\w+) selection=("[^"]*")'),
        ("wheel", r'classic-wheel: frozen=(\w+) stage=("[^"]*")->("[^"]*")'
                  r' zoom=("[^"]*")->("[^"]*")'),
        ("back", r"classic-back: restored=(\w+) classic=(\w+)"),
    )
    for key, pattern in patterns:
        match = re.search(pattern, body)
        if match is not None:
            found[key] = match.groups()
    none = re.search(r"classic-error: (.+)", body)
    if none is not None:
        found["error"] = (none.group(1),)
    return found


#: Each pixel-card line the wrapper writes, as ``name -> pattern``.
PIXEL_RES = (
    ("pencil", r'pixel-pencil: file="([^"]*)" drew="([^"]*)" press="([^"]*)" far="([^"]*)"'),
    ("eraser", r'pixel-eraser: file="([^"]*)" before="([^"]*)" after="([^"]*)"'),
    ("fill", r'pixel-fill: file="([^"]*)" filled="([^"]*)" press="([^"]*)" far="([^"]*)"'),
    ("undo", r'pixel-undo: focused=(\w+) stroke="([^"]*)" after-ctrl\+z="([^"]*)"'
             r' board-document=(\w+) viewport=(\w+)'),
    ("redo", r'pixel-redo: after-ctrl\+shift\+z="([^"]*)"'),
    ("d006", r'pixel-d006: rows=(\d+) d006=(\d+) declared=(\w+) named="([^"]*)"'
             r' sprite="([^"]*)" json="([^"]*)" size="([^"]*)"'
             r'(?: zoom=\d+ box=[0-9x]+)? drew="([^"]*)"'
             r' press="([^"]*)" far="([^"]*)"'),
    ("cards", r'pixel-cards: added=(\d+) left=(\d+) others="([^"]*)"'),
)


def parse_pixel(body: str) -> dict:
    """The pixel-card lines the wrapper wrote, as tuples of raw strings."""
    found = {}
    for key, pattern in PIXEL_RES:
        match = re.search(pattern, body)
        if match is not None:
            found[key] = match.groups()
    # A pixel line that starts with `pixel-error` is the half's own report of a
    # throwaway failure; the detail of a check whose line is missing quotes it.
    none = re.search(r"pixel-error: (.+)", body)
    if none is not None:
        found.setdefault("note", (none.group(1),))
    return found


def decode_rgba(path: Path):
    """``(width, height, rows)`` for a .png, rows as raw RGBA bytes.

    The pixel card writes 8-bit RGBA colour type 6, non-interlaced, one IDAT and
    no ancillary chunks, so unfiltering a few scanlines of ``zlib.decompress`` is
    the whole decoder -- and the check then reads the file the card really wrote
    rather than what the card says about it.  All five filter types are honoured
    in case the encoder grows a better one.
    """
    raw = path.read_bytes()
    if raw[:8] != b"\x89PNG\r\n\x1a\n":
        raise ValueError(f"{path.name} does not start with a png signature")
    width = height = None
    packed = bytearray()
    at = 8
    while at + 8 <= len(raw):
        length = int.from_bytes(raw[at:at + 4], "big")
        kind = raw[at + 4:at + 8]
        body = raw[at + 8:at + 8 + length]
        at += 12 + length
        if kind == b"IHDR":
            width = int.from_bytes(body[0:4], "big")
            height = int.from_bytes(body[4:8], "big")
            if body[8] != 8 or body[9] != 6:
                raise ValueError(f"{path.name}: bit depth {body[8]}, colour type {body[9]}, want 8/6")
        elif kind == b"IDAT":
            packed += body
        elif kind == b"IEND":
            break
    if width is None or height is None:
        raise ValueError(f"{path.name}: no IHDR")
    data = zlib.decompress(bytes(packed))
    stride = width * 4
    rows = []
    previous = bytearray(stride)
    at = 0
    for _ in range(height):
        kind = data[at]
        line = bytearray(data[at + 1:at + 1 + stride])
        at += 1 + stride
        for i in range(stride):
            left = line[i - 4] if i >= 4 else 0
            up = previous[i]
            corner = previous[i - 4] if i >= 4 else 0
            if kind == 1:
                line[i] = (line[i] + left) & 0xFF
            elif kind == 2:
                line[i] = (line[i] + up) & 0xFF
            elif kind == 3:
                line[i] = (line[i] + (left + up) // 2) & 0xFF
            elif kind == 4:
                span = left + up - corner
                near = min(abs(span - left), abs(span - up), abs(span - corner))
                guess = left if near == abs(span - left) else up if near == abs(span - up) else corner
                line[i] = (line[i] + guess) & 0xFF
            elif kind != 0:
                raise ValueError(f"{path.name}: filter type {kind} on row {len(rows)}")
        rows.append(bytes(line))
        previous = line
    return width, height, rows


def rgba_at(rows, x: int, y: int):
    row = rows[y]
    return tuple(row[x * 4:x * 4 + 4])


def opaque_count(rows) -> int:
    return sum(1 for row in rows for i in range(0, len(row), 4) if row[i + 3] != 0)


def ink_of(text: str):
    """The card's own names for a pixel: ``#rrggbb`` opaque, ``transparent`` clear."""
    if text == "transparent":
        return (0, 0, 0, 0)
    if re.fullmatch(r"#[0-9a-fA-F]{6}", text):
        return tuple(int(text[i:i + 2], 16) for i in (1, 3, 5)) + (255,)
    return None


def main(argv=None) -> int:
    args = build_parser().parse_args(argv)
    if args.timeout <= 0:
        build_parser().error("--timeout must be positive")
    if args.port < 0 or args.port > 65535:
        print(f"input_smoke.py: --port {args.port} is not a TCP port", file=sys.stderr)
        return 2
    if WRAPPER.exists():
        print(f"input_smoke.py: refusing to overwrite {WRAPPER}", file=sys.stderr)
        return 2

    try:
        edge = find_edge(args.edge)
    except DriverError as exc:
        print(f"[SKIP] no browser available: {exc}")
        print("summary: 0 passed, 0 failed, 26 skipped (no browser)")
        return 0

    # Deliberately *not* install_if_absent(): the counts below are deltas, so the
    # workspace's board (or its absence) is left exactly as it is until the run's
    # own autosave writes one -- which restore() then takes away again.
    backup = BoardBackup(BOARD_PATH)
    backup.snapshot()

    print(f"input smoke           {REPO_ROOT}")
    print(f"browser               {edge}")
    print(f"board                 {BOARD_PATH}"
          f"{'' if backup.existed else ' (absent -- this run will create and remove it)'}")
    print("-" * 68)
    profile = Path(tempfile.mkdtemp(prefix="infantgod-input-smoke-"))
    WRAPPER.write_text(PAGE, encoding="utf-8", newline="\n")
    # ``serve`` resolves every ``mod.*`` root under ``--mods-root``, which
    # defaults to the workspace; the mod whose D006 rows the pixel check opens
    # sits beside the repository, so the host is browser_smoke's default command
    # plus that one flag.  Without it the problems card answers
    # "路径越界，已被拒绝: SODefines" and there is no row to click.
    port = args.port or free_port()
    host_argv = None
    if MODS_ROOT.is_dir():
        host_argv = ["node", str(SHELL_MAIN), "serve", "--workspace", str(REPO_ROOT),
                     "--mods-root", str(MODS_ROOT), "--port", str(port), "--no-open"]
    host = Host(port, host_argv)
    results = Results()
    attempts = 0
    body = ""
    try:
        host.start()
        host.wait_ready(min(30.0, args.timeout))
        url = host.url + WRAPPER_NAME
        argv_ = [str(edge), *EDGE_FLAGS, f"--user-data-dir={profile}"]
        argv_ = [item if not item.startswith("--virtual-time-budget=")
                 else f"--virtual-time-budget={BUDGET_MS}" for item in argv_]
        done = subprocess.run([*argv_, "--dump-dom", url], capture_output=True, text=True,
                              encoding="utf-8", errors="replace", timeout=args.timeout)
        attempts = 1
        found = RESULT_RE.search(done.stdout or "")
        if found is None:
            print("[FAIL] the page never wrote a result block")
            tail = (done.stdout or "")[-400:]
            if tail:
                print(f"       dom tail: {tail!r}")
        else:
            body = found.group(1)
            for entity, char in (("&lt;", "<"), ("&gt;", ">"), ("&quot;", '"'), ("&amp;", "&")):
                body = body.replace(entity, char)
            for line in body.splitlines():
                print(f"  {line}")
    except (DriverError, OSError, subprocess.TimeoutExpired) as exc:
        print(f"[FAIL] the run did not finish: {exc}")
    finally:
        if not args.keep:
            WRAPPER.unlink(missing_ok=True)
        # The watch half writes this with a real child process; take it away
        # whether or not the checks got that far.
        SCRATCH.unlink(missing_ok=True)
        # The pixel half's cards create their .png on the first save and the
        # checks below decode them, so those files outlive this block and are
        # taken away after the last check.
        alive = host.proc is not None and host.proc.poll() is None
        if alive:
            terminate(host.proc)
        shutil.rmtree(profile, ignore_errors=True)
        restored = backup.restore()
        backup.discard()
        host_gone = not (host.proc is not None and host.proc.poll() is None)

    counts = parse_counts(body)
    wheel = parse_wheel(body)
    booted = "kernel ready: true" in body
    results.check("the app boots in an iframe and reaches kernel ready", booted)
    opened = re.search(r"view-default: classic=(\w+)", body)
    to_board = re.search(r"view-board: classic=(\w+) mod=(\w+)", body)
    folded = re.search(r'log-boot: hidden=(\w+) open=(\w+) shut=(\w+) button="([^"]*)"', body)
    results.check("a window opens on the classic tile with the message strip folded away, and `mode board` is still the board",
                  opened is not None and opened.group(1) == "true"
                  and to_board is not None and to_board.group(1) == "false"
                  and to_board.group(2) == "false"
                  and folded is not None and folded.group(1) == "true"
                  and folded.group(2) == "true" and folded.group(3) == "true",
                  f"at boot classic={opened.group(1) if opened else '?'}, after `mode board` "
                  f"classic={to_board.group(1) if to_board else '?'} "
                  f"mod={to_board.group(2) if to_board else '?'}; "
                  f"strip hidden={folded.group(1) if folded else '?'} "
                  f"open={folded.group(2) if folded else '?'} "
                  f"shut={folded.group(3) if folded else '?'} "
                  f"button={folded.group(4) if folded else '?'}")
    results.check("a double-click on empty space adds a card",
                  counts.get("added") == counts.get("boot", -1) + 1 if counts else False,
                  f"boot={counts.get('boot')} added={counts.get('added')}" if counts else "no counts")
    results.check("Ctrl+Z takes that card back",
                  bool(counts) and counts.get("undone") == counts.get("boot")
                  and "undid:" in body,
                  f"undone={counts.get('undone')} after added={counts.get('added')}" if counts else "no counts")
    results.check("Ctrl+Shift+Z puts it back",
                  bool(counts) and counts.get("redone") == counts.get("added")
                  and "redid:" in body,
                  f"redone={counts.get('redone')}" if counts else "no counts")
    results.check("Ctrl+Z with a text field focused leaves the board alone",
                  bool(counts) and counts.get("inField") == counts.get("redone"),
                  f"in-field={counts.get('inField')} redone={counts.get('redone')}" if counts else "no counts")

    card_wheel = wheel.get("card")
    if card_wheel is None:
        why = wheel.get("card_none")
        results.check("a wheel over a card's own scroll region is left to the card", False,
                      (f"no card's scroll region is under the pointer ({why}) -- not proven"
                       if why else "no card's scroll region is under the pointer -- not proven"))
    else:
        where = f"  ({card_wheel[2]})" if card_wheel[2] else ""
        results.check("a wheel over a card's own scroll region is left to the card",
                      card_wheel[0] == "false" and card_wheel[1] == "false",
                      f"defaultPrevented={card_wheel[0]} viewport-moved={card_wheel[1]}{where}"
                      " -- the card keeps the wheel and the board does not move")
    board_wheel = wheel.get("board")
    results.check("a wheel over the board still pans",
                  bool(board_wheel) and board_wheel[:2] == ("true", "true"),
                  f"defaultPrevented={board_wheel[0]} viewport-moved={board_wheel[1]}"
                  if board_wheel else "no wheel-board line")
    ctrl_wheel = wheel.get("ctrl")
    results.check("ctrl+wheel over a card is still a zoom",
                  bool(ctrl_wheel) and ctrl_wheel[0] != ctrl_wheel[1],
                  f"zoom {ctrl_wheel[0]} -> {ctrl_wheel[1]}" if ctrl_wheel else "no wheel-ctrl line")

    editor = parse_editor(body)

    def editor_detail(key: str) -> str:
        got = editor.get(key)
        if got is not None:
            return " ".join(got)
        if editor.get("none") is not None:
            return f"editor: {editor['none'][0]}"
        return f"no editor-{key} line"

    indent = editor.get("indent")
    results.check("Tab indents by the editor's step, and shift+Tab takes it back",
                  bool(indent) and indent[0] == "    " and indent[1] == "4" and indent[2] == "true",
                  editor_detail("indent"))
    enter = editor.get("enter")
    results.check("a line that opens a block indents the next line",
                  bool(enter) and enter[0].endswith("    \\nbar") and enter[1] == "10",
                  editor_detail("enter"))
    find = editor.get("find")
    results.check("Ctrl+F paints every hit and says how many",
                  bool(find) and find[0] == "true" and find[1] == "2" and find[2] == "1/2",
                  editor_detail("find"))
    step = editor.get("next")
    results.check("the next hit becomes the current one",
                  bool(step) and step[0] == "2/2" and step[1] == "1",
                  editor_detail("next"))
    replace = editor.get("replace")
    results.check("replace-all rewrites the buffer and Escape closes the bar",
                  bool(replace) and replace[0].endswith("fzzzz {\\n    \\nbar") and replace[1] == "true",
                  editor_detail("replace"))
    undo = editor.get("undo")
    results.check("a card's own edits are in the browser's undo stack, not just the buffer",
                  bool(undo) and undo == ("true", "true", "true"),
                  editor_detail("undo"))
    gutter = editor.get("gutter")
    results.check("line numbers are on by default, one per line of the buffer",
                  bool(gutter) and gutter[0] == "true" and gutter[1] == "on"
                  and gutter[2] == gutter[3] and gutter[4] == "1",
                  editor_detail("gutter"))
    toggled = editor.get("gutter_toggle")
    results.check("a click on the gutter hides the numbers and a second click brings them back",
                  bool(toggled) and toggled[0] == "true" and toggled[1] == "on",
                  editor_detail("gutter_toggle"))

    watch = parse_watch(body)

    def watch_detail(key: str) -> str:
        got = watch.get(key)
        if got is not None:
            return " ".join(got)
        if watch.get("error") is not None:
            return f"watch: {watch['error'][0]}"
        return f"no watch-{key} line"

    held_rev = watch.get("open")
    results.check("an editor card on a file reports the revision it read",
                  bool(held_rev) and held_rev[0] == "true" and held_rev[1].startswith("one")
                  and "rev " in held_rev[2] and "loaded" in held_rev[2],
                  f"text={held_rev[1]!r} status={held_rev[2]!r}" if held_rev
                  else watch_detail("open"))
    reloaded_card = watch.get("reload")
    results.check("a write from another process reaches a clean card, which reloads it",
                  bool(reloaded_card) and reloaded_card[0] == "true"
                  and reloaded_card[1].startswith("two")
                  and "reloaded from disk" in reloaded_card[2],
                  f"reloaded={reloaded_card[0]} text={reloaded_card[1]!r} status={reloaded_card[2]!r}"
                  if reloaded_card else watch_detail("reload"))
    warned_card = watch.get("warn")
    results.check("a card with unsaved edits keeps them and says the file changed",
                  bool(warned_card) and warned_card[0] == "true" and warned_card[1] == "true"
                  and "changed on disk" in warned_card[2] and "modified" in warned_card[2],
                  f"warned={warned_card[0]} kept={warned_card[1]} status={warned_card[2]!r}"
                  if warned_card else watch_detail("warn"))
    deleted_card = watch.get("gone")
    results.check("a file deleted under a card is reported and the text stays",
                  bool(deleted_card) and deleted_card[0] == "true" and deleted_card[1] == "true"
                  and "gone from disk" in deleted_card[2],
                  f"gone={deleted_card[0]} kept={deleted_card[1]} status={deleted_card[2]!r}"
                  if deleted_card else watch_detail("gone"))

    classic = parse_classic(body)

    def classic_detail(key: str) -> str:
        got = classic.get(key)
        if got is not None:
            return " ".join(got)
        if classic.get("error") is not None:
            return f"classic: {classic['error'][0]}"
        return f"no classic-{key} line"

    mode = classic.get("mode")
    results.check("`mode classic` tiles the same cards into a sidebar, a tab strip and a code area",
                  bool(mode) and mode[0] == "true" and int(mode[2]) >= 1
                  and int(mode[1]) == int(mode[2]) and mode[3] != ""
                  and mode[4] == "true" and mode[5] == "true" and int(mode[6]) >= 20
                  and mode[7].strip('"') == "Classic" and mode[8].strip('"') == "no zoom",
                  f"tabs={mode[1]} editors={mode[2]} shown={mode[3]} places={mode[4]} "
                  f"tile={mode[5]} strip={mode[6]}px button={mode[7]} zoom={mode[8]}"
                  if mode else classic_detail("mode"))
    tab = classic.get("tab")
    results.check("clicking a tab makes that file the code area",
                  bool(tab) and tab[0] != '""' and tab[1] == "true",
                  f"clicked={tab[0]} moved={tab[1]} selection={tab[2]}" if tab
                  else classic_detail("tab"))
    wheeled = classic.get("wheel")
    results.check("the board's wheel gestures are off once the board is not on screen",
                  bool(wheeled) and wheeled[0] == "true" and wheeled[2] == wheeled[1]
                  and wheeled[4] == wheeled[3],
                  f"frozen={wheeled[0]} stage={wheeled[1]}->{wheeled[2]} "
                  f"zoom={wheeled[3]}->{wheeled[4]}" if wheeled else classic_detail("wheel"))
    back = classic.get("back")
    results.check("`mode board` puts every card back where the document says it was",
                  bool(back) and back[0] == "true" and back[1] == "false",
                  f"restored={back[0]} classic={back[1]}" if back else classic_detail("back"))

    pixel = parse_pixel(body)

    def pixel_detail(key: str) -> str:
        got = pixel.get(key)
        if got is not None:
            return " ".join(got)
        if pixel.get("note") is not None:
            return f"pixel: {pixel['note'][0]}"
        return f"no pixel-{key} line"

    def saved_image(relative: str):
        """The .png one of the pixel cards saved, or ``(None, why)`` if it cannot
        be read -- the reason goes into the check's detail, because a file the
        card says it saved and this half cannot decode is the whole point."""
        path = REPO_ROOT / relative
        try:
            width, height, rows = decode_rgba(path)
        except (OSError, ValueError, zlib.error) as exc:
            size = path.stat().st_size if path.exists() else 0
            return None, f"{type(exc).__name__}: {exc} (exists={path.exists()} size={size})"
        return {"width": width, "height": height, "rows": rows}, ""

    # The pencil: the card's own eyedropper says which pixel it painted, and the
    # file the card saved says the same pixel is opaque in the .png on disk.  The
    # drag is (1,1) to (4,1); which of the pixels between them change is the
    # card's business, but the pixel it was pressed on is not.
    pencil = pixel.get("pencil")
    pencil_image, pencil_why = saved_image(pencil[0]) if pencil else (None, "no pixel-pencil line")
    pencil_ink = ink_of(pencil[1]) if pencil else None
    painted = ([(x, 1) for x in range(1, 5)
                if rgba_at(pencil_image["rows"], x, 1)[3] != 0] if pencil_image else [])
    press_pixel = rgba_at(pencil_image["rows"], 1, 1) if pencil_image else None
    results.check("a pencil stroke reaches the pixels the card saves",
                  pencil_image is not None and pencil_image["width"] == 8
                  and pencil_image["height"] == 8
                  and pencil_ink is not None and pencil_ink[3] == 255
                  and press_pixel is not None and press_pixel[:3] == pencil_ink[:3]
                  and len(painted) >= 1
                  and all(rgba_at(pencil_image["rows"], x, y)[:3] == pencil_ink[:3]
                          for x, y in painted)
                  and ink_of(pencil[2]) == pencil_ink and ink_of(pencil[3]) == (0, 0, 0, 0),
                  f"file={pencil[0]} drew={pencil[1]} press={pencil[2]} far={pencil[3]} "
                  f"painted={[f'{x},{y}' for x, y in painted]} press_pixel={press_pixel} "
                  f"image={pencil_why or 'read'}"
                  if pencil else pixel_detail("pencil"))

    # The eraser: the same pixel the pencil painted reads transparent through the
    # eyedropper and is transparent in the saved file, so it is not the pencil.
    eraser = pixel.get("eraser")
    eraser_image, eraser_why = saved_image(eraser[0]) if eraser else (None, "no pixel-eraser line")
    eraser_before = ink_of(eraser[1]) if eraser else None
    eraser_after = ink_of(eraser[2]) if eraser else None
    cleared = (eraser_image is not None
               and rgba_at(eraser_image["rows"], 1, 1)[3] == 0
               and rgba_at(eraser_image["rows"], 2, 1)[3] == 0)
    results.check("the eraser takes a painted pixel back to transparent",
                  eraser_image is not None and eraser_before is not None
                  and eraser_before[3] == 255 and eraser_after == (0, 0, 0, 0) and cleared,
                  f"file={eraser[0]} before={eraser[1]} after={eraser[2]} clear={cleared} "
                  f"image={eraser_why or 'read'}"
                  if eraser else pixel_detail("eraser"))

    # The fill: one press on a blank 8x8 image, and the whole image is that
    # colour -- through the eyedropper at the press, through the eyedropper in the
    # far corner, and through every pixel of the file the card saved.
    fill = pixel.get("fill")
    fill_image, fill_why = saved_image(fill[0]) if fill else (None, "no pixel-fill line")
    fill_ink = ink_of(fill[1]) if fill else None
    filled_pixels = opaque_count(fill_image["rows"]) if fill_image else 0
    results.check("a fill on an empty image changes more than the pixel under the pointer",
                  fill_image is not None and fill_ink is not None and filled_pixels == 64
                  and all(rgba_at(fill_image["rows"], x, y)[:3] == fill_ink[:3]
                          for x, y in ((0, 0), (7, 7), (3, 5)))
                  and ink_of(fill[2]) == fill_ink and ink_of(fill[3]) == fill_ink,
                  f"file={fill[0]} filled={fill[1]} press={fill[2]} far={fill[3]} "
                  f"opaque={filled_pixels}/64 image={fill_why or 'read'}"
                  if fill else pixel_detail("fill"))

    # Ctrl+Z and Ctrl+Shift+Z over the focused canvas: the card's own ring has to
    # answer first (main.mjs's cardUndoOrRing), and the board -- the document that
    # says which cards exist and where they sit -- must not move while it does.
    undo = pixel.get("undo")
    stroke_ink = ink_of(undo[1]) if undo else None
    undone_ink = ink_of(undo[2]) if undo else None
    results.check("Ctrl+Z over the canvas takes the stroke back and the board does not move",
                  bool(undo) and undo[0] == "true" and stroke_ink is not None
                  and stroke_ink[3] == 255 and undone_ink is not None
                  and undone_ink != stroke_ink and undone_ink == fill_ink
                  and undo[3] == "true" and undo[4] == "true",
                  f"focused={undo[0]} stroke={undo[1]} after={undo[2]} "
                  f"board-document={undo[3]} viewport={undo[4]}"
                  if undo else pixel_detail("undo"))
    redo = pixel.get("redo")
    redone_ink = ink_of(redo[0]) if redo else None
    results.check("Ctrl+Shift+Z puts the stroke back",
                  redone_ink is not None and redone_ink == stroke_ink,
                  f"after={redo[0]}" if redo else pixel_detail("redo"))

    # The D006 row: its button opens a pixel card on the *sprite* the diagnostic
    # named, not on the define JSON that declared it (which is the row's extra),
    # and a card whose file does not exist yet is usable at its declared size.
    d006 = pixel.get("d006")
    sprite_ok = (bool(d006) and int(d006[0]) > 0 and int(d006[1]) > 0
                 and d006[2] == "true" and d006[3] != ""
                 and d006[4] == f"{MOD_NAME}/{d006[3]}"
                 and d006[4] != d006[5] and d006[4].lower().endswith(".png")
                 and d006[5].lower().endswith(".json"))
    results.check("a D006 row opens the pixel card for the sprite it named, not the define JSON",
                  sprite_ok,
                  f"rows={d006[0]} d006={d006[1]} declared={d006[2]} named={d006[3]!r} "
                  f"sprite={d006[4]!r} json={d006[5]!r}"
                  if d006 else pixel_detail("d006"))
    size_ok = (bool(d006) and d006[6] == "96x96" and ink_of(d006[7]) is not None
               and ink_of(d006[7]) == ink_of(d006[8]) and ink_of(d006[9]) == (0, 0, 0, 0))
    results.check("a pixel card on a missing sprite is usable at its declared size",
                  size_ok,
                  f"size={d006[6]} drew={d006[7]} press={d006[8]} far={d006[9]}"
                  if d006 else pixel_detail("d006"))

    # And the cards this half opened are gone again; the sprite card was never
    # saved, so no file was created for it either.
    cards = pixel.get("cards")
    results.check("the pixel cards this run opened are closed again",
                  bool(cards) and int(cards[0]) >= 5 and cards[1] == "0",
                  f"added={cards[0]} left={cards[1]} others={cards[2]}"
                  if cards else pixel_detail("cards"))

    results.check("the board is back as it was found", restored,
                  "byte-identical" if backup.existed else "absent again")
    if not host_gone:
        results.check("the host is gone", False, "still running -- kill it by hand")
    # Every check that reads a .png the pixel cards wrote has had its look; the
    # cards made these files and nothing else this run survives it.
    for png in PIXEL_PNGS:
        png.unlink(missing_ok=True)
    code = results.report(attempts)
    if args.keep and WRAPPER.exists():
        print(f"wrapper kept: {WRAPPER}")
    return code


if __name__ == "__main__":
    sys.exit(main())
