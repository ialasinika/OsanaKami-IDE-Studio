/**
 * scaffold-cross.mjs -- G8：脚手架 × 校验器的自洽测试。
 *
 * 对 support.json 里的每个定义类型，用 scaffold.js 生成一个定义文件放进临时
 * Mod 包，再跑 validate.js 的整包校验：脚手架自己生成的文件必须零 error
 * （warning/info 允许，例如 EventReference 无法由 JSON 构造的 D019）。
 *
 * 四个内置模板也各生成一次整包，确保 mod.json / Yarn / CSV 一起通过。
 * 解析失败（生成的文件不是合法 JSON）计为失败，不算跳过。
 */

import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { join } from "node:path";

import { specTemp, specWrite } from "./corpus.mjs";
import { HERE, check, section } from "./foundation.mjs";

const require = createRequire(import.meta.url);
const validateCore = require(join(HERE, "validate.js"));
const scaffold = require(join(HERE, "scaffold.js"));

const KB_PATH = join(HERE, "knowledge.json");
const KB = JSON.parse(readFileSync(KB_PATH, "utf8"));
const SUPPORT = JSON.parse(readFileSync(join(HERE, "support.json"), "utf8"));

const types = Object.keys(SUPPORT.types || {}).sort();

section("G8: every definition type scaffolds into a package that validates");

{
  /*
   * 先跑一次模板脚手架，把 scaffold 的知识库覆盖固定到仓库里的 knowledge.json，
   * 并让 activeGameModsDir 指向一个不存在的目录——否则这台机器上探测到的游戏
   * schema 会让结果随机器变化。
   */
  const warm = await scaffold.scaffoldMod(join(specTemp("infantgod-cross-warm-"), "Warm"), {
    modName: "CrossWarm",
    template: "minimal",
    knowledgePath: KB_PATH,
    gameModsDir: join(specTemp("infantgod-cross-nogame-"), "no-game"),
  });
  check("the scaffold can be pointed at the repo knowledge base", warm && warm.modRoot ? true : false);

  const root = join(specTemp("infantgod-cross-"), "CrossMod");
  specWrite(join(root, "mod.json"), JSON.stringify({
    name: "CrossMod",
    version: "1.0.0",
    gameVersion: "1.0",
    loadOrder: 50,
    author: "selftest",
    description: "G8 scaffold x validate fixture",
  }, null, 2) + "\n");

  const covered = [];
  const unparsed = [];
  for (const type of types) {
    if (!KB.schemas[type]) continue;
    const techName = "Cross_" + type;
    const obj = scaffold.__internal.buildDefineObject(type, techName);
    const rel = join("Defines", type, techName + ".json");
    specWrite(join(root, rel), JSON.stringify(obj, null, 2) + "\n");
    let readBack = null;
    try {
      readBack = JSON.parse(readFileSync(join(root, rel), "utf8"));
    } catch (err) {
      unparsed.push(type + ": " + err.message);
    }
    if (readBack && (readBack.techName === techName || readBack.TechName === techName)) covered.push(type);
  }

  // 图标字段的默认值是 Sprites/placeholder.png，脚手架整包会写出这张占位图；
  // 这里逐类型生成时也要补上，否则校验只会报「图片不存在」而不是定义本身。
  specWrite(join(root, "Sprites", "placeholder.png"),
    scaffold.__internal.makePlaceholderPng(64, [0x7c, 0x4e, 0xc1]));

  check("every type with a schema was generated", covered.length === types.length,
    JSON.stringify({ generated: covered.length, support: types.length }));
  check("every generated define parses back as JSON", unparsed.length === 0,
    JSON.stringify(unparsed.slice(0, 3)));

  const report = validateCore.validateModPackage(root, { kb: KB });
  check("the generated package contains every define", report.summary.defines === covered.length,
    JSON.stringify({ defines: report.summary.defines, covered: covered.length }));
  const errors = report.diagnostics.filter((d) => d.severity === "error");
  check("scaffold x validate: no error diagnostics", errors.length === 0,
    JSON.stringify(errors.slice(0, 6).map((d) => d.code + " " + d.path + " " + d.message)));
  console.log("       types covered: " + covered.length + " (" + covered.join(", ") + ")");
}

section("G8: the four built-in templates validate as packages");

{
  const noGame = join(specTemp("infantgod-cross-tpl-nogame-"), "no-game");
  for (const template of scaffold.MOD_TEMPLATES.map((t) => t.id)) {
    const dir = specTemp("infantgod-cross-tpl-");
    const result = await scaffold.scaffoldMod(dir, {
      modName: "Tpl_" + template.replace(/-/g, "_"),
      template,
      knowledgePath: KB_PATH,
      gameModsDir: noGame,
    });
    const report = validateCore.validateModPackage(result.modRoot, { kb: KB });
    const errors = report.diagnostics.filter((d) => d.severity === "error");
    check(`template "${template}" scaffolds without errors`, errors.length === 0,
      JSON.stringify(errors.slice(0, 4).map((d) => d.code + " " + d.path + " " + d.message)));
  }
}
