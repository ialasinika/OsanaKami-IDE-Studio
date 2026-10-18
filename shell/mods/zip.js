'use strict';
/**
 * zip.js — G45：分发容器。游戏不认 zip，ModLoader 扫的是
 * `StreamingAssets/Mods/<Name>/` 目录，压缩包只是**传输形态**：作者导出、
 * 群友下载、解压进 `Mods/`。所以这里做的是「把一个包写成确定性的 zip」，
 * 不是「游戏能直接读的包」。
 *
 * 关键约束（docs/EDITOR_GAPS.md §18.4）：
 *   1. zip 内必须有一层 `<Name>/…`，解压到 `Mods/` 就得到 `Mods/<Name>/…`；
 *   2. 文件名 UTF-8 并置通用位 11（语料里已有乱码目录名，编码是真实痛点）；
 *   3. 固定排序 + 固定 mtime：同一个包两次导出逐字节一致，群里才能核对
 *      「我下的是不是同一个版本」；
 *   4. 零依赖：只借 `node:zlib` 的 `crc32` 与 `deflateRaw`，不引第三方库，
 *      也不用内核的 `file.read`（4 MiB 上限对 5 MiB 的 wav 不成立）。
 *
 * 本文件只**读**包目录、产出 Buffer；写盘与「先体检」在 index.js 的
 * `exportPackage` 里，本文件因此可以拿 Buffer 单测。
 *
 *   planExport({ modRoot, outFile })
 *     -> { name, files: [{ rel, abs, size }], skipped, bytes }
 *   zipEntries([{ name, data }])
 *     -> Buffer
 */

const fs = require('fs');
const path = require('path');
const zlib = require('zlib');

/** DOS 时间格式的 1980-01-01 00:00 —— zip 能表示的最早时刻，恒定值。 */
const DOS_TIME = 0;
const DOS_DATE = 0x21;

/** 通用标志位 11：文件名是 UTF-8。 */
const FLAG_UTF8 = 1 << 11;

/** 需要的解压版本 2.0（目录、deflate/store 都够）。 */
const VERSION = 20;

/** zip 的 32 位上限；Mod 包远够不到，但拒绝要比写出坏文件好。 */
const MAX_UINT32 = 0xffffffff;
const MAX_ENTRIES = 0xffff;

/**
 * 排除表（§18.4）：编辑器/浏览器的垃圾、构建产物、日志和版本库。
 * 只排除明确不该分发的，其余一律带上 —— 宁可多带一个文件，也不要静默
 * 漏掉游戏真会读的东西（`Audio/`、`UI/` 这类目录并不在 §18.4 的包含
 * 列表里，但语料里的包确实有）。
 */
const EXCLUDE = [
  /(^|\/)\.git(\/|$)/,
  /(^|\/)\.hg(\/|$)/,
  /(^|\/)\.svn(\/|$)/,
  /(^|\/)\.tmp[^/]*$/i,
  /\.code-workspace$/i,
  /(^|\/)(Thumbs\.db|\.DS_Store)$/i,
  /(^|\/)dist(\/|$)/i,
  /\.log$/i,
];

function toPosix(p) {
  return String(p).split(path.sep).join('/');
}

function failure(message) {
  return new Error('export zip: ' + message);
}

function isExcluded(rel) {
  return EXCLUDE.some((re) => re.test(rel));
}

/**
 * 枚举一个包里的文件，按 zip 内的名字排序。
 *
 * 只跟普通文件和符号链接的**目标**走一层：符号链接若在包外则跳过并报告，
 * 因为导出不应该把包外的文件带出去（与内核的 containment 同一个理由）。
 * `outFile` 若恰好落在包里（作者把 zip 导出到包内），从清单里剔除，免得
 * 第二次导出把上一次的 zip 装进去。
 */
function planExport(options) {
  const opts = options && typeof options === 'object' ? options : {};
  if (typeof opts.modRoot !== 'string' || opts.modRoot === '') throw failure('modRoot is required');
  const root = path.resolve(opts.modRoot);
  let rootStat;
  try {
    rootStat = fs.statSync(root);
  } catch {
    throw failure(root + ' does not exist');
  }
  if (!rootStat.isDirectory()) throw failure(root + ' is not a directory');
  if (!fs.existsSync(path.join(root, 'mod.json'))) throw failure(root + ' has no mod.json');

  const name = path.basename(root);
  const outFile = typeof opts.outFile === 'string' && opts.outFile !== '' ? path.resolve(opts.outFile) : null;

  const files = [];
  const skipped = [];
  const stack = [root];
  while (stack.length > 0) {
    const dir = stack.pop();
    let entries;
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch (err) {
      throw failure('cannot read ' + dir + ': ' + (err && err.message ? err.message : err));
    }
    entries.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
    for (const entry of entries) {
      const abs = path.join(dir, entry.name);
      const rel = toPosix(path.relative(root, abs));
      if (isExcluded(rel)) {
        skipped.push(rel);
        continue;
      }
      if (entry.isSymbolicLink()) {
        let target = null;
        try {
          target = fs.realpathSync(abs);
        } catch {
          target = null;
        }
        if (target === null || !target.startsWith(root + path.sep)) {
          skipped.push(rel + ' (symlink pointing out of the package)');
          continue;
        }
        const st = fs.statSync(target);
        if (!st.isFile()) {
          skipped.push(rel + ' (symlink to a directory)');
          continue;
        }
        files.push({ rel, abs: target, size: st.size });
        continue;
      }
      if (entry.isDirectory()) {
        stack.push(abs);
        continue;
      }
      if (!entry.isFile()) {
        skipped.push(rel);
        continue;
      }
      if (outFile !== null && path.resolve(abs) === outFile) {
        skipped.push(rel + ' (the archive itself)');
        continue;
      }
      const st = fs.statSync(abs);
      files.push({ rel, abs, size: st.size });
    }
  }

  files.sort((a, b) => (a.rel < b.rel ? -1 : a.rel > b.rel ? 1 : 0));
  if (files.length === 0) throw failure(root + ' has no files to export');
  if (files.length > MAX_ENTRIES) {
    throw failure('a zip holds at most ' + MAX_ENTRIES + ' entries; this package has ' + files.length);
  }
  let bytes = 0;
  for (const file of files) bytes += file.size;
  if (bytes > MAX_UINT32) throw failure('the package is larger than 4 GiB, which this writer does not support');
  return { name, files, skipped, bytes };
}

