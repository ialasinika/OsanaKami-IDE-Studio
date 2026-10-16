/* views.mjs -- the three ways to look at one board document.
 *
 * There is exactly one document (see `docs/PARADIGM.md`): the cards, where they
 * are, and what is written in them.  A *view* is a projection of it -- it
 * computes rectangles, the caller draws them, and nothing is saved.  That is why
 * switching views cannot lose an edit, and why `mode board` brings the board
 * back exactly as the document has it, pan, zoom, overlap and all.
 *
 *   board     the paradigm itself: every card where the document put it
 *   classic   a conventional IDE tile -- what seIDE grew to be usable by
 *             people who do not want to learn a board (classic.mjs)
 *   mod       the same tile arranged around a mod package -- package tree,
 *             code, and the validation that goes with it (modview.mjs)
 *
 * This file is only the list and the words around it, so main.mjs has one place
 * to ask "is this a mode name?" and the two tiles cannot disagree about what a
 * mode is called.
 *
 * Pure, so it runs under Node: no DOM, no clock, no I/O.
 */

/**
 * The mode a window opens in.
 *
 * A mod author opens this to write `.yarn`, `.json` and `.csv` in a mod
 * package, and the tile is the arrangement that does that without being taught
 * anything.  The board is still one `mode` away for the times the arrangement
 * itself is the thing you want to see; it is simply not where anyone lands, and
 * not a button (see `SWITCH_VIEWS`).
 */
export const DEFAULT_VIEW = "classic";

/** The mode names, as `mode <name>` takes them, in switch order. */
export const VIEWS = Object.freeze(["board", "classic", "mod"]);

/**
 * The modes the HUD switch offers -- what a window can be changed into.
 *
 * The board is deliberately absent.  It is a *mode*, not a destination: it draws
 * every card where the document put it, including the ones overlapping, and the
 * only way to make that arrangement meaningful is to drag cards around on it,
 * which is the paradigm this product stopped asking anyone to learn.  Leaving it
 * on the switch would put that back in front of every user as a button; leaving
 * it in `mode` keeps it reachable, and `docs/VIEWS.md` says why.
 */
export const SWITCH_VIEWS = Object.freeze(["classic", "mod"]);

/** What the switch calls each one. */
export const VIEW_LABELS = Object.freeze({
  board: "Board",
  classic: "Classic",
  mod: "Mod",
});

/**
 * The one line of prose each view gets, for the switch button's tooltip.
 *
 * Every name in `VIEWS` has one, including the board, so that putting any view
 * back on the switch is a matter of adding it to `SWITCH_VIEWS` and nothing
 * else -- a button whose title is `undefined` is the kind of thing nobody
 * notices until a user hovers it.  `selftest.mjs` holds that completeness.
 */
export const VIEW_TITLES = Object.freeze({
  board: "every card exactly where the document has it",
  classic: "the same cards as a sidebar, a tab strip and a code area",
  mod: "the same cards arranged around a mod package: package, code, problems",
});

/**
 * The mode a command-line argument names, or null when it names none.
 *
 * An unknown argument is `null` (the caller warns) rather than a silent fall
 * back to the board, because "mode clasic" quietly doing nothing looks like a
 * lost command.
 */
export function viewName(value) {
  if (typeof value !== "string") {
    return null;
  }
  const wanted = value.trim().toLowerCase();
  return VIEWS.indexOf(wanted) === -1 ? null : wanted;
}

/** True for the modes that draw a tile instead of the board. */
export function tiledView(view) {
  return view === "classic" || view === "mod";
}

/**
 * What the heads-up strip says while a view is showing.
 *
 * A tiled view draws under the identity transform with its wheel off, so a zoom
 * reading would be a lie; the slot says so instead of quoting a number that no
 * longer describes the screen.  Anything that is not a known view is the board,
 * the same way an unknown mode argument is refused by `viewName`.
 */
export function viewHud(view) {
  const name = viewName(view);
  return {
    view: name === null ? "board" : name,
    zoom: tiledView(name) ? "no zoom" : null,
  };
}

/** The line printed on entering a view, naming the two ways out of it. */
export function viewNote(view) {
  const name = viewName(view);
  const here = name === null ? "board" : name;
  const others = VIEWS.filter((one) => one !== here).map((one) => `\`mode ${one}\``);
  return `the ${here} view is showing. ${others.join(" or ")}.`;
}

/** The sentence a view prints about itself once it is on screen. */
export function viewAbout(view) {
  const name = viewName(view);
  switch (name === null ? "board" : name) {
    case "classic":
      return "classic view: a sidebar, a tab strip and a code area, drawn over the same board";
    case "mod":
      return "mod view: the package on the left, the code in the middle, the problems it reports underneath";
    default:
      return "board view: the cards are exactly where the document has them";
  }
}
