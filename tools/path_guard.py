#!/usr/bin/env python3
"""Guard: no tracked file may name a directory that exists only on one machine.

The repository is cloned onto other machines, packaged into an installer and
read by people who do not own this author's disk.  A path like
``C:\\Users\\someone\\Documents\\project`` is therefore not a path: it is a
leaked fact about one computer, and it is useless to everyone else.

This tool is the *strict* half of that rule: it walks ``git ls-files`` (or, in a
source tarball with no ``.git``, the tree itself) and reports what it finds in
two grades:

``error``
    A home directory (Windows or POSIX) or a UNC share.  These never mean
    anything except "this came from somebody's disk".

``note``
    An absolute drive path or a path segment from a game's developer project
    (``UnityProject``, ``YarnScripts``).  Both fail under ``--strict``, which is
    what ``make path-check`` runs, so a new one cannot slip in.

Placeholders are allowed everywhere (``you``, ``<user>``, ``%USERNAME%``,
``$HOME``, ``…``): a document may show the *shape* of a path without naming a
machine.  The allow-list below answers the two legitimate exceptions --
Windows-shaped test fixtures whose strings are *inputs* to path handling, and
the rules' own self-test cases -- and each entry records why.

Usage::

    python tools/path_guard.py             # errors fail, notes are listed
    python tools/path_guard.py --strict    # notes fail too; what `make path-check` runs
    python tools/path_guard.py --list      # show the allow-list, then report
    python tools/path_guard.py --json      # machine-readable report

Exit code 0 when clean, 1 when something failed.
"""

from __future__ import annotations

import json
import re
import subprocess
import sys
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parent.parent

#: Suffixes that are never source text.  A binary can contain anything; the
#: payload audit in ``tools/make-installer.mjs`` is what guards shipped bytes.
SKIP_SUFFIXES = {
    ".png", ".jpg", ".jpeg", ".gif", ".ico", ".icns", ".webp",
    ".exe", ".dll", ".pdb", ".pfx", ".cer", ".pw", ".bin", ".zip",
    ".woff", ".woff2", ".ttf", ".otf", ".pdf",
    ".html",  # LICENSES.chromium.html is third-party and enormous
}

#: A user segment that is a stand-in, not a person.
PLACEHOLDERS = {
    "you", "your-user", "your_user", "<you>", "<user>", "<username>", "user",
    "username", "%username%", "$user", "$home", "%home%", "~", "...", "…",
    "ana", "someone",
}

#: ``(kind, repository-relative path) -> why it is allowed``.
#:
#: Keyed by path, not by line: a line number rots the moment the file is
#: edited, and then the entry hides a real hit.  An entry here says "this whole
#: file is allowed to contain this kind of path", which is a decision a
#: reviewer can read.  Only two things belong here: strings that are *inputs*
#: to path handling in a test, and the rules' own self-test cases.  A real
#: machine path -- a user profile, a toolchain directory, a checkout -- is
#: never allowed; it belongs in the environment or in a placeholder.
ALLOW: dict[tuple[str, str], str] = {
    ("drive", "shell/mods/selftest.mjs"):
        "fixtures for new-mod URL building; the strings are never touched on disk",
    ("drive", "shell/web/selftest.mjs"):
        "fixtures whose text *is* a Windows path: CSV cells and table offsets",
    ("game-dev", "shell/web/selftest.mjs"):
        "fixtures copied from a real Yarn project table: they exercise long paths",
    ("drive", "shell/ai/selftest/config.mjs"):
        "a synthetic APPDATA table for the Windows user-data directory test",
    ("drive", "shell/mods/selftest/dispatch.mjs"):
        "Windows-shaped package roots fed to the URL builder; never read from disk",
    ("drive", "shell/mods/selftest/examples-menu.mjs"):
        "a synthetic ProgramFiles(x86) value for the Steam discovery test",
    ("drive", "shell/mods/selftest/importfile.mjs"):
        "an out-of-root import target: the refusal is the check, nothing is opened",
    ("drive", "shell/mods/selftest/knowledge-state.mjs"):
        "synthetic APPDATA/LOCALAPPDATA values for defaultUserDir",
    ("drive", "shell/web/selftest/main.mjs"):
        "an absolute-path fixture for the mod path join",
    ("drive", "shell/web/selftest/story.mjs"):
        "translation-table cells that carry the file column's Windows path",
    ("game-dev", "shell/web/selftest/story.mjs"):
        "as above: the cells are copied from a real Yarn project table",
    ("drive", "shell/web/selftest/translation.mjs"):
        "the shipped table's file field is a Windows path and is displayed as-is",
    ("game-dev", "shell/web/selftest/translation.mjs"):
        "as above: the field is copied from a real Yarn project table",
    ("drive", "shell/web/selftest/views.mjs"):
        "a Windows-shaped package root fed to the view's new-mod command",
    ("drive", "tools/make-installer.mjs"):
        "the payload audit's own absolute-developer-path rule",
    ("drive", "tools/path_guard.py"):
        "the rules' own cases and doc examples: each string is an input to a rule",
    ("game-dev", "tools/path_guard.py"):
        "as above: the game-project segment is one of the rules under test",
    ("home", "tools/path_guard.py"):
        "the rules' own self-test cases: each string is an input to a rule, not a path",
    ("home-posix", "tools/path_guard.py"):
        "as above: the POSIX and macOS home cases",
    ("unc", "tools/path_guard.py"):
        "the rule needs a share in its own self-test; nothing else here is one",
}

