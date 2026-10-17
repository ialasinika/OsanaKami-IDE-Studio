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
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, "..", "..");

const require = createRequire(import.meta.url);
const gamepath = require(join(HERE, "gamepath.js"));
const { createMods, KNOWLEDGE_PATH, defaultUserDir } = require(join(HERE, "index.js"));
const knowledgeBuild = require(join(HERE, "knowledge-build.js"));

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

/* ------------------------------------------------------------------ */
/* the L1 diagnostic rules from 03-诊断规则目录.md                     */
/* ------------------------------------------------------------------ */

section("the L1 diagnostic rules (03 规格)");

{
  const L1_ROOT = join(specTemp("infantgod-l1-"), "Lantern_Tests");
  const plain = (title, body) => "title: " + title + "\n---\n" + body + "\n===\n";
  const headed = (title, header, body) => "title: " + title + "\n" + header + "---\n" + body + "\n===\n";
  const line = "台词。 #line:9";
  let seq = 0;

  function l1Run(where, files, mainRel, context) {
    const dir = join(L1_ROOT, where);
    for (const rel of Object.keys(files)) specWrite(join(dir, rel), files[rel]);
    specMods.openMod({ dir });
    const params = { text: files[mainRel], fileName: mainRel, root: dir };
    if (context) params.context = context;
    return specMods.diagnoseYarn(params).diagnostics.map((d) => d.code);
  }

  function l1Rule(label, code, bad, good) {
    seq += 1;
    const badCodes = l1Run("bad-" + seq, bad.files, bad.main, bad.context);
    const goodCodes = l1Run("good-" + seq, good.files, good.main, good.context);
    const badHits = badCodes.filter((c) => c === code).length;
    const goodHits = goodCodes.filter((c) => c === code).length;
    check(label, badHits === 1 && goodHits === 0,
      "bad=" + JSON.stringify(badCodes) + " good=" + JSON.stringify(goodCodes));
  }

  // CR-102 / Y108：visited 的目标节点不存在
  l1Rule("Y108 CR-102: visited 的目标节点不存在", "Y108",
    { files: { "Yarn/main.yarn": plain("ZzStart", '<<if visited("ZzGhost")>>\n' + line + "\n<<endif>>") }, main: "Yarn/main.yarn" },
    { files: { "Yarn/main.yarn": plain("ZzStart", '<<if visited("ZzStart")>>\n' + line + "\n<<endif>>") }, main: "Yarn/main.yarn" });

  // CR-104 / Y109：跨文件重复 declare
  l1Rule("Y109 CR-104: 跨文件重复 declare", "Y109",
    { files: {
      "Yarn/a.yarn": plain("ZzA", "<<declare $zed>>"),
      "Yarn/main.yarn": plain("ZzB", "<<declare $zed>>")
    }, main: "Yarn/main.yarn" },
    { files: {
      "Yarn/a.yarn": plain("ZzA", "<<declare $other>>"),
      "Yarn/main.yarn": plain("ZzB", "<<declare $zed>>")
    }, main: "Yarn/main.yarn" });

  // CR-105 / Y112：未知标签
  l1Rule("Y112 CR-105: 未知标签", "Y112",
    { files: { "Yarn/main.yarn": plain("ZzStart", "台词。 #Nope #line:9") }, main: "Yarn/main.yarn" },
    { files: { "Yarn/main.yarn": plain("ZzStart", "台词。 #Topic:ZzTopic #line:9") }, main: "Yarn/main.yarn" });

  // CR-106 / Y113：标签只差大小写
  l1Rule("Y113 CR-106: 标签名大小写不对", "Y113",
    { files: { "Yarn/main.yarn": plain("ZzStart", "台词。 #topic:Zz #line:9") }, main: "Yarn/main.yarn" },
    { files: { "Yarn/main.yarn": plain("ZzStart", "台词。 #Topic:Zz #line:9") }, main: "Yarn/main.yarn" });

  // CR-113 / Y110：需要参数的标签缺参数（`line` 豁免）
  l1Rule("Y110 CR-113: 需要参数的标签缺参数", "Y110",
    { files: { "Yarn/main.yarn": plain("ZzStart", "台词。 #Check #line:9") }, main: "Yarn/main.yarn" },
    { files: { "Yarn/main.yarn": plain("ZzStart", "台词。 #Check:Zz:1:Zz #line:9") }, main: "Yarn/main.yarn" });

  // CR-107 / Y114：`#state` 漏了冒号
  l1Rule("Y114 CR-107: #state 漏了冒号", "Y114",
    { files: { "Yarn/main.yarn": plain("ZzStart", "台词。 #stateIdle #line:9") }, main: "Yarn/main.yarn" },
    { files: { "Yarn/main.yarn": plain("ZzStart", "台词。 #state:Idle #line:9") }, main: "Yarn/main.yarn" });

  // CR-108 / Y115：`#state:` 的值只差大小写
  l1Rule("Y115 CR-108: #state 值大小写不对", "Y115",
    { files: { "Yarn/main.yarn": plain("ZzStart", "台词。 #state:idle #line:9") }, main: "Yarn/main.yarn" },
    { files: { "Yarn/main.yarn": plain("ZzStart", "台词。 #state:Idle #line:9") }, main: "Yarn/main.yarn" });

  // CR-109 / Y104：`#state:` 的值不存在（warning，规格依赖数据不完整）
  l1Rule("Y104 CR-109: #state 的值不存在（warning）", "Y104",
    { files: { "Yarn/main.yarn": plain("ZzStart", "台词。 #state:ZzNope #line:9") }, main: "Yarn/main.yarn" },
    { files: { "Yarn/main.yarn": plain("ZzStart", "台词。 #state:Idle #line:9") }, main: "Yarn/main.yarn" });

  // CR-114 / Y111：`Character:` 行里的名字不是角色
  l1Rule("Y111 CR-114: Character: 行里的名字不是角色", "Y111",
    { files: { "Yarn/main.yarn": plain("ZzStart", "Character:ZzGhost\n" + line) }, main: "Yarn/main.yarn" },
    { files: { "Yarn/main.yarn": plain("ZzStart", "Character:ZzProbe\n" + line) }, main: "Yarn/main.yarn",
      context: { characters: ["ZzProbe"] } });

  // CR-115 / Y116：节点组成员缺 subtitle
  l1Rule("Y116 CR-115: 节点组成员缺 subtitle", "Y116",
    { files: {
      "Yarn/main.yarn": headed("ZzPair", "when: always\n", line),
      "Yarn/b.yarn": headed("ZzPair", "subtitle: ZzOne\nwhen: always\n", line)
    }, main: "Yarn/main.yarn" },
    { files: {
      "Yarn/main.yarn": headed("ZzPair", "subtitle: ZzTwo\nwhen: always\n", line),
      "Yarn/b.yarn": headed("ZzPair", "subtitle: ZzOne\nwhen: always\n", line)
    }, main: "Yarn/main.yarn" });

  // CR-116 / Y117：节点组里 subtitle 撞车（报后一个成员）
  l1Rule("Y117 CR-116: 节点组里 subtitle 重复", "Y117",
    { files: {
      "Yarn/a.yarn": headed("ZzPair", "subtitle: ZzSame\nwhen: always\n", line),
      "Yarn/b.yarn": headed("ZzPair", "subtitle: ZzSame\nwhen: always\n", line)
    }, main: "Yarn/b.yarn" },
    { files: {
      "Yarn/a.yarn": headed("ZzPair", "subtitle: ZzSame\nwhen: always\n", line),
      "Yarn/b.yarn": headed("ZzPair", "subtitle: ZzOther\nwhen: always\n", line)
    }, main: "Yarn/b.yarn" });

  // CR-201 / Y118：确定型配对只有起手（配对表由 knowledge.json 的动词族派生）
  l1Rule("Y118 CR-201: 确定型配对只有起手", "Y118",
    { files: { "Yarn/main.yarn": plain("ZzStart", "<<EnableDanmaku>>") }, main: "Yarn/main.yarn" },
    { files: { "Yarn/main.yarn": plain("ZzStart", "<<EnableDanmaku>>\n<<DisableDanmaku>>") }, main: "Yarn/main.yarn" });

  // CR-202 / Y119：可疑型配对只有起手（info，带「可疑：」前缀）
  l1Rule("Y119 CR-202: 可疑型配对只有起手（info）", "Y119",
    { files: { "Yarn/main.yarn": plain("ZzStart", "<<StartGibberish>>") }, main: "Yarn/main.yarn" },
    { files: { "Yarn/main.yarn": plain("ZzStart", "<<StartGibberish>>\n<<StopGibberish>>") }, main: "Yarn/main.yarn" });

  // CR-203 / Y120：确定型配对只有收尾
  l1Rule("Y120 CR-203: 确定型配对只有收尾", "Y120",
    { files: { "Yarn/main.yarn": plain("ZzStart", "<<DisableDanmaku>>") }, main: "Yarn/main.yarn" },
    { files: { "Yarn/main.yarn": plain("ZzStart", "<<EnableDanmaku>>\n<<DisableDanmaku>>") }, main: "Yarn/main.yarn" });

  // CR-501 / Y121：选项行 `#` 后面混了普通文字
  l1Rule("Y121 CR-501: 选项行 # 后混普通文字", "Y121",
    { files: { "Yarn/main.yarn": plain("ZzStart", "-> 选项文字 #后面跟着普通文字") }, main: "Yarn/main.yarn" },
    { files: { "Yarn/main.yarn": plain("ZzStart", "-> 选项文字 #Topic:ZzTopic") }, main: "Yarn/main.yarn" });

  // §11.1 索引为空时该族静默（空数据 ≠ 名字都错）
  const emptyTags = l1Run("empty-tags", { "Yarn/main.yarn": plain("ZzStart", "台词。 #Nope #line:9") },
    "Yarn/main.yarn", { tagVocabulary: { builtin: [], result: [], personality: [] }, modNames: [] });
  check("§11.1 空标签词表时标签族静默",
    emptyTags.every((c) => c !== "Y112" && c !== "Y113"), JSON.stringify(emptyTags));

  const emptyStates = l1Run("empty-states", { "Yarn/main.yarn": plain("ZzStart", "台词。 #state:idle #line:9") },
    "Yarn/main.yarn", { stateTags: [] });
  check("§11.1 空状态表时 #state 值检查静默",
    emptyStates.every((c) => c !== "Y104" && c !== "Y115"), JSON.stringify(emptyStates));

  const emptyChars = l1Run("empty-chars", { "Yarn/main.yarn": plain("ZzStart", "Character:ZzGhost\n" + line) },
    "Yarn/main.yarn", { characters: [] });
  check("§11.1 空角色表时 CR-114 静默",
    emptyChars.every((c) => c !== "Y111"), JSON.stringify(emptyChars));

  const offDefines = l1Run("off-defines", { "Yarn/main.yarn": plain("ZzStart", "台词。 #state:idle #line:9") },
    "Yarn/main.yarn", { checks: { defines: false } });
  check("§11.1 关掉 checkDefines 后 #state 检查静默",
    offDefines.every((c) => c !== "Y104" && c !== "Y115"), JSON.stringify(offDefines));

  const offVars = l1Run("off-vars", {
    "Yarn/a.yarn": plain("ZzA", "<<declare $zed>>"),
    "Yarn/main.yarn": plain("ZzB", "<<declare $zed>>")
  }, "Yarn/main.yarn", { checks: { variables: false } });
  check("§11.1 关掉 checkVariables 后重复 declare 静默",
    offVars.every((c) => c !== "Y109"), JSON.stringify(offVars));

  const offNodes = l1Run("off-nodes", { "Yarn/main.yarn": plain("ZzStart", '<<if visited("ZzGhost")>>\n' + line + "\n<<endif>>") },
    "Yarn/main.yarn", { checks: { nodes: false } });
  check("§11.1 关掉 checkNodes 后 visited 检查静默",
    offNodes.every((c) => c !== "Y108"), JSON.stringify(offNodes));

  // §11.2 槽位让路：`【…】` 让除了 CR-502 以外的规则全部让路
  const slotTags = l1Run("slot-tags", { "Yarn/main.yarn": plain("ZzStart", "台词。 #state:【状态】 #line:9") },
    "Yarn/main.yarn");
  check("§11.2 槽位让路：标签族不报",
    slotTags.every((c) => c !== "Y104" && c !== "Y110" && c !== "Y112" && c !== "Y115"), JSON.stringify(slotTags));

  const slotOpt = l1Run("slot-opt", { "Yarn/main.yarn": plain("ZzStart", "-> 选项【名字】 #普通文字") },
    "Yarn/main.yarn");
  check("§11.2 槽位让路：选项行不报 CR-501",
    slotOpt.every((c) => c !== "Y121"), JSON.stringify(slotOpt));

  // §11.3 生成顺序：step5 的标签诊断排在 step6 的配对诊断之前
  const order = l1Run("order", { "Yarn/main.yarn": plain("ZzStart", "<<EnableDanmaku>>\n台词。 #Nope #line:9") },
    "Yarn/main.yarn");
  check("§11.3 生成顺序：标签诊断先于配对诊断",
    order.indexOf("Y112") >= 0 && order.indexOf("Y118") >= 0 && order.indexOf("Y112") < order.indexOf("Y118"),
    JSON.stringify(order));

  // §11.3 单文档 500 条上限
  const tags600 = [];
  for (let i = 0; i < 600; i++) tags600.push("#Nope" + i);
  const capped = l1Run("cap", { "Yarn/main.yarn": plain("ZzStart", "台词。 " + tags600.join(" ") + " #line:9") },
    "Yarn/main.yarn");
  check("§11.3 单文档 500 条上限", capped.length === 500, String(capped.length));

  // §11.7 去重：跨文件的重复 declare 在一个文件里只报一次
  const dedupe = l1Run("dedupe", {
    "Yarn/a.yarn": plain("ZzA", "<<declare $zed>>"),
    "Yarn/main.yarn": plain("ZzB", "<<declare $zed>>\n<<declare $zed>>\n<<declare $zed>>")
  }, "Yarn/main.yarn");
  check("§11.7 去重：同文件多次 declare 只报一次",
    dedupe.filter((c) => c === "Y109").length === 1, JSON.stringify(dedupe));

  // §11.10 明确不报清单：when 表达式、说话者名字、注释都不判
  const quiet = l1Run("quiet", {
    "Yarn/main.yarn": "title: ZzStart\nwhen: 1 +* 2\n---\nCustomSpeaker: 台词。 #line:9\n// #Nope 在注释里\n===\n"
  }, "Yarn/main.yarn");
  check("§11.10 明确不报：when 表达式 / 说话者名 / 注释",
    quiet.length === 0, JSON.stringify(quiet));

  // §11.5 未保存文档并入：jump 到同一文本里的节点不算缺失
  const unsaved = l1Run("unsaved", {
    "Yarn/main.yarn": "title: ZzStart\n---\n<<jump ZzTarget>>\n台词。 #line:9\n===\ntitle: ZzTarget\n---\n台词。 #line:10\n===\n"
  }, "Yarn/main.yarn");
  check("§11.5 未保存文本里的节点能被 jump 找到",
    unsaved.every((c) => c !== "Y002"), JSON.stringify(unsaved));

  // 干净夹具：一条诊断都不该有
  const cleanAll = l1Run("clean", {
    "Yarn/main.yarn": plain("ZzClean", "ZzSpeaker: 干净的一句话。 #line:10 #state:Idle\nZzSpeaker: 再来一句。 #line:11 #Topic:ZzTopic")
  }, "Yarn/main.yarn");
  check("L1 干净夹具零诊断", cleanAll.length === 0, JSON.stringify(cleanAll));
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
/* the File menu's "打开示例 Mod" (electron/examples.js)                */
/* ------------------------------------------------------------------ */

/*
 * The demo package cannot be opened where it ships -- a card's `dir` never
 * leaves the mods folder -- so the menu item asks `mod.example` to copy it in
 * first and then navigates the same `?mod=` way the new-mod shortcut does.  As
 * with newmod.js, the frame and the address are the parts that can be wrong
 * without a window, and both are pure here.
 */

section('the File menu: "打开示例 Mod"');

const examplesMenu = require(join(ROOT, "electron", "examples.js"));

function answering(body, status = 200) {
  return async () => ({ status, text: async () => (typeof body === "string" ? body : JSON.stringify(body)) });
}
function reply(result) {
  return { jsonrpc: "2.0", id: 1, result };
}

check("the item is one frame and one address, nothing else",
  JSON.stringify(Object.keys(examplesMenu).sort()) === JSON.stringify(["install", "openUrl"]),
  JSON.stringify(Object.keys(examplesMenu).sort()));

const frames = [];
try {
  const answer = await examplesMenu.install({
    endpoint: "http://127.0.0.1:9/",
    fetchImpl: async (url, init) => {
      frames.push({ url, init });
      return { status: 200, text: async () => JSON.stringify(reply({ installed: true, dir: "Lantern", modRoot: "mods/Lantern", files: 22 })) };
    },
  });
  check("install posts to <endpoint>/rpc", frames.length === 1 && frames[0].url === "http://127.0.0.1:9/rpc", JSON.stringify(frames.map((one) => one.url)));
  check("with POST and a JSON body",
    frames[0].init.method === "POST" && frames[0].init.headers["content-type"] === "application/json",
    JSON.stringify(frames[0].init.method));
  check("the body is the exact mod.example frame",
    frames[0].init.body === '{"jsonrpc":"2.0","id":1,"method":"mod.example","params":{}}',
    frames[0].init.body);
  check("the reply's result is what the menu navigates with",
    answer.dir === "Lantern" && answer.files === 22, JSON.stringify(answer));
} catch (err) {
  check("install posts to <endpoint>/rpc", false, String(err));
}

try {
  let body = null;
  await examplesMenu.install({
    endpoint: "http://127.0.0.1:9",
    name: "  Lantern_Tests  ",
    fetchImpl: async (_url, init) => {
      body = init.body;
      return { status: 200, text: async () => JSON.stringify(reply({ installed: false, dir: "Lantern_Tests", modRoot: "mods/Lantern_Tests", files: 0 })) };
    },
  });
  check("a typed name is trimmed into the params",
    body === '{"jsonrpc":"2.0","id":1,"method":"mod.example","params":{"name":"Lantern_Tests"}}',
    body);
} catch (err) {
  check("a typed name is trimmed into the params", false, String(err));
}

let serverSaid = null;
try {
  await examplesMenu.install({
    endpoint: "http://127.0.0.1:9",
    fetchImpl: answering({ jsonrpc: "2.0", id: 1, error: { code: -32603, name: "RpcError", message: 'example: no demo package named "Nope"' } }),
  });
} catch (err) {
  serverSaid = err;
}
check("the shell's refusal is the menu's message, with its code",
  serverSaid instanceof Error && serverSaid.message === 'example: no demo package named "Nope"' && serverSaid.code === -32603,
  serverSaid === null ? "no error" : `${serverSaid.message} / ${serverSaid.code}`);

let noDir = null;
try {
  await examplesMenu.install({
    endpoint: "http://127.0.0.1:9",
    fetchImpl: answering(reply({ installed: true, files: 22 })),
  });
} catch (err) {
  noDir = err.message;
}
check("a reply with no directory is refused, not navigated to",
  typeof noDir === "string" && noDir.includes("没有可打开的目录"), noDir);

let noEndpoint = null;
try {
  await examplesMenu.install({ endpoint: "   ", fetchImpl: answering(reply({ dir: "Lantern" })) });
} catch (err) {
  noEndpoint = err.message;
}
check("a session without an endpoint is refused before any request",
  typeof noEndpoint === "string" && noEndpoint.includes("还没有 shell 端点"), noEndpoint);

const openShell = { url: "http://127.0.0.1:9/", workspace: ROOT, modsRoot: join(ROOT, "examples", "Mods") };
check("the address is the new-mod shortcut's, so one channel does both",
  examplesMenu.openUrl === undefined || examplesMenu.openUrl(openShell, "mods/Lantern") === newMod.openModUrl(openShell, "mods/Lantern"),
  examplesMenu.openUrl(openShell, "mods/Lantern"));
check("and it carries the package in ?mod=",
  examplesMenu.openUrl(openShell, "mods/Lantern").includes("?mod=mods%2FLantern"),
  examplesMenu.openUrl(openShell, "mods/Lantern"));

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

  /*
   * Steam 的默认位置按平台不同，而测试机器只有一个平台。所以平台和 env 都可以
   * 注入，三条检查用同一份注入数据说三个平台的话——它们不需要真的装一个 Steam。
   */
  const fakeHome = join(base, "home");
  const winDirs = gamepath.steamInstallDirs({ "ProgramFiles(x86)": "C:\\PF86" }, "win32");
  check("on Windows the Steam install directory comes from ProgramFiles(x86)",
    JSON.stringify(winDirs) === JSON.stringify([join("C:\\PF86", "Steam")]), JSON.stringify(winDirs));

  const linuxDirs = gamepath.steamInstallDirs({ HOME: fakeHome }, "linux");
  check("on Linux the default Steam roots are ~/.local/share/Steam and ~/.steam/steam",
    linuxDirs.includes(join(fakeHome, ".local", "share", "Steam")) &&
      linuxDirs.includes(join(fakeHome, ".steam", "steam")),
    JSON.stringify(linuxDirs));

  const macDirs = gamepath.steamInstallDirs({ HOME: fakeHome }, "darwin");
  check("on macOS the default Steam root is ~/Library/Application Support/Steam",
    macDirs.includes(join(fakeHome, "Library", "Application Support", "Steam")),
    JSON.stringify(macDirs));

  check("a Linux discovery uses the injected HOME, not the machine's",
    gamepath.defaultSearchRoots({ HOME: fakeHome }, "linux").includes(join(fakeHome, ".local", "share", "Steam")),
    JSON.stringify(gamepath.defaultSearchRoots({ HOME: fakeHome }, "linux").slice(0, 3)));

  check("describeDiscovery says where the folder was found, and by what",
    gamepath.describeDiscovery({ found: true, dir: join(base, "Mods"), source: "discover" }) ===
      `found ${join(base, "Mods")} (discover)`,
    gamepath.describeDiscovery({ found: true, dir: join(base, "Mods"), source: "discover" }));

  check("describeDiscovery on a miss counts the places it looked, with a plural",
    gamepath.describeDiscovery({ found: false, tried: [{}, {}, {}] }) === "not found; looked in 3 places" &&
      gamepath.describeDiscovery({ found: false, tried: [{}] }) === "not found; looked in 1 place",
    gamepath.describeDiscovery({ found: false, tried: [{}, {}, {}] }));

  check("an injected platform reaches discovery: no Windows ProgramFiles is needed on Linux",
    gamepath
      .discoverGameModsDir({ env: { HOME: fakeHome }, platform: "linux", searchRoots: [base] })
      .dir === corpus,
    JSON.stringify({ dir: gamepath.discoverGameModsDir({ env: { HOME: fakeHome }, platform: "linux", searchRoots: [base] }).dir }));

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
/* where the knowledge base comes from                                 */
/* ------------------------------------------------------------------ */

section("the knowledge base is resolved, shipped or derived (G30/G31)");

{
  const base = specTemp("infantgod-kb-resolve-");
  const noGame = join(base, "no-game");

  /** 一份能分辨来源的迷你知识库：schema 让 state=present，commands 带来源标记。 */
  const kbFile = (file, marker) => specWrite(file, JSON.stringify({
    version: 1,
    stats: { marker: marker },
    commands: [{ name: marker, parameters: [], usage: 0 }],
    functions: [], variables: [], nodes: [], baseline: {},
    schemas: { Demo: { type: "object", properties: {} } },
    localization: { baseLanguage: "zh-CN", locales: [], characters: [] },
  }, null, 2) + "\n");
  const markerOf = (mods) => {
    const kb = mods.knowledge();
    return kb.commands && kb.commands[0] ? kb.commands[0].name : null;
  };

  const optionFile = kbFile(join(base, "option", "k.json"), "From_Option");
  const envFile = kbFile(join(base, "env", "k.json"), "From_Env");
  const bundledFile = kbFile(join(base, "bundled", "k.json"), "From_Bundled");
  const userDir = join(base, "user");
  const userFile = kbFile(join(userDir, "knowledge.json"), "From_User");
  const bundledMissing = join(base, "no-bundled", "knowledge.json");

  const p1 = createMods({
    knowledgePath: optionFile, bundledKnowledgePath: bundledFile, userDir: userDir,
    env: { INFANTGOD_KNOWLEDGE: envFile }, gameModsDir: noGame,
  });
  check("an explicit knowledgePath wins over environment, shipped and user copies",
    p1.knowledgeState().source === "option" && p1.knowledgeState().path === optionFile && markerOf(p1) === "From_Option",
    JSON.stringify(p1.knowledgeState()));

  const p2 = createMods({
    bundledKnowledgePath: bundledFile, userDir: userDir,
    env: { INFANTGOD_KNOWLEDGE: envFile }, gameModsDir: noGame,
  });
  check("INFANTGOD_KNOWLEDGE wins over the shipped and user copies",
    p2.knowledgeState().source === "env" && markerOf(p2) === "From_Env",
    JSON.stringify(p2.knowledgeState()));

  const p3 = createMods({ bundledKnowledgePath: bundledFile, userDir: userDir, env: {}, gameModsDir: noGame });
  check("a shipped knowledge.json wins over a stale copy in the user dir",
    p3.knowledgeState().source === "bundled" && markerOf(p3) === "From_Bundled",
    JSON.stringify(p3.knowledgeState()));

  const p4 = createMods({ bundledKnowledgePath: bundledMissing, userDir: userDir, env: {}, gameModsDir: noGame });
  check("a copy derived earlier in the user dir is used when nothing ships",
    p4.knowledgeState().source === "user" && markerOf(p4) === "From_User" && p4.knowledgeState().path === userFile,
    JSON.stringify(p4.knowledgeState()));

  /* 自造的迷你游戏树：派生只依赖 SODefines/Schema + SODefines/Defines + 一个 Yarn 文件。 */
  const gameDir = join(base, "game");
  specWrite(join(gameDir, "SODefines", "Schema", "Demo.schema.json"), JSON.stringify({
    type: "object", properties: { techName: { type: "string" } },
  }, null, 2));
  specWrite(join(gameDir, "SODefines", "Defines", "Demo", "Hero.json"), JSON.stringify({ techName: "Demo_Hero" }, null, 2));
  specWrite(join(gameDir, "MyMod", "Yarn", "Logic", "Demo.yarn"), [
    "title: Demo_Start", "---", "Demo_Hero: 早。 #line:0abcdef", "===", "",
  ].join("\n"));

  const now = "2026-01-01T00:00:00.000Z";
  const coreKb = knowledgeBuild.buildKnowledge(gameDir, { now: now });
  const genMod = await import(pathToFileURL(join(ROOT, "tools", "gen_knowledge.mjs")).href);
  const genKb = genMod.buildKnowledge(gameDir, { now: now });
  check("tools/gen_knowledge.mjs is a thin CLI over shell/mods/knowledge-build.js, not a second copy",
    JSON.stringify(genKb) === JSON.stringify(coreKb) &&
    genMod.canonicalKnowledge === knowledgeBuild.canonicalKnowledge &&
    genMod.diffKnowledge === knowledgeBuild.diffKnowledge,
    JSON.stringify({ same: JSON.stringify(genKb) === JSON.stringify(coreKb) }));

  /* 四个位置都没有：自己派生一份，写进 userDir。 */
  const deriveUser = join(base, "derive");
  const derived = createMods({ bundledKnowledgePath: bundledMissing, userDir: deriveUser, env: {}, gameModsDir: gameDir });
  const derivedState = derived.knowledgeState();
  check("with nothing shipped or cached, the knowledge base is derived from the game's own folder",
    derivedState.state === "present" && derivedState.source === "derived" &&
    derivedState.path === join(deriveUser, "knowledge.json") && existsSync(derivedState.path),
    JSON.stringify(derivedState));
  const derivedKb = derived.knowledge();
  check("the derived knowledge base carries the game's facts, not an empty shell",
    derivedKb.stats.yarnFiles === 1 && derivedKb.schemas.Demo !== undefined &&
    derivedKb.baseline.Demo.includes("Demo_Hero"),
    JSON.stringify({ stats: derivedKb.stats, base: derivedKb.baseline }));
  const written = JSON.parse(readFileSync(derivedState.path, "utf8"));
  check("the file it wrote holds exactly the facts the core derives",
    JSON.stringify(knowledgeBuild.canonicalKnowledge(written)) ===
    JSON.stringify(knowledgeBuild.canonicalKnowledge(coreKb)),
    "written file and fresh derivation disagree");

  /* 第二次启动用缓存，不重新派生（游戏目录变了也不该重算）。 */
  const beforeMtime = statSync(derivedState.path).mtimeMs;
  specWrite(join(gameDir, "MyMod", "Yarn", "Logic", "Second.yarn"), "title: Demo_Two\n---\nDemo_Hero: 再来。\n===\n");
  const second = createMods({ bundledKnowledgePath: bundledMissing, userDir: deriveUser, env: {}, gameModsDir: gameDir });
  const secondState = second.knowledgeState();
  check("the next boot reuses the derived file instead of deriving again",
    secondState.source === "user" && second.knowledge().stats.yarnFiles === 1,
    JSON.stringify({ state: secondState, yarnFiles: second.knowledge().stats.yarnFiles }));
  check("and it does not rewrite the file it already had", statSync(derivedState.path).mtimeMs === beforeMtime,
    String(statSync(derivedState.path).mtimeMs) + " vs " + String(beforeMtime));

  /* 派生的写出目标不可用 / 游戏目录不可用：两种失败都要说出来，不能当空 KB。 */
  const blocked = join(base, "blocked");
  specWrite(blocked, "this is a file, not a directory");
  const blockedMods = createMods({ bundledKnowledgePath: bundledMissing, userDir: blocked, env: {}, gameModsDir: gameDir });
  const blockedState = blockedMods.knowledgeState();
  check("an unwritable user dir is reported as a derivation failure",
    blockedState.state === "missing" && !!blockedState.deriveError,
    JSON.stringify(blockedState));

  const noGameMods = createMods({ bundledKnowledgePath: bundledMissing, userDir: join(base, "nouser"), env: {}, gameModsDir: noGame });
  const noGameState = noGameMods.knowledgeState();
  check("no knowledge base and no game folder is the named missing state, with nothing invented",
    noGameState.state === "missing" && noGameState.schemas === 0 &&
    /knowledge\.json 不存在/.test(noGameState.loadError || "") &&
    !existsSync(join(base, "nouser", "knowledge.json")),
    JSON.stringify(noGameState));

  const corruptDir = join(base, "corrupt");
  specWrite(join(corruptDir, "knowledge.json"), "{ this is not json");
  const corruptMods = createMods({ bundledKnowledgePath: bundledMissing, userDir: corruptDir, env: {}, gameModsDir: gameDir });
  const corruptState = corruptMods.knowledgeState();
  check("a corrupt knowledge.json is a named load error, not an empty knowledge base",
    corruptState.state === "missing" && corruptState.source === "user" &&
    /JSON/.test(corruptState.loadError || ""),
    JSON.stringify(corruptState));

  /* 用户目录的默认位置与 INFANTGOD_USER_DIR 覆盖。 */
  const appDir = "OsanaKami IDE Studio";
  /* 拼出来而不是写字面量：tools/path_guard.py 会把源码里的 /home/<名字> 当成机器路径。 */
  const homeU = ["", "home", "u"].join("/");
  check("defaultUserDir follows each platform's convention",
    defaultUserDir({ APPDATA: "C:/roaming", LOCALAPPDATA: "C:/local" }, "win32") === join("C:/roaming", appDir) &&
    defaultUserDir({ LOCALAPPDATA: "C:/local" }, "win32") === join("C:/local", appDir) &&
    defaultUserDir({ HOME: homeU }, "darwin") === join(homeU, "Library", "Application Support", appDir) &&
    defaultUserDir({ HOME: homeU }, "linux") === join(homeU, ".local", "share", appDir) &&
    defaultUserDir({ HOME: homeU, XDG_DATA_HOME: "/data" }, "linux") === join("/data", appDir),
    JSON.stringify([
      defaultUserDir({ APPDATA: "C:/roaming" }, "win32"),
      defaultUserDir({ HOME: homeU }, "darwin"),
      defaultUserDir({ HOME: homeU }, "linux"),
    ]));

  const envUser = join(base, "env-user");
  const envUserMods = createMods({
    bundledKnowledgePath: bundledMissing, env: { INFANTGOD_USER_DIR: envUser }, gameModsDir: gameDir,
  });
  check("INFANTGOD_USER_DIR chooses where the derived file goes",
    envUserMods.knowledgeState().source === "derived" &&
    envUserMods.knowledgeState().path === join(envUser, "knowledge.json"),
    JSON.stringify(envUserMods.knowledgeState()));

  /* 仓库里跑（ship 了 knowledge.json）：用打包的那份，绝不写用户目录。 */
  const moduleUser = join(base, "module-user");
  const moduleMods = createMods({ userDir: moduleUser, env: {} });
  check("a checkout serves the shipped knowledge base and writes nothing to the user dir",
    moduleMods.knowledgeState().source === "bundled" &&
    moduleMods.knowledgeState().path === KNOWLEDGE_PATH && !existsSync(moduleUser),
    JSON.stringify(moduleMods.knowledgeState()));

  /* 文件被换掉（内容/大小变了）后，下一次使用要重读，而不是一直用旧的事实。 */
  const liveFile = kbFile(join(base, "live", "knowledge.json"), "From_Live");
  const liveMods = createMods({ knowledgePath: liveFile, env: {} });
  const firstRead = markerOf(liveMods);
  kbFile(join(base, "live", "knowledge.json"), "From_Live_Renamed");
  const refreshed = markerOf(liveMods);
  check("a knowledge.json replaced on disk is re-read on the next use",
    firstRead === "From_Live" && refreshed === "From_Live_Renamed",
    JSON.stringify({ firstRead: firstRead, refreshed: refreshed }));
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
    properties: {
      techName: { type: "string" },
      hp: { type: "number", description: "also stripped" },
      portrait: { type: "string", description: "Relative path to sprite image file (png)" },
      friend: { type: "string", description: "TechName reference to OtherDefinition" },
    },
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
  /*
   * G41: the two facts that sentence-shaped descriptions encode must survive the
   * text.  If they do not, regenerating the KB silently empties the reference and
   * sprite checks and `ok:true` starts meaning "nothing was looked at".
   */
  check("a description naming a TechName reference leaves the reference behind as a fact",
    kb.schemas.Demo.properties.friend["x-techReference"] === "OtherDefinition",
    JSON.stringify(kb.schemas.Demo.properties.friend));
  check("a description naming a sprite path leaves the flag behind as a fact",
    kb.schemas.Demo.properties.portrait["x-sprite"] === true,
    JSON.stringify(kb.schemas.Demo.properties.portrait));
  check("and neither sentence itself survives",
    !JSON.stringify(kb).includes("Relative path to sprite image file") &&
    !JSON.stringify(kb).includes("TechName reference to"),
    "a description sentence survived");
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
/* a regenerated knowledge base still knows the fields it checks      */
/* ------------------------------------------------------------------ */

section("a facts-only knowledge base keeps the fields the checker looks at");

{
  const validate = require(join(HERE, "validate.js"));
  const factsOnly = {
    schemas: {
      Hero: {
        type: "object",
        properties: {
          portrait: { type: "string", "x-sprite": true },
          friend: { type: "string", "x-techReference": "OtherDefinition" },
        },
      },
      Other: { type: "object", properties: { techName: { type: "string" } } },
    },
  };
  const rich = {
    schemas: {
      Hero: {
        type: "object",
        properties: {
          portrait: { type: "string", description: "Relative path to sprite image file (png)" },
          friend: { type: "string", description: "TechName reference to OtherDefinition" },
        },
      },
      Other: { type: "object", properties: { techName: { type: "string" } } },
    },
  };
  const factsMap = validate.referenceMap(factsOnly.schemas);
  const richMap = validate.referenceMap(rich.schemas);
  check("the sprite and reference fields survive in a facts-only knowledge base",
    factsMap.Hero.portrait === "sprite" && factsMap.Hero.friend === "Other",
    JSON.stringify(factsMap));
  check("a rich KB and a facts-only KB describe the same fields",
    JSON.stringify(factsMap) === JSON.stringify(richMap),
    JSON.stringify({ factsMap, richMap }));
  const stripped = {
    schemas: {
      Hero: { type: "object", properties: { portrait: { type: "string" }, friend: { type: "string" } } },
      Other: rich.schemas.Other,
    },
  };
  check("with neither the fact nor the sentence there is nothing to check, and the map is empty",
    Object.keys(validate.referenceMap(stripped.schemas).Hero).length === 0,
    JSON.stringify(validate.referenceMap(stripped.schemas)));
  const summary = validate.schemaSummary(factsOnly);
  check("schemaSummary lists the same sprite path",
    summary.find((s) => s.type === "Hero").sprites.join(",") === "portrait",
    JSON.stringify(summary.map((s) => [s.type, s.sprites])));

  /*
   * 派生出来的知识库只有事实键。校验必须认它们，否则「没有发布物知识库」的机器
   * 上 D005/D006 会静默消失，ok:true 又会变成「什么都没看」。
   */
  const factsKbFile = specWrite(join(specTemp("infantgod-facts-kb-"), "knowledge.json"), JSON.stringify({
    version: 1, stats: {}, commands: [], functions: [], variables: [], nodes: [],
    schemas: factsOnly.schemas, baseline: { Other: ["Exists"] },
    localization: { locales: [], characters: [] },
    undocumentedCommands: [], undeclaredVariables: [],
  }, null, 2) + "\n");
  const factsPkg = join(specTemp("infantgod-facts-mod-"), "FactsOnlyMod");
  specWrite(join(factsPkg, "mod.json"), JSON.stringify({
    name: "FactsOnlyMod", version: "1.0.0", gameVersion: "1.0", loadOrder: 5,
    author: "selftest", description: "a package checked against a facts-only knowledge base",
  }, null, 2) + "\n");
  specWrite(join(factsPkg, "Defines", "Hero", "Probe.json"), JSON.stringify({
    techName: "Hero_Probe", portrait: "Sprites/Missing.png", friend: "No_Such_Other",
  }, null, 2) + "\n");
  const factsMods = createMods({ knowledgePath: factsKbFile, gameModsDir: join(factsPkg, "no-game") });
  const factsReport = factsMods.validatePackage({ root: factsPkg });
  check("a facts-only knowledge base still runs D006 and D005",
    factsReport.diagnostics.some((d) => d.code === "D006") &&
    factsReport.diagnostics.some((d) => d.code === "D005"),
    JSON.stringify(factsReport.diagnostics.map((d) => d.code)));
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

/*
 * 语言服务的位置层（docs/LANGUAGE.md §2）。位置是纯函数，不需要浏览器也不需要
 * 语料：行从 1 数，列与 UTF-16 offset 从 0 数，CRLF 与裸 CR 各算一种行尾，区间
 * 从不跨行。这里钉的是"屏幕要什么"，错一个偏移就是选错一个字符。
 */
section("language service: positions");
{
  const {
    lineStarts, lineCount, offsetToPosition, positionToOffset, columnAt, lineText,
    rangeBetween, rangeOfLineCols, diagnosticRange, wordAt, isRangeInText, shiftRange, formatRange,
  } = require(join(HERE, "positions.js"));
  const eq = (name, actual, expected) => check(name, JSON.stringify(actual) === JSON.stringify(expected),
    `got ${JSON.stringify(actual)}, want ${JSON.stringify(expected)}`);

  eq("empty text has one empty line", lineStarts(""), [0]);
  eq("empty text counts as one line", lineCount(""), 1);
  eq("one line, no terminator", lineStarts("abc"), [0]);
  eq("LF starts a line", lineStarts("a\nb"), [0, 2]);
  eq("a trailing LF opens a last empty line", lineStarts("a\n"), [0, 2]);
  eq("CRLF counts as two code units", lineStarts("a\r\nb"), [0, 3]);
  eq("CRLF line count", lineCount("a\r\nb"), 2);
  eq("a lone CR is a line ending too", lineStarts("a\rb"), [0, 2]);
  eq("blank lines", lineStarts("\n\n"), [0, 1, 2]);
  eq("trailing CRLF", lineStarts("a\r\n"), [0, 3]);

  eq("offset 0", offsetToPosition("abc", 0), { line: 1, character: 0 });
  eq("offset 2", offsetToPosition("abc", 2), { line: 1, character: 2 });
  eq("the end of the text is a position", offsetToPosition("abc", 3), { line: 1, character: 3 });
  eq("past an LF", offsetToPosition("a\nb", 2), { line: 2, character: 0 });
  eq("past a CRLF", offsetToPosition("a\r\nb", 3), { line: 2, character: 0 });
  // The \r itself belongs to line 1, character 1.
  eq("the CR is still line 1", offsetToPosition("a\r\nb", 1), { line: 1, character: 1 });
  eq("offset past a trailing LF", offsetToPosition("a\n", 2), { line: 2, character: 0 });
  eq("an offset past the end clamps", offsetToPosition("abc", 99), { line: 1, character: 3 });
  eq("a negative offset clamps", offsetToPosition("abc", -5), { line: 1, character: 0 });
  eq("a NaN offset clamps", offsetToPosition("abc", NaN), { line: 1, character: 0 });

  // A smiley is TWO UTF-16 code units: the screen counts what the string counts.
  const smiley = "\u{1F600}";
  eq("a smiley is two code units", smiley.length, 2);
  eq("the middle of a pair is a position", offsetToPosition(smiley + "x", 1), { line: 1, character: 1 });
  eq("after a pair", offsetToPosition(smiley + "x", 2), { line: 1, character: 2 });
  eq("column counts code units", columnAt(smiley + "x", 2), 2);

  eq("position to offset 0", positionToOffset("abc", { line: 1, character: 0 }), 0);
  eq("position to offset 2", positionToOffset("abc", { line: 1, character: 2 }), 2);
  eq("a character past the line clamps to its end", positionToOffset("abc", { line: 1, character: 99 }), 3);
  eq("line 2 begins after the LF", positionToOffset("a\nb", { line: 2, character: 0 }), 2);
  eq("a line past the end clamps to the text end", positionToOffset("a\nb", { line: 9, character: 0 }), 3);
  eq("line 0 still lands inside the text", positionToOffset("a\nb", { line: 0, character: 1 }), 1);
  eq("line 2 of a CRLF file", positionToOffset("a\r\nb", { line: 2, character: 1 }), 4);

  const text = "第一行\nsecond line\r\nthird\tline\n\n\u{1F600} emoji end";
  let roundTrips = true;
  for (let i = 0; i <= text.length; i += 1) {
    if (positionToOffset(text, offsetToPosition(text, i)) !== i) { roundTrips = false; break; }
  }
  check("every offset survives the round trip", roundTrips);

  eq("lineText strips a CRLF", lineText("a\r\nb", 1), "a");
  eq("lineText, second line", lineText("a\r\nb", 2), "b");
  eq("lineText past the end is empty", lineText("a\n", 5), "");

  const range = rangeBetween("a\nbc\nd", 2, 4);
  eq("range start", range.start, { line: 2, character: 0 });
  eq("range end", range.end, { line: 2, character: 2 });
  eq("range offsets", [range.startOffset, range.endOffset], [2, 4]);
  eq("a backwards range is normalised", rangeBetween("abc", 3, 1).startOffset, 1);
  eq("a range prints as line:col-line:col", formatRange(rangeBetween("abc", 1, 3)), "1:1-1:3");

  const byLineCols = rangeOfLineCols("xx\nalpha beta\n", 2, 1, 6);
  eq("line/column to offsets", [byLineCols.startOffset, byLineCols.endOffset], [3, 8]);
  const toLineEnd = rangeOfLineCols("xx\nalpha beta\n", 2, 7, 7);
  eq("a column range that runs to the end stops at the line end", [toLineEnd.startOffset, toLineEnd.endOffset], [9, 13]);
  const onEmptyLine = rangeOfLineCols("a\n\nb", 2, 1, 1);
  eq("an empty line has a zero-width range", [onEmptyLine.startOffset, onEmptyLine.endOffset], [2, 2]);

  const diagText = "xx\n  <<jump Nowhere>>\n";
  const withLength = diagnosticRange(diagText, { line: 2, col: 3, length: 14 });
  eq("a diagnostic with a length", [withLength.startOffset, withLength.endOffset], [5, 19]);
  const toEnd = diagnosticRange(diagText, { line: 2, col: 3 });
  eq("a diagnostic without a length runs to the line end", [toEnd.startOffset, toEnd.endOffset], [5, 21]);
  const noCol = diagnosticRange(diagText, { line: 2 });
  eq("a diagnostic without a column starts at the line start", noCol.startOffset, 3);

  eq("word at a command name", wordAt("  <<jump Nowhere>>", 8).text, "jump");
  eq("word at an argument", wordAt("  <<jump Nowhere>>", 13).text, "Nowhere");
  eq("word at a boundary", wordAt("abc def", 3).text, "abc");
  eq("word after a space", wordAt("abc def", 4).text, "def");
  eq("word with CJK and underscore", wordAt("节点: 灯笼_Awake", 5).text, "灯笼_Awake");
  eq("no word in empty text", wordAt("", 0).text, "");

  check("a range inside the text is accepted", isRangeInText("abcdef", { startOffset: 1, endOffset: 3 }));
  check("a range outside the text is rejected", !isRangeInText("abcdef", { startOffset: 1, endOffset: 99 }));
  check("a zero-width range is not a range in the text", !isRangeInText("abcdef", { startOffset: 2, endOffset: 2 }));
  eq("shifting a range", shiftRange({ startOffset: 1, endOffset: 3 }, 10), { startOffset: 11, endOffset: 13 });
  eq("a NaN shift leaves the range alone", shiftRange({ startOffset: 1, endOffset: 3 }, NaN), { startOffset: 1, endOffset: 3 });

  const yarnText = "title: Demo\n---\n<<jump Missing>>\n\tWarden: Hello #line:abc1234\n";
  const realRange = diagnosticRange(yarnText, { line: 3, col: 1, length: 16 });
  eq("a real Yarn diagnostic lands on line 3", realRange.start.line, 3);
  eq("a real Yarn diagnostic starts at column 1", realRange.start.character, 0);
  eq("and covers the command", yarnText.slice(realRange.startOffset, realRange.endOffset), "<<jump Missing>>");
}

/*
 * 补全与悬停（docs/LANGUAGE.md §3-§5）。两个函数都只读索引、不写盘：补全说
 * "这里能写什么"，悬停说"这个词是什么"，没有把握时返回 null 而不是编一个。
 */
section("language service: completion and hover");
{
  const search = require(join(HERE, "search.js"));
  const lang = require(join(HERE, "complete.js"));
  const index = search.buildIndex(JSON.parse(readFileSync(KNOWLEDGE_PATH, "utf8")), {});
  const eq = (name, actual, expected) => check(name, JSON.stringify(actual) === JSON.stringify(expected),
    `got ${JSON.stringify(actual)}, want ${JSON.stringify(expected)}`);
  const at = (text) => text.length;
  const labels = (result, n) => result.items.slice(0, n || 5).map((i) => i.label);

  {
    const text = "<<jum";
    const ctx = lang.classify(text, at(text));
    eq("a command context", ctx.kind, "command");
    eq("its prefix", ctx.prefix, "jum");
    eq("its replace range", [ctx.replace.startOffset, ctx.replace.endOffset], [2, 5]);
    const result = lang.complete(text, at(text), index);
    check("it offers jump", labels(result, 30).includes("jump"), JSON.stringify(labels(result, 30)));
    const jump = result.items.find((i) => i.label === "jump");
    check("a command inserts with a trailing space", jump && jump.insertText === "jump ", JSON.stringify(jump && jump.insertText));
  }
  {
    const text = "<<jum>>";
    eq("mid-word replaces only the word", [lang.classify(text, 5).replace.startOffset, lang.classify(text, 5).replace.endOffset], [2, 5]);
  }
  {
    const text = "<<jump ";
    const ctx = lang.classify(text, at(text));
    eq("an argument context", ctx.kind, "argument");
    eq("the command it belongs to", ctx.command, "jump");
    eq("the argument index", ctx.argIndex, 0);
    eq("a node-name argument", ctx.context, "node");
    const result = lang.complete(text, at(text), index);
    check("arguments come back as labelled items", result.items.length > 0 && result.items.every((i) => typeof i.label === "string"));
  }
  {
    const text = '<<jump "Init';
    const ctx = lang.classify(text, at(text));
    eq("a quoted argument is still an argument", ctx.kind, "argument");
    eq("the quote is not part of the prefix", ctx.prefix, "Init");
    eq("the replace range stays inside the quotes", [ctx.replace.startOffset, ctx.replace.endOffset], [8, 12]);
    const result = lang.complete(text, at(text), index);
    check("a quoted prefix matches a node", result.items.some((i) => i.label === "Initial"), JSON.stringify(labels(result, 5)));
  }
  {
    const text = "<<AdvanceTime ";
    eq("a builtin with no known argument context", lang.classify(text, at(text)).context, "");
    eq("so it offers nothing", lang.complete(text, at(text), index).items.length, 0);
  }
  {
    const text = "#sta";
    const ctx = lang.classify(text, at(text));
    eq("a tag context", ctx.kind, "tag");
    eq("its prefix", ctx.prefix, "sta");
    const result = lang.complete(text, at(text), index);
    check("it offers state", labels(result, 10).includes("state"), JSON.stringify(labels(result, 10)));
    const state = result.items.find((i) => i.label === "state");
    eq("a tag inserts its colon", state && state.insertText, "state:");
  }
  {
    const text = "Warden: hi #line";
    const ctx = lang.classify(text, at(text));
    eq("a tag after text", ctx.kind, "tag");
    eq("and its prefix", ctx.prefix, "line");
  }
  {
    check("C# is not a tag", lang.classify("See C#", 6).kind === "none");
  }
  {
    const text = "#state:";
    const ctx = lang.classify(text, at(text));
    eq("a tag value context", ctx.kind, "tagvalue");
    eq("the tag it belongs to", ctx.tag, "state");
    eq("its values are the index's state names",
      lang.complete(text, at(text), index).items.length, (index.emotionTags || []).length);
  }
  {
    const text = "#state:Cal";
    const ctx = lang.classify(text, at(text));
    eq("a tag value prefix", ctx.prefix, "Cal");
    eq("and its replace range ends at the caret", ctx.replace.endOffset, 10);
  }
  {
    const text = "#vo:";
    const ctx = lang.classify(text, at(text));
    eq("#vo is a tag value with no index behind it", [ctx.kind, ctx.tag, ctx.context], ["tagvalue", "vo", ""]);
    eq("so it offers nothing", lang.complete(text, at(text), index).items.length, 0);
  }
  {
    const text = "  $Achi";
    const ctx = lang.classify(text, at(text));
    eq("a variable context", ctx.kind, "variable");
    eq("its prefix", ctx.prefix, "Achi");
    const result = lang.complete(text, at(text), index);
    const hit = result.items.find((i) => String(i.label).toLowerCase() === "achievement_sooooboring");
    check("a variable inserts with its real casing and a dollar", hit && hit.insertText === "$Achievement_SOOOOBORING", hit && hit.insertText);
  }
  {
    const known = index.characters[0].name;
    const text = known.slice(0, 2);
    const ctx = lang.classify(text, at(text));
    eq("a speaker context", ctx.kind, "character");
    eq("its prefix is what was typed", ctx.prefix, text);
    const result = lang.complete(text, at(text), index);
    check("the speaker is offered", labels(result, 30).includes(known), JSON.stringify(labels(result, 30)));
  }
  {
    const text = "Ward: hello";
    const ctx = lang.classify(text, 4);
    eq("a speaker mid-line", ctx.kind, "character");
    eq("with the name typed so far", ctx.prefix, "Ward");
  }
  {
    eq("an empty line is not a speaker", lang.classify("", 0).kind, "none");
  }
  {
    const text = "<<jum";
    check("a partial command has no hover", lang.hover(text, at(text), index) === null);
  }
  {
    const text = "<<jump>>";
    const hover = lang.hover(text, 4, index);
    check("a command hovers", hover && hover.kind === "command", JSON.stringify(hover && hover.kind));
    check("the hover says the command's name", hover && hover.contents[0].value.includes("jump"), hover && hover.contents[0].value.slice(0, 40));
  }
  {
    const text = "$Achievement_SOOOOBORING";
    const hover = lang.hover(text, 4, index);
    check("a variable hovers", hover && hover.kind === "variable", JSON.stringify(hover && hover.kind));
    check("the hover says the variable's type", hover && hover.contents[0].value.includes("bool"), hover && hover.contents[0].value);
  }
  {
    const hover = lang.hover("#state:", 3, index);
    check("a tag hovers", hover && hover.kind === "tag" && hover.name === "state", JSON.stringify(hover && hover.name));
  }
  {
    const hover = lang.hover("A sentence with Initial inside it.", 17, index);
    check("a node name in prose hovers", hover && hover.kind === "node", JSON.stringify(hover && hover.kind));
  }
  {
    const text = "<<";
    const first = JSON.stringify(lang.complete(text, at(text), index));
    const second = JSON.stringify(lang.complete(text, at(text), index));
    check("completion is deterministic", first === second);
    check("completion is bounded", lang.complete(text, at(text), index).items.length <= 200,
      String(lang.complete(text, at(text), index).items.length));
  }
  {
    eq("a closed command is not a command context", lang.classify("<<jump>>", 8).kind, "none");
  }
  {
    const text = "title: X\r\n---\r\n<<jum";
    const ctx = lang.classify(text, at(text));
    eq("a CRLF document still finds the command", ctx.kind, "command");
    eq("on the right line", ctx.line, 3);
    eq("with the right prefix", ctx.prefix, "jum");
  }
}

/*
 * 两个 shell 动词：`mod.complete` 与 `mod.hover`。光标是正在编辑的文档上的
 * 0-based UTF-16 偏移（positions.js 的定义），文档本身不必保存过 —— 编辑器
 * 拿内存里的文本直接问，动词不读盘。
 */
section("language service: the two shell verbs");
{
  const text = "title: Probe\n---\n<<jum";
  const answered = await frame(41, "mod.complete", { text, caret: text.length });
  check("mod.complete answers with a context and items, not a bare array",
    answered.error === undefined && answered.result !== undefined
      && answered.result.context.kind === "command"
      && answered.result.context.prefix === "jum"
      && Array.isArray(answered.result.items),
    JSON.stringify(answered).slice(0, 160));

  const jump = answered.result && answered.result.items.find((i) => i.label === "jump");
  check("an item carries what the editor has to replace and insert",
    jump !== undefined && jump.insertText === "jump "
      && typeof jump.replace.startOffset === "number" && jump.replace.startOffset < jump.replace.endOffset,
    JSON.stringify(jump));

  check("the context counts lines of the document it was given, not of a file",
    answered.result.context.line === 3 && answered.result.context.character === 5,
    JSON.stringify(answered.result.context));

  check("isIncomplete is part of the answer", answered.result.isIncomplete === false,
    String(answered.result.isIncomplete));

  const hovered = await frame(42, "mod.hover", { text: "<<jump X>>", caret: 3 });
  check("mod.hover names the token under the caret",
    hovered.error === undefined && hovered.result !== null
      && hovered.result.kind === "command" && hovered.result.name === "jump",
    JSON.stringify(hovered.result && hovered.result.kind));

  const silent = await frame(43, "mod.hover", { text: "zz", caret: 2 });
  check("nothing under the caret is null, not an invented answer",
    silent.result === null && silent.error === undefined, JSON.stringify(silent).slice(0, 120));

  const defaults = await frame(44, "mod.complete", {});
  check("missing text and caret default to an empty document, not INVALID_PARAMS",
    defaults.error === undefined && defaults.result.context.kind === "none" && defaults.result.items.length === 0,
    JSON.stringify(defaults).slice(0, 140));

  const noParams = await frame(45, "mod.hover", {});
  check("mod.hover with no document is null too",
    noParams.result === null && noParams.error === undefined, JSON.stringify(noParams).slice(0, 120));

  const again = await frame(46, "mod.complete", { text, caret: text.length });
  check("the same document and caret give the same answer",
    JSON.stringify(again.result) === JSON.stringify(answered.result));

  check("neither verb reached the kernel", kernelCalls === 0, String(kernelCalls));
}

/* ------------------------------------------------------------------ */
/* G50: mod.newFile — 在一个已有的包里按类型新建一个文件               */
/* ------------------------------------------------------------------ */

/*
 * 这个动词的输入是（目录, 类型, 名字），输出是一个真实存在、并且包校验器认
 * 为干净的文件。写盘/覆盖/拒绝的行为都在临时沙盒里跑，不碰语料、不碰仓库。
 *
 * 为什么每个 kind 都要看内容而不只是看路径：编辑器下一步是「把新文件打开给
 * 人编辑」，一个空文件或一个解析不了的故事等于没生成。
 */
section("new file by type: mod.newFile");
{
  const sandbox = mkdtempSync(join(tmpdir(), "infantgod-newfile-"));
  try {
    const fresh = createMods({ modsRoot: sandbox });
    const created = await fresh.scaffold({ dir: join(sandbox, "Files"), modName: "Files", template: "full" });
    const pkg = created.modRoot;
    const newfileCore = require(join(HERE, "newfile.js"));
    const readText = (rel) => readFileSync(join(pkg, rel), "utf8");
    const readBytes = (rel) => readFileSync(join(pkg, rel));

    /* a schema type -------------------------------------------------- */

    const definePath = "Defines/Attr/NewAttr.json";
    const define = fresh.newFile({ dir: pkg, type: "Attr", name: "NewAttr" });
    check("a schema type is written at Defines/<Type>/<name>.json",
      define.path === definePath && define.kind === "define" && define.warnings.length === 0,
      JSON.stringify(define));
    const defineText = readText(definePath);
    check("the writer reports the byte length it wrote",
      define.bytes === Buffer.byteLength(defineText), define.bytes + " vs " + Buffer.byteLength(defineText));
    const attrType = fresh.types().find((t) => t.type === "Attr");
    check("the JSON carries exactly the schema's required keys",
      JSON.stringify(Object.keys(JSON.parse(defineText))) === JSON.stringify(attrType.required),
      defineText.trim());
    check("the identity field equals the file name (so M006 can hold)",
      JSON.parse(defineText).techName === "NewAttr", defineText.trim());
    check("it is pretty JSON with a trailing newline",
      defineText.startsWith('{\n  "techName": "NewAttr"') && defineText.endsWith("\n"), JSON.stringify(defineText));
    const defineCheck = fresh.validateDefineText({ type: "Attr", text: defineText, relPath: definePath });
    check("validateDefineText reports zero errors for it",
      defineCheck.errors === 0, JSON.stringify(defineCheck.diagnostics));

    /* overwrite is opt-in -------------------------------------------- */

    const duplicate = (() => {
      try {
        fresh.newFile({ dir: pkg, type: "Attr", name: "NewAttr" });
        return null;
      } catch (err) {
        return err.message;
      }
    })();
    check("writing it again without overwrite refuses and says how",
      typeof duplicate === "string" && duplicate.includes("already exists") && duplicate.includes("overwrite: true"),
      String(duplicate));
    const rewritten = fresh.newFile({ dir: pkg, type: "Attr", name: "NewAttr", overwrite: true });
    check("overwrite: true rewrites the same path",
      rewritten.path === definePath && readText(definePath) === defineText, JSON.stringify(rewritten));

    /* yarn ----------------------------------------------------------- */

    const storyPath = "Yarn/NewStory.yarn";
    const story = fresh.newFile({ dir: pkg, type: "yarn", name: "NewStory" });
    const storyText = readText(storyPath);
    check("yarn is written at Yarn/<name>.yarn with the repo's story header",
      story.path === storyPath && storyText.startsWith("title: NewStory\nwhen: always\n---\n")
        && storyText.includes("-> END\n===\n"),
      JSON.stringify(story));
    const storyDiag = fresh.diagnoseYarn({ text: storyText, fileName: storyPath, root: pkg });
    check("the generated story parses with zero diagnostics",
      storyDiag.available === true && storyDiag.diagnostics.length === 0,
      JSON.stringify(storyDiag.diagnostics));
    check("its #line: id is derived from the name, not from the clock",
      newfileCore.yarnStoryFor("NewStory") === storyText && newfileCore.lineIdFor("NewStory").length === 8,
      newfileCore.lineIdFor("NewStory"));

    /* translation ---------------------------------------------------- */

    const csvPath = "Yarn/NewStory.csv";
    const csv = fresh.newFile({ dir: pkg, type: "translation", name: "NewStory" });
    const csvBytes = readBytes(csvPath);
    check("translation is written at Yarn/<name>.csv",
      csv.path === csvPath && csv.kind === "translation", JSON.stringify(csv));
    check("the CSV is BOM + CRLF + the real 8-column header, with no rows",
      csvBytes[0] === 0xef && csvBytes[1] === 0xbb && csvBytes[2] === 0xbf
        && csvBytes.slice(3).toString("utf8")
          === "language,id,text,file,node,lineNumber,lock,comment\r\n",
      JSON.stringify(csvBytes.slice(0, 3).toString("hex") + " " + csvBytes.slice(3).toString("utf8")));
    check("the header still lists lineNumber/lock/comment (the docs' 4 columns are stale)",
      newfileCore.TRANSLATION_HEADER.split(",").length === 8, newfileCore.TRANSLATION_HEADER);

    /* sprite --------------------------------------------------------- */

    const spritePath = "Sprites/NewIcon.png";
    const sprite = fresh.newFile({ dir: pkg, type: "sprite", name: "NewIcon" });
    const png = readBytes(spritePath);
    const pngSignature = png.slice(0, 8).toString("hex");
    check("sprite is written at Sprites/<name>.png",
      sprite.path === spritePath && sprite.kind === "sprite", JSON.stringify(sprite));
    check("the bytes are a PNG with a plausible IHDR",
      pngSignature === "89504e470d0a1a0a"
        && png.slice(12, 16).toString("ascii") === "IHDR"
        && png.readUInt32BE(16) === 96 && png.readUInt32BE(20) === 96,
      pngSignature + " " + png.slice(12, 16).toString("ascii") + " " + png.readUInt32BE(16) + "x" + png.readUInt32BE(20));

    /* refusals ------------------------------------------------------- */

    const refusal = (params) => {
      try {
        fresh.newFile(params);
        return null;
      } catch (err) {
        return err.message;
      }
    };
    const spine = refusal({ dir: pkg, type: "spine", name: "Rig" });
    check("spine refuses and names Spine, so the UI can say why before writing",
      typeof spine === "string" && spine.includes("Spine"), String(spine));
    const audio = refusal({ dir: pkg, type: "audio", name: "Sfx" });
    check("audio refuses and names the tool that could make one",
      typeof audio === "string" && /recording|synthesiser/.test(audio), String(audio));
    const unknown = refusal({ dir: pkg, type: "Bogus", name: "X" });
    check("an unknown type refuses by name",
      typeof unknown === "string" && unknown.includes('unknown type "Bogus"'), String(unknown));
    const escaping = refusal({ dir: pkg, type: "yarn", name: "../Escape" });
    check("a name that would escape the package is refused before any write",
      typeof escaping === "string" && /path separator/.test(escaping) && !existsSync(join(sandbox, "Escape.yarn")),
      String(escaping));
    check("every refusal message starts with the verb prefix",
      [spine, audio, unknown, escaping].every((m) => typeof m === "string" && m.startsWith("new file: ")),
      JSON.stringify([spine, audio, unknown, escaping]));
    const missing = ["dir", "type", "name"].map((key) => {
      const params = { dir: pkg, type: "yarn", name: "Probe" };
      delete params[key];
      return refusal(params);
    });
    check("dir, type and name are all required",
      missing.every((m) => typeof m === "string" && m.includes("is required")), JSON.stringify(missing));
    const badName = refusal({ dir: pkg, type: "Attr", name: "Not-An-Identifier" });
    check("a schema type's name must be an identifier (it is also the techName)",
      typeof badName === "string" && badName.includes("not a valid techName"), String(badName));

    /* dir resolution ------------------------------------------------- */

    const fromSubdir = fresh.newFile({ dir: join(pkg, "Yarn"), type: "Attr", name: "FromSubdir" });
    check("dir may be a subdirectory of the package and still lands at the package root",
      fromSubdir.path === "Defines/Attr/FromSubdir.json", JSON.stringify(fromSubdir));
    mkdirSync(join(sandbox, "not-a-mod"), { recursive: true });
    const outside = refusal({ dir: join(sandbox, "not-a-mod"), type: "yarn", name: "X" });
    check("a directory outside any package refuses with the package sentence",
      typeof outside === "string" && outside.includes("is not inside a mod package"), String(outside));
    const relative = fresh.newFile({ dir: "Files/Files", type: "translation", name: "Relative" });
    check("dir may be relative to the mods root",
      relative.path === "Yarn/Relative.csv", JSON.stringify(relative));

    const caseInsensitive = fresh.newFile({ dir: pkg, type: "attr", name: "CaseProbe" });
    check("a lowercase type resolves to the schema's real spelling",
      caseInsensitive.path === "Defines/Attr/CaseProbe.json", JSON.stringify(caseInsensitive));

    /* the cache a following mod.open reads --------------------------- */

    const before = fresh.openMod({ dir: pkg });
    const openedPath = "Defines/Attr/OpenedAfter.json";
    fresh.newFile({ dir: pkg, type: "Attr", name: "OpenedAfter" });
    const after = fresh.openMod({ dir: pkg });
    check("mod.open sees a file written moments earlier (the scan cache was invalidated)",
      !before.defines.some((d) => d.file === openedPath) && after.defines.some((d) => d.file === openedPath),
      JSON.stringify(after.defines.map((d) => d.file).slice(-3)));

    /* every schema type, not just Attr -------------------------------- */

    const typedMods = createMods({ modsRoot: sandbox });
    const typedCreated = await typedMods.scaffold({ dir: join(sandbox, "Typed"), modName: "Typed", template: "minimal" });
    const typedPkg = typedCreated.modRoot;
    const schemaTypes = typedMods.types();
    const broken = [];
    for (const t of schemaTypes) {
      try {
        const written = typedMods.newFile({ dir: typedPkg, type: t.type, name: "Probe_" + t.type });
        const verdict = typedMods.validateDefineText({
          type: t.type,
          text: readFileSync(written.file, "utf8"),
          relPath: written.path,
        });
        if (verdict.errors !== 0) broken.push(t.type + ": " + JSON.stringify(verdict.diagnostics));
      } catch (err) {
        broken.push(t.type + ": " + err.message);
      }
    }
    check("every one of the 51 schema types generates a define that validates clean",
      schemaTypes.length === 51 && broken.length === 0, JSON.stringify(broken.slice(0, 3)));

    /* determinism ---------------------------------------------------- */

    const planA = newfileCore.planNewFile({ type: "yarn", name: "Same" });
    const planB = newfileCore.planNewFile({ type: "yarn", name: "Same" });
    check("planning the same file twice gives the same bytes (no clock, no random)",
      JSON.stringify(planA) === JSON.stringify(planB), JSON.stringify(planA));
    check("the planner writes nothing by itself",
      !existsSync(join(pkg, "Yarn", "Same.yarn")), "Yarn/Same.yarn");
  } finally {
    rmSync(sandbox, { recursive: true, force: true });
  }
}

/* ------------------------------------------------------------------ */

/*
 * 导入和新建是两条腿：新建从 schema 生成，导入把一个磁盘上已有的文件搬进包。
 * 这一节只锁「搬」的契约：目标目录规则、`to`/`name` 语义、逐字节保真、
 * 校验失败要删掉刚拷贝的文件、overwrite、路径逃逸拒绝。
 *
 * 字节保真为什么值得单测：导入最常见的用途就是把别处已经能用的文件原样放进
 * 包，任何 BOM/换行/重编码的"顺手整理"都会让内容悄悄变样 —— 而 §18.2 的
 * 原则是「编辑既有文件＝字节保真」，导入是它的第一现场。
 */
section("import a file into a mod package: mod.importFile");
{
  const sandbox = mkdtempSync(join(tmpdir(), "infantgod-importfile-"));
  // 绝对路径的来源要放在 modsRoot 之外，才能证明 from 可以来自包外。
  const elsewhere = mkdtempSync(join(tmpdir(), "infantgod-import-src-"));
  try {
    const fresh = createMods({ modsRoot: sandbox });
    const created = await fresh.scaffold({ dir: join(sandbox, "Importer"), modName: "Importer", template: "full" });
    const pkg = created.modRoot;
    const importfileCore = require(join(HERE, "importfile.js"));
    const newfileCore = require(join(HERE, "newfile.js"));
    const readBytes = (rel) => readFileSync(join(pkg, rel));
    const refused = (params) => {
      try {
        fresh.importFile(params);
        return null;
      } catch (err) {
        return err.message;
      }
    };

    const sources = join(sandbox, "sources"); // 包外、modsRoot 内：可走相对路径
    mkdirSync(sources, { recursive: true });

    /* PNG：字节保真 + 目标目录 --------------------------------------- */

    const png = newfileCore.makeSpritePng();
    const pngSource = join(elsewhere, "hero.png");
    writeFileSync(pngSource, png);
    const importedPng = fresh.importFile({ dir: pkg, from: pngSource, name: "hero" });
    check("a PNG from outside the mods root lands at Sprites/<name>.png",
      importedPng.path === "Sprites/hero.png" && importedPng.kind === "sprite",
      JSON.stringify(importedPng));
    check("the imported PNG is byte-identical to the source (no re-encoding)",
      Buffer.compare(readBytes("Sprites/hero.png"), png) === 0, importedPng.bytes + " bytes");
    check("the writer reports the source size",
      importedPng.bytes === png.length, importedPng.bytes + " vs " + png.length);

    /* to 精确落位 ---------------------------------------------------- */

    const exact = fresh.importFile({ dir: pkg, from: pngSource, to: "Sprites/hero_to.png" });
    check("to: \"Sprites/hero_to.png\" lands exactly there",
      exact.path === "Sprites/hero_to.png" && Buffer.compare(readBytes("Sprites/hero_to.png"), png) === 0,
      JSON.stringify(exact));

    /* overwrite 是 opt-in -------------------------------------------- */

    const duplicate = refused({ dir: pkg, from: pngSource, name: "hero" });
    check("importing onto an existing file without overwrite refuses and says how",
      typeof duplicate === "string" && duplicate.includes("already exists") && duplicate.includes("overwrite: true"),
      String(duplicate));
    // 改一个 IDAT 内的字节：仍是合法 PNG（签名/IHDR 都在），但内容确实不同，
    // 这样「覆盖」的成功才可证，而不是又一次写了同样的字节。
    const changed = Buffer.from(png);
    changed[changed.length - 5] = changed[changed.length - 5] ^ 0xff;
    writeFileSync(pngSource, changed);
    const replaced = fresh.importFile({ dir: pkg, from: pngSource, name: "hero", overwrite: true });
    check("overwrite: true replaces the file with the new bytes",
      Buffer.compare(readBytes("Sprites/hero.png"), changed) === 0
        && Buffer.compare(readBytes("Sprites/hero.png"), png) !== 0, JSON.stringify(replaced));
    check("the overwrite is reported as a warning, not silently",
      replaced.warnings.some((w) => w.includes("already existed")), JSON.stringify(replaced.warnings));

    /* yarn：解析得动，字节不变 --------------------------------------- */

    const yarnText = "title: ImportedTalk\nwhen: always\n---\nNarrator: Hello there.\n-> END\n===\n";
    const yarnSource = join(sources, "talk.yarn");
    writeFileSync(yarnSource, yarnText, "utf8");
    const importedYarn = fresh.importFile({ dir: pkg, from: "sources/talk.yarn", name: "ImportedTalk" });
    check("a .yarn imported by a modsRoot-relative path lands at Yarn/<name>.yarn",
      importedYarn.path === "Yarn/ImportedTalk.yarn" && importedYarn.kind === "yarn",
      JSON.stringify(importedYarn));
    check("the imported story is byte-identical",
      readBytes("Yarn/ImportedTalk.yarn").toString("utf8") === yarnText, importedYarn.bytes + " bytes");
    check("the report carries the Yarn diagnostics of the imported story",
      Array.isArray(importedYarn.diagnostics)
        && importedYarn.diagnostics.filter((d) => d.severity === "error").length === 0,
      JSON.stringify(importedYarn.diagnostics));

    /* csv：BOM + CRLF 原样落地 --------------------------------------- */

    const csvText = "\ufefflanguage,id,text,file,node,lineNumber,lock,comment\r\nzh-CN,talk.0001,你好,Yarn/talk.yarn,ImportedTalk,5,0,\r\n";
    const csvSource = join(sources, "talk.csv");
    writeFileSync(csvSource, csvText, "utf8");
    const importedCsv = fresh.importFile({ dir: pkg, from: csvSource, name: "Imported" });
    check("a .csv lands at Yarn/<name>.csv",
      importedCsv.path === "Yarn/Imported.csv" && importedCsv.kind === "translation",
      JSON.stringify(importedCsv));
    check("the imported CSV keeps its BOM and CRLF exactly",
      readBytes("Yarn/Imported.csv").equals(Buffer.from(csvText, "utf8")),
      JSON.stringify(readBytes("Yarn/Imported.csv").slice(0, 3).toString("hex")));

    /* 定义：目录就是类型，不猜 --------------------------------------- */

    const other = join(sandbox, "OtherMod");
    mkdirSync(join(other, "Defines", "Goods"), { recursive: true });
    writeFileSync(join(other, "mod.json"), JSON.stringify({ name: "OtherMod" }));
    const goodsSource = join(other, "Defines", "Goods", "Goods_Imported.json");
    writeFileSync(goodsSource, JSON.stringify({ techName: "Goods_Imported" }, null, 2) + "\n");
    const importedDefine = fresh.importFile({ dir: pkg, from: goodsSource });
    check("a define JSON keeps its Defines/<Type>/ directory when imported",
      importedDefine.path === "Defines/Goods/Goods_Imported.json" && importedDefine.kind === "define",
      JSON.stringify(importedDefine));
    check("the imported define validates clean",
      fresh.validateDefineText({
        type: "Goods",
        text: readFileSync(join(pkg, importedDefine.path), "utf8"),
        relPath: importedDefine.path,
      }).errors === 0, JSON.stringify(importedDefine.diagnostics));

    const randomJson = join(elsewhere, "loose.json");
    writeFileSync(randomJson, JSON.stringify({ techName: "Loose" }));
    const noType = refused({ dir: pkg, from: randomJson });
    check("a .json with no Defines/<Type>/ segment refuses and asks for to",
      typeof noType === "string" && noType.includes("to:") && noType.includes("Defines/<Type>"),
      String(noType));
    const withTo = fresh.importFile({ dir: pkg, from: randomJson, to: "Defines/Goods/Goods_Loose.json" });
    check("the same .json imports when to names the type directory",
      withTo.path === "Defines/Goods/Goods_Loose.json", JSON.stringify(withTo));
    const looseTo = fresh.importFile({ dir: pkg, from: randomJson, to: "Misc/extra.json" });
    check("a .json imported outside Defines/ gets a syntax-only warning",
      looseTo.path === "Misc/extra.json"
        && looseTo.warnings.some((w) => w.includes("only its JSON syntax was checked")),
      JSON.stringify(looseTo.warnings));

    /* 校验失败要清场 ------------------------------------------------- */

    const brokenSource = join(other, "Defines", "Goods", "Goods_Broken.json");
    writeFileSync(brokenSource, JSON.stringify({ name: "no techName" }, null, 2) + "\n");
    const broken = refused({ dir: pkg, from: brokenSource });
    check("a define that fails validation refuses with the first error",
      typeof broken === "string" && broken.includes("does not validate"), String(broken));
    check("the failed define left NO file behind",
      !existsSync(join(pkg, "Defines", "Goods", "Goods_Broken.json")), "Defines/Goods/Goods_Broken.json");

    const fakePngSource = join(sources, "fake.png");
    writeFileSync(fakePngSource, "not a png at all");
    const fakePng = refused({ dir: pkg, from: fakePngSource, name: "fake" });
    check("a .png whose bytes are not a PNG refuses",
      typeof fakePng === "string" && fakePng.includes("not a PNG"), String(fakePng));
    check("the rejected PNG left NO file behind",
      !existsSync(join(pkg, "Sprites", "fake.png")), "Sprites/fake.png");
    const fakePngTo = refused({ dir: pkg, from: fakePngSource, to: "Sprites/fake_to.png" });
    check("the PNG check follows the target, not the source extension",
      typeof fakePngTo === "string" && fakePngTo.includes("not a PNG")
        && !existsSync(join(pkg, "Sprites", "fake_to.png")), String(fakePngTo));

    /* 路径逃逸与未知扩展名 ------------------------------------------- */

    const escaping = refused({ dir: pkg, from: pngSource, to: "../escape.png" });
    check("to: \"../escape.png\" is refused before any write",
      typeof escaping === "string" && escaping.includes("inside the mod package")
        && !existsSync(join(pkg, "..", "escape.png")), String(escaping));
    const drivePath = refused({ dir: pkg, from: pngSource, to: "C:/tmp/x.png" });
    check("an absolute/drive to is refused",
      typeof drivePath === "string" && drivePath.includes("drive path"), String(drivePath));
    const posixAbsolute = refused({ dir: pkg, from: pngSource, to: "/Sprites/x.png" });
    check("a POSIX-absolute to is refused",
      typeof posixAbsolute === "string" && posixAbsolute.includes("not absolute"), String(posixAbsolute));
    const directoryTo = refused({ dir: pkg, from: pngSource, to: "Sprites/" });
    check("a directory in to is refused",
      typeof directoryTo === "string" && directoryTo.includes("not a directory"), String(directoryTo));

    const unknownSource = join(sources, "notes.txt");
    writeFileSync(unknownSource, "hello");
    const unknown = refused({ dir: pkg, from: unknownSource });
    check("an unknown extension refuses and lists what this side knows",
      typeof unknown === "string" && unknown.includes('unknown extension ".txt"')
        && unknown.includes(".yarn") && unknown.includes(".skel.bytes"), String(unknown));

    const badName = refused({ dir: pkg, from: pngSource, name: "not-an-identifier" });
    check("a name must be an identifier",
      typeof badName === "string" && badName.includes("not valid"), String(badName));
    const nameWithExt = refused({ dir: pkg, from: pngSource, name: "hero.png" });
    check("a name may not carry an extension",
      typeof nameWithExt === "string" && nameWithExt.includes("not valid"), String(nameWithExt));

    /* 源文件的基本检查 ----------------------------------------------- */

    const missingSource = refused({ dir: pkg, from: join(sources, "nope.png") });
    check("a source that does not exist refuses",
      typeof missingSource === "string" && missingSource.includes("does not exist"), String(missingSource));
    const dirSource = refused({ dir: pkg, from: sources });
    check("a directory as source refuses",
      typeof dirSource === "string" && dirSource.includes("not a regular file"), String(dirSource));
    const bigSource = join(elsewhere, "big.wav");
    writeFileSync(bigSource, Buffer.alloc(importfileCore.MAX_IMPORT_BYTES + 1));
    const tooBig = refused({ dir: pkg, from: bigSource });
    check("a source over the 64 MiB limit refuses and names its size",
      typeof tooBig === "string" && tooBig.includes("64 MiB") && tooBig.includes("MiB"),
      String(tooBig));
    rmSync(bigSource, { force: true });

    /* audio / spine：目录按规则，内容不深查 --------------------------- */

    const wavSource = join(sources, "sound.wav");
    writeFileSync(wavSource, Buffer.from("RIFF0000WAVEfmt ", "ascii"));
    const importedWav = fresh.importFile({ dir: pkg, from: wavSource, name: "Sound" });
    check("a .wav lands at Audio/<name>.wav byte-identically",
      importedWav.path === "Audio/Sound.wav"
        && readBytes("Audio/Sound.wav").toString("ascii") === "RIFF0000WAVEfmt ",
      JSON.stringify(importedWav));
    const emptyWavSource = join(sources, "empty.wav");
    writeFileSync(emptyWavSource, Buffer.alloc(0));
    const emptyWav = fresh.importFile({ dir: pkg, from: emptyWavSource, name: "Empty" });
    check("an empty audio file imports with a warning instead of a silent pass",
      emptyWav.path === "Audio/Empty.wav" && emptyWav.warnings.some((w) => w.includes("empty")),
      JSON.stringify(emptyWav.warnings));

    const skelSource = join(sources, "Hero.skel.bytes");
    writeFileSync(skelSource, Buffer.from([1, 2, 3, 4]));
    const importedSkel = fresh.importFile({ dir: pkg, from: skelSource });
    check("a .skel.bytes keeps its full basename under Spine/",
      importedSkel.path === "Spine/Hero.skel.bytes" && importedSkel.kind === "spine",
      JSON.stringify(importedSkel));
    const atlasSource = join(sources, "Hero.atlas.txt");
    writeFileSync(atlasSource, "Hero\nsize: 1,1\n");
    const importedAtlas = fresh.importFile({ dir: pkg, from: atlasSource });
    check("a .atlas.txt keeps its full basename under Spine/",
      importedAtlas.path === "Spine/Hero.atlas.txt", JSON.stringify(importedAtlas));

    /* dir 解析 ------------------------------------------------------- */

    const fromSubdir = fresh.importFile({ dir: join(pkg, "Yarn"), from: csvSource, name: "FromSubdir" });
    check("dir may be a subdirectory of the package and still lands at the package root",
      fromSubdir.path === "Yarn/FromSubdir.csv", JSON.stringify(fromSubdir));
    mkdirSync(join(sandbox, "not-a-mod"), { recursive: true });
    const outside = refused({ dir: join(sandbox, "not-a-mod"), from: pngSource, name: "X" });
    check("a directory outside any package refuses with the package sentence",
      typeof outside === "string" && outside.includes("is not inside a mod package"), String(outside));
    const relativeDir = fresh.importFile({ dir: "Importer/Importer", from: pngSource, name: "RelativeDir" });
    check("dir may be relative to the mods root",
      relativeDir.path === "Sprites/RelativeDir.png", JSON.stringify(relativeDir));

    check("every refusal message starts with the verb prefix",
      [duplicate, noType, broken, fakePng, escaping, drivePath, unknown, badName, missingSource, tooBig, outside]
        .every((m) => typeof m === "string" && m.startsWith("import file: ")),
      JSON.stringify([noType, broken, outside]));

    /* 缓存失效：紧随其后的 mod.open 要看得见 ------------------------- */

    const opened = fresh.openMod({ dir: pkg });
    check("mod.open sees the imported sprite and story (the scan cache was invalidated)",
      opened.sprites.includes("Sprites/hero.png")
        && opened.yarnFiles.includes("Yarn/ImportedTalk.yarn"),
      JSON.stringify({ sprites: opened.sprites.slice(-2), yarn: opened.yarnFiles.slice(-2) }));
    check("mod.open sees the imported define",
      opened.defines.some((d) => d.file === "Defines/Goods/Goods_Imported.json"),
      JSON.stringify(opened.defines.map((d) => d.file).slice(-2)));

    /* planner 是纯的 ------------------------------------------------- */

    const planA = importfileCore.planImport({ modRoot: pkg, from: yarnSource, name: "Same" });
    const planB = importfileCore.planImport({ modRoot: pkg, from: yarnSource, name: "Same" });
    check("planning the same import twice gives the same result",
      JSON.stringify(planA) === JSON.stringify(planB),
      JSON.stringify({ path: planA.relPath, kind: planA.kind }));
    check("the planner writes nothing by itself",
      !existsSync(join(pkg, "Yarn", "Same.yarn")), "Yarn/Same.yarn");
  } finally {
    rmSync(sandbox, { recursive: true, force: true });
    rmSync(elsewhere, { recursive: true, force: true });
  }
}

/* ------------------------------------------------------------------ */
/* the demo packages beside the editor: mod.examples / mod.example     */
/* ------------------------------------------------------------------ */

/*
 * G35.  The demo ships beside the editor and `mod.open` refuses everything
 * outside `modsRoot`, so the only reachable demo is a copied one.  These checks
 * pin both halves: what ships is found by name, and the copy is byte-identical,
 * openable, idempotent and never overwrites a directory someone made.
 */

section("the demo packages the install ships");

{
  const examplesCore = require(join(HERE, "examples.js"));
  const listing = examplesCore.listExamples();
  check("examples/Mods is found beside the shell",
    listing.present && listing.source === "bundled" && listing.root.endsWith(join("examples", "Mods")),
    JSON.stringify({ root: listing.root, source: listing.source, present: listing.present }));
  check("the two demo packages are listed, with Lantern as the default",
    listing.packages.map((one) => one.dir).join(",") === "Lantern,Lantern_Tests" && listing.default === "Lantern",
    JSON.stringify(listing.packages.map((one) => one.dir)));

  const countFiles = (dir) => {
    let total = 0;
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (entry.isDirectory()) total += countFiles(join(dir, entry.name));
      else if (entry.isFile()) total += 1;
    }
    return total;
  };
  const shippedRoot = join(listing.root, "Lantern");
  const shippedFiles = countFiles(shippedRoot);

  const sandbox = mkdtempSync(join(tmpdir(), "infantgod-example-"));
  const occupied = mkdtempSync(join(tmpdir(), "infantgod-example-occupied-"));
  const nothing = mkdtempSync(join(tmpdir(), "infantgod-example-nothing-"));
  try {
    const fresh = createMods({ modsRoot: sandbox });
    check("the facade answers what ships, with the same listing",
      fresh.examples().packages.length === listing.packages.length, JSON.stringify(fresh.examples().packages.map((one) => one.dir)));

    const copied = fresh.example({});
    check("`mod.example` copies the demo into the mods folder",
      copied.installed === true && copied.dir === "Lantern" &&
      copied.modRoot === join(sandbox, "Lantern") && copied.files === shippedFiles,
      JSON.stringify({ dir: copied.dir, files: copied.files, shippedFiles }));
    check("the copied package is byte-identical to the one that ships",
      Buffer.compare(readFileSync(join(copied.modRoot, "mod.json")), readFileSync(join(shippedRoot, "mod.json"))) === 0,
      copied.file);
    check("the copy is openable, which the bundled original never was",
      fresh.openMod({ dir: "Lantern" }).manifest.name === "Lantern",
      JSON.stringify(fresh.openMod({ dir: "Lantern" }).manifest));
    const again = fresh.example({ name: "Lantern" });
    check("asking twice reports `already installed` and copies nothing",
      again.installed === false && again.files === 0, JSON.stringify(again));

    const refused = (params) => {
      try {
        fresh.example(params);
        return "";
      } catch (err) {
        return err.message;
      }
    };
    check("an unknown demo name is refused by name, with the list",
      refused({ name: "Nope" }).startsWith("example: no demo package named") &&
      refused({ name: "Nope" }).includes("Lantern"),
      refused({ name: "Nope" }));

    mkdirSync(join(occupied, "Lantern_Tests"), { recursive: true });
    writeFileSync(join(occupied, "Lantern_Tests", "notes.txt"), "mine\n");
    const busy = createMods({ modsRoot: occupied });
    let clash = "";
    try {
      busy.example({ name: "Lantern_Tests" });
    } catch (err) {
      clash = err.message;
    }
    check("the refusal names the directory and says why",
      clash.includes("already holds files") && clash.startsWith("example: "), clash);
    check("the refused directory keeps its file",
      readFileSync(join(occupied, "Lantern_Tests", "notes.txt"), "utf8") === "mine\n");

    check("with no mods folder the copy is refused, not sent somewhere",
      (() => {
        try {
          createMods({}).example({});
          return "";
        } catch (err) {
          return err.message;
        }
      })().startsWith("example: there is no mods folder"),
      "createMods({}) has no modsRoot");

    const empty = examplesCore.listExamples({ examplesDir: nothing });
    check("a build with no demo packages reports the state, not an error",
      empty.present === false && empty.default === null, JSON.stringify(empty));
    check("installing from a build with no demo packages says so",
      (() => {
        try {
          examplesCore.installExample({ examplesRoot: nothing, modsRoot: sandbox });
          return "";
        } catch (err) {
          return err.message;
        }
      })().includes("no demo package is installed beside the editor"),
      nothing);
  } finally {
    rmSync(sandbox, { recursive: true, force: true });
    rmSync(occupied, { recursive: true, force: true });
    rmSync(nothing, { recursive: true, force: true });
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
