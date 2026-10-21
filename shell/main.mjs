#!/usr/bin/env node
/**
 * main.mjs -- the shell's entry point, and the only Node file the user runs.
 *
 * The kernel speaks newline-delimited JSON-RPC on stdio and knows nothing
 * about languages and nothing about HTTP.  This file supplies both halves of
 * that gap, in one process, with no dependencies at all:
 *
 *   infantgod rpc      a stdio front end.  It spawns `build/infantgod.exe rpc`, forwards
 *                  every frame the kernel understands, and answers `lang.list`
 *                  and `lang.tokenize` itself.  This is the "full endpoint"
 *                  that `tools/e2e.py --kernel-cmd` drives, and the reason the
 *                  test can exercise the language layer without a browser.
 *
 *   infantgod serve    an HTTP front end: static files from `shell/web/` plus
 *                  `POST /rpc` and `GET /events` (SSE).  Then it launches the
 *                  system's Edge/Chromium in --app= mode.  No Electron, no
 *                  bundled Chromium, nothing to download.
 *
 *   infantgod validate DIR  the mod layer alone: validate one package (or every
 *                  package under a mods root) and print the diagnostics, with
 *                  --json for a machine.  No kernel, no window.  A review pass
 *                  and CI can run it against a mod someone sent them.
 *
 * Both modes share one `dispatch()` so the wire behaviour cannot drift between
 * them.
 *
 * Design note: language support is loaded with a *dynamic* import inside a
 * try/catch.  `rm -rf langs/` must leave a shell that still starts and still
 * serves the board -- it just renders plain text.
 */

import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { existsSync, statSync, mkdtempSync, readdirSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import readline from "node:readline";
import { fileURLToPath, pathToFileURL } from "node:url";

import { createConfigStore, defaultUserDataDir, describeConfig } from "./ai/config.mjs";
import { createProvider } from "./ai/provider.mjs";
import { createPreferenceStore } from "./ai/settings.mjs";
import { createReadOnlyTools, createToolRegistry, invokeToolCall } from "./ai/tools.mjs";

const SHELL_DIR = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.dirname(SHELL_DIR);
const WEB_DIR = path.join(SHELL_DIR, "web");
const LANGS_DIR = path.join(ROOT, "langs");
const MODS_DIR = path.join(SHELL_DIR, "mods");

const SHELL_VERSION = "0.1.3-beta";
const DEFAULT_KERNEL = process.platform === "win32"
  ? path.join(ROOT, "build", "infantgod.exe")
  : path.join(ROOT, "build", "infantgod");

/*
 * How long a single kernel call may take before this side gives up waiting.
 * It is a patience limit, not a deadline: nothing is cancelled at the other
 * end.  A view document can be large, and a fork that raises the ceiling (many
 * thousands of cards, a slow disk) should be able to say so with
 * --timeout-ms rather than by editing this file.
 */
const DEFAULT_TIMEOUT_MS = 30000;

/* ------------------------------------------------------------------ */
/* errors                                                              */
/* ------------------------------------------------------------------ */

/** A JSON-RPC error object, from the kernel or from this process. */
export class RpcError extends Error {
  constructor(error, method, transport = null) {
    const e = error && typeof error === "object" ? error : {};
    super(e.message ? String(e.message) : `rpc ${method} failed`);
    this.name = "RpcError";
    this.code = e.code ?? -32603;
    this.rpcName = e.name ?? "INTERNAL";
    this.data = e.data;
    this.method = method;
    this.transport = transport;
  }

  toJSON() {
    const error = { code: this.code, name: this.rpcName, message: this.message };
    if (this.data !== undefined) error.data = this.data;
    return error;
  }
}

/* ------------------------------------------------------------------ */
/* kernel link                                                         */
/* ------------------------------------------------------------------ */

/**
 * One child process, one id space, one promise per in-flight request.
 *
 * Ids are minted here (`h1`, `h2`, ...) rather than taken from the caller, so
 * a stdio client may reuse ids freely and still get the right answers back.
 */
export class Kernel {
  #child = null;
  #pending = new Map();
  #nextId = 1;
  #listeners = new Set();
  #exit = null;
  #stderr = null;

  constructor({
    exe = DEFAULT_KERNEL,
    workspace = process.cwd(),
    readRoots = [],
    verbose = false,
    timeoutMs = DEFAULT_TIMEOUT_MS,
  } = {}) {
    this.exe = exe;
    this.workspace = workspace;
    this.readRoots = [...readRoots];
    this.verbose = verbose;
    this.timeoutMs = timeoutMs;
  }

  get running() {
    return this.#child !== null && this.#exit === null;
  }

  onNotification(fn) {
    this.#listeners.add(fn);
    return () => this.#listeners.delete(fn);
  }

  #emit(event) {
    for (const fn of this.#listeners) {
      try {
        fn(event);
      } catch (err) {
        this.#log(`notification listener threw: ${err && err.message}`);
      }
    }
  }

  #log(message) {
    this.#emit({ event: "log", level: "warn", message: String(message) });
  }

  /** Spawns the kernel and proves it is alive with a `hello` round trip. */
  async start() {
    if (!existsSync(this.exe)) {
      throw new RpcError(
        { code: -32000, name: "KERNEL_MISSING", message: `no kernel at ${this.exe} -- run: mingw32-make -f Makefile` },
        "start",
        "spawn",
      );
    }

    /*
     * Read-only roots are the kernel's own containment decision, so they go on
     * the kernel's command line rather than being enforced here: the kernel is
     * the only place that knows which verbs read and which write.
     */
    const args = ["rpc", "--root", this.workspace];
    for (const dir of this.readRoots) args.push("--read-root", dir);
    const child = spawn(this.exe, args, {
      stdio: ["pipe", "pipe", "pipe"],
      windowsHide: true,
    });
    this.#child = child;

    const rl = readline.createInterface({ input: child.stdout, crlfDelay: Infinity });
    rl.on("line", (line) => this.#onLine(line));

    this.#stderr = readline.createInterface({ input: child.stderr, crlfDelay: Infinity });
    this.#stderr.on("line", (line) => {
      if (this.verbose) process.stderr.write(`[kernel] ${line}\n`);
    });

    child.on("error", (err) => {
      this.#exit = { code: null, signal: null, error: err };
      this.#failAll(new RpcError(
        { code: -32000, name: "KERNEL_GONE", message: `cannot run ${this.exe}: ${err.message}` },
        "start",
        "spawn",
      ));
    });

    child.on("exit", (code, signal) => {
      this.#exit = { code, signal };
      this.#failAll(new RpcError(
        { code: -32000, name: "KERNEL_GONE", message: `the kernel exited (code ${code}, signal ${signal})` },
        "exit",
        "transport",
      ));
    });

    await this.call("hello");
    return this;
  }

  #onLine(line) {
    const text = line.trim();
    if (text === "") return;

    let frame;
    try {
      frame = JSON.parse(text);
    } catch {
      this.#log(`unparsable kernel frame: ${text.slice(0, 200)}`);
      return;
    }

    if (frame === null || typeof frame !== "object") {
      this.#log("non-object kernel frame");
      return;
    }

    if (frame.event !== undefined) {
      this.#emit(frame);
      return;
    }

    const id = frame.id;
    if (id !== undefined && id !== null && this.#pending.has(id)) {
      const waiter = this.#pending.get(id);
      this.#pending.delete(id);
      clearTimeout(waiter.timer);
      if (frame.error) {
        waiter.reject(new RpcError(frame.error, waiter.method));
      } else {
        waiter.resolve(frame.result);
      }
      return;
    }

    // A parse error the kernel raised on a frame it could not read at all, so
    // it could not carry an id back.  The kernel reads frames one at a time, so
    // this belongs to the oldest call still waiting: settling it here turns a
    // silent 30-second hang into the error that actually happened.
    if (frame.error) {
      const oldest = this.#pending.keys().next();
      if (!oldest.done) {
        const waiter = this.#pending.get(oldest.value);
        this.#pending.delete(oldest.value);
        clearTimeout(waiter.timer);
        waiter.reject(new RpcError(frame.error, waiter.method));
        return;
      }
      this.#log(frame.error.message ? String(frame.error.message) : "kernel reported an error with no request id");
      return;
    }
    this.#log("kernel sent a response for an unknown id");
  }

  #failAll(error) {
    for (const [, waiter] of this.#pending) {
      clearTimeout(waiter.timer);
      waiter.reject(error);
    }
    this.#pending.clear();
  }

  call(method, params, { timeoutMs = this.timeoutMs } = {}) {
    if (!this.running) {
      return Promise.reject(new RpcError(
        { code: -32000, name: "KERNEL_GONE", message: "the kernel is not running" },
        method,
        "transport",
      ));
    }

    const id = `h${this.#nextId++}`;
    const frame = { jsonrpc: "2.0", id, method };
    if (params !== undefined) frame.params = params;

    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.#pending.delete(id);
        /*
         * A timeout here is a statement about this side's patience, not about
         * the kernel's state: the request is not cancelled and the kernel may
         * still be working on it.  Saying only "did not answer" invites the
         * caller to treat the operation as failed and retry it into a kernel
         * that is still busy with the first attempt.
         */
        reject(new RpcError(
          {
            code: -32001,
            name: "TIMEOUT",
            message: `${method} did not answer within ${timeoutMs} ms. `
              + "The request was not cancelled and the kernel may still be "
              + "working on it; raise the limit with --timeout-ms.",
          },
          method,
          "timeout",
        ));
      }, timeoutMs);
      timer.unref?.();

      this.#pending.set(id, { resolve, reject, method, timer });
      this.#child.stdin.write(`${JSON.stringify(frame)}\n`, (err) => {
        if (err && this.#pending.has(id)) {
          this.#pending.delete(id);
          clearTimeout(timer);
          reject(new RpcError(
            { code: -32000, name: "WRITE_FAILED", message: err.message },
            method,
            "transport",
          ));
        }
      });
    });
  }

  close() {
    const child = this.#child;
    this.#child = null;
    if (this.#exit === null) {
      this.#exit = { code: null, signal: "SHELL_CLOSE" };
    }
    this.#failAll(new RpcError(
      { code: -32000, name: "KERNEL_GONE", message: "the shell closed the kernel" },
      "close",
      "transport",
    ));
    if (child && child.exitCode === null && !child.killed) {
      try {
        child.stdin.end();
        child.kill();
      } catch {
        /* already gone */
      }
    }
  }
}

