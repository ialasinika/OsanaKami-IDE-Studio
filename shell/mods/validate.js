'use strict';
/**
 * validate.js — 游戏 Mod IDE 定义校验器
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
 *      M012 warning  读不到游戏 Mods 目录：跨 Mod 检查已跳过（G3）
 *      D102 warning techName 已是基线定义（整份覆写提示；G3 由 info 提级）
 *      D103 error    同类型的 techName 已被兄弟 Mod 或同包另一个文件定义：
 *                    游戏对重复的 (类型, TechName) 保留先加载的那一份，后一份被静默丢弃（G3）
 *      D006（音频分支，G21）error  Song.externalAudioFile / VoiceOverDefinition.voiceOverFolder
 *                    或 voiceOverFiles[] 指向的文件/目录在 Mod 根目录下不存在
 *      D007（G46）warning/info  PNG 的位深/色型/隔行：像素卡打不开的变体是 warning，
 *                    8-bit RGB 是 info（像素卡保存会写成 RGBA）
 *      D008（G46）error/warning   WAV 头：不是 RIFF/WAVE/PCM 的报出来；采样率不是 44.1 kHz 是 info
 *      D009（G46）error/warning   Spine 三件套：缺图集/图集里的页图不存在/图集没有骨架是
 *                    error，骨架版本不是 4.2.43 是 warning（4.2.x 其余版本仍能读）
 *      D010（G46）warning/info   本地化 CSV：表头不是 8 列或缺 lock 列是 warning，
 *                    缺 BOM 或只有 LF 行尾是 info（游戏自己导出的表是 BOM + CRLF）
 *      M013（G4）warning  定义类型在 wiki 的支持矩阵里是“不支持独立扩展”：
 *                    能注册进 ModRegistry，但没有 manager 消费它（每个类型每包只报一次）
 *      M014（G4）info     定义类型只被部分支持：报出消费者 manager 与前提
 *                    （矩阵来自 shell/mods/support.json）
 *      D011（G22）error  Character.spineAssetPath 指向的骨架/图集在 Mod 根目录下不存在；
 *                    写成游戏自带的相对地址（Spine/*.skel.bytes）时也查包内是否存在
 *      D012（G6）error  schema 关键字约束（const/pattern/minLength/maxLength/minimum/
 *                    maximum/exclusiveMinimum/exclusiveMaximum/multipleOf/minItems/maxItems/
 *                    uniqueItems/oneOf/anyOf/allOf/not/additionalProperties:false）：知识库
 *                    目前没用到这些关键字，但导出的 schema 一旦带上它们，校验器必须真的读
 *      D013（G6）warning  schema 的 $ref 解析不到 title：这一段没有被校验（每次定义只报一次）
 *      D014（G7）warning  Yarn 里带 #line: 的对话行在本地化表里没有对应 id → 该行永远显示原文
 *      D015（G7）warning  本地化表里的行在 Yarn 里找不到对应 #line: → 译文永远不会出现
 *      D016（G7）warning  同一个 #line: id 出现在多个 Yarn 文件里 → 翻译目标有歧义
 *      D017（G7）info      #line: id 不是 line:<7 位 hex> 的约定形式（演示脚本常见），无法与表核对
 *      D018（G9）warning  Addressables 地址看起来是 Unity 资源路径/文件路径（游戏按 address 查）
 *      D019（G10）warning  EventReference（FMOD 事件引用）被当成普通字符串/普通对象手写：
 *                    它是 Unity/FMOD 序列化出来的 {Guid:{Data1..4},Path}，必须由游戏/编辑器
 *                    产生（或从现有定义复制），JSON 无法凭空指向一个 FMOD 事件
 *      D020（G10）warning  Yarn 文件在台词/条件里调用 GetTopic() / WasVisited()：
 *                    两者在对话求值时读的是“当下”的运行时状态并有副作用，wiki 记录的
 *                    陷阱是「把它当纯函数缓存结果」；每文件只报一次
 *      D021（G10）warning  文档记录的画布/初始变换与定义里的值不一致：
 *                    Character.initialTransform 应为 -7.2（语料里全是 float32 的
 *                    -7.199999809265137），画布类类型（UIAnimation）的几何字段应为 256×144
 *      D022（G10）warning/info  GUID 形状：全零 GUID 是 warning，8-4-4-4-12 的 .NET
 *                    写法或既非 32 hex 也非虚线 UUID 的值是 info（Unity 资源 GUID 是
 *                    32 位不带连字符的十六进制）
 *      D023（G38）warning  本地化表的 `lock` 列指不回本包任何一行文本：lock 是
 *                    sha256(text) 的前 4 字节、小写 hex，11 张译文表逐行沿用基础表
 *                    那一行的 lock（MyMod 语料 18609/18609 行成立）。改台词文本却没
 *                    重算 lock 时，游戏与翻译工具都以为译文仍锁在旧文本上。
 *
 *     D103 只在调用方给出 otherMods（游戏 Mods 目录里的兄弟包）时才跨 Mod 比较；
 *     同包内部的重名始终检查。兄弟包的 Defines 由 siblingTechNames() 建索引。
 *
 * 8. 兼容别名：app/core/api.js:308 用旧名 `validatePackage(root, {kb, otherMods})`
 *    调用本模块，本模块的对外契约则是 `validateModPackage`。故在导出对象上挂了
 *    一个不可枚举的 `validatePackage` 别名（见文件末尾），既不改变规格要求的
 *    4 个导出键，又能让 IDE 的「校验整个 Mod」按原样工作。
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const supportCore = require('./support.js');
const yarnCore = require('./yarn.js');

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

/*
 * G21：文件型音频引用。schema 对这些字段没有 description（知识库只记了字段名），
 * 所以这里按字段名识别；它们与 sprite 一样相对 Mod 根目录解析——语料里唯一的
 * 外部音频范例（官方 Mods/Audio 演示包）把 6 个 wav 全放在包根目录。
 */
const AUDIO_FILE_FIELDS = ['externalAudioFile', 'voiceOverFiles'];
const AUDIO_FOLDER_FIELD = 'voiceOverFolder';

/*
 * G22：立绘骨架路径。schema 里 `spineAssetPath` 只有 `{ "type": "string" }`，
 * 没有 description，所以既进不了 sprite 集合（RE_SPRITE_DESC），也不在任何引用
 * 映射里 —— 写错就是静默失效：定义能注册，角色却不会加载立绘。语料 56 个
 * Character 里有 30 个给了路径（全部写作 `Spine/<名字>.skel.bytes`，文件在
 * 包内 `Spine/` 下），26 个留空字符串表示使用默认/无立绘，空值不算错。
 */
const SPINE_ASSET_FIELD = 'spineAssetPath';

/*
 * G38：本地化表的 `lock` 列。语料实测（MyMod 11 张表 × 18609 行，2026-10）：
 * lock 是 sha256(`text` 列原文) 的前 4 字节、big-endian、小写 hex；`text` 列是
 * 含 "Speaker: " 前缀的整行文本；11 张译文表逐行沿用基础表那一行的 lock，
 * 18609/18609 全部匹配。所以「改了台词却没重算 lock」是可验证的错误：新文本的
 * hash 与表里记录的 lock 对不上。全零 lock 语料里不存在，但翻译工具常用它表示
 * “未锁定”，按“没有 lock”跳过，免把工具约定当成错误。
 */
const LOCK_SHAPE = /^[0-9a-f]{8}$/i;
const ZERO_LOCK = '00000000';
function lockOfText(text) {
  return crypto.createHash('sha256').update(String(text), 'utf8').digest('hex').slice(0, 8);
}

/*
 * G9：Addressables 地址。schema 里这些字段只有一句 "Addressable asset address"，
 * 既不是 TechName 引用也不是 sprite 路径，所以校验器过去对它们一个字都不看。
 * 游戏按 Addressables 窗口里登记的 address 查找；作者若把 Unity 资源路径
 * （Assets/.../Foo.prefab）当成 address 写进来，定义能注册、运行时却找不到。
 * 没有游戏资源清单可查，这里只做「像不像资源路径」的形状判断。
 */
const ADDRESSABLE_DESC = /^Addressable asset address$/i;

/*
 * G10：wiki 上记录、但导出的 schema 说不出来的四个陷阱。schema 只给了形状，
 * 没有给「这个形状不能手写」或「文档值是几」；不在这里说，作者就只能在游戏里
 * 看到“定义注册成功、效果没发生”。
 *
 * EventReference 是 Unity/FMOD 的事件引用：{ Guid:{Data1..4}, Path } 由编辑器
 * 序列化产生，手写的字符串（"event:/..."）或零散对象都不是一个事件。
 * 画布 256×144 与 initialTransform -7.2 来自游戏自己的 UI/角色场景约定；语料里
 * 56 个 Character 的 initialTransform 全是 -7.199999809265137（float32 舍入），
 * 所以比较用 epsilon 而不是 ===。UIAnimation 是知识库里唯一的画布类类型，它的
 * schema 目前没有几何字段——这条分支在今天的 KB 上不会命中，但游戏一旦导出
 * canvasWidth/canvasHeight 之类字段，它必须按文档的 256×144 检查。
 * Yarn 的 GetTopic()/WasVisited() 在求值时读运行时状态（WasVisited 还是占位实现），
 * 把它们当纯函数缓存结果就会在跳转之后继续用旧值。
 */
