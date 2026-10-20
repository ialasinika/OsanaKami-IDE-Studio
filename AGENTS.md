# AGENTS.md

Working notes for AI coding agents in this repository. Human-facing docs live in
[`README.md`](README.md) and [`docs/`](docs/); this file is the short version of
what an agent must know before touching the tree.

If you only remember one thing: **run the narrow check first, then
`make test`, and never hand-edit a number that a suite prints.**

---

## 0. Orientation

- The product is **OsanaKami IDE Studio**, a mod IDE for 《幼神》 (Infant God).
  It is a fork of the seIDE prototype; [`docs/FORK.md`](docs/FORK.md) records
  exactly what was renamed, kept, and added.
- **Three layers, three languages, no shared dependency:**
  - `core/` — the kernel. **C89 only**, zero third-party dependencies.
  - `shell/` — the front end: HTTP/stdio endpoints, browser UI, game layer,
    AI layer. **JavaScript ESM, zero npm runtime dependencies.**
  - `tools/` — build/protocol drivers and generators. **Python 3.12 standard
    library only.**
  - `electron/` is the optional desktop wrapper and the *only* place that uses
    npm (devDependencies only).
- The app is **one card document** (`.infantgod/board.json`) drawn by **two
  tiled views**: `classic` and `mod`. There is no canvas mode any more —
  `mode board` is not a view. Card geometry (`x`/`y`/`w`/`h`, `viewport`) stays
  in the document schema for compatibility, but no shipped view reads it.
- The kernel speaks a frozen newline-delimited JSON-RPC protocol on stdio
  (`infantgod/2`); the shell serves it over HTTP and drives the browser UI.
- Internal names are deliberately retained from the fork's history:
  `.infantgod/`, `build/infantgod.exe`, `infantgod/2`, `INFANTGOD_*` include
  guards, `sde_*` C types and `sde_methods[]`. Do not rename them piecemeal —
  a rename is a documented, mechanical change ([`docs/FORK.md`](docs/FORK.md)).

## 1. Non-negotiables

1. **`core/` is C89.** Built with `-std=c89 -pedantic -Wall -Wextra -Werror`.
   No `//` comments, no declarations after statements, no VLAs, no third-party
   headers. If it compiles on gcc 14 with those flags it is fine, otherwise not.
2. **The build is offline.** No package manager, no network, no code generation
   that downloads. Adding a dependency means changing the product's contract:
   don't, unless the task explicitly says to.
3. **The protocol is a contract.** `docs/PROTOCOL.md` is normative and there are
   two consumers: the shell and `tools/seide_cli.py`. A wire change must update
   the doc, both clients, and pass `make cli-check`.
4. **One document, two views.** Do not reintroduce a pannable/zoomable canvas,
   viewport writes, or a third view. Views are projections: they create, move
   and save nothing.
5. **No hard-coded machine paths.** `tools/path_guard.py --strict` -- what
   `make path-check` runs -- fails the build on any absolute path that is not a
   documented placeholder or an allow-listed Windows-shaped test fixture; the
   allow-list in that tool records every exception with a reason. Machine facts
   (`MINGW_BIN`, `ProgramFiles`, the game directory) come from the environment,
   never from a file in this tree.
6. **Docs are English**, and they argue rather than list. Do not replace a
   reasoned paragraph with bullets.
7. **Numbers are measured, not invented.** Check counts change as checks are
   added. Never copy a count from an old doc: run the suite, then grep for every
   place that quotes it and update them together.
8. **The kernel is trimmable by construction.** A fork trims a module by deleting
   its line from `SRC` in the `Makefile`, deleting the file under `core/`, and
   removing the methods in `core/src/rpc.c` that call it. Keep that property:
   no hidden cross-module dependencies.

## 2. Toolchain and build

On Windows the MinGW toolchain is often **not on `PATH`**. Point `MINGW_BIN` at
the folder that holds `mingw32-make.exe` (this is a machine fact, so it lives in
the environment, not in a tracked file):

```powershell
$env:MINGW_BIN = "<your toolchain folder>"   # e.g. the folder holding mingw32-make.exe
$make = Join-Path $env:MINGW_BIN "mingw32-make.exe"
```

Build the kernel (produces `build/infantgod.exe`):

```powershell
& $make -f Makefile
# or, the driver that also proves the toolchain resolves:
python tools/build.py --check
python tools/build.py            # build; --release / --clean / targets
```

`tools/build.py` resolves make and gcc from `MAKE`/`GCC`, then `MINGW_BIN`, then
`PATH`, and passes the resolved compiler to make; it must never need a directory
outside the repository (that is what `path-check` enforces).

