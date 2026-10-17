# The mod layer

Everything 《幼神》-specific in this fork lives in two places:

| where | what | owns |
| --- | --- | --- |
| `shell/mods/` | game knowledge: schemas, the baseline corpus, Yarn diagnosis, scaffolding, search | Node, no browser |
| `shell/web/cards.mjs` | the `mod`, `problems` and `docs` card kinds | the DOM |

The kernel is not involved in either. It validates a card's *shape* — id, kind,
geometry — and deliberately not its vocabulary, so a new card kind needs no C
change; and `file.read`/`file.write` treat `.yarn`, `.json` and `.csv` as text,
so a mod package is just files on the board.

## Why it is not in the kernel

The kernel knows nothing about 幼神, and that is the point: it is a
language-agnostic, game-agnostic file/board/exec server. The game's 136
commands, 51 definition schemas and 1305 baseline defines are *data*, they
change when the game updates, and they must be editable without recompiling C.
So they sit in `shell/mods/knowledge.json` (296 KB) behind a small facade. The
file is not required at runtime: on a machine that has the game but not the file,
the mod layer derives an equivalent, facts-only base and writes it to the user's
own directory (see "Where the knowledge base comes from").

The same reasoning applies to `langs/`: `.yarn` highlighting is a descriptor
file, not a keyword list compiled into the binary.

## The three card kinds

All three are read-mostly. They call the shell's `mod.*` verbs and hand file
paths to the existing `editor` card; none of them writes source text.

### `mod` — the package

Persisted field: `dir` (workspace-relative or absolute path to the mod root).

Controls: a path field, `open`, `validate`. Shows `mod.json`, a file count
line, the defines grouped by type, and every `.yarn` file. Clicking a row opens
it in an editor card. `validate` reports counts to the log without leaving the
card.

### `problems` — validation output

Persisted field: `root`.

Renders `validatePackage()`'s diagnostics, worst first, tinted by severity.
Clicking a row opens the file the diagnostic points at — the `#json/pointer`
suffix is stripped for the filesystem path and kept as the row's detail.

### `docs` — the knowledge base

Persisted field: `query`.

An empty query lists the knowledge-base counts and the 51 definition types;
typing searches commands, functions, variables, nodes and defines; clicking a
result renders its documentation. `window` reloads the counts.

## Commands

```
mod <dir>           open a mod package card
new <type> <dir> <name>
                    create one file from the game's own schema, then open it
import <from> <dir> [to]
                    copy a file into a package (byte for byte), then open it
problems <dir>      open a validation card and run it
docs [query]        open the knowledge-base card
```

`mod` behaves like `project`: there is one mod panel, so a second `mod`
re-points the card you already have instead of stacking a duplicate.

## The `mod.*` verbs

Every verb is answered by `dispatch()` in `shell/main.mjs` from the
`MOD_METHODS` table, before the kernel is ever consulted. All of them are
synchronous except `mod.scaffold`, `mod.newFile` and `mod.importFile`, which
write files.

| verb | params | returns |
| --- | --- | --- |
| `mod.stats` | — | `{yarnFiles, nodes, commands, functions, variables, schemas, baselineDefines, locales, lineIds, …}` |
| `mod.types` | — | `[{type, count, required[], properties[], hasSchema}]` |
| `mod.templates` | — | `[{id, title, titleEn, description, descriptionEn, files[]}]` |
| `mod.characters` | — | `[{techName, nameKey, colour, …}]` |
| `mod.open` | `dir` | `{root, manifest, defines[], yarnFiles[], csvFiles[], sprites[], summary, diagnostics}` |
| `mod.validate` | `root` | `{ok, manifest, summary, diagnostics[], types, knowledge}` |
| `mod.validateDefine` | `type`, `text`, `relPath?` | `{diagnostics[]}` |
| `mod.diagnose` | `text`, `fileName?`, `root?` | `{available, diagnostics[], nodes[]}` |
| `mod.scaffold` | `dir`, `modName`, `template?` | `{modRoot, created[], warnings[]}` — **async** |
| `mod.newFile` | `dir`, `type`, `name`, `overwrite?` | `{path, file, kind, bytes, warnings, diagnostics}` — **async**, writes one file |
| `mod.importFile` | `dir`, `from`, `to?`, `name?`, `overwrite?` | `{path, file, kind, bytes, warnings, diagnostics}` — **async**, copies one file in |
| `mod.search` | `query`, `limit?` | `[{kind, name, score, detail}]` |
| `mod.docFor` | `kind`, `name` | markdown string |
| `mod.suggest` | `prefix`, `context?` | `[{label, kind, detail, insertText, documentation}]` |
| `mod.complete` | `text`, `caret`, `limit?` | `{context, items[{label, kind, detail, insertText, documentation, sortText, replace}], isIncomplete}` |
| `mod.hover` | `text`, `caret` | `{range, kind, name, contents[{kind, value}]}` or `null` |
| `mod.localization` | `root` | `{locales: [{code, file, base, rows, bytes}], baseLanguage}` |