const CHARACTER_INITIAL_TRANSFORM = -7.2;
const INITIAL_TRANSFORM_EPSILON = 1e-4;
const CANVAS_WIDTH = 256;
const CANVAS_HEIGHT = 144;
const CANVAS_TYPES = new Set(['UIAnimation']);
const CANVAS_WIDTH_FIELD = /^(?:canvas|design|reference|resolution)?width$/i;
const CANVAS_HEIGHT_FIELD = /^(?:canvas|design|reference|resolution)?height$/i;
const CANVAS_SIZE_FIELD = /^(?:canvas|design|reference|resolution)?size$/i;
const GUID_32_HEX = /^[0-9a-f]{32}$/i;
const GUID_ZERO_32 = /^0{32}$/;
const GUID_DASHED = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const YARN_SIDE_EFFECT_CALL = /(^|[^A-Za-z0-9_])(GetTopic|WasVisited)[ \t]*\(/;

/*
 * G7：`#line:` id 与本地化表双向核对。表里 id 列的契约是 `line:<7 位 hex>`
 * （shell/web/storycsv.mjs 的 LINE_ID），Yarn 里的标记写成 `#line:<id>`。
 * 语料里另有 56 个非 hex 的演示 id（`#line:e4f5g6h`），它们本来就不会出现在
 * 表里，用 info 汇总一句，不当作缺翻译逐行报。
 */
const LINE_ID_CONTRACT = /^[0-9a-f]{7}$/;

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

/** D006：图片文件存在性（只有给了 modRoot 才检查）；G46 顺带体检 PNG 头。 */
function checkSprite(value, jsonPath, ctx, out) {
  if (typeof value !== 'string') return;
  const raw = value.trim();
  if (!raw) return; // 空值由 D001 负责
  if (!ctx.modRoot) return;

  const cands = spriteCandidates(ctx.modRoot, raw);
  for (const c of cands) {
    if (!fileExistsCached(c, ctx)) continue;
    checkPngFormat(c, jsonPath, ctx, out);
    return;
  }
  out.push(diag('error', 'D006', jsonPath, ctx.type,
    '图片文件不存在：' + raw + '（在 Mod 根目录下尝试了 ' + cands.length + ' 个候选路径）',
    'Sprite file not found: ' + raw + ' (tried ' + cands.length + ' candidate path(s) under the mod root)',
    { expected: 'modRoot 下存在的图片文件', actual: raw }));
}

/**
 * G21：音频路径的候选绝对路径。
 * 相对 Mod 根目录；若同一个定义给了 voiceOverFolder，也在该目录下找一遍
 * （两种写法都见过：文件名带目录，或文件名 + voiceOverFolder 分开写）。
 */
function audioCandidates(modRoot, raw, folder) {
  const norm = String(raw).trim().replace(/\\/g, '/').replace(/^\.\//, '').replace(/^\/+/, '');
  if (!norm) return [];
  const out = [path.join(modRoot, norm)];
  const dir = String(folder || '').trim().replace(/\\/g, '/').replace(/^\.\//, '').replace(/^\/+/, '');
  if (dir) out.push(path.join(modRoot, dir, norm));
  return out;
}

/** D006（G21 音频分支）：音频文件存在性；G46 顺带体检 WAV 头。 */
function checkAudioFile(raw, jsonPath, ctx, out, folder) {
  if (typeof raw !== 'string') return;
  const value = raw.trim();
  if (!value) return; // 空值由 D001 负责
  if (!ctx.modRoot) return;
  const cands = audioCandidates(ctx.modRoot, value, folder);
  for (const c of cands) {
    if (!fileExistsCached(c, ctx)) continue;
    checkWavFormat(c, jsonPath, ctx, out);
    return;
  }
  out.push(diag('error', 'D006', jsonPath, ctx.type,
    '音频文件不存在：' + value + '（在 Mod 根目录下尝试了 ' + cands.length + ' 个候选路径）',
    'Audio file not found: ' + value + ' (tried ' + cands.length + ' candidate path(s) under the mod root)',
    { expected: 'modRoot 下存在的音频文件', actual: value }));
}

/** D006（G21 音频分支）：voiceOverFolder 是一个目录，不是文件。 */
function checkAudioFolder(raw, jsonPath, ctx, out) {
  if (typeof raw !== 'string') return;
  const value = raw.trim();
  if (!value) return;
  if (!ctx.modRoot) return;
  const norm = value.replace(/\\/g, '/').replace(/^\.\//, '').replace(/^\/+/, '');
  let ok = false;
  try {
    ok = fs.statSync(path.join(ctx.modRoot, norm)).isDirectory();
  } catch {
    ok = false;
  }
  if (ok) return;
  out.push(diag('error', 'D006', jsonPath, ctx.type,
    '音频目录不存在：' + value + '（voiceOverFolder 必须是 Mod 根目录下的目录）',
    'Audio folder not found: ' + value + ' (voiceOverFolder must be a folder under the mod root)',
    { expected: 'modRoot 下存在的目录', actual: value }));
}

/* ------------------------------------------------------------------ *
 * G22：立绘骨架引用
 *
 * `Character.spineAssetPath` 指向包内 Spine 资产（语料写法 `Spine/<Character>.skel.bytes`），
 * 但它既不是 sprite 字段也不是引用字段，写错时游戏只会在运行时静默不加载立绘。
 * 这里只查「文件在不在」：骨架版本/图集/页图由 G46 的包级体检（D009）负责，
 * 逐文件重复报错没有意义。空字符串表示没有自定义立绘（语料 26/56），静默跳过。
 * ------------------------------------------------------------------ */

/** 立绘路径的候选绝对路径：相对包根，容忍多写/少写 `Spine/` 前缀。 */
function spineCandidates(modRoot, raw) {
  const norm = String(raw).trim().replace(/\\/g, '/').replace(/^\.\//, '').replace(/^\/+/, '');
  if (!norm) return [];
  const out = [path.join(modRoot, norm)];
  if (/^Spine\//i.test(norm)) out.push(path.join(modRoot, norm.slice(6)));
  else out.push(path.join(modRoot, 'Spine', norm));
  return out;
}

/** D011：spineAssetPath 的存在性；`.json` 骨架还要有同名图集。 */
function checkSpineAsset(raw, jsonPath, ctx, out) {
  if (typeof raw !== 'string') return;
  const value = raw.trim();
  if (!value) return; // 空字符串 = 使用默认立绘，不是错误
  if (!ctx.modRoot) return;
  const cands = spineCandidates(ctx.modRoot, value);
  let found = null;
  for (const c of cands) {
    if (fileExistsCached(c, ctx)) { found = c; break; }
  }
  if (!found) {
    out.push(diag('error', 'D011', jsonPath, ctx.type,
      '立绘骨架文件不存在：' + value + '（在 Mod 根目录下尝试了 ' + cands.length + ' 个候选路径）',
      'Spine asset not found: ' + value + ' (tried ' + cands.length + ' candidate path(s) under the mod root)',
      { expected: 'modRoot 下存在的 .skel.bytes / .json / .atlas 文件', actual: value }));
    return;
  }
  /*
   * Spine 的 JSON 导出与图集是两个文件；只给 .json 而没给同名 .atlas(.txt) 时，
   * 运行时同样加载失败。`.skel.bytes` 的这一份由 G46 的包级体检覆盖。
   */
  if (/\.json$/i.test(found)) {
    const base = found.slice(0, -5);
    if (!fileExistsCached(base + '.atlas', ctx) && !fileExistsCached(base + '.atlas.txt', ctx)) {
      out.push(diag('error', 'D011', jsonPath, ctx.type,
        '立绘骨架缺少同名图集：' + path.basename(base) + '.atlas（Spine 的 JSON 导出需要与图集一起交付）',
        'Spine skeleton has no atlas beside it: expected ' + path.basename(base) +
          '.atlas (a Spine JSON export ships with its atlas)',
        { expected: base + '.atlas', actual: path.basename(found) }));
    }
  }
}

/* ------------------------------------------------------------------ *
 * G46：文件格式体检
 *
 * 这层只读文件头，不解析整个文件：PNG 的 IHDR、WAV 的 RIFF/fmt 块、Spine 骨架
 * 开头的版本字符串、本地化 CSV 的表头与字节序。阈值来自语料实测（docs/EDITOR_GAPS.md
 * §18.3）：1461 张 PNG 全是 8-bit 非隔行（1436 RGBA + 25 RGB），6 个 WAV 全是
 * 44.1 kHz 16-bit PCM，79 组 Spine 全是 4.2.43；11 张本地化表里基础表
 * NewProject.csv 不带 BOM，其余 10 张是 BOM + CRLF + 8 列且带 lock。所以语料上只有
 * 两种真话：被引用的 18 张 RGB PNG 各一条 info，以及包级「BOM 不一致」一句；
 * Spine 与 WAV 全干净。检查只在真的偏离时说话。
 * ------------------------------------------------------------------ */

/** 读文件开头的 n 个字节，按 `abs|n` 缓存在 ctx 上；读不到返回 null。 */
function readHeadCached(abs, n, ctx) {
  if (!ctx.headCache) ctx.headCache = new Map();
  const key = abs + '|' + n;
  if (ctx.headCache.has(key)) return ctx.headCache.get(key);
  let out = null;
  try {
    const fd = fs.openSync(abs, 'r');
    try {
      const buf = Buffer.alloc(n);
      const got = fs.readSync(fd, buf, 0, n, 0);
      out = buf.subarray(0, got);
    } finally {
      fs.closeSync(fd);
    }
  } catch {
    out = null;
  }
  ctx.headCache.set(key, out);
  return out;
}

/** 同一个文件同一种码只报一次（一张图会被很多定义引用）。 */
function formatDiagOnce(ctx, out, abs, code, severity, jsonPath, type, zh, en, extra) {
  if (!ctx.formatSeen) ctx.formatSeen = new Set();
  const key = abs + '|' + code;
  if (ctx.formatSeen.has(key)) return;
  ctx.formatSeen.add(key);
  out.push(diag(severity, code, jsonPath, type, zh, en, extra));
}

const PNG_SIGNATURE = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];

/** D007：PNG 的位深 / 色型 / 隔行。图片存在时由 checkSprite 调用。 */
function checkPngFormat(abs, jsonPath, ctx, out) {
  const b = readHeadCached(abs, 33, ctx);
  if (!b || b.length < 8) return; // 读不到：存在性检查已经管了
  let sig = true;
  for (let i = 0; i < PNG_SIGNATURE.length; i++) if (b[i] !== PNG_SIGNATURE[i]) sig = false;
  if (!sig) {
    formatDiagOnce(ctx, out, abs, 'D007', 'error', jsonPath, ctx.type,
      '文件扩展名是 .png，但文件头不是 PNG 签名（可能是别的图片格式改了后缀）。',
      'The file is named .png but its header is not the PNG signature (it may be another image format renamed).');
    return;
  }
  if (b.length < 33) {
    formatDiagOnce(ctx, out, abs, 'D007', 'warning', jsonPath, ctx.type,
      'PNG 的 IHDR 块不完整（文件可能被截断）。',
      'The PNG IHDR chunk is incomplete (the file may be truncated).');
    return;
  }
  const bitDepth = b[24];
  const colorType = b[25];
  const interlace = b[28];
  const unsupported = bitDepth !== 8 || (colorType !== 2 && colorType !== 6) || interlace !== 0;
  if (unsupported) {
    formatDiagOnce(ctx, out, abs, 'D007', 'warning', jsonPath, ctx.type,
      '像素卡打不开这种 PNG（位深 ' + bitDepth + '，色型 ' + colorType + '，隔行 ' + interlace +
        '）；它只读 8-bit RGB/RGBA、非隔行，保存会另存成 8-bit RGBA。',
      'The pixel card cannot open this PNG (bit depth ' + bitDepth + ', colour type ' + colorType +
        ', interlace ' + interlace + '); it reads 8-bit RGB/RGBA, non-interlaced only, and saving rewrites 8-bit RGBA.',
      { expected: '8-bit RGB/RGBA, non-interlaced', actual: 'bit ' + bitDepth + '/type ' + colorType + '/interlace ' + interlace });
  } else if (colorType === 2) {
    formatDiagOnce(ctx, out, abs, 'D007', 'info', jsonPath, ctx.type,
      '这张 PNG 是 RGB（没有 alpha）；像素卡保存时会写成 RGBA，色型改变、像素不变。',
      'This PNG is RGB (no alpha); saving it from the pixel card rewrites it as RGBA — the colour type changes, the pixels do not.',
      { expected: 'RGBA', actual: 'RGB' });
  }
}

/** D008：WAV 头。音频文件存在时由 checkAudioFile 调用。 */
function checkWavFormat(abs, jsonPath, ctx, out) {
  const b = readHeadCached(abs, 4096, ctx);
  if (!b || b.length < 12) return; // 读不到/太短：存在性检查已经管了
  if (b.toString('ascii', 0, 4) !== 'RIFF' || b.toString('ascii', 8, 12) !== 'WAVE') {
    formatDiagOnce(ctx, out, abs, 'D008', 'error', jsonPath, ctx.type,
      '不是 RIFF/WAVE 文件（Fmod 读不了这个音频）。',
      'Not a RIFF/WAVE file (Fmod cannot read this audio).',
      { expected: 'RIFF/WAVE', actual: b.toString('ascii', 0, 12) });
    return;
  }
  let fmt = null;
  let off = 12;
  while (off + 8 <= b.length) {
    const id = b.toString('ascii', off, off + 4);
    const size = b.readUInt32LE(off + 4);
    if (id === 'fmt ' && off + 8 + 16 <= b.length) {
      fmt = {
        format: b.readUInt16LE(off + 8),
        channels: b.readUInt16LE(off + 10),
        rate: b.readUInt32LE(off + 12),
        bits: b.readUInt16LE(off + 22)
      };
      break;
    }
    if (size <= 0 || size > 4096) break; // 异常块长度：别再往下走
    off += 8 + size + (size % 2);
  }
  if (!fmt) {
    formatDiagOnce(ctx, out, abs, 'D008', 'error', jsonPath, ctx.type,
      'WAV 里没有 fmt 块（文件头损坏）。',
      'The WAV has no fmt chunk (its header is damaged).');
    return;
  }
  if (fmt.format !== 1) {
    formatDiagOnce(ctx, out, abs, 'D008', 'warning', jsonPath, ctx.type,
      'WAV 不是 PCM（format ' + fmt.format + '）；Mods/Audio 按 Fmod Programmer Instrument 使用，' +
        '其他编码可能播不出。',
      'The WAV is not PCM (format ' + fmt.format + '); Mods/Audio is used as an Fmod Programmer Instrument, ' +
        'so other encodings may not play.',
      { expected: 'PCM (format 1)', actual: 'format ' + fmt.format });
  }
  if (fmt.rate !== 44100) {
    formatDiagOnce(ctx, out, abs, 'D008', 'info', jsonPath, ctx.type,
      '采样率 ' + fmt.rate + ' Hz，不是 44.1 kHz（语料里所有音频都是 44.1 kHz）。',
      'Sample rate is ' + fmt.rate + ' Hz, not 44.1 kHz (every audio file in the corpus is 44.1 kHz).',
      { expected: '44100 Hz', actual: String(fmt.rate) });
  }
  if (fmt.channels !== 1 && fmt.channels !== 2) {
    formatDiagOnce(ctx, out, abs, 'D008', 'warning', jsonPath, ctx.type,
      'WAV 是 ' + fmt.channels + ' 声道（语料只有单声道与立体声）。',
      'The WAV has ' + fmt.channels + ' channel(s) (the corpus only has mono and stereo).',
      { expected: '1 or 2 channels', actual: String(fmt.channels) });
  }
}

/** Spine 骨架开头的版本字符串（8 字节 hash 之后是长度前缀的 "4.2.43"）。 */
function spineVersionOf(abs, ctx) {
  const b = readHeadCached(abs, 32, ctx);
  if (!b || b.length < 10) return null;
  const m = /4\.\d+\.\d+/.exec(b.toString('latin1'));
  return m ? m[0] : null;
}

/**
 * D009：Spine 三件套（`<Name>.skel.bytes` + `<Name>.atlas.txt` + 图集里的页图）。
 * 包级扫描，不需要定义引用它——真机上少一张页图，立绘就是一整块空白。
 */
function auditSpineTriples(root, diagnostics) {
  const files = listFilesRecursive(root, [], 0);
  const rel = function (abs) { return relPosix(root, abs); };
  const seen = new Set();
  const add = function (severity, abs, zh, en, extra) {
    const key = abs + '|D009';
    if (seen.has(key)) return;
    seen.add(key);
    diagnostics.push(diag(severity, 'D009', rel(abs), '', zh, en, extra));
  };

  const lower = new Map();
  for (const f of files) lower.set(f.toLowerCase(), f);
  const skels = files.filter(function (f) { return /\.skel\.bytes$/i.test(f); });
  const atlases = files.filter(function (f) { return /\.atlas\.txt$/i.test(f); });
  const ctx = { headCache: null };

  for (const skel of skels) {
    const base = skel.replace(/\.skel\.bytes$/i, '');
    const atlasPath = lower.get((base + '.atlas.txt').toLowerCase());
    if (!atlasPath) {
      add('error', skel,
        'Spine 三件套缺图集：同目录应有 "' + path.basename(base) + '.atlas.txt"，否则游戏加载不出这套骨骼。',
        'The Spine triple is missing its atlas: "' + path.basename(base) + '.atlas.txt" should sit beside it, ' +
          'or the game cannot load this skeleton.',
        { expected: path.basename(base) + '.atlas.txt', actual: '(missing)' });
      continue;
    }

    const version = spineVersionOf(skel, ctx);
    if (!version) {
      add('warning', skel,
        '读不出 Spine 骨架的版本字符串（文件头可能损坏，或不是 4.x 的 .skel.bytes）。',
        'Could not read the Spine skeleton version string (the header may be damaged, or this is not a 4.x .skel.bytes).');
    } else if (version !== '4.2.43') {
      if (/^4\.2\./.test(version)) {
        add('warning', skel,
          'Spine 版本 ' + version + '；游戏自带的是 4.2.43。4.2.x 能读，但和游戏资源混用前建议用 4.2.43 重导出。',
          'Spine version is ' + version + '; the game ships 4.2.43. 4.2.x still reads, but re-export with 4.2.43 ' +
            'before mixing it with the game assets.',
          { expected: '4.2.43', actual: version });
      } else {
        add('error', skel,
          'Spine 版本 ' + version + ' 不是 4.2.x：游戏运行时读不了这套骨骼。',
          'Spine version ' + version + ' is not 4.2.x: the game runtime cannot read this skeleton.',
          { expected: '4.2.43', actual: version });
      }
    }

    let text = null;
    try {
      text = fs.readFileSync(atlasPath, 'utf8');
    } catch {
      add('warning', atlasPath,
        '图集无法以 UTF-8 读取。',
        'The atlas cannot be read as UTF-8.');
      continue;
    }
    const lines = text.split(/\r?\n/);
    const dir = path.dirname(atlasPath);
    for (let i = 0; i < lines.length; i++) {
      if (!/^size:\s*\d/.test(lines[i])) continue;
      let j = i - 1;
      while (j >= 0 && !lines[j].trim()) j--;
      const page = (lines[j] || '').trim();
      if (!page || /^(size|format|filter|repeat|pma):/i.test(page)) continue;
      const pageAbs = lower.get(path.join(dir, page).toLowerCase());
      if (!pageAbs) {
        add('error', atlasPath,
          '图集里写的页图 "' + page + '" 不存在（图集与 PNG 必须同名放在一起）。',
          'The atlas names page image "' + page + '", which does not exist (atlas and PNG must share a folder and name).',
          { expected: page, actual: '(missing)' });
      }
    }
  }

  for (const atlas of atlases) {
    const base = atlas.replace(/\.atlas\.txt$/i, '');
    if (lower.get((base + '.skel.bytes').toLowerCase())) continue;
    add('error', atlas,
      '图集没有对应的骨架：同目录应有 "' + path.basename(base) + '.skel.bytes"。',
      'The atlas has no skeleton: "' + path.basename(base) + '.skel.bytes" should sit beside it.',
      { expected: path.basename(base) + '.skel.bytes', actual: '(missing)' });
  }
}

/**
 * D010：本地化 CSV 的表头与字节序（只读开头 4 KB）。
 * BOM / 行尾单独返回给调用方：同一包里各表不一致时才值得说一句（语料就是
 * 基础表 NewProject.csv 不带 BOM、其余 10 张带），逐表报会变成 11 条噪音。
 */
function checkCsvTable(abs, relPath, diagnostics) {
  const ctx = { headCache: null };
  const b = readHeadCached(abs, 4096, ctx);
  if (!b || b.length < 4) return null;
  const bom = b[0] === 0xef && b[1] === 0xbb && b[2] === 0xbf;
  const text = b.toString('utf8');
  const crlf = text.indexOf('\r\n') >= 0;
  const firstLine = text.replace(/^\uFEFF/, '').split(/\r?\n/)[0];
  const header = firstLine.split(',').map(function (s) { return s.trim().replace(/^"|"$/g, ''); });
  const push = function (severity, zh, en) {
    diagnostics.push(diag(severity, 'D010', relPath, '', zh, en));
  };
  if (header.length !== 8) {
    push('warning',
      '表头是 ' + header.length + ' 列，游戏导出的本地化表是 8 列。',
      'The header has ' + header.length + ' columns; the localisation tables the game exports have 8.');
  }
  if (header.indexOf('lock') < 0) {
    push('warning',
      '表头缺少 lock 列：游戏导出的表用 lock 记录该行是否被锁定。',
      'The header has no lock column: the game exports a lock column recording whether the row is locked.');
  }
  return { rel: relPath, bom: bom, crlf: crlf };
}

/**
 * G9：字段值是不是 Unity 的资源路径 / 文件路径（Addressables address 常见误写）。
 */
function looksLikeAssetPath(v) {
  return /^Assets[\\/]/i.test(v) || /^Packages[\\/]/i.test(v) ||
    /^[A-Za-z]:[\\/]/.test(v) || /\\/.test(v) || /\.(prefab|asset|unity)$/i.test(v);
}

/** G9：D018 —— Addressables 地址的形状检查（无法核对游戏资源，只能拦明显误写）。 */
function checkAddressable(value, jsonPath, ctx, out) {
  if (typeof value !== 'string') return;
  const v = value.trim();
  if (v === '') return;
  if (!looksLikeAssetPath(v)) return;
  out.push(diag('warning', 'D018', jsonPath, ctx.type,
    'Addressables 地址写法可疑：' + describe(v) +
    ' 看起来是 Unity 资源路径/文件路径。游戏按 Addressables 窗口里登记的 address 查找，不按资源路径；' +
    '请填窗口里那串地址（通常与 prefab 文件名不同）。',
    'Suspicious Addressables address: ' + describe(v) +
    ' looks like a Unity asset or file path. The game looks up the address registered in the ' +
    'Addressables window, not the asset path; write the address string from that window ' +
    '(it is often different from the prefab file name).',
    { expected: 'Addressables address（窗口中登记的字符串）', actual: v }));
}

/* ---------------- G10：wiki 陷阱（schema 只能给形状，给不了约定） ---------------- */

/** 路径的最后一个字段名（`a.b[0].Guid` -> `Guid`）。 */
function lastFieldName(jsonPath) {
  const text = String(jsonPath == null ? '' : jsonPath);
  const clean = text.replace(/\[\d+\]/g, '');
  const dot = clean.lastIndexOf('.');
  return dot < 0 ? clean : clean.slice(dot + 1);
}

/** schema 节点是不是 FMOD EventReference（title 或 {Guid,Path} 的形状）。 */
function isEventReferenceNode(n) {
  if (!isPlainObject(n)) return false;
  if (n.title === 'EventReference') return true;
  const props = isPlainObject(n.properties) ? n.properties : null;
  return !!(props && props.Guid && props.Path && !props.techName && !props.TechName);
}

/** GUID 对象的四个整数槽是否齐全。 */
function guidDataSlots(value) {
  return isPlainObject(value) &&
    ['Data1', 'Data2', 'Data3', 'Data4'].every(function (k) { return hasOwn(value, k); });
}

function checkEventReference(value, ip, ctx, out) {
  // 字符串（"event:/..."）是作者最常写的替代品：schema 会报类型不符，但那句话
  // 说不清「为什么错」。warning 与 D003 并存，专门讲 FMOD 这一层。
  const asObject = isPlainObject(value);
  const guidOk = asObject && isPlainObject(value.Guid) && guidDataSlots(value.Guid) &&
    ['Data1', 'Data2', 'Data3', 'Data4'].every(function (k) {
      return Number.isInteger(value.Guid[k]);
    });
  const pathOk = asObject && typeof value.Path === 'string' && value.Path.trim() !== '';
  if (asObject && guidOk && pathOk) return; // 与 schema 形状一致，不额外报
  out.push(diag('warning', 'D019', ip, ctx.type,
    'EventReference 不能由 JSON 构造：' +
    (asObject ? '当前对象只有 ' + Object.keys(value).length + ' 个键（' + describe(value) + '）'
      : '当前值是 ' + describe(value)) +
    '。这个字段是 Unity/FMOD 在编辑器里序列化出来的事件引用' +
    '（{ Guid:{Data1..4}, Path }），必须由游戏/Unity 生成，或从现有定义里整段复制；' +
    '手写 JSON 不会让它指向一个 FMOD 事件。',
    'An EventReference cannot be built from JSON: ' +
    (asObject ? 'this object has only ' + Object.keys(value).length + ' key(s) (' + describe(value) + ')'
      : 'the value is ' + describe(value)) +
    '. This field is a Unity/FMOD event reference serialised by the editor ' +
    '({ Guid:{Data1..4}, Path }); it must be produced by the game/Unity, or copied whole from an ' +
    'existing definition. Hand-written JSON will not point at an FMOD event.',
    { expected: 'Unity/FMOD EventReference（{ Guid:{Data1..4}, Path }，由编辑器产生）',
      actual: describe(value) }));
}

function checkInitialTransform(value, ip, ctx, out) {
  if (ctx.type !== 'Character') return;
  if (lastFieldName(ip) !== 'initialTransform') return;
  if (typeof value !== 'number') return;
  if (Math.abs(value - CHARACTER_INITIAL_TRANSFORM) <= INITIAL_TRANSFORM_EPSILON) return;
  out.push(diag('warning', 'D021', ip, ctx.type,
    'Character.initialTransform 的文档值是 -7.2（语料里 56 个角色都是 -7.199999809265137，' +
    'float32 舍入），当前是 ' + value + '。脚手架默认的 0 会让角色站在场景原点。',
    'The documented Character.initialTransform is -7.2 (all 56 characters in the corpus carry ' +
    'the float32 rounding -7.199999809265137); this file has ' + value + '. The scaffold default 0 ' +
    'puts the character at the scene origin.',
    { expected: String(CHARACTER_INITIAL_TRANSFORM), actual: String(value) }));
}

/** 画布类类型（今天只有 UIAnimation）：几何字段必须与文档的 256×144 一致。 */
function checkCanvas(value, ip, ctx, out) {
  if (!CANVAS_TYPES.has(ctx.type)) return;
  const field = lastFieldName(ip);
  if (typeof value === 'number') {
    let expected = null;
    if (CANVAS_WIDTH_FIELD.test(field)) expected = CANVAS_WIDTH;
    else if (CANVAS_HEIGHT_FIELD.test(field)) expected = CANVAS_HEIGHT;
    if (expected === null || value === expected) return;
    out.push(diag('warning', 'D021', ip, ctx.type,
      '画布尺寸与文档不一致：' + field + '=' + value + '，文档记录游戏 UI 画布是 ' +
      CANVAS_WIDTH + '×' + CANVAS_HEIGHT + '。UI 动画按这个画布对位，别的尺寸会整体偏移/裁切。',
      'Canvas size differs from the documented one: ' + field + '=' + value + '; the game UI canvas ' +
      'is ' + CANVAS_WIDTH + '×' + CANVAS_HEIGHT + '. UI animations are laid out on that canvas, so ' +
      'another size shifts or crops them.',
      { expected: String(expected), actual: String(value) }));
    return;
  }
  if (typeof value === 'string' && CANVAS_SIZE_FIELD.test(field)) {
    const v = value.trim();
    if (v === '' || v === '256x144' || v === '256×144') return;
    out.push(diag('warning', 'D021', ip, ctx.type,
      '画布尺寸与文档不一致：' + field + '=' + describe(v) + '，文档记录游戏 UI 画布是 256×144。',
      'Canvas size differs from the documented one: ' + field + '=' + describe(v) +
      '; the game UI canvas is 256×144.',
      { expected: '256x144', actual: v }));
  }
}

function checkGuidShape(n, value, ip, ctx, out) {
  const field = lastFieldName(ip);
  const titleGuid = isPlainObject(n) && n.title === 'GUID';
  const nameGuid = /^guid$/i.test(field);
  if (!titleGuid && !nameGuid) return;

  if (typeof value === 'string') {
    const v = value.trim();
    if (v === '') return; // 空字符串 = 未设置
    if (GUID_ZERO_32.test(v)) {
      out.push(diag('warning', 'D022', ip, ctx.type,
        '全零 GUID：' + describe(v) + ' 不是有效的 Unity 资源 GUID（全零通常意味着引用没接上）。',
        'All-zero GUID: ' + describe(v) + ' is not a valid Unity asset GUID (all zeros usually means ' +
        'the reference was never wired up).',
        { expected: '32 位十六进制 GUID（非全零）', actual: v }));
      return;
    }
    if (GUID_32_HEX.test(v)) return; // Unity 资源 GUID 的正常形状
    if (GUID_DASHED.test(v)) {
      out.push(diag('info', 'D022', ip, ctx.type,
        'GUID 是 8-4-4-4-12 的 .NET 形式；Unity 资源 GUID 是 32 位十六进制、不带连字符。',
        'The GUID is in the dashed 8-4-4-4-12 .NET form; Unity asset GUIDs are 32 hexadecimal ' +
        'digits without dashes.',
        { expected: '32 位 hex', actual: v }));
      return;
    }
    out.push(diag('info', 'D022', ip, ctx.type,
      '值 ' + describe(v) + ' 既不是 32 位十六进制，也不是 8-4-4-4-12 的 GUID 形状。',
      'The value ' + describe(v) + ' is neither 32 hexadecimal digits nor a dashed 8-4-4-4-12 GUID.',
      { expected: '32 位 hex / 8-4-4-4-12', actual: v }));
    return;
  }

  if (guidDataSlots(value)) {
    const slots = ['Data1', 'Data2', 'Data3', 'Data4'];
    const integers = slots.every(function (k) { return Number.isInteger(value[k]); });
    if (!integers) return; // 类型错误由 D003/D007 负责
    if (slots.every(function (k) { return value[k] === 0; })) {
      out.push(diag('warning', 'D022', ip, ctx.type,
        '全零 GUID：Data1..Data4 都是 0，不是有效的 Unity 资源引用。',
        'All-zero GUID: Data1..Data4 are all 0, which is not a valid Unity asset reference.',
        { expected: '非全零的 GUID', actual: '00000000-0000-0000-0000-000000000000' }));
    }
  }
}

/** G10：在 validateNode 里统一调用这四个陷阱检查。 */
function checkWikiTraps(n, value, ip, ctx, out) {
  if (isEventReferenceNode(n)) checkEventReference(value, ip, ctx, out);
  checkInitialTransform(value, ip, ctx, out);
  checkCanvas(value, ip, ctx, out);
  checkGuidShape(n, value, ip, ctx, out);
}

/**
 * G6：一个值是否满足某个子 schema（只看 error，warning/info 不算不匹配）。
 * 用于 oneOf / anyOf / allOf / not 的分支判定；递归深度设上限防止自引用爆炸。
 */
function schemaMatches(node, value, schemaRoot, ctx, jsonPath, depth) {
  if (depth > 8) return true;
  const sub = Object.assign({}, ctx, {
    depth: depth + 1,
    refSeen: new Set(ctx.refSeen || [])
  });
  const tmp = [];
  validateNode(node, schemaRoot, value, jsonPath, sub, tmp, false, false);
  return !tmp.some(function (d) { return d.severity === 'error'; });
}

/**
 * G6：D012 —— schema 关键字面。知识库目前只用 type/properties/items/required/enum，
 * 但导出的 schema 一旦带上 pattern / minLength / oneOf 等，校验器不能假装没看见：
 * 那样「全绿」会从「值都对」退化成「这些关键字根本没读」。JSON Schema 的关键字
 * 是必须满足的约束，故一律 error（与 D003/D004 同级）。
 */
function checkConstraints(n, value, jsonPath, ctx, out, schemaRoot) {
  const add = function (zh, en, expected, actual) {
    out.push(diag('error', 'D012', jsonPath, ctx.type, zh, en,
      { expected: expected, actual: actual }));
  };

  if (hasOwn(n, 'const') &&
      JSON.stringify(value) !== JSON.stringify(n.const)) {
    add('值必须是常量 ' + describe(n.const) + '。',
      'The value must be the constant ' + describe(n.const) + '.',
      describe(n.const), describe(value));
  }

  if (typeof value === 'string') {
    if (typeof n.minLength === 'number' && value.length < n.minLength) {
      add('字符串长度 ' + value.length + ' 小于 minLength ' + n.minLength + '。',
        'The string is ' + value.length + ' characters, below minLength ' + n.minLength + '.',
        'minLength ' + n.minLength, String(value.length));
    }
    if (typeof n.maxLength === 'number' && value.length > n.maxLength) {
      add('字符串长度 ' + value.length + ' 大于 maxLength ' + n.maxLength + '。',
        'The string is ' + value.length + ' characters, above maxLength ' + n.maxLength + '.',
        'maxLength ' + n.maxLength, String(value.length));
    }
    if (typeof n.pattern === 'string') {
      let re = null;
      try { re = new RegExp(n.pattern, 'u'); } catch (err) { re = null; }
      if (re && !re.test(value)) {
        add('值 ' + describe(value) + ' 不匹配 pattern /' + n.pattern + '/。',
          'The value ' + describe(value) + ' does not match the pattern /' + n.pattern + '/.',
          'pattern /' + n.pattern + '/', value);
      }
    }
  }

  if (typeof value === 'number') {
    if (typeof n.minimum === 'number' && value < n.minimum) {
      add('数值 ' + value + ' 小于 minimum ' + n.minimum + '。',
        'The number ' + value + ' is below minimum ' + n.minimum + '.',
        'minimum ' + n.minimum, String(value));
    }
    if (typeof n.maximum === 'number' && value > n.maximum) {
      add('数值 ' + value + ' 大于 maximum ' + n.maximum + '。',
        'The number ' + value + ' is above maximum ' + n.maximum + '.',
        'maximum ' + n.maximum, String(value));
    }
    if (typeof n.exclusiveMinimum === 'number' && value <= n.exclusiveMinimum) {
      add('数值 ' + value + ' 必须大于 exclusiveMinimum ' + n.exclusiveMinimum + '。',
        'The number ' + value + ' must be above exclusiveMinimum ' + n.exclusiveMinimum + '.',
        '> ' + n.exclusiveMinimum, String(value));
    }
    if (typeof n.exclusiveMaximum === 'number' && value >= n.exclusiveMaximum) {
      add('数值 ' + value + ' 必须小于 exclusiveMaximum ' + n.exclusiveMaximum + '。',
        'The number ' + value + ' must be below exclusiveMaximum ' + n.exclusiveMaximum + '.',
        '< ' + n.exclusiveMaximum, String(value));
    }
    if (typeof n.multipleOf === 'number' && n.multipleOf > 0) {
      const ratio = value / n.multipleOf;
      if (Math.abs(ratio - Math.round(ratio)) > 1e-9) {
        add('数值 ' + value + ' 不是 multipleOf ' + n.multipleOf + ' 的整数倍。',
          'The number ' + value + ' is not a multiple of ' + n.multipleOf + '.',
          'multipleOf ' + n.multipleOf, String(value));
      }
    }
  }

  if (Array.isArray(value)) {
    if (typeof n.minItems === 'number' && value.length < n.minItems) {
      add('数组有 ' + value.length + ' 项，少于 minItems ' + n.minItems + '。',
        'The array has ' + value.length + ' items, below minItems ' + n.minItems + '.',
        'minItems ' + n.minItems, String(value.length));
    }
    if (typeof n.maxItems === 'number' && value.length > n.maxItems) {
      add('数组有 ' + value.length + ' 项，多于 maxItems ' + n.maxItems + '。',
        'The array has ' + value.length + ' items, above maxItems ' + n.maxItems + '.',
        'maxItems ' + n.maxItems, String(value.length));
    }
    if (n.uniqueItems === true) {
      const seen = new Set();
      const dup = [];
      for (const item of value) {
        const key = JSON.stringify(item);
        if (seen.has(key)) dup.push(describe(item));
        else seen.add(key);
      }
      if (dup.length) {
        add('数组要求 uniqueItems，但存在重复项：' + dup.slice(0, 5).join(', ') + '。',
          'The array requires uniqueItems, but contains duplicates: ' +
          dup.slice(0, 5).join(', ') + '.',
          'uniqueItems', dup.slice(0, 5).join(', '));
      }
    }
  }

  const branches = function (list) {
    return list.filter(function (sub) {
      return schemaMatches(sub, value, schemaRoot, ctx, jsonPath,
        (ctx.depth || 0) + 1);
    });
  };

  if (Array.isArray(n.oneOf) && n.oneOf.length) {
    const hits = branches(n.oneOf);
    if (hits.length !== 1) {
      add('oneOf 要求恰好匹配 1 个分支，实际匹配 ' + hits.length + ' 个。',
        'oneOf requires exactly one matching branch, but ' + hits.length + ' match.',
        'oneOf 恰好 1 个', String(hits.length));
    }
  }
  if (Array.isArray(n.anyOf) && n.anyOf.length) {
    const hits = branches(n.anyOf);
    if (hits.length === 0) {
      add('anyOf 要求至少匹配 1 个分支，实际一个都不匹配。',
        'anyOf requires at least one matching branch, but none match.',
        'anyOf 至少 1 个', '0');
    }
  }
  if (Array.isArray(n.allOf) && n.allOf.length) {
    const hits = branches(n.allOf);
    if (hits.length !== n.allOf.length) {
      add('allOf 要求所有分支都匹配，' + n.allOf.length + ' 个分支里只有 ' + hits.length + ' 个匹配。',
        'allOf requires every branch to match; only ' + hits.length + ' of ' +
        n.allOf.length + ' do.',
        'allOf 全部匹配', hits.length + '/' + n.allOf.length);
    }
  }
  if (isPlainObject(n.not) && !hasOwn(n, 'const') && !Array.isArray(n.oneOf) &&
      !Array.isArray(n.anyOf) && !Array.isArray(n.allOf)) {
    if (schemaMatches(n.not, value, schemaRoot, ctx, jsonPath, (ctx.depth || 0) + 1)) {
      add('值不能匹配 not 分支。',
        'The value must not match the not branch.',
        'not', describe(value));
    }
  }
}

/**
 * G7：解析本地化 CSV。表很小（语料 11 张 × 18k 行），所以一次读完再按 RFC 4180
 * 处理引号：字段里可以有逗号、换行与转义双引号。返回行数组的数组。
 */
function parseCsvText(text) {
  const rows = [];
  let row = [];
  let field = '';
  let quoted = false;
  for (let i = 0; i < text.length; i += 1) {
    const ch = text[i];
    if (quoted) {
      if (ch === '"') {
        if (text[i + 1] === '"') { field += '"'; i += 1; }
        else quoted = false;
      } else {
        field += ch;
      }
      continue;
    }
    if (ch === '"') { quoted = true; continue; }
    if (ch === ',') { row.push(field); field = ''; continue; }
    if (ch === '\n') {
      row.push(field);
      rows.push(row);
      row = [];
      field = '';
      continue;
    }
    if (ch === '\r') continue;
    field += ch;
  }
  if (field !== '' || row.length) {
    row.push(field);
    rows.push(row);
  }
  return rows;
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

  /* ---- D013 $ref 解析不到（G6） ---- */
  if (isPlainObject(rawNode) && typeof rawNode.$ref === 'string' && n === rawNode) {
    const ref = rawNode.$ref;
    const seen = ctx.refSeen || (ctx.refSeen = new Set());
    if (!seen.has(ref)) {
      seen.add(ref);
      out.push(diag('warning', 'D013', ip, ctx.type,
        'schema 引用 "' + ref + '" 解析不到（知识库里没有这个 title）；这一段没有被校验。',
        'The schema reference "' + ref + '" does not resolve (no such title in the knowledge ' +
        'base); this part was not checked.'));
    }
  }
  // null 视为「未设置 / 可空」，全部检查跳过
  if (value === null || value === undefined) return;

  /*
   * G10：陷阱检查放在类型检查之前——「把 EventReference 写成字符串」正是最典型的
   * 误用，而类型不符会 return，再往后的分支就永远看不到它了。这些检查各自只看
   * 值的实际形状，与 schema 声明的类型无关。
   */
  checkWikiTraps(n, value, ip, ctx, out);

  /* ---- D003 / D007 类型 ---- */
  const declaredTypes = Array.isArray(n.type)
    ? n.type.filter(function (t) { return typeof t === 'string'; })
    : (typeof n.type === 'string' ? [n.type] : null);
  const wantTypes = (declaredTypes && declaredTypes.length)
    ? declaredTypes
    : (isPlainObject(n.properties) ? ['object'] : null);
  if (wantTypes && !wantTypes.some(function (t) { return typeMatches(t, value); })) {
    const want = wantTypes.join('|');
    const code = (wantTypes.indexOf('array') >= 0 || fromItems) ? 'D007' : 'D003';
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

  /* ---- D012 schema 关键字约束（G6） ---- */
  checkConstraints(n, value, ip, ctx, out, schema);

  /* ---- D005 / D006 语义字段 ---- */
  const desc = typeof n.description === 'string' ? n.description : '';
  /*
   * G41/G30: a facts-only knowledge base (the one derived on a machine without a
   * shipped knowledge.json) has no description sentences -- it carries
   * `x-techReference` / `x-sprite` instead.  Both spellings must mean the same
   * thing here, otherwise deriving the KB would silently switch D005/D006 off and
   * `ok: true` would start meaning "nothing was looked at".
   */
  const refMatch = RE_TECH_REF.exec(desc);
  const refTarget = refMatch
    ? refMatch[1]
    : (typeof n[X_REF_KEY] === 'string' && n[X_REF_KEY] ? n[X_REF_KEY] : null);
  if (refTarget) checkReference(refTarget, value, ip, ctx, out, isRequired);
  else if (RE_SPRITE_DESC.test(desc) || n[X_SPRITE_KEY] === true) checkSprite(value, ip, ctx, out);

  /* ---- G9：Addressables 地址（schema 只有一句 "Addressable asset address"） ---- */
  if (ADDRESSABLE_DESC.test(desc)) {
    if (Array.isArray(value)) {
      for (let i = 0; i < value.length; i += 1) checkAddressable(value[i], ip + '[' + i + ']', ctx, out);
    } else {
      checkAddressable(value, ip, ctx, out);
    }
  }

  /* ---- 对象 ---- */
  if (isPlainObject(value)) {
    const props = isPlainObject(n.properties) ? n.properties : null;
    if (!props) return;

    const requiredKeys = Array.isArray(n.required) ? n.required : [];
    // D001：required 缺失 / null / 空字符串
    for (const key of requiredKeys) {
      if (!hasValue(value, key)) {
        let zh = '缺少必填字段 "' + key + '"' + (hasOwn(value, key) ? '（值为空）' : '') + '。';
        let en = 'Missing required field "' + key + '"' + (hasOwn(value, key) ? ' (empty value)' : '') + '.';
        /*
         * G21：AudioEvent 的双命名怪癖。它的 schema 同时要求 techName 与 TechName，
         * 语料里 117 个文件两个键都写；只写一个的手写作者会吃到一句没头没尾的 D001。
         */
        const twin = requiredKeys.filter((k) => k !== key && k.toLowerCase() === 'techname');
        if (twin.length) {
          zh += '（' + ctx.type + ' 在这里是双命名：必须同时写 "' + twin[0] + '" 与 "' + key +
            '" 两个键，游戏两套 JSON 各认一个。）';
          en += ' (' + ctx.type + ' uses both spellings here: write "' + twin[0] + '" and "' + key +
            '" together; each consumer reads one of them.)';
        }
        out.push(diag('error', 'D001', ip ? ip + '.' + key : key, ctx.type, zh, en,
          { expected: key, actual: hasOwn(value, key) ? describe(value[key]) : 'undefined' }));
      }
    }
    // D002：未声明的字段（schema 明确 additionalProperties:false 时升级为 error）
    for (const key of Object.keys(value)) {
      if (!hasOwn(props, key)) {
        if (n.additionalProperties === false) {
          out.push(diag('error', 'D012', ip ? ip + '.' + key : key, ctx.type,
            'schema 不允许字段 "' + key + '"（additionalProperties: false），游戏不会读取它。',
            'The schema does not allow field "' + key + '" (additionalProperties: false); ' +
            'the game will not read it.',
            { expected: Object.keys(props).join('|'), actual: key }));
        } else {
          out.push(diag('warning', 'D002', ip ? ip + '.' + key : key, ctx.type,
            'schema 中未声明的字段 "' + key + '"（可能是拼写错误，游戏不会读取它）。',
            'Undeclared field "' + key + '" (possible typo; the game will ignore it).',
            { expected: Object.keys(props).join('|'), actual: key }));
        }
      }
    }

    /* ---- G21：文件型音频引用（schema 没有 description，按字段名识别） ---- */
    if (ctx.modRoot) {
      const folder = typeof value[AUDIO_FOLDER_FIELD] === 'string' ? value[AUDIO_FOLDER_FIELD] : '';
      for (const key of AUDIO_FILE_FIELDS) {
        if (!hasOwn(value, key)) continue;
        const v = value[key];
        const jp = ip ? ip + '.' + key : key;
        if (typeof v === 'string') {
          checkAudioFile(v, jp, ctx, out, folder);
        } else if (Array.isArray(v)) {
          for (let i = 0; i < v.length; i++) checkAudioFile(v[i], jp + '[' + i + ']', ctx, out, folder);
        }
      }
      if (typeof value[AUDIO_FOLDER_FIELD] === 'string') {
        checkAudioFolder(folder, ip ? ip + '.' + AUDIO_FOLDER_FIELD : AUDIO_FOLDER_FIELD, ctx, out);
      }
      /* ---- G22：立绘骨架引用（schema 无 description，按字段名识别） ---- */
      if (hasOwn(value, SPINE_ASSET_FIELD) && typeof value[SPINE_ASSET_FIELD] === 'string') {
        checkSpineAsset(value[SPINE_ASSET_FIELD],
          ip ? ip + '.' + SPINE_ASSET_FIELD : SPINE_ASSET_FIELD, ctx, out);
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
    localTechNameCache: new Map(),
    // G46：包级校验时由 validateModPackage 传进来，一张图/一个 WAV 只体检一次
    headCache: o.headCache instanceof Map ? o.headCache : new Map(),
    formatSeen: o.formatSeen instanceof Set ? o.formatSeen : new Set(),
    // G6：同一个解析不到的 $ref 在一次定义校验里只报一次
    refSeen: new Set(),
    depth: 0
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

  // D102：整份覆写提示（G3：从 info 提级为 warning —— 这是「被内置定义吞掉」的最高风险信号）
  if (tv) {
    const list = kb.baseline ? kb.baseline[type] : null;
    if (Array.isArray(list) && list.includes(tv)) {
      out.push(diag('warning', 'D102', tk, type,
        '"' + tv + '" 已是基线定义，本文件属于「整份覆写」：必须包含你需要的全部字段，而不只是你要改的字段。',
        '"' + tv + '" is already a baseline definition; this file is a full override: it must ' +
        'contain every field you need, not only the ones you are changing.',
        { expected: '整份完整定义', actual: '覆写 ' + type }));
    }
  }

  // D103：兄弟 Mod 已经有同类型的同名定义（游戏对 (类型, TechName) 保留先加载的那一份）
  if (tv && isPlainObject(o.otherTechNames)) {
    const bucket = o.otherTechNames[type];
    if (bucket && typeof bucket.get === 'function' && bucket.has(tv)) {
      const owner = bucket.get(tv);
      out.push(diag('error', 'D103', tk, type,
        '"' + tv + '" 已由 Mod "' + owner + '" 定义为 ' + type +
        '；游戏只保留先加载的那一份，本文件会被静默丢弃。',
        '"' + tv + '" is already defined as ' + type + ' by mod "' + owner +
        '"; the game keeps only the first one loaded, so this file is dropped silently.',
        { expected: '唯一的 (类型, TechName)', actual: tv + ' @ ' + owner }));
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
 * G3：兄弟 Mod 的定义名索引 `{ [type]: Map<techName, 所属 Mod 名> }`。
 *
 * 撞名规则是 (类型, TechName)：游戏按加载顺序保留第一个，后来的静默丢弃。
 * 所以要在校验本包时把游戏 Mods 目录里其它包的 Defines 扫一遍。读不出来的
 * 文件跳过（它们不该让本包的校验失败）。
 */
function siblingTechNames(otherMods, selfRoot) {
  const index = Object.create(null);
  if (!Array.isArray(otherMods) || otherMods.length === 0) return index;
  for (const other of otherMods) {
    if (!isPlainObject(other) || typeof other.dir !== 'string' || !other.dir) continue;
    let otherRoot = null;
    try {
      otherRoot = path.resolve(String(other.dir));
    } catch {
      continue;
    }
    if (otherRoot === selfRoot) continue;
    const label = (isPlainObject(other.manifest) && typeof other.manifest.name === 'string' && other.manifest.name)
      ? other.manifest.name
      : (typeof other.name === 'string' && other.name ? other.name : path.basename(otherRoot));
    const defines = path.join(otherRoot, 'Defines');
    if (!isDir(defines)) continue;
    for (const typeDir of safeReaddir(defines, true)) {
      if (!typeDir.isDirectory()) continue;
      const bucket = index[typeDir.name] || (index[typeDir.name] = new Map());
      const files = listFilesRecursive(path.join(defines, typeDir.name), [], 0)
        .filter((f) => /\.json$/i.test(f));
      for (const abs of files) {
        let obj = null;
        try {
          obj = JSON.parse(fs.readFileSync(abs, 'utf8').replace(/^\uFEFF/, ''));
        } catch {
          continue;
        }
        if (!isPlainObject(obj)) continue;
        const tv = techNameValue(obj, null);
        if (tv && !bucket.has(tv)) bucket.set(tv, label);
      }
    }
  }
  return index;
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
  const siblingNames = otherMods.length > 0 ? siblingTechNames(otherMods, root) : Object.create(null);

  const gameMods = isPlainObject(o.gameMods) ? o.gameMods : null;
  if (gameMods && gameMods.readable === false) {
    diagnostics.push(diag('warning', 'M012', '', '',
      '读不到游戏 Mods 目录' + (gameMods.dir ? '（' + gameMods.dir + '）' : '') +
        '：跨 Mod 的 loadOrder 冲突与 techName 重名检查已跳过，这次只看到本包内部。',
      'The game Mods folder' + (gameMods.dir ? ' (' + gameMods.dir + ')' : '') +
        ' cannot be read: cross-mod loadOrder and techName collision checks were skipped; ' +
        'only this package was visible.'));
  }

  let manifest = null;
  let manifestFileCount = 0;
  let definesFileCount = 0;
  let yarnFileCount = 0;
  let csvFileCount = 0;
  // G46：各本地化表的 BOM / 行尾观测，最后在包级聚合（不一致才报一句）。
  const csvObservations = [];

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
    const firstSeen = {};
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
            const seen = firstSeen[type] || (firstSeen[type] = new Map());
            if (seen.has(tv)) {
              diagnostics.push(diag('error', 'D103', rel + '#techName', type,
                '同包里 "' + tv + '" 被重复定义为 ' + type + '（首次出现于 ' + seen.get(tv) +
                '）；游戏对重复的 (类型, TechName) 只保留先加载的那一份，后一个文件会被静默丢弃。',
                'This package defines "' + tv + '" as ' + type + ' twice (first in ' + seen.get(tv) +
                '); the game keeps only the first (type, TechName) it loads, so the later file is ' +
                'dropped silently.',
                { expected: '唯一的 (类型, TechName)', actual: tv + ' 出现两次' }));
            } else {
              seen.set(tv, rel);
            }
          }
        }
        pending.push({ type: type, rel: rel, abs: abs, obj: obj });
      }
    }

    /*
     * G4：wiki 的支持矩阵。一个包可能带几十个“注册了也没人消费”的类型，
     * 所以按类型各报一次，而不是按文件刷屏。supported / unknown 不报：
     * 前者有 manager，后者 wiki 没表态。
     */
    for (const type of Array.from(typeSet).sort()) {
      const support = supportCore.diagnosticFor(type);
      if (!support) continue;
      diagnostics.push(diag(support.severity, support.code, 'Defines/' + type, type,
        support.message, support.messageEn));
    }

    // G46：整个包共用一份文件头缓存与「已体检过」集合，同一张图只报一次。
    const headCache = new Map();
    const formatSeen = new Set();
    for (const p of pending) {
      const sub = validateDefine(p.type, p.obj, {
        kb: kb,
        modRoot: root,
        filePath: p.abs,
        fileName: path.basename(p.abs),
        techNames: techNames,
        otherTechNames: siblingNames,
        headCache: headCache,
        formatSeen: formatSeen
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
    // G7：`#line:` id -> [{ rel, line }]（对话行与选项行）
    const yarnLineIds = new Map();

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

      /*
       * G10：GetTopic() / WasVisited() 是 wiki 记录的两个「看起来像纯函数」的陷阱。
       * 它们在对话求值时读运行时的当下状态（WasVisited 在游戏里还是占位实现），
       * 作者把它们的结果缓存到变量里，跳转之后就会继续用旧值。
       *
       * 只在解析出来的 `<<...>>` 指令里找调用（`<<if GetTopic("X") > 0>>`、
       * `<<WasVisited>>`），不看台词正文和 `//` 注释，避免「对白里提到函数名」
       * 的误报。每文件只报一处，指出第一处调用所在行。
       */
      let parsedYarn = null;
      try { parsedYarn = yarnCore.parseYarn(text); } catch (err) { parsedYarn = null; }
      if (parsedYarn) {
        let hit = null;
        for (const node of parsedYarn.nodes) {
          for (const cmd of node.commands || []) {
            const m2 = YARN_SIDE_EFFECT_CALL.exec(cmd.name + ' ' + cmd.args);
            if (m2 && (!hit || cmd.line < hit.line)) hit = { line: cmd.line, name: m2[2] };
          }
        }
        if (hit) {
          diagnostics.push(diag('warning', 'D020', rel, '',
            'Yarn 第 ' + hit.line + ' 行调用了 ' + hit.name + '()：它在对话求值时读取运行时状态' +
            '（WasVisited 是游戏的占位实现），不是可以缓存结果的纯函数。把它存进变量再条件判断，' +
            '跳转/访问之后会继续用旧值。',
            'Line ' + hit.line + ' calls ' + hit.name + '(), which reads runtime state while the ' +
            'dialogue is evaluated (WasVisited is a placeholder in the game build) and is not a pure ' +
            'function whose result can be cached. Storing it in a variable and branching on that keeps ' +
            'the stale value after a jump or visit.',
            { expected: '每次需要时直接调用 ' + hit.name + '()', actual: hit.name + '()' }));
        }
      }

      /*
       * G7：把这一文件里所有带 `#line:` 的行（对话行与选项行）收进反向索引。
       * Y103 只报「缺少 id」，这里关心的是「id 在本地化表里有没有对应行」。
       */
      if (parsedYarn) {
        const recordId = function (item) {
          if (!item || !item.id) return;
          const norm = String(item.id).replace(/^line:/i, '').toLowerCase();
          let bucket = yarnLineIds.get(norm);
          if (!bucket) { bucket = []; yarnLineIds.set(norm, bucket); }
          bucket.push({ rel: rel, line: item.line });
        };
        for (const node of parsedYarn.nodes) {
          for (const ln of node.lines || []) recordId(ln);
          for (const opt of node.options || []) recordId(opt);
        }
      }

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
    // G7：本地化表里的 `line:<7 hex>` id -> 出现过的表文件（用于与 Yarn 双向核对）
    const tableLineIds = new Map();
    // G38：每一行的 (id, text, lock)，用于核对 lock 是否指回本包的一行文字
    const csvLockRows = [];
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
      const obs = checkCsvTable(abs, rel, diagnostics);
      if (obs) csvObservations.push(obs);
      csvRows.push({ rel: rel, lines: lines.length });

      /*
       * G7：解析整张表的 id 列。语料里的表是 11 张 × 18k 行，一次读完再按 RFC 4180
       * 处理引号；只有首行以 language, 开头的表才当作本地化表（与上面的过滤一致）。
       */
      const tableRows = parseCsvText(text);
      let idCol = -1;
      let textCol = -1;
      let lockCol = -1;
      if (tableRows.length) {
        const head = tableRows[0].map(function (c) { return c.trim(); });
        idCol = head.indexOf('id');
        textCol = head.indexOf('text');
        lockCol = head.indexOf('lock');
      }
      if (idCol >= 0) {
        for (let ri = 1; ri < tableRows.length; ri += 1) {
          const m = /^line:([0-9a-fA-F]+)$/.exec((tableRows[ri][idCol] || '').trim());
          if (!m) continue;
          const norm = m[1].toLowerCase();
          let bucket = tableLineIds.get(norm);
          if (!bucket) { bucket = []; tableLineIds.set(norm, bucket); }
          bucket.push(rel);
          if (textCol >= 0 && lockCol >= 0) {
            csvLockRows.push({
              rel: rel,
              id: norm,
              text: tableRows[ri][textCol] || '',
              lock: (tableRows[ri][lockCol] || '').trim(),
            });
          }
        }
      }
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

    /* ---------------- G7：`#line:` 与本地化表双向核对 ---------------- */
    // 行数与表头只能说明「表像不像游戏导出的表」；这里核对的是「这一行到底有没有译文」：
    // Yarn 里带 id 的行在表里找不到 → 该行永远显示原文；表里有 id 而 Yarn 里没有 → 译文
    // 永远不出现（删行/改 id 之后最常见）。id 的契约是 line:<7 位 hex>，语料里的演示 id
    // （#line:e4f5g6h 之类）不参与核对，只用一条 info 说明。
    if (yarnLineIds.size || tableLineIds.size) {
      const hexIds = [];
      for (const [id, where] of yarnLineIds) {
        if (LINE_ID_CONTRACT.test(id)) hexIds.push({ id: id, where: where });
      }

      if (tableLineIds.size) {
        const missing = hexIds.filter(function (entry) { return !tableLineIds.has(entry.id); });
        if (missing.length) {
          const sample = missing.slice(0, 6).map(function (entry) {
            return 'line:' + entry.id + '（' + entry.where[0].rel + ':' + entry.where[0].line + '）';
          }).join('、');
          diagnostics.push(diag('warning', 'D014', missing[0].where[0].rel, '',
            missing.length + ' 个对话行带 #line:，但本地化表里没有对应 id：' + sample +
            (missing.length > 6 ? ' 等' : '') + '。这些行没有译文，游戏里只会显示原文。',
            missing.length + ' dialogue line(s) carry a #line: id with no row in the localisation ' +
            'tables: ' + sample + (missing.length > 6 ? ', …' : '') +
            '. Those lines have no translation and will show the original text.'));
        }
      }

      const orphans = [];
      for (const [id, rels] of tableLineIds) {
        if (!yarnLineIds.has(id)) orphans.push({ id: id, rel: rels[0] });
      }
      if (orphans.length) {
        diagnostics.push(diag('warning', 'D015', orphans[0].rel, '',
          orphans.length + ' 个本地化行在 Yarn 里找不到对应的 #line:（行被删掉或 id 改过）：' +
          orphans.slice(0, 6).map(function (o) { return 'line:' + o.id; }).join('、') +
          (orphans.length > 6 ? ' 等' : '') + '。这些译文永远不会出现在游戏里。',
          orphans.length + ' localisation row(s) have no matching #line: in any Yarn file ' +
          '(the line was deleted or its id changed): ' +
          orphans.slice(0, 6).map(function (o) { return 'line:' + o.id; }).join(', ') +
          (orphans.length > 6 ? ', …' : '') + '. Those translations will never appear in the game.'));
      }

      const repeated = [];
      for (const [id, where] of yarnLineIds) {
        if (where.length < 2) continue;
        const rels = [];
        for (const w of where) if (rels.indexOf(w.rel) < 0) rels.push(w.rel);
        if (rels.length > 1) repeated.push({ id: id, rels: rels });
      }
      if (repeated.length) {
        diagnostics.push(diag('warning', 'D016', repeated[0].rels[0], '',
          repeated.length + ' 个 #line: id 同时出现在多个 Yarn 文件里：' +
          repeated.slice(0, 5).map(function (r) {
            return 'line:' + r.id + '（' + r.rels.join(' | ') + '）';
          }).join('、') + '。同一个 id 只能对应一行，否则翻译会串行。',
          repeated.length + ' #line: id(s) appear in more than one Yarn file: ' +
          repeated.slice(0, 5).map(function (r) {
            return 'line:' + r.id + ' (' + r.rels.join(' | ') + ')';
          }).join(', ') + '. One id belongs to one line, otherwise translations are ambiguous.'));
      }

      const nonContract = [];
      for (const [id] of yarnLineIds) {
        if (!LINE_ID_CONTRACT.test(id)) nonContract.push(id);
      }
      if (nonContract.length && tableLineIds.size) {
        diagnostics.push(diag('info', 'D017', 'Yarn', '',
          nonContract.length + ' 个 #line: id 不是 line:<7 位 hex> 的约定形式（例：' +
          nonContract.slice(0, 5).map(function (id) { return '#line:' + id; }).join('、') +
          '）；这些行不会出现在本地化表里，也无法核对译文。',
          nonContract.length + ' #line: id(s) do not follow the line:<7 hex> contract (e.g. ' +
          nonContract.slice(0, 5).map(function (id) { return '#line:' + id; }).join(', ') +
          '); they never appear in the localisation tables and cannot be cross-checked.'));
      }
    }

    /* ---------------- G38：lock 列必须指回本包的一行文字 ---------------- */
    // lock 的契约（语料实测见常量处的注释）是 sha256(text) 的前 4 字节；一张表里
    // 同 id 的行无论哪种语言都沿用基础表那一行的 lock。所以只要包内这个 id 有任何
    // 一行文字的 hash 等于 lock，就说明它指得回一段真实文本；一个都对不上，说明
    // 文本改过而 lock 没重算（或 lock 是手填的）。
    if (csvLockRows.length) {
      const hashesById = new Map();
      for (const row of csvLockRows) {
        let set = hashesById.get(row.id);
        if (!set) { set = new Set(); hashesById.set(row.id, set); }
        set.add(lockOfText(row.text));
      }
      const stray = [];
      for (const row of csvLockRows) {
        if (!LOCK_SHAPE.test(row.lock) || row.lock.toLowerCase() === ZERO_LOCK) continue;
        const set = hashesById.get(row.id);
        if (set && set.has(row.lock.toLowerCase())) continue;
        stray.push({ row: row, want: lockOfText(row.text) });
      }
      if (stray.length) {
        const sample = stray.slice(0, 5).map(function (s) {
          return s.row.rel + '（line:' + s.row.id + '，记录 ' + s.row.lock + '，应为 ' + s.want + '）';
        }).join('、');
        diagnostics.push(diag('warning', 'D023', stray[0].row.rel, '',
          stray.length + ' 行本地化表的 lock 与包内任何一行文本的 SHA-256 都对不上：' + sample +
          (stray.length > 5 ? ' 等' : '') +
          '。lock 是 sha256(text) 的前 4 字节；改过台词文本却没重算 lock 时，游戏仍认为' +
          '译文锁在旧文本上，译文不会更新。',
          stray.length + ' localisation row(s) carry a lock that matches no text the package ' +
          'records for that id: ' + sample + (stray.length > 5 ? ', …' : '') +
          '. A lock is the first four bytes of sha256(text); editing a line without ' +
          'recomputing its lock leaves the game holding a translation of text that no ' +
          'longer exists, so the translation never updates.'));
      }
    }
  }

  /* ---------------- G46：文件格式体检（包级） ---------------- */
  // Spine 三件套按包扫，不需要任何定义引用它；根目录的 NewProject*.csv 不在
  // Yarn/ 的本地化扫描里，单独体检一次表头与字节序。
  auditSpineTriples(root, diagnostics);
  for (const e of safeReaddir(root, true)) {
    if (!e.isFile() || !/^NewProject.*\.csv$/i.test(e.name)) continue;
    if (/metadata/i.test(e.name)) continue;
    const obs = checkCsvTable(path.join(root, e.name), e.name, diagnostics);
    if (obs) csvObservations.push(obs);
  }

  // BOM / 行尾：逐表报会变成一张表一条（语料里基础表 NewProject.csv 不带 BOM、
  // 其余 10 张都带），只在同一包内不一致时说一句，并强调按原字节写回。
  if (csvObservations.length > 1) {
    const names = function (list) { return list.map((o) => o.rel).join('、'); };
    const bomYes = csvObservations.filter((o) => o.bom);
    const bomNo = csvObservations.filter((o) => !o.bom);
    if (bomYes.length && bomNo.length) {
      diagnostics.push(diag('info', 'D010', bomNo[0].rel, '',
        '包内本地化表的 BOM 不一致：' + bomNo.length + ' 张不带 BOM（' + names(bomNo) + '），' +
        bomYes.length + ' 张带 BOM（' + names(bomYes) + '）。改表时按每张表原来的字节写回，不要统一。',
        'The localisation tables in this package disagree on the UTF-8 BOM: ' + bomNo.length + ' without (' +
        names(bomNo) + '), ' + bomYes.length + ' with (' + names(bomYes) +
        '). Keep each table\'s original bytes when editing; do not normalise them.'));
    }
    const crlfYes = csvObservations.filter((o) => o.crlf);
    const crlfNo = csvObservations.filter((o) => !o.crlf);
    if (crlfYes.length && crlfNo.length) {
      diagnostics.push(diag('info', 'D010', crlfNo[0].rel, '',
        '包内本地化表的行尾不一致：' + crlfNo.length + ' 张不是 CRLF（' + names(crlfNo) + '），' +
        crlfYes.length + ' 张是（' + names(crlfYes) + '）。改表时按每张表原来的行尾写回，不要统一。',
        'The localisation tables in this package disagree on line endings: ' + crlfNo.length + ' not CRLF (' +
        names(crlfNo) + '), ' + crlfYes.length + ' CRLF (' + names(crlfYes) +
        '). Keep each table\'s original line endings when editing; do not normalise them.'));
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
