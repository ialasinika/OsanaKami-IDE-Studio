import { HERE, ROOT, require, createMods, check, section, skip, mods, stats, templates } from "./foundation.mjs";
import { spawn, spawnSync } from "node:child_process";
import { createRequire } from "node:module";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

section("the protocol seam (shell dispatch)");

export const { dispatch } = await import(pathToFileURL(join(ROOT, "shell", "main.mjs")).href);

export const languages = {
  available: true,
  list: () => ({ langs: [] }),
  tokenize: () => ({ tokens: [], lang: null }),
};

export let kernelCalls = 0;
export const kernel = {
  call: async (method) => {
    kernelCalls += 1;
    throw new Error(`the kernel must not be consulted for ${method}`);
  },
};

export async function frame(id, method, params) {
  return dispatch({ jsonrpc: "2.0", id, method, params }, kernel, languages, mods);
}

{
  const answer = await frame(1, "mod.stats", {});
  check("mod.stats answers with the knowledge counts",
    answer.result !== undefined && answer.result.commands === 136 && answer.result.nodes === 1221,
    JSON.stringify(answer).slice(0, 120));

  const missing = await frame(2, "mod.open", {});
  check("a missing required parameter is INVALID_PARAMS",
    missing.error !== undefined && missing.error.code === -32602,
    JSON.stringify(missing.error));

  const unknown = await frame(3, "mod.notAVerb", {});
  check("an unknown mod verb is METHOD_NOT_FOUND",
    unknown.error !== undefined && unknown.error.code === -32601,
    JSON.stringify(unknown.error));

  const offline = await dispatch({ jsonrpc: "2.0", id: 4, method: "mod.stats", params: {} }, kernel, languages, null);
  check("a shell without the mod layer degrades, it does not crash",
    offline.error !== undefined && offline.error.code === -32601,
    JSON.stringify(offline.error));

  const searches = await frame(5, "mod.search", { query: "Love", limit: 3 });
  check("mod.search answers with a list the card can render",
    Array.isArray(searches.result) && searches.result.length > 0 && searches.result[0].name === "Love",
    JSON.stringify(searches.result).slice(0, 120));

  /*
   * G44: `mod.sources` is the read-only answer the settings card renders -- the
   * game folder discovery picked and the knowledge base in effect.  The seam is
   * the one table a verb can be forgotten in, so it gets its own frame.
   */
  const sourcesFrame = await frame(6, "mod.sources", {});
  check("mod.sources answers with the game folder and the knowledge state",
    sourcesFrame.result !== undefined &&
      sourcesFrame.result.game !== undefined &&
      typeof sourcesFrame.result.game.found === "boolean" &&
      Array.isArray(sourcesFrame.result.game.tried) &&
      sourcesFrame.result.knowledge !== undefined &&
      typeof sourcesFrame.result.knowledge.state === "string" &&
      typeof sourcesFrame.result.knowledge.schemas === "number",
    JSON.stringify(sourcesFrame).slice(0, 240));

  /*
   * G55: `mod.packages` is what the card's picker reads.  The same seam problem
   * applies -- a verb added to the facade and forgotten in the method table is
   * invisible to every facade test -- so the frame asserts the shape the card
   * relies on, not a particular machine's game folder.
   */
  const packagesFrame = await frame(7, "mod.packages", {});
  check("mod.packages answers with the folder it read and the packages under it",
    packagesFrame.result !== undefined &&
      typeof packagesFrame.result.found === "boolean" &&
      Array.isArray(packagesFrame.result.packages) &&
      packagesFrame.result.packages.every((item) =>
        item !== null && typeof item === "object" &&
        typeof item.name === "string" && typeof item.dir === "string"),
    JSON.stringify(packagesFrame.result));

  const notified = await dispatch({ jsonrpc: "2.0", method: "mod.stats", params: {} }, kernel, languages, mods);
  check("a notification is not answered", notified === null, JSON.stringify(notified));

  /*
   * G18: the docs card points `stats`, `types`, `search` and `docFor` at a
   * package by passing `root` in the frame.  The facade learned the parameter
   * first; if this table drops it, the card silently falls back to the knowledge
   * base and every test that calls the facade directly stays green.
   */
  const seamDocsRoot = mkdtempSync(join(tmpdir(), "infantgod-docs-seam-"));
  try {
    const pkg = join(seamDocsRoot, "DocsSeam");
    mkdirSync(join(pkg, "Defines", "SpellEvent"), { recursive: true });
    writeFileSync(join(pkg, "mod.json"), JSON.stringify({ name: "DocsSeam" }, null, 2) + "\n");
    writeFileSync(join(pkg, "Defines", "SpellEvent", "ZzSeam.json"),
      JSON.stringify({ techName: "ZzSeam" }, null, 2) + "\n");
    const seamMods = createMods({ modsRoot: seamDocsRoot });
    const pointed = await dispatch({ jsonrpc: "2.0", id: 900, method: "mod.stats", params: { root: "DocsSeam" } },
      kernel, languages, seamMods);
    check("the seams carries the package root the card passes",
      pointed.result !== undefined && pointed.result.package !== undefined
        && pointed.result.package.name === "DocsSeam",
      JSON.stringify(pointed.result && pointed.result.package).slice(0, 120));
    const plain = await dispatch({ jsonrpc: "2.0", id: 901, method: "mod.stats", params: {} },
      kernel, languages, seamMods);
    check("and a frame without a root keeps the knowledge-base shape",
      plain.result !== undefined && !("package" in plain.result),
      JSON.stringify(Object.keys(plain.result || {})).slice(0, 120));
  } finally {
    rmSync(seamDocsRoot, { recursive: true, force: true });
  }

  /*
   * G61: the version verbs are window-only; the history executor is injected, so
   * this frame proves the table forwards the package directory (and the message
   * or oid) rather than that a machine has a store.  Without the injection the
   * verbs must still answer "unavailable", not throw.
   */
  const seamCalls = [];
  const seamHistory = {
    ensure: (dir) => { seamCalls.push(["ensure", dir]); return { ok: true, store: "store", created: true }; },
    status: (dir) => { seamCalls.push(["status", dir]); return { ok: true, entries: [] }; },
    save: (dir, message) => { seamCalls.push(["save", dir, message]); return { ok: true, committed: true, oid: "0123456789ab" }; },
    log: (dir, limit) => { seamCalls.push(["log", dir, limit]); return { ok: true, commits: [{ oid: "0123456789ab", message: "one" }] }; },
    reset: (dir, oid) => { seamCalls.push(["reset", dir, oid]); return { ok: true, oid }; },
  };
  const historyMods = createMods({ modsRoot: seamDocsRoot, history: seamHistory });
  const vcsSave = await dispatch({ jsonrpc: "2.0", id: 910, method: "vcs.save", params: { dir: "DocsSeam", message: "first" } },
    kernel, languages, historyMods);
  check("vcs.save forwards the package and the message to the store",
    vcsSave.error === undefined
      && vcsSave.result !== undefined && vcsSave.result.committed === true
      && seamCalls.some((call) => call[0] === "save" && call[1].endsWith("DocsSeam") && call[2] === "first"),
    JSON.stringify({ result: vcsSave.result, calls: seamCalls }));
  const vcsLog = await dispatch({ jsonrpc: "2.0", id: 911, method: "vcs.log", params: { dir: "DocsSeam", limit: 3 } },
    kernel, languages, historyMods);
  check("vcs.log forwards the limit and answers with commits",
    vcsLog.result !== undefined && vcsLog.result.commits.length === 1
      && seamCalls.some((call) => call[0] === "log" && call[2] === 3),
    JSON.stringify({ result: vcsLog.result, calls: seamCalls }));
  const vcsRestore = await dispatch({ jsonrpc: "2.0", id: 912, method: "vcs.restore", params: { dir: "DocsSeam", oid: "fedcba987654" } },
    kernel, languages, historyMods);
  check("vcs.restore forwards the version to bring back",
    vcsRestore.result !== undefined && vcsRestore.result.ok === true
      && seamCalls.some((call) => call[0] === "reset" && call[2] === "fedcba987654"),
    JSON.stringify({ result: vcsRestore.result, calls: seamCalls }));
  const vcsUnavailable = await dispatch({ jsonrpc: "2.0", id: 913, method: "vcs.status", params: { dir: "DocsSeam" } },
    kernel, languages, mods);
  check("without a store the verbs answer unavailable, not an error",
    vcsUnavailable.error === undefined && vcsUnavailable.result !== undefined
      && vcsUnavailable.result.reason === "unavailable",
    JSON.stringify(vcsUnavailable));

  check("no mod.* frame reached the kernel", kernelCalls === 0, String(kernelCalls));

  /*
   * `mod.scaffold` is the one async verb.  When it refused a destination
   * outside its root, the rejection used to escape `dispatch`: the shell
   * answered nothing, logged an unhandled rejection and died, taking the
   * kernel child with it.  A refused verb has to be a frame like any other.
   */
  const seamSandbox = mkdtempSync(join(tmpdir(), "infantgod-seam-"));
  try {
    const scoped = createMods({ modsRoot: seamSandbox });
    let escaped = null;
    let threw = null;
    try {
      escaped = await dispatch({
        jsonrpc: "2.0",
        id: 6,
        method: "mod.scaffold",
        params: { dir: ROOT, modName: "Nope", template: "minimal" },
      }, kernel, languages, scoped);
    } catch (err) {
      threw = err;
    }
    check("an async verb's rejection becomes an error frame, not a crash",
      threw === null && escaped !== null && escaped.error !== undefined,
      threw !== null ? `threw: ${threw.message}` : JSON.stringify(escaped));
    if (escaped !== null && escaped.error !== undefined) {
      check("the refusal is a well-formed JSON-RPC error",
        escaped.jsonrpc === "2.0" && escaped.id === 6 && typeof escaped.error.code === "number",
        JSON.stringify(escaped));
      check("the refusal names the containment rule",
        /越界|outside|EOUTSIDE/i.test(String(escaped.error.message)),
        escaped.error.message);
    }
  } finally {
    rmSync(seamSandbox, { recursive: true, force: true });
  }
}

