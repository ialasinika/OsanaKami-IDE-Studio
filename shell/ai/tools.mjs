/**
 * tools.mjs -- the tools an agent may call, and the rules a tool obeys.
 *
 * A tool here is not a new verb invented for the model: it is a thin, named
 * wrapper around a verb the shell already has.  This slice ships exactly two,
 * both read-only:
 *
 *   kb.search       -> shell/mods/search.js `suggest` (completion candidates)
 *   mod.validate    -> shell/mods/index.js  `validatePackage` (the validator)
 *
 * and the registry refuses to hold anything with `safety: "write"` unless it
 * was created with `allowWrite: true`.  Writes will come later through a diff
 * card; until that exists, the absence is enforced here rather than trusted to
 * a caller.
 *
 * The registry's `openaiTools()` output is exactly the `tools` argument of a
 * chat-completions request, so a model's `tool_calls[].function.arguments` can
 * be parsed and dispatched without a translation layer:
 *
 *     const registry = createToolRegistry({ tools: createReadOnlyTools({ mods, modsRoot }) });
 *     const answer = await provider.stream({ messages, tools: registry.openaiTools() });
 *     const call = answer.message.tool_calls[0];
 *     const outcome = await invokeToolCall(registry, call);
 *     messages.push(answer.message, toolResultMessage(call, outcome));
 *
 * Every path argument is resolved inside a caller-supplied root before a
 * handler sees it: lexical `..`/absolute escape first, then symlink/junction
 * resolution (`modsRoot` is the only root here).  The model cannot name a path
 * outside the sandbox, and cannot name one at all when no root is configured.
 *
 * Node 18+; no dependencies beyond `node:path` / `node:fs`.
 */

import { realpathSync } from "node:fs";
import path from "node:path";

/** The safety labels a tool may carry. */
export const TOOL_SAFETY = Object.freeze(["read-only", "write"]);

/** The complete set of codes a ToolError carries. */
export const TOOL_ERROR_CODES = Object.freeze([
  "invalid_tool",
  "invalid_arguments",
  "unknown_tool",
  "unavailable",
  "path_outside_root",
  "handler_failed"
]);

/** One tool failed in a way the caller (or the model) can branch on. */
export class ToolError extends Error {
  /**
   * @param {string} code
   * @param {string} message
   * @param {{tool?: string|null, detail?: unknown}} [options]
   */
  constructor(code, message, options = {}) {
    super(message);
    this.name = "ToolError";
    this.code = TOOL_ERROR_CODES.includes(code) ? code : "invalid_tool";
    this.tool = typeof options.tool === "string" ? options.tool : null;
    this.detail = options.detail === undefined ? null : options.detail;
  }

  toJSON() {
    return {
      name: this.name,
      code: this.code,
      message: this.message,
      tool: this.tool,
      detail: this.detail
    };
  }
}

/* ------------------------------------------------------------------ */
/* small helpers                                                       */
/* ------------------------------------------------------------------ */

/** @param {unknown} value */
function plainObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

/** @param {unknown} value */
function textOf(value) {
  return typeof value === "string" ? value : "";
}

/** @param {unknown} value @param {number} cap */
function clip(value, cap) {
  const text = textOf(value);
  return text.length <= cap ? text : text.slice(0, cap) + "...";
}

/** @param {unknown} error */
function messageOf(error) {
  if (error && typeof error === "object" && typeof error.message === "string") {
    return error.message;
  }
  return String(error);
}

/** @param {unknown} error @returns {ToolError} */
export function asToolError(error) {
  return error instanceof ToolError
    ? error
    : new ToolError("handler_failed", messageOf(error));
}

/* ------------------------------------------------------------------ */
/* the tool definition                                                 */
/* ------------------------------------------------------------------ */

const TOOL_NAME = /^[a-z][a-z0-9_]*(?:\.[a-z][a-z0-9_]*)*$/;

/**
 * Validate and freeze one tool definition.
 *
 * @param {{
 *   name: string,
 *   description: string,
 *   parameters?: object,
 *   handler: Function,
 *   safety?: "read-only"|"write"
 * }} spec
 * @returns {{name: string, description: string, parameters: object, handler: Function, safety: string, readOnly: boolean}}
 */
