# seIDE Python tooling

Standard-library-only helpers that sit beside the C kernel (`core/`) and the
JavaScript shell (`shell/`). Nothing here is required to run seIDE: these are
build, scaffolding, verification and reference tools.

| Tool | What it is for |
| --- | --- |
| [`bf.py`](bf.py) | Brainfuck interpreter and reference implementation of the `langs/brainfuck.lang` semantics. It is also what `e2e.py` uses to learn the expected output of a fixture, and what `exec.start` runs. |
| [`newlang.py`](newlang.py) | Writes a `.lang` descriptor in the exact grammar `langs/lang.mjs` parses (see `langs/README.md` for the grammar itself). |
| [`e2e.py`](e2e.py) | End-to-end protocol driver: spawns an endpoint, speaks newline-delimited JSON-RPC on its stdin/stdout, and asserts the frozen scenario. |
| [`build.py`](build.py) | Thin wrapper around the repository `Makefile` (it never invents compiler flags); locates `mingw32-make`/`gcc` and reports them. |

## Examples

**1. Run a Brainfuck program, with input and a tape dump**

```console
python tools/bf.py examples/hello.bf --input "hello" --dump-tape
```

**2. Scaffold a language descriptor (refuses to overwrite without `--force`)**

```console
python tools/newlang.py --id brainfuck --ext .bf --title Brainfuck --comment "#" --out langs
```

**3. Verify a build end to end** (`--seide-cmd` takes the whole command line, so
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
* `e2e.py` asserts eleven things: the `hello` handshake, `workspace.info`, the
  language layer (`lang.list`, `lang.tokenize`, and that its spans tile the file
  with no gaps or overlaps), `file.read`, `file.write` plus a stale
  `base_revision`, path containment (absolute and relative escapes refused with
  `1003`), the `board.save`/`board.load` round-trip, and `exec.start` streamed to
  `exec.exit`. Kernel mode skips the three language checks, so a green kernel run
  reads `8 passed, 0 failed, 3 skipped`; a green full run reads
  `11 passed, 0 failed, 0 skipped`. Both exit `0`.
* The revision checks have to *change* the file to move its revision, because a
  file revision is a content hash: they append a comment, then write the original
  bytes back, so a finished run leaves the fixture byte-identical (`sha256`
  checked). A run killed mid-check can leave that appended comment behind; it is a
  Brainfuck comment, so the file still runs to the same output.
* Colour is disabled when stdout is not a TTY or when `NO_COLOR` is set.
