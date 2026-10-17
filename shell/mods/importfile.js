'use strict';
/**
 * importfile.js — G50 的另一半：把磁盘上已有的文件「导入」一个 Mod 包。
 *
 * 新建是「从 schema 生成」，导入是「把一个真实文件放进包里」；两者共用一条
 * 原则（docs/EDITOR_GAPS.md §18.2）：**编辑既有文件是字节保真**。导入因此
 * 必须逐字节复制 —— 不归一化 BOM、不把 CRLF 改成 LF、不重排 JSON、不重新编码
 * PNG。校验只读那份字节，只报告/拒绝，不改写。
 *
 *   planImport({ modRoot, from, to, name })
 *     -> { source, relPath, target, kind, warnings }      纯函数：不写盘
 *   importFile({ modRoot, from, to, name, overwrite, validateDefineText, diagnoseYarn })
 *     -> { path, file, kind, bytes, warnings, diagnostics }
 *
 * 目标目录由扩展名决定（`to` 给定时按 `to` 精确落位）：
 *   .yarn            -> Yarn/<name>.yarn
 *   .csv             -> Yarn/<name>.csv
 *   .png             -> Sprites/<name>.png
 *   .wav/.ogg/.mp3   -> Audio/<name>.<ext>
 *   .skel.bytes      -> Spine/<name>（.atlas.txt 同理）
 *   .json            -> 沿用源路径里的 Defines/<Type>/ 段：Defines/<Type>/<name>.json。
 *                       源路径没有这一段时拒绝并要 `to`：定义的目录**就是**它的
 *                       类型，猜类型等于写一个游戏加载不了的文件。
 *
 * 校验在拷贝之后做（文件已经落地），失败就把刚拷进来的那个文件删掉再抛错；
 * 消息统一 `import file: ` 前缀。
 *
 * 本文件是 CommonJS（仓库没有 package.json），只依赖 node:fs / node:path。
 * 内容校验器由门面注入（validateDefineText / diagnoseYarn 都是门面自己的闭包），
 * 这样这里不掺知识库细节，也不会和 index.js 互相 require。
 */
const fs = require('fs');
const path = require('path');
const { NAME_RE } = require('./newfile.js');

/** 导入上限：64 MiB（一个 Mod 资源文件的合理上限；超了通常是选错了文件）。 */
const MAX_IMPORT_BYTES = 64 * 1024 * 1024;

/** 本侧认识的扩展名（未知扩展名的拒绝消息里原样列出）。 */
const KNOWN_EXTENSIONS = ['.yarn', '.csv', '.png', '.json', '.wav', '.ogg', '.mp3', '.skel.bytes', '.atlas.txt'];

/** 统一错误：所有拒绝消息都以 `import file: ` 开头。 */
function failure(message) {
  return new Error('import file: ' + message);
}

function toPosix(p) {
  return String(p).split(path.sep).join('/');
}

/** 去掉 UTF-8 BOM（只用于 JSON.parse；写出去的是原始字节）。 */
function stripBom(text) {
  return text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
}

function formatMiB(bytes) {
  return (bytes / (1024 * 1024)).toFixed(1) + ' MiB';
}

/** 源文件的后缀分类。spine 的两段式后缀先匹配，避免被 extname 截成 ".bytes"。 */
function classifySource(source) {
  const base = path.basename(source);
  const lower = base.toLowerCase();
  if (lower.endsWith('.skel.bytes')) return { kind: 'spine', base: base, stem: base.slice(0, -'.skel.bytes'.length), ext: '.skel.bytes' };
  if (lower.endsWith('.atlas.txt')) return { kind: 'spine', base: base, stem: base.slice(0, -'.atlas.txt'.length), ext: '.atlas.txt' };
  const ext = path.extname(base).toLowerCase();
  switch (ext) {
    case '.yarn': return { kind: 'yarn', base: base, stem: path.basename(base, path.extname(base)), ext: ext };
    case '.csv': return { kind: 'translation', base: base, stem: path.basename(base, path.extname(base)), ext: ext };
    case '.png': return { kind: 'sprite', base: base, stem: path.basename(base, path.extname(base)), ext: ext };
    case '.wav':
    case '.ogg':
    case '.mp3': return { kind: 'audio', base: base, stem: path.basename(base, path.extname(base)), ext: ext };
    case '.json': return { kind: 'define', base: base, stem: path.basename(base, path.extname(base)), ext: ext };
    default:
      throw failure('unknown extension "' + (ext || '(none)') + '" for ' + base
        + '; this editor can import ' + KNOWN_EXTENSIONS.join(', '));
  }
}