`mod.complete` and `mod.hover` take the **document being edited**, not a path:
`text` is the buffer (saved or not) and `caret` is a 0-based UTF-16 offset into
it, the same unit `positions.js` and `lang.tokenize` use. Neither verb touches
the disk, so an editor can ask about an unsaved buffer without writing first.
`mod.complete` answers with what the caret is inside (`context.kind` — `none`,
`command`, `argument`, `variable`, `character`, `tag`, `tagvalue`), the exact
span to replace, and the candidates; `mod.hover` answers `null` when it has
nothing trustworthy to say rather than inventing a doc.

A diagnostic is uniformly shaped:

```json
{ "severity": "error|warning|info", "code": "D006", "path": "Defines/News/X.json#icon",
  "message": "…", "messageEn": "…", "schemaType": "News" }
```

`path` is POSIX-relative to the mod root and may carry a `#json/pointer`. There
is no `file` member — the pointer suffix is part of `path`.

### `mod.scaffold`'s one asymmetry

`dir` is the **parent** directory and the package lands in `dir/<modName>/`;
the reply's `modRoot` is what you then pass to every other verb. This follows
`scaffold.js`'s own contract. Every other verb takes the package root directly.

### One file, made from the game's own schema

`mod.newFile` grows a package that already exists. `dir` is the package root, or
any directory inside it — the verb walks up (at most 25 levels) for `mod.json` —
and it works from an absolute path, a path relative to the mods root, or a name.
The kind decides where the file goes and what is in it:

| `type` | lands in | contents |
| --- | --- | --- |
| any of the knowledge base's 51 definition types | `Defines/<Type>/<name>.json` | exactly the keys that schema `required`s, two-space JSON: strings `""`, integers `0`, booleans `false`, arrays `[]`, objects `{}`. The identity field is filled with `name` (case-insensitively — `techName` and `TechName` are both the file's `techName`), because the file name and that field have to agree |
| `yarn` | `Yarn/<name>.yarn` | a story with `title:`, `when: always`, the `---`/`===` fences, one `Narrator:` line whose `#line:` id is derived from `name` (no clock, no random: two runs are byte-identical) |
| `translation` | `Yarn/<name>.csv` | the eight-column table (`language,id,text,file,node,lineNumber,lock,comment`) with a BOM and CRLF, header only |
| `sprite` | `Sprites/<name>.png` | a real 96×96 RGBA PNG, so opening it in the pixel card is something to draw on rather than a broken image |
| `spine`, `audio` | — | refused, naming the tool the file actually needs |

`name` is a bare identifier (`/^[A-Za-z_][A-Za-z0-9_]*$/`) — no directory, no
extension, because the directory and extension are the verb's decision. Every
refusal starts with `new file:`; overwriting a file that is already there needs
`overwrite: true`, and two plans for the same file are byte-identical.

The mod card's **new** row is generated from `mod.types`, so a build with three
schemas offers three kinds and the four this side adds by hand (story,
translation, sprite) plus the two it cannot write, greyed with the reason. The
command line is `new <type> <dir> <name>`, and it opens what it wrote.

### A machine with no game is a state, not a guess