Other entry points:

```powershell
& $make -f Makefile run        # static server + system browser (no Electron)
npm install                    # only for the Electron window; devDeps
npm start                      # the Electron window (kernel must be built)
npm run dist                   # unpacked tree in dist/win-unpacked + NSIS installer
```

The game layer runs without a window, which is how most of it is verified:

```powershell
node shell/main.mjs validate DIR --json              # errors/warnings/infos, exit 0/1/2
node shell/main.mjs export DIR [--out FILE.zip]      # deterministic zip
node shell/main.mjs install DIR [--game-dir DIR] [--overwrite]
node shell/main.mjs log [--path FILE] [--mod NAME] [--duration-ms N] [--json]
```

`install` copies into the game's own `Mods/` folder (the last mile `export` does
not cover), and `log` reads or follows `Player.log`, which is where the game's
verdict on a package is written. Both are contained by the mods root the same
way `export` is.

`ELECTRON_RUN_AS_NODE` is set to `1` in some sandboxes and breaks Electron
spawns. Clear it for the current shell before running node/Electron work:

```powershell
Remove-Item Env:ELECTRON_RUN_AS_NODE -ErrorAction SilentlyContinue
```

## 3. Test and verification

The `Makefile` is the source of truth. Run the narrowest thing that covers your
change, then the full suite:

```powershell
& $make -f Makefile check          # e2e against the bare kernel
& $make -f Makefile fullcheck      # same suite through the shell (--kernel-cmd)
& $make -f Makefile probe          # every fixed bug in docs/BUGS.md
& $make -f Makefile cli-check      # the second client: tools/seide_cli.py selfcheck
& $make -f Makefile version-check  # every copy of VERSION agrees; CHANGELOG has a section
& $make -f Makefile path-check     # no hard-coded absolute path (strict, allow-listed fixtures only)
& $make -f Makefile installer-check # the installer's ownership manifest, real NSIS
& $make -f Makefile sign-check     # the signing wiring, against a stand-in signtool
& $make -f Makefile smoke          # real browser, headless: browser + input smoke
& $make -f Makefile test           # all of the above except smoke, plus the unit/self-tests
& $make -f Makefile ci             # what the GitHub test job runs: test, fixture installer, workflow audit
```

`make test` runs, in order: `check`, `fullcheck`, `probe`, `cli-check`,
`version-check`, `path-check`, `installer-check`, `sign-check`,
`build/obj/test_json.exe`, `build/obj/test_blob.exe`, then
`node langs/selftest.mjs`, `node shell/web/selftest.mjs`,
`node shell/mods/selftest.mjs`, `node shell/ai/selftest.mjs`.

Run a single JavaScript suite directly:

```powershell
node langs/selftest.mjs
node shell/web/selftest.mjs        # pure JS: no DOM, no browser
node shell/mods/selftest.mjs       # corpus checks skip when the game's Mods folder is absent
node shell/mods/selftest.mjs --mods <dir>
node shell/ai/selftest.mjs
```

Rules of thumb:

- **`make smoke` drives a real browser.** Do not run it concurrently with another
  agent or another smoke run on this machine — they collide on browser profiles
  and windows. A missing browser is a **skip with exit 0**, not a failure.
- **Do not run two suites at once either.** The mods suite rebuilds
  `build/knowledge-fixture` and its own scratch trees under `build/`; a second
  suite process (or a concurrent `make test`) can see the fixture half-written
  and report a generator failure that is not real. One suite per machine at a
  time, exactly like `smoke`.
- `installer-check` and `sign-check` compile against the real Windows binaries;
  they **skip with exit 0** when `makensis`, `gcc` or the sign stand-in's
  prerequisites are missing, and `sign-check` never needs a certificate. Do not
  read a skip as proof that signing works — a real Authenticode signature has
  never been produced in this repository.
- When you add a check, **prove it can fail**: invert the assertion (or
  temporarily break the code), watch the suite go red, then restore the file
  byte-for-byte. A check that has never been red is not evidence.
- Copy the counts from the run output into docs only after the run; grep the old
  number everywhere (`grep -rn "<old count>" --include=*.md .`) before deciding
  it is fully updated.
- `git diff --check` before handing work back; leave the tree buildable.

## 4. Repository map

