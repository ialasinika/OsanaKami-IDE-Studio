# InfantGod Studio · 幼神工坊

InfantGod Studio is a **mod IDE for 《幼神》 (Infant God)** — a board-shaped
editor for the game's Yarn scripts, ScriptableObject definitions, sprites and
localisation tables.

It is a fork. The upstream project is a small, finished, honest IDE *prototype*
whose stated purpose is to be reshaped into a real product for a real audience;
this repository is one such reshaping. `docs/FORK.md` records exactly what was
renamed, what was kept byte-identical, and what was added.

What it is *not*: a complete product. There is no settings UI, no debugger, no
Git integration, and no undo of the typing inside a card (Ctrl+Z takes back
board edits; a textarea keeps its own undo). Every deliberate tradeoff is
written down instead of discovered.

![The InfantGod Studio board: an editor card with Yarn colouring, a mod card listing a package's defines, a problems card, a docs card and labelled links between them](docs/board.png)

---

## What this fork adds

Three card kinds and one knowledge layer, none of which touches the kernel:

- **`mod`** — opens a mod package: `mod.json`, its defines grouped by type, its
  Yarn files, its sprites. Click a row to edit that file.
- **`problems`** — validation output for a package, worst first, each row
  jumping to the file and JSON pointer it came from.
- **`docs`** — the game's own knowledge base: 136 commands, 63 functions, 678
  variables, 1221 nodes, 51 definition schemas, 1305 baseline defines.
- **`.yarn` colouring** — a language descriptor in `langs/`, alongside JSON.
- **`shell/mods/`** — the game intelligence: schema validation, Yarn diagnosis,
  package scaffolding, search and completion. Pure Node, zero npm.

See [docs/MODS.md](docs/MODS.md) for the verb table, the three card kinds and
the containment rules.

## What InfantGod Studio is

- A **board**: an infinite, pannable, zoomable 2-D canvas of cards. No tabs, no
  file tree. Where you put things is part of the project state.
- **Three layers**, each in a different language, each trimmable:
  - `core/` — the kernel. **C89 only**, zero third-party dependencies.
  - `shell/` — the front end, the HTTP/stdio endpoints, and the game layer.
    **JavaScript ESM**, zero npm dependencies.
  - `tools/` — build driver, protocol driver, a language-descriptor generator.
    **Python 3.12 standard library only**.
- A **window** made of the system's Edge/Chromium launched in
  `--app=http://127.0.0.1:PORT` app mode.
- **Languages** that are actually supported: Yarn Spinner and JSON colouring,
  driven by descriptor files in `langs/`.
- A **frozen JSON-RPC protocol** on stdio, newline-delimited, with a documented
  method list and error-code table.
- **Edits that do not clobber.** An editor card remembers the revision it read
  and sends it back on every write, so a race is refused rather than won. A file
  rewritten by another program — `git checkout`, a formatter, another editor —
  announces nothing, so the shell polls for it and a card either reloads (if you
  have no unsaved edits) or keeps your text and tells you the file moved.

## What InfantGod Studio is not

- **Not a complete product.** There is no settings UI, no terminal emulator, no
  debugger, no Git integration, no refactoring, and no undo of text inside a card.
- **Not extensible.** There is no plugin system, by design. Extension means
  forking this repository and editing the source.
- **Not a native window.** The app mode of a browser is not a real application
  window; see the WRY/Tauri note below.
- **Not a Yarn compiler.** Yarn support is colouring, package validation,
  diagnosis and completion. It does not run or type-check a story.
- **Not a binary editor.** The kernel reads and writes UTF-8 text, so `.png`,
  `.bytes` and archives are listed and copied by hand, not edited in place.
- **Not portable yet.** The kernel's platform layer is Win32.

---

## The eight constraints

These are hard constraints, not aspirations. They are what make the code base
forkable, and they are what a fork will change first.

### 1. The paradigm is the board, not tabs and a tree

The main surface is one persistent 2-D canvas. Everything you work on is a
**card** placed at a point on that canvas. A card has a `kind` (`editor`,
`runner`, `note`, `files`, `project`), a position and size (`x`, `y`, `w`, `h`,
`z`), may
reference a file, and may be connected by links. The board persists to
`<root>/.infantgod/board.json`, so **where you put things is part of the project
state**. A non-modal command line at the bottom acts on the focused card.
See `docs/PARADIGM.md`.

### 2. No Electron in the core

Nothing below the window knows what a window is: the protocol, the language
layer, the mod layer and the board are all indifferent to how they are hosted.
The default host stays the system's Edge/Chromium launched in
`--app=http://127.0.0.1:PORT` app mode with a throwaway profile — no bundled
Chromium, nothing to download, and `node shell/main.mjs serve` works on a machine
that has never run `npm install`.

This fork adds an *optional* desktop shell on top: `electron/`, reached with
`npm start`. Handing an installer to mod authors needs a real window, a real
taskbar entry and no dependency on which browser happens to be installed. It is
one file with no preload script and no IPC, and it changes nothing under
`shell/`, `langs/` or `core/`; see `electron/README.md`. `node_modules/` stays a
build-time dependency of the shell, never a runtime dependency of the product.

**For a smaller binary the replacement path is WRY/Tauri**, described in
`docs/FORK.md`; it would also be what makes the kernel portable, which is the
larger piece of work. Electron is what this fork actually ships.

### 3. No plugin system, by design

Extension = fork and edit source. There is no plugin loading, no manifest, no
discovery and no sandbox.

What there *is* is one hook for new card kinds, because "a card is a file with a
cursor" is the assumption most likely to make a fork expensive. The kernel
stores any `kind` verbatim and validates only a card's shape; the shell
registers a kind with a single call:

```js
registerCardKind({ kind: "waveform", render: (card, ctx) => { /* … */ } });
```

The six shipped kinds are `editor`, `runner`, `note`, `files`, `project` and
`sheet` — `sheet` being a structured-data grid (typed cells, rows, columns, TSV
export) that exists to prove nothing downstream assumes text, and `project`
being the workspace as one project: what the project contains, merged with what
the board has open. See [`docs/SURFACES.md`](docs/SURFACES.md) and
[`docs/PROJECT.md`](docs/PROJECT.md).

### 4. The build is fully offline

No package manager, no network, no third-party dependencies, no configure step.
The Makefile needs a C89 compiler and GNU make, and either finds them or does
not. `core/` includes only C89 standard headers and `<windows.h>` behind the
platform layer.

### 5. Low coupling, trivially trimmable

Each module under `core/src/` is a whole subsystem with a stated cost of
removal. `infantgod modules` prints the trim manifest. See `docs/TRIM.md`.

### 6. `core/` is C89 ONLY

Enforced by the compiler, not by convention:

```make
CFLAGS = -std=c89 -pedantic -Wall -Wextra -Werror -O2 -Icore/include
```

C++ comments, mid-block declarations, `long long` and variadic macros are all
rejected by `-std=c89 -pedantic -Werror`.

### 7. The project is polyglot on purpose

| layer | language | dependencies |
| --- | --- | --- |
| `core/` | C89 | none beyond libc and the OS |
| `langs/`, `shell/` | JavaScript ESM | zero npm dependencies |
| `electron/` | JavaScript (CommonJS) | Electron + electron-builder, dev only |
| `tools/` | Python 3.12 | standard library only |

### 8. Language intelligence is keyword colouring, and it lives in `langs/`

The kernel knows about files, boards and processes — not about programming
languages. Language support lives in `langs/`, is served by the shell, and is
**deletable**: `rm -rf langs/` leaves a kernel that still builds and a shell that
still runs, rendering plain text. Yarn Spinner is the one language that must be
supported — it is the format 《幼神》 itself is written in, and the descriptor in
`langs/yarn.lang` is the worked example the grammar is exercised against. See
`docs/ARCHITECTURE.md` and `docs/PROTOCOL.md`.

---

## Quick start

Everything below is exactly what was run to verify this document. The versions
it was verified against:

```text
Python 3.12.9
Node   v24.16.0
GNU Make 4.4.1        (C:\mingw64\mingw64\bin\mingw32-make.exe)
gcc.exe 14.2.0        (MinGW-W64 x86_64-msvcrt-posix-seh, built by Brecht Sanders, r3)
```

Build the kernel (produces `build/infantgod.exe`):

```sh
C:/mingw64/mingw64/bin/mingw32-make.exe -f Makefile
```

`tools/build.py` is a thin driver over the same Makefile, and it is what proves
the toolchain is present:

```sh
python tools/build.py --check     # print resolved make + gcc and exit
python tools/build.py             # build (pass --release / --clean / targets)
```

Run the checks:

```sh
C:/mingw64/mingw64/bin/mingw32-make.exe -f Makefile check       # kernel alone: 9 passed, 0 failed, 3 skipped
C:/mingw64/mingw64/bin/mingw32-make.exe -f Makefile fullcheck   # whole endpoint: 12 passed, 0 failed, 0 skipped
C:/mingw64/mingw64/bin/mingw32-make.exe -f Makefile probe       # every bug in docs/BUGS.md: all ok
C:/mingw64/mingw64/bin/mingw32-make.exe -f Makefile smoke       # the window, headless: 5 + 19 checks, 0 failed
C:/mingw64/mingw64/bin/mingw32-make.exe -f Makefile version-check  # every copy agrees, and the changelog has a home for it
C:/mingw64/mingw64/bin/mingw32-make.exe -f Makefile test        # check, fullcheck, probe, version-check, the JSON test, all three JS self-tests
```

On a machine with no Chromium-family browser, `make smoke` prints a skip, not a
failure: "no browser" is not a defect in the board, and exit `0` means either
outcome.

The individual pieces, if you want to run them directly:

```sh
python tools/e2e.py --kernel build/infantgod.exe     # 9 passed, 0 failed, 3 skipped
python tools/e2e.py --kernel build/infantgod.exe --keep-going
python tools/kernel_probe.py                         # the fixed bugs: summary: all ok
python tools/browser_smoke.py                        # renders the real window; SKIP (exit 0) with no browser
python tools/input_smoke.py                          # real clicks, keys, wheels and editor keys; 19 checks
python tools/demo.py                                 # install the starter board: five cards, three links
build/obj/test_json.exe                        # the C JSON codec: "all good"
node langs/selftest.mjs                        # 92/92 checks passed
node shell/web/selftest.mjs                    # ok 96/96 (pure JS: no DOM)
node shell/mods/selftest.mjs                   # 84/84 checks passed
```

The mod suite reads the game's extracted `Mods` folder for its corpus checks and
skips them (rather than failing) when it is not there; point it at your own copy
with `node shell/mods/selftest.mjs --mods <dir>`.

`make test` runs `check`, then `fullcheck`, then `probe`, then the JSON test and
the three JavaScript self-tests **in that order**, so a `fullcheck` failure would
stop the run before the self-tests are reached. `smoke` is separate because it
needs a browser; on a clone that has no board yet it installs
`examples/board.json` for the run and removes it again afterwards. As of this
writing nothing fails.

**The protocol suite used to write to your board, and no longer does.** The board
checks drive `board.save` against the workspace they were given, but they
snapshot the whole document that was already there and restore it before the
check returns — including when the check fails. A run against `.` leaves
`./.infantgod/board.json` semantically identical; with the shipped starter board
it comes back byte-identical too (3211 bytes, byte-for-byte, because the kernel
writes every board and re-serialises the same way). If there was no board before
a run, there is none after it either — and no empty `.infantgod/` directory left
behind where the board used to be.

**The board shipped for a fresh clone is verified, not assumed.** The `starter
board` check saves `examples/board.json` through the real validator and requires
cards, links and viewport to come back exactly, so a hand-edit the kernel would
reject fails here rather than on a new user's first launch.

**Current state of the protocol suite:** both modes are green. Kernel mode
(`check`) reports 9 passed, 0 failed, 3 skipped — the skips are the three
language checks, which the kernel does not serve. Full mode (`fullcheck`, the
endpoint that adds `langs/`) reports 12 passed, 0 failed, 0 skipped. See
[Known rough edges](#known-rough-edges) for what is still genuinely unfinished.

Note `make test` uses `fullcheck`, which needs `node shell/main.mjs`; there is no
make target that runs only the JavaScript self-tests.

Start the app (builds the window from the system browser):

```sh
python tools/demo.py                                 # install the starter board first
node shell/main.mjs serve --workspace .
node shell/main.mjs serve --workspace . --no-open    # just serve, print the URL
node shell/main.mjs rpc --workspace .                # stdio endpoint, no browser
```

`.infantgod/` is gitignored, so a fresh clone opens an **empty canvas** — the
layout is per-checkout project state, deliberately not committed. `tools/demo.py`
copies `examples/board.json`, the five-card board in every screenshot here, into
`.infantgod/board.json`. It refuses to overwrite a board you already have unless
you pass `--force`, and `--print` shows it without touching anything. Opening an
empty board is fine too: the canvas tells you the commands, and `project` on the
command line gives you the workspace.

Point it at the game's mods so the 幼神 cards have something to open:

```sh
node shell/main.mjs serve --workspace . \
  --mods-root "…/Infant God/StreamingAssets/Mods"
```

Then, on the board's command line: `mod MyMod`, `problems MyMod`, `docs Love`.
`--mods-root` narrows what `mod.*` may touch; it defaults to `--workspace` and
can never widen it.

The kernel is usable with no UI at all:

```sh
build/infantgod.exe help
build/infantgod.exe version
build/infantgod.exe modules
build/infantgod.exe board show --root .
build/infantgod.exe rpc --root . --verbose
```

---

## Repository map

```
Makefile                the whole build: CC, CFLAGS, SRC, all, check, fullcheck,
                        probe, smoke, test, modules, run, clean, and the JSON
                        test target
README.md               this file
LICENSE                 MIT -- the code.  Except the docs: see below
LICENSE-DOCS            CC BY 4.0 -- every Markdown file in the repository
CHANGELOG.md            what is in this version, and what is not
.github/workflows/      CI: the same make targets, on a Windows runner
.gitignore              build artefacts and workspace-local state
.gitattributes          the checkout is the repository's bytes: LF everywhere

core/                   the kernel -- C89, no dependencies
  include/              public headers: buf, vec, json, port, wksp, board, exec,
                        serve, rpc, app, module, infantgod_cfg
  src/                  one file per module: buf, vec, json, wksp, board, exec,
                        rpc, serve, app, main
  port/                 the only OS-aware code: sys_win32.c, proc_win32.c
  tests/                test_json.c (JSON round-trip harness for the kernel)

langs/                  language support, deliberately OUTSIDE the kernel
  yarn.lang             Yarn Spinner: headers, builtins, <<commands>>, #tags
  json.lang             JSON, including the ScriptableObject definition files
  lang.mjs              descriptor parsing, validation, registry
  tokenize.mjs          the tokenizer and its tiling guarantee
  selftest.mjs          node langs/selftest.mjs -- no kernel needed
  README.md             the descriptor grammar and wire shapes

shell/                  the front end and the endpoints
  main.mjs              `infantgod rpc` (stdio) and `infantgod serve` (HTTP + SSE +
                        browser); also the `mod.*` verb table
  mods/                 the 幼神 layer -- game knowledge, no DOM
    index.js            the facade: openMod, validatePackage, diagnoseYarn,
                        scaffold, search, docFor, suggest, localization
    knowledge.json      136 commands, 63 functions, 678 variables, 1221 nodes,
                        51 schemas, 1305 baseline defines, 11 locales
    yarn.js             Yarn lexing, tag extraction, arity and jump checks
    validate.js         JSON-Schema + baseline validation of a mod package
    scaffold.js         template-driven package generation (writes real PNGs)
    search.js           the index behind search/docFor/suggest (no `require`)
    selftest.mjs        node shell/mods/selftest.mjs -- 81 checks, no kernel
  web/                  the board UI: index.html, style.css, board.mjs, cards.mjs,
                        rpc.mjs, main.mjs, selftest.mjs, README.md

tools/                  Python 3.12, standard library only
  build.py              drives the Makefile; --check / --release / --clean
  e2e.py                drives the protocol end to end over stdio
  kernel_probe.py       re-checks every bug in docs/BUGS.md, on a scratch workspace
  kernel_drive.py       the stdio JSON-RPC harness kernel_probe.py runs on
  browser_smoke.py      renders the board in a real browser and asserts the DOM
  demo.py               installs examples/board.json as this workspace's board
  newlang.py            writes a conforming .lang descriptor
  README.md             what each tool is for

examples/               hello.yarn, sample.json (the shipped fixtures), and
                        board.json -- the starter board `tools/demo.py` installs
docs/                   PARADIGM.md, ARCHITECTURE.md, PROTOCOL.md, SURFACES.md,
                        MODS.md, PROJECT.md, TRIM.md, FORK.md, BUGS.md
```

Build artefacts (`build/`, and the workspace-local `.infantgod/`) are ignored by
Git. `examples/` is **not** ignored: the `.yarn` and `.json` fixtures are part of
the project. `.gitattributes` pins `* text=auto eol=lf`, so the bytes in the
repository are the bytes a clone gets — the fixtures are compared byte for byte,
and a CRLF checkout would fail the suite on a file nobody edited.

---

## Known rough edges

Stated plainly, because a fork needs to know what it is inheriting.

- **`file.read` means different things at the two endpoints.** The shell adds a
  `lang` member (the detected language id, or `null`); the kernel does not,
  because it has no language layer. `docs/PROTOCOL.md` marks which members come
  from which layer.
- **The kernel still caps a single read at 4 MiB.** The game's localisation CSVs
  are around 4.5 MB, so they will not open through `file.read`. The 幼神 cards
  read and validate them in Node instead, which is why `problems` works on a
  package the editor cannot open.
- **The kernel has no delete or rename.** Copying a mod package into
  `StreamingAssets/Mods/<Name>/` is therefore a manual step; `mod.scaffold`
  creates directories through `file.write`'s parent-directory creation.
- **The kernel refuses any file containing a NUL byte**, so `.png` and `.bytes`
  assets can be listed and diagnosed but not read or written by the board.
- **Language colouring offsets are JS string indices, not bytes.** For Yarn this
  is what makes Chinese prose highlight correctly; the upstream README's
  "byte offsets" claim was wrong, and `langs/selftest.mjs` pins the gap over a
  shipped CJK fixture by measuring both, so a regression cannot pass unnoticed.
  The Python side is not a residue: `tools/e2e.py` measures its own fixtures in
  the same space (`js_length`) and judges every span in that same space, so its
  tiling check stays honest even for an astral character.  What would drift is
  any *new* check that compared a wire span to Python's `len(text)`, which
  counts code points.
- **Links are straight lines.** No router, no obstacle avoidance, no automatic
  layout. Undo has the same limit: it takes back board edits, and does not
  reverse a pan, a zoom, or a "raise to front".
- **The shell is the only client.** There is no second front end, so the protocol
  has exactly one consumer to keep honest.
- **A file changed outside the app is noticed late, by up to ~1.5 s.** The shell
  polls `file.stat` for the paths its cards hold; the kernel does not watch the
  filesystem and the protocol does not promise an event. A card that held a file
  somebody else rewrote is corrected on the next tick, not at the instant it
  happens — and a card whose file is too large or binary cannot be compared at
  all (`revision: 0`), so it warns instead of reloading.

---

## Fork it in 10 minutes

Start with `docs/FORK.md` — it is the playbook, ordered by cost. The short
version:

1. Rename the product (`README.md`, `shell/main.mjs`'s `SHELL_VERSION` and
   usage text, `core/include/infantgod_cfg.h`, `core/src/main.c`).
2. Delete what you do not want: `infantgod modules` prints the cost of each module,
   and `docs/TRIM.md` lists the four edits per removal.
3. Change the window: replace `shell/main.mjs`'s browser launcher with WRY/Tauri
   (`docs/FORK.md`).
4. Add your card kind, or your language — `docs/FORK.md` has both recipes.

The protocol is frozen (`docs/PROTOCOL.md`). Keep the JSON-RPC shape and you can
replace every layer under it in any order.

The docs, in reading order: [`docs/PARADIGM.md`](docs/PARADIGM.md) — why the
board and not tabs; [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md) — what each
layer is; [`docs/PROTOCOL.md`](docs/PROTOCOL.md) — the frozen wire;
[`docs/SURFACES.md`](docs/SURFACES.md) — non-text cards and the card-kind hook;
[`docs/PROJECT.md`](docs/PROJECT.md) — the workspace as one project;
[`docs/TRIM.md`](docs/TRIM.md) — how to cut a module out;
[`docs/FORK.md`](docs/FORK.md) — the fork playbook;
[`docs/BUGS.md`](docs/BUGS.md) — every defect probing found, with its root cause
and fix, so a fork knows what was already tried.

> Rejected alternative: **a Rust kernel**. It was dropped because a dependency's
> build script needed a C compiler, which broke constraint 4 (fully offline,
> no configure step). C89 has no build script and no dependency graph.

---

## Version, licence, CI

The version is one line — `#define SDE_VERSION` in
[`core/include/infantgod_cfg.h`](core/include/infantgod_cfg.h) — mirrored by
`SHELL_VERSION` in `shell/main.mjs`, because C89 and JavaScript cannot read a
file at build time. `build/infantgod.exe version` prints it, and it is the same
number in both; no build step generates it.

The code is [MIT](LICENSE) — take it, fork it, rename it. The documentation
(the Markdown files, this one included) is [CC BY 4.0](LICENSE-DOCS): quote it,
translate it, rewrite it for your fork, keep the attribution. Two licences, two
scopes, both spelled out in [LICENSE-DOCS](LICENSE-DOCS). InfantGod Studio is a
derivative of the MIT-licensed seIDE, and a rename does not change what a
licence allows: the kernel, the shell, the tools and the fixtures are MIT, and
only the prose is CC BY 4.0.

CI is [`.github/workflows/ci.yml`](.github/workflows/ci.yml): the `test` job runs
the same `make CC=gcc test` a maintainer runs, and the `smoke` job renders the
board headless. Neither job has run on a GitHub runner — the file was authored on
a machine with none — so treat them as unproven until the first green run; the
commands inside them are exactly the ones in **Quick start** above.
