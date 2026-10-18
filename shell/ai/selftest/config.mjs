import { section, ok, check } from "./harness.mjs";
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

/* ---------------------------- config ------------------------------ */

export async function runConfigSection(tempRoot) {
  section("config: what is stored, what is printed");

  const dir = path.join(tempRoot, "userdata-ok");
  const store = createConfigStore({ dir });

  await check("a missing file means the defaults, not an error", () => {
    const result = store.read();
    assert.equal(result.exists, false);
    assert.equal(result.error, null);
    assert.deepEqual(result.config, { ...DEFAULT_CONFIG });
    assert.equal(store.file, path.join(dir, CONFIG_FILE));
  });

  await check("write then read is a round trip", () => {
    const described = store.write({ model: "deepseek-reasoner", apiKey: TEST_KEY, baseUrl: "http://127.0.0.1:9/v1" });
    assert.equal(described.model, "deepseek-reasoner");
    const read = store.read();
    assert.equal(read.exists, true);
    assert.equal(read.config.model, "deepseek-reasoner");
    assert.equal(read.config.apiKey, TEST_KEY);
    assert.equal(read.config.baseUrl, "http://127.0.0.1:9/v1");
    assert.equal(read.config.temperature, DEFAULT_CONFIG.temperature);
    assert.equal(configFileExists(store), true);
  });

  await check("the write receipt is redacted", () => {
    const described = store.write({ apiKey: TEST_KEY });
    assert.equal(described.apiKey, MASK);
    assert.equal(described.hasApiKey, true);
    assert.equal(described.file, store.file);
    assert.ok(!JSON.stringify(described).includes(TEST_KEY), "the receipt must not carry the key");
  });

  await check("describe() masks the key and never prints it", () => {
    const described = store.describe();
    assert.equal(described.apiKey, MASK);
    assert.equal(described.hasApiKey, true);
    assert.equal(described.endpoint.endsWith("/chat/completions"), true);
    assert.ok(!JSON.stringify(described).includes(TEST_KEY), "describe() must not carry the key");
  });

  await check("the file itself does persist the key (that is its purpose)", () => {
    const text = readFileSync(store.file, "utf8");
    assert.equal(JSON.parse(text).apiKey, TEST_KEY);
    assert.equal(JSON.parse(text).version, 1);
  });

  await check("an invalid write is refused and leaves the file untouched", () => {
    const before = readFileSync(store.file, "utf8");
    assert.throws(
      () => store.write({ temperature: 9 }),
      (error) => error instanceof ConfigError && error.errors.some((entry) => entry.key === "temperature")
    );
    assert.equal(readFileSync(store.file, "utf8"), before);
  });

  await check("version is written by the store, not by the caller", () => {
    assert.throws(() => store.write({ version: 2 }), (error) => error instanceof ConfigError && /version/.test(error.message));
  });

  await check("a corrupt file falls back to defaults and does not echo its text", () => {
    const corruptDir = path.join(tempRoot, "userdata-corrupt");
    const corrupt = createConfigStore({ dir: corruptDir });
    corrupt.write({ apiKey: TEST_KEY });
    writeFileSync(corrupt.file, '{"apiKey":"' + TEST_KEY + '", oops', "utf8");
    const read = corrupt.read();
    assert.equal(read.error !== null, true);
    assert.match(read.error, /not valid JSON/);
    assert.equal(read.config.apiKey, "");
    assert.ok(!JSON.stringify(read).includes(TEST_KEY), "a corrupt read must not carry the key either");
  });

  await check("a directory and file name are validated", () => {
    assert.throws(() => createConfigStore({ dir: "relative/dir" }), ConfigError);
    assert.throws(() => createConfigStore({ dir: path.join(tempRoot, "x"), filename: "sub/ai.json" }), ConfigError);
  });

  await check("clear() removes the file", () => {
    const clearDir = path.join(tempRoot, "userdata-clear");
    const clearStore = createConfigStore({ dir: clearDir });
    clearStore.write({ model: "m" });
    assert.equal(configFileExists(clearStore), true);
    clearStore.clear();
    assert.equal(configFileExists(clearStore), false);
    clearStore.clear(); // removing twice is not an error
  });

  await check("no temp file is left behind by an atomic write", () => {
    const listing = readdirSync(path.join(tempRoot, "userdata-ok"));
    assert.deepEqual(listing, [CONFIG_FILE]);
  });

  await check("normalizeBaseUrl canonicalizes the endpoint forms people paste", () => {
    assert.equal(normalizeBaseUrl("http://127.0.0.1:8080/v1/").value, "http://127.0.0.1:8080/v1");
    assert.equal(normalizeBaseUrl("http://127.0.0.1:8080/v1/chat/completions").value, "http://127.0.0.1:8080/v1");
    assert.equal(normalizeBaseUrl("http://user:pw@host/v1").error !== undefined, true);
    assert.equal(normalizeBaseUrl("ftp://host/v1").error !== undefined, true);
    assert.equal(endpointUrl("http://127.0.0.1:1/v1"), "http://127.0.0.1:1/v1/chat/completions");
  });

  await check("redactText, redact and snippet hide the key", () => {
    const secret = "sk-live-abc123";
    assert.ok(!redactText("Authorization: Bearer " + secret, [secret]).includes(secret));
    const tree = redact({ apiKey: secret, nested: { authorization: "Bearer " + secret }, text: "uses " + secret }, [secret]);
    assert.equal(tree.apiKey, MASK);
    assert.equal(tree.nested.authorization, MASK);
    assert.ok(!JSON.stringify(tree).includes(secret));
    const oneLine = snippet("line one\nline two " + secret + "   ", [secret], 40);
    assert.equal(oneLine.includes("\n"), false);
    assert.ok(!oneLine.includes(secret));
    assert.ok(oneLine.length <= 40 + MASK.length);
  });

  await check("normalizeConfig reports bad fields without throwing", () => {
    const normalized = normalizeConfig({ baseUrl: "nope", temperature: 5, maxTokens: 0, apiKey: TEST_KEY });
    assert.equal(normalized.errors.length >= 3, true);
    assert.equal(normalized.config.apiKey, TEST_KEY);
    assert.equal(normalized.config.baseUrl, DEFAULT_CONFIG.baseUrl);
  });

  await check("describeConfig never returns the raw key", () => {
    const described = describeConfig({ apiKey: TEST_KEY });
    assert.equal(described.apiKey, MASK);
    assert.ok(!JSON.stringify(described).includes(TEST_KEY));
    assert.equal(describeConfig({ apiKey: "" }).apiKey, null);
  });

  await check("defaultUserDataDir uses the platform's convention", () => {
    const win = defaultUserDataDir({ APPDATA: "C:\\Users\\someone\\AppData\\Roaming" }, "win32");
    assert.equal(win, path.join("C:\\Users\\someone\\AppData\\Roaming", "OsanaKami IDE Studio"));
    const linux = defaultUserDataDir({ HOME: "/home/someone" }, "linux");
    assert.equal(linux, path.join("/home/someone", ".config", "OsanaKami IDE Studio"));
  });
}
