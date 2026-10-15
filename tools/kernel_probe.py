"""The kernel regression probe: every bug in docs/BUGS.md, checked after the fix.

Run it from a clone:

    python tools/kernel_probe.py        # or: make probe

It builds nothing itself -- build `build/seide.exe` first (`make`).  The probe
spawns the kernel against a **scratch workspace** under `build/` (git-ignored),
so it cannot touch your document, your files or your layout; the scratch directory
is removed on the way out, including when a check fails.  The scratch root is
inside the project rather than in the system temp directory on purpose: some
sandboxed environments deny a freshly built native binary write access outside
the project tree, and a probe that fails for that reason would be lying.

Each check asserts the *safe* outcome, not merely that an error came back: a
refused document must also leave what the kernel holds untouched, and a refused
write must leave the file as it was.
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
    stale rpc.o while `seide version` answered with the new one.
    """
    with open(os.path.join(ROOT, "VERSION"), encoding="utf-8") as handle:
        version = handle.read().strip()
    with open(os.path.join(ROOT, "core", "include", "seide_cfg.h"), encoding="utf-8") as handle:
        header = handle.read()
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
    # A file the kernel will not read as text, written here rather than through
    # `file.write` (which refuses U+0000 on purpose).  `file.stat` must call it
    # "exists, but no revision to compare", which is what tells a client to warn
    # about it rather than reload over it.
    with open(os.path.join(root, "scratch", "binary.bin"), "wb") as handle:
        handle.write(b"\x00\x01\x02\xff")
    return root