/* ------------------------------------------------------------------ */
/* the File menu's "新建模组…" (electron/newmod.js)                     */
/* ------------------------------------------------------------------ */

/*
 * The menu item is the one native feature whose work is a plain JSON-RPC
 * frame, and electron/newmod.js is split out of main.js so that every part but
 * the save dialog itself is testable here -- no Electron, no window, no
 * kernel.  The first check is a parity check: the labels have to be
 * scaffold.js's `nameZh`, because a menu that offers a template id the engine
 * does not know fails only after the user has already picked it.
 */

section('the File menu: "新建模组…"');

export const newMod = require(join(ROOT, "electron", "newmod.js"));
export const scaffoldCore = require(join(HERE, "scaffold.js"));

export const engineTemplates = (scaffoldCore.MOD_TEMPLATES || []).map((t) => ({ id: t.id, nameZh: t.nameZh }));
check("the menu's templates are the engine's, in order",
  JSON.stringify(newMod.TEMPLATES.map((t) => ({ id: t.id, label: t.label }))) ===
    JSON.stringify(engineTemplates.map((t) => ({ id: t.id, label: t.nameZh }))),
  JSON.stringify({ menu: newMod.TEMPLATES, engine: engineTemplates }));
check("and the menu does not grow a fifth item on its own",
  newMod.TEMPLATES.length === 4 && newMod.TEMPLATES.length === engineTemplates.length,
  String(newMod.TEMPLATES.length));

