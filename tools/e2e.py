#!/usr/bin/env python3
"""e2e.py -- end-to-end driver for the InfantGod Studio kernel protocol.

    python tools/e2e.py [--kernel PATH | --kernel-cmd CMD]
                        [--timeout SEC] [--keep-going] [--json]

Spawns an endpoint and speaks newline-delimited JSON-RPC over its
stdin/stdout:

* **requests** are ``{"id": N, "method": ..., "params": {...}}`` plus ``\\n``;
* **responses** carry the same ``id`` plus ``result`` or ``error``;
* **notifications** carry an ``event`` field and **no** ``id``.

Two reader threads demultiplex those lines, so a chatty kernel can never deadlock
the driver, and every request has a timeout.  The child is always killed on exit,
including when a check fails.

The scenario asserted here is the frozen protocol exercised in order: hello,
workspace.info, lang.list, lang.tokenize (plus its tiling property),
file.read / file.write / stale write, path containment, the view document
round-trip, the shipped starter board, and a real ``exec.start`` run whose stdout
must contain the kernel's own version.  The two write checks have to edit the
fixture to move its revision (a revision is a content hash) and write the
original bytes back afterwards, so a completed run leaves the file
byte-identical.

Since infantgod/2 the protocol also carries **bytes**, for files that are not
text: ``file.read_bytes`` / ``file.write_bytes``, which the checks here hold to
the same promises as their text siblings -- same containment, same 4 MiB cap,
same revision track, same ``STALE_REVISION`` refusal -- plus the one promise of
their own, that a payload of every byte value round-trips unchanged.  Those
checks use ``BYTE_SCRATCH`` under ``build/`` and delete it when they are done,
because unlike the text checks there is no shipped binary file they could edit
and put back.

The view document is stored at a path **this tool chooses**
(``DOCUMENT_PATH``, the same one the shell uses): since infantgod/2 the kernel
keeps a document without reading it, so the path, the schema and the bytes are
all client business -- except that what goes in must come back out unchanged.

Endpoint modes
    Languages are no longer part of the C kernel: the shell multiplexer serves
    ``lang.list`` / ``lang.tokenize`` and forwards the kernel methods.

    * **kernel mode** (default, ``--kernel build/infantgod.exe``): the driver spawns
      ``<infantgod> rpc``.  The kernel does not serve ``lang.*``, so those checks
      (three, counting the tiling assertion) are reported as
      *skipped (kernel mode)* and ``workspace.info`` is not required to carry
      ``langs``.
    * **full mode** (``--kernel-cmd "node shell/main.mjs rpc --workspace ."``):
      the command line is spawned verbatim -- nothing (not even ``rpc``) is
      appended.  ``workspace.info.langs`` is required and the tokenizer checks
      run, including the assertion that token spans tile the whole input.

Fixtures
    The checks read the two scripts that actually ship: ``examples/hello.yarn``
    (the tokenizer, ``file.read`` and the two write checks) and, for the language
    inventory, the descriptors in ``langs/``.  There is no scratch fixture and
    no ``--fixture`` override: every path the suite touches is a file the
    repository already has, so a run cannot invent one.

Exit codes
    0   every check passed
    1   at least one check failed (or checks were skipped after a failure)
    2   the driver could not start (missing infantgod binary, unusable fixture, ...)
    3   the command line was malformed
"""

from __future__ import annotations

import argparse
import base64
import collections
import itertools
import json
import os
import re
import shutil
import subprocess
import sys
import threading
import time
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parents[1]

#: Default kernel binary, relative to the repository root (kernel-only mode).
KERNEL_DEFAULT = "build/infantgod.exe"

#: The script the tokenizer, ``file.read`` and the write checks exercise.  It is
#: a file the repository ships, so no check ever depends on a fixture the driver
#: created (or on ``--fixture`` naming one).
FIXTURE = "examples/hello.yarn"

#: Name of the kernel binary that ``exec.start`` runs at itself in *both*
#: endpoint modes.  Derived from the documented ``KERNEL_DEFAULT`` rather than
#: from the endpoint argv: in full mode the argv is ``node``, and the binary a
#: `version` reply proves is the kernel's, not the shell's.
KERNEL_BINARY = REPO_ROOT / KERNEL_DEFAULT

#: Appended to a file to make a real content change for the revision checks.
#: ``#`` starts a comment in Yarn, so the file still parses and still tokenizes
#: while it is edited.
REVISION_PROBE = "\n# e2e: revision probe\n"

#: What the byte checks send through ``file.write_bytes``.  Every byte value is
#: in it, which is the point: a NUL is what makes ``file.read`` call the file
#: binary, and 0x89/0xff are what make it stop being a JSON string on the way
#: back.  A payload of ASCII would pass through ``file.write`` and prove nothing.
BYTE_PAYLOAD = bytes(range(256)) * 4 + b"\x00\x00PNG\r\n\x1a\n"

#: Where the byte checks put their scratch file: inside the workspace root, so
#: containment is exercised rather than bypassed, and under ``build/`` -- the
#: directory the repository already ignores -- so a crashed run cannot leave a
#: tracked file behind.  Every byte check removes it in a ``finally``.
BYTE_SCRATCH = "build/e2e-bytes.bin"

#: Kinds ``lang.tokenize`` may put on the wire (mirrors ``langs/lang.mjs``).
#: Kept here rather than imported so the driver stays runnable against any fork
#: whose language layer is a reimplementation, as the wire contract allows.
TOKEN_KINDS = (
    "keyword",
    "command",
    "type",
    "constant",
    "number",
    "string",
    "comment",
    "ident",
    "punct",
    "ws",
)

#: Where this suite keeps its document.  The kernel has no opinion: a view
#: document's path is the *client's* convention, and this is the same one
#: `shell/web/board.mjs` uses, so the suite exercises the path a real user has.
DOCUMENT_PATH = ".infantgod/board.json"


class DriverError(Exception):
    """The driver itself could not proceed (bad binary, timeout, dead child)."""


class RpcError(Exception):
    """The kernel answered a request with an ``error`` object."""

    def __init__(self, code: str, message: str, raw=None):
        super().__init__(f"{code}: {message}")
        self.code = code
        self.message = message
        self.raw = raw if isinstance(raw, dict) else {}


class CheckFailed(Exception):
    """An assertion about the protocol did not hold."""


class _Parser(argparse.ArgumentParser):
    """ArgumentParser that reports usage errors with the documented exit code."""

    def error(self, message: str) -> None:
        self.print_usage(sys.stderr)
        print(f"e2e.py: usage error: {message}", file=sys.stderr)
        raise SystemExit(3)


class Style:
    """Tiny ANSI helper; colour is switched off for pipes and ``NO_COLOR``."""

    def __init__(self, enabled: bool):
        self.enabled = enabled

    def _paint(self, text: str, code: str) -> str:
        return f"\033[{code}m{text}\033[0m" if self.enabled else text

    def ok(self, text: str) -> str:
        return self._paint(text, "32")

    def bad(self, text: str) -> str:
        return self._paint(text, "31")

    def dim(self, text: str) -> str:
        return self._paint(text, "2")

    def bold(self, text: str) -> str:
        return self._paint(text, "1")


def colour_enabled(stream) -> bool:
    """True only when *stream* is a TTY and NO_COLOR/TERM=dumb do not forbid it."""
    if "NO_COLOR" in os.environ or os.environ.get("TERM") == "dumb":
        return False
    return bool(getattr(stream, "isatty", lambda: False)())


