"""The kernel regression probe: every bug in docs/BUGS.md, checked after the fix.

Run it from a clone:

    python tools/kernel_probe.py        # or: make probe

It builds nothing itself -- build `build/seide.exe` first (`make`).  The probe
spawns the kernel against a **scratch workspace** under `build/` (git-ignored),
so it cannot touch your board, your files or your layout; the scratch directory
is removed on the way out, including when a check fails.  The scratch root is
inside the project rather than in the system temp directory on purpose: some
sandboxed environments deny a freshly built native binary write access outside
the project tree, and a probe that fails for that reason would be lying.

Each check asserts the *safe* outcome, not merely that an error came back: a
refused document must also leave the stored board untouched, and a refused write
must leave the file as it was.
"""
import json
import os
import shutil
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from kernel_drive import EXE, ROOT, Kernel, show  # noqa: E402

FAILURES = []


def check(label, ok, detail=""):
    print(f"{'ok  ' if ok else 'FAIL'} {label}" + (f": {detail}" if detail else ""))
    if not ok:
        FAILURES.append(label)


def prepare_workspace():
    """A throwaway workspace under build/, with the shipped fixtures in it."""
    starter = os.path.join(ROOT, "examples", "board.json")
    fixture = os.path.join(ROOT, "examples", "hello.bf")
    for path in (EXE, starter, fixture):
        if not os.path.isfile(path):
            print(f"kernel_probe: missing {path}"
                  + (" -- build first with `make`" if path == EXE else ""),
                  file=sys.stderr)
            return None
    root = os.path.join(ROOT, "build", f"probe-workspace-{os.getpid()}")
    if os.path.isdir(root):
        shutil.rmtree(root, ignore_errors=True)
    os.makedirs(os.path.join(root, "examples"))
    os.makedirs(os.path.join(root, "scratch"))
    os.makedirs(os.path.join(root, ".seide"))
    shutil.copyfile(fixture, os.path.join(root, "examples", "hello.bf"))
    shutil.copyfile(starter, os.path.join(root, ".seide", "board.json"))
    return root


