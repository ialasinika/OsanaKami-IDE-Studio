# The language service

This document is the contract for the editor's language features: completion,
hover, and the position arithmetic they both stand on. It is ours — the
reference material behind it is a reverse-engineered specification set for a
different host (a VS Code extension), and we take from it what an IDE of *this*
shape needs, not its editor surface.

Status: the pure cores are written (`shell/mods/positions.js`,
`shell/mods/complete.js`) and verified by their own checks; the RPC verbs and
the editor popup that will call them are not wired yet. This file is the
contract for that wiring.

## 1. What we take from the reference specification

| Reference | Decision | Why |
| --- | --- | --- |
| L1 diagnostics (26 `CR-*` rules, shared behaviours) | take, as a fidelity target | it is the part that decides whether a package loads, and our own diagnostics already cover roughly half of it |
| L2 completion / hover / go-to-definition / quick fixes | take, as RPC verbs | the IDE's editor is a `<textarea>`; everything must survive that |
| Position contract: 0-based UTF-16 offsets, 1-based lines | take | it is the only convention that lets a browser and a Node process agree on a caret |
| Comment stripping that keeps lengths, `【…】` slot let-through, 500-diagnostics cap, dedupe keys, "do not report" list | take | these are correctness rules, not presentation rules |
| L3 presentation (playhead preview, blocks library, asset trees) | skip for now | expensive, and the canvas that would host them is deliberately gone |
| L4 byte-identical interop, differential testing against the original | skip | it needs the original extension and its fixtures, which we do not distribute |
| VS Code host contract (extension host, `engines`, 30 commands, 5 activity-bar views, status bar items, TextMate grammars) | skip | we are not a VS Code extension; our views are `classic` and `mod` |

The rule of thumb: **capability first in the Node side verbs.** A feature that
only exists as pixels in one view disappears with that view (see
`docs/EDITOR_GAPS.md` §13.3). Anything the editor offers must be answerable by
a pure function the shell owns, so a second client — the CLI, an agent, a test
— can ask the same question.

## 2. Positions

All language features speak one position language, implemented in
`shell/mods/positions.js`:

- an **offset** is a 0-based UTF-16 code-unit index into the document string;
- a **line** is 1-based; a **column** is 0-based, counted in code units;
- `\n`, `\r\n` and `\r` each end one line; a trailing newline produces a final
  empty line, the way an editor shows it;
- a **range** is `{ startOffset, endOffset }`, half-open, in the same units.

`positions.js` is deliberately small and pure: `lineStarts`, `offsetToPosition`,
`positionToOffset`, `clampOffset`, `columnAt`, `lineText`, `rangeBetween`,
`rangeOfLineCols`, `diagnosticRange`, `wordAt`, `isRangeInText`, `shiftRange`,
`formatRange`. `diagnosticRange()` is the bridge from the diagnostics we
already emit (`{ line, col, length }`, `col` is 1-based) to offsets, so no
existing producer has to change to gain precise underlining.

CJK and astral characters are code units, not code points: a surrogate pair
counts as two, which is exactly what a browser `<textarea>.selectionStart`
reports. `smiley` (couple emoji) is the test for this.

## 3. The verbs

Both are pure functions over the *buffer*, never the file on disk — an unsaved
document must complete and hover correctly.

### `mod.complete`

```json
{ "text": "…the whole document…", "caret": 412, "path": "Yarn/Demo.yarn" }
```

```json
{ "context": { "kind": "argument", "command": "jump", "prefix": "Ini",
               "replace": { "startOffset": 407, "endOffset": 410 } },
  "items": [ { "label": "Initial", "kind": "node", "detail": "节点 Initial — …",
               "insertText": "Initial", "documentation": "…",
               "sortText": "0001_initial",
               "replace": { "startOffset": 407, "endOffset": 410 } } ],
  "isIncomplete": false }
```

`text` plus `caret` is the whole request: the client sends the buffer, not a
file path, and the answer depends on nothing else except the knowledge index
(which the shell owns). `replace` is the exact span the client must overwrite;
it is what keeps completion correct in the middle of a word, inside quotes, and
after a `#tag:`.

### `mod.hover`

```json
{ "range": { "startOffset": 402, "endOffset": 407 },
  "kind": "command", "name": "<<jump>>",
  "contents": [ { "kind": "markdown", "value": "**<<jump>>**\n\n…" } ] }
```

`null` when we have nothing trustworthy to say. An empty hover is better than
an invented one; that is the same rule as diagnostics: **degrade by saying
nothing, never by guessing.**

### When the index is not ready

If the knowledge base is missing, the verbs still answer from what they can
verify alone — Yarn's built-in commands (`shell/mods/yarn.js`'s
`NODE_BUILTINS`), the document's own text, and nothing game-specific. They do
not invent candidates, and they do not fail: the completion list simply gets
shorter, and `mod.hover` returns `null` for anything that would have needed the
index. The reference spec calls this "an empty index silences the family that
depends on it"; our version of it is the same discipline applied one layer up.

## 4. Contexts

`complete.js` classifies the caret, then delegates every candidate list to
`search.js` — the lists are not duplicated here.

| Kind | Trigger | Candidates | Inserted text |
| --- | --- | --- | --- |
| `command` | inside `<<` before the first space | commands + Yarn built-ins | `name ` (trailing space) |
| `argument` | inside `<<name …` | node titles for `jump`/`detour`/`visited`/`call`; nothing otherwise | the name, keeping quotes out of the replaced span |
| `tag` | after a `#` that starts a line or follows whitespace | `line`, `state`, `vo`, `Check`, `Topic`, `Modify` + states | `tag:` |
| `tagvalue` | after `#state:` | character states from the index | the state |
| `tagvalue` | after any other known tag | nothing (we have no VO/Topic/attribute index) | — |
| `variable` | after `$` | variables | `$name` |
| `character` | at the start of a dialogue line | characters | the name |

`C#` is not a tag, `<<jump>>` closed on the line is not a command context, and
an empty line does not fan out a character list — the classifier is line-based
and conservative on purpose.

Argument-position candidates are deliberately thin. The knowledge base keeps
the game's C# parameter names and types as strings (`achievementTechName:
string`), and the type tells us nothing about what belongs there, so only the
node-targeting commands — which the reference spec names explicitly — get an
argument list. Inventing a category from a parameter name is the kind of
guess this document exists to forbid.

## 5. Determinism and limits

- Same buffer + same caret + same index ⇒ byte-identical answer. No clock, no
  randomness, no ordering by hash iteration. `sortText` is a zero-padded rank
  followed by the lower-cased label, so equal scores tie-break by name.
- Answers are bounded (default 200 items, `isIncomplete` tells the client to
  keep the list open while it types more). The document is never modified, and
  no verb writes to disk.
- Suggestions come from the current index only; nothing suggests a value that
  is not in the game's data or in the document itself.

## 6. Checks

Both cores are covered by `node shell/mods/selftest.mjs`: the `positions` section
(60 checks) and the `completion and hover` section (53 checks, run against the
real knowledge base and real Yarn text). They started as scratch verifiers under
`build/` and moved into the shipped suite the same week, because a check that
only exists on the machine that wrote it is not a check.