def split_command(text: str) -> list:
    """Split a command string on whitespace, honouring double quotes.

    Hand-written so Windows paths keep their backslashes (``shlex`` would eat
    them in POSIX mode and keep the quotes in non-POSIX mode).
    """
    return [match.group(1) if match.group(1) is not None else match.group(2)
            for match in re.finditer(r'"([^"]*)"|(\S+)', text)]


def resolve_argv(setting: str, explicit: bool) -> list:
    """Turn ``--kernel`` into an argv list.

    A path to an existing file is used as-is; anything else is split like a shell
    command, which keeps the documented ``--kernel build/infantgod.exe`` contract while
    letting a test drive ``--kernel "python tools/stub.py"``.
    """
    candidate = Path(setting)
    if not candidate.is_absolute():
        candidate = REPO_ROOT / candidate
    if candidate.is_file():
        return [str(candidate)]
    argv = split_command(setting)
    if not argv:
        raise DriverError("--kernel is empty")
    if Path(argv[0]).is_file() or shutil.which(argv[0]):
        return argv
    if not explicit:
        raise DriverError(
            f"infantgod binary not found at {candidate}; build it first with `python tools/build.py`"
        )
    raise DriverError(f"cannot find {argv[0]!r} (from --kernel {setting!r})")


def resolve_endpoint(args) -> tuple:
    """Return ``(argv, mode)`` for ``--kernel`` (kernel) or ``--kernel-cmd`` (full).

    *kernel* mode appends the ``rpc`` subcommand to the kernel binary; *full*
    mode runs ``--kernel-cmd`` exactly as given, because the caller already wrote
    the whole command line (``rpc`` included).  ``--kernel`` defaults to the
    kernel binary only when it is absent, so an explicitly written ``--kernel``
    is still detected as a conflict with ``--kernel-cmd``.
    """
    if args.kernel_cmd:
        if args.kernel is not None:
            raise DriverError("--kernel and --kernel-cmd are mutually exclusive")
        argv = split_command(args.kernel_cmd)
        if not argv:
            raise DriverError("--kernel-cmd is empty")
        if not (Path(argv[0]).is_file() or shutil.which(argv[0])):
            raise DriverError(f"cannot find {argv[0]!r} (from --kernel-cmd)")
        return argv, "full"
    setting = args.kernel if args.kernel is not None else KERNEL_DEFAULT
    argv = resolve_argv(setting, explicit=args.kernel is not None)
    return [*argv, "rpc"], "kernel"


class RpcClient:
    """Line-delimited JSON-RPC client for a child process."""

    def __init__(self, argv, timeout: float):
        self.argv = list(argv)
        self.timeout = timeout
        self.proc = None
        self._cv = threading.Condition()
        self._responses = {}
        self._events = []
        self._ids = itertools.count(1)
        self._closed = None
        self._stderr_tail = collections.deque(maxlen=40)
        self._threads = []

    # -- lifecycle ---------------------------------------------------------

    def start(self) -> "RpcClient":
        """Spawn the child and start pumping its stdout/stderr."""
        try:
            self.proc = subprocess.Popen(
                self.argv,
                stdin=subprocess.PIPE,
                stdout=subprocess.PIPE,
                stderr=subprocess.PIPE,
                cwd=str(REPO_ROOT),
            )
        except OSError as exc:
            raise DriverError(f"cannot start {self.argv[0]!r}: {exc}") from exc
        for target in (self._pump_stdout, self._pump_stderr):
            thread = threading.Thread(target=target, daemon=True)
            thread.start()
            self._threads.append(thread)
        return self

    def close(self) -> None:
        """Shut the child down: close stdin, wait, then kill if it lingers."""
        proc = self.proc
        if proc is None:
            return
        with self._cv:
            if self._closed is None:
                self._closed = "driver closed the session"
            self._cv.notify_all()
        try:
            if proc.stdin:
                proc.stdin.close()
        except OSError:
            pass
        try:
            proc.wait(timeout=3)
        except subprocess.TimeoutExpired:
            proc.kill()
            try:
                proc.wait(timeout=3)
            except subprocess.TimeoutExpired:
                pass
        for thread in self._threads:
            thread.join(timeout=1)

    # -- reader threads ----------------------------------------------------

    def _pump_stdout(self) -> None:
        try:
            for raw in iter(self.proc.stdout.readline, b""):
                self._dispatch(raw)
        finally:
            code = self.proc.poll()
            self._finish(
                "the kernel closed its stdout" if code is None else f"the kernel exited with code {code}"
            )

    def _pump_stderr(self) -> None:
        for raw in iter(self.proc.stderr.readline, b""):
            line = raw.decode("utf-8", "replace").rstrip()
            if line:
                self._stderr_tail.append(line)

    def _dispatch(self, raw: bytes) -> None:
        line = raw.decode("utf-8", "replace").strip()
        if not line:
            return
        try:
            message = json.loads(line)
        except ValueError:
            message = None
        with self._cv:
            if isinstance(message, dict) and message.get("id") is not None:
                self._responses[message["id"]] = message
            elif isinstance(message, dict) and "event" in message:
                self._events.append(message)
            else:
                self._events.append({"_malformed": line})
            self._cv.notify_all()

    def _finish(self, reason: str) -> None:
        with self._cv:
            if self._closed is None:
                self._closed = reason
            self._cv.notify_all()

    def _dead_message(self, what: str) -> str:
        message = f"the kernel died before {what} ({self._closed})"
        if self._stderr_tail:
            message += "\nkernel stderr:\n  " + "\n  ".join(self._stderr_tail)
        return message

    def stderr_tail(self) -> str:
        """The kernel's recent stderr, for failure reports."""
        return "\n".join(self._stderr_tail)

    # -- protocol ----------------------------------------------------------

    def send(self, message: dict) -> None:
        """Write one JSON message plus a newline to the child's stdin."""
        payload = (json.dumps(message, separators=(",", ":")) + "\n").encode("utf-8")
        try:
            self.proc.stdin.write(payload)
            self.proc.stdin.flush()
        except (OSError, ValueError) as exc:
            raise DriverError(f"cannot write to the kernel: {exc}") from exc

    def _await(self, getter, what: str, budget: float):
        """Block until *getter()* returns something truthy or *budget* expires."""
        deadline = time.monotonic() + budget
        with self._cv:
            while True:
                value = getter()
                if value is not None:
                    return value
                if self._closed is not None:
                    raise DriverError(self._dead_message(what))
                remaining = deadline - time.monotonic()
                if remaining <= 0:
                    raise DriverError(f"timed out after {budget:g}s waiting for {what}")
                self._cv.wait(remaining)

    def exchange(self, method: str, params=None, timeout: float = None) -> dict:
        """Send one request and return the whole response message."""
        request_id = next(self._ids)
        budget = self.timeout if timeout is None else timeout
        self.send({"id": request_id, "method": method, "params": params if params is not None else {}})
        return self._await(
            lambda: self._responses.pop(request_id, None), f"the response to {method}", budget
        )

    def call(self, method: str, params=None, timeout: float = None):
        """Send a request and return its ``result``, raising :class:`RpcError`."""
        message = self.exchange(method, params, timeout)
        if "error" in message:
            error = message["error"]
            if not isinstance(error, dict):
                error = {"code": "ERROR", "message": str(error)}
            raise RpcError(
                str(error.get("name", error.get("code", "ERROR"))),
                str(error.get("message", "")),
                error,
            )
        if "result" not in message:
            raise CheckFailed(f"{method}: response has neither result nor error")
        return message["result"]

    def expect_error(self, method: str, params=None, timeout: float = None) -> dict:
        """Send a request that must fail, returning its error object."""
        message = self.exchange(method, params, timeout)
        error = message.get("error")
        if not isinstance(error, dict):
            raise CheckFailed(f"{method}: expected an error, got {_short(message)}")
        return error

    def wait_event(self, predicate, what: str, timeout: float = None) -> dict:
        """Return and consume the first queued event satisfying *predicate*."""
        budget = self.timeout if timeout is None else timeout

        def grab():
            for index, event in enumerate(self._events):
                if predicate(event):
                    return self._events.pop(index)
            return None

        return self._await(grab, what, budget)


