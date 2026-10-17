'use strict';
/**
 * gamepath.js — 「游戏 Mods 目录」的唯一发现入口。
 *
 * 为什么要单独一个文件：知识库生成器（tools/gen_knowledge.mjs）和 mod 门面
 * （index.js、scaffold.js）必须按同一套顺序找同一个目录，否则会出现「生成器
 * 能生成、编辑器找不到」这种半死状态。
 *
 * 顺序（只认结构标记，绝不猜一个看起来像的目录）：
 *   1. 显式设置   createMods({ gameModsDir }) / --game-dir / --mods-root 的调用方
 *   2. 环境变量   INFANTGOD_MODS_DIR；或 INFANTGOD_GAME_DIR 下的 Mods、
 *                 ModsFull/Mods（提取出来的游戏树放在哪一层由用户决定）
 *   3. 自动探测   Steam 库目录（各 steamapps/libraryfolders.vdf 的 path）
 *                 以及调用方给的 searchRoots（测试、自定义安装位置）
 *   4. 未找到     { dir: null, source: 'not found', tried: [...] } —— 显式状态，
 *                 调用方必须把「未找到」当成一个要显示给用户的事实，而不是
 *                 回退到一个硬编码路径。
 *
 * 标记（任一命中即认为是游戏 Mods 目录）：
 *   SODefines/Schema、SODefines/Defines、MyMod/Yarn
 *
 * 本文件是 CommonJS（仓库没有 package.json），只依赖 node:fs / node:path / node:os。
 */
const fs = require('fs');
const path = require('path');
const os = require('os');

/** 显式指定「游戏 Mods 目录」的环境变量。 */
const ENV_DIR = 'INFANTGOD_MODS_DIR';
/** 显式指定「游戏安装目录」的环境变量（其下的 Mods / ModsFull/Mods 会被试一次）。 */
const ENV_GAME = 'INFANTGOD_GAME_DIR';

/** 结构标记：命中任一条就认为这是一份游戏 Mods 目录。 */
const MARKERS = [
  ['SODefines', 'Schema'],
  ['SODefines', 'Defines'],
  ['MyMod', 'Yarn'],
];

/** 每个候选根最多看多少个下一层目录（防止在用户主目录上乱翻）。 */
const MAX_DIRS_PER_ROOT = 64;
/** tried 列表的上限，只为给用户看「找过哪些地方」。 */
const MAX_TRIED = 240;

function isDir(p) {
  if (p == null || p === '') return false;
  try {
    return fs.statSync(p).isDirectory();
  } catch {
    return false;
  }
}

/** 这个目录是不是游戏 Mods 目录（看结构标记，不看名字）。 */
function looksLikeGameModsDir(dir) {
  if (!dir) return false;
  return MARKERS.some((m) => isDir(path.join(dir, m[0], m[1])));
}

/**
 * 一个候选根下，可能放游戏 Mods 目录的位置（有界、确定顺序）。
 * 覆盖两种常见形态：
 *   <root> 本身就是 Mods    | 提取出来时把 Mods 放在 <root>/ModsFull/Mods
 *   <root>/<游戏名>/Mods     | Steam 库里的常见排布
 *
 * 顺序上先试 ModsFull/Mods：同一台机器上常常同时存在一份精简提取
 * （<root>/Mods）和一份完整提取（<root>/ModsFull/Mods），后者才是知识库的来源。
 */
function candidatesUnder(root) {
  const out = [
    root,
    path.join(root, 'ModsFull', 'Mods'),
    path.join(root, 'ModsFull'),
    path.join(root, 'Mods'),
  ];
  let names = [];
  try {
    names = fs
      .readdirSync(root, { withFileTypes: true })
      .filter((e) => e.isDirectory())
      .map((e) => e.name)
      .sort()
      .slice(0, MAX_DIRS_PER_ROOT);
  } catch {
    names = [];
  }
  for (const n of names) {
    out.push(path.join(root, n, 'ModsFull', 'Mods'));
    out.push(path.join(root, n, 'Mods'));
    out.push(path.join(root, n));
  }
  return out;
}

/**
 * Steam 的默认安装位置：三个平台不一样，但 libraryfolders.vdf 的格式一样。
 * 平台可以注入（`options.platform`），所以测试不需要真的装一个 Steam。
 */
function steamInstallDirs(env, platform) {
  const e = env || {};
  const p = platform || process.platform;
  if (p === 'win32') {
    const programFiles = e['ProgramFiles(x86)'] || e.ProgramFiles || 'C:\\Program Files (x86)';
    return [path.join(programFiles, 'Steam')];
  }
  const home = e.HOME || e.USERPROFILE || os.homedir();
  if (!home) return [];
  if (p === 'darwin') {
    return [
      path.join(home, 'Library', 'Application Support', 'Steam'),
      path.join(home, '.steam', 'steam'),
    ];
  }
  return [
    path.join(home, '.local', 'share', 'Steam'),
    path.join(home, '.steam', 'steam'),
  ];
}

