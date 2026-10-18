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

/* ---------------- 游戏日志：Player.log（G12） ---------------- */

/** 只读日志尾部时的默认字节数。 */
const LOG_TAIL_BYTES = 64 * 1024;
/** followPlayerLog 的默认采样间隔与总时长（毫秒）。 */
const LOG_POLL_MS = 500;
const LOG_DURATION_MS = 5000;

/**
 * 分类正则。保守：一行算「错误」就不算「mod」，宁可漏一条也不要把日常噪声
 * 全贴到作者脸上。
 */
const LOG_ERROR_RE = /error|exception|failed|failure|denied|not found/i;
const LOG_MOD_RE = /mod|yarn|tech/i;

/** stat 一个文件；不存在、没权限、是目录都返回 null（日志是「可能没有」的东西）。 */
function logStat(p) {
  try {
    const st = fs.statSync(p);
    return st.isFile() ? st : null;
  } catch (e) {
    return null;
  }
}

/** 读一段字节区间；失败（被删、被占用）返回 null，绝不抛。 */
function readRange(p, from, to) {
  let fd = null;
  try {
    fd = fs.openSync(p, 'r');
    const length = Math.max(0, to - from);
    if (length === 0) return { text: '', offset: from, buffer: Buffer.alloc(0) };
    const buffer = Buffer.alloc(length);
    let read = 0;
    while (read < length) {
      const n = fs.readSync(fd, buffer, read, length - read, from + read);
      if (n <= 0) break;
      read += n;
    }
    const slice = buffer.subarray(0, read);
    return { text: slice.toString('utf8'), offset: from + read, buffer: slice };
  } catch (e) {
    return null;
  } finally {
    if (fd !== null) {
      try {
        fs.closeSync(fd);
      } catch (e) {
        /* 已经关了 */
      }
    }
  }
}

/** 三个平台默认的 Unity 日志根（env / platform 可注入）。 */
function defaultLogRoots(env, platform) {
  const e = env && typeof env === 'object' ? env : process.env;
  const p = platform || process.platform;
  const home = e.HOME || e.USERPROFILE || os.homedir();
  const roots = [];
  if (p === 'win32') {
    if (home) roots.push(path.join(home, 'AppData', 'LocalLow'));
    if (e.LOCALAPPDATA) roots.push(path.join(String(e.LOCALAPPDATA), '..', 'LocalLow'));
  } else if (p === 'darwin') {
    if (home) roots.push(path.join(home, 'Library', 'Logs'));
  } else {
    if (e.XDG_CONFIG_HOME) roots.push(path.join(String(e.XDG_CONFIG_HOME), 'unity3d'));
    if (home) roots.push(path.join(home, '.config', 'unity3d'));
  }
  return roots;
}

function logNote(tried, p, source) {
  if (tried.length < MAX_TRIED) tried.push({ path: p, source: source });
}

/** 一个目录下的子目录，按名字排序（确定性）。 */
function childDirs(dir) {
  let names;
  try {
    names = fs.readdirSync(dir);
  } catch (e) {
    return [];
  }
  names.sort();
  const out = [];
  for (const name of names) {
    if (out.length >= MAX_DIRS_PER_ROOT) break;
    const abs = path.join(dir, name);
    if (isDir(abs)) out.push(abs);
  }
  return out;
}

/**
 * 找 Player.log。
 *
 * 布局按 Unity 的惯例：<root>/<Company>/<Product>/Player.log（深度 2），
 * 再退一步看 <root>/<X>/Player.log（深度 1，自定义安装）。多个候选取最近
 * 修改的一个。返回 {path, mtime, size, found, tried}，没找到时 path 为 null
 * ——「没找到」是一个要显示给用户的事实，不是回退到某个硬编码路径。
 *
 * options: {path?, env?, platform?, searchRoots?}；searchRoots 覆盖默认根。
 */
function discoverPlayerLog(options) {
  const o = options && typeof options === 'object' ? options : {};
  const env = o.env && typeof o.env === 'object' ? o.env : process.env;
  const tried = [];

  /* 1. 显式给了文件：只认它 */
  if (o.path != null && String(o.path).trim() !== '') {
    const abs = path.resolve(String(o.path));
    logNote(tried, abs, 'explicit');
    const st = logStat(abs);
    if (st === null) return { path: null, mtime: 0, size: 0, found: false, tried: tried };
    return { path: abs, mtime: st.mtimeMs, size: st.size, found: true, tried: tried };
  }

  /* 2. 在根目录下按深度找，取最新 */
  const roots =
    Array.isArray(o.searchRoots) && o.searchRoots.length
      ? o.searchRoots
      : defaultLogRoots(env, o.platform);
  let best = null;
  for (const root of roots) {
    if (root == null || String(root).trim() === '') continue;
    const absRoot = path.resolve(String(root));
    logNote(tried, absRoot, 'root');
    for (const company of childDirs(absRoot)) {
      for (const dir of [company].concat(childDirs(company))) {
        const candidate = path.join(dir, 'Player.log');
        logNote(tried, candidate, 'discover');
        const st = logStat(candidate);
        if (st !== null && (best === null || st.mtimeMs > best.mtime)) {
          best = { path: candidate, mtime: st.mtimeMs, size: st.size };
        }
      }
    }
  }

  /* 3. 未找到：显式状态 */
  if (best === null) return { path: null, mtime: 0, size: 0, found: false, tried: tried };
  return { path: best.path, mtime: best.mtime, size: best.size, found: true, tried: tried };
}

/**
 * 只读日志尾部：{text, offset, size, mtime}。offset 是 text 起始的字节位置，
 * 跟随日志时从这里接着读。从行边界开始：尾巴的第一行如果不完整就丢掉，
 * 这样 offset 永远指向一整行的开头。
 *
 * options: {bytes?}，默认 64 KiB。
 */
