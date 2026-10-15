#!/usr/bin/env python3
"""newlang.py -- scaffold a InfantGod Studio ``.lang`` language descriptor.

    python tools/newlang.py --id ID --ext .EXT [--title T] [--comment CHAR]
                            [--string TOKEN] [--block-comment-open TOKEN]
                            [--block-comment-close TOKEN]
                            [--keywords "a,b,c"] [--keyword TOKEN]
                            [--out DIR] [--force]

The written file uses exactly the grammar the InfantGod Studio descriptor parser accepts
(``langs/lang.mjs``, loaded by the shell -- languages are not part of the C
kernel)::

    # InfantGod Studio language descriptor
    id yarn
    title Yarn
    ext .yarn
    line_comment //
    kind keyword "title" "when" "tags" "if" "else" "end"

Only the keys named in that grammar are ever emitted -- an unknown key is a hard
error for the parser, so inventing one here would produce a broken descriptor.
``kind`` is ``command`` when every token is a single non-alphanumeric character
and ``keyword`` otherwise.  Tokens are always double-quoted, with ``\\"``,
``\\\\``, ``\\n`` and ``\\t`` escaped; the marker keys (``line_comment``,
``block_comment_open``, ``block_comment_close``, ``string``) take the raw marker
or a quoted one, and this tool always writes the quoted form.

``--string`` marks a string delimiter and may repeat, because a language can
delimit strings more than one way (``string "\\""`` plus ``string "'"`` for
Python).  ``--block-comment-open`` / ``--block-comment-close`` are one pair: the
parser rejects either half on its own, so this tool refuses to write one without
the other.

``--keywords`` splits on commas, so a token that is itself a comma or a space can
never come from that flag; give it with the repeatable ``--keyword``, which takes
one token verbatim.  Yarn's ``->`` and ``<<`` are ordinary tokens and go in the
comma list, but a language whose own separator is the comma needs ``--keyword``::

    python tools/newlang.py --id yarn --ext .yarn \
        --keywords "title,when,tags,if,else,end"

A JSON-like language, which needs a string delimiter and no comments::

    python tools/newlang.py --id adoc --ext .adoc --string '"' \
        --keywords "{,},[,],:" --keyword "," --keyword true --keyword false


Exit codes
    0   the descriptor was written
    2   refused to overwrite, or the file could not be written
    3   the command line (or an argument value) was malformed
"""

from __future__ import annotations

import argparse
import re
import sys
from pathlib import Path

ID_RE = re.compile(r"^[A-Za-z_][A-Za-z0-9_-]*$")
EXT_RE = re.compile(r"^\.[A-Za-z0-9_+.-]+$")
#: A "command" token: exactly one character, not alphanumeric, not blank.
COMMAND_RE = re.compile(r"^[^A-Za-z0-9\s]$")
WHITESPACE_RE = re.compile(r"\s")


class _Parser(argparse.ArgumentParser):
    """ArgumentParser that reports usage errors with the documented exit code."""

    def error(self, message: str) -> None:
        self.print_usage(sys.stderr)
        print(f"newlang.py: usage error: {message}", file=sys.stderr)
        raise SystemExit(3)


def _fail(message: str, code: int = 3) -> int:
    """Print an error and return *code* as the process exit code."""
    print(f"newlang.py: {message}", file=sys.stderr)
    return code


def escape_token(token: str) -> str:
    """Return *token* quoted and escaped for the descriptor grammar."""
    text = token.replace("\\", "\\\\").replace('"', '\\"')
    text = text.replace("\n", "\\n").replace("\t", "\\t")
    return f'"{text}"'


#: Every key the descriptor grammar accepts; anything else is a hard error.
KNOWN_KEYS = (
    "id",
    "title",
    "ext",
    "line_comment",
    "block_comment_open",
    "block_comment_close",
    "string",
    "kind",
)


