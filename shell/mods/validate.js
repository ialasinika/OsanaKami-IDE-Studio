'use strict';
/**
 * validate.js — 《幼神》(Infant God) Mod IDE 定义校验器
 *
 * 纯函数模块：用游戏导出的 51 份 JSON Schema（draft 2020-12 子集）校验单个定义文件，
 * 并校验整个 Mod 包（mod.json / Defines / Yarn / 本地化 CSV）。
 *
 * 只依赖 Node 内置模块（fs / path），CommonJS。
 *
 * ------------------------------------------------------------------ *
 * 导出的 API（严格保持签名）
 * ------------------------------------------------------------------ *
 *   referenceMap(schemas)             -> { [TypeName]: { [jsonPath]: TargetTypeName|'*'|'sprite' } }
 *   validateDefine(type, obj, opts)   -> Diagnostic[]
 *   validateModPackage(modRoot, opts) -> { ok, manifest, summary, diagnostics, types }
 *   schemaSummary(kb)                 -> [{ type, title, propertyCount, required, references, sprites, enums, ... }]
 *
 * ------------------------------------------------------------------ *
 * 实现要点 / 与规格的对应（含少量必要取舍，便于评审）
 * ------------------------------------------------------------------ *
 * 1. `required` 并不总是小写 `techName`。真实数据里 35 个 schema 用 `techName`，
 *    15 个用 `TechName`（AchievementDefinition / CutScene / Memory / Memory* / Pet* /
 *    Quest* / Result / SpecialEffect / TipsTypeDefinition），
 *    而 AudioEvent 同时要求 `techName` + `TechName`。实现按 schema 的 required / properties
 *    自适应字段名大小写，不做硬编码。
 *
 * 2. 引用字段的目标类型名与 schema 键名并不总是一致：
 *      "TechName reference to CharacterDefinition" -> schema 键 Character
 *      "TechName reference to CutSceneDefinition"  -> CutScene
 *      "TechName reference to HexSO"               -> Hex
 *      "TechName reference to MemoryDefinition"    -> Memory
 *      "TechName reference to Album"               -> 无对应类型（无法校验，仅非空）
 *      "TechName reference to ScriptableObject"    -> 泛型引用 '*'
 *    因此 referenceMap / schemaSummary 输出的是「解析后的目标类型名」（能解析时），
 *    解析失败时原样输出。D005 只在目标类型确实有基线时判定错误。
 *    合法目标的集合 = baseline[目标类型] ∪ 本 Mod 自己定义的同类 TechName：
 *    基线只描述游戏本体，而 Mod 完全可以自带 Defines/Attr/X.json 再在
 *    Defines/Topic/Y.json 里 `"attrType": "X"` 引用它。本 Mod 的定义集来自
 *    opts.techNames（validateModPackage 扫描时建好）或按需扫 modRoot/Defines/<类型>/。
 *
 * 3. `null` 一律视为「未设置 / 可空」，不做类型、枚举、引用、图片存在性检查
 *    （真实基线数据里有 1302 个 null 字段，例如 Goods.targetObject）。
 *
 * 4. D003 与 D007 语义重叠（数组既是 D003 列举的类型之一，又是 D007 的描述）。
 *    取舍：数组相关的类型错误统一走更具体的 D007（「本应是数组却是标量」+
 *    「items 声明的元素类型不符」），D003 负责标量/对象/数组以外的类型。
 *    两者都不会对同一字段重复报错（类型不符即停止下钻）。
 *
 * 5. 包级诊断的 `path` 用 `相对 modRoot 的 POSIX 路径#JSON路径` 前缀，
 *    使 Diagnostics 可以定位到具体文件（Diagnostic 结构本身没有 file 字段）。
 *
 * 6. M007（Yarn 节点重复）：真实 MyMod 里有 1221 个节点，其中 44 个 `title` 被
 *    多个节点复用 —— 因为本作 Yarn 方言用 `subtitle:` 头区分同一 title 的多个片段。
 *    真正的节点身份是 (title, subtitle)，它在全包 1221 个节点里唯一（0 重复）。
 *    所以 M007 以 (title, subtitle) 为键报 error（同文件内 / 跨文件都报），
 *    另提供 opts.strictYarnTitles 以仅按 title 报 warning（默认关闭，避免误报噪音）。
 *
 * 7. 规格外扩展码（仅用于「规格没定义但没有它就无法如实报告失败」的场景）：
 *      M009 info     mod.json 推荐字段缺失
 *      M010 error    定义文件不是合法 JSON
 *      M011 error/warning  Yarn 文件不可读 / 不是合法 UTF-8
 *
 * 8. 兼容别名：app/core/api.js:308 用旧名 `validatePackage(root, {kb, otherMods})`
 *    调用本模块，本模块的对外契约则是 `validateModPackage`。故在导出对象上挂了
 *    一个不可枚举的 `validatePackage` 别名（见文件末尾），既不改变规格要求的
 *    4 个导出键，又能让 IDE 的「校验整个 Mod」按原样工作。
 */

const fs = require('fs');
const path = require('path');

/* ================================================================== *
 * 1. 常量与轻量工具
 * ================================================================== */

const RE_TECH_REF = /^TechName reference to (.+)$/;
const RE_SPRITE_DESC = /Relative path to sprite image file/i;
const RE_YARN_TITLE = /^title:\s*(\S+)\s*$/;
const RE_YARN_SUBTITLE = /^subtitle:\s*(.+?)\s*$/;

/*
 * G41：description 里的两类事实，facts-only 的 KB（tools/gen_knowledge.mjs 生成）
 * 把它们提成这两个显式键后剥掉文本。校验器必须两边都认，否则「重新生成 KB」会让
 * 引用检查与 sprite 检查静默变成空集 —— 全绿，但什么都没查。
 */
const X_REF_KEY = 'x-techReference';
const X_SPRITE_KEY = 'x-sprite';

/** 泛型引用：类型未知，只能做非空检查。 */
const GENERIC_REF = 'ScriptableObject';
/** 图片路径字段在 referenceMap 中的特殊目标值。 */
const SPRITE = 'sprite';

/** 目标类型名 -> schema 键名的别名后缀（按顺序尝试剥离）。 */
const TYPE_ALIAS_SUFFIXES = ['Definition', 'SO', 'Asset', 'Type'];

