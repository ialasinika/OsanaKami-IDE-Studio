"""input_smoke.py -- drive the real window: the undo keys, who owns a wheel, and
a file that changes while nobody is looking.

The board's *input paths* were the one part of the app that no shipped suite
could reach: ``selftest.mjs`` proves the undo ring (documents, coalescing, the
redo branch) with no DOM at all, and this proves the wiring on top of it.
``--dump-dom`` drives no pointer, no keyboard and no wheel, so those events are
dispatched from a page this test owns.

How, without a web driver or CDP: the shell serves every file under
``shell/web/``, so this test writes one small wrapper page there for the length
of the run, deletes it in a ``finally``, and refuses to start if the name is
already taken.  The wrapper is same-origin with the app it frames, so it can
reach into the iframe and do what a person does:

1. wait for the app to reach "kernel ready";
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
   them, and a card that assigned to ``value`` would fail it.

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
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))

from browser_smoke import (  # noqa: E402  (the import needs the path above)
    BOARD_PATH,
    EDGE_FLAGS,
    REPO_ROOT,
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
    }
  } catch (error) {
    editorOk = false;
    say("editor-error: " + (error && error.message ? error.message : String(error)));
  }

  say("RESULT: " + (ok && wheelOk && watchOk && editorOk
    ? "undo, redo, wheel ownership, a watched file and the editor keys all work in a real browser"
    : "FAILED -- see the counts, the wheel, the watch and the editor lines above"));
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


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        prog="input_smoke.py",
        description=(
            "Boot the real app in the system browser, make a board change, press "
            "Ctrl+Z and Ctrl+Shift+Z, dispatch a wheel over a card's own scroll "
            "region and over the board, watch a file change under an open card, and "
            "drive the editor card's indent, auto-indent, find and replace keys. Exit "
            "codes: 0 pass or skipped, 1 a check failed, 2 could not run, 3 usage."
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
    )
    for key, pattern in patterns:
        match = re.search(pattern, body)
        if match is not None:
            found[key] = match.groups()
    none = re.search(r"editor-(?:none|error):? --? ?(.+)", body)
    if none is not None:
        found["none"] = (none.group(1),)
    return found


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
        print("summary: 0 passed, 0 failed, 19 skipped (no browser)")
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
    host = Host(args.port or free_port())
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

    results.check("the board is back as it was found", restored,
                  "byte-identical" if backup.existed else "absent again")
    if not host_gone:
        results.check("the host is gone", False, "still running -- kill it by hand")
    code = results.report(attempts)
    if args.keep and WRAPPER.exists():
        print(f"wrapper kept: {WRAPPER}")
    return code


if __name__ == "__main__":
    sys.exit(main())
