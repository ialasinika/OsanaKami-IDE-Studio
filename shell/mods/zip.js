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

/* ------------------------------------------------------------------ */
/* 读回一个 zip（导入用）                                              */
/* ------------------------------------------------------------------ */

/*
 * 导入是导出的反方向，但敌人完全不同：导出面对的是本机目录树，导入面对的是
 * 别人发来的字节。于是读侧把能查的都查了——EOCD 定位、中央目录边界、本地头与
 * 中央目录一致、CRC、解压后长度、名字越界（`..`、绝对路径、盘符、反斜杠、
 * NUL）——错一处就整包拒绝，而不是把半包写进 Mods/。
 *
 * 只支持「单盘、无加密、无 data descriptor、store/deflate」这个交集：这些是
 * Mod 群里互相传的 zip 的常态。中文名按 UTF-8 优先、GBK 兜底（Windows 自带
 * 压缩工具历史上就是这么写的）。
 */

/** 一个 Mod 包不可能有这么多文件；超过就是拿错了 zip 或者恶意的。 */
const READ_MAX_ENTRIES = 20000;
/** 单个文件解压后上限：Mod 里的音频/字体也远不到这个量。 */
const READ_MAX_ENTRY_BYTES = 64 * 1024 * 1024;
/** 整包解压后上限。 */
const READ_MAX_TOTAL_BYTES = 512 * 1024 * 1024;
/** 名字上限：Windows 的长路径也在这个量级以内。 */
const READ_MAX_NAME = 1024;

function broken(message) {
  return new Error('zip: ' + message);
}

function decodeName(bytes, utf8Flag) {
  if (utf8Flag) return bytes.toString('utf8');
  // 没有 UTF-8 标志位时，先按严格 UTF-8 试；不是再按 GBK（中文 Windows 的
  // 压缩工具会把 GBK 字节原样写进来）；还不行就 latin1 兜底，至少不抛。
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } catch {
    /* fall through */
  }
  try {
    return new TextDecoder('gbk').decode(bytes);
  } catch {
    return bytes.toString('latin1');
  }
}

/**
 * 把一个条目的名字归一成安全的相对路径；不安全就抛。
 * 反斜杠归成 `/`（少数 Windows 工具这么写），拒绝绝对路径、盘符、NUL 和 `..`。
 */
function safeEntryName(raw) {
  const name = String(raw).replace(/\\/g, '/');
  if (name === '') throw broken('an entry has an empty name');
  if (name.length > READ_MAX_NAME) throw broken('an entry name is longer than ' + READ_MAX_NAME + ' characters');
  if (name.indexOf('\u0000') !== -1) throw broken('an entry name contains a NUL byte');
  if (name.startsWith('/')) throw broken('an entry is an absolute path: ' + name);
  if (/^[A-Za-z]:/.test(name)) throw broken('an entry names a drive: ' + name);
  const parts = name.split('/').filter((part) => part !== '');
  for (const part of parts) {
    if (part === '.' || part === '..') throw broken('an entry points outside the archive: ' + name);
  }
  return parts.join('/');
}

/**
 * 读回一个 zip：`Buffer -> { entries: [{ name, data }], bytes }`。
 *
 * 目录条目、空目录不返回（Mod 包不靠空目录表达任何东西）；压缩方式只认
 * store(0) 和 deflate(8)；加密条目、data descriptor、多盘、zip64 一律拒绝，
 * 并说清楚是哪一条。
 */
