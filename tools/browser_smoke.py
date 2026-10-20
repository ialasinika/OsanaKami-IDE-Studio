#!/usr/bin/env python3
"""browser_smoke.py -- the real-browser smoke test for the OsanaKami IDE Studio board UI.

    python tools/browser_smoke.py [--port N] [--edge PATH] [--timeout S] [--keep]

Every other check in this repository speaks to the kernel over stdin/stdout
(``tools/e2e.py``) or imports the browser modules under Node
(``shell/web/selftest.mjs``).  Neither can see the one thing a user actually
looks at: the served page, the HUD the shell paints into it, and the board the
kernel hands back.  This script closes that gap with the smallest possible
machine: the host is started exactly as a developer starts it, the system
browser fetches the page with ``--dump-dom`` (no web driver, no CDP, no
websocket -- the tool this repository already uses for its screenshots), and
every assertion is a substring of the DOM the browser itself produced.

What it proves, in order:

1. ``kernel ready``  -- boot reached the kernel.  The status span only carries
   that text after ``client.ready()`` resolved, so it is the HUD telling the
   truth about a live ``POST /rpc``, not a static label in ``index.html``
   (which ships the empty string).
2. ``workspace <root>``  -- the resolved workspace root was reported and is on
   the page.  The negative half is the load-bearing one: the string ``was not
   reported by the kernel`` must be ABSENT.  That sentence is what the project
   panel paints when it mounts before ``workspace.info`` resolves; a real
   defect shipped once where the panel was drawn early and then never
   repainted, so the panel and the HUD disagreed about which project was open.
3. the board painted -- ``.infantgod/board.json`` is read as data, its first
   ``editor`` card's ``file`` must appear in the DOM, and (when the board has
   one) the first 40 characters of a ``note`` card's text must appear too.
   Both come from the live board, so this asserts that the *file on disk*
   reached the screen rather than that some hardcoded path did.
4. the command bar shipped -- ``#command`` and ``#command-hint`` are in the DOM
   and the module that defines the command vocabulary (``COMMAND_HELP`` in
   ``shell/web/cards.mjs``, imported by ``main.mjs`` at load time) ran to
   completion.  This is the weakest of the five; the PASS line says so
   explicitly, and the honesty notes below explain why.

Housekeeping, because this script drives the developer's real workspace:

* the host is a ``subprocess.Popen`` whose exact pid is terminated in a
  ``finally`` -- never a blanket kill of ``node``, which would take the
  harness's own node down with it;
* ``.infantgod/board.json`` is snapshotted byte-for-byte before the host starts and
  written back in a ``finally``, and the byte-identity of that restore is
  printed.  The host rewrites that file on any mutation, so a smoke test that
  forgot this would quietly reorder a user's board on every run;
* the port is picked by binding to port 0 and closing the socket, so two
  concurrent runs cannot collide;
* the browser profile is a throwaway directory that is deleted afterwards
  (kept when ``--keep`` was asked, or when the run never produced a DOM and the
  debris is worth inspecting).

Honesty about what is *not* proven here:

* no input is synthesized, so the command-bar hint (``#command-hint``) is empty
  in the dump -- it is filled by a keydown/input listener.  The shipped command
  rows live in a JavaScript array, not in the served markup, so the assertion
  in check 4 is about the *bar and its module* rather than about the hint text,
  and its PASS line names that limit.  It cannot catch a hint that fails to
  populate on a real keystroke.
* ``--dump-dom`` gives one serialized snapshot per browser launch, so text that
  reaches the page as markup is re-escaped (``&`` -> ``&amp;``), and text that
  lives in a ``<textarea>``'s ``value`` property is not serialized at all.  The
  note check names both limits in its failure message rather than papering over
  them.
* the five assertions above judge one dump of the board.  After them the run
  drives a *second* page: the new-mod round trip scaffolds a package in a
  throwaway workspace and lets a same-origin wrapper page
  (``shell/web/__browser_smoke_mod.html``, written and removed by the run)
  frame the app and click and type into it.  Its six checks cover what the
  0.1.0 new-mod defect broke -- the default mod view, ``?mod=`` opening the
  package the menu created, the three headings opening their files, a save's
  own echo not being read as another writer, a real external write still
  warning, and a wrong relative name failing visibly.
* a *third* page follows: the card round trip opens one card of every kind the
  board ships from the command line, then walks both tiles and presses each
  card's tab (or focuses the part of the tile it already fills) and reports
  whether the root element is drawn and can take the keyboard.  Its checks
  cover G29: every kind is reachable in both views, and no view hides a card
  without offering the tab that brings it back.
* a green run says the page booted, the HUD and the board agree, the command
  vocabulary shipped, the new-mod path works, and every card kind is reachable
  -- not that the UI is correct in any wider sense.

Exit codes
    0   every check passed -- or the browser is not installed (a SKIP line)
    1   the browser was available and at least one check failed
    2   the smoke test could not run (host never listened, browser never
        produced a DOM, malformed ``--port``)
    3   the command line was malformed
"""

from __future__ import annotations

import argparse
import base64
import html
import json
import os
import re
import shutil
import socket
import struct
import subprocess
import sys
import tempfile
import threading
import time
import urllib.error
import urllib.parse
import urllib.request
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parents[1]
SHELL_MAIN = REPO_ROOT / "shell" / "main.mjs"
BOARD_PATH = REPO_ROOT / ".infantgod" / "board.json"
STARTER_BOARD = REPO_ROOT / "examples" / "board.json"

#: Where the system browser normally lives on Windows.  ``--edge`` overrides it,
#: and so does ``INFANTGOD_BROWSER`` -- the same variable ``shell/main.mjs``
#: honours when it opens a window.  The bases come from the environment, never
#: from a directory written into this file: that is wrong on every other machine.
EDGE_CANDIDATES = tuple(
    Path(base, "Microsoft", "Edge", "Application", "msedge.exe")
    for base in (os.environ.get("ProgramFiles(x86)"), os.environ.get("ProgramFiles"))
    if base
)

#: Headless flags proven in this repository for screenshots and DOM dumps.
#: ``--virtual-time-budget`` lets the browser run the page's timers as fast as
#: it can and then stop, so ``--dump-dom`` is deterministic instead of a race.
EDGE_FLAGS = (
    "--headless=new",
    "--disable-gpu",
    "--no-first-run",
    "--no-default-browser-check",
    "--window-size=1700,1000",
    "--virtual-time-budget=9000",
)

#: The sentence the project panel paints when ``workspace.info`` has not
#: resolved yet.  Its presence in the DOM is the shipped defect, so it is
#: asserted absent rather than merely searched for.
STALE_PANEL_TEXT = "was not reported by the kernel"

#: The HUD state that is only written once the RPC client is actually ready.
READY_TEXT = "kernel ready"

#: The two spellings of the boot log's workspace line.  ``main.mjs`` resolves
#: the flag with Node's own path rules, which render Windows separators as
#: forward slashes (``workspace <checkout>``), while the flag a developer
#: types -- and the one printed by ``serve`` -- keeps backslashes.  Both are the
#: same root, so both count; see ``workspace_lines``.
WORKSPACE_TEXTS = (
    f"workspace {REPO_ROOT}",
    "workspace " + str(REPO_ROOT).replace("\\", "/"),
)


class DriverError(Exception):
    """The smoke test itself could not run (unusable options, dead host, ...)."""


class CheckFailed(Exception):
    """An assertion about the served page did not hold."""


class _Parser(argparse.ArgumentParser):
    """ArgumentParser that reports usage errors with the documented exit code."""

    def error(self, message: str) -> None:
        self.print_usage(sys.stderr)
        print(f"browser_smoke.py: usage error: {message}", file=sys.stderr)
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


def show(label: str, detail=None) -> None:
    """One aligned ``label : detail`` line; the smoke test's only printer."""
    prefix = f"{label:<22}"
    if detail is None or detail == "":
        print(prefix)
        return
    lines = str(detail).splitlines() or [""]
    print(f"{prefix}{lines[0]}")
    pad = " " * len(prefix)
    for line in lines[1:]:
        print(f"{pad}{line}")


def require(condition, message: str) -> None:
    """Raise :class:`CheckFailed` unless *condition* is true."""
    if not condition:
        raise CheckFailed(message)


def _short(text, limit: int = 200) -> str:
    """A single-line, bounded rendering of *text* for a failure message."""
    flat = " ".join(str(text).split())
    return flat if len(flat) <= limit else flat[:limit] + "..."


def _close_fds() -> bool:
    """``close_fds`` for the host: Windows needs False to inherit the pipe."""
    return False if os.name == "nt" else True


# --------------------------------------------------------------------------
# the host


def free_port() -> int:
    """Return a port the OS just handed out: bind to 0, read it, release it."""
    with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as sock:
        sock.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
        sock.bind(("127.0.0.1", 0))
        return int(sock.getsockname()[1])


def terminate(proc, grace: float = 5.0) -> bool:
    """Terminate exactly *proc*; return True once it is gone.

    Tracking the pid is the whole point: ``taskkill /IM node.exe`` (or the
    equivalent) would kill the harness, which runs on node.
    """
    if proc is None or proc.poll() is not None:
        return proc is None or proc.poll() is not None
    proc.terminate()
    try:
        proc.wait(timeout=grace)
        return True
    except subprocess.TimeoutExpired:
        proc.kill()
        try:
            proc.wait(timeout=grace)
            return True
        except subprocess.TimeoutExpired:
            return False


class Host:
    """The ``node shell/main.mjs serve`` child, started and killed by pid."""

    def __init__(self, port: int, argv=None):
        self.port = int(port)
        self.argv = list(argv) if argv is not None else [
            "node",
            str(SHELL_MAIN),
            "serve",
            "--workspace",
            str(REPO_ROOT),
            "--port",
            str(self.port),
            "--no-open",
        ]
        self.proc = None
        self.url = f"http://127.0.0.1:{self.port}/"
        self._lines = []
        self._ready = threading.Event()
        self._thread = None

    def start(self) -> "Host":
        """Spawn the host and begin draining its output."""
        try:
            self.proc = subprocess.Popen(
                self.argv,
                cwd=str(REPO_ROOT),
                stdin=subprocess.DEVNULL,
                stdout=subprocess.PIPE,
                stderr=subprocess.STDOUT,
                close_fds=_close_fds(),
            )
        except OSError as exc:
            raise DriverError(f"cannot start {self.argv[0]!r}: {exc}") from exc
        self._thread = threading.Thread(target=self._drain, daemon=True)
        self._thread.start()
        return self

    def _drain(self) -> None:
        """Read the host's stdout line by line; flag the address banner.

        The pipe is drained continuously on purpose: a host that blocks writing
        to a full pipe would look like a hang, and the failure would blame the
        browser instead of the plumbing.
        """
        try:
            for raw in iter(self.proc.stdout.readline, b""):
                line = raw.decode("utf-8", "replace").rstrip()
                self._lines.append(line)
                if line.strip().startswith("board ") and "http://" in line:
                    self._ready.set()
        except (OSError, ValueError):
            pass
        finally:
            self._ready.set()

    def wait_ready(self, timeout: float) -> str:
        """Block until the host prints its URL; raise :class:`DriverError`."""
        deadline = time.monotonic() + timeout
        while not self._ready.wait(0.25):
            if self.proc.poll() is not None:
                self._ready.wait(0.2)
                break
            if time.monotonic() >= deadline:
                raise DriverError(
                    f"the host printed no address within {timeout:g}s "
                    f"(exit {self.proc.poll()})\n{self.tail()}"
                )
        self._ready.wait(0.2)
        if self.proc.poll() is not None and not any("http://" in line for line in self._lines):
            raise DriverError(f"the host exited with {self.proc.poll()}\n{self.tail()}")
        return "\n".join(self._lines[-6:])

    def probe(self, timeout: float = 5.0) -> int:
        """GET ``/`` and return the status code; raise when nothing answers."""
        request = urllib.request.Request(self.url, method="GET")
        try:
            with urllib.request.urlopen(request, timeout=timeout) as response:
                response.read(2048)
                return int(response.status)
        except urllib.error.HTTPError as exc:
            return int(exc.code)
        except (urllib.error.URLError, OSError) as exc:
            raise DriverError(f"GET {self.url} failed: {exc}") from exc

    def close(self) -> bool:
        """Terminate the exact pid and report whether it went away."""
        return terminate(self.proc)

    def tail(self, limit: int = 12) -> str:
        """The host's recent output, for a failure message."""
        return "\n".join(self._lines[-limit:])


# --------------------------------------------------------------------------
# the browser


def find_edge(explicit):
    """Return the browser to drive, or raise :class:`DriverError` when missing.

    ``--edge`` wins, then ``INFANTGOD_BROWSER`` (a value that names a missing
    file is ignored rather than fatal, because the variable is also read by
    ``shell/main.mjs`` for its own window and may name a browser this test
    cannot drive), then the usual install locations.
    """
    if explicit:
        path = Path(explicit).expanduser()
        if not path.is_file():
            raise DriverError(f"--edge is not a readable file: {path}")
        return path
    from_env = os.environ.get("INFANTGOD_BROWSER")
    if from_env:
        path = Path(from_env).expanduser()
        if path.is_file():
            return path
    for candidate in EDGE_CANDIDATES:
        if candidate.is_file():
            return candidate
    raise DriverError("no browser found at " + " or ".join(str(item) for item in EDGE_CANDIDATES))


def _ps_quote(text: str) -> str:
    """Single-quote *text* for PowerShell."""
    return "'" + str(text).replace("'", "''") + "'"


def _kill_stray(profile: Path) -> int:
    """Best-effort sweep of browsers still holding *profile*; returns the count.

    Only reached after a timeout, and always scoped to this run's throwaway
    profile directory -- never a blanket kill by image name.
    """
    if os.name == "nt":
        script = (
            "$p = " + _ps_quote(str(profile)) + "; $n = 0; "
            "Get-CimInstance Win32_Process -Filter \"Name='msedge.exe'\" -ErrorAction SilentlyContinue | "
            "ForEach-Object { if ($_.CommandLine -like \"*$p*\") { "
            "Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue; $n++ } }; $n"
        )
        try:
            done = subprocess.run(
                ["powershell", "-NoProfile", "-NonInteractive", "-Command", script],
                capture_output=True, timeout=60, check=False,
            )
            return int(done.stdout.decode("utf-8", "replace").strip() or 0)
        except (OSError, ValueError, subprocess.SubprocessError):
            return 0
    try:
        done = subprocess.run(["pkill", "-f", str(profile)], capture_output=True, timeout=30, check=False)
        return 1 if done.returncode == 0 else 0
    except (OSError, subprocess.SubprocessError):
        return 0


