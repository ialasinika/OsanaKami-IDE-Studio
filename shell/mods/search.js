'use strict';

/**
 * search.js — 《幼神》(Infant God) Mod IDE 知识库检索 / 补全 / 悬停文档模块
 * ---------------------------------------------------------------------------
 * 设计约束：
 *   1. 同时运行于 Node（主进程 / 测试）与 Electron 渲染进程（<script> 或打包）。
 *      —— 因此内部**不读取任何文件**，不使用 fs / path / require，所有数据由
 *      `buildIndex(kb, options)` 的参数传入（`options.emotionTags` 可选：给表情标签
 *      一个显式来源，例如调用方从活动游戏目录扫到的状态名）。
 *   2. 导出 API（原签名不变，末尾新增一个只读查询）：
 *        buildIndex, search, getEntry, docFor, listDefines, listTypes,
 *        suggest, signatureOf, fuzzyScore, emotionTagsOf
 *   3. 所有名字索引统一小写，展示时保留原始大小写。
 *
 * Index 结构（普通对象，可缓存 / 可结构化克隆）：
 *   {
 *     commands, functions, variables, nodes,   // 原始条目数组（保留 kb 原貌）
 *     types:      [{ type, defineCount, propertyCount, required }],
 *     defines:    { <TypeName>: techName[] },
 *     characters: [...], locales: [...],
 *     emotionTags: [...],  // 表情标签；来源见 meta.emotionSource
 *     meta:       { commands, functions, variables, nodes, types, defines,
 *                   emotionTags, emotionSource, ... },
 *     // 内部辅助（下划线前缀，渲染进程可忽略）
 *     _maps, _entries, _typeInfo, _builtinUsage, _undocumented
 *   }
 */

/* ============================== 常量表 ============================== */

/** 结果排序时的 kind 优先级（数字小的排前面）。 */
const KIND_ORDER = {
  command: 0,
  function: 1,
  variable: 2,
  node: 3,
  define: 4,
  type: 5,
  character: 6,
  locale: 7,
};

/** Yarn Spinner 内建指令（无论知识库是否收录都要能补全）。 */
const YARN_BUILTINS = [
  'if', 'elseif', 'else', 'endif', 'set', 'declare', 'jump', 'detour',
  'return', 'once', 'endonce', 'stop', 'wait', 'call', 'show',
];

/** `#` 之后的常用元数据键。 */
const TAG_KEYS = ['line', 'state', 'vo'];

/**
 * 表情 / 情绪标签的**中性兜底**：这几个词是我们自己挑的，不是《幼神》自己的状态名。
 * 游戏的状态名优先从知识库 `baseline.CharacterState`（或调用方通过
 * `buildIndex(kb, { emotionTags })` 传进来的列表）取；只有那两路都没有时才用这一套，
 * 并且 index.meta.emotionSource 会如实写明用的是哪一路，调用方与界面据此可分辨。
 */
const NEUTRAL_EMOTION_TAGS = ['Neutral', 'Calm', 'Bright', 'Gloomy', 'Tense', 'Tender'];

/** 内建 / 运行时指令的中文速览（悬停与补全说明用）。 */
const BUILTIN_DOCS = {
  if: 'Yarn 内建：条件分支起始，`<<if 表达式>>`。',
  elseif: 'Yarn 内建：条件分支的否则-if，`<<elseif 表达式>>`。',
  else: 'Yarn 内建：条件分支的否则路径，`<<else>>`。',
  endif: 'Yarn 内建：结束条件分支，`<<endif>>`。',
  set: 'Yarn 内建：给变量赋值，`<<set $变量 to 值>>`。',
  declare: 'Yarn 内建：声明变量，`<<declare $变量 = 默认值>>`。',
  jump: 'Yarn 内建：跳转到指定节点，参数为节点标题（title）。',
  detour: 'Yarn 内建：跳转到指定节点并在结束后返回，参数为节点标题（title）。',
  return: 'Yarn 内建：从当前节点返回，`<<return>>`。',
  once: 'Yarn 内建：以下内容只执行一次，`<<once>>`。',
  endonce: 'Yarn 内建：结束只执行一次区块，`<<endonce>>`。',
  stop: 'Yarn 内建：立即结束对话，`<<stop>>`。',
  wait: 'Yarn 内建：等待若干秒后继续，`<<wait 1>>`。',
  call: 'Yarn 内建：调用命令 / 节点，参数为命令名或节点标题。',
  show: 'Yarn 内建：显示台词 / 节点内容，`<<show ...>>`。',
};

/** 标签说明（`#` 上下文）。 */
const TAG_DOCS = {
  line: '行标识（line id）：本地化 CSV 的主键，形如 `line:0a1b2c3`。',
  state: '角色状态标签：给当前说话人附加状态。',
  vo: '语音（voice over）标签：标记该行对应语音资源。',
};

/* ============================== 工具函数 ============================== */

function toArray(v) {
  return Array.isArray(v) ? v : [];
}

function lower(s) {
  return String(s == null ? '' : s).toLowerCase();
}

function cmpText(a, b) {
  const x = lower(a);
  const y = lower(b);
  return x < y ? -1 : x > y ? 1 : 0;
}

function pad4(n) {
  return ('0000' + n).slice(-4);
}

function cloneType(t) {
  return {
    type: t.type,
    defineCount: t.defineCount,
    propertyCount: t.propertyCount,
    required: t.required.slice(),
  };
}

/** 7 位随机十六进制（line id 占位符）。 */
function randomHex7() {
  const HEX = '0123456789abcdef';
  let out = '';
  for (let i = 0; i < 7; i++) out += HEX.charAt(Math.floor(Math.random() * 16));
  return out;
}