/*
 * The dialog hands back a name the user typed.  Everything Windows cannot put
 * in a folder -- and everything that would silently mean "somewhere else" --
 * has to come back as a throw, so the menu returns the user to the dialog
 * instead of creating a differently-named folder behind their back.
 */
export const unnamed = [];
for (const bad of ["", "   ", "a/b", "a\\b", ".", "..", "a:b", "name."]) {
  try {
    newMod.plan({ parent: join(tmpdir(), "mods"), typedName: bad });
    unnamed.push(bad);
  } catch (err) {
    // the expected way out
  }
}
check("plan refuses an empty, path-like or unspellable name",
  unnamed.length === 0, JSON.stringify(unnamed));

export let noParent = null;
try {
  newMod.plan({ parent: "", typedName: "Probe" });
} catch (err) {
  noParent = err;
}
check("plan refuses to guess when there is no writable parent",
  noParent instanceof Error, String(noParent));

export const planned = newMod.plan({ parent: join(tmpdir(), "mods"), typedName: "Probe" });
check("plan hands mod.scaffold the folder the user named, not a package path",
  planned.dir === join(tmpdir(), "mods") && planned.modName === "Probe",
  JSON.stringify(planned));

export const plannedCjk = newMod.plan({ parent: join(tmpdir(), "mods"), typedName: "  幼神模组  " });
check("plan trims a CJK name and still passes the parent through",
  plannedCjk.dir === join(tmpdir(), "mods") && plannedCjk.modName === "幼神模组",
  JSON.stringify(plannedCjk));