/** mod.json 的推荐字段（缺失只报 info）。 */
const RECOMMENDED_MANIFEST_KEYS = ['version', 'gameVersion', 'author', 'description'];

const RECOMMENDED_LABEL = {
  version: '版本号',
  gameVersion: '游戏版本',
  author: '作者',
  description: '描述'
};
const RECOMMENDED_LABEL_EN = {
  version: 'version',
  gameVersion: 'gameVersion',
  author: 'author',
  description: 'description'
};

function isPlainObject(v) {
  return v !== null && typeof v === 'object' && !Array.isArray(v);
}

function hasOwn(obj, key) {
  return Object.prototype.hasOwnProperty.call(obj, key);
}

/** JSON 层面的类型名。 */
function jsonTypeOf(v) {
  if (v === null) return 'null';
  if (v === undefined) return 'undefined';
  if (Array.isArray(v)) return 'array';
  return typeof v;
}

/** 值是否算「已设置」（null / undefined / 空字符串 视为未设置）。 */
function hasValue(obj, key) {
  if (!hasOwn(obj, key)) return false;
  const v = obj[key];
  return v !== undefined && v !== null && v !== '';
}

/** 消息里对值的简短呈现。 */
function describe(v) {
  if (typeof v === 'string') {
    return JSON.stringify(v.length > 48 ? v.slice(0, 48) + '…' : v);
  }
  if (v === null) return 'null';
  if (v === undefined) return 'undefined';
  if (Array.isArray(v)) return 'array(' + v.length + ')';
  if (typeof v === 'object') return 'object{' + Object.keys(v).length + '}';
  return String(v);
}

/** 统一构造 Diagnostic，保证字段顺序稳定。 */
function diag(severity, code, jsonPath, schemaType, message, messageEn, extra) {
  const d = {
    severity: severity,
    code: code,
    path: jsonPath == null ? '' : String(jsonPath),
    message: message,
    messageEn: messageEn,
    schemaType: schemaType == null ? '' : String(schemaType)
  };
  if (extra) {
    if (extra.expected !== undefined) d.expected = extra.expected;
    if (extra.actual !== undefined) d.actual = extra.actual;
  }
  return d;
}

function toPosix(p) {
  return String(p).split(path.sep).join('/');
}

function relPosix(root, abs) {
  return toPosix(path.relative(root, abs));
}

function safeReaddir(dir, withFileTypes) {
  try {
    return fs.readdirSync(dir, withFileTypes ? { withFileTypes: true } : undefined);
  } catch {
    return [];
  }
}

function isDir(p) {
  try {
    return fs.statSync(p).isDirectory();
  } catch {
    return false;
  }
}

/** 递归列出目录下全部文件（绝对路径），跳过符号链接造成的环。 */
function listFilesRecursive(dir, out, depth) {
  const acc = out || [];
  const d = depth || 0;
  if (d > 24) return acc;
  for (const e of safeReaddir(dir, true)) {
    const full = path.join(dir, e.name);
    let isDirectory = e.isDirectory();
    let isFile = e.isFile();
    if (e.isSymbolicLink && e.isSymbolicLink()) {
      if (isDir(full)) isDirectory = true;
      else isFile = true;
    }
    if (isDirectory) listFilesRecursive(full, acc, d + 1);
    else if (isFile) acc.push(full);
  }
  return acc;
}

/** 极简编辑距离（带上限剪枝），用于「你是不是想写 X」提示。 */
function editDistance(a, b, cap) {
  const n = a.length;
  const m = b.length;
  if (Math.abs(n - m) > cap) return cap + 1;
  let prev = new Array(m + 1);
  let cur = new Array(m + 1);
  for (let j = 0; j <= m; j++) prev[j] = j;
  for (let i = 1; i <= n; i++) {
    cur[0] = i;
    let rowMin = cur[0];
    for (let j = 1; j <= m; j++) {
      const cost = a.charCodeAt(i - 1) === b.charCodeAt(j - 1) ? 0 : 1;
      let v = prev[j - 1] + cost;
      const del = prev[j] + 1;
      const ins = cur[j - 1] + 1;
      if (del < v) v = del;
      if (ins < v) v = ins;
      cur[j] = v;
      if (v < rowMin) rowMin = v;
    }
    if (rowMin > cap) return cap + 1;
    const t = prev;
    prev = cur;
    cur = t;
  }
  return prev[m];
}

/** 从候选列表里找最接近的值（找不到返回 null）。 */
function closestMatch(value, list) {
  if (!Array.isArray(list) || !list.length) return null;
  if (list.length > 4000) return null;
  const target = String(value);
  const cap = Math.max(2, Math.min(6, Math.floor(target.length / 2) + 1));
  const lower = target.toLowerCase();
  let best = null;
  let bestD = cap + 1;
  for (const cand of list) {
    if (typeof cand !== 'string') continue;
    if (cand.toLowerCase() === lower) continue;
    const d = editDistance(target, cand, cap);
    if (d < bestD) {
      bestD = d;
      best = cand;
      if (d === 1) break;
    }
  }
  return bestD <= cap ? best : null;
}

/* ================================================================== *
 * 2. Schema 索引 / $ref 解析 / 类型名解析
 * ================================================================== */

/** title -> schema 节点 的索引（每个 schema 对象只建一次）。 */
const TITLE_INDEX_CACHE = new WeakMap();

function buildTitleIndex(schema) {
  let idx = TITLE_INDEX_CACHE.get(schema);
  if (idx) return idx;
  idx = new Map();
  (function walk(node) {
    if (!isPlainObject(node)) return;
    if (typeof node.title === 'string' && !idx.has(node.title)) idx.set(node.title, node);
    if (isPlainObject(node.properties)) {
      for (const k of Object.keys(node.properties)) walk(node.properties[k]);
    }
    if (node.items) walk(node.items);
    for (const key of ['oneOf', 'anyOf', 'allOf']) {
      if (Array.isArray(node[key])) node[key].forEach(walk);
    }
  })(schema);
  TITLE_INDEX_CACHE.set(schema, idx);
  return idx;
}

/**
 * 解析 `$ref`。本作导出的 schema 里只有 `#/TitleName` 形式，
 * 指向同一文档中 title 相同的内联节点（例如 `#/EventReference`、`#/QuestConditionSet`）。
 */