#: ``(kind, pattern, severity)``.  Both home-directory rules and the UNC rule
#: are errors; the rest are notes.
RULES = [
    (
        "home",
        re.compile(r"(?i)\b[A-Za-z]:[\\/]{1,2}Users[\\/]{1,2}([A-Za-z0-9._$@-]+)"),
        "error",
    ),
    (
        "home-posix",
        re.compile(r"/(?:home|Users)/([A-Za-z0-9._-]+)"),
        "error",
    ),
    (
        "unc",
        re.compile(r"\\\\[A-Za-z0-9._-]+\\[A-Za-z0-9._$-]+"),
        "error",
    ),
    (
        "drive",
        re.compile(r"(?<![A-Za-z0-9_])[A-Za-z]:[\\/]"),
        "note",
    ),
    (
        "game-dev",
        re.compile(r"\b(?:UnityProject|YarnScripts)\b"),
        "note",
    ),
]

_SEVERITY_ORDER = {"error": 0, "note": 1}


#: Directories a tree walk never descends into.  Build output, dependencies and
#: workspace state are not source, and ``git ls-files`` never lists them either.
WALK_SKIP_DIRS = {".git", "build", "dist", "node_modules", ".infantgod"}

#: Vendored projects are another tree kept byte-identical so it can be re-synced
#: from its own home without a merge: their example paths are part of *their*
#: documentation, and editing them here would turn every sync into a conflict.
#: The version store lives in ``vendor/iaqs`` for exactly that reason.
VENDOR_PREFIX = "vendor/"


def walk_files() -> list[str]:
    """Every source file in the tree, for a source tarball with no ``.git``."""
    names: list[str] = []
    for path in REPO_ROOT.rglob("*"):
        if not path.is_file():
            continue
        rel = path.relative_to(REPO_ROOT)
        if any(part in WALK_SKIP_DIRS for part in rel.parts):
            continue
        if rel.as_posix().startswith(VENDOR_PREFIX):
            continue
        names.append(rel.as_posix())
    return sorted(names)


def tracked_files() -> list[str]:
    """Every path git knows about, with forward slashes, in stable order.

    A source tarball has no ``.git``, and a machine may not even have git; then
    the tree itself is the list.  Both ways answer one question: which files are
    this project's source.
    """
    try:
        out = subprocess.run(
            ["git", "ls-files", "-z"],
            cwd=str(REPO_ROOT),
            capture_output=True,
            check=True,
        ).stdout
    except (OSError, subprocess.CalledProcessError):
        return walk_files()
    names = [name for name in out.decode("utf-8", "replace").split("\0") if name]
    names = [name for name in names if not name.startswith(VENDOR_PREFIX)]
    # An unpacked copy sitting inside somebody else's checkout answers "nothing"
    # without failing -- every path in it is untracked there.  No files is not a
    # clean tree; it is an unanswered question, so ask the tree instead.
    if not names:
        return walk_files()
    return sorted(names)


def is_text_candidate(rel: str) -> bool:
    return Path(rel).suffix.lower() not in SKIP_SUFFIXES


def read_text(rel: str) -> str | None:
    path = REPO_ROOT / rel
    try:
        raw = path.read_bytes()
    except OSError:
        return None
    if b"\0" in raw[:4096]:  # looks binary
        return None
    return raw.decode("utf-8-sig", "replace")


def scan(rel: str, text: str) -> list[dict[str, object]]:
    """Every rule's hits in one file.

    A placeholder is judged per match, not per line: a sentence may mention
    "you" and still name a real machine somewhere else, and skipping the line
    would hide it.
    """
    hits: list[dict[str, object]] = []
    for number, line in enumerate(text.splitlines(), start=1):
        if not line.strip():
            continue
        for kind, pattern, severity in RULES:
            for match in pattern.finditer(line):
                if kind in ("home", "home-posix"):
                    segment = (match.group(1) or "").lower()
                    if segment in PLACEHOLDERS:
                        continue
                allowed_because = ALLOW.get((kind, rel))
                hits.append(
                    {
                        "path": rel,
                        "line": number,
                        "kind": kind,
                        "severity": severity,
                        "match": match.group(0),
                        "text": line.strip()[:160],
                        "allowed": allowed_because,
                    }
                )
    return hits


