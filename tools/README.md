# InfantGod Studio Python tooling

Standard-library-only helpers that sit beside the C kernel (`core/`) and the
JavaScript shell (`shell/`). Nothing here is required to run InfantGod Studio: these are
build, scaffolding, verification and reference tools.

| Tool | What it is for |
| --- | --- |
| [`newlang.py`](newlang.py) | Writes a `.lang` descriptor in the exact grammar `langs/lang.mjs` parses (see `langs/README.md` for the grammar itself). |
| [`e2e.py`](e2e.py) | End-to-end protocol driver: spawns an endpoint, speaks newline-delimited JSON-RPC on its stdin/stdout, and asserts the frozen scenario. |
| [`kernel_probe.py`](kernel_probe.py) | The regression probe for every bug in [`docs/BUGS.md`](../docs/BUGS.md), plus the shapes `file.stat` promises: spawns the kernel against a scratch workspace under `build/` and asserts the safe outcome of each fix. `make probe`. |
| [`kernel_drive.py`](kernel_drive.py) | The stdio JSON-RPC harness `kernel_probe.py` runs on: starts `<infantgod> rpc --root DIR`, pumps both pipes on reader threads, and turns a silent method into `<silence>` instead of a hang. |
| [`seide_cli.py`](seide_cli.py) | The protocol's **second client**: `hello`, `info`, `ls`, `cat`, `write`, `board`, `run` and `selfcheck`, over the same stdio JSON-RPC, importing nothing from `shell/`. `board` prints the document this client keeps (`.infantgod/board.json` unless `--path` says otherwise) and says so when it is not the board shape -- the kernel stores a document without reading it, so this path and this shape are this client's word for them, not the kernel's; `write` refuses to replace an existing file without `--base-revision` or `--force`; `run` streams `exec.output` and exits with the child's code; `selfcheck` runs eight checks against a scratch workspace under `build/`. `make cli-check`. |
| [`browser_smoke.py`](browser_smoke.py) | The window, without a human: starts the host, drives the system browser headless (`--dump-dom`) and asserts on the rendered DOM -- HUD, workspace root, painted board. Restores the board byte-identically and kills the host by pid; with no board at all (a fresh clone) it installs `examples/board.json` for the run and removes it again. `make smoke`. Carries the shared driver -- host, browser lookup, board backup -- that `input_smoke.py` imports. |
| [`input_smoke.py`](input_smoke.py) | The other half of the window: `browser_smoke.py` drives no pointer, no keyboard and no wheel, so this one serves a small same-origin wrapper page, frames the app in it, proves the window opened on the classic tile with `mode board` still behind it -- which is why every board step below says `mode board` out loud before it drags anything -- and only then double-clicks empty space, dispatches `Ctrl+Z` and `Ctrl+Shift+Z` and counts cards in the iframe's DOM. Also proves that `Ctrl+Z` with a text field focused does *not* move the board, and who owns a wheel: it opens a file so a card really can scroll, then checks that a wheel over that card's own scroll region scrolls the card and leaves the viewport alone, that a wheel over bare board still pans, and that `Ctrl`+wheel over the card still zooms. Finally it makes a change **no notification covers** -- it rewrites a file with a real child process (`cmd /c echo`) while an editor card holds it, then reads the card's status back through `file.read` -- and checks all four answers: a clean card reloads, a card with unsaved edits keeps its text and says the file changed, a deleted file is reported instead of written back, and a card never claims a revision it did not read. Finally it drives the editor card's own keys -- `Tab`, `Shift+Tab`, `Enter` after an opener, `Ctrl+F`, next-hit, replace-all, `Esc` -- reading the buffer and the painted `<mark>`s back out of the DOM, and checks the one thing only a browser can prove: that the card's own edits went in through `document.execCommand("insertText")`, so `Ctrl+Z` still has them. Then it reads the editor's own gutter -- one number per line, the last one matching the file -- and clicks it off and clicks it back on, the way a reader would. Last it types `mode classic` and measures the view as drawn -- the same cards tiled into a sidebar, a tab strip and a code area, a tab click moving the code area to that file, the board's wheel gestures off while the board is not on screen, and `mode board` putting every card back where the document says it was. Runs second in `make smoke`. |
| [`demo.py`](demo.py) | Installs `examples/board.json` -- the five-card board in the README's screenshots -- as this workspace's `.infantgod/board.json`. `.infantgod/` is gitignored, so a fresh clone opens an **empty canvas** and every screenshot in these docs would be unreproducible. Refuses to overwrite an existing board without `--force`; `--print` shows the board and changes nothing. |
| [`build.py`](build.py) | Thin wrapper around the repository `Makefile` (it never invents compiler flags); locates `mingw32-make`/`gcc` and reports them. |

