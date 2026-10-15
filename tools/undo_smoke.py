"""undo_smoke.py -- press Ctrl+Z in the real window and count what happens.

The board's undo/redo *key path* was the one part of the undo feature that no
shipped suite could reach: ``selftest.mjs`` proves the ring (documents,
coalescing, the redo branch) with no DOM at all, and this proves the wiring on
top of it.  ``--dump-dom`` drives no pointer and no keyboard, so the keydown
events are dispatched from a page this test owns.

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
   did not move: text undo belongs to the textarea.

The board is backed up and restored byte-for-byte, and the host is killed by pid.

    python tools/undo_smoke.py [--edge PATH] [--port N] [--timeout S] [--keep]

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

WRAPPER_NAME = "__undo_smoke.html"
WRAPPER = REPO_ROOT / "shell" / "web" / WRAPPER_NAME
RESULT_RE = re.compile(r'<pre id="result">(.*?)</pre>', re.S)

#: Gives the page as much virtual time as it needs for five settled steps; the
#: real limit is ``--timeout`` on the browser process.
BUDGET_MS = 30000


PAGE = """<!doctype html>
<html lang="en"><head><meta charset="utf-8"><title>undo smoke</title>
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
  say("RESULT: " + (ok ? "undo and redo work in a real browser" : "FAILED -- see the counts above"));
  document.title = "undo smoke done";
}

main();
</script>
</body></html>
"""


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        prog="undo_smoke.py",
        description=(
            "Boot the real app in the system browser, make a board change, and press "
            "Ctrl+Z and Ctrl+Shift+Z. Exit codes: 0 pass or skipped, 1 a check failed, "
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


def parse_counts(body: str) -> dict:
    found = re.search(r"counts: boot=(\d+) added=(\d+) undone=(\d+) redone=(\d+) in-field=(\d+)", body)
    if found is None:
        return {}
    keys = ["boot", "added", "undone", "redone", "inField"]
    return dict(zip(keys, (int(value) for value in found.groups())))


def main(argv=None) -> int:
    args = build_parser().parse_args(argv)
    if args.timeout <= 0:
        build_parser().error("--timeout must be positive")
    if args.port < 0 or args.port > 65535:
        print(f"undo_smoke.py: --port {args.port} is not a TCP port", file=sys.stderr)
        return 2
    if WRAPPER.exists():
        print(f"undo_smoke.py: refusing to overwrite {WRAPPER}", file=sys.stderr)
        return 2

    try:
        edge = find_edge(args.edge)
    except DriverError as exc:
        print(f"[SKIP] no browser available: {exc}")
        print("summary: 0 passed, 0 failed, 5 skipped (no browser)")
        return 0

    # Deliberately *not* install_if_absent(): the counts below are deltas, so the
    # workspace's board (or its absence) is left exactly as it is until the run's
    # own autosave writes one -- which restore() then takes away again.
    backup = BoardBackup(BOARD_PATH)
    backup.snapshot()

    print(f"undo smoke            {REPO_ROOT}")
    print(f"browser               {edge}")
    print(f"board                 {BOARD_PATH}"
          f"{'' if backup.existed else ' (absent -- this run will create and remove it)'}")
    print("-" * 68)
    profile = Path(tempfile.mkdtemp(prefix="infantgod-undo-smoke-"))
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
        alive = host.proc is not None and host.proc.poll() is None
        if alive:
            terminate(host.proc)
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
                  "byte-identical" if backup.existed else "absent again")
    if not host_gone:
        results.check("the host is gone", False, "still running -- kill it by hand")
    code = results.report(attempts)
    if args.keep and WRAPPER.exists():
        print(f"wrapper kept: {WRAPPER}")
    return code


if __name__ == "__main__":
    sys.exit(main())
