# `shell/web/` — the seIDE board UI

This directory is the entire front end. It is served straight off disk by
`node shell/main.mjs serve` on `http://127.0.0.1:<port>/`, with no build step
and no dependencies: the browser loads these ES modules as written.

```
index.html    the single page; no inline logic
style.css     the whole look
rpc.mjs       POST /rpc + GET /events client (SSE framing, RpcError)
board.mjs     the board document, viewport, selection and mutations
history.mjs   the undo ring: document snapshots, coalescing, redo branch
cards.mjs     one renderer per card kind + the pure helpers
main.mjs      bootstrap: gestures, command line, log, dirty state
selftest.mjs  node shell/web/selftest.mjs -- no DOM, no network
```

---

## The board paradigm

There are **no tabs and no file tree**. The main surface is one persistent,
pannable, zoomable 2-D space, and everything you work on is a **card** placed at
a point in it. Opening a file does not add a tab; it puts a card somewhere on
the plane. Closing a card does not lose the file; it removes a rectangle.

The layout *is* project data. It lives in `.seide/board.json` next to your
sources, so the IDE remembers a spatial arrangement — what you had open, where
you put it, what was linked to what — rather than a tab history. Two people on
the same repository open the same board.

The command line at the bottom is the only place commands live. It is not a
modal palette and not a fuzzy finder popup: it stays where it is, it acts on the
currently focused card, and every message it has for you is appended to the log
line above it. **seIDE has no dialogs**, so nothing ever covers the board.

### Card kinds (registered, not hard-coded)

| kind | what it holds | stored fields |
| --- | --- | --- |
| `editor` | a file, with keyword colouring | `file` |
| `runner` | one command and its output | `cmd`, `cwd`, `run_id` |
| `note` | free text, part of the board | `text` |
| `files` | a workspace listing, filtered | `filter` |
| `project` | the workspace as one project: the tree plus what is open | `filter` |
| `sheet` | structured data: typed cells, not text | `title`, `doc` |

A kind exists because it was registered, and registering is one call at the end
of `cards.mjs`:

```js
registerCardKind({ kind, title, create, describe, render });
```

That is a **fork-time hook, not a plugin system** (there is no loading, no
discovery, no manifest and no sandbox): the call runs while this module graph is
evaluated. `renderCard` dispatches through the registry, so an unregistered kind
cannot crash the UI — it renders as a placeholder that names the kinds this
build does know and points at `cards.mjs`. The kernel stores unknown kinds and
their fields verbatim, so nothing is destroyed in the meantime.

`shell/web/selftest.mjs` covers the hook itself (including that a probe kind
survives a save/load round trip). The full contract, and `sheet` as a worked
example, are in [`docs/SURFACES.md`](../../docs/SURFACES.md).

### Links

Two cards can be linked (`link c1 c3 runs`), and the connection is drawn as a
straight line between their facing edges. Links are stored in the same
document, so a board can record *why* things are next to each other.

---

## Gestures

| gesture | effect |
| --- | --- |
| drag empty space | pan the board |
| wheel over a card's own contents | scroll the card (an editor, a sheet, a runner's output) |
| wheel / shift+wheel elsewhere | pan |
| ctrl/⌘ + wheel | zoom about the cursor |
| drag a card title | move the card |
| drag a card's bottom-right corner | resize the card |
| click a card | focus it; it comes to the front |
| double-click empty space | drop a new note there |
| `:` | focus the command line |
| ctrl/⌘ + S | save the board |
| ctrl/⌘ + Z | take back the last board edit |
| ctrl/⌘ + shift + Z, or ctrl/⌘ + Y | put it back |

Zoom is clamped to 20 %–400 %, and a card is clamped to 120×80 px so a card can
never be resized into something you cannot grab again.

### Command line

```
open <path>              open a file in a new editor card
note <text>              drop a note card
sheet [title]            drop a structured-data card (typed cells, not text)
run <cmd>                start a command in a runner card
files [glob]             open the file list card
project [glob]           open the project panel (the workspace as one project)
link <from> <to> [label] connect two cards
unlink <linkId>          remove a connection
zoom <n> | in | out | reset
focus <id>               select and centre a card
delete <id>              remove a card
save [force]             write .seide/board.json
undo                     take back the last board edit (Ctrl+Z)
redo                     put it back (Ctrl+Shift+Z or Ctrl+Y)
help                     list the commands
clear                    empty the log
```

An unknown command prints one line in the log and moves on. Nothing is modal,
nothing steals focus.

---

## Files, and what deleting each one costs

Each file is meant to be independently deletable; the consequence is stated so
the trade-off is explicit rather than discovered.

| file | delete it and… |
| --- | --- |
| `rpc.mjs` | nothing can reach the kernel: the board still renders and pans, but no file is read, nothing is saved, and the status light can never turn green. |
| `board.mjs` | there is no document model: cards cannot be added, moved, linked or serialised. `import` fails, so the UI does not boot. |
| `cards.mjs` | the board still pans and zooms, but it has no cards to put on it. |
| `style.css` | the board still works, but it renders as unstyled white boxes stacked at the origin. The editor's colour layer and text layer stop lining up. |
| `main.mjs` | `index.html` has nothing to boot: a blank dark page. |
| `index.html` | nothing is served at `/`; `main.mjs` is still a valid module. |
| `selftest.mjs` | nothing at runtime. You lose the only check that the protocol plumbing still works. |

