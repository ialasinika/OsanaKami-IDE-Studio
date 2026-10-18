#!/usr/bin/env python3
"""sign_smoke.py -- prove the installer signing wiring without a certificate.

The real path uses signtool.exe and a .pfx.  Neither is available on a build
machine that is not releasing, so this smoke compiles a tiny stand-in: an .exe
named signtool that records its argv and exits with a code from the environment.
That proves four things the wiring has to get right:

  1. `--sign-dry-run` resolves and prints the documented argv with the password
     redacted, and does not compile or sign anything.
  2. A requested signature with no certificate, or with a missing signtool,
     exits 2 instead of quietly producing an unsigned installer.
  3. The real compile invokes the shim with `/sign /fd SHA256 /td SHA256 /tr
     <url> /f <pfx> /p <password>` against the built installer only, and the
     build log and build/make-installer.json contain no password.
  4. A non-zero signtool is a build failure, and the JSON records it.

The shim is a native .exe on purpose: Node 24 refuses to spawn a .cmd/.bat
without a shell (EINVAL), and the point is to test the same spawn path signtool
uses.  gcc comes from the MinGW toolchain the Makefile already requires.

Like installer_smoke.py this skips (exit 0 with a note) when the toolchain or
NSIS is unavailable, because a machine that cannot build an installer cannot
prove anything about signing one.

Usage:
  python tools/sign_smoke.py [--keep]
"""

import json
import os
import shutil
import subprocess
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
WORK = ROOT / "build" / "sign-smoke"
NODE = os.environ.get("NODE", "node")
TIMESTAMP = "http://timestamp.digicert.com"
PASSWORD = "s3cret-sign-smoke-do-not-log"
THUMBPRINT = "AA:BB:CC:DD:EE:FF:00:11:22:33:44:55:66:77:88:99:AA:BB:CC:DD"

SHIM_C = r"""
#include <stdio.h>
#include <stdlib.h>

int main(int argc, char **argv) {
  const char *log = getenv("SIGN_SMOKE_LOG");
  const char *code = getenv("SIGN_SMOKE_EXIT");
  FILE *out;
  int i;

  if (log == NULL) return 3;
  out = fopen(log, "wb");
  if (out == NULL) return 4;
  for (i = 1; i < argc; i += 1) {
    if (i > 1) fputc('\n', out);
    fputs(argv[i], out);
  }
  fputc('\n', out);
  fclose(out);
  return code == NULL ? 0 : atoi(code);
}
"""


def fail(message):
    print(f"sign-smoke: FAIL: {message}")
    return 1


def skip(message):
    print(f"sign-smoke: skipped: {message}")
    return 0


def run(cmd, extra_env=None, timeout=600):
    env = dict(os.environ)
    for name in ("INFANTGOD_SIGN_PFX", "INFANTGOD_SIGNTOOL", "SIGNTOOL",
                 "CSC_LINK", "CSC_KEY_PASSWORD", "INFANTGOD_SIGN_PASSWORD"):
        env.pop(name, None)
    env.update(extra_env or {})
    env = {str(key): str(value) for key, value in env.items()}
    return subprocess.run(
        [str(part) for part in cmd],
        cwd=ROOT,
        env=env,
        capture_output=True,
        text=True,
        encoding="utf-8",
        errors="replace",
        timeout=timeout,
    )


def output_of(result):
    return f"{result.stdout or ''}{result.stderr or ''}"


def find_gcc():
    candidates = []
    if os.environ.get("CC"):
        candidates.append(os.environ["CC"])
    if os.environ.get("MINGW_BIN"):
        candidates.append(str(Path(os.environ["MINGW_BIN"]) / "gcc.exe"))
    candidates.append(r"C:\mingw64\mingw64\bin\gcc.exe")
    candidates.append(shutil.which("gcc"))
    candidates.append(shutil.which("cc"))
    for candidate in candidates:
        if not candidate:
            continue
        if Path(candidate).is_file():
            return str(Path(candidate).resolve())
        found = shutil.which(candidate)
        if found:
            return found
    return None