The knowledge base is the baseline the checker compares against (type names, the
game's commands and functions, its character states). It is optional: the mod layer
finds one from the shipped `shell/mods/knowledge.json` or from a game installation,
and it says which it got.

- Discovery order: an explicit `--mods-root`/setting, then `INFANTGOD_MODS_DIR` or
  `INFANTGOD_GAME_DIR`, then relative guesses (the checkout's parent,
  `ModsFull/Mods`, a Steam library, the home directory). Nothing is hard-coded to a
  machine, and `git grep -E "[A-Za-z]:[\\/]Users[\\/]" -- shell` is part of the mod
  suite for that reason.
- When there is none, the answer is named, not silent: `knowledge()` reports
  `{present: false}`, `mod.validate`'s reply carries `knowledge: "missing"` and
  `ok: false` with one `E000` error, and scaffolding falls back to the mod's own
  names instead of inventing the game's built-in characters. Before this, an absent
  knowledge base was `{}` — every check passed because no check ran — and a
  scaffolder that never touched a game still named seven of its characters.
- `mod.suggest`'s tag suggestions say where they came from: `knowledge-base` when
  the baseline answered, `neutral` (a short generic list) when it did not. Which
  source answered is part of the reply.
- The shipped knowledge base is the richer copy, deliberately: it knows 136 commands,
  63 functions and 678 variables where `tools/gen_knowledge.mjs` can regenerate 87,
  38 and 810. Regenerating it is a checkable operation rather than a silent one —
  `node tools/gen_knowledge.mjs --check shell/mods/knowledge.json` exits 1 and
  `--diff` lists, per section, the names only one side knows. A release therefore
  does not need to carry the file: with no knowledge file at all, the first launch
  derives one from the discovered game install (see "Where the knowledge base comes
  from" below), which is the G26 payload plan.
- A regenerated knowledge base keeps the two facts the game's schema *text* carries.
  A schema marks a TechName reference with the sentence `TechName reference to
  XDefinition` and a sprite path with `Relative path to sprite image file`; the
  checker reads those sentences, and the generator drops every description. Left
  alone, regenerating would empty the reference and sprite checks and `ok: true`
  would start meaning "nothing was looked at". So the generator lifts exactly those
  two facts into `x-techReference` and `x-sprite` before dropping the text, and
  `flattenSchema` reads the keys first and the sentences only as the fallback; the
  D005/D006 dispatch in `validate.js` accepts the same two spellings, because a
  derived base must not switch the checks off either. A rich knowledge base and a
  facts-only one describe the same fields, which `shell/mods/selftest.mjs` pins from
  both ends (including a `validatePackage` run on a facts-only base).

### Where the knowledge base comes from

The base is optional, and the layer now procures it in a fixed order:

1. an explicit path — `--knowledge`/`options.knowledgePath` (authoritative: a path
   the caller named is never silently replaced by a different file);
2. `INFANTGOD_KNOWLEDGE`;
3. the shipped `shell/mods/knowledge.json` next to the mod layer;
4. `<user dir>/knowledge.json`, where the user dir is `--user-dir`, else
   `INFANTGOD_USER_DIR`, else the platform default — `%APPDATA%\OsanaKami IDE
   Studio` on Windows, `~/Library/Application Support/OsanaKami IDE Studio` on
   macOS, `${XDG_DATA_HOME:-~/.local/share}/OsanaKami IDE Studio` on Linux; the
   Electron wrapper passes `app.getPath("userData")`;
5. nothing found: derive the base from the discovered game install by running the
   same `buildKnowledge` code `tools/gen_knowledge.mjs` uses, write it atomically
   into the user dir and report it as `source: "derived"`.

Why this order: while the repository *is* the installed shell the module directory
wins, so tests never write the user's profile; while a release can ship without the
296 KB file, the first launch with a game install derives it (`shell/mods/
knowledge-build.js` holds the derivation; the CLI is a thin wrapper over it, and
`--check` fixes its bytes). A file that exists but cannot be read is a named
`loadError`, never a silent empty base; a derivation that cannot write is a named
`deriveError`, and the layer falls back to the missing-knowledge state (one `E000`,
`ok: false`). `knowledgeState()` answers `{state, path, source, userDir, schemas,
loadError, deriveError}`, and `serve`/`rpc` log `mod layer: knowledge base found
<path> (<source>)` once, so an operator can tell shipped from derived.

Two smaller decisions: freshness is judged by mtime and size, not by the base's own
`generatedAt` (a copied file must be noticed), and derivation is bounded to facts —
it never invents descriptions, which is why the derived base is smaller than the
shipped one and why the two `x-` keys exist at all.

## Containment

`--mods-root DIR` bounds every `mod.*` call (default: `--workspace`). A path
that resolves outside it is refused with the message `路径越界，已拒绝: <arg>`,
as a normal JSON-RPC error frame. What a client sees is `SHELL_ERROR`
(`-32603`), *not* `EOUTSIDE`: the mod layer tags the error `EOUTSIDE`
(`shell/mods/index.js:243`), but the shell's dispatcher wraps any error that is
not an `RpcError` as `SHELL_ERROR` (`shell/main.mjs:596-598`), so the tag never
reaches the wire. Three measured refusals, each of the shape
`{"code":-32603,"name":"SHELL_ERROR","message":…}`:

- a directory inside the workspace but outside the mods root —
  `路径越界，已拒绝: <workspace>/Thing`;
- a directory outside both — `路径越界，已拒绝: C:/Windows/Temp`;
- a relative path that escapes the root — `路径越界，已拒绝: ../outside`
  (relative paths resolve against the mods root, not the process's working
  directory).

This is a *second* boundary, not a replacement for the kernel's. The kernel
refuses any path outside `--workspace`; `--mods-root` can only narrow that.

The verbs are async-safe: `mod.scaffold` may reject, and `dispatch` awaits it,
so a refusal becomes an error frame. Before that await existed, a refused
scaffold killed the shell with an unhandled rejection — `shell/mods/selftest.mjs`
now pins that behaviour.

## Creating a mod from the File menu

`mod.scaffold` has one caller in the app that is not a command line: the
Electron wrapper's **File → 新建模组…** (`electron/newmod.js`, wired into the
menu by `electron/main.js`). It is the only `mod.*` verb a user reaches without
typing anything, and it is what makes a mod creatable before the game's own
folder is anywhere in sight.

- The submenu carries one item per template, in `mod.templates` order, labelled
  with `scaffold.js`'s `nameZh` — 最小可加载, 对话剧情, 定义包, 完整工程 — and
  最小可加载 is also `Ctrl+N`. `electron/newmod.js` holds that list, and
  `shell/mods/selftest.mjs` fails if it drifts from the engine's.
- A native save dialog names the mod's folder. Its default is `NewMod` under
  the folder used last time, which is remembered in Electron's settings (see
  `electron/README.md`), so a second mod is not a repeat of the same walk.
