# `shell/web/` — the InfantGod Studio board UI

This directory is the entire front end. It is served straight off disk by
`node shell/main.mjs serve` on `http://127.0.0.1:<port>/`, with no build step
and no dependencies: the browser loads these ES modules as written.

```
index.html    the single page; no inline logic
style.css     the whole look
rpc.mjs       POST /rpc + GET /events client (SSE framing, RpcError)
board.mjs     the board document, viewport, selection and mutations
history.mjs   the undo ring: document snapshots, coalescing, redo branch
watch.mjs     what a card should do when the file moves under it (pure)
cards.mjs     one renderer per card kind + the pure helpers
classic.mjs   the same cards as a code area, tabs and a sidebar (pure)
views.mjs     the views by name, and what the HUD says in each (pure)
modview.mjs   the same cards as a package tree, editor and problems (pure)
main.mjs      bootstrap: gestures, command line, log, dirty state
selftest.mjs  node shell/web/selftest.mjs -- no DOM, no network
```

---

## The board paradigm

There are **no tabs and no file tree**. The main surface is one persistent,
pannable, zoomable 2-D space, and everything you work on is a **card** placed at
a point in it. Opening a file does not add a tab; it puts a card somewhere on
the plane. Closing a card does not lose the file; it removes a rectangle.