/** 目标路径（`to`）合法化：包根相对的 POSIX 路径，拒绝绝对路径/盘符/`..`。 */
function normalizeTo(to) {
  let s = String(to);
  if (s.trim() === '') throw failure('to must not be empty');
  s = s.replace(/\\/g, '/');
  if (/^[A-Za-z]:/.test(s)) throw failure('to must be relative to the mod package, not a drive path: ' + to);
  if (s.startsWith('/')) throw failure('to must be relative to the mod package, not absolute: ' + to);
  if (s.includes(':')) throw failure('to must not contain ":": ' + to);
  if (s.endsWith('/')) throw failure('to must name a file, not a directory: ' + to);
  const parts = s.split('/');
  for (const part of parts) {
    if (part === '' || part === '.' || part === '..') {
      throw failure('to must stay inside the mod package (no ".." or empty segments): ' + to);
    }
  }
  return parts.join('/');
}

/** 从目标相对路径判断 kind（用 `to` 导入时以目标为准）。 */
function classifyTarget(relPath) {
  const lower = String(relPath).toLowerCase();
  if (lower.endsWith('.skel.bytes') || lower.endsWith('.atlas.txt')) return 'spine';
  const ext = path.posix.extname(lower);
  switch (ext) {
    case '.yarn': return 'yarn';
    case '.csv': return 'translation';
    case '.png': return 'sprite';
    case '.wav':
    case '.ogg':
    case '.mp3': return 'audio';
    case '.json': return 'define';
    default:
      throw failure('unknown extension "' + (ext || '(none)') + '" for ' + relPath
        + '; this editor can import ' + KNOWN_EXTENSIONS.join(', '));
  }
}

/** 在源的路径段里找 `Defines/<Type>/`：定义了目录就是它的类型，不猜。 */
function defineTypeOf(source) {
  const parts = toPosix(source).split('/');
  for (let i = 0; i + 1 < parts.length; i++) {
    if (parts[i].toLowerCase() !== 'defines') continue;
    const type = parts[i + 1];
    if (type === undefined) continue;
    if (i + 2 >= parts.length) continue; // Defines/<Type> 是目录，源必须是目录里的文件
    if (/^[A-Za-z_][A-Za-z0-9_]*$/.test(type)) return type;
  }
  return null;
}

/**
 * 纯规划：不写任何文件，只 stat 源文件、算出目标与语言级信息。
 * @param {{modRoot:string, from:string, to?:string, name?:string}} input
 * @returns {{source:string, relPath:string, target:string, kind:string, warnings:string[]}}
 */
function planImport(input) {
  const p = input && typeof input === 'object' ? input : {};
  if (p.modRoot == null || String(p.modRoot).trim() === '') throw failure('modRoot is required');
  if (p.from == null || String(p.from).trim() === '') throw failure('from is required');

  const modRoot = path.resolve(String(p.modRoot));
  const source = path.resolve(String(p.from));

  let stat;
  try {
    stat = fs.statSync(source);
  } catch (e) {
    if (e && e.code === 'ENOENT') throw failure('source does not exist: ' + String(p.from));
    throw failure('source cannot be read: ' + String(p.from));
  }
  if (!stat.isFile()) throw failure('source is not a regular file: ' + String(p.from));
  try {
    fs.accessSync(source, fs.constants.R_OK);
  } catch {
    throw failure('source is not readable: ' + String(p.from));
  }
  if (stat.size > MAX_IMPORT_BYTES) {
    throw failure('source is ' + formatMiB(stat.size) + ' and the import limit is 64 MiB: ' + String(p.from));
  }

  const info = classifySource(source);
  const hasTo = p.to != null && String(p.to).trim() !== '';
  let relPath;
  let kind;
  if (hasTo) {
    relPath = normalizeTo(p.to);
    kind = classifyTarget(relPath);
  } else {
    const explicitName = p.name != null && String(p.name).trim() !== '' ? String(p.name) : null;
    if (explicitName !== null && !NAME_RE.test(explicitName)) {
      throw failure('name "' + explicitName + '" is not valid: letters, digits and "_" only, starting with a letter or "_"');
    }
    const stem = explicitName !== null ? explicitName : info.stem;
    switch (info.kind) {
      case 'yarn': relPath = 'Yarn/' + stem + '.yarn'; kind = 'yarn'; break;
      case 'translation': relPath = 'Yarn/' + stem + '.csv'; kind = 'translation'; break;
      case 'sprite': relPath = 'Sprites/' + stem + '.png'; kind = 'sprite'; break;
      case 'audio': relPath = 'Audio/' + stem + info.ext; kind = 'audio'; break;
      case 'spine': relPath = 'Spine/' + (explicitName !== null ? explicitName : info.base); kind = 'spine'; break;
      case 'define': {
        const type = defineTypeOf(source);
        if (!type) {
          throw failure('cannot tell the define type from ' + String(p.from)
            + ': a .json must come from a Defines/<Type>/ directory, or be imported with to: "Defines/<Type>/<name>.json"');
        }
        relPath = 'Defines/' + type + '/' + stem + '.json';
        kind = 'define';
        break;
      }
      default: throw failure('unknown source kind for ' + String(p.from));
    }
  }

  const target = path.resolve(modRoot, relPath.split('/').join(path.sep));
  const rel = path.relative(modRoot, target);
  if (rel === '' || rel.startsWith('..') || path.isAbsolute(rel)) {
    throw failure('refusing to write outside the mod package: ' + relPath);
  }
  return { source: source, relPath: relPath, target: target, kind: kind, warnings: [] };
}

