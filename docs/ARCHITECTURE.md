# Architecture

InfantGod Studio is three layers in three languages, connected by one frozen protocol.
This document describes what each layer is, how the processes are arranged, and
why the kernel deliberately knows nothing about programming languages.

---

## The three layers

| layer | directory | language | what it is |
| --- | --- | --- | --- |
| kernel | `core/` | C89 | files, board persistence, child processes, the JSON-RPC method table |
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
                 |    - board.*                |
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
| `port` | the platform boundary: files, paths, threads, processes | nothing builds; this is the layer a fork replaces to leave Win32 | no |
| `wksp` | workspace reads/writes, path containment, content revisions | files can no longer be opened or saved; only the canvas remains | yes |
| `board` | the board document: validation, atomic persistence, card ids | the canvas stops surviving restarts, which is the paradigm itself | yes |
| `exec` | child processes for `runner` cards, with streamed output | cards can no longer run anything | yes |
| `serve` | newline-delimited JSON-RPC over stdin/stdout | the kernel has no way in; useful only as a linkable library | yes |
| `rpc` | the method table that turns frames into actions | nothing is callable; keep it and the kernel has no verbs | no |
| `app` | constructs and owns the shared state modules are handed | nothing builds | no |

Ten modules. Six required (`buf`, `vec`, `json`, `port`, `rpc`, `app`), four
optional (`wksp`, `board`, `exec`, `serve`). Beyond the module table there are
two compile-time switches in `core/include/infantgod_cfg.h`:

```c
/* Compile-time switches a fork flips to cut whole subsystems out. */
#ifndef SDE_WITH_EXEC
#define SDE_WITH_EXEC 1
#endif
#ifndef SDE_WITH_BOARD
#define SDE_WITH_BOARD 1
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

`core/include/infantgod_cfg.h` must be included **first, before any system header**,
and raises two Win32 macros that the kernel depends on:

- `__USE_MINGW_ANSI_STDIO 1` — MinGW hides the C99 `snprintf`/`vsnprintf`
  family when `__STRICT_ANSI__` is set; this asks for the conforming
  implementations back.
- `_WIN32_WINNT 0x0600` — needed before `<windows.h>` so condition variables and
  `TryEnterCriticalSection` are visible.

---

## Why the kernel is language-agnostic

The kernel knows about files, boards and processes. It has **no tokenizer, no
keyword table, and no shipped grammar**. `core/include/app.h` states it:

> The kernel deliberately knows nothing about programming languages. There is no
> tokenizer, no keyword table and no shipped grammar here.

And `core/src/main.c`'s own usage text repeats it:

> Language support is deliberately not a kernel concern: `.lang` descriptors and
> the keyword tokenizer live in `langs/` and are served by the shell. The kernel
> knows nothing about programming languages.

Why is this a decision rather than an omission?

1. **It keeps the kernel honest.** Every method in `rpc.c` does one thing to
   files, processes or the board document. Nothing in C has to grow a table of
   language names, and nothing in C has to be rebuilt to support a new language.
2. **It makes language support deletable and replaceable.** `rm -rf langs/`
   leaves a kernel that still builds and a shell that still runs, rendering
   plain text. A fork that wants Rust-quality colouring can reimplement two
   methods — `lang.list` and `lang.tokenize` — in any language, anywhere, and
   delete `langs/`.
3. **The alternative was tried and rejected.** An earlier structure put the
   language layer in the kernel's process. It forced every colouring change to
   be a C rebuild, and it coupled the JSON-RPC method table to a data format
   that changes far more often than the file/board/process contract does.
4. **The wire is the seam.** `lang.list` and `lang.tokenize` have exactly the
   same shape as kernel methods, so a client cannot tell — and does not need to
   know — which layer answered. The shell multiplexes them onto one endpoint
   with one `dispatch()` function (`shell/main.mjs`), used identically by
   `infantgod rpc` (stdio) and `infantgod serve` (HTTP), so the wire behaviour cannot
   drift between the two modes.

The consequence for a forker: **language features are the cheapest thing in
this repository to change and the safest thing to delete.** The board and the
protocol are the load-bearing parts.

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
| `board.mjs` | the board model: cards, links, viewport, serialise | InfantGod Studio stops being InfantGod Studio; there is nothing to render |
| `cards.mjs` | one renderer and behaviour set per card kind | the board pans but has no cards on it |
| `rpc.mjs` | the client side of the kernel protocol | the board renders as an empty canvas |
| `main.mjs` | the only file that knows about the whole app | `index.html` has nothing to boot |
| `selftest.mjs` | `node shell/web/selftest.mjs`, no DOM, no network | nothing; it is only a test |

`board.mjs` is deliberately UI-free — no `document`, no `window`, no timer — so
the same object is used by the browser and by `selftest.mjs` under Node.

The HTTP front end serves `shell/web/` as static files, so there is no build
step between editing these modules and reloading the page. `index.html` loads
`./main.mjs` as a module, and the browser resolves the rest of the imports.

---

## What the build proves

The Makefile's verification targets, in the order `make test` runs them:

| target | command | what it proves |
| --- | --- | --- |
| `check` | `python tools/e2e.py --kernel build/infantgod.exe` | the kernel alone: protocol, files, board, exec |
| `fullcheck` | `python tools/e2e.py --kernel-cmd "node shell/main.mjs rpc --workspace ."` | the whole endpoint, including the language layer |
| `$(JSONTEST)` | `core/tests/test_json.c`, built against `json.o`/`buf.o`/`vec.o` | the JSON codec everything else trusts |
| — | `node langs/selftest.mjs` | the descriptor and tokenizer checks (approx. 74), no kernel, no browser |
| — | `node shell/web/selftest.mjs` | the protocol plumbing, board model and token spans (approx. 65 checks), no DOM |

---

## Rejected alternatives, with reasons

- **Electron.** Rejected because it means bundling a browser: hundreds of
  megabytes, a download in the build, and a Node-and-Chromium process tree. The
  prototype uses the system's Edge/Chromium in `--app=` mode with a throwaway
  profile instead. This is a prototype tradeoff, not a product answer; the
  product answer is WRY/Tauri (`docs/FORK.md`).
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
- **Binary files as JSON strings.** `wksp` refuses to read a file containing a
  NUL byte ("file is binary") because shipping it as a JSON string would produce
  a document no client can round-trip.
- **A missing or corrupt board document.** An absent `.infantgod/board.json` is
  fine (first run). A board document that **exists but does not parse** is a
  hard error: silently discarding a user's layout would be worse than refusing
  to start.
