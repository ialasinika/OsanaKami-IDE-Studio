# InfantGod Studio Python tooling

Standard-library-only helpers that sit beside the C kernel (`core/`) and the
JavaScript shell (`shell/`). Nothing here is required to run InfantGod Studio: these are
build, scaffolding, verification and reference tools.

| Tool | What it is for |
| --- | --- |
| [`newlang.py`](newlang.py) | Writes a `.lang` descriptor in the exact grammar `langs/lang.mjs` parses (see `langs/README.md` for the grammar itself). |
| [`e2e.py`](e2e.py) | End-to-end protocol driver: spawns an endpoint, speaks newline-delimited JSON-RPC on its stdin/stdout, and asserts the frozen scenario. |
| [`build.py`](build.py) | Thin wrapper around the repository `Makefile` (it never invents compiler flags); locates `mingw32-make`/`gcc` and reports them. |

## Examples

**1. Scaffold a language descriptor (refuses to overwrite without `--force`)**

```console
python tools/newlang.py --id mylang --ext .ml --title MyLang --comment "//" --out langs
```

**2. Verify a build end to end** (`--kernel-cmd` takes the whole command line, so
the shell multiplexer can be driven too; the default `--kernel` is the
kernel-only path and skips the `lang.*` checks)

```console
python tools/build.py core test
python tools/e2e.py --kernel build/infantgod.exe
python tools/e2e.py --kernel-cmd "node shell/main.mjs rpc --workspace ."
```

## Notes

* Exit codes are consistent across the tools: `0` success, `1` a check or the
  build failed, `2` a driver or environment error (endpoint not found,
  conflicting endpoints, protocol failure, file that cannot be written) and `3`
  a malformed command line.
* `e2e.py` runs in **kernel mode** with `--kernel` (spawns `<infantgod> rpc`; the
  kernel serves no `lang.*`, so those checks are reported as skipped) and in
  **full mode** with `--kernel-cmd` (the command line is spawned verbatim, e.g.
  `node shell/main.mjs rpc --workspace .`; `lang.list`, `lang.tokenize` and the
  span-tiling assertion all run).
* `e2e.py` asserts eleven things: the `hello` handshake, `workspace.info`, the
  language layer (`lang.list`, `lang.tokenize`, and that its spans tile the file
  with no gaps or overlaps), `file.read`, `file.write` plus a stale
  `base_revision`, path containment (absolute and relative escapes refused with
  `1003`), the `board.save`/`board.load` round-trip, and `exec.start` streamed to
  `exec.exit`. Kernel mode skips the three language checks, so a green kernel run
  reads `8 passed, 0 failed, 3 skipped`; a green full run reads
  `11 passed, 0 failed, 0 skipped`. Both exit `0`.
* The `exec.start` check runs a **real child process** and asserts its streamed
  `exec.output` and its `exec.exit` code — the kernel spawning itself is the
  simplest command that exists on every checkout, and it needs no interpreter on
  the Python side.
* The revision checks have to *change* the file to move its revision, because a
  file revision is a content hash: they append a comment and then write the
  original bytes back, so a finished run leaves the fixture byte-identical
  (`sha256` checked). The restore runs from a `finally` block, so a failing
  check -- a concurrent edit moving the file under it, a killed endpoint between
  the two writes -- still puts the original bytes back instead of leaving the
  probe comment behind. The probe text is a Yarn comment, so the fixture stays a
  valid `.yarn` file while it is edited.
* The board check is a snapshot-and-restore too, of the whole document: it must
  not silently drop where the developer put the camera or which cards are open.
  Restoring re-serialises, so the bytes and the member order can change while the
  cards, links and viewport do not.
* Colour is disabled when stdout is not a TTY or when `NO_COLOR` is set.