def prepare():
    if WORK.exists():
        shutil.rmtree(WORK)
    WORK.mkdir(parents=True)

    gcc = find_gcc()
    if not gcc:
        return None, skip("no C compiler (gcc) to build the signtool shim")

    source = WORK / "signtool_shim.c"
    source.write_text(SHIM_C.lstrip(), encoding="ascii")
    shim = WORK / "signtool.exe"
    built = run([gcc, "-O0", "-o", shim, source])
    if built.returncode != 0:
        return None, fail(f"could not compile the signtool shim:\n{output_of(built)}")

    pfx = WORK / "fake.pfx"
    pfx.write_bytes(b"this is a stand-in for a .pfx; signtool never sees it\n")
    return {"gcc": gcc, "shim": shim, "pfx": pfx}, None


def make_payload():
    payload = WORK / "payload"
    product = json.loads((ROOT / "package.json").read_text(encoding="utf-8"))["productName"]
    payload.mkdir(parents=True)
    (payload / f"{product}.exe").write_bytes(b"MZ sign-smoke fixture\n")
    deep = payload / "sub" / "deep"
    deep.mkdir(parents=True)
    (deep / "data.txt").write_text("not the game's data\n", encoding="utf-8")
    return payload


def base_command(payload, out):
    return [NODE, "tools/make-installer.mjs", "--payload", payload, "--out", out]


def assert_argv(argv, pfx, out):
    """The documented signtool argv, in the documented order."""
    if not argv or argv[0] != "/sign":
        return f"argv does not start with /sign: {argv}"
    for flag, value in (("/fd", "SHA256"), ("/td", "SHA256"), ("/tr", TIMESTAMP),
                        ("/f", str(pfx)), ("/p", PASSWORD)):
        if flag not in argv:
            return f"argv has no {flag}: {argv}"
        index = argv.index(flag)
        if index + 1 >= len(argv) or argv[index + 1] != value:
            return f"argv {flag} is not followed by the expected value: {argv}"
    if Path(argv[-1]).resolve() != Path(out).resolve():
        return f"argv does not end with the installer: {argv}"
    if any("payload" in part.lower() for part in argv):
        return f"argv names the payload, not just the installer: {argv}"
    return None


