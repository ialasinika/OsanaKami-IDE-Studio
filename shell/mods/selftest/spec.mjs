import { createMods, MODS_DIR, checks, check, section, skip, mods, types, characters } from "./foundation.mjs";
import { HAVE_CORPUS, specMods, specTemps, specTemp, specWrite } from "./corpus.mjs";
import { spawn, spawnSync } from "node:child_process";
import { createRequire } from "node:module";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import * as validateCore from "../validate.js";

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