check("defaultParent prefers a mods root",
  newMod.defaultParent({ workspace: "W", modsRoot: "M" }) === "M",
  String(newMod.defaultParent({ workspace: "W", modsRoot: "M" })));
check("defaultParent falls back to the workspace",
  newMod.defaultParent({ workspace: "W", modsRoot: "" }) === "W" &&
    newMod.defaultParent({ workspace: "W" }) === "W",
  String(newMod.defaultParent({ workspace: "W", modsRoot: "" })));

export const scaffoldFrame = newMod.request("mod.scaffold", { dir: "D", modName: "N", template: "minimal" });
check("the request frame is the frozen JSON-RPC shape",
  JSON.stringify(scaffoldFrame) === JSON.stringify({
    jsonrpc: "2.0", id: 1, method: "mod.scaffold",
    params: { dir: "D", modName: "N", template: "minimal" },
  }),
  JSON.stringify(scaffoldFrame));

export const picked = [];
export const fragment = newMod.menuTemplate({ onPick: (id) => picked.push(id) });
check("the File menu gains one submenu with one item per template",
  Array.isArray(fragment) && fragment.length === 1 &&
    fragment[0].submenu.length === newMod.TEMPLATES.length &&
    fragment[0].submenu.every((item) => typeof item.click === "function"),
  JSON.stringify(fragment));
check("the submenu is the Chinese menu name",
  fragment[0].label === "新建模组…", String(fragment[0].label));
for (const item of fragment[0].submenu) item.click();
check("clicking item i reports template i",
  JSON.stringify(picked) === JSON.stringify(newMod.TEMPLATES.map((t) => t.id)),
  JSON.stringify(picked));

/*
 * D1: after the scaffold, main.js reloads the window so the new package shows
 * up.  A bare reload used to be enough and left the package invisible -- the
 * board on disk still held `mod(dir: "")` -- so the reload now carries the
 * directory in the URL.  This is the one function that builds that address: it
 * has to survive backslashes, spaces and CJK, and refuse to build one that
 * names no package.
 */
export const urlOf = (shell, root) => {
  try {
    return newMod.openModUrl(shell, root);
  } catch (err) {
    return `threw: ${err.message}`;
  }
};
export const baseUrl = "http://127.0.0.1:7788";

check("openModUrl puts the created package in the page address",
  newMod.openModUrl({ url: baseUrl }, "C:\\work\\NewMod") ===
    `${baseUrl}/?mod=${encodeURIComponent("C:\\work\\NewMod")}`,
  newMod.openModUrl({ url: baseUrl }, "C:\\work\\NewMod"));

check("openModUrl handles a trailing slash, spaces and CJK",
  newMod.openModUrl({ url: `${baseUrl}/` }, "C:\\我的 模组") ===
    `${baseUrl}/?mod=${encodeURIComponent("C:\\我的 模组")}`,
  String(newMod.openModUrl({ url: `${baseUrl}/` }, "C:\\我的 模组")));

check("and a path survives the round trip out of the query string",
  new URL(newMod.openModUrl({ url: baseUrl }, "C:\\work\\NewMod")).searchParams.get("mod") ===
    "C:\\work\\NewMod",
  String(new URL(newMod.openModUrl({ url: baseUrl }, "C:\\work\\NewMod")).searchParams.get("mod")));

