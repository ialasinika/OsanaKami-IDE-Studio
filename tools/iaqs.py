#!/usr/bin/env python3
"""Build the version store (iaqs/) and run its suite.

    python tools/iaqs.py build    # build-iaqs/iaqs.exe, stripped when possible
    python tools/iaqs.py test     # build, then run build-iaqs/iaqs_tests.exe

The Makefile wraps these as `iaqs-bin` and `iaqs-check`, and `make test` runs
`iaqs-check`, so the fork's suite is part of "the tree is green" whenever the
C++ toolchain is on PATH.  Without `cmake` and a compiler both commands print a
skip and exit 0 -- the same contract as installer-check and sign-check, so a
machine without MinGW still runs the rest of the suite.

The generator is chosen from what is on PATH: `mingw32-make` (the maintainer's
MinGW) or `make` (MSYS2's shell, and the CI runner).  A CMake cache left from
the other generator, or from another source path, is discarded rather than
argued with.
"""
import argparse
import os
import re
import shutil
import subprocess
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
SOURCE = ROOT / "iaqs"
BUILD = ROOT / "build-iaqs"
EXE = BUILD / "iaqs.exe"
TESTS = BUILD / "iaqs_tests.exe"
CACHE = BUILD / "CMakeCache.txt"
TALLY = re.compile(r"(\d+)\s*/\s*(\d+)\s+tests passed")


def which(name):
    return shutil.which(name)


def skip(reason):
    print(f"iaqs: skipped -- {reason}")
    return 0


def run(argv):
    print("iaqs:", " ".join(argv))
    return subprocess.run(argv, cwd=ROOT)


def cache_matches():
    """True when the existing build tree was configured for this source."""
    if not CACHE.is_file():
        return False
    try:
        text = CACHE.read_text(encoding="ascii", errors="replace")
    except OSError:
        return False
    home = re.search(r"^CMAKE_HOME_DIRECTORY:INTERNAL=(.+)$", text, re.M)
    generator = re.search(r"^CMAKE_GENERATOR:INTERNAL=(.+)$", text, re.M)
    if not home or not generator:
        return False
    return (Path(home.group(1)).resolve() == SOURCE.resolve()
            and generator.group(1).strip() == generator_name())


def generator_name():
    if which("mingw32-make"):
        return "MinGW Makefiles"
    return "Unix Makefiles"


def strip_exe():
    compiler = which("g++")
    if compiler:
        candidate = Path(compiler).parent / "strip.exe"
        if candidate.is_file():
            return candidate
        candidate = Path(compiler).parent / "strip"
        if candidate.is_file():
            return candidate
    found = which("strip")
    return Path(found) if found else None


def build():
    cmake = which("cmake")
    cxx = which("g++") or which("c++")
    if not cmake or not cxx:
        return skip("cmake and g++ are not both on PATH")
    if not cache_matches():
        if BUILD.exists():
            shutil.rmtree(BUILD)
        configured = run([cmake, "-S", str(SOURCE), "-B", str(BUILD),
                          "-G", generator_name(), "-DCMAKE_BUILD_TYPE=Release"])
        if configured.returncode != 0:
            return configured.returncode
    compiled = run([cmake, "--build", str(BUILD), "--parallel"])
    if compiled.returncode != 0:
        return compiled.returncode
    strip = strip_exe()
    if strip:
        stripped = run([str(strip), "-s", str(EXE)])
        if stripped.returncode != 0:
            print("iaqs: strip failed, keeping the unstripped binary", file=sys.stderr)
    print(f"iaqs: built {EXE.relative_to(ROOT)} ({EXE.stat().st_size:,} bytes)")
    return 0


def test():
    code = build()
    if code != 0:
        return code
    if not TESTS.is_file():
        print("iaqs: build produced no test binary", file=sys.stderr)
        return 1
    scratch = BUILD / "test-temp"
    scratch.mkdir(parents=True, exist_ok=True)
    env = dict(os.environ)
    # This machine's file sandbox lets a child process write only inside the
    # workspace; the harness makes random directories under TEMP.
    env["TEMP"] = str(scratch)
    env["TMP"] = str(scratch)
    try:
        proc = subprocess.run([str(TESTS)], cwd=ROOT, env=env,
                              capture_output=True, text=True, errors="replace")
    finally:
        shutil.rmtree(scratch, ignore_errors=True)
    out = proc.stdout + proc.stderr
    match = None
    for line in out.splitlines():
        found = TALLY.search(line)
        if found:
            match = found
    if proc.returncode != 0 or not match:
        print(out[-4000:], file=sys.stderr)
        print(f"iaqs: the suite failed (exit {proc.returncode})", file=sys.stderr)
        return proc.returncode or 1
    passed, declared = int(match.group(1)), int(match.group(2))
    if passed != declared:
        print(out[-4000:], file=sys.stderr)
        print(f"iaqs: {declared - passed} test(s) did not run", file=sys.stderr)
        return 1
    print(f"iaqs-check: ok -- {passed}/{declared} tests passed")
    return 0


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("command", choices=("build", "test"))
    options = parser.parse_args()
    return build() if options.command == "build" else test()


if __name__ == "__main__":
    sys.exit(main())
