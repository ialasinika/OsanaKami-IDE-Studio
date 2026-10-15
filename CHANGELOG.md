# Changelog

What changed, in the order it changed.  This project is a prototype: the
version number says how usable it is, not how finished.

## v0.2.0-alpha.1 — 2026-10-15
The release pipeline.  Until now a release was a tag someone remembered to
create and a bundle someone remembered to zip; there is a tool for it now, and
it refuses to guess.

### Version

- `VERSION` at the repository root is the one place a seIDE version is decided.
  Two files carry a copy, because C89 and JavaScript cannot read a file at
  build time without a step this project does not have one of, and
  `tools/version.py` keeps them in step: `core/include/seide_cfg.h` and
  `shell/main.mjs`.  The duplicate define that used to sit in `core/src/main.c`
  is gone.
- `tools/version.py check` runs inside `make test`, so the copies cannot drift
  apart, and it also refuses a changelog whose top section names a different
  version than `VERSION` does.
- `tools/version.py show|check|set|bump` print, write and advance the number:
  `0.2.0-alpha.1` -> `0.2.0-alpha.2` -> `0.2.0-beta.1` -> `0.2.0-rc.1`.  A
  release has no pre-release suffix, so `bump` stops there and asks for the
  next version by name instead of inventing one.

### Releases

- `tools/release.py` cuts a release in five steps: preflight (version, branch,
  clean tree, free tag), verify (`make test`, plus `make smoke` from beta up),
  freeze (the changelog gets its date, in its own commit), artifacts, tag.  The
  release directory holds the artifacts, `SHA256SUMS`, `RELEASE-NOTES.md` and
  `manifest.json` -- the manifest being the machine-readable twin of the notes,
  so a mirror or a fork can assert exactly what it has.
- The channel table is the same one docs/RELEASING.md describes: alpha ships
  the source archive only, beta/rc/final ship that archive and the runnable
  win64 bundle, and 1.x final and LTS additionally ship the MSI and a bundle
  per named fork.  The source archive is on every channel on purpose: a binary
  nobody can rebuild is not a release this project knows how to make.
- `--dry-run` prints the whole plan and writes nothing.  `--no-tag`,
  `--skip-tests`, `--with-msi` and `--allow-branch` exist for rehearsals, and
  each of them changes what the notes claim about the release.
- Nothing is pushed unless `--push` is given.  This repository has no remote
  configured, so today an alpha is a local archive, a local tag and a manifest
  that says so.
- The branch model is in docs/RELEASING.md: `main` integrates, `release/<major>.<minor>`
  is cut for the first beta, `lts/<major>.<minor>` opens after 1.0.0.  The LTS
  window is deliberately not fixed yet.

### Forks

- `forks/<name>/fork.json` makes a fork something the pipeline knows about: it
  gets its own tag (`<name>-v<version>`), its own bundle with the fork's files
  laid over the bundle root, and a `<name>-fork.zip` holding the fork's whole
  delta plus an `APPLY.md` that says what to lay it on.
- `forks/electron-example/` is a worked example: an Electron window around the
  same shell, with `electron` in the fork's own `package.json`.  Electron never
  enters the kernel or the base shell -- that is the point of keeping it in a
  fork, and it is why this repository can stay dependency-free.

### Installer (1.x only)

- `tools/msi/` expands a WiX v4 source for a staged bundle and calls `wix` to
  bind it; the per-machine install ships the kernel, the shell, the docs and a
  Start Menu shortcut.  WiX is deliberately not a build dependency: a machine
  without it gets a sentence that says so rather than a fake `.msi`, and a 1.x
  final or LTS release treats the MSI as required rather than optional.

## v0.1.0-alpha — 2026-10-15

First alpha.  Everything below was built after this date's earlier work on the
prototype, and the whole tree passes `make test` plus `make smoke`.

### Licence

- The code is MIT ([LICENSE](LICENSE)) and the documentation is now
  **CC BY 4.0** ([LICENSE-DOCS](LICENSE-DOCS), with the scope list, the
  attribution notice to keep, and the official legal code).  Every Markdown file
  in the repository is documentation; everything else is code.

### Board undo and redo

- `Ctrl+Z` / `Ctrl+Shift+Z` (`Ctrl+Y` too), and the `undo` / `redo` commands,
  take back the last **board** change: a card added, removed, moved, resized or
  edited, a link made or dropped, z-order brought forward.  Typing inside a card
  keeps the textarea's own undo, as in any other editor — a sentence is not a
  board step.
- The step list lives in `shell/web/history.mjs`, in memory only: a reload
  forgets it, and saving does not create a step.  Same-label edits within 700 ms
  fold into one step, and 200 steps are kept.
