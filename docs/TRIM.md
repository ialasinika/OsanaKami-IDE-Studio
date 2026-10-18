# Trimming the kernel

OsanaKami IDE Studio is built to be cut down. Every subsystem in `core/` is a whole module with
a stated cost of removal, and the seed of that list is compiled into the binary —
`infantgod modules` prints it.

Run it yourself:

```sh
build/infantgod.exe modules
```

This document explains the removal procedure, shows the exact output, and states
what a trimmed kernel still does.

---

## The procedure: four places

`core/src/main.c`'s header comment names the complete set:

> `infantgod modules` prints the trim manifest below. That table, plus the SRC list
> in the Makefile and the method table in rpc.c, is the complete list of places a
> fork touches to remove a subsystem.

So removing a module is four edits. Using `exec` as the worked example:

**1. The file under `core/`.**

```sh
git rm core/src/exec.c
```

If it is one of the platform modules, the file lives under `core/port/` instead
(`sys_win32.c`, `proc_win32.c`). If the module is referenced by a header, remove
the header too (`core/include/exec.h`) and every `#include` of it.

**2. The `SRC` line in `Makefile`.**

```make
SRC = \
	core/src/buf.c \
	core/src/vec.c \
	core/src/json.c \
	core/src/wksp.c \
	core/src/view.c \
	core/src/exec.c \      <-- delete this line
	core/src/rpc.c \
	core/src/serve.c \
	core/src/app.c \
	core/src/main.c
```

The objects are derived from `SRC` (`OBJ = $(addprefix $(OBJDIR)/,$(notdir
$(SRC:.c=.o)))`), so nothing else in the Makefile needs to change — no target
lists the module by name.

**3. The module table in `core/src/main.c`.**

Delete the module's entry from `sde_module_table[]`, between line 34 and line 76.
The table is terminated by `{ NULL, NULL, NULL, 0 }`, and `sde_modules()` derives
its count from `sizeof(table)/sizeof(table[0]) - 1u`, so the count stays correct
as long as the terminator survives.

**4. Any method in `core/src/rpc.c` that calls it.**

For `exec` that is the `#if SDE_WITH_EXEC` block and its three table rows:

```c
#if SDE_WITH_EXEC
    { "exec.start",     h_exec_start },
    { "exec.stop",      h_exec_stop },
    { "exec.list",      h_exec_list },
#endif
```

There is a cheaper alternative to edit 4, and it is the one the code already
supports: instead of deleting the methods, flip the switch in
`core/include/infantgod_cfg.h`.

```c
/* Compile-time switches a fork flips to cut whole subsystems out. */
#ifndef SDE_WITH_EXEC
#define SDE_WITH_EXEC 1
#endif
#ifndef SDE_WITH_VIEW
#define SDE_WITH_VIEW 1
#endif
```

Setting `SDE_WITH_EXEC 0` removes `exec.start`, `exec.stop` and `exec.list` from
the table at compile time and lets the linker drop the handlers — but you must
*still* delete the `SRC` line and the file, because otherwise `exec.c` is
compiled into the binary with no caller. The switch is what makes the
`rpc.c` edit mechanical; the `SRC` edit is what makes the binary smaller.

Two subsystems also touch other modules' initialisation. `wksp` and `view` are
constructed in `core/src/app.c`; `exec` is created and bound there too:

```c
app->execs = sde_execset_new();
...
/* Lets the exec pump thread publish notifications through app->emit. */
sde_exec_bind(app->execs, app);
```

If you delete `exec`, delete that block from `app.c` as part of edit 1 — the
"four places" is the minimum, not a guarantee that no file outside `core/src/`
names the module. Grep is the honest answer:

```sh
grep -rn "sde_exec" core/
```

---

## The trim manifest, verbatim

`infantgod modules` on this build prints exactly this:

```text
InfantGod Studio kernel 0.1.2-beta -- 10 source modules
To drop one: delete its line in the Makefile SRC list, its file
under core/, and any method in rpc.c that calls it.

buf      [required]
         growable byte buffer, the kernel's only string type
         cut it and: nothing builds: every other module formats through it

vec      [required]
         growable pointer array, used for lists without a fixed bound
         cut it and: nothing builds

json     [required]
         JSON parse/serialise; the protocol's value type
         cut it and: nothing builds

port     [required]
         the platform boundary: files, paths, threads, processes
         cut it and: nothing builds; this is the layer a fork replaces to leave Win32

wksp     [optional]
         workspace reads/writes, path containment, content revisions
         cut it and: files can no longer be opened or saved; the client is left with what it holds

view     [optional]
         the client's view document: opaque JSON, atomic persistence, revisions
         cut it and: no document survives a restart; the client is left with what it holds

exec     [optional]
         child processes for `runner` cards, with streamed output
         cut it and: cards can no longer run anything

serve    [optional]
         newline-delimited JSON-RPC over stdin/stdout
         cut it and: the kernel has no way in; useful only as a linkable library

rpc      [required]
         the method table that turns frames into actions
         cut it and: nothing is callable; keep it and the kernel has no verbs

app      [required]
         constructs and owns the shared state modules are handed
         cut it and: nothing builds

6 of these cannot be cut without breaking the build; the rest
are whole subsystems.
```

### As a table

| module | status | what it is | cost of cutting it |
| --- | --- | --- | --- |
| `buf` | required | growable byte buffer, the kernel's only string type | nothing builds: every other module formats through it |
| `vec` | required | growable pointer array, used for lists without a fixed bound | nothing builds |
| `json` | required | JSON parse/serialise; the protocol's value type | nothing builds |
| `port` | required | the platform boundary: files, paths, threads, processes | nothing builds; this is the layer a fork replaces to leave Win32 |
| `wksp` | optional | workspace reads/writes, path containment, content revisions | files can no longer be opened or saved; the client is left with what it holds |
| `view` | optional | the client's view document: opaque JSON, atomic persistence, revisions | no document survives a restart; the client is left with what it holds |
| `exec` | optional | child processes for `runner` cards, with streamed output | cards can no longer run anything |
| `serve` | optional | newline-delimited JSON-RPC over stdin/stdout | the kernel has no way in; useful only as a linkable library |
| `rpc` | required | the method table that turns frames into actions | nothing is callable; keep it and the kernel has no verbs |
| `app` | required | constructs and owns the shared state modules are handed | nothing builds |

Six required (`buf`, `vec`, `json`, `port`, `rpc`, `app`), four optional
(`wksp`, `view`, `exec`, `serve`).

That banner still says *InfantGod Studio*: the kernel ships as a prebuilt binary and
was not rebuilt for the product rename, so its sources keep their internal names
(see the CHANGELOG, "The name").  Everything above the kernel — shell, tools,
installer, docs — is OsanaKami IDE Studio.

---

## What survives each cut

The manifest is one line per module; this is the detail behind it.

### Cutting `exec` — no processes

Delete `core/src/exec.c`, `core/include/exec.h`, its `SRC` line, its table entry,
the `#if SDE_WITH_EXEC` block in `rpc.c`, and the `sde_execset_new` /
`sde_exec_bind` calls in `core/src/app.c` (and the `execs` field of
`sde_app`). `SDE_WITH_EXEC` becomes vestigial; delete it too.

- Protocol loses `exec.start`, `exec.stop`, `exec.list`, and the `exec.output` /
  `exec.exit` notifications.
- The `runner` card in the shell has nothing to call: the runner module under
  `shell/web/cards/` becomes a dead button. Trim the kind from `CARD_KINDS` in
  `shell/web/board.mjs` and delete the runner's `registerCardKind` call from the
  `cards.mjs` barrel — the registry is the only place a kind exists.
- **Survives:** files, the board, the whole editor, the whole language layer.
- **Shell must change too:** yes, or the runner card is a control that fails.

### Cutting `view` — a document that does not persist

Delete `core/src/view.c`, `core/include/view.h`, its `SRC` line, its table entry,
the `#if SDE_WITH_VIEW` block in `rpc.c`, and the view construction in `app.c`.

- Protocol loses `view.load`, `view.save`, the `view.changed` notification, and
  the `view_path` / `view_revision` members of `workspace.info`.
- No document is written or read at any path. The client keeps whatever it holds
  in memory for the life of the process and nothing else, and `.infantgod/board.json`
  is never opened.
