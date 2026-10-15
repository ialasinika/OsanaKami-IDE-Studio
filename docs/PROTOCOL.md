# Protocol

The wire contract between a client and seIDE. There are two endpoints and one
frame format; this document is the frozen reference for both.

- **Kernel endpoint** — `build/seide.exe rpc`. Answers the eleven methods in the
  table below. Knows nothing about languages.
- **Shell endpoint** — `node shell/main.mjs rpc` (stdio) or
  `node shell/main.mjs serve` (HTTP + SSE). Forwards every kernel method, adds
  the `langs` member to `workspace.info`, and answers `lang.list` and
  `lang.tokenize` itself.

A client that only needs files, boards and processes can target the kernel
endpoint directly. A client that wants colouring should target the shell.

---

## Framing

Frames are **one JSON object per line**, delimited by `\n`, in both directions.
Leading and trailing whitespace on a line is trimmed; a blank line is a
keep-alive and is ignored. The kernel reads a frame at a time and writes one
response line per request line.

The single-frame cap is 64 MiB. An oversized frame is **reported and dropped
rather than fatal** — the reader discards bytes up to the next `\n` and emits:

```json
{"event":"log","message":"frame too large; dropped"}
```

**stdout is protocol-only.** Every diagnostic goes to stderr, so a client can
treat every stdout line as exactly one frame. Breaking this rule desynchronises
the reader permanently.

### Request

```json
{"jsonrpc":"2.0","id":1,"method":"file.read","params":{"path":"examples/hello.bf"}}
```

- `jsonrpc` is `"2.0"`.
- `id` is any JSON value. **Presence of `id` is what makes a frame a request**;
  a frame with no `id` is a notification and is never answered.
- `method` must be a non-empty string.
- `params` is an object. An absent `params` is treated as empty by the shell;
  in the kernel, absent means no parameters (handlers use defaults).

### Response

```json
{"jsonrpc":"2.0","id":1,"result":{"path":"examples/hello.bf","text":"...","revision":123456789,"eol":"lf","size":1234,"mtime":1700000000}}
```

Exactly one of `result` or `error` is present. When a handler produced no
result, `result` is an empty object (`{}`), never `null`.

### Error

```json
{"jsonrpc":"2.0","id":1,"error":{"code":1002,"name":"NOT_FOUND","message":"no such file"}}
```

`error` carries `code` (integer), `name` (the symbolic name), `message` (human
text) and, for a few failures, `data`. `name` is the machine-readable half;
clients should branch on `name`, not on `message`.

### Notifications

```json
{"event":"exec.output","run_id":1,"stream":"stdout","data":"Hello World!\n"}
```

Notifications carry `event` and have **no `id`**. They may appear between
responses at any time. The event list is below.

---

## The kernel method table

The authoritative table is `sde_methods[]` in `core/src/rpc.c`. With both
compile-time switches on (`SDE_WITH_BOARD`, `SDE_WITH_EXEC`) there are eleven
methods. `board.*` disappears when `SDE_WITH_BOARD` is 0; `exec.*` disappears
when `SDE_WITH_EXEC` is 0.

| method | parameters | result |
| --- | --- | --- |
| `hello` | none | `{protocol, protocol_name, kernel_version, root, pid}` |
| `workspace.info` | none | `{root, name, file_count, board_path, board_revision, ignored}` |
| `workspace.list` | `path?`, `glob?`, `limit?` | `{files, truncated, count}` |
| `file.read` | `path` | `{path, text, revision, eol, size, mtime}` (+ `lang` from the shell) |
| `file.write` | `path`, `text`, `base_revision?` | `{path, revision, eol, size}` |
| `board.load` | none | `{path, revision, document}` |
| `board.save` | `document` or `board`, `base_revision?` | `{path, revision, saved}` |
| `board.newId` | none | `{id}` |
| `exec.start` | `cmd`, `card_id?`, `cwd?` | `{run_id}` |
| `exec.stop` | `run_id` | `{stopped}` |
| `exec.list` | none | `{runs}` |