export function defineTool(spec) {
  if (!plainObject(spec)) {
    throw new ToolError("invalid_tool", "defineTool: the spec must be an object");
  }
  const name = spec.name;
  if (typeof name !== "string" || !TOOL_NAME.test(name) || name.length > 64) {
    throw new ToolError("invalid_tool", "tool names look like `domain.verb` in lower case: " + JSON.stringify(name));
  }
  const description = textOf(spec.description).trim();
  if (description === "") {
    throw new ToolError("invalid_tool", "tool " + name + ": description is required and is what the model sees");
  }
  if (description.length > 2000) {
    throw new ToolError("invalid_tool", "tool " + name + ": description is longer than 2000 characters");
  }
  if (typeof spec.handler !== "function") {
    throw new ToolError("invalid_tool", "tool " + name + ": handler must be a function");
  }
  let parameters = spec.parameters;
  if (parameters === undefined) {
    parameters = { type: "object", properties: {}, additionalProperties: false };
  }
  if (!plainObject(parameters) || parameters.type !== "object") {
    throw new ToolError("invalid_tool", "tool " + name + ": parameters must be a JSON-schema object with type 'object'");
  }
  const safety = spec.safety === undefined ? "read-only" : spec.safety;
  if (!TOOL_SAFETY.includes(safety)) {
    throw new ToolError("invalid_tool", "tool " + name + ": safety must be 'read-only' or 'write'");
  }
  return Object.freeze({
    name,
    description,
    parameters: detach(parameters),
    handler: spec.handler,
    safety,
    readOnly: safety === "read-only"
  });
}

/** A JSON-pure copy plus a freeze, so a caller cannot mutate a spec later. */
function detach(value) {
  const copy = JSON.parse(JSON.stringify(value));
  return deepFreeze(copy);
}

/** @param {unknown} value @returns {unknown} */
function deepFreeze(value) {
  if (value !== null && typeof value === "object") {
    for (const key of Object.keys(value)) {
      deepFreeze(value[key]);
    }
    Object.freeze(value);
  }
  return value;
}

/* ------------------------------------------------------------------ */
/* argument validation (the JSON-Schema subset a tool may use)         */
/* ------------------------------------------------------------------ */

/**
 * Check `value` against `schema`; returns a list of human-readable problems.
 * Supported: type, properties/required/additionalProperties, items,
 * min/max items, min/max length, pattern, minimum/maximum, enum, const, oneOf.
 *
 * @param {object} schema
 * @param {unknown} value
 * @param {string} [at]
 * @returns {string[]}
 */
export function validateToolArguments(schema, value, at = "arguments") {
  const errors = [];
  check(schema, value, at, errors, 0);
  return errors;
}

