import { createMods, MODS_DIR, checks, check, section, skip, mods, types, characters } from "./foundation.mjs";
import { HAVE_CORPUS, specMods, specTemps, specTemp, specWrite } from "./corpus.mjs";
import { spawn, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { createRequire } from "node:module";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import * as validateCore from "../validate.js";

const require = createRequire(import.meta.url);

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

  /*
   * G51：`mod.validate` 的诊断 path 是**相对包根**写的，而问题卡片手里只有
   * 用户输入的那一段（`Lantern`）。响应必须交回解析后的绝对包根，卡片才能
   * 拼出 `file.read` 认得的路径；否则它拼出的是相对 workspace 的
   * `Lantern/Defines/...`，文件明明在 `examples/Mods/Lantern` 里也读不到。
   *
   * `guardBase` 在系统临时目录里，而本进程的 cwd 是仓库根：相对名 `Rooted`
   * 只有按 modsRoot 解析才落在包上，所以「cwd 不同」这一半也被这条覆盖。
   */
  const rooted = join(guardBase, "Rooted");
  specWrite(join(rooted, "mod.json"), JSON.stringify({
    name: "Rooted", version: "1.0.0", gameVersion: "1.0", loadOrder: 61,
    author: "selftest", description: "selftest fixture: the resolved package root",
  }, null, 2) + "\n");
  specWrite(join(rooted, "Defines", "Attr", "ZzRootAttr.json"),
    JSON.stringify({ techName: "ZzRootAttr" }, null, 2) + "\n");

  const absoluteReport = guarded.validatePackage({ root: resolve(rooted) });
  check("validatePackage answers the absolute package root it resolved",
    absoluteReport.root === resolve(rooted) &&
      existsSync(join(absoluteReport.root, "mod.json")) &&
      existsSync(join(absoluteReport.root, "Defines", "Attr", "ZzRootAttr.json")),
    JSON.stringify(absoluteReport.root));

  const relativeReport = guarded.validatePackage({ root: "Rooted" });
  check("a relative root resolves against modsRoot, not the cwd",
    relativeReport.root === resolve(rooted) &&
      existsSync(join(relativeReport.root, "mod.json")),
    relativeReport.root + " (cwd is " + resolve(".") + ")");
}

/* G3：techName 撞名。游戏对重复的 (类型, TechName) 只保留先加载的那一份，
 * 后一份被静默丢弃；这里证明校验器把「静默」变成了可读的诊断。 */
section("techName collisions the game resolves silently (G3)");

{
  const kb = specMods.knowledge();

  function collidePackage(prefix) {
    const root = join(specTemp(prefix), "CollideMod");
    specWrite(join(root, "mod.json"), JSON.stringify({
      name: "CollideMod",
      version: "1.0.0",
      gameVersion: "1.0",
      loadOrder: 70,
      author: "selftest",
      description: "selftest fixture: techName collisions",
    }, null, 2) + "\n");
    return root;
  }

  // 同包内两个文件定义同一个 (类型, TechName)
  const twice = collidePackage("infantgod-collide-");
  specWrite(join(twice, "Defines", "Attr", "A.json"),
    JSON.stringify({ techName: "ZzTwiceAttr" }, null, 2) + "\n");
  specWrite(join(twice, "Defines", "Attr", "B.json"),
    JSON.stringify({ techName: "ZzTwiceAttr" }, null, 2) + "\n");
  const twiceOut = validateCore.validateModPackage(twice, {
    kb: kb,
    gameMods: { dir: null, readable: false },
  });
  const twiceD103 = twiceOut.diagnostics.filter((d) => d.code === "D103");
  check("the same techName defined twice in one package is D103",
    twiceD103.length === 1, JSON.stringify(twiceOut.diagnostics.map((d) => d.code)));
  check("D103 names the file that defined the name first",
    twiceD103.length === 1 && twiceD103[0].message.indexOf("A.json") >= 0,
    twiceD103.length === 1 ? twiceD103[0].message : "");

  // 兄弟 Mod 已经定义了同一个 (类型, TechName)
  const sibling = join(specTemp("infantgod-sibling-"), "SiblingMod");
  specWrite(join(sibling, "mod.json"), JSON.stringify({
    name: "SiblingMod",
    version: "1.0.0",
    gameVersion: "1.0",
    loadOrder: 80,
    author: "selftest",
    description: "selftest fixture: the sibling that got there first",
  }, null, 2) + "\n");
  specWrite(join(sibling, "Defines", "Attr", "A.json"),
    JSON.stringify({ techName: "ZzSiblingAttr" }, null, 2) + "\n");
  const mine = collidePackage("infantgod-mine-");
  specWrite(join(mine, "Defines", "Attr", "A.json"),
    JSON.stringify({ techName: "ZzSiblingAttr" }, null, 2) + "\n");
  const mineOut = validateCore.validateModPackage(mine, {
    kb: kb,
    otherMods: [{ dir: sibling, manifest: { name: "SiblingMod", loadOrder: 80 } }],
    gameMods: { dir: dirname(sibling), readable: true },
  });
  const mineD103 = mineOut.diagnostics.filter((d) => d.code === "D103");
  check("a techName a sibling mod already defines is D103",
    mineD103.length === 1 && mineD103[0].severity === "error", JSON.stringify(mineD103));
  check("D103 names the sibling mod that won",
    mineD103.length === 1 && mineD103[0].message.indexOf("SiblingMod") >= 0,
    mineD103.length === 1 ? mineD103[0].message : "");

  // 身份是 (类型, TechName)：不同目录里的同名不算撞名
  const typed = collidePackage("infantgod-typed-");
  specWrite(join(typed, "Defines", "Attr", "A.json"),
    JSON.stringify({ techName: "ZzTypedName" }, null, 2) + "\n");
  specWrite(join(typed, "Defines", "Topic", "A.json"),
    JSON.stringify({ techName: "ZzTypedName", attrType: "ZzOtherAttr" }, null, 2) + "\n");
  const typedOut = validateCore.validateModPackage(typed, {
    kb: kb,
    gameMods: { dir: null, readable: false },
  });
  check("the same name under a different type is not a collision",
    typedOut.diagnostics.every((d) => d.code !== "D103"),
    JSON.stringify(typedOut.diagnostics.filter((d) => d.code === "D103").map((d) => d.message)));

  // 基线定义：整份覆写提示从 info 提级为 warning
  const baselineType = Object.keys(kb.baseline || {})
    .find((t) => Array.isArray(kb.baseline[t]) && kb.baseline[t].length > 0);
  if (!baselineType) {
    skip("D102 is a warning (the knowledge base names no baseline definitions)");
  } else {
    const over = collidePackage("infantgod-baseline-");
    specWrite(join(over, "Defines", baselineType, "A.json"),
      JSON.stringify({ techName: kb.baseline[baselineType][0] }, null, 2) + "\n");
    const overOut = validateCore.validateModPackage(over, {
      kb: kb,
      gameMods: { dir: null, readable: false },
    });
    const d102 = overOut.diagnostics.filter((d) => d.code === "D102");
    check("a baseline techName is a warning, not an info",
      d102.length === 1 && d102[0].severity === "warning", JSON.stringify(d102));
  }

  // 读不到游戏 Mods 目录：跨 Mod 检查被跳过这件事本身要报出来
  const blind = collidePackage("infantgod-blind-");
  specWrite(join(blind, "Defines", "Attr", "A.json"),
    JSON.stringify({ techName: "ZzBlindAttr" }, null, 2) + "\n");
  const blindOut = validateCore.validateModPackage(blind, {
    kb: kb,
    otherMods: [],
    gameMods: { dir: "/nonexistent/game/Mods", readable: false },
  });
  check("an unreadable game Mods folder is an explicit M012 warning",
    blindOut.diagnostics.some((d) => d.code === "M012" && d.severity === "warning"),
    JSON.stringify(blindOut.diagnostics.filter((d) => d.code === "M012")));
}