def _short(value, limit: int = 300) -> str:
    """Compact repr of a value for failure messages."""
    text = json.dumps(value, separators=(",", ":"), default=str)
    return text if len(text) <= limit else text[:limit] + "..."


def _is_id(value) -> bool:
    """True for a revision/run id: an int or non-empty string, but not a bool."""
    if isinstance(value, bool):
        return False
    return (isinstance(value, int)) or (isinstance(value, str) and value != "")


def require(condition, message: str) -> None:
    """Raise :class:`CheckFailed` unless *condition* is true."""
    if not condition:
        raise CheckFailed(message)


# --------------------------------------------------------------------------
# Fixture and index space


def resolve_fixture() -> dict:
    """Return the shipped script every text check runs against.

    ``examples/hello.yarn`` is a real Yarn Spinner node, not test scratch space:
    it carries non-ASCII prose, indentation, comments and dialogue, which is
    exactly what makes it worth tokenizing.
    """
    path = REPO_ROOT / FIXTURE
    try:
        text = path.read_text(encoding="utf-8")
    except OSError as exc:
        raise DriverError(f"cannot read the fixture {path}: {exc}") from exc
    return {"path": str(path), "text": text}


def js_length(text: str) -> int:
    """Length of *text* in the tokenizer's index space.

    ``langs/tokenize.mjs`` indexes a JavaScript string, so every offset it emits
    is a **UTF-16 code unit** count, not a Python character (code point) count.
    The two agree until a character outside the BMP shows up -- an emoji, say --
    where one character is a surrogate *pair* and the JS index runs one ahead of
    ``len(text)``.  Comparing the wire spans against ``len(text)`` would then
    either fail a correct tokenizer or, worse, let a span past ``len(text)``
    through ``normalise_tokens``.  Measuring the fixture in the same space keeps
    the tiling assertion honest for any script, not just this one.
    """
    return len(text.encode("utf-16-le")) // 2


def scrubbed(raw: bytes) -> str:
    """Decode a child's captured stdout, dropping bytes that are not UTF-8.

    This is the "sanitised" half of the ``exec.start`` contract: the driver never
    trusts the wire to be valid UTF-8 (a Windows child can emit a code page),
    and never lets a stray byte kill the check.
    """
    return raw.decode("utf-8", "replace")


# --------------------------------------------------------------------------
# The scenario


class Harness:
    """Runs the named checks and records their outcomes."""

    def __init__(self, client: RpcClient, ctx: dict, style: Style, keep_going: bool, stream):
        self.client = client
        self.ctx = ctx
        self.style = style
        self.keep_going = keep_going
        self.stream = stream
        self.results = []

    def run(self, name: str, check) -> bool:
        """Execute one check, printing a PASS/FAIL line; never raises."""
        try:
            detail = check() or "ok"
            passed = True
        except (CheckFailed, RpcError, DriverError) as exc:
            detail, passed = str(exc).replace("\n", " "), False
        except Exception as exc:  # noqa: BLE001 - a driver bug is still a failing check
            detail, passed = f"{type(exc).__name__}: {exc}", False
        self.results.append(
            {"name": name, "ok": passed, "detail": detail, "skipped": False, "mode_skip": False}
        )
        tag = self.style.ok("PASS") if passed else self.style.bad("FAIL")
        print(f"[{tag}] {name}: {self.style.dim(detail)}", file=self.stream, flush=True)
        return passed

    def skip(self, name: str, reason: str) -> None:
        """Record a check this endpoint mode does not serve (never a failure)."""
        self.results.append(
            {"name": name, "ok": False, "detail": reason, "skipped": False, "mode_skip": True}
        )
        print(f"[{self.style.dim('SKIP')}] {name}: {self.style.dim(reason)}", file=self.stream, flush=True)


def build_board(ctx: dict) -> dict:
    """The board payload the round-trip check saves and loads.

    The frozen card vocabulary is ``{id, kind, x, y, w, h, z, title, ...}``, plus
    ``links: [{id, from, to, label}]``.  An editor card binds a *file path*; the
    text itself lives in the file, never in the card.

    ``kind`` is deliberately open, and since infantgod/2 the kernel does not even
    police the card *shape*: a document is opaque bytes to the kernel, so this
    payload's job is to prove the round-trip is exact rather than to prove the
    kernel can read it.  The third card below is a ``sheet`` card whose state is
    a nested object of typed columns and rows, not a string.  If anything in the
    path lost, reshaped or re-ordered that, the deep comparison in
    ``board_roundtrip`` fails.
    """
    return {
        "version": 1,
        "cards": [
            {
                "id": "e2e-editor",
                "kind": "editor",
                "x": 40,
                "y": 60,
                "w": 640,
                "h": 420,
                "z": 1,
                "title": "e2e scratch",
                "file": ctx["fixture_path"],
            },
            {
                "id": "e2e-note",
                "kind": "note",
                "x": 720,
                "y": 60,
                "w": 320,
                "h": 200,
                "z": 2,
                "title": "e2e notes",
            },
            {
                "id": "e2e-sheet",
                "kind": "sheet",
                "x": 720,
                "y": 300,
                "w": 460,
                "h": 320,
                "z": 3,
                "title": "e2e structured state",
                "doc": {
                    "columns": [
                        {"id": "key", "title": "key", "type": "text"},
                        {"id": "count", "title": "count", "type": "number"},
                        {"id": "done", "title": "done", "type": "bool"},
                        {"id": "mood", "title": "mood", "type": "choice",
                         "options": ["calm", "busy"]},
                    ],
                    "rows": [
                        {"id": "r1",
                         "cells": {"key": "unicode: \u00e9\u4e2d\u6587",
                                   "count": 1.5, "done": True, "mood": "calm"}},
                        {"id": "r2",
                         "cells": {"key": "", "count": 0, "done": False, "mood": "busy"}},
                    ],
                },
            },
        ],
        "links": [
            {"id": "l1", "from": "e2e-editor", "to": "e2e-note", "label": "e2e"},
            {"id": "l2", "from": "e2e-editor", "to": "e2e-sheet", "label": "data"},
        ],
    }


