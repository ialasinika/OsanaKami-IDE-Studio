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
* a green run says the page booted, the HUD and the board agree, the command
  vocabulary shipped, and the new-mod path works -- not that the UI is correct
  in any wider sense.

Exit codes
    0   every check passed -- or the browser is not installed (a SKIP line)
    1   the browser was available and at least one check failed
    2   the smoke test could not run (host never listened, browser never
        produced a DOM, malformed ``--port``)
    3   the command line was malformed
"""

from __future__ import annotations

import argparse
import html
import json
import os
import re
import shutil
import socket
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
#: honours when it opens a window.
EDGE_CANDIDATES = (
    Path(r"C:\Program Files (x86)\Microsoft\Edge\Application\msedge.exe"),
    Path(r"C:\Program Files\Microsoft\Edge\Application\msedge.exe"),
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
#: forward slashes (``workspace C:/codes/InfantGodIDE``), while the flag a developer
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
            "stay inside shell/web/cards.mjs's COMMAND_HELP array"
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
NEWMOD_CHECK_COUNT = 6

#: The wrapper page.  It is deliberately dumb: no imports, no build, plain
#: browser JS, so what it observes is what the shipped page does.  ``?app=`` in
#: the wrapper's own query string is the address to frame -- the caller encodes
#: it, which keeps ``?mod=C:\...`` out of the wrapper's parsing job.
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
      say("error", "");
      if (!wantsMod) { finish(); return; }
      if (!/(^|\\s)is-mod(\\s|$)/.test(booted || "")) { finish(); return; }
      /* D1: the package the URL named opened itself: a title, rows, a log line. */
      const headline = await waitFor(() => textOf(".card-mod .mod-headline").trim());
      say("headline", headline || "");
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
        return {"cold": cold, "trip": trip, "mod_root": mod_root}
    finally:
        if host is not None:
            host.close()
        if written:
            MOD_WRAPPER.unlink(missing_ok=True)
        shutil.rmtree(profile, ignore_errors=True)
        shutil.rmtree(sandbox, ignore_errors=True)


def define_newmod_checks(facts: dict) -> list:
    """The six round-trip assertions, as ``(name, callable)`` pairs."""
    cold = facts.get("cold") or {}
    trip = facts.get("trip") or {}

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

    return [
        ("item 8: a cold boot opens on the mod view", cold_boot_is_mod),
        ("D1: ?mod= opens the package the menu just created", mod_url_opens_package),
        ("D2: the three mod headings open the files they head", headings_open_files),
        ("D3: a page's own save is not logged as another writer", save_echo_is_not_a_warning),
        ("D3: a real external write still warns", external_writer_still_warns),
        ("D4: a wrong relative name fails visibly, the right one opens", wrong_relative_name_is_visible),
    ]


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
        print(f"summary: 0 passed, 0 failed, {5 + NEWMOD_CHECK_COUNT} skipped (no browser)")
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
