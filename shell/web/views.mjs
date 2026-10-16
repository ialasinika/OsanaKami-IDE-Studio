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

/** The mode names, as `mode <name>` takes them, in switch order. */
export const VIEWS = Object.freeze(["board", "classic", "mod"]);

/** What the switch calls each one.  `board` is first: a reload lands there. */
export const VIEW_LABELS = Object.freeze({
  board: "Board",
  classic: "Classic",
  mod: "Mod",
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
