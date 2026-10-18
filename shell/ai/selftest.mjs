#!/usr/bin/env node
/**
 * shell/ai/selftest.mjs -- offline checks for the agent foundation.
 *
 * Completely detached from the network and from the game: every HTTP request
 * goes to a throwaway OpenAI-compatible server this file starts on 127.0.0.1
 * (port 0, so the OS picks one), and every file goes to a temp directory that
 * is removed at the end.  Run it with plain Node:
 *
 *     node shell/ai/selftest.mjs
 *
 * Sections:
 *   config   -- defaults, round trip, redaction, corruption, invalid writes
 *   settings -- the preferences file and the config.get/config.set verbs
 *   wire     -- the exact chat-completions request this adapter sends
 *   replies  -- the error taxonomy and the non-streaming answer
 *   stream   -- SSE framing, cross-chunk deltas, tool_call accumulation, abort
 *   registry -- tool definitions, schema validation, path sandbox
 *   loop     -- provider + registry + tools, one complete model turn
 *
 * Exit code 0 when everything passes.
 */

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
} from "./config.mjs";
import {
  DEFAULT_PREFERENCES,
  PREFERENCES_FILE,
  SettingsError,
  createPreferenceStore,
  normalizePreferences
} from "./settings.mjs";
import { dispatch } from "../main.mjs";
import { ERROR_KINDS, ProviderError, createProvider, isProviderError } from "./provider.mjs";
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
} from "./tools.mjs";

import { passed, failed, skipped, failures } from "./selftest/harness.mjs";
import { startFakeServer } from "./selftest/fixtures.mjs";
import { runConfigSection } from "./selftest/config.mjs";
import { runSettingsSection } from "./selftest/settings.mjs";
import { runWireSection } from "./selftest/wire.mjs";
import { runReplySection } from "./selftest/reply.mjs";
import { runStreamSection } from "./selftest/stream.mjs";
import { runRegistrySection } from "./selftest/registry.mjs";
import { runLoopSection } from "./selftest/loop.mjs";

/* ------------------------------------------------------------------ */
/* main                                                               */
/* ------------------------------------------------------------------ */

async function main() {
  const tempRoot = mkdtempSync(path.join(tmpdir(), "ig-ai-selftest-"));
  const server = await startFakeServer();
  try {
    await runConfigSection(tempRoot);
    await runSettingsSection(tempRoot);
    await runWireSection(server);
    await runReplySection(server);
    await runStreamSection(server);
    await runRegistrySection(tempRoot);
    await runLoopSection(server, tempRoot);
  } finally {
    await server.close();
    rmSync(tempRoot, { recursive: true, force: true });
  }

  const total = passed + failed;
  process.stdout.write("\n" + passed + "/" + total + " checks passed" + (skipped > 0 ? " (" + skipped + " skipped)" : "") + "\n");
  if (failed > 0) {
    for (const failure of failures) {
      process.stdout.write("  " + failure.name + " -- " + failure.detail + "\n");
    }
    process.stdout.write("\nshell/ai: FAIL (" + failed + ")\n");
    process.exitCode = 1;
    return;
  }
  process.stdout.write("\nshell/ai: ok\n");
}

/* ------------------------------------------------------------------ */
/* run                                                                 */
/* ------------------------------------------------------------------ */

main().catch((error) => {
  process.stderr.write("shell/ai selftest crashed: " + (error && error.stack ? error.stack : String(error)) + "\n");
  process.exitCode = 1;
});
