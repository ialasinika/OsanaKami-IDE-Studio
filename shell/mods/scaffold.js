'use strict';
/**
 * scaffold.js — 游戏 Mod 脚手架生成模块
 *
 * 按模板一键生成结构完整、可直接放进游戏 `StreamingAssets/Mods/` 加载的 Mod 包。
 *
 * 只依赖 Node 内置模块（fs / path / os）。不 require 同目录其它模块（yarn.js /
 * validate.js / search.js / highlight.js），以便并行开发时互不阻塞。
 *
 * 真实结构参考：
 *   Mods<game>/MyMod/mod.json               -> { name, version, gameVersion, loadOrder, author?, description }
 *   Mods<game>/MyMod/Yarn/*.yarn            -> title/tags/subtitle/tracking 头部 + `---` 正文 + `===` 收尾
 *   Mods<game>/MyMod/Yarn/NewProject*.csv   -> language,id,text,file,node,lineNumber,lock,comment
 *   Mods<game>/SODefines/Defines/<Type>/<TechName>.json   -> techName 必须等于文件名（去 .json）
 *
 * 生成物只写入调用方给出的 destDir。
 */

const fs = require('fs');
const fsp = fs.promises;
const path = require('path');
const os = require('os');
const zlib = require('zlib');

/* ------------------------------------------------------------------ *
 * 1. 版本 / 常量
 * ------------------------------------------------------------------ */

const SCAFFOLD_VERSION = '1.0.0';

/* ------------------------------------------------------------------ *
 * 1b. 占位图（零依赖 PNG 编码）
 *
 * 生成的 define 会在 icon / portrait 等字段写一个相对路径，游戏加载时该文件
 * 必须真实存在，否则校验器会报 D006。为了让「新建出来的 Mod 包一次校验通过」，
 * 这里用 zlib 现场编码一张真实 PNG，而不是写空文件或指向游戏本体资源。
 * ------------------------------------------------------------------ */

/** CRC32（PNG 每个 chunk 都要）。 */
const _CRC_TABLE = (() => {
  const t = new Int32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c;
  }
  return t;
})();

function _crc32(buf) {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) c = _CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function _pngChunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length, 0);
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(_crc32(body), 0);
  return Buffer.concat([len, body, crc]);
}

/** 占位图主题色（与 IDE 主色一致）。 */
const PLACEHOLDER_RGB = [0x7c, 0x4e, 0xc1];

/**
 * 生成一张 `size`×`size` 的 RGBA PNG：浅色底 + 主题色圆环，够当图标用。
 *
 * @param {number} size    边长（像素）
 * @param {number[]} rgb   主题色 [r,g,b]
 * @returns {Buffer}
 */
function makePlaceholderPng(size, rgb) {
  const n = Math.max(8, size | 0 || 64);
  const c = Array.isArray(rgb) && rgb.length >= 3 ? rgb : [0x7c, 0x4e, 0xc1];
  const raw = Buffer.alloc((n * 4 + 1) * n);
  const cx = (n - 1) / 2;
  const rOuter = n * 0.46;
  const rInner = n * 0.30;
  for (let y = 0; y < n; y++) {
    const row = y * (n * 4 + 1);
    raw[row] = 0; // filter: None
    for (let x = 0; x < n; x++) {
      const o = row + 1 + x * 4;
      const d = Math.sqrt((x - cx) * (x - cx) + (y - cx) * (y - cx));
      const on = d <= rInner ? 1 : d <= rOuter ? 0.55 : 0;
      // 底色用主题色压暗，环用主题色本体，边缘留透明
      const base = on >= 1 ? c : c;
      raw[o] = Math.round(base[0] * (on >= 1 ? 0.35 : 1));
      raw[o + 1] = Math.round(base[1] * (on >= 1 ? 0.35 : 1));
      raw[o + 2] = Math.round(base[2] * (on >= 1 ? 0.35 : 1));
      raw[o + 3] = Math.round(255 * on);
    }
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(n, 0);
  ihdr.writeUInt32BE(n, 4);
  ihdr[8] = 8;  // bit depth
  ihdr[9] = 6;  // color type: RGBA
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    _pngChunk('IHDR', ihdr),
    _pngChunk('IDAT', zlib.deflateSync(raw, { level: 9 })),
    _pngChunk('IEND', Buffer.alloc(0)),
  ]);
}

/** 默认 loadOrder：0/1 被 MyMod/SODefines 占用，所以默认给 5。 */
const DEFAULT_LOAD_ORDER = 5;
const DEFAULT_GAME_VERSION = '1.0';
const DEFAULT_AUTHOR = 'Mod Author';
const DEFAULT_LOCALES = ['zh-CN', 'en-US'];
const DEFAULT_BASE_LANGUAGE = 'zh-CN';

/** 参考工程里真实存在的语言码（MyMod/Yarn/NewProject_*.csv），外加几个常见地区变体。 */
const KNOWN_LOCALES = [
  'zh-CN', 'en', 'ja', 'ru', 'es-US', 'zh-TW', 'fr', 'ko', 'pt-BR', 'bg', 'de',
  'en-US', 'ja-JP',
];

/** 语言码 -> CSV 文件名后缀（照抄真实工程 MyMod/Yarn/NewProject*.csv 的命名）。 */
const LOCALE_FILE_SUFFIX = {
  'zh-CN': '',
  'zh-TW': '_zhTW',
  en: '_EN',
  'en-US': '_enUS',
  ja: '_JA',
  'ja-JP': '_jaJP',
  ru: '_RU',
  'es-US': '_esUS',
  fr: '_fr',
  ko: '_ko',
  'pt-BR': '_ptBR',
  bg: '',
  de: '_de',
};

