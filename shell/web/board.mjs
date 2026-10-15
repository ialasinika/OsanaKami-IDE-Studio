/**
 * board.mjs -- the board document and the operations the canvas performs.
 *
 * DELETE THIS FILE and seIDE stops being seIDE: it holds the only definition of
 * what a board *is* (cards, links, viewport) and the only place the layout is
 * assembled before `board.save`.  Without it there is nothing to render.
 *
 * It is deliberately UI-free: no `document`, no `window`, no timer.  The same
 * object is used by the browser and by `selftest.mjs` under Node, which is the
 * point -- the spatial model can be tested without a canvas.
 *
 * Two rules borrowed from the kernel so the UI never builds a document the
 * kernel will reject (`core/src/board.c`):
 *
 *   - a card is an object with a non-empty unique string `id`, a non-empty
 *     string `kind`, and numeric `x`/`y`/`w`/`h`;
 *   - a link's `from`/`to` must name a card that exists, and its `id` (when it
 *     has one) must not repeat another link's -- `serialize` refuses to build a
 *     document the kernel would answer with `1004 INVALID_BOARD`.
 *
 * Anything else a card carries (`file`, `cmd`, `text`, and any extra field a
 * fork invents) is stored verbatim, because the kernel stores it verbatim.
 */

/**
 * The card kinds the prototype ships.  Advisory only: this file stores and
 * clones any `kind` string, because the kernel validates a card's *shape*
 * (id, kind, geometry) and deliberately not its vocabulary.  The authoritative
 * list at runtime is `knownCardKinds()` in cards.mjs, which is what the
 * built-in renderers register themselves into.  There is no extension
 * mechanism by design.
 */
export const CARD_KINDS = ["editor", "runner", "note", "files", "search", "project", "sheet", "frame"];

export const BOARD_VERSION = 1;

/** Default size per kind, used by `addCard`. */
export const DEFAULT_SIZE = {
  editor: { w: 640, h: 420 },
  runner: { w: 520, h: 260 },
  note: { w: 300, h: 180 },
  files: { w: 300, h: 520 },
  search: { w: 560, h: 460 },
  sheet: { w: 460, h: 320 },
  frame: { w: 420, h: 300 },
  project: { w: 340, h: 580 },
};

/** Cards never get smaller than this; a zero-size card is unclickable. */
export const MIN_SIZE = { w: 120, h: 80 };

/** Zoom bounds. Below the floor text is unreadable, above the ceiling it is a blur. */
export const ZOOM_MIN = 0.2;
export const ZOOM_MAX = 4;

/** Pan bounds. The space is effectively infinite; the numbers still have to be finite. */
export const PAN_LIMIT = 100000;

function isFiniteNumber(value) {
  return typeof value === "number" && Number.isFinite(value);
}

function isPlainObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

/** Clamp a number into `[lo, hi]`, mapping non-finite input to `fallback`. */
export function clampNumber(value, lo, hi, fallback) {
  if (!isFiniteNumber(value)) {
    return fallback;
  }
  if (value < lo) {
    return lo;
  }
  if (value > hi) {
    return hi;
  }
  return value;
}

/**
 * Normalise a viewport: `{x, y, zoom}` with zoom inside the bounds and finite
 * pan.  Anything missing or non-numeric falls back rather than producing NaN,
 * which would silently blank the canvas.
 */
export function clampViewport(view = {}) {
  const source = isPlainObject(view) ? view : {};
  return {
    x: clampNumber(source.x, -PAN_LIMIT, PAN_LIMIT, 0),
    y: clampNumber(source.y, -PAN_LIMIT, PAN_LIMIT, 0),
    zoom: clampNumber(source.zoom, ZOOM_MIN, ZOOM_MAX, 1),
  };
}

/** Deep copy of a JSON-shaped value. Structurally safe for the documents we hold. */
export function cloneDocument(value) {
  if (Array.isArray(value)) {
    return value.map(cloneDocument);
  }
  if (isPlainObject(value)) {
    const out = {};
    for (const key of Object.keys(value)) {
      out[key] = cloneDocument(value[key]);
    }
    return out;
  }
  return value;
}

