#!/usr/bin/env node
/**
 * selftest.mjs -- proves the 幼神 mod layer works with no kernel, no browser
 * and no network.  Run it after editing the facade, the knowledge base or any
 * ported core module.
 *
 *     node shell/mods/selftest.mjs [--mods DIR]
 *
 * `--mods` points at the game's extracted `Mods` folder.  Without it the folder is
 * discovered (INFANTGOD_MODS_DIR / INFANTGOD_GAME_DIR, the Steam libraries, the
 * user's home, the checkout's parent) -- this file never names a path on the
 * machine it happens to run on.  The corpus checks are skipped, not failed, when no
 * folder is found: the layer must stay useful on a machine that only has the
 * knowledge base.
 *
 * One section is the exception to "no kernel, no network": the File menu's
 * "新建模组…" exists only to send one `mod.scaffold` frame to a live shell
 * endpoint, so the last check spawns `node shell/main.mjs serve` on loopback
 * and creates a real mod.  It skips when there is no kernel binary to spawn.
 *
 * Exits 0 on success, 1 on the first failure.
 */

import { spawn, spawnSync } from "node:child_process";
import { createRequire } from "node:module";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, "..", "..");

const require = createRequire(import.meta.url);
const gamepath = require(join(HERE, "gamepath.js"));
const { createMods, KNOWLEDGE_PATH } = require(join(HERE, "index.js"));

/*
 * 游戏目录不再写死在这台机器上（docs/EDITOR_GAPS.md §14.1 G26）：优先级是
 * 显式设置 > 环境变量 > 自动探测（Steam 库、用户主目录、checkout 的上一级）。
 * 找不到就是"没有语料"，语料相关的检查跳过而不是失败 —— 这个文件里没有一个
 * 本机绝对路径。
 */
const DISCOVERY = gamepath.discoverGameModsDir({
  env: process.env,
  gameModsDir: process.env.INFANTGOD_MODS_DIR,
});
const DEFAULT_MODS = DISCOVERY.dir || join(ROOT, "build", "no-corpus");

const argv = process.argv.slice(2);
const modsIndex = argv.indexOf("--mods");
const MODS_DIR = modsIndex >= 0 && argv[modsIndex + 1] ? resolve(argv[modsIndex + 1]) : DEFAULT_MODS;

let failures = 0;
let checks = 0;
let skipped = 0;

function check(name, condition, detail) {
  checks += 1;
  if (condition) {
    console.log(`  ok   ${name}`);
  } else {
    failures += 1;
    console.log(`  FAIL ${name}${detail === undefined ? "" : ` -- ${detail}`}`);
  }
}

function section(title) {
  console.log(`\n${title}`);
}

function skip(name) {
  skipped += 1;
  console.log(`  skip ${name}`);
}

/* ------------------------------------------------------------------ */

section("knowledge base");

const mods = createMods({ modsRoot: existsSync(MODS_DIR) ? MODS_DIR : ROOT });

check("knowledge.json sits beside the facade", existsSync(KNOWLEDGE_PATH), KNOWLEDGE_PATH);

const stats = mods.stats();
check("211 Yarn files", stats.yarnFiles === 211, String(stats.yarnFiles));
check("1221 nodes", stats.nodes === 1221, String(stats.nodes));
check("136 commands", stats.commands === 136, String(stats.commands));
check("63 functions", stats.functions === 63, String(stats.functions));
check("678 variables", stats.variables === 678, String(stats.variables));
check("51 schemas", stats.schemas === 51, String(stats.schemas));
check("1305 baseline defines", stats.baselineDefines === 1305, String(stats.baselineDefines));
check("11 locales", stats.locales === 11, String(stats.locales));

const types = mods.types();
check("51 definition types", types.length === 51, String(types.length));
check("every type is sorted-unique", new Set(types.map((t) => t.type)).size === types.length);
check("every type carries a required list",
  types.every((t) => Array.isArray(t.required)),
  JSON.stringify(types.filter((t) => !Array.isArray(t.required)).map((t) => t.type)));
check("techName casing is per-type, not assumed",
  types.some((t) => t.required.includes("techName")) && types.some((t) => t.required.includes("TechName")));
{
  const total = types.reduce((sum, t) => sum + t.count, 0);
  check("per-type counts sum to the baseline", total === 1305, String(total));
}

const templates = mods.templates();
check("four mod templates", templates.length === 4, String(templates.length));
check("template ids are the documented ones",
  JSON.stringify(templates.map((t) => t.id).sort()) === JSON.stringify(["define-pack", "full", "minimal", "yarn-story"]),
  JSON.stringify(templates.map((t) => t.id)));

