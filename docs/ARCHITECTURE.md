# Architecture

OsanaKami IDE Studio is three layers in three languages, connected by one frozen protocol.
This document describes what each layer is, how the processes are arranged, and
why the kernel deliberately knows nothing about programming languages.

---

## The three layers

| layer | directory | language | what it is |
| --- | --- | --- | --- |
| kernel | `core/` | C89 | files, view persistence, child processes, the JSON-RPC method table |
| shell | `shell/`, `langs/` | JavaScript ESM | the endpoints, the board UI, language colouring |
| tools | `tools/` | Python 3.12 | build driver, protocol driver, language-descriptor generator |

The languages are not an accident and not a fashion statement:

- **C89** for the kernel because constraint 4 (fully offline, no package
  manager, no configure step) is easiest to keep when the compiler is the only
  build system. `-std=c89 -pedantic -Werror` makes the subset unarguable.
- **JavaScript ESM** for the shell because the UI is a web page already, and
  because Node can run the same modules the browser runs (no build step).
- **Python 3.12** for the tools because a protocol driver wants batteries and
  because Python is present on any machine that has this repository working.

Zero dependencies across all three. The shell has no `package.json` and no
`node_modules/`; the tools import nothing outside the standard library.

---

## Process topology

```
                 +-----------------------------+
   browser  <--> |  shell/main.mjs             |
   (Edge/       |  `infantgod rpc`  or            |
    Chromium    |  `infantgod serve`              |
    --app=)     |    - HTTP static + /rpc     |
                 |    - SSE /events            |
                 |    - lang.list              |
                 |    - lang.tokenize          |
                 |    - workspace.info + langs |
                 +--------------+--------------+
                                |
                    newline-delimited JSON-RPC
                       over stdin / stdout
                                |
                 +--------------v--------------+
                 |  build/infantgod.exe rpc        |
                 |    - workspace.* file.*     |
                 |    - view.*                 |
                 |    - exec.*                 |
                 |    - hello                  |
                 +-----------------------------+
```

The shell **spawns the kernel** and owns its lifetime. `shell/main.mjs` locates
the binary at `build/infantgod.exe` on Windows or `build/infantgod` elsewhere
(`DEFAULT_KERNEL`), writes one JSON frame per line to its stdin, and reads lines
from its stdout.

### stdout is protocol-only

This is the transport's one non-negotiable rule, stated in `core/include/serve.h`:

> Contract: stdout carries protocol frames and nothing else. Every diagnostic
> goes to stderr.

Everything a human should read — the port the window was served on, "ready",
"stop", usage text, frame-too-large notices that cannot be a protocol event —
goes to stderr. The shell writes kernel stderr through to the terminal, so
diagnostics stay visible without corrupting the stream.

### Concurrency inside the kernel

The kernel is single-writer by construction. One reader loop
(`sde_serve` in `core/src/serve.c`) answers requests, and the `exec` module's
single pump thread may publish `exec.output` at any moment. Both paths go
through the same emit callback, and the emit callback takes a mutex around its
`stdout` write:

```c
/* core/src/serve.c */
/* The output mutex is the one piece of synchronisation in the transport ... a
   half-written frame would desynchronise the shell's parser permanently. */
```

The `exec` module polls live children every 15 ms (`SDE_EXEC_IDLE_MS`) instead
of giving each child a blocking reader thread. That is what keeps "one writer"
true: adding a thread per run would have meant adding a lock per notification.

### Framing

One JSON object per line, in both directions. `\n` is the frame delimiter;
leading and trailing whitespace on a line is trimmed, and a blank line is a
keep-alive that is ignored. A single frame is capped at 64 MiB
(`SDE_SERVE_MAX_LINE`); an oversized frame is reported via a `log` notification
and dropped rather than killing the session.

Requests are answered with a response carrying the same `id`. A frame with no
`id` is a notification and is never answered. The full contract is in
`docs/PROTOCOL.md`.

---

## Module inventory (the trim manifest)

`infantgod modules` prints the same table that lives in `sde_module_table[]` at the
top of `core/src/main.c`. It is the authoritative list of what the kernel is
made of and what deleting each piece costs. `optional` means the kernel still
builds and runs without it.