/** 判断字符是否为单词边界（非字母数字）。 */
function isBoundaryChar(ch) {
  return !(ch >= 'a' && ch <= 'z') && !(ch >= '0' && ch <= '9');
}

/**
 * 内部评分：query / target 必须已小写。
 * 完全相等 1000 > 前缀 900-长度差 > 单词边界 800-位置 > 子串 700-位置 > 子序列 0..600。
 */
function scoreLower(q, t) {
  if (q === '') return t === '' ? 1000 : 0;
  if (t === '') return -1;
  if (q === t) return 1000;

  // 前缀
  if (t.indexOf(q) === 0) return 900 - (t.length - q.length);

  // 单词边界（`_`、`.`、`/`、空格、`#`、`$` 之后）
  for (let i = 1; i + q.length <= t.length; i++) {
    if (isBoundaryChar(t.charAt(i - 1)) && t.startsWith(q, i)) return 800 - i;
  }

  // 子串
  const idx = t.indexOf(q);
  if (idx > 0) return 700 - idx;

  // 子序列：按连续性与紧凑度给 0..600
  let qi = 0;
  let first = -1;
  let last = -1;
  let prev = -2;
  let contiguous = 0;
  for (let ti = 0; ti < t.length && qi < q.length; ti++) {
    if (t.charAt(ti) === q.charAt(qi)) {
      if (first < 0) first = ti;
      if (ti === prev + 1) contiguous++;
      prev = ti;
      last = ti;
      qi++;
    }
  }
  if (qi < q.length) return -1;

  const span = last - first + 1;
  const compactness = q.length / span;
  const continuity = q.length > 1 ? contiguous / (q.length - 1) : 1;
  const raw = 600 * (0.55 * compactness + 0.45 * continuity) - Math.min(100, first);
  return Math.max(0, Math.min(600, Math.round(raw)));
}

/* ============================== fuzzyScore ============================== */

/**
 * fuzzyScore(query, target) → number
 * 不匹配 -1；完全相等 1000；前缀 900-长度差；单词边界 800-位置；
 * 子串 700-位置；子序列匹配 0..600。空 query 返回 0（对空 target 返回 1000）。
 */
function fuzzyScore(query, target) {
  const q = lower(query == null ? '' : query);
  const t = lower(target == null ? '' : target);
  return scoreLower(q, t);
}

/* ============================== 签名 ============================== */

function fmtParam(p) {
  const name = p && p.name != null ? String(p.name) : 'arg';
  const type = p && p.type != null && p.type !== '' ? String(p.type) : 'any';
  let s = (p && p.isParamsArray ? '...' : '') + name + ':' + type;
  if (p && p.optional) s = '[' + s + ']';
  return s;
}

/**
 * signatureOf(entry) → string
 *   command  → `<<Love characterTechName:string amount:number>>`
 *   function → `CountNPCOption(baseNodeName:string): number`
 * 可选参数 `[name:type]`，可变参数 `...name:type`，异步前面加 `async `。
 */
function signatureOf(entry, kind) {
  if (!entry || typeof entry !== 'object') return '';
  const name = entry.name != null ? String(entry.name) : '';
  const k = lower(kind);
  const isFunction = k === 'function'
    ? true
    : k === 'command'
      ? false
      : Object.prototype.hasOwnProperty.call(entry, 'returnType');

  const params = toArray(entry.parameters).map(fmtParam).join(' ');
  let sig;
  if (isFunction) {
    const rt = entry.returnType != null && entry.returnType !== '' ? String(entry.returnType) : 'void';
    sig = name + '(' + params + '): ' + rt;
  } else {
    sig = '<<' + name + (params ? ' ' + params : '') + '>>';
  }
  return entry.async ? 'async ' + sig : sig;
}

/* ============================== 摘要 / 说明 ============================== */

function arityText(arity) {
  if (!arity || typeof arity !== 'object') return '';
  const keys = Object.keys(arity).sort((a, b) => Number(a) - Number(b));
  return keys.map((k) => k + ' 个实参 ×' + arity[k]).join('，');
}

function detailFor(kind, raw) {
  switch (kind) {
    case 'command':
      return '指令 ' + signatureOf(raw, 'command') + (raw && raw.builtin ? '（Yarn 内建）' : '');
    case 'function':
      return '函数 ' + signatureOf(raw, 'function');
    case 'variable': {
      const t = raw && (raw.type || raw.csType) ? (raw.type || raw.csType) : 'unknown';
      return '变量 $' + (raw && raw.name) + ': ' + t;
    }
    case 'node':
      return '节点 ' + (raw && raw.title) + ' — ' + (raw && raw.file);
    case 'type':
      return '类型 ' + (raw && raw.type) + '：' + (raw ? raw.defineCount : 0) + ' 个 techName，'
        + (raw ? raw.propertyCount : 0) + ' 个 Schema 属性';
    case 'define':
      return '属于类型 ' + (raw && raw.type) + ' 的 techName';
    case 'character':
      return '角色 ' + (raw && raw.name)
        + (raw && raw.displayName ? '（' + raw.displayName + '）' : '')
        + (raw && raw.colour ? ' ' + raw.colour : '');
    case 'locale':
      return '本地化 ' + (raw && raw.code) + '：' + (raw && raw.rows ? raw.rows : 0) + ' 行'
        + (raw && raw.base ? '（基准语言）' : '');
    default:
      return String((raw && (raw.name || raw.title || raw.type)) || '');
  }
}