def board_arrays(loaded) -> tuple:
    """Accept ``{cards, links}``, ``{board: ...}`` and the kernel's ``{document: ...}``.

    ``view.load`` answers ``{path, revision, document}``; a client that kept the
    document under ``board`` is tolerated too.
    """
    require(isinstance(loaded, dict), "view.load did not return an object")
    if "cards" in loaded or "links" in loaded:
        return loaded.get("cards"), loaded.get("links")
    for key in ("document", "board"):
        inner = loaded.get(key)
        if isinstance(inner, dict):
            return inner.get("cards"), inner.get("links")
    raise CheckFailed(
        f"view.load returned neither cards, document nor board: {_short(loaded)}"
    )


def normalise_tokens(tokens, text_len: int) -> list:
    """Return ``(start, end, kind)`` triples from either wire shape.

    *text_len* is the input's length in the tokenizer's index space (see
    :func:`js_length`), not ``len(text)`` -- a span is judged against the same
    units the tokenizer counted in.  The shell sends ``[start, end, kind]``
    arrays; object tokens are accepted too so the check keeps working against an
    older kernel-side tokenizer.
    """
    spans = []
    for token in tokens:
        if isinstance(token, dict):
            start, end, kind = token.get("start"), token.get("end"), token.get("kind")
        elif isinstance(token, (list, tuple)) and len(token) == 3:
            start, end, kind = token[0], token[1], token[2]
        else:
            raise CheckFailed(f"token is neither [start, end, kind] nor an object: {_short(token)}")
        require(
            isinstance(start, int) and isinstance(end, int) and isinstance(kind, str),
            f"token {_short(token)} needs int start/end and a string kind",
        )
        require(
            0 <= start < end <= text_len,
            f"token span {start}..{end} is outside the {text_len}-unit text",
        )
        spans.append((start, end, kind))
    return spans


def check_lang_entry(entry) -> str:
    """Validate one ``lang.list`` entry; returns its id.

    The wire contract is ``{id: string, title: string, extensions: list}`` and
    nothing more is required of a language -- the driver must not assume any
    particular id, because which descriptors ship is a fork's decision.
    """
    require(isinstance(entry, dict), f"lang.list entry is not an object: {_short(entry)}")
    for key, kind in (("id", str), ("title", str), ("extensions", list)):
        require(
            isinstance(entry.get(key), kind),
            f"lang {entry.get('id')!r}: {key} is not a {kind.__name__}",
        )
    require(entry["id"] != "", f"lang.list entry has an empty id: {_short(entry)}")
    for extension in entry["extensions"]:
        require(
            isinstance(extension, str) and extension.startswith("."),
            f"lang {entry['id']!r}: extension {extension!r} is not a string like '.yarn'",
        )
    return entry["id"]


def check_token(kind, start, end, text_len: int) -> None:
    """Validate one token against the wire contract, for any language.

    Deliberately kind-agnostic: a Yarn ``command``, a JSON ``keyword`` and a
    plain ``ident`` all satisfy the same shape, and the only kinds allowed on the
    wire are the ones ``langs/lang.mjs`` publishes.
    """
    require(
        kind in TOKEN_KINDS,
        f"token {start}..{end} has unknown kind {kind!r} "
        f"(expected one of {', '.join(TOKEN_KINDS)})",
    )


