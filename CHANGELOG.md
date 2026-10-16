# Changelog

What changed, in the order it changed.  This project is a prototype: the
version number says how usable it is, not how finished.

InfantGod Studio is a fork of seIDE at `v0.1.0-alpha`.  The kernel, the shell,
the protocol and the tools are upstream's, renamed: `seIDE` becomes InfantGod
Studio, `.seide/` becomes `.infantgod/`, `core/include/seide_cfg.h` becomes
`core/include/infantgod_cfg.h`, the protocol name `seide/1` becomes
`infantgod/1` — the fork's first protocol version, replaced by `infantgod/2` in
`## Unreleased` below.  The Brainfuck fixtures are retargeted to Yarn, so
`examples/hello.yarn` is the fixture the suite reads.  The `v0.1.0-alpha`
section below is inherited in that sense — upstream's work, as it stands in this
tree.

## Unreleased

### Kernel

- The kernel no longer knows what a view **is**.  `board.load`, `board.save` and
  `board.newId` are gone; `view.load {path}` and `view.save {path, document,
  base_revision?}` replace them.  The kernel keeps *a JSON document* at a path the
  caller names, hands it back verbatim, and never looks inside it: any JSON value
  except `null` round-trips exactly — an object shaped like a board, an array, a
  number — so `1004 INVALID_BOARD` is retired (the number stays reserved) and a
  malformed document can no longer stop the kernel from starting, because the
  kernel no longer reads one at startup.  `core/src/board.c` (`fill_defaults`,
  `validate`, `check_links`, `board_id`) and `core/include/board.h` were deleted,
  `core/src/view.c` and `core/include/view.h` took their place, and
  `SDE_WITH_BOARD` became `SDE_WITH_VIEW`.  What survives is the part a client
  cannot do for itself: the atomic neighbour-replace write, `base_revision`
  staleness with `data.current_revision` (`1001 STALE_REVISION`), the
  `view.changed` notification, and `workspace.info`'s `view_path` /
  `view_revision` — which report the document the kernel last read or wrote, not
  a workspace setting.  `SDE_PROTOCOL_VERSION` is **2**; the fork's protocol name
  is `infantgod/2`, and the rename is breaking on purpose, so an
  `infantgod/1` client is refused rather than half-served.  Reasoning, the
  failures this avoids and the price are in the new `docs/VIEWS.md`.

### Shell

- `shell/web/board.mjs` now owns the board schema, the `.infantgod/board.json`
  path (`BOARD_PATH`) and card ids (`makeId`, with `idFactory` left as a seam that
  nothing supplies — the old `board.newId` had no production caller).  Its rules
  are unchanged and still refuse what they always refused; the only difference is
  that the refusal now happens in the process that can explain it.  `main.mjs`
  names the path on every call and listens for `view.changed` instead of
  `board.changed`.
- The same board can be drawn as a **conventional IDE**: the command
  `mode classic` (or the HUD button, labelled with the view it will give you)
  tiles the focused `editor` card into a code area, every open editor into a tab
  strip above it and the first `project`/`files` card into a sidebar column,
  hiding the rest.  It is a **view, not a document**: switching creates no card,
  moves none, writes nothing to `board.json`, and `mode board` restores every
  card to the pixels — pan and zoom included — the document gives it; a card with
  no role is hidden rather than unmounted, so its text, scroll position and
  listeners survive a walk through the view and back; and a click in the view
  selects but never raises, so a first visit cannot dirty the board.  The role
  rules and the tile arithmetic are pure (`classicRoles`, `classicLayout`,
  `classicTabLabel` and the constants `CLASSIC_SIDEBAR_KINDS`,
  `CLASSIC_SIDEBAR_W`, `CLASSIC_SIDEBAR_MIN`, `CLASSIC_TAB_H` in
  `shell/web/classic.mjs`) and are measured in
  the board's own pixels, which is why `shell/web/selftest.mjs` pins them with no
  DOM (12 new checks, **118** in all) and `tools/input_smoke.py` measures the tile
  in a real window (4 new checks: the tiling and its parts, a tab click moving the
  code area to that file, the wheel leaving the viewport alone, and `mode board`
  restoring the board exactly, **25** in all).  The wheel stays the board's
  gesture, so the classic view has no pan and no zoom, and the HUD says `no zoom`
  rather than quoting a number that no longer describes the screen.  The view
  came from upstream seIDE `564d51e`, applied on top of the fork's own shell;
  nothing about the protocol, the board document or the card kinds changed.
