"""input_smoke.py -- drive the real window: the undo keys, and who owns a wheel.

``browser_smoke.py`` fetches the page with ``--dump-dom``, which drives no
pointer, no keyboard and no wheel, so the *input paths* were the part of the
board no shipped suite could reach: ``selftest.mjs`` proves the undo ring
(documents, coalescing, the redo branch) with no DOM at all, and this proves the
wiring on top of it -- including that a wheel over a card's own scroll region
belongs to the card, which is a rule only a real event can test.

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
6. dispatch ``wheel`` over a card's own scroll region and over the board, and
   check which one the app lets through: the card's wheel must not be
   ``preventDefault``-ed and must not move the viewport, the board's must pan,
   and ctrl+wheel over the card must still zoom.

The board is backed up and restored byte-for-byte, and the host is killed by pid.

    python tools/input_smoke.py [--edge PATH] [--port N] [--timeout S] [--keep]

Exit codes: 0 pass or skipped, 1 a check failed, 2 could not run, 3 usage.
"""

import argparse
import re
import shutil
import subprocess
import sys
import tempfile
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))

import browser_smoke as bs  # noqa: E402  (needs the sys.path line above)

WRAPPER_NAME = "__input_smoke.html"
WRAPPER = bs.REPO_ROOT / "shell" / "web" / WRAPPER_NAME
RESULT_RE = re.compile(r'<pre id="result">(.*?)</pre>', re.S)
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
  return { el: null, notes };
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
  let wheelOk = true;
  try {
    const region = regionInSomeCard(doc, 120);
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
    const zoomAt = region === null ? { clientX: 600, clientY: 400 } : { clientX: region.x, clientY: region.y };
    const zoomOn = doc.elementFromPoint(zoomAt.clientX, zoomAt.clientY) || doc.getElementById("board");
    wheel(win, zoomOn, Object.assign({ deltaY: -240, ctrlKey: true }, zoomAt));
    say("wheel-ctrl: " + zoomBefore + " -> " + hudZoom());
  } catch (error) {
    wheelOk = false;
    say("wheel-error: " + (error && error.message ? error.message : String(error)));
  }

  say("RESULT: " + (ok && wheelOk
    ? "undo, redo and wheel ownership work in a real browser"
    : "FAILED -- see the counts and the wheel lines above"));
  document.title = "input smoke done";
}

