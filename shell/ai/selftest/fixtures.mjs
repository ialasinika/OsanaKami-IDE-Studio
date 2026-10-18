import { ok } from "./harness.mjs";
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

export const TEST_KEY = "sk-test-key-do-not-print";

export function jsonCompletion(options = {}) {
  const message = { role: "assistant", content: options.content === undefined ? "" : options.content };
  if (options.toolCalls !== undefined) {
    message.content = null;
    message.tool_calls = options.toolCalls;
  }
  return {
    id: options.id || "chatcmpl-fake",
    object: "chat.completion",
    created: 1700000000,
    model: options.model || "fake",
    choices: [
      {
        index: 0,
        message,
        finish_reason: options.finish === undefined ? "stop" : options.finish
      }
    ],
    usage: options.usage === undefined ? { prompt_tokens: 3, completion_tokens: 1, total_tokens: 4 } : options.usage
  };
}

export function sseChunk(options = {}) {
  const frame = {
    id: options.id || "chatcmpl-stream",
    object: "chat.completion.chunk",
    created: 1700000000,
    model: options.model || "fake-stream"
  };
  const choice = { index: 0, delta: options.delta === undefined ? {} : options.delta };
  if (options.finish !== undefined) {
    choice.finish_reason = options.finish;
  }
  frame.choices = [choice];
  if (options.usage !== undefined) {
    frame.usage = options.usage;
  }
  return frame;
}

export function frameText(object) {
  return "data: " + JSON.stringify(object) + "\n\n";
}

export function jsonResponse(res, status, object) {
  const body = typeof object === "string" ? object : JSON.stringify(object);
  res.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "content-length": Buffer.byteLength(body)
  });
  res.end(body);
}

export function sseHead(res) {
  res.writeHead(200, {
    "content-type": "text/event-stream; charset=utf-8",
    "cache-control": "no-cache",
    connection: "keep-alive"
  });
}

export function tick(ms = 2) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Read the whole request body as text. */
export function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on("data", (chunk) => {
      size += chunk.length;
      if (size > 1024 * 1024) {
        reject(new Error("request body too large"));
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    req.on("error", reject);
  });
}