def run(k):
    print("== the shape of a revision ==")
    r = k.call("file.read", {"path": "examples/hello.bf"})
    rev = r["result"]["revision"]
    check("file.read revision is a non-negative number",
          isinstance(rev, (int, float)) and rev >= 0, repr(rev))
    check("...and is an int on the wire", isinstance(rev, int), repr(rev))
    info = k.call("workspace.info", {})["result"]
    check("board_revision is non-negative", info["board_revision"] >= 0,
          repr(info["board_revision"]))

    print("\n== bug A: a document that is not a board must not empty the board ==")
    before = k.call("board.load", {})["result"]
    before_rev = before["revision"]
    n_cards = len(before["document"]["cards"])
    check("there is a board to protect", n_cards > 0, f"{n_cards} cards")

    for label, document in [
        ("cards is an object", {"version": 1, "cards": {}, "links": []}),
        ("cards is absent", {"version": 1, "links": []}),
        ("links is absent", {"version": 1, "cards": []}),
        ("links is an object", {"version": 1, "cards": [], "links": {}}),
        ("cards is null", {"version": 1, "cards": None, "links": []}),
        ("version is a string", {"version": "1", "cards": [], "links": []}),
        ("viewport is an array", {"version": 1, "viewport": [], "cards": [], "links": []}),
    ]:
        r = k.call("board.save", {"document": document})
        err = r.get("error", {}).get("name") if isinstance(r, dict) else None
        check(f"board.save refuses: {label}", err == "INVALID_BOARD", json.dumps(r)[:120])

    after = k.call("board.load", {})["result"]
    check("the board survived all seven refusals",
          after["revision"] == before_rev and len(after["document"]["cards"]) == n_cards,
          f"rev {before_rev} -> {after['revision']}, "
          f"{n_cards} -> {len(after['document']['cards'])} cards")

    print("\n== a legitimately empty board is still accepted ==")
    r = k.call("board.save", {"document": {"version": 1, "cards": [], "links": []}})
    check("board.save accepts an empty board", "result" in r and r["result"].get("saved") is True,
          json.dumps(r)[:120])
    empty_rev = r["result"]["revision"] if "result" in r else None
    r = k.call("board.save", {"document": before["document"], "base_revision": empty_rev})
    check("and the original board can be put back (stale-guarded)",
          "result" in r, json.dumps(r)[:160])
    check("the board is back, card for card",
          k.call("board.load", {})["result"]["document"] == before["document"], "")

    print("\n== bug B: a wrong-typed base_revision must not disable the guard ==")
    k.call("file.write", {"path": "scratch/guard.txt", "text": "one"})
    cur = k.call("file.read", {"path": "scratch/guard.txt"})["result"]["revision"]
    for label, value in [("a string", str(cur)), ("true", True), ("an object", {}), ("an array", [])]:
        r = k.call("file.write", {"path": "scratch/guard.txt",
                                  "text": "clobbered", "base_revision": value})
        err = r.get("error", {}).get("name") if isinstance(r, dict) else None
        check(f"file.write refuses base_revision as {label}", err == "INVALID_PARAMS",
              json.dumps(r)[:120])
    text = k.call("file.read", {"path": "scratch/guard.txt"})["result"]["text"]
    check("the file was not clobbered", text == "one", repr(text))
    r = k.call("file.write", {"path": "scratch/guard.txt", "text": "two",
                              "base_revision": cur})
    check("a correct base_revision still writes", "result" in r, json.dumps(r)[:120])
    r = k.call("file.write", {"path": "scratch/guard.txt", "text": "three",
                              "base_revision": cur})
    check("and a stale one is still STALE_REVISION",
          r.get("error", {}).get("name") == "STALE_REVISION", json.dumps(r)[:120])
    r = k.call("file.write", {"path": "scratch/guard.txt", "text": "four",
                              "base_revision": None})
    check("base_revision: null still means 'no guard'", "result" in r, json.dumps(r)[:120])

    print("\n== bug C: U+0000 must not be silently truncated ==")
    k.call("file.write", {"path": "scratch/nul.txt", "text": "before"})
    r = k.call("file.write", {"path": "scratch/nul.txt", "text": "a\u0000b"})
    # U+0000 is refused by the parser, so the reply cannot carry an id: the id
    # was in the text that failed to parse.  It arrives as an id-null error.
    check("file.write refuses a text containing U+0000",
          isinstance(r, dict) and r.get("error", {}).get("name") == "PARSE_ERROR",
          json.dumps(r)[:140])
    text = k.call("file.read", {"path": "scratch/nul.txt"})["result"]["text"]
    check("the file still holds its old text", text == "before", repr(text))
    r = k.call("file.read", {"path": "examples/hello\u0000.bf"})
    check("file.read refuses a path containing U+0000",
          isinstance(r, dict) and r.get("error", {}).get("name") == "PARSE_ERROR",
          json.dumps(r)[:140])
    show("...and the kernel is still alive and answering",
         k.call("file.read", {"path": "examples/hello.bf"})["result"]["size"])

    print("\n== bug D: a wrong-typed limit must not be ignored ==")
    for label, value in [("a string", "3"), ("true", True), ("an object", {}), ("an array", [])]:
        r = k.call("workspace.list", {"limit": value})
        check(f"workspace.list refuses limit as {label}",
              r.get("error", {}).get("name") == "INVALID_PARAMS", json.dumps(r)[:120])
    r = k.call("workspace.list", {"limit": 3})["result"]
    check("limit: 3 still returns 3 entries", len(r["files"]) == 3, str(len(r["files"])))
    r = k.call("workspace.list", {"limit": None})["result"]
    check("limit: null still means 'no limit'", r["truncated"] is False, json.dumps(r)[:80])

    print("\n== the ordinary paths still work ==")
    r = k.call("file.read", {"path": "examples/hello.bf"})["result"]
    check("file.read is unchanged", r["size"] == 820 and r["revision"] == rev,
          f"size={r['size']} rev={r['revision']} eol={r['eol']}")
    check("the board document still round-trips",
          "result" in k.call("board.save", {"document": before["document"]}), "")


def main():
    root = prepare_workspace()
    if root is None:
        return 2
    k = None
    try:
        k = Kernel(root)
        run(k)
    finally:
        if k is not None:
            k.close()
        shutil.rmtree(root, ignore_errors=True)
    print()
    if FAILURES:
        print(f"summary: {len(FAILURES)} FAILED -> " + "; ".join(FAILURES))
        return 1
    print("summary: all ok")
    return 0


if __name__ == "__main__":
    sys.exit(main())
