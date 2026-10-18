import { section, ok, check } from "./harness.mjs";
import { TEST_KEY, providerFor, messagesUser } from "./fixtures.mjs";
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

/* ---------------------------- stream ------------------------------ */

export async function runStreamSection(server) {
  section("stream: frames that arrive in pieces, calls that arrive in pieces");

  await check("text deltas become one message, with events along the way", async () => {
    const events = [];
    const provider = providerFor(server, "fake-stream");
    const result = await provider.stream({ messages: messagesUser() }, (event) => events.push(event));
    assert.equal(result.streamed, true);
    assert.equal(result.message.content, "Hello, world");
    assert.equal(result.finishReason, "stop");
    assert.deepEqual(result.usage, { prompt_tokens: 5, completion_tokens: 3, total_tokens: 8 });
    const text = events.filter((event) => event.type === "text").map((event) => event.text).join("");
    assert.equal(text, "Hello, world");
    assert.deepEqual(events[events.length - 1].type, "done");
  });

  await check("a frame split across chunks is held until its blank line", async () => {
    // The fake server writes one frame in two halves with a pause between; if
    // the parser did not buffer, the JSON would be cut.
    const provider = providerFor(server, "fake-stream");
    const events = [];
    const result = await provider.stream({ messages: messagesUser() }, (event) => events.push(event));
    assert.equal(result.message.content, "Hello, world");
    assert.equal(server.state.requests[server.state.requests.length - 1].body.stream, true);
  });

  await check("CRLF frame separators are accepted", async () => {
    const provider = providerFor(server, "fake-stream-crlf");
    const result = await provider.stream({ messages: messagesUser() });
    assert.equal(result.message.content, "CRLF");
    assert.equal(result.finishReason, "stop");
  });

  await check("tool_calls accumulate across frames and stay in order", async () => {
    const provider = providerFor(server, "fake-tools");
    const events = [];
    const result = await provider.stream({ messages: messagesUser() }, (event) => events.push(event));
    assert.equal(result.message.content, null);
    assert.equal(result.finishReason, "tool_calls");
    assert.equal(result.message.tool_calls.length, 2);
    assert.equal(result.message.tool_calls[0].id, "call_1");
    assert.equal(result.message.tool_calls[0].function.name, "kb.search");
    assert.deepEqual(JSON.parse(result.message.tool_calls[0].function.arguments), { prefix: "Item_", limit: 2 });
    assert.equal(result.message.tool_calls[1].id, "call_2");
    assert.equal(result.message.tool_calls[1].function.name, "mod.validate");
    assert.deepEqual(JSON.parse(result.message.tool_calls[1].function.arguments), { root: "ExampleMod" });

    // The argument fragments, concatenated per call in arrival order, must
    // equal the argument string: this is what breaks if accumulation is lost.
    const deltas = events.filter((event) => event.type === "tool_call");
    const perCall = new Map();
    for (const event of deltas) {
      perCall.set(event.index, (perCall.get(event.index) || "") + event.argumentsDelta);
    }
    assert.equal(perCall.get(0), result.message.tool_calls[0].function.arguments);
    assert.equal(perCall.get(1), result.message.tool_calls[1].function.arguments);
  });

  await check("a name split across frames is stitched together", async () => {
    const provider = providerFor(server, "fake-tools");
    const result = await provider.stream({ messages: messagesUser() });
    assert.equal(result.message.tool_calls[0].function.name, "kb.search");
  });

  await check("a stream may end after finish_reason without [DONE]", async () => {
    const provider = providerFor(server, "fake-stream-no-done");
    const result = await provider.stream({ messages: messagesUser() });
    assert.equal(result.message.content, "Hi");
    assert.equal(result.finishReason, "stop");
  });

  await check("a stream that ends mid-answer is a protocol error", async () => {
    let caught = null;
    try {
      await providerFor(server, "fake-stream-incomplete").stream({ messages: messagesUser() });
    } catch (error) {
      caught = error;
    }
    assert.equal(caught.kind, "protocol");
    assert.match(caught.message, /\[DONE\]/);
  });

  await check("an error frame mid-stream is a protocol error", async () => {
    let caught = null;
    try {
      await providerFor(server, "fake-stream-midstream-error").stream({ messages: messagesUser() });
    } catch (error) {
      caught = error;
    }
    assert.equal(caught.kind, "protocol");
    assert.ok(!caught.detail.includes(TEST_KEY));
  });

  await check("a streamed tool_call without a name is a protocol error", async () => {
    let caught = null;
    try {
      await providerFor(server, "fake-tool-noname").stream({ messages: messagesUser() });
    } catch (error) {
      caught = error;
    }
    assert.equal(caught.kind, "protocol");
    assert.match(caught.message, /never said which function/);
  });

  await check("a server that ignores stream:true is accepted as one answer", async () => {
    const result = await providerFor(server, "fake-json-stream").stream({ messages: messagesUser() });
    assert.equal(result.streamed, false);
    assert.equal(result.message.content, "fell back");
  });

  await check("a non-SSE content type is a protocol error", async () => {
    let caught = null;
    try {
      await providerFor(server, "fake-plain").stream({ messages: messagesUser() });
    } catch (error) {
      caught = error;
    }
    assert.equal(caught.kind, "protocol");
    assert.match(caught.message, /text\/event-stream/);
  });

  await check("aborting the caller's signal cancels the request", async () => {
    const controller = new AbortController();
    const provider = providerFor(server, "fake-hang", { timeoutMs: 30000 });
    const pending = provider.stream({ messages: messagesUser(), signal: controller.signal });
    setTimeout(() => controller.abort(), 40);
    let caught = null;
    try {
      await pending;
    } catch (error) {
      caught = error;
    }
    assert.equal(caught instanceof ProviderError, true);
    assert.equal(caught.kind, "cancelled");
    assert.equal(caught.timedOut, false);
    assert.equal(server.count("fake-hang"), 1, "the cancelling caller must not trigger a retry");
  });

  await check("a silently hanging server times out, without retrying", async () => {
    server.reset();
    const provider = providerFor(server, "fake-hang", { timeoutMs: 120, retryLimit: 2 });
    let caught = null;
    try {
      await provider.chat({ messages: messagesUser() });
    } catch (error) {
      caught = error;
    }
    assert.equal(caught instanceof ProviderError, true);
    assert.equal(caught.kind, "network");
    assert.equal(caught.timedOut, true);
    assert.equal(caught.retryable, false);
    assert.match(caught.message, /timed out/);
    assert.equal(server.count("fake-hang"), 1, "a timeout is not retried automatically");
  });

  await check("an already-aborted signal never reaches the network", async () => {
    server.reset();
    const controller = new AbortController();
    controller.abort();
    const provider = providerFor(server, "fake-text");
    let caught = null;
    try {
      await provider.chat({ messages: messagesUser(), signal: controller.signal });
    } catch (error) {
      caught = error;
    }
    assert.equal(caught.kind, "cancelled");
    assert.equal(server.state.requests.length, 0);
  });

  await check("complete() picks the transport from request.stream", async () => {
    server.reset();
    const nonStreaming = providerFor(server, "fake-text").complete({ messages: messagesUser(), stream: false });
    const streamedProvider = providerFor(server, "fake-stream");
    const nonStream = await nonStreaming;
    assert.equal(nonStream.streamed, false);
    const streamed = await streamedProvider.complete({ messages: messagesUser(), stream: true });
    assert.equal(streamed.streamed, true);
    assert.equal(server.state.requests[0].body.stream, false);
    assert.equal(server.state.requests[1].body.stream, true);
  });
}
