# Changelog

What changed, in the order it changed.  This project is a prototype: the
version number says how usable it is, not how finished.

## v0.1.0-alpha — 2026-10-15

First alpha.  Everything below was built after this date's earlier work on the
prototype, and the whole tree passes `make test` plus `make smoke`.

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
  window headless and asserts on the DOM.

### Bugs found and fixed before this release

Four adversarial probing rounds found 33 defects; 31 are fixed and each one is
recorded in [`docs/BUGS.md`](docs/BUGS.md) with its symptom and root cause.  The
worst were silent data loss in `board.save`, `file.write` ignoring a
wrong-typed `base_revision`, and validation that was quadratic in the number of
cards (20 000 cards: 72.59 s → 0.81 s).

### Verification

`make check` (9 passed, 0 failed, 4 skipped), `make fullcheck` (13/0/0),
`make probe` (43 checks, all ok), `make smoke` (5/0, real browser), the C JSON
test, `langs/selftest.mjs` (87/87) and `shell/web/selftest.mjs` (60/60).  Two
defects are recorded as **not** fixed in `docs/BUGS.md`; the browser suite has
no pointer or focus coverage, and says so in its own output.

### Known limits

- Windows only: `core/port/` has one implementation (`sys_win32.c`,
  `proc_win32.c`).  The port layer is the only OS-aware code.
- No undo/redo yet.
- The card-kind hook is fork-time only: there is no plugin loading.
- CI (`.github/workflows/ci.yml`) is written but has never run on a GitHub
  runner — it was authored on a machine without one.  Its steps are exactly the
  local commands above.
