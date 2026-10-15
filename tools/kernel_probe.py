"""The kernel regression probe: every bug in docs/BUGS.md, checked after the fix.

Run it from a clone:

    python tools/kernel_probe.py        # or: make probe

It builds nothing itself -- build `build/infantgod.exe` first (`make`).  The probe
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
import re
import shutil
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from kernel_drive import EXE, ROOT, Kernel, show  # noqa: E402

FAILURES = []


def check(label, ok, detail=""):
    print(f"{'ok  ' if ok else 'FAIL'} {label}" + (f": {detail}" if detail else ""))
    if not ok:
        FAILURES.append(label)


def build_stamp():
    """What the sources say this binary is, read from the files on disk.

    The probe compares the *binary's* self-report against these, because the
    two can disagree: before the Makefile named the headers, a header-only
    version bump rebuilt nothing, and `hello` answered with the version from a
    stale rpc.o while `infantgod version` answered with the new one.
    """
    with open(os.path.join(ROOT, "core", "include", "infantgod_cfg.h"), encoding="utf-8") as handle:
        header = handle.read()
    version_path = os.path.join(ROOT, "VERSION")
    if os.path.isfile(version_path):
        with open(version_path, encoding="utf-8") as handle:
            version = handle.read().strip()
    else:
        # A checkout without the VERSION file is still a checkout: fall back to
        # the define the kernel itself was compiled from.
        fallback = re.search(r'#define\s+SDE_VERSION\s+"([^"]*)"', header)
        version = fallback.group(1) if fallback else None
    name = re.search(r'#define\s+SDE_PROTOCOL\s+"([^"]*)"', header)
    number = re.search(r"#define\s+SDE_PROTOCOL_VERSION\s+(\d+)", header)
    return {
        "version": version,
        "protocol_name": name.group(1) if name else None,
        "protocol": int(number.group(1)) if number else None,
    }


def prepare_workspace():
    """A throwaway workspace under build/, with the shipped fixtures in it."""
    starter = os.path.join(ROOT, "examples", "board.json")
    fixture = os.path.join(ROOT, "examples", "hello.yarn")
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
    os.makedirs(os.path.join(root, ".infantgod"))
    shutil.copyfile(fixture, os.path.join(root, "examples", "hello.yarn"))
    shutil.copyfile(starter, os.path.join(root, ".infantgod", "board.json"))
    return root


def run(k):
    print("== the shape of a revision ==")
    r = k.call("file.read", {"path": "examples/hello.yarn"})
    rev = r["result"]["revision"]
    size = r["result"]["size"]
    eol = r["result"]["eol"]
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
    r = k.call("file.read", {"path": "examples/hello\u0000.yarn"})
    check("file.read refuses a path containing U+0000",
          isinstance(r, dict) and r.get("error", {}).get("name") == "PARSE_ERROR",
          json.dumps(r)[:140])
    show("...and the kernel is still alive and answering",
         k.call("file.read", {"path": "examples/hello.yarn"})["result"]["size"])

    print("\n== bug D: a wrong-typed limit must not be ignored ==")
    for label, value in [("a string", "3"), ("true", True), ("an object", {}), ("an array", [])]:
        r = k.call("workspace.list", {"limit": value})
        check(f"workspace.list refuses limit as {label}",
              r.get("error", {}).get("name") == "INVALID_PARAMS", json.dumps(r)[:120])
    r = k.call("workspace.list", {"limit": 3})["result"]
    check("limit: 3 still returns 3 entries", len(r["files"]) == 3, str(len(r["files"])))
    r = k.call("workspace.list", {"limit": None})["result"]
    check("limit: null still means 'no limit'", r["truncated"] is False, json.dumps(r)[:80])

    print("\n== the binary is the one the sources describe ==")
    stamp = build_stamp()
    hello = k.call("hello").get("result", {})
    reported = hello.get("kernel_version")
    check("hello reports the version the sources name",
          reported == stamp["version"],
          f"hello says {reported!r}, the sources say {stamp['version']!r}"
          + ("" if reported == stamp["version"] else " -- a stale build says the old one; run: make clean"))
    check("hello reports the protocol name infantgod_cfg.h declares",
          hello.get("protocol_name") == stamp["protocol_name"],
          f"hello says {hello.get('protocol_name')!r}, the header says {stamp['protocol_name']!r}")
    check("hello reports the protocol number infantgod_cfg.h declares",
          hello.get("protocol") == stamp["protocol"],
          f"hello says {hello.get('protocol')!r}, the header says {stamp['protocol']!r}")

    print("\n== the ordinary paths still work ==")
    r = k.call("file.read", {"path": "examples/hello.yarn"})["result"]
    # Compare against what this checkout reported a moment ago, not against a
    # size written down here: the fixture is read-only for the whole run, and
    # pinning "820" would make the probe fail on a checkout whose git converted
    # line endings (see .gitattributes).
    check("file.read is unchanged",
          r["size"] == size and r["revision"] == rev and r["eol"] == eol,
          f"size={r['size']} (was {size}) rev={r['revision']} (was {rev}) eol={r['eol']}")
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