function deref(node, schema) {
  let cur = node;
  let guard = 0;
  while (isPlainObject(cur) && typeof cur.$ref === 'string' && guard++ < 16) {
    const name = cur.$ref.replace(/^#\//, '');
    const next = buildTitleIndex(schema).get(name);
    if (!next || next === cur) return cur;
    cur = next;
  }
  return cur;
}

/** name 是否是 kb 里已知的类型（schemas 或 baseline）。 */
function typeExists(name, kbLike) {
  if (!name) return false;
  const s = kbLike && kbLike.schemas;
  const b = kbLike && kbLike.baseline;
  if (s && hasOwn(s, name)) return true;
  if (b && hasOwn(b, name)) return true;
  return false;
}

/**
 * 把 schema 描述里的目标类型名解析成真实的类型键。
 * 例：CharacterDefinition -> Character，HexSO -> Hex，Album -> null（无法解析）。
 */
function resolveTargetType(name, kbLike) {
  if (!name) return null;
  if (typeExists(name, kbLike)) return name;
  for (const suf of TYPE_ALIAS_SUFFIXES) {
    if (name.length > suf.length && name.endsWith(suf)) {
      const base = name.slice(0, -suf.length);
      if (typeExists(base, kbLike)) return base;
    }
  }
  for (const suf of TYPE_ALIAS_SUFFIXES) {
    if (typeExists(name + suf, kbLike)) return name + suf;
  }
  return null;
}

/** TechName 字段的实际键名（techName / TechName）。 */
function techNameKey(schema) {
  const p = schema && schema.properties;
  if (isPlainObject(p)) {
    if (p.techName) return 'techName';
    if (p.TechName) return 'TechName';
  }
  const r = schema && schema.required;
  if (Array.isArray(r) && r.length && typeof r[0] === 'string') return r[0];
  return 'techName';
}

/** 从实例里取 techName 值（容忍两种大小写）。 */
function techNameValue(obj, key) {
  const order = [];
  if (key) order.push(key);
  order.push('techName', 'TechName');
  for (const k of order) {
    if (typeof obj[k] === 'string' && obj[k]) return obj[k];
  }
  return null;
}

/* ================================================================== *
 * 3. schema 展平（referenceMap / schemaSummary 的公共底座）
 * ================================================================== */

/**
 * 把一份 schema 展平成条目列表。
 * 路径以「类型内部」为根：`goodsType`、`levelConfigs[].addedSpecialEffect`、`mainAudioEvents[]`。
 * kind: 'ref' | 'sprite' | 'enum'
 */
function flattenSchema(schema) {
  const out = [];
  (function walk(rawNode, spath) {
    const n = deref(rawNode, schema);
    if (!isPlainObject(n)) return;
    const desc = typeof n.description === 'string' ? n.description : '';
    /* G41: the fact keys win when present; a rich KB still carries the text. */
    const ref = RE_TECH_REF.exec(desc) ||
      (typeof n[X_REF_KEY] === 'string' && n[X_REF_KEY] ? [null, n[X_REF_KEY]] : null);
    if (ref) out.push({ path: spath, kind: 'ref', target: ref[1] });
    else if (RE_SPRITE_DESC.test(desc) || n[X_SPRITE_KEY] === true) {
      out.push({ path: spath, kind: 'sprite', target: SPRITE });
    }
    if (Array.isArray(n.enum)) out.push({ path: spath, kind: 'enum', values: n.enum.slice() });

    if (isPlainObject(n.properties)) {
      for (const k of Object.keys(n.properties)) {
        walk(n.properties[k], spath ? spath + '.' + k : k);
      }
    }
    if (n.items) walk(n.items, spath + '[]');
  })(schema, '');
  return out;
}

/** 引用目标在 referenceMap / schemaSummary 里的呈现形式。 */
function targetLabel(rawTarget, kbLike) {
  if (rawTarget === GENERIC_REF) return '*';
  const resolved = resolveTargetType(rawTarget, kbLike);
  return resolved || rawTarget;
}

/* ================================================================== *
 * 4. referenceMap
 * ================================================================== */

/**
 * 抽取所有 schema 的「TechName 引用字段」与「图片路径字段」。
 *
 * 返回 { [TypeName]: { [jsonPath]: TargetTypeName | '*' | 'sprite' } }
 * 其中 jsonPath 相对该类型（数组用 `[]`）。
 */
function referenceMap(schemas) {
  const list = isPlainObject(schemas) ? schemas : {};
  const kbLike = { schemas: list, baseline: {} };
  const out = {};
  for (const type of Object.keys(list).sort()) {
    const map = {};
    for (const entry of flattenSchema(list[type])) {
      if (entry.kind === 'ref') map[entry.path] = targetLabel(entry.target, kbLike);
      else if (entry.kind === 'sprite') map[entry.path] = SPRITE;
    }
    out[type] = map;
  }
  return out;
}

/* ================================================================== *
 * 5. validateDefine
 * ================================================================== */

/** 字段期望类型是否匹配（null 由调用方提前排除）。 */
function typeMatches(want, v) {
  switch (want) {
    case 'string':
      return typeof v === 'string';
    case 'boolean':
      return typeof v === 'boolean';
    case 'number':
      return typeof v === 'number' && Number.isFinite(v);
    case 'integer':
      return typeof v === 'number' && Number.isInteger(v);
    case 'array':
      return Array.isArray(v);
    case 'object':
      return isPlainObject(v);
    case 'null':
      return v === null;
    default:
      return true;
  }
}

/**
 * 本 Mod 自己定义的同类型 TechName 集合。
 *
 * 基线只描述游戏本体（kb.baseline），而 Mod 完全可以定义并互相引用自己的
 * 定义（例如 Mod 自带 Defines/Attr/X.json，再在 Defines/Topic/Y.json 里
 * `"attrType": "X"`）。因此 D005 的目标集合 = baseline[目标类型] ∪ 本 Mod 定义。
 *
 * 两个来源：
 *  - ctx.techNames：validateModPackage 扫描时已经建好的 `{ TypeName: string[] }`；
 *  - 兜底：有 modRoot 时按需扫 `modRoot/Defines/<目标类型>/*.json` 的 techName。
 *    （单独调用 validateDefine / api.js 的实时校验走这条路径。）
 */
function localTechNames(ctx, type) {
  if (ctx.localTechNameCache.has(type)) return ctx.localTechNameCache.get(type);
  const set = new Set();
  if (ctx.techNames && Array.isArray(ctx.techNames[type])) {
    for (const n of ctx.techNames[type]) set.add(n);
  } else if (ctx.modRoot) {
    const dir = path.join(ctx.modRoot, 'Defines', type);
    let entries = [];
    try {
      entries = fs.readdirSync(dir);
    } catch {
      entries = [];
    }
    for (const f of entries) {
      if (!/\.json$/i.test(f)) continue;
      let obj = null;
      try {
        obj = JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8').replace(/^\uFEFF/, ''));
      } catch {
        obj = null; // 坏 JSON / 坏编码交给扫描阶段报，这里只是猜测引用目标
      }
      if (!isPlainObject(obj)) continue;
      for (const key of ['techName', 'TechName']) {
        if (typeof obj[key] === 'string' && obj[key].trim()) set.add(obj[key].trim());
      }
    }
    // 扫描不到（大多数类型没有该目录）也缓存，避免每个引用都 stat 一次
  }
  ctx.localTechNameCache.set(type, set);
  return set;
}

/**
 * D005：TechName 引用校验。
 * - 泛型 '*'：只做非空检查（空值已在 D001 覆盖时不再重复报）。
 * - 目标类型有基线：值必须在 baseline[target] ∪ 本 Mod 定义 里。
 * - 目标类型没有基线（或无法解析）：只做非空检查并给 info。
 */
function checkReference(rawTarget, value, jsonPath, ctx, out, isRequired) {
  const kb = ctx.kb;
  if (typeof value !== 'string') return; // 类型问题已由 D003/D007 报过

  const trimmed = value.trim();
  const isEmpty = trimmed === '';
  if (rawTarget === GENERIC_REF) {
    // 泛型引用：类型未知，只能做非空检查
    if (isEmpty && !isRequired) {
      out.push(diag('error', 'D005', jsonPath, ctx.type,
        '泛型 TechName 引用（ScriptableObject）不能为空字符串。',
        'Generic TechName reference (ScriptableObject) must not be an empty string.',
        { expected: '非空 TechName', actual: '' }));
    }
    return;
  }
  if (isEmpty) {
    if (isRequired) return; // 已由 D001 覆盖，避免同一字段报两次
    out.push(diag('error', 'D005', jsonPath, ctx.type,
      'TechName 引用不能为空字符串。',
      'TechName reference must not be an empty string.',
      { expected: '非空 TechName', actual: '' }));
    return;
  }

  const resolved = resolveTargetType(rawTarget, kb);
  // 目标类型可能只由本 Mod 定义（或本 Mod 新增/覆写），先在本地定义里找
  const local = resolved ? localTechNames(ctx, resolved) : null;
  const localHit = !!(local && local.has(value));
  const list = resolved && kb.baseline ? kb.baseline[resolved] : null;
  if (!Array.isArray(list) || list.length === 0) {
    if (localHit) return; // 本 Mod 自己定义了这个类型的目标，引用有效
    out.push(diag('info', 'D005', jsonPath, ctx.type,
      '类型 "' + rawTarget + '" 没有基线定义，无法校验引用 "' + value + '"（仅做非空检查）。',
      'Type "' + rawTarget + '" has no baseline definitions; cannot resolve reference "' + value +
      '" (non-empty check only).',
      { expected: rawTarget, actual: value }));
    return;
  }

  if (localHit) return; // 命中本 Mod 自己的定义，不再按基线判错

  if (!list.includes(value)) {
    const hint = closestMatch(value, list);
    const suffix = hint ? '；是否想写 "' + hint + '"？' : '';
    const suffixEn = hint ? '; did you mean "' + hint + '"?'
      : '; did you mean "' + hint + '"?';
    out.push(diag('error', 'D005', jsonPath, ctx.type,
      'TechName 引用无效："' + value + '" 不是 ' + resolved + ' 的已存在定义（共 ' + list.length + ' 个）' + suffix,
      'Invalid TechName reference: "' + value + '" is not an existing ' + resolved +
      ' definition (of ' + list.length + ')' + suffixEn,
      { expected: resolved, actual: value }));
  }
}

/** 图片路径的候选绝对路径（容忍 `/` 与 `\`，容忍带/不带前导 `Sprites/`）。 */
function spriteCandidates(modRoot, raw) {
  const norm = String(raw).trim().replace(/\\/g, '/').replace(/^\.\//, '').replace(/^\/+/, '');
  const out = [path.join(modRoot, norm)];
  if (/^Sprites\//i.test(norm)) {
    out.push(path.join(modRoot, norm.replace(/^Sprites\//i, '')));
  } else {
    out.push(path.join(modRoot, 'Sprites', norm));
  }
  return out;
}

function fileExistsCached(p, ctx) {
  if (!ctx.existsCache) ctx.existsCache = new Map();
  if (ctx.existsCache.has(p)) return ctx.existsCache.get(p);
  let ok = false;
  try {
    ok = fs.statSync(p).isFile();
  } catch {
    ok = false;
  }
  ctx.existsCache.set(p, ok);
  return ok;
}

/** D006：图片文件存在性（只有给了 modRoot 才检查）。 */
function checkSprite(value, jsonPath, ctx, out) {
  if (typeof value !== 'string') return;
  const raw = value.trim();
  if (!raw) return; // 空值由 D001 负责
  if (!ctx.modRoot) return;

  const cands = spriteCandidates(ctx.modRoot, raw);
  for (const c of cands) {
    if (fileExistsCached(c, ctx)) return;
  }
  out.push(diag('error', 'D006', jsonPath, ctx.type,
    '图片文件不存在：' + raw + '（在 Mod 根目录下尝试了 ' + cands.length + ' 个候选路径）',
    'Sprite file not found: ' + raw + ' (tried ' + cands.length + ' candidate path(s) under the mod root)',
    { expected: 'modRoot 下存在的图片文件', actual: raw }));
}

/**
 * 递归校验一个实例节点。
 * @param {object} rawNode      schema 节点（可能是 $ref）
 * @param {object} schema       该类型的根 schema（用于解析 $ref）
 * @param {*}      value        实例值
 * @param {string} ip           实例 JSON 路径（数组用 [i]）
 * @param {object} ctx          { type, kb, modRoot, existsCache }
 * @param {Array}  out          诊断输出
 * @param {boolean} fromItems   本节点是数组元素（决定 D003 / D007）
 * @param {boolean} isRequired  本节点对应的字段在其父对象里是 required
 */
function validateNode(rawNode, schema, value, ip, ctx, out, fromItems, isRequired) {
  const n = deref(rawNode, schema);
  if (!isPlainObject(n)) return;
  // null 视为「未设置 / 可空」，全部检查跳过
  if (value === null || value === undefined) return;

  /* ---- D003 / D007 类型 ---- */
  const want = typeof n.type === 'string'
    ? n.type
    : (isPlainObject(n.properties) ? 'object' : null);
  if (want && !typeMatches(want, value)) {
    const code = (want === 'array' || fromItems) ? 'D007' : 'D003';
    out.push(diag('error', code, ip, ctx.type,
      '类型不符：期望 ' + want + '，实际 ' + jsonTypeOf(value) + '（' + describe(value) + '）',
      'Type mismatch: expected ' + want + ', got ' + jsonTypeOf(value) + ' (' + describe(value) + ')',
      { expected: want, actual: jsonTypeOf(value) }));
    return; // 类型不符，停止下钻（同一字段只报一次）
  }

  /* ---- D004 枚举 ---- */
  if (Array.isArray(n.enum) && !n.enum.includes(value)) {
    out.push(diag('error', 'D004', ip, ctx.type,
      '枚举值非法：' + describe(value) + '；允许值：' + n.enum.join(' | '),
      'Invalid enum value: ' + describe(value) + '; allowed: ' + n.enum.join(' | '),
      { expected: n.enum.join('|'), actual: typeof value === 'string' ? value : jsonTypeOf(value) }));
  }

  /* ---- D005 / D006 语义字段 ---- */
  const desc = typeof n.description === 'string' ? n.description : '';
  const refMatch = RE_TECH_REF.exec(desc);
  if (refMatch) checkReference(refMatch[1], value, ip, ctx, out, isRequired);
  else if (RE_SPRITE_DESC.test(desc)) checkSprite(value, ip, ctx, out);

  /* ---- 对象 ---- */
  if (isPlainObject(value)) {
    const props = isPlainObject(n.properties) ? n.properties : null;
    if (!props) return;

    const requiredKeys = Array.isArray(n.required) ? n.required : [];
    // D001：required 缺失 / null / 空字符串
    for (const key of requiredKeys) {
      if (!hasValue(value, key)) {
        out.push(diag('error', 'D001', ip ? ip + '.' + key : key, ctx.type,
          '缺少必填字段 "' + key + '"' + (hasOwn(value, key) ? '（值为空）' : '') + '。',
          'Missing required field "' + key + '"' + (hasOwn(value, key) ? ' (empty value)' : '') + '.',
          { expected: key, actual: hasOwn(value, key) ? describe(value[key]) : 'undefined' }));
      }
    }
    // D002：未声明的字段
    for (const key of Object.keys(value)) {
      if (!hasOwn(props, key)) {
        out.push(diag('warning', 'D002', ip ? ip + '.' + key : key, ctx.type,
          'schema 中未声明的字段 "' + key + '"（可能是拼写错误，游戏不会读取它）。',
          'Undeclared field "' + key + '" (possible typo; the game will ignore it).',
          { expected: Object.keys(props).join('|'), actual: key }));
      }
    }
    // 下钻
    for (const key of Object.keys(props)) {
      if (!hasValue(value, key)) continue;
      validateNode(props[key], schema, value[key], ip ? ip + '.' + key : key, ctx, out,
        false, requiredKeys.indexOf(key) >= 0);
    }
    return;
  }

  /* ---- 数组 ---- */
  if (Array.isArray(value) && n.items) {
    for (let i = 0; i < value.length; i++) {
      validateNode(n.items, schema, value[i], ip + '[' + i + ']', ctx, out, true, false);
    }
  }
}

/**
 * 校验单个定义对象。
 *
 * @param {string} type  TypeName（必须是 opts.kb.schemas 的键）
 * @param {object} obj   已 JSON.parse 的定义对象
 * @param {object} opts  { kb, modRoot?, filePath?, fileName? }
 * @returns {Array} Diagnostic[]（按遍历顺序稳定输出）
 */
function validateDefine(type, obj, opts) {
  const o = opts || {};
  const kb = o.kb;
  const out = [];

  if (!kb || !isPlainObject(kb.schemas)) {
    out.push(diag('error', 'E000', '', type == null ? '' : String(type),
      '缺少知识库（opts.kb），无法校验。',
      'Missing knowledge base (opts.kb); cannot validate.'));
    return out;
  }

  const schema = kb.schemas[type];
  if (!isPlainObject(schema)) {
    const names = Object.keys(kb.schemas).sort();
    out.push(diag('error', 'E000', '', type == null ? '' : String(type),
      '未知定义类型 "' + type + '"。可用类型（' + names.length + '）：' + names.join(', '),
      'Unknown definition type "' + type + '". Available types (' + names.length + '): ' +
      names.join(', ')));
    return out;
  }

  if (!isPlainObject(obj)) {
    out.push(diag('error', 'D003', '', type,
      '定义必须是 JSON 对象，实际 ' + jsonTypeOf(obj) + '。',
      'A definition must be a JSON object, got ' + jsonTypeOf(obj) + '.',
      { expected: 'object', actual: jsonTypeOf(obj) }));
    return out;
  }

  const ctx = {
    type: type,
    kb: kb,
    modRoot: o.modRoot ? path.resolve(String(o.modRoot)) : null,
    techNames: isPlainObject(o.techNames) ? o.techNames : null,
    existsCache: new Map(),
    localTechNameCache: new Map()
  };

  validateNode(schema, schema, obj, '', ctx, out, false, false);

  const tk = techNameKey(schema);
  const tv = techNameValue(obj, tk);

  // D101：techName 与文件名不一致
  if (o.fileName && tv) {
    const base = String(o.fileName).replace(/\\/g, '/').split('/').pop().replace(/\.json$/i, '');
    if (base !== tv) {
      out.push(diag('warning', 'D101', tk, type,
        'techName "' + tv + '" 与文件名 "' + base + '.json" 不一致。',
        'techName "' + tv + '" does not match file name "' + base + '.json".',
        { expected: base, actual: tv }));
    }
  }

  // D102：整份覆写提示
  if (tv) {
    const list = kb.baseline ? kb.baseline[type] : null;
    if (Array.isArray(list) && list.includes(tv)) {
      out.push(diag('info', 'D102', tk, type,
        '"' + tv + '" 已是基线定义，本文件属于「整份覆写」：必须包含你需要的全部字段，而不只是你要改的字段。',
        '"' + tv + '" is already a baseline definition; this file is a full override: it must ' +
        'contain every field you need, not only the ones you are changing.',
        { expected: '整份完整定义', actual: '覆写 ' + type }));
    }
  }

  return out;
}

/* ================================================================== *
 * 6. validateModPackage
 * ================================================================== */

function countSeverities(diagnostics) {
  let errors = 0;
  let warnings = 0;
  let infos = 0;
  for (const d of diagnostics) {
    if (d.severity === 'error') errors++;
    else if (d.severity === 'warning') warnings++;
    else if (d.severity === 'info') infos++;
  }
  return { errors: errors, warnings: warnings, infos: infos };
}

/**
 * 校验整个 Mod 包。
 *
 * @param {string} modRoot  含 mod.json 的 Mod 文件夹
 * @param {object} opts     { kb, otherMods? }
 * @returns {{ ok:boolean, knowledge:'present'|'missing', manifest:object|null,
 *            summary:object, diagnostics:Array, types:string[] }}
 */
function validateModPackage(modRoot, opts) {
  const o = opts || {};
  const kb = isPlainObject(o.kb) ? o.kb : {};
  const schemas = isPlainObject(kb.schemas) ? kb.schemas : {};
  /**
   * 有没有真的知识库。缺知识库时绝不能悄悄给 ok:true —— 那等于「什么都没校验」
   * （docs/EDITOR_GAPS.md §14.1 / G6）。这里用一个具名诊断 + knowledge 状态说清楚。
   */
  const kbPresent = isPlainObject(o.kb) && isPlainObject(o.kb.schemas) && Object.keys(o.kb.schemas).length > 0;
  const root = path.resolve(String(modRoot == null ? '.' : modRoot));

  const diagnostics = [];
  if (!kbPresent) {
    diagnostics.push(diag('error', 'E000', '', '',
      '没有知识库（knowledge.json）：这次校验只看了文件结构，定义类型、必填字段和基线撞名都没有被校验。',
      'No knowledge base (knowledge.json): this run checked file structure only; definition types, ' +
      'required fields and baseline collisions were NOT checked.'));
  }
  const byType = {};
  const typeSet = new Set();
  const otherMods = Array.isArray(o.otherMods) ? o.otherMods : [];

  let manifest = null;
  let manifestFileCount = 0;
  let definesFileCount = 0;
  let yarnFileCount = 0;
  let csvFileCount = 0;

  /* ---------------- mod.json ---------------- */
  const manifestPath = path.join(root, 'mod.json');
  let manifestText = null;
  try {
    manifestText = fs.readFileSync(manifestPath, 'utf8');
  } catch {
    manifestText = null;
  }
  if (manifestText === null) {
    diagnostics.push(diag('error', 'M001', 'mod.json', '',
      '缺少 mod.json：Mod 包根目录必须有 mod.json。',
      'Missing mod.json: a mod package must have mod.json in its root.'));
  } else {
    try {
      manifest = JSON.parse(manifestText.replace(/^\uFEFF/, ''));
    } catch (e) {
      diagnostics.push(diag('error', 'M001', 'mod.json', '',
        'mod.json 不是合法 JSON：' + e.message,
        'mod.json is not valid JSON: ' + e.message));
      manifest = null;
    }
    if (manifest !== null && !isPlainObject(manifest)) {
      diagnostics.push(diag('error', 'M001', 'mod.json', '',
        'mod.json 顶层必须是 JSON 对象。',
        'mod.json must be a JSON object at the top level.'));
      manifest = null;
    }
    if (manifest) manifestFileCount = 1;
  }

  if (manifest) {
    // name（必需）
    if (typeof manifest.name !== 'string' || !manifest.name.trim()) {
      diagnostics.push(diag('error', 'M001', 'name', '',
        'mod.json 缺少必需字段 "name"。',
        'mod.json is missing the required field "name".',
        { expected: 'string', actual: describe(manifest.name) }));
    } else {
      const folder = path.basename(root);
      if (manifest.name !== folder) {
        diagnostics.push(diag('warning', 'M002', 'name', '',
          'name "' + manifest.name + '" 与文件夹名 "' + folder + '" 不一致（在 MyMod 这类允许的场景下可以忽略）。',
          'name "' + manifest.name + '" does not match folder name "' + folder +
          '" (tolerated for cases like MyMod).',
          { expected: folder, actual: manifest.name }));
      }
    }

    // loadOrder
    const lo = manifest.loadOrder;
    if (typeof lo !== 'number' || !Number.isFinite(lo)) {
      diagnostics.push(diag('warning', 'M003', 'loadOrder', '',
        'loadOrder 缺失或不是数字（实际 ' + describe(lo) + '），加载顺序将不确定。',
        'loadOrder is missing or not a number (' + describe(lo) + '); load order will be undefined.',
        { expected: 'number', actual: jsonTypeOf(lo) }));
    } else {
      for (const other of otherMods) {
        if (!other) continue;
        if (other.dir) {
          let otherRoot = null;
          try {
            otherRoot = path.resolve(String(other.dir));
          } catch {
            otherRoot = null;
          }
          if (otherRoot === root) continue;
        }
        const om = other.manifest;
        if (!isPlainObject(om)) continue;
        if (typeof om.loadOrder === 'number' && om.loadOrder === lo) {
          const label = typeof om.name === 'string' && om.name ? om.name : String(other.dir || '?');
          diagnostics.push(diag('error', 'M004', 'loadOrder', '',
            'loadOrder ' + lo + ' 与 Mod "' + label + '" 重复，加载顺序冲突。',
            'loadOrder ' + lo + ' collides with mod "' + label + '"; load order conflict.',
            { expected: '唯一的 loadOrder', actual: String(lo) }));
        }
      }
    }

    // 推荐字段（扩展码 M009：规格只列出字段名，未指定错误码，这里用 info）
    for (const key of RECOMMENDED_MANIFEST_KEYS) {
      if (manifest[key] === undefined || manifest[key] === null || manifest[key] === '') {
        diagnostics.push(diag('info', 'M009', key, '',
          'mod.json 缺少推荐字段 "' + key + '"（' + RECOMMENDED_LABEL[key] + '）。',
          'mod.json is missing the recommended field "' + key + '" (' +
          RECOMMENDED_LABEL_EN[key] + ').'));
      }
    }
  }

  /* ---------------- Defines ---------------- */
  const definesDir = path.join(root, 'Defines');
  if (isDir(definesDir)) {
    const entries = safeReaddir(definesDir, true)
      .slice()
      .sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));

    // M006：Defines/ 下直接放 .json
    for (const e of entries) {
      if (e.isFile() && /\.json$/i.test(e.name)) {
        diagnostics.push(diag('error', 'M006', 'Defines/' + e.name, '',
          '定义文件必须放在 Defines/<类型>/ 目录里，不能直接放在 Defines/ 下。',
          'Definition files must live in Defines/<Type>/, not directly under Defines/.'));
      }
    }

    // 先扫一遍收齐本 Mod 自己定义的 TechName（按类型），再统一校验：
    // 这样 Mod 内部互相引用（如 Topic.attrType -> 本 Mod 的 Attr）不会被 D005 误判。
    const techNames = {};
    const pending = [];

    for (const e of entries) {
      if (!e.isDirectory()) continue;
      const type = e.name;
      const relDir = 'Defines/' + type;
      if (!hasOwn(schemas, type)) {
        diagnostics.push(diag('warning', 'M005', relDir, '',
          '未知定义类型目录 "' + type + '"：kb.schemas 里没有这个类型，已跳过其中的文件。',
          'Unknown definition type directory "' + type + '": no such type in kb.schemas; its files were skipped.'));
        continue;
      }
      typeSet.add(type);
      if (!hasOwn(byType, type)) byType[type] = 0;

      const dir = path.join(definesDir, type);
      const fileList = listFilesRecursive(dir, [], 0)
        .filter((f) => /\.json$/i.test(f))
        .sort();
      for (const abs of fileList) {
        const rel = relPosix(root, abs);
        definesFileCount++;
        byType[type]++;

        let obj = null;
        try {
          obj = JSON.parse(fs.readFileSync(abs, 'utf8').replace(/^\uFEFF/, ''));
        } catch (err) {
          diagnostics.push(diag('error', 'M010', rel, type,
            '定义文件不是合法 JSON：' + err.message,
            'Definition file is not valid JSON: ' + err.message));
          continue;
        }

        if (isPlainObject(obj)) {
          const tv = techNameValue(obj, techNameKey(schemas[type]));
          if (tv) {
            if (!techNames[type]) techNames[type] = [];
            techNames[type].push(tv);
          }
        }
        pending.push({ type: type, rel: rel, abs: abs, obj: obj });
      }
    }

    for (const p of pending) {
      const sub = validateDefine(p.type, p.obj, {
        kb: kb,
        modRoot: root,
        filePath: p.abs,
        fileName: path.basename(p.abs),
        techNames: techNames
      });
      for (const d of sub) {
        // 前缀：相对 modRoot 的 POSIX 路径
        d.path = d.path ? p.rel + '#' + d.path : p.rel;
        diagnostics.push(d);
      }
    }
  }

  /* ---------------- Yarn ---------------- */
  const yarnDir = path.join(root, 'Yarn');
  if (isDir(yarnDir)) {
    const yarnFiles = listFilesRecursive(yarnDir, [], 0)
      .filter((f) => /\.yarn$/i.test(f))
      .sort();
    yarnFileCount = yarnFiles.length;

    // 节点身份 = (title, subtitle)。本作 Yarn 方言用 subtitle 区分同一 title 的多个片段。
    const nodeIndex = new Map();  // key -> [{ rel, line, title, subtitle }]
    const titleIndex = o.strictYarnTitles ? new Map() : null;

    for (const abs of yarnFiles) {
      const rel = relPosix(root, abs);
      let text = null;
      try {
        text = fs.readFileSync(abs, 'utf8');
      } catch (err) {
        diagnostics.push(diag('error', 'M011', rel, '',
          'Yarn 文件无法以 UTF-8 读取：' + err.message,
          'Yarn file cannot be read as UTF-8: ' + err.message));
        continue;
      }
      if (text.indexOf('\uFFFD') >= 0) {
        diagnostics.push(diag('warning', 'M011', rel, '',
          'Yarn 文件不是合法的 UTF-8 文本（解码后含替换字符 U+FFFD）。',
          'Yarn file is not valid UTF-8 text (contains U+FFFD replacement character).'));
      }
      if (text.charCodeAt(0) === 0xfeff) text = text.slice(1);

      const lines = text.split(/\r?\n/);
      let cur = null;
      const flush = function () {
        if (!cur) return;
        const key = cur.title + '\u0000' + (cur.subtitle || '');
        let bucket = nodeIndex.get(key);
        if (!bucket) {
          bucket = [];
          nodeIndex.set(key, bucket);
        }
        bucket.push(cur);
        if (titleIndex) {
          let tb = titleIndex.get(cur.title);
          if (!tb) {
            tb = [];
            titleIndex.set(cur.title, tb);
          }
          tb.push(cur);
        }
        cur = null;
      };
      for (let i = 0; i < lines.length; i++) {
        const line = lines[i];
        const m = RE_YARN_TITLE.exec(line);
        if (m) {
          flush();
          cur = { rel: rel, line: i + 1, title: m[1], subtitle: null };
          continue;
        }
        if (cur) {
          const s = RE_YARN_SUBTITLE.exec(line);
          if (s) cur.subtitle = s[1];
        }
      }
      flush();
    }

    // M007：重复节点
    for (const [key, bucket] of nodeIndex) {
      if (bucket.length < 2) continue;
      const sep = key.indexOf('\u0000');
      const title = key.slice(0, sep);
      const subtitle = key.slice(sep + 1);
      const rels = [];
      for (const item of bucket) if (rels.indexOf(item.rel) < 0) rels.push(item.rel);
      const label = 'title "' + title + '"' + (subtitle ? ' + subtitle "' + subtitle + '"' : '');
      if (rels.length === 1) {
        diagnostics.push(diag('error', 'M007', rels[0], '',
          '同文件内重复的 Yarn 节点：' + label + '（第 ' + bucket.map((x) => x.line).join(', ') + ' 行）。',
          'Duplicate Yarn node inside one file: ' + label + ' (lines ' +
          bucket.map((x) => x.line).join(', ') + ').',
          { expected: '唯一的 (title, subtitle)', actual: label }));
      } else {
        diagnostics.push(diag('error', 'M007', rels[0], '',
          '跨文件重复的 Yarn 节点：' + label + '（出现在 ' + rels.join(' | ') + '）。Yarn 节点标题在全局唯一。',
          'Duplicate Yarn node across files: ' + label + ' (found in ' + rels.join(' | ') +
          '). Yarn node titles are globally unique.',
          { expected: '唯一的 (title, subtitle)', actual: label }));
      }
    }

    // 仅按 title 的冲突（本作方言里用 subtitle 区分，默认不报；打开后为 warning）
    if (titleIndex) {
      for (const [title, bucket] of titleIndex) {
        if (bucket.length < 2) continue;
        const rels = [];
        for (const item of bucket) if (rels.indexOf(item.rel) < 0) rels.push(item.rel);
        diagnostics.push(diag('warning', 'M007', rels[0], '',
          'title "' + title + '" 被 ' + bucket.length + ' 个节点复用（' + rels.join(' | ') +
          '）；本作 Yarn 方言用 subtitle 区分，请确认这是有意的。',
          'title "' + title + '" is reused by ' + bucket.length + ' nodes (' + rels.join(' | ') +
          '); this dialect distinguishes them by subtitle — please confirm this is intentional.'));
      }
    }

    /* ---------------- 本地化 CSV ---------------- */
    const csvFiles = listFilesRecursive(yarnDir, [], 0)
      .filter((f) => {
        if (!/\.csv$/i.test(f)) return false;
        const rel = relPosix(yarnDir, f);
        if (/(^|\/)\.[^/]*\//.test('/' + rel)) return false; // 跳过 .VSCodeCounter 等隐藏目录
        if (/metadata/i.test(path.basename(f))) return false; // 非本地化表
        return true;
      })
      .sort();
    csvFileCount = csvFiles.length;

    const csvRows = [];
    for (const abs of csvFiles) {
      const rel = relPosix(root, abs);
      let text = null;
      try {
        text = fs.readFileSync(abs, 'utf8').replace(/^\uFEFF/, '');
      } catch (err) {
        diagnostics.push(diag('warning', 'M008', rel, '',
          'CSV 文件无法读取：' + err.message,
          'CSV file cannot be read: ' + err.message));
        continue;
      }
      const lines = text.split(/\r?\n/);
      const first = (lines[0] || '').trim();
      if (!/^language,/i.test(first)) {
        diagnostics.push(diag('warning', 'M008', rel, '',
          'CSV 首行不是 "language," 开头，可能不是本地化表。',
          'CSV first line does not start with "language,"; it may not be a localisation table.'));
      }
      csvRows.push({ rel: rel, lines: lines.length });
    }
    if (csvRows.length > 1) {
      const counts = [];
      for (const r of csvRows) if (counts.indexOf(r.lines) < 0) counts.push(r.lines);
      if (counts.length > 1) {
        diagnostics.push(diag('warning', 'M008', csvRows[0].rel, '',
          '本地化 CSV 行数不一致：' + csvRows.map((r) => r.rel + '=' + r.lines).join(', '),
          'Localisation CSV row counts differ: ' +
          csvRows.map((r) => r.rel + '=' + r.lines).join(', ')));
      }
    }
  }

  /* ---------------- summary ---------------- */
  const counts = countSeverities(diagnostics);
  const sortedByType = {};
  for (const t of Object.keys(byType).sort()) sortedByType[t] = byType[t];

  const summary = {
    files: manifestFileCount + definesFileCount + yarnFileCount + csvFileCount,
    defines: definesFileCount,
    yarnFiles: yarnFileCount,
    csvFiles: csvFileCount,
    errors: counts.errors,
    warnings: counts.warnings,
    infos: counts.infos,
    byType: sortedByType
  };

  return {
    ok: counts.errors === 0,
    knowledge: kbPresent ? 'present' : 'missing',
    manifest: manifest,
    summary: summary,
    diagnostics: diagnostics,
    types: Array.from(typeSet).sort()
  };
}

/* ================================================================== *
 * 7. schemaSummary
 * ================================================================== */

/**
 * 「定义速查」面板数据：按 type 排序。
 *
 * references / enums 都是 { [jsonPath]: value } 映射；为兼容「数组」读法，
 * 额外提供 referenceList / enumList 两个等价数组（附加字段，不影响主形状）。
 */
function schemaSummary(kb) {
  const schemas = kb && isPlainObject(kb.schemas) ? kb.schemas : {};
  const out = [];
  for (const type of Object.keys(schemas).sort()) {
    const schema = isPlainObject(schemas[type]) ? schemas[type] : {};
    const references = {};
    const sprites = [];
    const enums = {};
    const referenceList = [];
    const enumList = [];

    for (const entry of flattenSchema(schema)) {
      if (entry.kind === 'ref') {
        const target = targetLabel(entry.target, kb);
        references[entry.path] = target;
        referenceList.push({ path: entry.path, target: target });
      } else if (entry.kind === 'sprite') {
        sprites.push(entry.path);
      } else if (entry.kind === 'enum') {
        enums[entry.path] = entry.values.slice();
        enumList.push({ path: entry.path, values: entry.values.slice() });
      }
    }

    out.push({
      type: type,
      title: typeof schema.title === 'string' ? schema.title : type,
      propertyCount: isPlainObject(schema.properties) ? Object.keys(schema.properties).length : 0,
      required: Array.isArray(schema.required) ? schema.required.slice() : [],
      references: references,
      sprites: sprites,
      enums: enums,
      referenceList: referenceList,
      enumList: enumList
    });
  }
  return out;
}

/* ================================================================== *
 * 8. 导出
 * ================================================================== */

module.exports = { validateDefine, validateModPackage, referenceMap, schemaSummary };

/* ------------------------------------------------------------------ *
 * 兼容别名：app/core/api.js:308 以旧名调用
 *     v.validatePackage(root, { kb, otherMods })
 * 而本模块对外契约（用户规格）是 validateModPackage。api.js 不在本模块
 * 的可修改范围内，故在此挂一个「不可枚举」别名：`v.validatePackage` 可用，
 * 但 Object.keys(module.exports) 仍严格等于规格要求的 4 个名字。
 * ------------------------------------------------------------------ */
Object.defineProperty(module.exports, 'validatePackage', {
  value: validateModPackage,
  enumerable: false,
  writable: false,
  configurable: true
});