`?` marks an optional member. Members marked without `?` are required; omitting
or mis-typing them produces `-32602 INVALID_PARAMS`.

### `hello`

```json
{"protocol":1,"protocol_name":"seide/1","kernel_version":"0.1.0","root":"C:/codes/seIDE","pid":12345}
```

`protocol` is the integer a client can compare; `protocol_name` is the same
version spelled out for a human reading a log line.

### `workspace.info`

```json
{"root":"C:/codes/seIDE","name":"seIDE","file_count":42,"board_path":"C:/codes/seIDE/.seide/board.json","board_revision":3901234567,"ignored":[".git",".seide",".hg",".svn","node_modules","__pycache__",".vscode",".idea",".cache","dist","build","target","obj"]}
```

`name` is the last path segment of `root`. `board_path` is the absolute path of
the board document (an empty string before the board has been loaded).
`board_revision` is a number. `ignored` names the directories `workspace.list`
skips (see that section): absent rows look exactly like an empty directory, so a
client that wants to explain a missing `build/` has to be told, and telling it
here means the list is never written down twice.

**The shell adds one more member to this result:**

```json
{"langs":[{"id":"brainfuck","title":"Brainfuck","extensions":[".bf"]},{"id":"html","title":"HTML","extensions":[".html",".htm",".xhtml"]},{"id":"xml","title":"XML","extensions":[".xml",".svg",".xsl",".xslt",".xsd",".rss",".atom",".plist",".xaml",".csproj",".resx",".props",".targets"]}]}
```

The kernel is language-agnostic, so the language inventory is added by the layer
that owns it (`shell/main.mjs`). A client talking to the kernel endpoint
directly will not see `langs`; a client talking to the shell will. `tools/e2e.py`
requires it in full mode and reports the language checks as *skipped* in kernel
mode.

### `workspace.list`

| parameter | type | meaning |
| --- | --- | --- |
| `path` | string, optional | a subdirectory; joined as `path/glob` |
| `glob` | string, optional | default `**/*` |
| `limit` | number, optional | default/≤0 means the internal cap of 20000 |

Result:

```json
{
  "files": [
    {"path":"core/src/buf.c","dir":false,"size":4211},
    {"path":"core/src","dir":true,"size":0}
  ],
  "truncated": false,
  "count": 2
}
```

`path` is relative to the workspace root and uses `/`. Directories report
`size: 0`. A `.mtime` member is documented on the header and returned by
`file.read`; `workspace.list` items carry `path`, `dir` and `size` only.

The walk skips `.git`, `.seide`, `.hg`, `.svn`, `node_modules`, `__pycache__`,
`.vscode`, `.idea`, `.cache`, `dist`, `build`, `target` and `obj`, caps
directory depth at 24, and **skips an unreadable directory rather than
failing**. Glob rules: `*` matches within one segment, `?` matches one
non-separator character, `**` matches across separators (and matches zero
directories, so `**/*.bf` finds a file at the top level). Comparison is
case-folded because Windows paths are case-insensitive: a glob that behaved
differently from the filesystem underneath it would be a bug generator.

### `file.read`

Required parameter: `path` (non-empty string, relative to the workspace root).

```json
{"path":"examples/hello.bf","text":"...","revision":123456789,"eol":"lf","size":1234,"mtime":1700000000}
```

`revision` is a 32-bit FNV-1a hash of the file's bytes, carried as a number;
it is the token `file.write` checks. `eol` is `"crlf"` or `"lf"` (`"lf"` when
the text contains no newline). A file that does not exist reports revision 0.

A board's revision is a hash of the same kind, but taken over a **canonical**
rendering of the document: object members are sorted by name before hashing
(`sde_json_write_canonical()` in `core/src/json.c`). Two boards with the same
content therefore have the same revision no matter how the client spelled them,
which is what makes `base_revision` safe to compare across clients. The canonical
form exists only for hashing; the `document` the kernel hands back is the
client's own arrangement, minus the defaults the validator filled in.

**The shell adds one more member to this result:**

