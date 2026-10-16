"""The kernel regression probe: every bug in docs/BUGS.md, checked after the fix.

Run it from a clone:

    python tools/kernel_probe.py        # or: make probe

It builds nothing itself -- build `build/infantgod.exe` first (`make`).  The probe
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
import base64
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
    # A file the kernel will not read as *text*, written here rather than through
    # `file.write` (which refuses U+0000 on purpose).  This used to be the file
    # with no revision to compare, which was honest while nothing could read it:
    # there was nothing to compare against.  `file.read_bytes` changed that, so
    # what this fixture probes now is that the two verbs agree -- `file.stat` and
    # `file.read_bytes` must hand out one number for one file, or a client
    # watching an image would never see it change.
    with open(os.path.join(root, "scratch", "binary.bin"), "wb") as handle:
        handle.write(b"\x00\x01\x02\xff")
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
    check("view_revision is non-negative", info["view_revision"] >= 0,
          repr(info["view_revision"]))

    print("\n== the kernel stores a document without reading it ==")
    # This path is this tool's convention, not the kernel's: the probe plants
    # the shipped board exactly where the shell would look for it.  The kernel
    # only knows the path it was handed on the last call.
    DOC = ".infantgod/board.json"
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
    never = ".infantgod/never-written.json"
    r = k.call("view.load", {"path": never})
    check("view.load answers with an explicit null and revision 0",
          "result" in r and r["result"]["document"] is None
          and r["result"]["revision"] == 0, json.dumps(r)[:160])
    r = k.call("view.save", {"path": never, "document": {}})
    check("view.save writes a document at a path of the caller's choosing",
          "result" in r and r["result"].get("saved") is True, json.dumps(r)[:120])
    check("...including an empty object, which is still a document",
          k.call("view.load", {"path": never})["result"]["document"] == {}, "")

    # The two loads just above made `.infantgod/never-written.json` the document
    # the kernel holds, and the rail compares against what the kernel last read or
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

    print("\n== file.stat: ask about a file without reading it ==")
    # The reason the method exists: a client holding a revision can ask "is this
    # still what I read?" without moving the bytes.  If the two ever disagreed,
    # every comparison built on them would be wrong.
    read = k.call("file.read", {"path": "examples/hello.yarn"})["result"]
    stat = k.call("file.stat", {"path": "examples/hello.yarn"})["result"]
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
    check("file.stat reads a binary file's revision, so an image can be watched",
          binary["exists"] is True and isinstance(binary["revision"], int)
          and binary["revision"] != 0,
          json.dumps(binary)[:140])

    as_text = k.call("file.read", {"path": "scratch/binary.bin"})
    check("...while file.read still refuses that file as binary",
          as_text.get("error", {}).get("code") == 1003
          and "binary" in str(as_text.get("error", {}).get("message", "")),
          json.dumps(as_text)[:140])

    as_bytes = k.call("file.read_bytes", {"path": "scratch/binary.bin"})["result"]
    check("...and file.read_bytes hands out the same revision for the same bytes",
          as_bytes["revision"] == binary["revision"] and as_bytes["size"] == 4,
          json.dumps(as_bytes)[:160])

    escape = k.call("file.stat", {"path": "../outside.txt"})
    check("file.stat refuses a path that escapes the workspace",
          escape.get("error", {}).get("name") == "IO", json.dumps(escape)[:140])

    print("\n== a file over the text cap travels as a blob ==")
    # The company the 4 MiB text cap keeps: the same file, one chunk at a time.
    # The fixture is generated here rather than committed -- it is 5 MiB, and a
    # repository should not carry a file whose only job is to be too big.
    pattern = bytes((i * 131 + 17) & 0xFF for i in range(4096))
    big = (pattern * ((5 * 1024 * 1024 + 11) // len(pattern) + 1))[:5 * 1024 * 1024 + 11]
    with open(os.path.join(k.root, "scratch", "large.bin"), "wb") as handle:
        handle.write(big)

    def fnv1a(data):
        h = 2166136261
        for byte in data:
            h = ((h ^ byte) * 16777619) & 0xFFFFFFFF
        return h if h != 0 else 1

    opened = k.call("file.blobOpen",
                    {"path": "scratch/large.bin", "mode": "read", "want_revision": True})
    check("file.blobOpen reports a 5 MiB file's size and revision",
          opened.get("result", {}).get("size") == len(big)
          and opened["result"].get("revision") == fnv1a(big),
          json.dumps(opened)[:160])

    session = opened.get("result", {}).get("session")
    pieces = []
    offset = 0
    ends = 0
    while session is not None:
        frame = k.call("file.blobRead",
                       {"session": session, "offset": offset, "length": 1024 * 1024})
        if "result" not in frame:
            break
        got = frame["result"]
        if not got.get("data"):
            break
        pieces.append(base64.b64decode(got["data"]))
        offset = got["offset"] + len(pieces[-1])
        if got.get("eof"):
            ends += 1
            break
    streamed = b"".join(pieces)
    check("...and the chunks reassemble into the file byte for byte",
          streamed == big and offset == len(big) and ends == 1,
          f"{len(streamed)} of {len(big)} bytes, {len(pieces)} chunks, {ends} end frames")

    text = k.call("file.read", {"path": "scratch/large.bin"})
    check("...while the text cap still refuses that file whole",
          text.get("error", {}).get("code") == 1003
          and "too large" in str(text.get("error", {}).get("message", "")),
          json.dumps(text)[:140])

    wrote = k.call("file.blobOpen",
                   {"path": "scratch/published.bin", "mode": "write", "want_revision": True})
    check("a write session opens on a file that does not exist yet, at size 0",
          wrote.get("result", {}).get("size") == 0
          and wrote.get("result", {}).get("revision") == 0,
          json.dumps(wrote)[:160])
    wsession = wrote.get("result", {}).get("session")
    half = big[:700000]
    first = k.call("file.blobAppend", {"session": wsession,
                                       "data": base64.b64encode(half).decode("ascii")})
    check("blobAppend reports where the next append goes",
          first.get("result", {}).get("offset") == len(half)
          and first["result"].get("size") == len(half),
          json.dumps(first)[:160])
    wrong = k.call("file.blobAppend", {"session": wsession, "offset": 3,
                                       "data": base64.b64encode(b"x").decode("ascii")})
    check("an append at an offset that is not the end is refused, and the session survives",
          wrong.get("error", {}).get("code") == -32602
          and "offset" in str(wrong.get("error", {}).get("message", "")),
          json.dumps(wrong)[:160])
    # The rest goes up the way a real client sends it: frames of at most 1 MiB.
    landed = len(half)
    for start in range(len(half), len(big), 1024 * 1024):
        piece = big[start:start + 1024 * 1024]
        frame = k.call("file.blobAppend",
                       {"session": wsession,
                        "data": base64.b64encode(piece).decode("ascii")})
        landed = frame.get("result", {}).get("offset", -1)
    check("...and the remaining chunks land at the end",
          landed == len(big), f"the session's end is {landed}, the file is {len(big)} bytes")
    committed = k.call("file.blobCommit", {"session": wsession, "total_size": len(big)})
    check("blobCommit publishes the file with the whole file's revision",
          committed.get("result", {}).get("replaced") is True
          and committed["result"].get("revision") == fnv1a(big)
          and committed["result"].get("size") == len(big),
          json.dumps(committed)[:160])
    with open(os.path.join(k.root, "scratch", "published.bin"), "rb") as handle:
        on_disk = handle.read()
    check("the published bytes are the bytes that were appended",
          on_disk == big, f"{len(on_disk)} bytes on disk")

    after = k.call("file.blobRead", {"session": wsession, "offset": 0, "length": 4})
    check("the committed session is closed",
          after.get("error", {}).get("code") == -32602
          and "no such blob session" in str(after.get("error", {}).get("message", "")),
          json.dumps(after)[:140])

    missing = k.call("file.blobOpen", {"path": "scratch/nope.bin", "mode": "read"})
    check("opening a missing file for reading is NOT_FOUND",
          missing.get("error", {}).get("code") == 1002, json.dumps(missing)[:140])
    stale = k.call("file.blobOpen", {"path": "scratch/large.bin", "mode": "write",
                                     "base_revision": 1})
    check("a stale base_revision on a blob open is STALE_REVISION with current_revision",
          stale.get("error", {}).get("code") == 1001
          and isinstance(stale.get("error", {}).get("data", {}).get("current_revision"), int),
          json.dumps(stale)[:160])

    bad_len = k.call("file.blobRead",
                     {"session": opened["result"]["session"], "offset": 0,
                      "length": 1024 * 1024 + 1})
    check("a chunk over 1 MiB is refused, not truncated",
          bad_len.get("error", {}).get("code") == -32602, json.dumps(bad_len)[:140])

    temp = k.call("file.blobOpen", {"path": "scratch/thrown-away.bin", "mode": "write"})
    tsession = temp.get("result", {}).get("session")
    k.call("file.blobAppend", {"session": tsession,
                               "data": base64.b64encode(b"half a file").decode("ascii")})
    aborted = k.call("file.blobAbort", {"session": tsession})
    check("aborting a write session publishes nothing and leaves no temporary file",
          aborted.get("result", {}).get("aborted") is True
          and not os.path.exists(os.path.join(k.root, "scratch", "thrown-away.bin"))
          and not os.path.exists(os.path.join(k.root, "scratch", "thrown-away.bin.tmp")),
          json.dumps(aborted)[:140])

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
