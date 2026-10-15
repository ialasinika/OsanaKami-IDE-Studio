# Changelog

What changed, in the order it changed.  This project is a prototype: the
version number says how usable it is, not how finished.

## Unreleased
### Shell

- The board can select more than one card.  `Ctrl+A` selects every card,
  ctrl/⌘-click (and shift-click) add or remove one, `Shift`+drag on empty space
  draws a rubber band that selects everything it touches, dragging any selected
  card moves the whole set by one delta, and `Delete` removes the set.  The
  selection is a set of ids with a primary member rather than a scalar
  `selectedId`; `selectedId` still names the primary, so single-card verbs are
  unchanged, and the collapse back to one card happens on mouse-up when the
  pointer never moved.  `cardsWithin` (intersection, not containment, because a
  band that clips a corner must still pick the card up) lives in `board.mjs` and
  is pure; the band is drawn inside `#stage`, so it is world-space and zooms with
  the board.  A group move or delete is one change, one undo step and one save,
  and an edge whose endpoint is deleted goes with it (`1004 INVALID_BOARD`
  otherwise).  The command line gained `select <id...> | all | none`, and `delete`
  with no argument acts on the selection.  `shell/web/selftest.mjs` is 89 checks
  and `tools/input_smoke.py` drives the gestures in a real window (23 checks).
- The workspace can be searched from the board.  `find <text>` opens a `search`
  card (or re-points the one already there) at the centre of the view; it lists
  the workspace once, then reads the files that may hold the text and shows one
  row per hit as `line:column` plus the line cut around the hit.  A row opens its
  file — reusing an editor card already showing it — with the caret on that line.
  The find is literal and runs when asked, not on every keystroke; the budgets are
  part of the status line (200 files read, 50 hits per file, 200 hits total,
  nothing over 512 KiB, NUL-containing files skipped as binary), and the status
  says when one of them stopped the list.  `searchInText`, `searchExcerpt` and
  `searchFiles` are pure and exported, so the line/column, excerpt and budget
  arithmetic is checked without a DOM.
- The editor card gained the keys a text editor needs.  `Tab` and `Shift+Tab`
  indent and outdent the lines the selection touches, `Enter` keeps the line's
  indentation and steps in one more after `{`, `(` or `[`, and `Ctrl+F` opens a
  find bar with next/previous hit, replace and replace-all (`Esc` closes it).
  Every hit is painted in the colour layer as well as selected in the textarea,
  so matches stay visible while the caret is in the find bar.  The indent,
  auto-indent and replace edits go in through the browser's own insert command
  rather than by assigning `.value`, so `Ctrl+Z` still takes back a `Tab`.  The
  arithmetic is pure and exported (`indentSelection`, `indentAfterEnter`,
  `findMatches`, `replaceMatchAt`, `replaceAllMatches`, `markHits`) and checked
  in `shell/web/selftest.mjs`; `tools/input_smoke.py` presses the keys in a real
  window.

### Docs

- Token offsets are documented as **string indices**, which is what
  `lang.tokenize` always returned: six places said byte offsets, and a client
  that believed them would slice non-ASCII text in the wrong unit.  The claim is
  now pinned by `langs/selftest.mjs` (92 checks) and `shell/web/selftest.mjs`
  with non-ASCII fixtures.  No behaviour changed — the description
  caught up with the code.
- `shell/web/README.md` documents the editor card's own keys, the multi-select
  gestures and the search card, `docs/PARADIGM.md` and `docs/FORK.md` no longer
  list rubber-band selection or finding across the workspace as missing, and the
  check counts in `README.md` and `docs/ARCHITECTURE.md` follow the three suites.

## v0.2.1-alpha.2 — 2026-10-15
### Docs

- The README's version paragraph no longer names one release.  It said
  `0.2.0-alpha.2` and went stale the moment 0.2.1-alpha.1 was cut: the tooling
  checks the version copies, not prose.  The paragraph now points at
  `git describe --tags` and `dist/<version>/`.

### Tools

- `tools/release.py` and `tools/version.py` print UTF-8 where the stream allows
  it.  A run on a cp936 console died with `UnicodeEncodeError` while printing
  `make test`'s own output (`ok   U+1F600 -> F0 9F 98 80`), which is the worst
  place to stop -- after the tag already exists.  Captured child output had
  already been fixed; this is the printing half of the same problem.

