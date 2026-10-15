"""Put the starter board where the app looks for it.

`examples/board.json` is the board the README's screenshots show: five cards
(an editor on `examples/hello.bf`, a note, a runner, a files panel and a sheet),
three labelled links between them, and a viewport at the origin.

The live board is `<root>/.seide/board.json`, and `.seide/` is gitignored --
each clone's layout is private -- so the starter board cannot simply be checked
out.  A fresh clone therefore opens an empty canvas, and every screenshot and
bug report in the docs becomes unreproducible.  This copies it into place.

This deliberately does not talk to the kernel: it moves one file, and the app
reads it on the next start.  Nothing is validated by the C validator here --
`tools/e2e.py` does that, so the shipped board is known to be a board the
kernel accepts.

    python tools/demo.py                  # install into this checkout
    python tools/demo.py --root DIR       # ... into another workspace
    python tools/demo.py --force          # replace a board that is already there
    python tools/demo.py --print          # print the board, change nothing

Exit codes: 0 = installed (or already installed), 2 = refused or unusable.
"""
import argparse
import json
import os
import sys

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
STARTER = os.path.join(ROOT, "examples", "board.json")
BOARD_REL = os.path.join(".seide", "board.json")


def show(label, detail):
    print(f"{label:<14} {detail}")


def load(path):
    """Parse the starter board, or leave with a message that says why."""
    try:
        with open(path, "rb") as handle:
            raw = handle.read()
    except OSError as exc:
        _fail(f"cannot read {path}: {exc}")
    try:
        return raw, json.loads(raw.decode("utf-8"))
    except (UnicodeDecodeError, ValueError) as exc:
        _fail(f"{path} is not UTF-8 JSON: {exc}")


def _fail(message, code=2):
    print(f"demo.py: {message}", file=sys.stderr)
    raise SystemExit(code)


def check_shape(doc, path):
    """The minimum a board must be for the app to open it without surprises.

    Not a second validator: the kernel owns that.  This catches a hand-edited
    starter board before it is copied into someone's workspace, where a bad
    board would look like a broken app rather than a bad fixture.
    """
    if not isinstance(doc, dict):
        _fail(f"{path}: the board is not an object")
    cards = doc.get("cards")
    links = doc.get("links")
    if not isinstance(cards, list) or not cards:
        _fail(f"{path}: `cards` must be a non-empty array")
    if not isinstance(links, list):
        _fail(f"{path}: `links` must be an array")
    ids = set()
    for index, card in enumerate(cards):
        if not isinstance(card, dict):
            _fail(f"{path}: cards[{index}] is not an object")
        card_id = card.get("id")
        kind = card.get("kind")
        if not isinstance(card_id, str) or card_id == "":
            _fail(f"{path}: cards[{index}] has no id")
        if not isinstance(kind, str) or kind == "":
            _fail(f"{path}: card {card_id} has no kind")
        if card_id in ids:
            _fail(f"{path}: card id {card_id!r} appears twice")
        ids.add(card_id)
    for index, link in enumerate(links):
        if not isinstance(link, dict):
            _fail(f"{path}: links[{index}] is not an object")
        for end in ("from", "to"):
            target = link.get(end)
            if target not in ids:
                _fail(f"{path}: links[{index}] {end}={target!r} is not a card id")
    return cards, links


def install(starter_raw, root, force):
    """Copy the starter board to <root>/.seide/board.json; return the action.

    `already installed` is reported when the file on disk is byte-identical,
    because that is the interesting case: it means the workspace was not
    touched, not that the command did nothing.
    """
    target_dir = os.path.join(root, ".seide")
    target = os.path.join(target_dir, BOARD_REL.split(os.sep)[-1])
    replacing = False
    if os.path.exists(target):
        with open(target, "rb") as handle:
            current = handle.read()
        if current == starter_raw:
            return "already installed", target
        if not force:
            _fail(
                f"{target} exists and is not the starter board "
                f"({len(current)} bytes vs {len(starter_raw)}). "
                "It is untouched. Pass --force to replace it, or move it aside first."
            )
        replacing = True
    os.makedirs(target_dir, exist_ok=True)
    with open(target, "wb") as handle:
        handle.write(starter_raw)
    return ("replaced" if replacing else "installed"), target


def main(argv=None):
    parser = argparse.ArgumentParser(
        description="Install examples/board.json as this workspace's board.",
    )
    parser.add_argument(
        "--root",
        default=os.getcwd(),
        help="workspace root to install into (default: the current directory)",
    )
    parser.add_argument(
        "--force",
        action="store_true",
        help="replace an existing .seide/board.json",
    )
    parser.add_argument(
        "--print",
        dest="print_only",
        action="store_true",
        help="print the starter board and change nothing",
    )
    args = parser.parse_args(argv)

    starter_raw, doc = load(STARTER)
    cards, links = check_shape(doc, STARTER)
    kinds = {}
    for card in cards:
        kinds[card["kind"]] = kinds.get(card["kind"], 0) + 1
    summary = ", ".join(f"{n} {kind}" for kind, n in sorted(kinds.items()))

    if args.print_only:
        sys.stdout.write(starter_raw.decode("utf-8"))
        return 0

    root = os.path.abspath(args.root)
    show("starter board", f"{STARTER} ({len(starter_raw)} bytes)")
    show("contents", f"{len(cards)} cards ({summary}), {len(links)} links")
    show("target", os.path.join(root, BOARD_REL))
    action, target = install(starter_raw, root, args.force)
    show("action", action)
    if action == "already installed":
        show("note", "the file on disk is byte-identical to the starter board")
    else:
        show(
            "next",
            "node shell/main.mjs serve --workspace "
            + (root if root != ROOT else "."),
        )
    return 0


if __name__ == "__main__":
    sys.exit(main())