/* ============================== 表情标签来源 ============================== */

/**
 * 表情标签从哪来（优先级从高到低）：
 *   1. 调用方显式给的 `options.emotionTags`（例如从活动游戏目录扫出来的状态名）；
 *   2. 知识库里的游戏状态名 `baseline.CharacterState`；
 *   3. 知识库自带的 `emotionTags` 字段；
 *   4. 我们的中性兜底 NEUTRAL_EMOTION_TAGS（并如实标注 source: 'neutral'）。
 * 返回 { tags, source }，source ∈ 'caller' | 'knowledge-base' | 'neutral'。
 */
function resolveEmotionTags(kb, options) {
  const src = kb && typeof kb === 'object' ? kb : {};
  const opts = options && typeof options === 'object' ? options : {};
  const clean = (list) => {
    const out = [];
    const seen = new Set();
    for (const v of toArray(list)) {
      const name = String(v == null ? '' : v).trim();
      if (name === '' || seen.has(name)) continue;
      seen.add(name);
      out.push(name);
    }
    return out;
  };
  const fromCaller = clean(opts.emotionTags);
  if (fromCaller.length) return { tags: fromCaller, source: 'caller' };
  const baseline = src.baseline && typeof src.baseline === 'object' ? src.baseline : {};
  const fromGame = clean(baseline.CharacterState);
  if (fromGame.length) return { tags: fromGame, source: 'knowledge-base' };
  const fromKb = clean(src.emotionTags);
  if (fromKb.length) return { tags: fromKb, source: 'knowledge-base' };
  return { tags: NEUTRAL_EMOTION_TAGS.slice(), source: 'neutral' };
}

/** 只读查询：某个 index 用了哪套表情标签、来源是什么（界面可据此标注）。 */
function emotionTagsOf(index) {
  const idx = index && typeof index === 'object' ? index : {};
  const meta = idx.meta && typeof idx.meta === 'object' ? idx.meta : {};
  return {
    tags: toArray(idx.emotionTags).slice(),
    source: meta.emotionSource || 'neutral',
  };
}

/* ============================== buildIndex ============================== */