- What goes on the wire is exactly one frame — `POST <endpoint>/rpc` with
  `mod.scaffold {dir, modName, template}` — aimed at the endpoint the window is
  already serving. No method is added for the menu and no second process is
  started: `electron/newmod.js` imports `node:path` and nothing else, because a
  packaged app keeps `shell/` outside `app.asar`.
- `mod.scaffold`'s `dir` is the *parent* (the asymmetry above) while the folder
  the dialog named is the mod itself, so the folder's parent is what `dir` has
  to be and its basename is the `modName`.
- The name is checked before anything is sent: blank, `.`, `..`,
  `< > : " / \ | ? *`, control characters and a trailing dot are refused with
  the dialog still open, because Windows would otherwise create a folder named
  something other than what the user typed. Everything the client cannot know —
  a folder that is not empty, a `modName` the scaffold rejects, a path outside
  the mods root — comes back as the shell's own error frame and is shown in a
  dialog, never swallowed.
- After a create the mod is shown in the workspace: the window is reloaded when
  the new package already sits inside the current workspace, and when it does
  not the menu offers the package's parent as the workspace — the project panel
  *is* the workspace, so there is no other way to show a folder that is not in
  it.

The same frame is one command from a terminal, with no window anywhere in it:

```sh
curl -s http://127.0.0.1:<port>/rpc -H "content-type: application/json" \
  -d '{"jsonrpc":"2.0","id":1,"method":"mod.scaffold","params":{"dir":"…/Mods","modName":"Lantern","template":"minimal"}}'
```

The menu is Electron's: a browser tab opened by `serve` alone has no 新建模组
item, and the same four templates are reachable there over the protocol as
`mod.scaffold`.

## Diagnostic codes

Every code the mod layer can emit, its level, and where its condition comes from.
`03-诊断规则目录.md` (the reverse-engineered VS Code plugin spec) is the authority
for the Yarn rules: a code marked with a `CR-` id is that rule, with its level and
condition taken from the spec. A code marked **我们自有、规格无此条** is our own
check that the spec does not have; those are listed so that no error-level finding
exists without a spec counterpart.

### Yarn (`shell/mods/yarn.js`)