def dump_dom(edge, url: str, profile: Path, timeout: float, flags=EDGE_FLAGS):
    """Fetch *url* headless and return ``(dom, error)``; exactly one is None.

    ``error`` means the browser could not be run at all, as opposed to
    answering with a page: a leftover profile lock after a timeout is the usual
    cause, and the caller retries rather than reporting a false failure.

    ``flags`` exists for the round-trip section below, whose wrapper page awaits
    several RPCs and so needs a larger ``--virtual-time-budget`` than the board
    dump does.
    """
    argv = [str(edge), *flags, f"--user-data-dir={profile}", "--dump-dom", url]
    try:
        done = subprocess.run(argv, capture_output=True, timeout=timeout, check=False)
    except subprocess.TimeoutExpired:
        swept = _kill_stray(profile)
        note = f" (swept {swept} stray browser process(es) on this profile)" if swept else ""
        return None, f"{edge} did not finish within {timeout:g}s{note}"
    except OSError as exc:
        return None, f"cannot run {edge}: {exc}"
    text = done.stdout.decode("utf-8", "replace")
    if not text.strip():
        stderr = _short(done.stderr.decode("utf-8", "replace"), 300)
        suffix = f": {stderr}" if stderr else ""
        return None, f"the browser dumped no DOM (exit {done.returncode}){suffix}"
    return text, None


def dom_of(text: str) -> str:
    """Trim a dump to the markup, dropping any banner lines printed before it."""
    lowered = text.lower()
    for marker in ("<!doctype", "<html"):
        index = lowered.find(marker)
        if index > 0:
            return text[index:]
    return text


def _looks_painted(text: str) -> bool:
    """True when the dump shows a booted page, so a retry cannot improve it.

    Deliberately narrow: the HUD reached the ready state *and* some card markup
    exists.  A dump that only got as far as ``connecting...`` is worth retrying.
    """
    return READY_TEXT in text and "card-title" in text


def grab_dom(edge, url: str, profile: Path, timeout: float, budget: float, flags=EDGE_FLAGS, painted=None):
    """Keep dumping until the page looks painted, or *budget* seconds elapse.

    Returns ``(dom, launches, note)``.  ``--virtual-time-budget`` is
    deterministic from the page's point of view, but if the kernel answers one
    RPC after that budget expired the dump is genuinely incomplete; re-dumping
    is the cheap, honest fix, and the longest dump seen is the one reported.

    ``painted`` is the "a retry cannot improve this" predicate.  It defaults to
    the board's HUD-and-card test; the wrapper page below passes its own, since
    it has neither a HUD of its own nor any board markup outside the iframe.
    """
    painted = _looks_painted if painted is None else painted
    unfinished = (
        "the dump never showed both the ready HUD and a painted card"
        if painted is _looks_painted
        else "the wrapper page never reported its result"
    )
    deadline = time.monotonic() + budget
    launches, last_error, best = 0, "", ""
    while True:
        launches += 1
        raw, error = dump_dom(edge, url, profile, timeout, flags=flags)
        if raw is not None:
            text = dom_of(raw)
            if len(text) > len(best):
                best = text
            if painted(text):
                return text, launches, ""
            last_error = unfinished
        else:
            last_error = error
        remaining = deadline - time.monotonic()
        if remaining <= 0:
            break
        time.sleep(min(1.0, remaining))
    if best:
        return best, launches, last_error
    raise DriverError(f"the browser never produced a DOM within {budget:g}s: {last_error}")


# --------------------------------------------------------------------------
# the live board


def read_board(path: Path) -> dict:
    """Load ``.infantgod/board.json`` as data; raise :class:`CheckFailed` if unusable.

    Cards are found by walking the raw structure rather than by trusting one
    exact document shape, because the kernel is not the only writer of this
    file: it is user-editable, and ``tools/e2e.py`` writes its own cards too.
    """
    try:
        raw = path.read_text(encoding="utf-8")
    except OSError as exc:
        raise CheckFailed(f"cannot read the live board {path}: {exc}") from exc
    try:
        board = json.loads(raw)
    except ValueError as exc:
        raise CheckFailed(f"{path} is not valid JSON: {exc}") from exc
    require(isinstance(board, dict), f"{path} is not a JSON object")
    cards = board.get("cards")
    if not isinstance(cards, list):
        inner = board.get("document")
        cards = inner.get("cards") if isinstance(inner, dict) else None
    require(isinstance(cards, list), f"{path} has no cards array")
    return {"cards": cards, "bytes": len(raw.encode("utf-8"))}


def board_facts(board: dict) -> dict:
    """Pull the two card values this test asserts on out of a loaded board."""
    facts = {"count": len(board["cards"]), "file": None, "note": None, "kinds": []}
    for card in board["cards"]:
        if not isinstance(card, dict):
            continue
        kind = card.get("kind")
        facts["kinds"].append(str(kind))
        if kind == "editor" and facts["file"] is None:
            candidate = card.get("file")
            if isinstance(candidate, str) and candidate.strip():
                facts["file"] = candidate
        if kind == "note" and facts["note"] is None:
            text = card.get("text")
            if isinstance(text, str) and text.strip():
                facts["note"] = text
    return facts


# --------------------------------------------------------------------------
# the checks


class Harness:
    """Runs the named checks against one dumped DOM and records the outcomes."""

    def __init__(self, dom: str, style: Style, stream):
        self.dom = dom
        self.style = style
        self.stream = stream
        self.results = []

    def run(self, name: str, check) -> bool:
        """Execute one check, printing PASS/FAIL with its evidence; never raises."""
        try:
            detail = check() or "ok"
            passed = True
        except (CheckFailed, DriverError) as exc:
            detail, passed = str(exc), False
        except Exception as exc:  # noqa: BLE001 - a test bug is still a failing check
            detail, passed = f"{type(exc).__name__}: {exc}", False
        self.results.append({"name": name, "ok": passed, "detail": detail})
        tag = self.style.ok("PASS") if passed else self.style.bad("FAIL")
        print(f"[{tag}] {name}: {detail}", file=self.stream, flush=True)
        return passed


def define_checks(facts: dict, board_path: Path, dom: str) -> list:
    """The five assertions, as ``(name, callable)`` pairs."""

    def kernel_ready():
        require(
            READY_TEXT in dom,
            f"the DOM does not contain {READY_TEXT!r}; the HUD never reached the ready state "
            f"(status text is {_status_text(dom)!r})",
        )
        return f"found {READY_TEXT!r} in the HUD status span"

    def workspace_reported():
        require(
            STALE_PANEL_TEXT not in dom,
            f"the DOM contains {STALE_PANEL_TEXT!r}: a panel painted before workspace.info "
            "resolved and never repainted",
        )
        lines = workspace_lines(dom)
        require(
            lines,
            f"the DOM reports no workspace root; expected one of "
            f"{' or '.join(repr(item) for item in WORKSPACE_TEXTS)} in the boot log "
            f"(log text is {_short(_plain(dom, 'log'), 160)!r})",
        )
        return f"found {lines[0]!r}, and {STALE_PANEL_TEXT!r} is absent"

    def board_editor_painted():
        source = f"{board_path} first editor card"
        require(facts["file"] is not None, f"{source} has no non-empty 'file' value to assert on")
        needle = facts["file"]
        require(
            needle in dom,
            f"the DOM does not contain the live board's editor path {needle!r} ({source})",
        )
        return f"found {needle!r} ({source})"

    def board_note_painted():
        if facts["note"] is None:
            return "no note card on the board -- nothing to assert (editor card only)"
        prefix = facts["note"][:40]
        source = f"{board_path} first note card"
        if prefix in dom:
            return f"found the first 40 chars of the note text {prefix!r} ({source})"
        # The dump is serialized markup, so text that reaches the page as HTML
        # arrives re-escaped.  A prefix without &, <, > or quotes is compared
        # raw above, which is the strict form; this fallback only accepts the
        # entity spelling for the characters the serializer must escape.
        escaped = html.escape(prefix, quote=True)
        if escaped != prefix and escaped in dom:
            return (
                f"found the HTML-escaped form of the note prefix {escaped!r} ({source}); "
                "the dump escapes markup, so only &, <, > and quotes differ"
            )
        raise CheckFailed(
            f"the DOM contains neither the note prefix {prefix!r} nor its escaped form "
            f"{escaped!r} ({source}).  Note text is a <textarea>.value, which DOM "
            "serialization does not emit, so only the card's 48-char label is visible"
        )

    def command_bar():
        """The command bar is wired up, and what that does and does not prove.

        ``#command-hint`` is filled by a keydown/input listener, and
        ``--dump-dom`` drives no input, so the element is empty in every dump
        and the shipped command rows (``project [glob]``, ``files [glob]``)
        never reach the DOM -- they live in the ``COMMAND_HELP`` array inside
        ``shell/web/cards.mjs``, which the dump cannot see.  What *is* provable
        from a dump is that the bar shipped and that the module defining the
        commands executed: ``main.mjs`` imports ``COMMAND_HELP`` at load time
        and builds the line's key handling around it, so a boot that painted
        the HUD and the board ran that module whole.  Asserting more than this
        would mean asserting a string this tool never received.
        """
        hint = _plain(dom, "command-hint")
        require(
            "command-hint" in dom,
            "the DOM has no #command-hint element: the command bar did not ship",
        )
        require(
            'id="command"' in dom or 'id="command" ' in dom,
            "the DOM has no #command input: the command bar did not ship",
        )
        flat = " ".join(hint.split())
        if "project" in flat and "files" in flat:
            return f"the command-bar hint (#command-hint) lists project and files: {_short(flat, 110)!r}"
        return (
            "the command bar shipped (#command and #command-hint are in the DOM, and the "
            "module that defines the commands ran -- the HUD and board painted); NOT proven: "
            "the hint text, because no keys are typed and --dump-dom drives no input, so "
            "#command-hint is empty and the shipped rows ('project [glob]', 'files [glob]') "
            "stay inside shell/web/cards/registry.mjs's COMMAND_HELP array"
        )

    return [
        ("hud reports kernel ready", kernel_ready),
        ("workspace root reported, no stale panel", workspace_reported),
        ("board painted: editor card file", board_editor_painted),
        ("board painted: note card text", board_note_painted),
        ("command bar lists the shipped commands", command_bar),
    ]


def _element_text(dom: str, element_id: str) -> str:
    """Return the inner markup of ``#element_id`` (non-nested), or ``""``."""
    pattern = re.compile(
        r"<([a-zA-Z][\w:-]*)\b[^>]*\bid=\"%s\"[^>]*>(.*?)</\1>" % re.escape(element_id),
        re.DOTALL,
    )
    match = pattern.search(dom)
    return match.group(2) if match else ""


def _plain(dom: str, element_id: str) -> str:
    """The text content of ``#element_id``, tags stripped."""
    return re.sub(r"<[^>]+>", "", _element_text(dom, element_id))


def _status_text(dom: str) -> str:
    """The HUD status element's text, for a failure message."""
    return _short(_plain(dom, "kernel-status"), 80)


def workspace_lines(dom: str) -> list:
    """Every boot-log line reporting the workspace root, in either separator form.

    Returned rather than a bare boolean so the PASS line can show the string
    that was actually found -- the whole point of reading the live DOM instead
    of trusting the source that was supposed to produce it.
    """
    found = []
    for needle in WORKSPACE_TEXTS:
        if needle in dom and needle not in found:
            found.append(needle)
    return found


# --------------------------------------------------------------------------
# board backup


class BoardBackup:
    """Byte-for-byte snapshot of ``.infantgod/board.json``, restored in a ``finally``.

    The host rewrites this file on any mutation, so a smoke test that skipped
    this would reorder a developer's board -- and the shipped starter board --
    a little more on every run.
    """

    def __init__(self, path: Path):
        self.path = path
        self.existed = path.is_file()
        self.bytes = path.read_bytes() if self.existed else None
        self.backup = None
        self.installed = False
        self.restored_identical = False

    def install_if_absent(self) -> None:
        """Give a fresh clone something to paint.

        ``.infantgod/board.json`` is gitignored, so a clone has no board at all and
        the host would paint an empty canvas with nothing to assert on -- which
        is how ``make smoke`` failed on the first fresh clone.  The starter
        board in ``examples/`` is the same document, so install it for the run.

        This is safe because :meth:`restore` already remembers the file was not
        there and takes it away again; the run leaves the tree as it found it.
        """
        if self.existed:
            return
        if not STARTER_BOARD.is_file():
            raise DriverError(
                f"no board at {self.path} and no starter board at {STARTER_BOARD}"
            )
        self.path.parent.mkdir(parents=True, exist_ok=True)
        self.path.write_bytes(STARTER_BOARD.read_bytes())
        self.installed = True

    def snapshot(self) -> None:
        """Copy the original bytes aside, so even a hard kill is recoverable."""
        if not self.existed:
            return
        handle, name = tempfile.mkstemp(prefix="board.json.", suffix=".bak")
        with os.fdopen(handle, "wb") as stream:
            stream.write(self.bytes)
        self.backup = Path(name)

    def restore(self) -> bool:
        """Write the original bytes back; return True when byte-identical."""
        try:
            if not self.existed:
                # Nothing was here before: the run's own board has to go, and a
                # ``.infantgod/`` this test created must not be left behind either.
                # Not guarded on ``self.installed``: the host autosaves a board on
                # any mutation, so a test that never installed the starter board
                # (``input_smoke``, which counts card deltas) still leaves one.
                if self.path.is_file():
                    self.path.unlink()
                try:
                    if self.path.parent.is_dir() and not any(self.path.parent.iterdir()):
                        self.path.parent.rmdir()
                except OSError:
                    pass
                self.restored_identical = not self.path.exists()
                return self.restored_identical
            if not (self.path.is_file() and self.path.read_bytes() == self.bytes):
                self.path.parent.mkdir(parents=True, exist_ok=True)
                self.path.write_bytes(self.bytes)
            self.restored_identical = (
                self.path.is_file() and self.path.read_bytes() == self.bytes
            )
        except OSError:
            self.restored_identical = False
        return self.restored_identical

    def discard(self) -> None:
        """Delete the aside copy once the original is back and verified."""
        if self.backup is not None:
            try:
                self.backup.unlink()
            except OSError:
                pass
            self.backup = None


# --------------------------------------------------------------------------
# entry point


# --------------------------------------------------------------------------
# the new-mod round trip (D1-D4 and item 8)
#
# ``File -> 新建模组`` used to leave the package invisible: the window reloaded
# to a board that still said ``mod(dir: "")``, so the card painted "(no dir)",
# its three headings did nothing, and the log repeated "you have unsaved
# changes" while the save echo raced the page.  The fix hands the created root
# to the page in the boot URL, makes the headings targets, tells the user where
# a relative name resolves, and queues the save echo instead of mistaking it for
# another writer.
#
# None of that is visible to ``--dump-dom`` on its own: the page draws its board
# in ``#cards`` and the dump is one snapshot with no input.  So this section
# uses the same same-origin wrapper technique as ``tools/input_smoke.py``: write
# a page next to the app that frames it and reaches into the frame, drive it
# with real clicks and a real keystroke, and have it write ``name=value`` lines
# into ``<pre id="result">`` -- the only text a dump keeps from inside a frame.

#: The wrapper page this section writes into ``shell/web/``, the one static
#: directory the shell serves.  It is removed in the same ``finally`` as the
#: sandbox, so a green run leaves no page and no workspace behind.
MOD_WRAPPER_NAME = "__browser_smoke_mod.html"
MOD_WRAPPER = REPO_ROOT / "shell" / "web" / MOD_WRAPPER_NAME

#: ``<pre id="result">`` is the channel out of the iframe: a dump serializes the
#: top document only, so every fact has to be copied up here by the page itself.
MOD_RESULT_RE = re.compile(r'<pre id="result">(.*?)</pre>', re.S)

