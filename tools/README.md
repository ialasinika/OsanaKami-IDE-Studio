# seIDE Python tooling

Standard-library-only helpers that sit beside the C kernel (`core/`) and the
JavaScript shell (`shell/`). Nothing here is required to run seIDE: these are
build, scaffolding, verification and reference tools.

| Tool | What it is for |
| --- | --- |
| [`bf.py`](bf.py) | Brainfuck interpreter and reference implementation of the `langs/brainfuck.lang` semantics. It is also what `e2e.py` uses to learn the expected output of a fixture, and what `exec.start` runs. |
| [`newlang.py`](newlang.py) | Writes a `.lang` descriptor in the exact grammar `langs/lang.mjs` parses — flat by default, or an SGML-family member with `--family sgml` and repeatable `--raw-element NAME` (see `langs/README.md` for the grammar itself). |
| [`e2e.py`](e2e.py) | End-to-end protocol driver: spawns an endpoint, speaks newline-delimited JSON-RPC on its stdin/stdout, and asserts the frozen scenario. |
| [`kernel_probe.py`](kernel_probe.py) | The regression probe for every bug in `docs/BUGS.md`: spawns the kernel against a scratch workspace under `build/` and asserts the safe outcome of each fix. `make probe`. |
| [`kernel_drive.py`](kernel_drive.py) | The stdio JSON-RPC harness `kernel_probe.py` runs on: starts `<seide> rpc --root DIR`, pumps both pipes on threads, and turns a silent method into `<silence>` instead of a hang. |
| [`browser_smoke.py`](browser_smoke.py) | The window, without a human: starts the host, drives the system browser headless (`--dump-dom`), and asserts on the rendered DOM — HUD, workspace root, painted board. Restores the board byte-identically and kills the host by pid. `make smoke`. |
| [`build.py`](build.py) | Thin wrapper around the repository `Makefile` (it never invents compiler flags); locates `mingw32-make`/`gcc` and reports them. |
| [`demo.py`](demo.py) | Installs `examples/board.json` — the five-card board in the README's screenshots — as this workspace's `.seide/board.json`. `.seide/` is gitignored, so a fresh clone otherwise opens an empty canvas, and every screenshot and bug report in the docs would be unreproducible. Refuses to overwrite an existing board without `--force`; `--print` shows the board and changes nothing. |

## Examples

**1. Run a Brainfuck program, with input and a tape dump**

```console
python tools/bf.py examples/hello.bf --input "hello" --dump-tape
```

**2. Scaffold a language descriptor (refuses to overwrite without `--force`)**

```console
python tools/newlang.py --id brainfuck --ext .bf --title Brainfuck --comment "#" --out langs
```

**3. Give a fresh clone the board in the screenshots** (the layout is per-checkout
state and is not committed, so a new clone starts with an empty canvas)

```console
python tools/demo.py                 # install into ./.seide/board.json
python tools/demo.py --root DIR      # ... into another workspace
python tools/demo.py --force         # replace a board you already have
python tools/demo.py --print         # print it, change nothing
```

**4. Prove the fixed bugs are still fixed** (43 checks, on its own scratch
workspace — it cannot touch your board)

```console
python tools/kernel_probe.py
```

**5. Check the window still paints** (needs a Chromium-family browser; says so
and exits 0 with a SKIP when there is none)

```console
python tools/browser_smoke.py
python tools/browser_smoke.py --edge "C:\path\to\msedge.exe" --keep
```

**6. Verify a build end to end** (`--seide-cmd` takes the whole command line, so
the shell multiplexer can be driven too; the default `--seide` is the
kernel-only path and skips the `lang.*` checks)

```console
python tools/build.py core test
python tools/e2e.py --seide build/seide.exe --fixture examples/hello.bf
python tools/e2e.py --seide-cmd "node shell/main.mjs rpc --workspace ." --fixture examples/hello.bf
```

## Notes

* Exit codes are consistent across the tools: `0` success, `1` a check or the
  build failed, `2` a driver or environment error (endpoint not found,
  conflicting endpoints, protocol failure, file that cannot be written) and `3`
  a malformed command line. `bf.py` uses `2` for a program or parse error and
  `3` for a usage error.
* `e2e.py` runs in **kernel mode** with `--seide` (spawns `<seide> rpc`; the
  kernel serves no `lang.*`, so those checks are reported as skipped) and in
  **full mode** with `--seide-cmd` (the command line is spawned verbatim, e.g.
  `node shell/main.mjs rpc --workspace .`; `lang.list`, `lang.tokenize` and the
  span-tiling assertion all run).
* `e2e.py` asserts thirteen things: the `hello` handshake, `workspace.info`, the
  language layer (`lang.list`, `lang.tokenize`, that its spans tile the file with
  no gaps or overlaps, and that an SGML file — `examples/page.html`, not the
  Brainfuck fixture — goes through the same path with its own kinds),
  `file.read`, `file.write` plus a stale `base_revision`, path containment
  (absolute and relative escapes refused with `1003`), the `board.save`/
  `board.load` round-trip, the shipped starter board (`examples/board.json`
  saved through the real validator and compared back), and `exec.start` streamed
  to `exec.exit`. Kernel mode skips the four language checks, so a green kernel
  run reads `9 passed, 0 failed, 4 skipped`; a green full run reads
  `13 passed, 0 failed, 0 skipped`. Both exit `0`.
* The revision checks have to *change* the file to move its revision, because a
  file revision is a content hash: they append a comment, then write the original
  bytes back, so a finished run leaves the fixture byte-identical (`sha256`
  checked). The restore runs from a `finally` block, so a failing check -- a
  concurrent edit moving the file under it, a killed endpoint between the two
  writes -- still puts the original bytes back instead of leaving the probe
  comment behind.
* The two board checks are snapshot-and-restore as well, of the whole document
  (`board_state()` / `board_restore()`): a suite that silently drops where the
  developer put the camera or which cards are open is testing the wrong product.
  Restoring goes back through `board.save`, so the result is the kernel's own
  serialisation; with the shipped starter board that is byte-identical (3107
  bytes measured), and the check reports semantics rather than bytes because the
  kernel, not the test, owns the formatting.
* Colour is disabled when stdout is not a TTY or when `NO_COLOR` is set.