/* ------------------------------------------------------------------ */
/* the zip container                                                   */
/* ------------------------------------------------------------------ */

function u16(buf, offset, value) {
  buf.writeUInt16LE(value & 0xffff, offset);
}

function u32(buf, offset, value) {
  buf.writeUInt32LE(value >>> 0, offset);
}

function localHeader(entry, nameBuf, data) {
  const header = Buffer.alloc(30);
  u32(header, 0, 0x04034b50);
  u16(header, 4, VERSION);
  u16(header, 6, FLAG_UTF8);
  u16(header, 8, entry.method);
  u16(header, 10, DOS_TIME);
  u16(header, 12, DOS_DATE);
  u32(header, 14, entry.crc);
  u32(header, 18, entry.compressed.length);
  u32(header, 22, data.length);
  u16(header, 26, nameBuf.length);
  u16(header, 28, 0); /* extra field length */
  return header;
}

function centralHeader(entry, nameBuf, offset) {
  const header = Buffer.alloc(46);
  u32(header, 0, 0x02014b50);
  u16(header, 4, (3 << 8) | VERSION); /* made by: Unix, zip 2.0 */
  u16(header, 6, VERSION);
  u16(header, 8, FLAG_UTF8);
  u16(header, 10, entry.method);
  u16(header, 12, DOS_TIME);
  u16(header, 14, DOS_DATE);
  u32(header, 16, entry.crc);
  u32(header, 20, entry.compressed.length);
  u32(header, 24, entry.data.length);
  u16(header, 28, nameBuf.length);
  u16(header, 30, 0); /* extra */
  u16(header, 32, 0); /* comment */
  u16(header, 34, 0); /* disk start */
  u16(header, 36, 0); /* internal attributes */
  u32(header, 38, 0o100644 << 16); /* external attributes: regular file */
  u32(header, 42, offset);
  return header;
}

/**
 * 把 `[{ name, data: Buffer }]` 写成 zip 字节。
 *
 * 排序、时间、压缩级别都是常量，所以同一组输入两次调用得到同一份 Buffer；
 * 用 store（不压缩）还是 deflate 取决于哪个更小，但那是输入的确定函数，
 * 不是随机的。
 */
function zipEntries(entries) {
  if (!Array.isArray(entries) || entries.length === 0) throw failure('nothing to put in the zip');
  if (entries.length > MAX_ENTRIES) throw failure('a zip holds at most ' + MAX_ENTRIES + ' entries');

  const sorted = entries.slice().sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  const seen = new Set();
  let total = 0;
  for (const entry of sorted) {
    if (entry === null || typeof entry !== 'object') throw failure('an entry must be an object');
    if (typeof entry.name !== 'string' || entry.name === '') throw failure('an entry needs a name');
    if (!Buffer.isBuffer(entry.data)) throw failure(entry.name + ' needs a Buffer');
    if (entry.name.length > 0xffff) throw failure(entry.name + ' has a name longer than 65535 bytes');
    if (seen.has(entry.name)) throw failure('two entries are named ' + entry.name);
    seen.add(entry.name);
    total += entry.data.length;
  }
  if (total > MAX_UINT32) throw failure('the contents are larger than 4 GiB, which this writer does not support');

  const parts = [];
  const central = [];
  let offset = 0;
  for (const entry of sorted) {
    const nameBuf = Buffer.from(entry.name, 'utf8');
    const deflated = zlib.deflateRawSync(entry.data, { level: 9 });
    const useDeflate = deflated.length < entry.data.length;
    const compressed = useDeflate ? deflated : entry.data;
    const stored = {
      method: useDeflate ? 8 : 0,
      crc: zlib.crc32(entry.data) >>> 0,
      compressed,
      data: entry.data,
    };
    const local = localHeader(stored, nameBuf, entry.data);
    parts.push(local, nameBuf, compressed);
    central.push(centralHeader(stored, nameBuf, offset), nameBuf);
    offset += local.length + nameBuf.length + compressed.length;
    if (offset > MAX_UINT32) throw failure('the archive grew past 4 GiB, which this writer does not support');
  }

  const centralStart = offset;
  let centralSize = 0;
  for (const part of central) centralSize += part.length;
  const end = Buffer.alloc(22);
  u32(end, 0, 0x06054b50);
  u16(end, 4, 0); /* this disk */
  u16(end, 6, 0); /* disk with the central directory */
  u16(end, 8, sorted.length);
  u16(end, 10, sorted.length);
  u32(end, 12, centralSize);
  u32(end, 16, centralStart);
  u16(end, 20, 0); /* archive comment length */

  return Buffer.concat([...parts, ...central, end]);
}

module.exports = {
  planExport,
  zipEntries,
  EXCLUDE,
  DOS_TIME,
  DOS_DATE,
  FLAG_UTF8,
};