section("audio references and the #vo tag (G21)");

{
  const kb = specMods.knowledge();

  function audioPackage(prefix) {
    const root = join(specTemp(prefix), "AudioMod");
    specWrite(join(root, "mod.json"), JSON.stringify({
      name: "AudioMod",
      version: "1.0.0",
      gameVersion: "1.0",
      author: "selftest",
      description: "selftest fixture: audio references",
    }, null, 2) + "\n");
    return root;
  }

  function codesOf(root) {
    return validateCore.validateModPackage(root, {
      kb: kb,
      gameMods: { dir: null, readable: false },
    }).diagnostics;
  }

  // Song：externalAudioFile 在 Mod 根目录下不存在 / 存在
  const songRoot = audioPackage("infantgod-audio-song-");
  specWrite(join(songRoot, "Defines", "Song", "Missing.json"),
    JSON.stringify({ techName: "ZzSongMissing", externalAudioFile: "Audio/missing.wav" }, null, 2) + "\n");
  specWrite(join(songRoot, "Defines", "Song", "Present.json"),
    JSON.stringify({ techName: "ZzSongPresent", externalAudioFile: "Audio/tone.wav" }, null, 2) + "\n");
  specWrite(join(songRoot, "Audio", "tone.wav"), "RIFF");
  const songOut = codesOf(songRoot);
  const songD006 = songOut.filter((d) => d.code === "D006");
  check("a Song whose externalAudioFile is missing is D006",
    songD006.length === 1 && songD006[0].message.indexOf("missing.wav") >= 0,
    JSON.stringify(songD006.map((d) => d.message)));
  check("a Song whose externalAudioFile exists is not D006",
    songD006.every((d) => d.message.indexOf("tone.wav") < 0),
    JSON.stringify(songD006.map((d) => d.message)));

  // VoiceOverDefinition：voiceOverFolder 是目录，voiceOverFiles 可在它下面解析
  const voRoot = audioPackage("infantgod-audio-vo-");
  specWrite(join(voRoot, "Defines", "VoiceOverDefinition", "V.json"),
    JSON.stringify({ techName: "ZzVo", voiceOverFolder: "Audio", voiceOverFiles: ["a.wav"] }, null, 2) + "\n");
  specWrite(join(voRoot, "Audio", "a.wav"), "RIFF");
  const voOut = codesOf(voRoot).filter((d) => d.code === "D006");
  check("a voice-over set whose folder and file both exist is not D006",
    voOut.length === 0, JSON.stringify(voOut.map((d) => d.message)));

  const badVoRoot = audioPackage("infantgod-audio-vobad-");
  specWrite(join(badVoRoot, "Defines", "VoiceOverDefinition", "V.json"),
    JSON.stringify({ techName: "ZzVo", voiceOverFolder: "Audio/Nowhere", voiceOverFiles: ["a.wav"] }, null, 2) + "\n");
  const badVoOut = codesOf(badVoRoot).filter((d) => d.code === "D006");
  check("a missing voiceOverFolder is D006", badVoOut.length === 2, JSON.stringify(badVoOut.map((d) => d.message)));
  check("and the missing voiceOverFolder is named",
    badVoOut.some((d) => d.message.indexOf("Audio/Nowhere") >= 0), JSON.stringify(badVoOut.map((d) => d.message)));

  // AudioEvent 的双命名：D001 要说清两条键都要写
  const eventRoot = audioPackage("infantgod-audio-event-");
  specWrite(join(eventRoot, "Defines", "AudioEvent", "E.json"),
    JSON.stringify({ techName: "ZzEvent" }, null, 2) + "\n");
  const eventD001 = codesOf(eventRoot).filter((d) => d.code === "D001");
  check("an AudioEvent with only techName gets a D001 that explains the double name",
    eventD001.length === 1 && eventD001[0].message.indexOf("双命名") >= 0 &&
      eventD001[0].message.indexOf("TechName") >= 0,
    JSON.stringify(eventD001.map((d) => d.message)));

  // Y122 / Y123：`#vo:` 指向不存在的语音集合 / 废弃指令
  const yarnRoot = audioPackage("infantgod-audio-yarn-");
  specWrite(join(yarnRoot, "Defines", "VoiceOverDefinition", "V.json"),
    JSON.stringify({ techName: "ZzVo", voiceOverFolder: "Audio", voiceOverFiles: [] }, null, 2) + "\n");
  function yarnCodes(name, body) {
    const rel = "Yarn/" + name + ".yarn";
    specWrite(join(yarnRoot, rel), "title: Zz" + name + "\n---\n" + body + "\n===\n");
    specMods.openMod({ dir: yarnRoot });
    return specMods.diagnoseYarn({
      text: readFileSync(join(yarnRoot, rel), "utf8"),
      fileName: rel,
      root: yarnRoot,
    }).diagnostics;
  }
  const badVoCodes = yarnCodes("badvo", "台词。 #vo:ZzNope #line:9");
  check("an unknown #vo value is Y122", badVoCodes.some((d) => d.code === "Y122"),
    JSON.stringify(badVoCodes.map((d) => d.code)));
  const localVoCodes = yarnCodes("localvo", "台词。 #vo:ZzVo #line:9");
  check("a voice-over set defined by this package satisfies #vo",
    !localVoCodes.some((d) => d.code === "Y122"), JSON.stringify(localVoCodes.map((d) => d.code)));
  const baselineVoCodes = yarnCodes("basevo", "台词。 #vo:Lick #line:9");
  check("a baseline voice-over set satisfies #vo",
    !baselineVoCodes.some((d) => d.code === "Y122"), JSON.stringify(baselineVoCodes.map((d) => d.code)));
  const deprecatedCodes = yarnCodes("deprecated", '<<PlayDialogueWithVoice "Lick">>');
  check("PlayDialogueWithVoice is an info-level Y123",
    deprecatedCodes.some((d) => d.code === "Y123" && d.severity === "info"),
    JSON.stringify(deprecatedCodes.map((d) => d.code + ":" + d.severity)));
}

