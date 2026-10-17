'use strict';

/**
 * 知识库的纯派生核心（G30/G31）。
 *
 * 这一段原来只活在 `tools/gen_knowledge.mjs` 里，但它是纯函数：给一个游戏的 Mods
 * 目录，返回一份 facts-only 的知识库对象。放进 `shell/mods/` 是为了让 shell 在
 * 用户机器上也能自己派生一份，而不必让发布物随包携带生成的 `knowledge.json`。
 *
 * 依赖只有 node 的 fs/path 和同目录的 gamepath.js；不读仓库路径、不写文件、
 * 不联网。CLI（参数、--check/--diff、输出）仍然在 tools/gen_knowledge.mjs。
 */
const fs = require('fs');
const path = require('path');
const gamepath = require('./gamepath.js');

/** schema 里这些键是文档/元数据，不是事实，一律剥掉。 */
const DROP_KEYS = new Set(["description", "$schema", "$comment", "examples", "x-description"]);

/** description 里的两类事实（G41）：剥文本前先把它们提成显式字段。 */
const RE_TECH_REF = /^TechName reference to (.+)$/;
const RE_SPRITE_DESC = /Relative path to sprite image file/i;
const X_REF_KEY = "x-techReference";
const X_SPRITE_KEY = "x-sprite";

/** Yarn 方言里由引擎实现的内置动词，不算「Mod 用到的命令」。 */
const BUILTIN_VERBS = new Set([
  "if", "else", "elseif", "endif", "set", "declare", "jump", "detour", "once", "stop",
  "wait", "end", "return", "call", "enum", "case", "default", "do", "while", "for",
  "include", "title", "tags", "when", "tracking", "subtitle", "node", "add", "sub",
]);

/* ------------------------------------------------------------------ *
 * 通用小工具
 * ------------------------------------------------------------------ */

function relPosix(root, abs) {
  return path.relative(root, abs).split(path.sep).join("/");
}

/** 递归列出文件（确定顺序，跳过点目录）。 */
function walkFiles(dir, filter, out, depth) {
  const list = out || [];
  const d = depth || 0;
  if (d > 24 || !gamepath.isDir(dir)) return list;
  let entries = [];
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return list;
  }
  entries.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  for (const e of entries) {
    if (e.name.startsWith(".")) continue;
    const full = path.join(dir, e.name);
    if (e.isDirectory()) walkFiles(full, filter, list, d + 1);
    else if (e.isFile() && filter(e.name)) list.push(full);
  }
  return list;
}

/** 深拷贝并剥掉文档键；description 里的两类事实先提成显式字段（G41）。 */
function stripFacts(node) {
  if (Array.isArray(node)) return node.map(stripFacts);
  if (node && typeof node === "object") {
    const out = {};
    const desc = typeof node.description === "string" ? node.description : "";
    const reference = RE_TECH_REF.exec(desc);
    for (const key of Object.keys(node)) {
      if (DROP_KEYS.has(key)) continue;
      out[key] = stripFacts(node[key]);
    }
    if (reference) out[X_REF_KEY] = reference[1];
    else if (RE_SPRITE_DESC.test(desc)) out[X_SPRITE_KEY] = true;
    return out;
  }
  return node;
}

function readJsonFile(abs, warnings) {
  try {
    return JSON.parse(fs.readFileSync(abs, "utf8").replace(/^\uFEFF/, ""));
  } catch (e) {
    if (warnings) warnings.push(`${relPosix(REPO, abs)} 读不出来：${e.message}`);
    return null;
  }
}

/* ------------------------------------------------------------------ *
 * 各部分采集
 * ------------------------------------------------------------------ */

function collectSchemas(schemaDir, warnings) {
  const out = {};
  if (!gamepath.isDir(schemaDir)) {
    warnings.push("没有 SODefines/Schema：本次生成不含 schemas。");
    return out;
  }
  let names = [];
  try {
    names = fs.readdirSync(schemaDir).filter((f) => /\.schema\.json$/i.test(f)).sort();
  } catch (e) {
    warnings.push(`SODefines/Schema 读不出来：${e.message}`);
    return out;
  }
  for (const file of names) {
    const raw = readJsonFile(path.join(schemaDir, file), warnings);
    if (raw && typeof raw === "object") out[file.replace(/\.schema\.json$/i, "")] = stripFacts(raw);
  }
  return out;
}

/** 一份定义对象的身份字段名（照 schema 说的来，猜不到就用文件名）。 */
function techNameOf(obj, schema) {
  const props = schema && schema.properties && typeof schema.properties === "object"
    ? Object.keys(schema.properties)
    : [];
  const order = [];
  if (props.includes("techName")) order.push("techName");
  if (props.includes("TechName")) order.push("TechName");
  order.push("techName", "TechName", "name", "id");
  for (const key of order) {
    if (typeof obj[key] === "string" && obj[key]) return obj[key];
  }
  return null;
}

