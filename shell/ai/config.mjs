/**
 * config.mjs -- the one place a provider's settings are allowed to exist.
 *
 * The agent talks to a chat-completions endpoint that looks like OpenAI's, but
 * the endpoint, the model name and the key belong to the machine's user, not to
 * the repository.  So they live in one JSON file under Electron's userData
 * directory, they are validated here before anything else sees them, and they
 * are described here in a redacted form.  Nothing in this module logs, and
 * nothing in this module returns the key: `describeConfig` answers `***` where
 * the key would be, and `redact` / `redactText` exist so callers can scrub a
 * value before it reaches a log line or an error message.
 *
 * The file is `ai-provider.json`:
 *
 *     {
 *       "version": 1,
 *       "baseUrl": "https://api.deepseek.com/v1",
 *       "model": "deepseek-chat",
 *       "apiKey": "...",
 *       "temperature": 0.7,
 *       "maxTokens": 2048,
 *       "timeoutMs": 60000,
 *       "stream": true
 *     }
 *
 * `baseUrl` is the base, not the full endpoint: `.../v1` becomes
 * `.../v1/chat/completions`.  A pasted full endpoint is accepted and trimmed
 * back, so the two cannot both be stored half-way.
 *
 * What this module deliberately cannot know: which directory is the game
 * directory.  Callers must pass Electron's `app.getPath('userData')`; there is
 * no code path here that takes a path from a model or from the repository.
 *
 * Node 18+; no dependencies beyond `node:fs` / `node:path`.
 */

import {
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  statSync,
  unlinkSync,
  writeFileSync
} from "node:fs";
import path from "node:path";

export const CONFIG_FILE = "ai-provider.json";
export const CONFIG_VERSION = 1;
export const MASK = "***";

/** The settings a provider needs, and the fallbacks when the file is absent. */
export const DEFAULT_CONFIG = Object.freeze({
  baseUrl: "https://api.deepseek.com/v1",
  model: "deepseek-chat",
  apiKey: "",
  temperature: 0.7,
  maxTokens: 2048,
  timeoutMs: 60000,
  stream: true
});

/** Fields whose values must never be printed, described or returned. */
export const SECRET_FIELDS = Object.freeze(["apiKey"]);

const SETTINGS_KEYS = Object.freeze(Object.keys(DEFAULT_CONFIG));

/** One or more settings failed validation (or the file could not be written). */
export class ConfigError extends Error {
  /**
   * @param {string} message
   * @param {{key: string, message: string}[]} [errors]
   */
  constructor(message, errors = []) {
    super(message);
    this.name = "ConfigError";
    this.errors = Array.isArray(errors) ? errors : [];
  }

  toJSON() {
    return { name: this.name, message: this.message, errors: this.errors };
  }
}

/* ------------------------------------------------------------------ */
/* validation                                                          */
/* ------------------------------------------------------------------ */

const CHAT_COMPLETIONS = "/chat/completions";

/**
 * Canonicalize a base URL.  Returns `{value}` or `{error}`.
 * @param {unknown} raw
 * @returns {{value?: string, error?: string}}
 */
export function normalizeBaseUrl(raw) {
  const text = typeof raw === "string" ? raw.trim() : "";
  if (text === "") {
    return { error: "baseUrl must be a non-empty http(s) URL" };
  }
  if (/\s/.test(text)) {
    return { error: "baseUrl must not contain whitespace" };
  }
  let url;
  try {
    url = new URL(text);
  } catch {
    return { error: "baseUrl is not a valid URL" };
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    return { error: "baseUrl must use http: or https:" };
  }
  if (url.username !== "" || url.password !== "") {
    return { error: "baseUrl must not embed credentials; put the key in apiKey" };
  }
  if (url.hash !== "") {
    return { error: "baseUrl must not contain a fragment" };
  }
  let pathname = url.pathname.replace(/\/+$/, "");
  if (pathname.toLowerCase().endsWith(CHAT_COMPLETIONS)) {
    pathname = pathname.slice(0, -CHAT_COMPLETIONS.length);
  }
  return { value: url.origin + pathname + url.search };
}

