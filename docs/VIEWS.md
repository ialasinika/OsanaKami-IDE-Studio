# Views

The kernel defines that a **view** exists. It does not define what one is.

That sentence is the whole document, but it is easy to read past, so this file
says what it means in code, why the line is where it is, and what a fork gets
out of it. `docs/PARADIGM.md` describes the view we ship; this file describes the
seam between that view and the kernel.

---

## What the kernel owns

A view, to the kernel, is four things and nothing else:

| the kernel owns | the method | what it promises |
| --- | --- | --- |
| a place | `view.load {path}` | reads that path, relative to the workspace, exactly as it is |
| a value | the `document` member | JSON, not `null`, stored and returned verbatim |
| a revision | `revision` on both methods | a canonical hash, so two spellings of the same document compare equal |
| an atomic write | `view.save {path, document, base_revision?}` | the whole old document or the whole new one, never half |

Plus one notification: `view.changed {path, revision}`.

That is the entire vocabulary. The kernel does not know the word `card`, does
not know the word `link`, does not know that a document might have a `viewport`,
and cannot be told. It also does not read the document at start-up, so a
corrupt file cannot stop it from running. `core/src/rpc.c` is short because of
this: `h_view_load` hands the bytes back, `h_view_save` checks the revision rail
and writes them (`docs/PROTOCOL.md` has the wire form, including the failure
modes).

## What a client owns

Everything else. In this repository that client is `shell/web/`:

| the shell owns | where | examples |
| --- | --- | --- |
| the document's schema | `shell/web/board.mjs` | `cards`, `links`, `viewport`, `version`, card `kind`s |
| its validation | `isValidCard`, `normaliseDocument`, `serialize` | which members are required, which are repaired, which card ids may repeat |
| its meaning | `shell/web/cards.mjs` | what an editor card is, what a note card draws |
| its address | `BOARD_PATH = ".infantgod/board.json"` | the file name and directory are the client's convention |
| its default | `createBoard` | what an empty board looks like |
| its id space | `makeId` | card ids are allocated in the browser; the kernel issues none |

`board.mjs` is where the old kernel validator went, rules and messages and all.
It is a better home for it: the messages name the thing the user is looking at,
the client can repair what it understands, and a second client is free to
disagree with the whole shape.

## Why the line is here

Three failures are avoided by drawing it at "the kernel does not read the
document":

1. **A paradigm cannot be a protocol.** A kernel that validates `cards` and
   `links` has decided what every client must look like. A different view -- a
   document, a notebook, a timeline -- would need a kernel change, a suite, a
   protocol version and a release, and the answer would still be "make it look
   like a board".
2. **A client's file must not be able to break the kernel.** When the kernel
   validated at start-up, a bad `.infantgod/board.json` meant the process refused to
   start (`docs/BUGS.md`, entries N8 and N10), and a hand-added BOM was a
   non-obvious version of the same thing. Now the worst case is that the client
   says "I cannot read this file" and offers to rewrite it.
3. **The client is the only one who can say what is wrong.** `cards[0] is not a
   valid card` is a useful message only to something that can draw a card. The
   kernel could only say it in the abstract.

What it costs is stated as plainly: the kernel cannot protect a client from a
bad document, so a client must validate before it draws. That is a real
obligation, and it is one the client already had -- it built the document in the
first place.

The kernel still protects the thing it is uniquely placed to protect: the
**lost update**. `base_revision` is compared against the revision of the document
the kernel last read or wrote, so an overwrite of something that moved is
refused with `1001 STALE_REVISION` and `data.current_revision`, whatever the
document is. Revision and atomicity are properties of *storage*, and storage is
the kernel's job.

## The words, in this repository

| word | means |
| --- | --- |
| **view** | the kernel's abstract thing: a path, a JSON value, a revision |
| **board** | the *document* the shell's two tiled views are computed from: the JSON value in `.infantgod/board.json`, a set of cards and links — not an arrangement |
| **card** | the shell's unit inside that board (editor, runner, note, mod, ...) |
| **document** | the JSON value itself, wire-level: `view.*`'s `document` member |

