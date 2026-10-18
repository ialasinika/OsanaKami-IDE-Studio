import { section, ok, check } from "./harness.mjs";
import { providerFor, messagesUser, fakeMods } from "./fixtures.mjs";
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

/* ---------------------------- loop -------------------------------- */

export async function runLoopSection(server, tempRoot) {
  section("loop: the model asks, the registry answers, the model concludes");

  await check("one complete tool turn over the wire", async () => {
    const mods = fakeMods();
    const registry = createToolRegistry({ tools: createReadOnlyTools({ mods, modsRoot: path.join(tempRoot, "mods-root") }) });
    const provider = providerFor(server, "fake-loop");
    server.reset();

    const messages = [
      { role: "system", content: "You are the IDE agent. Use tools when they answer the question." },
      { role: "user", content: "Which Item_ variables exist?" }
    ];

    const first = await provider.chat({ messages, tools: registry.openaiTools() });
    assert.equal(first.message.tool_calls.length, 1);
    const call = first.message.tool_calls[0];
    assert.equal(call.function.name, "kb.search");

    const outcome = await invokeToolCall(registry, call);
    assert.equal(outcome.ok, true);
    assert.equal(outcome.result.count, 2);

    messages.push(first.message, toolResultMessage(call, outcome));
    const second = await provider.chat({ messages, tools: registry.openaiTools() });
    assert.equal(second.message.content, "LOOP DONE");

    const secondRequest = server.state.requests[1];
    assert.equal(secondRequest.body.messages[1].role, "user");
    assert.equal(secondRequest.body.messages[2].role, "assistant");
    assert.equal(secondRequest.body.messages[3].role, "tool");
    assert.equal(secondRequest.body.messages[3].tool_call_id, "call_1");
    const toolPayload = JSON.parse(secondRequest.body.messages[3].content);
    assert.equal(toolPayload.items[0].label, "Item_Foo");
    assert.equal(secondRequest.body.tools.length, 2);
  });

  await check("the same loop works over SSE with streamed tool_calls", async () => {
    const mods = fakeMods();
    const registry = createToolRegistry({ tools: createReadOnlyTools({ mods, modsRoot: null }) });
    const provider = providerFor(server, "fake-tools");

    const events = [];
    const result = await provider.stream({ messages: messagesUser("find"), tools: registry.openaiTools() }, (event) => events.push(event));
    assert.equal(result.message.tool_calls.length, 2);
    assert.ok(events.some((event) => event.type === "tool_call"));
    assert.ok(events.some((event) => event.type === "done"));

    const outcomes = [];
    for (const call of result.message.tool_calls) {
      outcomes.push(await invokeToolCall(registry, call));
    }
    assert.equal(outcomes[0].ok, true);
    assert.equal(outcomes[0].result.count, 2);
    // mod.validate has no mods root here, so the relative root is refused as
    // data rather than thrown at the loop.
    assert.equal(outcomes[1].ok, false);
    assert.equal(outcomes[1].error.code, "path_outside_root");
  });
}