| code | level | spec | condition |
| --- | --- | --- | --- |
| Y001 | error | CR-001 | unknown command / statement name in `<<…>>` |
| Y002 | error | CR-101 | `jump`/`detour` target node does not exist |
| Y003 | warning | 我们自有、规格无此条 | unbalanced block structure (`if`/`once` stack) |
| Y005 | warning | 我们自有、规格无此条 | a node header has no `===` terminator |
| Y006 | warning | 我们自有、规格无此条 | `<<set>>` writes a variable nothing declared |
| Y007 | warning | 我们自有、规格无此条 | `<<` is never closed |
| Y101 | warning | CR-103 | reads a variable nothing declares |
| Y102 | info / warning | CR-111 | wrong argument count (too few is info, too many is warning) |
| Y103 | info | 我们自有、规格无此条 | a spoken line carries no `#line:` id |
| Y104 | warning | CR-109 | `#state:` value is not in the state table (states the two possibilities) |
| Y105 | info | 我们自有、规格无此条 | unknown function name (§11.10 says function existence is not reported) |
| Y106 | warning | 我们自有、规格无此条 | an option line's text is empty |
| Y107 | info | 我们自有、规格无此条 | the same `#line:` id twice in one file (CR-403 only covers cross-file) |
| Y108 | error | CR-102 | `visited("…")` names a node that does not exist |
| Y109 | error | CR-104 | `declare` of a variable first declared in another file |
| Y110 | error | CR-113 | a tag that needs a parameter has none (`#line` is exempt) |
| Y111 | error | CR-114 | a `Character:` line names someone who is not a character |
| Y112 | error | CR-105 | unknown tag |
| Y113 | error | CR-106 | unknown tag that differs from a known one only by case |
| Y114 | error | CR-107 | `#state` with the colon missing |
| Y115 | error | CR-108 | `#state:` value differs from a state name only by case |
| Y116 | error | CR-115 | a member of a node group (same title, ≥2 members, some `when:`) has no `subtitle` |
| Y117 | error | CR-116 | two members of one node group share a `subtitle` (reported on the later one) |
| Y118 | error | CR-201 | a certain start/end command pair has its start but never its end |
| Y119 | info | CR-202 | a suspicious start/end pair has its start but never its end (message starts `可疑：`) |
| Y120 | error | CR-203 | a certain pair has its end but never its start |
| Y121 | error | CR-501 | an option line's `#` is followed by plain text |
| Y900 | error | internal | the Yarn parser threw; a failure of ours, not of the file |

### Defines (`shell/mods/validate.js`)

`D001`–`D007` and `M001`–`M008` predate this spec and check the JSON package
against `knowledge.json`'s schemas; they are not part of the Yarn rule set and are
unchanged. `D005` (a `TechName reference to …` points at nothing) and `D006` (a
`Relative path to …` file is missing) have the same conditions as spec CR-301 and
CR-302; the rest of the D/M family has no spec counterpart and is local to us.

### What of §11 is implemented

- **§11.1** switches and empty-index silence: `checkDefines`/`checkVariables`/
  `checkNodes` gate CR-108/109/114, CR-103/104/112 and CR-101/102 respectively;
  an empty tag vocabulary, state table, character set or node index silences that
  family instead of reporting every value as unknown. The switches are a `ctx.checks`
  seam (`shell/mods/index.js`) with the shipped default "all on"; wiring them to a
  settings UI is the shell's job, not this module's.
- **§11.2** slot yielding: a `【…】` inside the checked token suppresses every rule
  except CR-502 (which needs the block library we do not ship, so it is not
  implemented); we treat every `【…】` as a slot, which over-yields on purpose —
  under-reporting beats inventing slots.
- **§11.3** the 500-diagnostics-per-document cap and the 13-step generation order
  (tags at step 5, pairs at step 6 by file sort, node groups at step 12).
- **§11.4** related positions: emitted as a `related[]` member when a rule has one
  (first declaration, earlier group member); the web panel does not render them yet.
- **§11.5** the current text's nodes/variables join the index before checking;
  unsaved *other* files cannot exist in a headless library.
- **§11.7** dedupe keys: pairs by (mod, pair, direction), CR-104 by (file, variable),
  CR-115/116 per group member, the rest per occurrence.
- **§11.10** the do-not-report list: speaker lines, the `when:` expression, comments,
  JSON syntax, and command-name case are not judged; the codes marked 我们自有 above
  are the deliberate exceptions this fork keeps, and all of them are warning/info
  except the two structural ones that stay warnings by decision (Y003, Y005, Y006).