- **Verification note:** `tools/e2e.py` drives `view.save` against the workspace
  it is pointed at. It snapshots whatever document was already there and restores
  it when the check finishes, so a normal run leaves your layout in place — but
  the checks themselves are meaningless without `view`, so once it is cut they
  have to be dropped rather than adjusted. Another reason the cut costs more than
  it looks.
- **Survives:** files, processes, the protocol.
- **What is lost is persistence itself:** the layout stops existing between runs.
  Everything else still works; the reason to use OsanaKami IDE Studio does not.
- **Shell must change too:** yes and heavily — `board.mjs` and `main.mjs` both
  assume `view.load` / `view.save` exist, and every other client would have to
  keep its own file. `tools/seide_cli.py`'s `board` verb is that second client:
  with no document it prints only what it was handed. The classic view goes with
  the board for free: `classicLayout` is a projection of the shell's board model,
  so with no document there is nothing to project.

### Cutting `wksp` — cards with no files behind them

Delete `core/src/wksp.c`, `core/include/wksp.h`, its `SRC` line, its table entry,
and the `workspace.info` / `workspace.list` / `file.read` / `file.write` /
`file.stat` methods plus their five table rows in `rpc.c`.

- Protocol loses those five methods, the `file.changed` notification, and the
  `root` / `name` / `file_count` members of `workspace.info`.
- **Or keep `wksp` and cut only `file.stat`:** the shell is built for that. Its
  watcher recognises `-32601` (`watchTrimmed` in `shell/web/watch.mjs`), stops
  asking and logs one line, so a trimmed kernel costs the live-reload behaviour
  and nothing else. `tools/kernel_probe.py` skips its `file.stat` block the same
  way.
- `exec.start`'s `cwd` resolution goes through `sde_wksp_resolve`, so `exec`
  depends on `wksp`; cutting `wksp` means changing `exec.start` too (either
  refusing a relative `cwd` or resolving it against the process's own directory).
- **Survives:** the board, links, notes, and the whole layout mechanism.
- **Shell must change too:** yes — the `editor`, `files` and `project` card kinds
  have nothing to call, so all three renderers must go.

### Cutting `serve` — a library, not a program

Delete `core/src/serve.c`, `core/include/serve.h`, its `SRC` line, its table
entry, and the `rpc` subcommand in `main.c`. The kernel then has no transport:
`infantgod rpc` does not exist, and the process has no way to receive a frame.

- **Survives:** everything the kernel *can* do, as a linkable library. Nothing
  outside the process can reach it.
- **Shell must change too:** yes — `shell/main.mjs` spawns `build/infantgod.exe rpc`
  and there is no such mode.

### Cutting the required modules

`buf`, `vec`, `json`, `port`, `rpc` and `app` are the substrate. `json` is the
protocol's value type, `buf` is the only string type, `vec` backs every
unbounded list, `port` is the only OS-aware code, `rpc` is the method dispatch
and the frame envelope, and `app` is the shared state the rest are handed. There
is no smaller working kernel than these six; a fork that wants a smaller one is
writing a new program and using this one as a reference.

---

## Removing the language layer (a non-kernel trim)

`langs/` is not in the manifest because it is not in the kernel. To remove
language support entirely:

```sh
rm -rf langs/
```

and, in `shell/main.mjs`, the dynamic import already falls back to
`PlainLanguages`, which reports `{"langs":[]}` from `lang.list` and returns one
`plain` token covering the input from `lang.tokenize`. The editor cards render
plain text. Nothing in `core/` changes; the build is unaffected.

The **wire contract** for those two methods is documented in
`docs/PROTOCOL.md`. A fork that wants to reimplement colouring in another
language implements those two methods and can ignore `langs/` entirely.

---

## Cross-links

- `docs/FORK.md` — the removal procedure as one step of the fork playbook, plus
  the moves that are not removals (renaming, replacing the platform layer,
  shipping a real window) and what each costs.
- `docs/ARCHITECTURE.md` — the module inventory in context, and why the kernel
  is language-agnostic.
- `docs/PROTOCOL.md` — what the protocol looks like after each cut, method by
  method, including the compile-time switches.
