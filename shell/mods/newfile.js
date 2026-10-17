'use strict';
/**
 * newfile.js — G50 后端：在一个已有的 Mod 包里「按类型新建一个文件」。
 *
 * 门面（shell/mods/index.js 的 newFile）负责路径解析、找包根、挑 schema；
 * 本模块只做两件纯事：
 *
 *   planNewFile({ type, name, schema })  -> { relPath, text?|bytes?, kind }
 *   writeNewFile({ modRoot, type, name, schema, overwrite })
 *                                        -> { path, file, kind, bytes, warnings }
 *
 * 生成规则（契约，别改）：
 *   - schema 类型（knowledge().schemas 的 51 个键之一）：
 *       Defines/<Type>/<name>.json
 *     内容 = schema.required 里每个字段的默认值，pretty JSON（2 空格）+ 末尾换行：
 *       string -> ""（身份字段 techName/TechName 例外，取 name）
 *       integer/number -> 0、boolean -> false、array -> []、object -> {}
 *     文件名必须等于身份字段（文件名即 techName），所以 name 受
 *     /^[A-Za-z_][A-Za-z0-9_]*$/ 约束；Defines/<Type>/ 的位置由 validate.js 的
 *     M006 强制。
 *   - yarn：       Yarn/<name>.yarn，带仓库自己的 story 头（title/when/---/===）。
 *   - translation：Yarn/<name>.csv，BOM + CRLF，8 列表头，无数据行。
 *   - sprite：     Sprites/<name>.png，96×96 的真 PNG（RGBA，主题色圆环）。
 *   - spine / audio：拒绝，并说出需要什么工具 —— UI 在写盘前就能给人看。
 *   - 其它未知类型：拒绝。
 *
 * 生成是确定性的：文件里没有时间戳、没有随机数（Yarn 的 #line: id 由 name 派生）。
 * 本模块不校验生成结果（校验需要知识库，在门面的 newFile 一侧做/由测试覆盖）。
 *
 * 本文件是 CommonJS（仓库没有 package.json），只依赖 node:fs / node:path /
 * node:zlib（PNG 的 deflate，和 scaffold.js 的占位图画法相同）。
 */
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');

/** schema 类型的文件名 = techName：只允许标识符。 */
const NAME_RE = /^[A-Za-z_][A-Za-z0-9_]*$/;

/** 生成不出来时的错误：消息统一带 `new file: ` 前缀（dispatch 直接当错误帧给人看）。 */
function failure(message) {
  return new Error('new file: ' + message);
}

/* ------------------------------------------------------------------ *
 * 1. PNG：96×96 的占位图（算法照 scaffold.js 的 makePlaceholderPng）
 * ------------------------------------------------------------------ */

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

/** 96×96 RGBA 占位图：浅底 + 主题色圆环，边缘透明（和脚手架生成的图标同款）。 */
const SPRITE_SIZE = 96;
const SPRITE_RGB = [0x7c, 0x4e, 0xc1];