function buildIndex(kb, options) {
  const src = kb && typeof kb === 'object' ? kb : {};
  const commands = toArray(src.commands).slice();
  const functions = toArray(src.functions).slice();
  const variables = toArray(src.variables).slice();
  const nodes = toArray(src.nodes).slice();
  const schemas = src.schemas && typeof src.schemas === 'object' ? src.schemas : {};
  const baseline = src.baseline && typeof src.baseline === 'object' ? src.baseline : {};
  const localization = src.localization && typeof src.localization === 'object' ? src.localization : {};
  const characters = toArray(localization.characters).slice();
  const locales = toArray(localization.locales).slice();
  const undocumented = toArray(src.undocumentedCommands).slice();
  const undeclared = toArray(src.undeclaredVariables).slice();
  const emotion = resolveEmotionTags(src, options);

  /* ---- types（baseline ∪ schemas，按 type 名称升序） ---- */
  const typeNames = [];
  const seenType = new Set();
  for (const t of Object.keys(baseline)) {
    if (!seenType.has(t)) { seenType.add(t); typeNames.push(t); }
  }
  for (const t of Object.keys(schemas)) {
    if (!seenType.has(t)) { seenType.add(t); typeNames.push(t); }
  }
  typeNames.sort();

  const types = typeNames.map((t) => {
    const schema = schemas[t] && typeof schemas[t] === 'object' ? schemas[t] : {};
    const props = schema.properties && typeof schema.properties === 'object' ? Object.keys(schema.properties) : [];
    return {
      type: t,
      defineCount: toArray(baseline[t]).length,
      propertyCount: props.length,
      required: toArray(schema.required).slice(),
    };
  });

  /* ---- defines：{ TypeName: techName[] } ---- */
  const defines = {};
  let defineTotal = 0;
  for (const t of typeNames) {
    const list = toArray(baseline[t]).map(String);
    defines[t] = list;
    defineTotal += list.length;
  }

  /* ---- 内建指令 usage（来自 undocumentedCommands）与合成条目 ---- */
  const builtinUsage = new Map();
  for (const u of undocumented) builtinUsage.set(lower(u.name), u.usage || 0);
  for (const b of YARN_BUILTINS) {
    if (!builtinUsage.has(lower(b))) builtinUsage.set(lower(b), 0);
  }

  const undocByName = new Map();
  for (const u of undocumented) {
    const k = lower(u.name);
    if (!undocByName.has(k)) undocByName.set(k, u);
  }

  const commandNames = new Set();
  for (const c of commands) commandNames.add(lower(c.name));

  /** 构造“知识库中没有、但运行时存在”的指令条目。 */
  function runtimeCommandEntry(name, usage) {
    const wrapped = '`<<' + name + '>>`';
    return {
      name: name,
      parameters: [],
      async: false,
      documentation: BUILTIN_DOCS[lower(name)] || ('运行时/内置指令 ' + wrapped + '，官方未提供文档。'),
      source: '(Yarn 内建 / 运行时指令)',
      usage: usage || 0,
      builtin: true,
    };
  }

  const runtimeCommands = [];
  for (const u of undocumented) {
    if (!commandNames.has(lower(u.name))) runtimeCommands.push(runtimeCommandEntry(u.name, u.usage));
  }
  for (const b of YARN_BUILTINS) {
    if (!commandNames.has(lower(b)) && !undocByName.has(lower(b))) runtimeCommands.push(runtimeCommandEntry(b, 0));
  }

  /* ---- 查询表（全部小写键） ---- */
  function mapOf(arr, keyFn) {
    const m = new Map();
    for (const e of arr) {
      const k = lower(keyFn(e));
      if (k === '') continue;
      if (!m.has(k)) m.set(k, e);
    }
    return m;
  }

  const typeInfoByName = new Map();
  for (const t of types) typeInfoByName.set(lower(t.type), t);

  const defineTypesByLower = new Map(); // lower(techName) → [TypeName, ...]
  for (const t of Object.keys(defines)) {
    for (const tech of defines[t]) {
      const k = lower(tech);
      if (!defineTypesByLower.has(k)) defineTypesByLower.set(k, []);
      const arr = defineTypesByLower.get(k);
      if (arr.indexOf(t) < 0) arr.push(t);
    }
  }

  const maps = {
    command: mapOf(commands.concat(runtimeCommands), (e) => e.name),
    function: mapOf(functions, (e) => e.name),
    variable: mapOf(variables, (e) => e.name),
    node: mapOf(nodes, (e) => e.title),
    type: typeInfoByName,
    character: mapOf(characters, (e) => e.name),
    define: new Map(), // 由 docFor 单独使用 defineTypesByLower
  };

  /* ---- 统一检索条目表（kind 顺序：command→…→locale） ---- */
  const entries = [];
  const seenEntry = new Set();

  function pushEntry(kind, name, raw, usage, file) {
    const key = kind + ':' + lower(name);
    if (seenEntry.has(key)) return;
    seenEntry.add(key);
    entries.push({
      kind: kind,
      name: String(name),
      lower: lower(name),
      usage: usage || 0,
      raw: raw,
      detail: detailFor(kind, raw),
      file: file || undefined,
    });
  }

  for (const c of commands) pushEntry('command', c.name, c, c.usage);
  for (const c of runtimeCommands) pushEntry('command', c.name, c, c.usage);
  for (const f of functions) pushEntry('function', f.name, f, f.usage);
  for (const v of variables) pushEntry('variable', v.name, v, 0);
  for (const n of nodes) pushEntry('node', n.title, n, 0, n.file);
  for (const t of typeNames) {
    for (const tech of defines[t]) pushEntry('define', tech, { name: tech, type: t }, 0);
  }
  for (const t of types) pushEntry('type', t.type, t, 0);
  for (const ch of characters) pushEntry('character', ch.name, ch, 0);
  for (const lc of locales) pushEntry('locale', lc.code, lc, 0);

  /* ---- meta ---- */
  const stats = src.stats && typeof src.stats === 'object' ? src.stats : {};
  const meta = {
    version: src.version,
    generatedAt: src.generatedAt,
    gameModsDir: src.gameModsDir,
    commands: commands.length,
    functions: functions.length,
    variables: variables.length,
    nodes: nodes.length,
    types: types.length,
    defines: defineTotal,
    baselineDefines: defineTotal,
    schemas: Object.keys(schemas).length,
    characters: characters.length,
    locales: locales.length,
    undocumentedCommands: undocumented.length,
    undeclaredVariables: undeclared.length,
    runtimeCommands: runtimeCommands.length,
    yarnFiles: stats.yarnFiles,
    lineIds: stats.lineIds,
    stats: stats,
    emotionTags: emotion.tags.length,
    emotionSource: emotion.source,
  };

  return {
    commands: commands,
    functions: functions,
    variables: variables,
    nodes: nodes,
    types: types,
    defines: defines,
    characters: characters,
    locales: locales,
    emotionTags: emotion.tags,
    meta: meta,
    _maps: maps,
    _entries: entries,
    _typeInfo: typeInfoByName,
    _defineTypes: defineTypesByLower,
    _builtinUsage: builtinUsage,
    _runtimeCommands: runtimeCommands,
    _undocumented: undocumented,
  };
}

/* ============================== getEntry ============================== */

/**
 * getEntry(index, kind, name) → 条目对象 | null
 * kind ∈ 'command' | 'function' | 'variable' | 'node' | 'type' | 'character'（大小写不敏感）。
 */
function getEntry(index, kind, name) {
  if (!index || name == null) return null;
  const k = lower(kind);
  const key = lower(String(name)).trim();
  if (key === '') return null;
  if (k === 'define') return null; // 定义请用 docFor(index,'define',techName) 或 index.defines
  const m = index._maps ? index._maps[k] : null;
  if (!m || typeof m.get !== 'function') return null;
  const hit = m.get(key);
  return hit === undefined ? null : hit;
}

/* ============================== listTypes / listDefines ============================== */

/** listTypes(index) → [{ type, defineCount, propertyCount, required }]，按 type 升序。 */
function listTypes(index) {
  if (!index || !Array.isArray(index.types)) return [];
  return index.types.map(cloneType);
}

/** listDefines(index, type) → string[]（该类型的 techName 列表）。 */
function listDefines(index, type) {
  if (!index || type == null || !index.defines) return [];
  const key = lower(type).trim();
  const direct = index.defines[type];
  if (Array.isArray(direct)) return direct.slice();
  const info = index._typeInfo ? index._typeInfo.get(key) : null;
  if (info && Array.isArray(index.defines[info.type])) return index.defines[info.type].slice();
  return [];
}

/* ============================== 文档生成 ============================== */

