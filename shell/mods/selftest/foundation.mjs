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

check("knowledge.json sits beside the facade", existsSync(KNOWLEDGE_PATH), KNOWLEDGE_PATH);

export const stats = mods.stats();
check("211 Yarn files", stats.yarnFiles === 211, String(stats.yarnFiles));
check("1221 nodes", stats.nodes === 1221, String(stats.nodes));
check("136 commands", stats.commands === 136, String(stats.commands));
check("63 functions", stats.functions === 63, String(stats.functions));
check("678 variables", stats.variables === 678, String(stats.variables));
check("51 schemas", stats.schemas === 51, String(stats.schemas));
check("1305 baseline defines", stats.baselineDefines === 1305, String(stats.baselineDefines));
check("11 locales", stats.locales === 11, String(stats.locales));

export const types = mods.types();
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

export const templates = mods.templates();
check("four mod templates", templates.length === 4, String(templates.length));
check("template ids are the documented ones",
  JSON.stringify(templates.map((t) => t.id).sort()) === JSON.stringify(["define-pack", "full", "minimal", "yarn-story"]),
  JSON.stringify(templates.map((t) => t.id)));

export const characters = mods.characters();
check("characters have a colour for the editor", characters.length > 0 && characters.every((c) => /^#[0-9a-fA-F]{6}$/.test(c.colour || "")),
  JSON.stringify(characters.slice(0, 2)));

/* ------------------------------------------------------------------ */