export function startFakeServer() {
  const state = { requests: [], counts: new Map(), hang: new Set() };

  async function handle(req, res, body) {
    const model = body && typeof body.model === "string" ? body.model : "";
    const count = (state.counts.get(model) || 0) + 1;
    state.counts.set(model, count);

    switch (model) {
      case "fake-text":
        return jsonResponse(res, 200, jsonCompletion({ id: "chatcmpl-text", model, content: "HELLO" }));

      case "fake-stream": {
        sseHead(res);
        res.write(frameText(sseChunk({ model, delta: { role: "assistant", content: "Hel" } })));
        await tick();
        res.write(frameText(sseChunk({ model, delta: { content: "lo, " } })));
        await tick();
        // A frame deliberately split across two writes: the parser must wait
        // for the blank line before treating it as complete.
        const tail = frameText(sseChunk({ model, delta: { content: "world" }, finish: "stop", usage: { prompt_tokens: 5, completion_tokens: 3, total_tokens: 8 } }));
        res.write(tail.slice(0, 25));
        await tick();
        res.write(tail.slice(25));
        await tick();
        res.write("data: [DONE]\n\n");
        res.end();
        return;
      }

      case "fake-stream-crlf": {
        sseHead(res);
        res.write("data: " + JSON.stringify(sseChunk({ model, delta: { content: "CR" } })) + "\r\n\r\n");
        await tick();
        res.write("data: " + JSON.stringify(sseChunk({ model, delta: { content: "LF" }, finish: "stop" })) + "\r\n\r\n");
        await tick();
        res.write("data: [DONE]\r\n\r\n");
        res.end();
        return;
      }

      case "fake-stream-no-done": {
        sseHead(res);
        res.write(frameText(sseChunk({ model, delta: { content: "Hi" } })));
        await tick();
        res.write(frameText(sseChunk({ model, delta: {}, finish: "stop" })));
        res.end();
        return;
      }

      case "fake-stream-incomplete": {
        sseHead(res);
        res.write(frameText(sseChunk({ model, delta: { content: "Hi" } })));
        res.end();
        return;
      }

      case "fake-stream-midstream-error": {
        sseHead(res);
        res.write(frameText(sseChunk({ model, delta: { content: "partial" } })));
        await tick();
        res.write("data: " + JSON.stringify({ error: { message: "upstream exploded with " + TEST_KEY } }) + "\n\n");
        res.end();
        return;
      }

      case "fake-json-stream":
        return jsonResponse(res, 200, jsonCompletion({ model, content: "fell back" }));

      case "fake-plain": {
        const body = "not an event stream";
        res.writeHead(200, { "content-type": "text/plain", "content-length": Buffer.byteLength(body) });
        res.end(body);
        return;
      }

      case "fake-tools": {
        sseHead(res);
        // call 0: id, then the name split across two frames, then arguments
        // split across two more.
        res.write(frameText(sseChunk({ model, delta: { role: "assistant" } })));
        await tick();
        res.write(frameText(sseChunk({ model, delta: { tool_calls: [{ index: 0, id: "call_1", type: "function", function: { name: "kb." } }] } })));
        await tick();
        res.write(frameText(sseChunk({ model, delta: { tool_calls: [{ index: 0, function: { name: "search" } }] } })));
        await tick();
        const argBits = ['{"prefix":"Item', '_","limit":2}'];
        for (const bit of argBits) {
          res.write(frameText(sseChunk({ model, delta: { tool_calls: [{ index: 0, function: { arguments: bit } }] } })));
          await tick();
        }
        // call 1: a separate function in the same response.
        res.write(frameText(sseChunk({ model, delta: { tool_calls: [{ index: 1, id: "call_2", type: "function", function: { name: "mod.validate" } }] } })));
        await tick();
        res.write(frameText(sseChunk({ model, delta: { tool_calls: [{ index: 1, function: { arguments: '{"root":"ExampleMod"}' } }] } })));
        await tick();
        res.write(frameText(sseChunk({ model, delta: {}, finish: "tool_calls", usage: { prompt_tokens: 7, completion_tokens: 9, total_tokens: 16 } })));
        await tick();
        res.write("data: [DONE]\n\n");
        res.end();
        return;
      }

      case "fake-tool-noname": {
        sseHead(res);
        res.write(frameText(sseChunk({ model, delta: { tool_calls: [{ index: 0, id: "call_x", function: { arguments: "{}" } }] } })));
        await tick();
        res.write(frameText(sseChunk({ model, delta: {}, finish: "tool_calls" })));
        res.end();
        return;
      }

      case "fake-no-choices":
        return jsonResponse(res, 200, { id: "x", object: "chat.completion", choices: [], usage: null });

      case "fake-error-in-200":
        return jsonResponse(res, 200, { error: { message: "model overloaded for " + TEST_KEY } });

      case "fake-not-json":
        return jsonResponse(res, 200, "{oops not json");

      case "fake-401":
        return jsonResponse(res, 401, { error: { message: "bad key " + TEST_KEY } });

      case "fake-429":
        res.writeHead(429, { "content-type": "application/json", "retry-after": "1" });
        res.end(JSON.stringify({ error: { message: "slow down" } }));
        return;

      case "fake-500":
        return jsonResponse(res, 500, { error: { message: "server on fire" } });

      case "fake-retry": {
        if (count === 1) {
          req.socket.destroy();
          return;
        }
        return jsonResponse(res, 200, jsonCompletion({ model, content: "recovered" }));
      }

      case "fake-loop": {
        if (count === 1) {
          return jsonResponse(
            res,
            200,
            jsonCompletion({
              model,
              finish: "tool_calls",
              toolCalls: [
                {
                  id: "call_1",
                  type: "function",
                  function: { name: "kb.search", arguments: '{"prefix":"Item_","limit":2}' }
                }
              ]
            })
          );
        }
        return jsonResponse(res, 200, jsonCompletion({ model, content: "LOOP DONE" }));
      }

      case "fake-hang": {
        state.hang.add(res);
        // Never answer: the client must time out or be aborted.
        return new Promise(() => {});
      }

      default:
        return jsonResponse(res, 404, { error: { message: "no fake scenario named " + JSON.stringify(model) } });
    }
  }

  const server = createServer((req, res) => {
    req.on("error", () => {});
    readBody(req)
      .then((text) => {
        let body = null;
        try {
          body = JSON.parse(text);
        } catch {
          body = null;
        }
        state.requests.push({ method: req.method, url: req.url, headers: req.headers, body, text });
        return handle(req, res, body);
      })
      .catch((error) => {
        try {
          jsonResponse(res, 500, { error: { message: String(error) } });
        } catch {
          // response already gone
        }
      });
  });

  return new Promise((resolve, reject) => {
    server.on("error", reject);
    server.on("listening", () => {
      const port = server.address().port;
      resolve({
        baseUrl: "http://127.0.0.1:" + port + "/v1",
        state,
        reset() {
          state.requests.length = 0;
          state.counts.clear();
        },
        /** How many requests carried `model`. */
        count(model) {
          return state.counts.get(model) || 0;
        },
        close() {
          for (const res of state.hang) {
            try {
              res.destroy();
            } catch {
              // already gone
            }
          }
          state.hang.clear();
          if (typeof server.closeAllConnections === "function") {
            server.closeAllConnections();
          }
          return new Promise((done) => server.close(() => done()));
        }
      });
    });
    server.listen(0, "127.0.0.1");
  });
}

