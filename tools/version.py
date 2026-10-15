#!/usr/bin/env python3
"""version.py -- the one place a seIDE version number is decided.

    python tools/version.py show
    python tools/version.py check
    python tools/version.py set 0.2.0-beta.1
    python tools/version.py bump [alpha|beta|rc]

``VERSION`` at the repository root is the source of truth.  Two source files
carry a copy of it, because C89 and JavaScript cannot read a file at compile
time without introducing a build step this project does not have:

    core/include/seide_cfg.h    #define SDE_VERSION "..."
    shell/main.mjs              const SHELL_VERSION = "..."

``check`` fails when any copy disagrees -- including the case where someone
re-introduces a second ``#define SDE_VERSION`` inside a ``.c`` file -- and it is
wired into ``make test``, so the tree cannot drift.  ``check`` also reads the
top section of ``CHANGELOG.md`` and requires it to be either ``## Unreleased``
(work in progress) or ``## v<version>`` (exactly this version); anything else
means the changelog and the version have gone out of step.

Version strings are SemVer 2.0.0 with the pre-release channels this project
uses: ``0.2.0-alpha.1`` -> ``0.2.0-beta.1`` -> ``0.2.0-rc.1`` -> (1.0.0 for
GA).  Per docs/RELEASING.md the 0.x line only ever publishes alpha/beta/rc
builds; ``ga`` and ``lts`` releases start at 1.0.0.

Exit codes
    0   the version is consistent (or was written)
    1   a copy disagrees, or the changelog has no section for it
    2   ``VERSION`` is missing or unreadable
    3   the command line was malformed, or the requested version is not valid
"""

from __future__ import annotations

import argparse
import io
import re
import sys
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parents[1]
VERSION_FILE = REPO_ROOT / "VERSION"
CFG_HEADER = REPO_ROOT / "core" / "include" / "seide_cfg.h"
SHELL_MAIN = REPO_ROOT / "shell" / "main.mjs"
KERNEL_MAIN = REPO_ROOT / "core" / "src" / "main.c"
CHANGELOG = REPO_ROOT / "CHANGELOG.md"

#: SemVer 2.0.0, as strict as a release pipeline needs it to be.
SEMVER = re.compile(
    r"^(?P<major>0|[1-9]\d*)\.(?P<minor>0|[1-9]\d*)\.(?P<patch>0|[1-9]\d*)"
    r"(?:-(?P<pre>[0-9A-Za-z.-]+))?(?:\+(?P<build>[0-9A-Za-z.-]+))?$"
)
#: The pre-release identifiers this project issues.
PRE = re.compile(r"^(?P<channel>alpha|beta|rc)(?:\.(?P<count>[1-9]\d*))?$")

CFG_DEFINE = re.compile(r'^(?P<indent>\s*)#define\s+SDE_VERSION\s+"(?P<value>[^"]*)"', re.M)
SHELL_CONST = re.compile(r'^(?P<indent>\s*)const\s+SHELL_VERSION\s*=\s*"(?P<value>[^"]*)";', re.M)
ANY_DEFINE = re.compile(r"#define\s+SDE_VERSION")
SECTION = re.compile(r"^##\s+(?P<title>.+?)\s*$", re.M)

#: alpha -> beta -> rc, in the only order a version may move.
CHANNEL_ORDER = ("alpha", "beta", "rc")

#: The value a row carries when the point of the row is that the version is
#: absent there (core/src/main.c must not define it).
NO_COPY = "no copy"


class _Parser(argparse.ArgumentParser):
    """ArgumentParser that reports usage errors with the documented exit code."""

    def error(self, message: str) -> None:
        self.print_usage(sys.stderr)
        print(f"version.py: usage error: {message}", file=sys.stderr)
        raise SystemExit(3)


def read_text(path: Path) -> str:
    """Read a UTF-8 file, preserving whatever line endings it has."""
    return io.open(path, "r", encoding="utf-8", newline="").read()


def write_text(path: Path, text: str) -> None:
    """Write UTF-8 with LF endings, so a checkout stays byte-identical."""
    with io.open(path, "w", encoding="utf-8", newline="\n") as handle:
        handle.write(text)


def parse(version: str):
    """Return the parsed parts of a version, or ``None`` if it is not SemVer."""
    match = SEMVER.match(version.strip())
    if not match:
        return None
    parts = match.groupdict()
    pre = parts["pre"] or ""
    channel, count = None, None
    if pre:
        pre_match = PRE.match(pre)
        if pre_match:
            channel = pre_match.group("channel")
            count = int(pre_match.group("count")) if pre_match.group("count") else None
    return {
        "version": version.strip(),
        "major": int(parts["major"]),
        "minor": int(parts["minor"]),
        "patch": int(parts["patch"]),
        "pre": pre,
        "build": parts["build"] or "",
        "channel": channel,
        "count": count,
    }