function collectBaseline(definesDir, schemas, warnings) {
  const out = {};
  if (!gamepath.isDir(definesDir)) {
    warnings.push("没有 SODefines/Defines：本次生成不含 baseline（撞名检查会失去依据）。");
    return out;
  }
  let types = [];
  try {
    types = fs
      .readdirSync(definesDir, { withFileTypes: true })
      .filter((e) => e.isDirectory())
      .map((e) => e.name)
      .sort();
  } catch (e) {
    warnings.push(`SODefines/Defines 读不出来：${e.message}`);
    return out;
  }
  for (const type of types) {
    const names = new Set();
    for (const abs of walkFiles(path.join(definesDir, type), (n) => /\.json$/i.test(n))) {
      const obj = readJsonFile(abs, warnings);
      if (!obj || typeof obj !== "object") continue;
      const name = techNameOf(obj, schemas[type]) || path.basename(abs).replace(/\.json$/i, "");
      if (name) names.add(String(name));
    }
    out[type] = [...names].sort();
  }
  return out;
}

/** 扫所有 .yarn：节点、命令、函数、变量、#line: 数量。 */
function collectYarn(root, warnings) {
  const result = {
    yarnFiles: 0,
    nodes: [],
    commands: [],
    functions: [],
    variables: [],
    lineIds: 0,
  };
  const files = walkFiles(root, (n) => /\.yarn$/i.test(n));
  result.yarnFiles = files.length;
  const commands = new Map();
  const functions = new Map();
  const variables = new Map();
  const seenNodes = new Set();

  for (const abs of files) {
    let text = "";
    try {
      text = fs.readFileSync(abs, "utf8").replace(/^\uFEFF/, "");
    } catch (e) {
      warnings.push(`${relPosix(root, abs)} 读不出来：${e.message}`);
      continue;
    }
    const file = relPosix(root, abs);
    const lines = text.split(/\r?\n/);
    let node = null;
    let inHeader = false;
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      const title = /^[ \t]*title[ \t]*:[ \t]*(.+?)[ \t]*$/.exec(line);
      if (title) {
        if (node) pushNode(result, seenNodes, node);
        node = { title: title[1], file: file, tags: [] };
        inHeader = true;
        continue;
      }
      if (inHeader) {
        const tags = /^[ \t]*tags[ \t]*:[ \t]*(.+?)[ \t]*$/.exec(line);
        if (tags) {
          if (node) {
            node.tags = tags[1]
              .split(/[\s,]+/)
              .map((t) => t.trim())
              .filter(Boolean);
          }
          continue;
        }
        if (/^[ \t]*---[ \t]*$/.test(line)) inHeader = false;
      }
    }
    if (node) pushNode(result, seenNodes, node);

    for (const m of text.matchAll(/#line:[A-Za-z0-9_]+/g)) result.lineIds++;

    for (const m of text.matchAll(/<<\s*([A-Za-z_][A-Za-z0-9_]*)([^>]*)>>/g)) {
      const name = m[1];
      if (BUILTIN_VERBS.has(name)) continue;
      const args = String(m[2] || "").trim();
      const arity = args === "" ? 0 : args.split(/\s+/).length;
      const entry = commands.get(name) || { name: name, parameters: [], usage: 0, arity: {} };
      entry.usage++;
      entry.arity[String(arity)] = (entry.arity[String(arity)] || 0) + 1;
      commands.set(name, entry);
    }

    for (const m of text.matchAll(/([A-Za-z_][A-Za-z0-9_]*)\s*\(/g)) {
      const name = m[1];
      if (BUILTIN_VERBS.has(name)) continue;
      const entry = functions.get(name) || { name: name, parameters: [], usage: 0 };
      entry.usage++;
      functions.set(name, entry);
    }

    for (const m of text.matchAll(/<<\s*declare\s+\$([A-Za-z_][A-Za-z0-9_]*)\s*=\s*([^>]*)>>/g)) {
      const name = m[1];
      const value = String(m[2] || "").trim();
      const type = /^(true|false)$/i.test(value)
        ? "bool"
        : /^-?\d+(\.\d+)?$/.test(value)
          ? "number"
          : /^"/.test(value)
            ? "string"
            : "number";
      variables.set(name, { name: name, type: type });
    }
    for (const m of text.matchAll(/\$([A-Za-z_][A-Za-z0-9_]*)/g)) {
      if (!variables.has(m[1])) variables.set(m[1], { name: m[1], type: "number" });
    }
  }

  result.commands = [...commands.values()].sort((a, b) => (a.name < b.name ? -1 : 1));
  result.functions = [...functions.values()].sort((a, b) => (a.name < b.name ? -1 : 1));
  result.variables = [...variables.values()].sort((a, b) => (a.name < b.name ? -1 : 1));
  result.nodes = result.nodes.sort((a, b) =>
    a.file < b.file ? -1 : a.file > b.file ? 1 : a.title < b.title ? -1 : a.title > b.title ? 1 : 0
  );
  return result;
}

function pushNode(result, seen, node) {
  const key = node.file + "\u0000" + node.title;
  if (seen.has(key)) return;
  seen.add(key);
  result.nodes.push({ title: node.title, file: node.file, tags: node.tags });
}

/** 首行 `language,` 之后的第一个字段就是这份表的语言码。 */
function csvLanguage(text) {
  /*
   * 第一行是表头（`language,id,text,...`），语言码在第一行数据的第一列。
   * 之前这里误把「数据行以 language, 开头」当成条件，所有文件都读不出语言码、
   * 退回文件名后缀 "base" —— 于是 baseLanguage 永远是 "base" 而不是 zh-CN。
   */
  const lines = text.split(/\r?\n/);
  if (lines.length < 2) return null;
  const first = lines[1].trim();
  if (!first) return null;
  const field = first.split(",")[0].trim().replace(/^"|"$/g, "");
  if (!field || /^language$/i.test(field)) return null;
  return field;
}

function collectLocalisation(root, warnings) {
  const out = { baseLanguage: null, locales: [] };
  const files = walkFiles(root, (n) => /\.csv$/i.test(n)).filter((f) => !/metadata/i.test(path.basename(f)));
  for (const abs of files) {
    let text = "";
    try {
      text = fs.readFileSync(abs, "utf8").replace(/^\uFEFF/, "");
    } catch (e) {
      warnings.push(`${relPosix(root, abs)} 读不出来：${e.message}`);
      continue;
    }
    if (!/^language,/i.test((text.split(/\r?\n/)[0] || "").trim())) continue;
    const file = relPosix(root, abs);
    const stem = path.basename(file).replace(/\.csv$/i, "");
    const suffix = stem.indexOf("_") >= 0 ? stem.slice(stem.lastIndexOf("_") + 1) : "base";
    out.locales.push({
      code: suffix,
      file: file,
      base: false,
      rows: text.split(/\r?\n/).filter((l) => l.trim() !== "").length,
      bytes: Buffer.byteLength(text, "utf8"),
    });
  }
  out.locales.sort((a, b) => (a.file < b.file ? -1 : a.file > b.file ? 1 : 0));
  if (!out.locales.length) {
    warnings.push("没有本地化 CSV：本次生成不含 locales。");
    return out;
  }
  out.locales[0].base = true;
  const baseFile = path.join(root, out.locales[0].file.split("/").join(path.sep));
  try {
    const language = csvLanguage(fs.readFileSync(baseFile, "utf8").replace(/^\uFEFF/, ""));
    out.baseLanguage = language || out.locales[0].code;
  } catch {
    out.baseLanguage = out.locales[0].code;
  }
  return out;
}

/* ------------------------------------------------------------------ *
 * 生成 / 比较
 * ------------------------------------------------------------------ */

/**
 * 从游戏目录生成 facts-only 知识库。
 * @param {string} gameDir 游戏 Mods 目录（含 SODefines/）
 * @param {object} [options] { now?:string, warnings?:string[], schemaDir?:string, definesDir?:string }
 * @returns {object} 知识库对象（形状与 shell/mods/knowledge.json 兼容）
 */
function buildKnowledge(gameDir, options) {
  const o = options && typeof options === "object" ? options : {};
  const root = path.resolve(String(gameDir == null ? "" : gameDir));
  const schemaDir = o.schemaDir ? path.resolve(String(o.schemaDir)) : path.join(root, "SODefines", "Schema");
  const definesDir = o.definesDir ? path.resolve(String(o.definesDir)) : path.join(root, "SODefines", "Defines");
  if (!o.schemaDir && !o.definesDir && !gamepath.looksLikeGameModsDir(root)) {
    const err = new Error(`不是游戏 Mods 目录（没有 SODefines/Schema 或 SODefines/Defines）：${root}`);
    err.code = "ENOGAME";
    throw err;
  }
  const warnings = Array.isArray(o.warnings) ? o.warnings : [];
  const schemas = collectSchemas(schemaDir, warnings);
  const baseline = collectBaseline(definesDir, schemas, warnings);
  const yarn = collectYarn(root, warnings);
  const localization = collectLocalisation(root, warnings);
  let baselineDefines = 0;
  for (const type of Object.keys(baseline)) baselineDefines += baseline[type].length;

  return {
    version: 1,
    generatedBy: "tools/gen_knowledge.mjs",
    generatedAt: o.now || new Date().toISOString(),
    warnings: warnings,
    stats: {
      yarnFiles: yarn.yarnFiles,
      nodes: yarn.nodes.length,
      commands: yarn.commands.length,
      functions: yarn.functions.length,
      variables: yarn.variables.length,
      schemas: Object.keys(schemas).length,
      baselineDefines: baselineDefines,
      locales: localization.locales.length,
      lineIds: yarn.lineIds,
      undocumentedCommands: 0,
      undeclaredVariables: 0,
    },
    commands: yarn.commands,
    functions: yarn.functions,
    variables: yarn.variables,
    nodes: yarn.nodes,
    undocumentedCommands: [],
    undeclaredVariables: [],
    schemas: schemas,
    baseline: baseline,
    localization: localization,
  };
}

const nameOf = (entry) => {
  if (!entry || typeof entry !== "object") return JSON.stringify(entry);
  return entry.name || entry.title || entry.file || JSON.stringify(entry);
};

const byName = (a, b) => (nameOf(a) < nameOf(b) ? -1 : nameOf(a) > nameOf(b) ? 1 : 0);

/** 归一化：去掉时间戳，按名字排序，让 --check 比较的是事实而不是书写顺序。 */
function canonicalKnowledge(kb) {
  const c = JSON.parse(JSON.stringify(kb && typeof kb === "object" ? kb : {}));
  delete c.generatedAt;
  c.commands = (c.commands || []).slice().sort(byName);
  c.functions = (c.functions || []).slice().sort(byName);
  c.variables = (c.variables || []).slice().sort(byName);
  c.nodes = (c.nodes || []).slice().sort(byName);
  c.undocumentedCommands = (c.undocumentedCommands || []).slice().sort(byName);
  c.undeclaredVariables = (c.undeclaredVariables || []).slice().sort(byName);
  const baseline = {};
  for (const type of Object.keys(c.baseline || {}).sort()) {
    baseline[type] = (c.baseline[type] || []).slice().sort();
  }
  c.baseline = baseline;
  const schemas = {};
  for (const type of Object.keys(c.schemas || {}).sort()) schemas[type] = c.schemas[type];
  c.schemas = schemas;
  const loc = c.localization && typeof c.localization === "object" ? c.localization : {};
  c.localization = {
    baseLanguage: loc.baseLanguage == null ? null : loc.baseLanguage,
    locales: (loc.locales || []).slice().sort((a, b) => (a.file < b.file ? -1 : a.file > b.file ? 1 : 0)),
  };
  return c;
}

const ARRAY_SECTIONS = ["commands", "functions", "variables", "nodes", "undocumentedCommands", "undeclaredVariables"];
const OBJECT_SECTIONS = ["schemas", "baseline"];

/**
 * 比较两份知识库的事实。
 * @returns {{equal:boolean, sections:Array<{key:string,status:string,added:string[],removed:string[],detail?:string}>}}
 */
function diffKnowledge(expected, actual) {
  const a = canonicalKnowledge(expected);
  const b = canonicalKnowledge(actual);
  const sections = [];
  const keys = [...new Set([...Object.keys(a), ...Object.keys(b)])].sort();
  for (const key of keys) {
    const av = a[key];
    const bv = b[key];
    const same = JSON.stringify(av) === JSON.stringify(bv);
    if (same) {
      sections.push({ key: key, status: "same", added: [], removed: [] });
      continue;
    }
    if (ARRAY_SECTIONS.includes(key)) {
      const an = new Set((av || []).map(nameOf));
      const bn = new Set((bv || []).map(nameOf));
      sections.push({
        key: key,
        status: "differs",
        added: [...an].filter((x) => !bn.has(x)).sort(),
        removed: [...bn].filter((x) => !an.has(x)).sort(),
        detail: `${(av || []).length} vs ${(bv || []).length}`,
      });
      continue;
    }
    if (OBJECT_SECTIONS.includes(key)) {
      const ak = new Set(Object.keys(av || {}));
      const bk = new Set(Object.keys(bv || {}));
      sections.push({
        key: key,
        status: "differs",
        added: [...ak].filter((x) => !bk.has(x)).sort(),
        removed: [...bk].filter((x) => !ak.has(x)).sort(),
        detail: `${ak.size} vs ${bk.size}`,
      });
      continue;
    }
    sections.push({ key: key, status: "differs", added: [], removed: [], detail: "值不同" });
  }
  return { equal: sections.every((s) => s.status === "same"), sections: sections };
}

module.exports = {
  buildKnowledge: buildKnowledge,
  canonicalKnowledge: canonicalKnowledge,
  diffKnowledge: diffKnowledge
};
