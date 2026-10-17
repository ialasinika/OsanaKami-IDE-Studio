#!/usr/bin/env node
/**
 * gen_knowledge.mjs — 从本机安装（或提取出来）的游戏目录重建 mod 层的知识库。
 *
 * 背景：`shell/mods/knowledge.json` 是派生数据 —— 游戏自己的 schema、基线定义名、
 * 角色表、Yarn 命令/变量统计。仓库里原本没有任何东西能重建它，游戏一更新就只能
 * 手改 296 KB 的单行 JSON（G5）。本工具就是那个再生成入口。
 *
 * 它生成的是**facts-only** 知识库（中间路线）：
 *   保留：类型名 / 属性名与类型 / required / enum / const、基线定义名、Yarn 节点、
 *         命令与函数名及用量、变量名与类型、本地化语言表（文件名、行数、字节数）
 *   丢弃：description 等文档文本、`#region` 乱码、`$schema` 地址、53 个角色名与
 *         配色、projectName / startNode / 本机绝对路径 gameModsDir
 * 理由：文档文本与角色表和游戏本体是同一份受版权约束的复制件，事实不是。
 *
 * 例外（G41）：description 里有两类**事实**，剥掉文本时必须把它们留下，否则
 * 「重新生成 KB」会静默关掉校验器的一整类检查（两条线各自正确，合起来是
 * 「全绿但没查」）：
 *   "TechName reference to XDefinition"      -> 节点上的 "x-techReference": "XDefinition"
 *   "Relative path to sprite image file ..." -> 节点上的 "x-sprite": true
 * 校验器（shell/mods/validate.js 的 flattenSchema）优先读这两个键，没有时再退回
 * 解析 description —— 所以旧的富 KB 与新生成的 facts-only KB 都查得到同样的字段。
 *
 * 用法：
 *   node tools/gen_knowledge.mjs --game-dir <游戏Mods目录> --out <文件>
 *   node tools/gen_knowledge.mjs --game-dir <游戏Mods目录> --check [已有知识库]
 *   node tools/gen_knowledge.mjs --game-dir <游戏Mods目录> --diff [已有知识库]
 *   node tools/gen_knowledge.mjs --help
 *
 * 游戏目录的发现顺序见 shell/mods/gamepath.js：显式 --game-dir →
 * INFANTGOD_MODS_DIR / INFANTGOD_GAME_DIR → Steam 库探测 → 显式「未找到」（退出码 2）。
 *
 * 退出码：0 成功/无漂移/--diff 报告；1 --check 发现漂移；2 用法错误或找不到游戏。
 *
 * --diff 是只读报告（永远退出 0，不影响 --check 的退出码语义）：按区段列出
 * 「只在已提交 KB 里」与「只在生成版里」的名字（commands / functions / variables /
 * nodes 等）。**已提交的 shell/mods/knowledge.json 比 facts-only 生成版更富，这是
 * 已知且故意的**：它来自更早的客户端抽取器，带文档文本、命令的参数签名（136 条
 * command / 63 条 function）、53 个角色名与配色、undocumentedCommands 与
 * undeclaredVariables；本生成器只保留事实（见上面的「丢弃」清单）。因此 --check
 * 对已提交 KB 报漂移是预期的，--diff 就是用来把这份「更富」逐条摊开看的。
 *
 * 测试：shell/mods/selftest.mjs 用 build/ 下自造的 fixture 跑本文件的
 * buildKnowledge() 与 --check / --diff（fixture 里故意放了 description 与角色表，
 * 用来证明它们被丢掉）。本文件不写任何仓库内的路径，除非显式给 --out。
 */

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const gamepath = require("../shell/mods/gamepath.js");
const knowledgeBuild = require("../shell/mods/knowledge-build.js");

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, "..");
const DEFAULT_KB = path.join(REPO, "shell", "mods", "knowledge.json");

/* 纯派生核心在 shell/mods/knowledge-build.js；这里转出去，调用方不用关心搬家。 */
export const buildKnowledge = knowledgeBuild.buildKnowledge;
export const canonicalKnowledge = knowledgeBuild.canonicalKnowledge;
export const diffKnowledge = knowledgeBuild.diffKnowledge;

