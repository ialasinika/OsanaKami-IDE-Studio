import { section, ok, describeError, check, skip } from "./harness.mjs";
import { fakeMods } from "./fixtures.mjs";
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

/* ---------------------------- registry ---------------------------- */

export async function runRegistrySection(tempRoot) {
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
      skip();
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