/** An empty, valid board document. */
export function emptyDocument() {
  return {
    version: BOARD_VERSION,
    viewport: { x: 0, y: 0, zoom: 1 },
    cards: [],
    links: [],
  };
}

/**
 * A rectangle from two corners, whichever way round they were dragged.
 * `w` and `h` come out non-negative, so the result is comparable with `card`.
 */
export function normaliseRect(a, b) {
  const x1 = Math.min(a.x, b.x);
  const y1 = Math.min(a.y, b.y);
  const x2 = Math.max(a.x, b.x);
  const y2 = Math.max(a.y, b.y);
  return { x: x1, y: y1, w: x2 - x1, h: y2 - y1 };
}

/** True when two axis-aligned boxes touch or overlap. Edges count as touching. */
export function boxesIntersect(a, b) {
  return a.x <= b.x + b.w && b.x <= a.x + a.w
    && a.y <= b.y + b.h && b.y <= a.y + a.h;
}

/**
 * The ids of the cards a rubber band touches, in document order.
 *
 * Touching is enough: a band that clips a card selects it, which is what a file
 * manager's band does and what a person expects when they drag past a corner.
 * Containment would make the gesture feel broken on a dense board, where the
 * band would have to swallow whole cards to select anything.
 *
 * A band with a non-finite edge selects nothing rather than everything: an
 * unmeasurable rectangle must not quietly become "select all".
 */
export function cardsWithin(cards, rect) {
  const box = isPlainObject(rect) ? rect : {};
  if (!isFiniteNumber(box.x) || !isFiniteNumber(box.y)
    || !isFiniteNumber(box.w) || !isFiniteNumber(box.h)) {
    return [];
  }
  const band = { x: box.x, y: box.y, w: box.w, h: box.h };
  const list = Array.isArray(cards) ? cards : [];
  const out = [];
  for (const card of list) {
    if (isValidCard(card) && boxesIntersect(card, band)) {
      out.push(card.id);
    }
  }
  return out;
}

/**
 * The ids of the cards whose *centre* stands inside a rectangle, in document
 * order.
 *
 * Intersection is right for a rubber band and wrong for a frame: a frame holds
 * the cards standing in it, so a card that merely clips the border has not
 * joined the group.  `except` names one id to leave out, which is how a frame
 * asks the question about itself.
 *
 * A rectangle with a non-finite edge holds nothing, for the same reason a
 * malformed band selects nothing.
 */
export function cardsInsideRect(cards, rect, options = {}) {
  const box = isPlainObject(rect) ? rect : {};
  if (!isFiniteNumber(box.x) || !isFiniteNumber(box.y)
    || !isFiniteNumber(box.w) || !isFiniteNumber(box.h)) {
    return [];
  }
  const except = isPlainObject(options) && typeof options.except === "string"
    ? options.except
    : null;
  const list = Array.isArray(cards) ? cards : [];
  const out = [];
  for (const card of list) {
    if (!isValidCard(card) || card.id === except) {
      continue;
    }
    const cx = card.x + card.w / 2;
    const cy = card.y + card.h / 2;
    if (cx > box.x && cx < box.x + box.w && cy > box.y && cy < box.y + box.h) {
      out.push(card.id);
    }
  }
  return out;
}

/**
 * The rectangle that holds every named card, with a margin: what `group`
 * draws round a selection.
 *
 * Ids that name nothing are ignored.  No ids at all has no rectangle, so the
 * answer is `null` rather than a frame collapsed at the origin.
 */
export function frameRect(cards, ids, options = {}) {
  const pad = isPlainObject(options) && isFiniteNumber(options.pad)
    ? Math.max(0, options.pad)
    : 26;
  const list = Array.isArray(cards) ? cards : [];
  const wanted = new Set(Array.isArray(ids) ? ids : []);
  const box = { x: 0, y: 0, w: 0, h: 0 };
  let first = true;
  for (const card of list) {
    if (!isValidCard(card) || !wanted.has(card.id)) {
      continue;
    }
    if (first) {
      box.x = card.x;
      box.y = card.y;
      box.w = card.w;
      box.h = card.h;
      first = false;
      continue;
    }
    const right = Math.max(box.x + box.w, card.x + card.w);
    const bottom = Math.max(box.y + box.h, card.y + card.h);
    box.x = Math.min(box.x, card.x);
    box.y = Math.min(box.y, card.y);
    box.w = right - box.x;
    box.h = bottom - box.y;
  }
  if (first) {
    return null;
  }
  return {
    x: Math.round(box.x - pad),
    y: Math.round(box.y - pad),
    w: Math.round(box.w + pad * 2),
    h: Math.round(box.h + pad * 2),
  };
}