Two deviations from the spec's data, both because the data is absent from this
repo: the state table is the game's own 16 state names (`knowledge.json`), not the
130 `Defines/CharacterState` names the reverse-engineering saw; and the command-pair
table is derived from `knowledge.json`'s own command names and verb families
(start/stop, enable/disable, add/remove, install/uninstall, equip/unequip, open/close,
show/hide) rather than read from a `模块.json` that does not exist here. Which
families are "certain" and which are "suspicious" follows that derivation, so CR-202
ships with the state-ish pairs (start/stop, show/hide, play/stop, start/end) and
CR-201/203 with the resource-ish ones.

The 332-check count includes a block for the L1 diagnostic rules taken from
`03-诊断规则目录.md`: each rule gets a bad fixture that must produce exactly that
code, a clean fixture that must produce none, and the shared behaviours (§11.1
empty-index silence and its three switches, §11.2 slot yielding, §11.3 the 500
cap and generation order, §11.5 the current text joining the index, §11.7 dedupe,
§11.10 the do-not-report list) get checks of their own. The fixtures are written
into a temporary directory when the suite runs; the deliberately broken package
they are modelled on ships as `examples/Mods/Lantern_Tests`, so the rules can be
seen firing in the editor without it becoming the default `--mods-root` package.

## Data facts worth knowing

These are properties of the game's own shipped data, not defects in this fork:

- `validatePackage(SODefines)` reports exactly **2 errors**, both `D006`: two
  definitions reference sprite files that are not in the package.
- `MyMod` ships **14** `.csv` files of which only **11** are languages:
  `NewProject-metadata.csv` is line metadata, and two more live under
  `Yarn/.VSCodeCounter/`. `openMod.summary.csv`, `validatePackage.summary.csvFiles`
  and `mod.localization` all agree on 11.
- The scaffold suffix table maps `bg` to the empty suffix, so `NewProject_bg.csv`
  would fold into the base language on a suffix-only lookup. The facade checks
  the knowledge base's authoritative stem table first, which keeps Bulgarian
  distinct and `base: true` on exactly one file.
- A mod's own defines are valid reference targets for its own Yarn, and its own
  node titles count as existing jump targets. Checking against the game baseline
  alone reports spurious `D005`/`Y002`.

## Running it

```sh
node shell/main.mjs serve --workspace . --mods-root examples/Mods
node shell/main.mjs serve --workspace . --mods-root "…/StreamingAssets/Mods"
```

`--mods-root` is what makes a mod card able to see a directory the board itself
is not rooted at. The first line points at the worked example below, so nothing
here needs the game installed; the second is the real mods folder. Then, on the
command line at the bottom of the board:

```
mod Lantern
problems Lantern
docs Love
```

## The worked example we ship

`examples/Mods/Lantern` is the repository's own mod: 22 files, every byte
written here, no game asset, small enough to read in one sitting. It is the
package `tools/input_smoke.py` drives, so the browser suite passes on a machine
with no 幼神 install at all, and it is what `--mods-root examples/Mods` above
opens. Since the game's own data is not part of this checkout (G26), it is also
the only package here that exercises every file kind the mod layer can read.

| file | what it is for |
| --- | --- |
| `mod.json` | the manifest: `name`, `version`, `gameVersion`, `loadOrder`, `author`, `description` |
| `Lantern.yarnproject` | the project file: its one source file, the language map (`en` → `Lantern_en.csv`) and the base language |
| `Yarn/Lantern.yarn` | two nodes with `title`/`subtitle`/`when`/`tags`, five spoken lines, one `<<AdvanceTime 1>>`, one `<<jump>>`, and the six tags discussed below |
| `Yarn/Lantern.csv` | the base table. Like the game's own `MyMod`, the base language's table carries **no** language suffix (`NewProject.csv` there, `Lantern.csv` here) |
| `Yarn/Lantern_en.csv` | the English table, mapped by the project file |
| `Sprites/*.png` | four 32×32 images: `Lantern.png`, `Lantern_Glow.png` and `Warden.png` are 8-bit RGBA, `Lantern_Rgb.png` is 8-bit RGB (colour type 2). All four were drawn pixel by pixel by `build/scratch_make_sprites.py` |
| `Defines/Character/Warden.json` | a `Character`: `portrait`/`emailPortrait` are one of those sprites, `initialCharacterStates` is `Calm`, and `spineAssetPath` names a stub rig |
| `Defines/CharacterState/Calm.json` | a `CharacterState` that skins the body and switches on the pixel animation below |
| `Defines/PixelAnimation/Lantern_Idle.json` | a `PixelAnimation` with a bone track, a physics track and an `audioEvent` |
| `Defines/AudioEvent/Audio_Lantern_Hum.json` | the `AudioEvent` that the animation and the voice-over definition refer to by `TechName` |
| `Defines/Song/Song_Lantern.json` | a `Song` whose `image` is a sprite and whose `externalAudioFile` names a wav |
| `Defines/VoiceOverDefinition/Vo_Lantern.json` | a `VoiceOverDefinition` naming the audio event and a wav |
| `Defines/Attachment/*.json` | three `Attachment`s; one of them names a sprite that is not in the package |
| `Audio/*.wav` | two small 8 kHz mono 16-bit PCM files, synthesised by `build/scratch_make_audio.py`; a sample big enough to be realistic would be megabytes, so the test that needs one generates it at run time instead of committing it |
| `Spine/Warden_Rig.json` | a stand-in named by `spineAssetPath`; nothing in the tools opens it |
| `README.txt` | the same story for someone who has only the mod folder: a tutorial, not a data sheet |

