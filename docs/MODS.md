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
So they sit in `shell/mods/knowledge.json` (296 KB) behind a small facade.

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
problems <dir>      open a validation card and run it
docs [query]        open the knowledge-base card
```

`mod` behaves like `project`: there is one mod panel, so a second `mod`
re-points the card you already have instead of stacking a duplicate.

## The `mod.*` verbs

Every verb is answered by `dispatch()` in `shell/main.mjs` from the
`MOD_METHODS` table, before the kernel is ever consulted. All of them are
synchronous except `mod.scaffold`.

| verb | params | returns |
| --- | --- | --- |
| `mod.stats` | — | `{yarnFiles, nodes, commands, functions, variables, schemas, baselineDefines, locales, lineIds, …}` |
| `mod.types` | — | `[{type, count, required[], properties[], hasSchema}]` |
| `mod.templates` | — | `[{id, title, titleEn, description, descriptionEn, files[]}]` |
| `mod.characters` | — | `[{techName, nameKey, colour, …}]` |
| `mod.open` | `dir` | `{root, manifest, defines[], yarnFiles[], csvFiles[], sprites[], summary, diagnostics}` |
| `mod.validate` | `root` | `{ok, manifest, summary, diagnostics[], types}` |
| `mod.validateDefine` | `type`, `text`, `relPath?` | `{diagnostics[]}` |
| `mod.diagnose` | `text`, `fileName?`, `root?` | `{available, diagnostics[], nodes[]}` |
| `mod.scaffold` | `dir`, `modName`, `template?` | `{modRoot, created[], warnings[]}` — **async** |
| `mod.search` | `query`, `limit?` | `[{kind, name, score, detail}]` |
| `mod.docFor` | `kind`, `name` | markdown string |
| `mod.suggest` | `prefix`, `context?` | `[{label, kind, detail, insertText, documentation}]` |
| `mod.localization` | `root` | `{locales: [{code, file, base, rows, bytes}], baseLanguage}` |

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

## Containment

`--mods-root DIR` bounds every `mod.*` call (default: `--workspace`). A path
that resolves outside it is refused with `EOUTSIDE` and the message
`路径越界，已拒绝: <arg>`, as a normal JSON-RPC error frame.

This is a *second* boundary, not a replacement for the kernel's. The kernel
refuses any path outside `--workspace`; `--mods-root` can only narrow that.

The verbs are async-safe: `mod.scaffold` may reject, and `dispatch` awaits it,
so a refusal becomes an error frame. Before that await existed, a refused
scaffold killed the shell with an unhandled rejection — `shell/mods/selftest.mjs`
now pins that behaviour.

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
node shell/main.mjs serve --workspace . --mods-root "…/StreamingAssets/Mods"
```

`--mods-root` is what makes a mod card able to see a directory the board itself
is not rooted at. Then, on the command line at the bottom of the board:

```
mod MyMod
problems MyMod
docs Love
```

## Testing

```sh
node shell/mods/selftest.mjs                 # 81 checks, no kernel, no browser
node shell/mods/selftest.mjs --mods DIR      # with the game corpus
make test                                    # the whole project
```

The suite covers the knowledge-base counts, the game's own `MyMod` and
`SODefines` packages, a freshly scaffolded mod validating clean, the locale
mapping, the protocol seam with a kernel that throws if it is ever consulted,
and the containment refusal.