/** Steam 库根目录：Steam 安装目录 + libraryfolders.vdf 里登记的每个 path。 */
function steamLibraryRoots(env, platform) {
  const roots = [];
  for (const steam of steamInstallDirs(env, platform)) {
    if (!roots.includes(steam)) roots.push(steam);
    try {
      const text = fs.readFileSync(path.join(steam, 'steamapps', 'libraryfolders.vdf'), 'utf8');
      for (const m of text.matchAll(/"path"\s+"([^"]+)"/g)) {
        const candidate = m[1].replace(/\\\\/g, '\\');
        if (!roots.includes(candidate)) roots.push(candidate);
      }
    } catch {
      /* 没装 Steam / 没有 vdf：这个安装目录仍是候选 */
    }
  }
  return roots;
}

/** 默认探测根：Steam 库 + 用户主目录 + checkout 的上一级（只列一层，靠候选列表收敛）。 */
function defaultSearchRoots(env, platform) {
  const roots = steamLibraryRoots(env, platform);
  const home = (env && (env.HOME || env.USERPROFILE)) || os.homedir();
  if (home) roots.push(home);
  /* 提取出来的游戏树常和仓库并排放（<workspace>/ModsFull/Mods）。这是相对位置，
     不是本机绝对路径：别人的 checkout 放在哪里都照样成立。 */
  roots.push(path.resolve(__dirname, '..', '..', '..'));
  return roots;
}

/** 一句人话：找到在哪、怎么找到的；或者「没找到，找过几处」。 */
function describeDiscovery(result) {
  const r = result || {};
  if (r.found && r.dir) return `found ${r.dir} (${r.source})`;
  const n = Array.isArray(r.tried) ? r.tried.length : 0;
  return `not found; looked in ${n} place${n === 1 ? '' : 's'}`;
}

/**
 * 找游戏 Mods 目录。
 *
 * @param {object} [options]
 * @param {string} [options.gameModsDir] 显式目录（最高优先级）
 * @param {string} [options.dir]         gameModsDir 的别名
 * @param {object} [options.env]         环境变量表（默认 process.env）
 * @param {string[]} [options.searchRoots] 自定义探测根（默认 Steam 库 + 主目录）
 * @returns {{dir:string|null, source:string, tried:Array<{path:string,source:string}>, found:boolean}}
 */
function discoverGameModsDir(options) {
  const o = options && typeof options === 'object' ? options : {};
  const env = o.env && typeof o.env === 'object' ? o.env : process.env;
  const tried = [];
  const note = (p, source) => {
    if (tried.length < MAX_TRIED) tried.push({ path: p, source: source });
  };
  const hit = (dir, source) => ({ dir: dir, source: source, tried: tried, found: true });

  /* 1. 显式设置 */
  const explicit = o.gameModsDir != null ? o.gameModsDir : o.dir;
  if (explicit != null && String(explicit).trim() !== '') {
    const abs = path.resolve(String(explicit));
    note(abs, 'setting');
    if (looksLikeGameModsDir(abs)) return hit(abs, 'setting');
    return { dir: null, source: 'not found', tried: tried, found: false };
  }

  /* 2. 环境变量 */
  const fromEnv = [
    [env[ENV_DIR], ENV_DIR],
    [env[ENV_GAME] ? path.join(String(env[ENV_GAME]), 'Mods') : null, ENV_GAME + '/Mods'],
    [env[ENV_GAME] ? path.join(String(env[ENV_GAME]), 'ModsFull', 'Mods') : null, ENV_GAME + '/ModsFull/Mods'],
  ];
  for (const pair of fromEnv) {
    if (pair[0] == null || String(pair[0]).trim() === '') continue;
    const abs = path.resolve(String(pair[0]));
    note(abs, pair[1]);
    if (looksLikeGameModsDir(abs)) return hit(abs, pair[1]);
  }

  /* 3. 自动探测 */
  const roots =
    Array.isArray(o.searchRoots) && o.searchRoots.length
      ? o.searchRoots
      : defaultSearchRoots(env, o.platform);
  for (const root of roots) {
    if (root == null || String(root).trim() === '') continue;
    const absRoot = path.resolve(String(root));
    for (const candidate of candidatesUnder(absRoot)) {
      note(candidate, 'discover');
      if (looksLikeGameModsDir(candidate)) return hit(candidate, 'discover');
    }
  }

  /* 4. 未找到：显式状态 */
  return { dir: null, source: 'not found', tried: tried, found: false };
}

module.exports = {
  ENV_DIR,
  ENV_GAME,
  MARKERS,
  isDir,
  looksLikeGameModsDir,
  candidatesUnder,
  steamInstallDirs,
  steamLibraryRoots,
  defaultSearchRoots,
  describeDiscovery,
  discoverGameModsDir,
};