/** 去掉 <summary>/<remarks>/<para> 等包裹标签并压缩空白（不碰 `<<...>>`）。 */
function cleanDocumentation(raw) {
  if (!raw) return '';
  let s = String(raw);
  s = s.replace(/<\/?summary>/gi, '\n');
  s = s.replace(/<\/?remarks>/gi, '\n');
  s = s.replace(/<\/?para>/gi, '\n');
  s = s.replace(/<br\s*\/?>/gi, '\n');
  s = s.replace(/[ \t\r\f\v]+/g, ' ');
  s = s.replace(/\s*\n\s*/g, '\n').trim();
  return s.replace(/\s{2,}/g, ' ');
}

function firstCharacterName(index) {
  const chars = index && index.characters ? index.characters : [];
  for (const c of chars) if (c && c.name) return String(c.name);
  return 'Company';
}

function firstNodeTitle(index) {
  const nodes = index && index.nodes ? index.nodes : [];
  for (const n of nodes) if (n && n.title) return String(n.title);
  return 'Node';
}

function sampleValue(param, index) {
  const t = lower(param && param.type);
  const n = lower(param && param.name);
  if (t === 'number' || t === 'int' || t === 'float' || t === 'double') return '1';
  if (t === 'bool' || t === 'boolean') return 'true';
  if (/character|speaker|role/.test(n)) return '"' + firstCharacterName(index) + '"';
  if (t === 'string') return '"Sample"';
  return 'value';
}

function generateExample(index, kind, entry) {
  if (kind === 'function') {
    const args = toArray(entry.parameters).map((p) => (p.isParamsArray ? '...' : sampleValue(p, index)));
    return entry.name + '(' + args.join(', ') + ')';
  }
  if (kind === 'variable') {
    const t = lower(entry.type || entry.csType);
    const val = t === 'number' ? '0' : t === 'bool' || t === 'boolean' ? 'true' : '"Sample"';
    return '<<set $' + entry.name + ' to ' + val + '>>';
  }
  if (kind === 'node') return '<<jump ' + entry.title + '>>';
  if (kind === 'type') {
    const list = toArray(index && index.defines ? index.defines[entry.type] : []);
    return list.length ? 'techName: ' + list[0] : 'techName: ' + entry.type + '_MyMod';
  }
  if (kind === 'character') return entry.name + ': [line:0000000] 台词内容';
  if (kind === 'define') return 'techName: ' + entry.name;

  // command
  const name = String(entry.name);
  const base = lower(name);
  if ((base === 'jump' || base === 'detour') && index && toArray(index.nodes).length) {
    return '<<' + name + ' ' + firstNodeTitle(index) + '>>';
  }
  const args = toArray(entry.parameters).map((p) => (p.isParamsArray ? '...' : sampleValue(p, index)));
  return '<<' + name + (args.length ? ' ' + args.join(' ') : '') + '>>';
}

/** 从 documentation 中抽出 `Usage:` / `用法` 示例；否则自动生成。 */
function exampleFor(index, kind, entry) {
  // jump / detour 是 Yarn 内建，文档里的示例只是占位符（`<<jump 节点名>>`），
  // 必须改用 index.nodes 里的真实节点标题，示例才能直接复制。
  const base = lower(entry && entry.name);
  if (kind === 'command' && (base === 'jump' || base === 'detour')
      && index && toArray(index.nodes).length) {
    return { code: generateExample(index, kind, entry), fromDoc: false };
  }
  const doc = cleanDocumentation(entry.documentation);
  if (doc) {
    const m = doc.match(/(?:Usage|用法)\s*[:：]\s*([\s\S]+)$/i);
    if (m) {
      const tail = m[1].trim();
      const code = tail.match(/<<[^>]*>>|<[^>]*>|\$?[A-Za-z_][\w.]*\s*\([^)]*\)/);
      if (code) return { code: code[0].trim(), fromDoc: true };
      if (tail) return { code: tail, fromDoc: true };
    }
    const bare = doc.match(/<<[^>]*>>/);
    if (bare) return { code: bare[0], fromDoc: true };
  }
  return { code: generateExample(index, kind, entry), fromDoc: false };
}

function paramTable(entry) {
  const params = toArray(entry.parameters);
  if (!params.length) return ['该条目没有参数。'];
  const lines = ['| 名称 | 类型 | 可选 | 默认值 | 备注 |', '| --- | --- | --- | --- | --- |'];
  for (const p of params) {
    const def = p.defaultValue != null && p.defaultValue !== '' ? '`' + p.defaultValue + '`' : '—';
    const note = p.isParamsArray ? '可变参数（可传多个）' : '';
    lines.push('| `' + (p.name != null ? p.name : 'arg') + '` | `' + (p.type || 'any') + '` | '
      + (p.optional ? '是' : '否') + ' | ' + def + ' | ' + note + ' |');
  }
  return lines;
}

function callableDoc(index, kind, entry) {
  const isFn = kind === 'function';
  const sig = signatureOf(entry, kind);
  const doc = cleanDocumentation(entry.documentation);
  const ex = exampleFor(index, kind, entry);
  const L = [];

  L.push('# ' + (isFn ? '函数' : '指令') + ' `' + entry.name + '`');
  L.push('');
  L.push('```yarn');
  L.push(sig);
  L.push('```');
  L.push('');
  L.push('| 项目 | 值 |');
  L.push('| --- | --- |');
  L.push('| 签名 | `' + sig + '` |');
  L.push('| 来源文件 | `' + (entry.source || '未提供') + '` |');
  L.push('| 使用次数 | ' + (entry.usage || 0) + ' |');
  L.push('| 异步 | ' + (entry.async ? '是' : '否') + ' |');
  if (isFn) L.push('| 返回类型 | `' + (entry.returnType || 'void') + '` |');
  if (kind === 'command' && entry.arity) {
    const a = arityText(entry.arity);
    if (a) L.push('| 实参个数分布 | ' + a + ' |');
  }
  L.push('');
  L.push('### 参数');
  L.push('');
  for (const line of paramTable(entry)) L.push(line);
  L.push('');
  L.push('### 说明');
  L.push('');
  L.push(doc ? doc : '（官方未提供文档说明。）');
  L.push('');
  L.push('### 示例');
  L.push('');
  L.push('```yarn');
  L.push(ex.code);
  L.push('```');
  if (!ex.fromDoc) L.push('');
  if (!ex.fromDoc) L.push('> 该示例依据参数签名自动生成，请按需替换其中的占位值。');
  return L.join('\n');
}