def run(k):
    print("== the shape of a revision ==")
    r = k.call("file.read", {"path": "examples/hello.bf"})
    rev = r["result"]["revision"]
    size = r["result"]["size"]
    eol = r["result"]["eol"]
    check("file.read revision is a non-negative number",
          isinstance(rev, (int, float)) and rev >= 0, repr(rev))
    check("...and is an int on the wire", isinstance(rev, int), repr(rev))
    info = k.call("workspace.info", {})["result"]
    check("view_revision is non-negative", info["view_revision"] >= 0,
          repr(info["view_revision"]))

    print("\n== the kernel stores a document without reading it ==")
    # This path is this tool's convention, not the kernel's: the probe plants
    # the shipped board exactly where the shell would look for it.  The kernel
    # only knows the path it was handed on the last call.
    DOC = ".seide/board.json"
    before = k.call("view.load", {"path": DOC})["result"]
    n_cards = len(before["document"]["cards"])
    check("there is a document to protect", n_cards > 0, f"{n_cards} cards")

    # Everything the board schema calls wrong is the kernel's business to keep,
    # not to judge.  This is the whole point of the split: `cards` is a client
    # word, so a document that misuses it must survive a round-trip untouched.
    opaque = {"app": "kernel_probe", "cards": {"nope": True},
              "links": None, "views": [{"id": "v1"}]}
    r = k.call("view.save", {"path": DOC, "document": opaque})
    check("view.save takes a document the board schema would reject",
          "result" in r and r["result"].get("saved") is True, json.dumps(r)[:120])
    now_rev = r["result"]["revision"] if "result" in r else None
    back = k.call("view.load", {"path": DOC})["result"]["document"]
    check("...and hands it back unchanged", back == opaque, json.dumps(back)[:120])

    # A refused write must leave what the kernel holds exactly as it was.  There
    # are two ways to be refused: a base revision that moved on, and no document
    # at all.
    r = k.call("view.save", {"path": DOC, "document": {"views": []},
                             "base_revision": before["revision"]})
    check("view.save refuses a stale base revision",
          r.get("error", {}).get("name") == "STALE_REVISION", json.dumps(r)[:160])
    check("...and says which revision is current",
          (r.get("error", {}).get("data") or {}).get("current_revision") == now_rev,
          json.dumps(r)[:160])
    for label, params in [
        ("no document member", {"path": DOC}),
        ("document: null", {"path": DOC, "document": None}),
    ]:
        r = k.call("view.save", params)
        err = r.get("error", {}).get("name") if isinstance(r, dict) else None
        check(f"view.save refuses: {label}", err == "INVALID_PARAMS", json.dumps(r)[:120])
    check("the document survived every refusal",
          k.call("view.load", {"path": DOC})["result"]["document"] == opaque, "")

    print("\n== a first run has no document, and that is not an error ==")
    never = ".seide/never-written.json"
    r = k.call("view.load", {"path": never})
    check("view.load answers with an explicit null and revision 0",
          "result" in r and r["result"]["document"] is None
          and r["result"]["revision"] == 0, json.dumps(r)[:160])
    r = k.call("view.save", {"path": never, "document": {}})
    check("view.save writes a document at a path of the caller's choosing",
          "result" in r and r["result"].get("saved") is True, json.dumps(r)[:120])
    check("...including an empty object, which is still a document",
          k.call("view.load", {"path": never})["result"]["document"] == {}, "")

    # The two loads just above made `.seide/never-written.json` the document the
    # kernel holds, and the rail compares against what the kernel last read or
    # wrote -- so the board's revision is read again here instead of reusing
    # `now_rev`, which belongs to the document the probe replaced.
    board_rev = k.call("view.load", {"path": DOC})["result"]["revision"]
    r = k.call("view.save", {"path": DOC, "document": before["document"],
                             "base_revision": board_rev})
    check("the original board can be put back (stale-guarded)",
          "result" in r, json.dumps(r)[:160])
    check("the board is back, member for member",
          k.call("view.load", {"path": DOC})["result"]["document"] == before["document"], "")

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

    print("\n== file.stat: ask about a file without reading it ==")
    # The reason the method exists: a client holding a revision can ask "is this
    # still what I read?" without moving the bytes.  If the two ever disagreed,
    # every comparison built on them would be wrong.
    read = k.call("file.read", {"path": "examples/hello.bf"})["result"]
    stat = k.call("file.stat", {"path": "examples/hello.bf"})["result"]
    check("file.stat agrees with file.read on the revision",
          stat["revision"] == read["revision"],
          f"stat={stat['revision']} read={read['revision']}")
    check("...and on the size", stat["size"] == read["size"],
          f"stat={stat['size']} read={read['size']}")
    check("a plain file exists and is not a directory",
          stat["exists"] is True and stat["dir"] is False, json.dumps(stat)[:140])
    check("mtime is a positive number", isinstance(stat["mtime"], int) and stat["mtime"] > 0,
          repr(stat["mtime"]))

    absent = k.call("file.stat", {"path": "scratch/absent.txt"})
    check("a file that is not there is an answer, not an error",
          "result" in absent and absent["result"]["exists"] is False,
          json.dumps(absent)[:140])
    check("...with no revision to compare (0), no size and no mtime",
          absent["result"]["revision"] == 0 and absent["result"]["size"] == 0
          and absent["result"]["mtime"] == -1,
          json.dumps(absent["result"])[:140])

    directory = k.call("file.stat", {"path": "examples"})["result"]
    check("a directory says it is one",
          directory["exists"] is True and directory["dir"] is True,
          json.dumps(directory)[:140])

    binary = k.call("file.stat", {"path": "scratch/binary.bin"})["result"]
    check("a file the kernel will not read as text has no revision (0)",
          binary["exists"] is True and binary["revision"] == 0,
          json.dumps(binary)[:140])

    escape = k.call("file.stat", {"path": "../outside.txt"})
    check("file.stat refuses a path that escapes the workspace",
          escape.get("error", {}).get("name") == "IO", json.dumps(escape)[:140])

    print("\n== the binary is the one the sources describe ==")
    stamp = build_stamp()
    hello = k.call("hello").get("result", {})
    reported = hello.get("kernel_version")
    check("hello reports the version VERSION names",
          reported == stamp["version"],
          f"hello says {reported!r}, VERSION says {stamp['version']!r}"
          + ("" if reported == stamp["version"] else " -- a stale build says the old one; run: make clean"))
    check("hello reports the protocol name seide_cfg.h declares",
          hello.get("protocol_name") == stamp["protocol_name"],
          f"hello says {hello.get('protocol_name')!r}, the header says {stamp['protocol_name']!r}")
    check("hello reports the protocol number seide_cfg.h declares",
          hello.get("protocol") == stamp["protocol"],
          f"hello says {hello.get('protocol')!r}, the header says {stamp['protocol']!r}")

    print("\n== the ordinary paths still work ==")
    r = k.call("file.read", {"path": "examples/hello.bf"})["result"]
    # Compare against what this checkout reported a moment ago, not against a
    # size written down here: the fixture is read-only for the whole run, and
    # pinning "820" would make the probe fail on a checkout whose git converted
    # line endings (see .gitattributes).
    check("file.read is unchanged",
          r["size"] == size and r["revision"] == rev and r["eol"] == eol,
          f"size={r['size']} (was {size}) rev={r['revision']} (was {rev}) eol={r['eol']}")
    check("the document still round-trips",
          "result" in k.call("view.save", {"path": DOC, "document": before["document"]}), "")


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