/* ------------------------------------------------------------------ */
/* language layer (optional, lives outside the kernel)                 */
/* ------------------------------------------------------------------ */

/** Fallback used when `langs/` has been deleted: everything is plain text. */
class PlainLanguages {
  available = false;

  list() {
    return { langs: [] };
  }

  /** No language layer: every path is plain text. */
  detect() {
    return null;
  }

  tokenize(text) {
    return { tokens: [[0, text.length, "plain"]], lang: null };
  }
}

class FileLanguages {
  available = true;

  constructor(registry, tokenize, tokenizePlain) {
    this.registry = registry;
    this.#tokenize = tokenize;
    this.#tokenizePlain = tokenizePlain;
  }

  #tokenize;
  #tokenizePlain;

  list() {
    return { langs: this.registry.list() };
  }

  /** The language a path is written in, or null when nothing claims it. */
  detect(filePath) {
    if (typeof filePath !== "string" || filePath === "") {
      return null;
    }
    return this.registry.detect(filePath) ?? null;
  }

  tokenize(text, { path: filePath = null, lang: id = null } = {}) {
    const lang = (id !== null ? this.registry.byId(id) : null)
      ?? (filePath !== null ? this.registry.detect(filePath) : null)
      ?? null;
    if (lang === null) {
      return { tokens: this.#tokenizePlain(text), lang: null };
    }
    return { tokens: this.#tokenize(lang, text), lang: lang.id };
  }
}

async function loadLanguages(dir, log = () => {}) {
  try {
    const [langMod, tokMod] = await Promise.all([
      import(pathToFileURL(path.join(dir, "lang.mjs")).href),
      import(pathToFileURL(path.join(dir, "tokenize.mjs")).href),
    ]);
    // A descriptor that cannot be read is skipped rather than fatal -- one bad
    // file must not cost every other language -- but skipping it silently
    // makes a typo indistinguishable from having no languages at all, so each
    // one is reported.
    const problems = [];
    const registry = langMod.LangRegistry.fromDir(dir, {
      onError: (file, err) => problems.push(`${path.basename(file)}: ${err && err.message}`),
    });
    for (const problem of problems) {
      log(`langs: skipping descriptor -- ${problem}`);
    }
    if (registry.list().length === 0) {
      log(`langs: no descriptors in ${dir}; every file opens as plain text`);
    }
    return new FileLanguages(registry, tokMod.tokenize, tokMod.tokenizePlain);
  } catch (err) {
    // Deliberately not fatal: `langs/` is optional by design, and the editor
    // degrades to plain text.  Saying so is what keeps the degradation from
    // looking like "this project has no languages".
    log(`langs: the language layer did not load (${err && err.message});`
      + " every file opens as plain text");
    return new PlainLanguages();
  }
}

/* ------------------------------------------------------------------ */
/* dispatch -- the single definition of what a frame means             */
/* ------------------------------------------------------------------ */

function response(id, result) {
  return { jsonrpc: "2.0", id, result: result === undefined ? null : result };
}

function failure(id, code, name, message, data) {
  const error = { code, name, message };
  if (data !== undefined) error.data = data;
  return { jsonrpc: "2.0", id, error };
}

/* ------------------------------------------------------------------ */
/* the mod layer -- game knowledge the kernel must not have            */
/* ------------------------------------------------------------------ */

/*
 * `shell/mods/` is the game-aware half of this fork.  It opens a mod package,
 * validates it against the shipped JSON Schemas and the extracted baseline,
 * diagnoses Yarn, and searches the knowledge base built from the game's own
 * generated command list.
 *
 * Like `langs/`, it is optional: the board is still a general-purpose canvas
 * without it, so a missing or broken layer disables the `mod.*` verbs instead
 * of refusing to boot.  The kernel is never consulted for any of them.
 */
async function loadMods(options, log = () => {}) {
  try {
    const mod = await import(pathToFileURL(path.join(MODS_DIR, "index.js")).href);
    const factory = mod.createMods ?? (mod.default && mod.default.createMods);
    if (typeof factory !== "function") {
      log("mod layer: index.js exports no createMods(); mod verbs are unavailable");
      return null;
    }
    const mods = factory({ modsRoot: options.modsRoot ?? options.workspace, userDir: options.userDir });
    // Say which knowledge base is in use: the bundled one, a previously derived
    // one in the user data dir, or one derived just now from the game's files.
    // A missing base is a degraded state, not a crash -- validatePackage names it.
    const kb = typeof mods.knowledgeState === "function" ? mods.knowledgeState() : null;
    if (kb && kb.state === "present") {
      log(`mod layer: knowledge base found ${kb.path} (${kb.source})`);
    } else if (kb) {
      log(`mod layer: no knowledge base yet (${kb.loadError ?? kb.path})`);
    }
    return mods;
  } catch (err) {
    log(`mod layer: did not load (${err && err.message}); mod verbs are unavailable`);
    return null;
  }
}

/* ------------------------------------------------------------------ */
/* the settings layer -- files the shell owns, never the kernel        */
/* ------------------------------------------------------------------ */

/*
 * `config.get` and `config.set` report and persist the three JSON files a
 * settings card cares about, all under the userData directory:
 *
 *   ai-provider.json   the agent's provider settings (shell/ai/config.mjs)
 *   preferences.json   the board's own defaults (shell/ai/settings.mjs)
 *   settings.json      Electron's file; reported as a path, never written here
 *
 * The context is built once per process, next to the mod layer, so no single
 * request can pick a different directory halfway through.  `--user-dir` wins;
 * otherwise the platform's userData directory is used.  Nothing here talks to
 * the kernel, exactly like `mod.*`.
 */
function loadSettings(options = {}) {
  const userDir = typeof options.userDir === "string" && options.userDir !== ""
    ? options.userDir
    : defaultUserDataDir();
  return {
    userDir,
    app: {
      workspace: typeof options.workspace === "string" ? options.workspace : null,
      modsRoot: typeof options.modsRoot === "string" ? options.modsRoot : null,
    },
    ai: createConfigStore({ dir: userDir }),
    prefs: createPreferenceStore({ dir: userDir }),
  };
}

/*
 * Only reached when someone imports `dispatch` directly and passes the old
 * four arguments (the kernel probe, a unit test).  Building the context lazily
 * keeps importing this module free of filesystem work.
 */
let lazySettings = null;

function settingsContext(settings) {
  if (settings !== null && settings !== undefined) {
    return settings;
  }
  if (lazySettings === null) {
    lazySettings = loadSettings();
  }
  return lazySettings;
}

/** The redacted description `config.get` answers with; never contains a key. */
function describeSettings(context) {
  const ai = context.ai.read();
  const prefs = context.prefs.read();
  const app = context.app ?? {};
  return {
    userDir: context.userDir,
    files: {
      settings: path.join(context.userDir, "settings.json"),
      ai: context.ai.file,
      preferences: context.prefs.file,
    },
    app: {
      workspace: app.workspace ?? null,
      modsRoot: app.modsRoot ?? null,
    },
    ai: {
      ...describeConfig(ai.config),
      file: context.ai.file,
      exists: ai.exists,
      warnings: ai.warnings,
      errors: ai.errors,
    },
    prefs: {
      ...prefs.preferences,
      file: context.prefs.file,
      exists: prefs.exists,
      warnings: prefs.warnings,
    },
  };
}

/**
 * Apply one `config.set` payload.  Throws an Error whose message starts with
 * `config.set:`; `dispatch` already turns that into an -32603 frame, so there
 * is no second error path to keep in sync.  Never returns the key.
 */
function applySettings(context, params) {
  if (params === null || typeof params !== "object" || Array.isArray(params)) {
    throw new Error("config.set: params must be an object");
  }
  const clearKey = params.clearKey === true;
  try {
    if (params.ai !== undefined) {
      if (params.ai === null || typeof params.ai !== "object" || Array.isArray(params.ai)) {
        throw new Error("`ai` must be an object");
      }
      const patch = {};
      for (const key of Object.keys(params.ai)) {
        // An empty apiKey field means "leave the stored key alone", which is
        // what a settings card sends when the user did not retype it.
        if (key === "apiKey" && params.ai[key] === "") continue;
        patch[key] = params.ai[key];
      }
      if (clearKey) patch.apiKey = "";
      if (Object.keys(patch).length > 0) context.ai.write(patch);
    } else if (clearKey) {
      context.ai.write({ apiKey: "" });
    }
    if (params.prefs !== undefined) {
      if (params.prefs === null || typeof params.prefs !== "object" || Array.isArray(params.prefs)) {
        throw new Error("`prefs` must be an object");
      }
      context.prefs.write(params.prefs);
    }
  } catch (error) {
    throw new Error("config.set: " + settingsErrorMessage(error));
  }
  return describeSettings(context);
}

/** Flatten a ConfigError/SettingsError into one message without echoing values. */
function settingsErrorMessage(error) {
  const message = error && error.message ? String(error.message) : String(error);
  const details = error && Array.isArray(error.errors) ? error.errors : [];
  if (details.length === 0) return message;
  const notes = details.map((entry) => {
    const key = entry && entry.key ? String(entry.key) : "";
    const note = entry && entry.message ? String(entry.message) : "";
    return key === "" ? note : key + ": " + note;
  });
  return message + " (" + notes.join("; ") + ")";
}

function needParam(params, name) {
  const value = params === null || typeof params !== "object" ? undefined : params[name];
  if (typeof value !== "string" || value === "") {
    throw new RpcError({
      code: -32602,
      name: "INVALID_PARAMS",
      message: `missing non-empty string \`${name}\``,
    });
  }
  return value;
}

function optionalString(params, name) {
  const value = params === null || typeof params !== "object" ? undefined : params[name];
  return typeof value === "string" && value !== "" ? value : null;
}

/* ------------------------------------------------------------------ */
/* the agent's verbs -- G49: the card tools need a provider to hold    */
/* ------------------------------------------------------------------ */

/*
 * The window's cards declare what an agent may call (`shell/ai/cards.mjs`),
 * but the provider settings and the card tools' reachable shell verbs live on
 * this side, where the key does.  These four verbs are the smallest surface
 * that lets an agent work without ever seeing the key:
 *
 *   ai.status   what provider is configured and which read-only tools exist
 *   ai.tools    the full OpenAI `tools` array, schemas included
 *   ai.chat     one non-streaming completion (the loop lives in the caller)
 *   ai.invoke   run one read-only tool by name, with JSON arguments
 *
 * The chat loop is deliberately not here: a card owns the conversation, this
 * side owns the key and the tools.  Every frame is redacted by the provider
 * before it leaves (`describeConfig`, `redact`), and `ai.chat` returns only the
 * assistant message -- never the request that produced it.
 */

/** The tool registry this shell can honestly offer: the two read-only tools. */
function agentRegistry(context, mods) {
  const modsRoot = context !== null && context.app && typeof context.app.modsRoot === "string"
    ? context.app.modsRoot
    : null;
  return createToolRegistry({
    tools: createReadOnlyTools({ mods, modsRoot }),
  });
}

function aiStatus(context, mods) {
  const view = describeConfig(context.ai.load());
  let tools = [];
  try {
    tools = agentRegistry(context, mods).openaiTools()
      .map((entry) => entry && entry.function ? entry.function.name : null)
      .filter((name) => typeof name === "string");
  } catch (error) {
    tools = [];
  }
  return {
    configured: view.baseUrl !== "",
    endpoint: view.endpoint,
    model: view.model,
    hasApiKey: view.hasApiKey,
    stream: view.stream,
    timeoutMs: view.timeoutMs,
    tools,
  };
}

function aiTools(context, mods) {
  return { tools: agentRegistry(context, mods).openaiTools() };
}

/** One completion.  The caller owns the loop and the transcript. */
async function aiChat(context, params) {
  const messages = params !== null && typeof params === "object" ? params.messages : undefined;
  if (!Array.isArray(messages) || messages.length === 0) {
    throw new RpcError({
      code: -32602,
      name: "INVALID_PARAMS",
      message: "ai.chat needs a non-empty `messages` array",
    });
  }
  for (const message of messages) {
    if (message === null || typeof message !== "object" || typeof message.role !== "string") {
      throw new RpcError({
        code: -32602,
        name: "INVALID_PARAMS",
        message: "every message is an object with a string `role`",
      });
    }
  }
  const config = context.ai.load();
  const provider = createProvider({ ...config });
  const request = { messages: messages.map((message) => ({ ...message })) };
  if (params.tools !== undefined) {
    if (!Array.isArray(params.tools) || params.tools.length > 64) {
      throw new RpcError({
        code: -32602,
        name: "INVALID_PARAMS",
        message: "`tools` is the OpenAI tools array, at most 64 entries",
      });
    }
    if (params.tools.length > 0) {
      request.tools = params.tools;
      request.toolChoice = "auto";
    }
  }
  if (typeof params.temperature === "number") request.temperature = params.temperature;
  if (typeof params.maxTokens === "number") request.maxTokens = params.maxTokens;
  const answer = await provider.chat(request);
  return {
    id: answer.id,
    model: answer.model,
    created: answer.created,
    message: answer.message,
    finishReason: answer.finishReason,
    usage: answer.usage,
    streamed: answer.streamed === true,
  };
}

/** Run one read-only shell tool by name; the open outcome is the answer. */
async function aiInvoke(context, mods, params) {
  const name = needParam(params, "name");
  const args = params !== null && typeof params === "object" ? params.arguments : undefined;
  const registry = agentRegistry(context, mods);
  return invokeToolCall(registry, {
    // The shape the model produces, which is what `invokeToolCall` parses;
    // `aiInvoke` only re-labels an explicit tool call from the agent card.
    type: "function",
    function: {
      name,
      arguments: args === undefined ? "{}" : JSON.stringify(args),
    },
  });
}

/*
 * Every `mod.*` verb, in one table, so adding one is a row and not a branch.
 * The facade behind these is synchronous; `mod.scaffold`, `mod.newFile`,
 * `mod.importFile`, `mod.example` and `mod.export` write files, and are the
 * five with a side effect.
 */
const MOD_METHODS = {
  // G18: the docs card points these four at a package; the table forwards
  // `root` so the card's call reaches the facade it was written for.
  "mod.stats": (params, mods) => mods.stats({ root: optionalString(params, "root") ?? undefined }),
  "mod.types": (params, mods) => mods.types({ root: optionalString(params, "root") ?? undefined }),
  // G44: the sources behind every other answer -- the game folder discovery
  // picked and the knowledge base in effect -- as one read-only verb.
  "mod.sources": (_params, mods) => ({ knowledge: mods.knowledgeState(), game: mods.gameMods() }),
  "mod.templates": (_params, mods) => mods.templates(),
  "mod.characters": (_params, mods) => mods.characters(),

  "mod.open": (params, mods) => mods.openMod({ dir: needParam(params, "dir") }),
  "mod.validate": (params, mods) => mods.validatePackage({ root: needParam(params, "root") }),
  "mod.validateDefine": (params, mods) => mods.validateDefineText({
    type: needParam(params, "type"),
    text: typeof params.text === "string" ? params.text : "",
    relPath: optionalString(params, "relPath"),
  }),
  "mod.diagnose": (params, mods) => mods.diagnoseYarn({
    text: typeof params.text === "string" ? params.text : "",
    fileName: optionalString(params, "fileName"),
    root: optionalString(params, "root"),
  }),
  "mod.scaffold": (params, mods) => mods.scaffold({
    dir: needParam(params, "dir"),
    modName: needParam(params, "modName"),
    template: optionalString(params, "template") ?? "full",
    // G34: the File menu's new-mod shortcut offers to replace a folder a
    // previous attempt left behind; the flag has to cross the frame or that
    // retry can never succeed.
    overwrite: params.overwrite === true,
  }),
  // G50: one file, generated from the game's own schema, inside a package that
  // already exists.  `dir` may be the package root or any directory inside it.
  "mod.newFile": (params, mods) => mods.newFile({
    dir: needParam(params, "dir"),
    type: needParam(params, "type"),
    name: needParam(params, "name"),
    overwrite: params.overwrite === true,
  }),
  // The other half of G50: copy a file that already exists into a package.  The
  // bytes are copied verbatim; `to` is only needed when the name does not say
  // where the file belongs.
  "mod.importFile": (params, mods) => mods.importFile({
    dir: needParam(params, "dir"),
    from: needParam(params, "from"),
    to: optionalString(params, "to") ?? undefined,
    name: optionalString(params, "name") ?? undefined,
    overwrite: params.overwrite === true,
  }),
  // G45: a zip with one `<Name>/` top layer, so unpacking into Mods/ lands as
  // Mods/<Name>/.  The validator runs first; errors stop it, warnings do not.
  "mod.export": (params, mods) => mods.exportPackage({
    dir: needParam(params, "dir"),
    out: optionalString(params, "out") ?? undefined,
    overwrite: params.overwrite === true,
  }),
  // G11: the same package, but straight into the game instead of a zip.  The
  // target is <gameMods>/<Name>; without `overwrite` an existing folder is
  // refused, and the copy is staged beside it and swapped in.
  "mod.installGame": (params, mods) => mods.installGame({
    dir: needParam(params, "dir"),
    overwrite: params.overwrite === true,
    gameModsDir: optionalString(params, "gameModsDir") ?? undefined,
    gameDir: optionalString(params, "gameDir") ?? undefined,
  }),
  // G12: what the game itself said.  `path` skips discovery; otherwise the most
  // recently modified Player.log under the platform's log root is read.
  "mod.gameLog": (params, mods) => mods.gameLog({
    path: optionalString(params, "path") ?? undefined,
    modName: optionalString(params, "modName") ?? undefined,
    bytes: typeof params.bytes === "number" ? params.bytes : undefined,
  }),
  // G12 follow: poll for `durationMs`, collect only appended bytes.
  "mod.followGameLog": (params, mods) => mods.followGameLog({
    path: optionalString(params, "path") ?? undefined,
    modName: optionalString(params, "modName") ?? undefined,
    durationMs: typeof params.durationMs === "number" ? params.durationMs : undefined,
    intervalMs: typeof params.intervalMs === "number" ? params.intervalMs : undefined,
  }),
  // G35: the demo packages beside the editor cannot be opened where they ship
  // (a card's `dir` never leaves the mods folder), so `mod.examples` lists them
  // and `mod.example` copies one in, which also makes it editable.
  "mod.examples": (_params, mods) => mods.examples(),
  "mod.example": (params, mods) => mods.example({
    name: optionalString(params, "name") ?? undefined,
  }),
  "mod.search": (params, mods) => mods.search({
    query: typeof params.query === "string" ? params.query : "",
    limit: typeof params.limit === "number" ? params.limit : undefined,
    root: optionalString(params, "root") ?? undefined,
  }),
  "mod.docFor": (params, mods) => mods.docFor({
    kind: needParam(params, "kind"),
    name: needParam(params, "name"),
    root: optionalString(params, "root") ?? undefined,
  }),
  "mod.suggest": (params, mods) => mods.suggest({
    prefix: typeof params.prefix === "string" ? params.prefix : "",
    context: optionalString(params, "context") ?? undefined,
  }),
  // The language service takes the *document being edited*, never the file on
  // disk: the editor can ask about text the user has not saved yet.
  "mod.complete": (params, mods) => mods.completeYarn({
    text: typeof params.text === "string" ? params.text : "",
    caret: typeof params.caret === "number" ? params.caret : 0,
    limit: typeof params.limit === "number" ? params.limit : undefined,
  }),
  "mod.hover": (params, mods) => mods.hoverYarn({
    text: typeof params.text === "string" ? params.text : "",
    caret: typeof params.caret === "number" ? params.caret : 0,
  }),
  "mod.localization": (params, mods) => mods.localization({ root: needParam(params, "root") }),
};

/**
 * Answers one request.  Returns the response object, or null when the frame
 * was a notification (which must not be answered).
 *
 * Methods the shell owns:
 *   lang.list, lang.tokenize            served from langs/, no kernel involved
 *   mod.*                               served from shell/mods/, no kernel involved
 *   config.get, config.set              the shell's settings files; no kernel involved
 *   ai.status/tools/chat/invoke         the agent's provider and read-only tools (G49)
 *   workspace.info                      the kernel's answer plus `langs`
 * Everything else is forwarded verbatim.
 */
export async function dispatch(frame, kernel, languages, mods = null, settings = null) {
  if (frame === null || typeof frame !== "object" || Array.isArray(frame)) {
    return failure(null, -32600, "INVALID_REQUEST", "a frame must be a JSON object");
  }

  const id = frame.id;
  const notification = id === undefined;
  const method = frame.method;
  const params = frame.params ?? {};

  if (typeof method !== "string" || method === "") {
    return notification ? null : failure(id, -32600, "INVALID_REQUEST", "`method` must be a non-empty string");
  }

  const answer = (build) => (notification ? null : build());

  try {
    if (method === "lang.list") {
      return answer(() => response(id, languages.list()));
    }

    if (method === "lang.tokenize") {
      if (typeof params.text !== "string") {
        return answer(() => failure(id, -32602, "INVALID_PARAMS", "lang.tokenize needs a string `text`"));
      }
      if (!languages.available) {
        return answer(() => response(id, { tokens: [[0, params.text.length, "plain"]], lang: null }));
      }
      return answer(() => response(id, languages.tokenize(params.text, {
        path: typeof params.path === "string" ? params.path : null,
        lang: typeof params.lang === "string" ? params.lang : null,
      })));
    }

    if (method.startsWith("mod.")) {
      if (mods === null) {
        return answer(() => failure(id, -32601, "METHOD_NOT_FOUND",
          "the mod layer is not loaded; `mod.*` is unavailable in this checkout"));
      }
      const handler = MOD_METHODS[method];
      if (handler === undefined) {
        return answer(() => failure(id, -32601, "METHOD_NOT_FOUND", `no such method \`${method}\``));
      }
      /*
       * `mod.scaffold` writes files, so a facade verb may answer with a promise.
       * Awaiting it here is what keeps a rejection inside this function's catch:
       * passing a rejected promise to `response()` would answer with `{}` and
       * then surface as an unhandled rejection that takes the whole shell -- and
       * the kernel child with it -- down instead of sending an error frame.
       */
      const result = await handler(params, mods);
      return answer(() => response(id, result));
    }

    if (method === "config.get") {
      return answer(() => response(id, describeSettings(settingsContext(settings))));
    }

    if (method === "config.set") {
      const context = settingsContext(settings);
      return answer(() => response(id, applySettings(context, params)));
    }

    // G49: the agent's provider and tools.  Like `config.*`, these never touch
    // the kernel; the read-only tools behind `ai.invoke` are wrappers around
    // the mod layer the shell already loaded.
    if (method === "ai.status") {
      return answer(() => response(id, aiStatus(settingsContext(settings), mods)));
    }

    if (method === "ai.tools") {
      return answer(() => response(id, aiTools(settingsContext(settings), mods)));
    }

    if (method === "ai.chat") {
      const result = await aiChat(settingsContext(settings), params);
      return answer(() => response(id, result));
    }

    if (method === "ai.invoke") {
      const result = await aiInvoke(settingsContext(settings), mods, params);
      return answer(() => response(id, result));
    }

    const result = await kernel.call(method, frame.params);

    // The kernel is language-agnostic, so the language inventory is added by
    // the layer that actually owns it.  A client that only needs the kernel
    // can ignore the member entirely.
    if (method === "workspace.info" && result !== null && typeof result === "object") {
      return answer(() => response(id, {
        ...result,
        langs: languages.list().langs,
        mods: mods !== null,
      }));
    }

    // Same reasoning for a single file: `file.read` names the language the
    // path is written in, because the kernel cannot know and every editor card
    // would otherwise have to ask a second time.
    if (method === "file.read" && result !== null && typeof result === "object") {
      const lang = languages.detect(
        typeof result.path === "string" ? result.path : (params.path ?? null),
      );
      return answer(() => response(id, { ...result, lang: lang === null ? null : lang.id }));
    }

    return answer(() => response(id, result));
  } catch (err) {
    const rpc = err instanceof RpcError
      ? err
      : new RpcError({ code: -32603, name: "SHELL_ERROR", message: err && err.message }, method);
    return answer(() => failure(id, rpc.code, rpc.rpcName, rpc.message, rpc.data));
  }
}

function parseFrame(text) {
  try {
    return { frame: JSON.parse(text) };
  } catch (err) {
    return { error: failure(null, -32700, "PARSE_ERROR", `offset 0: ${err && err.message}`) };
  }
}

/* ------------------------------------------------------------------ */
/* mode: rpc -- stdio front end                                        */
/* ------------------------------------------------------------------ */

function writeStdout(obj) {
  process.stdout.write(`${JSON.stringify(obj)}\n`);
}

async function runRpc(options) {
  const kernel = new Kernel(options);
  // Diagnostics belong on stderr: stdout carries protocol frames and nothing
  // else, so a client can parse it without filtering.
  const languages = await loadLanguages(LANGS_DIR, (message) => {
    process.stderr.write(`[shell] ${message}\n`);
  });
  const mods = await loadMods(options, (message) => {
    process.stderr.write(`[shell] ${message}\n`);
  });
  // The files behind config.get/config.set are the shell's own; the kernel is
  // never consulted for them, exactly like `mod.*`.
  const settings = loadSettings(options);

  await kernel.start();
  if (options.verbose) {
    process.stderr.write(`[shell] rpc on ${kernel.exe} (workspace ${kernel.workspace})\n`);
  }

  // Anything the kernel says on its own account goes straight out.
  kernel.onNotification((event) => writeStdout(event));

  const rl = readline.createInterface({ input: process.stdin, crlfDelay: Infinity });
  try {
    for await (const line of rl) {
      const text = line.trim();
      if (text === "") continue;   // keep-alive

      const { frame, error } = parseFrame(text);
      if (error) {
        writeStdout(error);
        continue;
      }

      // Sequential on purpose: the kernel answers one frame at a time, and a
      // client that pipelines still gets its replies in order.
      const reply = await dispatch(frame, kernel, languages, mods, settings);
      if (reply !== null) writeStdout(reply);
    }
  } finally {
    // Whatever ends the loop -- EOF, an error, a signal -- the kernel child
    // goes with it.
    kernel.close();
  }

  return 0;
}

/* ------------------------------------------------------------------ */
/* mode: serve -- HTTP + SSE + the system browser                      */
/* ------------------------------------------------------------------ */

const MIME = {
  ".html": "text/html; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".map": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".ico": "image/x-icon",
  ".txt": "text/plain; charset=utf-8",
  ".woff2": "font/woff2",
};

function staticPath(urlPath) {
  const raw = urlPath.split("?")[0];
  let clean;
  try {
    clean = decodeURIComponent(raw);
  } catch {
    // Malformed percent-encoding is a bad request, not a server fault: the
    // caller turns null into a refusal instead of a 500.
    return null;
  }
  const rel = clean === "/" ? "index.html" : clean.replace(/^\/+/, "");
  const full = path.resolve(WEB_DIR, rel);
  const base = path.resolve(WEB_DIR);
  if (full !== base && !full.startsWith(base + path.sep)) {
    return null;   // traversal attempt
  }
  return full;
}

function readBody(req, limit = 64 * 1024 * 1024) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    let settled = false;
    req.on("data", (chunk) => {
      if (settled) return;
      size += chunk.length;
      if (size > limit) {
        settled = true;
        // Answer instead of destroying the socket.  The rest of the body is
        // left unread, which closes the connection once the reply is out --
        // but the client gets told why, which a reset never does.
        req.pause();
        reject(Object.assign(new Error("request body is too large"), { status: 413 }));
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => {
      if (!settled) resolve(Buffer.concat(chunks).toString("utf8"));
    });
    req.on("error", (err) => {
      if (!settled) reject(err);
    });
  });
}

/** The candidate browser executables, in the order a Windows box has them. */
function browserCandidates() {
  const list = [];
  if (process.env.INFANTGOD_BROWSER) list.push(process.env.INFANTGOD_BROWSER);
  // Program Files comes from the environment, never from this file: the
  // project's machines disagree about it, and a directory baked in here would
  // be wrong on every other machine (tools/path_guard.py enforces that).
  const under = (base, ...parts) => (base ? path.join(base, ...parts) : null);
  const pf = process.env["ProgramFiles"];
  const pf86 = process.env["ProgramFiles(x86)"];
  const local = process.env["LOCALAPPDATA"];
  list.push(
    under(pf86, "Microsoft", "Edge", "Application", "msedge.exe"),
    under(pf, "Microsoft", "Edge", "Application", "msedge.exe"),
    under(pf, "Google", "Chrome", "Application", "chrome.exe"),
    under(pf86, "Google", "Chrome", "Application", "chrome.exe"),
    under(local, "Google", "Chrome", "Application", "chrome.exe"),
  );
  return list;
}

function openWindow(url, { verbose = false } = {}) {
  const exe = browserCandidates().find((candidate) => candidate && existsSync(candidate));
  if (!exe) {
    process.stderr.write("OsanaKami IDE Studio: no Edge/Chromium found; open the URL printed above yourself\n");
    return null;
  }

  // A throwaway profile keeps app mode out of the user's real browser session,
  // and keeps `--app` from adopting an existing window.
  const profile = mkdtempSync(path.join(tmpdir(), "infantgod-profile-"));
  const args = [
    `--app=${url}`,
    `--user-data-dir=${profile}`,
    "--no-first-run",
    "--no-default-browser-check",
    "--disable-features=Translate",
  ];
  if (verbose) process.stderr.write(`[shell] ${exe} ${args.join(" ")}\n`);
  const child = spawn(exe, args, { stdio: "ignore", detached: false, windowsHide: false });
  child.on("error", (err) => process.stderr.write(`OsanaKami IDE Studio: cannot launch ${exe}: ${err.message}\n`));
  return child;
}

async function runServe(options) {
  const kernel = new Kernel(options);
  const languages = await loadLanguages(LANGS_DIR, (message) => {
    process.stderr.write(`[shell] ${message}\n`);
  });
  const mods = await loadMods(options, (message) => {
    process.stderr.write(`[shell] ${message}\n`);
  });
  // The files behind config.get/config.set are the shell's own; the kernel is
  // never consulted for them, exactly like `mod.*`.
  const settings = loadSettings(options);
  await kernel.start();

  const subscribers = new Set();

  // Every notification the kernel emits is fanned out to the SSE clients.
  kernel.onNotification((event) => {
    const line = `data: ${JSON.stringify(event)}\n\n`;
    for (const res of subscribers) {
      try {
        res.write(line);
      } catch {
        subscribers.delete(res);
      }
    }
  });

  const server = createServer((req, res) => {
    handleRequest(req, res).catch((err) => {
      if (!res.headersSent) {
        res.writeHead(500, { "content-type": "text/plain; charset=utf-8" });
      }
      res.end(`shell error: ${err && err.message}\n`);
    });
  });

  async function handleRequest(req, res) {
    const url = req.url ?? "/";

    // Loopback is not a security boundary.  Any page the user happens to have
    // open can POST to this port -- a CORS "simple" request needs no
    // preflight -- and this endpoint writes files and starts processes.  A
    // browser does send `Origin` on cross-origin POSTs, so a request that
    // names a different origin is refused.  A request with no `Origin` is a
    // local tool (curl, the test suite), which is exactly who should be here.
    const origin = req.headers.origin;
    if (typeof origin === "string" && origin !== "" && origin !== `http://${req.headers.host}`) {
      res.writeHead(403, { "content-type": "text/plain; charset=utf-8" });
      res.end("cross-origin requests are refused\n");
      return;
    }

    if (req.method === "GET" && url.split("?")[0] === "/events") {
      res.writeHead(200, {
        "content-type": "text/event-stream; charset=utf-8",
        "cache-control": "no-store",
        connection: "keep-alive",
        "x-accel-buffering": "no",
      });
      res.write(": infantgod events\n\n");
      subscribers.add(res);

      const beat = setInterval(() => {
        try {
          res.write(": keep-alive\n\n");
        } catch {
          clearInterval(beat);
        }
      }, 15000);
      beat.unref?.();

      req.on("close", () => {
        clearInterval(beat);
        subscribers.delete(res);
      });
      return;
    }

    if (req.method === "POST" && url.split("?")[0] === "/rpc") {
      let frame;
      try {
        frame = JSON.parse(await readBody(req));
      } catch (err) {
        // An oversized body gets an answer, not a destroyed socket: a reset
        // tells the client nothing at all, and the connection is still able
        // to carry a status line.
        const tooLarge = err && err.status === 413;
        res.writeHead(tooLarge ? 413 : 400, { "content-type": "application/json; charset=utf-8" });
        res.end(JSON.stringify(tooLarge
          ? failure(null, -32600, "REQUEST_TOO_LARGE", "request body is too large")
          : failure(null, -32700, "PARSE_ERROR", `offset 0: ${err && err.message}`)));
        return;
      }

      const reply = await dispatch(frame, kernel, languages, mods, settings);
      // A notification is answered with 204: HTTP always needs a status, but
      // there is no response frame to give.
      if (reply === null) {
        res.writeHead(204, { "cache-control": "no-store" });
        res.end();
        return;
      }
      res.writeHead(200, {
        "content-type": "application/json; charset=utf-8",
        "cache-control": "no-store",
      });
      res.end(JSON.stringify(reply));
      return;
    }

    if (req.method !== "GET" && req.method !== "HEAD") {
      res.writeHead(405, { allow: "GET, HEAD, POST" });
      res.end("method not allowed\n");
      return;
    }

    const full = staticPath(url);
    if (full === null) {
      res.writeHead(403);
      res.end("forbidden\n");
      return;
    }

    let info = null;
    try {
      info = statSync(full);
    } catch {
      info = null;
    }
    if (info === null || !info.isFile()) {
      res.writeHead(404, { "content-type": "text/plain; charset=utf-8" });
      res.end(`not found: ${url}\n`);
      return;
    }

    const type = MIME[path.extname(full).toLowerCase()] ?? "application/octet-stream";
    res.writeHead(200, {
      "content-type": type,
      "content-length": info.size,
      "cache-control": "no-store",
    });
    if (req.method === "HEAD") {
      res.end();
      return;
    }
    res.end(await readFile(full));
  }

  let browser = null;
  const shutdown = () => {
    if (browser && browser.exitCode === null) {
      try {
        browser.kill();
      } catch {
        /* ignore */
      }
    }
    for (const res of subscribers) {
      try {
        res.end();
      } catch {
        /* ignore */
      }
    }
    subscribers.clear();
    server.close();
    kernel.close();
  };

  process.once("SIGINT", () => {
    shutdown();
    process.exit(0);
  });
  process.once("SIGTERM", () => {
    shutdown();
    process.exit(0);
  });

  try {
    await new Promise((resolve, reject) => {
      server.once("error", reject);
      server.listen(options.port, "127.0.0.1", resolve);
    });
  } catch (err) {
    // A port that is already taken must not leave a kernel child behind: its
    // pipes keep this process alive, so the failure would hang instead of
    // exiting with the error that explains it.
    kernel.close();
    throw err;
  }

  const address = server.address();
  const url = `http://127.0.0.1:${address.port}/`;

  process.stdout.write(`OsanaKami IDE Studio ${SHELL_VERSION}\n`);
  process.stdout.write(`  board   ${url}\n`);
  process.stdout.write(`  kernel  ${kernel.exe}\n`);
  process.stdout.write(`  root    ${kernel.workspace}\n`);
  for (const dir of kernel.readRoots) process.stdout.write(`  read    ${dir}\n`);
  process.stdout.write(`  langs   ${languages.available ? LANGS_DIR : "(none -- plain text)"}\n`);

  if (!options.noOpen) {
    browser = openWindow(url, options);
  }

  // Closing the window ends the session: no orphaned kernel, no orphaned port.
  if (browser) {
    browser.once("exit", () => {
      shutdown();
      process.exit(0);
    });
  }
  server.once("close", () => kernel.close());

  return new Promise(() => {});
}

/* ------------------------------------------------------------------ */
/* headless validation                                                 */
/* ------------------------------------------------------------------ */

/*
 * `validate DIR` is the mod layer with no window and no kernel around it.
 * Everything it needs is `shell/mods/`: the schemas, the baseline facts, the
 * asset readers.  That is deliberate -- a reviewer can run it on a machine
 * that has neither the game installed nor a compiled `build/infantgod.exe`,
 * which is exactly the situation the mods suite supports.
 *
 * DIR is one package (it has mod.json) or a mods root whose direct children
 * are packages.  The package's parent is the mods root for a single package,
 * so the cross-mod checks (techName collisions, M012's game-Mods note) behave
 * the way they do when the package sits among its siblings -- a package sent
 * over chat has no siblings, and must not silently change meaning.
 */

/** One diagnostic as a line someone can paste into a review comment. */
function describeDiagnostic(diag) {
  const where = diag && diag.path ? String(diag.path) : "(root)";
  const code = diag && diag.code ? String(diag.code) : "?";
  const severity = diag && diag.severity ? String(diag.severity) : "info";
  const text = diag && diag.message ? String(diag.message)
    : diag && diag.messageEn ? String(diag.messageEn)
      : "";
  return `${severity} ${code} ${where}: ${text}`;
}

function plural(n, word) {
  return `${n} ${word}${n === 1 ? "" : "s"}`;
}

async function runValidate(options) {
  const json = options.json === true;
  const say = (line) => process.stderr.write(line + "\n");
  const fail = (message) => {
    if (json) {
      process.stdout.write(JSON.stringify({ ok: false, error: message }, null, 2) + "\n");
    }
    process.stderr.write(`OsanaKami IDE Studio: ${message}\n`);
    return 2;
  };

  if (options.target === null) {
    return fail("validate needs a directory: node shell/main.mjs validate <dir> [--json]");
  }
  const target = path.resolve(options.target);
  if (!existsSync(target) || !statSync(target).isDirectory()) {
    return fail(`not a directory: ${target}`);
  }

  const targetIsPackage = existsSync(path.join(target, "mod.json"));
  const modsRoot = options.modsRoot !== null
    ? options.modsRoot
    : (targetIsPackage ? path.dirname(target) : target);

  let packages;
  if (targetIsPackage) {
    packages = [target];
  } else {
    try {
      packages = readdirSync(target)
        .map((name) => path.join(target, name))
        .filter((entry) => {
          try {
            return statSync(entry).isDirectory() && existsSync(path.join(entry, "mod.json"));
          } catch {
            return false;
          }
        })
        .sort();
    } catch (err) {
      return fail(`cannot read ${target}: ${err && err.message ? err.message : err}`);
    }
    if (packages.length === 0) {
      return fail(`no mod packages found in ${target} (looked for mod.json in its direct children)`);
    }
  }

  const mods = await loadMods({ ...options, modsRoot }, (line) => say(line));
  if (!mods) return fail("the mod layer did not load");

  const results = [];
  for (const root of packages) {
    let result;
    try {
      result = mods.validatePackage({ root });
    } catch (err) {
      return fail(`cannot validate ${root}: ${err && err.message ? err.message : err}`);
    }
    /*
     * The package name is the folder name: mod.json's own `name` can be absent
     * or wrong, and the report should still say where to look.
     */
    results.push({
      root,
      name: path.basename(root),
      ok: !!result.ok,
      knowledge: result.knowledge,
      summary: result.summary,
      diagnostics: result.diagnostics,
    });
  }

  const totals = {
    packages: results.length,
    failed: results.filter((r) => !r.ok).length,
    errors: results.reduce((n, r) => n + (r.summary.errors || 0), 0),
    warnings: results.reduce((n, r) => n + (r.summary.warnings || 0), 0),
    infos: results.reduce((n, r) => n + (r.summary.infos || 0), 0),
  };
  const gameMods = typeof mods.gameMods === "function" ? mods.gameMods() : null;
  const knowledge = results.every((r) => r.knowledge === "present") ? "present" : "missing";

  if (json) {
    const document = {
      tool: "infantgod-validate",
      version: SHELL_VERSION,
      ok: totals.errors === 0,
      modsRoot,
      knowledge,
      gameMods: gameMods ? { dir: gameMods.dir, source: gameMods.source, found: gameMods.found } : null,
      packages: results,
      totals,
    };
    process.stdout.write(JSON.stringify(document, null, 2) + "\n");
  } else {
    for (const result of results) {
      const s = result.summary;
      process.stdout.write(
        `${result.name}  ${result.ok ? "ok" : "has errors"}  ` +
        `(${plural(s.files, "file")}, ${s.errors} errors, ${s.warnings} warnings, ${s.infos} infos)\n`,
      );
      for (const diagnostic of result.diagnostics) {
        process.stdout.write(`  ${describeDiagnostic(diagnostic)}\n`);
      }
    }
    process.stdout.write(
      `${plural(totals.packages, "package")}: ${totals.packages - totals.failed} ok, ` +
      `${totals.failed} with errors -- ${plural(totals.errors, "error")}, ` +
      `${plural(totals.warnings, "warning")}, ${plural(totals.infos, "info")}\n`,
    );
    if (knowledge !== "present") {
      process.stdout.write("knowledge base: missing -- schema checks were limited, see the E000 diagnostic\n");
    }
    if (gameMods && gameMods.found !== true) {
      process.stdout.write(
        "game Mods folder: not found -- cross-mod checks were skipped (the M012 diagnostic says so per package)\n",
      );
    }
  }

  return totals.errors > 0 ? 1 : 0;
}

/* ------------------------------------------------------------------ */
/* export                                                              */
/* ------------------------------------------------------------------ */

/*
 * `export DIR` writes the distribution container the mod community actually
 * uses: a zip with one `<Name>/` layer at the top, so unpacking it into the
 * game's `Mods/` folder lands as `Mods/<Name>/`.  The game does not read zips
 * -- this is transport, which is why the container is deterministic and can be
 * diffed ("is this the same version I downloaded?").
 *
 * The precheck is the same validator the cards run: errors stop the export,
 * warnings and infos do not.  `E000` (no knowledge base) does not stop it
 * either: that error says this run could only check file structure, not that
 * the package is wrong.
 */
async function runExport(options) {
  const json = options.json === true;
  const fail = (message) => {
    if (json) {
      process.stdout.write(JSON.stringify({ ok: false, error: message }, null, 2) + "\n");
    }
    process.stderr.write(`OsanaKami IDE Studio: ${message}\n`);
    return 2;
  };

  if (options.target === null) {
    return fail("export needs a package directory: node shell/main.mjs export <dir> [--out file.zip]");
  }
  const target = path.resolve(options.target);
  if (!existsSync(target) || !statSync(target).isDirectory()) {
    return fail(`not a directory: ${target}`);
  }
  const modsRoot = options.modsRoot !== null ? options.modsRoot : path.dirname(target);

  const mods = await loadMods({ ...options, modsRoot }, (line) => process.stderr.write(line + "\n"));
  if (!mods) return fail("the mod layer did not load");

  let report;
  try {
    report = mods.exportPackage({
      dir: target,
      out: options.out,
      overwrite: options.overwrite === true,
    });
  } catch (err) {
    const message = err && err.message ? String(err.message) : String(err);
    if (json) {
      process.stdout.write(JSON.stringify({ ok: false, error: message }, null, 2) + "\n");
    }
    process.stderr.write(`OsanaKami IDE Studio: ${message}\n`);
    /* The validator stopping an export is the documented code 1, not a usage error. */
    return /has \d+ error\(s\)/.test(message) ? 1 : 2;
  }

  if (json) {
    process.stdout.write(JSON.stringify({ ok: true, ...report }, null, 2) + "\n");
  } else {
    process.stdout.write(
      `exported ${report.out} (${report.bytes} bytes, ${report.files} files)\n` +
      `${plural(report.warnings, "warning")}, ${plural(report.infos, "info")} from the precheck` +
      (report.knowledge === "missing" ? " (no knowledge base: only file structure was checked)" : "") + "\n",
    );
    if (report.skipped.length > 0) {
      process.stdout.write(`left out ${plural(report.skipped.length, "file")}:\n`);
      for (const rel of report.skipped) process.stdout.write(`  ${rel}\n`);
    }
  }
  return 0;
}

/* ------------------------------------------------------------------ */
/* install                                                             */
/* ------------------------------------------------------------------ */

/*
 * `install DIR` is the last mile after `export`: instead of a zip the author
 * unpacks by hand, the package goes straight into the game's Mods folder, which
 * is the one place the game actually reads.  The precheck and the exit codes
 * match `export` (1 = the validator stopped it, 2 = usage or write failure);
 * the one addition is that a package already installed under the same name is
 * refused until `--overwrite`, because replacing a folder is the destructive
 * step and it should be asked for explicitly.
 */
async function runInstall(options) {
  const json = options.json === true;
  const fail = (message) => {
    if (json) {
      process.stdout.write(JSON.stringify({ ok: false, error: message }, null, 2) + "\n");
    }
    process.stderr.write(`OsanaKami IDE Studio: ${message}\n`);
    return 2;
  };

  if (options.target === null) {
    return fail("install needs a package directory: node shell/main.mjs install <dir> [--game-dir DIR] [--overwrite]");
  }
  const target = path.resolve(options.target);
  if (!existsSync(target) || !statSync(target).isDirectory()) {
    return fail(`not a directory: ${target}`);
  }
  const modsRoot = options.modsRoot !== null ? options.modsRoot : path.dirname(target);

  const mods = await loadMods({ ...options, modsRoot }, (line) => process.stderr.write(line + "\n"));
  if (!mods) return fail("the mod layer did not load");

  let report;
  try {
    report = mods.installGame({
      dir: target,
      overwrite: options.overwrite === true,
      gameDir: options.gameDir !== null ? options.gameDir : undefined,
    });
  } catch (err) {
    const message = err && err.message ? String(err.message) : String(err);
    if (json) {
      process.stdout.write(JSON.stringify({ ok: false, error: message }, null, 2) + "\n");
    }
    process.stderr.write(`OsanaKami IDE Studio: ${message}\n`);
    /* The validator stopping an install is the documented code 1, not a usage error. */
    return /has \d+ error\(s\)/.test(message) ? 1 : 2;
  }

  if (json) {
    process.stdout.write(JSON.stringify({ ok: true, ...report }, null, 2) + "\n");
  } else {
    process.stdout.write(
      `installed ${report.name} -> ${report.target} (${plural(report.files, "file")}, ${report.bytes} bytes)` +
      (report.replaced ? " -- replaced the previous copy" : "") + "\n",
    );
    process.stdout.write(
      `${plural(report.warnings, "warning")}, ${plural(report.infos, "info")} from the precheck` +
      (report.knowledge === "missing" ? " (no knowledge base: only file structure was checked)" : "") + "\n",
    );
  }
  return 0;
}

/* ------------------------------------------------------------------ */
/* log                                                                 */
/* ------------------------------------------------------------------ */

/*
 * `log` is G12: read (or, with `--duration-ms`, follow) the game's Player.log
 * so the author can see the game's own verdict without alt-tabbing to a folder
 * they may never have opened.  Unlike `validate`, a log with zero matches is
 * still a success -- reading it was the job, and "the game said nothing" is a
 * real answer.  No log found is code 2 and the message lists where it looked.
 */
async function runLog(options) {
  const json = options.json === true;
  const fail = (message, code) => {
    if (json) {
      process.stdout.write(JSON.stringify({ ok: false, error: message }, null, 2) + "\n");
    }
    process.stderr.write(`OsanaKami IDE Studio: ${message}\n`);
    return code;
  };

  const modsRoot = options.modsRoot !== null ? options.modsRoot : options.workspace;
  const mods = await loadMods({ ...options, modsRoot }, (line) => process.stderr.write(line + "\n"));
  if (!mods) return fail("the mod layer did not load", 2);

  let answer;
  try {
    const params = {};
    if (options.logPath !== null) params.path = path.resolve(options.logPath);
    if (options.logMod !== null) params.modName = options.logMod;
    if (options.durationMs > 0) {
      params.durationMs = options.durationMs;
      answer = await mods.followGameLog(params);
    } else {
      answer = mods.gameLog(params);
    }
  } catch (err) {
    return fail(err && err.message ? String(err.message) : String(err), 1);
  }

  if (answer.found !== true) {
    const tried = Array.isArray(answer.tried) ? answer.tried : [];
    const shown = tried.slice(0, 10).map((entry) => `  ${entry && entry.path ? entry.path : String(entry)}`);
    const more = tried.length > shown.length ? ` (and ${tried.length - shown.length} more)` : "";
    return fail(
      `no Player.log found${options.logPath !== null ? ` at ${options.logPath}` : ""} -- ` +
      `looked in ${plural(tried.length, "place")}${more}` + (shown.length > 0 ? `:\n${shown.join("\n")}` : ""),
      2,
    );
  }
  if (answer.error) return fail(`${answer.path}: ${answer.error}`, 1);

  if (json) {
    process.stdout.write(JSON.stringify({ ok: true, ...answer }, null, 2) + "\n");
    return 0;
  }
  process.stdout.write(`${answer.path}\n`);
  process.stdout.write(
    `  read ${answer.bytes} bytes from offset ${answer.offset} of ${answer.size} bytes` +
    (answer.mtime ? ` (modified ${new Date(answer.mtime).toISOString()})` : "") + "\n",
  );
  process.stdout.write(
    `  ${plural(answer.totals.lines, "line")}, ${plural(answer.totals.errors, "error")}, ` +
    `${plural(answer.totals.mods, "mod line")}, ${plural(answer.totals.mentions, "mention")}` +
    (answer.samples ? ` (${plural(answer.samples, "sample")} of new text)` : "") + "\n",
  );
  if (answer.lines.length === 0) {
    process.stdout.write("  nothing worth showing -- the game said nothing about this package\n");
  }
  for (const line of answer.lines) {
    process.stdout.write(`  ${line.line} ${line.kind}: ${line.text}\n`);
  }
  return 0;
}

/*
 * `sources` is G44: the answer to "where do the mod layer's answers come from?"
 * -- the game folder the discovery settled on (and where it looked when there
 * was none), and which knowledge.json is in effect: shipped, derived into the
 * user directory, or missing.  A missing game or a missing knowledge base is
 * an answer, not an error; only a mod layer that cannot load is code 2.
 */
async function runSources(options) {
  const json = options.json === true;
  const modsRoot = options.modsRoot !== null ? options.modsRoot : options.workspace;
  const mods = await loadMods({ ...options, modsRoot }, (line) => process.stderr.write(line + "\n"));
  if (!mods) {
    if (json) {
      process.stdout.write(JSON.stringify({ ok: false, error: "the mod layer did not load" }, null, 2) + "\n");
    }
    process.stderr.write("OsanaKami IDE Studio: the mod layer did not load\n");
    return 2;
  }

  const answer = { knowledge: mods.knowledgeState(), game: mods.gameMods() };
  if (json) {
    process.stdout.write(JSON.stringify({ ok: true, ...answer }, null, 2) + "\n");
    return 0;
  }

  const game = answer.game;
  if (game.found === true && game.dir) {
    process.stdout.write(`game mods: ${game.dir} (found via ${game.source})\n`);
  } else {
    const tried = Array.isArray(game.tried) ? game.tried : [];
    process.stdout.write(`game mods: not found -- looked in ${plural(tried.length, "place")}\n`);
    for (const entry of tried.slice(0, 10)) {
      process.stdout.write(`  ${entry && entry.path ? entry.path : String(entry)}\n`);
    }
    if (tried.length > 10) process.stdout.write(`  (and ${tried.length - 10} more)\n`);
  }
  const knowledge = answer.knowledge;
  process.stdout.write(
    `knowledge base: ${knowledge.path ?? "(none)"} (${knowledge.source}, ` +
    `${plural(knowledge.schemas, "schema")})\n`,
  );
  if (knowledge.loadError) process.stdout.write(`  load error: ${knowledge.loadError}\n`);
  if (knowledge.deriveError) process.stdout.write(`  derive error: ${knowledge.deriveError}\n`);
  return 0;
}

/* ------------------------------------------------------------------ */
/* command line                                                        */
/* ------------------------------------------------------------------ */

const USAGE = `OsanaKami IDE Studio shell ${SHELL_VERSION}

usage: node shell/main.mjs <command> [options]

  rpc     [--workspace DIR] [--read-root DIR]... [--mods-root DIR] [--kernel PATH]
          [--timeout-ms N] [--user-dir DIR] [--verbose]
          Speak newline-delimited JSON-RPC on stdin/stdout.  Forwards to the
          kernel; answers lang.list and lang.tokenize from langs/, mod.* from
          shell/mods/; adds the \`langs\` and \`mods\` members to workspace.info.

  serve   [--workspace DIR] [--read-root DIR]... [--mods-root DIR] [--kernel PATH]
          [--port N] [--user-dir DIR] [--no-open] [--timeout-ms N] [--verbose]
          Serve shell/web/ over HTTP with POST /rpc and GET /events, then
          launch the system browser in --app= mode.  --port 0 (default) picks
          a free port; --no-open skips the browser.

  validate DIR [--mods-root DIR] [--user-dir DIR] [--json]
          Validate a mod package without opening the window: the same
          shell/mods/ validator the cards call, with no kernel involved, so it
          runs on a build machine that has neither the game nor a compiled
          binary.  DIR is one package (a directory with mod.json) or a mods
          root whose direct children are packages; every package is reported.
          --json prints one JSON object on stdout and nothing else, for CI and
          \`jq\`; logs and progress still go to stderr.
          Exit codes: 0 no errors, 1 the validator found errors, 2 the command
          line or the mod layer failed.  Warnings and infos never change it.

  export DIR [--out FILE.zip] [--overwrite] [--json]
          Write the package as a zip whose single top layer is the package
          folder name, so unpacking it into the game's Mods/ folder lands as
          Mods/<Name>/.  The same validator runs first: errors stop the export,
          warnings do not.  --out defaults to <modsRoot>/<Name>.zip and, like
          every write verb, must stay inside the mods root.  The archive is
          deterministic: same package, same bytes, so a shared zip can be
          checked against another copy.  Exit codes: 0 written, 1 the validator
          stopped it, 2 usage or write failure.

  install DIR [--game-dir DIR] [--overwrite] [--json]
          Copy the package into the game's Mods folder, where the game reads
          it, instead of writing a zip.  The target is <gameMods>/<Name>; the
          same validator runs first and errors stop it.  An existing folder of
          the same name is refused unless --overwrite, and the copy is staged
          beside the target and swapped in, so a failed install leaves the
          previous one intact.  --game-dir points at the game (its Mods/,
          StreamingAssets/Mods and ModsFull/Mods are tried in turn); without it
          the folder is discovered the way every other verb discovers it.
          Exit codes: 0 installed, 1 the validator stopped it, 2 usage or
          write failure.

  log [--path FILE] [--mod NAME] [--duration-ms N] [--json]
          Read the game's Player.log and print the lines worth showing: errors
          and exceptions, ModLoader/mod lines, and anything that mentions NAME.
          Without --path the most recently modified Player.log under the
          platform's log root is picked; --duration-ms N follows the file for N
          milliseconds instead and reports only the text appended meanwhile.
          --json prints one object (path, offsets, totals, lines).  Exit codes:
          0 the log was read (even with zero matches), 1 the read failed, 2 no
          log was found -- the message lists where it looked.

  sources [--json]
          Say where the mod layer's answers come from without opening the
          window: the game Mods folder discovery settled on (and where it
          looked when there was none), and which knowledge.json is in effect
          -- shipped, derived into --user-dir, or missing.  A missing game or a
          missing knowledge base is an answer, not an error.  Exit codes: 0
          answered, 2 the mod layer did not load.

  help    This text.

--workspace DIR is the directory the kernel may read and write; it is also
what the board's file tree, editor and runner cards see.

--read-root DIR registers a second directory the kernel may read from but
never write to, which is what makes a game installed outside the workspace
openable from a problem row.  Repeat the flag for more than one directory.
Nothing is added automatically: a game's Mods folder becomes readable only when
the user says so.  The directory does not have to exist yet, so a later install
is picked up; writes to it are refused as "read-only root".

--mods-root DIR bounds every \`mod.*\` call: a path that resolves outside it is
refused.  Defaults to --workspace.

--user-dir DIR is the directory the mod layer may write derived state into.  The
only thing it derives today is the knowledge base: when neither a shipped nor an
explicit knowledge.json exists, the command list is derived from the game's own
Mods folder and cached here as knowledge.json.  Defaults to
%APPDATA%/OsanaKami IDE Studio on Windows, ~/Library/Application Support/
OsanaKami IDE Studio on macOS, and $XDG_DATA_HOME/OsanaKami IDE Studio elsewhere.

--timeout-ms N is how long this side waits for one kernel call before giving
up (default ${DEFAULT_TIMEOUT_MS}).  Giving up does not cancel the call.

The window is the system's Edge/Chromium in app mode.  There is no Electron
and no bundled browser: a fork that wants a real native shell replaces this
file, not the kernel.
`;

function parseArgs(argv) {
  const options = {
    command: null,
    target: null,
    out: null,
    workspace: process.cwd(),
    readRoots: [],
    modsRoot: null,
    userDir: null,
    kernel: null,
    port: 0,
    noOpen: false,
    json: false,
    overwrite: false,
    gameDir: null,
    logPath: null,
    logMod: null,
    durationMs: 0,
    verbose: false,
    timeoutMs: DEFAULT_TIMEOUT_MS,
    help: false,
  };

  const takesValue = new Set([
    "--workspace", "--read-root", "--mods-root", "--user-dir", "--kernel", "--port",
    "--timeout-ms", "--out", "--game-dir", "--path", "--mod", "--duration-ms",
  ]);
  const rest = [];

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--help" || arg === "-h") {
      options.help = true;
    } else if (arg === "--verbose" || arg === "-v") {
      options.verbose = true;
    } else if (arg === "--no-open") {
      options.noOpen = true;
    } else if (arg === "--json") {
      options.json = true;
    } else if (arg === "--overwrite") {
      options.overwrite = true;
    } else if (arg.startsWith("--") && arg.includes("=")) {
      const [name, value] = [arg.slice(0, arg.indexOf("=")), arg.slice(arg.indexOf("=") + 1)];
      if (!takesValue.has(name)) throw new Error(`unknown option: ${name}`);
      applyOption(options, name, value);
    } else if (takesValue.has(arg)) {
      // A flag is not a value: `--workspace --no-open` used to make the
      // workspace literally "--no-open" and then fail later with something
      // unrecognisable.
      const value = argv[++i];
      if (value === undefined || value.startsWith("--")) {
        throw new Error(`${arg} needs a value`);
      }
      applyOption(options, arg, value);
    } else if (arg.startsWith("--")) {
      throw new Error(`unknown option: ${arg}`);
    } else {
      rest.push(arg);
    }
  }

  options.command = rest[0] ?? (options.help ? "help" : null);
  /*
   * Only `validate` and `export` take a positional argument.  Keeping the check
   * here means `rpc extra` still fails the same way it always did, instead of
   * the extra word being silently dropped.
   */
  options.target = rest[1] ?? null;
  if (options.target !== null && options.command !== "validate" && options.command !== "export" &&
    options.command !== "install") {
    throw new Error(`unexpected argument: ${options.target}`);
  }
  if (rest.length > 2) {
    throw new Error(`unexpected argument: ${rest[2]}`);
  }
  options.exe = path.resolve(options.kernel ?? DEFAULT_KERNEL);
  options.workspace = path.resolve(options.workspace);
  options.readRoots = options.readRoots.map((dir) => path.resolve(dir));
  if (options.modsRoot !== null) options.modsRoot = path.resolve(options.modsRoot);
  if (options.userDir !== null) options.userDir = path.resolve(options.userDir);
  if (options.gameDir !== null) options.gameDir = path.resolve(options.gameDir);
  return options;
}