function variableDoc(index, entry) {
  const t = entry.type || entry.csType || 'unknown';
  const ex = generateExample(index, 'variable', entry);
  const L = [];
  L.push('# 变量 `$' + entry.name + '`');
  L.push('');
  L.push('| 项目 | 值 |');
  L.push('| --- | --- |');
  L.push('| 变量名 | `$' + entry.name + '` |');
  L.push('| 类型 | `' + t + '`' + (entry.csType ? '（C# `' + entry.csType + '`）' : '') + ' |');
  L.push('');
  L.push('### 说明');
  L.push('');
  L.push('由游戏脚本导出的全局变量，可在 Yarn 中直接读写。');
  L.push('');
  L.push('### 示例');
  L.push('');
  L.push('```yarn');
  L.push(ex);
  L.push('```');
  return L.join('\n');
}

function nodeDoc(index, entry) {
  const tags = toArray(entry.tags);
  const L = [];
  L.push('# 节点 `' + entry.title + '`');
  L.push('');
  L.push('| 项目 | 值 |');
  L.push('| --- | --- |');
  L.push('| 标题 | `' + entry.title + '` |');
  L.push('| 文件 | `' + (entry.file || '未提供') + '` |');
  L.push('| 标签 | ' + (tags.length ? tags.map((t) => '`' + t + '`').join(' ') : '—') + ' |');
  L.push('');
  L.push('### 跳转示例');
  L.push('');
  L.push('```yarn');
  L.push('<<jump ' + entry.title + '>>');
  L.push('```');
  return L.join('\n');
}

function typeDoc(index, entry) {
  const defines = listDefines(index, entry.type);
  const preview = defines.slice(0, 5);
  const L = [];
  L.push('# 类型 `' + entry.type + '`');
  L.push('');
  L.push('| 项目 | 值 |');
  L.push('| --- | --- |');
  L.push('| 类型 | `' + entry.type + '` |');
  L.push('| 基线 techName 数量 | ' + entry.defineCount + ' |');
  L.push('| Schema 属性数 | ' + entry.propertyCount + ' |');
  L.push('| 必填属性 | ' + (entry.required.length ? entry.required.map((r) => '`' + r + '`').join(' ') : '—') + ' |');
  L.push('');
  L.push('### 覆写提示');
  L.push('');
  L.push('在你的 Mod 中新建一个 `' + entry.type + '` 定义文件，把 `techName` 设为基线中的同名值即可覆写该条目。');
  if (preview.length) {
    L.push('');
    L.push('可用 techName（前 ' + preview.length + ' 个）：' + preview.map((d) => '`' + d + '`').join(' '));
  }
  L.push('');
  L.push('### 示例');
  L.push('');
  L.push('```yaml');
  L.push(generateExample(index, 'type', entry));
  L.push('```');
  return L.join('\n');
}

function characterDoc(index, entry) {
  const L = [];
  L.push('# 角色 `' + entry.name + '`');
  L.push('');
  L.push('| 项目 | 值 |');
  L.push('| --- | --- |');
  L.push('| 角色名 | `' + entry.name + '` |');
  L.push('| 显示名 | ' + (entry.displayName ? '`' + entry.displayName + '`' : '—') + ' |');
  L.push('| 颜色 | ' + (entry.colour ? '`' + entry.colour + '`' : '—') + ' |');
  L.push('');
  L.push('### 台词示例');
  L.push('');
  L.push('```yarn');
  L.push(entry.name + ': [line:0a1b2c3] 台词内容');
  L.push('```');
  return L.join('\n');
}

function defineDoc(index, name, typeNames) {
  const L = [];
  L.push('# 定义 `' + name + '`');
  L.push('');
  L.push('| 项目 | 值 |');
  L.push('| --- | --- |');
  L.push('| techName | `' + name + '` |');
  L.push('| 所属类型 | ' + typeNames.map((t) => '`' + t + '`').join(' ') + ' |');
  L.push('');
  L.push('### 覆写提示');
  L.push('');
  L.push('在你的 Mod 中创建 ' + typeNames.map((t) => '`' + t + '`').join(' / ')
    + ' 定义，并把 `techName` 写成 `' + name + '`，即可覆盖游戏基线定义。');
  L.push('');
  L.push('### 示例');
  L.push('');
  L.push('```yaml');
  L.push('techName: ' + name);
  L.push('```');
  return L.join('\n');
}

/**
 * docFor(index, kind, name) → Markdown 字符串 | null
 * kind ∈ 'command' | 'function' | 'variable' | 'node' | 'type' | 'character' | 'define'
 */