#: Virtual clock for the wrapper.  Its probe awaits several RPCs and polls
#: between them, which the board's 9 s budget cannot cover.
MOD_BUDGET_MS = 60000

#: The number of assertions ``define_newmod_checks`` makes, for the "browser is
#: not installed" summary line, which is printed before any check exists.
NEWMOD_CHECK_COUNT = 7

#: The wrapper page.  It is deliberately dumb: no imports, no build, plain
#: browser JS, so what it observes is what the shipped page does.  ``?app=`` in
#: the wrapper's own query string is the address to frame -- the caller encodes
#: it, which keeps ``?mod=<path>`` out of the wrapper's parsing job.
MOD_PAGE = """<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<title>browser smoke: new mod round trip</title>
<style>
body{margin:0;font:12px monospace}
iframe{width:1500px;height:900px;border:0}
pre{white-space:pre-wrap}
</style>
</head>
<body>
<iframe id="app" src="/"></iframe>
<pre id="result">pending</pre>
<script>
(() => {
  const lines = [];
  const out = document.getElementById("result");
  const say = (name, value) => lines.push(name + "=" + String(value).replace(/\\s+/g, " ").trim());
  const finish = () => { out.textContent = lines.join("\\n") + "\\ndone=1"; };
  const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
  const frame = document.getElementById("app");
  const appUrl = new URLSearchParams(location.search).get("app") || "/";
  const wantsMod = appUrl.indexOf("mod=") !== -1;
  const doc = () => frame.contentDocument;
  const win = () => frame.contentWindow;
  const textOf = (selector) => {
    const el = doc().querySelector(selector);
    return el === null ? "" : (el.textContent || "");
  };
  const logText = () => {
    const el = doc().getElementById("log");
    return el === null ? "" : (el.textContent || "");
  };
  const labels = () => Array.from(doc().querySelectorAll("#cards [data-card-id] [data-role=card-label]"))
    .map((el) => (el.textContent || "").trim());
  const viewClass = () => (doc().body === null ? "" : doc().body.className);
  const waitFor = async (probe, tries) => {
    const limit = tries || 240;
    for (let index = 0; index < limit; index += 1) {
      try {
        const value = probe();
        if (value) { return value; }
      } catch (err) { /* the frame is not ready yet */ }
      await sleep(50);
    }
    return null;
  };
  const rpc = async (method, params) => {
    const response = await fetch("/rpc", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
    });
    const reply = await response.json();
    if (reply.error) { throw new Error(reply.error.message || JSON.stringify(reply.error)); }
    return reply.result;
  };
  const runLine = (text) => {
    const box = doc().getElementById("command");
    box.value = text;
    box.dispatchEvent(new (win().KeyboardEvent)("keydown", { bubbles: true, cancelable: true, key: "Enter" }));
  };
  const clickMod = (label) => {
    const buttons = Array.from(doc().querySelectorAll(".card-mod .card-button"));
    const button = buttons.find((el) => (el.textContent || "").trim() === label);
    if (button === undefined) { return false; }
    button.click();
    return true;
  };
  (async () => {
    try {
      frame.src = appUrl;
      await waitFor(() => doc() && doc().readyState === "complete");
      /* Item 8: which tile the window opens on. The boot sets one of these two
       * classes on <body> and the log says which view is showing. */
      const booted = await waitFor(() => (/(^|\\s)is-(mod|classic)(\\s|$)/.test(viewClass()) ? viewClass() : ""));
      say("view", booted || viewClass());
      say("log_mod_note", logText().indexOf("the mod view is showing") !== -1);
      say("log_classic_note", logText().indexOf("the classic view is showing") !== -1);
      /* The HUD switch is the other witness that the window is on a tile: the
       * button for the view on screen is the pressed one. */
      const pressed = Array.from(doc().querySelectorAll("#mode-switch [data-view]"))
        .filter((el) => el.getAttribute("aria-pressed") === "true")
        .map((el) => el.getAttribute("data-view"));
      say("hud_pressed", pressed.join(","));
      /* G34/F5: a ?mod= the page cannot open must leave the kernel status
       * "ready" and say why in the log -- not report a dead kernel. */
      say("kernel_status", textOf("#kernel-status"));
      say("error", "");
      if (!wantsMod) { finish(); return; }
      if (!/(^|\\s)is-mod(\\s|$)/.test(booted || "")) { finish(); return; }
      /* D1: the package the URL named opened itself: a title, rows, a log line. */
      const headline = await waitFor(() => textOf(".card-mod .mod-headline").trim());
      say("headline", headline || "");
      say("log_tail", (logText() || "").slice(-160));
      say("log_could_not_open", logText().indexOf("cannot open") !== -1);
      say("status", textOf(".card-mod [data-role=card-status]"));
      say("label", textOf(".card-mod [data-role=card-label]"));
      const dirInput = doc().querySelector(".card-mod .mod-dir");
      say("dir", dirInput === null ? "" : dirInput.value);
      say("rows", doc().querySelectorAll(".card-mod .mod-row").length);
      say("log_opened", logText().indexOf("opened ") !== -1);
      /* D2: each heading is a target and opens the file it heads. */
      const titles = Array.from(doc().querySelectorAll(".card-mod .mod-section-title"));
      say("titles", titles.length);
      say("title_roles", titles.length > 0 && titles.every((el) => el.getAttribute("role") === "button"));
      const before = labels();
      if (titles.length > 0) { titles[0].click(); }
      const manifest = await waitFor(() => labels().find((one) => one.indexOf("mod.json") !== -1 && before.indexOf(one) === -1));
      say("manifest_card", manifest || "");
      if (titles.length > 1) { titles[1].click(); }
      const defineCard = await waitFor(() => labels().find((one) => before.indexOf(one) === -1
        && one.indexOf("mod.json") === -1 && /\\.json$/.test(one)));
      say("define_card", defineCard || "");
      if (titles.length > 2) { titles[2].click(); }
      const yarnCard = await waitFor(() => labels().find((one) => before.indexOf(one) === -1 && /\\.yarn$/.test(one)));
      say("yarn_card", yarnCard || "");
      /* D3, first half: a real save from this page must not be mistaken for a
       * second writer.  A note dirties the board synchronously, so the manual
       * `save` below is the save whose echo races its own reply. */
      runLine("note e2e echo probe");
      runLine("save");
      const saved = await waitFor(() => logText().indexOf("board saved (rev") !== -1);
      say("saved", Boolean(saved));
      await sleep(400);
      say("echo_warn", logText().indexOf("you have unsaved changes") !== -1);
      /* D3, second half: a write from outside the page still warns while the
       * page holds unsaved layout.  The note dirties the board; the external
       * save then moves the disk revision under it. */
      runLine("note e2e external writer");
      await sleep(120);
      let external = false;
      for (let attempt = 0; attempt < 3 && !external; attempt += 1) {
        const loaded = await rpc("view.load", { path: ".infantgod/board.json" });
        say("loaded_revision", loaded.revision);
        /* Revisions are content hashes (core/src/blob.c), so writing the same
         * document back would keep the revision and the page would rightly call
         * that its own echo.  A real external writer changes the board: this one
         * adds a note card. */
        const document_ = loaded.document;
        if (!Array.isArray(document_.cards)) { document_.cards = []; }
        document_.cards.push({
          id: "external-writer",
          kind: "note",
          x: 24,
          y: 24,
          w: 220,
          h: 120,
          z: 1,
          text: "written by the smoke test",
        });
        try {
          await rpc("view.save", {
            path: ".infantgod/board.json",
            document: document_,
            base_revision: loaded.revision,
          });
          external = true;
        } catch (err) {
          say("external_error", (err && err.message) || String(err));
          await sleep(150);
        }
      }
      say("external_save", external);
      const warned = await waitFor(() => logText().indexOf("you have unsaved changes") !== -1);
      say("external_warn", Boolean(warned));
      say("log_after_ext", logText().slice(-400));
      /* D4 plus the placeholder: `Mods/MyMod` is not what a relative name means
       * here, so it has to fail in the status line and the log; `NewMod` is. */
      const input = doc().querySelector(".card-mod .mod-dir");
      input.value = "Mods/MyMod";
      clickMod("open");
      const failed = await waitFor(() => textOf(".card-mod [data-role=card-status]").indexOf("open failed") !== -1);
      say("bad_status", failed ? textOf(".card-mod [data-role=card-status]") : "");
      say("bad_log", logText().indexOf("cannot open Mods/MyMod:") !== -1);
      input.value = "NewMod";
      clickMod("open");
      const relative = await waitFor(() => {
        const status = textOf(".card-mod [data-role=card-status]");
        return status.indexOf("opened ") !== -1 && status.indexOf("NewMod") !== -1 ? status : "";
      });
      say("relative_status", relative || "");
      say("relative_label", textOf(".card-mod [data-role=card-label]"));
    } catch (err) {
      say("error", (err && err.message) || String(err));
    }
    finish();
  })();
})();
</script>
</body>
</html>
"""


def _wrapper_finished(text: str) -> bool:
    """True when the wrapper page put its ``done=1`` line in the dump."""
    match = MOD_RESULT_RE.search(text)
    return match is not None and "done=1" in html.unescape(match.group(1))


def _wrapper_facts(dom: str) -> dict:
    """Parse the ``name=value`` lines the wrapper wrote, as a dict of strings."""
    match = MOD_RESULT_RE.search(dom)
    if match is None:
        return {}
    facts = {}
    for line in html.unescape(match.group(1)).splitlines():
        name, separator, value = line.partition("=")
        if separator and name and name.replace("_", "").isalnum():
            facts[name] = value
    return facts


def rpc_call(host: Host, method: str, params: dict, timeout: float = 20.0) -> dict:
    """One JSON-RPC call against *host*; raise :class:`DriverError` on any failure."""
    body = json.dumps({"jsonrpc": "2.0", "id": 1, "method": method, "params": params}).encode("utf-8")
    request = urllib.request.Request(
        host.url + "rpc",
        data=body,
        method="POST",
        headers={"content-type": "application/json"},
    )
    try:
        with urllib.request.urlopen(request, timeout=timeout) as response:
            reply = json.loads(response.read().decode("utf-8"))
    except (urllib.error.URLError, OSError, ValueError) as exc:
        raise DriverError(f"POST {host.url}rpc ({method}) failed: {exc}") from exc
    if reply.get("error"):
        error = reply["error"] or {}
        raise DriverError(f"{method} answered an error: {error.get('message') or error!r}")
    return reply.get("result") or {}


