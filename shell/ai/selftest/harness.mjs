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

/* ------------------------------------------------------------------ */
/* harness                                                             */
/* ------------------------------------------------------------------ */

export let passed = 0;
export let failed = 0;
export let skipped = 0;
export const failures = [];

export function section(title) {
  process.stdout.write("\n" + title + "\n");
}

export function ok(name) {
  passed += 1;
  process.stdout.write("  ok   " + name + "\n");
}

export function fail(name, detail) {
  failed += 1;
  failures.push({ name, detail });
  process.stdout.write("  FAIL " + name + " -- " + detail + "\n");
}

export function describeError(error) {
  if (error instanceof ProviderError) {
    return "ProviderError(" + error.kind + "): " + error.message + (error.detail ? " | detail=" + error.detail : "");
  }
  if (error instanceof ConfigError) {
    return "ConfigError: " + error.message;
  }
  if (error instanceof ToolError) {
    return "ToolError(" + error.code + "): " + error.message;
  }
  return error && error.message ? error.message : String(error);
}

export async function check(name, fn) {
  try {
    await fn();
    ok(name);
  } catch (error) {
    fail(name, describeError(error));
  }
}

/* ------------------------------------------------------------------ */
/* the fake OpenAI-compatible server                                   */
/* ------------------------------------------------------------------ */


export function skip() {
  skipped += 1;
}