section("asset formats the game would silently mishandle (G46)");

{
  const kb = specMods.knowledge();

  function assetPackage(prefix) {
    const root = join(specTemp(prefix), "AssetMod");
    specWrite(join(root, "mod.json"), JSON.stringify({
      name: "AssetMod",
      version: "1.0.0",
      gameVersion: "1.0",
      author: "selftest",
      description: "selftest fixture: asset formats",
    }, null, 2) + "\n");
    return root;
  }

  function diagsOf(root) {
    return validateCore.validateModPackage(root, {
      kb: kb,
      gameMods: { dir: null, readable: false },
    }).diagnostics;
  }

  /* PNG：8-bit RGBA 静默；RGB 给 info；16-bit/隔行给警告；非 PNG 给 error。 */
  function pngBytes(bitDepth, colorType, interlace) {
    const b = Buffer.alloc(33);
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(b, 0);
    b.writeUInt32BE(13, 8);
    b.write("IHDR", 12, "ascii");
    b.writeUInt32BE(1, 16);
    b.writeUInt32BE(1, 20);
    b[24] = bitDepth;
    b[25] = colorType;
    b[26] = 0;
    b[27] = 0;
    b[28] = interlace;
    return b;
  }
  const pngRoot = assetPackage("infantgod-png-");
  specWrite(join(pngRoot, "Defines", "Attr", "ZzRgba.json"),
    JSON.stringify({ techName: "ZzRgba", icon: "Art/rgba.png" }, null, 2) + "\n");
  specWrite(join(pngRoot, "Defines", "Attr", "ZzRgb.json"),
    JSON.stringify({ techName: "ZzRgb", icon: "Art/rgb.png" }, null, 2) + "\n");
  specWrite(join(pngRoot, "Defines", "Attr", "ZzDeep.json"),
    JSON.stringify({ techName: "ZzDeep", icon: "Art/deep.png" }, null, 2) + "\n");
  specWrite(join(pngRoot, "Defines", "Attr", "ZzFake.json"),
    JSON.stringify({ techName: "ZzFake", icon: "Art/fake.png" }, null, 2) + "\n");
  mkdirSync(join(pngRoot, "Art"), { recursive: true });
  writeFileSync(join(pngRoot, "Art", "rgba.png"), pngBytes(8, 6, 0));
  writeFileSync(join(pngRoot, "Art", "rgb.png"), pngBytes(8, 2, 0));
  writeFileSync(join(pngRoot, "Art", "deep.png"), pngBytes(16, 6, 0));
  writeFileSync(join(pngRoot, "Art", "fake.png"), Buffer.from("not a png at all"));
  const pngDiags = diagsOf(pngRoot).filter((d) => d.code === "D007");
  check("an 8-bit RGBA PNG passes without a D007",
    !pngDiags.some((d) => d.message.indexOf("rgba.png") >= 0),
    JSON.stringify(pngDiags.map((d) => d.message)));
  check("an 8-bit RGB PNG is an info that saving will rewrite it as RGBA",
    pngDiags.some((d) => d.severity === "info" && d.message.indexOf("RGB") >= 0 &&
      d.message.indexOf("RGBA") >= 0), JSON.stringify(pngDiags.map((d) => d.severity + ":" + d.message)));
  check("a 16-bit PNG is a warning the pixel card cannot open it",
    pngDiags.some((d) => d.severity === "warning" && d.message.indexOf("16") >= 0),
    JSON.stringify(pngDiags.map((d) => d.severity + ":" + d.message)));
  check("a .png that is not a PNG is an error about the signature",
    pngDiags.some((d) => d.severity === "error" && d.message.indexOf("签名") >= 0),
    JSON.stringify(pngDiags.map((d) => d.severity + ":" + d.message)));

  /* WAV：PCM 44.1k 静默；非 PCM 警告；不是 RIFF/WAVE error；44.1k 以外的采样率 info。 */
  function wavBytes(format, channels, rate) {
    const b = Buffer.alloc(44);
    b.write("RIFF", 0, "ascii");
    b.writeUInt32LE(36, 4);
    b.write("WAVE", 8, "ascii");
    b.write("fmt ", 12, "ascii");
    b.writeUInt32LE(16, 16);
    b.writeUInt16LE(format, 20);
    b.writeUInt16LE(channels, 22);
    b.writeUInt32LE(rate, 24);
    b.writeUInt32LE(rate * channels * 2, 28);
    b.writeUInt16LE(channels * 2, 32);
    b.writeUInt16LE(16, 34);
    b.write("data", 36, "ascii");
    b.writeUInt32LE(0, 40);
    return b;
  }
  const wavRoot = assetPackage("infantgod-wav-");
  specWrite(join(wavRoot, "Defines", "Song", "ZzPcm.json"),
    JSON.stringify({ techName: "ZzPcm", externalAudioFile: "Audio/pcm.wav" }, null, 2) + "\n");
  specWrite(join(wavRoot, "Defines", "Song", "ZzFloat.json"),
    JSON.stringify({ techName: "ZzFloat", externalAudioFile: "Audio/float.wav" }, null, 2) + "\n");
  specWrite(join(wavRoot, "Defines", "Song", "ZzSlow.json"),
    JSON.stringify({ techName: "ZzSlow", externalAudioFile: "Audio/slow.wav" }, null, 2) + "\n");
  specWrite(join(wavRoot, "Defines", "Song", "ZzBroken.json"),
    JSON.stringify({ techName: "ZzBroken", externalAudioFile: "Audio/broken.wav" }, null, 2) + "\n");
  mkdirSync(join(wavRoot, "Audio"), { recursive: true });
  writeFileSync(join(wavRoot, "Audio", "pcm.wav"), wavBytes(1, 1, 44100));
  writeFileSync(join(wavRoot, "Audio", "float.wav"), wavBytes(3, 2, 44100));
  writeFileSync(join(wavRoot, "Audio", "slow.wav"), wavBytes(1, 1, 22050));
  writeFileSync(join(wavRoot, "Audio", "broken.wav"), Buffer.from("NOPE-not-a-wav-file-at-all"));
  const wavDiags = diagsOf(wavRoot).filter((d) => d.code === "D008");
  check("a PCM 44.1 kHz WAV passes without a D008",
    !wavDiags.some((d) => d.message.indexOf("pcm.wav") >= 0),
    JSON.stringify(wavDiags.map((d) => d.message)));
  check("a non-PCM WAV is a warning",
    wavDiags.some((d) => d.severity === "warning" && d.message.indexOf("format 3") >= 0),
    JSON.stringify(wavDiags.map((d) => d.severity + ":" + d.message)));
  check("a 22.05 kHz WAV is an info about the corpus being 44.1 kHz",
    wavDiags.some((d) => d.severity === "info" && d.message.indexOf("22050") >= 0),
    JSON.stringify(wavDiags.map((d) => d.severity + ":" + d.message)));
  check("a file named .wav that is not RIFF/WAVE is an error",
    wavDiags.some((d) => d.severity === "error" && d.message.indexOf("RIFF") >= 0),
    JSON.stringify(wavDiags.map((d) => d.severity + ":" + d.message)));

  /* Spine 三件套：缺图集 / 页图缺失 / 版本不对 / 孤立图集。 */
  function skelBytes(version) {
    const b = Buffer.alloc(8 + 2 + version.length);
    b.fill(0xab, 0, 8);
    b[8] = 0x0a; // 长度前缀：不重要，扫描只找版本字符串
    b.write(version, 9, "latin1");
    return b;
  }
  const spineRoot = assetPackage("infantgod-spine-");
  mkdirSync(join(spineRoot, "Defines", "Spine"), { recursive: true });
  writeFileSync(join(spineRoot, "Defines", "Spine", "NoAtlas.skel.bytes"), skelBytes("4.2.43"));
  specWrite(join(spineRoot, "Defines", "Spine", "Gone.atlas.txt"),
    "Gone\nsize: 8,8\nformat: RGBA8888\nfilter: Linear,Linear\nrepeat: none\n");
  writeFileSync(join(spineRoot, "Defines", "Spine", "NoPage.skel.bytes"), skelBytes("4.2.43"));
  specWrite(join(spineRoot, "Defines", "Spine", "NoPage.atlas.txt"),
    "NoPage.png\nsize: 8,8\nformat: RGBA8888\nfilter: Linear,Linear\nrepeat: none\n");
  specWrite(join(spineRoot, "Defines", "Spine", "Old.atlas.txt"),
    "Old.png\nsize: 8,8\nformat: RGBA8888\nfilter: Linear,Linear\nrepeat: none\n");
  writeFileSync(join(spineRoot, "Defines", "Spine", "Old.skel.bytes"), skelBytes("4.0.12"));
  writeFileSync(join(spineRoot, "Defines", "Spine", "Old.png"), pngBytes(8, 6, 0));
  const spineDiags = diagsOf(spineRoot).filter((d) => d.code === "D009");
  check("a skeleton without its atlas is an error",
    spineDiags.some((d) => d.severity === "error" && d.message.indexOf("缺图集") >= 0),
    JSON.stringify(spineDiags.map((d) => d.severity + ":" + d.message)));
  check("an atlas whose page image is missing is an error naming the page",
    spineDiags.some((d) => d.severity === "error" && d.message.indexOf("NoPage.png") >= 0),
    JSON.stringify(spineDiags.map((d) => d.severity + ":" + d.message)));
  check("a skeleton from before 4.2.x is an error the runtime cannot read it",
    spineDiags.some((d) => d.severity === "error" && d.message.indexOf("4.0.12") >= 0),
    JSON.stringify(spineDiags.map((d) => d.severity + ":" + d.message)));
  check("an atlas without its skeleton is an error",
    spineDiags.some((d) => d.severity === "error" && d.message.indexOf("没有对应的骨架") >= 0),
    JSON.stringify(spineDiags.map((d) => d.severity + ":" + d.message)));

  /* CSV：列数 / lock 列；BOM 不一致只报一句包级 info。 */
  const csvRoot = assetPackage("infantgod-csv-");
  specWrite(join(csvRoot, "NewProject.csv"), "language,key,text\r\nen,KEY1,English\r\n");
  specWrite(join(csvRoot, "Yarn", "NewProject_de.csv"),
    "\uFEFFlanguage,key,text,line,lock\r\nde,KEY1,Deutsch,line:1,false\r\n");
  specWrite(join(csvRoot, "Yarn", "NewProject_fr.csv"),
    "\uFEFFlanguage,key,text\r\nfr,KEY1,Francais\r\n");
  const csvDiags = diagsOf(csvRoot).filter((d) => d.code === "D010");
  check("a table with the wrong number of columns is a warning",
    csvDiags.some((d) => d.severity === "warning" && d.message.indexOf("3 列") >= 0),
    JSON.stringify(csvDiags.map((d) => d.severity + ":" + d.message)));
  check("a table without the lock column is a warning",
    csvDiags.some((d) => d.severity === "warning" && d.message.indexOf("lock") >= 0),
    JSON.stringify(csvDiags.map((d) => d.severity + ":" + d.message)));
  const bomDiags = csvDiags.filter((d) => d.severity === "info" && d.message.indexOf("BOM") >= 0);
  check("mixed BOM across the package is exactly one info, not one per table",
    bomDiags.length === 1, JSON.stringify(bomDiags.map((d) => d.message)));
}

