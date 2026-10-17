# Changelog

What changed, in the order it changed.  This project is a prototype: the
version number says how usable it is, not how finished.

OsanaKami IDE Studio is a fork of seIDE at `v0.1.0-alpha`.  It carried the name
InfantGod Studio (幼神工坊) until the rename recorded in `## Unreleased` below; the
kernel, the shell, the protocol and the tools are upstream's, renamed: `seIDE`
becomes OsanaKami IDE Studio, `.seide/` becomes `.infantgod/`,
`core/include/seide_cfg.h` becomes `core/include/infantgod_cfg.h`, the protocol
name `seide/1` becomes `infantgod/1` — the fork's first protocol version,
replaced by `infantgod/2` in `## Unreleased` below.  The Brainfuck fixtures are
retargeted to Yarn, so `examples/hello.yarn` is the fixture the suite reads.  The
`v0.1.0-alpha` section below is inherited in that sense — upstream's work, as it
stands in this tree.

## Unreleased

### A Spine rig, drawn from its own bytes

- `shell/web/spine.mjs` reads the `.skel.bytes` and `.atlas.txt` pair the game
  ships.  It is a layout parser, not a runtime: it knows nothing about drawing,
  and the file says where its field order comes from -- the 4.2 runtime's
  `SkeletonBinary.java` (Esoteric Software, Spine Runtimes License), read as a
  reference for an independent JavaScript parser, not vendored into this tree.
  A buffer it refuses is refused with the byte offset that broke it, so a wrong
  file is a message and not an empty canvas.
- `shell/web/spinepose.mjs` turns a skeleton and a time into world transforms and
  region corners (the previous commit); `shell/web/spineframe.mjs` maps those
  corners onto atlas rectangles, which is where a trimmed region's `offsets` and a
  quarter-turned `rotate` live.  Both are pure, so `shell/web/selftest.mjs`
  checks them without a browser.
- The `spine` card is those three layers plus a canvas, a selectable bones
  overlay, a skin picker, an animation picker, a timeline, playback at four
  speeds, and wheel zoom / drag pan / click-to-pick-bone.  Choosing no skin means
  *every* skin merged in skin order: these rigs keep the body, the eyes and the
  mouth in separate skins and the game stacks them, so `Journalist`'s single setup
  skin is six hair meshes and would draw an empty body.  A named skin still shows
  exactly that skin.
- `spine <path.skel.bytes>` opens it as a command, and opening either half of the
  pair as a file opens the card too.  At this commit nothing is written: the card
  is a viewer, and the board keeps `file`, `animation`, `skin` and `bones` so the
  choice survives a save and a reload.
