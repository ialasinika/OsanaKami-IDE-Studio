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

/* ------------------------------------------------------------------ */
/* harness                                                             */
/* ------------------------------------------------------------------ */

let passed = 0;
let failed = 0;
let skipped = 0;
const failures = [];

function section(title) {
  process.stdout.write("\n" + title + "\n");
}

function ok(name) {
  passed += 1;
  process.stdout.write("  ok   " + name + "\n");
}

function fail(name, detail) {
  failed += 1;
  failures.push({ name, detail });
  process.stdout.write("  FAIL " + name + " -- " + detail + "\n");
}

function describeError(error) {
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

async function check(name, fn) {
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

const TEST_KEY = "sk-test-key-do-not-print";

function jsonCompletion(options = {}) {
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

function sseChunk(options = {}) {
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

function frameText(object) {
  return "data: " + JSON.stringify(object) + "\n\n";
}

function jsonResponse(res, status, object) {
  const body = typeof object === "string" ? object : JSON.stringify(object);
  res.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "content-length": Buffer.byteLength(body)
  });
  res.end(body);
}

function sseHead(res) {
  res.writeHead(200, {
    "content-type": "text/event-stream; charset=utf-8",
    "cache-control": "no-cache",
    connection: "keep-alive"
  });
}

function tick(ms = 2) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Read the whole request body as text. */
function readBody(req) {
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

function startFakeServer() {
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

function providerFor(server, model, extra = {}) {
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

function messagesUser(text = "hi") {
  return [{ role: "user", content: text }];
}

/** A free port that nothing is listening on (for the connection-refused case). */
function deadPort() {
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

function fakeMods() {
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

/* ---------------------------- config ------------------------------ */

async function runConfigSection(tempRoot) {
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

/* ---------------------------- settings ---------------------------- */

async function runSettingsSection(tempRoot) {
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
      skipped += 1;
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

/* ---------------------------- wire -------------------------------- */

async function runWireSection(server) {
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

/* ---------------------------- replies ----------------------------- */

async function runReplySection(server) {
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

/* ---------------------------- stream ------------------------------ */

async function runStreamSection(server) {
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

/* ---------------------------- registry ---------------------------- */

async function runRegistrySection(tempRoot) {
  section("registry: named verbs, validated arguments, a real sandbox");

  await check("defineTool rejects a malformed definition", () => {
    assert.throws(() => defineTool({ name: "Bad Name", description: "x", handler() {} }), ToolError);
    assert.throws(() => defineTool({ name: "kb.search", description: "", handler() {} }), ToolError);
    assert.throws(() => defineTool({ name: "kb.search", description: "x", handler: "no" }), ToolError);
    assert.throws(() => defineTool({ name: "kb.search", description: "x", handler() {}, safety: "teleport" }), ToolError);
  });

  await check("a definition is frozen and read-only by default", () => {
    const tool = defineTool({ name: "kb.search", description: "x", handler() {} });
    assert.equal(tool.safety, "read-only");
    assert.equal(tool.readOnly, true);
    assert.throws(() => {
      tool.parameters.properties = {};
    }, TypeError);
  });

  await check("the registry refuses a write tool unless it was built for writes", () => {
    const writeTool = defineTool({ name: "mod.write", description: "x", handler() {}, safety: "write" });
    assert.throws(() => createToolRegistry({ tools: [writeTool] }), ToolError);
    const writable = createToolRegistry({ tools: [writeTool], allowWrite: true });
    assert.equal(writable.size, 1);
  });

  await check("the registry refuses a duplicate name", () => {
    const tool = defineTool({ name: "kb.search", description: "x", handler() {} });
    assert.throws(() => createToolRegistry({ tools: [tool, tool] }), ToolError);
  });

  await check("openaiTools() is exactly the tools array of a request", () => {
    const registry = createToolRegistry({ tools: createReadOnlyTools({ mods: fakeMods(), modsRoot: null }) });
    const wire = registry.openaiTools();
    assert.equal(wire.length, 2);
    for (const entry of wire) {
      assert.equal(entry.type, "function");
      assert.equal(typeof entry.function.name, "string");
      assert.equal(typeof entry.function.description, "string");
      assert.equal(entry.function.parameters.type, "object");
    }
    assert.deepEqual(registry.list().map((entry) => entry.name), ["kb.search", "mod.validate"]);
  });

  await check("validateToolArguments reports what is wrong", () => {
    const schema = {
      type: "object",
      properties: {
        prefix: { type: "string", minLength: 1, maxLength: 5 },
        limit: { type: "integer", minimum: 1, maximum: 3 },
        mode: { type: "string", enum: ["a", "b"] }
      },
      required: ["prefix"],
      additionalProperties: false
    };
    assert.deepEqual(validateToolArguments(schema, { prefix: "x" }), []);
    assert.equal(validateToolArguments(schema, {}).length, 1);
    assert.match(validateToolArguments(schema, {}).join(" "), /prefix is required/);
    assert.match(validateToolArguments(schema, { prefix: "x", limit: 9 }).join(" "), /limit/);
    assert.match(validateToolArguments(schema, { prefix: "x", limit: 1.5 }).join(" "), /integer/);
    assert.match(validateToolArguments(schema, { prefix: "toolong" }).join(" "), /at most 5/);
    assert.match(validateToolArguments(schema, { prefix: "x", mode: "c" }).join(" "), /one of/);
    assert.match(validateToolArguments(schema, { prefix: "x", surprise: 1 }).join(" "), /not an accepted argument/);
  });

  await check("invoke dispatches, and refuses the unknown and the invalid", async () => {
    const mods = fakeMods();
    const registry = createToolRegistry({ tools: createReadOnlyTools({ mods, modsRoot: null }) });
    await assert.rejects(() => registry.invoke("kb.wat", {}), (error) => error instanceof ToolError && error.code === "unknown_tool");
    await assert.rejects(
      () => registry.invoke("kb.search", { prefix: "x", limit: 999 }),
      (error) => error instanceof ToolError && error.code === "invalid_arguments"
    );
  });

  await check("a throwing or non-JSON handler becomes handler_failed", async () => {
    const registry = createToolRegistry({
      tools: [
        defineTool({ name: "test.broken", description: "x", handler() { throw new Error("boom"); } }),
        defineTool({
          name: "test.circular",
          description: "x",
          handler() {
            const loop = { ok: true };
            loop.self = loop;
            return loop;
          }
        })
      ]
    });
    await assert.rejects(() => registry.invoke("test.broken", {}), (error) => error instanceof ToolError && error.code === "handler_failed");
    await assert.rejects(
      () => registry.invoke("test.circular", {}),
      (error) => error instanceof ToolError && error.code === "handler_failed"
    );
  });

  await check("kb.search wraps suggest and clips what it returns", async () => {
    const mods = fakeMods();
    const registry = createToolRegistry({ tools: createReadOnlyTools({ mods, modsRoot: null }) });
    const result = await registry.invoke("kb.search", { prefix: "Item_", context: "variable", limit: 2 });
    assert.equal(result.count, 2);
    assert.equal(result.isIncomplete, true);
    assert.equal(result.items[0].label, "Item_Foo");
    assert.equal(result.items.length, 2);
    const call = mods.calls.find((entry) => entry.kind === "suggest");
    assert.deepEqual(call.params, { prefix: "Item_", context: "variable", opts: { limit: 2 } });
  });

  await check("kb.search says unavailable when the mod layer is missing", async () => {
    const registry = createToolRegistry({ tools: createReadOnlyTools({ mods: null }) });
    await assert.rejects(() => registry.invoke("kb.search", { prefix: "x" }), (error) => error instanceof ToolError && error.code === "unavailable");
  });

  await check("mod.validate runs the real validator and maps its diagnostics", async () => {
    const modsRoot = path.join(tempRoot, "mods-root");
    const mods = fakeMods();
    const registry = createToolRegistry({ tools: createReadOnlyTools({ mods, modsRoot }) });
    const result = await registry.invoke("mod.validate", { root: "ExampleMod" });
    assert.equal(result.root, path.join(modsRoot, "ExampleMod"));
    assert.equal(result.ok, false);
    assert.equal(result.knowledge, "present");
    assert.equal(result.manifest.name, "ExampleMod");
    assert.equal(result.typeCount, 2);
    assert.equal(result.diagnosticsTotal, 2);
    assert.equal(result.truncated, false);
    assert.equal(result.diagnostics[0].code, "define.unresolved");
    assert.equal(result.diagnostics[0].message, "unknown command Item_Foo", "English message preferred");
    assert.equal(result.diagnostics[0].path, "Scripts/main.cs");
    assert.equal(result.diagnostics[1].message, "missing field");
    const call = mods.calls.find((entry) => entry.kind === "validate");
    assert.deepEqual(call.params, { root: path.join(modsRoot, "ExampleMod") });
  });

  await check("mod.validate truncates a long diagnostic list", async () => {
    const mods = fakeMods();
    mods.validatePackage = async () => ({
      ok: false,
      knowledge: "missing",
      manifest: null,
      summary: { errors: 120 },
      types: [],
      diagnostics: Array.from({ length: 120 }, (_, index) => ({
        severity: "error",
        code: "define.missing",
        path: "a.cs",
        message: "missing " + index,
        messageEn: "missing " + index
      }))
    });
    const registry = createToolRegistry({ tools: createReadOnlyTools({ mods, modsRoot: tempRoot }) });
    const result = await registry.invoke("mod.validate", { root: "ExampleMod" });
    assert.equal(result.diagnostics.length, 50);
    assert.equal(result.diagnosticsTotal, 120);
    assert.equal(result.truncated, true);
  });

  await check("mod.validate refuses a path outside the mods root", async () => {
    const mods = fakeMods();
    const registry = createToolRegistry({ tools: createReadOnlyTools({ mods, modsRoot: path.join(tempRoot, "mods-root") }) });
    await assert.rejects(
      () => registry.invoke("mod.validate", { root: "../outside" }),
      (error) => error instanceof ToolError && error.code === "path_outside_root"
    );
    await assert.rejects(
      () => registry.invoke("mod.validate", { root: path.join(tempRoot, "elsewhere") }),
      (error) => error instanceof ToolError && error.code === "path_outside_root"
    );
  });

  await check("without a mods root, mod.validate requires an absolute path", async () => {
    const mods = fakeMods();
    const registry = createToolRegistry({ tools: createReadOnlyTools({ mods, modsRoot: null }) });
    await assert.rejects(
      () => registry.invoke("mod.validate", { root: "ExampleMod" }),
      (error) => error instanceof ToolError && error.code === "path_outside_root"
    );
    const absolute = await registry.invoke("mod.validate", { root: path.join(tempRoot, "ExampleMod") });
    assert.equal(absolute.root, path.join(tempRoot, "ExampleMod"));
  });

  await check("resolveInside allows inside paths and refuses escapes", () => {
    const root = path.join(tempRoot, "sandbox");
    assert.equal(resolveInside(root, "a/b.cs"), path.join(root, "a", "b.cs"));
    assert.equal(resolveInside(root, path.join(root, "a", "b.cs")), path.join(root, "a", "b.cs"));
    assert.equal(resolveInside(root, "a/../b.cs"), path.join(root, "b.cs"));
    assert.throws(() => resolveInside(root, "../escape.cs"), (error) => error instanceof ToolError && error.code === "path_outside_root");
    assert.throws(() => resolveInside(root, ".."), (error) => error instanceof ToolError && error.code === "path_outside_root");
    assert.throws(() => resolveInside(root, ""), (error) => error instanceof ToolError && error.code === "invalid_arguments");
    assert.throws(() => resolveInside(path.relative(process.cwd(), root), "a"), (error) => error instanceof ToolError && error.code === "path_outside_root");
  });

  await check("a symlink inside the sandbox may not point out of it", () => {
    const root = path.join(tempRoot, "sandbox-link");
    const outside = path.join(tempRoot, "outside-dir");
    rmSync(root, { recursive: true, force: true });
    rmSync(outside, { recursive: true, force: true });
    mkdirSync(root, { recursive: true });
    mkdirSync(outside, { recursive: true });
    writeFileSync(path.join(outside, "secret.cs"), "secret", "utf8");
    try {
      symlinkSync(outside, path.join(root, "escape-link"), "junction");
    } catch (error) {
      skipped += 1;
      process.stdout.write("  skip a symlink inside the sandbox may not point out of it -- " + describeError(error) + "\n");
      return;
    }
    assert.throws(
      () => resolveInside(root, "escape-link/secret.cs"),
      (error) => error instanceof ToolError && error.code === "path_outside_root"
    );
  });

  await check("parseToolArguments accepts a JSON string or a parsed object", () => {
    const fromString = parseToolArguments({ id: "c", type: "function", function: { name: "kb.search", arguments: '{"prefix":"I"}' } });
    assert.deepEqual(fromString.args, { prefix: "I" });
    const fromObject = parseToolArguments({ function: { name: "kb.search", arguments: { prefix: "I" } } });
    assert.deepEqual(fromObject.args, { prefix: "I" });
    const empty = parseToolArguments({ function: { name: "kb.search" } });
    assert.deepEqual(empty.args, {});
    assert.throws(() => parseToolArguments({ function: { name: "kb.search", arguments: "{oops" } }), (error) => error.code === "invalid_arguments");
  });

  await check("invokeToolCall never throws and reports a refusal as data", async () => {
    const registry = createToolRegistry({ tools: createReadOnlyTools({ mods: fakeMods(), modsRoot: null }) });
    const bad = await invokeToolCall(registry, { id: "c1", type: "function", function: { name: "kb.search", arguments: "{oops" } });
    assert.equal(bad.ok, false);
    assert.equal(bad.error.code, "invalid_arguments");
    const unknown = await invokeToolCall(registry, { function: { name: "nope.nope", arguments: "{}" } });
    assert.equal(unknown.ok, false);
    assert.equal(unknown.error.code, "unknown_tool");
    const good = await invokeToolCall(registry, { id: "c2", type: "function", function: { name: "kb.search", arguments: '{"prefix":"I"}' } });
    assert.equal(good.ok, true);
    assert.equal(good.result.count, 3);
  });

  await check("toolResultMessage is a role:tool message with the call id", () => {
    const message = toolResultMessage({ id: "call_7" }, { ok: true, name: "kb.search", result: { count: 1 } });
    assert.equal(message.role, "tool");
    assert.equal(message.tool_call_id, "call_7");
    assert.deepEqual(JSON.parse(message.content), { count: 1 });
    const failure = toolResultMessage({ id: "call_8" }, { ok: false, name: "x", error: { code: "invalid_arguments", message: "no" } });
    assert.equal(JSON.parse(failure.content).error.code, "invalid_arguments");
  });

  await check("tool error codes are the documented set", () => {
    assert.deepEqual(TOOL_ERROR_CODES, [
      "invalid_tool",
      "invalid_arguments",
      "unknown_tool",
      "unavailable",
      "path_outside_root",
      "handler_failed"
    ]);
  });
}

/* ---------------------------- loop -------------------------------- */

async function runLoopSection(server, tempRoot) {
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

/* ------------------------------------------------------------------ */
/* run                                                                 */
/* ------------------------------------------------------------------ */

main().catch((error) => {
  process.stderr.write("shell/ai selftest crashed: " + (error && error.stack ? error.stack : String(error)) + "\n");
  process.exitCode = 1;
});