/** True for a card the kernel would accept. Geometry may be repaired later. */
export function isValidCard(card) {
  if (!isPlainObject(card)) {
    return false;
  }
  if (typeof card.id !== "string" || card.id === "") {
    return false;
  }
  if (typeof card.kind !== "string" || card.kind === "") {
    return false;
  }
  return isFiniteNumber(card.x) && isFiniteNumber(card.y)
    && isFiniteNumber(card.w) && isFiniteNumber(card.h);
}

function normaliseCard(card) {
  const cleaned = cloneDocument(card);
  cleaned.id = card.id;
  cleaned.kind = card.kind;
  cleaned.x = card.x;
  cleaned.y = card.y;
  cleaned.w = card.w;
  cleaned.h = card.h;
  cleaned.z = isFiniteNumber(card.z) ? card.z : 0;
  return cleaned;
}

/**
 * Repair a document into a loadable one.
 *
 * Cards the kernel would reject are dropped (with a report, so the caller can
 * tell the user) rather than allowed to poison the board; links that lose an
 * endpoint go with them.  This mirrors `workspace.info` failing loudly: a
 * silently discarded *card* is worse than a visible message.
 *
 * Links are repaired the same way: a link that names a card which did not
 * survive is dropped, and a link whose id is missing or duplicated is given a
 * fresh id (the edge is never lost to a naming collision).  The ids that had to
 * be renamed are reported, not just counted, so the caller can name them.
 *
 * @returns {{document: object, droppedCards: string[], droppedLinks: number,
 *   repairedLinkIds: string[]}}
 */
export function normaliseDocument(input) {
  const doc = isPlainObject(input) ? input : {};
  const out = emptyDocument();
  out.version = isFiniteNumber(doc.version) ? doc.version : BOARD_VERSION;
  out.viewport = clampViewport(doc.viewport);

  const droppedCards = [];
  const seen = new Set();
  const cards = Array.isArray(doc.cards) ? doc.cards : [];

  for (let i = 0; i < cards.length; i += 1) {
    const card = cards[i];
    if (!isValidCard(card)) {
      droppedCards.push(`cards[${i}] (not a card)`);
      continue;
    }
    if (seen.has(card.id)) {
      droppedCards.push(`cards[${i}] (duplicate id ${card.id})`);
      continue;
    }
    seen.add(card.id);
    const clean = normaliseCard(card);
    // Geometry is repaired, not rejected: a card with a negative width is a
    // drag accident, not a corrupt document.
    clean.w = Math.max(MIN_SIZE.w, clean.w);
    clean.h = Math.max(MIN_SIZE.h, clean.h);
    out.cards.push(clean);
  }

  let droppedLinks = 0;
  const repairedLinkIds = [];
  const links = Array.isArray(doc.links) ? doc.links : [];
  /*
   * Link ids are unique board-wide.  A file can still carry the same id twice,
   * and the kernel then refuses to save it back (`1004 INVALID_BOARD`,
   * `links[N]: duplicate \`id\``), so a board that loaded fine would become
   * unsaveable.  The edge is kept and given a fresh id instead: losing a
   * connection the user can see is the worse repair.
   *
   * `reserved` holds every id the file already uses, so a replacement id never
   * steals one that a later link is entitled to keep.
   */
  const reserved = new Set();
  for (const link of links) {
    if (isPlainObject(link) && typeof link.id === "string" && link.id !== "" && !reserved.has(link.id)) {
      reserved.add(link.id);
    }
  }
  const claimed = new Set();
  for (const link of links) {
    if (!isPlainObject(link)) {
      droppedLinks += 1;
      continue;
    }
    const from = link.from;
    const to = link.to;
    if (typeof from !== "string" || typeof to !== "string"
      || !seen.has(from) || !seen.has(to)) {
      droppedLinks += 1;
      continue;
    }
    const clean = cloneDocument(link);
    let id = typeof clean.id === "string" ? clean.id : "";
    if (id === "" || claimed.has(id)) {
      if (clean.id !== undefined && clean.id !== null && clean.id !== "") {
        repairedLinkIds.push(String(clean.id));
      }
      let n = out.links.length + 1;
      do {
        id = `l${n}`;
        n += 1;
      } while (reserved.has(id) || claimed.has(id));
    }
    clean.id = id;
    claimed.add(id);
    out.links.push(clean);
  }

  return { document: out, droppedCards, droppedLinks, repairedLinkIds };
}