function check(schema, value, at, errors, depth) {
  if (depth > 12 || !plainObject(schema)) {
    return;
  }
  if (schema.const !== undefined && !sameValue(schema.const, value)) {
    errors.push(at + " must equal " + JSON.stringify(schema.const));
  }
  if (Array.isArray(schema.enum) && !schema.enum.some((entry) => sameValue(entry, value))) {
    errors.push(at + " must be one of " + JSON.stringify(schema.enum));
  }
  if (Array.isArray(schema.oneOf) && schema.oneOf.length > 0) {
    const matches = schema.oneOf.filter((option) => {
      const inner = [];
      check(option, value, at, inner, depth + 1);
      return inner.length === 0;
    });
    if (matches.length !== 1) {
      errors.push(at + " matches " + matches.length + " of the oneOf alternatives");
    }
  }

  const declared = schema.type;
  const types = declared === undefined ? null : Array.isArray(declared) ? declared : [declared];
  if (types !== null && !types.some((type) => matchesType(type, value))) {
    errors.push(at + " must be " + types.join(" or "));
    return;
  }
  if (value === null || value === undefined) {
    return;
  }

  if (plainObject(value) && (types !== null && types.includes("object"))) {
    const properties = plainObject(schema.properties) ? schema.properties : {};
    if (Array.isArray(schema.required)) {
      for (const key of schema.required) {
        if (!Object.prototype.hasOwnProperty.call(value, key)) {
          errors.push(at + "." + key + " is required");
        }
      }
    }
    for (const key of Object.keys(properties)) {
      if (Object.prototype.hasOwnProperty.call(value, key)) {
        check(properties[key], value[key], at + "." + key, errors, depth + 1);
      }
    }
    if (schema.additionalProperties === false) {
      for (const key of Object.keys(value)) {
        if (!Object.prototype.hasOwnProperty.call(properties, key)) {
          errors.push(at + "." + key + " is not an accepted argument");
        }
      }
    } else if (plainObject(schema.additionalProperties)) {
      for (const key of Object.keys(value)) {
        if (!Object.prototype.hasOwnProperty.call(properties, key)) {
          check(schema.additionalProperties, value[key], at + "." + key, errors, depth + 1);
        }
      }
    }
  }

  if (Array.isArray(value) && (types !== null && types.includes("array"))) {
    if (Number.isInteger(schema.minItems) && value.length < schema.minItems) {
      errors.push(at + " must have at least " + schema.minItems + " items");
    }
    if (Number.isInteger(schema.maxItems) && value.length > schema.maxItems) {
      errors.push(at + " must have at most " + schema.maxItems + " items");
    }
    if (plainObject(schema.items)) {
      value.forEach((item, index) => check(schema.items, item, at + "[" + index + "]", errors, depth + 1));
    }
  }

  if (typeof value === "string") {
    if (Number.isInteger(schema.minLength) && value.length < schema.minLength) {
      errors.push(at + " must be at least " + schema.minLength + " characters");
    }
    if (Number.isInteger(schema.maxLength) && value.length > schema.maxLength) {
      errors.push(at + " must be at most " + schema.maxLength + " characters");
    }
    if (typeof schema.pattern === "string") {
      let regex = null;
      try {
        regex = new RegExp(schema.pattern);
      } catch {
        regex = null;
      }
      if (regex !== null && !regex.test(value)) {
        errors.push(at + " does not match " + JSON.stringify(schema.pattern));
      }
    }
  }

  if (typeof value === "number") {
    if (Number.isFinite(schema.minimum) && value < schema.minimum) {
      errors.push(at + " must be >= " + schema.minimum);
    }
    if (Number.isFinite(schema.maximum) && value > schema.maximum) {
      errors.push(at + " must be <= " + schema.maximum);
    }
  }
}

function matchesType(type, value) {
  switch (type) {
    case "object":
      return plainObject(value);
    case "array":
      return Array.isArray(value);
    case "string":
      return typeof value === "string";
    case "number":
      return typeof value === "number" && Number.isFinite(value);
    case "integer":
      return Number.isInteger(value);
    case "boolean":
      return typeof value === "boolean";
    case "null":
      return value === null;
    default:
      return true;
  }
}

function sameValue(a, b) {
  return JSON.stringify(a) === JSON.stringify(b);
}

/* ------------------------------------------------------------------ */
/* paths                                                               */
/* ------------------------------------------------------------------ */

/**
 * Resolve `target` inside `root`, lexically and then through symlinks; throws
 * `path_outside_root` if either check escapes.  Relative targets are relative
 * to the root, never to the process cwd.
 *
 * @param {string} root absolute sandbox root
 * @param {string} target absolute or root-relative path
 * @param {string} [label] what to call the path in an error message
 * @returns {string} the absolute path inside the root
 */
export function resolveInside(root, target, label = "path") {
  if (typeof root !== "string" || !path.isAbsolute(root)) {
    throw new ToolError("path_outside_root", label + ": the sandbox root is not an absolute path");
  }
  if (typeof target !== "string" || target.trim() === "") {
    throw new ToolError("invalid_arguments", label + " must be a non-empty path");
  }
  if (target.indexOf("\0") >= 0) {
    throw new ToolError("invalid_arguments", label + " must not contain a NUL byte");
  }
  const base = path.resolve(root);
  const resolved = path.isAbsolute(target) ? path.resolve(target) : path.resolve(base, target);
  requireUnder(base, resolved, target, label);

  const realBase = realpathOrNull(base);
  const realTarget = realpathOrNull(resolved);
  if (realBase !== null && realTarget !== null) {
    requireUnder(realBase, realTarget, target, label);
  }
  return resolved;
}

function requireUnder(base, resolved, original, label) {
  const rel = path.relative(base, resolved);
  if (rel === "") {
    return;
  }
  if (rel === ".." || rel.startsWith(".." + path.sep) || path.isAbsolute(rel)) {
    throw new ToolError("path_outside_root", label + " escapes the sandbox: " + original);
  }
}

function realpathOrNull(target) {
  try {
    return typeof realpathSync.native === "function" ? realpathSync.native(target) : realpathSync(target);
  } catch {
    return null;
  }
}