/* ------------------------------------------------------------------ *
 * 命令行
 * ------------------------------------------------------------------ */

function usage() {
  return [
    "用法:",
    "  node tools/gen_knowledge.mjs --game-dir <游戏Mods目录> --out <文件>",
    "  node tools/gen_knowledge.mjs --game-dir <游戏Mods目录> --check [已有知识库]",
    "  node tools/gen_knowledge.mjs --game-dir <游戏Mods目录> --diff [已有知识库]",
    "  node tools/gen_knowledge.mjs --schema-dir <SODefines/Schema> --defines-dir <SODefines/Defines> --out <文件>",
    "  node tools/gen_knowledge.mjs --json            # 打到 stdout",
    "",
    "不写 --game-dir 时按 INFANTGOD_MODS_DIR / INFANTGOD_GAME_DIR / Steam 库探测。",
    "--schema-dir / --defines-dir 单独指向两个子目录（等价于 <game-dir>/SODefines/{Schema,Defines}）。",
    "生成的 facts-only 知识库保留：command/function/variable 名字、参数名与类型、required/enum、类型名、",
    "  baseline 定义名、yarn 节点与台词 id、语言；故意丢弃：description 文档文本、#region 噪声、",
    "  属性描述、53 个角色名与颜色、以及本机绝对路径。",
    "",
    "--diff 是只读报告（退出 0）：按区段打印「只在已提交 KB 里 / 只在生成版里」的名字。",
    "  已提交的 shell/mods/knowledge.json 比 facts-only 生成版更富，原因见 --help 顶部说明；",
    "  所以 --check 对已提交 KB 报漂移是预期的，--diff 用来逐条看那份「更富」。",
  ].join("\n");
}

export function parseArgs(argv) {
  const out = { gameDir: null, out: null, check: false, checkPath: null, diff: false, diffPath: null, json: false, help: false, schemaDir: null, definesDir: null };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--help" || a === "-h") out.help = true;
    else if (a === "--json") out.json = true;
    else if (a === "--game-dir" || a === "--mods-dir") out.gameDir = argv[++i] || "";
    else if (a.startsWith("--game-dir=")) out.gameDir = a.slice("--game-dir=".length);
    else if (a === "--schema-dir") out.schemaDir = argv[++i] || "";
    else if (a.startsWith("--schema-dir=")) out.schemaDir = a.slice("--schema-dir=".length);
    else if (a === "--defines-dir") out.definesDir = argv[++i] || "";
    else if (a.startsWith("--defines-dir=")) out.definesDir = a.slice("--defines-dir=".length);
    else if (a === "--out" || a === "-o") out.out = argv[++i] || "";
    else if (a.startsWith("--out=")) out.out = a.slice("--out=".length);
    else if (a === "--check") {
      out.check = true;
      const next = argv[i + 1];
      if (next && !next.startsWith("-")) {
        out.checkPath = next;
        i++;
      }
    } else if (a.startsWith("--check=")) {
      out.check = true;
      out.checkPath = a.slice("--check=".length);
    } else if (a === "--diff") {
      out.diff = true;
      const next = argv[i + 1];
      if (next && !next.startsWith("-")) {
        out.diffPath = next;
        i++;
      }
    } else if (a.startsWith("--diff=")) {
      out.diff = true;
      out.diffPath = a.slice("--diff=".length);
    } else if (a.startsWith("-")) {
      const err = new Error(`未知参数：${a}`);
      err.code = "EUSAGE";
      throw err;
    }
  }
  return out;
}

