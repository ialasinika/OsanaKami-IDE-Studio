'use strict';
/**
 * index.js — OsanaKami IDE Studio 的 Mod 智能层门面（host-independent facade）。
 *
 * 把 OsanaKami IDE Studio 的四个核心模块（yarn / validate / scaffold / search）
 * 与 knowledge.json 收成一个对 shell 友好的同步 API：
 *
 *   const { createMods } = require('./mods');
 *   const mods = createMods({ modsRoot: 'C:/work/mods' });
 *   mods.openMod({ dir: 'C:/work/mods/Probe' });
 *
 * 设计约束（照抄原 app/core/api.js 的行为，只做必要改动）：
 *  1. 本 Mod 自己的定义就是合法的引用目标 —— 由 validate.js 的
 *     `localTechNames()` 在 D005 判定时把 baseline[Type] ∪ 本 Mod 定义 并起来
 *     （见 validate.js:445 的注释），门面只需把 modRoot/techNames 传进去。
 *  2. 本 Mod 自己的 Yarn 节点标题必须并进 diagnoseYarn 的 nodeIndex，
 *     否则新写的 `<<jump MyNode>>` 会被 Y002 误判。
 *  3. openMod 换根时清掉所有按 root 缓存的派生状态。
 *  4. openMod 容忍缺 mod.json、容忍读不了的文件 —— 一律变成 diagnostic，不抛异常。
 *
 * 本文件是 CommonJS（仓库没有 package.json）。
 */
const fs = require('fs');
const path = require('path');

const yarnCore = require('./yarn.js');
const validateCore = require('./validate.js');
const scaffoldCore = require('./scaffold.js');
const searchCore = require('./search.js');
const completeCore = require('./complete.js');
const gamepath = require('./gamepath.js');
const knowledgeBuild = require('./knowledge-build.js');
const newfileCore = require('./newfile.js');
const importfileCore = require('./importfile.js');
const examplesCore = require('./examples.js');

/** knowledge.json 的位置（本模块同目录；发布物里可能不带，见下面的解析顺序）。 */
const KNOWLEDGE_PATH = path.join(__dirname, 'knowledge.json');

/** 用户数据目录名（与 electron/main.js 传给 shell 的 --user-dir 同名）。 */
const APP_DIR_NAME = 'OsanaKami IDE Studio';

/** 环境变量：显式指定用户数据目录 / 知识库文件（方便测试与「游戏装在怪位置」的用户）。 */
const USER_DIR_ENV = 'INFANTGOD_USER_DIR';
const KNOWLEDGE_ENV = 'INFANTGOD_KNOWLEDGE';

/**
 * 默认的用户数据目录（纯函数，env / platform 可注入，测试不碰本机真实目录）：
 *   win32   %APPDATA%/OsanaKami IDE Studio
 *   darwin  ~/Library/Application Support/OsanaKami IDE Studio
 *   其它     $XDG_DATA_HOME/OsanaKami IDE Studio（缺省 ~/.local/share/...）
 * 派生的知识库就写在这里的 knowledge.json。
 */
function defaultUserDir(env, platform) {
  const e = env && typeof env === 'object' ? env : process.env;
  const plat = platform || process.platform;
  const home = e.HOME || e.USERPROFILE || '';
  if (plat === 'win32') {
    const base = e.APPDATA || e.LOCALAPPDATA || path.join(home, 'AppData', 'Roaming');
    return path.join(base, APP_DIR_NAME);
  }
  if (plat === 'darwin') {
    return path.join(home, 'Library', 'Application Support', APP_DIR_NAME);
  }
  const base = e.XDG_DATA_HOME || path.join(home, '.local', 'share');
  return path.join(base, APP_DIR_NAME);
}

/** 原子写文本：先写同目录临时文件再 rename，避免半截知识库。 */
function writeTextAtomic(file, text) {
  const dir = path.dirname(file);
  fs.mkdirSync(dir, { recursive: true });
  const tmp = path.join(dir, '.' + path.basename(file) + '.' + process.pid + '.' + Date.now().toString(36) + '.tmp');
  fs.writeFileSync(tmp, text, 'utf8');
  try {
    fs.renameSync(tmp, file);
  } catch (e) {
    try { fs.unlinkSync(tmp); } catch { /* 已经是尽力清理 */ }
    throw e;
  }
}

/** ENOENT 在不同平台上的措辞不同；这里只用来区分「不存在」与「存在但读不了」。 */
function isMissingError(text) {
  return /ENOENT|no such file|cannot find the file|could not find/i.test(String(text == null ? '' : text));
}

/**
 * 游戏 Mods 目录不再写死。解析顺序见 gamepath.js：
 *   1. 显式 options.gameModsDir（shell 的 --game-dir / 设置项）
 *   2. 环境变量 INFANTGOD_MODS_DIR，或 INFANTGOD_GAME_DIR 下的 Mods / ModsFull/Mods
 *   3. 自动探测本机 Steam 库
 *   4. 都没有 = 「没找到」（null）：只用 knowledge.json，绝不猜路径
 */

/** #state 合法值（照抄原 api.js:284）。 */
const STATE_TAGS = [
  'Happy', 'Sad', 'Idle', 'Shy', 'Funny', 'Bored', 'Angry', 'Cold', 'Fear', 'Hate',
  'Naughty', 'Complex', 'Idol_1', 'Horror', 'Suprised', 'Confused'
];

/** Yarn 行内元数据的已知键（原 api.js:288）。 */
const KNOWN_META_KEYS = ['line', 'state', 'vo'];

/**
 * 行内标签词表（CR-105/106/107 的「合法标签」）。
 * 内建标签是语法关键字；结果标识与人格标签从 knowledge.json 的基线库派生（不写死游戏名）。
 */
const BUILTIN_TAGS = [
  'line', 'state', 'Topic', 'Check', 'Modify', 'reach', 'hub',
  'vo', 'reveal', 'checkpoint', 'resume', 'validator_ignore'
];

/** 必须带参数的标签（CR-113；`line` 单独豁免）。 */
const TAG_NEEDS_PARAM = ['state', 'Topic', 'Check', 'Modify'];

/**
 * 配对命令的动词族（CR-201/202/203 的配对表来源，不写死具体命令名）。
 * 规格的配对表（02 §5.2 模块.json 的 `pairs[].certain`）不在仓库里，这里按动词族派生：
 * 资源分配型（Add/Remove、Enable/Disable、Install/Uninstall、Equip/Unequip）→ certain，
 * 漏收尾一定会留下泄漏，报 CR-201/203（error）；
 * 状态持续型（Show/Hide、Start/Stop、Start/End、Play/Stop、Open/Close）→ 可疑，
 * 作者可能有意让状态保持到场景结束，只报 CR-202（info，带「可疑：」前缀）。
 */
const PAIR_VERBS = [
  { a: 'Add', b: 'Remove', certain: true },
  { a: 'Enable', b: 'Disable', certain: true },
  { a: 'Install', b: 'Uninstall', certain: true },
  { a: 'Equip', b: 'Unequip', certain: true },
  { a: 'Open', b: 'Close', certain: false },
  { a: 'Show', b: 'Hide', certain: false },
  { a: 'Start', b: 'Stop', certain: false },
  { a: 'Start', b: 'End', certain: false },
  { a: 'Play', b: 'Stop', certain: false }
];

const IGNORE_DIRS = new Set(['.git', '.svn', '.node_modules', 'node_modules', '__pycache__', '.vs', '.idea']);

const MAX_DEPTH = 24;

/* ================================================================== *
 * 小工具
 * ================================================================== */

function stripBom(s) {
  return typeof s === 'string' && s.charCodeAt(0) === 0xfeff ? s.slice(1) : s;
}

function toPosix(p) {
  return String(p == null ? '' : p).replace(/\\/g, '/');
}

function errText(e) {
  return e && e.message ? e.message : String(e);
}

function isDir(p) {
  try {
    return fs.statSync(p).isDirectory();
  } catch {
    return false;
  }
}

/** 读文本：永不抛异常，返回 { ok, text, error }。 */
function readText(abs) {
  try {
    return { ok: true, text: stripBom(fs.readFileSync(abs, 'utf8')), error: null };
  } catch (e) {
    return { ok: false, text: null, error: errText(e) };
  }
}

