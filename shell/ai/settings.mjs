/**
 * settings.mjs -- the shell's own preferences file.
 *
 * `ai-provider.json` (see config.mjs) holds the agent's provider settings.
 * This module holds the second file the shell owns under the same userData
 * directory: `preferences.json`, the plain editor preferences a settings card
 * is allowed to change.
 *
 *     {
 *       "version": 1,
 *       "bootView": "mod",
 *       "watchPollMs": 1500,
 *       "locale": "",
 *       "recentPackages": [],
 *       "onboarded": false
 *     }
 *
 * The file is deliberately small and boring: a few enums, one bounded integer,
 * a bounded list of recent package paths, one boolean, and a version number
 * that is written by the store rather than by the caller.
 * Anything unknown is reported as a warning, so a newer build that adds a key
 * degrades to "that key is ignored" instead of refusing to save, and anything
 * of the wrong type is an error, so a typo cannot quietly become a default.
 *
 * The write path has the same shape as config.mjs: validate first, write a
 * temp file in the destination directory with mode 0o600, then rename over the
 * real file.  A reader never sees a half-written preferences file.
 *
 * A third file, `settings.json`, belongs to the Electron side of the app; this
 * module knows its path so `config.get` can report it, but it never writes it.
 * Nothing here logs, and nothing here holds a secret.
 *
 * Node 18+; no dependencies beyond `node:fs` / `node:path`.
 */

import {
  chmodSync,
  mkdirSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeFileSync
} from "node:fs";
import path from "node:path";

export const PREFERENCES_FILE = "preferences.json";
export const PREFERENCES_VERSION = 1;

/** The preferences a fresh install has, and the fallbacks for a broken file. */
export const DEFAULT_PREFERENCES = Object.freeze({
  version: PREFERENCES_VERSION,
  bootView: "mod",
  watchPollMs: 1500,
  // Empty means "follow the system language": the window turns it into "en" or
  // "zh" at boot, while an explicit value is what the settings picker writes.
  locale: "",
  recentPackages: Object.freeze([]),
  onboarded: false
});

const BOOT_VIEWS = Object.freeze(["classic", "mod"]);
const UI_LOCALES = Object.freeze(["en", "zh"]);
const RECENT_PACKAGES_MAX = 8;
const WATCH_POLL_MIN = 250;
const WATCH_POLL_MAX = 60000;

/** One or more preferences failed validation (or the file could not be read/written). */
export class SettingsError extends Error {
  /**
   * @param {string} message
   * @param {{key: string, message: string}[]} [errors]
   */
  constructor(message, errors = []) {
    super(message);
    this.name = "SettingsError";
    this.errors = Array.isArray(errors) ? errors : [];
  }

  toJSON() {
    return { name: this.name, message: this.message, errors: this.errors };
  }
}

/* ------------------------------------------------------------------ */
/* validation                                                          */
/* ------------------------------------------------------------------ */

/**
 * Merge an untrusted object onto the default preferences.
 *
 * - missing keys keep their default;
 * - a key of the wrong type keeps its default and is reported in `errors`;
 * - unknown keys are dropped and reported in `warnings`;
 * - `version` is accepted only as the constant this build writes.
 *
 * @param {unknown} raw
 * @returns {{
 *   preferences: object,
 *   errors: {key: string, message: string}[],
 *   warnings: {key: string, message: string}[]
 * }}
 */
export function normalizePreferences(raw) {
  const errors = [];
  const warnings = [];
  const preferences = { ...DEFAULT_PREFERENCES };

  if (raw === undefined || raw === null) {
    return { preferences, errors, warnings };
  }
  if (typeof raw !== "object" || Array.isArray(raw)) {
    errors.push({ key: "", message: "preferences must be a JSON object" });
    return { preferences, errors, warnings };
  }

  for (const key of Object.keys(raw)) {
    const value = raw[key];
    if (key === "version") {
      if (!Number.isInteger(value) || value !== PREFERENCES_VERSION) {
        errors.push({ key, message: "version must be " + PREFERENCES_VERSION });
      }
      continue;
    }
    if (key === "bootView") {
      if (typeof value !== "string" || !BOOT_VIEWS.includes(value)) {
        errors.push({ key, message: "bootView must be \"classic\" or \"mod\"" });
        continue;
      }
      preferences.bootView = value;
      continue;
    }
    if (key === "watchPollMs") {
      if (!Number.isInteger(value)) {
        errors.push({ key, message: "watchPollMs must be an integer" });
        continue;
      }
      if (value < WATCH_POLL_MIN || value > WATCH_POLL_MAX) {
        errors.push({
          key,
          message: "watchPollMs must be between " + WATCH_POLL_MIN + " and " + WATCH_POLL_MAX
        });
        continue;
      }
      preferences.watchPollMs = value;
      continue;
    }
    if (key === "locale") {
      if (typeof value !== "string" || (value !== "" && !UI_LOCALES.includes(value))) {
        errors.push({ key, message: "locale must be empty, \"en\" or \"zh\"" });
        continue;
      }
      preferences.locale = value;
      continue;
    }
    if (key === "recentPackages") {
      if (!Array.isArray(value)) {
        errors.push({ key, message: "recentPackages must be an array of paths" });
        continue;
      }
      if (value.length > RECENT_PACKAGES_MAX) {
        errors.push({ key, message: "recentPackages holds at most " + RECENT_PACKAGES_MAX + " paths" });
        continue;
      }
      const paths = [];
      let bad = false;
      for (const entry of value) {
        if (typeof entry !== "string" || entry.trim() === "") {
          bad = true;
          break;
        }
        if (!paths.includes(entry)) paths.push(entry);
      }
      if (bad) {
        errors.push({ key, message: "recentPackages entries must be non-empty strings" });
        continue;
      }
      preferences.recentPackages = paths;
      continue;
    }
    if (key === "onboarded") {
      if (typeof value !== "boolean") {
        errors.push({ key, message: "onboarded must be a boolean" });
        continue;
      }
      preferences.onboarded = value;
      continue;
    }
    warnings.push({ key, message: "unknown preference ignored: " + key });
  }

  return { preferences, errors, warnings };
}