/**
 * The full endpoint a request is POSTed to.
 * @param {string} baseUrl
 * @returns {string}
 */
export function endpointUrl(baseUrl) {
  const normalized = normalizeBaseUrl(baseUrl);
  const base = normalized.value !== undefined ? normalized.value : DEFAULT_CONFIG.baseUrl;
  return base + CHAT_COMPLETIONS;
}

/** @param {string} key @param {unknown} value @returns {{value?: unknown, error?: string}} */
function normalizeField(key, value) {
  switch (key) {
    case "baseUrl":
      return normalizeBaseUrl(value);
    case "model": {
      if (typeof value !== "string" || value.trim() === "") {
        return { error: "model must be a non-empty string" };
      }
      const model = value.trim();
      if (/[\r\n]/.test(model) || model.length > 200) {
        return { error: "model must be one line, at most 200 characters" };
      }
      return { value: model };
    }
    case "apiKey": {
      if (typeof value !== "string") {
        return { error: "apiKey must be a string (empty means no Authorization header)" };
      }
      const key = value.trim();
      if (/[\r\n]/.test(key) || key.length > 4096) {
        return { error: "apiKey must be one line, at most 4096 characters" };
      }
      return { value: key };
    }
    case "temperature": {
      if (typeof value !== "number" || !Number.isFinite(value)) {
        return { error: "temperature must be a finite number" };
      }
      if (value < 0 || value > 2) {
        return { error: "temperature must be between 0 and 2" };
      }
      return { value };
    }
    case "maxTokens": {
      if (!Number.isInteger(value)) {
        return { error: "maxTokens must be an integer" };
      }
      if (value < 1 || value > 131072) {
        return { error: "maxTokens must be between 1 and 131072" };
      }
      return { value };
    }
    case "timeoutMs": {
      if (!Number.isInteger(value)) {
        return { error: "timeoutMs must be an integer" };
      }
      if (value < 1 || value > 3600000) {
        return { error: "timeoutMs must be between 1 and 3600000" };
      }
      return { value };
    }
    case "stream": {
      if (typeof value !== "boolean") {
        return { error: "stream must be a boolean" };
      }
      return { value };
    }
    default:
      return { error: "unknown setting: " + key };
  }
}

/**
 * Merge an untrusted object onto the defaults.
 *
 * - missing keys keep their default;
 * - a key that fails validation keeps its default and is reported in `errors`;
 * - unknown keys are dropped, reported as `errors` when `strict`, else
 *   as `warnings`.
 *
 * @param {unknown} raw
 * @param {{strict?: boolean}} [options]
 * @returns {{config: object, errors: {key: string, message: string}[], warnings: {key: string, message: string}[]}}
 */
export function normalizeConfig(raw, options = {}) {
  const strict = options.strict === true;
  const errors = [];
  const warnings = [];
  const config = { ...DEFAULT_CONFIG };

  if (raw === undefined || raw === null) {
    return { config, errors, warnings };
  }
  if (typeof raw !== "object" || Array.isArray(raw)) {
    errors.push({ key: "", message: "config must be a JSON object" });
    return { config, errors, warnings };
  }

  for (const key of Object.keys(raw)) {
    if (key === "version") {
      if (!Number.isInteger(raw[key])) {
        errors.push({ key, message: "version must be an integer" });
      }
      continue;
    }
    if (!SETTINGS_KEYS.includes(key)) {
      const note = { key, message: "unknown setting ignored: " + key };
      (strict ? errors : warnings).push(note);
      continue;
    }
    let result;
    try {
      result = normalizeField(key, raw[key]);
    } catch {
      result = { error: "could not validate " + key };
    }
    if (result.error !== undefined) {
      errors.push({ key, message: result.error });
      continue;
    }
    config[key] = result.value;
  }

  return { config, errors, warnings };
}

/* ------------------------------------------------------------------ */
/* redaction                                                           */
/* ------------------------------------------------------------------ */

const SECRET_NAME = /^(?:api[-_]?key|authorization|auth|token|secret|password|passwd)$/i;