/** 不含路径分隔符的非法文件名字符。 */
const ILLEGAL_NAME_CHARS = /[<>:"/\\|?*\u0000-\u001f]/;

/* ------------------------------------------------------------------ *
 * 2. 模板定义
 * ------------------------------------------------------------------ */

/** 模板 id -> 生成内容 */
const TEMPLATES = [
  {
    id: 'minimal',
    nameZh: '最小可加载',
    nameEn: 'Minimal',
    descriptionZh: '只生成 mod.json + README.md，结构最小、可立刻被游戏识别加载。',
    descriptionEn: 'Only mod.json + README.md — the smallest loadable mod package.',
    creates: ['mod.json', 'README.md'],
  },
  {
    id: 'yarn-story',
    nameZh: '对话剧情',
    nameEn: 'Yarn Story',
    descriptionZh: '在最小包基础上加入 Yarn/MyMod_Story.yarn（3 节点互跳 + 变量声明 + 条件分支 + 选项）、本地化 CSV 与 yarnproject。',
    descriptionEn: 'Minimal plus a Yarn story (3 interlinked nodes, variables, conditionals, options), localisation CSVs and a yarnproject.',
    creates: [
      'mod.json',
      'README.md',
      'Yarn/<ModName>_Story.yarn',
      'Yarn/<ModName>.yarnproject',
      'Yarn/<ModName>.csv',
      'Yarn/<ModName>_enUS.csv',
    ],
  },
  {
    id: 'define-pack',    nameZh: '定义包',
    nameEn: 'Define Pack',
    descriptionZh: '在最小包基础上加入 Defines/<Type>/<TechName>.json（Goods / Topic 两种，字段与 schema 完全一致，techName 等于文件名）。',
    descriptionEn: 'Minimal plus ScriptableObject defines (Goods / Topic) whose fields exactly match the schemas and whose techName equals the file name.',
    creates: [
      'mod.json',
      'README.md',
      'Defines/Goods/<ModName>_Poster.json',
      'Defines/Topic/<ModName>_Topic.json',
    ],
  },
  {
    id: 'full',
    nameZh: '完整工程',
    nameEn: 'Full Project',
    descriptionZh: '全部内容：mod.json、Yarn 剧情与本地化、Defines 定义包、Sprites 占位说明，以及含安装步骤与命名规范的 README。',
    descriptionEn: 'Everything: mod.json, Yarn story + localisation, define pack, Sprites placeholder notes, and a README with install steps and naming rules.',
    creates: [
      'mod.json',
      'README.md',
      'Yarn/<ModName>_Story.yarn',
      'Yarn/<ModName>.yarnproject',
      'Yarn/<ModName>.csv',
      'Yarn/<ModName>_enUS.csv',
      'Defines/Goods/<ModName>_Poster.json',
      'Defines/Topic/<ModName>_Topic.json',
      'Defines/CutScene/<ModName>_Intro.json',
      'Sprites/README.md',
    ],
  },
];

/** 保留对外可见的 MOD_TEMPLATES 结构（creates 用占位符，实际文件名随 modName 变化）。 */
const MOD_TEMPLATES = TEMPLATES.map((t) => ({
  id: t.id,
  nameZh: t.nameZh,
  nameEn: t.nameEn,
  descriptionZh: t.descriptionZh,
  descriptionEn: t.descriptionEn,
  creates: t.creates.slice(),
}));

function describeTemplates() {
  return MOD_TEMPLATES;
}

/* ------------------------------------------------------------------ *
 * 3. 角色配色 / 知识库（可选；没有知识库时不编造游戏角色）
 * ------------------------------------------------------------------ */

/**
 * 知识库的位置：本目录的 knowledge.json。
 *
 * 这里刻意没有任何内置角色表：那七个角色名与配色是游戏数据，不能编译进分发物
 * （docs/EDITOR_GAPS.md §14.1）。没有知识库时角色表就是空的 —— 调用方要么自己传
 * characters，要么由 defaultStoryNodes 用 modName 兜底。
 */
const KNOWLEDGE_PATH = path.join(__dirname, 'knowledge.json');

/** 上一次 scaffoldMod 显式给的知识库路径；null = 用 KNOWLEDGE_PATH。 */
let knowledgePathOverride = null;

function stripBom(s) {
  return s && s.charCodeAt(0) === 0xfeff ? s.slice(1) : s;
}

/**
 * 读取知识库里的角色表；没有知识库 / 没有角色表时返回空数组。
 * @returns {Array<{name:string,colour:string}>}
 */
function loadKnowledgeCharacters() {
  const kb = knowledge();
  const list = kb && kb.localization && kb.localization.characters;
  if (!Array.isArray(list) || !list.length) return [];
  return list
    .filter((c) => c && typeof c.name === 'string' && c.name)
    .map((c) => ({ name: c.name, colour: typeof c.colour === 'string' && c.colour ? c.colour : '#39c690' }));
}

function normalizeCharacters(input) {
  if (!Array.isArray(input) || !input.length) return loadKnowledgeCharacters();
  const out = [];
  for (const c of input) {
    if (!c) continue;
    if (typeof c === 'string' && c.trim()) {
      out.push({ name: c.trim(), colour: '#39c690' });
    } else if (typeof c === 'object' && typeof c.name === 'string' && c.name.trim()) {
      out.push({
        name: c.name.trim(),
        colour: typeof c.colour === 'string' && c.colour ? c.colour : '#39c690',
      });
    }
  }
  return out.length ? out : loadKnowledgeCharacters();
}

/* ------------------------------------------------------------------ *
 * 4. 小工具
 * ------------------------------------------------------------------ */

/** 确定性 PRNG（mulberry32），保证同一 modName 生成同样的 #line: id。 */
function hashSeed(str) {
  let h = 2166136261 >>> 0;
  for (let i = 0; i < str.length; i += 1) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 16777619) >>> 0;
  }
  return h >>> 0;
}