/* ------------------------------------------------------------------ */
/* the store                                                           */
/* ------------------------------------------------------------------ */

/**
 * A preferences store rooted at a directory.
 *
 * @param {{dir: string, filename?: string}} options
 *   `dir` must be absolute; it is Electron's userData directory.
 * @returns {{
 *   dir: string,
 *   file: string,
 *   read: () => {preferences: object, exists: boolean, warnings: object[], errors: object[], error: string|null},
 *   load: () => object,
 *   write: (patch?: object) => object,
 *   clear: () => void
 * }}
 */
export function createPreferenceStore(options = {}) {
  const dir = options.dir;
  if (typeof dir !== "string" || dir.trim() === "" || !path.isAbsolute(dir)) {
    throw new SettingsError("settings: dir must be an absolute directory path (Electron userData)");
  }
  const baseDir = path.resolve(dir);
  const filename = options.filename === undefined ? PREFERENCES_FILE : String(options.filename);
  if (filename !== path.basename(filename) || filename === "." || filename === "..") {
    throw new SettingsError("settings: filename must be a bare file name");
  }
  const file = path.join(baseDir, filename);

  function read() {
    const result = {
      preferences: { ...DEFAULT_PREFERENCES },
      exists: false,
      warnings: [],
      errors: [],
      error: null
    };
    let text;
    try {
      text = readFileSync(file, "utf8");
    } catch (error) {
      if (error && error.code === "ENOENT") {
        return result;
      }
      result.error = "settings: could not read " + filename + " (" + errorCode(error) + ")";
      return result;
    }
    result.exists = true;
    let raw;
    try {
      raw = JSON.parse(text);
    } catch {
      // Deliberately does not include the file text: it is the user's file and
      // a malformed one is not a reason to print its contents into a log.
      const note = "settings: " + filename + " is not valid JSON; defaults are in use";
      result.error = note;
      result.warnings = [{ key: "", message: note }];
      return result;
    }
    const normalized = normalizePreferences(raw);
    result.preferences = normalized.preferences;
    result.warnings = normalized.warnings;
    result.errors = normalized.errors;
    if (normalized.errors.length > 0) {
      result.error = "settings: " + filename + " has invalid values; defaults are in use";
    }
    return result;
  }

  /** @returns {object} the effective preferences (defaults for bad/missing fields) */
  function load() {
    return { ...read().preferences };
  }

  /**
   * Merge `patch` onto the stored preferences and write them atomically.
   * Throws SettingsError when the result would be invalid; nothing is written.
   * @param {object} [patch]
   * @returns {object} what was written, plus the file path and any warnings
   */
  function write(patch) {
    const current = read();
    if (patch !== undefined && (patch === null || typeof patch !== "object" || Array.isArray(patch))) {
      throw new SettingsError("settings: patch must be a plain object");
    }
    const merged = { ...current.preferences };
    if (patch !== undefined) {
      for (const key of Object.keys(patch)) {
        if (key === "version") {
          throw new SettingsError("settings: version is not settable", [
            { key, message: "version is written automatically" }
          ]);
        }
        merged[key] = patch[key];
      }
    }
    const normalized = normalizePreferences(merged);
    if (normalized.errors.length > 0) {
      throw new SettingsError("settings: refusing to write invalid preferences", normalized.errors);
    }

    mkdirSync(baseDir, { recursive: true, mode: 0o700 });
    const body = JSON.stringify({ version: PREFERENCES_VERSION, ...normalized.preferences }, null, 2) + "\n";
    const temp = path.join(
      baseDir,
      "." + filename + "." + process.pid + "." + Date.now().toString(36) + ".tmp"
    );
    try {
      writeFileSync(temp, body, { encoding: "utf8", mode: 0o600 });
      try {
        chmodSync(temp, 0o600);
      } catch {
        // Windows has no POSIX mode; the userData ACL is the protection there.
      }
      renameSync(temp, file);
    } catch (error) {
      try {
        unlinkSync(temp);
      } catch {
        // best effort
      }
      throw new SettingsError("settings: could not write " + filename + " (" + errorCode(error) + ")");
    }
    return { ...normalized.preferences, file, warnings: normalized.warnings };
  }

  function clear() {
    try {
      unlinkSync(file);
    } catch (error) {
      if (error && error.code === "ENOENT") {
        return;
      }
      throw new SettingsError("settings: could not remove " + filename + " (" + errorCode(error) + ")");
    }
  }

  return { dir: baseDir, file, read, load, write, clear };
}

/** @param {unknown} error */
function errorCode(error) {
  if (error && typeof error === "object" && typeof error.code === "string") {
    return error.code;
  }
  return "unknown error";
}
