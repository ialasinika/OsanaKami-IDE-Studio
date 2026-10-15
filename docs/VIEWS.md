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
| its address | `BOARD_PATH = ".seide/board.json"` | the file name and directory are the client's convention |
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
   validated at start-up, a bad `.seide/board.json` meant the process refused to
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
| **board** | the reference shell's view: a spatial canvas of cards and links |
| **card** | the shell's unit inside that board (editor, note, image, ...) |
| **classic view** | a second *rendering* of the same board document, not a second document (`shell/web/classic.mjs`) |
| **document** | the JSON value itself, wire-level: `view.*`'s `document` member |

The shell we ship is a **reference implementation** of one view, in the sense
that `tools/bf.py` is a reference interpreter: it is the one that has to work,
it is the one the tests drive, and it is not the definition. The definition is
`core/include/view.h`.

## If you want a different view

You do not touch `core/`. You have two configurations, both already supported:

- **Another document.** Name a different path -- `.seide/notes.json` -- give it
  your own schema, and call `view.load` / `view.save` with that path. The kernel
  will hold it, version it and write it atomically. If you want the shell's
  watcher and HUD, implement your model next to `board.mjs` and hand it to the
  same client (`shell/web/rpc.mjs` does not care what is in the document).
- **Another rendering of the board.** `shell/web/classic.mjs` is the worked
  example: a tab strip and a code area over the same document, switched with
  `--view classic`. The kernel never learns about tabs, and the document on disk
  does not change when the rendering does.

A view that shares the *file* with another view is the interesting case: two
clients, the same `path`, one `base_revision` rail between them.
`tools/seide_cli.py board` is the small version of that, and
`view.changed {path, revision}` is how the first client hears about the second.

## Where to look

| question | answer |
| --- | --- |
| the kernel side of the seam | `core/include/view.h`, `core/src/view.c` |
| the wire | `docs/PROTOCOL.md` (`view.load`, `view.save`, `view.changed`) |
| the reference view | `shell/web/board.mjs`, `shell/web/main.mjs`, `docs/PARADIGM.md` |
| what a fork may replace | `docs/FORK.md`, `docs/TRIM.md` |
| the bugs this closed | `docs/BUGS.md`, entries A, N8, N10 |