check("openModUrl refuses a session without an endpoint",
  /url/.test(urlOf({}, "M")) && /url/.test(urlOf(null, "M")),
  `${urlOf({}, "M")} / ${urlOf(null, "M")}`);

check("openModUrl refuses to build a URL with no package in it",
  /模组目录/.test(urlOf({ url: baseUrl }, "")) && /模组目录/.test(urlOf({ url: baseUrl }, null)),
  `${urlOf({ url: baseUrl }, "")} / ${urlOf({ url: baseUrl }, null)}`);

/*
 * `createMod` is a transport: one POST, one frame, one reply.  The stub fetch
 * records what went over the wire, which is the part a live endpoint would
 * otherwise hide.
 */
export const sent = [];
export const receipt = await newMod.createMod({
  endpoint: "http://127.0.0.1:12345",
  dir: "M",
  modName: "Probe",
  template: "minimal",
  fetchImpl: async (url, init) => {
    sent.push({ url, init });
    return {
      status: 200,
      text: async () => JSON.stringify({
        jsonrpc: "2.0", id: 1,
        result: { modRoot: "M\\Probe", created: ["mod.json", "README.md"], warnings: [] },
      }),
    };
  },
});
check("createMod posts once to <endpoint>/rpc",
  sent.length === 1 && sent[0].url === "http://127.0.0.1:12345/rpc",
  sent.length ? sent[0].url : "(no request)");
check("createMod uses POST",
  sent.length === 1 && sent[0].init.method === "POST",
  sent.length ? sent[0].init.method : "(no request)");
check("the body is the exact mod.scaffold frame",
  sent.length === 1 && sent[0].init.body === JSON.stringify({
    jsonrpc: "2.0", id: 1, method: "mod.scaffold",
    params: { dir: "M", modName: "Probe", template: "minimal" },
  }),
  sent.length ? sent[0].init.body : "(no request)");
check("createMod returns the reply's result",
  receipt.modRoot === "M\\Probe" && receipt.created.length === 2,
  JSON.stringify(receipt));

export const slashed = [];
await newMod.createMod({
  endpoint: "http://127.0.0.1:12345/",
  dir: "M",
  modName: "Probe",
  template: "minimal",
  fetchImpl: async (url, init) => {
    slashed.push({ url, init });
    return { status: 200, text: async () => JSON.stringify({ result: { modRoot: "M\\Probe", created: [], warnings: [] } }) };
  },
});
check("a trailing slash in the endpoint does not double the path",
  slashed.length === 1 && slashed[0].url === "http://127.0.0.1:12345/rpc",
  slashed.length ? slashed[0].url : "(no request)");

export let refusedReply = null;
try {
  await newMod.createMod({
    endpoint: "http://127.0.0.1:12345",
    dir: "M",
    modName: "Nope",
    template: "minimal",
    fetchImpl: async () => ({
      status: 200,
      text: async () => JSON.stringify({
        jsonrpc: "2.0", id: 1,
        error: { code: -32000, name: "EOUTSIDE", message: "路径越界，已拒绝: C:\\outside" },
      }),
    }),
  });
} catch (err) {
  refusedReply = err;
}
check("a refused scaffold throws the server's own error",
  refusedReply instanceof Error && refusedReply.message.includes("路径越界") &&
    refusedReply.code === -32000 && refusedReply.name === "EOUTSIDE",
  refusedReply === null ? "(nothing thrown)" : `${refusedReply.name} ${refusedReply.code} ${refusedReply.message}`);

check("isInside tells a workspace from a sibling of it",
  newMod.isInside(join(tmpdir(), "ws", "Probe"), join(tmpdir(), "ws")) === true &&
    newMod.isInside(join(tmpdir(), "wsTwo"), join(tmpdir(), "ws")) === false &&
    newMod.isInside(join(tmpdir(), "ws"), join(tmpdir(), "ws")) === true,
  "ws/Probe, wsTwo, ws");

