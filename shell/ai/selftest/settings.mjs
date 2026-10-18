import { section, ok, check, skip } from "./harness.mjs";
import { TEST_KEY } from "./fixtures.mjs";
import { strict as assert } from "node:assert";
import { createServer } from "node:http";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import {
  CONFIG_FILE,
  DEFAULT_CONFIG,
  MASK,
  ConfigError,
  configFileExists,
  createConfigStore,
  defaultUserDataDir,
  describeConfig,
  endpointUrl,
  normalizeBaseUrl,
  normalizeConfig,
  redact,
  redactText,
  snippet
} from "../config.mjs";
import {
  DEFAULT_PREFERENCES,
  PREFERENCES_FILE,
  SettingsError,
  createPreferenceStore,
  normalizePreferences
} from "../settings.mjs";
import { dispatch } from "../../main.mjs";
import { ERROR_KINDS, ProviderError, createProvider, isProviderError } from "../provider.mjs";
import {
  TOOL_ERROR_CODES,
  ToolError,
  createReadOnlyTools,
  createToolRegistry,
  defineTool,
  invokeToolCall,
  parseToolArguments,
  resolveInside,
  toolResultMessage,
  validateToolArguments
} from "../tools.mjs";

/* ---------------------------- settings ---------------------------- */

export async function runSettingsSection(tempRoot) {
  section("settings: the preferences file and the config verbs");

  const dir = path.join(tempRoot, "settings-default");
  const store = createPreferenceStore({ dir });

  await check("a missing preferences file means the defaults", () => {
    const result = store.read();
    assert.equal(result.exists, false);
    assert.equal(result.error, null);
    assert.deepEqual(result.preferences, { ...DEFAULT_PREFERENCES });
    assert.deepEqual(store.load(), { ...DEFAULT_PREFERENCES });
    assert.equal(store.file, path.join(dir, PREFERENCES_FILE));
  });

  await check("write then read is a round trip", () => {
    const receipt = store.write({ bootView: "classic", watchPollMs: 4000 });
    assert.equal(receipt.bootView, "classic");
    assert.equal(receipt.watchPollMs, 4000);
    assert.equal(receipt.version, 1);
    assert.equal(receipt.file, store.file);
    const read = store.read();
    assert.equal(read.exists, true);
    assert.equal(read.error, null);
    assert.equal(read.preferences.bootView, "classic");
    assert.equal(read.preferences.watchPollMs, 4000);
  });

  await check("a partial patch keeps the stored value", () => {
    const receipt = store.write({ bootView: "mod" });
    assert.equal(receipt.bootView, "mod");
    assert.equal(receipt.watchPollMs, 4000);
  });

  await check("the written file is JSON with version 1", () => {
    const raw = JSON.parse(readFileSync(store.file, "utf8"));
    assert.equal(raw.version, 1);
    assert.equal(raw.bootView, "mod");
    assert.equal(raw.watchPollMs, 4000);
  });

  await check("an invalid patch is refused and leaves the file untouched", () => {
    const before = readFileSync(store.file, "utf8");
    assert.throws(
      () => store.write({ bootView: "card" }),
      (error) => error instanceof SettingsError && error.errors.some((entry) => entry.key === "bootView")
    );
    assert.throws(() => store.write({ watchPollMs: 100 }), SettingsError);
    assert.throws(() => store.write({ watchPollMs: 60001 }), SettingsError);
    assert.throws(() => store.write({ watchPollMs: 1500.5 }), SettingsError);
    assert.equal(readFileSync(store.file, "utf8"), before);
  });

  await check("version is written by the store, not by the caller", () => {
    assert.throws(() => store.write({ version: 2 }), (error) => error instanceof SettingsError && /version/.test(error.message));
  });

  await check("unknown keys are warnings, not errors", () => {
    const normalized = normalizePreferences({ bootView: "classic", future: true });
    assert.equal(normalized.errors.length, 0);
    assert.equal(normalized.warnings.length, 1);
    assert.equal(normalized.warnings[0].key, "future");
    assert.equal(normalized.preferences.bootView, "classic");
  });

  await check("normalizePreferences reports bad values without throwing", () => {
    const normalized = normalizePreferences({ bootView: 1, watchPollMs: "fast", version: 3 });
    assert.equal(normalized.errors.length, 3);
    assert.equal(normalized.preferences.bootView, DEFAULT_PREFERENCES.bootView);
    assert.equal(normalized.preferences.watchPollMs, DEFAULT_PREFERENCES.watchPollMs);
    assert.equal(normalized.preferences.version, 1);
  });

  await check("a corrupt file falls back to defaults and does not echo its text", () => {
    const corruptDir = path.join(tempRoot, "settings-corrupt");
    const corrupt = createPreferenceStore({ dir: corruptDir });
    corrupt.write({ bootView: "classic" });
    writeFileSync(corrupt.file, '{"bootView":"classic", oops', "utf8");
    const read = corrupt.read();
    assert.equal(read.error !== null, true);
    assert.match(read.error, /not valid JSON/);
    assert.deepEqual(read.preferences, { ...DEFAULT_PREFERENCES });
    assert.equal(read.warnings.length, 1);
    assert.equal(read.warnings[0].message.includes("oops"), false);
  });

  await check("a directory and a file name are validated", () => {
    assert.throws(() => createPreferenceStore({ dir: "relative/dir" }), SettingsError);
    assert.throws(
      () => createPreferenceStore({ dir: path.join(tempRoot, "x"), filename: "sub/prefs.json" }),
      SettingsError
    );
  });

  await check("clear() removes the file", () => {
    const clearStore = createPreferenceStore({ dir: path.join(tempRoot, "settings-clear") });
    clearStore.write({ watchPollMs: 500 });
    assert.equal(existsSync(clearStore.file), true);
    clearStore.clear();
    assert.equal(existsSync(clearStore.file), false);
    clearStore.clear(); // removing twice is not an error
  });

  await check("no temp file is left behind by an atomic write", () => {
    assert.deepEqual(readdirSync(dir), [PREFERENCES_FILE]);
  });

  await check("the preferences file is 0o600 on POSIX", () => {
    if (process.platform === "win32") {
      skip();
      process.stdout.write("  skip the preferences file is 0o600 on POSIX (win32 has no POSIX mode)\n");
      return;
    }
    assert.equal(statSync(store.file).mode & 0o777, 0o600);
  });

  await check("dispatch answers config.get and config.set without the kernel", async () => {
    const userDir = path.join(tempRoot, "settings-dispatch");
    const context = {
      userDir,
      app: { workspace: path.join(tempRoot, "workspace"), modsRoot: null },
      ai: createConfigStore({ dir: userDir }),
      prefs: createPreferenceStore({ dir: userDir })
    };
    const kernel = { call() { throw new Error("the kernel must not be reached"); } };
    const ask = (id, method, params) => dispatch({ id, method, params }, kernel, null, null, context);

    const get = await ask(1, "config.get", {});
    assert.equal(get.error, undefined);
    const result = get.result;
    assert.equal(result.userDir, userDir);
    assert.equal(result.files.settings, path.join(userDir, "settings.json"));
    assert.equal(result.files.ai, path.join(userDir, CONFIG_FILE));
    assert.equal(result.files.preferences, path.join(userDir, PREFERENCES_FILE));
    assert.deepEqual(result.app, { workspace: context.app.workspace, modsRoot: null });
    assert.equal(result.ai.apiKey, null);
    assert.equal(result.prefs.bootView, DEFAULT_PREFERENCES.bootView);
    assert.equal(result.prefs.watchPollMs, DEFAULT_PREFERENCES.watchPollMs);
    assert.equal(result.prefs.file, context.prefs.file);

    const badPrefs = await ask(2, "config.set", { prefs: { bootView: "card" } });
    assert.equal(badPrefs.error.code, -32603);
    assert.equal(badPrefs.error.message.startsWith("config.set: "), true);
    assert.equal(context.prefs.read().exists, false, "a rejected write must not create the file");

    const badAi = await ask(3, "config.set", { ai: { temperature: 9 } });
    assert.equal(badAi.error.code, -32603);
    assert.equal(badAi.error.message.includes("temperature"), true);

    const set = await ask(4, "config.set", { prefs: { bootView: "classic" }, ai: { apiKey: TEST_KEY } });
    assert.equal(set.error, undefined);
    assert.equal(set.result.prefs.bootView, "classic");
    assert.equal(set.result.ai.apiKey, MASK);
    assert.equal(set.result.ai.hasApiKey, true);
    assert.ok(!JSON.stringify(set.result).includes(TEST_KEY), "config.set must never echo the key");

    // An empty apiKey field means "leave the stored key alone".
    const keep = await ask(5, "config.set", { ai: { apiKey: "" } });
    assert.equal(keep.result.ai.hasApiKey, true);
    assert.equal(keep.result.ai.apiKey, MASK);

    const clear = await ask(6, "config.set", { clearKey: true });
    assert.equal(clear.result.ai.hasApiKey, false);
    assert.equal(clear.result.ai.apiKey, null);

    const after = await ask(7, "config.get", {});
    assert.equal(after.error, undefined);
    assert.ok(!JSON.stringify(after.result).includes(TEST_KEY), "config.get must never carry the key");
    assert.equal(after.result.prefs.bootView, "classic");

    // Old four-argument callers (the kernel probe, a stdio mode) must keep
    // working: the settings context is the optional fifth argument.
    const legacy = await dispatch(
      { id: 8, method: "lang.list", params: {} },
      kernel,
      { list: () => ({ langs: [] }) },
      null
    );
    assert.equal(legacy.error, undefined);
    assert.deepEqual(legacy.result, { langs: [] });
  });
}
