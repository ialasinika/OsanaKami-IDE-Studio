/* views.mjs -- the two ways to look at one board document.
 *
 * There is exactly one document (see `docs/PARADIGM.md`): the cards, what is
 * written in them, and the links between them.  A *view* is a projection of it
 * -- it computes rectangles, the caller draws them, and nothing is saved.  That
 * is why switching views cannot lose an edit.
 *
 *   classic   a conventional IDE tile -- what seIDE grew to be usable by
 *             people who do not want to learn a board (classic.mjs)
 *   mod       the same tile arranged around a mod package -- package tree,
 *             code, and the validation that goes with it (modview.mjs)
 *
 * Those are all the views there are.  The *document* is still a board
 * (board.json, board.mjs, `#board`); what is gone is the view that drew every
 * card exactly where the document put it, with its pan, its zoom and its
 * overlap.  Both views that remain are tiles, which is the arrangement an
 * editor is expected to have, so `mode board` is now just another word `mode`
 * does not know.
 *
 * This file is only the list and the words around it, so main.mjs has one place
 * to ask "is this a mode name?" and the two tiles cannot disagree about what a
 * mode is called.
 *
 * Pure, so it runs under Node: no DOM, no clock, no I/O.
 */

/**
 * The view a window opens in.
 *
 * A mod author opens this to write `.yarn`, `.json` and `.csv` in a mod
 * package, and the tile is the arrangement that does that without being taught
 * anything.
 */
export const DEFAULT_VIEW = "classic";

/** The view names, as `mode <name>` takes them, in switch order. */
export const VIEWS = Object.freeze(["classic", "mod"]);

/**
 * The views the HUD switch offers -- what a window can be changed into.
 *
 * Every view is on the switch: there are two, they are both tiles, and a button
 * is also the answer to "where did the other view go?".  A view that was
 * reachable only by name would be a view most people never learn exists.
 */
export const SWITCH_VIEWS = Object.freeze(["classic", "mod"]);

/** What the switch calls each one. */
export const VIEW_LABELS = Object.freeze({
  classic: "Classic",
  mod: "Mod",
});

/**
 * The one line of prose each view gets, for the switch button's tooltip.
 *
 * Every name in `VIEWS` has one, so a button whose title is `undefined` cannot
 * happen -- the kind of thing nobody notices until a user hovers it.
 * `selftest.mjs` holds that completeness.
 */
export const VIEW_TITLES = Object.freeze({
  classic: "the same cards as a sidebar, a tab strip and a code area",
  mod: "the same cards arranged around a mod package: package, code, problems",
});

/**
 * The view a command-line argument names, or null when it names none.
 *
 * An unknown argument is `null` (the caller warns) rather than a silent fall
 * back to the classic view, because "mode clasic" quietly doing nothing looks
 * like a lost command.  `mode board` is one of those unknown words now.
 */
export function viewName(value) {
  if (typeof value !== "string") {
    return null;
  }
  const wanted = value.trim().toLowerCase();
  return VIEWS.indexOf(wanted) === -1 ? null : wanted;
}

/** True for the modes that draw a tile.  Both known views do. */
export function tiledView(view) {
  return view === "classic" || view === "mod";
}

/** The line printed on entering a view, naming the other one. */
export function viewNote(view) {
  const name = viewName(view);
  const here = name === null ? DEFAULT_VIEW : name;
  const others = VIEWS.filter((one) => one !== here).map((one) => `\`mode ${one}\``);
  return `the ${here} view is showing. ${others.join(" or ")}.`;
}

/** The sentence a view prints about itself once it is on screen. */
export function viewAbout(view) {
  const name = viewName(view);
  switch (name === null ? DEFAULT_VIEW : name) {
    case "mod":
      return "mod view: the package on the left, the code in the middle, the problems it reports underneath";
    default:
      return "classic view: a sidebar, a tab strip and a code area, drawn over the same board";
  }
}
