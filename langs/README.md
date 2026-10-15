# `langs/` — language support, deliberately outside the kernel

This directory is the *entire* language layer of seIDE. It is a sibling of
`core/`, not a part of it.

The kernel knows about files, boards and processes. It does not know what a
keyword is, and it never will: `core/` contains no tokenizer, no keyword table
and no language name. Language support is:

| what | where | language |
| --- | --- | --- |
| how a language looks | `langs/<id>.lang` | a text file, no code |
| how to read that file | `langs/lang.mjs` | JavaScript, no dependencies |
| how to colour flat text | `langs/tokenize.mjs` | JavaScript, no dependencies |
| how to colour SGML | `langs/markup.mjs` | JavaScript, no dependencies |

Consequences a fork can rely on:

- **Deletable.** `rm -rf langs/` leaves a kernel that still builds and a shell
  that still runs — the editor just renders plain text.
- **Replaceable.** The wire contract is `lang.list` and `lang.tokenize`
  (below). Reimplement those two methods in any language and delete this
  directory.
- **Data, not code, per language.** Adding Brainfuck took one file with six
  lines. Adding a real language must never require editing C or JavaScript —
  unless it needs delimiters no family provides, in which case the delimiters go
  into a new family (one file, shared by every language in it) and the
  descriptors stay data.

## The descriptor grammar (frozen)

```
# seIDE language descriptor
id brainfuck
title Brainfuck
ext .bf
line_comment #
kind command "+" "-" "<" ">" "[" "]" "." ","
```

- A line whose **first byte** is `#` is a comment. An indented `#` is not.
- One `key value` per line. Blank lines are ignored.
- Keys: `id`, `title`, `ext`, `family`, `raw_element`, `line_comment`,
  `block_comment_open`, `block_comment_close`, `string`, `kind`.
- `ext` and `string` may repeat, and so may `raw_element`.
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
  anything else is matched literally, longest first. That is why Brainfuck's
  punctuation is written `kind command "+" ...` and still works.

### Families: `flat` and `sgml`

`family` names the *scanner* a descriptor wants, and it is the one place where a
language can ask for delimiters that no data file can express. `flat` (the
default) is the scanner in `tokenize.mjs`: line comments, block comments,
strings, a token list. `sgml` is the scanner in `markup.mjs`: one engine for
HTML, XML, SVG and everything else built on the same syntax.

```
family sgml
raw_element "script" "style" "textarea" "title"
```

- A language names **one** family; naming two different ones is a hard error, and
  an unknown family is too.
- `raw_element` lists elements whose **body is text, not markup** (HTML's
  `<script>`, `<style>`, `<textarea>`, `<title>`), so a `<` inside a script does
  not open a tag. It is an error without `family sgml`.
- A flat key (`line_comment`, `block_comment_open`, `block_comment_close`,
  `string`, `kind`) in a `family sgml` descriptor is an error, not a no-op:
  those delimiters belong to the other scanner, and silently ignoring them would
  leave an author believing in colouring that never happens.
- `family` and `raw_element` are facts about *scanning*; they never reach the
  wire. A client sees only the token kinds below.

`tools/newlang.py` writes conforming descriptors for both families:

```
python tools/newlang.py --id mylang --ext .ml --keywords "if,else,while"
python tools/newlang.py --id myhtml --ext .mh --family sgml --raw-element script
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
`string`, `comment`, `ident`, `punct`, `ws`. They are the same for every family,
which is why adding the SGML family needed no change in the shell or the board.

Scan order at each offset is frozen, **per family**:

```
flat: block comment -> line comment -> string -> number -> identifier -> literal -> punctuation
sgml: comment -> doctype/PI -> tag or entity -> text
```

An unterminated string or block comment stops at end of line / end of input, so
one stray quote never darkens the rest of the file. SGML makes the same promise
the other way round: an unterminated tag, comment, string or CDATA section ends
at end of input, and text that is not markup is reported as text rather than
guessed at.

When no descriptor matches, `tokenize()` still returns a valid tiling (blank
runs as `ws`, everything else as `punct`), so clients never need a special case.

## API

```js
import { LangRegistry, parseDescriptor } from "./langs/lang.mjs";
import { tokenize, tokenizeLines } from "./langs/tokenize.mjs";

const registry = LangRegistry.fromDir("langs");       // skips bad descriptors
registry.list();                                      // wire form for lang.list
registry.byId("brainfuck");                           // flat
registry.byId("html");                                // family sgml
registry.detect("examples/hello.bf");                 // by extension
registry.detect("examples/page.html");                // -> html
registry.detect("examples/notes.svg");                // -> xml (.svg is XML)
registry.resolve({ path: "a.bf" });                   // explicit lang wins

const spans = tokenize(registry.byId("brainfuck"), "++[>+<-]\n");
const markup = tokenize(registry.byId("html"), "<p title='x'>hi</p>");
const perLine = tokenizeLines(registry.byId("brainfuck"), text);
```

`tokenize` dispatches on the descriptor's family; `langs/markup.mjs` is the sgml
half and is not meant to be called directly.

`parseDescriptor` throws `LangError` (with `source` and 1-based `line`) on any
grammar violation. `loadLanguages(dir, { onError })` reports and skips bad
files instead, because one broken descriptor must not take colouring down.

## Test

```
node langs/selftest.mjs
```

87 checks covering descriptor parsing, rejection of malformed descriptors
(including the family rules), registry lookup, tiling, comment/string/number
classification, line grouping, and the SGML scanner: tags, attributes, entities,
CDATA, doctypes, processing instructions, raw element bodies, and the fixtures
under `examples/` (`page.html`, `hello.xml`, `notes.svg`). It needs no kernel, no
shell and no network.