function readLogTail(p, options) {
  const o = options && typeof options === 'object' ? options : {};
  const want = Number(o.bytes) > 0 ? Math.floor(Number(o.bytes)) : LOG_TAIL_BYTES;
  const abs = path.resolve(String(p));
  const st = logStat(abs);
  if (st === null) return { text: '', offset: 0, size: 0, mtime: 0 };
  const start = st.size > want ? st.size - want : 0;
  const chunk = readRange(abs, start, st.size);
  if (chunk === null) return { text: '', offset: start, size: st.size, mtime: st.mtimeMs };

  if (start === 0) {
    return { text: chunk.text, offset: 0, size: st.size, mtime: st.mtimeMs };
  }
  const cut = chunk.buffer.indexOf(0x0a);
  if (cut >= 0) {
    return {
      text: chunk.buffer.subarray(cut + 1).toString('utf8'),
      offset: start + cut + 1,
      size: st.size,
      mtime: st.mtimeMs,
    };
  }
  /* 整段没有换行：读不到一行完整的，就从末尾接着等下一段 */
  return { text: '', offset: chunk.offset, size: st.size, mtime: st.mtimeMs };
}

/**
 * 扫描一段日志文本，挑出值得给作者看的行。
 *
 * 分类保守：/error|exception|failed|failure|denied|not found/i 算 error，
 * /mod|yarn|tech/i 算 mod，只有提到 modName 的行才降级为 info。
 * 返回 {lines: [{line, text, kind}], totals: {lines, errors, mods, mentions}}。
 */
function scanLogText(text, options) {
  const o = options && typeof options === 'object' ? options : {};
  const modName = typeof o.modName === 'string' && o.modName.trim() !== '' ? o.modName.trim() : null;
  const needle = modName === null ? null : modName.toLowerCase();
  const out = { lines: [], totals: { lines: 0, errors: 0, mods: 0, mentions: 0 } };
  const all = String(text == null ? '' : text).split(/\r?\n/);
  for (let i = 0; i < all.length; i++) {
    const line = all[i];
    out.totals.lines += 1;
    if (line.trim() === '') continue;
    const mentioned = needle !== null && line.toLowerCase().indexOf(needle) >= 0;
    if (mentioned) out.totals.mentions += 1;
    let kind = null;
    if (LOG_ERROR_RE.test(line)) kind = 'error';
    else if (LOG_MOD_RE.test(line)) kind = 'mod';
    else if (mentioned) kind = 'info';
    if (kind === null) continue;
    if (kind === 'error') out.totals.errors += 1;
    if (kind === 'mod') out.totals.mods += 1;
    out.lines.push({ line: i + 1, text: line, kind: kind });
  }
  return out;
}

/**
 * 跟随日志：从读过的偏移量开始轮询，只有新增了字节才调用
 * onProgress({text, offset, size, changed})。
 *
 * options: {path, durationMs?, intervalMs?, bytes?, clock?, sleep?}
 *   clock/sleep 可注入，测试不用真的等 5 秒。
 * 返回 {samples, offset, size, stoppedBecause}，stoppedBecause 是 "duration"
 * 或 "gone"。文件中途消失不抛：报告 gone；大小回退（日志被轮转）就从 0 重来。
 */
async function followPlayerLog(options, onProgress) {
  const o = options && typeof options === 'object' ? options : {};
  const progress = typeof onProgress === 'function' ? onProgress : function () {};
  const intervalMs = Number(o.intervalMs) > 0 ? Math.max(1, Math.floor(Number(o.intervalMs))) : LOG_POLL_MS;
  const durationMs = Number(o.durationMs) > 0 ? Math.floor(Number(o.durationMs)) : LOG_DURATION_MS;
  const clock = typeof o.clock === 'function' ? o.clock : Date.now;
  const sleep =
    typeof o.sleep === 'function'
      ? o.sleep
      : function (ms) {
          return new Promise(function (resolve) {
            setTimeout(resolve, ms);
          });
        };
  if (o.path == null || String(o.path).trim() === '') {
    return { samples: 0, offset: 0, size: 0, stoppedBecause: 'gone' };
  }

  const abs = path.resolve(String(o.path));
  const head = readLogTail(abs, { bytes: o.bytes });
  /* 从"已经读过的字节之后"开始跟：readLogTail 的 offset 是 text 的起点，
     加上 text 自身的字节数才是末尾（小文件从 0 读时尤其要这样算）。 */
  let offset = head.offset + Buffer.byteLength(head.text, 'utf8');
  let size = head.size;
  let samples = 0;
  let stoppedBecause = 'duration';
  const started = clock();
  const rounds = Math.max(1, Math.ceil(durationMs / intervalMs));

  for (let i = 0; i < rounds; i++) {
    if (i > 0 && clock() - started >= durationMs) break;
    const st = logStat(abs);
    if (st === null) {
      stoppedBecause = 'gone';
      break;
    }
    size = st.size;
    if (size < offset) offset = 0; /* 被轮转：从头再来 */
    if (size > offset) {
      const chunk = readRange(abs, offset, size);
      if (chunk === null) {
        stoppedBecause = 'gone';
        break;
      }
      offset = chunk.offset;
      samples += 1;
      progress({ text: chunk.text, offset: offset, size: size, changed: true });
    }
    if (i < rounds - 1) await sleep(intervalMs);
  }
  return { samples: samples, offset: offset, size: size, stoppedBecause: stoppedBecause };
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
  defaultLogRoots,
  discoverPlayerLog,
  readLogTail,
  scanLogText,
  followPlayerLog,
};