function docFor(index, kind, name) {
  if (!index || name == null) return null;
  const k = lower(kind);
  const key = lower(String(name)).trim();
  if (key === '') return null;

  if (k === 'define') {
    const types = index._defineTypes ? index._defineTypes.get(key) : null;
    if (!types || !types.length) return null;
    return defineDoc(index, String(name), types);
  }

  const entry = getEntry(index, k, name);
  if (!entry) return null;

  switch (k) {
    case 'command':
    case 'function':
      return callableDoc(index, k, entry);
    case 'variable':
      return variableDoc(index, entry);
    case 'node':
      return nodeDoc(index, entry);
    case 'type':
      return typeDoc(index, entry);
    case 'character':
      return characterDoc(index, entry);
    default:
      return null;
  }
}

/* ============================== search ============================== */

function byUsageThenKindThenName(a, b) {
  if (b.usage !== a.usage) return b.usage - a.usage;
  const ka = KIND_ORDER[a.kind] == null ? 99 : KIND_ORDER[a.kind];
  const kb = KIND_ORDER[b.kind] == null ? 99 : KIND_ORDER[b.kind];
  if (ka !== kb) return ka - kb;
  return cmpText(a.name, b.name);
}

function toResult(entry, score) {
  const r = { kind: entry.kind, name: entry.name, score: score, detail: entry.detail };
  if (entry.file) r.file = entry.file;
  return r;
}

/**
 * search(index, query, opts?) → Result[]
 * opts = { limit?: 50, kinds?: string[] }
 * Result = { kind, name, score, detail, file? }
 */
function search(index, query, opts) {
  if (!index || !Array.isArray(index._entries)) return [];
  const options = opts || {};
  const limit = options.limit == null ? 50 : options.limit;
  const kindFilter = Array.isArray(options.kinds) && options.kinds.length
    ? new Set(options.kinds.map(lower))
    : null;

  const pool = [];
  for (const e of index._entries) {
    if (kindFilter && !kindFilter.has(e.kind)) continue;
    pool.push(e);
  }

  const q = lower(query == null ? '' : query).trim();
  if (q === '') {
    pool.sort(byUsageThenKindThenName);
    return pool.slice(0, limit).map((e) => toResult(e, 0));
  }

  const hits = [];
  for (const e of pool) {
    const s = scoreLower(q, e.lower);
    if (s < 0) continue;
    hits.push({ e: e, s: s });
  }
  hits.sort((a, b) => {
    if (b.s !== a.s) return b.s - a.s;
    return byUsageThenKindThenName(a.e, b.e);
  });
  return hits.slice(0, limit).map((h) => toResult(h.e, h.s));
}

/* ============================== suggest ============================== */

function makeItem(label, kind, detail, insertText, extra) {
  const item = {
    label: label,
    kind: kind,
    detail: detail,
    insertText: insertText,
    usage: (extra && extra.usage) || 0,
    doc: (extra && extra.doc) || '',
    docKind: extra && extra.docKind,
    docName: extra && extra.docName,
  };
  return item;
}

function builtinOrCommandCandidates(index) {
  const out = [];
  const seen = new Set();
  const push = (name, usage, raw, builtin) => {
    const k = lower(name);
    if (seen.has(k)) return;
    seen.add(k);
    const detail = raw
      ? '指令 ' + signatureOf(raw, 'command') + (builtin ? '（Yarn 内建）' : '')
      : '指令 ' + name;
    out.push(makeItem(name, 'command', detail, name, {
      usage: usage || 0,
      docKind: 'command',
      docName: name,
    }));
  };
  for (const c of index.commands) push(c.name, c.usage, c, false);
  for (const c of toArray(index._runtimeCommands)) push(c.name, c.usage, c, true);
  return out;
}

function candidatesFor(index, ctx, typeName) {
  const out = [];
  if (ctx === 'command') return builtinOrCommandCandidates(index);

  if (ctx === 'function') {
    for (const f of index.functions) {
      out.push(makeItem(f.name, 'function', '函数 ' + signatureOf(f, 'function'), f.name, {
        usage: f.usage || 0, docKind: 'function', docName: f.name,
      }));
    }
    return out;
  }

  if (ctx === 'variable') {
    for (const v of index.variables) {
      const label = String(v.name).replace(/^\$/, '');
      out.push(makeItem(label, 'variable', '变量 $' + label + ': ' + (v.type || v.csType || 'unknown'),
        '$' + label, { usage: 0, docKind: 'variable', docName: label }));
    }
    return out;
  }

  if (ctx === 'node') {
    const seen = new Set();
    for (const n of index.nodes) {
      const k = lower(n.title);
      if (seen.has(k)) continue;
      seen.add(k);
      out.push(makeItem(n.title, 'node', '节点 ' + n.title + ' — ' + n.file, n.title,
        { usage: 0, docKind: 'node', docName: n.title }));
    }
    return out;
  }

  if (ctx === 'tag') {
    out.push(makeItem('line', 'tag', '行标识（line id）', 'line:' + randomHex7(),
      { usage: 100, doc: TAG_DOCS.line }));
    out.push(makeItem('state', 'tag', '角色状态标签', 'state', { usage: 90, doc: TAG_DOCS.state }));
    out.push(makeItem('vo', 'tag', '语音（voice over）标签', 'vo', { usage: 80, doc: TAG_DOCS.vo }));
    for (const c of index.characters) {
      out.push(makeItem(c.name, 'character', '角色 ' + c.name + (c.colour ? ' ' + c.colour : ''), c.name,
        { usage: 0, docKind: 'character', docName: c.name }));
    }
    for (const e of toArray(index.emotionTags)) {
      const source = index.meta && index.meta.emotionSource;
      const doc = source === 'neutral'
        ? '表情 / 情绪标签 ' + e + '（IDE 自带的中性兜底，不是游戏状态名）'
        : '表情 / 情绪标签 ' + e + '（来自' + (source === 'caller' ? '调用方给定的列表' : '知识库') + '）';
      out.push(makeItem(e, 'tag', doc, e, { usage: 0, doc: doc }));
    }
    return out;
  }

  if (ctx === 'character') {
    for (const c of index.characters) {
      out.push(makeItem(c.name, 'character',
        '角色 ' + c.name + (c.displayName ? '（' + c.displayName + '）' : '') + (c.colour ? ' ' + c.colour : ''),
        c.name + ': ', { usage: 0, docKind: 'character', docName: c.name }));
    }
    return out;
  }

  if (ctx === 'definetype') {
    for (const t of index.types) {
      out.push(makeItem(t.type, 'type', '类型 ' + t.type + '：' + t.defineCount + ' 个 techName',
        t.type, { usage: 0, docKind: 'type', docName: t.type }));
    }
    return out;
  }

  if (ctx === 'defineref') {
    const list = listDefines(index, typeName);
    const canonical = (index._typeInfo && index._typeInfo.get(lower(typeName)))
      ? index._typeInfo.get(lower(typeName)).type
      : typeName;
    for (const tech of list) {
      out.push(makeItem(tech, 'define', '属于类型 ' + canonical + ' 的 techName', tech,
        { usage: 0, docKind: 'define', docName: tech }));
    }
    return out;
  }

  return out;
}