| module | role | what a fork loses by deleting it | optional |
| --- | --- | --- | --- |
| `buf` | growable byte buffer, the kernel's only string type | nothing builds: every other module formats through it | no |
| `vec` | growable pointer array, used for lists without a fixed bound | nothing builds | no |
| `json` | JSON parse/serialise; the protocol's value type | nothing builds | no |
| `base64` | base64 for the byte verbs and for blob chunks | binary files can no longer cross the wire, in either direction | no |
| `port` | the platform boundary: files, paths, threads, processes | nothing builds; this is the layer a fork replaces to leave Win32 | no |
| `wksp` | workspace reads/writes, path containment, content revisions | files can no longer be opened or saved; the client is left with what it holds | yes |
| `blob` | large files as chunked sessions, published atomically on commit | a file over 4 MiB can only be read or written whole, if at all | no |
| `view` | the client's view document: opaque JSON, atomic persistence, revisions | no document survives a restart; the client is left with what it holds | yes |
| `exec` | child processes for `runner` cards, with streamed output | cards can no longer run anything | yes |
| `serve` | newline-delimited JSON-RPC over stdin/stdout | the kernel has no way in; useful only as a linkable library | yes |
| `rpc` | the method table that turns frames into actions | nothing is callable; keep it and the kernel has no verbs | no |
| `app` | constructs and owns the shared state modules are handed | nothing builds | no |

Twelve modules. Eight required (`buf`, `vec`, `json`, `base64`, `port`, `blob`,
`rpc`, `app`), four optional (`wksp`, `view`, `exec`, `serve`). Beyond the module
table there are two compile-time switches in `core/include/infantgod_cfg.h`:

```c
/* Compile-time switches a fork flips to cut whole subsystems out. */
#ifndef SDE_WITH_EXEC
#define SDE_WITH_EXEC 1
#endif
#ifndef SDE_WITH_VIEW
#define SDE_WITH_VIEW 1
#endif
```

The `rpc.c` method table is written under those switches, so turning one off
removes both the subsystem and the verbs that reach it. See `docs/TRIM.md`.

### The platform boundary

`core/port/` is the only code that knows which operating system this is:
`sys_win32.c` (files, paths, threads, mutexes, stdout/stderr) and
`proc_win32.c` (child processes with two pipes). The Makefile states the
contract for a fork:

```make
# The platform layer is the one place that knows which OS this is.  A fork
# targeting another system writes core/port/sys_<name>.c and proc_<name>.c and
# selects it here; nothing above core/port changes.
```

`core/include/port.h` uses opaque structs and function pointers deliberately, so
a fork can swap the implementation without recompiling its callers. Paths
crossing that API always use `/` as the separator; the Win32 implementation
accepts both on input and normalises internally.

Two of those functions carry the kernel's containment and its write promise,
and the Win32 implementation has to earn both:

- **Containment follows the real path.** `sde_port_path_within()` resolves the
  final name of the nearest existing ancestor and appends the components that do
  not exist yet, so a junction (a reparse point, `mklink /J`) planted inside the
  workspace cannot carry a relative path out of it -- not even for a file that
  is about to be created below it. The lexical check runs first, so a path that
  is obviously outside costs nothing; a path that looks inside then costs two
  final-path lookups (root and target), not a walk of the tree.
- **A publish is a rename, never a truncation.** `sde_port_write_file()` writes a
  sibling `.sde-write-<pid>-<n>` file and replaces the target with one
  `MoveFileEx(..., MOVEFILE_REPLACE_EXISTING)`. A reader either sees the old
  bytes or the new ones, and a failed write leaves the old file whole; the
  half-written sibling is removed on the way out.

The same honesty applies to revisions: a file that exists but cannot be read
(a share mode that admits writes and not reads, or a directory in place of one)
is never reported as revision 0 "for free". `file.stat` answers
`{"revision": 0, "readable": false}` for it, and the write verbs refuse with
`cannot read file for revision` instead of truncating a file whose base they
cannot prove.

`core/include/infantgod_cfg.h` must be included **first, before any system header**,
and raises two Win32 macros that the kernel depends on:

- `__USE_MINGW_ANSI_STDIO 1` — MinGW hides the C99 `snprintf`/`vsnprintf`
  family when `__STRICT_ANSI__` is set; this asks for the conforming
  implementations back.
- `_WIN32_WINNT 0x0600` — needed before `<windows.h>` so condition variables and
  `TryEnterCriticalSection` are visible.

---

## Files over 4 MiB: the blob layer