section("the wiki's support matrix says which definitions the game consumes (G4)");

{
  const support = require("../support.js");
  const kb = mods.knowledge();
  const matrix = support.table();
  const matrixTypes = Object.keys(matrix).sort();
  const schemaTypes = Object.keys(kb.schemas).sort();
  const LEVELS = ["supported", "partial", "unsupported", "unknown"];

  check("the matrix covers exactly the 51 schema types, no more and no less",
    JSON.stringify(matrixTypes) === JSON.stringify(schemaTypes),
    JSON.stringify(matrixTypes));

  const badLevels = matrixTypes.filter((t) => LEVELS.indexOf(matrix[t].level) < 0);
  check("every entry sits in one of the four documented levels",
    badLevels.length === 0, JSON.stringify(badLevels.map((t) => t + ":" + matrix[t].level)));

  const byLevel = LEVELS.map((l) => matrixTypes.filter((t) => matrix[t].level === l).length);
  check("all four levels are actually used by the matrix",
    byLevel.every((n) => n > 0), JSON.stringify(LEVELS.map((l, i) => l + "=" + byLevel[i])));

  check("Character is supported, with the manager that consumes it",
    matrix.Character && matrix.Character.level === "supported" &&
      matrix.Character.manager === "CharacterDefinitionRegistry", JSON.stringify(matrix.Character));
  check("Song is unsupported even though the schema exists",
    matrix.Song && matrix.Song.level === "unsupported", JSON.stringify(matrix.Song));
  check("VoiceOverDefinition is partial, and names its manager",
    matrix.VoiceOverDefinition && matrix.VoiceOverDefinition.level === "partial" &&
      matrix.VoiceOverDefinition.manager === "VoiceOverDefinitionRegistry",
    JSON.stringify(matrix.VoiceOverDefinition));
  check("the 11 managers from the wiki's ModRegistry table are listed",
    support.managers().length === 11 && support.managers().includes("CutSceneManager"),
    JSON.stringify(support.managers()));

  /* the matrix reaches the API the editors use ---------------------- */

  const typed = mods.types();
  check("types() carries the support entry for every schema type",
    typed.length === 51 && typed.every((t) => t.support && LEVELS.indexOf(t.support.level) >= 0),
    JSON.stringify(typed.filter((t) => !t.support).map((t) => t.type)));

  /* a package that ships types the game will not consume ------------ */

  const root = join(specTemp("infantgod-support-"), "SupportProbe");
  specWrite(join(root, "mod.json"), JSON.stringify({
    name: "SupportProbe", version: "1.0.0", gameVersion: "1.0", loadOrder: 50,
  }, null, 2) + "\n");
  specWrite(join(root, "Defines", "News", "One.json"), "{ \"techName\": \"ZzNewsOne\" }\n");
  specWrite(join(root, "Defines", "News", "Two.json"), "{ \"techName\": \"ZzNewsTwo\" }\n");
  specWrite(join(root, "Defines", "Goods", "Poster.json"), "{ \"techName\": \"ZzGoods\" }\n");
  specWrite(join(root, "Defines", "Character", "Hero.json"), "{ \"techName\": \"ZzHero\" }\n");
  specMods.openMod({ dir: root });
  const diags = specMods.validatePackage({ root }).diagnostics;

  const m013 = diags.filter((d) => d.code === "M013");
  check("two files of one unsupported type produce exactly one M013, not two",
    m013.length === 1 && m013[0].severity === "warning" && m013[0].message.indexOf("News") >= 0,
    JSON.stringify(m013.map((d) => d.message)));
  const m014 = diags.filter((d) => d.code === "M014");
  check("a partially supported type is an info naming its manager",
    m014.length === 1 && m014[0].severity === "info" && m014[0].message.indexOf("GoodsManager") >= 0,
    JSON.stringify(m014.map((d) => d.message)));
  check("a fully supported type produces neither M013 nor M014",
    !m013.some((d) => d.message.indexOf("Character") >= 0) &&
      !m014.some((d) => d.message.indexOf("Character") >= 0),
    JSON.stringify(diags.filter((d) => d.code === "M013" || d.code === "M014").map((d) => d.message)));

  const textVerdict = specMods.validateDefineText({
    type: "Song", text: "{ \"techName\": \"ZzSong\" }\n", relPath: "Defines/Song/ZzSong.json",
  });
  check("validateDefineText reports M013 before the schema's own complaints",
    textVerdict.diagnostics[0] && textVerdict.diagnostics[0].code === "M013",
    JSON.stringify(textVerdict.diagnostics.map((d) => d.code)));

  /* new files and the scaffold respect the same truth ----------------- */

  const sandbox = specTemp("infantgod-support-new-");
  const fresh = createMods({ modsRoot: sandbox });
  const created = await fresh.scaffold({ dir: join(sandbox, "SupportNew"), modName: "SupportNew", template: "full" });
  const news = fresh.newFile({ dir: created.modRoot, type: "News", name: "ZzNews" });
  check("newFile hands back the support entry for the type it wrote",
    news.support && news.support.level === "unsupported", JSON.stringify(news.support));
  check("the full template no longer generates Attr, which the game does not consume",
    !created.created.some((p) => String(p).indexOf("Defines/Attr/") === 0),
    JSON.stringify(created.created));

  const templates = fresh.templates();
  const definePack = templates.find((t) => t.id === "define-pack");
  check("the define-pack template advertises only the two types it still creates",
    definePack && !definePack.files.some((p) => p.indexOf("Attr") >= 0) &&
      definePack.files.some((p) => p.indexOf("Defines/Goods/") === 0) &&
      definePack.files.some((p) => p.indexOf("Defines/Topic/") === 0),
    JSON.stringify(definePack && definePack.files));
}

