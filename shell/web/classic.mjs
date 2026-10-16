/* classic.mjs -- the same board document, arranged as a conventional IDE.
 *
 * seIDE's paradigm is one 2-D board: a card is open because it is *somewhere*,
 * and where it is is part of the project.  This module adds the other way to
 * look at that, and it does it without a second document:
 *
 *   sidebar   the project panel (or the file list) in the left column
 *   tabs      one button per editor card, in the strip along the top
 *   area      the editor card a command would act on, filling what is left
 *
 * Everything here is arithmetic on `cards` and returns ids and rectangles.  It
 * reads a card and never writes one -- that is the whole promise of "classic is
 * a view": the positions it computes are drawn, not saved, so `mode board`
 * brings back the board exactly as the document has it, pan, zoom, overlap and
 * all.  If this file moved the cards it would be a second layout engine with a
 * migration problem; keeping it a projection is why it can be deleted.
 *
 * Pure, so it runs under Node: no DOM, no clock, no I/O.  main.mjs owns the
 * pixels; see `docs/PARADIGM.md` for what the mode is allowed to be.
 */

/** Card kinds that can stand in the sidebar, best first. */
export const CLASSIC_SIDEBAR_KINDS = Object.freeze(["project", "files"]);

/** The sidebar's comfortable width, and the narrowest it may be squeezed to. */
export const CLASSIC_SIDEBAR_W = 280;
export const CLASSIC_SIDEBAR_MIN = 160;

/** The tab strip's height, in pixels. */
export const CLASSIC_TAB_H = 34;

/** The tab a path gets: the last segment, with either slash treated as one. */
export function classicTabLabel(path) {
  const text = String(path === null || path === undefined ? "" : path).replace(/\\/g, "/");
  const cut = text.lastIndexOf("/");
  const base = cut === -1 ? text : text.slice(cut + 1);
  return base === "" ? text : base;
}

/**
 * Which card plays which part, as ids.
 *
 * `sidebar` is the project panel when there is one and the file list when there
 * is not -- the two cards that answer "what is in this project".  `area` is the
 * card a command with no argument would act on (the selection, when it is an
 * editor), because a classic layout whose code area is not the focused file is
 * an editor you cannot type in.  Everything else is hidden: a note, a runner, a
 * sheet or a frame has no place in this arrangement, and emptying the board to
 * make room for the view is exactly what must not happen.
 *
 * A card appears at most once.  Kinds are disjoint, so no card can be both the
 * sidebar and the code area -- but the rule is what the checks pin, not the
 * kind list, so a future sidebar kind that is also editable cannot double-book.
 */
export function classicRoles(cards, activeId = null) {
  const list = Array.isArray(cards) ? cards : [];

  let sidebar = null;
  for (const kind of CLASSIC_SIDEBAR_KINDS) {
    const found = list.find((card) => card !== null && card.kind === kind);
    if (found !== undefined) {
      sidebar = found.id;
      break;
    }
  }

  const tabs = [];
  for (const card of list) {
    if (card !== null && card.kind === "editor") {
      tabs.push(card.id);
    }
  }

  let area = null;
  if (activeId !== null && tabs.indexOf(activeId) !== -1) {
    area = activeId;
  } else if (tabs.length > 0) {
    area = tabs[0];
  }

  const hidden = [];
  for (const card of list) {
    if (card !== null && card.id !== sidebar && card.id !== area) {
      hidden.push(card.id);
    }
  }

  return { sidebar, tabs, area, hidden };
}

/** A number, or `fallback` when the value is not one. */
function numberOr(value, fallback) {
  return typeof value === "number" && isFinite(value) ? value : fallback;
}

/**
 * The rectangles the classic view draws, in the pixels of the board element.
 *
 * `viewport` is `{ width, height }` of the visible board -- these are screen
 * pixels, because a card is laid out in the board element itself rather than
 * under a transform.  `top` is how much of that is already taken by the heads-up
 * strip, which floats over the board rather than being a row of its own: the
 * tile starts below it, or the tab strip would sit under the HUD's text.
 *
 * The result is a tile: the sidebar column on the left (only while there is a
 * sidebar card -- an empty column is 280 pixels of nothing), the tab strip
 * across the rest, the code area under it, and no gap or overlap between them
 * at any size, including a window too narrow for the sidebar's comfortable
 * width.
 *
 * `boxes` holds the *placed* cards only, so a card with no entry is a card the
 * caller must hide rather than draw at 0,0.
 */
export function classicLayout(cards, viewport, options = {}) {
  const width = Math.max(0, Math.round(numberOr(viewport && viewport.width, 0)));
  const height = Math.max(0, Math.round(numberOr(viewport && viewport.height, 0)));
  const top = Math.max(0, Math.round(numberOr(options.top, 0)));
  const roles = classicRoles(cards, options.activeId === undefined ? null : options.activeId);

  let sidebarWidth = 0;
  if (roles.sidebar !== null) {
    // Narrow windows squeeze the column instead of letting it eat the code: 40%
    // is the most it may take, and 160px is where its listing stops being
    // readable -- until the window itself is narrower than that, when the code
    // area is already unusable and covering it would be worse than the squeeze.
    const room = Math.min(CLASSIC_SIDEBAR_W, Math.round(width * 0.4));
    sidebarWidth = width < CLASSIC_SIDEBAR_MIN
      ? width
      : Math.min(width, Math.max(CLASSIC_SIDEBAR_MIN, room));
  }

  const tabHeight = Math.max(0, Math.min(CLASSIC_TAB_H, height - top));
  const area = {
    x: sidebarWidth,
    y: top + tabHeight,
    w: Math.max(0, width - sidebarWidth),
    h: Math.max(0, height - top - tabHeight),
  };
  const tabs = {
    x: sidebarWidth,
    y: top,
    w: Math.max(0, width - sidebarWidth),
    h: tabHeight,
  };
  const sidebar = roles.sidebar === null
    ? null
    : { x: 0, y: top, w: sidebarWidth, h: Math.max(0, height - top) };

  const boxes = new Map();
  if (sidebar !== null) {
    boxes.set(roles.sidebar, sidebar);
  }
  if (roles.area !== null) {
    boxes.set(roles.area, area);
  }

  return { roles, sidebarWidth, tabHeight, sidebar, tabs, area, boxes };
}
