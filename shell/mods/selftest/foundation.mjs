import { spawn, spawnSync } from "node:child_process";
import { createRequire } from "node:module";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

export const HERE = resolve(dirname(fileURLToPath(import.meta.url)), "..");
export const ROOT = resolve(HERE, "..", "..");

export const require = createRequire(import.meta.url);
export const gamepath = require(join(HERE, "gamepath.js"));
export const { createMods, KNOWLEDGE_PATH, defaultUserDir } = require(join(HERE, "index.js"));
export const knowledgeBuild = require(join(HERE, "knowledge-build.js"));

/*
 * 游戏目录不再写死在这台机器上（docs/EDITOR_GAPS.md §14.1 G26）：优先级是
 * 显式设置 > 环境变量 > 自动探测（Steam 库、用户主目录、checkout 的上一级）。
 * 找不到就是"没有语料"，语料相关的检查跳过而不是失败 —— 这个文件里没有一个
 * 本机绝对路径。
 */
export const DISCOVERY = gamepath.discoverGameModsDir({
  env: process.env,
  gameModsDir: process.env.INFANTGOD_MODS_DIR,
});
export const DEFAULT_MODS = DISCOVERY.dir || join(ROOT, "build", "no-corpus");

export const argv = process.argv.slice(2);
export const modsIndex = argv.indexOf("--mods");
export const MODS_DIR = modsIndex >= 0 && argv[modsIndex + 1] ? resolve(argv[modsIndex + 1]) : DEFAULT_MODS;

export let failures = 0;
export let checks = 0;
export let skipped = 0;

export function check(name, condition, detail) {
  checks += 1;
  if (condition) {
    console.log(`  ok   ${name}`);
  } else {
    failures += 1;
    console.log(`  FAIL ${name}${detail === undefined ? "" : ` -- ${detail}`}`);
  }
}

export function section(title) {
  console.log(`\n${title}`);
}

export function skip(name) {
  skipped += 1;
  console.log(`  skip ${name}`);
}

/* ------------------------------------------------------------------ */

section("knowledge base");

export const mods = createMods({ modsRoot: existsSync(MODS_DIR) ? MODS_DIR : ROOT });

/*
 * knowledge.json is derived from the player's game and is not tracked
 * (`.gitignore`, docs/EDITOR_GAPS.md §14.1 G26).  A development tree keeps a
 * copy beside the facade and the checks below describe it; a clean clone has
 * none, and then they are skipped instead of failed -- the file was never
 * meant to travel with the project (the installer's payload filter excludes it
 * too).  Every group after the foundation needs the same schemas, so the entry
 * (`selftest.mjs`) skips those for the same reason.
 */
export const SHIPPED_KNOWLEDGE = existsSync(KNOWLEDGE_PATH);

export let stats = null;
export let types = null;
export let characters = null;

