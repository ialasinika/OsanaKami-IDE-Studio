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