def scan_quoted(text: str) -> list:
    """Split ``"a" "b"`` into ``['a', 'b']``, raising ``ValueError`` otherwise.

    Mirrors the token scanner in ``langs/lang.mjs``: only double-quoted tokens
    with the four documented escapes are accepted, and an unterminated quote is
    an error rather than a token that runs to end of line.
    """
    tokens = []
    index = 0
    length = len(text)
    while index < length:
        if text[index] == " ":
            index += 1
            continue
        if text[index] != '"':
            raise ValueError(f"unquoted token {text[index:]!r}")
        index += 1
        buffer = []
        closed = False
        while index < length:
            char = text[index]
            if char == "\\":
                index += 1
                if index >= length:
                    break
                escaped = text[index]
                buffer.append(
                    {"n": "\n", "t": "\t", "r": "\r", '"': '"', "\\": "\\"}.get(
                        escaped, escaped
                    )
                )
                index += 1
                continue
            if char == '"':
                closed = True
                index += 1
                break
            buffer.append(char)
            index += 1
        if not closed:
            raise ValueError("unterminated quoted token")
        tokens.append("".join(buffer))
    return tokens


def verify_descriptor(text: str):
    """Re-read the text we are about to write, the way the runtime will.

    A scaffolding tool that reports success while producing a descriptor the
    runtime silently skips is worse than one that refuses: the newcomer's first
    language disappears behind an "OK".  Returns a problem description, or
    ``None`` when the text satisfies the descriptor grammar.
    """
    counts = {}
    for number, raw in enumerate(text.split("\n"), start=1):
        line = raw.strip()
        if not line or line.startswith("#"):
            continue
        key, _, rest = line.partition(" ")
        rest = rest.strip()
        if key not in KNOWN_KEYS:
            return f"line {number}: unknown key {key!r}"
        if key == "kind":
            name, _, tokens = rest.partition(" ")
            if not name:
                return f"line {number}: kind needs a name"
            try:
                values = scan_quoted(tokens.strip())
            except ValueError as exc:
                return f"line {number}: {exc}"
            if not values:
                return f"line {number}: kind {name!r} has no tokens"
        elif not rest:
            return f"line {number}: {key} must not be empty"
        counts[key] = counts.get(key, 0) + 1
    for required in ("id", "title"):
        if counts.get(required, 0) != 1:
            return f"expected exactly one {required} line"
    opens, closes = counts.get("block_comment_open", 0), counts.get("block_comment_close", 0)
    if opens != closes:
        return "block_comment_open without block_comment_close"
    return None


def title_for(language_id: str) -> str:
    """Derive a human title from a language id (``my-lang`` -> ``My Lang``)."""
    return language_id.replace("-", " ").replace("_", " ").title()


def normalise_extensions(values) -> list:
    """Add a leading dot where missing and drop duplicates, keeping order."""
    extensions = []
    for value in values:
        extension = value if value.startswith(".") else f".{value}"
        if not EXT_RE.match(extension):
            raise ValueError(f"invalid extension {value!r} (want something like .yarn)")
        if extension not in extensions:
            extensions.append(extension)
    return extensions


def parse_keywords(values, singles) -> list:
    """Split comma-separated keyword lists, rejecting blanks and whitespace.

    *singles* (from ``--keyword``) are taken verbatim, so a token may itself be
    a comma.  A ``--keywords`` value that contributes no token at all is an
    error rather than a silently ignored argument.
    """
    keywords = []
    for value in values:
        found = False
        for token in value.split(","):
            token = token.strip()
            if not token:
                continue
            _check_token(token)
            found = True
            if token not in keywords:
                keywords.append(token)
        if not found and not singles:
            raise ValueError(
                f"--keywords {value!r} has no tokens (use --keyword for a literal comma)"
            )
    for token in singles:
        _check_token(token)
        if token not in keywords:
            keywords.append(token)
    return keywords


def _check_marker(value: str, flag: str) -> None:
    """Reject a marker that cannot be written back into a descriptor.

    Mirrors ``readMarker`` in ``langs/lang.mjs``: a raw marker is a single token
    with no whitespace, and an empty one is rejected for a string delimiter.
    """
    if not value:
        raise ValueError(f"{flag} needs a non-empty marker")
    if WHITESPACE_RE.search(value):
        raise ValueError(f"{flag} {value!r} contains whitespace")


def _check_token(token: str) -> None:
    """Reject a token that cannot be written back as a quoted descriptor token."""
    if not token:
        raise ValueError("--keyword needs a non-empty token")
    if WHITESPACE_RE.search(token):
        raise ValueError(f"token {token!r} contains whitespace")


