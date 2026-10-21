/**
 * web/diagnostic-hints.mjs -- what a person can do about a diagnostic (G57).
 *
 * The validator's messages say what is wrong, not what to change.  "D011
 * Sprites/icon.png is missing" is precise and still leaves a beginner asking
 * where the file was supposed to come from.  This table adds one sentence per
 * code, in the interface language, and returns "" for a code it does not know --
 * a stale table must never invent advice for a code it has not seen.
 *
 * The sentences live in `i18n.mjs` under `hint.<code>` so the language switch
 * reaches them like any other string.  Codes are the validator's own: D### for
 * defines and package checks, M### for the manifest, Y### for Yarn, OPEN### for
 * an open that failed.
 */
import { getLocale, hasMessage, t } from "./i18n.mjs";

/** The hint for a diagnostic code, or "" when there is none. */
export function hintFor(code) {
  if (typeof code !== "string" || code === "") {
    return "";
  }
  const key = `hint.${code}`;
  return hasMessage(getLocale(), key) ? t(key) : "";
}

/** Every code that carries a hint, sorted -- used by the suite to prove parity. */
export function hintedCodes(locale) {
  void locale;
  const codes = new Set();
  for (const key of ["D001", "D002", "D004", "D005", "D006", "D007", "D008", "D009", "D010",
    "D011", "D012", "D013", "D014", "D015", "D016", "D017", "D018", "D019", "D020", "D021",
    "D022", "D023", "D101", "D102", "D103", "M001", "M006", "M008", "M009", "M012", "M013",
    "M014", "OPEN001", "Y103", "Y107", "Y110", "Y122", "Y123"]) {
    if (hasMessage(getLocale(), `hint.${key}`)) {
      codes.add(key);
    }
  }
  return [...codes].sort();
}