/* ------------------------------------------------------------------ */
/* the registry                                                        */
/* ------------------------------------------------------------------ */

/**
 * @param {{tools?: object[], allowWrite?: boolean}} [options]
 * @returns {{
 *   register: (spec: object) => object,
 *   has: (name: string) => boolean,
 *   get: (name: string) => object|null,
 *   list: () => object[],
 *   openaiTools: () => object[],
 *   invoke: (name: string, args?: object, context?: object) => Promise<unknown>,
 *   size: number
 * }}
 */
export function createToolRegistry(options = {}) {
  const settings = plainObject(options) ? options : {};
  const allowWrite = settings.allowWrite === true;
  const tools = new Map();

  function register(spec) {
    const tool = defineTool(spec);
    if (tools.has(tool.name)) {
      throw new ToolError("invalid_tool", "tool " + tool.name + " is already registered");
    }
    if (tool.safety === "write" && !allowWrite) {
      throw new ToolError(
        "invalid_tool",
        "tool " + tool.name + " is a write tool; this registry is read-only (writes go through a diff card)"
      );
    }
    tools.set(tool.name, tool);
    return tool;
  }

  function list() {
    return [...tools.values()].map((tool) => ({
      name: tool.name,
      description: tool.description,
      parameters: tool.parameters,
      safety: tool.safety
    }));
  }

  const registry = {
    get size() {
      return tools.size;
    },
    register,
    has(name) {
      return typeof name === "string" && tools.has(name);
    },
    get(name) {
      return typeof name === "string" && tools.has(name) ? tools.get(name) : null;
    },
    list,
    openaiTools() {
      return [...tools.values()].map((tool) => ({
        type: "function",
        function: {
          name: tool.name,
          description: tool.description,
          parameters: tool.parameters
        }
      }));
    },
    /**
     * Validate the arguments, run the handler, and guarantee a JSON-serializable
     * result (tool output becomes the next message; it must survive JSON).
     */
    async invoke(name, args, context = {}) {
      const tool = registry.get(name);
      if (tool === null) {
        throw new ToolError("unknown_tool", "there is no tool named " + JSON.stringify(String(name)));
      }
      const value = args === undefined || args === null ? {} : args;
      if (!plainObject(value)) {
        throw new ToolError("invalid_arguments", "tool " + name + ": arguments must be an object", { tool: name });
      }
      const problems = validateToolArguments(tool.parameters, value);
      if (problems.length > 0) {
        throw new ToolError("invalid_arguments", "tool " + name + ": " + problems[0], {
          tool: name,
          detail: problems
        });
      }
      let result;
      try {
        result = await tool.handler(value, plainObject(context) ? context : {});
      } catch (error) {
        const wrapped = asToolError(error);
        if (wrapped !== error) {
          throw new ToolError("handler_failed", "tool " + name + " failed: " + messageOf(error), { tool: name });
        }
        throw wrapped;
      }
      try {
        JSON.stringify(result);
      } catch {
        throw new ToolError("handler_failed", "tool " + name + " returned a value that is not JSON-serializable", {
          tool: name
        });
      }
      return result;
    }
  };

  const initial = settings.tools === undefined ? [] : settings.tools;
  if (!Array.isArray(initial)) {
    throw new ToolError("invalid_tool", "createToolRegistry: tools must be an array");
  }
  for (const spec of initial) {
    register(spec);
  }
  return registry;
}

/* ------------------------------------------------------------------ */
/* tool calls as they arrive from a model                              */
/* ------------------------------------------------------------------ */

/**
 * Parse `{id, type, function:{name, arguments}}` into a dispatchable call.
 * `arguments` is a JSON string on the wire (models stream it that way); an
 * already-parsed object is accepted too, for a hand-built call.
 *
 * @param {unknown} call
 * @returns {{name: string, raw: string, args: object}}
 */
export function parseToolArguments(call) {
  if (!plainObject(call) || !plainObject(call.function)) {
    throw new ToolError("invalid_arguments", "a tool call must have a function object");
  }
  const name = textOf(call.function.name);
  if (name === "") {
    throw new ToolError("invalid_arguments", "a tool call must name a function");
  }
  const raw = call.function.arguments;
  if (raw === undefined || raw === null || raw === "") {
    return { name, raw: "", args: {} };
  }
  if (plainObject(raw)) {
    return { name, raw: JSON.stringify(raw), args: raw };
  }
  if (typeof raw !== "string") {
    throw new ToolError("invalid_arguments", "tool call " + name + ": arguments must be a JSON string", { tool: name });
  }
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    throw new ToolError("invalid_arguments", "tool call " + name + ": arguments are not JSON (" + messageOf(error) + ")", {
      tool: name,
      detail: clip(raw, 500)
    });
  }
  if (!plainObject(parsed)) {
    throw new ToolError("invalid_arguments", "tool call " + name + ": arguments must be a JSON object", {
      tool: name,
      detail: clip(raw, 500)
    });
  }
  return { name, raw, args: parsed };
}