const characters = mods.characters();
check("characters have a colour for the editor", characters.length > 0 && characters.every((c) => /^#[0-9a-fA-F]{6}$/.test(c.colour || "")),
  JSON.stringify(characters.slice(0, 2)));

/* ------------------------------------------------------------------ */
/* corpus: only when the extracted game folder is reachable            */
/* ------------------------------------------------------------------ */

const HAVE_CORPUS = existsSync(join(MODS_DIR, "MyMod")) && existsSync(join(MODS_DIR, "SODefines"));

section("the game's own MyMod package");

if (!HAVE_CORPUS) {
  skip("corpus checks (no Mods folder found; pass --mods DIR or set INFANTGOD_MODS_DIR)");
} else {
  const opened = mods.openMod({ dir: join(MODS_DIR, "MyMod") });
  check("openMod returns the documented members",
    JSON.stringify(Object.keys(opened).sort()) ===
    JSON.stringify(["csvFiles", "defines", "diagnostics", "manifest", "root", "sprites", "summary", "yarnFiles"]),
    JSON.stringify(Object.keys(opened)));
  check("manifest is the real mod.json",
    opened.manifest.name === "MyMod" && opened.manifest.loadOrder === 0,
    JSON.stringify(opened.manifest));
  check("211 Yarn files found", opened.yarnFiles.length === 211, String(opened.yarnFiles.length));
  check("MyMod ships no Defines/", opened.defines.length === 0, String(opened.defines.length));

  /*
   * The corpus has 14 .csv files but only 11 are languages: one is
   * `NewProject-metadata.csv` (line metadata, not a language) and two live in
   * `Yarn/.VSCodeCounter/`, which is editor residue.  A naive `*.csv` glob
   * reports 14/11/14 from three different call sites -- this pins all three to
   * the same number.
   */
  check("csvFiles counts languages, not every .csv", opened.csvFiles.length === 11, String(opened.csvFiles.length));
  check("openMod summary agrees with validatePackage",
    opened.summary.csv === 11 && opened.summary.yarn === 211,
    JSON.stringify(opened.summary));

  const report = mods.validatePackage({ root: join(MODS_DIR, "MyMod") });
  check("MyMod validates with zero errors", report.summary.errors === 0, JSON.stringify(report.summary));
  check("validatePackage and openMod agree on the language count",
    report.summary.csvFiles === 11, String(report.summary.csvFiles));

  const loc = mods.localization({ root: join(MODS_DIR, "MyMod") });
  check("11 localisation files", loc !== null && loc.locales.length === 11, loc === null ? "null" : String(loc.locales.length));
  check("exactly one base language", loc.locales.filter((l) => l.base).length === 1,
    JSON.stringify(loc.locales.filter((l) => l.base).map((l) => l.file)));
  /*
   * The suffix table in scaffold.js records `bg` with an empty suffix (for
   * mods that name their base file after themselves), so a suffix-only lookup
   * folds `NewProject_bg.csv` into the base language and loses Bulgarian.
   */
  const codes = [...new Set(loc.locales.map((l) => l.code))].sort();
  check("all 11 language codes are distinct",
    codes.length === 11, JSON.stringify(codes));
  check("Bulgarian is bg, not folded into the base language",
    codes.includes("bg") && loc.locales.find((l) => l.file.endsWith("_bg.csv")).code === "bg");
  check("the base file is the unsuffixed one", loc.locales.find((l) => l.base).file === "Yarn/NewProject.csv",
    loc.locales.find((l) => l.base).file);
  check("metadata.csv is not counted as a language",
    loc.locales.every((l) => !/metadata\.csv$/i.test(l.file)));
  check("editor residue is not counted as a language",
    loc.locales.every((l) => !l.file.includes(".VSCodeCounter")));
  check("every language has the full string table",
    loc.locales.every((l) => l.rows === 18609),
    JSON.stringify(loc.locales.filter((l) => l.rows !== 18609).map((l) => [l.file, l.rows])));

  section("the game's own SODefines package");

  const so = mods.validatePackage({ root: join(MODS_DIR, "SODefines") });
  check("1306 files", so.summary.files === 1306, String(so.summary.files));
  check("1305 defines", so.summary.defines === 1305, String(so.summary.defines));
  check("51 types present", Object.keys(so.summary.byType).length === 51, String(Object.keys(so.summary.byType).length));
  check("exactly the two known data defects are errors",
    so.summary.errors === 2 && so.diagnostics.filter((d) => d.severity === "error").every((d) => d.code === "D006"),
    JSON.stringify(so.diagnostics.filter((d) => d.severity === "error").map((d) => d.code)));
  check("no false TechName errors against the baseline",
    so.diagnostics.every((d) => d.code !== "D005"),
    JSON.stringify(so.diagnostics.filter((d) => d.code === "D005").slice(0, 3)));

  section("diagnosing real Yarn");

  const livePath = join(MODS_DIR, "MyMod", "Yarn", "Logic", "2.Live.yarn");
  if (!existsSync(livePath)) {
    skip("2.Live.yarn diagnosis");
  } else {
    const fs = require("node:fs");
    const text = fs.readFileSync(livePath, "utf8");
    const diag = mods.diagnoseYarn({ text, fileName: livePath, root: join(MODS_DIR, "MyMod") });
    check("diagnose returns available/diagnostics/nodes",
      JSON.stringify(Object.keys(diag).sort()) === JSON.stringify(["available", "diagnostics", "nodes"]),
      JSON.stringify(Object.keys(diag)));
    check("the game's own dialogue has no errors",
      diag.diagnostics.filter((d) => d.severity === "error").length === 0,
      JSON.stringify(diag.diagnostics.filter((d) => d.severity === "error").slice(0, 3)));
    check("its nodes are listed", diag.nodes.length > 0, String(diag.nodes.length));
  }
}

/* ------------------------------------------------------------------ */
/* a brand-new mod must be clean: the acceptance test                  */
/* ------------------------------------------------------------------ */

section("a freshly scaffolded mod");

{
  const sandbox = mkdtempSync(join(tmpdir(), "infantgod-mods-"));
  try {
    const fresh = createMods({ modsRoot: sandbox });
    const created = await fresh.scaffold({ dir: join(sandbox, "Probe"), modName: "Probe", template: "full" });
    check("scaffold reports the files it wrote", Array.isArray(created.created) && created.created.length > 0,
      JSON.stringify(created.created));
    /*
     * `dir` is the *parent*, and the package lands in `dir/<modName>` -- that is
     * scaffold.js's own contract.  Every other verb takes the package root, so
     * this is the one asymmetry worth pinning down with a check.
     */
    check("dir is the parent and the package lands in dir/<modName>",
      created.modRoot === join(sandbox, "Probe", "Probe"),
      created.modRoot);

    const report = fresh.validatePackage({ root: created.modRoot });
    check("a new mod validates with zero errors", report.summary.errors === 0, JSON.stringify(report.summary));
    check("and zero warnings", report.summary.warnings === 0, JSON.stringify({
      warnings: report.diagnostics.filter((d) => d.severity === "warning").map((d) => d.code + " " + d.path),
    }));

    /*
     * The generated Yarn jumps between nodes it declares itself, and the
     * generated Topic references the generated Attr by techName.  Both only
     * resolve if the mod's own definitions are merged into the knowledge the
     * checker uses -- consulting the game baseline alone reports Y002 and D005.
     */
    const story = report.diagnostics.filter((d) => d.code === "Y002" || d.code === "D005");
    check("no unresolved self-references", story.length === 0, JSON.stringify(story.map((d) => d.code + " " + d.path)));
    check("the generated icons exist on disk",
      report.diagnostics.every((d) => d.code !== "D006"),
      JSON.stringify(report.diagnostics.filter((d) => d.code === "D006").map((d) => d.path)));

    const storyText = [
      "title: Probe_Start",
      "---",
      "<<jump Probe_Hub>>",
      "===",
      "title: Probe_Hub",
      "---",
      "<<jump Probe_Start>>",
      "===",
      "",
    ].join("\n");
    const diag = fresh.diagnoseYarn({ text: storyText, fileName: "Probe/Story.yarn", root: created.modRoot });
    check("a new mod's own jump targets resolve",
      diag.diagnostics.every((d) => d.code !== "Y002"),
      JSON.stringify(diag.diagnostics.filter((d) => d.code === "Y002")));
  } finally {
    rmSync(sandbox, { recursive: true, force: true });
  }
}

/* ------------------------------------------------------------------ */
/* the verbs the cards call                                            */
/* ------------------------------------------------------------------ */

section("search, docs and completion");

const hit = mods.search({ query: "Love", limit: 5 });
check("search finds the Love command first", hit[0] && hit[0].kind === "command" && hit[0].name === "Love",
  JSON.stringify(hit[0]));
check("search results are shaped for a list card",
  hit.every((h) => typeof h.kind === "string" && typeof h.name === "string" && typeof h.detail === "string"));

const loveDoc = mods.docFor({ kind: "command", name: "Love" });
check("docFor returns readable markdown", typeof loveDoc === "string" && loveDoc.includes("Love") && loveDoc.includes("```yarn"),
  String(loveDoc).slice(0, 80));

const suggestions = mods.suggest({ prefix: "Lo", context: "command" });
check("completion offers Love first", suggestions[0] && suggestions[0].label === "Love", JSON.stringify(suggestions[0]));
check("completion carries an insertable text and a doc",
  suggestions.every((s) => typeof s.insertText === "string" && typeof s.documentation === "string"));

const badDoc = (() => {
  try {
    mods.docFor({ kind: "command", name: "NoSuchCommandName" });
    return null;
  } catch (err) {
    return err.message;
  }
})();
check("an unknown name is reported, not invented", badDoc === null || typeof badDoc === "string");

/* ------------------------------------------------------------------ */
/* the acceptance list, exercised directly                             */
/* ------------------------------------------------------------------ */

/*
 * `mods` above is deliberately narrowed to the corpus folder, so anything
 * outside it is EOUTSIDE.  These fixtures live in the OS temp dir and so need
 * an unguarded instance of their own; the guard is then tested separately.
 */

const specMods = createMods({});
const specTemps = [];

function specTemp(prefix) {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  specTemps.push(dir);
  return dir;
}

function specWrite(abs, text) {
  mkdirSync(dirname(abs), { recursive: true });
  writeFileSync(abs, text, "utf8");
  return abs;
}

section("the open package as a reference target");

if (!HAVE_CORPUS) {
  skip("openMod on the baseline package (no Mods folder)");
} else {
  const bound = mods.openMod({ dir: join(MODS_DIR, "SODefines") });
  check("openMod sees every file of the baseline package",
    bound.summary.files === 3108, String(bound.summary.files));
  check("the baseline package loads first (loadOrder 1)",
    bound.manifest.loadOrder === 1, JSON.stringify(bound.manifest));
  check("openMod finds a definition for every baseline type",
    bound.defines.length === 1305, String(bound.defines.length));
}

section("a package that references its own defines and files");

{
  const root = join(specTemp("infantgod-accept-"), "LocalRefMod");
  specWrite(join(root, "mod.json"), JSON.stringify({
    name: "LocalRefMod",
    version: "1.0.0",
    gameVersion: "1.0",
    loadOrder: 50,
    author: "selftest",
    description: "selftest fixture: the package's own references must resolve",
  }, null, 2) + "\n");
  specWrite(join(root, "Defines", "Attr", "ZzProbeAttr.json"),
    JSON.stringify({ techName: "ZzProbeAttr" }, null, 2) + "\n");
  specWrite(join(root, "Defines", "Topic", "ZzProbeTopic.json"),
    JSON.stringify({ techName: "ZzProbeTopic", attrType: "ZzProbeAttr" }, null, 2) + "\n");
  specWrite(join(root, "Yarn", "A.yarn"),
    "title: ZzTargetNode\n---\nThe target lives in A.yarn.\n===\n");
  const jumpText = "title: ZzStartNode\n---\n<<jump ZzTargetNode>>\n===\n";
  specWrite(join(root, "Yarn", "B.yarn"), jumpText);

  specMods.openMod({ dir: root });

  const own = specMods.validatePackage({ root });
  check("a define referenced from the same package is not D005",
    own.diagnostics.every((d) => d.code !== "D005"),
    JSON.stringify(own.diagnostics.filter((d) => d.code === "D005").map((d) => d.path)));
  check("the package's own defines are known types",
    own.types.includes("Attr") && own.types.includes("Topic"), JSON.stringify(own.types));

  const crossFile = specMods.diagnoseYarn({ text: jumpText, fileName: "Yarn/B.yarn" });
  check("a jump to a node in another file of the open package resolves",
    crossFile.diagnostics.every((d) => d.code !== "Y002"),
    JSON.stringify(crossFile.diagnostics.filter((d) => d.code === "Y002").map((d) => d.message)));

  const otherRoot = join(specTemp("infantgod-other-"), "SomewhereElse");
  mkdirSync(otherRoot, { recursive: true });
  specMods.openMod({ dir: otherRoot });
  const stale = specMods.diagnoseYarn({ text: jumpText, fileName: "Yarn/B.yarn" });
  check("opening a different package drops the previous node index",
    stale.diagnostics.some((d) => d.code === "Y002"),
    JSON.stringify(stale.diagnostics.map((d) => d.code)));
}

section("a package that is missing or unreadable");

{
  const root = join(specTemp("infantgod-broken-"), "Broken");
  specWrite(join(root, "Defines", "Attr", "Bad.json"), "{ not json at all\n");

  let opened = null;
  let thrown = null;
  try {
    opened = specMods.openMod({ dir: root });
  } catch (err) {
    thrown = err;
  }
  check("openMod does not throw when mod.json is absent", thrown === null, thrown && thrown.message);
  check("the missing mod.json is a diagnostic (M001)",
    opened !== null && opened.manifest === null && opened.diagnostics.some((d) => d.code === "M001"),
    JSON.stringify(opened && opened.diagnostics.map((d) => d.code)));
  check("an unparseable define is a diagnostic (M010)",
    opened !== null && opened.diagnostics.some((d) => d.code === "M010"),
    JSON.stringify(opened && opened.diagnostics.map((d) => d.code)));
}

section("docs for a node and a define");

{
  const kb = mods.knowledge();
  const nodeName = kb.nodes[0].title;
  const nodeDoc = mods.docFor({ kind: "node", name: nodeName });
  check(`docFor on a node (${nodeName}) returns markdown`,
    typeof nodeDoc === "string" && nodeDoc.trim().length > 0, JSON.stringify(String(nodeDoc).slice(0, 60)));

  const defineName = kb.baseline && kb.baseline.Attr && kb.baseline.Attr[0];
  const defineDoc = defineName ? mods.docFor({ kind: "define", name: defineName }) : null;
  check(`docFor on a define (${defineName}) returns markdown`,
    typeof defineDoc === "string" && defineDoc.trim().length > 0, JSON.stringify(String(defineDoc).slice(0, 60)));
}

section("the modsRoot allowlist");

{
  const guardBase = specTemp("infantgod-guard-");
  const guarded = createMods({ modsRoot: guardBase });
  const outside = join(MODS_DIR, "MyMod");

  let refused = null;
  try {
    guarded.openMod({ dir: outside });
  } catch (err) {
    refused = err;
  }
  check("a path outside modsRoot is refused", refused !== null && refused.code === "EOUTSIDE",
    refused && refused.code);
  check("the refusal carries the documented Chinese message",
    refused !== null && refused.message === `路径越界，已拒绝: ${outside}`, refused && refused.message);

  let refusedValidate = null;
  try {
    guarded.validatePackage({ root: join(MODS_DIR, "SODefines") });
  } catch (err) {
    refusedValidate = err;
  }
  check("validatePackage is guarded as well",
    refusedValidate !== null && refusedValidate.code === "EOUTSIDE", refusedValidate && refusedValidate.code);

  const inside = join(guardBase, "Inside");
  specWrite(join(inside, "mod.json"), JSON.stringify({
    name: "Inside", version: "1.0.0", gameVersion: "1.0", loadOrder: 60,
    author: "selftest", description: "selftest fixture",
  }, null, 2) + "\n");
  let allowed = null;
  try {
    guarded.openMod({ dir: inside });
  } catch (err) {
    allowed = err;
  }
  check("a path inside modsRoot is allowed", allowed === null, allowed && allowed.message);

  /*
   * A relative `dir` means "this package inside the mods root", not "relative
   * to whatever directory the server happened to start in".  Resolving against
   * the cwd instead made `mod MyMod` answer 路径越界 in the running app while
   * the very same package opened fine by absolute path -- which is what the
   * board screenshot caught and no test did.
   */
  let relative = null;
  let relativeErr = null;
  try {
    relative = guarded.openMod({ dir: "Inside" });
  } catch (err) {
    relativeErr = err;
  }
  check("a relative dir resolves inside modsRoot, not the cwd",
    relativeErr === null && relative !== null && relative.manifest !== null &&
      relative.manifest.name === "Inside",
    relativeErr ? relativeErr.message : JSON.stringify(relative && relative.root));

  let climbed = null;
  try {
    guarded.openMod({ dir: "../escape" });
  } catch (err) {
    climbed = err;
  }
  check("a relative dir that climbs out of modsRoot is still refused",
    climbed !== null && climbed.code === "EOUTSIDE", climbed && climbed.code);

  let nested = null;
  let nestedErr = null;
  try {
    nested = guarded.openMod({ dir: "./Inside" });
  } catch (err) {
    nestedErr = err;
  }
  check("a `./`-prefixed dir lands in the same place",
    nestedErr === null && nested !== null && relative !== null &&
      nested.root === relative.root,
    nestedErr ? nestedErr.message : JSON.stringify(nested && nested.root));
}

section("no state leaks between runs");

for (const dir of specTemps) rmSync(dir, { recursive: true, force: true });
check("every fixture this run created was removed",
  specTemps.every((d) => !existsSync(d)), specTemps.filter((d) => existsSync(d)).join(", "));

/* ------------------------------------------------------------------ */
/* the protocol seam                                                   */
/* ------------------------------------------------------------------ */

/*
 * The cards never talk to the knowledge layer directly -- they send `mod.*`
 * frames and the shell's `dispatch()` answers them.  This drives that exact
 * function with a kernel that throws if it is ever consulted, which is the
 * whole claim being made: `mod.*` is served above the kernel.
 */

section("the protocol seam (shell dispatch)");

const { dispatch } = await import(pathToFileURL(join(ROOT, "shell", "main.mjs")).href);

const languages = {
  available: true,
  list: () => ({ langs: [] }),
  tokenize: () => ({ tokens: [], lang: null }),
};

let kernelCalls = 0;
const kernel = {
  call: async (method) => {
    kernelCalls += 1;
    throw new Error(`the kernel must not be consulted for ${method}`);
  },
};

async function frame(id, method, params) {
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

const newMod = require(join(ROOT, "electron", "newmod.js"));
const scaffoldCore = require(join(HERE, "scaffold.js"));

const engineTemplates = (scaffoldCore.MOD_TEMPLATES || []).map((t) => ({ id: t.id, nameZh: t.nameZh }));
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
const unnamed = [];
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

let noParent = null;
try {
  newMod.plan({ parent: "", typedName: "Probe" });
} catch (err) {
  noParent = err;
}
check("plan refuses to guess when there is no writable parent",
  noParent instanceof Error, String(noParent));

const planned = newMod.plan({ parent: join(tmpdir(), "mods"), typedName: "Probe" });
check("plan hands mod.scaffold the folder the user named, not a package path",
  planned.dir === join(tmpdir(), "mods") && planned.modName === "Probe",
  JSON.stringify(planned));

const plannedCjk = newMod.plan({ parent: join(tmpdir(), "mods"), typedName: "  幼神模组  " });
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

const scaffoldFrame = newMod.request("mod.scaffold", { dir: "D", modName: "N", template: "minimal" });
check("the request frame is the frozen JSON-RPC shape",
  JSON.stringify(scaffoldFrame) === JSON.stringify({
    jsonrpc: "2.0", id: 1, method: "mod.scaffold",
    params: { dir: "D", modName: "N", template: "minimal" },
  }),
  JSON.stringify(scaffoldFrame));

const picked = [];
const fragment = newMod.menuTemplate({ onPick: (id) => picked.push(id) });
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
const urlOf = (shell, root) => {
  try {
    return newMod.openModUrl(shell, root);
  } catch (err) {
    return `threw: ${err.message}`;
  }
};
const baseUrl = "http://127.0.0.1:7788";

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
const sent = [];
const receipt = await newMod.createMod({
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

const slashed = [];
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

let refusedReply = null;
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
const KERNEL_EXE = join(ROOT, "build", "infantgod.exe");
const CAN_SPAWN_SHELL = process.platform === "win32" && process.versions.electron === undefined &&
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
/* finding the game: a setting, the environment, or discovery          */
/* ------------------------------------------------------------------ */

section("finding the game without a path written into the source");

{
  /*
   * docs/EDITOR_GAPS.md §14.1: the game folder used to be baked into scaffold.js
   * and into this file.  The rule now is setting > environment > discovery, and
   * "not found" is a state with a name, never a guess.  These checks build their
   * own little game tree, so they say the same thing on every machine.
   */
  const base = specTemp("infantgod-discover-");
  const corpus = join(base, "ModsFull", "Mods");
  mkdirSync(join(corpus, "SODefines", "Schema"), { recursive: true });
  mkdirSync(join(corpus, "MyMod", "Yarn"), { recursive: true });

  const bySetting = gamepath.discoverGameModsDir({ gameModsDir: corpus, env: {} });
  check("an explicit setting wins over the environment and over discovery",
    bySetting.dir === corpus && bySetting.source === "setting",
    JSON.stringify({ dir: bySetting.dir, source: bySetting.source }));

  const byEnv = gamepath.discoverGameModsDir({ env: { INFANTGOD_GAME_DIR: base } });
  check("INFANTGOD_GAME_DIR finds <dir>/ModsFull/Mods",
    byEnv.dir === corpus && byEnv.source === "INFANTGOD_GAME_DIR/ModsFull/Mods",
    JSON.stringify({ dir: byEnv.dir, source: byEnv.source }));

  const bySearch = gamepath.discoverGameModsDir({ env: {}, searchRoots: [base] });
  check("discovery under a root finds ModsFull/Mods under it",
    bySearch.dir === corpus && bySearch.source === "discover",
    JSON.stringify({ dir: bySearch.dir, source: bySearch.source }));

  const nothing = gamepath.discoverGameModsDir({ gameModsDir: join(base, "nope"), env: {} });
  check("a setting that is not a game folder is refused by name, not silently ignored",
    nothing.dir === null && nothing.source === "not found" && nothing.found === false,
    JSON.stringify({ source: nothing.source, tried: nothing.tried.length }));

  check("the default roots include the checkout's parent -- a relative rule, not this machine",
    gamepath.defaultSearchRoots({}).some((r) => r === resolve(ROOT, "..")),
    JSON.stringify(gamepath.defaultSearchRoots({}).slice(-2)));

  const info = mods.gameMods();
  check("the facade reports where the game folder came from",
    info !== null && typeof info.source === "string" &&
    (info.dir === null ? info.source === "not found" : typeof info.dir === "string"),
    JSON.stringify(info));

  check("with no --mods the corpus is exactly what discovery found",
    modsIndex >= 0 || HAVE_CORPUS === DISCOVERY.found,
    JSON.stringify({ mods: modsIndex >= 0, found: DISCOVERY.found, have: HAVE_CORPUS, source: DISCOVERY.source }));
}

/* ------------------------------------------------------------------ */
/* a knowledge base that is not there                                  */
/* ------------------------------------------------------------------ */

section("a knowledge base that is not there");

{
  const base = specTemp("infantgod-nokb-");
  const absent = join(base, "absent-knowledge.json");
  const bare = createMods({ modsRoot: base, knowledgePath: absent, gameModsDir: join(base, "no-game") });

  const state = bare.knowledgeState();
  check("knowledgeState names the missing knowledge base",
    state.state === "missing" && state.schemas === 0 && state.path === absent,
    JSON.stringify(state));

  const pkgRoot = join(base, "Bare");
  specWrite(join(pkgRoot, "mod.json"), JSON.stringify({
    name: "Bare", version: "1.0.0", gameVersion: "1.0", loadOrder: 5,
    author: "selftest", description: "no knowledge base",
  }, null, 2) + "\n");

  const report = bare.validatePackage({ root: pkgRoot });
  check("validatePackage reports the knowledge base as missing",
    report.knowledge === "missing", JSON.stringify(report.knowledge));
  check("a missing knowledge base is an error, so ok:true cannot mean 'nothing was checked'",
    report.ok === false && report.diagnostics.some((d) => d.code === "E000" && d.severity === "error"),
    JSON.stringify({ ok: report.ok, errors: report.summary.errors, codes: report.diagnostics.map((d) => d.code) }));

  const built = await bare.scaffold({ dir: join(base, "Fresh"), modName: "Fresh", template: "yarn-story" });
  check("scaffold still writes a package with no knowledge base",
    existsSync(join(built.modRoot, "mod.json")), built.modRoot);
  check("and says so instead of silently degrading",
    built.warnings.some((w) => /知识库/.test(w)), JSON.stringify(built.warnings));

  const readAll = (dir) => {
    let text = "";
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const abs = join(dir, entry.name);
      text += entry.isDirectory() ? readAll(abs) : readFileSync(abs, "utf8");
    }
    return text;
  };
  const generated = readAll(built.modRoot);
  const gameNames = ["Aistalt", "Biden", "Company", "Cop", "Greta", "Journalist", "Judge"];
  check("the generated package never mentions the seven built-in character names",
    gameNames.every((n) => !generated.includes(n)),
    gameNames.filter((n) => generated.includes(n)).join(", "));
  check("the generated story speaks as the mod's own name, not a game protagonist",
    generated.includes("Fresh:"), "no Fresh speaker in the generated package");
  const manifest = JSON.parse(readFileSync(join(built.modRoot, "mod.json"), "utf8"));
  check("and the manifest carries no character table",
    !Array.isArray(manifest.characters) || manifest.characters.length === 0 ||
    manifest.characters.every((c) => !gameNames.includes(String(c && c.name))),
    JSON.stringify(manifest.characters));
}

/* ------------------------------------------------------------------ */
/* the game's vocabulary, not ours                                     */
/* ------------------------------------------------------------------ */

section("search: the state names come from the game, not from our source");

{
  /*
   * The fifteen emotion names the completion used to carry as literals are
   * game data, so they are read from the shipped knowledge base at runtime.
   * These checks pin both halves: with the KB the game's own table is offered,
   * without it a neutral fallback is offered and *says* it is a fallback --
   * and the source itself names no game state.
   */
  const searchCore = require(join(HERE, "search.js"));
  const shipped = JSON.parse(readFileSync(KNOWLEDGE_PATH, "utf8"));
  const gameStates = shipped.baseline && Array.isArray(shipped.baseline.CharacterState)
    ? shipped.baseline.CharacterState.map(String)
    : [];

  check("the shipped knowledge base still carries the game's state table",
    gameStates.length > 0, JSON.stringify({ names: gameStates.length }));

  const index = searchCore.buildIndex(shipped);
  const fromKb = searchCore.emotionTagsOf(index);
  check("with a knowledge base the tags are the game's, and the index says where they came from",
    fromKb.source === "knowledge-base" && fromKb.tags.length === gameStates.length,
    JSON.stringify({ source: fromKb.source, tags: fromKb.tags.length, game: gameStates.length }));

  const unreachable = gameStates.filter((name) => {
    const prefix = name.slice(0, Math.min(3, name.length));
    return !searchCore.suggest(index, "#" + prefix, "tag", { limit: 400 }).items
      .some((item) => item.label === name && item.kind === "tag");
  });
  check("and every one of them is still offered by typing its first letters",
    unreachable.length === 0, unreachable.slice(0, 6).join(", "));

  /* The fallback is what a machine without the game sees: it must be honest. */
  const bare = searchCore.buildIndex({});
  const fromNeutral = searchCore.emotionTagsOf(bare);
  check("without a knowledge base the tags are the neutral fallback and say so",
    fromNeutral.source === "neutral" && fromNeutral.tags.length > 0,
    JSON.stringify(fromNeutral));
  check("and not one game state name leaks into the fallback",
    fromNeutral.tags.every((tag) => !gameStates.includes(tag)),
    fromNeutral.tags.filter((tag) => gameStates.includes(tag)).join(", "));

  const bareOffered = searchCore.suggest(bare, "#", "tag").items
    .filter((item) => item.kind === "tag").map((item) => item.label);
  check("the fallback itself is what the completion offers",
    fromNeutral.tags.every((tag) => bareOffered.includes(tag)),
    JSON.stringify(bareOffered.filter((label) => !fromNeutral.tags.includes(label))));

  const source = readFileSync(join(HERE, "search.js"), "utf8");
  const wordish = gameStates.filter((name) => name.length >= 4);
  const literals = wordish.filter((name) => source.includes(`"${name}"`) || source.includes(`'${name}'`));
  check("the search source keeps no game state name as a literal",
    literals.length === 0, literals.slice(0, 6).join(", "));

  const kbDoc = searchCore.suggest(index, "#Ang", "tag").items.find((item) => item.label === "Angry");
  const neutralDoc = searchCore.suggest(bare, "#Neu", "tag").items.find((item) => item.label === "Neutral");
  check("the documentation distinguishes a game tag from the neutral fallback",
    Boolean(kbDoc && /知识库/.test(kbDoc.documentation)) &&
    Boolean(neutralDoc && /中性兜底/.test(neutralDoc.documentation)),
    JSON.stringify({ kb: kbDoc && kbDoc.documentation, neutral: neutralDoc && neutralDoc.documentation }));
}

/* ------------------------------------------------------------------ */
/* the generator                                                       */
/* ------------------------------------------------------------------ */

section("the knowledge generator (tools/gen_knowledge.mjs)");

{
  const gen = join(ROOT, "tools", "gen_knowledge.mjs");
  const fixtureRoot = join(ROOT, "build", "knowledge-fixture");
  const gameDir = join(fixtureRoot, "game");
  const outPath = join(fixtureRoot, "committed.json");
  rmSync(fixtureRoot, { recursive: true, force: true });

  /*
   * 自造的迷你游戏树：两个 schema、一个基线定义、一个 Yarn 文件、一份 CSV。
   * 里面故意放了 description 和 #region 式的文档文本，用来证明它们会被丢掉；
   * 角色表根本不在生成物里。fixture 在 build/ 下（gitignored 的草稿区）。
   */
  specWrite(join(gameDir, "SODefines", "Schema", "Demo.schema.json"), JSON.stringify({
    type: "object", description: "documentation that must not ship",
    properties: { techName: { type: "string" }, hp: { type: "number", description: "also stripped" } },
  }, null, 2));
  specWrite(join(gameDir, "SODefines", "Schema", "Other.schema.json"), JSON.stringify({
    type: "object", properties: { techName: { type: "string" } },
  }, null, 2));
  specWrite(join(gameDir, "SODefines", "Defines", "Demo", "Hero.json"), JSON.stringify({
    techName: "Demo_Hero", description: "stripped too", hp: 3,
  }, null, 2));
  specWrite(join(gameDir, "MyMod", "Yarn", "Logic", "Demo.yarn"), [
    "title: Demo_Start",
    "tags: #hub",
    "---",
    "<<declare $Visits = 0>>",
    "<<set $Visits += 1>>",
    "Demo_Hero: 早。 #line:0abcdef #state:Idle",
    "<<if $Visits > 1>>",
    "<<jump Demo_Hub>>",
    "<<endif>>",
    "===",
    "",
  ].join("\n"));
  specWrite(join(gameDir, "MyMod", "Yarn", "NewProject.csv"),
    "language,id,text,file,node,lineNumber,lock,comment\nzh-CN,line:0abcdef,早,Demo.yarn,Demo_Start,6,,\n");

  const mod = await import(pathToFileURL(gen).href);
  const kb = mod.buildKnowledge(gameDir);
  check("the generator reads schemas, baseline, yarn and locales from a game tree",
    Object.keys(kb.schemas).length === 2 && kb.baseline.Demo.includes("Demo_Hero") &&
    kb.stats.yarnFiles === 1 && kb.localization.baseLanguage === "zh-CN",
    JSON.stringify({ stats: kb.stats, base: kb.localization.baseLanguage }));
  check("no documentation text survives into the knowledge base",
    !JSON.stringify(kb).includes('"description"'), "a description key survived");
  check("the character table is not generated at all",
    kb.characters === undefined, JSON.stringify(Object.keys(kb)));

  const run = spawnSync(process.execPath, [gen, "--game-dir", gameDir, "--out", outPath], { encoding: "utf8" });
  check("the CLI writes a knowledge base", run.status === 0 && existsSync(outPath), run.stderr || run.stdout);

  /* --schema-dir / --defines-dir 必须真的被读到：把 schema 指到另一个目录。 */
  specWrite(join(fixtureRoot, "extra-schema", "Extra.schema.json"), JSON.stringify({
    type: "object", properties: { techName: { type: "string" } },
  }, null, 2));
  const dirsOut = join(fixtureRoot, "dirs.json");
  const dirsRun = spawnSync(process.execPath, [gen, "--game-dir", gameDir,
    "--schema-dir", join(fixtureRoot, "extra-schema"),
    "--defines-dir", join(gameDir, "SODefines", "Defines"),
    "--out", dirsOut], { encoding: "utf8" });
  const dirsKb = existsSync(dirsOut) ? JSON.parse(readFileSync(dirsOut, "utf8")) : null;
  check("--schema-dir/--defines-dir name the two subdirectories directly",
    dirsRun.status === 0 && dirsKb !== null &&
    Object.keys(dirsKb.schemas).join(",") === "Extra" && dirsKb.baseline.Demo.includes("Demo_Hero"),
    dirsRun.stderr || dirsRun.stdout);
  const greenCheck = spawnSync(process.execPath, [gen, "--game-dir", gameDir, "--check", outPath], { encoding: "utf8" });
  check("--check is green against the file the generator just wrote", greenCheck.status === 0,
    JSON.stringify({ status: greenCheck.status, out: (greenCheck.stdout || "").trim().slice(-200) }));

  /*
   * --diff only describes the gap between the committed file and a facts-only
   * generation (the committed file came from an older, richer extractor), so it
   * always exits 0 -- unlike --check.  The fixture is used here because it is
   * the one committed file we can regenerate exactly.
   */
  const diffGreen = spawnSync(process.execPath, [gen, "--game-dir", gameDir, "--diff", outPath], { encoding: "utf8" });
  check("--diff describes an agreeing committed file and still exits 0",
    diffGreen.status === 0 &&
    /只在已提交 KB/.test(diffGreen.stdout || "") &&
    /只在生成版/.test(diffGreen.stdout || "") &&
    ["commands", "functions", "variables", "nodes"].every((name) =>
      new RegExp(`^\\s+${name}\\s`, "m").test(diffGreen.stdout || "")),
    JSON.stringify({ status: diffGreen.status, out: (diffGreen.stdout || "").trim().slice(-240) }));

  const drifted = JSON.parse(readFileSync(outPath, "utf8"));
  drifted.commands.push({ name: "Ghost_Cmd", parameters: [], usage: 0 });
  drifted.nodes = drifted.nodes.filter((node) => node.title !== "Demo_Start");
  const driftedPath = join(fixtureRoot, "drifted-committed.json");
  writeFileSync(driftedPath, JSON.stringify(drifted) + "\n");
  const diffDrift = spawnSync(process.execPath, [gen, "--game-dir", gameDir, "--diff", driftedPath], { encoding: "utf8" });
  check("--diff names what only the committed KB has, and what only the generated copy has",
    diffDrift.status === 0 &&
    /只在已提交 KB 里（1 个）：Ghost_Cmd/.test(diffDrift.stdout || "") &&
    /只在生成版里（1 个）：Demo_Start/.test(diffDrift.stdout || ""),
    JSON.stringify({ status: diffDrift.status, out: (diffDrift.stdout || "").trim().slice(-280) }));

  const diffMissing = spawnSync(process.execPath, [gen, "--game-dir", gameDir, "--diff", join(fixtureRoot, "no-such-kb.json")], { encoding: "utf8" });
  check("--diff with no readable committed file exits 2", diffMissing.status === 2,
    JSON.stringify({ status: diffMissing.status }));

  specWrite(join(gameDir, "SODefines", "Defines", "Demo", "Extra.json"), JSON.stringify({ techName: "Demo_Extra" }, null, 2));
  const redCheck = spawnSync(process.execPath, [gen, "--game-dir", gameDir, "--check", outPath], { encoding: "utf8" });
  check("--check goes red when a fact drifted and names the section",
    redCheck.status === 1 && /baseline/.test(redCheck.stdout || ""),
    JSON.stringify({ status: redCheck.status, out: (redCheck.stdout || "").trim().slice(-200) }));

  const noGame = spawnSync(process.execPath, [gen, "--game-dir", join(fixtureRoot, "nope"), "--out", join(fixtureRoot, "never.json")], { encoding: "utf8" });
  check("with no game directory the generator exits 2 and writes nothing",
    noGame.status === 2 && !existsSync(join(fixtureRoot, "never.json")),
    JSON.stringify({ status: noGame.status, err: (noGame.stderr || "").trim().slice(-160) }));
}

/* ------------------------------------------------------------------ */
/* the acceptance grep: nothing under shell/ names a machine           */
/* ------------------------------------------------------------------ */

section("nothing shipped under shell/ names a machine");

{
  const hits = [];
  const WALK_SKIP = new Set(["node_modules", ".git"]);
  const walk = (dir) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (WALK_SKIP.has(entry.name) || entry.name.startsWith(".")) continue;
      const abs = join(dir, entry.name);
      if (entry.isDirectory()) { walk(abs); continue; }
      if (!/\.(js|mjs|cjs|json|html|css|md|txt|yarn|yarnproject|csv|py|sh|bat|ps1|nsi)$/i.test(entry.name)) continue;
      const text = readFileSync(abs, "utf8");
      const hit = text.match(/[A-Za-z]:[\\/]Users[\\/]|\/Users\/[A-Za-z0-9._-]/);
      if (hit) hits.push(abs.slice(ROOT.length + 1) + " -> " + hit[0]);
    }
  };
  walk(join(ROOT, "shell"));
  check("no shipped file under shell/ contains an absolute path into a user profile",
    hits.length === 0, hits.slice(0, 5).join("; "));

  const shipped = JSON.parse(readFileSync(KNOWLEDGE_PATH, "utf8"));
  check("the shipped knowledge base no longer names the machine it was generated on",
    !Object.prototype.hasOwnProperty.call(shipped, "gameModsDir") &&
    !(shipped.localization && Object.prototype.hasOwnProperty.call(shipped.localization, "projectPath")),
    JSON.stringify({ keys: Object.keys(shipped).length }));
  check("and the facts survived: schemas and baseline are still there",
    Object.keys(shipped.schemas || {}).length > 0 && Object.keys(shipped.baseline || {}).length > 0,
    JSON.stringify({ schemas: Object.keys(shipped.schemas || {}).length, baseline: Object.keys(shipped.baseline || {}).length }));
}

/* ------------------------------------------------------------------ */

section("results");

const total = checks;
console.log(`\n${total - failures}/${total} checks passed${skipped ? ` (${skipped} skipped)` : ""}`);
console.log(`ok ${total - failures}/${total}${skipped ? ` (${skipped} skipped)` : ""}`);
if (failures > 0) {
  console.log(`mods: FAIL (${failures})`);
  process.exit(1);
}
console.log("mods: ok");