/**
 * Replace known secret values inside one piece of text.  Used for provider
 * responses and error bodies, which may echo a key back at us.
 * @param {unknown} text
 * @param {string[]} [secrets]
 * @returns {string}
 */
export function redactText(text, secrets = []) {
  let out = String(text == null ? "" : text);
  for (const secret of secrets) {
    if (typeof secret !== "string" || secret.length < 4) {
      continue;
    }
    out = out.split(secret).join(MASK);
  }
  return out;
}

/**
 * Deep-redact a value for a log line or a diagnostic: keys that name a secret
 * become `***`, and any occurrence of a known secret value inside a string is
 * replaced.  Never returns the same object; safe to `JSON.stringify`.
 * @param {unknown} value
 * @param {string[]} [secrets]
 * @returns {unknown}
 */
export function redact(value, secrets = []) {
  const limit = 8;

  function walk(node, depth) {
    if (depth > limit) {
      return "[depth-limit]";
    }
    if (typeof node === "string") {
      return redactText(node, secrets);
    }
    if (node === null || typeof node !== "object") {
      return node;
    }
    if (Array.isArray(node)) {
      return node.map((item) => walk(item, depth + 1));
    }
    const out = {};
    for (const key of Object.keys(node)) {
      const child = node[key];
      if (SECRET_NAME.test(key)) {
        out[key] = child === "" || child === null || child === undefined ? "" : MASK;
      } else {
        out[key] = walk(child, depth + 1);
      }
    }
    return out;
  }

  return walk(value, 0);
}

/**
 * A single-line, length-capped, secret-free excerpt for an error message.
 * @param {unknown} text
 * @param {string[]} [secrets]
 * @param {number} [cap]
 * @returns {string}
 */
export function snippet(text, secrets = [], cap = 500) {
  const flat = redactText(text, secrets).replace(/\s+/g, " ").trim();
  return flat.length <= cap ? flat : flat.slice(0, cap) + "...";
}

/* ------------------------------------------------------------------ */
/* description: what may leave this module                             */
/* ------------------------------------------------------------------ */

/**
 * The redacted view of a configuration.  Contains no key material of any kind:
 * `apiKey` is the constant mask when a key is set and `null` when it is not.
 * @param {unknown} config
 * @returns {object}
 */
export function describeConfig(config) {
  const normalized = normalizeConfig(config);
  const c = normalized.config;
  const hasApiKey = c.apiKey !== "";
  return {
    baseUrl: c.baseUrl,
    endpoint: endpointUrl(c.baseUrl),
    model: c.model,
    temperature: c.temperature,
    maxTokens: c.maxTokens,
    timeoutMs: c.timeoutMs,
    stream: c.stream,
    hasApiKey,
    apiKey: hasApiKey ? MASK : null
  };
}

/* ------------------------------------------------------------------ */
/* the store                                                           */
/* ------------------------------------------------------------------ */

/**
 * Where the settings live for a plain-Node caller.  Electron should pass
 * `app.getPath("userData")` instead; this is only a fallback for tests and CLI
 * tools, and it is a *directory*, never a repository or game path.
 * @param {NodeJS.ProcessEnv} [env]
 * @param {string} [platform]
 * @param {string} [appName]
 * @returns {string}
 */
export function defaultUserDataDir(
  env = process.env,
  platform = process.platform,
  appName = "OsanaKami IDE Studio"
) {
  const home = env.HOME || env.USERPROFILE || "";
  if (platform === "win32") {
    const roaming = env.APPDATA || (home ? path.join(home, "AppData", "Roaming") : "");
    return path.join(roaming || ".", appName);
  }
  if (platform === "darwin") {
    return path.join(home || ".", "Library", "Application Support", appName);
  }
  const xdg = env.XDG_CONFIG_HOME || (home ? path.join(home, ".config") : "");
  return path.join(xdg || ".", appName);
}

