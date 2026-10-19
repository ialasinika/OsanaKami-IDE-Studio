"""input_smoke.py -- drive the real window: the undo keys, the editor keys, who
owns a wheel, a file that changes while nobody is looking, and the two tiled
views -- classic's sidebar, tab strip and code area, and mod's package view.

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
   opened on: the canvas view is gone, so a window opens on the classic or the
   mod tile, and what the wrapper reports is the HUD switch's own
   ``aria-pressed``, the body's class, and the absence of the canvas's layers
   (its ``#hud-zoom`` readout, its ``#links`` SVG and the stage's transform);
   the window is expected to open on the **mod** tile (``BOOT_VIEW``), with no
   "classic view" line in the message strip;
2. type ``mode classic`` -- the other tile, which this run measures later -- add
   a card with the ``note`` command -- the same line a person would type --
   and then type the ``mode board`` a person might: it has to be refused as an
   unknown view, with a warning in the message strip, and leave the classic tile
   exactly where it was;
3. dispatch ``keydown`` with ``ctrlKey`` for ``z``, then for ``shift+z``;
4. count the card elements in the iframe's DOM after each step;
5. press Ctrl+Z while a text field has the keystroke, and check that the board
   did not move: text undo belongs to the textarea;
6. open a file so that one card has content taller than its own box, then
   dispatch ``wheel`` over that card's scroll region and ask who acted: the
   card's wheel must be left to the card.  The two checks that measured what the
   board's own wheel did next to it -- the pan and the ctrl+wheel zoom -- are
   gone with the viewport they moved: there is no canvas under the tile for
   either gesture to act on.  Nothing forces the issue by looking for a
   scrollable card and giving up: the run *makes* one, through the same ``open``
   command a person would type, so the check either proves the behaviour or
   fails;
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
   every card is exactly where it was -- the tile has no viewport to move; then
   ``mode mod`` and back to ``mode classic``, and check both views render and
   the classic tile comes back on the same pixels;
10. draw on the pixel cards and click the D006 row of the example mod this
   repository ships (``examples/Mods/Lantern``) -- the run passes
   ``--mods-root examples/Mods`` -- so the problems card has something to show
   with no game install;
11. open the story card the run generates: a two-line yarn over a 4.5 MB
   translation table it writes under ``build/``, past the kernel's 4 MiB
   whole-file read, and read back the card's own row count, its status line and
   the translation it paints for the first and the last row of the table.

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
import csv
import hashlib
import json
import os
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

#: The example mod this repository ships, under ``examples/Mods``: the run's
#: PROBLEMS card must show one, and it must be reachable from the host's own
#: ``--mods-root`` with no game install.  ``Lantern`` is a complete small package
#: -- a manifest, a project file, a yarn, two localisation CSVs (the suffix-less
#: base table and the English one), three sprites (two items and the character's
#: portrait), one character define and three attachment defines -- and it carries
#: exactly two findings on purpose: the D006 row the pixel card's click-through
#: opens (an attachment whose sprite file is not on disk) and an M008 warning (the
#: English CSV is a row short of the base).  Its three dialogue lines exercise the
#: translation column as well: one row matches, one row's lock is wrong (stale)
#: and one row is absent.
MODS_ROOT = REPO_ROOT / "examples" / "Mods"
MOD_NAME = "Lantern"

#: A game Mods folder with the structure marker and nothing else.  The problems
#: card this run reads must report the package's findings, so the cross-Mod input
#: is pinned: a machine without the game -- CI included -- otherwise adds M012
#: ("cross-Mod checks skipped") to every report, and this check would pass or fail
#: on whether the developer had installed the game.
GAME_MODS_FIXTURE = REPO_ROOT / "build" / "__input_smoke_game_mods"

#: The example mod ships one 8-bit RGB sprite (colour type 2) beside its RGBA
#: ones: the pixel card reads both shapes but writes colour type 6 back, so the
#: copy this run plants under ``build/`` is what gets saved, and comparing the
#: two headers is how the run records G20 ("saving rewrites the bytes") without
#: writing to the package itself.
RGB_SPRITE_SRC = MODS_ROOT / MOD_NAME / "Sprites" / "Lantern_Rgb.png"
RGB_SPRITE_REL = "build/__input_smoke_rgb.png"
RGB_SPRITE = REPO_ROOT / "build" / "__input_smoke_rgb.png"

#: The line the pixel half writes for the 8-bit RGB sprite it opened, saved and
#: then closed again.
RGB_RES = re.compile(r"pixel-rgb: (\{.*\})")

#: The line the pixel half writes with every row of the PROBLEMS card on it.
PROBLEMS_RES = re.compile(r"problems-rows: (\{.*\})")

#: The story half's own translation table.  It is *generated* here rather than
#: read from the game: this run must not need a game install, and it must still be
#: past the kernel's 4 MiB whole-file read, so the card can only open it by paging
#: a ``file.blob*`` session.  The table is written under ``build/``, which the
#: kernel reaches because its root is this repository.  Its first and last rows
#: are the two lines of the yarn written beside it, so the card paints a
#: translation for both ends of the file -- and the last row sits past the 4 MiB
#: mark, where a read that stopped at the old cap could never have reached it.
STORY_TABLE_REL = "build/__input_smoke_table.csv"
STORY_TABLE = REPO_ROOT / "build" / "__input_smoke_table.csv"
STORY_YARN_REL = "build/__input_smoke_story.yarn"
STORY_YARN = REPO_ROOT / "build" / "__input_smoke_story.yarn"
#: How large the generated table is: comfortably past the whole-file cap below.
STORY_TABLE_BYTES = 4_500_000
#: The whole-file cap the story card's old read ran into, and the frame a blob
#: session moves, both quoted in the check's detail line.
STORY_WHOLE_CAP = 4 * 1024 * 1024
STORY_FRAME = 1024 * 1024
STORY_RES = re.compile(r"story-table: (\{.*\})")


def lock_for(text: str) -> str:
    """The 8 hex the story card's own parser computes for a line's source text.

    ``storycsv.lockOf`` hashes the line's text (speaker and words) and keeps the
    first four bytes, so a generated row that wants to read as "ok" rather than
    "stale" has to carry the lock of the line it translates.
    """
    return hashlib.sha256(text.encode("utf-8")).hexdigest()[:8]


def build_story_table() -> tuple[str, dict]:
    """Write a translation table past the whole-file cap, and say what is in it.

    The table is the localisation of the two-line yarn below: the first and the
    last row carry a *translation* of the yarn's two lines, with the lock of the
    line each translates, so the words the card paints in the translation column
    can only have come from the table.  The dict is computed here, from the
    assembled text, so the check compares the card against this run's own bytes
    rather than against itself.
    """
    header = "language,id,text,file,node,lineNumber,lock,comment"
    head_source = "Lantern: 灯亮着。"
    head_text = "Lantern: 灯还亮着。"
    tail_source = "News: 晚安。"
    tail_text = "News: 晚安，明天见。"

    def row(index: int, text: str, lock: str) -> str:
        return ",".join(("zh-CN", f"line:{index:07x}", text, STORY_YARN_REL,
                         "Table_Smoke", str(index + 2), lock, ""))

    head_id = f"line:{1:07x}"
    lines = [header, row(1, head_text, lock_for(head_source))]
    size = sum(len(line.encode("utf-8")) + 2 for line in lines)
    index = 1
    while size < STORY_TABLE_BYTES:
        index += 1
        text = f"Lantern: 第 {index:05d} 句译文 —— 灯影落在墙上，房间应了一声。" * 3
        lines.append(row(index, text, lock_for(text)))
        size += len(lines[-1].encode("utf-8")) + 2
    index += 1
    lines.append(row(index, tail_text, lock_for(tail_source)))
    text = "\r\n".join(lines) + "\r\n"
    tail_id = f"line:{index:07x}"
    # Where the last row's id sits, in *bytes*: the column is three bytes a
    # character, so a character offset would understate how far into the file the
    # row is and the detail line would quote a number below the cap.
    tail_at = len(text[:text.rfind(tail_id)].encode("utf-8"))
    return text, {
        "bytes": len(text.encode("utf-8")),
        "rows": len(lines) - 1,
        "head_id": head_id,
        "head_source": head_source,
        "head_text": head_text,
        "tail_id": tail_id,
        "tail_source": tail_source,
        "tail_text": tail_text,
        "tail_at": tail_at,
        "crlf": text.count("\r\n"),
    }


def plant_story_table(text: str, real: dict) -> str:
    """Put the generated table where the kernel reaches it, and a story to open it.

    Returns "" on success or the reason it could not be written.
    """
    try:
        STORY_TABLE.write_text(text, encoding="utf-8", newline="")
        STORY_YARN.write_text(
            "title: Table_Smoke\n---\n"
            f"{real['head_source']} #line:{real['head_id'].split(':', 1)[-1]}\n"
            f"{real['tail_source']} #line:{real['tail_id'].split(':', 1)[-1]}\n"
            "===\n",
            encoding="utf-8",
            newline="\n",
        )
    except OSError as exc:
        return f"could not write the table: {exc}"
    return ""

#: Gives the page as much virtual time as it needs for five settled steps plus
#: the wheel half; the real limit is ``--timeout`` on the browser process.
#:
#: Virtual time is not real time: this is the page's own clock, and the run
#: reached 17s of it in 6s of wall clock, so the whole suite fits well inside
#: ``make smoke``'s ``--timeout 90``.  It was 45s, which cut the run off inside
#: the pixel half -- the page stopped between two `say` calls and every later
#: check reported a missing line as if the shell had stayed silent; the run now
#: prints `phase: <name> t=<ms>` lines and says when it was cut off, so the next
#: value is chosen from evidence rather than from a guess.
BUDGET_MS = 150000


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
/* The HUD's view switch: which buttons it offers and which one it says is the
   current view.  `aria-pressed` is what main.mjs sets and what a screen reader
   reads, so it is the product's own report of the mode, and the button's own
   `data-view` is the name views.mjs answers to. */
const hudButtons = () => Array.from(frame.contentDocument.querySelectorAll("#mode-switch [data-view]"));
const hudPressed = (name) => {
  const found = hudButtons().find((node) => node.dataset.view === name);
  return found === undefined ? "" : String(found.getAttribute("aria-pressed"));
};
/* The *name* of the view the HUD says is on: exactly one button carries
   `aria-pressed="true"` and its `data-view` is the name views.mjs answers to.
   `hudPressed` above is the boolean a check about one named button wants, and
   the two are not interchangeable -- reading the attribute where a name is due
   is what made three checks see `hud="true"`. */
const hudView = () => {
  const pressed = hudButtons().filter((node) => node.getAttribute("aria-pressed") === "true");
  return pressed.length === 1 ? pressed[0].dataset.view
    : pressed.map((node) => node.dataset.view).join(",");
};
/* Elapsed virtual milliseconds, from the page's own clock: the run is bounded by
   Edge's `--virtual-time-budget`, so a phase that stops running should be
   obvious rather than looking like a check that merely had no line. */
const t0 = performance.now();
const elapsed = () => Math.round(performance.now() - t0);
/* What the canvas view left behind: its zoom readout, its link layer and the
   stage's own transform.  All three are the canvas's, and none of them may be
   in the document any more. */
const canvasGone = () => {
  const d = frame.contentDocument;
  const stage = d.getElementById("stage");
  return {
    zoom: d.getElementById("hud-zoom") === null,
    links: d.getElementById("links") === null,
    stage: stage === null ? true : !stage.style.transform,
  };
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

  /* The window now opens on the mod tile (item 8, the default view), and every
     step below is about the document rather than a particular view: the card
     `note` adds, the Ctrl+Z ring, the card's own wheel.  What the view itself
     has to answer for is reported first -- the default is a claim the product
     makes and this is the only suite that can see a running window make it, the
     HUD switch has to offer exactly the two tiled views and show the mod one as
     pressed, the canvas's own layers and its zoom readout have to be gone, and
     the boot log must not name the classic view. */
  const bootLog = doc.getElementById("log").textContent || "";
  say("view-default: mod=" + doc.body.classList.contains("is-mod")
    + " classic=" + doc.body.classList.contains("is-classic")
    + " hud-mod=" + hudPressed("mod")
    + " log-classic=" + (bootLog.indexOf("the classic view is showing") !== -1));
  say("view-hud: classic=" + hudPressed("classic") + " mod=" + hudPressed("mod")
    + " buttons=" + hudButtons().length);
  const gone = canvasGone();
  say("canvas-gone: zoom=" + gone.zoom + " links=" + gone.links
    + " stage-transform=" + gone.stage);

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

  /* The steps below measure the classic tile, so move there first: `mode board`
     must leave the tile it refused to leave alone, and the tile itself is
     measured later in this run.  Getting there is itself worth reporting -- a
     window now opens on the mod tile, so `mode classic` is the way in, and this
     proves the switch answers on a real boot instead of the boot class merely
     agreeing with views.mjs. */
  const commandEl = doc.getElementById("command");
  commandEl.value = "mode classic";
  commandEl.dispatchEvent(new win.KeyboardEvent("keydown", { bubbles: true, cancelable: true, key: "Enter" }));
  await waitUntil(() => doc.body.classList.contains("is-classic"), 40, 100);
  say("classic-switch: classic=" + doc.body.classList.contains("is-classic")
    + " mod=" + doc.body.classList.contains("is-mod")
    + " hud-classic=" + hudPressed("classic"));

  /* `mode board` is the view that is gone.  A person who still has it in their
     fingers gets the app's own refusal -- an unknown-view warning in the message
     strip -- and, because a refused switch must not half-switch, the classic
     tile has to be exactly where it was: the body class, the HUD's pressed
     button and the cards. */
  commandEl.value = "mode board";
  commandEl.dispatchEvent(new win.KeyboardEvent("keydown", { bubbles: true, cancelable: true, key: "Enter" }));
  await sleep(500);
  const refused = /unknown view "board"/.test(logEl.textContent || "");
  say("view-board: warned=" + refused + " classic=" + doc.body.classList.contains("is-classic")
    + " mod=" + doc.body.classList.contains("is-mod")
    + " hud-classic=" + hudPressed("classic")
    + "  | log: " + logTail());

  const before = cardCount();
  say("cards at boot: " + before);

  /* One card, through the command a person would type: the double-click that
     used to drop a note here was the canvas's gesture, and the canvas is gone. */
  commandEl.value = "note input smoke undo";
  commandEl.dispatchEvent(new win.KeyboardEvent("keydown", { bubbles: true, cancelable: true, key: "Enter" }));
  await sleep(600);
  const added = cardCount();
  say("cards after a `note` command: " + added + "  | log: " + logTail());

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
  say("phase: boot t=" + elapsed() + "ms");

  /* --- who owns a wheel event ---
     There is no viewport under the tile any more: the pan and the ctrl+wheel
     zoom were the canvas's, and the canvas is gone.  What is left is the card's
     own claim -- a wheel that lands on a card whose box can scroll is the
     card's, and the page must not take it away from the card by calling
     preventDefault.  (Whether a synthetic wheel actually scrolls the box is the
     browser's business and is reported, not asserted.) */
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
      const scrollWas = region.el.scrollTop;
      const overCard = wheel(win, region.el, Object.assign({ deltaY: 120 }, at));
      wheelOk = wheelOk && !overCard.defaultPrevented;
      say("wheel-card: defaultPrevented=" + overCard.defaultPrevented
        + " scrollTop=" + scrollWas + "->" + region.el.scrollTop
        + "  (" + describe(region.el) + ")");
    }
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
    /* How long to wait for the host to run a child process and for the
       filesystem to tell the card about it.  This used to be 60 probes (15 s),
       which a *loaded* machine can miss: the write is a real child process and
       the notification is a real event, and when the box is busy both can be
       seconds late.  The budget is only ever spent when something is wrong --
       every loop leaves as soon as its condition holds. */
    const patience = 120;
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
      for (let i = 0; i < patience; i++) {
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
      for (let i = 0; i < patience; i++) {
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
    await waitUntil(() => editorHolding() !== null, patience, 250);
    const held = editorHolding();
    /* Wait for the read to answer: a card that has been made but has not read
       the file yet holds no revision, which is the one thing this section is
       about. */
    if (held !== null) await waitUntil(() => held.area.value.indexOf("one") === 0, patience, 250);
    say("watch-open: open=" + (held !== null)
      + " text=" + JSON.stringify(held === null ? "" : held.area.value)
      + " status=" + JSON.stringify(statusOf(held)));

    /* A second writer rewrites it.  A clean card takes the bytes. */
    await outside("two");
    await readBack("two");
    const reloaded = await waitUntil(() => statusOf(held).indexOf("reloaded from disk") !== -1, patience, 250);
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
    const warned = await waitUntil(() => statusOf(held).indexOf("changed on disk") !== -1, patience, 250);
    say("watch-warn: warned=" + warned
      + " kept=" + (held !== null && held.area.value === kept)
      + " status=" + JSON.stringify(statusOf(held)));

    /* The file disappears under the card.  Said, not silently written back. */
    await rpc("exec.start", { cmd: 'cmd /c del "' + nativePath + '"', card_id: "" });
    const gone = await vanished();
    const reported = gone !== null
      && await waitUntil(() => statusOf(held).indexOf("gone from disk") !== -1, patience, 250);
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
     no place in the tile is hidden, never moved off screen.  Then the other
     tiled view, `mode mod`, has to render as well, and coming back to classic
     has to put every card exactly where the document says it was: that is what
     makes a view a projection of the document and not a second document. */
  let classicOk = true;
  try {
    if (doc.activeElement && doc.activeElement.blur) doc.activeElement.blur();
    const cardsNow = () => Array.from(doc.querySelectorAll("#cards [data-card-id]"));
    const drawn = (node) => win.getComputedStyle(node).display !== "none";
    const near = (a, b) => Math.abs(a - b) <= 2;
    const strip = () => doc.getElementById("tabs");
    /* One tab container per card the tile draws nowhere else; the id is on the
       container and the name is the inner button (a tab also owns a close
       button, so "the tab" is not "the button" any more). */
    const tabButtons = () => Array.from(strip().querySelectorAll("[data-card-id]"));
    const selectionLine = () => (doc.getElementById("hud-selection").textContent || "").trim();
    const runLine = (text) => {
      const box = doc.getElementById("command");
      box.value = text;
      box.dispatchEvent(new win.KeyboardEvent("keydown", { bubbles: true, cancelable: true, key: "Enter" }));
    };
    /* What a round trip through a view has to preserve: every card's place, size
       and visibility.  The stage, the zoom and the link layer belonged to the
       canvas view that is gone with them, so the pixels that can still move are
       the cards'. */
    const snapshot = () => {
      const parts = [];
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
      const current = switchNode === null ? null
        : switchNode.querySelector('[data-view][aria-pressed="true"]');
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
    const editorTabs = editors.filter((id) => buttons.some((button) => button.dataset.cardId === id)).length;
    say("classic-mode: on=" + isClassic + " tabs=" + buttons.length + " editors=" + editors.length
      + " editors-tabs=" + editorTabs
      + " shown=" + shownCards.map((node) => node.dataset.cardId).join(",")
      + " places=" + places + " tile=" + tile + " strip=" + Math.round(stripRect.height)
      + " button=" + JSON.stringify(modeText) + " hud=" + JSON.stringify(hudView()));
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
      // The name is the button; the container carries the id.
      other.querySelector(".tab-open").click();
      await sleep(200);
      const moved = cardsNow().find((node) => node.dataset.cardId === clickedId);
      const movedRect = moved.getBoundingClientRect();
      const active = strip().querySelector(".tab.is-active");
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

    /* The wheel was the canvas's gesture and there is no canvas under the tile
       now, so what this measures is that nothing smuggled one back in: a
       ctrl+wheel over the code area and a plain wheel over the strip, and not a
       single card may move -- and the HUD must still say which view is on. */
    const placedBefore = snapshot();
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
    const placedAfter = snapshot();
    /* `#hud-zoom` said "no zoom" for the whole life of the tile because a tiled
       view has no viewport; now the element itself is gone, so the claim is that
       it is not in the document -- the same one the boot check makes, re-made
       here where the canvas machinery used to be measured. */
    const goneNow = canvasGone();
    const frozen = placedAfter === placedBefore && hudView() === "classic"
      && goneNow.zoom && goneNow.links;
    say("classic-canvas: zoom=" + goneNow.zoom + " links=" + goneNow.links);
    say("classic-wheel: frozen=" + frozen + " placements=" + cardsNow().length
      + " hud=" + JSON.stringify(hudView()));
    if (!frozen) say("classic-wheel-diff: " + placedBefore + "  ->  " + placedAfter);

    /* The other tiled view, and back: `mode mod` has to switch and paint
       something, and `mode classic` has to bring the same document back on the
       same pixels -- nothing was mounted, unmounted or moved while away.  The
       baseline is taken *here*, after the tab click above moved two cards on
       purpose: `before` predates that click, so comparing against it would fail
       for a reason that has nothing to do with the view. */
    const placedAtSwitch = snapshot();
    runLine("mode mod");
    const inMod = await waitUntil(() => doc.body.classList.contains("is-mod"), 40, 100);
    const modShown = cardsNow().filter(drawn).length;
    const modHud = hudPressed("mod");
    runLine("mode classic");
    const inClassic = await waitUntil(() => doc.body.classList.contains("is-classic"), 40, 100);
    const same = snapshot() === placedAtSwitch;
    const hudBack = hudView() === "classic";
    const back = inMod && inClassic && hudBack && same;
    say("view-switch: mod=" + inMod + " mod-drawn=" + modShown + " mod-hud=" + JSON.stringify(modHud)
      + " classic=" + back + " hud=" + JSON.stringify(hudView())
      + " in-classic=" + inClassic + " same=" + same);
    if (!back) {
      /* Which half failed, and what the browser thinks each card is: a card the
         document still holds but that has no box is a layout bug in the shell,
         not a check that needs loosening. */
      say("view-switch-cards: " + cardsNow().map((node) => {
        const box = node.getBoundingClientRect();
        return (node.dataset.cardId || "?") + ":" + (node.dataset.kind || "?")
          + ":" + win.getComputedStyle(node).display
          + ":" + Math.round(box.width) + "x" + Math.round(box.height)
          + "@" + Math.round(box.left) + "," + Math.round(box.top)
          + ":transform=" + JSON.stringify(node.style.transform || "");
      }).join("  "));
      say("view-switch-diff: " + placedAtSwitch + "  ->  " + snapshot());
    }

    /* Every editor is a tab (the strip serves every card with no place in the
       tile, so it may hold more than the editors), and the classic tile still
       shows no more than the area and the sidebar. */
    const tabIds = buttons.map((button) => button.dataset.cardId);
    classicOk = isClassic && editors.length > 0 && buttons.length >= editors.length
      && editors.every((id) => tabIds.indexOf(id) !== -1)
      && places && tile && tabClick && frozen && back;
    say("phase: classic t=" + elapsed() + "ms");
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
      const canvasLive = canvas !== null && canvas.isConnected;
      /* What the browser says about that canvas right now.  A pixel card has no
         place in a tiled view, and the tile is free to hide a card it has no place
         for (`.card.is-hidden { display: none }`); a hidden element cannot take
         the keyboard, so `focused` is measured and reported, never required.  The
         Ctrl+Z below is dispatched *to the canvas*, so the stroke coming back is
         the proof that the card received the key, painted or not. */
      const canvasBox = canvas === null ? null : canvas.getBoundingClientRect();
      const canvasPainted = canvas !== null && canvas.closest(".is-hidden") === null;
      const activeNow = doc.activeElement;
      const activeWhat = activeNow === null || activeNow === undefined ? "none"
        : (activeNow.tagName || "?") + "." + String(activeNow.className || "");
      const boxText = canvasBox === null ? "none"
        : Math.round(canvasBox.width) + "x" + Math.round(canvasBox.height);
      const placed = geometry();
      key(win, canvas, { key: "z", ctrlKey: true });
      await sleep(250);
      const afterUndo = await inkAt(focused, 7, 7);
      const undoStatus = statusOf(focused);
      const kept = geometry() === placed;
      key(win, canvas, { key: "z", ctrlKey: true, shiftKey: true });
      await sleep(250);
      const afterRedo = await inkAt(focused, 7, 7);
      undoOk = canvasLive && afterStroke === second && afterUndo === filledWith
        && afterUndo !== afterStroke && kept;
      redoOk = afterRedo === second;
      undoLine = "pixel-undo: canvas=" + (canvasLive ? "connected" : "gone")
        + " painted=" + canvasPainted + " box=" + boxText
        + " active=" + JSON.stringify(activeWhat)
        + " stroke=" + JSON.stringify(afterStroke)
        + " after-ctrl+z=" + JSON.stringify(afterUndo) + " board-document=" + kept
        + " status=" + JSON.stringify(undoStatus);
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

    /* 5b. the 8-bit RGB sprite the example package ships.  The pixel card reads
       colour type 2 and the save writes the file back as RGBA -- that is the
       only thing the encoder writes, and it is what this pins.  The *copy* under
       build/ is the file the card opened, so the package's own sprite is never
       the one written; the Python half compares the two headers afterwards. */
    let rgbOk = false;
    let rgbLine = "pixel-rgb: no card";
    try {
      const rgbName = "__input_smoke_rgb";
      runLine("pixel @@SPRITE_RGB@@");
      await waitUntil(() => pixelsNow().some((node) => textOf(node, ".card-label").indexOf(rgbName) >= 0), 60, 250);
      const rgbFound = pixelsNow().find((node) => textOf(node, ".card-label").indexOf(rgbName) >= 0) || null;
      const rgbCard = rgbFound === null ? null : await settle(textOf(rgbFound, ".card-label"));
      if (rgbCard === null) {
        rgbLine = "pixel-rgb: " + JSON.stringify({ opened: false, why: "no card for " + rgbName });
      } else {
        const size = valueOf(rgbCard, '[data-role="pixel-width"]') + "x"
          + valueOf(rgbCard, '[data-role="pixel-height"]');
        const loaded = statusOf(rgbCard);
        const ink = await inkAt(rgbCard, 16, 16);
        const saved = await saveNow(rgbCard);
        const after = await inkAt(rgbCard, 16, 16);
        rgbOk = ink !== "" && ink === after;
        rgbLine = "pixel-rgb: " + JSON.stringify({
          opened: true, size: size, loaded: loaded, ink: ink, after: after, saved: saved,
        });
      }
    } catch (error) {
      rgbLine = "pixel-rgb: " + JSON.stringify({
        opened: false, why: String(error && error.message ? error.message : error),
      });
    }
    say(rgbLine);

    /* 5c. every row of the PROBLEMS card, not just its D006 one: the two findings
       the package carries on purpose, and the audio files it names -- which no
       diagnostic mentions, because nothing checks them.  The count line is the
       card's own words. */
    let refsLine = "problems-rows: no card";
    {
      const host = problemsCard();
      refsLine = host === null
        ? "problems-rows: " + JSON.stringify({ card: false, mod: modName })
        : "problems-rows: " + JSON.stringify({
          card: true,
          counts: textOf(host, ".mod-counts"),
          rows: rowsOf(host).map((item) => ({
            label: textOf(item, ".mod-row-name"),
            meta: textOf(item, ".mod-row-meta"),
          })),
          text: (host.textContent || "").trim(),
        });
    }
    say(refsLine);

    /* 6. and nothing is left behind: the cards this half opened, not the ones the
       workspace came with.  The sprite card was never saved, so no file was
       created for it either. */
    /* `delete` is `app.closeCard`, the one close path, so a card holding text
       that was never saved asks first; this half answers "discard" -- the
       question itself is what browser_smoke.py pins. */
    const discardAsk = async () => {
      const stripNode = doc.querySelector(".ask");
      if (stripNode === null) return;
      const quit = Array.from(stripNode.querySelectorAll(".ask-button"))
        .find((button) => (button.textContent || "").indexOf("不保存") !== -1);
      if (quit !== undefined) quit.click();
      await sleep(320);
    };
    const added = cardsNow().map((node) => node.dataset.cardId)
      .filter((id) => startedWith.indexOf(id) < 0);
    for (const id of added) {
      runLine("delete " + id);
      await sleep(160);
      await discardAsk();
    }
    await sleep(300);
    const left = added.filter((id) => cardsNow().some((node) => node.dataset.cardId === id)).length;
    const others = pixelsNow().map((node) => textOf(node, ".card-label")).sort().join(",");
    say("pixel-cards: added=" + added.length + " left=" + left + " others=" + JSON.stringify(others));
    pixelOk = pencilOk && eraserOk && fillOk && undoOk && redoOk && d006Ok && sizeOk && rgbOk && left === 0;
    say("phase: pixel t=" + elapsed() + "ms");
  } catch (error) {
    pixelOk = false;
    say("pixel-error: " + (error && error.message ? error.message : String(error)));
  }

  /* The story card opens a translation table this run generates under build/:
     4.5 MB, past the kernel's 4 MiB whole-file read, so the card can only have
     opened it by paging a blob session.  What this reads back is the card's own
     row count, the words it paints for the first and the last row of the table,
     and its status line -- a fallback read would leave the status saying "could
     not read" and paint no translation at all. */
  let storyOk = false;
  let storyLine = "story-table: the card never opened";
  try {
    const storyCards = () => Array.from(doc.querySelectorAll("#cards [data-card-id]"));
    const storyText = (node, selector) => {
      const el = node.querySelector(selector);
      return el === null ? "" : (el.textContent || "").trim();
    };
    const storyOf = () => storyCards().find((node) => node.dataset.kind === "story") || null;
    const command = doc.getElementById("command");
    command.value = "story @@STORY_YARN@@ @@STORY_TABLE@@";
    command.dispatchEvent(new win.KeyboardEvent("keydown", { bubbles: true, cancelable: true, key: "Enter" }));
    const opened = await waitUntil(() => {
      const node = storyOf();
      return node !== null && /[0-9]+ rows/.test(storyText(node, '[data-role="story-table"]'));
    }, 300, 100);
    const card = storyOf();
    const table = card === null ? "" : storyText(card, '[data-role="story-table"]');
    const status = card === null ? "" : storyText(card, '[data-role="card-status"]');
    const cells = card === null ? [] : Array.from(card.querySelectorAll('[data-role="story-translation"]'))
      .map((cell) => (cell.textContent || "").trim());
    const counted = table.match(/([0-9]+) rows/);
    storyLine = "story-table: " + JSON.stringify({
      opened: opened,
      rows: counted === null ? 0 : Number(counted[1]),
      table: table,
      status: status,
      cells: cells,
    });
    storyOk = opened && status.indexOf("could not read") < 0 && cells.length >= 2;
  } catch (error) {
    storyOk = false;
    storyLine = "story-error: " + (error && error.message ? error.message : String(error));
  }
  say(storyLine);
  say("phase: story t=" + elapsed() + "ms");

  say("RESULT: " + (ok && wheelOk && watchOk && editorOk && classicOk && pixelOk && storyOk
    ? "undo, redo, who owns a wheel, a watched file, the editor keys, the view switch, the classic tile, the pixel cards and the story table all work in a real browser"
    : "FAILED -- see the counts, the wheel, the watch, the editor, the classic, the pixel and the story lines above")
    + " [" + elapsed() + "ms of virtual time]");
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
#: ...and the 8-bit RGB sprite the pixel half opens and saves; the copy the card
#: writes to is planted under build/ from the package's own sprite before the run.
PAGE = PAGE.replace("@@SPRITE_RGB@@", RGB_SPRITE_REL)
#: ...and the story the story half opens, with the 4.5 MB table it names.
PAGE = PAGE.replace("@@STORY_YARN@@", STORY_YARN_REL)
PAGE = PAGE.replace("@@STORY_TABLE@@", STORY_TABLE_REL)


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        prog="input_smoke.py",
        description=(
            "Boot the real app in the system browser, add a card with `note`, press "
            "Ctrl+Z and Ctrl+Shift+Z, dispatch a wheel over a card's own scroll "
            "region, watch a file change under an open card, drive the editor "
            "card's indent, auto-indent, find and replace keys, and check the view "
            "switch: `mode board` is refused as an unknown view, the canvas's "
            "layers and its zoom readout are gone, and classic and mod both tile "
            "the same document. Exit codes: 0 pass or skipped, 1 a check failed, "
            "2 could not run, 3 usage."
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

#: Each wheel line the wrapper writes, as ``name -> pattern``.  There is one
#: line now: the pan and the ctrl+wheel zoom were the canvas view's, and the
#: canvas view is gone, so nothing dispatches those two any more.
WHEEL_RES = (
    ("card", re.compile(r"wheel-card: defaultPrevented=(\w+) scrollTop=(-?\d+)->(-?\d+)(?:  \((.+)\))?")),
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
    """The classic-view lines the wrapper wrote, as tuples of strings."""
    found = {}
    patterns = (
        ("mode", r'classic-mode: on=(\w+) tabs=(\d+) editors=(\d+) editors-tabs=(\d+)'
                 r' shown=(\S*) places=(\w+) tile=(\w+) strip=(\d+) button=("[^"]*")'
                 r' hud=("[^"]*")'),
        ("canvas", r"classic-canvas: zoom=(\w+) links=(\w+)"),
        ("tab", r'classic-tab: clicked=("[^"]*") moved=(\w+) selection=("[^"]*")'),
        ("wheel", r'classic-wheel: frozen=(\w+) placements=(\d+) hud=("[^"]*")'),
        ("switch", r'view-switch: mod=(\w+) mod-drawn=(\d+) mod-hud=("[^"]*")'
                   r' classic=(\w+) hud=("[^"]*") in-classic=(\w+) same=(\w+)'),
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
    ("undo", r'pixel-undo: canvas=(\w+) painted=(\w+) box=([0-9x]+)'
             r' active=("[^"]*") stroke="([^"]*)" after-ctrl\+z="([^"]*)"'
             r' board-document=(\w+)'),
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
    # throwaway failure; the detail of a check whose line is missing quotes it
    # first, because it is the reason the later lines were never written.
    none = re.search(r"pixel-error: (.+)", body)
    if none is not None:
        found.setdefault("error", (none.group(1),))
    return found


def parse_story(body: str) -> dict:
    """The story half's JSON line: the card's row count, status and cells.

    Empty when the line is missing -- the check that uses it says so rather than
    pretending the card never had a table to read.
    """
    found = STORY_RES.search(body)
    if found is None:
        return {}
    try:
        report = json.loads(found.group(1))
    except ValueError:
        return {}
    return report if isinstance(report, dict) else {}


def decode_rgba(path: Path):
    """``(width, height, rows)`` for a .png, rows as raw RGBA bytes.

    The pixel card writes 8-bit RGBA colour type 6, non-interlaced, one IDAT and
    no ancillary chunks, so unfiltering a few scanlines of ``zlib.decompress`` is
    the whole decoder -- and the check then reads the file the card really wrote
    rather than what the card says about it.  Colour type 2 -- the 8-bit RGB the
    example package also ships -- is read too, with ``0xff`` standing in for the
    alpha it does not carry, so the same decoder can compare the two files pixel
    for pixel.  All five filter types are honoured in case the encoder grows a
    better one.
    """
    raw = path.read_bytes()
    if raw[:8] != b"\x89PNG\r\n\x1a\n":
        raise ValueError(f"{path.name} does not start with a png signature")
    width = height = None
    channels = None
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
            channels = {2: 3, 6: 4}.get(body[9])
            if body[8] != 8 or channels is None:
                raise ValueError(f"{path.name}: bit depth {body[8]}, colour type {body[9]}, "
                                 f"want 8/6 (RGBA) or 8/2 (RGB)")
        elif kind == b"IDAT":
            packed += body
        elif kind == b"IEND":
            break
    if width is None or height is None or channels is None:
        raise ValueError(f"{path.name}: no IHDR")
    data = zlib.decompress(bytes(packed))
    stride = width * channels
    rows = []
    previous = bytearray(stride)
    at = 0
    for _ in range(height):
        kind = data[at]
        line = bytearray(data[at + 1:at + 1 + stride])
        at += 1 + stride
        for i in range(stride):
            left = line[i - channels] if i >= channels else 0
            up = previous[i]
            corner = previous[i - channels] if i >= channels else 0
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
        if channels == 3:
            rows.append(b"".join(bytes(line[i:i + 3]) + b"\xff"
                                 for i in range(0, len(line), 3)))
        else:
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


def png_header(path: Path):
    """``(width, height, bit depth, colour type)`` of a .png, or four zeroes.

    The header is the only place a png records the shape of its pixels: colour
    type 2 is 8-bit RGB, 6 is 8-bit RGBA.  The pixel card reads both and writes
    the second (``docs/EDITOR_GAPS.md`` G20), which is what the check that calls
    this compares across the package's file and the copy the card saved.
    """
    try:
        raw = path.read_bytes()
    except OSError:
        return (0, 0, 0, 0)
    if len(raw) < 26 or raw[:8] != b"\x89PNG\r\n\x1a\n" or raw[12:16] != b"IHDR":
        return (0, 0, 0, 0)
    return (int.from_bytes(raw[16:20], "big"), int.from_bytes(raw[20:24], "big"),
            raw[24], raw[25])


def parse_rgb(body: str) -> dict:
    """The pixel half's line about the 8-bit RGB sprite: what the card opened."""
    found = RGB_RES.search(body)
    if found is None:
        return {}
    try:
        report = json.loads(found.group(1))
    except ValueError:
        return {}
    return report if isinstance(report, dict) else {}