- Evidence, measured.  A throw-away probe under `build/` parsed all 37 rigs in the
  game's `Spine/` folder and consumed every skeleton to its last byte -- 1199
  bones, 394 slots, 321 skins, 1077 attachments, 1038 atlas regions.  The game's
  files are not in this repository, so that probe is not a suite check.  What the
  suite does check is the arithmetic (`spine frame:` and `mergedSkins` in
  `shell/web/selftest.mjs`) and, in a real headless browser, three
  rigs end to end: `Cop` (2 bones, 3 regions) paints 200509 pixels; `Journalist`
  (28 bones) paints 178337 pixels from 4 region attachments and counts its 6 mesh
  attachments as not drawn; `Aistalt` (110 bones, 7 regions) paints 231814 pixels.
  The skin picker is not decoration: picking `Journalist`'s own `default` skin
  drops the picture to 0 regions -- that skin is six hair meshes, and the face
  lives in the merged skins -- and picking `Aistalt`'s takes it to 2.  Playback is
  real: `TailLoop` reads 0.93 s of 3.00 s after 600 ms with the picture changing
  while it runs.  `Journalist`'s 2 s animation moves only mesh vertices, which
  this card does not draw yet, so its picture stands still while the clock runs;
  the status line counts those meshes as not drawn instead of pretending.  The
  card round trip is a suite check now: `tools/browser_smoke.py` opens a synthetic
  one-bone rig (written in the test, to the layout the reader documents -- the
  game's own rigs stay out of the repository) through `spine rig.skel.bytes` and
  reaches the card as a tab in both tiles (55 checks at this commit).

### A Spine rig is edited where it was read

- `shell/web/spineedit.mjs` is the edit model, and it is pure: an edit is a set of
  setup numbers per bone, a setup attachment per slot, a duration per animation,
  and keyed frames per bone and slot.  Editing a bone's rotation for the first
  time copies that bone's timeline out of the file first, so the keys the author
  did not touch keep their curves; a key time is clamped against the animation's
  duration by the module, not by the caller.  `applyEdits` returns a new skeleton
  and never touches the parsed one, which is why Reset is one call.
- `shell/web/spinewrite.mjs` writes a parsed skeleton back as 4.2 binary.  The
  proof is byte identity, not plausibility: all 37 rigs the game ships round-trip
  through `writeSkeletonBinary(readSkeletonBinary(bytes))` to the same bytes --
  500206 bytes compared, per-file counts printed by a probe under `build/` that
  was warmed up by making it fail on purpose (dropping the attachment flag bits
  turned 32 of 37 files red at byte offset 12224; dropping the physics timeline's
  index bias turned 2 red at offset 6950).  Byte identity needs data the decoded
  model does not show: whether a default-valued field was present or absent, and
  which of two identical strings the table index pointed at.  So `spine.mjs` now
  also keeps those raw fields (attachment flags and string refs, bezier counts,
  the physics step divisor, null-versus-empty event strings, the default-skin
  marker); its decoding and its rejection offsets did not change.  A model built
  by hand instead of by the reader still writes, but it is canonicalised, and the
  result is a rig the reader accepts rather than the same bytes.
- The card can edit.  Edit turns the canvas into a posing surface: dragging the
  selected bone turns it, Shift+dragging moves it, three number inputs in the
  inspector do the same from the keyboard, Key and Unkey write and remove keys at
  the playhead, the key list jumps to a key or deletes one, and a slot's
  attachment picker chooses what it shows.  With an animation selected those
  numbers become keys at the playhead; with none they are the setup pose.  The
  status line says what is edited (`· edited: 1 bone, 2 keys`) instead of leaving
  the author to remember.
- Save writes the rig the canvas is showing back to the `.skel.bytes` it came
  from, with `base_revision` attached so a file that moved on disk is never
  overwritten silently (the answer to a moved file is the same overwrite / reload
  / cancel question an editor card asks).  Ctrl+S does the same from the keyboard.
  A clean card answers "nothing to save" and writes nothing, and a save of an
  unedited rig would be byte-identical by construction.  Only that one file is
  written -- the atlas and its PNG are untouched -- and mesh attachments are still
  read and counted but not drawn.
- Evidence.  In a real headless browser, on real rigs, with the files copied into a
  throw-away workspace: typing 25 degrees into `Cop`'s selected bone and pressing
  Save changed `Cop.skel.bytes` from 570 to 583 bytes, and the file read back
  contains one new timeline, `rotate@1[115]` -- the 90 degree setup angle plus the
  25 typed in -- with `round_trip_identical: True`; the same on `Journalist` went
  from 13349 to 13362 bytes (12 timelines: the file's 11 plus the new rotate),
  round-trip identical.  A second save with no edit, and a save after Reset, both
  said "nothing to save".  The suite (282 checks) covers the writer on the one rig
  it owns, a 135-byte synthetic skeleton it embeds for the purpose: reading it and
  writing it back is that same byte array, and a setup-pose edit survives a write
  and a re-read.  `tools/browser_smoke.py` grew the card's round trip into a suite
  check as well -- it poses that synthetic rig through the inspector, presses Save,
  reads the file the browser wrote back through the same parser and demands the
  typed angle, then presses Save again on the clean card and demands the refusal --
  and stands at 57 checks.

### The completion menu cannot outlive the caret

- The menu is a promise about a document and a caret: the language service
  answered a question about the text and the offset the editor asked for.  An
  arrow key, a click, Home or End, a find jump or an undo could move the caret
  while the menu stayed up, and Enter or Tab then inserted the row **against the
  old caret** -- text landed somewhere the author was not looking.  Three changes
  in `shell/web/cards.mjs`: the caret-moving keys close the menu, a click or
  mouseup in the textarea closes it, and `acceptIndex()` compares the live text
  and caret with the ones the menu was built from and asks again instead of
  cashing a stale promise.
- `tools/browser_smoke.py` drives the shipped page for both cases -- an arrow key
  (`lang_stale_arrow`) and a caret that moved with no key at all
  (`lang_stale_silent`) -- so the regression is caught by the suite, not by a
  reader.  51 → 53 checks; both went red against the old code and the file came
  back byte-identical.

### The name

- The product is **OsanaKami IDE Studio**.  The previous name was InfantGod Studio
  (幼神工坊).
- The version is still **0.1.0**: the product, the shell and the kernel's header all
  name 0.1.0, and the shipped kernel binary is compiled at 0.1.0 — this change was
  made on a machine with no C toolchain, so bumping the version would leave the
  sources disagreeing with the binary that ships (`python tools/kernel_probe.py`
  fails on exactly that).  After a `make` on a machine with a C89 compiler,
  `python tools/version.py set 0.1.1-alpha.1` finishes the bump everywhere.
- Renamed: `package.json` name / productName / author / publisherName, appId and
  uninstall key (`com.osanakami.idestudio`), the window title and the about box,
  the HUD brand, the `.lang` descriptor header, the generator line a new mod's
  README receives, the first-run workspace (`Documents/OsanaKamiIDEStudio`), the
  installer's product name and output file, the EULA, README, licenses and docs,
  and the code-signing identity (rebuilt as `CN=OsanaKami IDE Studio`).
- Deliberately unchanged: the kernel binary (`resources/infantgod.exe`), the
  workspace state directory `.infantgod/`, the protocol name `infantgod/2` and the
  `INFANTGOD_*` macros.  They are internal identifiers rather than product text,
  and this environment has no C toolchain, so the shipped kernel binary cannot be
  rebuilt: renaming them would put the sources and the binary out of step.
- The game's own names are still used only descriptively, and the disclaimer from
  the previous entry (not affiliated, no trademark claim) is unchanged.

### The licences: MIT for the code, non-commercial share-alike for the prose

- The documentation licence changes from CC BY 4.0 to **CC BY-NC-SA 4.0**
  ([LICENSE-DOCS](LICENSE-DOCS), which carries the full legal code and the scope
  list: every Markdown file in the repository).  The code stays **MIT**
  ([LICENSE](LICENSE)).  NC and SA restrict the prose only; MIT still grants
  commercial use of the program, and this file does not ask you to give that up.
- Why: this is a tool for making mods, and the mods are shared for free.  The prose
  -- the specs, the architecture notes, this changelog -- is the part a paid
  course, a paid handbook or a commercial fork would repackage and sell; the code
  is not.  NC keeps the prose out of commercial reuse; SA keeps a shared
  adaptation of it (a translation counts) under the same licence, so a fork cannot
  relicense the writing more loosely.
- `LICENSE-DOCS` is assembled from the official legal code retrieved from
  creativecommons.org, not retyped, and its preamble says in plain words that
  CC BY-NC-SA 4.0 is not an open-source licence: the prose is source-available.
- `EULA.txt` gains a section on what the two licences allow, and says plainly that
  selling this early, AI-authored build is **not recommended** -- a request, not a
  restriction, because MIT does not allow the project to restrict commercial use
  of the code.  The installer's licence page shows the same file.
- History: the entries below that say "CC BY 4.0" record what the licence was at
  the time; they are not rewritten.

### The Yarn card asks the language service while you type

- `mod.complete` and `mod.hover` are verbs on the shell's RPC surface now
  (`MOD_METHODS` in `shell/main.mjs`, backed by `completeYarn`/`hoverYarn` in
  `shell/mods/index.js`), and the Yarn card uses them. Typing `<<` opens a menu of
  at most eight commands, functions, variables and nodes, ranked by the same
  search index the Tools panel uses; `Up`/`Down`/`Tab` move, `Enter` takes a row,
  `Esc` closes, `Ctrl+Space` asks at once. A taken row replaces the whole `<<`
  prefix and leaves the placeholders its signature needs. The menu does not open
  inside `{ }` or inside quotes, and when the shell cannot answer the card goes
  quiet after the first failure instead of asking on every keystroke.
- The line under the cursor explains itself, with the hover text the language
  service already produces: a tag or a command name is explained where it is
  written. `tools/browser_smoke.py` (51 checks) and `shell/web/selftest.mjs`
  drive the menu and the hover line in the real window and in the pure model, and
  `docs/VIEWS.md` says what the two views now do with them.

### The translation table keeps its bytes

- The game's own tables (`NewProject*.csv`) open with a UTF-8 byte-order mark. The
  table card read them through a streaming `TextDecoder`, which ate the mark, so a
  read-modify-write handed the game a table without it. The same decoder was
  lenient: bytes that were not UTF-8 became U+FFFD, and the next save wrote those
  replacement characters over the modder's own text.
- `readTextInChunks()` now decodes with `{ stream: true, ignoreBOM: true, fatal:
  true }`, reports the mark as a `bom` fact separate from the text, and refuses
  invalid bytes with `the bytes at byte N are not UTF-8 text` instead of guessing.
  `writeTextInChunks()` puts the mark back when the caller asks for it
  (`bom: true`), and the story card carries it from the load to the save -- the
  idiom `shell/web/story.mjs` already used for a `.yarn` file's mark. Four checks
  in `shell/web/selftest.mjs` (249/249) pin the round trip with real bytes: a
  lenient decoder turns them red.

### A regenerated knowledge base cannot switch the checks off

- `tools/gen_knowledge.mjs` drops every `description`, because those sentences are
  the game's documentation text rather than facts. But two sentences *were* facts:
  `TechName reference to XDefinition` is how the checker knows a field points at
  another definition, and `Relative path to sprite image file` is how it knows a
  field holds a sprite. Regenerating the knowledge base from a real install would
  therefore have emptied 26 sprite fields and 62 reference fields, and every
  package would have validated green because nothing was left to look at.
- The generator now lifts exactly those two facts into `x-techReference` and
  `x-sprite` before dropping the text, and `flattenSchema` reads the keys first and
  the sentences only as the fallback. A rich knowledge base and a facts-only one
  describe the same fields: on the committed `shell/mods/knowledge.json` the old
  and new `referenceMap`/`schemaSummary` answers are byte-identical, and the mod
  suite (314/314) pins the facts-only side, including the failure mode where both
  the key and the sentence are missing and the map is empty.

### The payload carries no game data

- The installer ships the IDE, not the game. Every place where our own text named
  the game or its cast -- the `package.json` description, the examples, the `.lang`
  descriptor, the mod checker's and the search index's comments, eleven strings in
  the Yarn card and its help, the story card's sample lines -- now says the neutral
  thing ("the game", `Speaker` where a cast name was used as an example). The
  one behaviour that had to change is `firstCharacterName`'s fallback in
  `shell/mods/search.js`, which returned a character's name when a generated example
  needed a speaker; it returns `Speaker`. `setLineSpeaker` keeps its job: a line
  that changes speaker keeps its `#state:`, its `#line:` and its spacing.
- The payload audit is no longer allowed to have an allow-list. It reports 66 text
  files and four packed `app.asar` entries scanned, zero hits, and `--audit-only`
  exits 0. Two escapes were closed: `--no-audit` now requires `--dev` (a release
  build runs the audit), and a build without `--dev` fails while the allow-list is
  non-empty. `build/make-installer.json` records `dev`, the audit result and
  `releaseReady`, so a build says for itself whether it was checked.
- The game's knowledge baseline is no longer a `shell/mods/` resource: the
  `extraResources` filter excludes `mods/knowledge.json` (see the next entry for
  what reads the game now). Re-adding it is visible: the audit fails with 1307 hits
  in two files -- the baseline's 1306, plus one ordinary word that the game's own
  cast list also contains (`Runner`, a card title). That second hit is why the
  runner card is titled `Command`.

### The knowledge base is derived from the player's game

- A fresh install has no `knowledge.json`, and the IDE is useful anyway: it finds
  the game the way the settings page already did (an explicit path, an environment
  variable, Steam's own library list, the platform's usual install directories),
  derives the baseline once, and writes it under the user data directory
  (`%APPDATA%\OsanaKami IDE Studio` on Windows, `Application Support` on macOS,
  `$XDG_DATA_HOME` or `~/.local/share` elsewhere). The derivation is 331,438 bytes
  and took 1.6 s on this machine's installed game; the second boot reads the file.
  A machine with no game is a named state (`missing`), not a guess: the mod card
  still validates structure and references and says the baseline is absent.
- The resolution order is `options.knowledgePath`, then `INFANTGOD_KNOWLEDGE`, then
  a `knowledge.json` next to the module (a development tree), then
  `<userDir>/knowledge.json`, then build-from-game, then `missing`. An explicit
  `knowledgePath` that does not exist is an error (`E000`), not a reason to fall
  through and derive over it. A file that exists but does not parse is reported as
  `loadError` rather than silently treated as an empty baseline. The write is
  atomic (temporary file, then rename) and a failure to write leaves the session in
  the named missing state instead of crashing. The shell learned `--user-dir` and
  Electron passes `app.getPath("userData")`; startup prints
  `mod layer: knowledge base found <path> (<source>)` with the source among
  `option`, `env`, `bundled`, `user`, `derived` and `none`.
- The derivation core moved to `shell/mods/knowledge-build.js`
  (CommonJS, `buildKnowledge`/`canonicalKnowledge`/`diffKnowledge`), and
  `tools/gen_knowledge.mjs` became a thin CLI that re-exports it. The generator's
  output is unchanged: the old module and the extracted one produce the same
  223,901 bytes for the real corpus (211 `.yarn` files, 1,073 nodes), and
  `--check`/`--diff` keep their behaviour.
- A derived baseline carries facts, not the game's description sentences, and
  without the previous entry's `x-techReference`/`x-sprite` fix the definition
  checker would have quietly stopped checking sprite and reference fields on every
  machine without a shipped baseline. `validate.js` reads both spellings, and the
  mod suite pins the equivalence. `docs/MODS.md` has a section on the five sources,
  where the file is written and what turns off when there is no baseline; the mod
  suite is 332 checks.

### One document, two views -- the canvas is gone

- There were three ways to look at a board document; there are **two**.  `classic`
  (a sidebar, a tab strip and a code area) and `mod` (the same tile pointed at a
  mod package) are the whole registry, `mode board` is refused with the two names
  that work, and the page has no `#stage`, no `#links` and no `#hud-zoom`.  The
  dot grid, the grab cursor, the world transform, the pan and zoom arithmetic, the
  drawn link layer, the click-drag move and resize and the double-click note drop
  all went with them.  What did *not* go is the **document**: `.infantgod/board.json`
  still carries cards, links and `viewport`, `load`/`save` is still the identity on
  a file written before this change, and `#board` is still the element a tile
  measures and a click lands on -- the board is a document and a file, not a way of
  looking at them.
- A card's place is the tile's business alone.  `centreWorld()` -- the answer to
  "where does a new card go" -- used to read the viewport; it now walks a fixed
  cascade, so a new note still lands somewhere visible and two notes never land on
  the same pixel.  Selecting a card, raising it on top, clearing the selection by
  clicking empty space, and the `link`/`unlink` document verbs all survive; what is
  gone is moving a card by dragging it, which was the canvas's gesture.  Notes now
  come from `note <text>` alone.
- `#cards` carries `z-index: 0` in `style.css` as a deliberate substitution: the
  deleted stage opened a stacking context by carrying a transform, and without it a
  raised card could cover the tab strip or the hint.  The words are the other half
  of the change: `docs/VIEWS.md` defines *board* as the document (never a view),
  `docs/PARADIGM.md` keeps the paradigm without a canvas, and `docs/BUGS.md` notes
  that the older entries below use "canvas", "pan" and "zoom" because that was the
  shell then.

### Kernel

- The kernel no longer knows what a view **is**.  `board.load`, `board.save` and
  `board.newId` are gone; `view.load {path}` and `view.save {path, document,
  base_revision?}` replace them.  The kernel keeps *a JSON document* at a path the
  caller names, hands it back verbatim, and never looks inside it: any JSON value
  except `null` round-trips exactly — an object shaped like a board, an array, a
  number — so `1004 INVALID_BOARD` is retired (the number stays reserved) and a
  malformed document can no longer stop the kernel from starting, because the
  kernel no longer reads one at startup.  `core/src/board.c` (`fill_defaults`,
  `validate`, `check_links`, `board_id`) and `core/include/board.h` were deleted,
  `core/src/view.c` and `core/include/view.h` took their place, and
  `SDE_WITH_BOARD` became `SDE_WITH_VIEW`.  What survives is the part a client
  cannot do for itself: the atomic neighbour-replace write, `base_revision`
  staleness with `data.current_revision` (`1001 STALE_REVISION`), the
  `view.changed` notification, and `workspace.info`'s `view_path` /
  `view_revision` — which report the document the kernel last read or wrote, not
  a workspace setting.  `SDE_PROTOCOL_VERSION` is **2**; the fork's protocol name
  is `infantgod/2`, and the rename is breaking on purpose, so an
  `infantgod/1` client is refused rather than half-served.  Reasoning, the
  failures this avoids and the price are in the new `docs/VIEWS.md`.
- The protocol can now carry **bytes**, for the files that are not text.  Two
  methods join `file.read` / `file.write`: `file.read_bytes {path}` answers
  `{path, base64, revision, size, mtime}`, and `file.write_bytes {path, base64,
  base_revision?}` answers `{path, revision, size}`.  `base64` is the standard
  alphabet with `=` padding to a multiple of four and no line breaks; the two
  verbs take the same path, the same 4 MiB cap, the same containment rule and the
  same revision track as their text siblings, and a stale `base_revision` is
  refused with the same `1001 STALE_REVISION`, carrying the same
  `data.current_revision`.  The one member that differs is deliberate: a byte
  write reports no `eol`, because it never looked at the bytes as lines and a
  reported style would be a guess.  A payload that is not base64 is `-32602
  INVALID_PARAMS` -- the kernel does not guess at a near-miss, because the
  failure mode of guessing is a corrupted image rather than a refused request --
  and a payload whose *decoded* length would exceed the cap is refused before it
  is decoded.  The driving case is a PNG: `file.read` refuses a file holding a
  NUL byte with `1003 file is binary -- use file.read_bytes`, and `file.write`
  can only carry a JSON string, so an image had no way in or out of a workspace.
  Both write verbs now run through one function, so a rule added to one -- the
  staleness check, the `file.changed` notification -- cannot quietly miss the
  other.
- `file.stat` now answers with a **revision for a binary file**.  It used to
  report `0`, "no revision to compare", for any file holding a NUL byte, which
  was honest while nothing could read one: there was nothing to compare against.
  `file.read_bytes` changed that, and a watcher that could not compare an image
  would warn about every change to it instead of reloading.  The number is the
  same FNV-1a hash `file.read_bytes` reports for the same bytes, so a client
  holding a revision from `file.read`, `file.read_bytes` or `file.stat` can
  compare it against any of the other two.
- The kernel can now move a file that is too big to be one JSON **string**.  The
  four `file.*` text/byte verbs carry a whole file through one JSON value, so all
  of them stop at 4 MiB: the game's own translation tables run from 4.5 MB to
  5.75 MB and were simply unopenable.  Five methods replace "one big string" with
  a session.  `file.blobOpen {path, mode, base_revision?, want_revision?}` opens
  one; `file.blobRead {session, offset?, length?}` answers at most 1 MiB of base64
  at a time with `eof`; `file.blobAppend {session, data, offset?}` writes into a
  `<path>.tmp` neighbour; `file.blobCommit {session, total_size}` publishes it
  with the same atomic replace `file.write` uses — a reader of the target sees the
  old file or the new one and never a half-written one — and `file.blobAbort`
  takes the temporary file with it.  A chunk over 1 MiB is refused rather than
  truncated, an append whose `offset` is not where the session's data currently
  ends is refused rather than spliced into the wrong spot, `base_revision` is
  compared exactly as `file.write` compares it (`1001 STALE_REVISION` with
  `data.current_revision`), a read session on a missing file is `1002`, and an
  unknown session is `-32602`.  `blobOpen`'s `want_revision` and `blobCommit`'s
  `revision` are the same FNV-1a hash the other `file.*` verbs report for those
  bytes, which is how a client learns the base of a file too large for
  `file.stat` to have hashed; a write session on a file that is not there is not
  an error, because the commit creates it.  Eight sessions per kernel, closed
  after fifteen idle minutes, and a kernel killed with sessions open leaves no
  commit.  `core/src/blob.c` hashes in 64 KiB steps and seeks instead of
  buffering, `core/include/base64.h` is now the one base64 implementation (the
  statics in `wksp.c` are gone), and `core/port/sys_win32.c` gained `read_at` and
  `append_file`, so neither side ever holds the file whole.  The 4 MiB refusals
  are unchanged and still read `file is too large to open`.

### Shell

- `shell/web/board.mjs` now owns the board schema, the `.infantgod/board.json`
  path (`BOARD_PATH`) and card ids (`makeId`, with `idFactory` left as a seam that
  nothing supplies — the old `board.newId` had no production caller).  Its rules
  are unchanged and still refuse what they always refused; the only difference is
  that the refusal now happens in the process that can explain it.  `main.mjs`
  names the path on every call and listens for `view.changed` instead of
  `board.changed`.
- The same board can be drawn as a **conventional IDE**: the command
  `mode classic` (or the HUD button, labelled with the view it will give you)
  tiles the focused `editor` card into a code area, every open editor into a tab
  strip above it and the first `project`/`files` card into a sidebar column,
  hiding the rest.  It is a **view, not a document**: switching creates no card,
  moves none, writes nothing to `board.json`, and `mode board` restores every
  card to the pixels — pan and zoom included — the document gives it; a card with
  no role is hidden rather than unmounted, so its text, scroll position and
  listeners survive a walk through the view and back; and a click in the view
  selects but never raises, so a first visit cannot dirty the board.  The role
  rules and the tile arithmetic are pure (`classicRoles`, `classicLayout`,
  `classicTabLabel` and the constants `CLASSIC_SIDEBAR_KINDS`,
  `CLASSIC_SIDEBAR_W`, `CLASSIC_SIDEBAR_MIN`, `CLASSIC_TAB_H` in
  `shell/web/classic.mjs`) and are measured in
  the board's own pixels, which is why `shell/web/selftest.mjs` pins them with no
  DOM (12 new checks, **108** in all) and `tools/input_smoke.py` measures the tile
  in a real window (4 new checks: the tiling and its parts, a tab click moving the
  code area to that file, the wheel leaving the viewport alone, and `mode board`
  restoring the board exactly, **23** in all).  The wheel stays the board's
  gesture, so the classic view has no pan and no zoom, and the HUD says `no zoom`
  rather than quoting a number that no longer describes the screen.  The view
  came from upstream seIDE `564d51e`, applied on top of the fork's own shell;
  nothing about the protocol, the board document or the card kinds changed.
- The same board can also be drawn as a **mod workbench**: `mode mod` (or the
  `Mod` button in the HUD's view switch) puts the mod package in the left column,
  the focused editor in the middle and the first `problems` card underneath it,
  hiding everything else.  It is the same kind of thing as `mode classic` — a
  **view, not a document**: nothing is written, no card moves, a card with no role
  is hidden rather than unmounted, a click selects but never raises, and
  `mode board` restores the pan and the zoom the document gives it.  The tile is
  the classic tile plus a report panel, and both can drop out: `MOD_SIDEBAR_KINDS`
  (the `mod` card first, then `project`, then `files`) at `MOD_SIDEBAR_W` 320 px
  and `MOD_SIDEBAR_MIN` 180 px, `MOD_TAB_H` 34 px, and a panel of `MOD_PANEL_H`
  200 px at its tallest — dropped outright rather than squeezing the code area
  below `MOD_AREA_MIN` 140 px, so that a board with no `problems` card has no
  panel and a board with no package card has no column, instead of drawing 320
  pixels of nothing.  The full rules are in `modview.mjs`; what every view is
  *called* moved out of `classic.mjs` into the new `shell/web/views.mjs`
  (`VIEWS`, `VIEW_LABELS`, `viewName`, `tiledView`, `viewHud`, `viewNote`,
  `viewAbout`), so the mode switch — now **one button per view**, built from
  `VIEWS`, instead of a single toggle — and the two tiles cannot disagree about
  what a mode is named.  `shell/web/selftest.mjs` gained 10 checks (**118** in
  all); the tile was then measured in a real window over a real mod package
  (`Mods/SODefines`, 1306 files, 347 validator errors) before it was written up.
- The editor has **line numbers**, and they are on when a file is opened: a gutter
  of its own down the left of the text (`ed-gutter` in `shell/web/cards.mjs`)
  holding a single `<pre>` of numbers (`ed-gutter-numbers`) that is rewritten only
  when the number of lines changes -- never one element per line, so a 4000-line
  file costs one string and scrolling costs no reflow at all.  The numbers share
  the code's font, leading and line box, so they cannot drift out of step with it.
  Clicking the gutter hides it and clicking it again brings it back
  (`showGutter`, which flips `data-on` and the surface's `has-gutter`/`no-gutter`),
  and hiding it hands its columns back to the code rather than leaving a hole.  It
  is a **view, not a document**: the state lives in the card and starts on, so
  `board.json` is not written and two windows need not agree.  The wheel still
  belongs to the card's scroll region, so the gutter is not a second place where a
  wheel means something else.  This came from upstream seIDE `e6ee30c` ("Prepare
  0.4.1-alpha.1"), whose own note is the argument for the default -- *The editor
  shows line numbers, and starts that way.*  `tools/input_smoke.py` checks both
  halves in a real window, because neither is visible to a DOM-less test: that the
  gutter holds one number per line with the last one matching the file, and that a
  click turns it off and another turns it back on (**25** in all).
- The HUD is **one line high**, whatever the selection says.  It was one line by
  luck: `hud-brand` sets no `white-space` of its own, so a long path squeezed it
  onto a second line, the strip grew from 30 px to 33 and every card under it
  moved three pixels -- which the classic view's own tile check caught, because
  it compares the board's rectangle before and after a click.  `.hud-item` now
  carries the `min-width: 0` a flex item needs before it can ellipsize at all,
  every item with a fixed width keeps it, and the selection is the one thing that
  gives up room.
- A window now **opens on the classic tile**, and the board is a **mode**, not a
  button.  `shell/web/views.mjs` separates the view a window starts in
  (`DEFAULT_VIEW`) from the views the switch offers (`SWITCH_VIEWS`, which is
  `classic` and `mod`): `board` stays a member of `VIEWS` — its command, its
  `body` class and its tile arithmetic are untouched — it is simply not one of
  the buttons, because a switch should offer the views you are *not* in and the
  board already has `mode board`, the command bar and `help`.  The first paint is
  a view like any other: `paintView` writes `body.is-classic` where `viewMode` is
  initialised, because `setView` refuses to act on the mode it is already in, and
  a window that booted into a mode nobody painted was left wearing the board's
  CSS.  `shell/web/selftest.mjs` gained two checks — that the default view is a
  member and the switch is not, and that every switchable view has a button title
  (**120** in all) — and `tools/input_smoke.py` gained one, that a window really
  opens on the classic tile with `mode board` still behind it (**26** in all,
  whose board steps now say `mode board` out loud instead of assuming it).
- The **message strip is folded away** until it has something to say.  What it
  holds is the `info` chatter a quiet window emits — the startup banner and the
  workspace path — which is exactly the clutter a person who opened the app to
  edit a file does not want; so `#log` starts `hidden`, its rows go back to the
  tile (measured in a real window: 620 px of board against 559 px with the strip
  open), and the HUD carries a `log` button in its place.  An `error` opens the
  strip on the spot and never folds it back on its own; while it is shut the
  button counts what is waiting and takes the worst level's colour (`log · 3`,
  `is-hot` at a warning and `is-error` at an error, in the button's own tooltip);
  `help` opens it; `log` and a click on the button toggle it.  No message text
  changed, so the suites that read the strip still read it.
- The hint that stands in the sidebar column is no longer a **smear of clipped
  words**.  A tile with no `project` card has no column to stand in — the tile
  arithmetic gives the tabs and the code area the whole width, so `layout.tabs.x`
  is 0 — and advice laid out in a zero-width box wraps to one word per line
  behind the code.  It is a notice there instead, and only while the code area is
  empty: below the tab strip rather than over it (with no sidebar card the tabs
  start at the tile's left edge, so a notice at the tile's top would cover the
  very tab the file under it is open in), 280 px wide and its own height, with a
  border all round instead of a panel's cut-off edge.  Once a file is open the
  notice is not drawn at all, because advice is worth less than the first two
  lines of the file you just opened.

### A story editor, and the tables beside it

- The shell reads the mod's own Yarn rather than only the file as text.
  `shell/web/story.mjs` parses a `.yarn` file into nodes and body lines
  (dialogue, `->` options, `<<commands>>`, comments, tags, blanks) and writes it
  back line for line.  The rule the corpus had to settle is that a header cannot
  be recognised by its shape: 7,397 body lines in this mod look exactly like
  `key: value`, so a line is a header only when it carries no `#line:` marker
  *and* its key is one of the ten the game uses (`title`, `subtitle`, `when`,
  `tags`, `permission`, `position`, `tracking`, `Character`, `Topic`).  A
  line's `#line:` id is what the game looks it up by, so the parser never
  invents one: `nextLineId` is FNV-1a over the ids already taken, with no clock
  and no `Math.random`.  All **211 `.yarn` files** in the mod parse and
  re-serialise byte for byte, which is the property the parser is held to.
- The `story` card (`shell/web/cards.mjs`) draws those nodes and lines, edits a
  speaker or a line's text in place, and adds a line beside the one that is on.
  The card's own code path proves two things the module alone cannot: an edit
  moves no other line's `#line:` id, and a card nobody touched saves its file
  back unchanged.
- The translation tables the game keeps beside a story are read too:
  `shell/web/storycsv.mjs` parses and writes the eight-column CSV, keeps its
  BOM, its CRLF and its five-field `metadata` rows, and *derives* the `lock`
  column rather than trusting it.  `lock` is the first four bytes of SHA-256 of
  the source text, hex, big-endian, read off the mod's own tables and confirmed
  on all 18,609 rows that carry one; that is what lets a row be called `stale`
  rather than merely different.  `story <path.yarn> [table.csv]` then puts the
  column beside the story: a line is joined to its row by its `#line:` id, and
  the cell shows the table's words with the row's state (`ok`, `stale`,
  `untranslated`, `missing`).  A line with no marker draws no cell; a line the
  table has no row for draws `missing`, because a gap is exactly what a
  translator needs to see.
- A line the story **gains** is a row the table owes, so `+ line` writes one:
  the card mints the line's `#line:` id the way the parser does, then builds the
  row for that id — the id as `line:<id>`, the text as the line's own words, and
  `lock` as the hash of exactly that text, which is what makes the row read
  `untranslated` until somebody translates it and `stale` the day the line
  changes under it.  `node` is the node the line went into and `lineNumber`
  continues that node's highest.  `file` is the one column the card refuses to
  invent: the game writes the author's own absolute path there, so the row takes
  the value the table's own rows already use — a card on another machine cannot
  know it, and a guessed path is a path the game would fail to find.  Nothing is
  written to disk until the card is saved, and a card that added no line writes
  its table back not at all.
- `<<commands>>` are completed from the mod's own schema, not from a list kept in
  the shell.  `shell/web/ysls.mjs` reads the `.ysls.json` the game's compiler
  generates — this mod's is 136 commands and 63 functions — as two lists in the
  file's own order, keeping each entry's parameters, their types and a function's
  answer.  A `story` card opened with a third word (`story <path.yarn>
  [table.csv] [commands.json]`) holds one, and a caret inside a `<<name` offers
  what that file has: a name that starts with what was typed, before one that
  merely contains it; an empty `<<` browses the head of the schema; and a name the
  compiler marked `containsErrors` is never offered, because it exists in the file
  and not in the game.  Tab or Enter takes the current one, and the line is
  rewritten through the same door as any other edit, so nothing else on it moves
  — including the indentation, which is what a command line keeps in its raw text
  rather than in its `indent`.  A space, a `>` or ordinary prose closes the list:
  a suggestion box that appeared while somebody was writing dialogue would be
  worse than none.  A JSON file with neither a `commands` nor a `functions` list
  is refused rather than read as an empty schema that would complete nothing for
  the rest of the session.
- The tables are too big for one JSON string, so the card no longer asks for one.
  A `NewProject_<lang>.csv` is 4.5-5.75 MB and a whole-file `file.read` is
  refused over 4 MiB, which the card used to meet as a plain read failure.  The
  table now moves through a `file.blob*` session — opened once, read in 1 MiB
  frames, each frame decoded by a *streaming* UTF-8 decoder so a table whose bytes
  straddle a frame boundary is still assembled character for character, and the
  session given back on every path, a failed read included.  The status line shows
  how far the read has got, and a frame that fails is named on the card and leaves
  no table behind: a shorter table is never passed off as the whole one.  Saving
  uses a session of its own — the new text appended in frames and published with
  `file.blobCommit`, whose `total_size` is checked against the bytes actually
  appended — under the same stale-revision rules as any other write, so the game's
  real tables are written the way they are read.

### A pixel canvas, and the file it draws

- The shell draws **pixels**.  `shell/web/pixelpng.mjs` is a PNG reader and
  writer with no imports at all — it runs in a browser page, so it carries its
  own inflate, its own CRC-32 and its own Adler-32 rather than reaching for
  `node:zlib` — and it reads what this game's art actually is: 8-bit RGBA
  (colour type 6) and 8-bit RGB (colour type 2), not interlaced, in stored,
  fixed-Huffman and dynamic-Huffman blocks, through all five row filters.  Of
  the 374 PNGs under `Mods`, 365 are the first kind and 9 the second; anything
  else is refused **by name** (`unsupported PNG: colour type 3, only 6 (RGBA)
  and 2 (RGB) are read`) rather than half-decoded into a wrong image, because
  the failure mode of guessing at an image is a file that looks right until it
  is opened in the game.  `encodePng` writes the same shape back, so a round
  trip reproduces width, height and every byte of every pixel.  The kernel's
  byte verbs are what make any of this possible: `file.read` refuses a file
  holding a NUL byte and `file.write` can only carry a JSON string, so before
  `file.read_bytes` / `file.write_bytes` an image had no way in or out of a
  workspace at all.
- A `pixel <path.png> [width] [height]` card is a drawing surface over one PNG.
  Pencil, eraser, flood fill, eyedropper and a hand that pans; the wheel or the
  zoom buttons scale from 1× to 32×; the palette is sixteen `#rrggbb` swatches
  plus a colour field that takes any `#rrggbb` or `#rgb`.  What the card puts in
  the board document is `{file, width, height, palette}` and **nothing else**:
  the pixels are the file, not the document, so a board save stays a small JSON
  document and an undo of a card *move* cannot resurrect a drawing that was never
  saved.  A file that is not there yet opens blank at its declared size — 96×96,
  or the size on the command line — showing a checkerboard through its alpha, and
  the first save creates it.  One file is one card: a second `pixel` command for
  the same path focuses the card that already has it, because two cards on one
  path are two buffers that save over each other and both look right until one
  does.
- Which is a problem the board's undo ring cannot solve.  The ring snapshots
  *documents*, and the artwork deliberately is not one, so Ctrl+Z over a stroke
  would either do nothing or move the board underneath — the one thing worse than
  doing nothing.  `Ctrl+Z`, `Ctrl+Shift+Z`, `undo` and `redo` therefore offer the
  step to the **selected card** first (`main.mjs`'s `cardUndoOrRing`) and fall
  through to the board's ring only when the card answers that it did not take it.
  The card's own ring holds 64 gestures and stores, per gesture, only the pixels
  the gesture changed — not a copy of the image, so a 1024×1024 drawing does not
  cost four megabytes a stroke.
- D006 — the one diagnostic whose *subject* is another file: the JSON is fine,
  the sprite it names is not there — now has somewhere to go.  The row used to
  open the declaring JSON; the sprite path is the diagnostic's `actual` (which
  never carries the `#json/pointer` that `path` does), so the row now opens a
  pixel card on the sprite, and the declaring file stays one click away on the
  row's meta line rather than being replaced.  What the defines do not carry is a
  size: no sprite in this tree declares one, and `shell/mods/knowledge.json` has
  no width or height anywhere in its schemas, so the card declares 96×96 and the
  person changes it if the art insists.

### Undo and redo on the board

- `Ctrl+Z` takes back the last board edit and `Ctrl+Shift+Z` puts it back; both
  are also commands (`undo`, `redo`).  The ring lives in `shell/web/history.mjs`
  — document snapshots with coalescing, so a drag is one step, not forty — and
  an edit that cannot be expressed as a document snapshot stays off the ring
  rather than half-on it.
- It covers cards and links: add, delete, move, resize, edit, and a committed
  `sheet` cell.  It does **not** cover the typing inside a card (the textarea
  keeps the browser's own undo), a pan, a zoom, or a "raise to front", and the
  ring is in memory, so a reload forgets it.  `shell/web/README.md` says all of
  this where a reader will look for it.  A pixel card is the one place where a
  step exists that the ring *cannot* hold — the pixels are not in the document —
  so the keystroke is offered to the selected card first and the ring only moves
  when the card declines; see the pixel section above for why that order is the
  safe one.
- What it does not reach is now tested as well as what it does:
  `tools/input_smoke.py` frames the app in a same-origin wrapper page, makes a
  real board change with a real double-click, dispatches the real keydowns, and
  checks that `Ctrl+Z` with a text field focused leaves the board alone.
  `make smoke` runs it after `browser_smoke.py`.

### A wheel over a card scrolls the card

- A card's contents — an editor's text, a sheet, a runner's output, the mods
  list — are a scroll region *inside* the board, and their wheel events bubble up
  to the board element.  Panning unconditionally meant the board moved and the
  card never did.  The wheel handler now walks up from the pointer to the nearest
  container that can still move in the direction the wheel asks, and leaves the
  event to it; at the end of that container the wheel pans again, the way nested
  scrolling usually chains.  `Ctrl`+wheel still zooms about the cursor.
- Neither half of that is taken on faith.  `shell/web/selftest.mjs` proves the
  arithmetic underneath without a DOM (`scrollRoom`) and `tools/input_smoke.py`
  proves the wiring in a real browser: it opens a file through the real command
  line so that a card genuinely can scroll, then dispatches a wheel over that
  card's own textarea, over bare board, and with `Ctrl` held.

### A file that changes while nobody is looking

- The kernel announces a write **it** made (`file.changed`) and nothing else.  A
  file rewritten by `git checkout`, by a formatter or by another editor was
  silently re-overwritten the next time the card was saved, because the card had
  no way to learn that its revision was stale.  The kernel gains one method for
  it: `file.stat {path}` → `{path, exists, dir, size, mtime, revision}`, where
  `revision` is computed by the same function `file.read` uses, so the two can
  never drift.  It moves no text, so asking is cheap enough to do on a timer.
- A file that is not there is a **result, not an error** (`exists: false`,
  `size: 0`, `mtime: -1`, `revision: 0`), and `revision: 0` means *cannot
  compare* — a directory, a binary, a file over 4 MiB, or a card that has not
  read the file yet.  An empty file is `2166136261`, not `0`, so "empty" can
  never be mistaken for "unknown".  `docs/PROTOCOL.md` carries the table.
- `shell/web/watch.mjs` decides what an answer means and is pure — no DOM, no
  clock — so `shell/web/selftest.mjs` pins the whole table without a browser.  A
  clean card reloads; a card with unsaved edits **keeps its text** and is told
  the file changed; a deletion is reported instead of written back; a revision
  that cannot be compared warns and is never treated as "unchanged".  A decision
  is acted on only when it is news, so a card warns once rather than every 1.5 s.
  `main.mjs` polls; a path held by three cards is one `file.stat`.
- A trimmed kernel with no `file.stat` is not a failure: the shell recognises
  `-32601`, stops asking and logs one line, and the board keeps working as it did
  before the poll existed.
- `tools/input_smoke.py` proves it end to end, because a unit test cannot: it
  rewrites a file with a **real child process** (`cmd /c echo`) while an editor
  card holds it and reads the card's own status back — clean reload, dirty warn,
  deleted, and never a revision the card did not read.
- `tools/kernel_probe.py` gains the other half against the real kernel: 9 checks
  over text, empty, directory, binary, missing, escape, notification-free and
  agree-with-`file.read`.

### Closing a card asks before unsaved text goes

- Every open card now has a tab in **both** tiles.  The sidebars keep what they
  always showed (project/files; in the mod view also mod and problems) and every
  other kind of card -- notes, docs, stories, pixels, the tool console -- lands in
  the strip, so a card opened in one view is reachable in the other instead of
  being open and invisible.  The click target is one container per card
  (`div.tab[data-card-id][data-kind]`) with a name button and a close button; the
  old fixture-based tab ids are gone from `tools/input_smoke.py`, which is why that
  suite gained a check rather than losing one.
- Three gestures close a tab -- `x`, a middle click, `Ctrl+W` -- and all three go
  through the same `closeTab` → `closeCard` path, so there is no second way to
  delete a card.  Which tab becomes active afterwards is a pure function
  (`classicNeighbourAfterClose`: the right neighbour, else the left, else
  nothing), shared by both views.
- A card with unsaved text **asks** first: save and close, discard, or cancel,
  with Escape meaning cancel, and a save that throws keeps the card (and its text)
  exactly where it was.  A clean card closes without a question, as it did before.
  This is an inline strip above the command line, not a modal: the app still has
  no dialogs.
- The old "focus the card after opening it" bug is gone: focus used to be applied
  before the render, so a card in a `display:none` region could be opened, its tab
  clicked, and never receive the keyboard.  The fixed order is select → render →
  focus.
- `shell/web/selftest.mjs` 227 → 238 checks, `tools/browser_smoke.py` 11 → 42
  (22 view × kind, reachability in both tiles, four gestures, three answers), and
  `tools/input_smoke.py` 42 → 43 against the real kernel.

### Finding the game: a setting, the environment, or discovery

- The game's Mods folder used to be a path in the source.  It is now a documented
  search: an explicit setting wins, then `INFANTGOD_MODS_DIR` /
  `INFANTGOD_GAME_DIR`, then discovery under the platform's Steam install
  directories (`steamapps/libraryfolders.vdf` in each), the user's home and the
  checkout's parent.  "Not found" is a value with a name -- `{dir: null, source:
  "not found", tried: [...]}` -- and `describeDiscovery` turns it into one line:
  `found <dir> (<source>)` or `not found; looked in N places`.
- `steamInstallDirs(env, platform)` names the per-platform defaults
  (`ProgramFiles(x86)` on Windows, `~/Library/Application Support/Steam` and
  `~/.steam/steam` on macOS, `~/.local/share/Steam` and `~/.steam/steam` on Linux)
  and takes the platform as an argument, so the checks speak for all three from one
  machine.  `shell/mods/selftest.mjs` 290 → 297.
- `tools/path_guard.py` fails the build on a home directory or a network share in
  a tracked file, and `tools/make-installer.mjs` audits the unpacked payload for
  the same thing before packing it; three allow-listed files carry the example
  corpus's game names on purpose, and the reason is in the file.

### The editor card behaves like an editor

- The editor card gained the keys a person reaches for before trusting a text
  box: `Tab` and `Shift+Tab` indent and outdent the lines the selection touches
  (with no selection they insert or remove one unit at the caret, so `Tab` is
  still a tab), `Enter` keeps the current line's indentation and steps in one more
  after `{`, `(`, or `[`, and `Ctrl+F` opens an in-card find bar — query, a live
  `3 / 7` count, previous and next, a replacement box, Replace, Replace All, and
  `Esc` to close.  `Enter` splits by the line **up to the caret** rather than the
  whole line, so pressing it in the middle of a deeply indented line no longer
  leaves the tail indented.
- Matches are painted as well as selected.  The textarea's text is transparent
  and the colours live in the `<pre>` behind it, so a hit is drawn as a `<mark>`
  in that layer: the colours survive inside the hit and the hit stays visible
  while the caret sits in the find bar.  The token spans are **split** at the hit
  boundaries (`markHits`) instead of being replaced.
- Every edit the card makes on the user's behalf — the indent, the auto-indent,
  replacing one hit, replacing all of them — goes in through
  `document.execCommand("insertText")` over the selected range rather than by
  assigning to `value`.  Assigning to `value` throws away the browser's undo
  stack, so `Ctrl+Z` after a `Tab` or a Replace All would have cleared the whole
  file; the command is the one way to have both a programmatic edit and a real
  undo step.
- Nothing about it is taken on faith.  The arithmetic is pure and exported
  (`indentSelection`, `indentAfterEnter`, `findMatches`, `replaceMatchAt`,
  `replaceAllMatches`, `markHits`) and `shell/web/selftest.mjs` checks it with no
  DOM at all (86 → **96** checks), and `tools/input_smoke.py` presses those keys
  in a real window — including the check only a browser can make, that a `Ctrl+Z`
  after the card's own `Tab` still restores the buffer because the edit really did
  go through the insert command (13 → **19** checks).  Each new check was
  sabotaged one at a time — `markHits` dropping the hit, `indentSelection` doing
  nothing, `findMatches` stopping after the first hit, the editor assigning to
  `value` instead of using the command — and each turns its suite red, after which
  the file was restored byte-identically.
- The card's limits are unchanged and now written where its keys are
  (`shell/web/README.md`): one undo step per programmatic edit, no per-key
  bindings, no code folding, and the find bar is literal text only — no regular
  expressions, no match-case and no whole-word toggles.

### One version, checked

- The version has exactly one definition: the `VERSION` file at the root, edited
  only through `tools/version.py` (`show`, `check`, `set`, `bump`), which writes
  `core/include/infantgod_cfg.h` and keeps `shell/main.mjs`'s banner and
  `package.json` in step.  `make version-check` (part of `make test`) fails if any
  copy drifts.  `package.json` is in that list because electron-builder stamps
  *that* number into the installer: if it drifts, the shipped product's file name
  and About box disagree with its own `hello`.
- `core/src/main.c` no longer carries a second `#define SDE_VERSION`.  It could
  disagree with the header's copy in the same binary — `infantgod version` read
  one, `hello` read the other — and a header-only version bump rebuilt nothing at
  all, because the Makefile's object rules named only the `.c` files.  Both are
  fixed: every object now depends on every header and on `VERSION`.  Recorded as
  entry **G** in [`docs/BUGS.md`](docs/BUGS.md).

### Tools

- `tools/seide_cli.py`, `tools/kernel_probe.py`, `tools/e2e.py` and
  `tools/demo.py` speak `view.load` / `view.save`; the CLI's `new-id` verb is gone
  with `board.newId` (the client allocates ids) and its `board` command prints
  whatever `view.load` hands back, with a note — not an error — when the document
  is not the board shape.  `tools/browser_smoke.py` and `tools/input_smoke.py`
  need no change at all: `.infantgod/board.json` was always just a file to them, and
  that is now the truth of it.  The probe stops pinning refusals the kernel no
  longer makes and pins the opacity contract instead: a document the board schema
  would reject is stored and handed back unchanged, a stale `base_revision` is
  `1001` with `data.current_revision`, and a save with no `document` (or `null`)
  is `-32602`.  The CLI selfcheck reads `SDE_PROTOCOL_VERSION` out of
  `core/include/infantgod_cfg.h` rather than hard-coding a protocol number.
- `tools/e2e.py` removes the empty `.infantgod/` directory left behind when the
  suite created the board and put it back: a test run should not leave a state
  directory nobody asked for.  `make test` in a fresh clone now ends with the
  tree exactly as it started.
- `tools/input_smoke.py` imports the host, the browser lookup and the board
  backup from `tools/browser_smoke.py` instead of carrying a second copy: one
  place to fix when `serve`'s banner or the board path changes.  The board
  backup's "the clone had no board" branch is no longer guarded on the test
  having installed the starter board, because the host autosaves one anyway.

### A worked example, inside this repository

- New `examples/Mods/Lantern/`: twenty-two files, every byte of them written here
  rather than copied from the game — `mod.json` (`loadOrder: 5`), `README.txt` (the
  walkthrough), `Lantern.yarnproject`, `Yarn/Lantern.yarn` (two nodes, five spoken
  lines, each with a `#line:` id, exercising `#state:`, `#vo:`, `#Check:`, `#Topic:`
  and `#Modify:`, one line calling `<<AdvanceTime 1>>`), the base table
  `Yarn/Lantern.csv` and its `Yarn/Lantern_en.csv` translation (the game's eight
  columns; the base table carries no language suffix and the `en` table is mapped
  by the yarnproject, the way the game's own projects do it), four 32×32 8-bit
  sprites under `Sprites/` — three RGBA and one **RGB**, the case the reader used to
  hand back with an alpha byte — drawn pixel by pixel with the repository's own PNG
  writer, two small 8 kHz 16-bit PCM files under `Audio/` (made by a scratch script,
  not the game's), a placeholder `Spine/Warden_Rig.json`, and `Defines/` with a
  character (portrait, email portrait, spine asset path), a character state, a pixel
  animation (bone and physics tracks, an audio event), an audio event, a song, a
  voice-over definition and three attachments.
- Two defects are there on purpose, so the checks that look for them have something
  real to find: `Defines/Attachment/Lantern_Broken.json` names a sprite that does
  not exist (`D006`, and the pixel card's own entry point into creating it), and
  `Lantern_en.csv` is missing one of the three lines while another line's lock
  disagrees with the base table (so one row reads as missing and one as stale in the
  story card's translation column).
- `tools/input_smoke.py` needs no game install any more: its mods root is
  `examples/Mods` and its mod is `Lantern`.  The >4 MiB table it opens through a blob
  session is built by the run itself (`build/__input_smoke_table.csv`, 4,500,403
  bytes, 14,369 rows — and the last row past the 4 MiB single-read cap), the `D006`
  check points at the example's missing sprite (and the pixel card opens at the size
  that definition declares), and one check asserts that the suite used the
  repository's own mod and a table it made.  The suite is falsifiable about both: put
  the missing sprite back and the `D006` check fails; point `MODS_ROOT` at a game
  installation and that check fails — and that second run exposed a real defect of its
  own (the detail line computed a relative path and crashed the run instead of failing
  the check; it now reports the outside path as a failure).
- The example is a coverage matrix rather than a sample: it names every kind of file
  the tooling claims to understand, and the checks assert what the tools *do* with
  them instead of what the tags promise.  Three new checks were added for it, and
  `tools/input_smoke.py` now runs 43 checks (four more than the first delivery), all
  of them green twice in a row; three breaks — the RGB sprite swapped for RGBA, the
  `#vo:` line deleted, an audio event pointing at a file that is not there — each
  turned its own check red, and every file came back byte-identical.  The honest
  result of the matrix is that the gaps are now named rather than hidden: the RGB
  sprite is read and comes back as RGBA because the writer always emits colour type 6
  (**G20** in `docs/EDITOR_GAPS.md`), the story card carries `#vo:`/`#Check:`/`#Topic:`/
  `#Modify:` without validating or resolving any of them and diagnoses only the one
  unknown `#state:Calm` (`Y104`) — **G21** and **G22** — and a package check finds
  exactly the two deliberate defects it should: one `D006` error and one `M008`
  warning, with both WAV files read and named.
- `docs/MODS.md` gains "The worked example we ship" — a per-file table of the
  example, what each deliberately broken thing is for, what the checks prove and
  which gaps are still open.
- `shell/web/README.md` gains the `mod`, `problems` and `docs` command rows plus a
  walkthrough that runs the shell with `--mods-root examples/Mods`.

### A new mod, from the File menu

- Electron's File menu gained **新建模组…**: a submenu of the engine's own four
  scaffolding templates (`最小可加载`, `对话剧情`, `定义包`, `完整工程`, the first
  on `CmdOrCtrl+N`), inserted right after "Choose Mods Folder…".  Choosing one opens
  a native save dialog (title `新建模组`, default `<the folder used last>\NewMod`,
  button `创建`) whose folder and file name are the mod's name and folder; the menu
  then scaffolds it over the shell's own JSON-RPC — one `POST <endpoint>/rpc`
  carrying the existing `mod.scaffold` frame — so no protocol method was added and
  nothing new is spoken.  A packaged window's shell lives at
  `process.resourcesPath/shell` and is loaded by URL, so the menu reaches it through
  the loopback endpoint (`session.url`) and never `require`s `shell/mods/` out of the
  archive.
- The logic that can be tested by itself lives in `electron/newmod.js` (CommonJS,
  imports only `node:path`; no Electron and no `shell/**` at runtime): the template
  table (ids and labels are the engine's own `nameZh`, and a drift between the two
  fails a check), `defaultParent` (the mods root when there is one, else the
  workspace), `plan` (a blank name, `.`, `..`, a path separator, a trailing dot or a
  Windows-hostile character is refused rather than guessed at, and `dir` is the
  parent `mod.scaffold` wants — so the folder the dialog names is the mod's own
  folder, not a parent of it), the exact JSON-RPC frame, and `createMod`, which
  raises the server's own error instead of swallowing it.
- Afterwards the mod is expanded in the workspace that is already open: when the new
  folder is inside it, the window reloads so the project panel lists the mod; when it
  is not, a message box asks whether to make the new mod's parent the workspace.  The
  parent is remembered (the `newModDir` setting) so the second mod starts where the
  first went, and every failure goes to the same `新建模组失败` report as the rest of
  the menu — a click never ends in silence.
- `shell/mods/selftest.mjs` carries the testable half (the `mods` suite: 84 → 106
  checks): template parity against `scaffold.js`, `defaultParent`, the name refusals,
  the menu fragment and each item's id, the request frame, a refused scaffold raising
  the server's error, and a live endpoint that scaffolds `Probe` onto a sandbox
  through `plan` and asserts the dialog's folder is the mod's own folder.  That last
  check is the seam where a first cut nested the mod one level deep (the chosen
  folder left empty, the mod in `<chosen>\<name>`): restoring the old
  `dir: path.join(parent, modName)` turns five checks red and prints
  `…\Probe\Probe`.  Six such breaks were each caught by their own check, with
  `electron/newmod.js` byte-identical after every restore.
- An independent pass re-drove the whole path with its own endpoint and harness: the
  four template ids come back in the engine's order with the engine's names, a second
  scaffold into a non-empty folder is refused by name with the first one's files
  kept, a missing parameter is `-32602 missing non-empty string \`dir\``, an
  out-of-bounds folder is refused (the mod layer tags that error `EOUTSIDE`, but the
  dispatcher wraps anything that is not an `RpcError`, so the wire shows
  `SHELL_ERROR 路径越界，已拒绝: …` — `docs/MODS.md` now says that instead of naming
  a code a client will never see), and a chosen path really becomes the mod root.
  The same pass found the nesting defect, which is why the check above exists.

### The window opens on the mod view, and a new mod opens with it

- A cold window now boots into the **mod** tile.  The classic tile is one click
  away and `mode classic` still names it; `DEFAULT_VIEW` keeps `classic` only as
  the fallback for a view name nobody recognises.  A tester's first screen is the
  thing this fork exists for, not a file tree.
- File → 新建模组… now *opens* what it created.  Changing the window's URL replaces
  the document, so the old path reloaded and landed on whatever the board had
  managed to autosave: the package was on disk but the window showed an empty mod
  card whose "Mods/MyMod" is a placeholder that reads like a value, with three
  section headings that were plain text.  The menu now flushes the board through
  `window.__infantgodFlushBoard` and loads `/?mod=<folder>`; the page's boot reads
  that query, finds the last mod card or adds one, points it at the folder and
  switches to the mod view.  A mod opened by hand from the panel's own input goes
  through the same `setDir` path.
- The three section headings are targets now: `MOD.JSON`, `DEFINES` and `YARN` are
  buttons (mouse, `Enter`, `Space`) that open `mod.json`, the first definition and
  the first yarn file, each section says `（空）` when it has nothing and shows the
  package-relative hint while no package is open.  Opening a bad relative name now
  says so in the card's status line and in the app log instead of calling a
  `refresh()` that does not exist — the click no longer ends in silence.
- The "another writer changed this document" warning no longer fires on the
  window's own save: the save notification can overtake the reply, so a page was
  told about a revision it had itself just written.  `classifyViewEvent({revision,
  boardRevision, dirty})` sorts a view event into *our own echo*, *follow* (a dirty
  or older page adopts the newer revision) or *warn*, and events that arrive while
  a save is in flight are queued and judged when it settles.  A real external write
  still warns — that case is a check.
- `shell/web/selftest.mjs` 225 → 227, `shell/mods/selftest.mjs` 143 → 148 (five unit
  checks for the URL builder), `tools/browser_smoke.py` 5 → 11 (six: a cold boot
  lands on the mod tile, `?mod=` opens the package the menu wrote, the three
  headings open their files, a page's own save is not logged as another writer, a
  real external write still warns, a wrong relative name fails visibly while the
  right one opens) and `tools/input_smoke.py` 42 → 43.  Five breaks
  (`build/falsify_task17.py`: the boot view put back to classic, `?mod=` parsing
  made to return null, the save queue removed, the heading listeners removed, the
  open-failure log removed) each turned its own check red, and all fourteen files
  came back byte-identical.
- `shell/mods/selftest.mjs`'s real-endpoint group is gated on
  `build/infantgod.exe`; when the binary is absent those three checks are *skipped*
  (the count then reads 145 executed, 1 skipped) rather than silently passing.
  Copying the kernel out of the frozen payload — the same bytes the installer
  ships — restored 148/148 with nothing skipped.  The gate stays: it is an
  environment fact, and the report says which one.
- Not machine-verified, and recorded as such: the native save dialog and a real
  menu click need an Electron window with a display, which this session does not
  have.  The two halves the click wires together — the `/?mod=` URL the menu builds
  and the `POST /rpc` frame it sends — are both covered.

### An installer we build ourselves

- The setup program is no longer electron-builder's NSIS target.
  electron-builder builds an installer in two passes: the first compiles an
  installer, *runs* it to make it write the uninstaller
  (`NsisTarget.js:347`: `execWine(installerPath, null, [],
  { env: { __COMPAT_LAYER: "RunAsInvoker" } })`), then compiles the real one.  On
  this machine the middle run exits 2 and electron-builder reports
  `⨯ Exit code: 2` — but leaves the pass-one artifact in `dist/`, and double-clicking
  *that* is the "Error writing temporary file.  Make sure your temp folder is valid."
  dialog.  A minimal installer compiled with the same `makensis.exe` (the one
  electron-builder caches) ran silently, exit 0, with both the inherited environment
  and a replaced one — so the toolchain was never the problem; the chained wrapper
  was.
- The replacement is `tools/installer.nsi` (166 lines, MUI2, Unicode, per-user
  `$LOCALAPPDATA\Programs\OsanaKami IDE Studio`, Start Menu shortcut, an uninstall entry
  and a working uninstaller) driven by `tools/make-installer.mjs` (one `makensis`
  call over a frozen payload, then sign and verify, then a JSON summary in
  `build/make-installer.json`).  `package.json`'s `dist` is electron-builder
  `--dir` for the payload followed by this script; `dist:nsis` keeps the old path
  for comparison.
- The setup's licence page is `EULA.txt`, copied into the program directory along
  with `LICENSE.electron.txt` and `LICENSES.chromium.html`: `Install: 5 pages
  (320 bytes)` against a licence-less control's `4 pages (256 bytes)`, 4,472 bytes
  apart.  The payload is installed verbatim (127 files, 386,117,895 bytes) and
  compressed with zlib: `/SOLID lzma` silently installs *nothing* at this payload
  size on this machine, measured rather than assumed (116 MB vs 157.8 MB for a
  package that works).
- Every build walks the payload and refuses to finish on a game marker or a machine
  path outside a printed allow-list.  The allow-list has three entries today —
  `resources/shell/mods/knowledge.json`, `shell/mods/scaffold.js` and
  `shell/mods/search.js` — each with the reason it is still there and
  `TODO: must be empty before public distribution`; four audit cases (clean
  baseline, a planted scrap, the scrap removed, an allow-listed hit) and three
  template breaks all behaved, with the template byte-identical after each.  The
  audit is **red** right now on 41 hits in 14 files (the §14.1 cleanup: the example
  mods, the language files, three shell modules and the electron README still name
  the game), so `npm run dist` exits 1 until that lands; release candidates are
  built with `--no-audit` and this entry says so.
- End to end, 19 checks on a copy of the shipped bytes (18 when the payload
  executable is not named, which skips the payload-hash check): silent install into
  a scratch directory, every one of the 127 payload files compared byte for byte,
  shortcut and both HKCU keys, the three licence files, then `/S` uninstall leaving
  no directory, no shortcut and neither key.  One caveat is written down in
  `build/e2e-final5.out`: running the same bytes straight out of `dist/` from this
  sandboxed session does not reproduce (exit 0 in one second, nothing installed,
  while the identical copy in `build/` installs in eight); the artifact is
  byte-identical by sha256, so this is a session/environment effect, not the
  package.  The final package — rebuilt under the new name, `OsanaKami IDE Studio
  Setup 0.1.0.exe`, sha256 `e0ab79e5…50604b`, signed `CN=OsanaKami IDE Studio` —
  was checked the same way out of `build/`, against its own payload
  (`build/_lead_verify_final.log`): install, all 127 files, the three licence
  files, the shortcut, both renamed keys (`com.osanakami.idestudio`,
  `Software\OsanaKami IDE Studio`), then uninstall — 19/19, exit 0 throughout,
  nothing left behind.

### A knowledge base that can be rebuilt, and a machine with no game

- `tools/gen_knowledge.mjs` rebuilds the facts half of the knowledge base from
  `SODefines/{Schema,Defines}` (plus Yarn and CSV when a mod is given): commands,
  functions, variables, nodes, schemas, locales.  It deliberately drops the
  descriptions, the `#region` comments and the 53-character palette, and it can
  compare itself to a knowledge base that already exists — `--check` exits 0 on a
  match, 1 on drift and 2 when it cannot run, and `--diff` prints, section by
  section, the names only one side knows.
- `shell/mods/gamepath.js` is the one place that finds a game: an explicit setting,
  then `INFANTGOD_MODS_DIR` / `INFANTGOD_GAME_DIR`, then relative guesses (the
  checkout's parent, `ModsFull/Mods`, a Steam library, the home directory) — all of
  them relative, none of them this machine.  `DEFAULT_GAME_MODS_DIR` is gone and so
  is the absolute path `scaffold.js` used to write into new projects;
  `git grep -E "[A-Za-z]:[\\/]Users[\\/]" -- shell` is empty.
- A machine with no game is now a state instead of a crash or a lie:
  `knowledge()` answers `{present: false}`, a package validation gains a named
  `E000` error and `knowledge: "missing"` (an absent knowledge base used to be `{}`
  — "check nothing" — and reported `ok: true`), scaffolding no longer invents the
  seven built-in characters or defaults a speaker to `Aistalt` (it uses the mod's
  own names), and emotion suggestions come from the knowledge base when there is
  one (`source: "knowledge-base"`) or from a neutral six-name list
  (`source: "neutral"`) instead of a literal table of the game's fifteen states.
  Which source answered is part of the answer.
- The committed knowledge base stays the one that ships, minus the two machine
  paths it carried (`gameModsDir` and `localization.projectPath`; 295,902 →
  295,678 bytes, every fact unchanged).  Regenerating it onto the package would be
  a silent regression: the committed copy knows 136 commands, 63 functions and 678
  variables where the generator sees 87, 38 and 810 — swapping them would delete 49
  commands and turn legal Yarn into "unknown command" diagnostics.  "Rebuildable"
  is therefore checkable and its drift is data (`--diff`), not a claim; removing the
  knowledge base from the package needs it to be loaded from the user's own install
  at runtime, which is the next step.
- Twenty-six new checks cover the discovery order, the named no-knowledge state and
  the generator's `--check` against a fixture the test builds itself; eleven more
  cover the tag sources and `--diff`.  Nine breaks and four breaks respectively each
  turned their own check red, and every file came back byte-identical.

### The mod checker learns the compiler's rules, and stops guessing

- The Yarn diagnostics were rebuilt against a specification reverse-engineered
  from the game's own editor extension, read as truth about the file format
  rather than as a feature list.  Fifteen rules the game rejects a whole mod over
  are new: a `visited()` target that does not exist (`Y108`), a `<<declare>>`
  whose first declarer is another file (`Y109`), a tag that needs a parameter and
  has none (`Y110`), a `Character:` line naming someone unknown (`Y111`), unknown
  and wrong-case tags and a `#state` missing its colon (`Y112`/`Y113`/`Y114`), a
  `#state` value in the wrong case (`Y115`), a node group member without its
  subtitle or with a duplicate one (`Y116`/`Y117`), paired commands that start and
  never end (`Y118`/`Y119`/`Y120`), and a shortcut option whose `#` runs into
  plain text (`Y121`).  Every error code we emit now has an error in the
  specification behind it; `Y103` and `Y105` became info, `Y003`/`Y005`/`Y006`
  became warnings, `Y000` was removed and `Y004` retired into `Y117`.
- The shared behaviours from the specification's section 11 are what make the
  checks usable at scale: a family goes silent when its index is empty instead of
  calling every value unknown; a `【…】` placeholder suppresses everything but the
  slot rule; 500 findings per file in the specification's generation order;
  per-group and per-pair dedupe; and an explicit do-not-report list (speaker
  names, `when:` expressions, function names, a lone `#line`).  Suggestions are
  deterministic — candidates from the current index only, a case-only difference
  wins, ties by code point.
- `examples/Mods/Lantern_Tests/` is the negative fixture: eight files, one rule
  per file, and a clean control file that must stay silent.  It is deliberately
  not the default example and carries no game data.
- The mod suite went 148 → 177 checks (one per rule, positive and negative); the
  real corpus (211 `.yarn` files through the production path) went 191 → 200
  findings, and each new one was read by hand: a `visited(" …")` with a leading
  space, `#Idle:`, `#troll`, six lowercase `#state:` values, two MyMod command
  pairs that start and never end.  Fifteen breaks, one rule muted at a time, each
  turned exactly its own check red, and `yarn.js` came back byte-identical.

### A language service we can build on

- `shell/mods/positions.js` is the offset layer everything else in the language
  service stands on: `offsetToPosition` / `positionToOffset` / `rangeBetween` /
  `rangeOfLineCols` / `wordAt` / `lineText`, and `diagnosticRange()`, which turns
  the diagnostics the mod layer already emits — `{line, col}` with a one-based
  column and a `length` or `endCol` — into a range a UI can underline.  The
  contract is written down and tested: an offset counts UTF-16 code units from 0,
  a line counts from 1, a column counts from 0, `\n`, `\r\n` and `\r` each end one
  line, a trailing newline opens an empty last line, a range never crosses a line,
  and an offset past the end clamps to the end.  Sixty checks, including a
  surrogate pair, a round trip at every offset, and CJK.
- `shell/mods/complete.js` answers the two questions an editor asks a language:
  what goes here, and what does this mean.  `classify()` names the context at the
  caret (command, argument, tag, tag value, variable, speaker) and the exact
  `replace` span; `complete()` returns ranked items whose `insertText` already
  carries the trailing space a command wants, the colon a tag wants and the `$` a
  variable needs; `hover()` resolves in the order the reference spec lays down —
  tag, then command or function, then variable, then node, then character — and
  answers `null` rather than guess.  Candidates come from `search.suggest()`, so
  there is still one fuzzy matcher and one knowledge base.  Built-in commands
  (`jump`, `detour`, `visited`, …) are answered from the parser's own list because
  they are not in the knowledge base.  Fifty-three checks over the real index:
  136 commands, 63 functions, 678 variables, 1221 nodes, 53 characters.  Both
  sets started as scratch files under `build/` and now run as two sections of
  `node shell/mods/selftest.mjs` (290 checks), because a check that only exists
  on the machine that wrote it is not a check.
- `docs/LANGUAGE.md` writes down what was taken from the reference specification
  and what was deliberately left: the L1 rules, the L2 verbs and the position
  contract are in; the VS Code host contract (a `package.json` `engines` field, 30
  commands, five tree views, a status bar, TextMate grammars) is out, because this
  is not an extension.  It also states the degradation rule the mod layer already
  follows — when the index is not ready, say only what can be verified and do not
  guess — and the shape of the RPC verbs that will expose this (`mod.complete`,
  `mod.hover`, both `{text, caret, path}` in, items with an exact `replace` out).

### An AI loop that speaks one protocol

- `shell/ai/` is the groundwork for the assistant, and none of it is wired to a
  window yet: `provider.mjs` (one OpenAI-compatible adapter — `chat`, `stream`,
  `complete`), `config.mjs` (the provider settings under the user's data
  directory), `tools.mjs` (a tool registry plus two read-only tools, `kb.search`
  and `mod.validate`), `selftest.mjs` and `README.md`.  Four files, 2,400-odd lines,
  no new dependency: `node:fs`, `node:path`, `node:os` and the `fetch` Node has
  had since 18.
- The contract is the one the endpoints actually speak: `POST
  {baseUrl}/chat/completions`, `authorization: Bearer` only when a key is set,
  `text/event-stream` when streaming.  SSE frames are cut on a blank line, a frame
  split across TCP reads is put back together, `delta.tool_calls` accumulates
  across frames **by index** (so a name arriving in two pieces and three calls
  arriving at once both survive), `[DONE]` or a finish reason ends the stream, and
  a model that ignores `stream: true` is accepted as a non-streamed answer.
  Failures are classified `auth`, `rate`, `network`, `protocol`, `cancelled`; only
  a network failure is retried, once, and only if nothing reached the caller.
- The key never reaches a log or an error: `describe()`, the write receipt and
  every `ProviderError` show `***`, a corrupted config file falls back to defaults
  without echoing its contents, and `store.read().config.apiKey` is the one place
  the real value comes out.  The config is written atomically into the user's data
  directory.  The tools are read-only by construction — the registry refuses any
  tool marked as a writer unless a caller passes `allowWrite: true` — and their
  paths go through a lexical plus `realpath` containment check under the mods root.
- Seventy-two checks, and they run offline: the suite starts its own fake
  OpenAI-compatible server on `127.0.0.1:0` and writes only into a temporary
  directory it deletes.  Three deliberate breaks (tool-call accumulation, key
  redaction, path containment) each turned their own checks red — two, four and
  three of them — with the shared tree byte-identical before and after, because
  the breaks ran on a copy.
- It is not in `make test` by accident any more: the AI suite is part of `test`,
  and `!ai/selftest.mjs` keeps its 57 KB out of the installed package.

### Docs

- New `docs/VIEWS.md`: what the kernel defines (that a view exists — a place, a
  value, a revision, an atomic write, a notification) against what a client
  defines (what one is — the schema, the meaning, the path, the ids), the three
  failures that follow from confusing the two, and what it costs.  `docs/BUGS.md`
  entries A and E are kept as history with that context added.
- `docs/PROTOCOL.md` documents the two new methods, the method table (now
  eighteen entries, the five `file.blob*` verbs among them), the retired `1004`,
  and `workspace.info`'s `view_path` / `view_revision`; the blob layer is argued
  where it can be checked, under `## Files over 4 MiB: the blob layer` in
  `docs/ARCHITECTURE.md`;
  `docs/ARCHITECTURE.md`, `docs/PARADIGM.md`, `docs/TRIM.md`, `docs/SURFACES.md`,
  `docs/FORK.md`, `docs/PROJECT.md`, `README.md`, `tools/README.md` and
  `shell/web/README.md` now say that the board is the shell's convention and where
  the schema lives.  The counts in README.md, tools/README.md and
  docs/ARCHITECTURE.md follow the suites.
- The classic view is documented where it can be argued with: constraint 1 in
  `README.md` now says the board is still the only document and the new paragraph
  describes the projection, `shell/web/README.md` gained `### The same cards as a
  code area: mode classic` (the role table, the tile's arithmetic, and what the
  mode deliberately does not do — write, raise, take a shortcut or move the
  wheel), `docs/PARADIGM.md` answers "No tabs" honestly (a strip drawn from the
  cards is not the tab strip the paradigm rejects), `docs/PROJECT.md` keeps the
  project card *a card* even when the view draws it in a column, `docs/FORK.md`
  gives the mechanical cut, and `docs/TRIM.md` notes that cutting the board
  document takes the view with it.  The upstream commit also documented a
  multi-select, a workspace `find` and a `frame` card kind; those features are not
  in this fork, so no document gained them.

### Checks

- `make test` (e2e 22/22 in full mode, and 19 passed + 3 skipped against the kernel
  alone, kernel probe, cli-check, version-check, JSON, blob 130/130, langs 91/91,
  selftest 227/227, mods 290/290) and `make smoke` (browser smoke 11, input smoke
  43) are green.  The blob layer was held to the same bar rather than
  to "it compiles": ten breaks in `build/sabotage_blob.py` — a stale base not
  compared, a session table that answers to any id, an idle reaper that closes
  live sessions, a read cap and an append cap not enforced, an append at the wrong
  offset accepted, a read that ignores the offset it was given, a hash that folds
  one byte per chunk, an abort that forgets its temporary file, and a commit that
  reports success without publishing — were all caught by a failing check (the new
  `core/tests/test_blob.c` and `tools/e2e.py`'s six blob checks between them), and
  `core/src/blob.c` was restored byte-identical by `sha256`.  The point of the
  layer was measured against the game's own table rather than a fixture: the real
  5,751,617-byte `Mods/MyMod/Yarn/NewProject_RU.csv` is refused by `file.read`
  with `1003 file is too large to open`, then read through a session in six frames
  (1 MiB, 1 MiB, 1 MiB, 1 MiB, 1 MiB, 508,737 bytes) whose concatenation is the
  file byte for byte, and written back through a write session to a copy with the
  same sha256 as the source; the stale-base, wrong-offset and over-1 MiB refusals
  were exercised on the same run.  The same file was then read by the *card*, in a
  real browser: a `tools/input_smoke.py` check opens the story card on the real
  5,751,617-byte table (hard-linked under `build/`, because `file.*` is bounded by
  the workspace and the mods root is its sibling) and compares the card's 18,609
  rows and its first and last translated cells — the last row at byte 4,617,216,
  past the cap — against values computed from the file in Python; with `loadTable`
  made to read the table whole again the check goes red (`could not read … file is
  too large to open`), and `shell/web/cards.mjs` was restored byte-identical.
  Every
  new promise was sabotaged to prove its check can fail (throwaway
  `build/sabotage_view.py`): the kernel repairing a document, a stale save
  accepted, a first-run answer that is `{}` instead of `null`, the client writing
  a card its own model cannot read, and the client booting from a path of its own
  invention.  All five were caught, and the three sources were restored
  byte-identical.  The editor's gutter was put to the same bar: a gutter that
  paints nothing and a gutter whose click does not toggle were both caught by
  `tools/input_smoke.py`, and `shell/web/cards.mjs` was restored byte-identical.
  That file was also reading the current view out of `#mode-toggle`, the single
  button the classic view introduced and the view switch replaced: the stale
  lookup threw inside the classic block and took four checks down with it, which
  is why it now finds the button marked `is-current` instead.  The three promises
  this release adds were held to the same bar (throwaway
  `build/sabotage_default_view.py`): a window made to open on the board instead of
  the classic tile, a message strip made to ship unfolded, and the board put back
  on the switch — each was caught by the suite that claims it, and `views.mjs` and
  `index.html` were restored byte-identical.  The first two are only visible to a
  real window, which is the whole reason `tools/input_smoke.py` reads them: no
  DOM-less check can see which mode a window booted into.  The byte verbs were
  held to it as well (throwaway `build/sabotage_byte_verbs.py`): a payload that
  is not base64 accepted and written anyway, a revision that is not the file's,
  the shared `base_revision` guard skipped, and a `size` counted in characters
  instead of bytes — all four were caught, by `tools/e2e.py` for the first, third
  and fourth and by `tools/kernel_probe.py` for the second, and `core/src/wksp.c`
  was restored byte-identical.  The story editor was held to it the same way.
  `build/sabotage_storycsv.py` changed eleven things about the translation
  tables -- quoting that ignores commas and quotes, a `lock` written
  little-endian, rows split on every comma, the line ending not detected, the
  byte order mark dropped, a stale translation not reported, an untranslated row
  called translated, a missing row not reported, metadata tags dropped, an edit
  not written back, and speakers not collected -- and all eleven were caught by
  the storycsv checks, with `shell/web/storycsv.mjs` restored byte-identical.  `build/sabotage_story_column.py` then broke the
  card's column four ways (the row looked up by the bare id instead of
  `line:<id>`, the cell showing the line's own words instead of the table's, the
  column never drawn, and the table read but its rows thrown away) and
  `shell/web/cards.mjs` was restored byte-identical after each.  The row a new
  line owes the table was put to it too (throwaway
  `build/sabotage_story_sync.py`): a `lineNumber` that stops continuing the
  node's, a row that forgets which node the line is in, a `lock` that is no
  longer the hash of the text the row carries, a row that loses one of the eight
  columns, a card that adds the line but never tells the table, and a table
  rewritten even though the card added nothing — all six were caught, by
  `shell/web/selftest.mjs` for the shape and by `build/storycard.probe.mjs` for
  the wiring, and both files were restored byte-identical.  The completion of
  `<<commands>>` was held to it too (throwaway `build/sabotage_completion.py`):
  a name offered for not starting with what was typed, a name the compiler marked
  broken offered anyway, a space no longer ending the name, a `>` no longer
  closing the command, taking a name dropping what came after the caret, a JSON
  file that is no schema read as an empty one, a function's answer left out of its
  call, a command edited with its indent inside the field, a command written back
  losing its indent, and a suggestion taken but never written — all ten were
  caught, by `shell/web/selftest.mjs` for the schema reading and by
  `build/storycard.probe.mjs` for the card, and both files were restored
  byte-identical.  The corpus is the second half of the bar: 211 real `.yarn` files
  parse and re-serialise byte for byte, and the story card's own probe opens a
  real story with its real `NewProject_EN.csv` and edits through the card.  The pixel
  work was held to the same bar, and to the corpus.  `build/sabotage_pixelpng.py`
  broke the codec twelve ways — Paeth read as Up, a row's filter byte not consumed, a
  chunk length read little-endian, the zlib check bits ignored, the check bits taken
  from the wrong byte, RGB gaining an alpha byte, the Adler-32 ignored, a 4-bit depth
  accepted, an interlaced image read as if it were not, a back-reference allowed to
  reach before the start of the image, colour type 2 accepted while the writer emitted
  RGBA, and one pixel painted a column to the right — and all twelve were caught by
  `build/pixelpng_check.mjs`, which walks the 374 real PNGs under `Mods` (28,332,585
  pixels), decodes, re-encodes and decodes every one of them back to the same pixels,
  checks the encoder's own stream against a bit pusher written from RFC 1951 and the
  reader against `zlib`, and refuses a PNG it does not understand by name;
  `shell/web/pixelpng.mjs` was restored by `sha256` after each case.  Ten more were
  aimed at the card (`build/sabotage_pixel_card.py`): a palette thrown away, `#rgb` not
  read as a colour, a byte of the eyedropper readout left unpadded, a new card seeded
  without its palette, a missing sprite declared at some other size, the eraser painting
  instead of clearing, a save that does not say which revision it read, a D006 row
  opening the declaring JSON instead of the sprite, and Ctrl+Z and Ctrl+Shift+Z moving
  the board even when the card took the step — all ten were caught, by
  `shell/web/selftest.mjs` and by `build/pixelcard.probe.mjs` (141 checks over the
  card's pixels and the pixel under a zoomed, panned cursor, its own undo ring and the
  app's route to it, a gesture released off the card, the bytes a save writes under the
  revision it read, and the D006 row), and `shell/web/cards.mjs` was restored
  byte-identical each time.  `tools/input_smoke.py` is what proves it in a real window:
  it draws a pencil drag and decodes the PNG the card wrote, takes a painted pixel back
  to transparent with the eraser, fills a blank image and reads all 64 of its pixels
  opaque out of the file, checks that Ctrl+Z over the canvas returns the pixel while the
  document stays identical, and clicks a real D006 row to open and draw on a sprite that
  is not on disk.  The board view's removal was held to the same bar
  (`build/sabotage_no_canvas.py`): the word put back on the registry, every word treated
  as a tile, an unknown view falling back to the classic tile instead of being refused,
  the zoom readout, the zoom arithmetic and the drawn link layer each put back — six
  breaks, each caught by a failing check (three source-level checks and the real command
  line in `shell/web/selftest.mjs`), with `main.mjs`, `views.mjs` and `index.html`
  restored byte-identical after every case.  What no DOM-less suite can see — that the
  window really has no canvas, no `#links` and no `#hud-zoom`, that `mode board` is
  refused and that the tile does not move — is read out of a real browser by
  `tools/input_smoke.py`, whose count went from 34 to 38 and then — with the worked
  example's matrix and the mod view's entry points — to 43.
- This release's newer promises were held to the same bar.  The installer: nineteen
  end-to-end checks on a copy of the shipped bytes (silent install, every payload
  file compared byte for byte, shortcut, both HKCU keys, the three licence files,
  then `/S` uninstall leaving nothing), a licence-page control that must differ from
  the licence-less build by one page and 4,472 bytes, four payload-audit
  falsifications and three template breaks — each case caught, the template and
  every source byte-identical after restore.  The worked example: three breaks
  (RGBA swapped in for the RGB sprite, the `#vo:` line deleted, an audio event
  pointing at a file that is not there).  The knowledge base: nine breaks around
  discovery, the named no-knowledge state and the generator's `--check`, and four
  around the tag sources and `--diff` (`searchroot`, `fullfirst`, `noe000`,
  `invent`, `descr`, `checkequal`, `lang`, `delfact`, `kbpath`, `literal`,
  `diffsilent`, `diffexit`).  The mod view: five breaks (`bootview`,
  `requestedmod`, `savequeue`, `headings`, `openlog`), each caught by the check
  that claims it (`build/falsify_task17.py` prints, per case, the failing check
  name and a `restore ok`).  Every file involved was restored byte-identical, by
  sha256, and the counts above are from a final clean run.

### Licence

- The code stays **MIT** ([LICENSE](LICENSE)) and the prose documentation
  becomes **CC BY 4.0** ([LICENSE-DOCS](LICENSE-DOCS)): every Markdown file in
  the repository is documentation, everything else is code.  The fork is a
  derivative of MIT code, so this is the licence it was always allowed to carry.
- New `EULA.txt`, and the installer now shows it: `nsis.license` in
  `package.json` puts an early-version notice on the setup's licence page instead
  of the MIT file.  It is deliberately *not* a restrictive agreement — the project
  is free (code MIT, prose CC BY 4.0), the notice says so itself, defers to
  `LICENSE`/`LICENSE-DOCS`, and promises to narrow nothing.  What it does say is
  the one thing a licence page is good for: this build is early, it is not stable,
  it may have bugs, it writes the files under your Mods directory, back them up.
  It also says how the program was made — AI-authored throughout, corrected by hand
  in DSH sessions, backed by self-tests and by the rule that a key promise needs a
  sabotage run that turns a check red — which is part of judging an early build
  rather than a footnote to it.  Plain text with a UTF-8 BOM, because NSIS's licence
  page is not Markdown and does not guess an encoding.
- §5.1 of that notice and the licence paragraph of `README.md` now say whose names
  these are: the product is not affiliated with or endorsed by the game's authors,
  the game's names are the trademarks of their respective owners, and this program
  names them only to say what it is compatible with.  That is the descriptive-use
  half of the naming question in `docs/EDITOR_GAPS.md` §14.3; whether the product
  name itself may keep the game's name is a separate decision, still open, and this
  release does only the part that needs no rename.

### Tools and CI a clone can run

- `.github/workflows/ci.yml` runs `make CC=gcc test` on a Windows runner, and a
  `smoke` job that renders the board headless.  Neither job has run on a GitHub
  runner yet; the file says so in its own header.
- `tools/kernel_probe.py` and its stdio harness `tools/kernel_drive.py` re-check
  every bug in [`docs/BUGS.md`](docs/BUGS.md) against a scratch workspace under
  `build/`, so the ledger is runnable instead of being a claim: `make probe`.
- `tools/browser_smoke.py` renders the board in the system browser, asserts on
  the dumped DOM and restores the board byte for byte: `make smoke`.  It needs a
  browser and reports a skip, not a failure, when there is none.
- `tools/demo.py` installs `examples/board.json` — the five-card board in the
  screenshots — as `.infantgod/board.json`, because `.infantgod/` is gitignored
  and a fresh clone otherwise opens an empty canvas.
- `.gitattributes` pins `* text=auto eol=lf`.  Git for Windows ships
  `core.autocrlf=true`, which turned a checkout into CRLF and failed a suite
  that compares fixtures byte for byte.

### Documentation that had gone stale

Three places still described the prototype, and a reader comparing them with the
code would have concluded the code was wrong:

- `README.md` said there is "no undo", which stopped being true this release.
  It now says what undo does and where it stops.
- `shell/web/README.md` and `docs/PARADIGM.md` still claimed that
  `lang.tokenize` returns **UTF-8 byte offsets** treated as string indices, and
  said so as a known limitation.  It returns **string indices** (UTF-16 code
  units), which is what makes Yarn colouring land on Chinese prose; the "byte
  offsets" wording was simply wrong, and the four files that already said so
  (`README.md`, `docs/PROTOCOL.md`, `docs/FORK.md`, `langs/README.md`) were being
  contradicted by the two that did not.  The "residue" this first described — an
  astral character counting as two units in JS and one in Python's `len()`, so
  that `tools/e2e.py`'s tiling check could see an offset past the end — did not
  exist: `tools/e2e.py` measures its fixtures with `js_length` and judges every
  span in that same space, so the check is honest to the last unit.  The stale
  claim was withdrawn from `README.md`, `shell/web/README.md`, `docs/PARADIGM.md`,
  `docs/FORK.md` and `langs/README.md`, and `langs/selftest.mjs` now pins the gap
  over a shipped CJK fixture — eleven checks, both numbers measured.

## v0.1.0-alpha — 2026-10-15

First alpha.  Everything below was built after this date's earlier work on the
prototype, and the whole tree passes `make test`.

### Licence

- The code is MIT ([LICENSE](LICENSE)) and the documentation is now
  **CC BY 4.0** ([LICENSE-DOCS](LICENSE-DOCS), with the scope list, the
  attribution notice to keep, and the official legal code).  Every Markdown file
  in the repository is documentation; everything else is code.

### Board, still the project state

**The board is still the project state.** Cards on an infinite plane, links
between them, no tabs and no file tree.  A fresh clone opens an **empty canvas**
(the layout lives in `.infantgod/`, which is git-ignored) — `python tools/demo.py`
installs the five-card starter board from `examples/board.json` if you want the
screen in the README.

### Kernel (`core/`, C89, no dependencies)

- Newline-delimited JSON-RPC over stdio; `hello`, `workspace.info`,
  `workspace.list`, `file.read`, `file.write`, `file.stat`, `board.load`,
  `board.save`, `board.newId`, `exec.start`, `exec.stop`, `exec.list`.  (That
  list is the 0.1 state: `## Unreleased` above replaced the three `board.*`
  methods with `view.load` / `view.save` and moved the schema into the shell.)
- Modules are trimmable per line in the Makefile's `SRC` list; `infantgod
  modules` prints what each one costs.
- The kernel knows no languages: `langs/` is served entirely by the shell.

### Languages (`langs/`, the shell's layer)

- A descriptor grammar (`.lang`): adding a language is one text file — no code.
  (Upstream's grammar has two families, `flat` and `sgml`; this fork has no SGML
  and ships the two descriptors below, one per language.)
- `langs/yarn.lang` is the flat descriptor this fork ships: Yarn Spinner
  headers, builtins, `<<commands>>` and `#tags`.  `langs/json.lang` covers the
  game's ScriptableObject definition files.
- `lang.tokenize` returns spans that tile the file with no gaps or overlaps, in
  the same wire form for either language (`node langs/selftest.mjs`, 82 checks).

### Shell (`shell/`)

- `infantgod rpc` (stdio) and `infantgod serve` (HTTP + SSE + the system browser
  in `--app=` mode).  No bundled Chromium, no npm dependencies.
- Nine card kinds: `editor`, `runner`, `note`, `files`, `sheet` and `project`,
  plus `mod`, `problems` and `docs` for the mod layer.
- The `project` card answers "what is in this project, and what do I have open
  in it": the workspace listing folded by folder, merged with the open editors,
  with one panel per board and a filter.
- Autosave with optimistic locking on every write; a stale write is refused,
  never silently merged.
- The 幼神 layer in `shell/mods/` (game knowledge, no DOM) serves `mod.*`:
  package validation, Yarn diagnosis, scaffolding, search, localisation.

### Tools (`tools/`, Python 3.12 standard library only)

- `demo.py` installs the starter board; `build.py` drives the Makefile;
  `e2e.py` drives the protocol end to end; `newlang.py` writes a conforming
  descriptor; `kernel_probe.py` re-checks every fixed bug; `browser_smoke.py`
  renders the window headless and asserts on the DOM.

### Bugs found and fixed before this release

Four adversarial probing rounds found 33 defects; 31 are fixed and each one is
recorded in [`docs/BUGS.md`](docs/BUGS.md) with its symptom and root cause.  The
worst were silent data loss in the board save, `file.write` ignoring a
wrong-typed `base_revision`, and validation that was quadratic in the number of
cards (20 000 cards: 72.59 s → 0.81 s).

Two more were found by cloning the repository and running the suite in the
clone, which is the only way to see what a new reader sees:

- **A clone on Windows got CRLF line endings.**  Git for Windows ships
  `core.autocrlf=true`, so the shipped fixture arrived with different bytes and
  the byte-exact fixture check failed on a checkout nobody had edited.
  `.gitattributes` now pins `* text=auto eol=lf`, and `kernel_probe.py` compares
  the fixture against what it read at the start of the run instead of a size
  written into the source.
- **`make smoke` failed on a fresh clone**, because there was no
  `.infantgod/board.json` to paint (it is gitignored).  It now installs
  `examples/board.json` for the run and removes it again.

### Verification

`make check` (9 passed, 0 failed, 3 skipped), `make fullcheck` (12/0/0),
`make probe` (37 checks, all ok), the C JSON test, `langs/selftest.mjs` (82/82),
`shell/web/selftest.mjs` (74/74) and `shell/mods/selftest.mjs` (84/84).  Two
defects are recorded as **not** fixed in `docs/BUGS.md`; `browser_smoke.py`
still drives no pointer, and says so in its own output.

### Known limits

- Windows only: `core/port/` has one implementation (`sys_win32.c`,
  `proc_win32.c`).  The port layer is the only OS-aware code.
- No undo of the typing inside a card.
- The card-kind hook is fork-time only: there is no plugin loading.
- CI (`.github/workflows/ci.yml`) is written but has never run on a GitHub
  runner — it was authored on a machine without one.  Its steps are exactly the
  local commands above.