/*
 * G34: the 0.1.0 audit called the new-mod shortcut's failure paths F1-F5.  The
 * save dialog cannot be constrained to a folder, so the containment question is
 * answered before the write; a retry after a half-written package has to carry
 * `overwrite`; and a shell that never answers has to become an error.
 */
export const confinedOutside = newMod.confine({ parent: join(tmpdir(), "other"), root: join(tmpdir(), "ws") });
check("confine rebases a folder outside the writable root",
  confinedOutside.moved === true &&
    confinedOutside.dir === join(tmpdir(), "ws") &&
    confinedOutside.root === join(tmpdir(), "ws"),
  JSON.stringify(confinedOutside));

export const confinedInside = newMod.confine({ parent: join(tmpdir(), "ws", "Mods", "Deep"), root: join(tmpdir(), "ws") });
check("and leaves a folder inside it alone",
  confinedInside.moved === false && confinedInside.dir === join(tmpdir(), "ws", "Mods", "Deep"),
  JSON.stringify(confinedInside));

export const writableOf = newMod.writableRoot({ workspace: "W", modsRoot: "M" });
check("writableRoot is the folder mod.scaffold would accept",
  writableOf === "M" && newMod.writableRoot({ workspace: "W" }) === "W",
  String(writableOf));

check("needsOverwrite recognises the scaffold's non-empty refusal",
  newMod.needsOverwrite(new Error(
    'scaffoldMod: target "C:\\work\\Probe" already exists and is not empty (pass { overwrite: true } to replace)'
  )) === true &&
    newMod.needsOverwrite(new Error("路径越界，已拒绝: C:\\outside")) === false &&
    newMod.needsOverwrite(null) === false,
  "already exists / EOUTSIDE / null");

export const overwriteFrame = [];
await newMod.createMod({
  endpoint: "http://127.0.0.1:12345",
  dir: "M",
  modName: "Probe",
  template: "minimal",
  overwrite: true,
  fetchImpl: async (url, init) => {
    overwriteFrame.push(JSON.parse(init.body));
    return { status: 200, text: async () => JSON.stringify({ result: { modRoot: "M\\Probe", created: [], warnings: [] } }) };
  },
});
check("an agreed overwrite crosses the frame",
  overwriteFrame.length === 1 && overwriteFrame[0].params.overwrite === true,
  JSON.stringify(overwriteFrame));
check("an ordinary attempt does not carry the flag at all",
  !("overwrite" in JSON.parse(sent[0].init.body).params),
  sent.length ? sent[0].init.body : "(no request)");

export let timedOut = null;
const slowStarted = Date.now();
try {
  await newMod.createMod({
    endpoint: "http://127.0.0.1:12345",
    dir: "M",
    modName: "Slow",
    template: "minimal",
    timeoutMs: 25,
    // Never resolves and ignores `signal`: the deadline has to be independent
    // of the fetch's cooperation, which is exactly what F4 was about.
    fetchImpl: () => new Promise(() => {}),
  });
} catch (err) {
  timedOut = err;
}
check("a scaffold that never answers fails with a timeout instead of silence",
  timedOut instanceof Error && timedOut.name === "TimeoutError" &&
    /没有回答 mod\.scaffold/.test(timedOut.message) && Date.now() - slowStarted < 5000,
  timedOut === null ? "(nothing thrown)" : `${timedOut.name} ${timedOut.message}`);


/*
 * The one check that is not a stub.  `mod.scaffold` is served above the
 * kernel, but the frame still has to survive a real server, a real port and
 * the containment rule -- a stub cannot prove that.  A Windows-only taskkill
 * is what keeps the spawned shell's kernel child from outliving the run.
 */
export const KERNEL_EXE = join(ROOT, "build", "infantgod.exe");
export const CAN_SPAWN_SHELL = process.platform === "win32" && process.versions.electron === undefined &&
  existsSync(KERNEL_EXE) && existsSync(join(ROOT, "shell", "main.mjs"));