- The same board can also be drawn as a **mod workbench**: `mode mod` (or the
  `Mod` button in the HUD's view switch) puts the mod package in the left column,
  the focused editor in the middle and the first `problems` card underneath it,
  hiding everything else.  It is the same kind of thing as `mode classic` — a
  **view, not a document**: nothing is written, no card moves, a card with no role
  is hidden rather than unmounted, a click selects but never raises, and
  `mode board` restores the pan and the zoom the document gives it.  The tile is
  the classic tile plus a report panel, and both can drop out: `MOD_SIDEBAR_KINDS`
  (the `mod` card first, then `project`, then `files`) at `MOD_SIDEBAR_W` 320 px
  and `MOD_SIDEBAR_MIN` 180 px, `MOD_TAB_H` 34 px, and a panel of `MOD_PANEL_H`
  200 px at its tallest — dropped outright rather than squeezing the code area
  below `MOD_AREA_MIN` 140 px, so that a board with no `problems` card has no
  panel and a board with no package card has no column, instead of drawing 320
  pixels of nothing.  The full rules are in `modview.mjs`; what every view is
  *called* moved out of `classic.mjs` into the new `shell/web/views.mjs`
  (`VIEWS`, `VIEW_LABELS`, `viewName`, `tiledView`, `viewHud`, `viewNote`,
  `viewAbout`), so the mode switch — now **one button per view**, built from
  `VIEWS`, instead of a single toggle — and the two tiles cannot disagree about
  what a mode is named.  `shell/web/selftest.mjs` gained 10 checks (**118** in
  all); the tile was then measured in a real window over a real mod package
  (`Mods/SODefines`, 1306 files, 347 validator errors) before it was written up.
- The editor has **line numbers**, and they are on when a file is opened: a gutter
  of its own down the left of the text (`ed-gutter` in `shell/web/cards.mjs`)
  holding a single `<pre>` of numbers (`ed-gutter-numbers`) that is rewritten only
  when the number of lines changes -- never one element per line, so a 4000-line
  file costs one string and scrolling costs no reflow at all.  The numbers share
  the code's font, leading and line box, so they cannot drift out of step with it.
  Clicking the gutter hides it and clicking it again brings it back
  (`showGutter`, which flips `data-on` and the surface's `has-gutter`/`no-gutter`),
  and hiding it hands its columns back to the code rather than leaving a hole.  It
  is a **view, not a document**: the state lives in the card and starts on, so
  `board.json` is not written and two windows need not agree.  The wheel still
  belongs to the card's scroll region, so the gutter is not a second place where a
  wheel means something else.  This came from upstream seIDE `e6ee30c` ("Prepare
  0.4.1-alpha.1"), whose own note is the argument for the default -- *The editor
  shows line numbers, and starts that way.*  `tools/input_smoke.py` checks both
  halves in a real window, because neither is visible to a DOM-less test: that the
  gutter holds one number per line with the last one matching the file, and that a
  click turns it off and another turns it back on (**25** in all).
- The HUD is **one line high**, whatever the selection says.  It was one line by
  luck: `hud-brand` sets no `white-space` of its own, so a long path squeezed it
  onto a second line, the strip grew from 30 px to 33 and every card under it
  moved three pixels -- which the classic view's own tile check caught, because
  it compares the board's rectangle before and after a click.  `.hud-item` now
  carries the `min-width: 0` a flex item needs before it can ellipsize at all,
  every item with a fixed width keeps it, and the selection is the one thing that
  gives up room.

### Undo and redo on the board

- `Ctrl+Z` takes back the last board edit and `Ctrl+Shift+Z` puts it back; both
  are also commands (`undo`, `redo`).  The ring lives in `shell/web/history.mjs`
  — document snapshots with coalescing, so a drag is one step, not forty — and
  an edit that cannot be expressed as a document snapshot stays off the ring
  rather than half-on it.
- It covers cards and links: add, delete, move, resize, edit, and a committed
  `sheet` cell.  It does **not** cover the typing inside a card (the textarea
  keeps the browser's own undo), a pan, a zoom, or a "raise to front", and the
  ring is in memory, so a reload forgets it.  `shell/web/README.md` says all of
  this where a reader will look for it.
- What it does not reach is now tested as well as what it does:
  `tools/input_smoke.py` frames the app in a same-origin wrapper page, makes a
  real board change with a real double-click, dispatches the real keydowns, and
  checks that `Ctrl+Z` with a text field focused leaves the board alone.
  `make smoke` runs it after `browser_smoke.py`.

### A wheel over a card scrolls the card

- A card's contents — an editor's text, a sheet, a runner's output, the mods
  list — are a scroll region *inside* the board, and their wheel events bubble up
  to the board element.  Panning unconditionally meant the board moved and the
  card never did.  The wheel handler now walks up from the pointer to the nearest
  container that can still move in the direction the wheel asks, and leaves the
  event to it; at the end of that container the wheel pans again, the way nested
  scrolling usually chains.  `Ctrl`+wheel still zooms about the cursor.
- Neither half of that is taken on faith.  `shell/web/selftest.mjs` proves the
  arithmetic underneath without a DOM (`scrollRoom`) and `tools/input_smoke.py`
  proves the wiring in a real browser: it opens a file through the real command
  line so that a card genuinely can scroll, then dispatches a wheel over that
  card's own textarea, over bare board, and with `Ctrl` held.

### A file that changes while nobody is looking

- The kernel announces a write **it** made (`file.changed`) and nothing else.  A
  file rewritten by `git checkout`, by a formatter or by another editor was
  silently re-overwritten the next time the card was saved, because the card had
  no way to learn that its revision was stale.  The kernel gains one method for
  it: `file.stat {path}` → `{path, exists, dir, size, mtime, revision}`, where
  `revision` is computed by the same function `file.read` uses, so the two can
  never drift.  It moves no text, so asking is cheap enough to do on a timer.
- A file that is not there is a **result, not an error** (`exists: false`,
  `size: 0`, `mtime: -1`, `revision: 0`), and `revision: 0` means *cannot
  compare* — a directory, a binary, a file over 4 MiB, or a card that has not
  read the file yet.  An empty file is `2166136261`, not `0`, so "empty" can
  never be mistaken for "unknown".  `docs/PROTOCOL.md` carries the table.
- `shell/web/watch.mjs` decides what an answer means and is pure — no DOM, no
  clock — so `shell/web/selftest.mjs` pins the whole table without a browser.  A
  clean card reloads; a card with unsaved edits **keeps its text** and is told
  the file changed; a deletion is reported instead of written back; a revision
  that cannot be compared warns and is never treated as "unchanged".  A decision
  is acted on only when it is news, so a card warns once rather than every 1.5 s.
  `main.mjs` polls; a path held by three cards is one `file.stat`.
- A trimmed kernel with no `file.stat` is not a failure: the shell recognises
  `-32601`, stops asking and logs one line, and the board keeps working as it did
  before the poll existed.
- `tools/input_smoke.py` proves it end to end, because a unit test cannot: it
  rewrites a file with a **real child process** (`cmd /c echo`) while an editor
  card holds it and reads the card's own status back — clean reload, dirty warn,
  deleted, and never a revision the card did not read.
- `tools/kernel_probe.py` gains the other half against the real kernel: 9 checks
  over text, empty, directory, binary, missing, escape, notification-free and
  agree-with-`file.read`.

### The editor card behaves like an editor

- The editor card gained the keys a person reaches for before trusting a text
  box: `Tab` and `Shift+Tab` indent and outdent the lines the selection touches
  (with no selection they insert or remove one unit at the caret, so `Tab` is
  still a tab), `Enter` keeps the current line's indentation and steps in one more
  after `{`, `(`, or `[`, and `Ctrl+F` opens an in-card find bar — query, a live
  `3 / 7` count, previous and next, a replacement box, Replace, Replace All, and
  `Esc` to close.  `Enter` splits by the line **up to the caret** rather than the
  whole line, so pressing it in the middle of a deeply indented line no longer
  leaves the tail indented.
- Matches are painted as well as selected.  The textarea's text is transparent
  and the colours live in the `<pre>` behind it, so a hit is drawn as a `<mark>`
  in that layer: the colours survive inside the hit and the hit stays visible
  while the caret sits in the find bar.  The token spans are **split** at the hit
  boundaries (`markHits`) instead of being replaced.
- Every edit the card makes on the user's behalf — the indent, the auto-indent,
  replacing one hit, replacing all of them — goes in through
  `document.execCommand("insertText")` over the selected range rather than by
  assigning to `value`.  Assigning to `value` throws away the browser's undo
  stack, so `Ctrl+Z` after a `Tab` or a Replace All would have cleared the whole
  file; the command is the one way to have both a programmatic edit and a real
  undo step.
- Nothing about it is taken on faith.  The arithmetic is pure and exported
  (`indentSelection`, `indentAfterEnter`, `findMatches`, `replaceMatchAt`,
  `replaceAllMatches`, `markHits`) and `shell/web/selftest.mjs` checks it with no
  DOM at all (86 → **96** checks), and `tools/input_smoke.py` presses those keys
  in a real window — including the check only a browser can make, that a `Ctrl+Z`
  after the card's own `Tab` still restores the buffer because the edit really did
  go through the insert command (13 → **19** checks).  Each new check was
  sabotaged one at a time — `markHits` dropping the hit, `indentSelection` doing
  nothing, `findMatches` stopping after the first hit, the editor assigning to
  `value` instead of using the command — and each turns its suite red, after which
  the file was restored byte-identically.
- The card's limits are unchanged and now written where its keys are
  (`shell/web/README.md`): one undo step per programmatic edit, no per-key
  bindings, no code folding, and the find bar is literal text only — no regular
  expressions, no match-case and no whole-word toggles.

### One version, checked

- The version has exactly one definition: the `VERSION` file at the root, edited
  only through `tools/version.py` (`show`, `check`, `set`, `bump`), which writes
  `core/include/infantgod_cfg.h` and keeps `shell/main.mjs`'s banner and
  `package.json` in step.  `make version-check` (part of `make test`) fails if any
  copy drifts.  `package.json` is in that list because electron-builder stamps
  *that* number into the installer: if it drifts, the shipped product's file name
  and About box disagree with its own `hello`.
- `core/src/main.c` no longer carries a second `#define SDE_VERSION`.  It could
  disagree with the header's copy in the same binary — `infantgod version` read
  one, `hello` read the other — and a header-only version bump rebuilt nothing at
  all, because the Makefile's object rules named only the `.c` files.  Both are
  fixed: every object now depends on every header and on `VERSION`.  Recorded as
  entry **G** in [`docs/BUGS.md`](docs/BUGS.md).

### Tools

- `tools/seide_cli.py`, `tools/kernel_probe.py`, `tools/e2e.py` and
  `tools/demo.py` speak `view.load` / `view.save`; the CLI's `new-id` verb is gone
  with `board.newId` (the client allocates ids) and its `board` command prints
  whatever `view.load` hands back, with a note — not an error — when the document
  is not the board shape.  `tools/browser_smoke.py` and `tools/input_smoke.py`
  need no change at all: `.infantgod/board.json` was always just a file to them, and
  that is now the truth of it.  The probe stops pinning refusals the kernel no
  longer makes and pins the opacity contract instead: a document the board schema
  would reject is stored and handed back unchanged, a stale `base_revision` is
  `1001` with `data.current_revision`, and a save with no `document` (or `null`)
  is `-32602`.  The CLI selfcheck reads `SDE_PROTOCOL_VERSION` out of
  `core/include/infantgod_cfg.h` rather than hard-coding a protocol number.
- `tools/e2e.py` removes the empty `.infantgod/` directory left behind when the
  suite created the board and put it back: a test run should not leave a state
  directory nobody asked for.  `make test` in a fresh clone now ends with the
  tree exactly as it started.
- `tools/input_smoke.py` imports the host, the browser lookup and the board
  backup from `tools/browser_smoke.py` instead of carrying a second copy: one
  place to fix when `serve`'s banner or the board path changes.  The board
  backup's "the clone had no board" branch is no longer guarded on the test
  having installed the starter board, because the host autosaves one anyway.

### Docs

- New `docs/VIEWS.md`: what the kernel defines (that a view exists — a place, a
  value, a revision, an atomic write, a notification) against what a client
  defines (what one is — the schema, the meaning, the path, the ids), the three
  failures that follow from confusing the two, and what it costs.  `docs/BUGS.md`
  entries A and E are kept as history with that context added.
- `docs/PROTOCOL.md` documents the two new methods, the eleven-method table, the
  retired `1004`, and `workspace.info`'s `view_path` / `view_revision`;
  `docs/ARCHITECTURE.md`, `docs/PARADIGM.md`, `docs/TRIM.md`, `docs/SURFACES.md`,
  `docs/FORK.md`, `docs/PROJECT.md`, `README.md`, `tools/README.md` and
  `shell/web/README.md` now say that the board is the shell's convention and where
  the schema lives.  The counts in README.md, tools/README.md and
  docs/ARCHITECTURE.md follow the suites.
- The classic view is documented where it can be argued with: constraint 1 in
  `README.md` now says the board is still the only document and the new paragraph
  describes the projection, `shell/web/README.md` gained `### The same cards as a
  code area: mode classic` (the role table, the tile's arithmetic, and what the
  mode deliberately does not do — write, raise, take a shortcut or move the
  wheel), `docs/PARADIGM.md` answers "No tabs" honestly (a strip drawn from the
  cards is not the tab strip the paradigm rejects), `docs/PROJECT.md` keeps the
  project card *a card* even when the view draws it in a column, `docs/FORK.md`
  gives the mechanical cut, and `docs/TRIM.md` notes that cutting the board
  document takes the view with it.  The upstream commit also documented a
  multi-select, a workspace `find` and a `frame` card kind; those features are not
  in this fork, so no document gained them.

### Checks

- `make test` (e2e 12, kernel probe, cli-check, version-check, JSON, langs 91/91,
  selftest 118/118, mods 84/84) and `make smoke` (browser smoke 5, input smoke 25)
  are green.  Every
  new promise was sabotaged to prove its check can fail (throwaway
  `build/sabotage_view.py`): the kernel repairing a document, a stale save
  accepted, a first-run answer that is `{}` instead of `null`, the client writing
  a card its own model cannot read, and the client booting from a path of its own
  invention.  All five were caught, and the three sources were restored
  byte-identical.  The editor's gutter was put to the same bar: a gutter that
  paints nothing and a gutter whose click does not toggle were both caught by
  `tools/input_smoke.py`, and `shell/web/cards.mjs` was restored byte-identical.
  That file was also reading the current view out of `#mode-toggle`, the single
  button the classic view introduced and the view switch replaced: the stale
  lookup threw inside the classic block and took four checks down with it, which
  is why it now finds the button marked `is-current` instead.

### Licence

- The code stays **MIT** ([LICENSE](LICENSE)) and the prose documentation
  becomes **CC BY 4.0** ([LICENSE-DOCS](LICENSE-DOCS)): every Markdown file in
  the repository is documentation, everything else is code.  The fork is a
  derivative of MIT code, so this is the licence it was always allowed to carry.

### Tools and CI a clone can run

- `.github/workflows/ci.yml` runs `make CC=gcc test` on a Windows runner, and a
  `smoke` job that renders the board headless.  Neither job has run on a GitHub
  runner yet; the file says so in its own header.
- `tools/kernel_probe.py` and its stdio harness `tools/kernel_drive.py` re-check
  every bug in [`docs/BUGS.md`](docs/BUGS.md) against a scratch workspace under
  `build/`, so the ledger is runnable instead of being a claim: `make probe`.
- `tools/browser_smoke.py` renders the board in the system browser, asserts on
  the dumped DOM and restores the board byte for byte: `make smoke`.  It needs a
  browser and reports a skip, not a failure, when there is none.
- `tools/demo.py` installs `examples/board.json` — the five-card board in the
  screenshots — as `.infantgod/board.json`, because `.infantgod/` is gitignored
  and a fresh clone otherwise opens an empty canvas.
- `.gitattributes` pins `* text=auto eol=lf`.  Git for Windows ships
  `core.autocrlf=true`, which turned a checkout into CRLF and failed a suite
  that compares fixtures byte for byte.

### Documentation that had gone stale

Three places still described the prototype, and a reader comparing them with the
code would have concluded the code was wrong:

- `README.md` said there is "no undo", which stopped being true this release.
  It now says what undo does and where it stops.
- `shell/web/README.md` and `docs/PARADIGM.md` still claimed that
  `lang.tokenize` returns **UTF-8 byte offsets** treated as string indices, and
  said so as a known limitation.  It returns **string indices** (UTF-16 code
  units), which is what makes Yarn colouring land on Chinese prose; the "byte
  offsets" wording was simply wrong, and the four files that already said so
  (`README.md`, `docs/PROTOCOL.md`, `docs/FORK.md`, `langs/README.md`) were being
  contradicted by the two that did not.  The "residue" this first described — an
  astral character counting as two units in JS and one in Python's `len()`, so
  that `tools/e2e.py`'s tiling check could see an offset past the end — did not
  exist: `tools/e2e.py` measures its fixtures with `js_length` and judges every
  span in that same space, so the check is honest to the last unit.  The stale
  claim was withdrawn from `README.md`, `shell/web/README.md`, `docs/PARADIGM.md`,
  `docs/FORK.md` and `langs/README.md`, and `langs/selftest.mjs` now pins the gap
  over a shipped CJK fixture — eleven checks, both numbers measured.

## v0.1.0-alpha — 2026-10-15

First alpha.  Everything below was built after this date's earlier work on the
prototype, and the whole tree passes `make test`.

### Licence

- The code is MIT ([LICENSE](LICENSE)) and the documentation is now
  **CC BY 4.0** ([LICENSE-DOCS](LICENSE-DOCS), with the scope list, the
  attribution notice to keep, and the official legal code).  Every Markdown file
  in the repository is documentation; everything else is code.

### Board, still the project state

**The board is still the project state.** Cards on an infinite plane, links
between them, no tabs and no file tree.  A fresh clone opens an **empty canvas**
(the layout lives in `.infantgod/`, which is git-ignored) — `python tools/demo.py`
installs the five-card starter board from `examples/board.json` if you want the
screen in the README.

### Kernel (`core/`, C89, no dependencies)

- Newline-delimited JSON-RPC over stdio; `hello`, `workspace.info`,
  `workspace.list`, `file.read`, `file.write`, `file.stat`, `board.load`,
  `board.save`, `board.newId`, `exec.start`, `exec.stop`, `exec.list`.  (That
  list is the 0.1 state: `## Unreleased` above replaced the three `board.*`
  methods with `view.load` / `view.save` and moved the schema into the shell.)
- Modules are trimmable per line in the Makefile's `SRC` list; `infantgod
  modules` prints what each one costs.
- The kernel knows no languages: `langs/` is served entirely by the shell.

### Languages (`langs/`, the shell's layer)

- A descriptor grammar (`.lang`): adding a language is one text file — no code.
  (Upstream's grammar has two families, `flat` and `sgml`; this fork has no SGML
  and ships the two descriptors below, one per language.)
- `langs/yarn.lang` is the flat descriptor this fork ships: Yarn Spinner
  headers, builtins, `<<commands>>` and `#tags`.  `langs/json.lang` covers the
  game's ScriptableObject definition files.
- `lang.tokenize` returns spans that tile the file with no gaps or overlaps, in
  the same wire form for either language (`node langs/selftest.mjs`, 82 checks).

### Shell (`shell/`)

- `infantgod rpc` (stdio) and `infantgod serve` (HTTP + SSE + the system browser
  in `--app=` mode).  No bundled Chromium, no npm dependencies.
- Nine card kinds: `editor`, `runner`, `note`, `files`, `sheet` and `project`,
  plus `mod`, `problems` and `docs` for the mod layer.
- The `project` card answers "what is in this project, and what do I have open
  in it": the workspace listing folded by folder, merged with the open editors,
  with one panel per board and a filter.
- Autosave with optimistic locking on every write; a stale write is refused,
  never silently merged.
- The 幼神 layer in `shell/mods/` (game knowledge, no DOM) serves `mod.*`:
  package validation, Yarn diagnosis, scaffolding, search, localisation.

### Tools (`tools/`, Python 3.12 standard library only)

- `demo.py` installs the starter board; `build.py` drives the Makefile;
  `e2e.py` drives the protocol end to end; `newlang.py` writes a conforming
  descriptor; `kernel_probe.py` re-checks every fixed bug; `browser_smoke.py`
  renders the window headless and asserts on the DOM.

### Bugs found and fixed before this release

Four adversarial probing rounds found 33 defects; 31 are fixed and each one is
recorded in [`docs/BUGS.md`](docs/BUGS.md) with its symptom and root cause.  The
worst were silent data loss in the board save, `file.write` ignoring a
wrong-typed `base_revision`, and validation that was quadratic in the number of
cards (20 000 cards: 72.59 s → 0.81 s).

Two more were found by cloning the repository and running the suite in the
clone, which is the only way to see what a new reader sees:

- **A clone on Windows got CRLF line endings.**  Git for Windows ships
  `core.autocrlf=true`, so the shipped fixture arrived with different bytes and
  the byte-exact fixture check failed on a checkout nobody had edited.
  `.gitattributes` now pins `* text=auto eol=lf`, and `kernel_probe.py` compares
  the fixture against what it read at the start of the run instead of a size
  written into the source.
- **`make smoke` failed on a fresh clone**, because there was no
  `.infantgod/board.json` to paint (it is gitignored).  It now installs
  `examples/board.json` for the run and removes it again.

### Verification

`make check` (9 passed, 0 failed, 3 skipped), `make fullcheck` (12/0/0),
`make probe` (37 checks, all ok), the C JSON test, `langs/selftest.mjs` (82/82),
`shell/web/selftest.mjs` (74/74) and `shell/mods/selftest.mjs` (84/84).  Two
defects are recorded as **not** fixed in `docs/BUGS.md`; `browser_smoke.py`
still drives no pointer, and says so in its own output.

### Known limits

- Windows only: `core/port/` has one implementation (`sys_win32.c`,
  `proc_win32.c`).  The port layer is the only OS-aware code.
- No undo of the typing inside a card.
- The card-kind hook is fork-time only: there is no plugin loading.
- CI (`.github/workflows/ci.yml`) is written but has never run on a GitHub
  runner — it was authored on a machine without one.  Its steps are exactly the
  local commands above.