function mulberry32(seed) {
  let a = seed >>> 0;
  return function next() {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * `#line:` id 生成器。真实文件里是 7 位十六进制小写字符串；这里保证非空且唯一
 * （万一随机碰撞就线性探测下一个值）。
 */
function createLineIdFactory(seedStr) {
  const rnd = mulberry32(hashSeed(String(seedStr || 'infant-god')));
  const used = new Set();
  return function nextLineId() {
    for (let attempt = 0; attempt < 64; attempt += 1) {
      const v = Math.floor(rnd() * 0x10000000) & 0x0fffffff;
      const id = v.toString(16).padStart(7, '0').slice(-7);
      if (!used.has(id)) {
        used.add(id);
        return id;
      }
    }
    // 极端情况：顺序补齐
    for (let i = 0; i < 0x10000000; i += 1) {
      const id = i.toString(16).padStart(7, '0');
      if (!used.has(id)) {
        used.add(id);
        return id;
      }
    }
    throw new Error('line id space exhausted');
  };
}

function toPosix(p) {
  return String(p).split(path.sep).join('/');
}

function safeFileName(name) {
  return String(name || '').trim().replace(/[\s]+/g, '_').replace(ILLEGAL_NAME_CHARS, '_');
}

function normalizeModName(modName) {
  const name = String(modName == null ? '' : modName).trim();
  if (!name) throw new Error('scaffoldMod: opts.modName is required');
  if (ILLEGAL_NAME_CHARS.test(name) || name === '.' || name === '..') {
    throw new Error(`scaffoldMod: illegal modName "${name}" (contains path or reserved characters)`);
  }
  return name;
}

function normalizeLocales(locales, baseLanguage) {
  let list = Array.isArray(locales) ? locales : [];
  list = list
    .map((l) => String(l == null ? '' : l).trim())
    .filter((l) => l && !ILLEGAL_NAME_CHARS.test(l) && l !== '.' && l !== '..');
  if (!list.length) list = DEFAULT_LOCALES.slice();
  // 去重，保持顺序；baseLanguage 永远排最前。
  const out = [];
  const base = baseLanguage && list.includes(baseLanguage) ? baseLanguage : list[0];
  if (base) out.push(base);
  for (const l of list) if (!out.includes(l)) out.push(l);
  return out;
}

/** CSV 字段转义：含逗号/引号/换行时整体加引号，内部引号翻倍（与真实 CSV 一致）。 */
function csvField(value) {
  const s = value == null ? '' : String(value);
  if (/[",\r\n]/.test(s)) return `"${s.replace(/"/g, '""')}"`;
  return s;
}

function csvLine(fields) {
  return fields.map(csvField).join(',');
}

function csvFileNameFor(modName, locale) {
  const suffix = Object.prototype.hasOwnProperty.call(LOCALE_FILE_SUFFIX, locale)
    ? LOCALE_FILE_SUFFIX[locale]
    : `_${safeFileName(locale).replace(/-/g, '')}`;
  return `${safeFileName(modName)}${suffix}.csv`;
}

/* ------------------------------------------------------------------ *
 * 5. Yarn 解析（内部用：给本地化 CSV 提供 file/node/lineNumber/元数据）
 * ------------------------------------------------------------------ */

/**
 * 解析一份 Yarn 文本：
 *   -> { nodes: [{ title, header, body: [...] }], errors: [...] }
 * body 里每一项是 { kind: 'line'|'option'|'command'|'comment'|'blank', raw, ... }
 */
function parseYarnStory(text) {
  const lines = String(text == null ? '' : text).replace(/\r\n?/g, '\n').split('\n');
  const nodes = [];
  const errors = [];
  let cur = null;
  let mode = 'idle'; // idle | header | body
  let bodyStartLineNumber = 0;

  const pushBody = (kind, raw, lineNumber, extra) => {
    cur.body.push(Object.assign({ kind, raw, lineNumber }, extra || {}));
  };

  for (let i = 0; i < lines.length; i += 1) {
    const raw = lines[i];
    const lineNo = i + 1;
    const trimmed = raw.trim();

    if (mode === 'header') {
      if (trimmed === '---') {
        mode = 'body';
        bodyStartLineNumber = lineNo + 1;
        continue;
      }
      if (/^([A-Za-z_][A-Za-z0-9_]*)\s*:\s*(.*)$/.test(trimmed)) {
        cur.header.push(trimmed);
        continue;
      }
      if (!trimmed) {
        cur.header.push('');
        continue;
      }
      if (/^\/\//.test(trimmed)) {
        cur.header.push(trimmed);
        continue;
      }
      errors.push(`line ${lineNo}: unexpected content in node header of "${cur.title}": ${trimmed}`);
      cur.header.push(trimmed);
      continue;
    }

    if (mode === 'body' && trimmed === '===') {
      cur.endLineNumber = lineNo;
      nodes.push(cur);
      cur = null;
      mode = 'idle';
      continue;
    }

    if (mode === 'idle') {
      if (!trimmed) continue;
      if (/^\/\//.test(trimmed)) continue;
      const m = /^title\s*:\s*(\S+)\s*$/.exec(trimmed);
      if (!m) {
        errors.push(`line ${lineNo}: content outside of any node: ${trimmed}`);
        continue;
      }
      cur = { title: m[1], header: [trimmed], body: [], startLineNumber: lineNo };
      mode = 'header';
      continue;
    }

    // mode === 'body'
    if (!trimmed) {
      pushBody('blank', raw, lineNo);
      continue;
    }
    if (/^\/\//.test(trimmed)) {
      pushBody('comment', raw, lineNo);
      continue;
    }
    const opt = /^->\s*(.*)$/.exec(trimmed);
    if (opt) {
      const rawOpt = opt[1];
      const lineIdM = /#line:([0-9a-fA-F]+)/.exec(rawOpt);
      const stateM = /#state:([^\s#]+)/.exec(rawOpt);
      pushBody('option', raw, lineNo, {
        indent: raw.length - raw.replace(/^\s+/, '').length,
        text: lineIdM ? rawOpt.slice(0, lineIdM.index).trim() : rawOpt.trim(),
        lineId: lineIdM ? lineIdM[1] : null,
        state: stateM ? stateM[1] : null,
      });
      continue;
    }
    if (/^<<.*>>$/.test(trimmed)) {
      pushBody('command', raw, lineNo, { command: trimmed.replace(/^<</, '').replace(/>>$/, '').trim() });
      continue;
    }
    const dm = /^([^\s#][^:]*?)\s*:\s*(.*)$/.exec(trimmed);
    if (dm) {
      const rest = dm[2];
      const lineIdM = /#line:([0-9a-fA-F]+)/.exec(rest);
      const stateM = /#state:([^\s#]+)/.exec(rest);
      const text = (lineIdM ? rest.slice(0, lineIdM.index) : rest).trim();
      pushBody('line', raw, lineNo, {
        indent: raw.length - raw.replace(/^\s+/, '').length,
        speaker: dm[1].trim(),
        text,
        lineId: lineIdM ? lineIdM[1] : null,
        state: stateM ? stateM[1] : null,
        fullText: `${dm[1].trim()}: ${text}`,
      });
      continue;
    }
    pushBody('other', raw, lineNo);
  }

  if (mode === 'header' || mode === 'body') {
    errors.push(`node "${cur ? cur.title : '?'}" is not terminated by "===" (opened at line ${cur ? cur.startLineNumber : '?'})`);
  }

  return { nodes, errors };
}

/**
 * 从 Yarn 文本里抽取本地化需要的条目（含每行的 #line: / #state: 元数据）。
 * filePath 用 POSIX 相对路径写入 CSV 的 file 列。
 */
function yarnStoryToEntries(text, filePath, modName) {
  const parsed = parseYarnStory(text);
  const entries = [];
  for (const node of parsed.nodes) {
    for (const item of node.body) {
      if (item.kind !== 'line' && item.kind !== 'option') continue;
      entries.push({
        key: item.lineId || '',
        text: item.kind === 'line' ? item.fullText : item.text,
        state: item.state || null,
        node: node.title,
        lineNumber: item.lineNumber,
        file: filePath,
      });
    }
  }
  return { entries, errors: parsed.errors, nodes: parsed.nodes };
}

/* ------------------------------------------------------------------ *
 * 6. Yarn 生成
 * ------------------------------------------------------------------ */

const NODE_META_ORDER = ['title', 'tags', 'subtitle', 'when', 'tracking'];

function formatNode(node) {
  const meta = [];
  const push = (k, v) => {
    if (v === undefined || v === null || v === '') return;
    meta.push(`${k}: ${v}`);
  };
  push('title', node.title);
  if (node.tags) push('tags', node.tags);
  if (node.subtitle) push('subtitle', node.subtitle);
  push('when', node.when || 'always');
  if (node.tracking) push('tracking', node.tracking);
  // 其它自定义头字段（保持确定性顺序）
  if (node.extraMeta && typeof node.extraMeta === 'object') {
    for (const k of Object.keys(node.extraMeta).sort()) {
      if (NODE_META_ORDER.includes(k)) continue;
      push(k, node.extraMeta[k]);
    }
  }
  const body = (node.body || []).map((l) => (l == null ? '' : String(l)));
  return `${meta.join('\n')}\n---\n${body.join('\n').replace(/\n+$/, '')}\n===\n`;
}

/** 默认生成的 3 个互相跳转的节点（含变量声明、条件分支、选项）。 */
function defaultStoryNodes(modName, characters) {
  // 没有角色表时用 mod 自己的名字当说话人：这是调用方给的名字，不是游戏角色。
  const names = (Array.isArray(characters) ? characters : []).map((c) => c && c.name).filter(Boolean);
  const lead = names[0] || modName;
  const second = names[Math.min(1, names.length - 1)] || lead;
  const third = names[Math.min(2, names.length - 1)] || lead;

  return [
    {
      title: `${modName}_Start`,
      tags: '#hub #reach',
      subtitle: `${modName} 入口`,
      when: 'always',
      tracking: 'always',
      body: [
        `// ${modName} 的入口节点。`,

        `<<declare $${modName}_Visits = 0>>`,
        `<<declare $${modName}_Mood = "Neutral">>`,
        `<<set $${modName}_Visits += 1>>`,
        `${lead}: 你好，欢迎来到 ${modName}。 #line:LINE #state:Idle`,
        `${lead}: 这是第 {$${modName}_Visits} 次启动。 #line:LINE #state:Idle`,
        '<<if $' + modName + '_Visits >= 2>>',
        `    ${lead}: 又见面了。我已经记住你了。 #line:LINE #state:Happy`,
        '<<else>>',
        `    ${lead}: 初次见面，请多关照。 #line:LINE #state:Idle`,
        '<<endif>>',
        `${second}: 别废话了，我们开始吧。 #line:LINE #state:Idle`,
        `<<jump ${modName}_Hub>>`,
      ],
    },
    {
      title: `${modName}_Hub`,
      tags: '#hub #reach',
      subtitle: '选择下一步',
      when: 'always',
      tracking: 'always',
      body: [
        '// 对话枢纽：把两条分支串起来。',
        `${lead}: 你想先做点什么？ #line:LINE #state:Idle`,
        `-> 回顾一下之前发生的事 #line:LINE`,
        `    <<set $${modName}_Mood = "Thoughtful">>`,
        `    ${third}: 那就从回忆开始吧。 #line:LINE #state:Idle`,
        `    <<detour ${modName}_Reflection>>`,
        `-> 直接进入结局 #line:LINE`,
        `    <<set $${modName}_Mood = "Bold">>`,
        `    ${lead}: 好，那就跳过铺垫。 #line:LINE #state:Happy`,
        `    <<jump ${modName}_Finale>>`,
      ],
    },
    {
      title: `${modName}_Reflection`,
      tags: '#hub #reach',
      subtitle: '回顾',
      when: 'always',
      body: [
        '// 被 Hub detour 进来的回顾节点，结束时回到 Hub。',
        `<<once>>`,
        `    ${lead}: 这段回忆只会播放一次。 #line:LINE #state:Idle`,
        `<<endonce>>`,
        '<<if $' + modName + '_Mood == "Thoughtful">>',
        `    ${third}: 你当时确实想了很多。 #line:LINE #state:Idle`,
        '<<else>>',
        `    ${third}: 你看起来并不在意。 #line:LINE #state:Idle`,
        '<<endif>>',
        `<<jump ${modName}_Hub>>`,
      ],
    },
    {
      title: `${modName}_Finale`,
      tags: '#hub #reach',
      subtitle: '结局',
      when: 'always',
      body: [
        '// 收敛节点：把状态写进结局变量。',
        `<<declare $${modName}_Ending = "None">>`,
        '<<if $' + modName + '_Mood == "Bold">>',
        `    <<set $${modName}_Ending = "Bold">>`,
        `    ${lead}: 你选择了最短的那条路。 #line:LINE #state:Happy`,
        '<<else>>',
        `    <<set $${modName}_Ending = "Thoughtful">>`,
        `    ${lead}: 你选择了慢慢走完。 #line:LINE #state:Idle`,
        '<<endif>>',
        `<<Love "${lead}" 1>>`,
        `${second}: 结束了。下次再来。 #line:LINE #state:Idle`,
      ],
    },
  ];
}

/**
 * 渲染一份合法 Yarn 文本。
 * @param {{modName?:string, nodes?:Array, characters?:Array}} [opts]
 * @returns {string}
 */
function renderYarnStory(opts) {
  const o = opts && typeof opts === 'object' ? opts : {};
  const modName = o.modName ? normalizeModName(o.modName) : 'MyMod';
  const characters = normalizeCharacters(o.characters);

  let nodes;
  if (Array.isArray(o.nodes) && o.nodes.length) {
    nodes = o.nodes
      .filter((n) => n && typeof n === 'object' && n.title)
      .map((n) => ({
        title: String(n.title),
        tags: n.tags,
        subtitle: n.subtitle,
        when: n.when,
        tracking: n.tracking,
        extraMeta: n.extraMeta,
        body: Array.isArray(n.body) ? n.body.slice() : [],
      }));
    if (!nodes.length) nodes = defaultStoryNodes(modName, characters);
  } else {
    nodes = defaultStoryNodes(modName, characters);
  }

  const nextLineId = createLineIdFactory(`${modName}::yarn-story::${SCAFFOLD_VERSION}`);
  const rendered = nodes.map((n) => {
    const body = (n.body || []).map((line) =>
      String(line).replace(/#line:LINE/g, () => `#line:${nextLineId()}`),
    );
    return formatNode(Object.assign({}, n, { body }));
  });

  return `${rendered.join('\n')}`.replace(/[ \t]+$/gm, '');
}

/* ------------------------------------------------------------------ *
 * 7. 本地化 CSV 生成
 * ------------------------------------------------------------------ */

/**
 * 渲染一份本地化 CSV（列结构照抄真实文件：
 *   language,id,text,file,node,lineNumber,lock,comment
 * ）
 * @param {{baseLanguage?:string, locales?:string[], entries?:Array}} [opts]
 * @returns {string}
 */
function renderLocalisationCsv(opts) {
  const o = opts && typeof opts === 'object' ? opts : {};
  const baseLanguage = String(o.baseLanguage || DEFAULT_BASE_LANGUAGE);
  const locales = normalizeLocales(o.locales, baseLanguage);
  const entries = Array.isArray(o.entries) ? o.entries.filter(Boolean) : [];

  const header = ['language', 'id', 'text', 'file', 'node', 'lineNumber', 'lock', 'comment'].join(',');
  const rows = [];

  locales.forEach((locale) => {
    const rnd = mulberry32(hashSeed(`${locale}::${baseLanguage}::${entries.length}`));
    const lockHex = () => Math.floor(rnd() * 0x100000000).toString(16).padStart(8, '0');
    for (const e of entries) {
      const key = String(e.key == null ? '' : e.key);
      const id = /^line:/.test(key) ? key : `line:${key}`;
      let text = e.text == null ? '' : String(e.text);
      const translations = e.translations && typeof e.translations === 'object' ? e.translations : null;
      if (translations && typeof translations[locale] === 'string') {
        text = translations[locale];
      } else if (locale !== baseLanguage && typeof e.translation === 'string') {
        text = e.translation;
      }
      const state = e.state || (e.meta && e.meta.state) || null;
      rows.push(
        csvLine([
          locale,
          id,
          text,
          e.file == null ? '' : String(e.file),
          e.node == null ? '' : String(e.node),
          e.lineNumber == null ? '' : String(e.lineNumber),
          // lock 列固定 8 位十六进制；每行独立随机。
          lockHex(),
          state ? `Line metadata: state:${state}` : (e.comment == null ? '' : String(e.comment)),
        ]),
      );
    }
  });

  return `\ufeff${[header, ...rows].join('\n')}\n`;
}

/* ------------------------------------------------------------------ *
 * 8. ScriptableObject 定义生成（字段严格来自 schema）
 * ------------------------------------------------------------------ */

/**
 * 这次生成生效的游戏 Mods 目录；null = 没有（这时只用知识库里的 schema）。
 * 解析顺序与 index.js/gamepath.js 一致：显式参数 → 环境变量 → 没有。
 * 这里不写死任何本机路径。
 */
let activeGameModsDir = null;

/** 已读 schema 的缓存：`<游戏目录>\0<TypeName>` -> schema 对象 | null */
const schemaCache = new Map();

/** 目录是否存在（schema 探测用）。 */
function dirExists(p) {
  try {
    return !!p && fs.statSync(p).isDirectory();
  } catch {
    return false;
  }
}

/**
 * 解析这次生成要用的游戏 Mods 目录。显式参数优先，其次环境变量；
 * 找不到就是 null（index.js 会把它自己探测到的目录传进来）。
 */
function resolveGameModsDir(explicit) {
  const fromEnv = process.env.INFANTGOD_MODS_DIR;
  const gameHome = process.env.INFANTGOD_GAME_DIR;
  const candidates = [
    explicit,
    fromEnv,
    gameHome ? path.join(String(gameHome), 'Mods') : null,
    gameHome ? path.join(String(gameHome), 'ModsFull', 'Mods') : null,
  ];
  for (const c of candidates) {
    if (c == null || String(c).trim() === '') continue;
    const abs = path.resolve(String(c));
    if (dirExists(abs)) return abs;
  }
  return null;
}

function loadSchema(typeName) {
  const key = `${activeGameModsDir || ''}\u0000${typeName}`;
  if (schemaCache.has(key)) return schemaCache.get(key);
  let schema = null;
  const candidates = [];
  if (activeGameModsDir) {
    candidates.push(path.join(activeGameModsDir, 'SODefines', 'Schema', `${typeName}.schema.json`));
  }
  candidates.push(path.join(__dirname, 'knowledge', 'schema', `${typeName}.schema.json`));
  candidates.push(path.join(__dirname, 'knowledge', 'schemas', `${typeName}.schema.json`));
  for (const p of candidates) {
    try {
      schema = JSON.parse(stripBom(fs.readFileSync(p, 'utf8')));
      break;
    } catch {
      /* 试下一个候选路径 */
    }
  }
  if (!schema) schema = loadSchemaFromKnowledge(typeName);
  schemaCache.set(key, schema);
  return schema;
}

let knowledgeCache; // undefined = 还没读过；null = 读过但没有
let knowledgeCachePath = null;

/** 这次生效的知识库路径（scaffoldMod 的 opts.knowledgePath 可覆盖）。 */
function knowledgePath() {
  return knowledgePathOverride || KNOWLEDGE_PATH;
}

function knowledge() {
  const p = knowledgePath();
  if (knowledgeCachePath === p && knowledgeCache !== undefined) return knowledgeCache;
  knowledgeCachePath = p;
  try {
    knowledgeCache = JSON.parse(stripBom(fs.readFileSync(p, 'utf8')));
  } catch {
    knowledgeCache = null;
  }
  return knowledgeCache;
}

function loadSchemaFromKnowledge(typeName) {
  const kb = knowledge();
  if (!kb || !kb.schemas) return null;
  // knowledge.json 里同名键可能大小写不同，做个大小写不敏感查找。
  if (kb.schemas[typeName]) return kb.schemas[typeName];
  const hit = Object.keys(kb.schemas).find((k) => k.toLowerCase() === String(typeName).toLowerCase());
  return hit ? kb.schemas[hit] : null;
}

/** 按 schema 递归生成一份"字段齐全"的默认值。 */
function defaultValueForSchema(node, propertyName) {
  const s = node && typeof node === 'object' ? node : {};
  const type = Array.isArray(s.type) ? s.type[0] : s.type;
  if (Array.isArray(s.enum) && s.enum.length && type !== 'array') return s.enum[0];
  if (s.const !== undefined) return s.const;
  switch (type) {
    case 'object':
      return defaultObjectForSchema(s);
    case 'array':
      return [];
    case 'integer':
    case 'number':
      return 0;
    case 'boolean':
      return false;
    case 'null':
      return null;
    case 'string':
    default:
      if (propertyName === 'icon') return 'Sprites/placeholder.png';
      return '';
  }
}

function defaultObjectForSchema(schema) {
  const out = {};
  const props = schema && schema.properties && typeof schema.properties === 'object' ? schema.properties : {};
  for (const key of Object.keys(props)) {
    out[key] = defaultValueForSchema(props[key], key);
  }
  if (schema && Array.isArray(schema.required)) {
    for (const key of schema.required) {
      if (!(key in out)) out[key] = defaultValueForSchema(props[key], key);
    }
  }
  return out;
}

/**
 * schema 里表示"文件名身份"的字段名：
 * 大多数类型是 `techName`，但有 15 种（CutScene / AchievementDefinition / Memory / Quest* …）
 * 用 PascalCase 的 `TechName`。两者都必须等于文件名（去 .json）。
 */
function techNameFieldOf(schema) {
  const props = (schema && schema.properties) || {};
  if (Object.prototype.hasOwnProperty.call(props, 'techName')) return 'techName';
  if (Object.prototype.hasOwnProperty.call(props, 'TechName')) return 'TechName';
  return 'techName';
}

/**
 * 生成一份 define JSON。
 * - 所有属性名都来自该 Type 的 schema.properties（因此必定被校验通过）
 * - 身份字段（techName / TechName）强制等于文件名（去 .json）
 * - schema 里没有身份字段时（理论上不存在）退化成 techName，并给出 warning
 */
function buildDefineObject(typeName, techName, overrides) {
  const schema = loadSchema(typeName);
  const base = schema
    ? defaultObjectForSchema(schema)
    : { EditorNote: '', techName: '', nameKey: '', descKey: '' };
  const out = Object.assign(base, overrides || {});
  const field = techNameFieldOf(schema);
  if (field !== 'techName' && Object.prototype.hasOwnProperty.call(out, 'techName')) delete out.techName;
  out[field] = techName;
  if (schema && schema.properties && 'EditorNote' in schema.properties && !('EditorNote' in out)) {
    out.EditorNote = '';
  }
  return out;
}

/** 模板用到的 define 定义清单（typeName / techName 后缀 / 逐字段覆写）。 */
function defineSpecs(modName) {
  const safe = safeFileName(modName);
  const lead = `Sprites/Resources/Art/UI/Icon/${safe}.png`;
  return [
    {
      typeName: 'Goods',
      techName: `${safe}_Poster`,
      overrides: {
        id: '',
        targetObject: null,
        goodsType: 'GoodsType_Album',
        level: 1,
        cost: 100,
        persistent: false,
        nameKey: `${safe}_Poster_name`,
        descKey: `${safe}_Poster_desc`,
        effectDescKey: `${safe}_Poster_effect`,
        icon: lead,
      },
    },
    {
      // Topic 的 attrType 指向 Attr；但 Attr 在 wiki 的支持矩阵里是“不支持独立
      // 扩展”（没有 manager 消费），所以模板不生成 Attr，也不留下悬空引用。
      typeName: 'Topic',
      techName: `${safe}_Topic`,
      overrides: {
        attrType: null,
        inFilter: true,
        levelConfigs: [
          { level: 1, variableName: '', descKey: `${safe}_Topic_1_desc`, quality: 0, addedSpecialEffect: null },
          { level: 2, variableName: '', descKey: `${safe}_Topic_2_desc`, quality: 1, addedSpecialEffect: null },
        ],
        nameKey: `${safe}_Topic_name`,
        descKey: `${safe}_Topic_desc`,
        icon: lead,
      },
    },
    {
      typeName: 'CutScene',
      techName: `${safe}_Intro`,
      overrides: {
        // CutScene 的字段是 PascalCase（EditorNote / TechName / Prefab / YarnNode / Steps），
        // 没有 nameKey/descKey 这类本地化字段。Prefab 为 null 与真实样例一致。
        Prefab: null,
        YarnNode: `${safe}_Start`,
        Steps: [
          { StepName: 'Establish', TimelineName: 'Establish', PlayTransition: false },
          { StepName: 'ExitBeat', TimelineName: 'ExitBeat', PlayTransition: true },
        ],
      },
    },
  ];
}

/* ------------------------------------------------------------------ *
 * 9. mod.json / README / Sprites / yarnproject 文本
 * ------------------------------------------------------------------ */

function renderModJson(meta) {
  const obj = {
    name: meta.modName,
    version: meta.version,
    gameVersion: meta.gameVersion,
    loadOrder: meta.loadOrder,
    description: meta.description,
  };
  if (meta.author) {
    // author 放在 name/version 之后、loadOrder 之前更贴近真实文件；这里统一重排。
    return `${JSON.stringify(
      {
        name: obj.name,
        version: obj.version,
        gameVersion: obj.gameVersion,
        loadOrder: obj.loadOrder,
        author: meta.author,
        description: obj.description,
      },
      null,
      2,
    )}\n`;
  }
  return `${JSON.stringify(obj, null, 2)}\n`;
}

function renderYarnProject(meta) {
  const localisation = {};
  for (const locale of meta.locales) {
    localisation[locale] = { strings: csvFileNameFor(meta.modName, locale) };
  }
  const obj = {
    projectFileVersion: 4,
    sourceFiles: ['**/*.yarn'],
    excludeFiles: ['Bin/RandomGuy/*.yarn', 'Bin/*/*.yarn', '.storage.yarn'],
    localisation,
    baseLanguage: meta.baseLanguage,
    definitions: [],
    compilerOptions: {},
    projectName: meta.modName,
    authorName: [meta.author],
    editorOptions: {
      yarnScriptEditor: {
        characters: meta.characters.map((c) => ({ name: c.name, colour: c.colour })),
        characterColourMode: 'uniform',
        defaultCharacterColour: '#39c690',
        startNode: `${safeFileName(meta.modName)}_Start`,
      },
    },
  };
  return `${JSON.stringify(obj, null, 2)}\n`;
}

function renderSpritesReadme(meta) {
  return [
    `# Sprites — ${meta.modName}`,
    '',
    '这个目录用来放 Mod 自己的贴图/图标资源。生成器不会写入任何二进制文件，',
    '所以这里先放一份占位说明，等你把美术资源丢进来。',
    '',
    '## 目录约定',
    '',
    '```',
    'Sprites/',
    '  Resources/',
    '    Art/',
    '      UI/Icon/          <- Goods / Topic 的图标（对应 define 的 icon 字段）',
    '      CG/               <- CG 立绘',
    '    FairyGUI/           <- 需要打进 FairyGUI 包时放这里',
    '```',
    '',
    '## 字段对应关系',
    '',
    '| define 字段 | 含义 | 示例 |',
    '| --- | --- | --- |',
    '| `icon` | 相对 Mod 根目录的图片路径，正斜杠分隔 | `Sprites/Resources/Art/UI/Icon/MyIcon.png` |',
    '| `nameKey` | 本地化 CSV 里的 key，不要写中文 | `MyMod_Poster_name` |',
    '| `descKey` | 同上，描述文本的 key | `MyMod_Poster_desc` |',
    '',
    '## 注意',
    '',
    '- 路径统一用 `/`，不要用 `\\`。',
    '- 目前生成器只产出文本文件；图片请自行放入并保持路径与 define 一致。',
    '- 图片会被游戏直接读取，建议用 PNG，尺寸参考 baseline 定义里同类型资源的规格。',
    '',
  ].join('\n');
}

function renderReadme(meta) {
  const lines = [];
  lines.push(`# ${meta.modName}`);
  lines.push('');
  lines.push(meta.description);
  lines.push('');
  lines.push('## 基本信息');
  lines.push('');
  lines.push('| 项 | 值 |');
  lines.push('| --- | --- |');
  lines.push(`| 模板 | \`${meta.template}\` (${meta.templateNameZh}) |`);
  lines.push(`| 版本 | ${meta.version} |`);
  lines.push(`| 游戏版本 | ${meta.gameVersion} |`);
  lines.push(`| 加载顺序 loadOrder | ${meta.loadOrder} |`);
  lines.push(`| 作者 | ${meta.author} |`);
  lines.push(`| 基准语言 | ${meta.baseLanguage} |`);
  lines.push(`| 语言 | ${meta.locales.join(', ')} |`);
  lines.push(`| 生成器 | OsanaKami IDE Studio scaffold.js v${SCAFFOLD_VERSION} |`);
  lines.push('');
  lines.push('## 安装步骤');
  lines.push('');
  lines.push('1. 把整个 `' + meta.modName + '` 文件夹复制到游戏的 Mod 目录：');
  lines.push('');
  lines.push('   ```');
  lines.push('   <Infant God>/StreamingAssets/Mods/' + meta.modName + '/');
  lines.push('   ```');
  lines.push('');
  lines.push('2. 确认 `mod.json` 里的 `loadOrder` 没有和别的 Mod 冲突');
  lines.push(`   （本包是 ${meta.loadOrder}；\`MyMod\` 固定 0，\`SODefines\` 固定 1）。`);
  lines.push('3. 启动游戏，在 Mod 列表里勾选启用本 Mod。');
  lines.push('4. 游戏会把 Mod 目录里的 Yarn 脚本编译进对话图；定义文件按 `techName` 覆盖/新增 ScriptableObject。');
  lines.push('5. 想改内容时直接编辑本目录里的文件，重启游戏生效。');
  lines.push('');
  lines.push('## 文件结构');
  lines.push('');
  lines.push('```');
  lines.push(`${meta.modName}/`);
  for (const file of meta.fileList) {
    lines.push(`  ${file}`);
  }
  lines.push('```');
  lines.push('');
  lines.push('## 命名规范');
  lines.push('');
  lines.push('### ScriptableObject 定义');
  lines.push('');
  lines.push('- 路径固定为 `Defines/<TypeName>/<TechName>.json`，`<TypeName>` 必须是 51 种类型之一。');
  lines.push('- **`techName` 字段必须与文件名（去掉 `.json`）完全一致**，否则定义不会被加载。');
  lines.push('- 覆写基线定义时是**整份替换**，必须把 schema 里的字段全部写全，不要只写改动的那几个。');
  lines.push('- 可选字段可以为 `null`；但字段名必须与 schema 的 `properties` 完全一致（大小写敏感）。');
  lines.push('- `nameKey` / `descKey` 等是本地化 CSV 的 key，用英文字母和数字，不要直接写中文。');
  lines.push('- 类型清单与字段见 `Mods/SODefines/Schema/<TypeName>.schema.json`。');
  lines.push('');
  lines.push('### Yarn 节点');
  lines.push('');
  lines.push('- 节点头部在第一个 `---` 之前，正文在 `---` 与 `===` 之间，**`===` 必须收尾**。');
  lines.push('- 字段：`title`（节点名，必填、全局唯一）/ `tags` / `subtitle` / `when` / `tracking`。');
  lines.push('- 对话行格式：`说话人: 文本 #line:<7位十六进制> #state:<情绪>`，`#line:` id 必须全局唯一。');
  lines.push('- `<<jump 节点名>>` / `<<detour 节点名>>` 的目标节点必须真实存在，否则编译报错。');
  lines.push('- 变量以 `$` 开头，使用前用 `<<declare $X = 0>>` 声明。');
  lines.push('- 注释是整行的 `//`。');
  if (meta.characters.length) {
    lines.push('- 说话人建议只用真实存在的角色（' + meta.characters.slice(0, 8).map((c) => c.name).join('、') + ' 等），否则没有配色。');
  } else {
    lines.push('- 没有角色表（没有知识库，或知识库里没有角色）：说话人写你自己 Mod 的角色名，配色会缺省。');
  }
  lines.push('');
  lines.push('### 本地化 CSV');
  lines.push('');
  lines.push('- 列结构：`language,id,text,file,node,lineNumber,lock,comment`。');
  lines.push('- 每种语言一个文件，文件名规则见 `Yarn/` 目录（基准语言无后缀）。');
  lines.push('- 翻译文本含逗号/引号时整列用双引号包裹，内部引号写成 `""`。');
  lines.push('- `id` 就是 Yarn 里的 `#line:` id，前面加 `line:` 前缀。');
  lines.push('');
  lines.push('## 下一步');
  lines.push('');
  lines.push('- 用 IDE 的校验功能检查 Yarn 跳转闭合与 define 字段。');
  lines.push('- 需要新类型定义时，照着 `Mods/SODefines/Defines/<Type>/` 里的真实样例复制一份再改。');
  lines.push('');
  return `${lines.join('\n')}`;
}

/* ------------------------------------------------------------------ *
 * 10. scaffoldMod
 * ------------------------------------------------------------------ */

function hasAnyFile(dir) {
  try {
    return fs.readdirSync(dir).length > 0;
  } catch {
    return false;
  }
}

/**
 * 生成一个 Mod 包。
 * @param {string} destDir 目标父目录（生成物写在 destDir/<modName>/ 下）
 * @param {object} opts
 * @returns {Promise<{modRoot:string, created:string[], warnings:string[]}>}
 */
async function scaffoldMod(destDir, opts) {
  const o = opts && typeof opts === 'object' ? opts : {};
  const modName = normalizeModName(o.modName);

  // 每次生成都按这次给的路径/游戏目录重设派生缓存：同一进程连做两次生成
  // （selftest 就是这么干的）不能拿到上一次的知识库或 schema。
  knowledgePathOverride = o.knowledgePath ? path.resolve(String(o.knowledgePath)) : null;
  knowledgeCache = undefined;
  knowledgeCachePath = null;
  activeGameModsDir = resolveGameModsDir(o.gameModsDir);
  schemaCache.clear();

  if (destDir === undefined || destDir === null || String(destDir).trim() === '') {
    throw new Error('scaffoldMod: destDir is required');
  }
  const destRoot = path.resolve(String(destDir));

  const templateId = String(o.template || 'full');
  const template = TEMPLATES.find((t) => t.id === templateId);
  if (!template) {
    throw new Error(
      `scaffoldMod: unknown template "${templateId}" (available: ${TEMPLATES.map((t) => t.id).join(', ')})`,
    );
  }

  const overwrite = o.overwrite === true;
  const meta = {
    modName,
    version: typeof o.version === 'string' && o.version ? o.version : '1.0.0',
    gameVersion: typeof o.gameVersion === 'string' && o.gameVersion ? o.gameVersion : DEFAULT_GAME_VERSION,
    loadOrder: Number.isFinite(Number(o.loadOrder)) ? Number(o.loadOrder) : DEFAULT_LOAD_ORDER,
    author: typeof o.author === 'string' && o.author.trim() ? o.author.trim() : DEFAULT_AUTHOR,
    description:
      typeof o.description === 'string' && o.description.trim()
        ? o.description
        : `${modName} — 由 Infant God Mod IDE 脚手架生成的 Mod。`,
    template: template.id,
    templateNameZh: template.nameZh,
    overwrite,
    warnings: [],
  };
  if (o.baseLanguage === undefined || o.baseLanguage === null || String(o.baseLanguage).trim() === '') {
    meta.baseLanguage = DEFAULT_BASE_LANGUAGE;
  } else {
    meta.baseLanguage = String(o.baseLanguage).trim();
  }
  meta.locales = normalizeLocales(o.locales, meta.baseLanguage);
  meta.characters = normalizeCharacters(o.characters);

  // 没有知识库时把状态说出来：定义字段是占位、校验能力不可用（G6）。
  // 有知识库但这次没传角色表不算异常 —— 角色表本来就是空的。
  const kb = knowledge();
  if (meta.characters.length === 0 && !(kb && kb.schemas && Object.keys(kb.schemas).length > 0)) {
    meta.warnings.push(
      `没有可用的知识库（${knowledgePath()}）：定义字段与角色表都用占位，校验能力不可用。`,
    );
  }

  if (!meta.locales.includes(meta.baseLanguage)) {
    meta.warnings.push(
      `baseLanguage "${meta.baseLanguage}" 不在 locales 列表里，已把它插到最前面。`,
    );
  }

  const modRoot = path.join(destRoot, modName);

  if (!overwrite && hasAnyFile(modRoot)) {
    throw new Error(
      `scaffoldMod: target "${modRoot}" already exists and is not empty (pass { overwrite: true } to replace)`,
    );
  }

  /* ---- 1) 计算要写哪些文件（先算内容，便于 README 列出文件清单） ---- */

  const files = new Map(); // posix 相对路径 -> { content, kind }

  files.set('mod.json', { content: renderModJson(meta), kind: 'mod' });

  const wantsYarn = template.id === 'yarn-story' || template.id === 'full';
  const wantsDefines = template.id === 'define-pack' || template.id === 'full';
  const wantsSprites = template.id === 'full';

  let yarnText = null;
  let yarnFileName = null;
  if (wantsYarn) {
    yarnText = renderYarnStory({ modName, characters: meta.characters });
    yarnFileName = `Yarn/${safeFileName(modName)}_Story.yarn`;
    files.set(yarnFileName, { content: yarnText, kind: 'yarn' });
    files.set(`Yarn/${safeFileName(modName)}.yarnproject`, {
      content: renderYarnProject(meta),
      kind: 'yarnproject',
    });

    const parsed = yarnStoryToEntries(yarnText, yarnFileName, modName);
    if (parsed.errors.length) {
      meta.warnings.push(`生成的 Yarn 自检发现 ${parsed.errors.length} 处结构问题：${parsed.errors[0]}`);
    }
    const lineKeys = new Set();
    for (const e of parsed.entries) {
      if (!e.key) {
        meta.warnings.push(`Yarn 行缺少 #line: id（文件 ${yarnFileName}，第 ${e.lineNumber} 行）。`);
        continue;
      }
      if (lineKeys.has(e.key)) meta.warnings.push(`重复的 #line: id "${e.key}"。`);
      lineKeys.add(e.key);
    }

    for (const locale of meta.locales) {
      const entries = parsed.entries.map((e) => {
        const translation = locale === meta.baseLanguage ? undefined : e.text;
        return {
          key: e.key,
          text: e.text,
          translations: translation === undefined ? undefined : { [locale]: translation },
          state: e.state,
          node: e.node,
          lineNumber: e.lineNumber,
          file: yarnFileName,
        };
      });
      const csv = renderLocalisationCsv({
        baseLanguage: meta.baseLanguage,
        locales: [locale],
        entries,
      });
      files.set(`Yarn/${csvFileNameFor(modName, locale)}`, { content: csv, kind: 'csv' });
    }
  }

  const definePreview = [];
  const spriteRefs = new Set();
  if (wantsDefines) {
    for (const spec of defineSpecs(modName)) {
      const schema = loadSchema(spec.typeName);
      if (!schema) {
        meta.warnings.push(`找不到 ${spec.typeName} 的 schema，已用兜底字段生成定义。`);
      } else if (!schema.properties || !('techName' in schema.properties || 'TechName' in schema.properties)) {
        meta.warnings.push(`${spec.typeName} 的 schema 没有 techName/TechName 身份字段，已补 techName。`);
      }
      const obj = buildDefineObject(spec.typeName, spec.techName, spec.overrides);
      const rel = `Defines/${spec.typeName}/${spec.techName}.json`;
      definePreview.push(rel);
      files.set(rel, { content: `${JSON.stringify(obj, null, 2)}\n`, kind: 'define' });
      // 收集 define 里引用到的图片路径：必须真实落盘，否则校验器报 D006、
      // 游戏加载时 icon 也会是空白。
      for (const key of ['icon', 'image', 'portrait', 'emailPortrait', 'sprite']) {
        const v = obj[key];
        if (typeof v === 'string' && /\.(png|jpg|jpeg)$/i.test(v.trim())) spriteRefs.add(v.trim());
      }
    }
  }

  if (wantsSprites) {
    files.set('Sprites/README.md', { content: renderSpritesReadme(meta), kind: 'sprites' });
  }

  // 为每个被引用的图片写一张真实的占位 PNG（主题色圆环）。
  for (const rel of [...spriteRefs].sort()) {
    if (files.has(rel)) continue;
    files.set(rel, { content: makePlaceholderPng(64, PLACEHOLDER_RGB), kind: 'sprite', binary: true });
  }

  /* ---- 2) README（需要完整文件清单） ---- */
  const fileList = [...files.keys()].filter((p) => p !== 'README.md').sort();
  fileList.push('README.md');
  meta.fileList = fileList.sort();
  files.set('README.md', { content: renderReadme(meta), kind: 'readme' });

  /* ---- 3) 落盘 ---- */
  const dirs = new Set();
  for (const rel of files.keys()) {
    const dir = path.dirname(rel);
    if (dir && dir !== '.') dirs.add(dir);
  }
  await fsp.mkdir(modRoot, { recursive: true });
  for (const rel of [...dirs].sort()) {
    await fsp.mkdir(path.join(modRoot, rel), { recursive: true });
  }

  const created = [];
  for (const rel of [...files.keys()].sort()) {
    const abs = path.join(modRoot, rel);
    const entry = files.get(rel);
    if (entry.binary) {
      await fsp.writeFile(abs, entry.content); // Buffer：图片等二进制资源
    } else {
      // 统一 UTF-8 无 BOM、\n 换行。
      await fsp.writeFile(abs, String(entry.content).replace(/\r\n?/g, '\n'), { encoding: 'utf8' });
    }
    created.push(toPosix(rel));
  }

  created.sort();
  return { modRoot, created, warnings: meta.warnings };
}

/* ------------------------------------------------------------------ *
 * 11. 导出（签名严格保持）
 * ------------------------------------------------------------------ */

module.exports = {
  scaffoldMod,
  MOD_TEMPLATES,
  describeTemplates,
  renderYarnStory,
  renderLocalisationCsv,
};

// 便捷内部导出：定义成不可枚举属性，这样 Object.keys(module.exports)
// 得到的就是规格要求的 5 个公开 API，不会被这个测试辅助入口污染。
Object.defineProperty(module.exports, '__internal', {
  enumerable: false,
  configurable: true,
  writable: true,
  value: {
  SCAFFOLD_VERSION,
  KNOWN_LOCALES,
  LOCALE_FILE_SUFFIX,
  DEFAULT_LOAD_ORDER,
  DEFAULT_GAME_VERSION,
  DEFAULT_AUTHOR,
  DEFAULT_LOCALES,
  DEFAULT_BASE_LANGUAGE,
  parseYarnStory,
  yarnStoryToEntries,
  loadSchema,
  buildDefineObject,
  csvFileNameFor,
  csvField,
  normalizeLocales,
  safeFileName,
  createLineIdFactory,
  loadKnowledgeCharacters,
  },
});