def render(
    language_id: str,
    title: str,
    extensions,
    comment: str,
    keywords,
    strings=(),
    block_open: str = "",
    block_close: str = "",
) -> str:
    """Render the descriptor text (always LF-terminated, exactly one final LF)."""
    lines = ["# InfantGod Studio language descriptor", f"id {language_id}", f"title {title}"]
    lines.extend(f"ext {extension}" for extension in extensions)
    if block_open:
        lines.append(f"block_comment_open {escape_token(block_open)}")
        lines.append(f"block_comment_close {escape_token(block_close)}")
    lines.append(f"line_comment {escape_token(comment)}")
    lines.extend(f"string {escape_token(delimiter)}" for delimiter in strings)
    if keywords:
        kind = "command" if all(COMMAND_RE.match(token) for token in keywords) else "keyword"
        lines.append("kind " + kind + " " + " ".join(escape_token(t) for t in keywords))
    return "\n".join(lines) + "\n"


def _build_parser() -> argparse.ArgumentParser:
    parser = _Parser(
        prog="newlang.py",
        description="Write a .lang descriptor for a new language. Exit codes: 0 ok, 2 refused, 3 usage error.",
    )
    parser.add_argument("--id", required=True, metavar="ID", help="language id, e.g. yarn")
    parser.add_argument(
        "--ext",
        required=True,
        action="append",
        metavar=".EXT",
        help="file extension (repeatable), e.g. --ext .yarn",
    )
    parser.add_argument("--title", metavar="T", help="display title (default: derived from --id)")
    parser.add_argument("--comment", metavar="CHAR", default="#", help="line comment marker (default #)")
    parser.add_argument(
        "--string",
        action="append",
        default=[],
        metavar="TOKEN",
        help='string delimiter (repeatable), e.g. --string \'"\'',
    )
    parser.add_argument(
        "--block-comment-open",
        metavar="TOKEN",
        default="",
        help="block comment opener, e.g. /* (requires --block-comment-close)",
    )
    parser.add_argument(
        "--block-comment-close",
        metavar="TOKEN",
        default="",
        help="block comment closer, e.g. */ (requires --block-comment-open)",
    )
    parser.add_argument(
        "--keywords",
        action="append",
        default=[],
        metavar='"a,b,c"',
        help="comma-separated tokens (repeatable); --id and --ext are still required",
    )
    parser.add_argument(
        "--keyword",
        action="append",
        default=[],
        metavar="TOKEN",
        help="one token, taken verbatim (repeatable); use this for a literal comma",
    )
    parser.add_argument("--out", default="langs", metavar="DIR", help="output directory (default langs)")
    parser.add_argument("--force", action="store_true", help="overwrite an existing descriptor")
    return parser


def main(argv=None) -> int:
    """Entry point; returns the process exit code."""
    args = _build_parser().parse_args(argv)

    if not ID_RE.match(args.id):
        return _fail(f"invalid --id {args.id!r} (want letters, digits, '_', '-' starting with a letter)")
    try:
        extensions = normalise_extensions(args.ext)
    except ValueError as exc:
        return _fail(str(exc))
    if not extensions:
        return _fail("at least one --ext is required")
    comment = args.comment
    if not comment or WHITESPACE_RE.search(comment) or comment == '"':
        return _fail(f"invalid --comment {comment!r} (want a non-blank marker without whitespace)")
    try:
        strings = []
        for value in args.string:
            _check_marker(value, "--string")
            if value not in strings:
                strings.append(value)
        block_open, block_close = args.block_comment_open, args.block_comment_close
        if block_open or block_close:
            _check_marker(block_open, "--block-comment-open")
            _check_marker(block_close, "--block-comment-close")
    except ValueError as exc:
        return _fail(str(exc))
    try:
        keywords = parse_keywords(args.keywords, args.keyword)
    except ValueError as exc:
        return _fail(str(exc))

    title = args.title if args.title else title_for(args.id)
    text = render(args.id, title, extensions, comment, keywords, strings, block_open, block_close)
    problem = verify_descriptor(text)
    if problem is not None:
        return _fail(f"refusing to write a descriptor the runtime would reject: {problem}", code=2)

    out_dir = Path(args.out)
    target = out_dir / f"{args.id}.lang"
    if target.exists() and not args.force:
        return _fail(f"refusing to overwrite {target.resolve()} (pass --force)", code=2)
    try:
        out_dir.mkdir(parents=True, exist_ok=True)
        target.write_text(text, encoding="utf-8", newline="\n")
    except OSError as exc:
        return _fail(f"cannot write {target}: {exc}", code=2)

    print(target.resolve())
    return 0


if __name__ == "__main__":
    sys.exit(main())