section("the portrait a Character names through spineAssetPath (G22)");

{
  const kb = specMods.knowledge();

  function spinePackage(prefix) {
    const root = join(specTemp(prefix), "SpineMod");
    specWrite(join(root, "mod.json"), JSON.stringify({
      name: "SpineMod",
      version: "1.0.0",
      gameVersion: "1.0",
      author: "selftest",
      description: "selftest fixture: spineAssetPath",
    }, null, 2) + "\n");
    return root;
  }

  function characterAt(root, techName, spinePath) {
    const obj = { techName };
    if (spinePath !== undefined) obj.spineAssetPath = spinePath;
    specWrite(join(root, "Defines", "Character", techName + ".json"),
      JSON.stringify(obj, null, 2) + "\n");
  }

  function d011(root) {
    return validateCore.validateModPackage(root, {
      kb: kb,
      gameMods: { dir: null, readable: false },
    }).diagnostics.filter((d) => d.code === "D011");
  }

  /* 文件在：静默。语料里的写法是包内 Spine/<名字>.skel.bytes。 */
  const present = spinePackage("infantgod-spine-present-");
  characterAt(present, "Hero", "Spine/Hero.skel.bytes");
  mkdirSync(join(present, "Spine"), { recursive: true });
  writeFileSync(join(present, "Spine", "Hero.skel.bytes"), Buffer.from("fake skeleton"));
  check("a spineAssetPath whose file exists produces no D011",
    d011(present).length === 0, JSON.stringify(d011(present).map((d) => d.message)));

  /* 文件缺失：一处报错，点名文件和定义。 */
  const missing = spinePackage("infantgod-spine-missing-");
  characterAt(missing, "Hero", "Spine/Nowhere.skel.bytes");
  const missingDiags = d011(missing);
  check("a spineAssetPath whose file does not exist is one D011 error",
    missingDiags.length === 1, JSON.stringify(missingDiags.map((d) => d.code + ": " + d.message)));
  check("the D011 names the missing file and the definition that points at it",
    missingDiags[0] && missingDiags[0].message.indexOf("Nowhere.skel.bytes") >= 0 &&
      String(missingDiags[0].path).indexOf("Defines/Character/Hero.json") === 0,
    JSON.stringify(missingDiags[0] && { path: missingDiags[0].path, message: missingDiags[0].message }));

  /* 空字符串在语料里表示「没有自定义立绘」（26/56），不是错误。 */
  const empty = spinePackage("infantgod-spine-empty-");
  characterAt(empty, "Hero", "");
  check("an empty spineAssetPath means the default portrait and is not an error",
    d011(empty).length === 0, JSON.stringify(d011(empty).map((d) => d.message)));

  /* 少写 Spine/ 前缀也能找到包内 Spine/ 下的文件。 */
  const bare = spinePackage("infantgod-spine-bare-");
  characterAt(bare, "Hero", "Hero.skel.bytes");
  mkdirSync(join(bare, "Spine"), { recursive: true });
  writeFileSync(join(bare, "Spine", "Hero.skel.bytes"), Buffer.from("fake skeleton"));
  check("a path written without the Spine/ prefix still finds the file under Spine/",
    d011(bare).length === 0, JSON.stringify(d011(bare).map((d) => d.message)));

  /* Spine 的 JSON 导出要带同名图集。 */
  const jsonOnly = spinePackage("infantgod-spine-json-");
  characterAt(jsonOnly, "Hero", "Spine/Hero.json");
  mkdirSync(join(jsonOnly, "Spine"), { recursive: true });
  writeFileSync(join(jsonOnly, "Spine", "Hero.json"), Buffer.from("{}"));
  const jsonDiags = d011(jsonOnly);
  check("a Spine JSON export without its atlas is one D011 error about the atlas",
    jsonDiags.length === 1 && jsonDiags[0].message.indexOf("图集") >= 0,
    JSON.stringify(jsonDiags.map((d) => d.message)));
  writeFileSync(join(jsonOnly, "Spine", "Hero.atlas.txt"), Buffer.from("Hero.png\nsize: 2,2\n"));
  check("the same JSON export with a matching atlas is silent",
    d011(jsonOnly).length === 0, JSON.stringify(d011(jsonOnly).map((d) => d.message)));

  /* 真实语料：30 个带路径的 Character 全部在包内可解析，不产生任何 D011。 */
  if (!HAVE_CORPUS) {
    skip("the shipped SODefines package has no D011 (no Mods folder)");
  } else {
    const corpusDiags = validateCore.validateModPackage(join(MODS_DIR, "SODefines"), {
      kb: kb,
      gameMods: { dir: null, readable: false },
    }).diagnostics.filter((d) => d.code === "D011");
    check("the shipped SODefines package has no D011", corpusDiags.length === 0,
      JSON.stringify(corpusDiags.map((d) => d.message)));
  }
}