/**
 * @param {object} [initial]  a board document (already valid, or it will be repaired)
 * @param {object} [options]
 * @param {(kind: string) => string} [options.idFactory]  id source; defaults to a local counter
 */
export function createBoard(initial, options = {}) {
  const { idFactory = null } = options;

  let document = normaliseDocument(initial).document;
  /*
   * The selection is a *set* of ids, held in document order, plus the primary
   * one: the card the HUD describes and the one a following command with no
   * argument acts on.  `selectedId` (the getter) reports the primary, so every
   * caller written when the selection was a single card keeps working.
   *
   * It is deliberately not part of the document: nothing about which card is
   * highlighted belongs in `.seide/board.json`, and a reload must not resurrect
   * somebody else's selection.
   */
  let selection = [];
  let primaryId = null;
  let nextLocalId = 1;
  let sequence = 0;

  const listeners = new Set();

  /** Local ids are collision-proof against the current document, no round trip. */
  function localId(prefix) {
    const used = new Set(document.cards.map((card) => card.id));
    for (;;) {
      const candidate = `${prefix}${nextLocalId}`;
      nextLocalId += 1;
      if (!used.has(candidate)) {
        return candidate;
      }
    }
  }

  function makeId(prefix) {
    // The host's `board.newId` is the authority when it is available; the local
    // counter is the fallback so the board stays usable standalone.
    if (idFactory !== null) {
      const id = idFactory(prefix);
      if (typeof id === "string" && id !== "") {
        return id;
      }
    }
    return localId(prefix);
  }

  /**
   * The id a new card will carry.  Kept in one place so `addCard` can check for
   * a duplicate whether the id came from the caller or from the id factory.
   */
  function takeId(prefix) {
    const id = makeId(prefix);
    if (findCard(id)) {
      throw new Error(`addCard: id ${JSON.stringify(id)} is already used`);
    }
    return id;
  }

  function findCard(id) {
    return document.cards.find((card) => card.id === id) || null;
  }

  function nextZ() {
    return document.cards.reduce((top, card) => Math.max(top, card.z), 0) + 1;
  }

  function changed() {
    sequence += 1;
    for (const listener of listeners) {
      try {
        listener();
      } catch {
        /* a renderer must not break the model */
      }
    }
  }

  function requireCard(id) {
    const card = findCard(id);
    if (card === null) {
      throw new Error(`no card ${JSON.stringify(id)}`);
    }
    return card;
  }

  /** Replace the whole document (e.g. from `board.load` or a save reply). */
  function load(next) {
    const result = normaliseDocument(next);
    document = result.document;
    pruneSelection();
    changed();
    return result;
  }

  /**
   * @param {string} kind  one of CARD_KINDS (others are stored, but not rendered)
   * @param {number} x
   * @param {number} y
   * @param {object} [fields]  extra per-card fields, stored verbatim
   * @param {{id?: string, w?: number, h?: number, z?: number}} [geometry]
   */
  function addCard(kind, x, y, fields = {}, geometry = {}) {
    if (typeof kind !== "string" || kind === "") {
      throw new TypeError("addCard: kind must be a non-empty string");
    }
    const size = DEFAULT_SIZE[kind] || { w: 420, h: 280 };
    // A caller-supplied id is honoured as-is; otherwise the factory's answer is
    // taken and *then* checked, so a factory that repeats itself is caught.
    // `String(undefined)` would be the string "undefined", which is a valid
    // kernel id, so the check is explicitly against `null`/`undefined`.
    const given = geometry === null || geometry === undefined ? null : geometry.id;
    const id = given === undefined || given === null ? takeId("c") : String(given);
    if (findCard(id)) {
      throw new Error(`addCard: id ${JSON.stringify(id)} is already used`);
    }
    const card = {
      id,
      kind,
      x: isFiniteNumber(x) ? x : 0,
      y: isFiniteNumber(y) ? y : 0,
      w: clampNumber(geometry.w, MIN_SIZE.w, 100000, size.w),
      h: clampNumber(geometry.h, MIN_SIZE.h, 100000, size.h),
      z: isFiniteNumber(geometry.z) ? geometry.z : nextZ(),
    };
    for (const key of Object.keys(fields)) {
      if (card[key] === undefined) {
        card[key] = cloneDocument(fields[key]);
      }
    }
    document.cards.push(card);
    changed();
    return card;
  }

  /** Remove exactly one card (and its links). @returns {boolean} */
  function removeCard(id) {
    return removeCards([id]).length > 0;
  }

  function moveCard(id, x, y) {
    const card = requireCard(id);
    if (isFiniteNumber(x)) {
      card.x = x;
    }
    if (isFiniteNumber(y)) {
      card.y = y;
    }
    changed();
    return card;
  }

  function resizeCard(id, w, h) {
    const card = requireCard(id);
    card.w = clampNumber(w, MIN_SIZE.w, 100000, card.w);
    card.h = clampNumber(h, MIN_SIZE.h, 100000, card.h);
    changed();
    return card;
  }

  /** Bring a card to the front. `z` is only ever compared, never rendered. */
  function raiseCard(id) {
    const card = requireCard(id);
    card.z = nextZ();
    changed();
    return card;
  }

  /** Every link id currently in use, so a new one can be proven unique. */
  function usedLinkIds() {
    return new Set(document.links.map((link) => link.id));
  }

  /** The first free `lN`. Ids are local until a save hands them to the kernel. */
  function freeLinkId() {
    const used = usedLinkIds();
    let n = document.links.length + 1;
    while (used.has(`l${n}`)) {
      n += 1;
    }
    return `l${n}`;
  }

  /**
   * Add one link under a caller-chosen id.
   *
   * Link ids are unique across the whole board, because the kernel refuses a
   * document that repeats one (`1004 INVALID_BOARD`, `links[N]: duplicate
   * \`id\``) -- and because `unlink <id>` names exactly one edge.  Accepting a
   * collision here would let the UI build a document its own backend will not
   * save, so it is an error and not a second link.
   *
   * @param {string} from  id of the source card
   * @param {string} to    id of the target card
   * @param {string} [label]
   * @param {string|null} [id]  an explicit id; `null` allocates a free one
   * @throws {Error} when the id is empty or already used
   */
  function addLink(from, to, label = "", id = null) {
    requireCard(from);
    requireCard(to);
    const link = {
      id: id === null || id === undefined ? freeLinkId() : String(id),
      from,
      to,
    };
    if (link.id === "") {
      throw new Error("addLink: link id must not be empty");
    }
    if (usedLinkIds().has(link.id)) {
      throw new Error(`addLink: link id ${JSON.stringify(link.id)} is already used`);
    }
    if (label !== "") {
      link.label = label;
    }
    document.links.push(link);
    changed();
    return link;
  }

  function linkCards(from, to, label = "") {
    requireCard(from);
    requireCard(to);
    const existing = document.links.find((link) => link.from === from && link.to === to);
    if (existing) {
      if (label !== "" && existing.label !== label) {
        existing.label = label;
        changed();
      }
      return existing;
    }
    return addLink(from, to, label);
  }

  /**
   * Remove exactly one link.
   *
   * Ids are unique, so removing by index is the honest operation: the `filter`
   * this replaces removed *every* link that shared the id, which turned one
   * `unlink` into several the moment a duplicate existed.
   */
  function unlink(linkId) {
    const at = document.links.findIndex((link) => link.id === linkId);
    if (at < 0) {
      return false;
    }
    document.links.splice(at, 1);
    changed();
    return true;
  }

  function setViewport(v) {
    document.viewport = clampViewport({ ...document.viewport, ...(isPlainObject(v) ? v : {}) });
    changed();
    return document.viewport;
  }

  /** Patch a card's arbitrary fields (e.g. an editor's `file`). */
  function setCardFields(id, fields) {
    const card = requireCard(id);
    for (const key of Object.keys(fields)) {
      if (key === "id" || key === "kind") {
        continue;
      }
      card[key] = cloneDocument(fields[key]);
    }
    changed();
    return card;
  }

  function setSelection(id) {
    if (id === null || id === undefined) {
      applySelection([], null);
      return true;
    }
    if (!findCard(id)) {
      return false;
    }
    applySelection([id], id);
    return true;
  }

  function isSelected(id) {
    return selection.includes(id);
  }

  /**
   * Replace the selection with `ids`, dropping ids that name no card and
   * keeping document order.  `primary` names the card the HUD should describe;
   * it defaults to the last one, which is the one a person just touched, and
   * falls back when the caller names something that did not survive the filter.
   *
   * @returns {boolean} whether the selection actually moved
   */
  function applySelection(ids, primary = null) {
    const order = new Map();
    document.cards.forEach((card, at) => order.set(card.id, at));
    const seen = new Set();
    const next = [];
    for (const id of Array.isArray(ids) ? ids : []) {
      if (typeof id === "string" && order.has(id) && !seen.has(id)) {
        seen.add(id);
        next.push(id);
      }
    }
    next.sort((a, b) => order.get(a) - order.get(b));
    const nextPrimary = primary !== null && seen.has(primary)
      ? primary
      : (next.length === 0 ? null : next[next.length - 1]);
    const same = next.length === selection.length
      && next.every((id, at) => selection[at] === id)
      && nextPrimary === primaryId;
    selection = next;
    primaryId = nextPrimary;
    if (!same) {
      changed();
    }
    return !same;
  }

  /** Forget ids that are no longer on the board (after a load or a removal). */
  function pruneSelection() {
    const live = new Set(document.cards.map((card) => card.id));
    const kept = selection.filter((id) => live.has(id));
    if (kept.length === selection.length && (primaryId === null || live.has(primaryId))) {
      return false;
    }
    selection = kept;
    if (primaryId === null || !live.has(primaryId)) {
      primaryId = kept.length === 0 ? null : kept[kept.length - 1];
    }
    return true;
  }

  function clearSelection() {
    applySelection([], null);
    return true;
  }

  /** Add a card to the selection (ctrl/shift-click), or take it out again. */
  function toggleSelection(id) {
    if (!findCard(id)) {
      return false;
    }
    if (selection.includes(id)) {
      // Removing the primary promotes another card rather than leaving the HUD
      // pointing at something that is no longer selected.
      applySelection(selection.filter((other) => other !== id), null);
    } else {
      applySelection([...selection, id], id);
    }
    return true;
  }

  /** Add a card to the selection, keeping what is already there. */
  function addSelection(id) {
    if (!findCard(id)) {
      return false;
    }
    applySelection([...selection, id], id);
    return true;
  }

  /** Select every card (Ctrl+A). @returns {number} how many are selected now */
  function selectAll() {
    applySelection(document.cards.map((card) => card.id), null);
    return selection.length;
  }

  /** Select the cards a rubber band touches. @returns {string[]} the selection */
  function selectWithin(rect) {
    applySelection(cardsWithin(document.cards, rect), null);
    return selection.slice();
  }

  /**
   * Move several cards in one step.
   *
   * The whole list is applied before anything is notified, so a group drag is
   * one change and one render rather than one per card.  Absolute positions are
   * taken, not deltas: a drag that loses an event must not accumulate drift.
   *
   * @param {Array<{id: string, x?: number, y?: number}>} moves
   * @returns {number} how many cards moved
   */
  function moveCards(moves) {
    const list = Array.isArray(moves) ? moves : [];
    let moved = 0;
    for (const move of list) {
      if (!isPlainObject(move)) {
        continue;
      }
      const card = findCard(move.id);
      if (card === null) {
        continue;
      }
      if (isFiniteNumber(move.x)) {
        card.x = move.x;
      }
      if (isFiniteNumber(move.y)) {
        card.y = move.y;
      }
      moved += 1;
    }
    if (moved > 0) {
      changed();
    }
    return moved;
  }

  /**
   * Remove several cards, and every link that named one of them.
   *
   * The kernel refuses a link with a missing endpoint (`1004 INVALID_BOARD`), so
   * an edge to a dead card is dropped with it -- one change for the whole
   * removal, so undoing a group delete brings the cards *and* their edges back
   * together.
   *
   * @returns {string[]} the ids that were actually on the board
   */
  function removeCards(ids) {
    const wanted = new Set(Array.isArray(ids) ? ids : [ids]);
    const dead = new Set();
    const kept = [];
    for (const card of document.cards) {
      if (wanted.has(card.id)) {
        dead.add(card.id);
      } else {
        kept.push(card);
      }
    }
    if (dead.size === 0) {
      return [];
    }
    document.cards = kept;
    document.links = document.links.filter((link) => !dead.has(link.from) && !dead.has(link.to));
    pruneSelection();
    changed();
    return [...dead];
  }

  /**
   * Plain JSON, ready for `board.save`. Always a copy: no aliasing into the model.
   *
   * Nothing is dropped silently.  A document the kernel would refuse is
   * reported as an error that names the offending entry, instead of being
   * quietly trimmed: a trimmed save reports success while work is missing from
   * disk, which is the one outcome a board-first editor must never produce.
   * Callers that hold a document straight off disk have already had it repaired
   * by `normaliseDocument`, so anything refused here is a bug in the model.
   *
   * @throws {Error} on an invalid or duplicated card, on a link that names a
   *   card which is not in the document, or on a duplicated link id
   */
  function serialize() {
    const out = cloneDocument(document);
    out.version = isFiniteNumber(out.version) ? out.version : BOARD_VERSION;
    out.viewport = clampViewport(out.viewport);

    const ids = new Set();
    out.cards = out.cards.map((card, at) => {
      if (!isValidCard(card)) {
        throw new Error(`serialize: cards[${at}] is not a valid card`
          + " -- the kernel needs a non-empty string id, a string kind and numeric x/y/w/h;"
          + " it was kept in the model rather than dropped from the document");
      }
      if (ids.has(card.id)) {
        throw new Error(`serialize: cards[${at}] repeats card id ${JSON.stringify(card.id)}`
          + " -- the kernel refuses a document with duplicate card ids");
      }
      ids.add(card.id);
      const clean = cloneDocument(card);
      clean.z = isFiniteNumber(clean.z) ? clean.z : 0;
      return clean;
    });

    const linkIds = new Set();
    out.links = out.links.map((link, at) => {
      if (!isPlainObject(link)) {
        throw new Error(`serialize: links[${at}] is not an object`);
      }
      if (typeof link.from !== "string" || typeof link.to !== "string"
        || !ids.has(link.from) || !ids.has(link.to)) {
        throw new Error(`serialize: links[${at}] (${JSON.stringify(link.from)} →`
          + ` ${JSON.stringify(link.to)}) names a card that is not in the document`);
      }
      const clean = cloneDocument(link);
      if (typeof clean.id === "string" && clean.id !== "") {
        if (linkIds.has(clean.id)) {
          throw new Error(`serialize: links[${at}] repeats link id ${JSON.stringify(clean.id)}`
            + " -- the kernel refuses a document with duplicate link ids");
        }
        linkIds.add(clean.id);
      }
      return clean;
    });
    return out;
  }

  function subscribe(listener) {
    listeners.add(listener);
    return () => listeners.delete(listener);
  }

  const board = {
    // reads
    get document() {
      return document;
    },
    get cards() {
      return document.cards;
    },
    get links() {
      return document.links;
    },
    get viewport() {
      return document.viewport;
    },
    get selectedId() {
      return primaryId;
    },
    /** Every selected id, in document order (a copy). */
    get selection() {
      return selection.slice();
    },
    get selectionCount() {
      return selection.length;
    },
    get sequence() {
      return sequence;
    },
    findCard,
    // writes
    load,
    addCard,
    removeCard,
    moveCard,
    resizeCard,
    raiseCard,
    linkCards,
    addLink,
    unlink,
    setViewport,
    setCardFields,
    setSelection,
    // selection (a set, with `selectedId` as its primary member)
    applySelection,
    clearSelection,
    toggleSelection,
    addSelection,
    selectAll,
    selectWithin,
    isSelected,
    // group writes
    moveCards,
    removeCards,
    serialize,
    subscribe,
  };

  return board;
}