/** diagnostic 形状与 validate.js 完全一致：没有 `file` 字段。 */
function diag(severity, code, relPath, message, messageEn, schemaType) {
  return {
    severity: severity,
    code: code,
    path: toPosix(relPath),
    message: message,
    messageEn: messageEn || message,
    schemaType: schemaType || ''
  };
}

function countSeverities(diagnostics) {
  let errors = 0;
  let warnings = 0;
  let infos = 0;
  for (const d of diagnostics || []) {
    if (d.severity === 'error') errors++;
    else if (d.severity === 'warning') warnings++;
    else if (d.severity === 'info') infos++;
  }
  return { errors: errors, warnings: warnings, infos: infos };
}

/**
 * 本地化 CSV 的判定：Yarn Spinner 导出的字符串表是 `NewProject.csv` /
 * `NewProject_de.csv`，而 `NewProject-metadata.csv` 是行内元数据（`#line:`、
 * `#state:`），不是一种语言。把它算进语言数会让 `locales` 永远多一个。
 */
function isLocaleCsv(rel) {
  const base = rel.slice(rel.lastIndexOf('/') + 1);
  return /\.csv$/i.test(base) && !/-metadata\.csv$/i.test(base);
}

/**
 * 递归收集文件。永不抛异常：读不了的目录进 errors。
 * @returns {Array<{abs:string, rel:string}>}
 */
function collectFiles(dir, out, errors, depth, relBase) {  if (depth > MAX_DEPTH) return out;
  let entries;
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch (e) {
    errors.push({ rel: relBase, error: e });
    return out;
  }
  for (const e of entries) {
    const abs = path.join(dir, e.name);
    const rel = relBase ? relBase + '/' + e.name : e.name;
    if (e.isDirectory()) {
      // Hidden directories are tooling residue (`.VSCodeCounter`, `.git`), never
      // part of a shipped mod package, so they must not inflate a file count.
      if (e.name.startsWith('.') || IGNORE_DIRS.has(e.name)) continue;
      collectFiles(abs, out, errors, depth + 1, rel);
    } else if (e.isFile()) {
      out.push({ abs: abs, rel: rel });
    }
  }
  return out;
}

/** 定义对象的身份字段名（techName / TechName 都吃）。 */
function techNameOfObject(obj) {
  if (!obj || typeof obj !== 'object' || Array.isArray(obj)) return null;
  for (const key of ['techName', 'TechName']) {
    if (typeof obj[key] === 'string' && obj[key].trim()) return obj[key].trim();
  }
  return null;
}

/** 按 `\n` 数行，末尾换行不算新行；再减掉表头。 */
function countCsvRows(abs) {
  let buf;
  try {
    buf = fs.readFileSync(abs);
  } catch {
    return 0;
  }
  let nl = 0;
  for (let i = 0; i < buf.length; i++) if (buf[i] === 0x0a) nl++;
  const lines = buf.length > 0 && buf[buf.length - 1] === 0x0a ? nl : nl + 1;
  return Math.max(0, lines - 1);
}

/**
 * 这张 CSV 是不是本地化表？过滤规则与 validate.js 的 CSV 扫描一致：
 * 跳过隐藏目录（.VSCodeCounter 之类）与 metadata 表，并要求首行以 `language,` 开头。
 * 这样 localization() 报的数字才和 knowledge.json 的 localization.locales 对得上。
 */