```json
{"path":"examples/hello.bf","text":"...","revision":1873099737,"eol":"lf","size":820,"mtime":1700000000,"lang":"brainfuck"}
```

`lang` is the language the shell detected from the path, or `null` when nothing
matched. It is not in the kernel's result and the kernel has no opinion about
it; `tools/e2e.py` requires it in full mode and tolerates its absence in kernel
mode.

Refusals, all `IO` (1003) except the first:

| condition | code | name | message |
| --- | --- | --- | --- |
| no such file | 1002 | `NOT_FOUND` | `no such file` |
| directory | 1003 | `IO` | `is a directory` |
| larger than 4 MiB | 1003 | `IO` | `file is too large to open` |
| contains a NUL byte | 1003 | `IO` | `file is binary` |

Absolute paths and `..` escapes are refused before any of that: `sde_wksp_resolve`
rejects `absolute paths are not allowed: <path>` and
`path escapes the workspace: <path>`, surfaced as `IO`.

### `file.write`

| parameter | type | meaning |
| --- | --- | --- |
| `path` | string, required | relative path; parent directories are created |
| `text` | string, required | the whole new contents; send `""` to empty the file. A non-string is `INVALID_PARAMS` with `` `text` must be a string ``, and omitting it is `INVALID_PARAMS` too |
| `base_revision` | number, optional | the revision the client read; omit for last-writer-wins |

Result: `{"path":"examples/hello.bf","revision":987654321,"eol":"lf","size":1240}`.

With a `base_revision` that no longer matches the file on disk, the write is
refused with:

```json
{"jsonrpc":"2.0","id":3,"error":{"code":1001,"name":"STALE_REVISION","message":"file changed on disk since it was read","data":{"current_revision":987654321}}}
```

On success the kernel emits a notification **before** the response is written:

```json
{"event":"file.changed","path":"examples/hello.bf","revision":987654321}
```

### `board.load`

```json
{"path":"C:/codes/seIDE/.seide/board.json","revision":3901234567,"document":{"version":1,"viewport":{"x":0,"y":0,"zoom":1},"cards":[],"links":[]}}
```

`document` is a clone, so a client may keep and mutate it freely.

### `board.save`

| parameter | type | meaning |
| --- | --- | --- |
| `document` | object, required | the board document |
| `board` | object | **accepted as an alias** for `document` |
| `base_revision` | number, optional | the revision the client loaded |

Both spellings are accepted on purpose: the protocol calls the member
`document`, while the kernel's own load result also calls it `document`, and a
client that round-trips one into the other should not have to rename it.

Result: `{"path":"...","revision":3901234568,"saved":true}`, plus a notification:

```json
{"event":"board.changed","revision":3901234568}
```

Failure modes, in the order the kernel checks them:

| condition | code | name | message / data |
| --- | --- | --- | --- |
| `document` is absent or not an object | -32602 | `INVALID_PARAMS` | `` `document` must be an object `` |
| `base_revision` present and ≠ current | 1001 | `STALE_REVISION` | `board changed since it was loaded`, data `{current_revision}` |
| the document fails validation | 1004 | `INVALID_BOARD` | the validator's message, e.g. ``cards[0]: missing non-empty string `kind` `` |
| the file could not be written | 1003 | `IO` | `cannot save board` |

Validation is described below. The staleness check happens **before** the
document is adopted, so a rejected save leaves the in-memory board untouched.

### `board.newId`

```json
{"id":"c7"}
```

A fresh `cN` id that no card currently uses.

### `exec.start`

| parameter | type | meaning |
| --- | --- | --- |
| `cmd` | string, required | passed to the platform's child-process spawner |
| `card_id` | string, optional | defaults to `""`; echoed on the run and its events |
| `cwd` | string, optional | resolved through the workspace; empty/absent means the workspace root |

Result: `{"run_id":1}`.

A `cwd` that escapes the workspace is refused with `-32602 INVALID_PARAMS`.
A process that cannot start is `1005 EXEC`. Runs are capped at 64 live entries;
when the table is full the kernel drops the oldest **finished** run, and if
every run is still alive it lets the table grow instead.

