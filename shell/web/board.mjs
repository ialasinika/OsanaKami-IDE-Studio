/**
 * board.mjs -- the board document and the operations the canvas performs.
 *
 * DELETE THIS FILE and OsanaKami IDE Studio stops being OsanaKami IDE Studio: it holds the only definition of
 * what a board *is* (cards, links, viewport), where it lives in the workspace,
 * and the only place the layout is assembled before `view.save`.  Without it
 * there is nothing to render.
 *
 * It is deliberately UI-free: no `document`, no `window`, no timer.  The same
 * object is used by the browser and by `selftest.mjs` under Node, which is the
 * point -- the spatial model can be tested without a canvas.
 *
 * This file owns the schema.  The kernel used to: `core/src/board.c` knew about
 * cards, geometry and ids, and answered a malformed document with
 * `1004 INVALID_BOARD`.  It no longer knows any of that.  A view document is
 * opaque to the kernel -- it persists whatever JSON it is handed, at the path
 * its client names (`view.load` / `view.save`) -- and the meaning of the fields
 * is decided here.  So the two rules below are this file's rules now, enforced
 * by `serialize()` before anything is sent:
 *
 *   - a card is an object with a non-empty unique string `id`, a non-empty
 *     string `kind`, and numeric `x`/`y`/`w`/`h`;
 *   - a link's `from`/`to` must name a card that exists, and its `id` (when it
 *     has one) must not repeat another link's.
 *
 * Anything else a card carries (`file`, `cmd`, `text`, and any extra field a
 * fork invents) is stored verbatim, because the kernel stores it verbatim.
 */

/** The four card kinds. Fixed: there is no extension mechanism by design. */
/**
 * The kinds `cards.mjs` ships renderers for.  Advisory only: this file stores
 * and clones any `kind` string, because this file validates a card's *shape*
 * (id, kind, geometry) and deliberately not its vocabulary.  The authoritative
 * list at runtime is `knownCardKinds()` in cards.mjs, which is what the
 * built-in renderers register themselves into.
 */
export const CARD_KINDS = [
  "editor", "runner", "note", "files", "project", "sheet", "story", "pixel",
  "rig", "mod", "problems", "docs", "settings", "help", "audio", "agent", "start",
];

export const BOARD_VERSION = 1;

/**
 * Where this document lives, relative to the workspace root.
 *
 * The kernel used to decide this (`SDE_BOARD_RELPATH` in `core/src/board.h`);
 * now the client names the path on every `view.load`/`view.save`.  A fork can
 * point it somewhere else, or keep a second document beside it, without the
 * kernel knowing or caring.
 */
export const BOARD_PATH = ".infantgod/board.json";

/** Default size per kind, used by `addCard`. */
export const DEFAULT_SIZE = {
  editor: { w: 640, h: 420 },
  runner: { w: 520, h: 260 },
  note: { w: 300, h: 180 },
  files: { w: 300, h: 520 },
  sheet: { w: 460, h: 320 },
  story: { w: 600, h: 480 },
  pixel: { w: 560, h: 500 },
  rig: { w: 660, h: 560 },
  project: { w: 340, h: 580 },
  mod: { w: 420, h: 520 },
  problems: { w: 520, h: 420 },
  docs: { w: 460, h: 520 },
  settings: { w: 540, h: 520 },
  help: { w: 560, h: 560 },
  agent: { w: 560, h: 520 },
  audio: { w: 380, h: 200 },
  start: { w: 520, h: 400 },
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

/** True for a card this document format accepts. Geometry may be repaired later. */
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
  // A board written while this card was still called `spine` says so in
  // `kind`; `spine` names the format, the card is a rig.  Map it rather than
  // drop it: a card the user can see must not vanish on load.
  cleaned.kind = card.kind === "spine" ? "rig" : card.kind;
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
 * Cards this format cannot read are dropped (with a report, so the caller can
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
   * and `serialize()` then refuses to write it back (`links[N]: duplicate
   * \`id\``), so a board that loaded fine would become unsaveable.  The edge is
   * kept and given a fresh id instead: losing a connection the user can see is
   * the worse repair.
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
  let selectedId = null;
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
    // Ids are the client's business now: the kernel used to hand them out
    // (`board.newId`) and no longer has an opinion.  A caller that wants a
    // different source -- a fork resolving ids against something else -- passes
    // `idFactory`; otherwise the local counter keeps the board standalone.
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

  /** Replace the whole document (e.g. from `view.load` or a save reply). */
  function load(next) {
    const result = normaliseDocument(next);
    document = result.document;
    if (selectedId !== null && !findCard(selectedId)) {
      selectedId = null;
    }
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
    // card id, so the check is explicitly against `null`/`undefined`.
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

  function removeCard(id) {
    const at = document.cards.findIndex((card) => card.id === id);
    if (at < 0) {
      return false;
    }
    document.cards.splice(at, 1);
    // Links pointing at a dead card would make the next save fail validation.
    document.links = document.links.filter((link) => link.from !== id && link.to !== id);
    if (selectedId === id) {
      selectedId = null;
    }
    changed();
    return true;
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

  /** The first free `lN`. Ids are local: nothing outside this file allocates them. */
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
   * Link ids are unique across the whole board, because `serialize()` refuses a
   * document that repeats one (`links[N]: duplicate \`id\``) -- and because
   * `unlink <id>` names exactly one edge.  Accepting a collision here would let
   * the UI build a document its own writer will not save, so it is an error and
   * not a second link.
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
    const next = id === null || id === undefined ? null : id;
    if (next !== null && !findCard(next)) {
      return false;
    }
    if (next === selectedId) {
      return true;
    }
    selectedId = next;
    changed();
    return true;
  }

  /**
   * Plain JSON, ready for `view.save`. Always a copy: no aliasing into the model.
   *
   * Nothing is dropped silently.  A document this format cannot express is
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
          + " -- a card needs a non-empty string id, a string kind and numeric x/y/w/h;"
          + " it was kept in the model rather than dropped from the document");
      }
      if (ids.has(card.id)) {
        throw new Error(`serialize: cards[${at}] repeats card id ${JSON.stringify(card.id)}`
          + " -- card ids must be unique in the document");
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
            + " -- link ids must be unique in the document");
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
      return selectedId;
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
    serialize,
    subscribe,
  };

  return board;
}