def _sandbox_workspace(sandbox: Path) -> None:
    """Give the round trip its own board, with the defective card on it.

    The reported defect is exactly ``mod(dir: "")``: the scaffold created the
    package and the page never learned where.  The board starts with such a
    card so ``?mod=`` has something to repair rather than something to add.
    """
    board = json.loads(STARTER_BOARD.read_text(encoding="utf-8"))
    board.setdefault("cards", []).append(
        {"id": "c-mod", "kind": "mod", "x": 1080, "y": 40, "w": 380, "h": 460, "z": 4, "dir": ""}
    )
    target = sandbox / ".infantgod" / "board.json"
    target.parent.mkdir(parents=True, exist_ok=True)
    target.write_text(json.dumps(board, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")


def _drive_wrapper(edge, args, profile: Path, url: str, label: str) -> dict:
    """Dump one wrapper page and return the facts it reported."""
    flags = tuple(item for item in EDGE_FLAGS if not item.startswith("--virtual-time-budget")) + (
        f"--virtual-time-budget={MOD_BUDGET_MS}",
    )
    dom, attempts, note = grab_dom(
        edge, url, profile, args.timeout, budget=min(args.timeout, 90.0),
        flags=flags, painted=_wrapper_finished,
    )
    show(f"e2e dom ({label})", f"{len(dom)} chars from {attempts} browser launch(es)")
    if note:
        show(f"e2e note ({label})", note)
    return _wrapper_facts(dom)


def newmod_round_trip(edge, args) -> dict:
    """Scaffold a package in a sandbox, then drive the page the way the menu does.

    Returns ``{"cold": facts, "trip": facts, "mod_root": str}``.  Raises
    :class:`DriverError` when the sandbox itself cannot be brought up; a page
    that merely reports the wrong facts is for the checks below to judge.
    """
    sandbox = Path(tempfile.mkdtemp(prefix="infantgod-smoke-modws-"))
    profile = Path(tempfile.mkdtemp(prefix="infantgod-smoke-e2e-"))
    host = None
    written = False
    try:
        _sandbox_workspace(sandbox)
        MOD_WRAPPER.write_text(MOD_PAGE, encoding="utf-8")
        written = True
        port = free_port()
        host = Host(
            port,
            [
                "node", str(SHELL_MAIN),
                "serve",
                "--workspace", str(sandbox),
                "--mods-root", str(sandbox),
                # A throwaway user directory: the settings card's preferences live
                # there, so a developer machine that once picked the classic view
                # cannot change which view this run's cold boot lands on.
                "--user-dir", str(profile / "user"),
                "--port", str(port),
                "--no-open",
            ],
        )
        host.start()
        show("e2e host", f"{host.url} (workspace {sandbox})")
        host.wait_ready(args.timeout)
        status = host.probe(timeout=min(10.0, args.timeout))
        if status != 200:
            raise DriverError(f"GET / on the round-trip host answered {status}, expected 200")
        created = rpc_call(host, "mod.scaffold", {"dir": str(sandbox), "modName": "NewMod", "template": "full"})
        mod_root = created.get("modRoot")
        if not isinstance(mod_root, str) or mod_root == "":
            raise DriverError(f"mod.scaffold created no modRoot (answer keys: {sorted(created)})")
        files = created.get("created") or []
        show("e2e package", f"{mod_root} ({len(files)} file(s))")

        cold = _drive_wrapper(edge, args, profile, f"{host.url}{MOD_WRAPPER_NAME}?app=%2F", "cold start")
        # The package root is encoded once here and decoded once by the wrapper,
        # so the address it frames carries an encoded `?mod=` -- a raw Windows
        # path in a URL is not something the browser promises to keep.
        app = "/?mod=" + urllib.parse.quote(mod_root, safe="")
        trip = _drive_wrapper(
            edge, args, profile,
            f"{host.url}{MOD_WRAPPER_NAME}?app={urllib.parse.quote(app, safe='')}",
            "?mod= round trip",
        )
        # F5: the same boot, but the folder the URL names is gone.  The window
        # still has to come up (status "ready"); the failure belongs in the log.
        missing = "/?mod=" + urllib.parse.quote(str(Path(sandbox) / "NotThere"), safe="")
        lost = _drive_wrapper(
            edge, args, profile,
            f"{host.url}{MOD_WRAPPER_NAME}?app={urllib.parse.quote(missing, safe='')}",
            "?mod= to a missing folder",
        )
        return {"cold": cold, "trip": trip, "missing": lost, "mod_root": mod_root}
    finally:
        if host is not None:
            host.close()
        if written:
            MOD_WRAPPER.unlink(missing_ok=True)
        shutil.rmtree(profile, ignore_errors=True)
        shutil.rmtree(sandbox, ignore_errors=True)


def define_newmod_checks(facts: dict) -> list:
    """The seven round-trip assertions, as ``(name, callable)`` pairs."""
    cold = facts.get("cold") or {}
    trip = facts.get("trip") or {}
    missing = facts.get("missing") or {}

    def reported(report: dict, label: str) -> None:
        require(
            report,
            f"the {label} wrapper page reported nothing: the browser dump carried no #result block, "
            "so the page never ran its probe",
        )
        require(not report.get("error"), f"the {label} wrapper page failed: {report.get('error')}")

    def cold_boot_is_mod():
        reported(cold, "cold-start")
        require(
            "is-mod" in cold.get("view", "").split(),
            f"a cold boot did not open on the mod view (body class is {cold.get('view')!r}); "
            "item 8 makes the mod tile the default",
        )
        require(
            cold.get("hud_pressed") == "mod",
            f"the HUD switch does not show the mod tile as the pressed one "
            f"(pressed: {cold.get('hud_pressed')!r})",
        )
        require(
            cold.get("log_classic_note") == "false",
            "the boot log says the classic view is showing, so the default changed in the layout only",
        )
        return (
            f"body class {cold.get('view')!r}; HUD pressed {cold.get('hud_pressed')!r}; "
            "the log never names the classic view"
        )

    def mod_url_opens_package():
        reported(trip, "round-trip")
        headline = trip.get("headline", "")
        require(
            "NewMod" in headline,
            f"the ?mod= boot did not open the created package: the card's title is {headline!r} "
            f"(status {trip.get('status')!r})",
        )
        rows = trip.get("rows", "0")
        require(
            rows.isdigit() and int(rows) > 0,
            f"the opened package lists no rows ({rows!r}); the manifest, defines and Yarn files "
            "all failed to paint",
        )
        require(trip.get("log_opened") == "true", "the log never said which package it opened")
        require(
            trip.get("status", "").startswith("opened "),
            f"the card's status line is {trip.get('status')!r}, not 'opened <root>'",
        )
        return f"title {headline!r}, {rows} row(s), status {trip.get('status')!r}"

    def headings_open_files():
        reported(trip, "round-trip")
        require(
            trip.get("titles") == "3" and trip.get("title_roles") == "true",
            f"the card shows {trip.get('titles')!r} section heading(s) and roles {trip.get('title_roles')!r}; "
            "all three headings must be targets",
        )
        require(
            "mod.json" in trip.get("manifest_card", ""),
            f"clicking the mod.json heading opened no card naming mod.json "
            f"(new card label {trip.get('manifest_card')!r})",
        )
        require(
            trip.get("define_card", "").endswith(".json"),
            f"clicking the Defines heading opened no define file (new card label {trip.get('define_card')!r})",
        )
        require(
            trip.get("yarn_card", "").endswith(".yarn"),
            f"clicking the Yarn heading opened no Yarn file (new card label {trip.get('yarn_card')!r})",
        )
        return (
            f"mod.json -> {trip.get('manifest_card')!r}, Defines -> {trip.get('define_card')!r}, "
            f"Yarn -> {trip.get('yarn_card')!r}"
        )

    def save_echo_is_not_a_warning():
        reported(trip, "round-trip")
        require(trip.get("saved") == "true", "no save from the page reached the disk, so its echo could not be tested")
        require(
            trip.get("echo_warn") == "false",
            "a save from the page still logs 'you have unsaved changes'; the page is reading its own "
            "echo as another writer",
        )
        return "the page's own save reached the disk with no 'unsaved changes' warning"

    def external_writer_still_warns():
        reported(trip, "round-trip")
        require(
            trip.get("external_save") == "true",
            "the test's own external view.save never landed, so nothing external was tested",
        )
        require(
            trip.get("external_warn") == "true",
            "an external view.save while the page held unsaved layout did not warn; "
            "the queued echo fix must not swallow other writers",
        )
        return "an external view.save while dirty logged 'you have unsaved changes'"

    def wrong_relative_name_is_visible():
        reported(trip, "round-trip")
        bad_status = trip.get("bad_status", "")
        require(
            bad_status.startswith("open failed"),
            f"`Mods/MyMod` left the status line at {bad_status!r}; a failed open must say so",
        )
        require(
            trip.get("bad_log") == "true",
            "a failed open never reached the log strip; the failure has to be visible in both places",
        )
        require(
            trip.get("relative_status", "").startswith("opened ")
            and "NewMod" in trip.get("relative_status", ""),
            f"`NewMod`, the name the placeholder shows, did not open: status {trip.get('relative_status')!r}",
        )
        return (
            f"`Mods/MyMod` -> status {bad_status!r} and a log line; "
            f"`NewMod` -> {trip.get('relative_status')!r}"
        )

    def failed_open_is_not_a_dead_kernel():
        reported(missing, "missing-folder")
        require(
            missing.get("kernel_status", "").strip().endswith("ready"),
            f"a ?mod= that cannot be opened left the kernel status at {missing.get('kernel_status')!r}; "
            "the window booted and only the package failed, so it must stay 'ready'",
        )
        require(
            missing.get("log_could_not_open") == "true",
            "a ?mod= that cannot be opened never said so in the log; the failure has to be visible "
            f"(log tail: {missing.get('log_tail')!r})",
        )
        return f"status {missing.get('kernel_status')!r} and a log line"

    return [
        ("item 8: a cold boot opens on the mod view", cold_boot_is_mod),
        ("D5: a ?mod= that fails leaves the kernel up and says why", failed_open_is_not_a_dead_kernel),
        ("D1: ?mod= opens the package the menu just created", mod_url_opens_package),
        ("D2: the three mod headings open the files they head", headings_open_files),
        ("D3: a page's own save is not logged as another writer", save_echo_is_not_a_warning),
        ("D3: a real external write still warns", external_writer_still_warns),
        ("D4: a wrong relative name fails visibly, the right one opens", wrong_relative_name_is_visible),
    ]


#: ---------------------------------------------------------------------------
#: The card round trip (G29).  A card the tile has no place for used to be
#: hidden with nothing to bring it back; the container mapping now offers it as
#: a tab.  The round trip drives one page in a sandbox workspace: open one card
#: of every kind from the command line, then, in each view, press each card's
#: tab (or focus the part of the tile it already fills) and report whether its
#: root is drawn and can take the keyboard.
#: ---------------------------------------------------------------------------

CARD_WRAPPER_NAME = "__browser_smoke_cards.html"
CARD_WRAPPER = REPO_ROOT / "shell" / "web" / CARD_WRAPPER_NAME

#: The kinds the board ships, in ``shell/web/board.mjs``'s ``CARD_KINDS`` order.
#: Every one of them has to be reachable in both tiles.
CARD_KINDS = (
    "editor", "runner", "note", "files", "project",
    "sheet", "story", "pixel", "rig", "mod", "problems", "docs", "settings",
    "help", "audio",
)

#: The tiles, in the order the round trip walks them (the window boots on mod).
CARD_VIEWS = ("mod", "classic")

#: The commands that open one card of every kind.  The sandbox workspace is
#: written by ``_cards_workspace`` so each relative path here is real.
CARD_COMMANDS = (
    "open README.md",
    "run echo smoke",
    "note smoke note",
    "files",
    "project",
    "sheet smoke sheet",
    "story main.yarn",
    "pixel icon.png",
    "rig rig.skel.bytes",
    "mod NewMod",
    "problems",
    "docs",
    "settings",
    "help",
    "open tone.wav",
)

#: The close facts the card page prints after the reachability walk: the three
#: strip gestures (x, middle click, Ctrl+W), the neighbour rule when the last tab
#: closes, the unsaved-text question's three answers, the same two gestures in the
#: mod view, and the undo that puts a closed card back.  Named after the key the
#: page prints, and used by the "browser is not installed" summary line.
CLOSE_CHECK_KEYS = (
    "x_close",
    "middle_close",
    "ctrl_w",
    "close_last_neighbour",
    "ask_cancel",
    "ask_discard",
    "ask_save",
    "ask_gestures",
    "mod_x_close",
    "mod_ctrl_w",
    "undo_close",
)
CLOSE_CHECK_COUNT = len(CLOSE_CHECK_KEYS)

#: The Yarn language strips: the menu for `<<`, accepting a row, Escape, the
#: Ctrl+Space shortcut, a non-Yarn file staying quiet, hover following the
#: caret, and the menu refusing to accept a row for a caret that has moved
#: (by an arrow key, and with no key at all -- a find jump or an undo).  Same
#: rules as CLOSE_CHECK_KEYS.
LANG_CHECK_KEYS = (
    "lang_menu",
    "lang_accept",
    "lang_escape",
    "lang_ctrl_space",
    "lang_non_yarn",
    "lang_hover",
    "lang_stale_arrow",
    "lang_stale_silent",
)
LANG_CHECK_COUNT = len(LANG_CHECK_KEYS)

#: The rig card's own round trip -- edit, save, and a second save that must
#: refuse -- is two facts past the reachability sweep.  The mod card's new-file
#: row is one more: the picker it generates, and the define it writes.
RIG_SAVE_CHECK_COUNT = 2
MOD_NEW_CHECK_COUNT = 2

#: One assertion per (view, kind), plus the one that every mounted card is
#: reachable somewhere, plus the rig save facts, the mod new-file fact, the close
#: facts and the language-strip facts.  Used by the "browser is not installed"
#: summary line.
CARD_CHECK_COUNT = (
    len(CARD_KINDS) * len(CARD_VIEWS) + 1 + RIG_SAVE_CHECK_COUNT
    + MOD_NEW_CHECK_COUNT + CLOSE_CHECK_COUNT + LANG_CHECK_COUNT
)

#: The wrapper page.  Same rules as ``MOD_PAGE``: plain browser JS, no imports,
#: and every fact copied into ``#result`` because a dump serializes only the top
#: document.  ``?app=`` is the address to frame.
CARD_PAGE = r"""<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<title>browser smoke: every card kind in both views</title>
<style>
body{margin:0;font:12px monospace}
iframe{width:1500px;height:900px;border:0}
pre{white-space:pre-wrap}
</style>
</head>
<body>
<iframe id="app" src="/"></iframe>
<pre id="result">pending</pre>
<script>
(() => {
  const KINDS = __KINDS__;
  const VIEWS = __VIEWS__;
  const COMMANDS = __COMMANDS__;
  const lines = [];
  const out = document.getElementById("result");
  const say = (name, value) => lines.push(name + "=" + String(value).replace(/\s+/g, " ").trim());
  const finish = () => { out.textContent = lines.join("\n") + "\ndone=1"; };
  const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
  const frame = document.getElementById("app");
  const appUrl = new URLSearchParams(location.search).get("app") || "/";
  const doc = () => frame.contentDocument;
  const win = () => frame.contentWindow;
  const viewClass = () => (doc().body === null ? "" : doc().body.className);
  const inView = (view) => new RegExp("(^|\\s)is-" + view + "(\\s|$)").test(viewClass());  const waitFor = async (probe, tries) => {
    const limit = tries || 240;
    for (let index = 0; index < limit; index += 1) {
      try {
        const value = probe();
        if (value) { return value; }
      } catch (err) { /* the frame is not ready yet */ }
      await sleep(50);
    }
    return null;
  };
  const runLine = (text) => {
    const box = doc().getElementById("command");
    box.value = text;
    box.dispatchEvent(new (win().KeyboardEvent)("keydown", { bubbles: true, cancelable: true, key: "Enter" }));
  };
  /* The board's own redraws are queued on an animation frame, and a headless
   * page can go a while without servicing one; a card added between frames then
   * has its root but no tab yet.  A view switch repaints synchronously, so this
   * is how the probe asks the page to redraw before it trusts the strip -- the
   * outcome (a real tab, a real button) is still the only thing measured. */
  const syncStrip = async (view) => {
    runLine("mode " + (view === "mod" ? "classic" : "mod"));
    await sleep(180);
    runLine("mode " + view);
    await sleep(240);
  };
  /* The last root of a kind: the commands run after the boot-time hint note, so
   * the card this probe opened is the last one the board mounted. */
  const rootOf = (kind) => {
    const roots = Array.from(doc().querySelectorAll('#cards .card[data-kind="' + kind + '"]'));
    return roots.length === 0 ? null : roots[roots.length - 1];
  };
  /* A tab is a container with a close button in it, so the id lives on the
   * container and the strip is addressed by id, not by "the button". */
  const tabOf = (id) => (id === null ? null : doc().querySelector('#tabs [data-card-id="' + id + '"]'));
  const focusedIn = (root) => {
    const active = doc().activeElement;
    return active !== null && (active === root || root.contains(active));
  };
  const describeActive = (root) => {
    const active = doc().activeElement;
    const tag = active === null ? "none" : active.tagName + "." + String(active.className || "");
    return "active=" + tag + " in=" + (root !== null && focusedIn(root) ? 1 : 0);
  };
  (async () => {
    try {
      frame.src = appUrl;
      await waitFor(() => doc() && doc().readyState === "complete");
      await waitFor(() => {
        const status = doc().getElementById("kernel-status");
        return status !== null && /ready/.test(status.textContent || "");
      });
      await sleep(200);
      for (const command of COMMANDS) {
        runLine(command);
        await sleep(180);
      }
      /* The kind that loads files over RPC (open, story, pixel, mod) is slower
       * than the rest; give the last one room before measuring. */
      await sleep(600);
      for (const view of VIEWS) {
        runLine("mode " + view);
        await waitFor(() => inView(view));
        await sleep(300);
        for (const kind of KINDS) {
          const root = rootOf(kind);
          const id = root === null ? null : root.getAttribute("data-card-id");
          const tab = tabOf(id);
          let focused = false;
          if (root !== null) {
            if (tab !== null) {
              tab.click();
              await sleep(160);
            } else {
              root.focus();
              await sleep(30);
            }
            focused = focusedIn(root);
          }
          say(
            "card_" + view + "_" + kind,
            "root=" + (root !== null ? 1 : 0)
              + " tab=" + (tab !== null ? 1 : 0)
              + " visible=" + (root !== null && !root.classList.contains("is-hidden") ? 1 : 0)
              + " focused=" + (focused ? 1 : 0)
              + " " + describeActive(root),
          );
        }
        /* The invariant G29 is about: a card is drawn by one of the tile's parts
         * or it is one of the strip's buttons -- never neither. */
        const cards = Array.from(doc().querySelectorAll("#cards [data-card-id]"));
        let reachable = 0;
        for (const card of cards) {
          const id = card.getAttribute("data-card-id");
          const tab = tabOf(id);
          if (!card.classList.contains("is-hidden") || tab !== null) { reachable += 1; }
        }
        say("reach_" + view, "total=" + cards.length + " reachable=" + reachable);
      }

      /* ---------------- the rig card writes back what it shows ---------------- */
      {
        const rigRoot = rootOf("rig");
        say("rig_card", "root=" + (rigRoot !== null ? 1 : 0));
        if (rigRoot !== null) {
          const statusOf = () => {
            const el = rigRoot.querySelector(".card-status");
            return el === null ? "" : el.textContent.trim();
          };
          const settled = await waitFor(() => {
            const text = statusOf();
            return text !== "" && text.indexOf("reading") !== 0 ? text : "";
          }, 200);
          say("rig_before", "settled=" + (settled === null ? 0 : 1));
          const rpc = async (method, params) => {
            const reply = await fetch("/rpc", {
              method: "POST",
              headers: { "content-type": "application/json" },
              body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
            });
            const body = await reply.json();
            if (body.error) { throw new Error(JSON.stringify(body.error)); }
            return body.result;
          };
          const readRig = async () => String((await rpc("file.read_bytes", { path: "rig.skel.bytes" })).base64 || "");
          const clickIn = (selector) => {
            const el = rigRoot.querySelector(selector);
            if (el === null) { return false; }
            el.dispatchEvent(new (win().MouseEvent)("click", { bubbles: true }));
            return true;
          };
          const before = await readRig();
          const opened = clickIn('[data-role="rig-edit"]');
          await sleep(180);
          const rows = Array.from(rigRoot.querySelectorAll(".rig-bones .mod-row"));
          if (rows.length > 0) { rows[0].dispatchEvent(new (win().MouseEvent)("click", { bubbles: true })); }
          await sleep(180);
          const rotation = rigRoot.querySelector('[data-role="rig-rotation"]');
          const from = rotation === null ? "" : rotation.value;
          const typed = String(Number(from || 0) + 15);
          if (rotation !== null) {
            rotation.value = typed;
            rotation.dispatchEvent(new (win().Event)("change", { bubbles: true }));
          }
          await sleep(220);
          const edited = statusOf();
          const pressed = clickIn('[data-role="rig-save"]');
          const saved = pressed ? await waitFor(() => {
            const text = statusOf();
            return text.indexOf("saved") === 0 || text.indexOf("save failed") === 0 ? text : "";
          }, 200) : null;
          await sleep(200);
          const after = await readRig();
          /* The file the card wrote, read back by the same parser the card uses:
             the number typed in the inspector has to come out of the bytes. */
          let back = "";
          try {
            const spine = await import("/spine.mjs");
            const raw = atob(after);
            const bytes = new Uint8Array(raw.length);
            for (let index = 0; index < raw.length; index += 1) { bytes[index] = raw.charCodeAt(index); }
            const model = spine.readSkeletonBinary(bytes);
            back = "bones=" + model.bones.length
              + " rotation=" + Math.round(model.bones[0].rotation * 1000) / 1000;
          } catch (err) {
            back = "error=" + String(err && err.message ? err.message : err);
          }
          say("rig_back", back);
          say("rig_edit", "opened=" + (opened ? 1 : 0) + " rows=" + rows.length
            + " from=" + (from === "" ? "none" : from)
            + " typed=" + typed
            + " edited=" + (edited.indexOf("edited:") >= 0 ? 1 : 0));
          say("rig_save", "pressed=" + (pressed ? 1 : 0)
            + " written=" + (saved === null ? 0 : 1)
            + " changed=" + (before !== after ? 1 : 0)
            + " b64_before=" + before.length + " b64_after=" + after.length);
          /* A rig with no edit must not be written a second time. */
          clickIn('[data-role="rig-save"]');
          await sleep(250);
          say("rig_again", "refused=" + (statusOf().indexOf("nothing to save") === 0 ? 1 : 0));
        }
      }

      /* ---------------- the mod card makes one file from a schema ---------------- */
      {
        const modRoot = rootOf("mod");
        say("mod_card", "root=" + (modRoot !== null ? 1 : 0));
        if (modRoot !== null) {
          const statusOf = () => {
            const el = modRoot.querySelector(".card-status");
            return el === null ? "" : el.textContent.trim();
          };
          const select = modRoot.querySelector(".mod-new-type");
          const name = modRoot.querySelector(".mod-new-name");
          const newButton = modRoot.querySelector(".mod-new .card-button");
          const options = select === null ? [] : Array.from(select.options || []).map((one) => one.value);
          const greyed = select === null ? 0 : Array.from(select.options || []).filter((one) => one.disabled).length;
          say("mod_new_pick", "select=" + (select !== null ? 1 : 0)
            + " options=" + options.length
            + " goods=" + (options.indexOf("Goods") >= 0 ? 1 : 0)
            + " yarn=" + (options.indexOf("yarn") >= 0 ? 1 : 0)
            + " greyed=" + greyed);
          if (select !== null && name !== null && newButton !== null) {
            select.value = "Goods";
            name.value = "Goods_Smoke";
            name.dispatchEvent(new (win().Event)("input", { bubbles: true }));
            newButton.click();
          }
          const created = await waitFor(() => {
            const text = statusOf();
            return text.indexOf("created") === 0 || text.indexOf("not created") === 0 ? text : "";
          }, 300);
          let keys = "";
          let techName = "";
          try {
            const reply = await fetch("/rpc", {
              method: "POST",
              headers: { "content-type": "application/json" },
              body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "file.read", params: { path: "NewMod/Defines/Goods/Goods_Smoke.json" } }),
            });
            const body = await reply.json();
            if (body.error) { throw new Error(body.error.message); }
            const parsed = JSON.parse(body.result.text);
            keys = Object.keys(parsed).join(",");
            techName = String(parsed.techName);
          } catch (err) {
            keys = "error=" + String(err && err.message ? err.message : err);
          }
          say("mod_new", "created=" + (created !== null && created.indexOf("created") === 0 ? 1 : 0)
            + " keys=" + keys + " techName=" + techName);

          /* The other half: a file that already exists, copied into the package. */
          const importFrom = modRoot.querySelector(".mod-import-from");
          const importTo = modRoot.querySelector(".mod-import-to");
          const importButton = modRoot.querySelector(".mod-import .card-button");
          let imported = 0;
          let same = 0;
          if (importFrom !== null && importTo !== null && importButton !== null) {
            importFrom.value = "icon.png";
            importTo.value = "Sprites/icon-imported.png";
            importFrom.dispatchEvent(new (win().Event)("input", { bubbles: true }));
            importTo.dispatchEvent(new (win().Event)("input", { bubbles: true }));
            importButton.click();
            const done = await waitFor(() => {
              const text = statusOf();
              return text.indexOf("imported") === 0 || text.indexOf("not imported") === 0 ? text : "";
            }, 300);
            imported = done !== null && done.indexOf("imported") === 0 ? 1 : 0;
            const read64 = async (path) => {
              const reply = await fetch("/rpc", {
                method: "POST",
                headers: { "content-type": "application/json" },
                body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "file.read_bytes", params: { path } }),
              });
              const body = await reply.json();
              return body.error ? "" : String(body.result.base64 || "");
            };
            const source = await read64("icon.png");
            const target = await read64("NewMod/Sprites/icon-imported.png");
            same = source !== "" && source === target ? 1 : 0;
          }
          say("mod_import", "imported=" + imported + " same=" + same);
        }
      }

      /* ---------------- close gestures and the unsaved-text question ---------------- */
      const tabIds = () => Array.from(doc().querySelectorAll("#tabs [data-card-id]"))
        .map((node) => node.getAttribute("data-card-id"));
      const cardRootOf = (id) => doc().querySelector('#cards [data-card-id="' + id + '"]');
      const areaHas = (id) => {
        const root = cardRootOf(id);
        return root !== null && !root.classList.contains("is-hidden");
      };
      const focusInCard = (id) => {
        const root = cardRootOf(id);
        return root !== null && focusedIn(root);
      };
      const rightOf = (ids, id) => {
        const at = ids.indexOf(id);
        return at < 0 || at + 1 >= ids.length ? null : ids[at + 1];
      };
      const leftOf = (ids, id) => {
        const at = ids.indexOf(id);
        return at <= 0 ? null : ids[at - 1];
      };
      const openTab = async (id) => {
        const tab = tabOf(id);
        if (tab === null) { return false; }
        tab.querySelector(".tab-open").click();
        await sleep(260);
        return true;
      };
      const closeWithX = (id) => {
        const tab = tabOf(id);
        if (tab !== null) { tab.querySelector(".tab-close").click(); }
      };
      const closeWithMiddle = (id) => {
        const tab = tabOf(id);
        if (tab === null) { return; }
        tab.querySelector(".tab-open").dispatchEvent(
          new MouseEvent("auxclick", { button: 1, bubbles: true, cancelable: true }),
        );
      };
      const closeWithCtrlW = () => {
        doc().dispatchEvent(
          new KeyboardEvent("keydown", { key: "w", ctrlKey: true, bubbles: true, cancelable: true }),
        );
      };
      const gestureFacts = (closed, next) => "gone=" + (tabOf(closed) === null && cardRootOf(closed) === null ? 1 : 0)
        + " next=" + (next === null ? "-" : next)
        + " shown=" + (next !== null && areaHas(next) ? 1 : 0)
        + " focused=" + (next !== null && focusInCard(next) ? 1 : 0)
        + " tabs=" + tabIds().length;
      const editorUnder = () => {
        const roots = Array.from(doc().querySelectorAll('#cards .card[data-kind="editor"]'));
        return roots.length === 0 ? null : roots[roots.length - 1];
      };
      const markDirty = async (marker) => {
        runLine("open README.md");
        await sleep(800);
        let root = editorUnder();
        if (root === null) { return null; }
        const id = root.getAttribute("data-card-id");
        const tab = tabOf(id);
        if (tab !== null) {
          tab.querySelector(".tab-open").click();
          await sleep(320);
          root = editorUnder();
        }
        if (root === null) { return null; }
        const area = root.querySelector("textarea");
        if (area === null) { return null; }
        area.value = area.value + "\n" + marker + "\n";
        area.dispatchEvent(new Event("input", { bubbles: true }));
        await sleep(240);
        /* The dot is painted by the next render, and the page only renders on a
         * board change: pressing the tab is a render that touches nothing else. */
        const fresh = editorUnder();
        const freshTab = fresh === null ? null : tabOf(fresh.getAttribute("data-card-id"));
        if (freshTab !== null) {
          freshTab.querySelector(".tab-open").click();
          await sleep(320);
        }
        const dot = tabOf(id) === null ? null : tabOf(id).querySelector(".tab-dirty");
        return { id: id, dirty: dot !== null ? 1 : 0 };
      };
      const askNow = () => {
        const strip = doc().querySelector(".ask");
        if (strip === null) { return null; }
        return {
          strip: strip,
          labels: Array.from(strip.querySelectorAll(".ask-button")).map((button) => button.textContent),
        };
      };
      const answer = async (label) => {
        const asked = askNow();
        if (asked === null) { return false; }
        const button = Array.from(asked.strip.querySelectorAll(".ask-button"))
          .find((item) => item.textContent === label);
        if (button === undefined) { return false; }
        button.click();
        await sleep(900);
        return true;
      };
      const cancelCheck = async () => {
        const marked = await markDirty("CANCEL-SMOKE-MARKER");
        if (marked === null) {
          say("ask_cancel", "dirty=0 asked=0 answered=0 kept=0 strip=0 focused=0");
          return;
        }
        closeWithX(marked.id);
        await sleep(450);
        const asked = askNow();
        if (asked === null) {
          say("ask_cancel", "dirty=" + marked.dirty + " asked=0 answered=0 kept="
            + (cardRootOf(marked.id) !== null ? 1 : 0) + " strip=0 focused=0");
          return;
        }
        const answered = await answer("取消");
        const kept = cardRootOf(marked.id) !== null ? 1 : 0;
        say("ask_cancel", "dirty=" + marked.dirty + " asked=1 answered=" + (answered ? 1 : 0)
          + " labels=" + asked.labels.join("|") + " kept=" + kept
          + " strip=" + (askNow() === null ? 0 : 1)
          + " focused=" + (kept === 1 && focusInCard(marked.id) ? 1 : 0));
      };
      const discardCheck = async () => {
        const marker = "DISCARD-SMOKE-MARKER";
        const marked = await markDirty(marker);
        if (marked === null) {
          say("ask_discard", "dirty=0 asked=0 answered=0 gone=0 leaked=0");
          return;
        }
        closeWithX(marked.id);
        await sleep(450);
        const asked = askNow();
        if (asked === null) {
          say("ask_discard", "dirty=" + marked.dirty + " asked=0 answered=0 gone=0 leaked=1");
          return;
        }
        const answered = await answer("不保存，关闭");
        const gone = cardRootOf(marked.id) === null && tabOf(marked.id) === null ? 1 : 0;
        // Only the disk can say the text was not written: reopen the file.
        runLine("open README.md");
        await sleep(900);
        const root = editorUnder();
        const area = root === null ? null : root.querySelector("textarea");
        const leaked = area !== null && area.value.indexOf(marker) !== -1 ? 1 : 0;
        say("ask_discard", "dirty=" + marked.dirty + " asked=1 answered=" + (answered ? 1 : 0)
          + " labels=" + asked.labels.join("|") + " gone=" + gone + " leaked=" + leaked);
      };
      const saveCheck = async () => {
        const marker = "SAVE-SMOKE-MARKER";
        const marked = await markDirty(marker);
        if (marked === null) {
          say("ask_save", "dirty=0 asked=0 answered=0 gone=0 saved=0");
          return;
        }
        closeWithX(marked.id);
        await sleep(450);
        const asked = askNow();
        if (asked === null) {
          say("ask_save", "dirty=" + marked.dirty + " asked=0 answered=0 gone=0 saved=0");
          return;
        }
        const answered = await answer("保存并关闭");
        await sleep(1200);
        const gone = cardRootOf(marked.id) === null && tabOf(marked.id) === null ? 1 : 0;
        runLine("open README.md");
        await sleep(900);
        const root = editorUnder();
        const area = root === null ? null : root.querySelector("textarea");
        const saved = area !== null && area.value.indexOf(marker) !== -1 ? 1 : 0;
        say("ask_save", "dirty=" + marked.dirty + " asked=1 answered=" + (answered ? 1 : 0)
          + " labels=" + asked.labels.join("|") + " gone=" + gone + " saved=" + saved);
      };
      /* The other two ways into a close -- the Ctrl+W key and the middle click --
       * must reach the same question the x does, or a user who never presses the
       * x would lose unsaved text without being asked. */
      const gestureAskCheck = async () => {
        const wMarked = await markDirty("CTRL-W-SMOKE-MARKER");
        let askedW = 0;
        let answeredW = 0;
        let keptW = 0;
        if (wMarked !== null) {
          await openTab(wMarked.id);
          closeWithCtrlW();
          await sleep(500);
          askedW = askNow() === null ? 0 : 1;
          if (askedW === 1) {
            answeredW = (await answer("取消")) ? 1 : 0;
            keptW = cardRootOf(wMarked.id) !== null ? 1 : 0;
          }
        }
        const mMarked = await markDirty("MIDDLE-SMOKE-MARKER");
        let askedM = 0;
        let answeredM = 0;
        let keptM = 0;
        if (mMarked !== null) {
          closeWithMiddle(mMarked.id);
          await sleep(500);
          askedM = askNow() === null ? 0 : 1;
          if (askedM === 1) {
            answeredM = (await answer("取消")) ? 1 : 0;
            keptM = cardRootOf(mMarked.id) !== null ? 1 : 0;
          }
        }
        say("ask_gestures", "asked_w=" + askedW + " answered_w=" + answeredW + " kept_w=" + keptW
          + " asked_m=" + askedM + " answered_m=" + answeredM + " kept_m=" + keptM);
      };
      runLine("mode classic");
      await waitFor(() => inView("classic"));
      await sleep(350);
      await syncStrip("classic");

      /* x on the *active* tab: the neighbour that slides into its place takes the
       * selection and the keyboard.  Activating it first is what makes the
       * neighbour rule the thing under test. */
      let closeIds = tabIds();
      const xTarget = closeIds[Math.max(0, Math.floor(closeIds.length / 2) - 1)];
      await openTab(xTarget);
      closeIds = tabIds();
      const xNext = rightOf(closeIds, xTarget);
      closeWithX(xTarget);
      await sleep(420);
      say("x_close", gestureFacts(xTarget, xNext));

      /* A middle click closes the tab under the pointer even when it is not the
       * active one, and the card the user is working in must not move. */
      closeIds = tabIds();
      const mTarget = closeIds[0] === undefined ? null : closeIds[0];
      const mKeep = closeIds[closeIds.length - 1];
      if (mKeep !== undefined) { await openTab(mKeep); }
      if (mTarget !== null) { closeWithMiddle(mTarget); }
      await sleep(420);
      say("middle_close", gestureFacts(mTarget, mKeep));

      closeIds = tabIds();
      const wTarget = closeIds[Math.max(0, closeIds.length - 2)];
      await openTab(wTarget);
      closeIds = tabIds();
      const wNext = rightOf(closeIds, wTarget);
      closeWithCtrlW();
      await sleep(420);
      say("ctrl_w", gestureFacts(wTarget, wNext));

      closeIds = tabIds();
      const lTarget = closeIds[closeIds.length - 1];
      await openTab(lTarget);
      closeIds = tabIds();
      const lNext = leftOf(closeIds, lTarget);
      closeWithX(lTarget);
      await sleep(420);
      say("close_last_neighbour", "gone=" + (tabOf(lTarget) === null && cardRootOf(lTarget) === null ? 1 : 0)
        + " next=" + (lNext === null ? "-" : lNext)
        + " shown=" + (lNext !== null && areaHas(lNext) ? 1 : 0)
        + " focused=" + (lNext !== null && focusInCard(lNext) ? 1 : 0));

      await cancelCheck();
      await discardCheck();
      await saveCheck();
      await gestureAskCheck();

      /* ---------------- the same close, in the mod view ---------------- */
      /* The assertions above prove the classic strip's gestures; the mod view
       * tiles the board differently (sidebar / panel / its own tab list), so a
       * close there is driven for real too -- "the card is reachable" is not
       * "the card closes and the right neighbour takes over". */
      runLine("mode mod");
      await waitFor(() => inView("mod"));
      await sleep(350);
      const lastNoteRoot = () => {
        const roots = Array.from(doc().querySelectorAll('#cards .card[data-kind="note"]'));
        return roots.length === 0 ? null : roots[roots.length - 1];
      };
      /* Close one clean card -- a fresh note, which has nothing to lose, so the
       * question must not open -- and report the neighbours the strip showed,
       * so Python can check the neighbour RULE instead of trusting the page. */
      const closeInMod = async (key, close) => {
        runLine("note " + key + " probe");
        await sleep(700);
        await syncStrip("mod");
        const root = lastNoteRoot();
        if (root === null) {
          say(key, "view=" + (inView("mod") ? 1 : 0)
            + " closed=- right=- left=- gone=0 next=- shown=0 focused=0 tabs=0");
          return;
        }
        const id = root.getAttribute("data-card-id");
        await openTab(id);
        const ids = tabIds();
        const right = rightOf(ids, id);
        const left = leftOf(ids, id);
        close(id);
        await sleep(600);
        say(key, "view=" + (inView("mod") ? 1 : 0)
          + " closed=" + id
          + " right=" + (right === null ? "-" : right)
          + " left=" + (left === null ? "-" : left)
          + " " + gestureFacts(id, right !== null ? right : left));
      };
      await closeInMod("mod_x_close", closeWithX);
      await closeInMod("mod_ctrl_w", () => { closeWithCtrlW(); });

      /* ---------------- undo gives a closed card back ---------------- */
      runLine("note undo_close probe");
      await sleep(700);
      await syncStrip("mod");
      let undoTarget = null;
      let undoGone = 0;
      let undoBack = 0;
      let undoTab = 0;
      const undoRoot = lastNoteRoot();
      if (undoRoot !== null) {
        undoTarget = undoRoot.getAttribute("data-card-id");
        await openTab(undoTarget);
        closeWithX(undoTarget);
        await sleep(600);
        undoGone = cardRootOf(undoTarget) === null && tabOf(undoTarget) === null ? 1 : 0;
        /* Only the board's ring can give a closed card back, and a text field
         * would keep the keystroke for its own undo -- blur first, the way a
         * keyboard user leaves the field before pressing Ctrl+Z. */
        const active = doc().activeElement;
        if (active !== null && typeof active.blur === "function") {
          active.blur();
        }
        doc().dispatchEvent(
          new KeyboardEvent("keydown", { key: "z", ctrlKey: true, bubbles: true, cancelable: true }),
        );
        await sleep(800);
        undoBack = cardRootOf(undoTarget) !== null ? 1 : 0;
        undoTab = tabOf(undoTarget) !== null ? 1 : 0;
      }
      say("undo_close", "gone=" + undoGone + " back=" + undoBack + " tab=" + undoTab
        + " id=" + (undoTarget === null ? "-" : undoTarget));

      /* ---------------- the Yarn language strips ----------------
       * The mod layer answers about the text being edited, so the probe types
       * into the real textarea, lets the real debounce run, and reads the real
       * strips.  Facts stay small; the rules are Python's to judge. */
      runLine("mode mod");
      await waitFor(() => inView("mod"));
      await sleep(300);
      runLine("open main.yarn");
      await sleep(900);
      await syncStrip("mod");
      const lastEditorFor = (pattern) => {
        const roots = Array.from(doc().querySelectorAll('#cards .card[data-kind="editor"]'));
        for (let i = roots.length - 1; i >= 0; i -= 1) {
          const label = roots[i].querySelector(".card-label");
          if (label !== null && pattern.test(label.textContent || "")) { return roots[i]; }
        }
        return null;
      };
      const areaOf = (root) => (root === null ? null : root.querySelector("textarea.ed-input"));
      const shownBar = (root, selector) => {
        const bar = root === null ? null : root.querySelector(selector);
        return bar !== null && !bar.hidden;
      };
      const rowsOf = (root) => (root === null ? [] : Array.from(
        root.querySelectorAll(".ed-complete-item .ed-complete-label"),
      ).map((node) => node.textContent));
      const typeInto = (root, text, caret) => {
        const area = areaOf(root);
        if (area === null) { return false; }
        area.focus();
        area.value = text;
        area.setSelectionRange(caret, caret);
        area.dispatchEvent(new Event("input", { bubbles: true }));
        return true;
      };
      const keyOn = (root, name, extra) => {
        const area = areaOf(root);
        if (area === null) { return; }
        area.focus();
        area.dispatchEvent(new KeyboardEvent("keydown", Object.assign(
          { key: name, bubbles: true, cancelable: true }, extra || {},
        )));
      };
      const openMenu = async (root, text, caret) => {
        typeInto(root, text, caret);
        await sleep(650);
        return rowsOf(root);
      };
      const menuShown = (root) => (shownBar(root, ".ed-complete") ? 1 : 0);
      const editorText = (root) => (areaOf(root) === null ? "" : areaOf(root).value);

      let yarn = lastEditorFor(/\.yarn$/i);
      let rows = await openMenu(yarn, "<<jump", 6);
      say("lang_menu",
        "root=" + (yarn !== null ? 1 : 0)
        + " shown=" + menuShown(yarn)
        + " rows=" + rows.length
        + " first=" + encodeURIComponent(rows.length === 0 ? "-" : rows[0]));
      // Enter accepts the active row: the command lands, the caret moves into
      // its argument slot, and whatever the argument slot answers next is not
      // this check's business -- the text change is.
      keyOn(yarn, "Enter");
      await sleep(300);
      say("lang_accept",
        "text=" + encodeURIComponent(editorText(yarn))
        + " caret=" + (areaOf(yarn) === null ? -1 : areaOf(yarn).selectionStart));
      // Escape closes the menu and touches nothing.
      await openMenu(yarn, "<<jump", 6);
      const beforeEscape = editorText(yarn);
      keyOn(yarn, "Escape");
      await sleep(250);
      say("lang_escape",
        "shown=" + menuShown(yarn)
        + " kept=" + (editorText(yarn) === beforeEscape ? 1 : 0));
      // Ctrl+Space is the "ask now" gesture: no debounce, the same menu.
      typeInto(yarn, "<<", 2);
      keyOn(yarn, " ", { ctrlKey: true });
      await sleep(300);
      say("lang_ctrl_space", "shown=" + menuShown(yarn) + " rows=" + rowsOf(yarn).length);
      // The menu is a promise about the document *and* the caret it was asked
      // about.  An arrow key moves the caret away from it, so the menu must go
      // and the next Enter must be the editor's Enter -- not an accept that
      // inserts a row at a place the author is no longer looking at.
      await openMenu(yarn, "<<jump", 6);
      const arrowRows = rowsOf(yarn).length;
      const arrowArea = areaOf(yarn);
      arrowArea.setSelectionRange(2, 2);
      keyOn(yarn, "ArrowLeft");
      await sleep(260);
      const arrowShown = menuShown(yarn);
      const arrowBefore = editorText(yarn);
      keyOn(yarn, "Enter");
      await sleep(320);
      say("lang_stale_arrow", "rows=" + arrowRows + " shown=" + arrowShown
        + " kept=" + (editorText(yarn) === arrowBefore ? 1 : 0)
        + " text=" + encodeURIComponent(editorText(yarn)));
      // The same promise cashed without any key at all: a find jump or an undo
      // can move the caret silently.  Enter then must not insert a row for the
      // caret the menu remembers.
      await openMenu(yarn, "<<jump", 6);
      const silentRows = rowsOf(yarn).length;
      areaOf(yarn).setSelectionRange(2, 2);
      await sleep(60);
      keyOn(yarn, "Enter");
      await sleep(320);
      say("lang_stale_silent", "rows=" + silentRows
        + " kept=" + (editorText(yarn) === "<<jump" ? 1 : 0)
        + " caret=" + (areaOf(yarn) === null ? -1 : areaOf(yarn).selectionStart));
      // A non-Yarn file never asks, whatever is typed into it.
      runLine("open README.md");
      await sleep(900);
      await syncStrip("mod");
      const readme = lastEditorFor(/README\.md$/i);
      typeInto(readme, "<<", 2);
      await sleep(700);
      say("lang_non_yarn", "shown=" + menuShown(readme));
      // Hover follows the caret: on a token it says something, away from one it
      // clears.  The line itself is data, so it travels encoded.
      runLine("open main.yarn");
      await sleep(900);
      await syncStrip("mod");
      yarn = lastEditorFor(/\.yarn$/i);
      typeInto(yarn, "<<jump>>", 8);
      await sleep(750);
      const hoverOn = shownBar(yarn, ".ed-hover") ? 1 : 0;
      const hoverText = hoverOn === 1 ? yarn.querySelector(".ed-hover").textContent : "";
      // The caret moves onto a plain word (a line below the command): nothing
      // token-shaped there, so the line must go.
      typeInto(yarn, "<<jump>>\nplain words", 12);
      await sleep(750);
      say("lang_hover",
        "on=" + hoverOn
        + " off=" + (shownBar(yarn, ".ed-hover") ? 1 : 0)
        + " line=" + encodeURIComponent(hoverText));
    } catch (err) {
      say("error", (err && err.message) || String(err));
    }
    finish();
  })();
})();
</script>
</body>
</html>
"""


def _varint(value: int) -> bytes:
    """libGDX's ``DataOutput.writeInt(value, true)``: 7 bits a byte, low group first."""
    out = bytearray()
    while True:
        chunk = value & 0x7F
        value >>= 7
        if value:
            out.append(chunk | 0x80)
        else:
            out.append(chunk)
            return bytes(out)


def _spine_string(text: str | None) -> bytes:
    """libGDX's ``DataOutput.writeString``: 0 means null, else the byte count plus one."""
    if text is None:
        return _varint(0)
    raw = text.encode("utf-8")
    return _varint(len(raw) + 1) + raw


def _spine_f32(*values: float) -> bytes:
    return b"".join(struct.pack(">f", value) for value in values)


def _spine_rig() -> tuple[bytes, str]:
    """A synthetic Spine 4.2 skeleton and its atlas: one bone, one slot, one region.

    The card round trip only needs the kind to open and mount, and the game's own
    rigs are not in this repository -- so the fixture is written here, to the
    layout ``shell/web/spine.mjs`` documents, rather than committing a binary
    blob nobody can read.  It is not an export from Spine: it is the smallest
    buffer that reader accepts, which is exactly what this test needs and no more
    (a real rig, with meshes and animations, is what the card is for).
    """
    #: Version 4.2.43, an 8-byte zero hash, and the bounds/scale header.
    skeleton = bytearray(b"\x00" * 8)
    skeleton += _spine_string("4.2.43")
    skeleton += _spine_f32(0.0, 0.0, 64.0, 64.0, 1.0)
    skeleton += b"\x00"  # nonessential = false, so no fps/paths and no extra fields
    #: The string table: "body", referenced by the slot and the attachment.
    skeleton += _varint(1) + _spine_string("body")
    #: One bone: root, length 100, inherit mode 0 (normal), not skin-required.
    skeleton += _varint(1) + _spine_string("root")
    skeleton += _spine_f32(0.0, 0.0, 0.0, 1.0, 1.0, 0.0, 0.0, 100.0)
    skeleton += b"\x00\x00"
    #: One slot: "body" on bone 0, opaque white, no dark colour, "body" attached.
    skeleton += _varint(1) + _spine_string("body") + _varint(0)
    skeleton += struct.pack(">i", -1) + struct.pack(">i", -1)
    skeleton += _varint(1) + b"\x00"
    #: No IK, transform, path or physics constraints.
    skeleton += b"\x00\x00\x00\x00"
    #: The default skin: one slot, one region attachment keyed "body".
    skeleton += _varint(1) + _varint(0) + _varint(1) + _varint(1)
    skeleton += b"\x00"  # region flags: no name, no path, no colour, no sequence
    skeleton += _spine_f32(0.0, 0.0, 1.0, 1.0, 64.0, 64.0)
    #: No named skins, no events, no animations.
    skeleton += b"\x00\x00\x00"
    atlas = (
        "rig.png\n"
        "size: 64,64\n"
        "format: RGBA8888\n"
        "filter: Linear,Linear\n"
        "pma: true\n"
        "body\n"
        "bounds: 0,0,64,64\n"
    )
    return bytes(skeleton), atlas


def _cards_workspace(sandbox: Path) -> None:
    """The workspace the card round trip runs in: a real file for each kind.

    No board is written.  A cold boot is part of what the round trip walks (the
    window has to open on the mod tile), and the page adds the empty-board hint
    note itself -- which is why the note probe takes the *last* note card.
    """
    (sandbox / "README.md").write_text(
        "# smoke workspace\n\nOne text file, for the editor card.\n", encoding="utf-8"
    )
    (sandbox / "main.yarn").write_text("title: Smoke\n---\nHello, world!\n===\n", encoding="utf-8")
    # A 1x1 transparent PNG: the pixel card fetches the bytes over /rpc, and a
    # placeholder is enough for its root to mount.
    (sandbox / "icon.png").write_bytes(
        base64.b64decode(
            "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg=="
        )
    )
    # A one-second 8-bit mono WAV: the audio card mounts from the bytes the
    # kernel returns, and a real header is what makes it a recording rather
    # than a file with an audio extension.
    samples = 8000
    wav = (
        b"RIFF" + struct.pack("<I", 36 + samples) + b"WAVE"
        + b"fmt " + struct.pack("<IHHIIHH", 16, 1, 1, 8000, 8000, 1, 8)
        + b"data" + struct.pack("<I", samples) + bytes([128]) * samples
    )
    (sandbox / "tone.wav").write_bytes(wav)
    # The rig card reads three files beside each other: the skeleton, its
    # atlas, and the page image the atlas names.
    rig, atlas = _spine_rig()
    (sandbox / "rig.skel.bytes").write_bytes(rig)
    (sandbox / "rig.atlas.txt").write_text(atlas, encoding="utf-8")
    shutil.copyfile(sandbox / "icon.png", sandbox / "rig.png")
    package = sandbox / "NewMod"
    package.mkdir(parents=True, exist_ok=True)
    (package / "mod.json").write_text(
        json.dumps(
            {
                "name": "NewMod",
                "version": "1.0.0",
                "author": "browser smoke",
                "description": "the package the card round trip opens",
                "gameVersion": "1.0",
                "loadOrder": 1,
            },
            indent=2,
        )
        + "\n",
        encoding="utf-8",
    )


def _card_page() -> str:
    """``CARD_PAGE`` with the kind/view/command lists spliced in as JS arrays."""
    return (
        CARD_PAGE
        .replace("__KINDS__", json.dumps(list(CARD_KINDS)))
        .replace("__VIEWS__", json.dumps(list(CARD_VIEWS)))
        .replace("__COMMANDS__", json.dumps(list(CARD_COMMANDS)))
    )


def card_round_trip(edge, args) -> dict:
    """Drive both tiles in a throwaway workspace; return the wrapper's facts.

    Raises :class:`DriverError` when the sandbox host cannot be brought up; a
    page that merely reports the wrong facts is for ``define_card_checks`` to
    judge.
    """
    sandbox = Path(tempfile.mkdtemp(prefix="infantgod-smoke-cardws-"))
    profile = Path(tempfile.mkdtemp(prefix="infantgod-smoke-card-"))
    host = None
    written = False
    try:
        _cards_workspace(sandbox)
        CARD_WRAPPER.write_text(_card_page(), encoding="utf-8")
        written = True
        port = free_port()
        host = Host(
            port,
            [
                "node", str(SHELL_MAIN),
                "serve",
                "--workspace", str(sandbox),
                "--mods-root", str(sandbox),
                # A throwaway user directory: the settings card's preferences live
                # there, so a developer machine that once picked the classic view
                # cannot change which view this run's cold boot lands on.
                "--user-dir", str(profile / "user"),
                "--port", str(port),
                "--no-open",
            ],
        )
        host.start()
        show("cards host", f"{host.url} (workspace {sandbox})")
        host.wait_ready(args.timeout)
        status = host.probe(timeout=min(10.0, args.timeout))
        if status != 200:
            raise DriverError(f"GET / on the card host answered {status}, expected 200")
        return _drive_wrapper(
            edge, args, profile,
            f"{host.url}{CARD_WRAPPER_NAME}?app=%2F",
            "card reachability",
        )
    finally:
        if host is not None:
            host.close()
        if written:
            CARD_WRAPPER.unlink(missing_ok=True)
        shutil.rmtree(profile, ignore_errors=True)
        shutil.rmtree(sandbox, ignore_errors=True)


def _split_fact_line(line: str) -> dict:
    """``"root=1 tab=0 visible=1"`` -> ``{"root": "1", ...}``."""
    parsed = {}
    for part in line.split():
        name, separator, value = part.partition("=")
        if separator and name:
            parsed[name] = value
    return parsed


def define_card_checks(facts: dict) -> list:
    """The G29 assertions, as ``(name, callable)`` pairs.

    One per (view, kind): the card was opened from the UI, its root is drawn
    (not ``is-hidden``) and it took the keyboard.  Plus one that says every card
    the board mounted is drawn somewhere or offered as a tab.
    """
    require(
        facts,
        "the card wrapper page reported nothing: the browser dump carried no #result block, "
        "so the page never ran its probe",
    )
    require(not facts.get("error"), f"the card wrapper page failed: {facts.get('error')}")

    def card_check(view: str, kind: str):
        def check():
            line = facts.get(f"card_{view}_{kind}", "")
            require(line, f"{view}: the wrapper page reported no line for the {kind} card")
            parsed = _split_fact_line(line)
            require(
                parsed.get("root") == "1",
                f"{view}: no {kind} card root was mounted at all (facts {line!r})",
            )
            require(
                parsed.get("visible") == "1",
                f"{view}: the {kind} card root is is-hidden -- the tile has a place for no part of "
                "it and the strip offers no way in, which is the G29 defect",
            )
            require(
                parsed.get("focused") == "1",
                f"{view}: the {kind} card root could not take the keyboard after its own part of "
                "the tile (or its tab) was used",
            )
            via = "its tab" if parsed.get("tab") == "1" else "its own part of the tile"
            return f"{view}: {kind} reached through {via}, drawn and focusable"
        return check

    checks = []
    for view in CARD_VIEWS:
        for kind in CARD_KINDS:
            checks.append((f"G29: the {view} tile shows the {kind} card from the UI", card_check(view, kind)))

    def every_card_reachable():
        parts = []
        for view in CARD_VIEWS:
            line = facts.get(f"reach_{view}", "")
            require(line, f"{view}: the wrapper page reported no reachability line")
            parsed = _split_fact_line(line)
            total = parsed.get("total", "")
            reachable = parsed.get("reachable", "")
            require(
                total.isdigit() and int(total) >= len(CARD_KINDS),
                f"{view}: only {total!r} card(s) are mounted; the round trip opened one of every "
                f"kind ({len(CARD_KINDS)})",
            )
            require(
                reachable == total,
                f"{view}: {total} card(s) are mounted but only {reachable} are reachable -- a "
                "card that is hidden and has no tab has disappeared with the canvas",
            )
            parts.append(f"{view}: {reachable}/{total} cards reachable")
        return "; ".join(parts)

    checks.append(("G29: every open card is reachable in both views", every_card_reachable))

    def rig_saves_what_it_shows():
        require(facts.get("rig_card"), "the wrapper page reported no line for the rig card")
        require(
            _split_fact_line(facts["rig_card"]).get("root") == "1",
            "no rig card root was mounted, so the save round trip could not run",
        )
        edit = _split_fact_line(facts.get("rig_edit", ""))
        save = _split_fact_line(facts.get("rig_save", ""))
        require(facts.get("rig_edit"), "the wrapper page reported no rig edit line")
        require(edit.get("opened") == "1", "the rig card has no Edit button to press")
        require(
            edit.get("rows", "").isdigit() and int(edit["rows"]) >= 1,
            f"the rig card listed no bones (facts {facts.get('rig_edit')!r})",
        )
        require(
            edit.get("edited") == "1",
            "typing a number into the rig inspector did not mark the rig edited",
        )
        require(facts.get("rig_save"), "the wrapper page reported no rig save line")
        require(
            save.get("written") == "1",
            f"pressing Save on the rig card never reported a save (facts {facts.get('rig_save')!r})",
        )
        require(
            save.get("changed") == "1",
            "the rig file on disk was byte-identical after saving an edit, so nothing was written",
        )
        require(facts.get("rig_back"), "the wrapper page never read the saved file back")
        back = _split_fact_line(facts["rig_back"])
        require(
            back.get("rotation") == edit.get("typed"),
            "the saved file does not carry the angle typed into the inspector "
            f"(file says {back.get('rotation')!r}, inspector said {edit.get('typed')!r})",
        )
        return (
            f"the edited pose was written back ({save.get('b64_before', '?')} -> "
            f"{save.get('b64_after', '?')} base64 characters) and read back as "
            f"bone 0 rotation {back.get('rotation')}"
        )

    checks.append(("G29: the rig card saves the pose it is showing back to the rig", rig_saves_what_it_shows))

    def rig_refuses_a_clean_save():
        require(facts.get("rig_again"), "the wrapper page reported no second rig save line")
        again = _split_fact_line(facts["rig_again"])
        require(
            again.get("refused") == "1",
            "a rig card with no edit saved the file again instead of answering 'nothing to save'",
        )
        return "a clean rig card answers 'nothing to save' and leaves the file alone"

    checks.append(("G29: the rig card refuses to write a rig with no edit", rig_refuses_a_clean_save))

    def mod_card_makes_a_file():
        require(facts.get("mod_card"), "the wrapper page reported no line for the mod card")
        require(
            _split_fact_line(facts["mod_card"]).get("root") == "1",
            "no mod card root was mounted, so the new-file row could not be used",
        )
        pick = _split_fact_line(facts.get("mod_new_pick", ""))
        require(facts.get("mod_new_pick"), "the wrapper page reported no new-file picker line")
        require(pick.get("select") == "1", "the mod card has no new-file kind picker")
        require(
            pick.get("goods") == "1",
            f"the picker was not generated from the knowledge base's types (facts {facts.get('mod_new_pick')!r})",
        )
        require(
            pick.get("yarn") == "1",
            "the picker does not offer the story kind this side writes itself",
        )
        require(
            pick.get("greyed", "0").isdigit() and int(pick["greyed"]) >= 2,
            "a rig and an audio file need tools this editor does not have, and should be "
            f"shown greyed rather than missing (facts {facts.get('mod_new_pick')!r})",
        )
        require(facts.get("mod_new"), "the wrapper page reported no new-file result line")
        new = _split_fact_line(facts["mod_new"])
        require(
            new.get("created") == "1",
            f"the new-file row did not create a define from its schema (facts {facts.get('mod_new')!r})",
        )
        require(
            new.get("keys") == "techName",
            "a Goods define made from the schema should carry exactly its required key, "
            f"got {new.get('keys')!r}",
        )
        require(
            new.get("techName") == "Goods_Smoke",
            f"the file does not name itself as its techName (facts {facts.get('mod_new')!r})",
        )
        return (
            f"the picker offered {pick.get('options')} kinds with {pick.get('greyed')} greyed; "
            "creating a Goods wrote exactly its required key and the name it was given"
        )

    checks.append(("G50: the mod card creates a file from the game's own schema", mod_card_makes_a_file))

    def mod_card_imports_a_file():
        require(facts.get("mod_import"), "the wrapper page reported no import result line")
        imported = _split_fact_line(facts["mod_import"])
        require(
            imported.get("imported") == "1",
            f"the mod card's import row did not import a file (facts {facts.get('mod_import')!r})",
        )
        require(
            imported.get("same") == "1",
            "the imported file is not byte-identical to the file it was copied from",
        )
        return "a workspace PNG imported into the package lands byte for byte, at the target given"

    checks.append(("G50: the mod card imports a file into the package, byte for byte", mod_card_imports_a_file))

    ask_labels = ("保存并关闭", "不保存，关闭", "取消")

    def close_gesture(key: str) -> object:
        def check():
            line = facts.get(key, "")
            require(line, f"the wrapper page reported no {key!r} line for the close gesture")
            parsed = _split_fact_line(line)
            require(
                parsed.get("gone") == "1",
                f"the closed tab and its card are still there (facts {line!r})",
            )
            next_id = parsed.get("next", "")
            require(
                next_id not in ("", "-"),
                f"the closed tab had no neighbour to take over, so nothing proves the rule "
                f"(facts {line!r})",
            )
            require(
                parsed.get("shown") == "1",
                f"the neighbour {next_id} is not drawn in the area (facts {line!r})",
            )
            require(
                parsed.get("focused") == "1",
                f"the neighbour {next_id} did not take the keyboard (facts {line!r})",
            )
            return f"the tab and its card are gone; {next_id} is in the area and focused"
        return check

    def ask_line(key: str) -> dict:
        line = facts.get(key, "")
        require(line, f"the wrapper page reported no {key!r} line for the unsaved-text question")
        parsed = _split_fact_line(line)
        require(
            parsed.get("dirty") == "1",
            f"the editor never became dirty before the close (facts {line!r})",
        )
        require(
            parsed.get("asked") == "1",
            f"closing unsaved text asked nothing, so the text would be gone without a "
            f"decision (facts {line!r})",
        )
        require(parsed.get("answered") == "1", f"the answer button was not found (facts {line!r})")
        labels = parsed.get("labels", "").split("|")
        require(
            labels == list(ask_labels),
            f"the question offered {labels!r}, expected {list(ask_labels)!r}",
        )
        return parsed

    def cancel_keeps():
        parsed = ask_line("ask_cancel")
        require(parsed.get("kept") == "1", "cancel removed the card")
        require(parsed.get("strip") == "0", "the question strip is still on screen")
        require(parsed.get("focused") == "1", "cancel did not put the keyboard back on the card")
        return "the card, its text and the keyboard all stayed"

    def discard_keeps_file():
        parsed = ask_line("ask_discard")
        require(parsed.get("gone") == "1", "discard left the card on the board")
        require(parsed.get("leaked") == "0", "the discarded text reached the file on disk")
        return "the card is gone and the file on disk is unchanged"

    def save_before_close():
        parsed = ask_line("ask_save")
        require(parsed.get("gone") == "1", "save closed nothing: the card is still on the board")
        require(parsed.get("saved") == "1", "the saved text did not reach the reopened file")
        return "the text was written before the card went"

    def ask_gesture_checks():
        line = facts.get("ask_gestures", "")
        require(line, "the wrapper page reported no 'ask_gestures' line for Ctrl+W and the middle click")
        parsed = _split_fact_line(line)
        require(
            parsed.get("asked_w") == "1",
            f"Ctrl+W closed unsaved text without asking anything (facts {line!r})",
        )
        require(
            parsed.get("answered_w") == "1" and parsed.get("kept_w") == "1",
            f"Ctrl+W's question could not be answered with cancel, so the card was lost "
            f"(facts {line!r})",
        )
        require(
            parsed.get("asked_m") == "1",
            f"a middle click closed unsaved text without asking anything (facts {line!r})",
        )
        require(
            parsed.get("answered_m") == "1" and parsed.get("kept_m") == "1",
            f"the middle click's question could not be answered with cancel, so the card "
            f"was lost (facts {line!r})",
        )
        return "Ctrl+W and the middle click both reach the same question, and cancel keeps the card"

    def neighbour_rule(key: str, view: str) -> object:
        """The classic neighbour rule, driven from the mod view's own strip."""

        def check():
            line = facts.get(key, "")
            require(line, f"the wrapper page reported no {key!r} line for the {view} view close")
            parsed = _split_fact_line(line)
            require(
                parsed.get("view") == "1",
                f"the {view} view was not on screen when its close ran (facts {line!r})",
            )
            require(
                parsed.get("gone") == "1",
                f"the {view} view: the closed tab and its card are still there (facts {line!r})",
            )
            # The rule, checked from what the page saw, not from what it expected:
            # the right neighbour if there is one, else the left, else nothing.
            right = parsed.get("right", "-")
            left = parsed.get("left", "-")
            expected = right if right not in ("", "-") else left
            require(
                expected not in ("", "-"),
                f"the closed tab had no neighbour to take over in the {view} view (facts {line!r})",
            )
            require(
                parsed.get("next") == expected,
                f"the selection went to {parsed.get('next')!r}, but the rule names {expected!r} "
                f"(facts {line!r})",
            )
            require(
                parsed.get("shown") == "1",
                f"the neighbour {expected} is not drawn in the {view} view's area (facts {line!r})",
            )
            require(
                parsed.get("focused") == "1",
                f"the neighbour {expected} did not take the keyboard (facts {line!r})",
            )
            return f"the {view} view closed the tab and gave the selection to {expected}"

        return check

    def undo_close():
        line = facts.get("undo_close", "")
        require(line, "the wrapper page reported no 'undo_close' line")
        parsed = _split_fact_line(line)
        require(
            parsed.get("gone") == "1",
            f"the close that undo should reverse removed nothing (facts {line!r})",
        )
        require(
            parsed.get("back") == "1",
            f"Ctrl+Z did not give the closed card back (facts {line!r})",
        )
        require(
            parsed.get("tab") == "1",
            "the card came back without its tab, so the strip still acts as if it is gone",
        )
        require(
            parsed.get("id", "-") not in ("", "-"),
            "the page reported no id for the card it closed and undid",
        )
        return f"closing is a document edit: Ctrl+Z gave card {parsed.get('id')} and its tab back"

    checks.append(("G29: x closes the tab and the neighbour takes over", close_gesture("x_close")))
    checks.append(("G29: a middle click closes the tab like a browser tab", close_gesture("middle_close")))
    checks.append(("G29: Ctrl+W closes the active tab, not the window", close_gesture("ctrl_w")))
    checks.append(("G29: closing the last tab falls back to the left neighbour", close_gesture("close_last_neighbour")))
    checks.append(("G29: closing unsaved text asks first, and cancel keeps the card", cancel_keeps))
    checks.append(("G29: closing unsaved text answered discard removes it and writes nothing", discard_keeps_file))
    checks.append(("G29: closing unsaved text answered save writes before the card goes", save_before_close))
    checks.append(("G29: Ctrl+W and a middle click ask the same close question", ask_gesture_checks))
    checks.append(("G29: the mod view's x closes the tab and hands the neighbour the keyboard", neighbour_rule("mod_x_close", "mod")))
    checks.append(("G29: the mod view's Ctrl+W closes the active tab", neighbour_rule("mod_ctrl_w", "mod")))
    checks.append(("G29: Ctrl+Z gives a closed card back, tab and all", undo_close))

    def lang_fact(key: str) -> dict:
        line = facts.get(key, "")
        require(line, f"the wrapper page reported no {key!r} line for the Yarn language strips")
        return _split_fact_line(line)

    def lang_menu():
        parsed = lang_fact("lang_menu")
        require(parsed.get("root") == "1", "no .yarn editor card was mounted to ask")
        require(
            parsed.get("shown") == "1",
            f"typing `<<jum` into a .yarn card opened no completion menu (facts {parsed!r})",
        )
        first = urllib.parse.unquote(parsed.get("first", ""))
        require(
            first == "jump",
            f"the first candidate was {first!r}, expected the `jump` command",
        )
        require(int(parsed.get("rows", "0") or "0") >= 1, "the menu opened with no rows")
        return "typing `<<jum` opens the menu and names `jump` first"

    def lang_accept():
        parsed = lang_fact("lang_accept")
        text = urllib.parse.unquote(parsed.get("text", ""))
        require(
            text == "<<jump ",
            f"accepting the `jump` row left the card as {text!r}, expected '<<jump ' -- "
            "the prefix has to be replaced by the row's insert text",
        )
        require(
            parsed.get("caret") == "7",
            f"the caret did not land after the inserted text (facts {parsed!r})",
        )
        return "Enter accepts the row, replaces the prefix and leaves the caret after the command"

    def lang_escape():
        parsed = lang_fact("lang_escape")
        require(parsed.get("shown") == "0", "Escape left the completion menu on screen")
        require(parsed.get("kept") == "1", "Escape changed the text while only closing the menu")
        return "Escape closes the menu and leaves the text alone"

    def lang_ctrl_space():
        parsed = lang_fact("lang_ctrl_space")
        require(
            parsed.get("shown") == "1",
            "Ctrl+Space did not ask for the menu (the debounce never ran in time)",
        )
        require(int(parsed.get("rows", "0") or "0") >= 1, "Ctrl+Space opened an empty menu")
        return "Ctrl+Space asks for the menu immediately"

    def lang_non_yarn():
        parsed = lang_fact("lang_non_yarn")
        require(
            parsed.get("shown") == "0",
            "a non-Yarn file opened a completion menu -- the cards must only ask for .yarn",
        )
        return "a non-Yarn card never opens the menu"

    def lang_hover():
        parsed = lang_fact("lang_hover")
        require(parsed.get("on") == "1", "hovering `<<jump>>` printed no line")
        line = urllib.parse.unquote(parsed.get("line", ""))
        require("jump" in line, f"the hover line said {line!r}, expected the jump command's doc")
        require(
            parsed.get("off") == "0",
            "the hover line stayed up with the caret on plain text, away from any token",
        )
        return "hover prints one line on a token and clears when the caret leaves it"

    def lang_stale_arrow():
        parsed = lang_fact("lang_stale_arrow")
        require(
            int(parsed.get("rows", "0") or "0") >= 1,
            f"the menu opened with no rows, so there was nothing to leave stale (facts {parsed!r})",
        )
        require(
            parsed.get("shown") == "0",
            "an arrow key moved the caret but left the completion menu up for the old one",
        )
        require(
            parsed.get("kept") == "1",
            "Enter after the caret moved accepted a row: the text changed although the "
            "caret was no longer where the menu was asked",
        )
        return "an arrow key closes the menu, and Enter then leaves the text alone"

    def lang_stale_silent():
        parsed = lang_fact("lang_stale_silent")
        require(
            int(parsed.get("rows", "0") or "0") >= 1,
            f"the menu opened with no rows, so there was nothing to leave stale (facts {parsed!r})",
        )
        require(
            parsed.get("kept") == "1",
            "Enter accepted a row for a caret the menu was never asked about (the text changed)",
        )
        require(
            parsed.get("caret") == "2",
            f"Enter moved the caret to {parsed.get('caret')!r} instead of leaving it at 2",
        )
        return "a silent caret move makes Enter refuse the stale row"

    checks.append(("Yarn strips: typing `<<jum` opens the menu and names `jump`", lang_menu))
    checks.append(("Yarn strips: Enter accepts the row and relocates the caret", lang_accept))
    checks.append(("Yarn strips: Escape closes the menu without touching the text", lang_escape))
    checks.append(("Yarn strips: Ctrl+Space asks without waiting for the debounce", lang_ctrl_space))
    checks.append(("Yarn strips: a non-Yarn card never opens the menu", lang_non_yarn))
    checks.append(("Yarn strips: hover follows the caret on and off a token", lang_hover))
    checks.append(("Yarn strips: an arrow key closes the menu, and Enter keeps the text", lang_stale_arrow))
    checks.append(("Yarn strips: Enter refuses a row for a caret that moved silently", lang_stale_silent))
    return checks


def _build_parser() -> argparse.ArgumentParser:
    parser = _Parser(
        prog="browser_smoke.py",
        description=(
            "Drive the OsanaKami IDE Studio board UI in the real browser and assert on the dumped DOM. "
            "Exit codes: 0 pass or skipped, 1 a check failed, 2 could not run, 3 usage."
        ),
    )
    parser.add_argument(
        "--port", type=int, default=0, metavar="N",
        help="port for the host (default: ask the OS for a free one)",
    )
    parser.add_argument(
        "--edge", default=None, metavar="PATH",
        help="browser executable (default: the system Edge, if installed)",
    )
    parser.add_argument(
        "--timeout", type=float, default=60.0, metavar="S",
        help="seconds for the host to start and per browser launch (default 60)",
    )
    parser.add_argument(
        "--keep", action="store_true",
        help="keep the throwaway browser profile and the board backup",
    )
    return parser


def _run(host: Host, backup: BoardBackup, edge, args, style: Style) -> int:
    """Start, drive and judge one run; the caller owns every cleanup."""
    profile_dir = None
    exits = 1
    restored = False
    host_gone = False
    got_dom = False
    passed = failed = total = attempts = 0
    try:
        host.start()
        show("serving", f"{host.url} (pid {host.proc.pid})")
        banner = host.wait_ready(args.timeout)
        show("host ready", _short(banner, 300))
        status = host.probe(timeout=min(10.0, args.timeout))
        if status != 200:
            raise DriverError(f"GET / answered {status}, expected 200")
        show("http", f"GET / -> {status}")

        profile_dir = Path(tempfile.mkdtemp(prefix="infantgod-smoke-edge-"))
        show("profile", str(profile_dir))
        dom, attempts, note = grab_dom(
            edge, host.url, profile_dir, args.timeout, budget=min(args.timeout, 90.0)
        )
        got_dom = True
        show("dom", f"{len(dom)} chars from {attempts} browser launch(es)")
        if note:
            show("dom note", note)
            if attempts > 1:
                # Every launch was cut short; say so rather than letting a
                # best-effort dump look like a clean one.
                show("dom caution", "the dump may be missing late-arriving state")

        board = read_board(BOARD_PATH)
        facts = board_facts(board)
        show(
            "live board",
            f"{facts['count']} cards ({', '.join(facts['kinds']) or 'none'}), "
            f"editor file={facts['file']!r}",
        )
        print(style.dim("-" * 68))

        harness = Harness(dom, style, sys.stdout)
        for name, check in define_checks(facts, BOARD_PATH, dom):
            harness.run(name, check)

        # The board dump cannot see a click, a keystroke or an iframe, so the
        # round trip drives its own page in a sandbox workspace and reports what
        # it saw; the checks below only judge that report.
        print(style.dim("-" * 68))
        show("e2e", "new-mod round trip, in a throwaway workspace")
        try:
            mod_facts = newmod_round_trip(edge, args)
        except DriverError as exc:
            raise DriverError(f"the new-mod round trip could not run: {exc}") from exc
        for name, check in define_newmod_checks(mod_facts):
            harness.run(name, check)

        # G29: the second page opens one card of every kind and walks both
        # tiles; its checks are the only proof that a hidden kind is one press
        # away rather than gone with the canvas.
        print(style.dim("-" * 68))
        show("e2e", "every card kind in both views, in a throwaway workspace")
        try:
            card_facts = card_round_trip(edge, args)
        except DriverError as exc:
            raise DriverError(f"the card round trip could not run: {exc}") from exc
        for name, check in define_card_checks(card_facts):
            harness.run(name, check)
        passed = sum(1 for item in harness.results if item["ok"])
        failed = sum(1 for item in harness.results if not item["ok"])
        total = len(harness.results)
        exits = 0 if failed == 0 else 1
    except (DriverError, CheckFailed) as exc:
        show("FAIL", f"{exc}")
        tail = host.tail()
        if tail:
            show("host output", _short(tail, 500))
        exits = 2
    except KeyboardInterrupt:
        show("interrupted", "the run was cancelled from the keyboard")
        exits = 130
    finally:
        host_gone = host.close()
        if profile_dir is not None:
            if args.keep:
                show("profile kept", str(profile_dir))
            elif not got_dom:
                # The run never got a usable DOM, so the debris is the evidence.
                show("profile kept", f"{profile_dir} (the run never produced a DOM)")
            else:
                shutil.rmtree(profile_dir, ignore_errors=True)

    restored = backup.restore()
    print(style.dim("-" * 68))
    if backup.existed:
        exact = "byte-identical" if restored else "NOT byte-identical"
        show("restore", f"{BOARD_PATH} restored ({exact})")
    elif restored:
        show("restore", f"{BOARD_PATH} removed again (the clone had none)")
    else:
        show("restore", f"FAIL {BOARD_PATH} is still there -- remove it by hand")
    if args.keep and backup.backup is not None:
        show("board backup kept", str(backup.backup))
    elif not restored and backup.backup is not None:
        # The bytes on disk are not the ones this run started with, so the aside
        # copy is now the only copy of the original: keep it, always.
        show("board backup kept", f"{backup.backup} (the restore was not byte-identical)")
    else:
        backup.discard()
    show("host", "terminated by pid" if host_gone else "DID NOT EXIT -- kill it by hand")

    if exits == 0 and (not restored or not host_gone):
        # Never exit 0 while the environment is not as it was found.
        exits = 1
        failed += 1
    if exits != 0:
        # A failing run still owes the reader a summary line; the per-check
        # PASS/FAIL lines above are the detail.
        if failed == 0:
            failed = 1  # the environment, not a check, is what failed
        print(
            f"summary: {passed} passed, {style.bad(f'{failed} failed')} "
            f"({total} checks, {attempts} browser launch(es))"
        )
        return exits

    summary = (
        f"summary: {style.ok(f'{passed} passed')}, 0 failed "
        f"({total} checks, {attempts} browser launch(es))"
    )
    print(summary)
    return 0


def main(argv=None) -> int:
    """Entry point; returns the process exit code."""
    parsed = _build_parser().parse_args(argv)
    stream = sys.stdout
    style = Style(colour_enabled(stream))
    started = time.monotonic()

    if parsed.timeout <= 0:
        _build_parser().error("--timeout must be positive")
    if parsed.port < 0 or parsed.port > 65535:
        print(f"browser_smoke.py: --port {parsed.port} is not a TCP port", file=sys.stderr)
        return 2

    try:
        edge = find_edge(parsed.edge)
    except DriverError as exc:
        show("SKIP", f"no browser available: {exc}")
        show("how to fix", "pass --edge PATH, or install Microsoft Edge")
        print(
            f"summary: 0 passed, 0 failed, "
            f"{5 + NEWMOD_CHECK_COUNT + CARD_CHECK_COUNT} skipped (no browser)"
        )
        return 0

    show("OsanaKami IDE Studio browser smoke", str(REPO_ROOT))
    show("browser", str(edge))
    show("kernel", f"{SHELL_MAIN.relative_to(REPO_ROOT)} (node)")

    # Back the board up BEFORE the host can touch it, and choose the port:
    # both can fail, and neither may leave a process or a modified file behind.
    backup = BoardBackup(BOARD_PATH)
    backup.snapshot()
    try:
        backup.install_if_absent()
    except (DriverError, OSError) as exc:
        show("FAIL setup", f"{exc}")
        backup.discard()
        return 2
    show(
        "board",
        str(BOARD_PATH)
        if backup.existed
        else f"{BOARD_PATH} (absent -- installed {STARTER_BOARD.name} for this run)",
    )
    print(style.dim("-" * 68))

    try:
        port = parsed.port or free_port()
    except OSError as exc:
        show("FAIL setup", f"cannot pick a free port: {exc}")
        backup.discard()
        return 2

    host = Host(port)
    try:
        code = _run(host, backup, edge, parsed, style)
    except KeyboardInterrupt:
        code = 130
    except Exception as exc:  # noqa: BLE001 - never leave the host or board behind
        show("FAIL unexpected", f"{type(exc).__name__}: {exc}")
        terminate(host.proc)
        backup.restore()
        backup.discard()
        code = 2

    if code == 0:
        print(style.dim(f"total {time.monotonic() - started:.1f}s"))
    return code


if __name__ == "__main__":
    sys.exit(main())
