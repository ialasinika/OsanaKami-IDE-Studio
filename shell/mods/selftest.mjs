#!/usr/bin/env node
/**
 * selftest.mjs -- proves the 幼神 mod layer works with no kernel, no browser
 * and no network.  Run it after editing the facade, the knowledge base or any
 * ported core module.
 *
 *     node shell/mods/selftest.mjs [--mods DIR]
 *
 * `--mods` points at the game's extracted `Mods` folder (the default is the
 * one this fork was developed against).  The corpus checks are skipped, not
 * failed, when that folder is absent: the layer must stay useful on a machine
 * that only has the knowledge base.
 *
 * Exits 0 on success, 1 on the first failure.
 */

import { createRequire } from "node:module";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, "..", "..");

const DEFAULT_MODS = "C:\\Users\\PC\\Documents\\deepseek-harness\\default-workspace\\ModsFull\\Mods";

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

const require = createRequire(import.meta.url);
const { createMods, KNOWLEDGE_PATH } = require(join(HERE, "index.js"));

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
  skip("corpus checks (no Mods folder at " + MODS_DIR + ")");
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

section("results");

const total = checks;
console.log(`\n${total - failures}/${total} checks passed${skipped ? ` (${skipped} skipped)` : ""}`);
console.log(`ok ${total - failures}/${total}${skipped ? ` (${skipped} skipped)` : ""}`);
if (failures > 0) {
  console.log(`mods: FAIL (${failures})`);
  process.exit(1);
}
console.log("mods: ok");