def parse_problems(body: str) -> dict:
    """The PROBLEMS card's own count line, rows and text, as the page read them."""
    found = PROBLEMS_RES.search(body)
    if found is None:
        return {}
    try:
        report = json.loads(found.group(1))
    except ValueError:
        return {}
    return report if isinstance(report, dict) else {}


def csv_rows(path: Path) -> list:
    """A localisation CSV as dicts, ``[]`` when it cannot be read.

    The columns are ``language,id,text,file,node,lineNumber,lock,comment``: the
    id is ``line:<7 hex>`` and the lock is the one the row was generated against,
    so a row whose lock no longer matches the story is stale by construction.
    """
    try:
        text = path.read_text(encoding="utf-8")
    except OSError:
        return []
    return list(csv.DictReader(text.splitlines()))


#: Ask ``shell/mods`` what it makes of the example story, in a fresh node
#: process: the module the host runs, so the Yarn card's diagnostics box and the
#: check below cannot disagree.  Inline so a fresh checkout needs nothing from
#: ``build/``.  The root arrives as the last argv entry (``-e`` has no script
#: name, so ``process.argv[1]`` is the first argument and the last one is the
#: directory).
YARN_DIAG_JS = """
import { createRequire } from "node:module";
import { readFileSync } from "node:fs";
import path from "node:path";
const require = createRequire(path.join(process.cwd(), "tools", "input_smoke.py"));
const { createMods } = require(path.join(process.cwd(), "shell", "mods", "index.js"));
const root = process.argv[process.argv.length - 1];
const text = readFileSync(path.join(root, "Yarn", "Lantern.yarn"), "utf8");
const report = createMods({}).diagnoseYarn({ text: text, fileName: "Yarn/Lantern.yarn", root: root });
console.log(JSON.stringify((report.diagnostics || []).map((d) => ({
  code: d.code, severity: d.severity, line: d.line, message: d.messageEn || d.message,
}))));
"""