### `exec.stop`

Parameter: `run_id` (number; a non-number is `-32602` with
`` `run_id` must be a number ``). Result: `{"stopped":true}`. An unknown id is
`1002 NOT_FOUND` with `no such run`.

### `exec.list`

```json
{"runs":[{"run_id":1,"card_id":"c3","cmd":"python tools/bf.py examples/hello.bf","running":false,"code":0,"started":1700000000000}]}
```

`code` is `-1` while the run is alive or was killed. `started` is
`sde_port_now_ms()` (milliseconds since the platform epoch). There is **no
`pid` member**, despite the header comment mentioning one.

---

## Notifications

| event | members | emitted when |
| --- | --- | --- |
| `file.changed` | `path`, `revision` | a successful `file.write` |
| `board.changed` | `revision` | a successful `board.save` |
| `exec.output` | `run_id`, `stream`, `data` | the pump read bytes from a child |
| `exec.exit` | `run_id`, `code` | a child exited and every byte was consumed |
| `log` | `message` | the transport dropped an oversized frame |

`exec.output.stream` is `"stdout"` or `"stderr"`. Each output notification
carries at most 8192 bytes (`SDE_EXEC_READ_MAX`), one read per run per 15 ms
pass, which keeps a chatty process from starving the others.

The shell's board UI reacts to `board.changed` by ignoring its own revision echo;
if the board is dirty it warns, otherwise it re-runs `board.load` to adopt what
is on disk.

---

## Standard JSON-RPC codes

| code | name | when |
| --- | --- | --- |
| -32700 | `PARSE_ERROR` | the frame was not valid JSON, or carried a string this transport cannot represent (a U+0000 code point); built by the reader loop, sent with a **null** id |
| -32600 | `INVALID_REQUEST` | the frame was not an object, or had no string `method` on a request |
| -32601 | `METHOD_NOT_FOUND` | no such method; message is `` no such method `NAME` `` |
| -32602 | `INVALID_PARAMS` | a required parameter was absent, empty or the wrong type |
| -32603 | `INTERNAL` | out of memory, or an unexpected internal failure |

## Application codes (frozen, from `core/include/rpc.h`)

| code | name | when |
| --- | --- | --- |
| 1001 | `STALE_REVISION` | `file.write` or `board.save` with an out-of-date `base_revision`; carries `data.current_revision` |
| 1002 | `NOT_FOUND` | `file.read` on an absent file; `exec.stop` on an unknown run |
| 1003 | `IO` | read/write/list/save failures not covered above |
| 1004 | `INVALID_BOARD` | the submitted board document failed validation |
| 1005 | `EXEC` | a child process could not be started |

`INVALID_PARAMS` messages are uniform: the helper that reads a required string
emits ``missing non-empty string `KEY` `` naming the parameter.

## Shell-local error names (HTTP client, not the kernel)

The browser client `shell/web/rpc.mjs` additionally produces transport-level
errors that never come off the wire: `TRANSPORT`, `CLIENT_CLOSED`,
`HTTP_STATUS`, `BAD_REPLY`. The shell process itself (`shell/main.mjs`) uses
`KERNEL_GONE`, `TIMEOUT` and `WRITE_FAILED` when it cannot reach or write to the
kernel. These are not part of the frozen kernel protocol; a fork may replace
them along with the transport.

---

## HTTP endpoint (what the browser uses)

`node shell/main.mjs serve` serves `shell/web/` as static files and offers two
dynamic routes:

| route | shape |
| --- | --- |
| `POST /rpc` | body is one JSON frame; the reply is one JSON frame with `Content-Type: application/json` |
| `GET /events` | `text/event-stream`; one `data: <json>\n\n` per notification |

The browser client posts the **same frame shape** as stdio —
`{"jsonrpc":"2.0","id":N,"method":"...","params":{...}}` — because the shell's
`dispatch()` is shared by both modes. A frame with no `id` is a notification and
is answered with `204 No Content`, since HTTP always needs a status but there is
no response frame to give. The SSE subscriber set also receives a `: keep-alive`
comment every 15 seconds.