## v0.2.1-alpha.1 — 2026-10-15
### Shell

- A wheel over a card's own contents scrolls the card instead of panning the
  board.  The wheel listener sits on the board and the event bubbles up from
  inside a card, so panning was unconditional: an editor's text, a sheet and the
  files list could not be scrolled at all.  Now the nearest scroll region under
  the pointer keeps the wheel while it has room in that direction, at its end
  the board pans again, and ctrl/⌘+wheel still zooms wherever the pointer is.
  `scrollRoom()` holds that rule's arithmetic and is checked in
  `shell/web/selftest.mjs` (70 checks now); `tools/input_smoke.py` dispatches the
  real event over a card and over the board and checks who wins.

### Tools

- `tools/e2e.py` removes the empty `.seide/` directory left behind when the
  suite created the board and put it back: a test run should not leave a state
  directory nobody asked for.  `make test` in a fresh clone now ends with the
  tree exactly as it started.
- `tools/undo_smoke.py` is now `tools/input_smoke.py`: it drives the window's
  input, and the undo keys are no longer the only thing it checks.  The wrapper
  page and the browser it launches are the same; the name now says what it is.

## v0.2.0-alpha.3 — 2026-10-15
What the 1.0.0 rehearsal turned up.

### Releases

- A fork release's notes name the fork and its delta in a sentence of their own
  instead of trailing them after the MSI clause.
- A fork's delta archive keeps the `forks/<name>/` prefix, so unpacking it over
  the base tree lands exactly where the base tree keeps forks.  `APPLY.md` says
  so, which is what makes "copy this over the base tree" literally true.
- A 1.x bundle cut with `--no-msi` says the installer is missing on purpose in
  its own `START-HERE.txt`, not only in the notes beside it.

### CI

- `.github/workflows/release.yml` takes a pushed tag and rebuilds the release
  that was cut locally: it checks that the tag names `VERSION`, runs the same
  suite, writes the same notes, manifest and artifacts with
  `python tools/release.py --no-tag --no-freeze --allow-branch`, keeps the
  directory as a workflow artifact and publishes it as a GitHub release
  (`--prerelease` when the version carries a pre-release identifier).  Like
  `ci.yml`, it has never run on a GitHub runner and says so in its own header.
- `tools/release.py --no-tag` no longer requires the tag to be free.  A run that
  will not create a tag should not refuse because one already exists, and that
  is exactly the position a tag push is in.

### Tools

- `tools/release.py` captures a suite's output as UTF-8, with replacement
  characters instead of an exception, and tells the child Python to write UTF-8.
  The locale on the machine a release is cut on is cp936, and a suite that
  printed an em dash made the capture come back empty: a real run's notes said
  `exit 0: (no output)` for a command that had printed 13 KB of evidence.

## v0.2.0-alpha.2 — 2026-10-15
The build stopped contradicting itself about its own version, and the release
pipeline can now rehearse a GA on a machine that has no Windows installer
toolchain.

### Build

- Every object file depends on `VERSION` and on the headers in `core/include/`,
  so a version change rebuilds the kernel.  `tools/version.py set` writes the
  number into a header, and make used to see only `.c` files: the objects that
  included `seide_cfg.h` kept the previous version, and one binary reported two
  different numbers -- `seide version` the new one, `hello` the old one.
- `docs/BUGS.md` entry **G** records the symptom, the cause and both halves of
  the fix, and `tools/kernel_probe.py` grew the three checks that would have
  caught it: the binary is asked which version and protocol it was built with,
  and the answers are compared with `VERSION` and `core/include/seide_cfg.h`
  (43 -> 46 checks).  A kernel built from older headers now fails `make probe`
  instead of shipping.

### Releases

- `tools/release.py --no-msi` skips the installer that a 1.x final or LTS
  release requires, and says so in the notes and in `manifest.json`
  (`msi: null` plus the reason).  WiX is not installed on the machine the
  `1.0.0` path is rehearsed on, so the rest of that release -- the bundle, the
  fork, the notes, the tag -- can be exercised for real instead of faked.

Verified in this tree: `make test` exit 0 (13 served checks, 13 full checks,
`make probe` 46 checks all ok including the three new ones, the C JSON test
`all good`, `langs/selftest.mjs` 87/87, `shell/web/selftest.mjs` 69/69).

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
