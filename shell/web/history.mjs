/**
 * history.mjs -- undo and redo for the board document.
 *
 * The board is the project state, so "undo" has to mean the board, not one
 * textarea: deleting a card, moving one, adding a link and clearing a sheet cell
 * are all edits to one document.  `board.serialize()` already returns a deep
 * copy and the model never aliases it (`docs/FORK.md` says the snapshot ring is
 * a shell-only change), so this module is a ring of documents plus a cursor.
 *
 * Three rules keep it honest:
 *
 * - **Only the document counts.**  `record()` stores what `serialize()` returns;
 *   a caller that mutates the board afterwards cannot change history, because
 *   the snapshot is a copy.
 * - **Only real edits count.**  `describeChange()` returns `null` when two
 *   documents differ in nothing but the viewport.  Panning and zooming are
 *   navigation -- Ctrl+Z must not spend a step putting the camera back.
 * - **A typing burst is one step.**  `record()` folds an edit into the step it
 *   just pushed when the same description arrives again inside `coalesceMs`,
 *   so `Ctrl+Z` after a sentence takes back the sentence, not the last letter.
 *
 * What it deliberately does not do: survive an external reload (the caller
 * resets it -- undoing across another writer's board would resurrect their
 * deleted cards), or undo the *text* inside an editor card, which is not in the
 * document at all: that textarea keeps the browser's own undo.
 */

const DEFAULT_LIMIT = 200;
const DEFAULT_COALESCE_MS = 700;

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

function sameValue(a, b) {
  return JSON.stringify(a) === JSON.stringify(b);
}

function cardsById(document) {
  const map = new Map();
  const cards = document && Array.isArray(document.cards) ? document.cards : [];
  for (const card of cards) {
    map.set(card.id, card);
  }
  return map;
}

function linksById(document) {
  const map = new Map();
  const links = document && Array.isArray(document.links) ? document.links : [];
  for (const link of links) {
    if (typeof link.id === "string") {
      map.set(link.id, link);
    }
  }
  return map;
}

function named(ids) {
  const list = [...ids].sort();
  if (list.length === 1) {
    return ` ${list[0]}`;
  }
  if (list.length === 2) {
    return ` ${list[0]} and ${list[1]}`;
  }
  return ` ${list.length} cards`;
}

/** Geometry lives in four fields; everything else in a card is its content. */
function geometryOf(card) {
  return [card.x, card.y, card.w, card.h];
}

function sameGeometry(a, b) {
  return sameValue(geometryOf(a), geometryOf(b));
}

function sameContent(a, b) {
  const keys = new Set([...Object.keys(a), ...Object.keys(b)]);
  for (const key of ["x", "y", "w", "h", "z"]) {
    keys.delete(key);
  }
  for (const key of keys) {
    if (!sameValue(a[key], b[key])) {
      return false;
    }
  }
  return true;
}

/**
 * One short phrase for the step from `before` to `after`, or `null` when the
 * step is not an edit (identical documents, or a viewport-only move).
 */
export function describeChange(before, after) {
  if (before === null || before === undefined) {
    return "changed the board";
  }
  if (sameValue(before, after)) {
    return null;
  }
  const wasCards = cardsById(before);
  const nowCards = cardsById(after);
  const parts = [];

  const added = [...nowCards.keys()].filter((id) => !wasCards.has(id));
  const removed = [...wasCards.keys()].filter((id) => !nowCards.has(id));
  const edited = [];
  const moved = [];
  const resized = [];
  for (const [id, card] of nowCards) {
    const was = wasCards.get(id);
    if (was === undefined) {
      continue;
    }
    if (!sameContent(was, card)) {
      edited.push(id);
    } else if (!sameGeometry(was, card)) {
      // A card can move and resize in one gesture; one word is enough, and
      // "moved" is the one a drag should read as.
      if (sameValue([was.x, was.y], [card.x, card.y])) {
        resized.push(id);
      } else {
        moved.push(id);
      }
    }
  }

  const wasLinks = linksById(before);
  const nowLinks = linksById(after);
  const addedLinks = [...nowLinks.values()].filter((link) => !wasLinks.has(link.id));
  const removedLinks = [...wasLinks.keys()].filter((id) => !nowLinks.has(id));

  if (added.length > 0) {
    parts.push(`added a card${named(added)}`);
  }
  if (removed.length > 0) {
    parts.push(`removed a card${named(removed)}`);
  }
  if (edited.length > 0) {
    const kinds = edited.map((id) => (nowCards.get(id) || {}).kind || "card");
    const one = edited.length === 1 && kinds[0] !== "card";
    parts.push(one ? `edited the ${kinds[0]} card ${edited[0]}` : `edited a card${named(edited)}`);
  }
  if (moved.length > 0) {
    parts.push(`moved a card${named(moved)}`);
  }
  if (resized.length > 0) {
    parts.push(`resized a card${named(resized)}`);
  }
  if (addedLinks.length > 0) {
    const one = addedLinks.length === 1;
    parts.push(
      one
        ? `linked ${addedLinks[0].from} to ${addedLinks[0].to}`
        : `added ${addedLinks.length} links`,
    );
  }
  if (removedLinks.length > 0) {
    parts.push(
      removedLinks.length === 1
        ? `unlinked ${removedLinks[0]}`
        : `removed ${removedLinks.length} links`,
    );
  }

  if (parts.length === 0) {
    // The viewport is the only difference, or something changed that this
    // function does not model.  Either way there is no edit to undo.
    return null;
  }
  if (parts.length > 2) {
    return `${parts[0]}, ${parts[1]} and more`;
  }
  return parts.join(" and ");
}