def define_checks(h: Harness) -> list:
    """Return the scenario as ``(name, check, requires)`` triples.

    ``requires`` is ``None`` for every endpoint, or ``"full"`` for the language
    services that only the shell multiplexer serves.
    """
    client, ctx = h.client, h.ctx

    def hello():
        result = client.call("hello", {})
        require(isinstance(result, dict), "hello result is not an object")
        require(isinstance(result.get("protocol"), int), "hello.protocol is not an int")
        require(isinstance(result.get("kernel_version"), str), "hello.kernel_version is not a string")
        require(isinstance(result.get("root"), str), "hello.root is not a string")
        ctx["root"] = result["root"]
        # The `exec.start` check asserts against this: the version is whatever
        # the live endpoint says it is, never a number written down here.
        ctx["expected"] = f"infantgod {result['kernel_version']} protocol"
        return f"protocol={result['protocol']} kernel_version={result['kernel_version']} root={result['root']}"

    def workspace_info():
        info = client.call("workspace.info", {})
        require(isinstance(info, dict), "workspace.info result is not an object")
        require(isinstance(info.get("root"), str), "workspace.info.root is not a string")
        require(isinstance(info.get("file_count"), int), "workspace.info.file_count is not an int")
        # `view_path`/`view_revision` describe the document the *kernel* is
        # holding right now, which -- this early in the run -- is whatever the
        # last process left.  A fresh kernel has read nothing, so an empty path
        # and revision 0 are the honest answer, not a missing member.
        require(isinstance(info.get("view_path"), str),
                "workspace.info.view_path is not a string")
        require(isinstance(info.get("view_revision"), (int, float)),
                "workspace.info.view_revision is not a number")
        if ctx["mode"] == "full":
            langs = info.get("langs")
            require(isinstance(langs, list), "workspace.info.langs is not a list (full mode)")
            require(langs, "workspace.info.langs is empty (full mode)")
            described = f"langs={len(langs)}"
        elif "langs" in info:
            require(isinstance(info.get("langs"), list), "workspace.info.langs is not a list")
            described = f"langs={len(info['langs'])} (not required in kernel mode)"
        else:
            described = "no langs member (kernel mode)"
        return f"root={info['root']} file_count={info['file_count']} {described}"

    def lang_list():
        result = client.call("lang.list", {})
        entries = result.get("langs") if isinstance(result, dict) else None
        require(isinstance(entries, list), "lang.list.langs is not a list")
        require(entries, "lang.list returned no languages at all")
        by_id = {check_lang_entry(entry): entry for entry in entries}
        # This checkout ships exactly two descriptors -- JSON and Yarn -- so
        # either one missing (or the list holding anything else) means the
        # language directory is not the one this suite was written for.  A real
        # assertion, not a demand for one particular id.
        for wanted in ("json", "yarn"):
            require(
                wanted in by_id,
                f"lang.list has no {wanted!r} language ({sorted(by_id)})",
            )
        require(
            ".yarn" in by_id["yarn"]["extensions"],
            f"lang 'yarn' declares extensions {by_id['yarn']['extensions']}, not '.yarn'",
        )
        return (
            f"{len(entries)} languages {sorted(by_id)}; "
            f"yarn extensions={by_id['yarn']['extensions']}"
        )

    def lang_tokenize():
        text = ctx["source_text"]
        result = client.call("lang.tokenize", {"path": ctx["fixture_path"], "text": text})
        require(isinstance(result, dict), "lang.tokenize result is not an object")
        tokens = result.get("tokens")
        require(isinstance(tokens, list), "lang.tokenize.tokens is not a list")
        require(tokens, "lang.tokenize returned no tokens for a non-empty file")
        lang = result.get("lang")
        require(lang is None or isinstance(lang, str), "lang.tokenize.lang is neither a string nor null")
        require(
            lang == "yarn",
            f"lang.tokenize.lang is {lang!r}, expected 'yarn' for a .yarn path",
        )
        length = ctx["source_units"]
        spans = normalise_tokens(tokens, length)
        # Kind-agnostic on purpose: the fixture is Yarn today, but the contract is
        # "valid triples with known kinds", not "a token of kind 'keyword'".
        for start, end, kind in spans:
            check_token(kind, start, end, length)
        ctx["tokens"] = spans
        return f"{len(spans)} tokens, kinds {sorted({kind for _, _, kind in spans})}, lang={lang!r}"

    def lang_tiling():
        """Spans must tile the input: start at 0, no gap, no overlap, end at length."""
        text = ctx["source_text"]
        length = ctx["source_units"]
        result = client.call("lang.tokenize", {"path": ctx["fixture_path"], "text": text})
        tokens = result.get("tokens") if isinstance(result, dict) else None
        require(isinstance(tokens, list) and tokens, "lang.tokenize returned no tokens")
        spans = normalise_tokens(tokens, length)
        cursor = 0
        for index, (start, end, kind) in enumerate(spans):
            require(
                start == cursor,
                f"tiling broke at token {index} ({kind}): starts at {start}, expected {cursor}",
            )
            cursor = end
        require(
            cursor == length,
            f"spans stop tiling at {cursor}, but the input is {length} units long",
        )
        return f"{len(spans)} spans tile 0..{length} with no gaps or overlaps"

    def file_read():
        result = client.call("file.read", {"path": ctx["fixture_path"]})
        require(isinstance(result, dict), "file.read result is not an object")
        # Hand the text and revision to the write checks before judging anything
        # else, so one unmet expectation cannot cascade into them.
        require(isinstance(result.get("text"), str), "file.read.text is not a str")
        require(_is_id(result.get("revision")), "file.read.revision is not an int or string")
        ctx["revision"] = result["revision"]
        ctx["file_text"] = result["text"]
        required = [("path", str), ("eol", str), ("size", int), ("mtime", int)]
        if ctx["mode"] == "full":
            # Only the shell knows languages; the kernel has no language layer.
            # The fixture is ``examples/hello.yarn``, so the detected id is not
            # decorative: it is the extension-to-language mapping, asserted.
            required.append(("lang", str))
        for key, kind in required:
            require(isinstance(result.get(key), kind), f"file.read.{key} is not a {kind.__name__}")
        require(
            result["eol"] in ("lf", "crlf"),
            f"file.read.eol is {result['eol']!r}, expected 'lf' or 'crlf'",
        )
        if ctx["mode"] == "full":
            require(
                result["lang"] == "yarn",
                f"file.read.lang is {result['lang']!r}, expected 'yarn' for {FIXTURE}",
            )
        elif "lang" in result:
            require(isinstance(result["lang"], str), "file.read.lang is not a str")
        described = f"revision={result['revision']} eol={result['eol']!r} size={result['size']}"
        if isinstance(result.get("lang"), str):
            described += f" lang={result['lang']}"
        return described

    def _write_fixture(text, base_revision):
        """Write ``text`` to the fixture and return the resulting revision."""
        result = client.call(
            "file.write",
            {"path": ctx["fixture_path"], "text": text, "base_revision": base_revision},
        )
        require(isinstance(result, dict), "file.write result is not an object")
        revision = result.get("revision")
        require(_is_id(revision), "file.write.revision is not an int or string")
        return revision

    def _restore_fixture(text):
        """Put the fixture's original bytes back, whatever revision it is at now.

        Called from ``finally`` blocks, where the file may have been moved on by
        a concurrent editor or by the check's own first write, so the base
        revision is re-read instead of remembered.  A restore that cannot run
        must never mask the failure it was cleaning up after, but it must not be
        silent either.
        """
        try:
            current = client.call("file.read", {"path": ctx["fixture_path"]})["revision"]
            client.call(
                "file.write",
                {"path": ctx["fixture_path"], "text": text, "base_revision": current},
            )
        except Exception as exc:  # noqa: BLE001 -- a restore may never raise
            sys.stderr.write(
                f"InfantGod Studio e2e: could not restore {ctx['fixture_path']}: {exc}\n"
            )

    def file_write():
        require(ctx.get("file_text") is not None, "file.read provided no text to write back")
        original, base = ctx["file_text"], ctx["revision"]
        # The revision is a content hash, so rewriting the same bytes would hand
        # back the base revision and prove nothing: make a real edit instead.
        edited = _write_fixture(original + REVISION_PROBE, base)
        try:
            require(
                edited != base,
                f"file.write of changed text returned the base revision {base}",
            )
            # Leave the workspace byte-identical to how it was found; identical bytes
            # hash back to the original revision, which is what proves the restore.
            restored = _write_fixture(original, edited)
            require(
                restored == base,
                f"restoring the original bytes gave revision {restored}, expected {base}",
            )
        finally:
            # The probe text is ours, not the developer's: if anything above
            # raised -- a stale revision because an editor, a formatter or a
            # `git checkout` touched the file mid-check -- the fixture must not
            # be left carrying it.  This is the same contract the sibling
            # checks already keep.
            _restore_fixture(original)
        return f"revision {base} -> {edited} -> {restored} (edited then restored)"

    def file_write_stale():
        require(ctx.get("file_text") is not None, "file.read provided no text to write back")
        original, base = ctx["file_text"], ctx["revision"]
        # Move the file on with one write, then offer the revision we read before
        # that write as the base of the next one, which must be refused.
        current = _write_fixture(original + REVISION_PROBE, base)
        try:
            error = client.expect_error(
                "file.write",
                {"path": ctx["fixture_path"], "text": original, "base_revision": base},
            )
            # The kernel names the error in `name` and numbers it in `code`; a
            # string `code` is accepted too so the check survives either spelling.
            code = error.get("name", error.get("code"))
            require(
                code == "STALE_REVISION",
                f"stale write reported {code!r} (code={error.get('code')!r}), "
                "expected 'STALE_REVISION'",
            )
            data = error.get("data")
            require(
                isinstance(data, dict) and "current_revision" in data,
                "STALE_REVISION carries no data.current_revision",
            )
            require(
                _is_id(data["current_revision"]),
                "STALE_REVISION data.current_revision is not an int or string",
            )
            require(
                data["current_revision"] == current,
                f"STALE_REVISION reports current_revision={data['current_revision']!r}, "
                f"but the file is at {current!r}",
            )
            detail = (
                f"stale base_revision={base} rejected with {code} "
                f"(current {data['current_revision']})"
            )
        finally:
            # Restore the fixture even if the expectation above did not hold.
            _write_fixture(original, current)
        return detail

    def path_containment():
        """A path outside the workspace root is refused, in both spellings.

        The fixture lives inside the root, so the escape target is a sibling of
        the repository directory: it is never created and never has to exist,
        because containment is decided before the file is looked up.
        """
        outside = str(REPO_ROOT.parent / "e2e-outside.yarn")
        for label, path in (("absolute", outside), ("relative", "../e2e-outside.yarn")):
            error = client.expect_error("file.read", {"path": path})
            code = error.get("code")
            require(
                code == 1003 or str(code) == "1003",
                f"{label} escape {path!r} reported code={code!r} "
                f"name={error.get('name')!r}, expected 1003",
            )
        return f"absolute and relative escapes both refused with 1003 (e.g. {outside})"

    # -- the byte verbs ----------------------------------------------------
    #
    # `file.read` refuses a file with a NUL in it and `file.write` can only carry
    # a JSON string, so neither can move a PNG.  An image is bytes, not text, and
    # the contract that has to hold for it is the one that already holds for
    # text: same containment, same cap, same revision track, same staleness
    # refusal.  The only promise that is new is the one in the verb's name.

    def _byte_scratch_path():
        return os.path.join(ctx["root"], BYTE_SCRATCH.replace("/", os.sep))

    def _remove_scratch():
        try:
            os.remove(_byte_scratch_path())
        except OSError:
            pass  # nothing was written, or a previous finally took it

    def _write_bytes(path, payload_b64, base_revision=None):
        params = {"path": path, "base64": payload_b64}
        if base_revision is not None:
            params["base_revision"] = base_revision
        return client.call("file.write_bytes", params)

    def byte_roundtrip():
        _remove_scratch()
        want = base64.b64encode(BYTE_PAYLOAD).decode("ascii")
        try:
            written = _write_bytes(BYTE_SCRATCH, want)
            require(isinstance(written, dict), "file.write_bytes result is not an object")
            require(
                written.get("size") == len(BYTE_PAYLOAD),
                f"file.write_bytes.size is {written.get('size')!r}, expected the "
                f"number of bytes written ({len(BYTE_PAYLOAD)}), not the number of "
                "characters sent",
            )
            # A byte write never looked at the bytes as lines, so it has no style
            # to report: inventing one would be the lie the text verb exists to
            # tell honestly.
            require(
                "eol" not in written,
                f"file.write_bytes reported eol={written.get('eol')!r}; a byte "
                "write has no line endings to speak of",
            )
            require(_is_id(written.get("revision")), "file.write_bytes.revision is not an int or string")

            read = client.call("file.read_bytes", {"path": BYTE_SCRATCH})
            require(isinstance(read, dict), "file.read_bytes result is not an object")
            require(
                read.get("base64") == want,
                "file.read_bytes did not return the bytes that were written",
            )
            require(
                read.get("size") == len(BYTE_PAYLOAD),
                f"file.read_bytes.size is {read.get('size')!r}, expected {len(BYTE_PAYLOAD)}",
            )
            require(_is_id(read.get("revision")), "file.read_bytes.revision is not an int or string")

            # The contrast that justifies the verb: the *text* read of the same
            # file is refused, by code, rather than returning a truncated string.
            error = client.expect_error("file.read", {"path": BYTE_SCRATCH})
            code = error.get("code")
            require(
                code == 1003 or str(code) == "1003",
                f"file.read of a binary file reported code={code!r} "
                f"name={error.get('name')!r}, expected 1003",
            )

            # And the byte write is on the same revision track as the text one:
            # identical bytes hash back to the revision they were read at.
            again = _write_bytes(BYTE_SCRATCH, want, read["revision"])
            require(
                again.get("revision") == read["revision"],
                f"rewriting the same bytes gave revision {again.get('revision')!r}, "
                f"expected {read['revision']!r}",
            )
            return (
                f"{len(BYTE_PAYLOAD)} bytes (every value 0x00-0xff, plus NUL and 0xff) "
                f"round-tripped; file.read still refuses it with 1003; revision {read['revision']}"
            )
        finally:
            _remove_scratch()

    def byte_write_stale():
        _remove_scratch()
        first = base64.b64encode(b"\x01\x02\x03").decode("ascii")
        moved = base64.b64encode(b"\x04\x05\x06\x07").decode("ascii")
        try:
            base = _write_bytes(BYTE_SCRATCH, first)["revision"]
            current = _write_bytes(BYTE_SCRATCH, moved, base)["revision"]
            require(current != base, f"a byte write of different bytes kept revision {base}")
            error = client.expect_error(
                "file.write_bytes",
                {"path": BYTE_SCRATCH, "base64": first, "base_revision": base},
            )
            code = error.get("name", error.get("code"))
            require(
                code == "STALE_REVISION",
                f"stale byte write reported {code!r} (code={error.get('code')!r}), "
                "expected 'STALE_REVISION'",
            )
            data = error.get("data")
            require(
                isinstance(data, dict),
                "STALE_REVISION from a byte write carries no data object",
            )
            require(
                data.get("current_revision") == current,
                f"STALE_REVISION from a byte write reports "
                f"current_revision={data.get('current_revision')!r}, but the file is at {current!r}",
            )
            return f"byte write with base_revision={base} refused (current {current})"
        finally:
            _remove_scratch()

    def byte_payload_rejected():
        _remove_scratch()
        cases = [
            ("a character outside the alphabet", "!!!not-base64!!!"),
            ("a length that is not a multiple of four", "AAA"),
            ("padding in the middle", "AA==AAAA"),
            ("a line break", "AA\nAA"),
        ]
        try:
            for label, payload in cases:
                error = client.expect_error(
                    "file.write_bytes", {"path": BYTE_SCRATCH, "base64": payload}
                )
                code = error.get("name", error.get("code"))
                require(
                    code == "INVALID_PARAMS",
                    f"{label} ({payload!r}) reported {code!r} "
                    f"(code={error.get('code')!r}), expected 'INVALID_PARAMS'",
                )
            # A *forgotten* member is not an empty file, the same way for
            # `file.write` an absent `text` is not an empty file.
            error = client.expect_error("file.write_bytes", {"path": BYTE_SCRATCH})
            require(
                error.get("name", error.get("code")) == "INVALID_PARAMS",
                "file.write_bytes without `base64` was not INVALID_PARAMS",
            )
            # Which is what makes this the real test of the pair: a genuinely
            # empty payload *is* a file of zero bytes.
            empty = _write_bytes(BYTE_SCRATCH, "")
            require(
                empty.get("size") == 0,
                f"writing an empty payload reported size={empty.get('size')!r}, expected 0",
            )
            back = client.call("file.read_bytes", {"path": BYTE_SCRATCH})
            require(
                back.get("base64") == "",
                f"an empty file read back as {back.get('base64')!r}",
            )
            return f'{len(cases)} malformed payloads and a missing member refused; "" writes 0 bytes'
        finally:
            _remove_scratch()

    def byte_path_containment():
        """The byte verbs keep the containment the text verbs keep.

        Worth its own check rather than a comment: a second verb that resolves
        paths is a second chance to forget the rule, and the files it would leak
        are images, which no human reads before they are gone.
        """
        outside = str(REPO_ROOT.parent / "e2e-outside.png")
        for label, path in (("absolute", outside), ("relative", "../e2e-outside.png")):
            for method in ("file.read_bytes", "file.write_bytes"):
                params = {"path": path}
                if method == "file.write_bytes":
                    params["base64"] = base64.b64encode(b"\x89PNG").decode("ascii")
                error = client.expect_error(method, params)
                code = error.get("code")
                require(
                    code == 1003 or str(code) == "1003",
                    f"{method} {label} escape {path!r} reported code={code!r} "
                    f"name={error.get('name')!r}, expected 1003",
                )
        return f"both byte verbs refuse absolute and relative escapes with 1003 ({outside})"

    def board_state():
        """Read the live board so a check that saves one can put it back.

        The board is project state, not test scratch space: a suite that
        silently discards where the developer put everything is testing the
        wrong product.  The **whole** document is kept, not just the two arrays
        this suite happens to know about -- rebuilding it by hand is exactly how
        the viewport (where the developer put the camera) got reset on every
        run, silently and with exit 0.

        The kernel answers with the document it is holding, so "was there one
        before the run" is not something its reply can say: this suite reads the
        path it named itself.  That is the point of the split -- the client owns
        the path, the kernel owns the bytes.
        """
        loaded = client.call("view.load", {"path": DOCUMENT_PATH})
        document = loaded.get("document") if isinstance(loaded, dict) else None
        absolute = os.path.join(ctx["root"], DOCUMENT_PATH.replace("/", os.sep))
        return {
            "document": (
                json.loads(json.dumps(document)) if isinstance(document, dict) else None
            ),
            "path": absolute,
            "existed": os.path.exists(absolute),
        }

    def board_restore(state):
        """Put the board back, or remove the one the suite created."""
        if state["existed"]:
            # The document on disk is the developer's; one that could not be read
            # is not ours to rewrite, so only a document that was read goes back.
            if state["document"] is not None:
                client.call(
                    "view.save",
                    {"path": DOCUMENT_PATH, "document": state["document"]},
                )
            return
        if state["path"] and os.path.basename(state["path"]) == "board.json":
            # No board before the run, none after it either -- and no empty
            # state directory left behind where the board used to be.  There is
            # no document to put back in this case (that is why one is absent),
            # so this branch, not a return, is what keeps the suite from leaving
            # its own scratch document where the app looks for the real board.
            try:
                os.remove(state["path"])
            except OSError:
                pass  # a check failed before anything was written
            try:
                os.rmdir(os.path.dirname(state["path"]))
            except OSError:
                pass  # something else lives there, or it was never created

    def board_roundtrip():
        state = board_state()
        try:
            board = build_board(ctx)
            saved = client.call("view.save", {"path": DOCUMENT_PATH, "document": board})
            require(isinstance(saved, dict), "view.save result is not an object")
            require(_is_id(saved.get("revision")), "view.save.revision is not an int or string")
            require(saved.get("saved") is True, "view.save.saved is not true")
            loaded = client.call("view.load", {"path": DOCUMENT_PATH})
            cards, links = board_arrays(loaded)
            require(
                cards == board["cards"],
                f"cards did not round-trip: sent {_short(board['cards'])} got {_short(cards)}",
            )
            require(
                links == board["links"],
                f"links did not round-trip: sent {_short(board['links'])} got {_short(links)}",
            )
            # The document travels under one name.  A client that puts it
            # somewhere else gets an answer, not a silently stored nothing.
            error = client.expect_error(
                "view.save", {"path": DOCUMENT_PATH, "board": board}
            )
            code = error.get("name", error.get("code"))
            require(
                code == "INVALID_PARAMS",
                f"a document under the wrong member was refused with {code!r}",
            )
            detail = (
                f"{len(cards)} cards and {len(links)} links round-tripped exactly "
                f"(revision {saved['revision']})"
            )
        finally:
            try:
                board_restore(state)
            except Exception:
                pass

        return detail

    def starter_board():
        """The board shipped for a fresh clone must survive the store untouched.

        `examples/board.json` is what `tools/demo.py` installs into a new
        workspace, and it is the board the README's screenshots show.  The
        kernel no longer validates it -- a document's shape is the client's
        business, and the client's reader lives in `shell/web/board.mjs` -- so
        what this check can still prove is the other half of the contract: the
        shipped bytes, viewport included, come back exactly as they went in.
        A starter board that a *client* would mangle is caught where the client
        runs: `shell/web/selftest.mjs` and `make smoke`.
        """
        path = REPO_ROOT / "examples" / "board.json"
        require(path.is_file(), f"{path} is missing")
        with open(path, "rb") as handle:
            raw = handle.read()
        try:
            document = json.loads(raw.decode("utf-8"))
        except (UnicodeDecodeError, ValueError) as exc:
            require(False, f"{path} is not UTF-8 JSON: {exc}")
        require(isinstance(document, dict), f"{path} is not an object")
        cards = document.get("cards")
        links = document.get("links")
        require(isinstance(cards, list) and cards, f"{path} carries no cards")
        require(isinstance(links, list), f"{path} carries no links array")

        state = board_state()
        try:
            saved = client.call(
                "view.save", {"path": DOCUMENT_PATH, "document": document}
            )
            require(isinstance(saved, dict), "the starter board was not accepted")
            require(saved.get("saved") is True, "the starter board was not saved")
            loaded = client.call("view.load", {"path": DOCUMENT_PATH})
            got_cards, got_links = board_arrays(loaded)
            require(
                got_cards == cards,
                f"starter cards did not round-trip: sent {len(cards)}, got {_short(got_cards)}",
            )
            require(
                got_links == links,
                f"starter links did not round-trip: sent {len(links)}, got {_short(got_links)}",
            )
            kept = loaded.get("document") if isinstance(loaded, dict) else {}
            viewport = kept.get("viewport") if isinstance(kept, dict) else None
            require(
                viewport == document.get("viewport"),
                f"the starter viewport did not survive: sent {document.get('viewport')!r} "
                f"got {viewport!r}",
            )
        finally:
            try:
                board_restore(state)
            except Exception:
                pass
        return (
            f"{len(cards)} cards and {len(links)} links from {len(raw)} shipped bytes "
            "accepted and stored exactly"
        )

    def exec_run():
        """A real child process, its exit code, and its captured stdout.

        The command is the kernel run at **itself**: ``"<infantgod>" version``
        with the workspace as cwd.  That choice keeps the check honest without
        inventing anything:

        * it is a genuine process spawn with a real exit code, not a mock;
        * it needs no fixture file and no interpreter, so the check cannot be
          broken by one of the project's languages being removed;
        * the expected stdout is *derived from the endpoint*, not hard-coded --
          ``ctx['expected']`` is whatever ``hello`` reported as
          ``kernel_version``, and the assertion is that the child's stdout
          carries ``infantgod <that version> protocol``.  A checked-in version
          number would have to be edited every release, and a bare substring
          match would pass on a value like ``"1"``, which is no assertion at all;
        * the kernel binary is addressed through ``KERNEL_BINARY`` rather than
          through the endpoint argv, so the same command proves the same thing
          in *full* mode, where argv[0] is ``node`` and the kernel is a child of
          the shell, not of this driver.

        The stdout is decoded with :func:`scrubbed`, which is what "captured and
        sanitised" means here: invalid UTF-8 becomes U+FFFD instead of an
        exception, so a child that writes a Windows code page still yields a
        readable, assertable string.
        """
        result = client.call(
            "exec.start", {"card_id": ctx["card_id"], "cmd": ctx["cmd"], "cwd": ctx["cwd"]}
        )
        require(isinstance(result, dict), "exec.start result is not an object")
        run_id = result.get("run_id")
        require(_is_id(run_id), "exec.start.run_id is not an int or string")

        def belongs(event):
            if event.get("event") not in ("exec.output", "exec.exit"):
                return False
            return event.get("run_id", run_id) == run_id

        deadline = time.monotonic() + client.timeout
        stdout, stderr, finished, exit_code = bytearray(), bytearray(), False, None
        while not finished:
            remaining = deadline - time.monotonic()
            require(remaining > 0, f"run {run_id} produced no exec.exit within {client.timeout:g}s")
            event = client.wait_event(belongs, f"exec.output/exec.exit for run {run_id}", remaining)
            if event["event"] == "exec.output":
                channel = str(event.get("stream", event.get("channel", "stdout")))
                data = event.get("data", event.get("text", ""))
                (stderr if channel == "stderr" else stdout).extend(str(data).encode("utf-8", "replace"))
            else:
                exit_code = event.get("code", event.get("exit_code"))
                finished = True

        text = scrubbed(bytes(stdout))
        require(
            exit_code == 0,
            f"run {run_id} exited with {exit_code!r}; stderr={scrubbed(bytes(stderr))[:200]!r}",
        )
        require(
            ctx["expected"] in text,
            f"stdout {text[:200]!r} does not contain the expected output {ctx['expected']!r}",
        )
        return f"run {run_id} exit 0, stdout {text!r}"

    return [
        ("hello", hello, None),
        ("workspace.info", workspace_info, None),
        ("lang.list", lang_list, "full"),
        ("lang.tokenize", lang_tokenize, "full"),
        ("lang.tokenize tiling", lang_tiling, "full"),
        ("file.read", file_read, None),
        ("file.write", file_write, None),
        ("file.write stale revision", file_write_stale, None),
        ("file.read path containment", path_containment, None),
        ("file.read_bytes/file.write_bytes round-trip", byte_roundtrip, None),
        ("file.write_bytes stale revision", byte_write_stale, None),
        ("file.write_bytes malformed payload", byte_payload_rejected, None),
        ("byte verbs path containment", byte_path_containment, None),
        ("view.save/view.load round-trip", board_roundtrip, None),
        ("starter board", starter_board, None),
        ("exec.start run", exec_run, None),
    ]