function isLocalizationCsv(rel, firstLine) {
  if (/(^|\/)\.[^/]*\//.test('/' + rel)) return false;
  if (/metadata/i.test(path.basename(rel))) return false;
  return /^language,/i.test(String(firstLine == null ? '' : firstLine).trim());
}

/** 读 CSV 第一行（识别本地化表用）；读不了返回 null。 */
function firstLineOf(abs) {
  let text;
  try {
    text = fs.readFileSync(abs, 'utf8');
  } catch {
    return null;
  }
  const line = stripBom(text).split(/\r?\n/, 1)[0];
  return line == null ? '' : line;
}

/* ================================================================== *
 * createMods
 * ================================================================== */

/**
 * @param {object} [options]
 * @param {string} [options.knowledgePath] 显式知识库文件；给了它就是权威的（缺了也不回退）
 * @param {string} [options.bundledKnowledgePath] 打包在本模块旁的知识库（测试/打包用）
 * @param {string} [options.userDir]      用户数据目录（派生知识库写这里；缺省见 defaultUserDir）
 * @param {object} [options.env]          环境变量表（测试注入用；缺省 process.env）
 * @param {string} [options.modsRoot]      可选白名单根：所有 dir/root 参数必须落在里面
 * @param {string} [options.gameModsDir]   游戏 Mods 目录（基线 schema/定义来源）
 */
function createMods(options) {
  const opts = options && typeof options === 'object' ? options : {};

  const env = opts.env && typeof opts.env === 'object' ? opts.env : process.env;
  /**
   * 知识库解析顺序（G30）：
   *   1. options.knowledgePath —— 显式给了就只认它（缺文件 = 没有知识库，这是既有契约）
   *   2. env INFANTGOD_KNOWLEDGE
   *   3. 本模块旁的 knowledge.json（仓库/开发时就是这份）
   *   4. <userDir>/knowledge.json（上次派生的结果；mtime/size 变了会重读）
   *   5. 都没有：用 gamepath 找到的游戏目录自己派生一份，原子写进 userDir 后再用
   */
  const knowledgePath = opts.knowledgePath ? path.resolve(String(opts.knowledgePath)) : null;
  const bundledKnowledgePath = path.resolve(opts.bundledKnowledgePath ? String(opts.bundledKnowledgePath) : KNOWLEDGE_PATH);
  const userDir = path.resolve(String(
    opts.userDir != null && opts.userDir !== '' ? opts.userDir : (env[USER_DIR_ENV] || defaultUserDir(env))
  ));
  const modsRoot = opts.modsRoot ? path.resolve(String(opts.modsRoot)) : null;
  const gameMods = gamepath.discoverGameModsDir({
    gameModsDir: opts.gameModsDir != null ? opts.gameModsDir : opts.gameDir,
    env: env
  });
  /** 最终实际用的是哪份知识库（路径 + 来源），knowledgeState() 会报出去。 */
  const knowledgeSource = {
    source: knowledgePath ? 'option' : 'bundled',
    path: knowledgePath || bundledKnowledgePath,
    userDir: userDir,
    deriveError: null
  };
  /** 游戏 Mods 目录；null = 本机没找到（「没找到」本身也是要报出来的状态）。 */
  const gameModsDir = gameMods.dir;

  /** 所有按 root 缓存的派生状态；openMod 换根时整块清掉。 */
  const cache = {
    kb: null,
    kbMeta: null,
    kbView: null,
    index: null,
    root: null,
    manifest: null,
    mod: null,
    nodeTitlesByRoot: new Map(),
    modIndexByRoot: new Map(),
    pairs: null
  };

  /* ---------------- 路径护栏 ---------------- */

  /**
   * 把调用方给的 dir/root 参数解析成绝对路径；设了 modsRoot 时拒绝越界。
   * 越界抛 `code === 'EOUTSIDE'`，消息用调用方原样给的字符串。
   *
   * 相对路径按 modsRoot 解析，不按进程 cwd。`--mods-root` 的语义就是
   * 「mod 包都放在这个目录下」，所以卡片里的 `MyMod` 指的必然是
   * `<modsRoot>/MyMod`。若按 cwd 解析，`serve` 的 cwd 一旦与被服务的
   * workspace 不同（这是常态），根内的包就会被判成越界 —— 界面上的表现
   * 是 mod 卡直接报「路径越界，已拒绝: MyMod」，而包其实就在根里。
   *
   * 绝对路径不受影响：path.resolve 遇到绝对路径会忽略它前面的基准。
   */
  function resolveArg(value, label) {
    const raw = String(value == null ? '' : value);
    const abs = modsRoot ? path.resolve(modsRoot, raw) : path.resolve(raw);
    if (modsRoot) {
      const rel = path.relative(modsRoot, abs);
      const outside = rel !== '' && (rel === '..' || rel.startsWith('..' + path.sep) || path.isAbsolute(rel));
      if (outside) {
        const err = new Error('路径越界，已拒绝: ' + raw);
        err.code = 'EOUTSIDE';
        err.arg = raw;
        err.label = label || null;
        throw err;
      }
    }
    return abs;
  }

  /* ---------------- 知识库 ---------------- */

  /** 结构完整的空壳知识库；loadError 说明为什么没有事实可用。 */
  function emptyKb(loadError) {
    return {
      version: 0,
      stats: {},
      commands: [],
      functions: [],
      variables: [],
      nodes: [],
      schemas: {},
      baseline: {},
      localization: { locales: [], characters: [] },
      undocumentedCommands: [],
      undeclaredVariables: [],
      loadError: loadError
    };
  }

  /** 记住一份从磁盘读到的知识库（含 mtime/size，用于之后判断要不要重读）。 */
  function rememberKb(kb, source, file) {
    knowledgeSource.source = source;
    knowledgeSource.path = file;
    cache.kb = kb;
    try {
      const st = fs.statSync(file);
      cache.kbMeta = { path: file, mtimeMs: st.mtimeMs, size: st.size };
    } catch {
      cache.kbMeta = null;
    }
    return cache.kb;
  }

  /** 解析并（必要时）派生知识库；结果进 cache。 */
  function resolveKnowledge() {
    const candidates = [];
    if (knowledgePath) {
      candidates.push({ path: knowledgePath, source: 'option' });
    } else {
      const envPath = env[KNOWLEDGE_ENV] ? path.resolve(String(env[KNOWLEDGE_ENV])) : null;
      if (envPath) candidates.push({ path: envPath, source: 'env' });
      candidates.push({ path: bundledKnowledgePath, source: 'bundled' });
      candidates.push({ path: path.join(userDir, 'knowledge.json'), source: 'user' });
    }

    let chosen = null;
    for (const candidate of candidates) {
      const r = readText(candidate.path);
      if (r.ok) {
        chosen = { path: candidate.path, source: candidate.source, text: r.text };
        break;
      }
      if (!isMissingError(r.error)) {
        // 文件在那儿但读不了：明确 loadError，绝不静默当空 KB，也不去派生盖掉它。
        knowledgeSource.source = candidate.source;
        knowledgeSource.path = candidate.path;
        cache.kb = emptyKb('knowledge.json 读不出来：' + r.error);
        return cache.kb;
      }
    }

    if (!chosen) {
      // 四个位置都没有：自己从游戏目录派生一份（G31）。
      const target = path.join(userDir, 'knowledge.json');
      if (gameModsDir) {
        try {
          const derived = knowledgeBuild.buildKnowledge(gameModsDir);
          writeTextAtomic(target, JSON.stringify(derived, null, 2) + '\n');
          return rememberKb(derived, 'derived', target);
        } catch (e) {
          knowledgeSource.deriveError = errText(e);
        }
      }
      knowledgeSource.source = 'missing';
      knowledgeSource.path = knowledgePath || target;
      cache.kb = emptyKb(
        knowledgeSource.deriveError
          ? 'knowledge.json 不存在，从游戏目录派生也失败了：' + knowledgeSource.deriveError
          : 'knowledge.json 不存在，而且本机没找到游戏的 Mods 目录，无法派生'
      );
      return cache.kb;
    }

    try {
      return rememberKb(JSON.parse(chosen.text), chosen.source, chosen.path);
    } catch (e) {
      knowledgeSource.source = chosen.source;
      knowledgeSource.path = chosen.path;
      cache.kb = emptyKb('knowledge.json 不是合法 JSON：' + errText(e));
      return cache.kb;
    }
  }

  /** knowledge.json 的原样对象（必要时给一个结构完整的空壳）。 */
  function knowledge() {
    if (cache.kb) {
      // 自上次读取后文件被换过（mtime/size 变了）就重读；派生出来的那份同样适用。
      if (cache.kbMeta && cache.kbMeta.path) {
        let changed = false;
        try {
          const st = fs.statSync(cache.kbMeta.path);
          changed = st.mtimeMs !== cache.kbMeta.mtimeMs || st.size !== cache.kbMeta.size;
        } catch {
          changed = true;
        }
        if (changed) {
          cache.kb = null;
          cache.kbMeta = null;
          cache.kbView = null;
          cache.index = null;
        }
      }
      if (cache.kb) return cache.kb;
    }
    return resolveKnowledge();
  }

  /**
   * 校验用的知识库视图：knowledge.json ∪ gameModsDir 里缺的那部分。
   *
   * 正常情况下 knowledge.json 已经带齐 51 个 schema / 1305 条基线定义，这里什么都不加；
   * 只有当某个类型在 knowledge.json 里缺失（自定义 knowledgePath、精简知识库）时，
   * 才去 <gameModsDir>/SODefines/{Schema,Defines}/ 补上，这样"Mod 不带自己的 schema"
   * 也能被正确校验。绝不修改 knowledge() 返回的原对象。
   */
  function kbView() {
    const base = knowledge();
    if (cache.kbView && cache.kbView.base === base) return cache.kbView.kb;

    const schemas = Object.assign({}, base.schemas || {});
    const baseline = Object.assign({}, base.baseline || {});
    let touched = false;

    const schemaDir = gameModsDir ? path.join(gameModsDir, 'SODefines', 'Schema') : null;
    if (schemaDir && isDir(schemaDir)) {
      let names = [];
      try {
        names = fs.readdirSync(schemaDir).filter((f) => /\.schema\.json$/i.test(f));
      } catch {
        names = [];
      }
      for (const f of names) {
        const type = f.replace(/\.schema\.json$/i, '');
        if (Object.prototype.hasOwnProperty.call(schemas, type)) continue;
        const r = readText(path.join(schemaDir, f));
        if (!r.ok) continue;
        try {
          schemas[type] = JSON.parse(r.text);
          touched = true;
        } catch {
          /* 坏 schema 忽略：校验时按"未知类型"报出来 */
        }
      }
    }

    const definesDir = gameModsDir ? path.join(gameModsDir, 'SODefines', 'Defines') : null;
    if (definesDir && isDir(definesDir)) {
      let typeDirs = [];
      try {
        typeDirs = fs.readdirSync(definesDir, { withFileTypes: true }).filter((e) => e.isDirectory());
      } catch {
        typeDirs = [];
      }
      for (const e of typeDirs) {
        const type = e.name;
        const have = Array.isArray(baseline[type]) ? baseline[type].length : 0;
        if (have > 0) continue;
        const list = [];
        const errs = [];
        collectFiles(path.join(definesDir, type), [], errs, 0, type);
        const files = [];
        collectFiles(path.join(definesDir, type), files, errs, 0, type);
        for (const f of files) {
          if (!/\.json$/i.test(f.abs)) continue;
          const r = readText(f.abs);
          if (!r.ok) continue;
          try {
            const name = techNameOfObject(JSON.parse(r.text));
            if (name) list.push(name);
          } catch {
            /* 坏 JSON 交给校验阶段报 */
          }
        }
        if (list.length) {
          baseline[type] = list;
          touched = true;
        }
      }
    }

    const view = touched
      ? Object.assign({}, base, { schemas: schemas, baseline: baseline })
      : base;
    cache.kbView = { base: base, kb: view };
    return view;
  }

  function stats() {
    return knowledge().stats || {};
  }

  function types() {
    const kb = knowledge();
    const schemas = kb.schemas && typeof kb.schemas === 'object' ? kb.schemas : {};
    const baseline = kb.baseline && typeof kb.baseline === 'object' ? kb.baseline : {};
    const names = [];
    const seen = new Set();
    for (const t of Object.keys(baseline)) if (!seen.has(t)) { seen.add(t); names.push(t); }
    for (const t of Object.keys(schemas)) if (!seen.has(t)) { seen.add(t); names.push(t); }
    names.sort();
    return names.map((type) => {
      const schema = schemas[type] && typeof schemas[type] === 'object' ? schemas[type] : null;
      const props = schema && schema.properties && typeof schema.properties === 'object'
        ? Object.keys(schema.properties).sort()
        : [];
      const list = Array.isArray(baseline[type]) ? baseline[type] : [];
      return {
        type: type,
        count: list.length,
        required: schema && Array.isArray(schema.required) ? schema.required.slice() : [],
        properties: props,
        hasSchema: Object.prototype.hasOwnProperty.call(schemas, type)
      };
    });
  }

  /** 知识库里的角色；没有 localization.characters 就是 []。 */
  function characters() {
    const kb = knowledge();
    const loc = kb.localization && typeof kb.localization === 'object' ? kb.localization : {};
    const list = Array.isArray(loc.characters) ? loc.characters : [];
    return list.map((c) => ({
      techName: c && c.name != null ? String(c.name) : '',
      nameKey: c && c.displayName != null ? String(c.displayName) : (c && c.name != null ? String(c.name) : ''),
      colour: c && c.colour != null ? String(c.colour) : '',
      name: c && c.name != null ? String(c.name) : '',
      displayName: c && c.displayName != null ? c.displayName : null
    }));
  }

  /* ---------------- 检索 / 文档 / 补全 ---------------- */

  function index() {
    if (!cache.index) cache.index = searchCore.buildIndex(knowledge());
    return cache.index;
  }

  function search(params) {
    const p = params && typeof params === 'object' ? params : {};
    const sopts = {};
    if (p.limit != null) sopts.limit = Number(p.limit);
    if (Array.isArray(p.kinds)) sopts.kinds = p.kinds;
    return searchCore.search(index(), p.query, sopts) || [];
  }

  function docFor(params) {
    const p = params && typeof params === 'object' ? params : {};
    const doc = searchCore.docFor(index(), p.kind, p.name);
    return doc == null ? '' : String(doc);
  }

  /**
   * 补全候选。返回 items 数组（门面签名是 `-> [...]`）；
   * `isIncomplete` 作为不可枚举属性挂在数组上，JSON 序列化不会带上它。
   */
  function suggest(params) {
    const p = params && typeof params === 'object' ? params : {};
    const res = searchCore.suggest(index(), p.prefix, p.context, p.opts || {}) || {};
    const items = Array.isArray(res.items) ? res.items : [];
    Object.defineProperty(items, 'isIncomplete', {
      value: !!res.isIncomplete,
      enumerable: false,
      configurable: true,
      writable: true
    });
    return items;
  }

  /**
   * 补全：`mod.complete` 的实现。`text` 是**正在编辑的文档**（不是磁盘文件），
   * `caret` 是 0-based UTF-16 偏移。返回 `{context, items, isIncomplete}`。
   * 落盘与否不参与判定 —— 编辑器可以拿未保存的文本直接问。
   * 上下文分类与候选列表分别由 complete.js（哪一段被编辑）与 search.js（候选从哪来）负责，
   * 这里只把两者接到 knowledge() 建出的索引上，不重复实现。
   */
  function completeYarn(params) {
    const p = params && typeof params === 'object' ? params : {};
    const text = typeof p.text === 'string' ? p.text : '';
    const caret = typeof p.caret === 'number' ? p.caret : 0;
    const res = completeCore.complete(text, caret, index(), {
      limit: typeof p.limit === 'number' ? p.limit : 200
    }) || {};
    return {
      context: res.context || {},
      items: Array.isArray(res.items) ? res.items : [],
      isIncomplete: !!res.isIncomplete
    };
  }

  /**
   * 悬停：`mod.hover` 的实现。返回 `{range, kind, name, contents} | null`。
   * 没把握时返回 null 而不是编一段 —— 空的悬停比错的好（complete.js 的解析顺序）。
   */
  function hoverYarn(params) {
    const p = params && typeof params === 'object' ? params : {};
    const text = typeof p.text === 'string' ? p.text : '';
    const caret = typeof p.caret === 'number' ? p.caret : 0;
    return completeCore.hover(text, caret, index());
  }

  /* ---------------- 打开 Mod ---------------- */

  /**
   * 扫描一个 Mod 文件夹。永不抛异常（除非路径越界，那在 resolveArg 里就出去了）：
   * 读不了的文件/目录都变成 diagnostic。
   */
  function scanMod(root) {
    const diagnostics = [];
    const files = [];
    const walkErrors = [];

    if (!isDir(root)) {
      diagnostics.push(diag('error', 'OPEN001', '', '不是文件夹: ' + root, 'Not a directory: ' + root));
      return {
        root: root,
        manifest: null,
        defines: [],
        yarnFiles: [],
        csvFiles: [],
        sprites: [],
        nodeTitles: [],
        defineTechNames: {},
        summary: { files: 0, totalFiles: 0, defines: 0, yarn: 0, csv: 0, sprites: 0, types: [], diagnostics: 1 },
        diagnostics: diagnostics
      };
    }

    collectFiles(root, files, walkErrors, 0, '');
    files.sort((a, b) => (a.rel < b.rel ? -1 : a.rel > b.rel ? 1 : 0));
    for (const e of walkErrors) {
      diagnostics.push(diag('warning', 'OPEN002', e.rel,
        '文件夹无法读取：' + errText(e.error),
        'Directory cannot be read: ' + errText(e.error)));
    }

    /* mod.json：缺失/读不了/坏 JSON 都只报 diagnostic，不抛。 */
    let manifest = null;
    const manifestAbs = path.join(root, 'mod.json');
    if (!fs.existsSync(manifestAbs)) {
      diagnostics.push(diag('error', 'M001', 'mod.json',
        '缺少 mod.json：Mod 包根目录必须有 mod.json。',
        'Missing mod.json: a mod package must have mod.json in its root.'));
    } else {
      const r = readText(manifestAbs);
      if (!r.ok) {
        diagnostics.push(diag('error', 'M001', 'mod.json',
          'mod.json 无法读取：' + r.error,
          'mod.json cannot be read: ' + r.error));
      } else {
        try {
          manifest = JSON.parse(r.text);
          if (!manifest || typeof manifest !== 'object' || Array.isArray(manifest)) {
            diagnostics.push(diag('error', 'M001', 'mod.json',
              'mod.json 顶层必须是 JSON 对象。',
              'mod.json must be a JSON object at the top level.'));
            manifest = null;
          }
        } catch (e) {
          diagnostics.push(diag('error', 'M001', 'mod.json',
            'mod.json 不是合法 JSON：' + errText(e),
            'mod.json is not valid JSON: ' + errText(e)));
          manifest = null;
        }
      }
    }

    const yarnFiles = [];
    const csvFiles = [];
    const sprites = [];
    const defines = [];
    const defineTechNames = {};
    const typesSeen = new Set();
    const nodeTitles = [];
    const nodeSeen = new Set();

    for (const f of files) {
      const rel = toPosix(f.rel);
      if (/\.yarn$/i.test(rel)) {
        yarnFiles.push(rel);
        const r = readText(f.abs);
        if (!r.ok) {
          diagnostics.push(diag('warning', 'M011', rel,
            'Yarn 文件无法以 UTF-8 读取：' + r.error,
            'Yarn file cannot be read as UTF-8: ' + r.error));
          continue;
        }
        for (const name of nodeNamesFromText(r.text)) {
          if (name && !nodeSeen.has(name)) { nodeSeen.add(name); nodeTitles.push(name); }
        }
        continue;
      }
      if (isLocaleCsv(rel)) csvFiles.push(rel);
      if (/^Sprites\//i.test(rel)) sprites.push(rel);

      const dm = /^Defines\/([^/]+)\/(.+\.json)$/i.exec(rel);
      if (dm) {
        const type = dm[1];
        let techName = null;
        const r = readText(f.abs);
        if (!r.ok) {
          diagnostics.push(diag('error', 'M010', rel,
            '定义文件无法读取：' + r.error,
            'Definition file cannot be read: ' + r.error, type));
        } else {
          try {
            techName = techNameOfObject(JSON.parse(r.text));
          } catch (e) {
            diagnostics.push(diag('error', 'M010', rel,
              '定义文件不是合法 JSON：' + errText(e),
              'Definition file is not valid JSON: ' + errText(e), type));
          }
        }
        defines.push({ type: type, techName: techName, file: rel });
        if (!defineTechNames[type]) defineTechNames[type] = [];
        if (techName) defineTechNames[type].push(techName);
        typesSeen.add(type);
      }
    }

    defines.sort((a, b) => (a.file < b.file ? -1 : a.file > b.file ? 1 : 0));

    const summary = {
      files: files.length,
      totalFiles: files.length,
      defines: defines.length,
      yarn: yarnFiles.length,
      csv: csvFiles.length,
      sprites: sprites.length,
      types: [...typesSeen].sort(),
      diagnostics: diagnostics.length
    };

    return {
      root: root,
      manifest: manifest,
      defines: defines,
      yarnFiles: yarnFiles,
      csvFiles: csvFiles,
      sprites: sprites,
      nodeTitles: nodeTitles,
      defineTechNames: defineTechNames,
      summary: summary,
      diagnostics: diagnostics
    };
  }

  /**
   * 打开一个 Mod 文件夹。
   * 换根时清掉所有按 root 缓存的派生状态（节点表、manifest、扫描结果）。
   */
  function openMod(params) {
    const p = params && typeof params === 'object' ? params : {};
    const dir = p.dir != null ? p.dir : p.root;
    if (dir == null || String(dir).trim() === '') throw new Error('openMod: dir is required');

    const root = resolveArg(dir, 'dir');
    if (cache.root !== root) invalidateForRoot();

    const info = scanMod(root);

    cache.root = root;
    cache.manifest = info.manifest;
    cache.mod = info;
    cache.nodeTitlesByRoot.set(root, info.nodeTitles);

    return {
      root: root,
      manifest: info.manifest,
      defines: info.defines,
      yarnFiles: info.yarnFiles,
      csvFiles: info.csvFiles,
      sprites: info.sprites,
      summary: info.summary,
      diagnostics: info.diagnostics
    };
  }

  /** 丢弃所有按 root 缓存的状态。 */
  function invalidateForRoot() {
    cache.root = null;
    cache.manifest = null;
    cache.mod = null;
    cache.nodeTitlesByRoot.clear();
  }

  function requireRoot() {
    if (!cache.root) {
      const err = new Error('尚未打开任何 Mod 文件夹');
      err.code = 'ENOMOD';
      throw err;
    }
    return cache.root;
  }

  /**
   * 一段 .yarn 文本里声明的节点名：title，或 title.subtitle（规格 §3「节点」条）。
   * 只收 title 会让 `visited("Title.Sub")` / `jump Title.Sub` 这类引用被误判成缺节点。
   */
  function nodeNamesFromText(text) {
    const out = [];
    const lines = String(text || '').split(/\r?\n/);
    for (let i = 0; i < lines.length; i++) {
      const m = /^[ \t]*title[ \t]*:[ \t]*(.+?)[ \t]*$/.exec(lines[i]);
      if (!m) continue;
      const t = m[1].trim();
      if (!t) continue;
      let sub = null;
      for (let j = i + 1; j < lines.length; j++) {
        const l = lines[j].trim();
        if (/^-{3,}\s*$/.test(l)) break;
        const sm = /^subtitle[ \t]*:[ \t]*(.*)$/.exec(l);
        if (sm) { sub = sm[1].trim() || null; break; }
      }
      if (sub) out.push(t, t + '.' + sub);
      else out.push(t);
    }
    return out;
  }

  /** 某个 root 下所有 .yarn 声明过的节点标题（按 root 缓存）。 */
  function localNodeTitles(root) {
    if (!root) return [];
    if (cache.nodeTitlesByRoot.has(root)) return cache.nodeTitlesByRoot.get(root);
    const titles = [];
    const seen = new Set();
    const files = [];
    const errs = [];
    collectFiles(root, files, errs, 0, '');
    for (const f of files) {
      if (!/\.yarn$/i.test(f.rel)) continue;
      const r = readText(f.abs);
      if (!r.ok) continue;
      for (const name of nodeNamesFromText(r.text)) {
        if (name && !seen.has(name)) { seen.add(name); titles.push(name); }
      }
    }
    cache.nodeTitlesByRoot.set(root, titles);
    return titles;
  }

  /** 读一个 .yarn 节点头里的 subtitle / when（CR-115/116 的组成员数据）。 */
  function nodeHeaderInfo(text, headerLine) {
    const lines = String(text || '').split(/\r?\n/);
    const out = { subtitle: null, subtitleLine: 0, when: null };
    for (let i = (headerLine || 1) - 1; i < lines.length; i++) {
      const t = lines[i].trim();
      if (i > (headerLine || 1) - 1 && /^-{3,}\s*$/.test(t)) break;
      let m = /^subtitle\s*:\s*(.*)$/.exec(t);
      if (m) { out.subtitle = m[1].trim() || null; out.subtitleLine = i + 1; continue; }
      m = /^when\s*:\s*(.*)$/.exec(t);
      if (m) out.when = m[1].trim() || null;
    }
    return out;
  }

  /**
   * 一个 Mod 包内的跨文件索引（按 root 缓存）：
   *   declarations {name:{file,line}}、nodeGroups Map(title → members)、
   *   commands [{name,file,line,args}]、characters Set(techName)、modNames []。
   * 供 CR-104 / CR-115 / CR-116 / CR-201..203 / CR-114 / CR-105 使用。
   */
  function localModIndex(root) {
    if (!root) return null;
    if (cache.modIndexByRoot.has(root)) return cache.modIndexByRoot.get(root);
    const files = [];
    const errs = [];
    collectFiles(root, files, errs, 0, '');
    files.sort((a, b) => (a.rel < b.rel ? -1 : a.rel > b.rel ? 1 : 0));
    const declarations = {};
    const groups = new Map();
    const commands = [];
    const characters = new Set();
    for (const f of files) {
      if (/\.yarn$/i.test(f.rel)) {
        const r = readText(f.abs);
        if (!r.ok) continue;
        let parsed = null;
        try { parsed = yarnCore.parseYarn(r.text, { fileName: f.rel }); } catch { parsed = null; }
        if (!parsed) continue;
        for (const node of parsed.nodes || []) {
          if (!node || !node.title) continue;
          const head = nodeHeaderInfo(r.text, node.headerLine);
          if (!groups.has(node.title)) groups.set(node.title, []);
          groups.get(node.title).push({
            file: f.rel,
            line: node.headerLine,
            subtitleLine: head.subtitleLine || node.headerLine,
            subtitle: head.subtitle,
            when: head.when
          });
          for (const d of node.declarations || []) {
            if (d && d.name && !Object.prototype.hasOwnProperty.call(declarations, d.name)) {
              declarations[d.name] = { file: f.rel, line: d.line };
            }
          }
          for (const c of node.commands || []) {
            commands.push({ name: c.name, file: f.rel, line: c.line, args: c.args || '' });
          }
        }
      } else if (/^Defines\/Character\/[^/]+\.json$/i.test(f.rel)) {
        try {
          const obj = JSON.parse(stripBom(fs.readFileSync(f.abs, 'utf8')));
          if (obj && typeof obj.techName === 'string' && obj.techName) characters.add(obj.techName);
        } catch {
          /* 坏 JSON 由 validate 报，这里静默 */
        }
      }
    }
    // 同级目录名也是合法标签（`#MyMod` 这类 mod 命名空间标签）
    const modNames = [];
    try {
      for (const e of fs.readdirSync(path.dirname(root), { withFileTypes: true })) {
        if (e.isDirectory() && !e.name.startsWith('.')) modNames.push(e.name);
      }
    } catch {
      /* 读不到父目录就算了 */
    }
    const info = { declarations, groups, commands, characters, modNames };
    cache.modIndexByRoot.set(root, info);
    return info;
  }

  /** 由基线库派生结果标识标签（`Result_X` → `X`）与人格标签（`Attr` 名 + `W_` 前缀）。 */
  function tagVocabulary(kb) {
    const baseline = (kb && kb.baseline) || {};
    const result = (baseline.Result || [])
      .map((n) => String(n).replace(/^Result_/, ''))
      .filter(Boolean);
    const attr = (baseline.Attr || []).map((n) => String(n)).filter(Boolean);
    const personality = attr.concat(attr.map((n) => 'W_' + n));
    return { builtin: BUILTIN_TAGS.slice(), result, personality };
  }

  /** 角色名集合：基线库 Character ∪ 本地化角色表 ∪ 本 Mod 自己定义的 Character。 */
  function characterNames(kb, idx) {
    const set = new Set();
    const baseline = (kb && kb.baseline) || {};
    for (const n of baseline.Character || []) set.add(String(n));
    const locChars = kb && kb.localization ? kb.localization.characters : null;
    if (Array.isArray(locChars)) {
      for (const c of locChars) {
        if (typeof c === 'string') set.add(c);
        else if (c && typeof c === 'object' && c.name) set.add(String(c.name));
      }
    } else if (locChars && typeof locChars === 'object') {
      for (const k of Object.keys(locChars)) set.add(k);
    }
    if (idx && idx.characters) for (const n of idx.characters) set.add(n);
    return Array.from(set);
  }

  /**
   * 配对命令表（CR-201/202/203）：用动词族在 knowledge.json 的命令名里找成对命令，
   * 不写死任何具体命令名。确定型/可疑型由动词族决定（见 PAIR_VERBS 注释）。
   */
  function commandPairs(kb) {
    if (cache.pairs) return cache.pairs;
    const names = new Set();
    for (const c of (kb && kb.commands) || []) if (c && c.name) names.add(c.name);
    for (const c of (kb && kb.undocumentedCommands) || []) if (c && c.name) names.add(c.name);
    const out = [];
    const seen = new Set();
    for (const verb of PAIR_VERBS) {
      for (const n of names) {
        if (n.slice(0, verb.a.length) !== verb.a) continue;
        const partner = verb.b + n.slice(verb.a.length);
        if (!names.has(partner)) continue;
        const key = n + '\u0000' + partner;
        if (seen.has(key)) continue;
        seen.add(key);
        out.push({ start: n, end: partner, certain: verb.certain, why: verb.a + '/' + verb.b });
      }
    }
    out.sort((a, b) => (a.start < b.start ? -1 : a.start > b.start ? 1 : 0));
    cache.pairs = out;
    return out;
  }

  /* ---------------- Yarn 诊断 ---------------- */

  function buildDiagnoseContext(kb, fileName, root) {
    const commands = {};
    for (const c of kb.commands || []) commands[c.name] = c;
    for (const c of kb.undocumentedCommands || []) {
      if (!commands[c.name]) commands[c.name] = { name: c.name, parameters: [], documentation: '' };
    }
    const functions = {};
    for (const f of kb.functions || []) functions[f.name] = f;
    const variables = {};
    for (const v of kb.variables || []) variables[v.name] = v.type;
    for (const v of kb.undeclaredVariables || []) if (!variables[v.name]) variables[v.name] = 'number';
    const nodeIndex = {};
    for (const n of kb.nodes || []) nodeIndex[n.title] = n.file;

    // 跨文件索引（本 Mod 包）：声明、节点组、命令用法、角色名
    const idx = localModIndex(root);

    // CR-104：全局声明索引 = 游戏基线（knowledge.json 的 variables）∪ 本 Mod 的 declare
    const declarations = {};
    for (const v of kb.variables || []) {
      if (v && v.name) declarations[v.name] = { file: '', line: 0 };
    }
    if (idx) {
      for (const name of Object.keys(idx.declarations)) {
        declarations[name] = idx.declarations[name];
      }
    }

    return {
      fileName: fileName,
      commands: commands,
      functions: functions,
      variables: variables,
      nodeIndex: nodeIndex,
      stateTags: STATE_TAGS.slice(),
      knownMetaKeys: KNOWN_META_KEYS.slice(),
      characters: characterNames(kb, idx),
      tagVocabulary: tagVocabulary(kb),
      modNames: idx ? idx.modNames : [],
      declarations: declarations,
      nodeGroups: idx ? idx.groups : null,
      modCommands: idx ? idx.commands : null,
      pairs: commandPairs(kb),
      checks: { defines: true, variables: true, nodes: true }
    };
  }

  /**
   * 诊断一份 Yarn 文本。
   * nodeIndex = 知识库 1221 个节点 ∪ 本 Mod 其他 .yarn 的节点 ∪ 本文件自己的节点。
   * root 缺省时用当前打开的 Mod。
   */
  function diagnoseYarn(params) {
    const p = params && typeof params === 'object' ? params : {};
    const text = typeof p.text === 'string' ? p.text : (p.text == null ? '' : String(p.text));
    const fileName = p.fileName ? String(p.fileName) : 'untitled.yarn';

    let root = null;
    const rootArg = p.root != null ? p.root : cache.root;
    if (rootArg != null && String(rootArg).trim() !== '') root = resolveArg(rootArg, 'root');

    const kb = knowledge();
    const ctx = buildDiagnoseContext(kb, fileName, root);
    // 磁盘索引里存的是 Mod 内相对路径；把调用方给的（可能是绝对的）fileName 归一成同一把钥匙，
    // 否则「当前文件」会被误当成另一个文件而重复计入节点组/命令/声明（§11.5 的并入语义）。
    if (root) {
      const rel = path.relative(root, fileName);
      if (rel && !rel.startsWith('..') && !path.isAbsolute(rel)) {
        ctx.fileKey = rel.split(path.sep).join('/');
      }
    }
    // 宿主/测试可以覆盖任意上下文（例如 §11.1 开关、空索引夹具）
    if (p.context && typeof p.context === 'object') {
      for (const k of Object.keys(p.context)) ctx[k] = p.context[k];
    } else if (p.checks && typeof p.checks === 'object') {
      ctx.checks = Object.assign({ defines: true, variables: true, nodes: true }, p.checks);
    }
    for (const t of localNodeTitles(root)) {
      if (!ctx.nodeIndex[t]) ctx.nodeIndex[t] = '';
    }

    let nodes = [];
    try {
      nodes = (yarnCore.parseYarn(text, { fileName: fileName }).nodes || []).map((n) => ({
        title: n.title,
        subtitle: n.subtitle || null,
        tags: n.tags,
        line: n.headerLine,
        endLine: n.bodyEndLine
      }));
    } catch {
      /* 解析失败时只保留诊断 */
    }
    for (const n of nodes) {
      if (!n.title) continue;
      if (!ctx.nodeIndex[n.title]) ctx.nodeIndex[n.title] = fileName;
      const full = n.subtitle ? n.title + '.' + n.subtitle : null;
      if (full && !ctx.nodeIndex[full]) ctx.nodeIndex[full] = fileName;
    }

    let diagnostics = [];
    try {
      diagnostics = yarnCore.diagnose(text, ctx) || [];
    } catch (e) {
      diagnostics = [{
        severity: 'error', code: 'Y900', line: 1, col: 1,
        message: '解析器异常: ' + errText(e), source: 'yarn'
      }];
    }
    return { available: true, diagnostics: diagnostics, nodes: nodes };
  }

  /* ---------------- 定义校验 ---------------- */

  /**
   * 校验一份定义文本。errors/warnings/infos 是计数（同 validate.js 的 countSeverities），
   * 完整诊断在 diagnostics 里。
   */
  function validateDefineText(params) {
    const p = params && typeof params === 'object' ? params : {};
    const type = p.type == null ? '' : String(p.type);
    const text = typeof p.text === 'string' ? p.text : (p.text == null ? '' : String(p.text));
    const relPath = p.relPath ? String(p.relPath) : null;

    let obj;
    try {
      obj = JSON.parse(stripBom(text));
    } catch (e) {
      const d = [diag('error', 'JSON001', '(root)',
        'JSON 解析失败：' + errText(e),
        'JSON parse error: ' + errText(e), type)];
      return { errors: 1, warnings: 0, infos: 0, diagnostics: d };
    }

    const diagnostics = validateCore.validateDefine(type, obj, {
      kb: kbView(),
      modRoot: cache.root || undefined,
      filePath: relPath || undefined,
      fileName: relPath ? path.basename(relPath) : undefined
    }) || [];

    const counts = countSeverities(diagnostics);
    return {
      errors: counts.errors,
      warnings: counts.warnings,
      infos: counts.infos,
      diagnostics: diagnostics
    };
  }

  /* ---------------- 整包校验 ---------------- */

  /** 游戏 Mods 目录里已安装的 Mod（loadOrder 冲突检测用）。 */
  function listInstalledMods() {
    const out = [];
    if (!isDir(gameModsDir)) return out;
    let entries = [];
    try {
      entries = fs.readdirSync(gameModsDir, { withFileTypes: true });
    } catch {
      return out;
    }
    for (const e of entries) {
      if (!e.isDirectory()) continue;
      const full = path.join(gameModsDir, e.name);
      const mf = path.join(full, 'mod.json');
      if (!fs.existsSync(mf)) continue;
      const r = readText(mf);
      let manifest = null;
      if (r.ok) {
        try { manifest = JSON.parse(r.text); } catch { manifest = null; }
      }
      out.push({ dir: full, name: e.name, manifest: manifest });
    }
    return out;
  }

  /**
   * 校验整个 Mod 包。
   * 「本 Mod 自己的定义算合法引用目标」由 validate.js 的 ctx.techNames /
   * localTechNames 保证（D005 的目标集合 = baseline[Type] ∪ 本 Mod 定义）。
   */
  function validatePackage(params) {
    const p = params && typeof params === 'object' ? params : {};
    const rootArg = p.root != null ? p.root : requireRoot();
    const root = resolveArg(rootArg, 'root');
    const result = validateCore.validateModPackage(root, {
      kb: kbView(),
      otherMods: listInstalledMods(),
      // G3：读不到游戏 Mods 目录时，跨 Mod 的检查要显式说明被跳过（M012）
      gameMods: { dir: gameModsDir, readable: isDir(gameModsDir) }
    });
    return {
      ok: !!result.ok,
      knowledge: result.knowledge === 'present' ? 'present' : 'missing',
      manifest: result.manifest,
      summary: result.summary,
      diagnostics: result.diagnostics,
      types: result.types
    };
  }

  /* ---------------- 脚手架 ---------------- */

  /**
   * 生成一个 Mod 包（异步，同 scaffold.scaffoldMod）。
   * @returns {Promise<{modRoot:string, created:string[], warnings:string[]}>}
   */
  async function scaffold(params) {
    const p = params && typeof params === 'object' ? params : {};
    const dir = p.dir != null ? p.dir : p.destDir;
    if (dir == null || String(dir).trim() === '') throw new Error('scaffold: dir is required');

    const destRoot = resolveArg(dir, 'dir');
    // 脚手架只读知识库里的模板/角色事实；用「实际生效的那份」（可能是派生出来的）。
    knowledge();
    const sopts = { knowledgePath: knowledgeSource.path || bundledKnowledgePath };
    if (p.modName != null) sopts.modName = p.modName;
    if (p.template != null) sopts.template = p.template;
    if (gameModsDir) sopts.gameModsDir = gameModsDir;
    for (const key of ['version', 'gameVersion', 'loadOrder', 'author', 'description',
      'baseLanguage', 'locales', 'characters', 'overwrite']) {
      if (p[key] !== undefined) sopts[key] = p[key];
    }

    const r = await scaffoldCore.scaffoldMod(destRoot, sopts);
    resolveArg(r.modRoot, 'modRoot'); // 生成结果也必须落在 modsRoot 里
    invalidateForRoot(); // 目录树变了，按 root 的缓存一律作废
    return { modRoot: r.modRoot, created: r.created, warnings: r.warnings };
  }

  /* ---------------- 按类型新建文件（G50） ---------------- */

  /**
   * 把调用方给的 dir 解析成它所属的 Mod 包根（newFile / importFile 共用）。
   * dir 可以是绝对路径、相对 modsRoot 的路径，也可以是包内任意子目录；从它往上
   * 找 `mod.json`（最多 25 层，别一路找到盘符）。拒绝消息带调用方的动词前缀。
   */
  function packageRootOf(rawDir, prefix) {
    let dirAbs;
    try {
      dirAbs = resolveArg(String(rawDir), 'dir');
    } catch (e) {
      // 路径越界也属于「这个动词拒绝了你」，把消息归一到动词前缀。
      if (e && e.code === 'EOUTSIDE') throw new Error(prefix + e.message);
      throw e;
    }

    let root = path.resolve(dirAbs);
    for (let i = 0; i <= 25; i++) {
      if (fs.existsSync(path.join(root, 'mod.json'))) return root;
      const parent = path.dirname(root);
      if (parent === root) break;
      root = parent;
    }
    throw new Error(prefix + rawDir + ' is not inside a mod package');
  }

  /**
   * 在一个已有的 Mod 包里新建一个文件。
   *
   * params `{ dir, type, name, overwrite? }`：
   *   - `dir` 可以是绝对路径，也可以相对 modsRoot（和别的动词同一个 resolveArg，
   *     越界即拒绝）；从它往上找 `mod.json`
   *     （最多 25 层）得到包根，写进包根下的规范位置（见 newfile.js）。
   *   - `type` 是 51 个 schema 类型之一，或 `yarn|translation|sprite|spine|audio`；
   *     `spine`/`audio` 明确拒绝并说出需要什么工具，未知类型也拒绝。
   *   - `overwrite: true` 才允许替换已有文件。
   *
   * @returns {{path:string, file:string, kind:string, bytes:number, warnings:string[]}}
   * @throws {Error} 消息以 `new file: ` 开头（dispatch 直接转成错误帧）
   */
  function newFile(params) {
    const p = params && typeof params === 'object' ? params : {};
    for (const key of ['dir', 'type', 'name']) {
      if (p[key] == null || String(p[key]).trim() === '') {
        throw new Error('new file: ' + key + ' is required');
      }
    }

    const packageRoot = packageRootOf(String(p.dir), 'new file: ');

    const requestedType = String(p.type);
    const name = String(p.name);
    const kb = knowledge();
    const schemas = kb && kb.schemas && typeof kb.schemas === 'object' ? kb.schemas : {};
    let schema = Object.prototype.hasOwnProperty.call(schemas, requestedType) ? schemas[requestedType] : null;
    let type = requestedType;
    if (!schema) {
      // 大小写不敏感地找一次（Defines/<Type> 目录名必须用 schema 的真实键）。
      const hit = Object.keys(schemas).find((k) => k.toLowerCase() === requestedType.toLowerCase());
      if (hit) {
        type = hit;
        schema = schemas[hit];
      }
    }

    const written = newfileCore.writeNewFile({
      modRoot: packageRoot,
      type: type,
      name: name,
      schema: schema,
      overwrite: p.overwrite
    });
    invalidateForRoot(); // 目录树变了，按 root 的缓存一律作废（同 scaffold）
    return written;
  }

  /* ---------------- 导入既有文件（G50） ---------------- */

  /**
   * 把一个磁盘上已有的文件导入一个 Mod 包（mod.importFile）。
   *
   * params `{ dir, from, to?, name?, overwrite? }`：
   *   - `dir`：同 newFile（包内任意子目录/绝对路径/相对 modsRoot），用来定位包根；
   *   - `from`：源文件。绝对路径原样接受（导入的常见来源就在包外），相对路径按
   *     modsRoot/工作区解析（resolveArg，越界即拒绝）；
   *   - `to`：可选，包根相对的 POSIX 目标路径；不给时按扩展名落规范目录
   *     （规则见 importfile.js）；`.json` 的源路径没有 `Defines/<Type>/` 段时
   *     要求给 `to` —— 定义的目录就是它的类型，不猜；
   *   - `overwrite: true` 才允许替换已有文件。
   *
   * 复制逐字节进行（BOM/换行不归一化，§18.2 字节保真）；内容校验失败会删掉
   * 刚拷进来的那个文件再抛错。消息统一 `import file: ` 前缀。
   * @returns {{path:string, file:string, kind:string, bytes:number, warnings:string[], diagnostics:Array}}
   * @throws {Error} 消息以 `import file: ` 开头（dispatch 直接转成错误帧）
   */
  function importFileInto(params) {
    const p = params && typeof params === 'object' ? params : {};
    for (const key of ['dir', 'from']) {
      if (p[key] == null || String(p[key]).trim() === '') {
        throw new Error('import file: ' + key + ' is required');
      }
    }

    const packageRoot = packageRootOf(String(p.dir), 'import file: ');

    const rawFrom = String(p.from);
    let fromAbs;
    if (path.isAbsolute(rawFrom)) {
      // 导入的来源通常在包外（桌面、别的工程目录），绝对路径不再受 modsRoot 限制。
      fromAbs = path.resolve(rawFrom);
    } else {
      try {
        fromAbs = resolveArg(rawFrom, 'from');
      } catch (e) {
        if (e && e.code === 'EOUTSIDE') throw new Error('import file: ' + e.message);
        throw e;
      }
    }

    const imported = importfileCore.importFile({
      modRoot: packageRoot,
      from: fromAbs,
      to: p.to,
      name: p.name,
      overwrite: p.overwrite,
      // 校验器由门面注入：定义校验和 Yarn 诊断都是这里的闭包（含知识库/磁盘索引）。
      validateDefineText: validateDefineText,
      diagnoseYarn: diagnoseYarn
    });
    invalidateForRoot(); // 目录树变了，按 root 的缓存一律作废（同 newFile/scaffold）
    return imported;
  }

  /* ---------------- 自带示例包（G35） ---------------- */

  /**
   * The demo packages shipped beside the editor (`examples/Mods`).
   *
   * `mod.open` may only open a directory under `modsRoot` (`resolveArg`), and a
   * bundled demo sits outside it by construction -- so the demo cannot be opened
   * where it ships.  This verb answers what ships; `mod.example` copies one into
   * the mods folder, where every other verb can reach it and the user can edit
   * it without the install noticing.
   */
  function examples() {
    return examplesCore.listExamples();
  }

  /**
   * Copy one demo package into the mods folder (G35).
   *
   * params `{ name? }`; idempotent -- a package already there is answered as
   * `installed: false` and never replaced.  `dir` in the answer is the
   * mod-relative name to hand to `mod.open` or the `mod` command.
   */
  function example(params) {
    const p = params && typeof params === "object" ? params : {};
    const installed = examplesCore.installExample({
      modsRoot: modsRoot,
      name: typeof p.name === "string" && p.name.trim() !== "" ? p.name.trim() : undefined,
    });
    if (installed.installed) invalidateForRoot();
    return installed;
  }

  /** 模板摘要：[{ id, title, files }]。 */
  function templates() {
    return (scaffoldCore.MOD_TEMPLATES || []).map((t) => ({
      id: t.id,
      title: t.nameZh,
      titleEn: t.nameEn,
      description: t.descriptionZh,
      descriptionEn: t.descriptionEn,
      files: (t.creates || []).slice()
    }));
  }

  /* ---------------- 本地化 ---------------- */

  /**
   * 文件名词干 -> 语言码。优先查知识库里那张权威表（游戏本体自带
   * `NewProject.csv` / `NewProject_bg.csv` 的对照），后缀表只当兜底。
   *
   * 必须先查权威表的原因：`scaffold.js` 的后缀表把 `bg` 记成空后缀（生成
   * `MyMod.csv` 时要用），于是 `NewProject_bg` 会被错误地归到基准语言
   * `zh-CN` —— 11 种语言凭空少一种、基准语言多一条。
   */
  function localeCodeFor(stem, baseLanguage, authoritative) {
    const low = String(stem).toLowerCase();
    if (authoritative) {
      for (const entry of authoritative) {
        if (entry.stem === low) return entry.code;
      }
    }
    const suffixes = scaffoldCore.__internal && scaffoldCore.__internal.LOCALE_FILE_SUFFIX
      ? scaffoldCore.__internal.LOCALE_FILE_SUFFIX
      : {};
    const entries = Object.keys(suffixes)
      .map((code) => ({ code: code, suffix: String(suffixes[code] || '') }))
      .filter((e) => e.suffix !== '')
      .sort((a, b) => b.suffix.length - a.suffix.length);
    for (const e of entries) {
      if (low.endsWith(e.suffix.toLowerCase())) return e.code;
    }
    return baseLanguage;
  }

  /** 知识库里的 `文件名词干(小写) -> 语言码` 表，按词干长度降序以便最长匹配。 */
  function authoritativeLocaleStems(kb) {
    const loc = kb && kb.localization && typeof kb.localization === 'object' ? kb.localization : {};
    const list = Array.isArray(loc.locales) ? loc.locales : [];
    const out = [];
    for (const entry of list) {
      if (!entry || typeof entry.code !== 'string' || typeof entry.file !== 'string') continue;
      const base = entry.file.slice(entry.file.lastIndexOf('/') + 1).replace(/\.csv$/i, '');
      if (base !== '') out.push({ stem: base.toLowerCase(), code: entry.code });
    }
    out.sort((a, b) => b.stem.length - a.stem.length);
    return out;
  }

  /**
   * Mod 的本地化 CSV 概览。
   * @returns {{locales:Array<{code:string,file:string,base:boolean,rows:number,bytes:number}>, baseLanguage:string}|null}
   */
  function localization(params) {
    const p = params && typeof params === 'object' ? params : {};
    const rootArg = p.root != null ? p.root : cache.root;
    if (rootArg == null || String(rootArg).trim() === '') return null;
    const root = resolveArg(rootArg, 'root');
    if (!isDir(root)) return null;

    const kb = knowledge();
    const loc = kb.localization && typeof kb.localization === 'object' ? kb.localization : {};
    const baseLanguage = typeof loc.baseLanguage === 'string' && loc.baseLanguage
      ? loc.baseLanguage
      : 'zh-CN';

    const files = [];
    const errs = [];
    collectFiles(root, files, errs, 0, '');
    const csvs = files.filter((f) => isLocaleCsv(toPosix(f.rel)));
    if (!csvs.length) return null;

    const authoritative = authoritativeLocaleStems(kb);
    const locales = csvs.map((f) => {
      const file = toPosix(f.rel);
      const stem = path.basename(f.rel).replace(/\.csv$/i, '');
      const code = localeCodeFor(stem, baseLanguage, authoritative);
      let bytes = 0;
      try { bytes = fs.statSync(f.abs).size; } catch { bytes = 0; }
      const isBase = code === baseLanguage && !/_[A-Za-z-]+$/.test(stem);
      return { code: code, file: file, base: isBase, rows: countCsvRows(f.abs), bytes: bytes };
    });
    locales.sort((a, b) => (a.file < b.file ? -1 : a.file > b.file ? 1 : 0));
    return { locales: locales, baseLanguage: baseLanguage };
  }

  /* ---------------- 游戏目录 / 知识库状态 ---------------- */

  /**
   * 这次进程解析出来的游戏 Mods 目录。没找到也要说得出来：
   * `source === 'not found'` 且 `tried` 列出找过的地方。
   */
  function gameModsInfo() {
    return {
      dir: gameModsDir,
      source: gameMods.source,
      found: !!gameModsDir,
      tried: Array.isArray(gameMods.tried) ? gameMods.tried.slice() : []
    };
  }

  /**
   * 知识库状态：present = 有 schema 可用；missing = 没有知识库，
   * 校验只给文件结构结论（validate.js 会带一条具名 E000 说出来）。
   *
   * `source` 说明用的是哪一份：option / env / bundled / user / derived / missing。
   */
  function knowledgeState() {
    const kb = knowledge();
    const schemas = kb && kb.schemas && typeof kb.schemas === 'object' ? Object.keys(kb.schemas).length : 0;
    return {
      state: schemas > 0 ? 'present' : 'missing',
      path: knowledgeSource.path,
      source: knowledgeSource.source,
      userDir: userDir,
      schemas: schemas,
      loadError: kb && kb.loadError ? String(kb.loadError) : null,
      deriveError: knowledgeSource.deriveError ? String(knowledgeSource.deriveError) : null
    };
  }

  /* ---------------- 门面 ---------------- */

  return {
    knowledge: knowledge,
    knowledgeState: knowledgeState,
    gameMods: gameModsInfo,
    stats: stats,
    types: types,
    characters: characters,
    openMod: openMod,
    validatePackage: validatePackage,
    validateDefineText: validateDefineText,
    diagnoseYarn: diagnoseYarn,
    scaffold: scaffold,
    newFile: newFile,
    importFile: importFileInto,
    examples: examples,
    example: example,
    templates: templates,
    search: search,
    docFor: docFor,
    suggest: suggest,
    completeYarn: completeYarn,
    hoverYarn: hoverYarn,
    localization: localization
  };
}

module.exports = { createMods, KNOWLEDGE_PATH, defaultUserDir };