/**
 * Parse, validate, invoke -- and never throw at the caller: the outcome is a
 * plain object suitable for the next `role: "tool"` message.
 *
 * @param {ReturnType<typeof createToolRegistry>} registry
 * @param {unknown} call
 * @param {object} [context]
 * @returns {Promise<{ok: boolean, name: string, result?: unknown, error?: object}>}
 */
export async function invokeToolCall(registry, call, context = {}) {
  const fallbackName = plainObject(call) && plainObject(call.function) ? textOf(call.function.name) : "";
  let parsed;
  try {
    parsed = parseToolArguments(call);
  } catch (error) {
    return { ok: false, name: fallbackName, error: asToolError(error).toJSON() };
  }
  try {
    const result = await registry.invoke(parsed.name, parsed.args, context);
    return { ok: true, name: parsed.name, result };
  } catch (error) {
    return { ok: false, name: parsed.name, error: asToolError(error).toJSON() };
  }
}

/**
 * The `role: "tool"` message that answers one call.
 * @param {unknown} call
 * @param {{ok: boolean, name: string, result?: unknown, error?: object}} outcome
 * @returns {{role: "tool", tool_call_id: string, content: string}}
 */
export function toolResultMessage(call, outcome) {
  const id = plainObject(call) && typeof call.id === "string" ? call.id : "";
  const payload = outcome.ok === true ? outcome.result : { error: outcome.error };
  return {
    role: "tool",
    tool_call_id: id,
    content: JSON.stringify(payload === undefined ? null : payload)
  };
}

/* ------------------------------------------------------------------ */
/* the two read-only tools                                             */
/* ------------------------------------------------------------------ */

const KB_CONTEXTS =
  "command|function|variable|node|tag|character|defineType|defineRef:<TypeName>";

/**
 * Build the read-only tools for this slice.
 *
 * @param {{
 *   mods?: {suggest?: Function, validatePackage?: Function}|null,
 *   modsRoot?: string|null,
 *   defaultLimit?: number,
 *   maxLimit?: number,
 *   defaultDiagnostics?: number,
 *   maxDiagnostics?: number
 * }} [options]
 * @returns {object[]} definitions ready for `createToolRegistry({tools})`
 */