`main.mjs` is the only file that imports the other four, which is what keeps
this table honest: every module below it stands on its own.

---

## Editing, dirty state and honesty about conflicts

An `editor` card holds the file text in a `<textarea>` that is **transparent**,
painted over a `<pre>` that carries the coloured spans. Re-colouring therefore
never touches the element you are typing into, so **the caret and the selection
survive every re-tokenisation**. Tokenising is debounced by 120 ms, and a reply
that arrives after you typed again is discarded.

The revision returned by `file.read` is remembered and sent back as
`base_revision` on every write. If another writer got there first the kernel
answers `STALE_REVISION`, and seIDE does **not** silently overwrite:

* the card's status line says the file changed on disk, and
* a row of buttons appears above the command line — *reload from disk*,
  *overwrite*, *leave it* — and

your text stays in the card either way. An unsaved buffer is never discarded
implicitly: reloading a dirty editor card refuses and tells you to press ctrl+S
first.

The board document is protected the same way: an autosave fires 1.5 s after the
last layout change, and a `STALE_REVISION` on the board keeps your layout in
memory and asks you to type `save force`.

### The keys inside an editor card

The card is a text editor, so it answers the keys a text editor answers, with no
dialog anywhere:

| key | what happens |
| --- | --- |
| `Tab` | indent the lines the selection touches by one step (4 spaces); a bare caret gets one step in place |
| `Shift+Tab` | take one step back off those lines: one tab, or up to four spaces |
| `Enter` | keep the line's indentation, and step in one more after a line ending in `{`, `(` or `[` |
| `Ctrl+F` | open the card's find bar: find, next/previous hit, replace, replace-all |
| `Ctrl+S` | write the file — the board's own shortcuts never fire while you type |
| `Esc` | close the find bar |

Every hit is painted in the colour layer as well as selected in the textarea, so
matches stay visible while the caret is in the find bar. The indent, auto-indent
and replace edits are inserted through the browser's own insert command instead
of assigning `.value`, because a direct write throws the textarea's undo stack
away: after a `Tab`, `Ctrl+Z` still takes that `Tab` back. The pure parts
(`indentSelection`, `indentAfterEnter`, `findMatches`, `replaceMatchAt`,
`replaceAllMatches`, `markHits`) are exported for `selftest.mjs`; the wiring is
pressed for real by `tools/input_smoke.py`.

### Known limitations (deliberate, documented rather than hidden)

* Token offsets are **string indices**, not byte offsets. `lang.tokenize` scans
  the JavaScript string it was handed, so its spans tile `0..text.length` in the
  same unit `text.length` counts (UTF-16 code units) and non-ASCII text colours
  correctly — `langs/selftest.mjs` and this directory's `selftest.mjs` both pin
  that with non-ASCII fixtures. A tokenizer written in another language, or a
  client that counts bytes, has to convert.
* The colour layer and the text layer must share identical metrics. That is
  enforced from `style.css` (`--code-*`), so a card zoomed far out will scale
  them together, but a browser that substitutes a different font for one layer
  only would shear the two apart.
* Links are straight lines. There is no router, no obstacle avoidance and no
  automatic layout: where you put a card is where it stays.
* Output from a long-running command is capped (200 000 characters / 2 000
  lines); the head is dropped and the card says how much went.
* Undo covers the **board**, not the text inside a card. `Ctrl+Z` (or `undo`)
  takes back the last card or link change; a textarea keeps its own undo stack,
  so typing in a note or an editor is the browser's business — including the
  edits the editor card makes itself, which go in as browser edits so `Ctrl+Z`
  still takes them back. The steps live in
  memory (`history.mjs`) and a reload forgets them.

---

## Kernel contract

Everything the UI knows about the outside world is in one frozen interface
(`node shell/main.mjs serve`):

* `POST /rpc` with a JSON-RPC 2.0 request `{jsonrpc:"2.0", id, method, params}`
  → `{jsonrpc:"2.0", id, result}` or `{jsonrpc:"2.0", id, error:{code, name,
  message, data}}`. A request without an `id` is a notification: the server
  answers `204 No Content`, and sending one without an `id` by mistake is the
  single easiest way to get an empty, unparseable reply.
* `GET /events` → Server-Sent Events, one `data: <json>\n\n` frame per
  notification.

`rpc.mjs` consumes `/events` with `fetch` + `response.body.getReader()` rather
than `EventSource`, and re-assembles frames on a rolling buffer, so a frame split
mid-line, mid-JSON or mid-UTF-8 across chunk boundaries still arrives intact.
`RpcError` carries `code`, `errorName`, `message` and `data`, and it recognises a
stale write whether the endpoint puts the symbol in `name`, in `code` or in
`data`.

If `/rpc` is unreachable, the page shows a **"kernel not reachable"** card with a
retry button, the status light turns red, the UI stays fully interactive, and it
keeps retrying with backoff. There is never a blank page and never a
console-only error.

---

## Self-test

```sh
node shell/web/selftest.mjs
```

It imports the pure parts of the shell and drives them against a fake SSE stream
with no DOM and no network: chunk-split frame reassembly, `RpcError` mapping,
`STALE_REVISION` surfacing `data.current_revision`, board add/move/link/serialize
round-trips, document repair, viewport clamping, and token-span application to a
string. It prints `ok N/N` and exits non-zero if anything fails.