def check_dry_run(ctx, payload):
    shim, pfx = ctx["shim"], ctx["pfx"]
    out = WORK / "dry-run.exe"
    if out.exists():
        out.unlink()
    result = run(base_command(payload, out) + [
        "--sign-dry-run", "--sign-pfx", pfx, "--sign-signtool", shim,
    ], {"INFANTGOD_SIGN_PASSWORD": PASSWORD})
    text = output_of(result)
    if result.returncode != 0:
        return fail(f"--sign-dry-run exited {result.returncode}:\n{text}")
    for needle in ("/sign", "/fd SHA256", "/td SHA256", f"/tr {TIMESTAMP}",
                   f"/f {pfx}", "/p ***"):
        if needle not in text:
            return fail(f"--sign-dry-run output is missing {needle!r}:\n{text}")
    if PASSWORD in text:
        return fail(f"--sign-dry-run leaked the password:\n{text}")
    if out.exists():
        return fail("--sign-dry-run wrote an installer")
    if "compiling" in text:
        return fail("--sign-dry-run compiled an installer")

    # A dry run is an audit, not a signing: it must resolve the same argv with
    # no password in the environment, and still print the secret slot as ***.
    bare = run(base_command(payload, out) + [
        "--sign-dry-run", "--sign-pfx", pfx, "--sign-signtool", shim,
    ])
    bare_text = output_of(bare)
    if bare.returncode != 0:
        return fail(f"password-less --sign-dry-run exited {bare.returncode}:\n{bare_text}")
    if "/p ***" not in bare_text:
        return fail(f"password-less --sign-dry-run did not redact the password slot:\n{bare_text}")

    # A thumbprint is the other documented scheme, and has no /p at all.
    thumb = run(base_command(payload, out) + [
        "--sign-dry-run", "--sign-thumbprint", THUMBPRINT, "--sign-signtool", shim,
    ])
    thumb_text = output_of(thumb)
    if thumb.returncode != 0:
        return fail(f"thumbprint --sign-dry-run exited {thumb.returncode}:\n{thumb_text}")
    if "/sha1 aabbccddeeff00112233445566778899aabbccdd" not in thumb_text:
        return fail(f"thumbprint argv is wrong:\n{thumb_text}")
    if " /p " in thumb_text:
        return fail(f"thumbprint argv has a password:\n{thumb_text}")

    # The timestamp URL is settable, and --no-timestamp drops /td and /tr.
    custom = run(base_command(payload, out) + [
        "--sign-dry-run", "--sign-pfx", pfx, "--sign-signtool", shim,
        "--sign-timestamp", "http://ts.example.test",
    ], {"INFANTGOD_SIGN_PASSWORD": PASSWORD})
    if "/tr http://ts.example.test" not in output_of(custom):
        return fail(f"--sign-timestamp was ignored:\n{output_of(custom)}")
    without = run(base_command(payload, out) + [
        "--sign-dry-run", "--sign-pfx", pfx, "--sign-signtool", shim, "--no-timestamp",
    ], {"INFANTGOD_SIGN_PASSWORD": PASSWORD})
    if without.returncode != 0 or "/tr" in output_of(without) or "/td" in output_of(without):
        return fail(f"--no-timestamp did not drop /td and /tr:\n{output_of(without)}")
    return None


def check_no_cert(ctx, payload):
    result = run(base_command(payload, WORK / "no-cert.exe") + [
        "--sign", "--sign-signtool", ctx["shim"],
    ])
    if result.returncode != 2:
        return fail(f"--sign without a certificate exited {result.returncode}, expected 2:\n{output_of(result)}")
    if "needs a certificate" not in output_of(result):
        return fail(f"no-certificate error is not explanatory:\n{output_of(result)}")
    return None


def check_missing_password(ctx, payload):
    result = run(base_command(payload, WORK / "no-password.exe") + [
        "--sign", "--sign-pfx", ctx["pfx"], "--sign-signtool", ctx["shim"],
    ])
    if result.returncode != 2:
        return fail(f"--sign without INFANTGOD_SIGN_PASSWORD exited {result.returncode}, expected 2:\n{output_of(result)}")
    if "INFANTGOD_SIGN_PASSWORD" not in output_of(result):
        return fail(f"the missing-password error does not name the variable:\n{output_of(result)}")
    return None


def check_missing_tool(ctx, payload):
    missing = WORK / "no-such-signtool.exe"
    result = run(base_command(payload, WORK / "no-tool.exe") + [
        "--sign", "--sign-pfx", ctx["pfx"], "--sign-signtool", missing,
    ], {"INFANTGOD_SIGN_PASSWORD": PASSWORD})
    if result.returncode != 2:
        return fail(f"--sign with a missing signtool exited {result.returncode}, expected 2:\n{output_of(result)}")
    if "signtool.exe not found" not in output_of(result):
        return fail(f"missing-signtool error is not explanatory:\n{output_of(result)}")
    return None