- Verified by nine DOM-free checks in `shell/web/selftest.mjs` (69 checks in
  total) **and** by `tools/undo_smoke.py`, which boots the real app in the system
  browser, adds a card by double-clicking empty space, and then sends the
  keystrokes: six checks, including that Ctrl+Z with a text field focused leaves
  the board alone.  `make smoke` runs it.

**The board is still the project state.** Cards on an infinite plane, links
between them, no tabs and no file tree.  A fresh clone opens an **empty canvas**
(the layout lives in `.seide/`, which is git-ignored) — `python tools/demo.py`
installs the five-card starter board from `examples/board.json` if you want the
screen in the README.

### Kernel (`core/`, C89, no dependencies)

- Newline-delimited JSON-RPC over stdio; `hello`, `workspace.info`,
  `workspace.list`, `file.read`, `file.write`, `board.load`, `board.save`,
  `board.newId`, `exec.start`, `exec.stop`, `exec.list`.
- Modules are trimmable per line in the Makefile's `SRC` list; `seide modules`
  prints what each one costs.
- The kernel knows no languages: `langs/` is served entirely by the shell.

### Languages (`langs/`, the shell's layer)

- A descriptor grammar (`.lang`) with two **families**: `flat` (Brainfuck) and
  `sgml` (HTML, XML/SVG and friends).  Adding a language is one text file — no
  code.
- Flat: comments, block comments, strings, keyword/command/type/constant token
  lists, scanned in a frozen order.
- SGML: elements, attributes, entities, CDATA, doctype/PI, comments, and
  per-descriptor raw elements (`script`/`style`/`textarea`/`title` for HTML).
- `lang.tokenize` returns spans that tile the file with no gaps or overlaps, in
  the same wire form for both families (`node langs/selftest.mjs`, 87 checks).

### Shell (`shell/`)

- `seide rpc` (stdio) and `seide serve` (HTTP + SSE + the system browser in
  `--app=` mode).  No Electron, no bundled Chromium, no npm dependencies.
- Six card kinds: `editor`, `runner`, `note`, `files`, `sheet` and `project`.
- The `project` card answers "what is in this project, and what do I have open
  in it": the workspace listing folded by folder, merged with the open editors,
  with one panel per board and a filter.
- Autosave with optimistic locking on every write; a stale write is refused,
  never silently merged.

### Tools (`tools/`, Python 3.12 standard library only)

- `demo.py` installs the starter board; `build.py` drives the Makefile;
  `e2e.py` drives the protocol end to end; `newlang.py` writes a conforming
  descriptor; `bf.py` is the Brainfuck reference interpreter;
  `kernel_probe.py` re-checks every fixed bug; `browser_smoke.py` renders the
  window headless and asserts on the DOM; `undo_smoke.py` presses Ctrl+Z in it.

### Bugs found and fixed before this release

Four adversarial probing rounds found 33 defects; 31 are fixed and each one is
recorded in [`docs/BUGS.md`](docs/BUGS.md) with its symptom and root cause.  The
worst were silent data loss in `board.save`, `file.write` ignoring a
wrong-typed `base_revision`, and validation that was quadratic in the number of
cards (20 000 cards: 72.59 s → 0.81 s).

Two more were found by cloning the repository and running the suite in the
clone, which is the only way to see what a new reader sees:

- **A clone on Windows got CRLF line endings.**  Git for Windows ships
  `core.autocrlf=true`, so `examples/hello.bf` arrived as 841 bytes instead of
  820 and the byte-exact fixture check failed on a checkout nobody had edited.
  `.gitattributes` now pins `* text=auto eol=lf`, and `kernel_probe.py` compares
  the fixture against what it read at the start of the run instead of a size
  written into the source.
- **`make smoke` failed on a fresh clone**, because there was no
  `.seide/board.json` to paint (it is gitignored).  It now installs
  `examples/board.json` for the run and removes it again.

### Verification

`make check` (9 passed, 0 failed, 4 skipped), `make fullcheck` (13/0/0),
`make probe` (43 checks, all ok), the C JSON test, `langs/selftest.mjs` (87/87),
`shell/web/selftest.mjs` (69/69), and `make smoke` in the real browser
(`browser_smoke.py` 5/0, `undo_smoke.py` 6/0) — all of them also run from a fresh
`git clone` of the tagged commit.  Two defects are recorded as **not** fixed in
`docs/BUGS.md`; `browser_smoke.py` still drives no pointer, and says so in its own
output.

### Known limits

- Windows only: `core/port/` has one implementation (`sys_win32.c`,
  `proc_win32.c`).  The port layer is the only OS-aware code.
- No undo of the typing inside a card, and board undo steps are not written to
  disk: a reload forgets them.
- The card-kind hook is fork-time only: there is no plugin loading.
- CI (`.github/workflows/ci.yml`) is written but has never run on a GitHub
  runner — it was authored on a machine without one.  Its steps are exactly the
  local commands above.