function docForItem(index, item) {
  if (item.docKind && item.docName) {
    const d = docFor(index, item.docKind, item.docName);
    if (d) return d;
  }
  return item.doc || '';
}

/**
 * suggest(index, prefix, context, opts?) → { items, isIncomplete }
 * context: 'command' | 'function' | 'variable' | 'node' | 'tag' | 'character'
 *        | 'defineRef:<TypeName>' | 'defineType'
 * items: [{ label, kind, detail, insertText, documentation, sortText }]
 */
function suggest(index, prefix, context, opts) {
  const empty = { items: [], isIncomplete: false };
  if (!index) return empty;

  const options = opts || {};
  const limit = options.limit == null ? 200 : options.limit;
  const rawContext = String(context == null ? '' : context).trim();
  const ctxLower = lower(rawContext);

  let ctx = ctxLower;
  let typeName = '';
  const refMatch = rawContext.match(/^defineRef\s*[:：]\s*(.+)$/i);
  if (refMatch) {
    ctx = 'defineref';
    typeName = refMatch[1].trim();
    if (!typeName) return empty;
  }

  const candidates = candidatesFor(index, ctx, typeName);
  if (!candidates.length) return empty;

  let p = String(prefix == null ? '' : prefix);
  if (ctx === 'variable') p = p.replace(/^\$/, '');
  if (ctx === 'tag') p = p.replace(/^#/, '');
  const pl = lower(p).trim();

  const matched = [];
  for (const cand of candidates) {
    let tier;
    let score;
    if (pl === '') {
      tier = 0;
      score = 0;
    } else if (cand.label.toLowerCase().indexOf(pl) === 0) {
      tier = 0;
      score = 900 - (cand.label.length - pl.length);
    } else {
      const s = scoreLower(pl, lower(cand.label));
      if (s < 0) continue;
      tier = 1;
      score = s;
    }
    matched.push({ cand: cand, tier: tier, score: score });
  }

  const isIncomplete = matched.length > limit;

  let ordered = matched;
  if (pl === '') {
    ordered = matched.slice().sort((a, b) => {
      if (b.cand.usage !== a.cand.usage) return b.cand.usage - a.cand.usage;
      const ka = KIND_ORDER[a.cand.kind] == null ? 99 : KIND_ORDER[a.cand.kind];
      const kb = KIND_ORDER[b.cand.kind] == null ? 99 : KIND_ORDER[b.cand.kind];
      if (ka !== kb) return ka - kb;
      return cmpText(a.cand.label, b.cand.label);
    });
  } else {
    ordered = matched.slice().sort((a, b) => {
      if (a.tier !== b.tier) return a.tier - b.tier;
      if (b.score !== a.score) return b.score - a.score;
      if (b.cand.usage !== a.cand.usage) return b.cand.usage - a.cand.usage;
      return cmpText(a.cand.label, b.cand.label);
    });
  }

  const cap = pl === '' ? Math.min(limit, 100) : limit;
  const picked = ordered.slice(0, cap);

  const items = picked.map((m, i) => ({
    label: m.cand.label,
    kind: m.cand.kind,
    detail: m.cand.detail,
    insertText: m.cand.insertText,
    documentation: docForItem(index, m.cand),
    sortText: pad4(i) + '_' + lower(m.cand.label),
  }));

  items.sort((a, b) => (a.sortText < b.sortText ? -1 : a.sortText > b.sortText ? 1 : 0));

  return { items: items, isIncomplete: isIncomplete };
}

/* ============================== 导出 ============================== */

const InfantGodSearch = {
  buildIndex: buildIndex,
  search: search,
  getEntry: getEntry,
  docFor: docFor,
  listDefines: listDefines,
  listTypes: listTypes,
  suggest: suggest,
  signatureOf: signatureOf,
  fuzzyScore: fuzzyScore,
  emotionTagsOf: emotionTagsOf,
};

// Node / CommonJS
if (typeof module !== 'undefined' && module.exports) module.exports = InfantGodSearch;
// 浏览器 / Electron 渲染进程（<script> 直接加载）
if (typeof window !== 'undefined') window.InfantGodSearch = InfantGodSearch;