def read_version_file() -> str:
    """Return the version in ``VERSION``, or raise the documented exit 2."""
    if not VERSION_FILE.is_file():
        print(f"version.py: no VERSION file at {VERSION_FILE}", file=sys.stderr)
        raise SystemExit(2)
    version = read_text(VERSION_FILE).strip()
    if not version:
        print(f"version.py: {VERSION_FILE} is empty", file=sys.stderr)
        raise SystemExit(2)
    return version


def changelog_section() -> str:
    """Return the title of CHANGELOG.md's first ``##`` section (or '')."""
    if not CHANGELOG.is_file():
        return ""
    match = SECTION.search(read_text(CHANGELOG))
    return match.group("title") if match else ""


def copies() -> list:
    """Return ``(label, value, problem)`` for every place the version appears."""
    found = []

    header = read_text(CFG_HEADER) if CFG_HEADER.is_file() else ""
    values = CFG_DEFINE.findall(header)
    if len(values) != 1:
        found.append(("core/include/seide_cfg.h", f"{len(values)} definitions", "expected exactly one #define SDE_VERSION"))
    else:
        found.append(("core/include/seide_cfg.h", values[0][1], ""))

    shell = read_text(SHELL_MAIN) if SHELL_MAIN.is_file() else ""
    const = SHELL_CONST.search(shell)
    if not const:
        found.append(("shell/main.mjs", "not found", "expected const SHELL_VERSION = \"...\";"))
    else:
        found.append(("shell/main.mjs", const.group("value"), ""))

    kernel = read_text(KERNEL_MAIN) if KERNEL_MAIN.is_file() else ""
    if ANY_DEFINE.search(kernel):
        found.append(("core/src/main.c", "a second #define", "main.c must not define SDE_VERSION: seide_cfg.h is the one copy"))
    else:
        found.append(("core/src/main.c", NO_COPY, ""))

    return found


def cmd_show() -> int:
    """Print the version and what it means."""
    version = read_version_file()
    info = parse(version)
    if info is None:
        print(f"version.py: VERSION holds {version!r}, which is not SemVer", file=sys.stderr)
        return 1
    print(f"version   {info['version']}")
    if info["channel"]:
        count = info["count"] if info["count"] is not None else "-"
        print(f"channel   {info['channel']} {count}")
        print("stage     pre-release: the interface may still change")
    else:
        print("channel   release")
        print("stage     " + ("GA or LTS candidate (1.x)" if info["major"] >= 1 else "0.x release: no GA line, no LTS"))
    print(f"section   {changelog_section() or '(none)'}")
    return 0


def cmd_check(quiet: bool = False, changelog: bool = True) -> int:
    """Assert that every copy of the version agrees, and (optionally) the changelog too."""
    version = read_version_file()
    info = parse(version)
    problems = []
    if info is None:
        problems.append(f"VERSION holds {version!r}, which is not SemVer 2.0.0")

    rows = copies()
    for label, value, problem in rows:
        if problem:
            problems.append(f"{label}: {problem}")
        elif info is not None and value != NO_COPY and value != version:
            problems.append(f"{label}: {value!r} != VERSION {version!r}")

    section = changelog_section()
    released = section.startswith("v") and section.split()[0][1:] == version
    if changelog:
        if not section:
            problems.append("CHANGELOG.md: no '## ' section at all")
        elif not (section == "Unreleased" or released):
            problems.append(
                f"CHANGELOG.md: top section is '## {section}', expected '## Unreleased' or '## v{version}'"
            )

    if not quiet:
        print(f"{'copy':<26} {'value':<22} result")
        for label, value, problem in rows:
            result = "FAIL" if problem or (info and value != NO_COPY and value != version) else "ok"
            print(f"{label:<26} {value:<22} {result}")
        if changelog:
            print(f"{'CHANGELOG.md':<26} {'## ' + (section or '(none)'):<22} "
                  f"{'FAIL' if any('CHANGELOG' in p for p in problems) else 'ok'}")

    if problems:
        for problem in problems:
            print(f"FAIL {problem}", file=sys.stderr)
        print(f"version.py: {len(problems)} problem(s) for {version}", file=sys.stderr)
        return 1
    if not quiet:
        channel = info["channel"] or "release"
        print(f"version.py: every copy agrees on {version} (channel {channel})")
    return 0


def _stamp_cfg(text: str, version: str) -> str:
    return CFG_DEFINE.sub(
        lambda m: f'{m.group("indent")}#define SDE_VERSION "{version}"', text, count=1
    )