The four `file.*` verbs move a whole file through one JSON string, so 4 MiB is
where they stop; that limit is unchanged and those refusals still read
`file is too large to open`. `core/src/blob.c` is the companion for the files
that are bigger than a JSON string should be: a session turns one file into a
sequence of 1 MiB chunks, so a 5.75 MB translation table is read and written
without either side ever holding it whole.

- **A session is a small state machine.** `sde_blobset` holds eight sessions; a
  session is a path already resolved through `sde_wksp_resolve` (so `../` and
  absolute paths are refused before a file is touched), a mode, a position and,
  for writes, the temporary file. `file.blobOpen` takes a `base_revision` and
  checks it exactly as `file.write` does, so the stale-revision rail is the same
  rail.
- **Reads seek instead of buffering.** `sde_port_read_at()` reads `length` bytes
  at `offset` in 64 KiB steps. The per-call chunk is capped at
  `SDE_BLOB_MAX_CHUNK` (1 MiB) and refused, never truncated, so a client cannot
  ask one call for the whole file and defeat the point. Asking past the end is
  answered with an empty frame *at the end of the file*, which keeps a loop that
  trusted a stale size terminating.
- **Revisions stream.** `sde_rev_update()`/`sde_rev_final()` (in `wksp.c`, seed
  `SDE_REV_SEED`) are the FNV-1a hash of `sde_rev_of()` split into two steps, so
  the same hash can be computed in 64 KiB pieces. A chunked write folds each
  append into the session's running hash as the bytes arrive; a chunked read
  streams the file through the same helper. `sde_rev_final()` maps a hash of 0
  to 1, because 0 is the protocol's "no revision". The result is that a 5.75 MB
  file read as a blob, read as text, `file.stat`ed and committed as a blob all
  report the same number.
- **Publish is still one rename.** A write session appends to `<path>.tmp`;
  `file.blobCommit` requires `total_size` to equal what was appended and then
  calls the same `sde_port_replace_file()` that `file.write` uses. A refusal
  leaves the session open so the sender can send the missing bytes; `file.blobAbort`
  closes it and removes the temporary file; a session idle for fifteen minutes is
  closed by the next blob call, which is what keeps a crashed client from leaving
  a `.tmp` behind forever.
