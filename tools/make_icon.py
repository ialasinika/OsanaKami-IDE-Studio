"""Draws electron/icon.ico.

The window icon is a build input, not a design artefact, so it is generated from
one file instead of being a binary nobody can edit.  Re-run it after changing the
palette:

    python tools/make_icon.py

The mark is the product's actual paradigm rather than its name: three cards on a
dark board, joined by links, each with a coloured title bar taken from
`shell/web/style.css`.  That is what the app looks like, it survives being
downscaled to 16x16 (three coloured blocks, not a glyph that turns to mush), and
it stays legible in a taskbar where a single 幼 would have to be redrawn by hand
at every size.
"""

import sys
from pathlib import Path

from PIL import Image, ImageDraw

ROOT = Path(__file__).resolve().parent.parent
OUT = ROOT / "electron" / "icon.ico"

BG = (20, 22, 26, 255)         # --bg
EDGE = (43, 48, 56, 255)       # --line
BODY = (34, 38, 46, 255)       # --card-hi
FAINT = (58, 64, 74, 255)      # card text, abstracted
LINK = (72, 80, 92, 255)       # a board link
BLUE = (111, 179, 255, 255)    # --accent
GREEN = (116, 201, 145, 255)   # --ok
PURPLE = (124, 78, 193, 255)   # the mod card's accent

# Drawn at 8x and downsampled: Pillow has no antialiased rounded rectangle, and
# an icon is exactly where the aliasing shows.
S = 8
SIZES = [16, 24, 32, 48, 64, 128, 256]

# Geometry on a 256 grid: a big editor card, a small mod card beside it, and a
# problems card below them, joined the way the board joins them.
EDITOR = (28, 36, 148, 124)
MOD = (162, 36, 228, 96)
PROBLEMS = (100, 136, 228, 224)
LINKS = [((142, 122), (114, 142)), ((196, 102), (182, 138))]


def card(canvas, box, header, radius, header_height, text_lines):
    x0, y0, x1, y1 = [v * S for v in box]
    r = radius * S
    canvas.rounded_rectangle([x0, y0, x1, y1], radius=r, fill=BODY, outline=EDGE, width=max(1, S))

    top = y0 + header_height * S
    canvas.rounded_rectangle(
        [x0, y0, x1, top],
        radius=r,
        fill=header,
        corners=(True, True, False, False),
    )

    # Two faint bars standing in for the card's content; any more detail is
    # invisible below 48px.
    for index, fraction in enumerate(text_lines):
        bar_y = top + (14 + index * 22) * S
        if bar_y + 8 * S > y1 - 8 * S:
            break
        canvas.rounded_rectangle(
            [x0 + 12 * S, bar_y, x0 + int((x1 - x0) * fraction), bar_y + 8 * S],
            radius=4 * S,
            fill=FAINT,
        )


def link(canvas, start, end, width):
    canvas.line(
        [start[0] * S, start[1] * S, end[0] * S, end[1] * S],
        fill=LINK,
        width=width * S,
    )


def draw_master():
    big = 256 * S
    image = Image.new("RGBA", (big, big), (0, 0, 0, 0))
    canvas = ImageDraw.Draw(image)

    inset = 2 * S
    canvas.rounded_rectangle(
        [inset, inset, big - inset - 1, big - inset - 1],
        radius=56 * S,
        fill=BG,
        outline=EDGE,
        width=max(1, 2 * S),
    )

    for start, end in LINKS:
        link(canvas, start, end, 5)

    card(canvas, EDITOR, BLUE, 12, 26, [0.78, 0.52])
    card(canvas, MOD, PURPLE, 10, 20, [0.62])
    card(canvas, PROBLEMS, GREEN, 12, 26, [0.66, 0.40])

    return image


def main():
    master = draw_master()
    OUT.parent.mkdir(parents=True, exist_ok=True)
    icons = [master.resize((s, s), Image.LANCZOS) for s in SIZES]
    # Pillow writes every requested size into the one .ico container.
    icons[-1].save(OUT, format="ICO", sizes=[(s, s) for s in SIZES], append_images=icons[:-1])
    print(f"wrote {OUT} ({OUT.stat().st_size} bytes, sizes {SIZES})")
    return 0


if __name__ == "__main__":
    sys.exit(main())
