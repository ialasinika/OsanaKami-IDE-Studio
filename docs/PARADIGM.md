# The board paradigm

This document explains the one design decision that makes seIDE unlike every
IDE you have used: **the main surface is a persistent 2-D canvas, not a set of
tabs over a file tree.**

Everything else follows from that. If you disagree with this document, fork the
project and change it — but change it knowingly, because several other decisions
(card kinds, the command line, the board file) only make sense in this frame.

---

## The two things seIDE removes

### No tabs

A tab strip is a **stack**: it has an order, it runs out of room, and it holds
exactly one document in focus at a time. The moment you open the fifth file you
begin managing the tab strip instead of the code. Closed tabs are gone; the
only way back is the file tree and your memory of the path.

In seIDE, opening a file creates a **card at a point on the canvas**. Nothing
closes when you open something else. The card you opened yesterday is still
where you left it, next to the note where you wrote down why you opened it.

### No file tree

A file tree answers "where does this file live in the repository?" It does not
answer "which files am I working on, and what is the relationship between
them?" — that question is answered by the filesystem's directory layout, which
is an accident of history.

seIDE replaces the tree with the `files` card: a filterable listing you place
where you want it, and `workspace.list` underneath. The listing is a card like
any other, so you can open three of them with different filters
(`core/**/*.c`, `langs/**/*`, `examples/*.bf`) and leave them open.

---

## The board

The board is an unbounded plane. It is not a grid you snap to and not a fixed
workspace; it is a plane with coordinates, and the visible rectangle over it is
the **viewport**.

A viewport is three numbers:

```json
{ "x": 0, "y": 0, "zoom": 1 }
```

`x`/`y` are the world coordinates of the top-left corner of the visible
rectangle. `zoom` is the scale factor, clamped to `[0.2, 4]` by the shell
(`ZOOM_MIN` / `ZOOM_MAX` in `shell/web/board.mjs`) and to a pan limit of
100000 world units. Panning changes `x`/`y`; zooming about the cursor changes
`zoom` while keeping the world point under the cursor fixed.

The implementation detail that makes this cheap: `#stage` in
`shell/web/index.html` carries **one** CSS transform,
`translate(tx,ty) scale(zoom)`. Panning and zooming therefore never touch a
card's own coordinates, and the SVG link overlay — which is written in world
units — stays aligned for free.

### Cards

A card is the unit of everything. In the board document a card is an object
with:

| field | meaning | enforced by |
| --- | --- | --- |
| `id` | non-empty, unique string | kernel (`core/src/board.c`) |
| `kind` | non-empty string, e.g. `editor` | kernel (any string) |
| `x`, `y`, `w`, `h` | numeric geometry, world units | kernel |
| `z` | numeric stacking order, defaults to 0 | kernel (`fill_defaults`) |
| any other field | stored **verbatim**, never interpreted | nothing |

The shell ships six kinds:

| kind | what it is | card fields it uses |
| --- | --- | --- |
| `editor` | a text editor for one file, with keyword colouring | `file` |
| `runner` | a command with its streamed output | `cmd`, `cwd`, `run_id` |
| `note` | a text area that lives in the board document | `text` |
| `files` | a filterable workspace listing | `filter` |
| `project` | the workspace as one project: what it contains, and what is open | `filter` |
| `sheet` | structured data: typed cells in a grid, not text | `title`, `doc` |

The kernel does **not** interpret `kind`. `core/include/board.h` says so
explicitly: `editor`, `runner`, `note`, `files`, `project` and `sheet` are
conventions the shell implements, and a fork that invents `timeline` or
`waveform` changes the
shell and nothing else. A card with an unknown kind still loads, still saves, and
still renders — `renderCard` in `shell/web/cards.mjs` falls through to a
placeholder that says the card is preserved in `board.json` and lists the kinds
that build does know.

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

Both `from` and `to` must name an existing card; the kernel rejects a document
where they do not. Links have **no semantics** in the prototype — nothing is
executed along them, nothing is inferred from them. They are drawn as a
straight line between the midpoints of the two facing edges of the connected
cards (`linkPoints` in `shell/web/main.mjs`), which is deliberately not a
router: a straight line is enough to read a board and it never crosses the
cards it connects.

Deleting a card drops every link that touched it, both in the kernel's
validation and in `board.mjs`'s `removeCard`. Links pointing at a dead card
would make the next save fail validation.

### The board file

The board persists to `<root>/.seide/board.json`. The format is JSON:

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

This file is why **where you put things is part of the project state**. Two
developers with different board files are working on different projects in a
way no `.gitignore`d editor state can express. Commit it or ignore it — but
decide on purpose, because seIDE's `.gitignore` ignores all of `.seide/` and you
may want your fork to keep `board.json`.

---

## The command line