if (!CAN_SPAWN_SHELL) {
  skip("a real mod.scaffold over POST /rpc (no kernel or no Windows taskkill)");
} else {
  const realSandbox = mkdtempSync(join(tmpdir(), "infantgod-newmod-"));
  let shell = null;
  try {
    const env = { ...process.env };
    delete env.ELECTRON_RUN_AS_NODE;
    shell = spawn(process.execPath, [
      join(ROOT, "shell", "main.mjs"), "serve",
      "--workspace", realSandbox, "--mods-root", realSandbox,
      "--port", "0", "--no-open",
    ], { cwd: ROOT, env, stdio: ["ignore", "pipe", "pipe"] });

    let banner = "";
    const endpoint = await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`no endpoint after 20s:\n${banner}`)), 20000);
      shell.stdout.on("data", (chunk) => {
        banner += String(chunk);
        const found = banner.match(/board\s+(http:\/\/127\.0\.0\.1:\d+\/)/);
        if (found) {
          clearTimeout(timer);
          resolve(found[1]);
        }
      });
      shell.stderr.on("data", (chunk) => { banner += String(chunk); });
      shell.once("exit", (code) => {
        clearTimeout(timer);
        reject(new Error(`the shell exited ${code}:\n${banner}`));
      });
    });

    /*
     * plan() runs here exactly as main.js runs it: the double-nesting defect
     * lived in that composition (a `dir` one level too deep), so the check has
     * to cover the seam and not just the two pieces separately.
     */
    const target = newMod.plan({ parent: realSandbox, typedName: "Probe" });
    const written = await newMod.createMod({
      endpoint, dir: target.dir, modName: target.modName, template: "minimal",
    });
    check("a live endpoint scaffolds the minimal mod onto disk",
      written.modRoot === join(realSandbox, "Probe") &&
        existsSync(join(realSandbox, "Probe", "mod.json")) &&
        existsSync(join(realSandbox, "Probe", "README.md")),
      JSON.stringify(written));
    check("the folder the dialog named is the mod's own, not a parent of it",
      !existsSync(join(realSandbox, "Probe", "Probe")),
      join(realSandbox, "Probe", "Probe"));
    check("and the sandbox holds exactly that mod",
      JSON.stringify(readdirSync(realSandbox)) === JSON.stringify(["Probe"]) &&
        JSON.stringify(readdirSync(join(realSandbox, "Probe")).sort()) === JSON.stringify(["README.md", "mod.json"]),
      JSON.stringify(readdirSync(realSandbox)));

    /*
     * F2 end to end: the second attempt is the one the menu used to be unable
     * to finish.  Without `overwrite` the same folder is refused; with it the
     * same frame repairs the package.
     */
    let refusedAgain = null;
    try {
      await newMod.createMod({ endpoint, dir: target.dir, modName: target.modName, template: "minimal" });
    } catch (err) {
      refusedAgain = err;
    }
    check("a second run at the same folder is refused by default",
      newMod.needsOverwrite(refusedAgain),
      refusedAgain === null ? "(nothing thrown)" : String(refusedAgain.message));

    let replaced = null;
    let overwriteError = null;
    try {
      replaced = await newMod.createMod({
        endpoint, dir: target.dir, modName: target.modName, template: "minimal", overwrite: true,
      });
    } catch (err) {
      overwriteError = err;
    }
    check("and an agreed overwrite repairs it over a live endpoint",
      replaced !== null && replaced.modRoot === join(realSandbox, "Probe") &&
        existsSync(join(realSandbox, "Probe", "mod.json")) &&
        existsSync(join(realSandbox, "Probe", "README.md")),
      overwriteError === null ? JSON.stringify(replaced) : String(overwriteError.message));
  } catch (err) {
    check("a live endpoint scaffolds the minimal mod onto disk", false, String((err && err.message) || err));
    check("and the sandbox holds exactly that mod", false, "the run above failed");
  } finally {
    if (shell !== null && shell.exitCode === null) {
      try {
        spawnSync("taskkill", ["/pid", String(shell.pid), "/T", "/F"], { stdio: "ignore" });
      } catch (err) {
        shell.kill();
      }
    }
    rmSync(realSandbox, { recursive: true, force: true });
  }
}

/* ------------------------------------------------------------------ */
/* the File menu's "打开示例 Mod" (electron/examples.js)                */
/* ------------------------------------------------------------------ */