def check_signed_build(ctx, payload):
    shim, pfx = ctx["shim"], ctx["pfx"]
    out = WORK / "setup-signed.exe"
    log = WORK / "signtool-argv.txt"
    result = run(base_command(payload, out) + [
        "--sign", "--sign-pfx", pfx, "--sign-signtool", shim, "--dev", "--no-audit",
    ], {"INFANTGOD_SIGN_PASSWORD": PASSWORD, "SIGN_SMOKE_LOG": log, "SIGN_SMOKE_EXIT": "0"})
    text = output_of(result)
    if result.returncode != 0:
        if "makensis.exe not found" in text:
            return "skip", skip("makensis.exe not found (the dry-run wiring checks passed)")
        return "fail", fail(f"signed build exited {result.returncode}:\n{text}")
    if not out.exists():
        return "fail", fail("signed build exited 0 but wrote no installer")
    if not log.exists():
        return "fail", fail("the signtool shim was never invoked")
    argv = [line for line in log.read_text(encoding="utf-8").splitlines() if line]
    error = assert_argv(argv, pfx, out)
    if error:
        return "fail", fail(error)
    if PASSWORD in text:
        return "fail", fail(f"the build log leaked the password:\n{text}")
    if "/p ***" not in text:
        return "fail", fail(f"the build log does not show the redacted argv:\n{text}")

    summary = json.loads((ROOT / "build" / "make-installer.json").read_text(encoding="utf-8"))
    signing = summary.get("signing")
    expected_keys = {"requested", "signed", "tool", "scheme", "timestampUrl", "exitCode"}
    if not isinstance(signing, dict) or set(signing) != expected_keys:
        return "fail", fail(f"build/make-installer.json signing record is not {sorted(expected_keys)}: {signing}")
    if not (signing["requested"] is True and signing["signed"] is True):
        return "fail", fail(f"signing record does not say the build was signed: {signing}")
    if signing["scheme"] != "pfx" or signing["timestampUrl"] != TIMESTAMP or signing["exitCode"] != 0:
        return "fail", fail(f"signing record has the wrong values: {signing}")
    if Path(signing["tool"]).resolve() != shim.resolve():
        return "fail", fail(f"signing record names the wrong tool: {signing['tool']}")
    summary_text = json.dumps(summary)
    if PASSWORD in summary_text or "password" in summary_text.lower():
        return "fail", fail("build/make-installer.json contains a password")
    return "ok", None


def check_failure(ctx, payload):
    out = WORK / "setup-fail.exe"
    log = WORK / "signtool-fail-argv.txt"
    result = run(base_command(payload, out) + [
        "--sign", "--sign-pfx", ctx["pfx"], "--sign-signtool", ctx["shim"], "--dev", "--no-audit",
    ], {"INFANTGOD_SIGN_PASSWORD": PASSWORD, "SIGN_SMOKE_LOG": log, "SIGN_SMOKE_EXIT": "1"})
    text = output_of(result)
    if result.returncode != 1:
        return fail(f"a failing signtool exited {result.returncode}, expected 1:\n{text}")
    if "signtool exited 1" not in text:
        return fail(f"the failure does not name signtool's exit code:\n{text}")
    summary = json.loads((ROOT / "build" / "make-installer.json").read_text(encoding="utf-8"))
    signing = summary.get("signing") or {}
    if signing.get("requested") is not True or signing.get("signed") is not False or signing.get("exitCode") != 1:
        return fail(f"the failed build did not record the attempt: {signing}")
    return None


def main(argv):
    if os.name != "nt":
        return skip("signing is Windows-only")
    ctx, code = prepare()
    if code is not None:
        return code
    payload = make_payload()

    checks = [
        ("dry-run", check_dry_run),
        ("no certificate", check_no_cert),
        ("missing password", check_missing_password),
        ("missing signtool", check_missing_tool),
    ]
    for name, check in checks:
        error = check(ctx, payload)
        if error:
            return error

    status, code = check_signed_build(ctx, payload)
    if status == "skip":
        return code
    if status == "fail":
        return code
    error = check_failure(ctx, payload)
    if error:
        return error

    if "--keep" not in argv:
        shutil.rmtree(WORK, ignore_errors=True)
    print("sign-smoke: ok -- password-less dry-run redaction, no-cert, missing-password "
          "and missing-tool exit 2, documented argv, no secret in the log or JSON, "
          "and a non-zero signtool fails the build")
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