def run_scenario(client: RpcClient, ctx: dict, style: Style, keep_going: bool, stream):
    """Run every check, stopping at the first failure unless *keep_going*."""
    harness = Harness(client, ctx, style, keep_going, stream)
    checks = define_checks(harness)
    for index, (name, check, requires) in enumerate(checks):
        if requires == "full" and ctx["mode"] != "full":
            harness.skip(name, "kernel mode: languages are served by the shell, not the kernel")
            continue
        if not harness.run(name, check) and not keep_going:
            for skipped_name, _, _ in checks[index + 1:]:
                harness.results.append(
                    {
                        "name": skipped_name,
                        "ok": False,
                        "detail": "not run",
                        "skipped": True,
                        "mode_skip": False,
                    }
                )
            break
    return harness.results


def report(results, style: Style, stream, extra: str = "") -> int:
    """Print the summary and return the process exit code."""
    passed = [item for item in results if item["ok"] and not item.get("mode_skip")]
    failed = [
        item
        for item in results
        if not item["ok"] and not item.get("skipped") and not item.get("mode_skip")
    ]
    stopped = [item for item in results if item.get("skipped")]
    mode_skipped = [item for item in results if item.get("mode_skip")]
    parts = [style.ok(f"{len(passed)} passed"), style.bad(f"{len(failed)} failed")]
    skipped_text = f"{len(stopped) + len(mode_skipped)} skipped"
    if mode_skipped:
        skipped_text += f" ({len(mode_skipped)} not served in this mode)"
    parts.append(skipped_text)
    print(f"summary: {', '.join(parts)} ({len(results)} checks)", file=stream, flush=True)
    if stopped:
        print(style.dim("stopped after the first failure; re-run with --keep-going"), file=stream)
    if extra:
        print(style.dim("kernel stderr (tail):"), file=stream)
        for line in extra.splitlines()[-20:]:
            print(style.dim(f"  {line}"), file=stream)
    return 0 if (not failed and not stopped and passed) else 1