/** 解析游戏目录：显式 → 环境变量 → 探测 → 抛出带 tried 的错误。 */
export function resolveGameDir(explicit, options) {
  const o = options && typeof options === "object" ? options : {};
  const found = gamepath.discoverGameModsDir({
    gameModsDir: explicit || null,
    env: o.env || process.env,
    searchRoots: o.searchRoots,
  });
  if (!found.dir) {
    const err = new Error(
      "未找到游戏 Mods 目录（没有 SODefines/Schema 或 SODefines/Defines）。\n" +
        "用 --game-dir 指定，或设 INFANTGOD_MODS_DIR / INFANTGOD_GAME_DIR。\n" +
        "找过的地方：\n" +
        found.tried.slice(0, 40).map((t) => `  - ${t.path}  (${t.source})`).join("\n")
    );
    err.code = "ENOGAME";
    err.tried = found.tried;
    throw err;
  }
  return { dir: found.dir, source: found.source, tried: found.tried };
}

function printSummary(kb, target) {
  const s = kb.stats;
  const lines = [
    `知识库：${target}`,
    `  schemas=${s.schemas} baselineDefines=${s.baselineDefines} locales=${s.locales}`,
    `  yarnFiles=${s.yarnFiles} nodes=${s.nodes} lineIds=${s.lineIds}`,
    `  commands=${s.commands} functions=${s.functions} variables=${s.variables}`,
  ];
  if (kb.warnings.length) {
    lines.push(`  警告 ${kb.warnings.length} 条：`);
    for (const w of kb.warnings.slice(0, 10)) lines.push(`    - ${w}`);
  }
  return lines.join("\n");
}

/** --diff 逐条打印的区段（其余区段只打印「值不同」一行）。 */
const DIFF_DETAIL_SECTIONS = [
  "commands",
  "functions",
  "variables",
  "nodes",
  "undocumentedCommands",
  "undeclaredVariables",
  "schemas",
  "baseline",
];

/**
 * --diff 的报告正文：按区段给出「只在已提交 KB 里」与「只在生成版里」的名字，
 * 并把「已提交 KB 更富」的原因写明。只读，不参与退出码。
 */
function formatDiff(report, kbPath, generated, resolvedDir) {
  const lines = [];
  lines.push(`游戏目录：${resolvedDir}`);
  lines.push(`已提交知识库：${kbPath}（${fs.statSync(kbPath).size} B）`);
  lines.push(
    `生成版：facts-only，内存中未写盘 ` +
      `(${generated.stats.commands} commands / ${generated.stats.functions} functions / ` +
      `${generated.stats.variables} variables / ${generated.stats.nodes} nodes)`
  );
  lines.push("");
  lines.push("区段                     只在已提交 KB   只在生成版");
  const details = [];
  for (const s of report.sections) {
    const onlyCommitted = s.added || [];
    const onlyGenerated = s.removed || [];
    if (s.status === "same") {
      lines.push(`  ${s.key.padEnd(22)} ${"0".padEnd(15)} ${"0".padEnd(15)} （一致）`);
      continue;
    }
    lines.push(
      `  ${s.key.padEnd(22)} ${String(onlyCommitted.length).padEnd(15)} ${String(onlyGenerated.length).padEnd(15)} ${s.detail || "值不同"}`
    );
    if (!DIFF_DETAIL_SECTIONS.includes(s.key)) continue;
    const fmt = (label, names) => {
      if (!names.length) return;
      const head = names.slice(0, 30);
      details.push(
        `  ${s.key} — ${label}（${names.length} 个）：${head.join(", ")}` +
          (names.length > head.length ? ` …还有 ${names.length - head.length} 个` : "")
      );
    };
    fmt("只在已提交 KB 里", onlyCommitted);
    fmt("只在生成版里", onlyGenerated);
  }
  if (details.length) {
    lines.push("");
    lines.push("逐条：");
    lines.push(...details);
  }
  lines.push("");
  lines.push("已提交 KB 比 facts-only 生成版更富，这是已知且故意的：");
  lines.push("  * 它来自更早的客户端抽取器：带命令的参数签名、文档文本、53 个角色名与配色，");
  lines.push("    以及 undocumentedCommands / undeclaredVariables 统计；");
  lines.push("  * 本生成器是 facts-only（见 --help 顶部）：故意丢弃上述内容，只留事实；");
  lines.push("  * 所以 --check 对已提交 KB 报漂移是预期的；--diff 只描述差距，退出码始终 0。");
  return `${lines.join("\n")}\n`;
}