The `id` on an HTTP request is what makes it a request. A frame with no `id` is
a notification: the host answers `204`, there is no reply frame, and the browser
client has nothing to resolve its promise with. `shell/web/rpc.mjs` guards that
two ways — it always mints an `id`, and every call is bounded by its own
timeout, so a missing reply settles as a `TIMEOUT` rejection rather than a
promise that never settles.

Requests to `/rpc` with a body that is not JSON get `400` and a
`PARSE_ERROR` frame with a null id. Non-GET/HEAD/POST methods get `405`.

---

## The `.lang` descriptor grammar

The grammar is frozen and documented in `langs/README.md`. A descriptor is a
plain text file, one `key value` per line:

```
# seIDE language descriptor
id brainfuck
title Brainfuck
ext .bf
line_comment #
kind command "+" "-" "<" ">" "[" "]" "." ","
```

Rules:

- A line whose **first byte** is `#` is a comment. An indented `#` is not.
- Blank lines are ignored.
- Keys: `id`, `title`, `ext`, `family`, `raw_element`, `line_comment`,
  `block_comment_open`, `block_comment_close`, `string`, `kind`.
- `ext`, `string` and `raw_element` may repeat; the others may not be
  meaningfully repeated.
- **An unknown key is a hard error.**
- Markers take a raw form (`#`, `//`, `/*`) or a quoted form (`"#"`).
- `kind <kindname> "<token>" ...`, where `<kindname>` is one of `keyword`,
  `command`, `type`, `constant`, `number`, `string`, `comment`. Tokens are
  always double-quoted, with `\"`, `\\`, `\n`, `\t` and `\r` understood. An
  unquoted token is a hard error.
- **The token text, not the kind, decides how it matches**: a token starting
  with a letter or `_` matches as a whole word; anything else matches literally,
  longest first.
- `family flat` (the default) is the scanner above. `family sgml` selects the
  HTML/XML scanner, and `raw_element "script" "style"` lists elements whose body
  is text rather than markup. The two families do not mix: a flat-scan key
  (`line_comment`, `block_comment_*`, `string`, `kind`) in a `family sgml`
  descriptor is a hard error, `raw_element` without `family sgml` is a hard
  error, and an unknown family is a hard error. Neither key ever appears in a
  `lang.*` result — they are facts about scanning, not about the wire.

`parseDescriptor` throws `LangError` (with `source` and a 1-based `line`) on any
grammar violation; `loadLanguages(dir, { onError })` reports and skips bad files
so one broken descriptor cannot take the language layer down.

Scaffold a new one:

```sh
python tools/newlang.py --id mylang --ext .ml --keywords "if,else,while"
python tools/newlang.py --id myhtml --ext .mh --family sgml --raw-element script
```

### Verbatim: `langs/brainfuck.lang`

```
# seIDE language descriptor
id brainfuck
title Brainfuck
ext .bf
line_comment #
kind command "+" "-" "<" ">" "[" "]" "." ","
```

### Verbatim: `langs/html.lang`

```
# seIDE language descriptor
id html
title HTML
ext .html
ext .htm
ext .xhtml
family sgml
raw_element "script" "style" "textarea" "title"
```

`langs/xml.lang` is the same shape without `raw_element`, covering `.xml` and the
extensions built on it (`.svg`, `.xsl`, `.xsd`, `.rss`, `.atom`, `.plist`, …).

---

## The shell-owned language methods

These are answered **by the shell**, not by the kernel. A client talking to the
kernel endpoint directly will get `METHOD_NOT_FOUND` for both.

### `lang.list`

Parameters: none.

```json
{"langs":[{"id":"brainfuck","title":"Brainfuck","extensions":[".bf"]},{"id":"html","title":"HTML","extensions":[".html",".htm",".xhtml"]},{"id":"xml","title":"XML","extensions":[".xml",".svg",".xsl",".xslt",".xsd",".rss",".atom",".plist",".xaml",".csproj",".resx",".props",".targets"]}]}
```