section("schema constraints, line ids and addressable addresses (G6, G7, G9)");

{
  const kb = specMods.knowledge();

  /* ---------------- G6：schema 关键字真的被读取 ---------------- */
  const g6Kb = {
    schemas: {
      Probe: {
        title: "Probe",
        type: "object",
        required: ["techName"],
        properties: {
          techName: { type: "string" },
          code: { type: "string", pattern: "^[A-Z]{3}$" },
          count: { type: "number", minimum: 1, multipleOf: 2 },
          score: { type: "number", maximum: 10, exclusiveMaximum: 10 },
          tags: { type: "array", minItems: 1, uniqueItems: true, items: { type: "string" } },
          kind: { type: "string", enum: ["a", "b"] },
          one: { oneOf: [{ type: "string" }, { type: "number" }] },
          any: { anyOf: [{ type: "string", minLength: 2 }, { type: "number" }] },
          either: { type: ["string", "number"] },
          strict: { type: "object", additionalProperties: false, properties: { x: { type: "string" } } },
          refA: { $ref: "#/NoSuchTitle" },
          refB: { $ref: "#/NoSuchTitle" },
        },
      },
    },
    baseline: {},
  };
  const g6 = (obj) => validateCore.validateDefine("Probe", obj, { kb: g6Kb });

  const clean = g6({ techName: "P", code: "ABC", count: 4, score: 9, tags: ["a"], kind: "a", one: 1, any: "ok", either: 3, strict: { x: "y" } });
  check("a definition that satisfies every keyword is silent",
    clean.length === 0, JSON.stringify(clean.map((d) => d.code + ": " + d.message)));

  const pattern = g6({ techName: "P", code: "abc" });
  check("a value that misses pattern is a D012 error",
    pattern.some((d) => d.code === "D012" && d.severity === "error" && d.message.indexOf("pattern") >= 0),
    JSON.stringify(pattern.map((d) => d.code + ": " + d.message)));

  const numeric = g6({ techName: "P", count: 3, score: 11 });
  check("minimum/multipleOf/maximum are enforced by D012",
    numeric.filter((d) => d.code === "D012").length === 3,
    JSON.stringify(numeric.map((d) => d.code + ": " + d.message)));

  const arrays = g6({ techName: "P", tags: ["a", "a"] });
  check("minItems and uniqueItems are enforced by D012",
    arrays.filter((d) => d.code === "D012").length === 1 &&
      arrays.some((d) => d.code === "D012" && d.message.indexOf("uniqueItems") >= 0),
    JSON.stringify(arrays.map((d) => d.code + ": " + d.message)));

  const one = g6({ techName: "P", one: true });
  check("oneOf with no matching branch is a D012 error",
    one.some((d) => d.code === "D012" && d.message.indexOf("oneOf") >= 0),
    JSON.stringify(one.map((d) => d.code + ": " + d.message)));

  const any = g6({ techName: "P", any: "x" });
  check("anyOf with no matching branch is a D012 error",
    any.some((d) => d.code === "D012" && d.message.indexOf("anyOf") >= 0),
    JSON.stringify(any.map((d) => d.code + ": " + d.message)));

  const eitherOk = g6({ techName: "P", either: "x" });
  const eitherBad = g6({ techName: "P", either: true });
  check("a type array accepts both listed types and rejects the rest",
    !eitherOk.some((d) => d.code === "D003" || d.code === "D007") &&
      eitherBad.some((d) => d.code === "D003" || d.code === "D007"),
    JSON.stringify({ ok: eitherOk.map((d) => d.code), bad: eitherBad.map((d) => d.code) }));

  const strict = g6({ techName: "P", strict: { x: "y", extra: 1 } });
  check("additionalProperties:false makes an undeclared field a D012 error, not a D002 warning",
    strict.some((d) => d.code === "D012" && d.severity === "error" && d.message.indexOf("extra") >= 0) &&
      !strict.some((d) => d.code === "D002"),
    JSON.stringify(strict.map((d) => d.code + ": " + d.message)));

  const unresolved = g6({ techName: "P", refA: "x", refB: "y" });
  const d013 = unresolved.filter((d) => d.code === "D013");
  check("an unresolvable $ref is one D013 warning per definition, not per field",
    d013.length === 1 && d013[0].severity === "warning" &&
      d013[0].message.indexOf("NoSuchTitle") >= 0,
    JSON.stringify(d013.map((d) => d.code + " " + d.severity + ": " + d.message)));

  /* ---------------- G9：Addressables 地址的形状 ---------------- */
  const addressPath = validateCore.validateDefine("CharacterState", {
    techName: "ProbeState",
    backgroundPrefab: "Assets/Art/Background/Office.prefab",
  }, { kb: kb });
  check("a Unity asset path written as an Addressables address is a D018 warning",
    addressPath.some((d) => d.code === "D018" && d.severity === "warning"),
    JSON.stringify(addressPath.map((d) => d.code + ": " + d.message)));

  const addressOk = validateCore.validateDefine("CharacterState", {
    techName: "ProbeState",
    backgroundPrefab: "Backgrounds/Office",
  }, { kb: kb });
  check("a plain Addressables address is silent",
    !addressOk.some((d) => d.code === "D018"),
    JSON.stringify(addressOk.map((d) => d.code + ": " + d.message)));

  /* ---------------- G7：#line: 与本地化表双向核对 ---------------- */
  const root = join(specTemp("infantgod-g7-"), "LineMod");
  specWrite(join(root, "mod.json"), JSON.stringify({
    name: "LineMod",
    version: "1.0.0",
    gameVersion: "1.0",
    author: "selftest",
    description: "selftest fixture: line ids",
  }, null, 2) + "\n");
  specWrite(join(root, "Yarn", "A.yarn"), [
    "title: A",
    "---",
    "Speaker: Hello #line:aaaaaaa",
    "Speaker: Missing row #line:bbbbbbb",
    "Speaker: Demo id #line:e4f5g6h",
    "",
  ].join("\n"));
  specWrite(join(root, "Yarn", "NewProject.csv"), [
    "language,id,text,file,node,lineNumber,lock,comment",
    "zh-CN,line:aaaaaaa,A: \u4f60\u597d,A.yarn,A,3,00000000,",
    "zh-CN,line:ccccccc,A: \u65e7\u884c,A.yarn,A,9,00000000,",
    "",
  ].join("\n"));

  const g7 = (dir) => validateCore.validateModPackage(dir, {
    kb: kb,
    gameMods: { dir: null, readable: false },
  }).diagnostics;
  const g7Diags = g7(root);
  const byCode = (code) => g7Diags.filter((d) => d.code === code);

  check("a Yarn line whose #line id is missing from the table is one D014 warning",
    byCode("D014").length === 1 && byCode("D014")[0].message.indexOf("bbbbbbb") >= 0,
    JSON.stringify(byCode("D014").map((d) => d.message)));
  check("a table row whose id is no longer in any Yarn file is one D015 warning",
    byCode("D015").length === 1 && byCode("D015")[0].message.indexOf("ccccccc") >= 0,
    JSON.stringify(byCode("D015").map((d) => d.message)));
  check("a #line id outside the line:<7 hex> contract is one D017 info, not a missing translation",
    byCode("D017").length === 1 && byCode("D017")[0].severity === "info" &&
      byCode("D017")[0].message.indexOf("e4f5g6h") >= 0 &&
      byCode("D014")[0].message.indexOf("e4f5g6h") < 0,
    JSON.stringify({ d17: byCode("D017").map((d) => d.message), d14: byCode("D014").map((d) => d.message) }));

  /* 同一个 id 出现在两个文件：翻译目标有歧义。 */
  specWrite(join(root, "Yarn", "B.yarn"), [
    "title: B",
    "---",
    "Speaker: Again #line:aaaaaaa",
    "",
  ].join("\n"));
  const dup = g7(root).filter((d) => d.code === "D016");
  check("the same #line id in two Yarn files is one D016 warning",
    dup.length === 1 && dup[0].message.indexOf("aaaaaaa") >= 0,
    JSON.stringify(dup.map((d) => d.message)));

  /* 真实语料：MyMod 有一行译文在 Yarn 里确实不存在（line:094007b），其余核对零误报。 */
  if (!HAVE_CORPUS) {
    skip("the shipped MyMod package has exactly one orphan translation row (no Mods folder)");
  } else {
    const corpus = validateCore.validateModPackage(join(MODS_DIR, "MyMod"), {
      kb: kb,
      gameMods: { dir: null, readable: false },
    }).diagnostics;
    const corpusOrphans = corpus.filter((d) => d.code === "D015");
    check("the shipped MyMod package has exactly one D015 (line:094007b) and no D014",
      corpusOrphans.length === 1 && corpusOrphans[0].message.indexOf("094007b") >= 0 &&
        corpus.filter((d) => d.code === "D014").length === 0,
      JSON.stringify({ d15: corpusOrphans.map((d) => d.message), d14: corpus.filter((d) => d.code === "D014").length }));
  }
}

  /* ---------------- G38：lock 列必须指回本包的一行文字 ---------------- */
  /*
   * 契约来自 MyMod 语料（11 张表 × 18609 行，全部成立）：lock 是 sha256(text)
   * 前 4 字节的小写 hex，译文表沿用基础表那一行的 lock。这里造一个小包：一张源表
   * 一张译文表，lock 都对得上；然后把源表文本改掉却不改 lock，锁就悬空了。
   */
  const lockOf = (text) => createHash("sha256").update(text, "utf8").digest("hex").slice(0, 8);
  const kb = mods.knowledge();
  const lockRoot = join(specTemp("infantgod-g38-"), "LockMod");
  specWrite(join(lockRoot, "mod.json"), JSON.stringify({
    name: "LockMod",
    version: "1.0.0",
    gameVersion: "1.0",
    author: "selftest",
    description: "selftest fixture: localisation locks",
  }, null, 2) + "\n");
  specWrite(join(lockRoot, "Yarn", "A.yarn"), [
    "title: A",
    "---",
    "Lantern: The lamp is lit. #line:aaa0001",
    "",
  ].join("\n"));
  const lockHead = "language,id,text,file,node,lineNumber,lock,comment\n";
  const writeLocks = (sourceText, { sourceLock = lockOf(sourceText), englishLock = sourceLock } = {}) => {
    specWrite(join(lockRoot, "Yarn", "NewProject.csv"),
      lockHead + "zh-CN,line:aaa0001," + sourceText + ",Yarn/A.yarn,A,3," + sourceLock + ",\n");
    specWrite(join(lockRoot, "Yarn", "NewProject_en.csv"),
      lockHead + "en,line:aaa0001,Lantern: The lamp is bright.,Yarn/A.yarn,A,3," + englishLock + ",\n");
  };
  writeLocks("Lantern: The lamp is lit.");
  const g38 = () => validateCore.validateModPackage(lockRoot, {
    kb: kb,
    gameMods: { dir: null, readable: false },
  }).diagnostics.filter((d) => d.code === "D023");
  check("a table whose locks hash a line in the package is quiet",
    g38().length === 0, JSON.stringify(g38().map((d) => d.message)));

  /* 改了台词文本却没重算 lock：译文表还记着旧文本的 hash。 */
  const editedText = "Lantern: The lamp is burning.";
  writeLocks(editedText, { sourceLock: lockOf("Lantern: The lamp is lit.") });
  const strayLock = g38();
  check("editing a line without recomputing its lock is one D023 naming the row and both hashes",
    strayLock.length === 1 &&
      strayLock[0].severity === "warning" &&
      strayLock[0].message.indexOf("line:aaa0001") >= 0 &&
      strayLock[0].message.indexOf(lockOf("Lantern: The lamp is lit.")) >= 0 &&
      strayLock[0].message.indexOf(lockOf(editedText)) >= 0,
    JSON.stringify(strayLock.map((d) => d.message)));

  /* 全零 lock 是翻译工具的"未锁定"，按没有 lock 跳过，不当错误。 */
  writeLocks(editedText, { sourceLock: "00000000" });
  check("a zero lock is treated as no lock, not as a mismatched one",
    g38().length === 0, JSON.stringify(g38().map((d) => d.message)));

  /* 真实语料：MyMod 的 18k 行 lock 全部指回源表文本，D023 零误报。 */
  if (!HAVE_CORPUS) {
    skip("the shipped MyMod package has no D023 false positives (no Mods folder)");
  } else {
    const corpusLocks = validateCore.validateModPackage(join(MODS_DIR, "MyMod"), {
      kb: kb,
      gameMods: { dir: null, readable: false },
    }).diagnostics.filter((d) => d.code === "D023");
    check("the shipped MyMod package has no D023 false positives",
      corpusLocks.length === 0, JSON.stringify(corpusLocks.map((d) => d.message)));
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
