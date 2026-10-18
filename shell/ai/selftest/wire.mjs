import { section, check } from "./harness.mjs";
import { TEST_KEY, providerFor, messagesUser, fakeMods } from "./fixtures.mjs";
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

/* ---------------------------- wire -------------------------------- */

export async function runWireSection(server) {
  section("wire: the exact request a chat-completions endpoint sees");

  const provider = providerFor(server, "fake-text");

  server.reset();
  await check("a normal request is a POST to /v1/chat/completions", async () => {
    await provider.chat({ messages: messagesUser("hi") });
    const request = server.state.requests[0];
    assert.equal(server.state.requests.length, 1);
    assert.equal(request.method, "POST");
    assert.equal(request.url, "/v1/chat/completions");
    assert.equal(request.headers["content-type"], "application/json");
    assert.equal(request.headers.accept, "application/json");
    assert.equal(request.headers.authorization, "Bearer " + TEST_KEY);
  });

  await check("the body carries model, messages, stream and the settings", async () => {
    const body = server.state.requests[0].body;
    assert.equal(body.model, "fake-text");
    assert.deepEqual(body.messages, [{ role: "user", content: "hi" }]);
    assert.equal(body.stream, false);
    assert.equal(body.temperature, 0.2);
    assert.equal(body.max_tokens, 64);
  });

  await check("no API key means no Authorization header at all", async () => {
    const keyless = createProvider({ baseUrl: server.baseUrl, model: "fake-text", apiKey: "", timeoutMs: 4000 });
    await keyless.chat({ messages: messagesUser("hi") });
    const request = server.state.requests[server.state.requests.length - 1];
    assert.equal("authorization" in request.headers, false);
  });

  await check("a streamed request asks for text/event-stream", async () => {
    await provider.stream({ messages: messagesUser("hi") });
    const request = server.state.requests[server.state.requests.length - 1];
    assert.equal(request.body.stream, true);
    assert.equal(request.headers.accept, "text/event-stream");
  });

  await check("tools travel in the OpenAI function-calling shape", async () => {
    const registry = createToolRegistry({ tools: createReadOnlyTools({ mods: fakeMods(), modsRoot: null }) });
    await provider.chat({ messages: messagesUser("hi"), tools: registry.openaiTools() });
    const body = server.state.requests[server.state.requests.length - 1].body;
    assert.equal(Array.isArray(body.tools), true);
    assert.equal(body.tools.length, 2);
    assert.equal(body.tools[0].type, "function");
    assert.equal(body.tools[0].function.name, "kb.search");
    assert.equal(body.tools[0].function.parameters.type, "object");
    assert.equal(body.tool_choice, "auto");
  });

  await check("bad request shapes are refused before anything is sent", async () => {
    const before = server.state.requests.length;
    assert.throws(() => provider.chat({ messages: [] }), ConfigError);
    assert.throws(() => provider.chat({ messages: messagesUser(), toolChoice: "auto" }), ConfigError);
    assert.throws(() => provider.chat({ messages: messagesUser(), extra: { model: "sneaky" } }), ConfigError);
    assert.throws(() => provider.chat({ messages: messagesUser(), temperature: 2.5 }), ConfigError);
    assert.throws(() => provider.chat({ messages: messagesUser(), maxTokens: 0 }), ConfigError);
    assert.equal(server.state.requests.length, before, "a refused request must not reach the server");
  });

  await check("extra may add a field but not override the envelope", async () => {
    server.reset();
    await provider.chat({ messages: messagesUser(), extra: { top_p: 0.9 } });
    assert.equal(server.state.requests[0].body.top_p, 0.9);
  });

  await check("a tool message keeps its tool_call_id on the wire", async () => {
    server.reset();
    await provider.chat({
      messages: [
        { role: "user", content: "find" },
        { role: "assistant", content: null, tool_calls: [{ id: "call_9", type: "function", function: { name: "kb.search", arguments: "{}" } }] },
        { role: "tool", tool_call_id: "call_9", content: "{}" }
      ]
    });
    const sent = server.state.requests[0].body.messages;
    assert.equal(sent[1].tool_calls[0].id, "call_9");
    assert.equal(sent[2].tool_call_id, "call_9");
  });

  await check("the endpoint and describe() come from the same settings", () => {
    const described = provider.describe();
    assert.equal(described.endpoint, server.baseUrl + "/chat/completions");
    assert.equal(described.model, "fake-text");
    assert.equal(described.apiKey, MASK);
    assert.equal(described.retryLimit, 1);
  });
}