## Examples

**1. Scaffold a language descriptor (refuses to overwrite without `--force`)**

```console
python tools/newlang.py --id mylang --ext .ml --title MyLang --comment "//" --out langs
```

**2. Give a clone the board in the screenshots** -- the layout is per-checkout
state and is not committed, so a new clone starts empty

```console
python tools/demo.py                 # install into ./.infantgod/board.json
python tools/demo.py --root DIR      # ... into another workspace
python tools/demo.py --force         # replace a board you already have
python tools/demo.py --print         # print it, change nothing
```

**3. Prove the fixed bugs are still fixed** -- against its own scratch workspace,
so it cannot touch your board or your files

```console
python tools/kernel_probe.py
```

**4. Check that the window still paints** -- needs a Chromium-family browser;
with none installed it says so and exits `0` with a skip, because "no browser" is
not a failure of the board

```console
python tools/browser_smoke.py
python tools/browser_smoke.py --edge "C:\Program Files (x86)\Microsoft\Edge\Application\msedge.exe" --keep
```

**5. Verify a build end to end** (`--kernel-cmd` takes the whole command line, so
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
* `e2e.py` asserts sixteen things: the `hello` handshake, `workspace.info`, the
  language layer (`lang.list`, `lang.tokenize`, and that its spans tile the file
  with no gaps or overlaps), `file.read`, `file.write` plus a stale
  `base_revision`, path containment (absolute and relative escapes refused with
  `1003`), the `file.read_bytes`/`file.write_bytes` round-trip of all 256 byte
  values (including the NULs that make the file binary, and the same
  `base_revision` rail the text verbs use), a payload that is not base64, the
  `view.save`/`view.load` round-trip, the shipped starter board
  (`examples/board.json` stored and read back member for member -- the kernel
  does not judge the shape, so this is a storage check, and the board schema's
  own check is `shell/web/selftest.mjs`), and `exec.start` streamed to
  `exec.exit`. Kernel mode skips the three language checks, so a green kernel run
  reads `13 passed, 0 failed, 3 skipped`; a green full run reads
  `16 passed, 0 failed, 0 skipped`. Both exit `0`.
* The `exec.start` check runs a **real child process** and asserts its streamed
  `exec.output` and its `exec.exit` code — the kernel spawning itself is the
  simplest command that exists on every checkout, and it needs no interpreter on
  the Python side.
* The revision checks have to *change* the file to move its revision, because a
  file revision is a content hash: they append a comment and then write the
  original bytes back, so a finished run leaves the fixture byte-identical --
  writing those bytes back has to return the original revision, and that is what
  proves the restore. The restore runs from a `finally` block, so a failing
  check -- a concurrent edit moving the file under it, a killed endpoint between
  the two writes -- still puts the original bytes back instead of leaving the
  probe comment behind. The probe text is a Yarn comment, so the fixture stays a
  valid `.yarn` file while it is edited.
* The two document checks share a `board_state`/`board_restore` pair, and the
  state is the **whole** document (`view.save` / `view.load`), not just the two
  arrays the suite knows about: a suite that silently drops where the developer
  put the camera, or which cards are open, is testing the wrong product --
  rebuilding the document out of the cards alone is how the viewport got reset
  silently while the run still exited `0`. Restoring goes back through
  `view.save`, so the result is the kernel's own serialisation: the bytes and the
  member order can change while the cards, links and viewport do not, and these
  checks compare semantics rather than bytes because the kernel, not the test,
  owns the formatting. `board_state()` decides for itself whether a document was
  there (`os.path.exists` on the absolute path) -- the kernel's reply describes
  the document it holds, not the directory -- and if the workspace had none, the
  run removes the file it created **and** the now-empty `.infantgod/` directory,
  so a finished test run leaves the tree exactly as it started.
* `browser_smoke.py` snapshots `.infantgod/board.json` byte for byte before it
  starts the host and puts it back afterwards; on a clone that has no board it
  installs `examples/board.json` for the run (a fresh clone has no board — the
  layout is gitignored) and removes it again when it is done.
* Colour is disabled when stdout is not a TTY or when `NO_COLOR` is set.
