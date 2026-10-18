#!/usr/bin/env python3
"""ci_audit.py -- check .github/workflows/ci.yml without a runner or network.

The repository has no git remote, so the workflow cannot be executed on GitHub
from here.  This audit is the next best thing: it checks the properties that
would make a run fail before it starts, and it does not need PyYAML (it parses
the small, regular subset of YAML the workflow uses with indentation-aware
regexes).  When PyYAML is installed it also parses the file for real and checks
the same properties on the resulting document.

What it asserts:
  * every `uses:` is pinned to a major tag (`@vN`) or a 40-hex commit SHA;
  * every job declares `runs-on`;
  * every step has `uses` or `run`;
  * the `test` job runs `make ci` and uploads the installer artefacts;
  * the `sign_gate` job reads secrets.SIGN_PFX and secrets.SIGN_PASSWORD and
    exposes an `enabled` output;
  * the `sign` job depends on that gate and is conditional on its output.

Exit 0 prints one `ci-audit: ok ...` line; exit 1 prints every failure.
"""

import re
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
WORKFLOW = ROOT / ".github" / "workflows" / "ci.yml"

PINNED = re.compile(r"@(v\d+|[0-9a-f]{40})$")


def job_blocks(text):
    """The lines under each direct child of `jobs:` (the workflow's shape)."""
    lines = text.splitlines()
    start = None
    for index, line in enumerate(lines):
        if re.match(r"^jobs:\s*$", line):
            start = index
            break
    if start is None:
        return None
    blocks = {}
    current = None
    for line in lines[start + 1:]:
        if not line.strip() or line.lstrip().startswith("#"):
            continue
        indent = len(line) - len(line.lstrip())
        if indent == 0:
            break
        match = re.match(r"^  ([A-Za-z0-9_-]+):\s*$", line)
        if match:
            current = match.group(1)
            blocks[current] = []
        elif current is not None:
            blocks[current].append(line)
    return blocks


def structural_checks(text):
    errors = []
    if not WORKFLOW.is_file():
        return [f"workflow not found: {WORKFLOW}"]

    uses = re.findall(r"^\s*(?:-\s*)?uses:\s*([^\s#]+)", text, re.M)
    if not uses:
        errors.append("the workflow has no `uses:` steps")
    for action in uses:
        if not PINNED.search(action):
            errors.append(f"action is not pinned to @vN or a 40-hex SHA: {action}")

    if not re.search(r"^permissions:\s*$", text, re.M):
        errors.append("no top-level `permissions:` block")

    blocks = job_blocks(text)
    if not blocks:
        return errors + ["could not find any jobs under `jobs:`"]
    for name, lines in blocks.items():
        body = "\n".join(lines)
        if not re.search(r"^    runs-on:\s*\S+", body, re.M):
            errors.append(f"job `{name}` has no runs-on")
        if not re.search(r"^    steps:\s*$", body, re.M):
            errors.append(f"job `{name}` has no steps list")
        if not re.search(r"^\s+-?\s*(?:uses|run):", body, re.M):
            errors.append(f"job `{name}` has no uses/run steps")

    test = "\n".join(blocks.get("test", []))
    if "make" not in test or "ci" not in test:
        errors.append("the test job does not run `make ci`")
    if "upload-artifact" not in test:
        errors.append("the test job does not upload an artifact")

    gate = "\n".join(blocks.get("sign_gate", []))
    for secret in ("secrets.SIGN_PFX", "secrets.SIGN_PASSWORD"):
        if secret not in gate:
            errors.append(f"sign_gate does not read {secret}")
    if "outputs:" not in gate or "enabled:" not in gate:
        errors.append("sign_gate does not expose an `enabled` output")

    sign = "\n".join(blocks.get("sign", []))
    if not re.search(r"^    if:\s*(?:\$\{\{\s*)?needs\.sign_gate\.outputs\.enabled", sign, re.M):
        errors.append("the sign job is not conditional on needs.sign_gate.outputs.enabled")
    if "needs:" not in sign:
        errors.append("the sign job does not depend on the test job and the gate")
    if "secrets.SIGN_PASSWORD" not in sign:
        errors.append("the sign job does not pass SIGN_PASSWORD to the build")
    if "Get-AuthenticodeSignature" not in sign:
        errors.append("the sign job does not verify the signature")
    return errors