At the bottom of the window is a single non-modal input line. It is not a
palette that steals focus and it is not a menu; it is a place to type a verb.

- Press `:` anywhere outside a text field to focus it. `Escape` clears and
  blurs it. `Tab` completes a command name. `ArrowUp` shows the last non-error
  log line as a hint. Typing a known verb shows its usage.
- Verbs are `open`, `note`, `run`, `files`, `project`, `link`, `unlink`, `zoom`,
  `focus`, `delete`, `save`, `help`, `clear` (`KNOWN_COMMANDS` in
  `shell/web/main.mjs`).
- `delete` with no argument acts on the **focused card**. That is the only
  place the command line reaches for the selection, and it is the intended
  pattern: the command line acts on what you are looking at.
- `note`, `files` and `project` create cards at the centre of the current
  viewport, so a new card appears where you are looking rather than at the
  origin.

The authoritative help text lives in `COMMAND_HELP` in `shell/web/cards.mjs`,
kept there (per its own comment) so the README and the UI agree.

The command line is the same surface at every zoom level and with nothing
selected. That is the point: it does not care what is in front of it, so it
never becomes unusable because the thing you need is buried.

---

## What this buys

- **Spatial memory becomes real.** You stop navigating to a file and start
  knowing where it is. Related work sits together because you put it together.
- **No context destruction.** Opening a fifth file does not evict the fourth.
  There is no stack to exhaust.
- **Relationships are first-class.** A link between a Brainfuck source card and
  the runner card that executes it is visible without a build-system file
  saying so.
- **One surface, no modes.** Panning, zooming, moving, resizing and editing all
  work with the same pointer gestures and the same transform.
- **The state is a file.** The layout is data, so it can be diffed, reviewed,
  merged and generated.

## What it costs

- **You can lose a card.** A card pushed far off-screen is invisible until you
  zoom out and find it or type `focus <id>` — which requires knowing its id.
  There is no minimap and no "projekt overview" panel to save you.
- **No automatic layout.** Nothing tiles, snaps, aligns or prevents overlap.
  With twenty cards, a board becomes a mess that only its author can read.
- **Undo is board-level and in-memory.** `Ctrl+Z` takes back the last board
  edit — a card added, removed, moved or edited, a link made or dropped — and
  only in this window: the steps are never written down, so a reload forgets
  them. Typing inside a card is the textarea's own undo, not the board's.
- **Keyboard-only navigation is weak.** The command line is a single line with
  a single focus model; there is no chord language, no keyboard card
  switching, and no search across the board.
- **Small screens suffer.** A board wants area. On a laptop display you zoom out
  until text is unreadable or pan a lot.
- **Collaboration is worse, not better.** One board file means one layout, and
  two people editing it concurrently get `STALE_REVISION`, not a merge.

---

## Contrast with mainstream IDEs, concretely

| concern | mainstream IDE | seIDE |
| --- | --- | --- |
| Where is my file? | in the tree, at its path | wherever you put the card; the tree is a `files` card |
| Which files am I working on? | the open tabs | the cards on the visible part of the board |
| What happens when I open one more? | a tab; something may be evicted | a card; nothing is ever evicted |
| How do I relate two files? | a symbol, an import, a comment | a link you draw between two cards |
| How do I run something? | a run configuration dialog | a `runner` card next to the source, or `run <cmd>` |
| Where do scratch notes go? | nowhere; a comment or an external app | a `note` card in the board document |
| What does the layout express? | nothing | which pieces belong together |
| How do I extend it? | write a plugin against an API | fork the repository and edit the source |
| What is persisted? | editor settings, open-tab session | the whole layout, as `board.json` |

The comparison that matters: in a tabbed IDE, the layout is a **transient view**
of the filesystem. In seIDE, the layout is **part of the work**.

---

## Where this design is not finished

Honesty is part of the paradigm, not a disclaimer bolted on. As of this
prototype:

- There is no minimap, no overview mode, no "fit board to window".
- There is no rubber-band multi-select and no multi-card operations.
- Links carry a label but nothing consumes them.
- Card kinds are registered with one call (`registerCardKind`) rather than edited
  into a switch, but there is still no plugin system: no loading, no discovery,
  no manifest, no sandbox (constraint 3). Registering happens while the shell's
  module graph is evaluated, so it is a fork-time hook, not a runtime one.
- The `sheet` kind is one structured surface, not a general structured-editing
  framework: no formulas, no sorting, no selection ranges, and its column types
  are fixed at four. A cell edit is a board edit, so the board's undo takes it
  back like any other change.
- The editor is ASCII-clean only for colouring purposes: `lang.tokenize`
  returns **byte** offsets and the shell treats them as string indices, which is
  the same thing only for ASCII. The shell exports this as `LIMITATIONS` in
  `shell/web/main.mjs` rather than hiding it.