export function createReadOnlyTools(options = {}) {
  const settings = plainObject(options) ? options : {};
  const mods = settings.mods === undefined ? null : settings.mods;
  const modsRoot =
    typeof settings.modsRoot === "string" && settings.modsRoot !== "" ? path.resolve(settings.modsRoot) : null;
  const defaultLimit = clampInt(settings.defaultLimit, 1, 100, 8);
  const maxLimit = clampInt(settings.maxLimit, defaultLimit, 200, 20);
  const defaultDiagnostics = clampInt(settings.defaultDiagnostics, 0, 200, 50);
  const maxDiagnostics = clampInt(settings.maxDiagnostics, defaultDiagnostics, 500, 200);

  const kbSearch = defineTool({
    name: "kb.search",
    description:
      "Look up knowledge-base completion candidates (script commands, functions, variables, nodes, tags, " +
      "characters, type definitions) by the prefix the user has typed. Read-only; returns at most " +
      maxLimit +
      " items, each with a label, a kind and a short snippet of documentation. Use it before writing a " +
      "command or a define reference so the name exists in this game version.",
    parameters: {
      type: "object",
      properties: {
        prefix: {
          type: "string",
          maxLength: 200,
          description: "The text typed so far, e.g. 'Item_' or 'Set'."
        },
        context: {
          type: "string",
          maxLength: 200,
          description: "One of " + KB_CONTEXTS + ". Omit for any."
        },
        limit: {
          type: "integer",
          minimum: 1,
          maximum: maxLimit,
          description: "How many candidates to return (default " + defaultLimit + ")."
        }
      },
      required: ["prefix"],
      additionalProperties: false
    },
    handler: async (args) => {
      if (mods === null || typeof mods.suggest !== "function") {
        throw new ToolError("unavailable", "kb.search: the mod/search layer is not loaded");
      }
      const limit = args.limit === undefined ? defaultLimit : args.limit;
      let raw;
      try {
        raw = mods.suggest({ prefix: args.prefix, context: args.context, opts: { limit } });
      } catch (error) {
        throw new ToolError("handler_failed", "kb.search: the search layer threw: " + messageOf(error));
      }
      const items = Array.isArray(raw) ? raw.slice(0, limit) : [];
      return {
        prefix: args.prefix,
        context: args.context === undefined ? "" : args.context,
        count: items.length,
        isIncomplete: raw !== null && typeof raw === "object" && raw.isIncomplete === true,
        items: items.map((item) => ({
          label: clip(item && item.label, 120),
          kind: clip(item && item.kind, 40),
          detail: clip(item && item.detail, 200),
          insertText: clip(item && item.insertText, 120),
          documentation: clip(item && item.documentation, 400)
        }))
      };
    }
  });

  const modValidate = defineTool({
    name: "mod.validate",
    description:
      "Run the IDE's own mod-package validator on a Mod folder (a folder that contains mod.json) and " +
      "return its diagnostics. Read-only: it never writes, and it reports the same codes the Problems " +
      "view shows. Use it after proposing edits, so the answer is the validator's, not the model's.",
    parameters: {
      type: "object",
      properties: {
        root: {
          type: "string",
          minLength: 1,
          maxLength: 1024,
          description: "The Mod folder to validate, relative to the configured mods root or absolute inside it."
        },
        maxDiagnostics: {
          type: "integer",
          minimum: 0,
          maximum: maxDiagnostics,
          description: "How many diagnostics to include (default " + defaultDiagnostics + ")."
        }
      },
      required: ["root"],
      additionalProperties: false
    },
    handler: async (args) => {
      if (mods === null || typeof mods.validatePackage !== "function") {
        throw new ToolError("unavailable", "mod.validate: the mod layer is not loaded");
      }
      let root;
      if (modsRoot !== null) {
        root = resolveInside(modsRoot, args.root, "root");
      } else {
        if (!path.isAbsolute(args.root)) {
          throw new ToolError(
            "path_outside_root",
            "mod.validate: root must be absolute unless the mods root is configured"
          );
        }
        root = path.resolve(args.root);
      }
      let result;
      try {
        result = await mods.validatePackage({ root });
      } catch (error) {
        throw new ToolError("handler_failed", "mod.validate: the validator threw: " + messageOf(error));
      }
      if (!plainObject(result)) {
        throw new ToolError("handler_failed", "mod.validate: the validator returned no result");
      }
      const diagnostics = Array.isArray(result.diagnostics) ? result.diagnostics : [];
      const cap = args.maxDiagnostics === undefined ? defaultDiagnostics : args.maxDiagnostics;
      const picked = diagnostics.slice(0, cap).map((diagnostic) => ({
        severity: textOf(diagnostic && diagnostic.severity),
        code: textOf(diagnostic && diagnostic.code),
        path: textOf(diagnostic && diagnostic.path),
        message: textOf((diagnostic && (diagnostic.messageEn || diagnostic.message)) || ""),
        schemaType: textOf(diagnostic && diagnostic.schemaType)
      }));
      return {
        root,
        ok: !!result.ok,
        knowledge: result.knowledge === "present" ? "present" : "missing",
        manifest: summarizeManifest(result.manifest),
        summary: result.summary === undefined ? null : result.summary,
        typeCount: Array.isArray(result.types) ? result.types.length : null,
        diagnostics: picked,
        diagnosticsTotal: diagnostics.length,
        truncated: diagnostics.length > picked.length
      };
    }
  });

  return [kbSearch, modValidate];
}

function summarizeManifest(manifest) {
  if (!plainObject(manifest)) {
    return null;
  }
  const out = {};
  for (const key of ["name", "displayName", "version", "author"]) {
    if (typeof manifest[key] === "string" && manifest[key] !== "") {
      out[key] = clip(manifest[key], 200);
    }
  }
  return out;
}

function clampInt(value, min, max, fallback) {
  if (!Number.isInteger(value)) {
    return fallback;
  }
  return Math.min(max, Math.max(min, value));
}
