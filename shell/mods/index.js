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
const gamepath = require('./gamepath.js');

/** knowledge.json 的位置（本模块同目录）。 */
const KNOWLEDGE_PATH = path.join(__dirname, 'knowledge.json');

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
 * @param {string} [options.knowledgePath] 默认本目录的 knowledge.json
 * @param {string} [options.modsRoot]      可选白名单根：所有 dir/root 参数必须落在里面
 * @param {string} [options.gameModsDir]   游戏 Mods 目录（基线 schema/定义来源）
 */
function createMods(options) {
  const opts = options && typeof options === 'object' ? options : {};

  const knowledgePath = path.resolve(opts.knowledgePath || KNOWLEDGE_PATH);
  const modsRoot = opts.modsRoot ? path.resolve(String(opts.modsRoot)) : null;
  const gameMods = gamepath.discoverGameModsDir({
    gameModsDir: opts.gameModsDir != null ? opts.gameModsDir : opts.gameDir,
    env: process.env
  });
  /** 游戏 Mods 目录；null = 本机没找到（「没找到」本身也是要报出来的状态）。 */
  const gameModsDir = gameMods.dir;

  /** 所有按 root 缓存的派生状态；openMod 换根时整块清掉。 */
  const cache = {
    kb: null,
    kbView: null,
    index: null,
    root: null,
    manifest: null,
    mod: null,
    nodeTitlesByRoot: new Map()
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

  /** knowledge.json 的原样对象（必要时给一个结构完整的空壳）。 */
  function knowledge() {
    if (cache.kb) return cache.kb;
    const r = readText(knowledgePath);
    if (!r.ok) {
      cache.kb = {
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
        loadError: r.error
      };
      return cache.kb;
    }
    try {
      cache.kb = JSON.parse(r.text);
    } catch (e) {
      cache.kb = {
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
        loadError: 'knowledge.json 不是合法 JSON：' + errText(e)
      };
    }
    return cache.kb;
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
        for (const m of r.text.matchAll(/^[ \t]*title[ \t]*:[ \t]*(.+?)[ \t]*$/gm)) {
          const t = m[1].trim();
          if (t && !nodeSeen.has(t)) { nodeSeen.add(t); nodeTitles.push(t); }
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
      for (const m of r.text.matchAll(/^[ \t]*title[ \t]*:[ \t]*(.+?)[ \t]*$/gm)) {
        const t = m[1].trim();
        if (t && !seen.has(t)) { seen.add(t); titles.push(t); }
      }
    }
    cache.nodeTitlesByRoot.set(root, titles);
    return titles;
  }

  /* ---------------- Yarn 诊断 ---------------- */

  function buildDiagnoseContext(kb, fileName) {
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
    return {
      fileName: fileName,
      commands: commands,
      functions: functions,
      variables: variables,
      nodeIndex: nodeIndex,
      stateTags: STATE_TAGS.slice(),
      knownMetaKeys: KNOWN_META_KEYS.slice()
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
    const ctx = buildDiagnoseContext(kb, fileName);
    for (const t of localNodeTitles(root)) {
      if (!ctx.nodeIndex[t]) ctx.nodeIndex[t] = '';
    }

    let nodes = [];
    try {
      nodes = (yarnCore.parseYarn(text, { fileName: fileName }).nodes || []).map((n) => ({
        title: n.title,
        tags: n.tags,
        line: n.headerLine,
        endLine: n.bodyEndLine
      }));
    } catch {
      /* 解析失败时只保留诊断 */
    }
    for (const n of nodes) {
      if (n.title && !ctx.nodeIndex[n.title]) ctx.nodeIndex[n.title] = fileName;
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
      otherMods: listInstalledMods()
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
    const sopts = { knowledgePath: knowledgePath };
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
   */
  function knowledgeState() {
    const kb = knowledge();
    const schemas = kb && kb.schemas && typeof kb.schemas === 'object' ? Object.keys(kb.schemas).length : 0;
    return {
      state: schemas > 0 ? 'present' : 'missing',
      path: knowledgePath,
      schemas: schemas,
      loadError: kb && kb.loadError ? String(kb.loadError) : null
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
    templates: templates,
    search: search,
    docFor: docFor,
    suggest: suggest,
    localization: localization
  };
}

module.exports = { createMods, KNOWLEDGE_PATH };