function checkShippedKnowledge() {
  check("knowledge.json sits beside the facade", existsSync(KNOWLEDGE_PATH), KNOWLEDGE_PATH);

  stats = mods.stats();
  check("211 Yarn files", stats.yarnFiles === 211, String(stats.yarnFiles));
  check("1221 nodes", stats.nodes === 1221, String(stats.nodes));
  check("136 commands", stats.commands === 136, String(stats.commands));
  check("63 functions", stats.functions === 63, String(stats.functions));
  check("678 variables", stats.variables === 678, String(stats.variables));
  check("51 schemas", stats.schemas === 51, String(stats.schemas));
  check("1305 baseline defines", stats.baselineDefines === 1305, String(stats.baselineDefines));
  check("11 locales", stats.locales === 11, String(stats.locales));
  // G15：帮助卡直接引用这份矩阵和 wiki 出处，所以它必须随 stats 一起到达卡片层，
  // 且与 types()/M013 判据同源（support.json 只有一份）。
  check("the support matrix rides with the stats",
    stats.support && typeof stats.support.types === "object" && Object.keys(stats.support.types).length === 51,
    String(stats.support && Object.keys(stats.support.types).length));
  check("the help card gets the wiki URL",
    typeof stats.support.wiki === "string" && /^https?:\/\//.test(stats.support.wiki),
    String(stats.support.wiki));
  check("four support levels", Array.isArray(stats.support.levels) && stats.support.levels.length === 4,
    JSON.stringify(stats.support.levels));

  // G5：开发树里的 documentation 是 wiki 的正文，不是它的解码残渣。那一轮清掉了
  // 21 条把 "#region …" 变成乱码的串（U+E000 私用区、闊 之类的错码）；这类串
  // 一条就是 docs 卡里的一条错答案，wiki 再生成一次就可能回来，所以直接查数据。
  {
    const base = JSON.parse(readFileSync(KNOWLEDGE_PATH, "utf8"));
    const corrupt = [];
    let documentation = 0;
    const walk = (node, trail) => {
      if (node === null || typeof node !== "object") return;
      for (const key of Object.keys(node)) {
        const value = node[key];
        if (key === "documentation" && typeof value === "string") {
          documentation += 1;
          // #region 本身是 wiki 的编辑标记；私用区字符和"闊"是它被当作 GBK
          // 或 UTF-8 混读后的残渣。正文里出现任何一个都说明旧数据回来了。
          if (/#region|[\uE000-\uF8FF]|闊/.test(value)) corrupt.push(`${trail}/${key}`);
        } else if (value !== null && typeof value === "object") {
          walk(value, `${trail}/${key}`);
        }
      }
    };
    walk(base, "");
    check("the shipped documentation carries no region mojibake", corrupt.length === 0,
      `${corrupt.length} string(s): ${corrupt.slice(0, 3).join(", ")}`);
    check("the documentation prose survives the cleanup", documentation >= 150, String(documentation));
  }

  types = mods.types();
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

  characters = mods.characters();
  check("characters have a colour for the editor", characters.length > 0 && characters.every((c) => /^#[0-9a-fA-F]{6}$/.test(c.colour || "")),
    JSON.stringify(characters.slice(0, 2)));
}

if (SHIPPED_KNOWLEDGE) {
  checkShippedKnowledge();
} else {
  skip(`the shipped knowledge base (${KNOWLEDGE_PATH} is not in this checkout)`);
}

export const templates = mods.templates();
check("four mod templates", templates.length === 4, String(templates.length));
check("template ids are the documented ones",
  JSON.stringify(templates.map((t) => t.id).sort()) === JSON.stringify(["define-pack", "full", "minimal", "yarn-story"]),
  JSON.stringify(templates.map((t) => t.id)));

// G14：mod 层与内核对"这个文件能不能当文本读"给同一个答案。两边是两段代码
// （shell 进程里用 node:fs，内核是独立可执行文件），所以数字从内核头文件里
// 读出来比——漂移只有这里能发现。NUL 即二进制是内核 file.read 的判据，不是
// 这里猜的第三条规则。
{
  const readtext = require(join(HERE, "readtext.js"));
  const header = readFileSync(join(ROOT, "core", "include", "wksp.h"), "utf8");
  const match = header.match(/#define\s+SDE_WKSP_MAX_READ\s+\((\d+)u\s*\*\s*(\d+)u\s*\*\s*(\d+)u\)/);
  const kernelMax = match ? Number(match[1]) * Number(match[2]) * Number(match[3]) : null;
  check("the mod layer's text cap is the kernel's",
    kernelMax === readtext.MAX_TEXT_BYTES, `${readtext.MAX_TEXT_BYTES} vs ${kernelMax}`);

  const asDirectory = readtext.readTextFile(ROOT);
  check("a directory is not text", asDirectory.ok === false && /is a directory/.test(asDirectory.error),
    String(asDirectory.error));

  const scratch = mkdtempSync(join(tmpdir(), "infantgod-readtext-"));
  try {
    const nul = join(scratch, "nul.bin");
    writeFileSync(nul, Buffer.from([0x41, 0x00, 0x42]));
    const nullable = readtext.readTextFile(nul);
    check("a NUL byte makes it bytes, not text",
      nullable.ok === false && /file is binary/.test(nullable.error), String(nullable.error));

    const bom = join(scratch, "bom.txt");
    writeFileSync(bom, Buffer.from([0xef, 0xbb, 0xbf, 0x68, 0x69]));
    const stripped = readtext.readTextFile(bom);
    check("one UTF-8 BOM is stripped, as the card layer strips it",
      stripped.ok === true && stripped.text === "hi" && stripped.bytes === 5, JSON.stringify(stripped));

    const big = join(scratch, "big.txt");
    writeFileSync(big, Buffer.alloc(readtext.MAX_TEXT_BYTES + 1, 0x61));
    const tooLarge = readtext.readTextFile(big);
    check("a file over the cap is refused before it is read",
      tooLarge.ok === false && /too large/.test(tooLarge.error), String(tooLarge.error));
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
}

/* ------------------------------------------------------------------ */