def yarn_diagnostics(root: Path):
    """What ``diagnoseYarn`` reports for the example story, or ``None``.

    ``None`` means node could not run the module at all; the check says that
    rather than reporting a silence it did not observe.
    """
    try:
        done = subprocess.run(["node", "--input-type=module", "-e", YARN_DIAG_JS, str(root)],
                              cwd=str(REPO_ROOT), capture_output=True, text=True,
                              encoding="utf-8", errors="replace", timeout=120)
    except (OSError, subprocess.TimeoutExpired):
        return None
    if done.returncode != 0:
        return None
    #  The module prints one JSON array; anything else on stdout (a warning
    #  from node itself) is skipped, and the last parsable line wins.
    for line in reversed((done.stdout or "").splitlines()):
        line = line.strip()
        if line[:1] not in ("[", "{"):
            continue
        try:
            found = json.loads(line)
        except ValueError:
            continue
        return found if isinstance(found, list) else None
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
        print("summary: 0 passed, 0 failed, 38 skipped (no browser)")
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
    # The story half opens a translation table this run generates: 4.5 MB, past
    # the kernel's 4 MiB whole-file read, so the card can only open it by paging a
    # blob session.  It is written under build/ -- reachable because the kernel's
    # root is this repository -- together with the two-line story that names the
    # table's first and last row.  Both files go away in the finally below.
    story_text, real = build_story_table()
    story_fixture = plant_story_table(story_text, real)
    # The pixel half opens the example's 8-bit RGB sprite and saves it: the copy
    # planted here is the file that gets written, so the package's own sprite is
    # never touched -- the check afterwards compares the two headers, and the
    # copy is taken away with the pixel half's other .png files.
    rgb_fixture = ""
    if RGB_SPRITE_SRC.is_file():
        try:
            RGB_SPRITE.parent.mkdir(parents=True, exist_ok=True)
            shutil.copyfile(RGB_SPRITE_SRC, RGB_SPRITE)
        except OSError as exc:
            rgb_fixture = f"could not copy {RGB_SPRITE_SRC} to {RGB_SPRITE}: {exc}"
    else:
        rgb_fixture = f"{RGB_SPRITE_SRC} is missing"
    WRAPPER.write_text(PAGE, encoding="utf-8", newline="\n")
    # ``serve`` resolves every ``mod.*`` root under ``--mods-root``, which
    # defaults to the workspace; the mod the pixel check opens is the example this
    # repository ships, so the host is browser_smoke's default command plus that
    # one flag.  Without it the problems card would answer from the workspace,
    # which holds no mod, and there would be no D006 row to click.
    # Pin the cross-Mod input (GAME_MODS_FIXTURE): the host inherits this
    # environment, and an empty readable folder contributes no baseline.
    (GAME_MODS_FIXTURE / "SODefines" / "Schema").mkdir(parents=True, exist_ok=True)
    os.environ["INFANTGOD_MODS_DIR"] = str(GAME_MODS_FIXTURE)
    port = args.port or free_port()
    host_argv = None
    if MODS_ROOT.is_dir():
        host_argv = ["node", str(SHELL_MAIN), "serve", "--workspace", str(REPO_ROOT),
                     "--mods-root", str(MODS_ROOT),
                     # A throwaway user directory, so the preferences a settings
                     # card writes on a developer machine cannot decide which
                     # view this run's cold boot lands on.
                     "--user-dir", str(profile),
                     "--port", str(port), "--no-open"]
    host = Host(port, host_argv)
    results = Results()
    attempts = 0
    body = ""
    #: True when the page wrote lines but never reached its own RESULT line: the
    #: run was cut off by Edge's virtual clock, not by a check going silent.
    cut_off = False
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
            # The page's clock is Edge's `--virtual-time-budget`: a long run can
            # be cut off between two `say` calls, and then every later check would
            # report "no ... line" as if the shell had stayed silent.  Say what
            # really happened, once, before the checks are read.
            cut_off = "RESULT:" not in body
            if cut_off:
                last = body.strip().splitlines()[-1] if body.strip() else "(nothing)"
                print(f"[FAIL] the page was cut off before its RESULT line after "
                      f"{BUDGET_MS / 1000:g}s of virtual time -- the last line it wrote was "
                      f"{last[:140]!r}; raise BUDGET_MS or make the run shorter")
    except (DriverError, OSError, subprocess.TimeoutExpired) as exc:
        print(f"[FAIL] the run did not finish: {exc}")
    finally:
        if not args.keep:
            WRAPPER.unlink(missing_ok=True)
        # The watch half writes this with a real child process; take it away
        # whether or not the checks got that far.
        SCRATCH.unlink(missing_ok=True)
        # The table the story half opens is one this run generated under build/,
        # with the two-line story that names its first and last row; both go away
        # together, and nothing outside the repository was ever touched.
        STORY_YARN.unlink(missing_ok=True)
        STORY_TABLE.unlink(missing_ok=True)
        # The pixel half's cards create their .png on the first save and the
        # checks below decode them, so those files outlive this block and are
        # taken away after the last check.
        alive = host.proc is not None and host.proc.poll() is None
        if alive:
            terminate(host.proc)
        shutil.rmtree(profile, ignore_errors=True)
        shutil.rmtree(GAME_MODS_FIXTURE, ignore_errors=True)
        restored = backup.restore()
        backup.discard()
        host_gone = not (host.proc is not None and host.proc.poll() is None)

    counts = parse_counts(body)
    wheel = parse_wheel(body)
    booted = "kernel ready: true" in body
    results.check("the app boots in an iframe and reaches kernel ready", booted)
    opened = re.search(r"view-default: mod=(\w+) classic=(\w+) hud-mod=(\w+) log-classic=(\w+)", body)
    hud = re.search(r"view-hud: classic=(\w+) mod=(\w+) buttons=(\d+)", body)
    canvas = re.search(r"canvas-gone: zoom=(\w+) links=(\w+) stage-transform=(\w+)", body)
    switched = re.search(r"classic-switch: classic=(\w+) mod=(\w+) hud-classic=(\w+)", body)
    to_board = re.search(r"view-board: warned=(\w+) classic=(\w+) mod=(\w+) hud-classic=(\w*)", body)
    folded = re.search(r'log-boot: hidden=(\w+) open=(\w+) shut=(\w+) button="([^"]*)"', body)
    results.check("a window opens on the mod tile with the message strip folded away",
                  opened is not None and opened.group(1) == "true"
                  and opened.group(2) == "false" and opened.group(3) == "true"
                  and opened.group(4) == "false"
                  and folded is not None and folded.group(1) == "true"
                  and folded.group(2) == "true" and folded.group(3) == "true",
                  f"at boot mod={opened.group(1) if opened else '?'} "
                  f"classic={opened.group(2) if opened else '?'} "
                  f"hud-mod={opened.group(3) if opened else '?'} "
                  f"log-classic={opened.group(4) if opened else '?'}; "
                  f"strip hidden={folded.group(1) if folded else '?'} "
                  f"open={folded.group(2) if folded else '?'} "
                  f"shut={folded.group(3) if folded else '?'} "
                  f"button={folded.group(4) if folded else '?'}")
    results.check("the HUD offers exactly the classic and mod views",
                  hud is not None and hud.group(1) == "false" and hud.group(2) == "true"
                  and hud.group(3) == "2",
                  f"buttons={hud.group(3) if hud else '?'} "
                  f"classic-pressed={hud.group(1) if hud else '?'} "
                  f"mod-pressed={hud.group(2) if hud else '?'}")
    results.check("`mode classic` moves the window off the mod tile",
                  switched is not None and switched.group(1) == "true"
                  and switched.group(2) == "false" and switched.group(3) == "true",
                  f'classic={switched.group(1) if switched else "?"} '
                  f'mod={switched.group(2) if switched else "?"} '
                  f'hud-classic={switched.group(3) if switched else "?"}')
    results.check("the HUD has no zoom readout",
                  canvas is not None and canvas.group(1) == "true",
                  f"#hud-zoom gone={canvas.group(1) if canvas else '?'}")
    results.check("the canvas layers are not painted",
                  canvas is not None and canvas.group(2) == "true" and canvas.group(3) == "true",
                  f"#links gone={canvas.group(2) if canvas else '?'} "
                  f"#stage transform empty={canvas.group(3) if canvas else '?'}")
    results.check('`mode board` is refused as an unknown view and leaves the classic tile alone',
                  to_board is not None and to_board.group(1) == "true"
                  and to_board.group(2) == "true" and to_board.group(3) == "false"
                  and to_board.group(4) == "true",
                  f'warned={to_board.group(1) if to_board else "?"} '
                  f'classic={to_board.group(2) if to_board else "?"} '
                  f'mod={to_board.group(3) if to_board else "?"} '
                  f'hud-classic={to_board.group(4) if to_board else "?"}')
    results.check("a `note` command adds a card",
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
        where = f"  ({card_wheel[3]})" if card_wheel[3] else ""
        results.check("a wheel over a card's own scroll region is left to the card",
                      card_wheel[0] == "false",
                      f"defaultPrevented={card_wheel[0]} scrollTop="
                      f"{card_wheel[1]}->{card_wheel[2]}{where} -- the card keeps the wheel")

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
        if cut_off:
            return f"the page stopped before classic-{key} (virtual-time budget {BUDGET_MS}ms)"
        return f"no classic-{key} line"

    mode = classic.get("mode")
    results.check("`mode classic` tiles the same cards into a sidebar, a tab strip and a code area",
                  bool(mode) and mode[0] == "true" and int(mode[2]) >= 1
                  and int(mode[1]) >= int(mode[2]) and int(mode[3]) == int(mode[2])
                  and mode[4] != "" and mode[5] == "true" and mode[6] == "true"
                  and int(mode[7]) >= 20
                  and mode[8].strip('"') == "Classic" and mode[9].strip('"') == "classic",
                  f"tabs={mode[1]} editors={mode[2]} editors-in-tabs={mode[3]} shown={mode[4]} "
                  f"places={mode[5]} tile={mode[6]} strip={mode[7]}px button={mode[8]} hud={mode[9]}"
                  if mode else classic_detail("mode"))
    tab = classic.get("tab")
    results.check("clicking a tab makes that file the code area",
                  bool(tab) and tab[0] != '""' and tab[1] == "true",
                  f"clicked={tab[0]} moved={tab[1]} selection={tab[2]}" if tab
                  else classic_detail("tab"))
    tile_canvas = classic.get("canvas")
    results.check("the tile has no zoom readout and no link layer of its own",
                  bool(tile_canvas) and tile_canvas[0] == "true" and tile_canvas[1] == "true",
                  f"#hud-zoom gone={tile_canvas[0]} #links gone={tile_canvas[1]}"
                  if tile_canvas else classic_detail("canvas"))
    wheeled = classic.get("wheel")
    results.check("a wheel over the tile leaves every card exactly where it was",
                  bool(wheeled) and wheeled[0] == "true" and int(wheeled[1]) >= 1
                  and wheeled[2].strip('"') == "classic",
                  f"frozen={wheeled[0]} placements={wheeled[1]} hud={wheeled[2]}"
                  if wheeled else classic_detail("wheel"))
    switched = classic.get("switch")
    results.check("`mode mod` and `mode classic` both render, and classic comes back on the same pixels",
                  bool(switched) and switched[3] == "true"
                  and switched[0] == "true" and int(switched[1]) >= 1
                  and switched[2].strip('"') == "true" and switched[4].strip('"') == "classic"
                  and switched[5] == "true" and switched[6] == "true",
                  f"mod={switched[0]} mod-drawn={switched[1]} mod-hud={switched[2]} "
                  f"classic={switched[3]} hud={switched[4]} in-classic={switched[5]} same={switched[6]}"
                  if switched else classic_detail("switch"))

    pixel = parse_pixel(body)

    def pixel_detail(key: str) -> str:
        got = pixel.get(key)
        if got is not None:
            return " ".join(got)
        if pixel.get("error") is not None:
            return f"pixel half died: {pixel['error'][0]}"
        if cut_off:
            return f"the page stopped before pixel-{key} (virtual-time budget {BUDGET_MS}ms)"
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

    # Ctrl+Z and Ctrl+Shift+Z, sent to the canvas the card drew on: the card's own
    # ring has to answer first (main.mjs's cardUndoOrRing), and no card may move
    # while it does -- the undo belongs to the picture, not to the document the
    # view is telling apart.  The viewport this once compared is gone with the
    # canvas view, and so is the keyboard focus it once required: a pixel card has
    # no place in a tiled view, so the tile may hide it (and a hidden element
    # cannot be focused), while the key reaches the canvas either way.
    undo = pixel.get("undo")
    stroke_ink = ink_of(undo[4]) if undo else None
    undone_ink = ink_of(undo[5]) if undo else None
    results.check("Ctrl+Z over the pixel canvas takes the stroke back and no card moves",
                  bool(undo) and undo[0] == "connected" and stroke_ink is not None
                  and stroke_ink[3] == 255 and undone_ink is not None
                  and undone_ink != stroke_ink and undone_ink == fill_ink
                  and undo[6] == "true",
                  f"canvas={undo[0]} painted={undo[1]} box={undo[2]} active={undo[3]} "
                  f"stroke={undo[4]} after={undo[5]} board-document={undo[6]}"
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

    # The story card opens a translation table this run generates: 4.5 MB, past
    # the kernel's 4 MiB whole-file read, so the card can only have assembled it
    # by paging a blob session.  The card's own row count is compared with the
    # count computed here from the text the run wrote, and the words it painted
    # for the first and the last row -- the last row sits past the 4 MiB mark,
    # which a read that stopped at the old cap could not have reached.  A
    # fallback read leaves "could not read" in the status line and no translation
    # cell at all.  The expected count is quoted in the detail line either way.
    story = parse_story(body)
    story_cells = story.get("cells") or []
    story_ok = (not story_fixture
                and story.get("rows") == real.get("rows")
                and story_cells[:2] == [real.get("head_text"), real.get("tail_text")]
                and "could not read" not in str(story.get("status", ""))
                and real.get("bytes", 0) > STORY_WHOLE_CAP
                and real.get("tail_at", 0) > STORY_WHOLE_CAP)
    if story_fixture:
        story_detail = story_fixture
    else:
        story_detail = (f"{STORY_TABLE_REL}: {real.get('bytes')} bytes, {real.get('rows')} rows, "
                        f"the last of them at byte {real.get('tail_at')} (computed here); card rows="
                        f"{story.get('rows')} table={story.get('table')!r} status={story.get('status')!r} "
                        f"cells={story_cells!r}")
    results.check("the story card reads the 4.5 MB table this run generates whole, through a blob session",
                  story_ok, story_detail)

    # The two properties that make the paragraph above true and keep this suite
    # runnable on a machine without the game: the mods root is the repository's
    # own example package (the game's ``MyMod``/``SODefines`` are not under it),
    # and the 4.5 MB table was written by ``build_story_table()`` during this run,
    # under ``build/``, rather than read from the game's ``NewProject_RU.csv``.
    example = MODS_ROOT / MOD_NAME
    # A label that cannot raise: this check's whole point is that the mods root
    # may be the *wrong* one, and a detail line that only formatted when the root
    # was already right would crash the run instead of reporting the FAIL.
    try:
        mods_label = str(MODS_ROOT.relative_to(REPO_ROOT)).replace("\\", "/")
    except ValueError:
        mods_label = str(MODS_ROOT)
    example_ok = (MODS_ROOT == REPO_ROOT / "examples" / "Mods"
                  and not (MODS_ROOT / "MyMod").exists()
                  and not (MODS_ROOT / "SODefines").exists()
                  and (example / "mod.json").is_file()
                  and (example / "Yarn" / "Lantern.yarn").is_file()
                  and (example / "Yarn" / "Lantern.csv").is_file()
                  and (example / "Yarn" / "Lantern_en.csv").is_file()
                  and (example / "Sprites" / "Warden.png").is_file()
                  and (example / "Defines" / "Character" / "Warden.json").is_file()
                  and not (example / "Sprites" / "Missing.png").exists()
                  and str(STORY_TABLE).startswith(str(REPO_ROOT / "build"))
                  and real.get("bytes", 0) > STORY_WHOLE_CAP
                  and real.get("crlf") == real.get("rows", 0) + 1)
    results.check("the run drives the repository's own example mod and generates its own big table",
                  example_ok,
                  f"mods-root={mods_label} mod={MOD_NAME} "
                  f"table={STORY_TABLE_REL} {real.get('bytes')} bytes {real.get('rows')} rows "
                  f"crlf={real.get('crlf')} whole-file-cap={STORY_WHOLE_CAP} (no game install)")

    # The example's other sprite shape: 8-bit RGB, opened by the pixel card and
    # saved.  The card reads colour type 2 and writes colour type 6 back, so the
    # copy under build/ comes out RGBA -- G20's "saving an RGB sprite rewrites its
    # bytes", still open, is pinned here rather than described.  The package's own
    # sprite is not the file that was written, and the pixel the card read is
    # compared with the pixel in both files, so what this asserts is about bytes.
    rgb_line = parse_rgb(body)
    rgb_shipped = png_header(RGB_SPRITE_SRC)
    rgb_saved = png_header(RGB_SPRITE)
    rgb_ink = ink_of(str(rgb_line.get("ink", "")))
    rgb_status = str(rgb_line.get("loaded", ""))
    rgb_pixels = None
    if not rgb_fixture:
        try:
            rgb_pixels = (rgba_at(decode_rgba(RGB_SPRITE_SRC)[2], 16, 16),
                          rgba_at(decode_rgba(RGB_SPRITE)[2], 16, 16))
        except (OSError, ValueError, IndexError):
            rgb_pixels = None
    rgb_ok = (not rgb_fixture
              and bool(rgb_line) and rgb_line.get("opened") is True
              and re.search(r"32\s*[x×]\s*32", rgb_status) is not None
              and str(rgb_line.get("saved", "")) not in ("", "not saving", "nothing to save")
              and rgb_ink is not None and rgb_line.get("ink") == rgb_line.get("after")
              and rgb_shipped == (32, 32, 8, 2) and rgb_saved == (32, 32, 8, 6)
              and rgb_pixels is not None and rgb_pixels[0] == rgb_pixels[1]
              and rgb_pixels[0] == rgb_ink)
    if rgb_fixture:
        rgb_detail = rgb_fixture
    else:
        rgb_detail = (f"shipped={RGB_SPRITE_SRC.name} {rgb_shipped} saved-copy={RGB_SPRITE_REL} "
                      f"{rgb_saved} pixel(16,16) source={rgb_pixels[0] if rgb_pixels else None} "
                      f"saved={rgb_pixels[1] if rgb_pixels else None} card-ink={rgb_line.get('ink')!r} "
                      f"card-loaded={rgb_status!r} saved-status={rgb_line.get('saved')!r}")
    results.check("the pixel card reads the example's 8-bit RGB sprite and saves it back as RGBA",
                  rgb_ok, rgb_detail)

    # The example story's tag surface, and what the tools make of it.  `#state:`
    # is judged -- against the *game's* sixteen states, so the package's own
    # CharacterState name is not one of them and the tool warns -- while `#vo:`,
    # `#Check:`, `#Topic:` and `#Modify:` are not judged at all.  Both facts come
    # from ``shell/mods`` itself, asked in a fresh node process, and the two
    # defects the translation table carries on purpose (one en row missing, one
    # lock zeroed) have to still be exactly those two.
    try:
        yarn_text = (example / "Yarn" / "Lantern.yarn").read_text(encoding="utf-8")
    except OSError:
        yarn_text = ""
    base_rows = csv_rows(example / "Yarn" / "Lantern.csv")
    en_rows = csv_rows(example / "Yarn" / "Lantern_en.csv")
    base_ids = [row.get("id", "") for row in base_rows]
    en_ids = [row.get("id", "") for row in en_rows]
    base_locks = {row.get("id", ""): (row.get("lock") or "").lower() for row in base_rows}
    en_locks = {row.get("id", ""): (row.get("lock") or "").lower() for row in en_rows}
    stale_id = "line:5d6e7f8"    # the en row whose lock is 00000000 on purpose
    missing_id = "line:9c0d1e2"  # the en row that is deliberately not there
    story_tags = ("#state:", "#vo:", "#Check:", "#Topic:", "#Modify:")
    tag_hits = [tag for tag in story_tags if tag in yarn_text]
    line_ids = re.findall(r"#line:([0-9a-f]{7})", yarn_text)
    known_keys = None
    try:
        index_js = (REPO_ROOT / "shell" / "mods" / "index.js").read_text(encoding="utf-8")
    except OSError:
        index_js = ""
    keys_match = re.search(r"KNOWN_META_KEYS\s*=\s*\[([^\]]*)\]", index_js)
    if keys_match is not None:
        known_keys = re.findall(r"[\"']([^\"']+)[\"']", keys_match.group(1))
    yarn_report = yarn_diagnostics(example)
    yarn_codes = [(item.get("code"), int(item.get("line") or 0), str(item.get("message", "")))
                  for item in (yarn_report or [])]
    state_warn = [item for item in yarn_codes if item[0] == "Y104" and "#state:" in item[2]]
    unjudged = [item for item in yarn_codes
                if any(tag in item[2] for tag in ("#vo:", "#Check:", "#Topic:", "#Modify:"))]
    tags_ok = (tag_hits == list(story_tags)
               and len(line_ids) == 5 and len(set(line_ids)) == 5
               and base_ids == ["line:" + value for value in line_ids]
               and en_ids == [value for value in base_ids if value != missing_id]
               and en_locks.get(stale_id) == "00000000"
               and all(en_locks.get(value) == base_locks.get(value)
                       for value in base_ids if value not in (stale_id, missing_id))
               and known_keys == ["line", "state", "vo"]
               and yarn_report is not None and len(yarn_codes) == 1
               and len(state_warn) == 1 and not unjudged)
    tags_detail = (f"tags={tag_hits!r} line-ids={line_ids!r} base={len(base_rows)} rows "
                   f"en={len(en_rows)} rows missing={missing_id not in en_locks} "
                   f"stale-lock={en_locks.get(stale_id)!r} KNOWN_META_KEYS={known_keys!r} "
                   f"diagnostics={yarn_codes!r}")
    results.check("the example story carries the whole tag surface, and the tools judge one of the four extra tags",
                  tags_ok, tags_detail)

    # What the package's own PROBLEMS card says: the findings the example carries
    # on purpose, and no D005 -- every cross-reference in the package resolves.
    # The shipped example exercises the type set (a Song and a
    # VoiceOverDefinition the game only partly consumes, M013/M014), a spine JSON
    # with no atlas beside it (D011), two 8 kHz WAVs (D008), a sprite it names
    # that is not there (D006) and the second language's row count (M008).  The
    # two WAV files are named by nobody on the card: nothing in the IDE checks an
    # audio file (G21), and this records that rather than implying otherwise.
    refs = parse_problems(body)
    ref_labels = [str(row.get("label", "")) for row in (refs.get("rows") or [])]
    ref_codes = sorted(label.split(" ")[0] for label in ref_labels if label)
    ref_text = str(refs.get("text", ""))
    audio = [example / "Audio" / "Lantern_Hum.wav", example / "Audio" / "Lantern_Voice.wav"]
    defines = [example / "Defines" / kind / name for kind, name in (
        ("Character", "Warden.json"), ("CharacterState", "Calm.json"),
        ("PixelAnimation", "Lantern_Idle.json"), ("AudioEvent", "Audio_Lantern_Hum.json"),
        ("Song", "Song_Lantern.json"), ("VoiceOverDefinition", "Vo_Lantern.json"))]
    counts = str(refs.get("counts", ""))
    refs_ok = (bool(refs) and refs.get("card") is True
               and ref_codes == ["D006", "D008", "D008", "D011", "M008", "M013", "M014"]
               and counts.startswith("2 errors") and "2 warnings" in counts and "3 infos" in counts
               and ".wav" not in ref_text.lower()
               and all(path.is_file() for path in defines + audio))
    refs_detail = (f"counts={counts!r} codes={ref_codes} wav-mentioned={'.wav' in ref_text.lower()} "
                   f"defines={sum(1 for path in defines if path.is_file())}/{len(defines)} "
                   f"audio={[path.name + ':' + str(path.stat().st_size) for path in audio if path.is_file()]}")
    results.check("the example package's only findings are its two deliberate ones, and its audio is named by nobody",
                  refs_ok, refs_detail)

    results.check("the board is back as it was found", restored,
                  "byte-identical" if backup.existed else "absent again")
    if not host_gone:
        results.check("the host is gone", False, "still running -- kill it by hand")
    # Every check that reads a .png the pixel cards wrote has had its look; the
    # cards made these files and nothing else this run survives it.
    for png in (*PIXEL_PNGS, RGB_SPRITE):
        png.unlink(missing_ok=True)
    code = results.report(attempts)
    if args.keep and WRAPPER.exists():
        print(f"wrapper kept: {WRAPPER}")
    return code


if __name__ == "__main__":
    sys.exit(main())