/**
 * A config store rooted at a directory.
 *
 * @param {{dir: string, filename?: string}} options
 *   `dir` must be absolute; it is Electron's userData directory.
 * @returns {{
 *   dir: string,
 *   file: string,
 *   read: () => {config: object, exists: boolean, warnings: object[], errors: object[], error: string|null},
 *   load: () => object,
 *   write: (patch?: object) => object,
 *   clear: () => void,
 *   describe: () => object
 * }}
 */
export function createConfigStore(options = {}) {
  const dir = options.dir;
  if (typeof dir !== "string" || dir.trim() === "" || !path.isAbsolute(dir)) {
    throw new ConfigError("config: dir must be an absolute directory path (Electron userData)");
  }
  const baseDir = path.resolve(dir);
  const filename = options.filename === undefined ? CONFIG_FILE : String(options.filename);
  if (filename !== path.basename(filename) || filename === "." || filename === "..") {
    throw new ConfigError("config: filename must be a bare file name");
  }
  const file = path.join(baseDir, filename);

  function read() {
    const result = {
      config: { ...DEFAULT_CONFIG },
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
      result.error = "config: could not read " + filename + " (" + errorCode(error) + ")";
      return result;
    }
    result.exists = true;
    let raw;
    try {
      raw = JSON.parse(text);
    } catch {
      // Deliberately does not include the file text: it holds the key.
      result.error = "config: " + filename + " is not valid JSON; defaults are in use";
      return result;
    }
    const normalized = normalizeConfig(raw);
    result.config = normalized.config;
    result.warnings = normalized.warnings;
    result.errors = normalized.errors;
    if (normalized.errors.length > 0) {
      result.error = "config: " + filename + " has invalid values; defaults are in use";
    }
    return result;
  }

  /** @returns {object} the effective configuration (defaults for bad/missing fields) */
  function load() {
    return { ...read().config };
  }

  /**
   * Merge `patch` onto the stored configuration and write it atomically.
   * Throws ConfigError when the result would be invalid; nothing is written.
   * @param {object} [patch]
   * @returns {object} the redacted description of what was written
   */
  function write(patch) {
    const current = read();
    if (pendingPatchInvalid(patch)) {
      throw new ConfigError("config: patch must be a plain object");
    }
    const merged = { ...current.config };
    if (patch !== undefined) {
      for (const key of Object.keys(patch)) {
        if (key === "version") {
          throw new ConfigError("config: version is not settable", [
            { key, message: "version is written automatically" }
          ]);
        }
        merged[key] = patch[key];
      }
    }
    const normalized = normalizeConfig(merged, { strict: true });
    if (normalized.errors.length > 0) {
      throw new ConfigError("config: refusing to write invalid settings", normalized.errors);
    }

    mkdirSync(baseDir, { recursive: true, mode: 0o700 });
    const body = JSON.stringify({ version: CONFIG_VERSION, ...normalized.config }, null, 2) + "\n";
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
      throw new ConfigError("config: could not write " + filename + " (" + errorCode(error) + ")");
    }
    return { ...describeConfig(normalized.config), file, warnings: normalized.warnings };
  }

  function clear() {
    try {
      unlinkSync(file);
    } catch (error) {
      if (error && error.code === "ENOENT") {
        return;
      }
      throw new ConfigError("config: could not remove " + filename + " (" + errorCode(error) + ")");
    }
  }

  function describe() {
    const current = read();
    return {
      ...describeConfig(current.config),
      file,
      exists: current.exists,
      error: current.error,
      warnings: current.warnings,
      errors: current.errors
    };
  }

  return { dir: baseDir, file, read, load, write, clear, describe };
}

/** @param {unknown} value */
function pendingPatchInvalid(value) {
  return value !== undefined && (value === null || typeof value !== "object" || Array.isArray(value));
}

/** @param {unknown} error */
function errorCode(error) {
  if (error && typeof error === "object" && typeof error.code === "string") {
    return error.code;
  }
  return "unknown error";
}

/** True when a path exists and is a regular file; used by callers that report drift. */
export function configFileExists(store) {
  try {
    return existsSync(store.file) && statSync(store.file).isFile();
  } catch {
    return false;
  }
}