def _stamp_shell(text: str, version: str) -> str:
    return SHELL_CONST.sub(
        lambda m: f'{m.group("indent")}const SHELL_VERSION = "{version}";', text, count=1
    )


def write_version(version: str) -> None:
    """Write the version into VERSION and stamp both source copies."""
    write_text(VERSION_FILE, version + "\n")
    print(f"[write] VERSION -> {version}")

    header = read_text(CFG_HEADER)
    stamped = _stamp_cfg(header, version)
    if stamped != header:
        write_text(CFG_HEADER, stamped)
        print("[write] core/include/seide_cfg.h")
    else:
        print("[keep ] core/include/seide_cfg.h (already correct)")

    shell = read_text(SHELL_MAIN)
    stamped = _stamp_shell(shell, version)
    if stamped != shell:
        write_text(SHELL_MAIN, stamped)
        print("[write] shell/main.mjs")
    else:
        print("[keep ] shell/main.mjs (already correct)")


def cmd_set(target: str) -> int:
    """Validate and write an explicitly named version."""
    info = parse(target)
    if info is None:
        print(f"version.py: {target!r} is not SemVer 2.0.0 (want MAJOR.MINOR.PATCH[-channel[.N]])", file=sys.stderr)
        return 3
    if info["pre"] and info["channel"] is None:
        print(
            f"version.py: pre-release {info['pre']!r} is not one of alpha/beta/rc",
            file=sys.stderr,
        )
        return 3
    if info["channel"] is None and info["major"] == 0:
        print("note: 0.x is never a GA or LTS release (docs/RELEASING.md); "
              "the 0.x line publishes alpha/beta/rc builds only")
    write_version(info["version"])
    result = cmd_check(changelog=False)
    section = changelog_section()
    if result == 0 and section not in ("Unreleased",) and not (
        section.startswith("v") and section.split()[0][1:] == info["version"]
    ):
        print(
            f"note: CHANGELOG.md's top section is '## {section or '(none)'}'; "
            f"'version.py check' stays red until it is '## Unreleased' or '## v{info['version']}'"
        )
    return result


def cmd_bump(part: str = "") -> int:
    """Move to the next pre-release of the same line: alpha.1 -> alpha.2, alpha -> beta.1."""
    current = read_version_file()
    info = parse(current)
    if info is None:
        print(f"version.py: VERSION holds {current!r}, which is not SemVer", file=sys.stderr)
        return 1
    if info["channel"] is None:
        print(
            f"version.py: {current} is a release, not a pre-release: the next version "
            "is a decision, so name it -- version.py set X.Y.Z",
            file=sys.stderr,
        )
        return 3

    want = (part or info["channel"]).lower()
    if want not in CHANNEL_ORDER:
        print(f"version.py: {part!r} is not one of {'/'.join(CHANNEL_ORDER)}", file=sys.stderr)
        return 3
    here, there = CHANNEL_ORDER.index(info["channel"]), CHANNEL_ORDER.index(want)
    if there < here:
        print(
            f"version.py: {current} cannot go back to {want}; "
            "publish a new minor line instead",
            file=sys.stderr,
        )
        return 3

    if there == here:
        count = (info["count"] or 0) + 1
    else:
        count = 1
    target = f"{info['major']}.{info['minor']}.{info['patch']}-{want}.{count}"
    print(f"note: {current} -> {target}")
    return cmd_set(target)


def _build_parser() -> argparse.ArgumentParser:
    parser = _Parser(
        prog="version.py",
        description="Show, check, set or bump the version. Exit codes: 0 ok, 1 drift, 2 no VERSION, 3 usage.",
    )
    sub = parser.add_subparsers(dest="command", metavar="{show,check,set,bump}")

    sub.add_parser("show", help="print the version and what stage it is")
    check = sub.add_parser("check", help="assert every copy and the changelog agree")
    check.add_argument("--quiet", action="store_true", help="print nothing unless something is wrong")

    setter = sub.add_parser("set", help="write a version into VERSION and both source copies")
    setter.add_argument("version", metavar="X.Y.Z[-channel[.N]]")

    bumper = sub.add_parser("bump", help="move to the next pre-release (alpha.1 -> alpha.2, alpha -> beta.1)")
    bumper.add_argument("part", nargs="?", default="", metavar="alpha|beta|rc")
    return parser


def main(argv=None) -> int:
    """Entry point; returns the process exit code."""
    args = _build_parser().parse_args(argv)
    if args.command in (None,):
        return cmd_show()
    if args.command == "show":
        return cmd_show()
    if args.command == "check":
        return cmd_check(quiet=args.quiet)
    if args.command == "set":
        return cmd_set(args.version)
    if args.command == "bump":
        return cmd_bump(args.part)
    return 3


if __name__ == "__main__":
    sys.exit(main())