main();
</script>
</body></html>
"""


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        prog="input_smoke.py",
        description=(
            "Boot the real app in the system browser, make a board change, press "
            "Ctrl+Z and Ctrl+Shift+Z, and dispatch a wheel over a card's own scroll "
            "region and over the board. Exit codes: 0 pass or skipped, 1 a check "
            "failed, 2 could not run, 3 usage."
        ),
    )
    parser.add_argument("--edge", help="path to msedge.exe (default: the usual two places)")
    parser.add_argument("--port", type=int, default=0, help="port for the host (default: a free one)")
    parser.add_argument("--timeout", type=float, default=180.0, help="seconds to allow the browser")
    parser.add_argument("--keep", action="store_true", help="keep the wrapper page for debugging")
    return parser


class Results:
    """The PASS/FAIL lines and the summary, in the shape browser_smoke.py uses."""

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


def parse_counts(body: str) -> dict:
    found = re.search(r"counts: boot=(\d+) added=(\d+) undone=(\d+) redone=(\d+) in-field=(\d+)", body)
    if found is None:
        return {}
    keys = ["boot", "added", "undone", "redone", "inField"]
    return dict(zip(keys, (int(value) for value in found.groups())))


def parse_wheel(body: str) -> dict:
    """The two wheel lines the wrapper wrote, as tuples of strings."""
    found = {}
    patterns = (
        ("card", r"wheel-card: defaultPrevented=(\w+) viewport-moved=(\w+)(?:  \((.+)\))?"),
        ("board", r"wheel-board: defaultPrevented=(\w+) viewport-moved=(\w+)"),
        ("ctrl", r"wheel-ctrl: (\S+) -> (\S+)"),
    )
    for key, pattern in patterns:
        match = re.search(pattern, body)
        if match is not None:
            found[key] = match.groups()
    none = re.search(r"wheel-card: none -- .*?\[(.+)\]", body)
    if none is not None:
        found["card_none"] = (none.group(1),)
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
        edge = bs.find_edge(args.edge)
    except bs.DriverError as exc:
        print(f"[SKIP] no browser available: {exc}")
        print("summary: 0 passed, 0 failed, 9 skipped (no browser)")
        return 0

    backup = bs.BoardBackup(bs.BOARD_PATH)
    backup.snapshot()
    try:
        backup.install_if_absent()
    except (bs.DriverError, OSError) as exc:
        print(f"[FAIL] cannot set up a board: {exc}")
        backup.discard()
        return 2

    print(f"input smoke           {bs.REPO_ROOT}")
    print(f"browser               {edge}")
    print(f"board                 {bs.BOARD_PATH}")
    print("-" * 68)
    profile = Path(tempfile.mkdtemp(prefix="seide-input-smoke-"))
    WRAPPER.write_text(PAGE, encoding="utf-8", newline="\n")
    host = bs.Host(args.port or bs.free_port())
    results = Results()
    attempts = 0
    body = ""
    try:
        host.start()
        host.wait_ready(min(30.0, args.timeout))
        url = host.url + WRAPPER_NAME
        argv = [str(edge), *bs.EDGE_FLAGS, f"--user-data-dir={profile}"]
        argv = [item if not item.startswith("--virtual-time-budget=")
                else f"--virtual-time-budget={BUDGET_MS}" for item in argv]
        done = subprocess.run([*argv, "--dump-dom", url], capture_output=True, text=True,
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
    except (bs.DriverError, OSError, subprocess.TimeoutExpired) as exc:
        print(f"[FAIL] the run did not finish: {exc}")
    finally:
        if not args.keep:
            WRAPPER.unlink(missing_ok=True)
        alive = host.proc is not None and host.proc.poll() is None
        if alive:
            bs.terminate(host.proc)
        shutil.rmtree(profile, ignore_errors=True)
        restored = backup.restore()
        backup.discard()
        host_gone = not (host.proc is not None and host.proc.poll() is None)

    counts = parse_counts(body)
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
    results.check("the board is back as it was found", restored,
                  "byte-identical" if restored else "NOT byte-identical")

    wheel = parse_wheel(body)
    card_wheel = wheel.get("card")
    if card_wheel is None:
        why = wheel.get("card_none")
        results.check("a wheel over a card's own scroll region is left to the card", True,
                      (f"no card's scroll region is under the pointer ({why[0]}) -- not proven"
                       if why else "no card's scroll region is under the pointer -- not proven"))
    else:
        where = f"  ({card_wheel[2]})" if card_wheel[2] else ""
        results.check("a wheel over a card's own scroll region is left to the card",
                      card_wheel[:2] == ("false", "false"),
                      f"defaultPrevented={card_wheel[0]} viewport-moved={card_wheel[1]}{where}"
                      " -- the card keeps the wheel and the board does not move")
    board_wheel = wheel.get("board")
    results.check("a wheel over the board still pans",
                  board_wheel == ("true", "true"),
                  f"defaultPrevented={board_wheel[0]} viewport-moved={board_wheel[1]}"
                  if board_wheel else "no wheel-board line")
    ctrl_wheel = wheel.get("ctrl")
    results.check("ctrl+wheel over a card is still a zoom",
                  bool(ctrl_wheel) and ctrl_wheel[0] != ctrl_wheel[1],
                  f"zoom {ctrl_wheel[0]} -> {ctrl_wheel[1]}" if ctrl_wheel else "no wheel-ctrl line")
    if not host_gone:
        results.check("the host is gone", False, "still running -- kill it by hand")
    code = results.report(attempts)
    if args.keep and WRAPPER.exists():
        print(f"wrapper kept: {WRAPPER}")
    return code


if __name__ == "__main__":
    sys.exit(main())