function applyOption(options, name, value) {
  // `--workspace=` and `--workspace ""` both mean "I forgot the value"; taking
  // them literally would resolve to the current directory and look like it
  // worked.
  if (value === "") throw new Error(`${name} needs a value`);
  if (name === "--workspace") options.workspace = value;
  else if (name === "--read-root") options.readRoots.push(value);
  else if (name === "--mods-root") options.modsRoot = value;
  else if (name === "--user-dir") options.userDir = value;
  else if (name === "--kernel") options.kernel = value;
  else if (name === "--out") options.out = value;
  else if (name === "--game-dir") options.gameDir = value;
  else if (name === "--path") options.logPath = value;
  else if (name === "--mod") options.logMod = value;
  else if (name === "--duration-ms") {
    const durationMs = Number(value);
    if (!Number.isInteger(durationMs) || durationMs < 0 || durationMs > 600000) {
      throw new Error(`--duration-ms needs a whole number of milliseconds between 0 and 600000, got ${value}`);
    }
    options.durationMs = durationMs;
  }
  else if (name === "--port") {
    const port = Number(value);
    if (!Number.isInteger(port) || port < 0 || port > 65535) {
      throw new Error(`--port needs a number between 0 and 65535, got ${value}`);
    }
    options.port = port;
  } else if (name === "--timeout-ms") {
    const timeoutMs = Number(value);
    if (!Number.isInteger(timeoutMs) || timeoutMs < 100) {
      throw new Error(`--timeout-ms needs a whole number of milliseconds >= 100, got ${value}`);
    }
    options.timeoutMs = timeoutMs;
  }
}

export async function main(argv = process.argv.slice(2)) {
  let options;
  try {
    options = parseArgs(argv);
  } catch (err) {
    process.stderr.write(`OsanaKami IDE Studio: ${err.message}\n\n${USAGE}`);
    return 2;
  }

  if (options.help || options.command === "help" || options.command === null) {
    process.stdout.write(USAGE);
    return options.command === null && !options.help ? 2 : 0;
  }

  try {
    if (options.command === "rpc") return await runRpc(options);
    if (options.command === "serve") return await runServe(options);
    if (options.command === "validate") return await runValidate(options);
    if (options.command === "export") return await runExport(options);
    if (options.command === "install") return await runInstall(options);
    if (options.command === "log") return await runLog(options);
    if (options.command === "sources") return await runSources(options);
  } catch (err) {
    process.stderr.write(`OsanaKami IDE Studio: ${err && err.message ? err.message : err}\n`);
    return 1;
  }

  process.stderr.write(`OsanaKami IDE Studio: unknown command: ${options.command}\n\n${USAGE}`);
  return 2;
}

// Only run when executed, so the module can also be imported by tests.
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().then((code) => {
    if (code !== 0) process.exitCode = code;
  });
}