There are two more arrangements, and each is a *view*: `mode classic` lays the
same cards out as a code area, a tab strip and, when the board has a
`project`/`files` card to spare, a sidebar ([the classic
view](#the-same-cards-as-a-code-area-mode-classic)); `mode mod` lays them out as
a package tree, the editor, and the problems the mod reports ([the mod
workbench](#the-board-as-a-mod-workbench-mode-mod)). Neither creates a card,
moves a card or saves anything — the tabs are the editor cards, in board order.
The board is the document; the views are what you can do with it.

A window opens in `classic`, and the HUD switch offers `classic` and `mod`
(`views.mjs`'s `DEFAULT_VIEW` and `SWITCH_VIEWS`). The board is still a mode —
`mode board` draws every card exactly where the document put it, and nothing
about it was removed — but it is not a button: its arrangement only means
something once you have dragged cards into it, and nothing here asks you to.

The layout *is* project data. It lives in `.infantgod/board.json` next to your
sources, so the IDE remembers a spatial arrangement — what you had open, where
you put it, what was linked to what — rather than a tab history. Two people on
the same repository open the same board.

This directory is a **reference implementation** of one view. The schema, the
path and the ids are all decided here (`board.mjs` owns `BOARD_PATH`, the
`isValidCard`/`normaliseDocument` rules and `makeId`); the kernel is handed the
document and stores it without reading it, so another client can keep a
different document at a different path, or draw this one another way, without
touching `core/` — [`docs/VIEWS.md`](../../docs/VIEWS.md).

The command line at the bottom is the only place commands live. It is not a
modal palette and not a fuzzy finder popup: it stays where it is, it acts on the
currently focused card, and every message it has for you is appended to the log.

**The log starts folded away, and `log` toggles it.** It is the app's only voice
— there are no dialogs, so nothing ever covers what you are reading — but a strip
of running commentary under the code is the tool of the person writing the code,
not of the person using it. The HUD's `log` button (`#log-toggle`) unfolds it and
the same button folds it back. A line that arrives while it is folded turns the
button into a count and colours it by the worst line waiting, so nothing fails in
silence and nothing is in the way; unfolding clears the count. An `error` is the
one thing that will not wait to be noticed: it opens the strip by itself.

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
| wheel / shift+wheel | pan |
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
save [force]             write .infantgod/board.json
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
| `history.mjs` | `Ctrl+Z` stops existing: every gesture still edits the board, but nothing is remembered, and the undo ring starts empty. |
| `watch.mjs` | nothing polls for changes made outside the app. Cards still read and write files; a file rewritten by another program is simply not noticed until the card is reopened. |
| `classic.mjs` | the board works as always, but there is no conventional-IDE arrangement: no code area, no tab strip, no sidebar column, and `mode classic` is not a mode. |
| `views.mjs` | the views have no names and the HUD cannot say which one is on, so the mode switch goes and `mode classic` / `mode mod` are no longer modes. |
| `modview.mjs` | the board works as always, but there is no mod workbench: no package tree, no report panel, and `mode mod` is not a mode. |
| `style.css` | the board still works, but it renders as unstyled white boxes stacked at the origin. The editor's colour layer and text layer stop lining up. |
| `main.mjs` | `index.html` has nothing to boot: a blank dark page. |
| `index.html` | nothing is served at `/`; `main.mjs` is still a valid module. |
| `selftest.mjs` | nothing at runtime. You lose the only check that the protocol plumbing still works. |

`main.mjs` is the only file that imports the other five, which is what keeps
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
answers `STALE_REVISION`, and InfantGod Studio does **not** silently overwrite:

* the card's status line says the file changed on disk, and
* a row of buttons appears above the command line — *reload from disk*,
  *overwrite*, *leave it* — and

your text stays in the card either way. An unsaved buffer is never discarded
implicitly: reloading a dirty editor card refuses and tells you to press ctrl+S
first.

The board document is protected the same way: an autosave fires 1.5 s after the
last layout change, and a `STALE_REVISION` on the board keeps your layout in
memory and asks you to type `save force`.

### A file that changes outside the app

`STALE_REVISION` only helps if somebody *tries* to write. A file rewritten by
`git checkout`, by a formatter or by another editor announces nothing, so the
shell polls `file.stat` every 1.5 s (`WATCH_POLL_MS`) for the paths its cards
hold, and `watch.mjs` — pure, no DOM, no clock — decides what each answer means:

| the card holds | the file on disk | what happens |
| --- | --- | --- |
| a revision | the same revision | nothing |
| a revision, no unsaved edits | a different revision | the card **reloads** and its status says `reloaded from disk` |
| a revision, unsaved edits | a different revision | the text **stays**; the status says `changed on disk (rev …) · ^S overwrites` |
| a revision | nothing (`exists: false`), or a directory | the status says `gone from disk · ^S writes it back`; the text stays |
| a revision | a revision the kernel cannot give (`0`: binary, or over 4 MiB) | a warn, never a reload — "cannot compare" is not "unchanged" |
| no revision yet | anything | nothing: a card that has not read the file is a version of nothing |

Two rules keep this from being noise. A decision is acted on only when it is
**news** (`watchReport` compares a `decision:revision` signature against the
previous poll, so a card warns once, not every tick), and a path held by three
cards is **one** `file.stat`, with the decision applied per card — a clean card
reloading is exactly what leaves a dirty one alone.

This is deliberately polled: the kernel never walks the workspace on a timer of
its own, and the protocol does not promise a filesystem watcher. A kernel that
has been **trimmed** and has no `file.stat` at all is answered politely rather
than fatally — `watchTrimmed` recognises `-32601` and the shell stops asking and
logs one line, because a smaller kernel is not a broken one.

### The editor card's own keys

The editor card answers the keys a person reaches for before trusting a text box:

| key | what it does |
| --- | --- |
| `Tab` | indents the lines the selection touches, or inserts one unit at the caret when there is no selection |
| `Shift+Tab` | outdents those lines, or removes one unit before the caret |
| `Enter` | keeps the current line's indentation, and steps in one more level after `{`, `(` or `[` |
| `Ctrl+F` | opens the in-card find bar: query, live `3 / 7` count, previous, next, a replacement box, Replace, Replace All |
| `Esc` | closes the find bar |

`Enter` splits by the line **up to the caret**, not the whole line, so pressing it
in the middle of a deeply indented line does not leave the tail indented.

Matches are painted as well as selected. Colours live in the `<pre>` behind the
transparent textarea, so a hit is drawn there as a `<mark>` — the token spans are
**split** at the hit boundaries (`markHits`) rather than replaced, which keeps the
colours inside the hit and the hit visible while the caret sits in the find bar.

Every edit the card makes on your behalf — the indent, the auto-indent, Replace,
Replace All — goes in through `document.execCommand("insertText")` over the
selected range rather than by assigning to `.value`. Assigning to `.value` throws
away the browser's undo stack, so `Ctrl+Z` after a `Tab` or a Replace All would
have cleared the whole file; the insert command is the one way to have both a
programmatic edit and a real undo step. `tools/input_smoke.py` presses those keys
in a real window and checks the undo stack afterwards.

The arithmetic is pure and exported — `indentSelection`, `indentAfterEnter`,
`findMatches`, `replaceMatchAt`, `replaceAllMatches`, `markHits` — and
`shell/web/selftest.mjs` checks it with no DOM at all.

### Line numbers

The editor draws a gutter down its left: one number per line, `1` at the top, and
it is **on** when a file is opened — the answer to "where am I" should not have to
be asked for first. Clicking the gutter hides it, clicking it again brings it
back, and hiding it hands its columns to the code rather than leaving a gap.

The numbers live in one `<pre>` (`ed-gutter-numbers`) whose text is rewritten only
when the number of lines changes, not in one element per line: `paintGutter` sets
`gutter.dataset.lines` and returns early when that is what it already was, so a
four-thousand-line file costs one string and a scroll costs no reflow. The numbers
share the code's font, leading and line box (`ed-gutter-numbers` and the `pre`
behind the textarea are the same box), so they cannot drift out of step with the
text they count.

It is a **view, not a document**. The state (`state.gutterOn`) lives in the card,
starts on, and is never written to `board.json`: no card moves, nothing joins the
undo ring, and two windows may disagree about the gutter without either being
wrong. `showGutter` flips `data-on` on the gutter, `has-gutter`/`no-gutter` on the
surface and the gutter's own `title`, so a reader who hovers it is told what a
click will do. The wheel still belongs to the card's scroll region, so the gutter
is not a second place where a wheel means something else.

`tools/input_smoke.py` reads the gutter back out of a real window — one number per
line, the last one matching the file — and clicks it off and back on, because
neither the painted height nor a click is visible to a DOM-less test.

### The same cards as a code area: `mode classic`

A window **opens here**: `DEFAULT_VIEW` in `views.mjs` names this mode, and the
board is the one that has to be asked for. `mode classic` — or the `Classic`
button in the HUD's view switch, whose buttons come from `SWITCH_VIEWS` and whose
current one is marked — draws the board a second way:

| part | which card | where |
| --- | --- | --- |
| sidebar | the first `project` card, else the first `files` card, else nothing | the left column, `CLASSIC_SIDEBAR_W` (280 px) wide, `CLASSIC_SIDEBAR_MIN` (160 px) at the least, and never more than 40% of the board |
| tab strip | every `editor` card, in board order | `CLASSIC_TAB_H` (34 px) under the HUD, right of the sidebar |
| code area | the focused `editor` card, else the first editor | all that is left below the strip |

Every other card is **hidden, not unmounted** (`.card.is-hidden`), so a card's
text, its scroll position and its listeners survive a walk through the view and
back. The rules are pure and exported from `classic.mjs` —
`CLASSIC_SIDEBAR_KINDS`, `CLASSIC_SIDEBAR_W`, `CLASSIC_SIDEBAR_MIN`,
`CLASSIC_TAB_H`, `classicTabLabel`, `classicRoles`, `classicLayout` — so
`selftest.mjs` pins them with no DOM and `input_smoke.py` measures the same
rectangles in a real window. The view's *name* and its HUD reading come from
`views.mjs`, next to the mod view's.

What the mode deliberately does **not** do: it writes nothing (the document keeps
its `x`/`y`/`w`/`h`, so `mode board` restores the pan, the zoom and every
overlap); clicking in it selects but never raises or moves a card, so a first
visit cannot dirty the board; it has no keyboard shortcut, because a hidden
keystroke is not discoverable; and the wheel stays the board's gesture, so the
classic view has no pan and no zoom and the HUD says `no zoom` rather than
quoting a number that no longer describes the screen. A window `resize` while
the mode is on re-measures the tile. A card with no role is a card with no box:
the caller hides it rather than drawing it at 0,0.

### The board as a mod workbench: `mode mod`

`mode mod` draws the same cards a third way — the package tree on the left, the
file in the middle, and what validation says about it underneath:

| part | which card | where |
| --- | --- | --- |
| package tree | the first `mod` card, else the first `project` card, else the first `files` card | the left column, `MOD_SIDEBAR_W` (320 px) wide, `MOD_SIDEBAR_MIN` (180 px) at the least, and never more than 40% of the board |
| tab strip | every `editor` card, in board order | `MOD_TAB_H` (34 px) under the HUD, right of the tree |
| code area | the focused `editor` card, else the first editor | all that is left of the column above the report |
| report | the first `problems` card | along the foot of the column, `MOD_PANEL_H` (200 px) at its tallest and `MOD_PANEL_MIN` (80 px) at its shortest |

The difference from the classic view is what it is *for*. There, the sidebar is
whatever card happened to be a project; here the tree is a mod **package** — the
manifest, the defines and the Yarn — and the panel is the validator's output, so
the errors sit under the file they are about instead of floating somewhere on the
plane. Which card takes which place is the same rule as everywhere else: the
*first* card of a kind, in board order, so a second `mod` or `problems` card
stays on the board and is merely hidden while the mode is on.

`mode mod` is the same kind of thing as `mode classic`: a view, not a document.
It writes nothing, moves nothing, hides what has no role rather than unmounting
it, and refuses to raise a card on a click, so a first visit cannot dirty the
board. It keeps the wheel, too: no pan, no zoom, and the HUD says `no zoom`
rather than quoting a number that no longer describes the screen. A window
`resize` while the mode is on re-measures the tile.

The panel is the only part that can disappear. A window too short for both drops
it and gives the height back to the code — rather than squeezing the editor into
a slit to keep a two-line report on screen — and `MOD_AREA_MIN` (140 px) is where
that happens. A board with no `problems` card has no panel at all, and a board
with no `mod`, `project` or `files` card has no tree: an empty column is 320
pixels of nothing, so the code area takes the width instead. A card with no role
is a card with no box, and the caller hides it rather than drawing it at 0,0.

The rules are pure and exported from `modview.mjs` — `modRoles`, `modLayout`,
`MOD_SIDEBAR_KINDS`, `MOD_PANEL_KINDS`, `MOD_SIDEBAR_W`, `MOD_SIDEBAR_MIN`,
`MOD_TAB_H`, `MOD_PANEL_H`, `MOD_PANEL_MIN`, `MOD_AREA_MIN` — so `selftest.mjs`
pins them with no DOM and `input_smoke.py` measures the same rectangles in a real
window. What every view *is called* and what the HUD says in it lives one file
over, in `views.mjs` (`VIEWS`, `VIEW_LABELS`, `viewName`, `tiledView`, `viewHud`,
`viewNote`, `viewAbout`), so the two tiles cannot disagree about what a mode is
named: the HUD's switch is built from `VIEWS`, one button per view, and a view
added to that list is reachable by mouse and by `mode <name>` at once.

What it deliberately does **not** do: it does not build, validate, edit a define
or write a Yarn file — those are the cards' jobs (`mod`, `problems`, `docs`), and
the view only decides where they are drawn. It has no keyboard shortcut, for the
same reason the classic view has none: a hidden keystroke is not discoverable.

### Known limitations (deliberate, documented rather than hidden)

* `lang.tokenize` returns **JS string indices** (UTF-16 code units of the string
  that was sent), not UTF-8 byte offsets. This is what makes Yarn colouring land
  on Chinese prose instead of drifting by one glyph per multi-byte character;
  the upstream README's "byte offsets" claim was wrong, and `langs/selftest.mjs`
  pins the gap over a shipped CJK fixture. The Python side is not a residue:
  `tools/e2e.py` measures its fixtures with `js_length` — UTF-16 code units, the
  same space as the spans — and judges every span against that, so its tiling
  check stays honest even for an astral character. What would drift is any *new*
  check that compared a wire span to `len()`, which counts code points.
* The colour layer and the text layer must share identical metrics. That is
  enforced from `style.css` (`--code-*`), so a card zoomed far out will scale
  them together, but a browser that substitutes a different font for one layer
  only would shear the two apart.
* Links are straight lines. There is no router, no obstacle avoidance and no
  automatic layout: where you put a card is where it stays. The only arrangements
  seIDE computes are the two tiled views' — and they are views, not layouts: each
  is drawn from the document and never saved into it.
* Output from a long-running command is capped (200 000 characters / 2 000
  lines); the head is dropped and the card says how much went.
* Undo covers the **board**, not the text inside a card. `Ctrl+Z` (or `undo`)
  takes back the last card or link change; a textarea keeps its own undo stack,
  so typing in a note or an editor is the browser's business. The steps live in
  memory (`history.mjs`) and a reload forgets them.
* The editor card's keys stop where a text box stops: **one** undo step per
  programmatic edit (a `Tab` or a Replace All is one step, not a character at a
  time), no per-key bindings, no code folding, and the find bar is **literal
  text only** — no regular expressions, no match-case and no whole-word toggles.
* The tiled views are **views**: no split panes, no drag-to-resize on the sidebar
  or the report panel, no per-tab close (a card has no close, and the strip is
  rebuilt from the board on every render), no tab reordering that survives
  anything, no second layout to save, and no effect on the protocol or on
  `board.json`. Hide a card and it is still open; the board is what is real. The
  mod view adds no second panel of its own: the report *is* a `problems` card, so
  a bottom panel that is not on the board does not exist, and `problems <dir>` is
  what puts one there.

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
round-trips, document repair, viewport clamping, the views (what each mode is
called, what its HUD says, which card plays which part in the classic and the mod
tile, the label a tab gets, and a tile that leaves no gap or overlap and stays
inside the viewport at several sizes, including the mod report panel dropping out
when the window is too short for it), the
watcher's decision table (a clean card adopts new bytes, a dirty one is only
warned, a revision that cannot be compared is never a reload, and one piece of
news is reported once), and token-span application to a string. It prints
`ok N/N` and exits non-zero if anything fails.