/*
 * The demo package cannot be opened where it ships -- a card's `dir` never
 * leaves the mods folder -- so the menu item asks `mod.example` to copy it in
 * first and then navigates the same `?mod=` way the new-mod shortcut does.  As
 * with newmod.js, the frame and the address are the parts that can be wrong
 * without a window, and both are pure here.
 */

/* ------------------------------------------------------------------ */
/* G49: the agent's provider and tools (shell/main.mjs)               */
/* ------------------------------------------------------------------ */

/*
 * These frames are what the agent card asks before it can run one round:
 * whether a provider is configured, which tools exist, one completion, and one
 * tool call.  No network here -- `ai.chat` is only exercised on its parameter
 * checks, because a real completion needs a provider and a key.  The context is
 * handed in explicitly with a throwaway user dir, so the test never reads (or
 * writes) the machine's own settings.
 */

{
  const { createConfigStore } = await import(
    pathToFileURL(join(ROOT, "shell", "ai", "config.mjs")).href
  );
  const { createPreferenceStore } = await import(
    pathToFileURL(join(ROOT, "shell", "ai", "settings.mjs")).href
  );
  const aiUserDir = mkdtempSync(join(tmpdir(), "infantgod-ai-"));
  const settings = {
    userDir: aiUserDir,
    app: { workspace: null, modsRoot: null },
    ai: createConfigStore({ dir: aiUserDir }),
    prefs: createPreferenceStore({ dir: aiUserDir }),
  };
  const aiFrame = (id, method, params) =>
    dispatch({ jsonrpc: "2.0", id, method, params }, kernel, languages, mods, settings);
  try {
    const status = await aiFrame(300, "ai.status", {});
    check("ai.status answers with the provider and the tools it can offer",
      status.result !== undefined &&
        typeof status.result.configured === "boolean" &&
        typeof status.result.model === "string" &&
        status.result.hasApiKey === false &&
        Array.isArray(status.result.tools) &&
        status.result.tools.includes("kb.search") &&
        status.result.tools.includes("mod.validate"),
      JSON.stringify(status).slice(0, 200));

    const tools = await aiFrame(301, "ai.tools", {});
    const listed = Array.isArray(tools.result && tools.result.tools) ? tools.result.tools : [];
    check("ai.tools answers with OpenAI function declarations",
      listed.length >= 2 &&
        listed.every((entry) => entry.type === "function" &&
          entry.function !== null && typeof entry.function.name === "string" &&
          typeof entry.function.parameters === "object"),
      JSON.stringify(tools).slice(0, 200));

    const searched = await aiFrame(302, "ai.invoke", {
      name: "kb.search",
      arguments: { prefix: "Love", limit: 3 },
    });
    check("ai.invoke runs a read-only tool and answers with its result",
      searched.result !== undefined && searched.result.ok === true &&
        searched.result.name === "kb.search" &&
        Array.isArray(searched.result.result && searched.result.result.items),
      JSON.stringify(searched).slice(0, 200));

    const unknownTool = await aiFrame(303, "ai.invoke", { name: "kb.nothing", arguments: {} });
    check("ai.invoke reports an unknown tool as an outcome, not a frame error",
      unknownTool.result !== undefined && unknownTool.result.ok === false &&
        unknownTool.result.error !== null && unknownTool.result.error.code === "unknown_tool",
      JSON.stringify(unknownTool).slice(0, 200));

    const noMessages = await aiFrame(304, "ai.chat", {});
    check("ai.chat without messages is INVALID_PARAMS",
      noMessages.error !== undefined && noMessages.error.code === -32602,
      JSON.stringify(noMessages.error));

    const tooManyTools = await aiFrame(305, "ai.chat", {
      messages: [{ role: "user", content: "hi" }],
      tools: Array.from({ length: 65 }, () => ({ type: "function" })),
    });
    check("ai.chat caps the tools array at 64",
      tooManyTools.error !== undefined && tooManyTools.error.code === -32602,
      JSON.stringify(tooManyTools.error));
  } finally {
    rmSync(aiUserDir, { recursive: true, force: true });
  }
}