def render(rows: list[dict[str, object]]) -> None:
    for row in rows:
        mark = "allow" if row["allowed"] else ("error" if row["severity"] == "error" else " note")
        print(f"{mark:5s} {row['path']}:{row['line']}  {row['kind']}: {row['match']}")
        if not row["allowed"]:
            print(f"      {row['text']}")


def self_test() -> int:
    """Prove the rules fire, and that placeholders and relative paths do not.

    The guard is a regular expression away from being useless: a rule that
    silently stops matching is worse than no rule, because the summary still
    says "clean".  Each case below is a string, the number of hits each rule
    should find, and the reason.
    """
    cases = [
        # A home directory is both an error and (structurally) a drive path:
        # the drive rule never claims to be exclusive, the home rule is the one
        # that makes the run fail.
        ("windows home", r"copy C:\Users\person\Documents\board.json here", {"home": 1, "drive": 1}),
        ("posix home", "see /home/person/project", {"home-posix": 1}),
        ("mac home", "see /Users/person/project", {"home-posix": 1}),
        ("unc share", r"\\fileserver\share\mods", {"unc": 1}),
        ("drive path", r"open C:\Program Files\NSIS\makensis.exe", {"drive": 1}),
        ("unity project", r"E:\UnityProject\Infant God\Assets", {"drive": 1, "game-dev": 1}),
        ("placeholder you", r"C:\Users\you\Documents\project", {"drive": 1}),
        ("placeholder angle", r"C:\Users\<user>\project", {"drive": 1}),
        ("placeholder var", "%USERPROFILE%\\.infantgod", {}),
        ("placeholder home", "~/.config/project", {}),
        ("placeholder ellipsis", "…/StreamingAssets/Mods", {}),
        ("relative posix", "shell/web/board.mjs", {}),
        ("relative drive-esque", "build/infantgod.exe", {}),
        ("single letter is not a drive", "a/b", {}),
        ("url is not a drive", "http://127.0.0.1:8080/rpc", {}),
    ]
    failed = 0
    for label, text, expected in cases:
        hits: dict[str, int] = {}
        for kind, pattern, _severity in RULES:
            for match in pattern.finditer(text):
                if kind in ("home", "home-posix"):
                    segment = (match.group(1) or "").lower()
                    if segment in PLACEHOLDERS:
                        continue
                hits[kind] = hits.get(kind, 0) + 1
        want = {kind: n for kind, n in expected.items() if n}
        if hits != want:
            failed += 1
            print(f"FAIL {label}: expected {want or 'no hits'}, got {hits or 'no hits'}")
            print(f"     {text}")
    total = len(cases)
    if failed == 0:
        print(f"path-guard self-test: {total}/{total} cases passed")
        return 0
    print(f"path-guard self-test: {failed}/{total} cases failed")
    return 1


def main(argv: list[str]) -> int:
    if "--self-test" in argv:
        return self_test()

    strict = "--strict" in argv
    as_json = "--json" in argv
    show_allow = "--list" in argv

    rows: list[dict[str, object]] = []
    scanned = 0
    for rel in tracked_files():
        if not is_text_candidate(rel):
            continue
        text = read_text(rel)
        if text is None:
            continue
        scanned += 1
        rows.extend(scan(rel, text))

    failures = [r for r in rows if not r["allowed"] and r["severity"] == "error"]
    notes = [r for r in rows if not r["allowed"] and r["severity"] == "note"]
    allowed = [r for r in rows if r["allowed"]]

    if as_json:
        print(
            json.dumps(
                {
                    "scanned": scanned,
                    "failures": failures,
                    "notes": notes,
                    "allowed": allowed,
                    "strict": strict,
                },
                indent=2,
                ensure_ascii=False,
            )
        )
    else:
        if show_allow:
            print(f"allow-list: {len(ALLOW)} entries")
            for (kind, path), why in sorted(ALLOW.items()):
                print(f"  {kind:9s} {path}\n            {why}")
            print()
        if rows:
            print("hardcoded paths found\n")
            render(sorted(rows, key=lambda r: (r["path"], r["line"], r["kind"])))
            print()
        print(
            f"path-guard: {scanned} text files scanned, "
            f"{len(failures)} error(s), {len(notes)} note(s), {len(allowed)} allowed"
        )

    if failures:
        print(
            "a home directory or UNC share names one machine; "
            "use a placeholder (you / <user> / …) or a path relative to the repository",
            file=sys.stderr,
        )
        return 1
    if strict and notes:
        print(
            "--strict: every note above is a hardcoded path; use a placeholder, a "
            "relative path, or add a reviewed allow-list entry",
            file=sys.stderr,
        )
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