- **Errors keep the wire's meaning.** `SDE_BLOB_STALE` becomes `1001
  STALE_REVISION` with `data.current_revision`; a read open of a missing file is
  `1002 NOT_FOUND`; an unknown session, a bad `mode`, a chunk over 1 MiB, a
  negative offset, an append offset that is not the end and a `total_size` that
  does not match are all `-32602 INVALID_PARAMS`; anything else is `1003 IO`.
  The mapping lives in one function (`fail_blob()` in `core/src/rpc.c`) so a
  status cannot drift from its code.

`core/src/blob.c` and the port use `long` throughout, the layer's existing size
type. On Win64 `long` is 32-bit, so a blob session covers files up to 2 GiB --
three orders of magnitude above the 4 MiB it removes, and a local change if a
fork ever needs more.

The shell does not ask which size a file is before opening it. `readTextFile`
and `writeTextFile` (`shell/web/cards/blob.mjs`) call `file.read` /
`file.write` first -- one call, and the read answer includes the line endings --
and fall back to a blob session only when the kernel's refusal is the one that
says the file is too large. That keeps a 2 KB define's round trip at one call
and gives a 5.75 MB table or `.yarn` the session without a second code path,
and it means the boundary is enforced in exactly one place: the kernel.

The same argument reaches the mod layer, which reads files itself with
`node:fs` rather than asking the kernel. It cannot share code with the kernel —
it runs in the shell's process — so it shares the rule: `shell/mods/readtext.js`
refuses a directory, a file over the same four mebibytes and anything that holds
a NUL byte, and every text read in `shell/mods/` goes through it. The suite
parses `SDE_WKSP_MAX_READ` out of `core/include/wksp.h` and fails if the two
numbers stop agreeing (G14).

A recording is the case where the two read verbs disagree on purpose: the audio
card (G2) asks for `file.read_bytes` because the bytes are the point, and hands
the player a data URL rather than a URL — the shell's HTTP front end serves the
app, not project files, so a project file reaches a card only through the
kernel.

---

## Why the kernel is language-agnostic

The kernel knows about files, documents and processes. It has **no tokenizer, no
keyword table, and no shipped grammar**. `core/include/app.h` states it:

> The kernel deliberately knows nothing about programming languages. There is no
> tokenizer, no keyword table and no shipped grammar here.

And `core/src/main.c`'s own usage text repeats it:

> Language support is deliberately not a kernel concern: `.lang` descriptors and
> the keyword tokenizer live in `langs/` and are served by the shell. The kernel
> knows nothing about programming languages.

Why is this a decision rather than an omission?

1. **It keeps the kernel honest.** Every method in `rpc.c` does one thing to
   files, processes or the client's document. Nothing in C has to grow a table of
   language names, and nothing in C has to be rebuilt to support a new language.
2. **It makes language support deletable and replaceable.** `rm -rf langs/`
   leaves a kernel that still builds and a shell that still runs, rendering
   plain text. A fork that wants Rust-quality colouring can reimplement two
   methods — `lang.list` and `lang.tokenize` — in any language, anywhere, and
   delete `langs/`.
3. **The alternative was tried and rejected.** An earlier structure put the
   language layer in the kernel's process. It forced every colouring change to
   be a C rebuild, and it coupled the JSON-RPC method table to a data format
   that changes far more often than the file/document/process contract does.
4. **The wire is the seam.** `lang.list` and `lang.tokenize` have exactly the
   same shape as kernel methods, so a client cannot tell — and does not need to
   know — which layer answered. The shell multiplexes them onto one endpoint
   with one `dispatch()` function (`shell/main.mjs`), used identically by
   `infantgod rpc` (stdio) and `infantgod serve` (HTTP), so the wire behaviour cannot
   drift between the two modes.

The consequence for a forker: **language features are the cheapest thing in
this repository to change and the safest thing to delete.** The seam between the
kernel and a view (`docs/VIEWS.md`) and the protocol are the load-bearing parts.

---

## The shell, inside

`shell/main.mjs` is the only Node file the user runs. It has two modes:

| mode | command | what it is |
| --- | --- | --- |
| stdio front end | `node shell/main.mjs rpc --workspace .` | spawns the kernel, forwards every frame, answers `lang.*` itself; this is the "full endpoint" `tools/e2e.py --kernel-cmd` drives |
| HTTP front end | `node shell/main.mjs serve --workspace .` | static files from `shell/web/`, `POST /rpc`, `GET /events` (SSE), then launches the system browser in `--app=` mode |

Both modes share one `dispatch()`, so a method behaves the same either way.
Language support is loaded with a **dynamic import inside a `try/catch`**, which
is what makes deleting `langs/` survivable at runtime rather than a startup
failure; the fallback is `PlainLanguages`, which reports no languages and
returns one `plain` token covering the input.

The browser side, `shell/web/`, is module-per-concern:

| file | role | delete it and ... |
| --- | --- | --- |
| `index.html` | the entire page | nothing loads |
| `style.css` | layout, card chrome, the editor's two-layer metrics | cards render unstyled |
| `board.mjs` | the board model: cards, links, serialise | OsanaKami IDE Studio stops being OsanaKami IDE Studio; both views have nothing to project |
| `history.mjs` | the undo ring: document snapshots, coalescing, redo branch | `Ctrl+Z` stops existing; every edit still lands, nothing is remembered |
| `watch.mjs` | what a card should do when its file moves under it, and which cards ask | a file rewritten outside the app stays silently stale under an open card |
| `cards.mjs` | the barrel over `cards/`: re-exports the public names and registers the seventeen kinds | no card has anything to draw with |
| `cards/` | one module per card family, plus the shared `dom.mjs`, `registry.mjs`, `blob.mjs`, `text.mjs`, `sheet.mjs`, `story.mjs`, `agent-tools.mjs` and the guide card | `cards.mjs` has nothing to re-export, so no card has a renderer |
| `rpc.mjs` | the client side of the kernel protocol | the views render as an empty document |
| `classic.mjs` | the same cards arranged as a code area, a tab strip and a sidebar (pure; the pixels are in `main.mjs`) | the app has no tiling to open in -- `DEFAULT_VIEW` would name a view nobody draws |
| `modview.mjs` | the same cards arranged as a mod workbench: a package column, a code area and a report panel (pure) | the app has no second tiling to switch to |
| `story.mjs` | a Yarn story read as nodes, lines, speakers, tags and `#line:` ids, and written back line for line (pure) | the story card has no model to draw, and the mod's 211 `.yarn` files can only be edited as raw text |
| `storycsv.mjs` | the translation tables the game keeps beside a story: CSV in and out, `lock` = the first four bytes of SHA-256 of the source text, and each row's state (pure) | a translation cannot be shown beside the line it belongs to, and nothing can tell a fresh translation from one the source has moved under |
| `ysls.mjs` | the game's own command schema read as two ordered lists, and where a `<<name` is being typed in a line (pure) | completion would have to be a hand-kept list in the shell, which is wrong the day the mod's commands change |
| `pixelpng.mjs` | a PNG reader and writer that carries its own inflate, CRC-32 and Adler-32, and reads the two shapes this game's art is (pure) | a `.png` could only travel as base64 and nothing could show or change a pixel |
| `pixelview.mjs` | the pixel card's framing arithmetic: where the image sits on a measured surface, what a wheel does under the cursor, and the zoom range (pure) | the card would have to keep zoom and pan consistent inside its own paint, and no test could pin the arithmetic without a DOM |
| `audioinfo.mjs` | what the window knows about a recording before playing it: which extensions are audio, the media type, a size and a clock read as a person reads them, and the data URL for bytes it already holds (pure) | the audio card would decide media types and durations in the DOM, where no test reaches, and two cards would eventually disagree about `.oga` |
| `openpath.mjs` | whether the kernel will read a path the window is about to open: relative names are the kernel's to resolve, absolute ones have to sit under the reported workspace root (pure) | the rule becomes an inline string comparison in `main.mjs`, and the relative-open regression it pins stays green in every pure suite |
| `i18n.mjs` | the two catalogs (English and Chinese), locale normalisation, a lookup that falls back to English and then to the key, and the card-kind names (pure) | every visible word would be an English literal again, and a language choice could not outlive the window |
| `diagnostic-hints.mjs` | one sentence a person can act on for a diagnostic code, looked up from the same table, and silence for a code the table has never met (pure) | the problems card could show what went wrong but never where to start fixing it |
| `views.mjs` | what each mode is called, which one draws a tile, and which one a window opens in (pure) | the two tiles cannot agree on what a mode is named, and the HUD's switch has nothing to build its buttons from |
| `main.mjs` | the only file that knows about the whole app | `index.html` has nothing to boot |
| `selftest.mjs` | the entry: imports `selftest/` in order and prints the tally (`node shell/web/selftest.mjs`, no DOM, no network) | nothing; it is only a test |
| `selftest/` | one module per section of the suite (harness, fixtures, rpc, board, cards, project, http, sheet, main, views, story, translation, mods, pixel, spine) | the suite is one 5,900-line file again |

