#!/usr/bin/env python3
"""newlang.py -- scaffold a seIDE ``.lang`` language descriptor.

    python tools/newlang.py --id ID --ext .EXT [--title T] [--comment CHAR]
                            [--keywords "a,b,c"] [--keyword TOKEN]
                            [--out DIR] [--force]
    python tools/newlang.py --id ID --ext .EXT --family sgml
                            [--raw-element NAME ...] [--out DIR] [--force]

The written file uses exactly the grammar the seIDE descriptor parser accepts
(``langs/lang.mjs``, loaded by the shell -- languages are not part of the C
kernel)::

    # seIDE language descriptor
    id brainfuck
    title Brainfuck
    ext .bf
    line_comment #
    kind command "+" "-" "<" ">" "[" "]" "." ","

Only the keys named in that grammar are ever emitted -- an unknown key is a hard
error for the parser, so inventing one here would produce a broken descriptor.
``kind`` is ``command`` when every token is a single non-alphanumeric character
and ``keyword`` otherwise.  Tokens are always double-quoted, with ``\\"``,
``\\\\``, ``\\n`` and ``\\t`` escaped.

``--keywords`` splits on commas, so a token that is itself a comma (Brainfuck's
``,``) is given with the repeatable ``--keyword``, which takes one token verbatim::

    python tools/newlang.py --id brainfuck --ext .bf \
        --keywords "+,-,<,>,[,],." --keyword ","

A language whose syntax is SGML's (HTML, XML, SVG, ...) is scaffolded as a
*family* member instead.  Its delimiters live in ``langs/markup.mjs``, so the
descriptor says only who it is and which elements hold raw text::

    python tools/newlang.py --id html --ext .html --family sgml \
        --raw-element script --raw-element style

``--comment``, ``--keywords`` and ``--keyword`` are flat-scan facts and are
refused together with ``--family sgml``; ``--raw-element`` is refused without it.

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
    "family",
    "raw_element",
    "line_comment",
    "block_comment_open",
    "block_comment_close",
    "string",
    "kind",
)

#: Tokenizer families a descriptor may name (``langs/lang.mjs``).
FAMILIES = ("flat", "sgml")

#: Keys that only the flat scanner reads; combining one with ``family sgml`` is
#: a contradiction rather than a no-op, so it is refused here as well.
FLAT_ONLY_KEYS = (
    "line_comment",
    "block_comment_open",
    "block_comment_close",
    "string",
    "kind",
)

#: An element name in ``raw_element`` (XML's NameStartChar and NameChar).
NAME_RE = re.compile(r"^[A-Za-z_:][A-Za-z0-9_:.-]*$")


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
    family = None
    flat_keys = []
    raw_element_lines = 0
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
        elif key == "family":
            if rest not in FAMILIES:
                return f"line {number}: unknown family {rest!r} (expected one of {', '.join(FAMILIES)})"
            if family is not None and family != rest:
                return f"line {number}: family is already {family}; a descriptor names one family"
            family = rest
        elif key == "raw_element":
            try:
                names = scan_quoted(rest)
            except ValueError as exc:
                return f"line {number}: {exc}"
            if not names:
                return f"line {number}: raw_element names no element"
            for name in names:
                if not NAME_RE.match(name):
                    return f"line {number}: invalid element name {name!r}"
            raw_element_lines += 1
        elif not rest:
            return f"line {number}: {key} must not be empty"
        if key in FLAT_ONLY_KEYS:
            flat_keys.append(key)
        counts[key] = counts.get(key, 0) + 1
    for required in ("id", "title"):
        if counts.get(required, 0) != 1:
            return f"expected exactly one {required} line"
    if family == "sgml" and flat_keys:
        return f"{flat_keys[0]} is a flat-scan key; family sgml has SGML's own delimiters"
    if raw_element_lines and family != "sgml":
        return "raw_element belongs to family sgml; add a family line"
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
            raise ValueError(f"invalid extension {value!r} (want something like .bf)")
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
    family: str = "flat",
    raw_elements=(),
) -> str:
    """Render the descriptor text (always LF-terminated, exactly one final LF)."""
    lines = ["# seIDE language descriptor", f"id {language_id}", f"title {title}"]
    lines.extend(f"ext {extension}" for extension in extensions)
    if family == "sgml":
        lines.append("family sgml")
        if raw_elements:
            lines.append("raw_element " + " ".join(escape_token(e) for e in raw_elements))
        return "\n".join(lines) + "\n"
    lines.append(f"line_comment {escape_token(comment)}")
    if keywords:
        kind = "command" if all(COMMAND_RE.match(token) for token in keywords) else "keyword"
        lines.append("kind " + kind + " " + " ".join(escape_token(t) for t in keywords))
    return "\n".join(lines) + "\n"


def _build_parser() -> argparse.ArgumentParser:
    parser = _Parser(
        prog="newlang.py",
        description="Write a .lang descriptor for a new language. Exit codes: 0 ok, 2 refused, 3 usage error.",
    )
    parser.add_argument("--id", required=True, metavar="ID", help="language id, e.g. brainfuck")
    parser.add_argument(
        "--ext",
        required=True,
        action="append",
        metavar=".EXT",
        help="file extension (repeatable), e.g. --ext .bf",
    )
    parser.add_argument("--title", metavar="T", help="display title (default: derived from --id)")
    parser.add_argument(
        "--family",
        choices=FAMILIES,
        default="flat",
        help="tokenizer family: flat (the default) or sgml (HTML/XML/SVG)",
    )
    parser.add_argument(
        "--raw-element",
        action="append",
        default=[],
        metavar="NAME",
        help="family sgml: an element whose body is text, not markup (repeatable)",
    )
    parser.add_argument(
        "--comment", metavar="CHAR", default=None, help="line comment marker (default #)"
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
    comment = args.comment if args.comment is not None else "#"
    if not comment or WHITESPACE_RE.search(comment) or comment == '"':
        return _fail(f"invalid --comment {comment!r} (want a non-blank marker without whitespace)")
    try:
        keywords = parse_keywords(args.keywords, args.keyword)
    except ValueError as exc:
        return _fail(str(exc))

    raw_elements = []
    for name in args.raw_element:
        if not NAME_RE.match(name):
            return _fail(f"invalid --raw-element {name!r} (want an element name like 'script')")
        if name not in raw_elements:
            raw_elements.append(name)

    if args.family == "sgml":
        if args.comment is not None or keywords:
            return _fail(
                "--comment/--keywords/--keyword are flat-scan facts; "
                "a --family sgml descriptor names raw elements instead"
            )
    else:
        if raw_elements:
            return _fail("--raw-element belongs to --family sgml")

    title = args.title if args.title else title_for(args.id)
    text = render(args.id, title, extensions, comment, keywords, args.family, raw_elements)
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