function makeSpritePng() {
  const n = SPRITE_SIZE;
  const c = SPRITE_RGB;
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
      raw[o] = Math.round(c[0] * (on >= 1 ? 0.35 : 1));
      raw[o + 1] = Math.round(c[1] * (on >= 1 ? 0.35 : 1));
      raw[o + 2] = Math.round(c[2] * (on >= 1 ? 0.35 : 1));
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

/* ------------------------------------------------------------------ *
 * 2. schema 默认值 / Yarn 文本
 * ------------------------------------------------------------------ */

/** 属性 schema 的主类型（type 可以是数组，取第一个）。 */
function propertyType(prop) {
  const t = prop && typeof prop === 'object' ? prop.type : null;
  if (Array.isArray(t)) return typeof t[0] === 'string' ? t[0] : '';
  return typeof t === 'string' ? t : '';
}

/**
 * 一个 required 字段的默认值。
 * 身份字段（大小写不敏感的 techName）永远取 name —— 文件名即 techName。
 */
function defaultValueFor(name, prop, propertyName) {
  if (propertyName && String(propertyName).toLowerCase() === 'techname') return name;
  const p = prop && typeof prop === 'object' ? prop : {};
  if (p.const !== undefined) return p.const;
  const type = propertyType(p);
  if (Array.isArray(p.enum) && p.enum.length && type !== 'array') return p.enum[0];
  switch (type) {
    case 'integer':
    case 'number':
      return 0;
    case 'boolean':
      return false;
    case 'array':
      return [];
    case 'object':
      return {};
    case 'null':
      return null;
    case 'string':
    default:
      return '';
  }
}

/** schema 的 required 列表（调用方也可以单独给 required，用于兼容旧夹具）。 */
function requiredListOf(schema, required) {
  if (Array.isArray(required)) return required.slice();
  if (schema && Array.isArray(schema.required)) return schema.required.slice();
  return [];
}

/** 生成 define 对象：只放 required 字段（契约要求「恰好是 required 键」）。 */
function defineObjectFor(name, schema, required) {
  const props = schema && schema.properties && typeof schema.properties === 'object'
    ? schema.properties
    : {};
  const out = {};
  for (const key of requiredListOf(schema, required)) {
    out[key] = defaultValueFor(name, props[key], key);
  }
  return out;
}

/** Yarn 的 #line: id 由 name 派生（FNV-1a 32 位）：确定性且像语料里的 7~8 位十六进制。 */
function lineIdFor(name) {
  let h = 0x811c9dc5;
  const s = String(name);
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h.toString(16).padStart(8, '0');
}

/** 一份最小的合法 Yarn story：一个开始节点，一句台词，一个 -> END。 */
function yarnStoryFor(name) {
  return [
    'title: ' + name,
    'when: always',
    '---',
    'Narrator: ' + name + ' starts here. #line:' + lineIdFor(name),
    '-> END',
    '===',
    '',
  ].join('\n');
}

/** 本地化 CSV 的真实 8 列表头（文档里的 4 列说法已过时）。 */
const TRANSLATION_HEADER = 'language,id,text,file,node,lineNumber,lock,comment';

function translationCsvFor() {
  return '\ufeff' + TRANSLATION_HEADER + '\r\n';
}

/* ------------------------------------------------------------------ *
 * 3. 伪类型：拒绝时要说出需要的工具
 * ------------------------------------------------------------------ */

const REFUSALS = {
  spine: 'a .spell rig needs Spine (or a rig exported from it); this editor cannot author one',
  audio: 'audio needs a recording or a synthesiser; this editor cannot author a sound file',
};

/* ------------------------------------------------------------------ *
 * 4. planNewFile / writeNewFile
 * ------------------------------------------------------------------ */

/** name 校验：schema 类型必须是标识符；其它类型只要不是路径。 */
function assertName(name, strict) {
  const s = String(name);
  if (s === '' || s.trim() !== s) throw failure('name must not be empty or padded with spaces');
  if (strict) {
    if (!NAME_RE.test(s)) {
      throw failure('name "' + s + '" is not a valid techName: letters, digits and "_" only, starting with a letter or "_"');
    }
    return s;
  }
  if (/[\\/]/.test(s) || s === '.' || s === '..') {
    throw failure('name "' + s + '" must not contain a path separator');
  }
  return s;
}

/**
 * 纯规划器：不发任何文件系统调用。
 * @param {{type:string, name:string, schema?:object, required?:string[], properties?:object}} input
 * @returns {{relPath:string, text?:string, bytes?:Buffer, kind:string}}
 */
function planNewFile(input) {
  const p = input && typeof input === 'object' ? input : {};
  const type = p.type == null ? '' : String(p.type);
  const rawName = p.name == null ? '' : String(p.name);

  if (type === 'yarn') {
    const name = assertName(rawName, false);
    return { relPath: 'Yarn/' + name + '.yarn', text: yarnStoryFor(name), kind: 'yarn' };
  }
  if (type === 'translation') {
    const name = assertName(rawName, false);
    return { relPath: 'Yarn/' + name + '.csv', text: translationCsvFor(), kind: 'translation' };
  }
  if (type === 'sprite') {
    const name = assertName(rawName, false);
    return { relPath: 'Sprites/' + name + '.png', bytes: makeSpritePng(), kind: 'sprite' };
  }
  if (Object.prototype.hasOwnProperty.call(REFUSALS, type)) {
    throw failure(REFUSALS[type]);
  }

  const schema = p.schema && typeof p.schema === 'object' ? p.schema : null;
  if (!schema) throw failure('unknown type "' + type + '"');

  const name = assertName(rawName, true);
  const obj = defineObjectFor(name, schema, p.required);
  return {
    relPath: 'Defines/' + type + '/' + name + '.json',
    text: JSON.stringify(obj, null, 2) + '\n',
    kind: 'define',
  };
}

/**
 * 把规划结果写进包里。
 * @param {{modRoot:string, type:string, name:string, schema?:object, overwrite?:boolean}} input
 * @returns {{path:string, file:string, kind:string, bytes:number, warnings:string[]}}
 */
function writeNewFile(input) {
  const p = input && typeof input === 'object' ? input : {};
  if (p.modRoot == null || String(p.modRoot).trim() === '') throw failure('modRoot is required');

  const plan = planNewFile(p);
  const modRoot = path.resolve(String(p.modRoot));
  const file = path.resolve(modRoot, plan.relPath.split('/').join(path.sep));
  const rel = path.relative(modRoot, file);
  if (rel === '' || rel.startsWith('..') || path.isAbsolute(rel)) {
    throw failure('refusing to write outside the mod package: ' + plan.relPath);
  }

  if (fs.existsSync(file) && p.overwrite !== true) {
    throw failure(plan.relPath + ' already exists; pass overwrite: true to replace it');
  }

  const data = Buffer.isBuffer(plan.bytes) ? plan.bytes : Buffer.from(String(plan.text == null ? '' : plan.text), 'utf8');
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, data);

  return {
    path: plan.relPath,
    file: file,
    kind: plan.kind,
    bytes: data.length,
    warnings: [],
  };
}

module.exports = {
  planNewFile,
  writeNewFile,
  // 供测试/门面复用（不是公开契约的一部分，但确定性要求它们可被钉住）
  NAME_RE,
  TRANSLATION_HEADER,
  SPRITE_SIZE,
  REFUSALS,
  makeSpritePng,
  yarnStoryFor,
  lineIdFor,
};
