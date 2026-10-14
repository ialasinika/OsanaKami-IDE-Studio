#!/usr/bin/env python3
"""newlang.py -- scaffold a seIDE ``.lang`` language descriptor.

    python tools/newlang.py --id ID --ext .EXT [--title T] [--comment CHAR]
                            [--keywords "a,b,c"] [--keyword TOKEN]
                            [--out DIR] [--force]

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


def render(language_id: str, title: str, extensions, comment: str, keywords) -> str:
    """Render the descriptor text (always LF-terminated, exactly one final LF)."""
    lines = ["# seIDE language descriptor", f"id {language_id}", f"title {title}"]
    lines.extend(f"ext {extension}" for extension in extensions)
    lines.append(f"line_comment {comment}")
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
    parser.add_argument("--comment", metavar="CHAR", default="#", help="line comment marker (default #)")
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
        keywords = parse_keywords(args.keywords, args.keyword)
    except ValueError as exc:
        return _fail(str(exc))

    title = args.title if args.title else title_for(args.id)
    text = render(args.id, title, extensions, comment, keywords)

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