`extensions` is lowercase and includes the dot; a client matches by
case-insensitive suffix. Only `id`, `title` and `extensions` are on the wire —
a descriptor's `family` and `raw_element` are scanning facts and stay in the
language layer.

When `langs/` has been deleted, the shell's fallback answers `{"langs":[]}`.

### `lang.tokenize`

| parameter | type | meaning |
| --- | --- | --- |
| `text` | string, required | the text to tokenize; a non-string is `-32602 INVALID_PARAMS` with ``lang.tokenize needs a string `text` `` |
| `path` | string, optional | used to detect the language by extension |
| `lang` | string, optional | an explicit language id; it wins over `path` |

```json
{"tokens":[[0,2,"command"],[2,3,"punct"],[3,4,"command"]],"lang":"brainfuck"}
```

`tokens` is an array of `[start, end, kind]` triples over **byte offsets**.
`lang` is the resolved language id, or `null` when nothing matched.

Guarantees:

- Spans **tile the whole input**: every offset from 0 to `text.length` is
  covered exactly once, in order. Whitespace is reported as `ws` rather than
  skipped.
- Kinds on the wire: `keyword`, `command`, `type`, `constant`, `number`,
  `string`, `comment`, `ident`, `punct`, `ws`. (`ident`, `punct` and `ws` are
  produced, never declared.) The kind set is the same for every family, so a
  client that understands Brainfuck understands HTML's tokens too.
- Frozen scan order, per family:
  - `flat`: **block comment → line comment → string → number → identifier →
    literal → punctuation**.
  - `sgml`: **comment → doctype/processing instruction → tag or entity → text**.
- An unterminated string or block comment stops at end of line / end of input,
  so one stray quote never darkens the rest of the file. SGML keeps the same
  promise in its own terms: an unterminated comment, tag, attribute string or
  CDATA section ends at end of input.
- With no descriptor matching, `lang.tokenize` still returns a valid tiling:
  blank runs are `ws`, everything else is `punct`.
- With `langs/` deleted, the fallback returns one span covering the input with
  the kind `plain` and `lang: null`.

The editor card in the shell calls `lang.tokenize` with `{path, text}` on a
120 ms debounce and discards stale replies.

---

## Board document validation

The kernel validates before adopting a board. The rules, with their exact
messages, from `core/src/board.c`:

- The document must be an object — `board document must be a JSON object`.
- `version` must be a number — ``board `version` must be a number``.
- `viewport` must be an object — ``board `viewport` must be an object``.
- `cards` must be an array — ``board `cards` must be an array``.
- `links` must be an array — ``board `links` must be an array``.
- Each card must be an object (`card must be a JSON object`) with a non-empty
  string `id` (``missing non-empty string `id` ``), a non-empty string `kind`
  (``missing non-empty string `kind` ``), and numeric `x`, `y`, `w`, `h`
  (checked in that order: ``missing numeric `x` ``, then `y`, `w`, `h`).
- Ids must be unique — ``duplicate `id` ``.
- Each link must be an object (`link must be a JSON object`) with string `from`
  and `to` (``missing string `from` and `to` ``), both naming an existing card
  (`` `from` names no card`` / `` `to` names no card``).

Messages are prefixed with `cards[N]: ` or `links[N]: ` where applicable.

**Missing defaults are filled before validation, but only on the load path.** A
hand-written `board.json` therefore only has to be correct about the meaningful
parts: absent `version`, `viewport`, `cards` and `links` are filled in, and a
card's missing numeric `z` becomes `0`. A document arriving over the wire is
held to a higher standard — it must carry `cards` and `links` itself, and a
present member of the wrong type is never repaired. That asymmetry is
deliberate: repairing a *missing* member helps a human editing a file by hand,
while repairing a *mis-typed* one lets a client's bug silently replace the whole
board (`docs/BUGS.md`, entry A).

Anything a card carries beyond `id`, `kind` and the geometry is stored
**verbatim** — the kernel never interprets it.
