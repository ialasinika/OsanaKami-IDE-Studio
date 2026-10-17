/**
 * watch.mjs -- who wins when a file changes under an open card.
 *
 * The kernel announces its own writes (`file.changed`), but nothing announces a
 * write from git, from another editor, or from a build script.  `file.stat` is
 * the one method that can answer "is this still the revision I hold?" without
 * moving the bytes, so the shell asks about every file on the board and this
 * module decides what the answer means.
 *
 * One rule, applied twice: once per path, to tell news from repetition, and once
 * per card, to tell what *that* card deserves.  A clean card adopts the bytes; a
 * card with unsaved edits is told and keeps them -- an editor that silently
 * overwrites typing because a file moved is worse than one that never reloads.
 * A revision that cannot be compared (binary, unreadable, or a card that has not
 * read the file yet) is a warn and never a reload, because "cannot compare" is
 * not "unchanged".
 *
 * This module is pure on purpose: decisions are worth pinning in `selftest.mjs`
 * without a browser, a kernel or a clock.  The polling lives in `main.mjs`.
 */

/** How often the shell asks. A stat moves no bytes; a false negative is worse. */
export const WATCH_POLL_MS = 1500;

/**
 * The interval the settings card may ask for, in milliseconds.
 *
 * Kept beside the default so the window's fallback and the form's number input
 * bounds are the same two numbers.  The shell's preference store validates the
 * same range on its side; a persisted value outside it is a bug in a writer,
 * and the window's answer to a bug is the default, not a faster poll.
 */
export const WATCH_POLL_MIN = 250;
export const WATCH_POLL_MAX = 60000;

export const WATCH_OK = "ok";
export const WATCH_RELOAD = "reload";
export const WATCH_WARN = "warn";
export const WATCH_GONE = "gone";
export const WATCH_UNKNOWN = "unknown";

/** A usable revision is a finite number; the kernel uses 0 for "cannot say". */
function revisionOf(value) {
  return Number.isFinite(value) ? value : null;
}

/**
 * What should happen to a card holding `known.revision`?
 *
 * @param {{revision?: number|null, dirty?: boolean}} known  what the card holds
 * @param {{exists?: boolean, dir?: boolean, revision?: number, error?: Error}|null} stat
 *   the answer from `file.stat`, or `null`/an error object when there was none
 * @returns {string} one of `WATCH_OK`, `WATCH_RELOAD`, `WATCH_WARN`,
 *   `WATCH_GONE`, `WATCH_UNKNOWN`
 */
export function watchDecision(known, stat) {
  const held = known === null || known === undefined ? null : revisionOf(known.revision);
  if (held === null) {
    // The card has not read the file yet (or is reading it now). Its buffer is
    // not a version of anything, so there is nothing to compare and nothing to
    // say: the next poll will know.
    return WATCH_UNKNOWN;
  }
  if (stat === null || stat === undefined || stat.error !== undefined) {
    // A transport failure is not a change. Saying "changed on disk" because the
    // kernel blinked would be a lie the user cannot tell from the real thing.
    return WATCH_UNKNOWN;
  }
  if (stat.exists !== true || stat.dir === true) {
    return WATCH_GONE;
  }
  const onDisk = revisionOf(stat.revision);
  if (onDisk === null || onDisk === 0 || held === 0) {
    // The kernel has no revision to give (binary, or too large to read), so
    // neither side can be compared. Warn: never reload over an unknown.
    return WATCH_WARN;
  }
  if (onDisk === held) {
    return WATCH_OK;
  }
  return known.dirty === true ? WATCH_WARN : WATCH_RELOAD;
}

/**
 * Did the kernel refuse to answer because it does not have the method?
 *
 * A fork that trims `file.stat` is not broken -- it is smaller, and the board
 * keeps working exactly as it did before this poll existed.  The shell has to
 * be able to tell that apart from a transport failure, which is worth a warning
 * but not worth shutting the watch down.
 *
 * @param {Array<{error?: {code?: number|string}}|null>} responses  one per path
 * @returns {boolean} true when at least one answer was `METHOD_NOT_FOUND`
 */
export function watchTrimmed(responses) {
  return responses.some((stat) => stat !== null && stat !== undefined
    && stat.error !== undefined && stat.error.code === -32601);
}

/**
 * A whole poll's worth of decisions, minus the repetitions.
 *
 * @param {Array<{path: string, known: object, stat: object|null}>} pairs
 *   one entry per watched path -- a path held by three cards is one pair
 * @param {Map<string, string>} previous  the signatures from the last poll
 * @returns {{next: Map<string, string>, actions: Array<{path: string, decision: string, revision: number|null, stat: object|null}>}}
 *   `next` replaces `previous` (paths that are no longer open simply drop out,
 *   which is what keeps a long session from growing this map forever), and
 *   `actions` holds only decisions that are both news and actionable.
 */
export function watchReport(pairs, previous) {
  const before = previous instanceof Map ? previous : new Map();
  const next = new Map();
  const actions = [];
  for (const pair of pairs) {
    const decision = watchDecision(pair.known, pair.stat);
    const revision = pair.stat === null || pair.stat === undefined ? null : revisionOf(pair.stat.revision);
    const signature = `${decision}:${revision === null ? "-" : revision}`;
    const isNews = before.get(pair.path) !== signature;
    next.set(pair.path, signature);
    if (!isNews) {
      // Already said. A poll runs every second and a half; a card that warns on
      // every tick is not reporting anything, it is noise.
      continue;
    }
    if (decision === WATCH_RELOAD || decision === WATCH_WARN || decision === WATCH_GONE) {
      actions.push({ path: pair.path, decision, revision, stat: pair.stat });
    }
  }
  return { next, actions };
}