def parsed_checks(yaml):
    errors = []
    try:
        document = yaml.safe_load(WORKFLOW.read_text(encoding="utf-8"))
    except Exception as error:  # yaml.YAMLError, but keep the message verbatim
        return [f"PyYAML could not parse the workflow: {error}"]
    if not isinstance(document, dict):
        return ["the workflow is not a YAML mapping"]
    jobs = document.get("jobs")
    if not isinstance(jobs, dict) or not jobs:
        return ["the parsed workflow has no jobs mapping"]

    for name, job in jobs.items():
        if not isinstance(job, dict):
            errors.append(f"job `{name}` is not a mapping")
            continue
        if "runs-on" not in job:
            errors.append(f"job `{name}` has no runs-on")
        steps = job.get("steps")
        if steps is None:
            errors.append(f"job `{name}` has no steps")
            continue
        if not isinstance(steps, list) or not steps:
            errors.append(f"job `{name}` has an empty steps list")
            continue
        for index, step in enumerate(steps):
            if not isinstance(step, dict):
                errors.append(f"job `{name}` step {index} is not a mapping")
                continue
            if "uses" not in step and "run" not in step:
                errors.append(f"job `{name}` step {index} has neither uses nor run")
            if "uses" in step and not PINNED.search(str(step["uses"])):
                errors.append(f"job `{name}` step {index} action is not pinned: {step['uses']}")

    gate = jobs.get("sign_gate") or {}
    gate_steps = gate.get("steps") or []
    gate_env = " ".join(str(step.get("env", {})) for step in gate_steps if isinstance(step, dict))
    for secret in ("secrets.SIGN_PFX", "secrets.SIGN_PASSWORD"):
        if secret not in gate_env:
            errors.append(f"parsed sign_gate does not put {secret} in a step env")
    if "enabled" not in (gate.get("outputs") or {}):
        errors.append("parsed sign_gate has no enabled output")

    sign = jobs.get("sign") or {}
    condition = str(sign.get("if", ""))
    if "sign_gate" not in condition or "enabled" not in condition:
        errors.append(f"parsed sign job is not conditional on the gate: {condition!r}")
    needs = sign.get("needs")
    needs_list = needs if isinstance(needs, list) else [needs]
    if "test" not in needs_list or "sign_gate" not in needs_list:
        errors.append(f"parsed sign job needs {needs!r}, expected test and sign_gate")
    sign_env = " ".join(
        str(step.get("env", {})) for step in (sign.get("steps") or []) if isinstance(step, dict)
    )
    if "secrets.SIGN_PASSWORD" not in sign_env:
        errors.append("parsed sign job does not pass SIGN_PASSWORD to a step")
    return errors


def main():
    if not WORKFLOW.is_file():
        print(f"ci-audit: FAIL: workflow not found: {WORKFLOW}")
        return 1
    text = WORKFLOW.read_text(encoding="utf-8")
    errors = structural_checks(text)

    try:
        import yaml
    except ImportError:
        yaml = None
    if yaml is not None:
        errors += parsed_checks(yaml)
        parser = "PyYAML"
    else:
        parser = "structural only (PyYAML not installed)"

    if errors:
        for error in errors:
            print(f"ci-audit: FAIL: {error}")
        return 1

    blocks = job_blocks(text) or {}
    uses = len(re.findall(r"^\s*(?:-\s*)?uses:", text, re.M))
    print(f"ci-audit: ok -- {len(blocks)} jobs, {uses} pinned actions, "
          f"sign job gated on SIGN_PFX/SIGN_PASSWORD; parser: {parser}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