/**
 * A ring of board snapshots with a cursor.  `entries[position]` is the state on
 * screen; `undo()` walks the cursor back, `redo()` walks it forward, and a new
 * edit after an undo throws the redo branch away (as every editor does).
 */
export function createHistory(options = {}) {
  const limit = Number.isInteger(options.limit) && options.limit > 0 ? options.limit : DEFAULT_LIMIT;
  const coalesceMs =
    Number.isInteger(options.coalesceMs) && options.coalesceMs >= 0
      ? options.coalesceMs
      : DEFAULT_COALESCE_MS;
  const now = typeof options.now === "function" ? options.now : () => Date.now();

  let entries = [];
  let notes = [];
  let position = -1;
  let lastKey = null;
  let lastAt = 0;

  function current() {
    return position >= 0 ? entries[position] : null;
  }

  /** Start again from a document that is not the result of an edit in flight. */
  function reset(document, resetOptions = {}) {
    entries = [clone(document)];
    notes = [resetOptions.label || "the board as loaded"];
    position = 0;
    lastKey = null;
    lastAt = 0;
    return clone(entries[0]);
  }

  /**
   * Remember `document` as the state after an edit.  Returns true when a new
   * step was pushed, false when the document did not change, when the change is
   * only the viewport, or when it folded into the step it just pushed.
   */
  function record(document, recordOptions = {}) {
    const before = current();
    if (before === null) {
      reset(document, recordOptions);
      return true;
    }
    if (sameValue(before, document)) {
      return false;
    }
    const label = recordOptions.label || describeChange(before, document);
    if (label === null) {
      return false;
    }
    const at = now();
    const atTop = position === entries.length - 1;
    if (atTop && position > 0 && label === lastKey && at - lastAt <= coalesceMs) {
      // Same edit, still going: keep the step that is already there and let it
      // describe the newest state.
      entries[position] = clone(document);
      notes[position] = label;
      lastAt = at;
      return false;
    }
    entries.length = position + 1;
    notes.length = position + 1;
    entries.push(clone(document));
    notes.push(label);
    if (entries.length > limit) {
      const drop = entries.length - limit;
      entries.splice(0, drop);
      notes.splice(0, drop);
    }
    position = entries.length - 1;
    lastKey = label;
    lastAt = at;
    return true;
  }

  function undo() {
    if (position <= 0) {
      return null;
    }
    const from = position;
    position -= 1;
    lastKey = null;
    lastAt = 0;
    return { document: clone(entries[position]), label: notes[from] };
  }

  function redo() {
    if (position < 0 || position >= entries.length - 1) {
      return null;
    }
    position += 1;
    lastKey = null;
    lastAt = 0;
    return { document: clone(entries[position]), label: notes[position] };
  }

  return {
    reset,
    record,
    undo,
    redo,
    canUndo: () => position > 0,
    canRedo: () => position >= 0 && position < entries.length - 1,
    /** The state on screen, as a copy -- for describing the next change. */
    current: () => (current() === null ? null : clone(current())),
    /** What the step under the cursor was, for a status line. */
    label: () => (position >= 0 ? notes[position] : null),
    size: () => entries.length,
    position: () => position,
    clear() {
      entries = [];
      notes = [];
      position = -1;
      lastKey = null;
      lastAt = 0;
    },
  };
}