def _build_parser() -> argparse.ArgumentParser:
    parser = _Parser(
        prog="e2e.py",
        description="Drive the InfantGod Studio kernel RPC scenario. Exit codes: 0 pass, 1 fail, 2 driver error, 3 usage.",
    )
    parser.add_argument(
        "--kernel",
        default=None,
        metavar="PATH",
        help=f"kernel binary, spawned as `<PATH> rpc` (default {KERNEL_DEFAULT})",
    )
    parser.add_argument(
        "--kernel-cmd",
        metavar="CMD",
        help='full endpoint command line, spawned verbatim, e.g. "node shell/main.mjs rpc --workspace ."',
    )
    parser.add_argument(
        "--timeout", type=float, default=15.0, metavar="SEC", help="per-request timeout (default 15)"
    )
    parser.add_argument("--keep-going", action="store_true", help="run every check after a failure")
    parser.add_argument("--json", action="store_true", help="write the report as JSON on stdout")
    return parser


def main(argv=None) -> int:
    """Entry point; returns the process exit code."""
    args = _build_parser().parse_args(argv)
    stream = sys.stderr if args.json else sys.stdout
    style = Style(colour_enabled(stream))
    started = time.monotonic()

    def fail_start(message: str) -> int:
        print(f"e2e.py: {message}", file=sys.stderr)
        if args.json:
            print(json.dumps({"ok": False, "error": message}, indent=2))
        return 2

    try:
        argv_infantgod, mode = resolve_endpoint(args)
        fixture = resolve_fixture()
        # The `exec.start` check runs the kernel at itself, so the command line
        # is fixed here rather than derived from the endpoint: in full mode the
        # endpoint is the shell, and the shell's argv[0] is `node`.
        kernel = resolve_argv(str(KERNEL_BINARY), explicit=True)
    except DriverError as exc:
        return fail_start(str(exc))

    ctx = {
        "mode": mode,
        "fixture_path": fixture["path"],
        "source_text": fixture["text"],
        "source_units": js_length(fixture["text"]),
        # Filled in by `hello`; the suite cannot know the version until then.
        "expected": "",
        "card_id": "e2e-editor",
        "cwd": str(REPO_ROOT),
        # Quoted because the workspace path may contain spaces and this string
        # goes straight to CreateProcessA as a raw command line.
        "cmd": f'"{" ".join(kernel)}" version',
    }

    if not args.json:
        print(style.bold(f"InfantGod Studio e2e [{mode} mode]: {' '.join(argv_infantgod)}"))
        print(style.dim(f"fixture   : {fixture['path']} ({ctx['source_units']} units)"))
        print(style.dim(f"exec cmd  : {ctx['cmd']}"))
        if mode == "kernel":
            print(style.dim("note      : kernel mode skips lang.list / lang.tokenize"))
        print(style.dim("-" * 68))

    client = RpcClient(argv_infantgod, args.timeout)
    results, stderr_tail = [], ""
    try:
        client.start()
        results = run_scenario(client, ctx, style, args.keep_going, stream)
    except DriverError as exc:
        stderr_tail = client.stderr_tail()
        if not results:
            return fail_start(str(exc))
        print(style.bad(f"FAIL driver: {exc}"), file=stream)
    except KeyboardInterrupt:
        print(style.bad("interrupted"), file=stream)
        return 130
    finally:
        client.close()

    stderr_tail = stderr_tail or client.stderr_tail()
    code = report(results, style, stream, stderr_tail)

    if args.json:
        passed = sum(1 for item in results if item["ok"] and not item.get("mode_skip"))
        failed = sum(
            1
            for item in results
            if not item["ok"] and not item.get("skipped") and not item.get("mode_skip")
        )
        skipped = sum(1 for item in results if item.get("skipped") or item.get("mode_skip"))
        print(
            json.dumps(
                {
                    "ok": code == 0,
                    "mode": mode,
                    "endpoint": argv_infantgod,
                    "fixture": fixture["path"],
                    "duration_s": round(time.monotonic() - started, 3),
                    "passed": passed,
                    "failed": failed,
                    "skipped": skipped,
                    "checks": results,
                },
                indent=2,
            )
        )
    return code


if __name__ == "__main__":
    sys.exit(main())
