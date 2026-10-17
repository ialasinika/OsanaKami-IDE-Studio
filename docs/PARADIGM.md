# The board paradigm

This document explains the one design decision that makes OsanaKami IDE Studio unlike every
IDE you have used: **the cards are a persistent document, and every arrangement
you look at is a projection of it.**

Everything else follows from that. If you disagree with this document, fork the
project and change it — but change it knowingly, because several other decisions
(card kinds, the command line, the board file) only make sense in this frame.

This is the paradigm of **one document, two tiled views**, and it is the
shell's, not the kernel's: the kernel defines that a view document exists and how
it is stored, and nothing about what is in it. If you want a different main
surface, you are replacing this document rather than fighting the core — see
[`VIEWS.md`](VIEWS.md).

A card in this document is still placed at a point with a size (`x`, `y`, `w`,
`h`), and links still connect cards to each other. The shipped shell no longer
has a canvas you can pan, zoom or drag a card across: it ships two tiled views —
`classic` (a code area, a tab strip and a sidebar) and `mod` (a package tree, the
editor and a problems report), and a window opens on `classic`. The canvas was
the first arrangement on top of the document, not the document itself, and it is
the one this product no longer draws. What the document buys you is the thing
below: what is open, and what is linked to what, survives a view.

---

## The two things OsanaKami IDE Studio removes

### No tabs

A tab strip is a **view**: it has an order, it runs out of room, and it holds
exactly one document in focus at a time. When the strip *is* the model, the
moment you open the fifth file you begin managing the tab strip instead of the
code. Closed tabs are gone; the only way back is the file tree and your memory of
the path.

In OsanaKami IDE Studio, opening a file creates a **card in the board document**.
Nothing closes when you open something else, and the card you opened yesterday is
still in the document, next to the note where you wrote down why you opened it.

Both shipped views do draw a tab strip, and a window opens on one of them:
`mode classic` (the default) puts the open editor cards in a row above a code
area, with a sidebar column beside them, and `mode mod` puts the same cards
around a package tree and a validation report. That exists because the request
for it was explicit and because an arrangement of a document is not a second
document — but it is a **projection**, not the paradigm. The tabs *are* the
editor cards, in document order: there is no tab that is not a card, nothing is
evicted when the sixth file opens, and the strip is rebuilt from the document on
every render. There is no other view to switch back to: `mode classic` and
`mode mod` are the two arrangements this product draws. If the tabs ever start
deciding what is open, if a card can be closed from a tab or a tab can exist
without one, this project has become the thing it was written not to be.

### No file tree

A file tree answers "where does this file live in the repository?" It does not
answer "which files am I working on, and what is the relationship between
them?" — that question is answered by the filesystem's directory layout, which
is an accident of history.

OsanaKami IDE Studio puts the tree in a card, not in the frame: the `files` card is a
filterable listing you can open (and the `project` card answers the same question
with what is already open merged in), and `workspace.list` is underneath. Neither
view's column is the repository: it is the first `project`/`files`/`mod` card the
document happens to hold, so the tree is something the document says rather than
something the window assumes. The listing is a card like any other, so you can
open three of them with different filters (`core/**/*.c`, `langs/**/*`,
`examples/*.yarn`) and leave them open without either view needing to change.

---

## The board document

The board is a document, not a mode. It is one JSON value: the cards, the
geometry each card carries, and the links between them. It has no grid you snap
to and no fixed window: the numbers live on the cards, and the views are what
turn them into rectangles on a screen.

A card's geometry is world units, and the document still carries a `viewport`
descriptor:

```json
{ "x": 0, "y": 0, "zoom": 1 }
```

`x`/`y` were the world coordinates of the top-left corner of the visible
rectangle and `zoom` was the scale factor, clamped to `[0.2, 4]` by the shell
(`ZOOM_MIN` / `ZOOM_MAX` in `shell/web/board.mjs`) with a pan limit of 100000
world units. No shipped view reads those three numbers any more: the tiled views
measure the window, not the document, and `mode board` — the view that drew the
document at its own coordinates, and the only thing that ever moved the viewport
— is gone. The field is still written and still accepted, so a `board.json` from
a build that had the board view loads unchanged, and a card's `x`/`y`/`w`/`h`
still round-trip byte for byte.

If you want the plane back it is a view away: the geometry is in the document,
`shell/web/classic.mjs` is the model of a pure projection, and
[`VIEWS.md`](VIEWS.md) is the seam. Adding it back is a rendering, not a
protocol change.

### Cards

A card is the unit of everything. In the board document a card is an object
with:

| field | meaning | enforced by |
| --- | --- | --- |
| `id` | non-empty, unique string | the board model (`shell/web/board.mjs`) |
| `kind` | non-empty string, e.g. `editor` | the board model (any string) |
| `x`, `y`, `w`, `h` | numeric geometry, world units | the board model |
| `z` | numeric stacking order, defaults to 0 | the board model's load defaults |
| any other field | stored **verbatim**, never interpreted | nothing |

The shell ships twelve kinds:

| kind | what it is | card fields it uses |
| --- | --- | --- |
| `editor` | a text editor for one file, with keyword colouring | `file` |
| `runner` | a command with its streamed output | `cmd`, `cwd`, `run_id` |
| `note` | a text area that lives in the board document | `text` |
| `files` | a filterable workspace listing | `filter` |
| `project` | the workspace as one project: what it contains, and what is open | `filter` |
| `sheet` | structured data: typed cells in a grid, not text | `title`, `doc` |
| `story` | a Yarn story beside its translation table | `file`, `table`, `schema` |
| `pixel` | a PNG canvas: the pixels are the file, not the board | `file`, `width`, `height`, `palette` |
| `spine` | a Spine rig: bones, skins, an animation timeline; posable, and the pose saves back to the rig file | `file`, `animation`, `skin`, `bones` |
| `mod` | one Mod package: its manifest and diagnostics | `dir` |
| `problems` | the diagnostics of one Mod, as a list | `root` |
| `docs` | the game's knowledge base, searched | `query` |

The board model does **not** interpret `kind`, and the kernel never sees it.
`core/include/view.h` stores any document verbatim; `shell/web/board.mjs` states
the schema, and `docs/VIEWS.md` states the seam: those twelve kinds are
conventions the shell implements, and a fork that invents `timeline` or
`waveform` changes the shell and nothing else. A card with an unknown kind still
loads, still saves, and still renders — `renderCard` in `shell/web/cards.mjs`
falls through to a placeholder that says the card is preserved in `board.json`
and lists the kinds that build does know.

Adding a kind is one registration, not a renderer plus three edits:

```js
registerCardKind({ kind: "waveform", describe, create, render });
```

See [`SURFACES.md`](SURFACES.md) for the contract, the shipped `sheet` worked
example, and what the kernel, the protocol and the board model each guarantee a
new surface.

The shell clamps cards to a minimum size of 120x80 (`MIN_SIZE`): a zero-size
card is unclickable, and an unclickable card is lost.

### Links

A link is a named connection between two cards:

```json
{ "id": "l1", "from": "c1", "to": "c2", "label": "" }
```

Both `from` and `to` must name an existing card; the board model refuses to
serialise a document where they do not, and the file then stays as it was. Links
have **no semantics** — nothing is executed along them, nothing is inferred from
them, and no shipped view draws them any more. They are still first-class in the
document: they are what records *why* two cards belong together, they survive a
view switch and a save, and the next view is free to draw them (the board view
drew them as a straight line between the midpoints of the two facing edges of the
connected cards, `linkPoints` in `shell/web/main.mjs`, which is deliberately not
a router: a straight line is enough to read a board and it never crosses the
cards it connects).

Deleting a card drops every link that touched it, in `board.mjs`'s
`removeCard`. Links pointing at a dead card
would make the next save fail the model's own serialisation check.

### The board file

The board persists to `<root>/.infantgod/board.json`. The format is JSON:

```json
{
  "version": 1,
  "viewport": { "x": 0, "y": 0, "zoom": 1 },
  "cards": [],
  "links": []
}
```

It is written **pretty-printed with a 2-space indent and a trailing newline**
because a board file is something a human diffs. It is written by serialising
to a temporary file and then atomically replacing the real one
(`sde_port_replace_file`), so an interrupted save never leaves a truncated
board behind. The board's `revision` is a content hash (FNV-1a, 32 bits) of the
serialised document, and it is the token the optimistic-concurrency checks use.
The path and the shape are the shell's conventions -- `docs/VIEWS.md` -- and the
kernel's part of this is only the atomic replace and the revision.

This file is why **the layout is part of the project state**. The document
remembers which cards are open, where the reader put them and what is linked to
what; the views are recomputed from it and never written back into it. Two
developers with different board files are working on different projects in a way
no `.gitignore`d editor state can express. Commit it or ignore it — but decide on
purpose, because OsanaKami IDE Studio's `.gitignore` ignores all of `.infantgod/` and
you may want your fork to keep `board.json`.

---

## The command line

At the bottom of the window is a single non-modal input line. It is not a
palette that steals focus and it is not a menu; it is a place to type a verb.

- Press `:` anywhere outside a text field to focus it. `Escape` clears and
  blurs it. `Tab` completes a command name. `ArrowUp` shows the last non-error
  log line as a hint. Typing a known verb shows its usage.
- Verbs are `open`, `note`, `run`, `files`, `project`, `link`, `unlink`,
  `focus`, `delete`, `save`, `help`, `clear` (`KNOWN_COMMANDS` in
  `shell/web/main.mjs`).
- `delete` with no argument acts on the **focused card**. That is the only
  place the command line reaches for the selection, and it is the intended
  pattern: the command line acts on what you are looking at.
- `note`, `files` and `project` create a card in the document, and the view is
  what decides where that card appears: neither tiled view reads `x`/`y`, so a
  new card is not placed at the origin and is not placed where a viewport
  happened to be either.

The authoritative help text lives in `COMMAND_HELP` in `shell/web/cards.mjs`,
kept there (per its own comment) so the README and the UI agree.