export function providerFor(server, model, extra = {}) {
  return createProvider({
    baseUrl: server.baseUrl,
    model,
    apiKey: TEST_KEY,
    temperature: 0.2,
    maxTokens: 64,
    timeoutMs: 4000,
    stream: true,
    retryDelayMs: 1,
    ...extra
  });
}

export function messagesUser(text = "hi") {
  return [{ role: "user", content: text }];
}

/** A free port that nothing is listening on (for the connection-refused case). */
export function deadPort() {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.on("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const port = server.address().port;
      server.close(() => resolve(port));
    });
  });
}

/* ------------------------------------------------------------------ */
/* a stand-in for the shell's mod layer                                */
/* ------------------------------------------------------------------ */

export function fakeMods() {
  const calls = [];
  return {
    calls,
    suggest(params) {
      calls.push({ kind: "suggest", params });
      const all = [
        {
          label: "Item_Foo",
          kind: "variable",
          detail: "variable",
          insertText: "Item_Foo",
          documentation: "A label shown in the menu."
        },
        {
          label: "Item_Bar",
          kind: "variable",
          detail: "variable",
          insertText: "Item_Bar",
          documentation: ""
        },
        {
          label: "Item_Baz",
          kind: "variable",
          detail: "variable",
          insertText: "Item_Baz",
          documentation: ""
        }
      ];
      const limit = params && params.opts && Number.isInteger(params.opts.limit) ? params.opts.limit : all.length;
      const items = all.slice(0, limit);
      Object.defineProperty(items, "isIncomplete", { value: true, enumerable: false });
      return items;
    },
    async validatePackage(params) {
      calls.push({ kind: "validate", params });
      return {
        ok: false,
        knowledge: "present",
        manifest: { name: "ExampleMod", displayName: "Example Mod", version: "1.0.0" },
        summary: { errors: 1, warnings: 1 },
        types: [{ name: "command" }, { name: "variable" }],
        diagnostics: [
          {
            severity: "error",
            code: "define.unresolved",
            path: "Scripts/main.cs",
            message: "未知命令 Item_Foo",
            messageEn: "unknown command Item_Foo",
            schemaType: "command"
          },
          {
            severity: "warning",
            code: "mod.manifest",
            path: "mod.json",
            message: "缺少字段",
            messageEn: "missing field"
          }
        ]
      };
    }
  };
}