/** PNG：签名 + 至少一个 IHDR chunk（内容校验，只读）。 */
function assertPng(buf, relPath) {
  const signature = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  if (buf.length < 8 || buf.slice(0, 8).compare(signature) !== 0) {
    throw failure('not a PNG (wrong signature): ' + relPath);
  }
  if (buf.indexOf(Buffer.from('IHDR', 'ascii'), 12) < 0) {
    throw failure('not a PNG (no IHDR chunk): ' + relPath);
  }
}

/**
 * 导入：规划 -> 检查覆盖 -> 逐字节复制 -> 校验（失败删除刚拷贝的文件）。
 * @param {{modRoot:string, from:string, to?:string, name?:string, overwrite?:boolean,
 *          validateDefineText?:Function, diagnoseYarn?:Function}} input
 * @returns {{path:string, file:string, kind:string, bytes:number, warnings:string[], diagnostics:Array}}
 */
function importFile(input) {
  const p = input && typeof input === 'object' ? input : {};
  const plan = planImport(p);

  const existed = fs.existsSync(plan.target);
  if (existed && p.overwrite !== true) {
    throw failure(plan.relPath + ' already exists; pass overwrite: true to replace it');
  }

  let buf;
  try {
    buf = fs.readFileSync(plan.source);
  } catch {
    throw failure('source is not readable: ' + plan.source);
  }

  const warnings = Array.isArray(plan.warnings) ? plan.warnings.slice() : [];
  if (existed) warnings.push(plan.relPath + ' already existed and was replaced');

  fs.mkdirSync(path.dirname(plan.target), { recursive: true });
  fs.writeFileSync(plan.target, buf);

  const diagnostics = [];
  try {
    if (plan.kind === 'define') {
      const parts = plan.relPath.split('/');
      // 只有落在 Defines/<Type>/ 里的 .json 才谈得上「按类型校验」；`to` 把
      // JSON 放进别的目录时（比如一个非定义的附属文件）只查 JSON 合法性。
      const underDefines = parts.length > 2 && parts[0] === 'Defines';
      const type = underDefines ? parts[1] : '';
      let obj;
      try {
        obj = JSON.parse(stripBom(buf.toString('utf8')));
      } catch (e) {
        throw failure(plan.relPath + ' is not valid JSON: ' + String(e && e.message ? e.message : e));
      }
      if (typeof p.validateDefineText === 'function' && underDefines) {
        const verdict = p.validateDefineText({ type: type, text: buf.toString('utf8'), relPath: plan.relPath }) || {};
        const list = Array.isArray(verdict.diagnostics) ? verdict.diagnostics : [];
        const errors = list.filter((d) => d && d.severity === 'error');
        if (errors.length) {
          const first = errors[0];
          throw failure('the imported define does not validate: ' + String(first.message));
        }
        for (const d of list) {
          if (d && d.severity === 'warning') warnings.push(String(d.message));
        }
        diagnostics.push(...list);
      } else if (!underDefines) {
        warnings.push(plan.relPath + ' is not under Defines/<Type>/, so only its JSON syntax was checked');
      } else {
        warnings.push(plan.relPath + ' was not validated: no define validator available');
      }
    } else if (plan.kind === 'sprite') {
      assertPng(buf, plan.relPath);
    } else if (plan.kind === 'yarn') {
      if (typeof p.diagnoseYarn === 'function') {
        const result = p.diagnoseYarn({ text: buf.toString('utf8'), fileName: plan.relPath, root: plan.modRoot }) || {};
        const list = Array.isArray(result.diagnostics) ? result.diagnostics : [];
        const errors = list.filter((d) => d && d.severity === 'error');
        if (errors.length) {
          const first = errors[0];
          throw failure('the imported story has an error: ' + String(first.message));
        }
        for (const d of list) {
          if (d && d.severity === 'warning') warnings.push(String(d.message));
        }
        diagnostics.push(...list);
      } else {
        warnings.push(plan.relPath + ' was not diagnosed: no Yarn diagnoser available');
      }
    } else if (buf.length === 0) {
      warnings.push('the imported file is empty: ' + plan.relPath);
    }
  } catch (e) {
    // 已经落地的拷贝不能留下：一个校验不过的文件比没有更糟。
    try {
      fs.unlinkSync(plan.target);
    } catch {
      /* 删不掉就保持原错误；报告里说明即可 */
    }
    throw e;
  }

  return {
    path: plan.relPath,
    file: plan.target,
    kind: plan.kind,
    bytes: buf.length,
    warnings: warnings,
    diagnostics: diagnostics
  };
}

module.exports = {
  planImport,
  importFile,
  MAX_IMPORT_BYTES,
  KNOWN_EXTENSIONS
};