The command line is the same surface whatever the window is showing and with
nothing selected. That is the point: it does not care what is in front of it, so
it never becomes unusable because the thing you need is buried.

---

## What this buys

- **The layout is the document.** You stop navigating to a file and start
  having it in the document: what is open survives a view switch, a reload and a
  save, and it is the same list in both views.
- **No context destruction.** Opening a fifth file does not evict the fourth.
  The tab strip is drawn from the document, so it cannot decide what is open.
- **Relationships are first-class.** A link between a Yarn script card and the
  `mod` card for the package it ships in is stored in the document, so a view
  that draws it needs no build-system file to say so.
- **One document, two views.** `classic` and `mod` are projections of the same
  cards; switching is a rendering, and neither can lose an edit.
- **The state is a file.** The layout is data, so it can be diffed, reviewed,
  merged and generated.

## What it costs

- **A card can be off the screen and stay there.** The views draw the cards that
  have a role in the tile; every other card is hidden, not closed, and the only
  way to reach it is the command line (`focus <id>`, which requires its id) or
  the view that does give it a place. There is no overview panel to save you.
- **The arrangement is the view's, not yours.** Nothing lets you drag a card
  somewhere and have it stay: both views compute the rectangles, and the
  document's own `x`/`y` are carried but not drawn. If you want the plane back,
  it is a view to write.
- **Undo stops at the document.** `Ctrl+Z` takes back card and link edits, not
  the typing inside a card (the textarea keeps its own stack). The ring is in
  memory, so a reload forgets it.
- **Keyboard-only navigation is weak.** The command line is a single line with
  a single focus model; there is no chord language, no keyboard card
  switching, and no search across the document.
- **Small screens suffer.** A tiled view wants width for the column and height
  for the code; the mod view's report panel drops out below `MOD_AREA_MIN`,
  and the code area is what is left.
- **Collaboration is worse, not better.** One board file means one layout, and
  two people editing it concurrently get `STALE_REVISION`, not a merge.

---

## Contrast with mainstream IDEs, concretely

| concern | mainstream IDE | OsanaKami IDE Studio |
| --- | --- | --- |
| Where is my file? | in the tree, at its path | in the document; the tree is a `files` card, and both views' columns are a `project`/`files`/`mod` card |
| Which files am I working on? | the open tabs | the cards in the document; the tab strip is those cards, drawn |
| What happens when I open one more? | a tab; something may be evicted | a card; nothing is ever evicted |
| How do I relate two files? | a symbol, an import, a comment | a link stored between two cards |
| How do I run something? | a run configuration dialog | a `runner` card, or `run <cmd>` |
| Where do scratch notes go? | nowhere; a comment or an external app | a `note` card in the board document |
| What does the layout express? | nothing | which pieces belong together |
| How do I extend it? | write a plugin against an API | fork the repository and edit the source |
| What is persisted? | editor settings, open-tab session | the whole document, as `board.json` |

The comparison that matters: in a tabbed IDE, the layout is a **transient view**
of the filesystem. In OsanaKami IDE Studio, the layout is **part of the work** — the
document is the thing that persists, and both views are drawn from it.

---

## Where this design is not finished

Honesty is part of the paradigm, not a disclaimer bolted on. As of this
prototype:

- There is no canvas view to pan, no zoom, no "fit board to window" and no
  minimap: the geometry is in the document, and neither shipped view draws it.
- There is no rubber-band multi-select and no multi-card operations.
- The watcher is a **poll, not a filesystem notification**: the kernel emits
  `file.changed` only for writes it made itself, so the shell asks `file.stat`
  every 1.5 s about the files open editor cards hold. A change is therefore
  noticed up to 1.5 s late, and never for a file no open card holds;
  `shell/web/watch.mjs` is the pure decision table and
  [`shell/web/README.md`](../shell/web/README.md) says what each answer means.
- Links carry a label but nothing consumes them, and no shipped view draws them.
- Card kinds are registered with one call (`registerCardKind`) rather than edited
  into a switch, but there is still no plugin system: no loading, no discovery,
  no manifest, no sandbox (constraint 3). Registering happens while the shell's
  module graph is evaluated, so it is a fork-time hook, not a runtime one.
- The `sheet` kind is one structured surface, not a general structured-editing
  framework: no formulas, no sorting, no selection ranges, and its column types
  are fixed at four. A committed cell edit is a board edit, so `Ctrl+Z` reaches
  it; the keystrokes that compose it are the textarea's own undo.
- The editor colours text in the encoding the browser uses, which is not the
  encoding Python and C use. `lang.tokenize` returns JS string indices (UTF-16
  code units), which is what makes Chinese prose highlight correctly — the
  upstream README's "byte offsets" claim was simply wrong. `tools/e2e.py`
  measures its fixtures in the same space (`js_length` counts UTF-16 code units,
  not Python code points), so its tiling check stays honest even for an astral
  character; what would drift is any *new* check that compared wire spans to
  `len(text)`. The shipped fixture is exercised by `node langs/selftest.mjs`,
  which pins the unit/byte gap and the `0..text.length` tiling.