function readZip(buffer) {
  if (!Buffer.isBuffer(buffer)) throw broken('expected a Buffer');
  if (buffer.length < 22) throw broken('too short to be a zip archive');

  // EOCD 在文件尾，注释最多 64 KiB；从后往前找，并核对注释长度正好到文件尾。
  let eocd = -1;
  const stop = Math.max(0, buffer.length - 22 - 0xffff);
  for (let at = buffer.length - 22; at >= stop; at--) {
    if (buffer.readUInt32LE(at) !== 0x06054b50) continue;
    const commentLen = buffer.readUInt16LE(at + 20);
    if (at + 22 + commentLen === buffer.length) {
      eocd = at;
      break;
    }
  }
  if (eocd === -1) throw broken('no end-of-central-directory record (not a zip, or truncated)');

  const disk = buffer.readUInt16LE(eocd + 4);
  const centralDisk = buffer.readUInt16LE(eocd + 6);
  const countOnDisk = buffer.readUInt16LE(eocd + 8);
  const count = buffer.readUInt16LE(eocd + 10);
  const centralSize = buffer.readUInt32LE(eocd + 12);
  const centralOffset = buffer.readUInt32LE(eocd + 16);
  if (disk !== 0 || centralDisk !== 0 || countOnDisk !== count) {
    throw broken('multi-disk archives are not supported');
  }
  if (count === 0xffff || centralOffset === 0xffffffff || centralSize === 0xffffffff) {
    throw broken('zip64 archives are not supported');
  }
  if (count > READ_MAX_ENTRIES) {
    throw broken('the archive holds ' + count + ' entries; the import limit is ' + READ_MAX_ENTRIES);
  }
  if (centralOffset + centralSize > eocd) throw broken('the central directory runs past the archive');

  const entries = [];
  const seen = new Set();
  let total = 0;
  let at = centralOffset;
  for (let index = 0; index < count; index++) {
    if (at + 46 > eocd) throw broken('central directory entry ' + index + ' is cut off');
    if (buffer.readUInt32LE(at) !== 0x02014b50) throw broken('bad central directory signature at entry ' + index);
    const flags = buffer.readUInt16LE(at + 8);
    const method = buffer.readUInt16LE(at + 10);
    const crc = buffer.readUInt32LE(at + 16);
    const compressedSize = buffer.readUInt32LE(at + 20);
    const size = buffer.readUInt32LE(at + 24);
    const nameLen = buffer.readUInt16LE(at + 28);
    const extraLen = buffer.readUInt16LE(at + 30);
    const commentLen = buffer.readUInt16LE(at + 32);
    const localOffset = buffer.readUInt32LE(at + 42);
    const next = at + 46 + nameLen + extraLen + commentLen;
    if (next > eocd) throw broken('central directory entry ' + index + ' runs past the directory');
    const rawName = decodeName(buffer.subarray(at + 46, at + 46 + nameLen), (flags & FLAG_UTF8) !== 0);
    at = next;

    if ((flags & 0x0001) !== 0) throw broken('encrypted archives are not supported');
    if ((flags & 0x0008) !== 0) throw broken('streamed entries (with a data descriptor) are not supported');
    if (method !== 0 && method !== 8) throw broken('unsupported compression method ' + method + ' on ' + rawName);
    if (size > READ_MAX_ENTRY_BYTES) {
      throw broken(rawName + ' is ' + size + ' bytes; the import limit per file is ' + READ_MAX_ENTRY_BYTES);
    }

    let name;
    try {
      name = safeEntryName(rawName);
    } catch (err) {
      throw broken(err.message.replace(/^zip: /, ''));
    }
    // 目录条目：名字以 / 结尾、长度为 0；Mod 包不需要它们。
    if (/\/$/.test(name) || (size === 0 && method === 0 && /\/$/.test(rawName))) continue;
    if (name === '') continue;
    if (seen.has(name)) throw broken('two entries are named ' + name);
    seen.add(name);

    if (localOffset + 30 > buffer.length) throw broken(name + ' points past the archive');
    if (buffer.readUInt32LE(localOffset) !== 0x04034b50) throw broken(name + ' has no local header');
    const localFlags = buffer.readUInt16LE(localOffset + 6);
    const localMethod = buffer.readUInt16LE(localOffset + 8);
    if ((localFlags & 0x0008) !== 0) throw broken('streamed entries (with a data descriptor) are not supported');
    if (localMethod !== method) throw broken(name + ' disagrees with its central directory entry');
    const localNameLen = buffer.readUInt16LE(localOffset + 26);
    const localExtraLen = buffer.readUInt16LE(localOffset + 28);
    const dataStart = localOffset + 30 + localNameLen + localExtraLen;
    const dataEnd = dataStart + compressedSize;
    if (dataEnd > buffer.length) throw broken(name + ' runs past the archive');

    const raw = buffer.subarray(dataStart, dataEnd);
    let data;
    if (method === 0) {
      data = Buffer.from(raw);
    } else {
      try {
        data = zlib.inflateRawSync(raw, { maxOutputLength: Math.max(1, size + 1) });
      } catch (err) {
        throw broken(name + ' does not inflate: ' + (err && err.message ? err.message : String(err)));
      }
    }
    if (data.length !== size) throw broken(name + ' inflates to ' + data.length + ' bytes, the directory says ' + size);
    if ((zlib.crc32(data) >>> 0) !== crc) throw broken(name + ' fails its CRC check (the download is damaged)');

    total += data.length;
    if (total > READ_MAX_TOTAL_BYTES) {
      throw broken('the archive unpacks to more than ' + READ_MAX_TOTAL_BYTES + ' bytes');
    }
    entries.push({ name, data });
  }

  if (entries.length === 0) throw broken('the archive holds no files');
  entries.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  return { entries, bytes: total };
}

module.exports = {
  planExport,
  zipEntries,
  readZip,
  safeEntryName,
  EXCLUDE,
  DOS_TIME,
  DOS_DATE,
  FLAG_UTF8,
  READ_MAX_ENTRIES,
  READ_MAX_ENTRY_BYTES,
  READ_MAX_TOTAL_BYTES,
};