The shell we ship is a **reference implementation** of one view, in the sense
that a reference interpreter is: it is the one that has to work, it is the one
the tests drive, and it is not the definition. The contract is written down in
`core/include/view.h`; the tests that hold the shell to it are
`node shell/web/selftest.mjs` and `make smoke`.

## If you want a different view

You do not touch `core/`. You have two configurations, both already supported:

- **Another document.** Name a different path -- `.infantgod/notes.json` -- give it
  your own schema, and call `view.load` / `view.save` with that path. The kernel
  will hold it, version it and write it atomically. If you want the shell's
  watcher and HUD, implement your model next to `board.mjs` and hand it to the
  same client (`shell/web/rpc.mjs` does not care what is in the document).
- **Another rendering of the same document.** Draw the document differently
  without creating or moving a card. This fork ships two of those, and they are
  the model to copy: `mode classic` tiles the board as a code area, a tab strip
  and a sidebar (`shell/web/classic.mjs`), and `mode mod` tiles it as a package
  tree, the editor and the validation report (`shell/web/modview.mjs`). Both
  create nothing, move nothing and save nothing: the kernel never learns about
  tabs or panels, and the file on disk does not change when the rendering does.
  Both strips carry every card the tile draws nowhere else, so no open card is
  left without a way in; a tab's `×`, a middle click and `Ctrl+W` all take the
  same close path (`closeCard` in `shell/web/main.mjs`, which asks before it
  discards unsaved text and leaves the selection on the neighbour that
  `classicNeighbourAfterClose` names). Closing is a document edit, so `Ctrl+Z`
  takes it back.
  The list of view names they share lives in `shell/web/views.mjs`;
  `shell/web/README.md` describes each tile and `docs/MODS.md` what the mod one
  is showing.

  A window opens in `mod`, because that is where a mod author works
  (`shell/web/main.mjs`'s `BOOT_VIEW`; `views.mjs`'s `DEFAULT_VIEW` stays
  `classic` as the fallback for a word that names no view), and the HUD switch
  offers the two tilings (`SWITCH_VIEWS`). `mode classic` moves a window to the
  other tile and `mode mod` comes back. There is no third view: the spatial
  plane the `x`/`y` of a card once described was never a view anybody could
  choose, so it is gone along with its pan and zoom, and `mode board` is no
  longer a name the command line answers. The document is untouched by all of
  it -- every card keeps its `x`/`y` on disk, and nothing was removed from the
  schema.

  A window can also be asked for a package by URL: `?mod=<absolute path>` (the
  File menu's 「新建模组」 hands its result over this way) makes the boot open
  that directory on the mod card and switch to the mod view. The only code that
  writes the URL is `openModUrl` in `electron/newmod.js`, and the page side is
  `requestedModFromSearch` + `openRequestedMod` in `shell/web/main.mjs`.

A view that shares the *file* with another view is the interesting case: two
clients, the same `path`, one `base_revision` rail between them.
`make cli-check` drives the second client (`tools/seide_cli.py`) against a
scratch workspace, and `view.changed {path, revision}` is how the first client
hears about the second.

## Where to look

| question | answer |
| --- | --- |
| the kernel side of the seam | `core/include/view.h`, `core/src/view.c` |
| the wire | `docs/PROTOCOL.md` (`view.load`, `view.save`, `view.changed`) |
| the reference views | `shell/web/board.mjs`, `shell/web/classic.mjs`, `shell/web/modview.mjs`, `shell/web/main.mjs`, `docs/PARADIGM.md` |
| what a fork may replace | `docs/FORK.md`, `docs/TRIM.md` |
| the bugs this closed | `docs/BUGS.md`, entries A, N8, N10 |