`board.mjs`, `history.mjs`, `watch.mjs`, `classic.mjs`, `modview.mjs`,
`views.mjs`, `story.mjs`, `storycsv.mjs`, `ysls.mjs`, `pixelpng.mjs`,
`pixelview.mjs`, `audioinfo.mjs`, `openpath.mjs` and `cards/agent-tools.mjs` are deliberately UI-free —
no `document`, no `window`, no timer — so the same objects
are used by the browser and by `selftest.mjs` under Node. `watch.mjs` decides; the polling
that feeds it lives in `main.mjs`, which is why the decision table can be pinned
without a browser, a kernel or a clock. `classic.mjs` and `modview.mjs` are the
same kind of arithmetic: they compute the role and the tile for the cards a
document already holds, `views.mjs` names the modes and says which one a window
opens in, and `main.mjs` owns the pixels.

Three host contracts keep a card honest without letting it reach around the
shell. A card's `openFile(path, {line, pointer})` keeps the caller's own path
form (a name it was given stays a name) but refuses what the kernel cannot
read; the editor screens answer it by moving the caret to the line, or to the
JSON Pointer the diagnostic was written with. A tile calls a card's optional
`shown()` the first time that card is displayed, so a canvas created behind
another tab measures itself when it has real pixels rather than when it was
built. And the mod card's sections fold from their titles, recording the folded
set on the card document so a re-render keeps it; the card body scrolls only
when the window is shorter than the unfolded sections.

The agent card keeps the same shape one level up. A card family may declare
`agent` tools beside its `render` (`defineCardTool` in
`cards/agent-tools.mjs`, names `card.<kind>.<verb>`, read-only only), and the
card merges those declarations with the shell's own tools for each round. The
shell holds the provider, the key and the four `ai.*` verbs; the window holds
the loop, routes a `card.*` call back to the card that declared it, and turns a
throwing handler into a tool message. Neither side can reach past that seam:
the model never sees a key, and a card cannot offer a write.