The story's tag surface is part of the example, and what the tools make of it is
recorded rather than assumed. Its five lines carry six tags: `#line:<7 hex>` on
every line (the id the CSV matches a row by), `#state:Calm`, `#vo:Vo_Lantern`,
`#Check:$lantern_lit`, `#Topic:Lantern_Awake` and `#Modify:$lantern_lit=false`.
`shell/mods/index.js` knows exactly three tag names — `line`, `state` and `vo` —
so `#state:Calm` is judged against the game's own emotion states and earns a
`Y104` warning (`Calm` is this package's `CharacterState`, not one of the game's
states), while `#Check:`, `#Topic:` and `#Modify:` reach the card as unexplained
text with no diagnostic at all. `tools/input_smoke.py` asserts both halves: every
tag is on screen, and the three tag names the tools know are the only three they
judge.

Two flaws are left in on purpose, because an example that validates clean proves
nothing about the diagnostics:

* `Defines/Attachment/Lantern_Broken.json` names `Sprites/Missing.png`, which is
  not in the package: `problems Lantern` shows the `D006` error, and clicking
  that row opens the pixel card for the *sprite*, not for the JSON that declared
  it.
* `Yarn/Lantern_en.csv` is a row short of the story (`line:9c0d1e2` has no
  English row) and the row it does carry for `line:5d6e7f8` has a `lock` that
  does not match the source line: with the story card on `Yarn/Lantern.yarn` and
  that table, one line reads `ok`, one `stale` and one `missing`, and the
  package-level row-count check reports the gap as `M008`.

`README.txt` inside the package says the same things to someone who has only the
mod folder, and ends with how to copy the package into the game's own mods
folder. It also names the three places where the tools are still silent: the
audio files three of the defines point at and nothing looks for (G21),
`spineAssetPath` (G22), and the 8-bit RGB sprite whose bytes come back as RGBA
when the pixel card saves it (G20).

## Testing

```sh
node shell/mods/selftest.mjs                 # 407 checks, no kernel, no browser
node shell/mods/selftest.mjs --mods DIR      # with the game corpus
python tools/input_smoke.py                  # a real browser, against examples/Mods
make test                                    # the whole project
```

The suite covers the knowledge-base counts, the game's own `MyMod` and
`SODefines` packages, a freshly scaffolded mod validating clean, the locale
mapping, the protocol seam with a kernel that throws if it is ever consulted,
and the containment refusal. `tools/input_smoke.py` no longer touches `Mods`
next to the repository: it drives `examples/Mods/Lantern`, generates its own
4.5 MB translation table under `build/` (past the kernel's 4 MiB whole-file
read, so the story card can only open it through a `file.blob*` session), and
proves the D006 click-through on the example mod's missing sprite.

Three of `input_smoke.py`'s 43 checks pin the example's own claims rather than the
UI's: the 8-bit RGB sprite is read as colour type 2 and written back as colour
type 6 (G20); the whole tag surface reaches the story card while the tools judge
exactly the three tag names they know; and the package's only findings are its
two deliberate ones, with the three audio references earning nothing at all
(G21). Each was falsified once -- a sabotaged package fails exactly the check it
should and nothing else -- before being trusted.  `tools/browser_smoke.py` is 57
checks over the same example (the views' tabs and tiles, a tab that closes after
asking, the completion menu and the hover line, and a rig card that saves the
pose it is showing).