/** 主入口；返回退出码（0/1/2）。 */
export async function main(argv) {
  let args;
  try {
    args = parseArgs(argv);
  } catch (e) {
    process.stderr.write(`${e.message}\n${usage()}\n`);
    return 2;
  }
  if (args.help) {
    process.stdout.write(`${usage()}\n`);
    return 0;
  }

  let resolved;
  try {
    if (args.schemaDir || args.definesDir) {
      resolved = { dir: path.resolve(args.gameDir || process.cwd()), source: "explicit-dirs", tried: [] };
    } else {
      resolved = resolveGameDir(args.gameDir);
    }
  } catch (e) {
    process.stderr.write(`${e.message}\n`);
    return 2;
  }

  let kb;
  try {
    kb = buildKnowledge(resolved.dir, { schemaDir: args.schemaDir, definesDir: args.definesDir });
  } catch (e) {
    process.stderr.write(`${e.message}\n`);
    return 2;
  }

  if (args.diff) {
    const diffPath = path.resolve(args.diffPath || DEFAULT_KB);
    if (!fs.existsSync(diffPath)) {
      process.stderr.write(`--diff 找不到要比较的知识库：${diffPath}\n`);
      return 2;
    }
    let committed;
    try {
      committed = JSON.parse(fs.readFileSync(diffPath, "utf8"));
    } catch (e) {
      process.stderr.write(`--diff 读不了 ${diffPath}：${e.message}\n`);
      return 2;
    }
    const report = diffKnowledge(committed, kb);
    process.stdout.write(formatDiff(report, diffPath, kb, `${resolved.dir}（来源 ${resolved.source}）`));
    return 0;
  }

  if (args.check) {
    const checkPath = path.resolve(args.checkPath || DEFAULT_KB);
    if (!fs.existsSync(checkPath)) {
      process.stderr.write(`--check 找不到要比较的知识库：${checkPath}\n`);
      return 2;
    }
    let actual;
    try {
      actual = JSON.parse(fs.readFileSync(checkPath, "utf8"));
    } catch (e) {
      process.stderr.write(`--check 读不了 ${checkPath}：${e.message}\n`);
      return 2;
    }
    const report = diffKnowledge(kb, actual);
    const drifted = report.sections.filter((s) => s.status !== "same");
    process.stdout.write(
      `游戏目录：${resolved.dir}（来源 ${resolved.source}）\n比较对象：${checkPath}\n`
    );
    if (report.equal) {
      process.stdout.write("无漂移：这份知识库与游戏目录里的事实一致。\n");
      return 0;
    }
    process.stdout.write(`发现漂移（${drifted.length} 个区段）：\n`);
    for (const s of drifted) {
      const extra = s.added.length ? ` 新增 ${s.added.slice(0, 8).join(", ")}${s.added.length > 8 ? " …" : ""}` : "";
      const gone = s.removed.length ? ` 缺失 ${s.removed.slice(0, 8).join(", ")}${s.removed.length > 8 ? " …" : ""}` : "";
      process.stdout.write(`  - ${s.key}: ${s.detail || "值不同"}${extra}${gone}\n`);
    }
    return 1;
  }

  const text = `${JSON.stringify(kb)}\n`;
  if (args.out) {
    const outPath = path.resolve(args.out);
    fs.mkdirSync(path.dirname(outPath), { recursive: true });
    fs.writeFileSync(outPath, text, "utf8");
    process.stdout.write(`${printSummary(kb, outPath)}\n`);
    return 0;
  }
  if (args.json) {
    process.stdout.write(text);
    return 0;
  }
  process.stdout.write(`${printSummary(kb, "(未写出，加 --out / --json)")}\n`);
  return 0;
}

const invoked = process.argv[1] ? path.resolve(process.argv[1]) : "";
if (invoked.toLowerCase().endsWith("gen_knowledge.mjs")) {
  main(process.argv.slice(2)).then(
    (code) => {
      process.exitCode = code;
    },
    (err) => {
      process.stderr.write(`${(err && err.stack) || err}\n`);
      process.exitCode = 2;
    }
  );
}