The HTTP front end serves `shell/web/` as static files, so there is no build
step between editing these modules and reloading the page. `index.html` loads
`./main.mjs` as a module, and the browser resolves the rest of the imports.

`electron/` is not a third front end: it spawns the HTTP front end under
`ELECTRON_RUN_AS_NODE=1` and loads the loopback URL in an Electron window
(`electron/README.md`). Everything that speaks protocol from outside the page —
`tools/seide_cli.py`, the File menu's 新建模组… — goes through the same
`POST /rpc`, so a UI never grows a method of its own: the menu's one frame is
`mod.scaffold`, which already existed. The settings card and the mod
card's new/import rows reach the shell the same way, never around it:
`config.get`/`config.set` for the machine, `mod.newFile`/`mod.importFile`
for the files a package holds.

---

## What the build proves

The Makefile's verification targets, in the order `make test` runs them:

| target | command | what it proves |
| --- | --- | --- |
| `check` | `python tools/e2e.py --kernel build/infantgod.exe` | the kernel alone: protocol, files (text and bytes), blob sessions over 4 MiB, the view document, exec |
| `fullcheck` | `python tools/e2e.py --kernel-cmd "node shell/main.mjs rpc --workspace ."` | the whole endpoint, including the language layer |
| `probe` | `python tools/kernel_probe.py` | every bug in `docs/BUGS.md`, against its own scratch workspace under `build/` |
| `cli-check` | `python tools/seide_cli.py selfcheck` | the protocol's second consumer: eight checks -- hello, a write round-trip, the stale-revision rail, the listing, a document the kernel stores without reading it (and the stale write it refuses), a child's output and exit code, that a shell-only method is still `METHOD_NOT_FOUND`, and that the command line refuses to overwrite a file it was not given a base revision for |
| `version-check` | `python tools/version.py check` | the four copies of the version number still agree with `VERSION` |
| `path-check` | `python tools/path_guard.py --self-test` then `tools/path_guard.py --strict` | no tracked file names a hard-coded absolute path: a home directory, a UNC share or any other drive path fails the run unless the file is on the tool's allow-list with a reason (Windows-shaped test fixtures and the rules' own self-test cases). `make path-check` runs it strict, so a new path cannot slip in; the rules themselves are checked against synthetic strings first |
| `installer-check` | `python tools/installer_smoke.py` | the installer's ownership manifest and its two questions against the real Windows binaries: a new folder installs and an upgrade over it works; a silent install makes the default desktop and Start Menu shortcuts and uninstall removes both; the uninstaller removes the payload, the licence, the manifest and itself and leaves a stranger's files and their folders; a folder holding a stranger's file is refused with exit 2 and nothing written (no shortcut either); an uninstaller copied away from its manifest deletes nothing. Skips with exit 0 when makensis is not installed |
| `sign-check` | `python tools/sign_smoke.py` | the installer-signing wiring without a certificate: a compiled stand-in for signtool records the argv it was given (the password is absent, quoting intact), and the script checks `--sign-dry-run`, exit 2 for a missing or ambiguous certificate, exit 1 for a failing signtool, and the `signing` record in `build/make-installer.json`. Skips with exit 0 when gcc or makensis is not installed |
| `ci` | `make ci` | what the GitHub `test` job runs, locally: the whole `test` target, then `tools/ci_installer.py` builds and installs a two-file fixture installer, then `tools/ci_audit.py` audits `.github/workflows/ci.yml` offline (four jobs, every action pinned, read-only permissions). The `test` and `smoke` jobs also run on the GitHub runner for every push to `main` |
| `smoke` | `python tools/browser_smoke.py` then `tools/input_smoke.py` | the real window: rendered DOM; real double-clicks, keys and wheels; a file rewritten by a real child process while a card holds it; and the editor card's `Tab`, `Shift+Tab`, `Enter`, `Ctrl+F`, next-hit, replace-all, `Esc` and undo stack |
| `$(JSONTEST)` | `core/tests/test_json.c`, built against `json.o`/`buf.o`/`vec.o` | the JSON codec everything else trusts |
| `$(BLOBTEST)` | `core/tests/test_blob.c`, built against every object except `main.o` | the blob layer through `sde_rpc_handle()`: base64 on the wire, offsets, limits, sessions, the 1 MiB chunk cap, idle close, the temporary file and the atomic publish, and the port layer's half of the same promises -- a junction cannot carry a relative path out of the workspace, a write onto a file it cannot read is refused instead of truncating it, and a write publishes a new file rather than editing the old one -- against its own scratch directory under `build/` (184 checks) |
| — | `node langs/selftest.mjs` | the descriptor and tokenizer checks (91), no kernel, no browser |
| — | `node shell/web/selftest.mjs` | the protocol plumbing, board model, undo ring, watch decision table, the classic and mod views' roles and tiles, which view a window opens in and which ones the switch offers, every card kind's tab in both views, the tab-close neighbour rule, the close question and what each answer means, the Yarn card's completion menu and hover line, token spans and the editor's indent/find/replace arithmetic, the Yarn story parser against every line shape the mod uses, the translation tables' quoting, BOM (kept byte for byte, non-UTF-8 refused), line endings, derived `lock` and row states, the 4 MiB refusal answered by a session on all three cards that show a file (editor, story, table), a translation cell written back through `setColumn` with its `lock` refreshed and a row created for a line the table did not have, and the command schema's order, filtering and signatures, and the PNG reader and writer's five row filters, block shapes, refusals and byte-exact round trip, the Spine binary reader's layout and refusals, the pose, frame and edit-model arithmetic, the writer's byte identity on the rig the suite owns, the settings card's
kind and the boot view and poll interval a preferences file can ask for, the
pixel view's framing arithmetic (an un-panned image centred on the measured
surface, a pan the person made kept, a wheel zooming around the pixel under the
cursor and clamped to the image), the pixel card taking its measurements when
its tile first shows it, a mod card section folding and remembering the
fold on the card document, and the watch accepting any card that names a file
and can reload it -- through getters or methods -- while a card holding a folder
or a query stays out of the poll, and the sources rows the settings card prints
say which folder and which knowledge base answered,
and the agent card's tool inventory, read-only construction and the bridge into the tool
registry are covered as well, and so are the open picker's recents rule, the locale catalogs' parity and fallbacks, the hint table, and the start card's place in the kind list (329 checks), no DOM |
| — | `python tools/browser_smoke.py` | the window renders: HUD, workspace root, the board's first cards, the command bar; a cold boot lands on the mod tile; `?mod=` opens the package the File menu just wrote; the mod card's three headings open their files; a page's own save is not logged as another writer while a real external write still is; a wrong relative name fails visibly and the right one opens; every card kind is reachable as a tab in both tiles and any opened card can be focused; a tab closes by `x`, a middle click and `Ctrl+W`, closing a clean card is undone with `Ctrl+Z`, and closing a dirty card asks with three answers; the Yarn card opens a completion menu on `<<` and accepts a row with Enter, moving the caret closes that menu instead of leaving it stale, Enter after a silent caret move inserts nothing, and the line under the cursor explains itself; the rig card poses a bone through its inspector, saves it over the rig file, and the file read back carries the typed angle, while a clean card refuses a second save; the settings card is one of the
kinds the tab strip has to reach in both tiles, the mod card creates a Goods
define through its own picker and imports a PNG that reads back byte for byte
(70 checks) |
| — | `python tools/input_smoke.py` | the board's input really is wired up: a double-click adds a card, Ctrl+Z takes it back, Ctrl+Shift+Z puts it back, who owns a wheel -- a wheel over a card's own contents is left to the card, and no view pans or zooms -- the editor card's Tab, Shift+Tab, Enter, Ctrl+F, next-hit, replace-all, Escape and undo stack behave, a file written out of band and then edited over and deleted is reloaded, warned about or reported, and the classic view is measured as drawn -- the tile and the tab click that moves the code area -- and the editor's gutter is read back one number per line and toggled off and on by a real click, and the mod view's entry points are exercised in the same window: the repository's own example mod, an RGB sprite read back through the pixel card, the story card's tag surface, the 4.5 MB table this run builds, a `D011` row opening the file it names (and a `D006` row explaining the file it cannot find), and a window checked to open on the mod tile (44 checks) |

