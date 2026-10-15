# `langs/` — language support, deliberately outside the kernel

This directory is the *entire* language layer of InfantGod Studio. It is a sibling of
`core/`, not a part of it.

The kernel knows about files, boards and processes. It does not know what a
keyword is, and it never will: `core/` contains no tokenizer, no keyword table
and no language name. Language support is:

| what | where | language |
| --- | --- | --- |
| how a language looks | `langs/<id>.lang` | a text file, no code |
| how to read that file | `langs/lang.mjs` | JavaScript, no dependencies |
| how to colour text | `langs/tokenize.mjs` | JavaScript, no dependencies |

Consequences a fork can rely on:

- **Deletable.** `rm -rf langs/` leaves a kernel that still builds and a shell
  that still runs — the editor just renders plain text.
- **Replaceable.** The wire contract is `lang.list` and `lang.tokenize`
  (below). Reimplement those two methods in any language and delete this
  directory.
- **Data, not code, per language.** Adding Yarn Spinner took one file — `yarn.lang`
  and `json.lang` are the two descriptors this repository ships, and neither
  required editing C or JavaScript. A real language must never require it either.

## The descriptor grammar (frozen)

The rules:

- A line whose **first byte** is `#` is a comment. An indented `#` is not.
- One `key value` per line. Blank lines are ignored.
- Keys: `id`, `title`, `ext`, `line_comment`, `block_comment_open`,
  `block_comment_close`, `string`, `kind`.
- `ext` and `string` may repeat.
- **An unknown key is a hard error.** Silently ignoring a key the author
  believed in is how descriptors rot.
- `line_comment`, `block_comment_*` and `string` take a raw marker (`#`, `//`,
  `/*`) or a quoted one (`"#"`). Both are accepted.
- `kind <kindname> "<token>" "<token>" ...` declares tokens. Declarable kinds
  are `keyword`, `command`, `type`, `constant`, `number`, `string`,
  `comment`. Tokens are always double-quoted; `\"`, `\\`, `\n`, `\t` and
  `\r` are understood; an unquoted token is a hard error.
- **The token text, not the kind, decides how it matches.** A token starting
  with a letter or `_` is matched as a whole word (identifier boundary);
  anything else is matched literally, longest first. That is why Yarn's `<<` is
  declared as one literal and still wins over a stray `<`: the literal table is
  sorted longest-first, so the two-character marker is one span rather than two
  punct spans. It is also why `yarn.lang` can declare punctuation as
  `kind command "<<" ">>" ...` and have the words and literals coexist in one
  file.

The two descriptors this repository ships, condensed to their keys (the real
files carry more tokens and their own comments):

```
# InfantGod Studio language descriptor
id yarn
title Yarn
ext .yarn
ext .yarnproject
line_comment //
block_comment_open /*
block_comment_close */
string "\""
kind keyword "title" "when" "tags" "subtitle" "tracking" "position"
kind keyword "if" "elseif" "else" "endif" "set" "declare" "jump" "true" "false" "null"
kind command "<<" ">>" "---" "===" "->" "#" "$" ":" "|"
```

```
# InfantGod Studio language descriptor
id json
title JSON
ext .json
string "\""
kind keyword "true" "false" "null"
kind command "{" "}" "[" "]" ":" ","
```

Yarn is the worked example to read first: it declares a line comment, a block
comment, a string delimiter and several word and literal kinds, so it exercises
most of the grammar at once. JSON is the other extreme — no comments at all, one
string delimiter, two `kind` lines.

`tools/newlang.py` writes conforming descriptors:

```
python tools/newlang.py --id mylang --ext .ml --keywords "if,else,while"
```

## Wire contract

The language layer answers two methods. Both are served by the **shell**, not
by the kernel: the shell multiplexes a single client-facing JSON-RPC endpoint,
forwarding kernel methods and answering these itself.

```
lang.list      {}                                  -> {"langs":[{"id","title","extensions"}, ...]}
lang.tokenize  {"path"|"lang", "text"}             -> {"tokens":[[start,end,kind], ...], "lang": "<id>"|null}
```

`lang.tokenize` reports **contiguous spans that tile the whole input**: every
offset from `0` to `text.length` is covered exactly once, in order, and
whitespace is reported as `ws` rather than skipped. A client can therefore
colour a document by walking the array once, with no gap logic.

Kinds on the wire: `keyword`, `command`, `type`, `constant`, `number`,
`string`, `comment`, `ident`, `punct`, `ws`.

Scan order at each offset is frozen:

```
block comment -> line comment -> string -> number -> identifier -> literal -> punctuation
```

An unterminated string or block comment stops at end of line / end of input, so
one stray quote never darkens the rest of the file.

When no descriptor matches, `tokenize()` still returns a valid tiling (blank
runs as `ws`, everything else as `punct`), so clients never need a special case.

## API

```js
import { LangRegistry, parseDescriptor } from "./langs/lang.mjs";
import { tokenize, tokenizeLines } from "./langs/tokenize.mjs";

const registry = LangRegistry.fromDir("langs");       // skips bad descriptors
registry.list();                                      // wire form for lang.list
registry.byId("yarn");
registry.detect("examples/hello.yarn");               // by extension
registry.resolve({ path: "a.yarn" });                 // explicit lang wins

const spans = tokenize(registry.byId("yarn"), "<<set $x = 1>> // go\n");
const perLine = tokenizeLines(registry.byId("yarn"), text);
```

`parseDescriptor` throws `LangError` (with `source` and 1-based `line`) on any
grammar violation. `loadLanguages(dir, { onError })` reports and skips bad
files instead, because one broken descriptor must not take colouring down.

## Test

```
node langs/selftest.mjs
```

More than seventy checks covering descriptor parsing, rejection of malformed
descriptors, registry lookup, tiling, comment/string/number classification, line
grouping, and the shipped `yarn.lang`/`json.lang` descriptors exercised over the
fixtures in `examples/`. The count moves as descriptors and cases are added, so
trust the footer it prints, not this line. It needs no kernel, no shell and no
network.

## Known limitations of the frozen grammar

These are properties of the eight-key descriptor format, not bugs in
`tokenize.mjs`, and they cannot be fixed without a new key:

- **Keywords colour inside prose.** A declared word kind is matched wherever the
  identifier appears, including inside a string of dialogue. For `yarn.lang`
  that means an English `if` in a line of narrative becomes a keyword. It is
  acceptable because 《幼神》's prose is Chinese and English keywords are rare in
  it; a European-language script would need a different trade-off.
- **`$variable` is two spans.** The grammar can match a literal or a word, never
  "a `$` followed by an identifier is one token". `$Fan_Join` therefore reports
  a `command` `$` immediately followed by an `ident` — adjacent and both
  visible, so the colour is right at the boundary even though the span is not.
- **JSON has no line comment.** There is no key for "this language has none"
  beyond leaving `line_comment` out, which is what `json.lang` does. Declaring
  one would make a `//` inside a string or a URL swallow the rest of the line.
- **A block comment declared for a language that has none.** Yarn has no
  `/* */`, but `yarn.lang` declares one so that a commented-out snippet colours
  sanely. Comments outrank strings in scan order, so a literal `/*` inside a
  quoted title would start a comment: an accepted consequence of that order.
- **Offsets are JS string indices, not byte offsets.** The wire docstring in
  `tokenize.mjs` says `text.length`; for a Chinese file that is UTF-16 code
  units, not UTF-8 bytes. `langs/selftest.mjs` asserts this explicitly for a
  CJK input, because the error messages elsewhere in the repo say "byte" and a
  client that converted them would be off by the difference.