| Path | What it is |
| --- | --- |
| `core/` | the C89 kernel: JSON, RPC, workspace/view/blob layers, exec |
| `core/port/` | the only OS-aware layer (`sys_win32.c`, `proc_win32.c`) |
| `core/tests/` | `test_json.c`, `test_blob.c` |
| `shell/main.mjs` | CLI (`rpc`, `serve`, `validate`, `export`, `install`, `log`), HTTP/stdio endpoints, `MOD_METHODS` |
| `shell/web/` | the browser UI: `main.mjs`, `cards.mjs` (the barrel), `cards/` (fifteen kinds, one module per family), `board.mjs`, `views.mjs`, `classic.mjs`, `modview.mjs`, `watch.mjs`, `openpath.mjs`, `history.mjs`, `rpc.mjs`, `selftest.mjs`, `README.md` |
| `shell/mods/` | the game layer: schema validation and its `D` codes, Yarn diagnosis, the `#line:` id cross-check, scaffolding, search, zip export (`zip.js`), install into the game (`gamepath.js` also finds the folder and reads/follows `Player.log`); `selftest.mjs` is the entry over `selftest/` (`game.mjs` is the install/log group) |
| `shell/ai/` | the AI layer (config, provider, tools); `selftest.mjs` is the entry over `selftest/` and runs in `make test` |
| `langs/` | language descriptors (`json.lang`, `yarn.lang`) + tokenizer |
| `tools/` | build/protocol/smoke drivers, scaffolders, the installer builder and its checks: `make-installer.mjs`, `installer_smoke.py`, `sign_smoke.py`, and `ci_installer.py`/`ci_audit.py` for the workflow's test job |
| `electron/` | the Windows wrapper: `main.js`, `newmod.js`, menus |
| `.github/workflows/ci.yml` | the `test` job as a file: four jobs, every action pinned, signing gated on repository secrets; `make ci` runs the test job locally |
| `docs/` | the argument: protocol, architecture, paradigm, mods, trim map, bugs, the open gap list (now round three) |
| `examples/` | shipped fixtures (`board.json`, `hello.yarn`, `sample.json`, `Mods/`) |
| `build/` | **gitignored** scratch: binaries, objects, test scratch, probes |
| `dist/` | **gitignored** packaging output |

## 5. Where the truth lives

Read the matching doc before changing a subsystem; each one is normative for its
area:

- [`docs/PROTOCOL.md`](docs/PROTOCOL.md) — the wire contract, method list, error
  codes, both transports, the "second client" rule.
- [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md) — layers, process topology,
  module inventory (the trim manifest), what the build proves, rejected
  alternatives.
- [`docs/PARADIGM.md`](docs/PARADIGM.md) — why the document, not tabs and a tree.
- [`docs/MODS.md`](docs/MODS.md) — the `mod.*` verbs, containment, the three mod
  card kinds, File → New Mod.
- [`docs/VIEWS.md`](docs/VIEWS.md), [`docs/SURFACES.md`](docs/SURFACES.md) — the
  view/document split and what a card kind is.
- [`docs/TRIM.md`](docs/TRIM.md) — what to cut, in what order, and what it costs.
- [`docs/BUGS.md`](docs/BUGS.md) — every fixed bug has a probe in
  `tools/kernel_probe.py`; add the entry and the probe together.
- [`docs/GAPS.md`](docs/GAPS.md) — the gaps that are still open, each with the
  command or line that proves it today; the longer audit is archived in
  `docs/EDITOR_GAPS.md` and takes no new entries.
- [`docs/FORK.md`](docs/FORK.md) — what this fork renamed/kept/added.
- [`docs/LANGUAGE.md`](docs/LANGUAGE.md) — how a `.lang` descriptor is written
  (generated by `tools/newlang.py` / `tools/gen_knowledge.mjs`).
- [`CHANGELOG.md`](CHANGELOG.md) — release notes; `version-check` requires a
  section for `VERSION`.
- [`.github/workflows/ci.yml`](.github/workflows/ci.yml) — the release pipeline
  as a file: four jobs, every action pinned. It runs on the GitHub runner for
  every push to `main`; this repository's first pushes were its first runs, and
  they exposed two assumptions a maintainer's machine hides (the recipe shell
  under MSYS2's make, and the Python console code page). `make ci` remains the
  local equivalent of the `test` job, and the workflow file itself is checked
  offline by `tools/ci_audit.py`. Signing is opt-in and needs the
  `SIGN_PFX`/`SIGN_PASSWORD` secrets; without them the `sign` job is skipped, not
  failed.
- `shell/web/README.md` — the UI's own manual (views, gestures, card kinds).
- `electron/README.md` — the wrapper: menus, spawning, sandboxing, packaging.

Recipes:

- **Add a card kind**: register it with `registerCardKind(...)` in
  `shell/web/cards/` (the module for its family; `cards.mjs` is the barrel that
  re-exports `cards/` and holds the registration list), add its renderer and any
  drag/selection behaviour, add its command to `COMMAND_HELP`, then document it
  in `shell/web/README.md` and
  the "shipped kinds" sentence in `README.md`, and cover its pure arithmetic in
  the section module beside it under `shell/web/selftest/` (`selftest.mjs` is the
  entry that imports the sections in order and prints the tally).
- **Add a protocol method**: `sde_methods[]` in `core/src/rpc.c`, the handler in
  the matching `core/src` module, the doc row in `docs/PROTOCOL.md`, the shell's
  client wrapper, and (if it is client-visible) the `seide_cli.py` verb; then
  `make check fullcheck cli-check`.
- **Add a mod verb**: `shell/mods/index.js` + the `MOD_METHODS` table in
  `shell/main.mjs` + the CLI usage block in the same file + `docs/MODS.md`'s
  verb table and a section if the verb is user-visible + a check in the matching
  group under `shell/mods/selftest/` + `README.md`'s `shell/mods/` sentence if
  the verb is a headline feature; then `node shell/mods/selftest.mjs`.
- **Add a validation code**: `shell/mods/validate.js` (the code table at the top
  of the file is part of the contract) + the prose in `docs/MODS.md` + checks in
  `shell/mods/selftest/spec.mjs`, calibrated so the shipped `MyMod`/`SODefines`
  stay quiet unless the code really fires on them; then prove it red.
- **Change installer, signing or CI**: `tools/make-installer.mjs` (flags, JSON
  record, exit codes), `tools/installer_smoke.py` / `tools/sign_smoke.py` for
  what the change must keep true, `tools/ci_audit.py` for the workflow's shape,
  `README.md`'s installer/CI paragraphs and `docs/ARCHITECTURE.md`'s
  `What the build proves` table; then `make installer-check sign-check ci`.
  Signing without a certificate is a **skip** — never claim a real signature.

## 6. Working discipline

- **Scope your writes.** This tree is often edited by several agents at once.
  Take one file set, say so, and stay in it; if you need a file another agent
  owns, report it instead of editing it.
- **Never** run `git stash`, `git checkout --`, `git restore`, `git reset`,
  `git clean`, or branch switches while the tree is mid-work — another agent's
  uncommitted work lives there. Do not `git add`/`commit` unless asked.
- **Do not rewrite history** or force-push. Commit messages are English,
  imperative, one concern each.
- Prefer `read`/`edit`/`write` tools for file changes; they respect the
  filesystem guard. Scripts and formatters are not protected — coordinate them.
- If a behavior and a doc disagree, find out which one the code actually does,
  then fix the doc (or the code) and say which in your report.
- **A doc you did not write may be in the tree.** `docs/GAPS.md` has been
  rewritten by a different session mid-task; treat uncommitted docs as someone
  else's work: read the current file before editing it, keep their structure
  where it is sound, re-pin any line numbers your changes would invalidate, and
  say in your report which parts you verified and which you inherited.
  Never silently revert another agent's copy.
- If the task says "do not touch X", do not touch X even to fix an obvious typo.
- Report what you measured: commands, exit codes, and the raw failing output for
  anything that did not hold. State plainly what you could **not** verify.

## 7. Windows / PowerShell pitfalls

- The console mis-decodes UTF-8 (`鈥?`, `鈫?`). Use the `read` tool for non-ASCII
  files; use `pwsh` for ASCII scans only.
- `Set-Content -Encoding utf8` writes a **BOM**; `>` writes **UTF-16**. When
  producing files for tooling, prefer the `write` tool, or write bytes without a
  BOM.
- PowerShell strips double quotes out of native argv, so passing JSON as a
  command-line argument to node/python corrupts it. Write the payload to a
  file and pass the path (`@file`) instead.
- `Get-ChildItem`/`Select-String` are fine for discovery, but the repo's own
  tools (`tools/path_guard.py`, `tools/version.py`) are the authority.

## 8. Pre-flight checklist

Before saying a change is done:

- [ ] `git status --short` shows only files you meant to touch.
- [ ] No conflict markers anywhere: `grep -rn "^<<<<<<<\|^=======\|^>>>>>>>"`.
- [ ] `git diff --check` is clean (no trailing whitespace, no conflict cruft).
- [ ] The narrow suite for your area passes, then `make test` passes.
- [ ] If you added a check: it was red before the fix / with the assertion
      inverted, and it is green now.
- [ ] Every doc sentence that quotes a count or a file list matches the tree.
- [ ] Anything you could not run or verify is listed explicitly in your report.
