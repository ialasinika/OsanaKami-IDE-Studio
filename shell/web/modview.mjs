/* modview.mjs -- the same board document, arranged for mod development.
 *
 * A mod is not a project of files; it is a package with a shape: `mod.json`
 * names the defines, the defines name the sprites and the Yarn, and the whole
 * thing is either valid or it is not.  Editing it means moving between three
 * things constantly --
 *
 *   the package    what is in it, grouped the way the game groups it
 *   the file       the one editor card a command would act on
 *   the report     what validation says is wrong with it, right now
 *
 * -- so this view puts all three on screen at once: the package in the left
 * column, the file in the middle, and the report in a panel under the file,
 * where it stays visible while the file is being typed in.  That is the whole
 * difference from `classic`, which spends the bottom of the window on nothing
 * but more code.
 *
 * Like `classic.mjs` this is a projection: it returns ids and rectangles, reads
 * a card and never writes one.  `mode board` restores the document exactly,
 * because the document was never touched -- see `docs/VIEWS.md`.
 *
 * Pure, so it runs under Node: no DOM, no clock, no I/O.
 */

/** Card kinds that can stand in the sidebar, best first.  The package wins. */
export const MOD_SIDEBAR_KINDS = Object.freeze(["mod", "project", "files"]);

/** Card kinds that can stand in the bottom panel, best first. */
export const MOD_PANEL_KINDS = Object.freeze(["problems"]);

/** The sidebar's comfortable width, and the narrowest it may be squeezed to. */
export const MOD_SIDEBAR_W = 320;
export const MOD_SIDEBAR_MIN = 180;

/** The tab strip's height, in pixels -- the same strip `classic` draws. */
export const MOD_TAB_H = 34;

/** The panel's comfortable height, and where a report stops being readable. */
export const MOD_PANEL_H = 200;
export const MOD_PANEL_MIN = 80;

/**
 * How much code must stay on screen.  A panel is worth having only while there
 * is still a file to look at above it: with less than this the panel is dropped
 * outright rather than squeezing the editor to a slit.
 */
export const MOD_AREA_MIN = 140;

/**
 * Which card plays which part, as ids.
 *
 * `sidebar` is the mod package when there is one, then the project panel, then
 * the file list -- the three cards that answer "what is in this thing", in the
 * order this view cares about them.  `area` is the card a command would act on
 * (the selection, when it is an editor), because a code area that is not the
 * focused file is an editor you cannot type in.  `panel` is the validation
 * report.  Everything else has no part here.
 *
 * A card appears at most once.  Kinds are disjoint, so no card can be both the
 * sidebar and the code area -- but the rule is what the checks pin, not the kind
 * list, so a future panel kind that is also editable cannot double-book.
 */
export function modRoles(cards, activeId = null) {
  const list = Array.isArray(cards) ? cards : [];
  const firstOf = (kinds) => {
    for (const kind of kinds) {
      const found = list.find((card) => card !== null && card.kind === kind);
      if (found !== undefined) {
        return found.id;
      }
    }
    return null;
  };

  const sidebar = firstOf(MOD_SIDEBAR_KINDS);
  const panel = firstOf(MOD_PANEL_KINDS);

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
    if (card !== null && card.id !== sidebar && card.id !== area && card.id !== panel) {
      hidden.push(card.id);
    }
  }

  return { sidebar, tabs, area, panel, hidden };
}

/** A number, or `fallback` when the value is not one. */
function numberOr(value, fallback) {
  return typeof value === "number" && isFinite(value) ? value : fallback;
}

/**
 * The rectangles the mod view draws, in the pixels of the board element.
 *
 * `viewport` is `{ width, height }` of the visible board and `top` is how much
 * of it the floating HUD already covers -- the same two numbers `classicLayout`
 * takes, and for the same reason: the identity transform is what lets these be
 * screen pixels and world pixels at once.
 *
 * The result is a tile with no gap and no overlap at any size: the sidebar
 * column on the left, the tab strip across the top of what is left, the code
 * area under it, and the report panel along the bottom of the code column.  The
 * panel is the only part that can disappear -- a window too short for both drops
 * it and gives the height back to the code, rather than squeezing the editor into
 * a slit to keep a two-line report on screen.
 *
 * `boxes` holds the *placed* cards only, so a card with no entry is a card the
 * caller must hide rather than draw at 0,0.
 */
export function modLayout(cards, viewport, options = {}) {
  const width = Math.max(0, Math.round(numberOr(viewport && viewport.width, 0)));
  const height = Math.max(0, Math.round(numberOr(viewport && viewport.height, 0)));
  const top = Math.max(0, Math.round(numberOr(options.top, 0)));
  const roles = modRoles(cards, options.activeId === undefined ? null : options.activeId);

  // Only while there is a sidebar card: an empty column is 320 pixels of
  // nothing.  40% is the most it may take and 180px is where a package tree
  // stops being readable -- until the window is narrower than that, when the
  // code area is already unusable and covering it would be worse than a squeeze.
  let sidebarWidth = 0;
  if (roles.sidebar !== null) {
    const room = Math.min(MOD_SIDEBAR_W, Math.round(width * 0.4));
    sidebarWidth = width < MOD_SIDEBAR_MIN
      ? width
      : Math.min(width, Math.max(MOD_SIDEBAR_MIN, room));
  }

  const tabHeight = Math.max(0, Math.min(MOD_TAB_H, height - top));

  let panelHeight = 0;
  if (roles.panel !== null) {
    const room = Math.max(0, height - top - tabHeight - MOD_AREA_MIN);
    const wanted = Math.min(MOD_PANEL_H, Math.max(MOD_PANEL_MIN, Math.round(height * 0.34)));
    panelHeight = room < MOD_PANEL_MIN ? 0 : Math.min(wanted, room);
  }

  const columnX = sidebarWidth;
  const columnW = Math.max(0, width - sidebarWidth);
  const areaH = Math.max(0, height - top - tabHeight - panelHeight);

  const tabs = { x: columnX, y: top, w: columnW, h: tabHeight };
  const area = { x: columnX, y: top + tabHeight, w: columnW, h: areaH };
  const panel = panelHeight === 0
    ? null
    : { x: columnX, y: top + tabHeight + areaH, w: columnW, h: panelHeight };
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
  if (panel !== null && roles.panel !== null) {
    boxes.set(roles.panel, panel);
  }

  return { roles, sidebarWidth, tabHeight, panelHeight, sidebar, tabs, area, panel, boxes };
}
