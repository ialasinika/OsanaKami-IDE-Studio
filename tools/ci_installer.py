#!/usr/bin/env python3
"""ci_installer.py -- build a small installer for CI without an Electron payload.

The release installer packs dist/win-unpacked, which only exists after an
Electron pack.  CI does not need the app to prove that the installer compiles,
that the payload audit passes, or that signing is wired: it needs a deterministic
installer whose inputs are two fixture files.  This script creates that payload,
runs the same tools/make-installer.mjs a release runs, and leaves the installer
and build/make-installer.json where a workflow can upload them.

Extra arguments after `--` go straight to make-installer.mjs, so the signing job
can reuse this script:

  python tools/ci_installer.py --out build/ci-setup.exe
  python tools/ci_installer.py --out build/signed-setup.exe -- --sign --sign-pfx build/sign/codesign.pfx

When makensis is missing the script prints a note and exits 0, the same skip the
installer and signing smokes use.  Pass --keep to leave the fixture payload for
debugging.
"""

import argparse
import json
import shutil
import subprocess
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
WORK = ROOT / "build" / "ci-payload"
NODE = "node"


def main(argv):
    parser = argparse.ArgumentParser(description="build a fixture installer for CI")
    parser.add_argument("--out", default="build/ci-setup.exe", help="installer to write")
    parser.add_argument("--keep", action="store_true", help="keep the fixture payload")
    args, extra = parser.parse_known_args(argv)
    if extra and extra[0] == "--":
        extra = extra[1:]

    if WORK.exists():
        shutil.rmtree(WORK)
    WORK.mkdir(parents=True)

    product = json.loads((ROOT / "package.json").read_text(encoding="utf-8"))["productName"]
    (WORK / f"{product}.exe").write_bytes(b"MZ ci fixture\n")
    deep = WORK / "sub" / "deep"
    deep.mkdir(parents=True)
    (deep / "data.txt").write_text("not the game's data\n", encoding="utf-8")

    out = Path(args.out)
    if not out.is_absolute():
        out = ROOT / out
    command = [NODE, "tools/make-installer.mjs", "--payload", str(WORK), "--out", str(out), *extra]
    result = subprocess.run(
        command,
        cwd=ROOT,
        capture_output=True,
        text=True,
        encoding="utf-8",
        errors="replace",
    )
    sys.stdout.write(result.stdout or "")
    sys.stderr.write(result.stderr or "")
    combined = f"{result.stdout or ''}{result.stderr or ''}"

    if result.returncode != 0:
        if "makensis.exe not found" in combined:
            print("ci-installer: skipped: makensis.exe not found (the other checks still ran)")
            return 0
        print(f"ci-installer: FAIL: make-installer exited {result.returncode}")
        return result.returncode or 1

    if not out.is_file():
        print(f"ci-installer: FAIL: make-installer exited 0 but wrote no {out}")
        return 1
    if not args.keep:
        shutil.rmtree(WORK, ignore_errors=True)
    print(f"ci-installer: ok -- {out} ({out.stat().st_size} bytes)")
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
