#!/usr/bin/env python3
"""build.py -- thin convenience driver around the repository ``Makefile``.

    python tools/build.py [--check] [--release] [--clean] [target ...]

This tool **never** invents compiler flags: it locates ``mingw32-make`` (falling
back to ``make``) and runs the repository's own ``Makefile`` with the targets it
was given.  ``--release`` passes the make variable ``RELEASE=1``; ``--clean``
prepends the ``clean`` target.  ``--check`` only reports the resolved toolchain
and exits.

Exit codes
    0   the build (or ``--check``) succeeded
    1   ``--check`` could not find make or gcc
    2   the repository has no Makefile, or make could not be started
    N   whatever make returned
    3   the command line was malformed
"""

from __future__ import annotations

import argparse
import os
import shutil
import subprocess
import sys
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parents[1]
MAKEFILE = REPO_ROOT / "Makefile"

#: Where the MinGW-w64 toolchain lives on the reference Windows setup.
MINGW_BIN = Path(r"C:\mingw64\mingw64\bin")
MAKE_NAMES = ("mingw32-make.exe", "mingw32-make", "make.exe", "make")
GCC_NAMES = ("gcc.exe", "gcc")


class _Parser(argparse.ArgumentParser):
    """ArgumentParser that reports usage errors with the documented exit code."""

    def error(self, message: str) -> None:
        self.print_usage(sys.stderr)
        print(f"build.py: usage error: {message}", file=sys.stderr)
        raise SystemExit(3)


def find_tool(names, env_var: str):
    """Return the first existing tool: ``$env_var``, MinGW bin, then ``PATH``."""
    override = os.environ.get(env_var)
    if override:
        candidate = Path(override)
        if candidate.is_file():
            return candidate
        found = shutil.which(override)
        if found:
            return Path(found)
    for name in names:
        candidate = MINGW_BIN / name
        if candidate.is_file():
            return candidate
    for name in names:
        found = shutil.which(name)
        if found:
            return Path(found)
    return None


def version_line(tool: Path) -> str:
    """Return the first line of ``tool --version``, or a short failure note."""
    try:
        done = subprocess.run(
            [str(tool), "--version"], capture_output=True, text=True, timeout=30, check=False
        )
    except (OSError, subprocess.SubprocessError) as exc:
        return f"(cannot run --version: {exc})"
    output = (done.stdout or "") + (done.stderr or "")
    lines = [line.strip() for line in output.splitlines() if line.strip()]
    return lines[0] if lines else f"(no version output; exit {done.returncode})"


def do_check(make, gcc) -> int:
    """Print the resolved toolchain and signal whether a build could run."""
    print(f"repo      : {REPO_ROOT}")
    print(f"makefile  : {MAKEFILE}" + ("" if MAKEFILE.is_file() else "  (MISSING)"))
    print(f"make      : {make if make else 'NOT FOUND'}")
    if make:
        print(f"            {version_line(make)}")
    print(f"gcc       : {gcc if gcc else 'NOT FOUND'}")
    if gcc:
        print(f"            {version_line(gcc)}")
    return 0 if (make and gcc) else 1


def do_build(make, args) -> int:
    """Invoke the repository Makefile, returning make's own exit code."""
    if not MAKEFILE.is_file():
        print(f"build.py: no Makefile at {MAKEFILE}", file=sys.stderr)
        return 2

    command = [str(make), "-f", "Makefile"]
    targets = list(args.targets)
    if args.clean:
        targets = ["clean"] + [target for target in targets if target != "clean"]
    if args.release:
        command.append("RELEASE=1")
    command.extend(targets)

    print(f"==> {' '.join(command)}  (cwd={REPO_ROOT})", flush=True)
    try:
        return subprocess.call(command, cwd=str(REPO_ROOT))
    except OSError as exc:
        print(f"build.py: cannot run {make}: {exc}", file=sys.stderr)
        return 2
    except KeyboardInterrupt:
        print("build.py: interrupted", file=sys.stderr)
        return 130


def _build_parser() -> argparse.ArgumentParser:
    parser = _Parser(
        prog="build.py",
        description="Drive the repository Makefile. Exit codes: make's own, or 2/3 for driver errors.",
    )
    parser.add_argument("--check", action="store_true", help="print resolved toolchain and exit")
    parser.add_argument("--release", action="store_true", help="pass RELEASE=1 to make")
    parser.add_argument("--clean", action="store_true", help="run the clean target first")
    parser.add_argument("targets", nargs="*", metavar="target", help="extra make targets, e.g. core test run")
    return parser


def main(argv=None) -> int:
    """Entry point; returns the process exit code."""
    args = _build_parser().parse_args(argv)
    make = find_tool(MAKE_NAMES, "MAKE")
    gcc = find_tool(GCC_NAMES, "GCC")

    if args.check:
        return do_check(make, gcc)
    if make is None:
        print(
            f"build.py: no make found (looked for {', '.join(MAKE_NAMES)} in "
            f"{MINGW_BIN} and PATH); set MAKE to override",
            file=sys.stderr,
        )
        return 2
    return do_build(make, args)


if __name__ == "__main__":
    sys.exit(main())