| — | `node shell/mods/selftest.mjs` | the mod layer without a browser: discovery order (setting, environment, the platform's Steam defaults, the named no-knowledge state) and `describeDiscovery`, scaffolding, package validation and every `D`/`M`/`E` code, the Yarn parser's diagnostics, the tag sources, the knowledge base's resolution order and the derivation into the user directory when no file ships, the knowledge generator's `--check` and `--diff`, a facts-only knowledge base keeping the sprite and reference fields the checker looks at (down to a `validatePackage` run on one), the language service's position and completion cores, creating one file from a
schema for all 51 definition types (each validating clean), importing a file
byte for byte with its validations and refusals, exporting a package as a
deterministic zip (round-tripped by the suite's own reader: central directory,
CRCs, UTF-8 flags, the precheck gate), installing that package into a game tree
(staged swap, refusal without `--overwrite`, the blocked-package precheck), reading
and following a `Player.log` (newest at depth one or two, the tail from a line
boundary, appended bytes only, `gone` not thrown), the schema constraints a
knowledge base can state (`pattern`, `minimum`/`maximum`, `minItems`, `uniqueItems`,
`oneOf`/`anyOf`/`allOf`/`not`), unresolved `$ref`s, the Yarn `#line:` ids checked
both ways against the translation tables (missing from the table, orphaned in it,
duplicated across files, the non-hex ids reported rather than matched), the
Addressables addresses that look like asset paths rather than names, the package
root a validation answers with so another card can open what its diagnostics
point at, the demo
packages' listing and
byte-identical copy (openable only where it was copied), `config.get`/`config.set`
keeping a real API key off the wire, the wiki-trap lint (`D019`–`D022`) and the
localisation lock lint (`D023`), the package-side answers the docs verbs give
when a root is passed (`stats` package block, per-type `packageCount`, define /
node / file hits and their text) while the no-root shapes stay what they were,
the sources report behind the settings card and `sources` (the game folder and
the places discovery tried, the knowledge state and its source), and the row
wording kept as pure data, with the shipped corpus pinned at zero false
positives and the `ai.*` frames the agent card asks (684 checks) |
| — | `node shell/ai/selftest.mjs` | the AI groundwork, offline: the fake OpenAI-compatible server this suite starts on `127.0.0.1:0`, the exact request bytes, SSE frames split across reads, tool calls accumulated by index, the five error classes, the key that never reaches a log, atomic config writes, the tool registry and its path containment, the settings store and its two verbs, and the card-tool bridge into the tool registry (93 checks, 1 skipped on win32 where `0o600` is not a thing) |

`smoke` runs the last two and needs a browser.

---

## Rejected alternatives, with reasons

- **Electron.** Rejected because it means bundling a browser: hundreds of
  megabytes, a download in the build, and a Node-and-Chromium process tree. The
  prototype uses the system's Edge/Chromium in `--app=` mode with a throwaway
  profile instead. This is a prototype tradeoff, not a product answer; the
  product answer is WRY/Tauri (`docs/FORK.md`). The rejection is about what
  `core/` may depend on, not about the wrapper this fork ships: `electron/`
  spawns that same HTTP front end and speaks no protocol of its own (see "The
  shell, inside"), so it adds no method to the kernel.
- **A Rust kernel.** Dropped because a dependency's build script needed a C
  compiler, which breaks constraint 4 (fully offline, no configure step). C89
  has no build script and no dependency graph to resolve.
- **Language support in the kernel.** Rejected for the four reasons above.
- **A socket instead of stdio for `rpc` mode.** Rejected because stdio framing
  gives the shell a trivially correct lifetime rule: when the shell's stdin
  closes, the kernel exits and frees the app, which kills every live child.
  That is exactly the behaviour a closing window needs.
- **One reader thread per child process.** Rejected in favour of a single
  15 ms polling pump, to keep the kernel single-writer (see above).
- **Binary files as JSON strings.** Rejected: `file.read` refuses a file
  containing a NUL byte ("file is binary -- use file.read_bytes") because
  shipping it as a JSON string would produce a document no client can
  round-trip.  The bytes travel as `base64` instead -- an encoding every JSON
  parser can carry and every byte value survives -- so a client that wants a
  `.png` asks for it by name rather than discovering the refusal.
- **A missing or corrupt view document.** Neither is the kernel's problem any
  more. An absent `.infantgod/board.json` is fine (first run: `document: null`,
  `revision: 0`), and a file that **exists but does not parse** is reported to
  the client by `view.load` -- the kernel does not open it at start-up at all.
  The earlier rule ("refuse to start rather than silently discard a user's
  layout") was reversed in `infantgod/2`, because the client is the thing that
  can tell a layout from a parse error, and a kernel that will not start is a
  worse outcome than a client that offers to rewrite the file. `docs/VIEWS.md`
  has the reasoning; `docs/BUGS.md` (entries N8, N10) has the two bugs that made
  the old rule expensive.
