import { section, ok, check } from "./harness.mjs";
import { TEST_KEY, providerFor, messagesUser, deadPort } from "./fixtures.mjs";
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

/* ---------------------------- replies ----------------------------- */

export async function runReplySection(server) {
  section("replies: one answer, or one classified failure");

  const provider = providerFor(server, "fake-text");

  await check("a non-streaming answer is normalized", async () => {
    const result = await provider.chat({ messages: messagesUser() });
    assert.equal(result.streamed, false);
    assert.equal(result.message.role, "assistant");
    assert.equal(result.message.content, "HELLO");
    assert.equal(result.finishReason, "stop");
    assert.deepEqual(result.usage, { prompt_tokens: 3, completion_tokens: 1, total_tokens: 4 });
    assert.equal(result.model, "fake-text");
  });

  await check("401 is an auth error, not retried, with the key redacted", async () => {
    server.reset();
    let caught = null;
    try {
      await providerFor(server, "fake-401").chat({ messages: messagesUser() });
    } catch (error) {
      caught = error;
    }
    assert.equal(caught instanceof ProviderError, true);
    assert.equal(caught.kind, "auth");
    assert.equal(caught.status, 401);
    assert.equal(caught.retryable, false);
    assert.equal(server.count("fake-401"), 1, "an auth error must not be retried");
    assert.ok(!caught.detail.includes(TEST_KEY), "the error detail must not echo the key");
    assert.ok(!caught.message.includes(TEST_KEY));
  });

  await check("429 is a retryable rate error with retry-after", async () => {
    let caught = null;
    try {
      await providerFor(server, "fake-429").chat({ messages: messagesUser() });
    } catch (error) {
      caught = error;
    }
    assert.equal(caught instanceof ProviderError, true);
    assert.equal(caught.kind, "rate");
    assert.equal(caught.status, 429);
    assert.equal(caught.retryable, true);
    assert.equal(caught.retryAfterMs, 1000);
  });

  await check("500 is a retryable protocol error", async () => {
    server.reset();
    let caught = null;
    try {
      await providerFor(server, "fake-500").chat({ messages: messagesUser() });
    } catch (error) {
      caught = error;
    }
    assert.equal(caught.kind, "protocol");
    assert.equal(caught.status, 500);
    assert.equal(caught.retryable, true);
    assert.equal(server.count("fake-500"), 1, "only transport errors are retried automatically");
  });

  await check("an error object in a 200 body is a protocol error", async () => {
    let caught = null;
    try {
      await providerFor(server, "fake-error-in-200").chat({ messages: messagesUser() });
    } catch (error) {
      caught = error;
    }
    assert.equal(caught.kind, "protocol");
    assert.ok(!caught.detail.includes(TEST_KEY));
  });

  await check("a body that is not JSON is a protocol error", async () => {
    let caught = null;
    try {
      await providerFor(server, "fake-not-json").chat({ messages: messagesUser() });
    } catch (error) {
      caught = error;
    }
    assert.equal(caught.kind, "protocol");
    assert.match(caught.message, /not JSON/);
  });

  await check("a response with no choices is a protocol error", async () => {
    let caught = null;
    try {
      await providerFor(server, "fake-no-choices").chat({ messages: messagesUser() });
    } catch (error) {
      caught = error;
    }
    assert.equal(caught.kind, "protocol");
    assert.match(caught.message, /choices/);
  });

  await check("a refused connection is a network error, retried exactly once", async () => {
    const port = await deadPort();
    let calls = 0;
    const countingFetch = (url, init) => {
      calls += 1;
      return fetch(url, init);
    };
    const dead = createProvider({
      baseUrl: "http://127.0.0.1:" + port + "/v1",
      model: "whatever",
      retryLimit: 1,
      retryDelayMs: 1,
      timeoutMs: 2000,
      fetchImpl: countingFetch
    });
    let caught = null;
    try {
      await dead.chat({ messages: messagesUser() });
    } catch (error) {
      caught = error;
    }
    assert.equal(caught instanceof ProviderError, true);
    assert.equal(caught.kind, "network");
    assert.equal(caught.retryable, true);
    assert.equal(calls, 2, "one attempt plus exactly one retry");
  });

  await check("a dropped connection is retried and then recovers", async () => {
    server.reset();
    const flaky = providerFor(server, "fake-retry");
    const result = await flaky.chat({ messages: messagesUser() });
    assert.equal(result.message.content, "recovered");
    assert.equal(server.count("fake-retry"), 2);
  });

  await check("isProviderError tells errors apart from crash bugs", () => {
    assert.equal(isProviderError(new ProviderError("network", "x")), true);
    assert.equal(isProviderError(new Error("x")), false);
    assert.deepEqual(ERROR_KINDS, ["auth", "rate", "network", "protocol", "cancelled"]);
  });
}
