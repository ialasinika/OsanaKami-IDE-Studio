'use strict';

/**
 * yarn.js — Yarn Spinner 脚本解析器 + 诊断引擎
 *
 * 纯函数模块，无任何外部依赖，仅使用 Node 内置能力（本文件甚至不需要 require 任何东西）。
 * 面向《幼神》(Infant God) 游戏 Mod 开发 IDE：解析游戏本体 211 个 .yarn / 968+ 节点所用的
 * Yarn Spinner 语法子集，并产出一份「无噪音」的诊断列表。
 *
 * 公开 API（严格保持签名）：
 *   parseYarn(text, opts) -> { nodes, errors }
 *   diagnose(text, ctx)   -> Diagnostic[]
 *   listNodes(text)       -> [{ title, tags, line }]
 *   NODE_BUILTINS         -> 内建指令名（数组，同时带 .has() 方法）
 *
 * ---------------------------------------------------------------------------
 * 实现约定 / 语法现实（来自对真实语料的实测，务必保留）：
 *
 * 1. 节点 = 头部键值行 + `---` + 正文 + `===`。
 *    title/tags/subtitle/tracking 从头部取；正文只在 `---` 与 `===` 之间。
 *
 * 2. `<<if>>` / `<<once>>` 有两种形态，绝对不能混：
 *      - **行首形态**（该行第一个非空白内容就是 `<<...>>`）= 块开始，需要配对的
 *        `<<endif>>` / `<<endonce>>`。实测：677 个行首 if 对 677 个 endif，
 *        98 个行首 once 对 98 个 endonce —— 完全平衡。
 *      - **行内形态**（前面已经有文本 / `->` 选项标记）= 行条件，**不需要**配对。
 *        实测：978 个行内 if（对话行条件）、594 个行内 once（`-> 选项 <<once>>`）。
 *    因此块的配对状态机只使用「行首」的 if / once；endif / endonce / else / elseif
 *    一律视为块结构（语料中它们从不行内出现）。
 *
 *    重要修正（真实语料逼出来的）：`once` **自己就能带一个 `<<else>>` 子句**，
 *    不需要外层 `if`。Yarn Spinner 的 once_statement 语法是
 *    `'once' if_clause? statement* else_clause? 'endonce'`，即
 *    `<<once>>` / `<<once if $x>>` … `<<else>>` … `<<endonce>>` 都合法，
 *    且 once 块能嵌在 if 块里、两层 else 同时存在。语料实证：
 *      Hachimide_WeAsk.yarn:482 `<<once>>` → :504 `<<else>>` → :510 `<<endonce>>`；
 *      Greta_2_WeAsk.yarn:59 `<<once if $x>>` → :66 `<<else>>` → :68 `<<endonce>>`；
 *      Greenguard_Atk.yarn 外层 if 里嵌 once（:68 else / :72 endonce），
 *      之后 :73 `<<else>>` 属于外层 if、:76 `<<endif>>`。
 *    所以 if 与 once 共用同一个栈，`else` / `elseif` 匹配最近的**条件块**；
 *    `elseif` 不是 once 语法的一部分（只有带 if 子句的 once 才接受它）。
 *
 * 3. 对话行 `说话人: 文本`（冒号后可有可无空格），可带若干 `#key` / `#key:value` 元数据。
 *    元数据 tag 不要求前面有空白（真实语料存在 `...>=1>>#Kitsch #line:xxx`）。
 *
 * 4. `->` 与 `=>` 都产出 option：`->` 是普通选项，`=>` 在真实语料中总带
 *    `<<if 条件>>` 与 `#line:`，语义上就是「带条件的选项」（如 `=>Aistalt: 文本 #line:x`）。
 *
 * 5. `//` 注释：只在引号外生效；整行注释与行尾注释都会被剥离，
 *    因此注释里的 `<<指令>>` 不会进入 commands。
 *
 * 6. Y105 未知函数检查会放行 Yarn 内建函数（visited / visited_count / dice ...）
 *    与表达式关键字（and / or / not / if ...），否则真实语料会炸出 400+ 条噪音。
 */

/* ========================================================================== *
 * 内建指令
 * ========================================================================== */

const NODE_BUILTINS = [
  'if', 'elseif', 'else', 'endif',
  'set', 'declare', 'jump', 'detour', 'return',
  'once', 'endonce', 'stop', 'wait', 'call', 'show',
];
const _BUILTIN_SET = new Set(NODE_BUILTINS);

// 同时支持 NODE_BUILTINS.has('if') 与 NODE_BUILTINS.includes('if')。
// 定义为不可枚举属性：deepStrictEqual / JSON.stringify / 展开运算符 都视其为普通数组。
Object.defineProperty(NODE_BUILTINS, 'has', {
  value: function (name) { return _BUILTIN_SET.has(name); },
  enumerable: false, configurable: true, writable: true,
});

// Yarn Spinner 自带的表达式函数：即使 ctx.functions 里没有，也不能算「未知函数」。
const YARN_FUNCTIONS = new Set([
  'visited', 'visited_count', 'visitedCount', 'visitCount',
  'dice', 'random', 'random_range', 'randomRange',
  'round', 'roundTo', 'floor', 'ceil', 'abs', 'min', 'max', 'pow', 'sqrt', 'clamp',
  'plural', 'ordinal', 'format', 'string', 'number', 'bool', 'int', 'float', 'length',
]);

// 永远不会是函数调用的标识符。
const EXPR_KEYWORDS = new Set([
  'if', 'elseif', 'else', 'endif', 'end', 'and', 'or', 'not', 'xor',
  'as', 'is', 'in', 'to', 'true', 'false', 'null', 'then', 'while', 'do',
]);

/* ========================================================================== *
 * 基础工具
 * ========================================================================== */

function splitLines(text) {
  const lines = String(text == null ? '' : text).split(/\r?\n/);
  if (lines.length && lines[0].charCodeAt(0) === 0xfeff) {
    // 保留长度，避免第 1 行列号偏移
    lines[0] = ' ' + lines[0].slice(1);
  }
  return lines;
}

/** 最后一行「内容行」的 1-based 行号（忽略文件末尾的空行）。 */
function lastContentLine(lines) {
  let last = lines.length;
  while (last > 1 && lines[last - 1].trim() === '') last--;
  return last;
}

/** 剥离 `//` 行尾注释；引号内的 `//` 保留。 */
function stripComment(line) {
  let inS = false, inD = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (inS) { if (ch === '\\') i++; else if (ch === "'") inS = false; continue; }
    if (inD) { if (ch === '\\') i++; else if (ch === '"') inD = false; continue; }
    if (ch === "'") { inS = true; continue; }
    if (ch === '"') { inD = true; continue; }
    if (ch === '/' && line[i + 1] === '/') return line.slice(0, i);
  }
  return line;
}

/** 找到与 code[from-2..] 对应的 `>>`，跳过引号内的 `>>`。失败返回 -1。 */
function findDirectiveEnd(code, from) {
  let inS = false, inD = false;
  for (let i = from; i < code.length - 1; i++) {
    const ch = code[i];
    if (inS) { if (ch === '\\') i++; else if (ch === "'") inS = false; continue; }
    if (inD) { if (ch === '\\') i++; else if (ch === '"') inD = false; continue; }
    if (ch === "'") { inS = true; continue; }
    if (ch === '"') { inD = true; continue; }
    if (ch === '>' && code[i + 1] === '>') return i;
  }
  return -1;
}

/**
 * 统计实参个数：只在引号外、括号深度 0 处按空白切分。
 * `<<show "hello world">>` -> 1；`<<set $LineCount += 1>>` -> 3；`<<f(a, b)>>` -> 1。
 */
function countArgs(args) {
  if (!args) return 0;
  let n = 0, inTok = false, depth = 0, inS = false, inD = false;
  for (let i = 0; i < args.length; i++) {
    const ch = args[i];
    if (inS) { if (ch === '\\') i++; else if (ch === "'") inS = false; continue; }
    if (inD) { if (ch === '\\') i++; else if (ch === '"') inD = false; continue; }
    if (ch === "'") { if (!inTok) { inTok = true; n++; } inS = true; continue; }
    if (ch === '"') { if (!inTok) { inTok = true; n++; } inD = true; continue; }
    if (ch === '(' || ch === '[' || ch === '{') { if (!inTok) { inTok = true; n++; } depth++; continue; }
    if (ch === ')' || ch === ']' || ch === '}') { if (depth > 0) depth--; continue; }
    if (ch === ' ' || ch === '\t') { if (depth === 0) inTok = false; continue; }
    if (!inTok) { inTok = true; n++; }
  }
  return n;
}

/** args 的第一个 token（去引号），用于 jump / detour 目标。 */
function firstToken(args) {
  const m = /^\s*(\S+)/.exec(args || '');
  if (!m) return '';
  return m[1].replace(/^["']|["']$/g, '');
}

/** 扫描一行里的所有 `<<...>>`。返回的每一项都带绝对列号与 leading（是否行首）标记。 */
function scanDirectives(code, lineNo) {
  const out = [];
  let i = 0;
  while (i < code.length) {
    const open = code.indexOf('<<', i);
    if (open < 0) break;
    const close = findDirectiveEnd(code, open + 2);
    const closed = close >= 0;
    const inner = closed ? code.slice(open + 2, close) : code.slice(open + 2);
    const end = closed ? close + 2 : code.length;
    const nm = /[A-Za-z_][A-Za-z0-9_]*/.exec(inner);
    if (nm) {
      const name = nm[0];
      const nameStart = open + 2 + nm.index;
      const rawArgs = inner.slice(nm.index + name.length);
      const args = rawArgs.trim();
      out.push({
        name, args, argc: countArgs(args),
        line: lineNo, col: nameStart + 1,
        leading: code.slice(0, open).trim() === '',
        closed,
        start: open, end,
        nameStart, nameEnd: nameStart + name.length,
        vars: scanVars(code.slice(open, end), open),
      });
    }
    i = end > open ? end : open + 2;
  }
  return out;
}

/** 扫描一段文本里的 `$Var`，返回绝对列号（1-based）。 */
function scanVars(text, base) {
  const out = [];
  const re = /\$([A-Za-z_][A-Za-z0-9_]*)/g;
  let m;
  while ((m = re.exec(text))) out.push({ name: m[1], col: base + m.index + 1 });
  return out;
}

/**
 * 抽取 `#key` / `#key:value` 元数据。
 * 不要求 `#` 前面有空白；`#` 前面也不能是单词字符（避免把 C# 之类当 tag），
 * **但紧贴上一个 tag 的 `#` 例外** —— 真实语料存在两个 tag 直接相连的写法：
 *   Masturbator_1.yarn:197 `#Empathy#line:08eac3c #state:Complex`
 * 这里必须把 `#line:` 也识别出来，否则会误报 Y103「缺少 #line:」。
 */
function extractTags(str) {
  const spans = [];
  const list = [];
  const entries = [];
  let id = null, idCol = null;
  let lastTagEnd = -1;
  const re = /#([A-Za-z_][A-Za-z0-9_]*)(?::([^\s#]+))?/g;
  let m;
  while ((m = re.exec(str))) {
    const hashAt = m.index;
    const prev = hashAt > 0 ? str.charAt(hashAt - 1) : '';
    // 前面是单词字符、且又不是紧贴上一个 tag（`#A#B`）时，判定为 C# 之类的普通文本
    if (prev && /[A-Za-z0-9_]/.test(prev) && hashAt !== lastTagEnd) continue;
    const key = m[1];
    const value = m[2] === undefined ? null : m[2];
    spans.push({ start: hashAt, end: re.lastIndex });
    const raw = value === null ? key : key + ':' + value;
    list.push(raw);
    entries.push({ key, value, line: 0, col: hashAt + 1 });
    if (key === 'line' && value !== null && value !== '' && id === null) {
      id = value;
      idCol = hashAt + 1;
    }
    lastTagEnd = re.lastIndex;
  }
  return { spans, list, entries, id, idCol };
}

/** 从字符串里剔除若干区间，用于得到「纯文本」。 */
function removeSpans(str, spans) {
  if (!spans || !spans.length) return str;
  const sorted = spans.slice().sort((a, b) => a.start - b.start);
  let out = '', last = 0;
  for (const s of sorted) {
    if (s.start < last) continue;
    out += str.slice(last, s.start);
    last = Math.max(last, s.end);
  }
  out += str.slice(last);
  return out;
}

function collapse(str) {
  return str.replace(/\s+/g, ' ').trim();
}

/** 行内第一个非空白字符的 1-based 列号。 */
function firstNonWsCol(code) {
  const idx = code.search(/\S/);
  return idx < 0 ? 1 : idx + 1;
}

/* ========================================================================== *
 * 解析
 * ========================================================================== */

function emptyNode(title, headerLine, lastLine) {
  return {
    title,
    tags: [],
    subtitle: null,
    tracking: null,
    headerLine,
    bodyStartLine: headerLine,
    bodyEndLine: lastLine,
    closed: false,
    jumps: [],
    detours: [],
    commands: [],
    lines: [],
    options: [],
    declarations: [],
  };
}

function parseTagsValue(value) {
  return String(value || '')
    .split(/[\s,]+/)
    .map(s => s.replace(/^#/, '').trim())
    .filter(Boolean);
}

function applyHeader(node, key, value) {
  switch (key) {
    case 'title': node.title = value.trim(); break;
    case 'tags': node.tags = parseTagsValue(value); break;
    case 'subtitle': node.subtitle = value.trim() || null; break;
    case 'tracking': node.tracking = value.trim() || null; break;
    default: break; // 其它头部键（when/position/colorID ...）暂不建模
  }
}

function parseDeclare(args) {
  let rest = args || '';
  let type = null;
  const am = /\s+as\s+([A-Za-z_][A-Za-z0-9_]*)\s*$/.exec(rest);
  if (am) { type = am[1]; rest = rest.slice(0, am.index).trim(); }
  let name = null, value = null;
  const nm = /^\$?([A-Za-z_][A-Za-z0-9_]*)/.exec(rest);
  if (nm) {
    name = nm[1];
    const after = rest.slice(nm[0].length).trim();
    if (after.charAt(0) === '=') value = after.slice(1).trim() || null;
  }
  return { name, type, value };
}

/**
 * 内部完整解析：除公开字段外，另外返回诊断所需的逐行元数据（不泄漏到 nodes 上，
 * 保证 node 对象只含规格里列出的字段，deepStrictEqual 友好）。
 */
function _parse(text, opts) {
  opts = opts || {};
  const fileName = opts.fileName || '';
  const lines = splitLines(text);
  const lastLine = lastContentLine(lines);

  const nodes = [];
  const meta = [];
  const errors = [];

  let cur = null;          // 当前节点
  let curMeta = null;      // 当前节点的元数据
  let state = 'idle';      // idle | header | body

  const pushError = (code, line, col, message) => {
    errors.push({ severity: 'error', code, line, col, message });
  };

  const openNode = (title, headerLine) => {
    cur = emptyNode(title, headerLine, lastLine);
    curMeta = {
      dirs: [], vars: [], tags: [], funcs: [],
      declared: [], setRefs: [], jumpRefs: [],
      headerEndLine: headerLine,
    };
    nodes.push(cur);
    meta.push(curMeta);
  };

  const closeNode = (endLine, closed) => {
    cur.bodyEndLine = Math.max(cur.bodyStartLine, endLine);
    cur.closed = !!closed;
    if (!closed) {
      pushError('Y005', cur.bodyEndLine, 1,
        (fileName ? fileName + ': ' : '') +
        '节点 `' + cur.title + '` 缺少 `===` 收尾');
    }
    cur = null;
    curMeta = null;
  };

  for (let i = 0; i < lines.length; i++) {
    const lineNo = i + 1;
    const rawLine = lines[i];
    const trimmed = rawLine.trim();

    if (state === 'idle') {
      if (trimmed === '' || trimmed.startsWith('//')) continue;
      const m = /^title\s*:\s*(.*)$/.exec(trimmed);
      if (m) { openNode(m[1].trim(), lineNo); state = 'header'; }
      continue;
    }

    if (state === 'header') {
      if (/^-{3,}\s*$/.test(trimmed)) {
        cur.bodyStartLine = lineNo;
        state = 'body';
        continue;
      }
      if (trimmed === '' || trimmed.startsWith('//')) continue;
      const m = /^title\s*:\s*(.*)$/.exec(trimmed);
      if (m) {
        // 上一个节点没有 `---`：按未闭合处理，然后开始新节点
        cur.bodyStartLine = curMeta.headerEndLine;
        closeNode(lineNo - 1, false);
        openNode(m[1].trim(), lineNo);
        continue;
      }
      const kv = /^([A-Za-z_][A-Za-z0-9_]*)\s*:\s*(.*)$/.exec(trimmed);
      if (kv) {
        applyHeader(cur, kv[1], kv[2]);
        curMeta.headerEndLine = lineNo;
      }
      continue;
    }

    // state === 'body'
    if (/^={3,}\s*$/.test(trimmed)) {
      closeNode(lineNo, true);
      state = 'idle';
      continue;
    }
    parseBodyLine(lineNo, rawLine, cur, curMeta);
  }

  if (cur) {
    if (state === 'header') cur.bodyStartLine = curMeta.headerEndLine;
    closeNode(lastLine, false);
  }

  if (!nodes.length) {
    pushError('Y000', 1, 1,
      (fileName ? fileName + ': ' : '') +
      '文件中没有任何节点（缺少 `title:` 头部，或缺少 `---` 分隔符）');
  }

  return { nodes, meta, errors };
}

function parseBodyLine(lineNo, rawLine, node, m) {
  const code = stripComment(rawLine);
  if (!code.trim()) return;

  const dirs = scanDirectives(code, lineNo);
  const tagInfo = extractTags(code);

  // --- 指令 ---------------------------------------------------------------
  for (const d of dirs) {
    node.commands.push({ name: d.name, args: d.args, argc: d.argc, line: d.line, col: d.col });
    m.dirs.push(d);

    if (d.name === 'jump' || d.name === 'detour') {
      const target = firstToken(d.args);
      const list = d.name === 'jump' ? node.jumps : node.detours;
      list.push({ target, line: lineNo });
      m.jumpRefs.push({ name: d.name, target, line: lineNo, col: d.col });
    }

    if (d.name === 'declare') {
      const dec = parseDeclare(d.args);
      node.declarations.push({ name: dec.name, type: dec.type, value: dec.value, line: lineNo });
      if (dec.name) m.declared.push(dec.name);
    }

    if (d.name === 'set' && d.vars.length) {
      m.setRefs.push({ name: d.vars[0].name, line: lineNo, col: d.vars[0].col });
    }

    for (const v of d.vars) m.vars.push({ name: v.name, line: lineNo, col: v.col });
  }

  // --- 元数据 tag ---------------------------------------------------------
  for (const e of tagInfo.entries) {
    e.line = lineNo;
    m.tags.push(e);
  }

  // --- 函数调用（供 Y105 使用）------------------------------------------
  collectFunctionCalls(code, lineNo, dirs, m.funcs);

  // --- 行类型判定 ---------------------------------------------------------
  const spans = dirs.map(d => ({ start: d.start, end: d.end })).concat(tagInfo.spans);
  const ctrim = code.trim();

  if (/^(->|=>)/.test(ctrim)) {
    const optText = collapse(removeSpans(code, spans)).replace(/^(->|=>)\s*/, '').trim();
    let condition = null;
    for (const d of dirs) {
      if (d.name === 'if') { condition = d.args; break; }
    }
    if (condition === null) {
      for (const d of dirs) {
        if (d.name === 'once') {
          const cm = /^if\b([\s\S]*)$/.exec(d.args);
          if (cm) { condition = cm[1].trim(); break; }
        }
      }
    }
    node.options.push({
      text: optText,
      line: lineNo,
      col: firstNonWsCol(code),
      id: tagInfo.id,
      condition,
    });
    return;
  }

  const content = collapse(removeSpans(code, spans));
  if (!content) return;

  let speaker = null, text = content;
  const sm = /^([A-Za-z_][A-Za-z0-9_]*)\s*:\s*/.exec(content);
  if (sm) {
    speaker = sm[1];
    text = content.slice(sm[0].length).trim();
  }

  node.lines.push({
    id: tagInfo.id,
    speaker,
    text,
    tags: tagInfo.list,
    line: lineNo,
    col: firstNonWsCol(code),
  });
}

/**
 * 收集**真正会被求值**的位置里的函数调用，供 Y105 使用：
 *   1. `<<Name 参数…>>` 的参数区（`<<if CountNPCOption("X")>>`、`<<set $a = f()>>` …）
 *   2. 对话正文里的内联表达式 `{ f() }`
 * 对话散文里出现的 `name(...)` **不算调用**。实测真实语料里有 10 处是这样：
 *   `_(:3 」∠)_`（颜文字）、`` `O(n!)` ``、`` `function GenerateInsult()` ``、
 *   `` `Get_ID()` ``；若整行扫描会在正常脚本上刷出 10 条 Y105 噪音。
 */
function collectFunctionCalls(code, lineNo, dirs, out) {
  const spans = [];
  for (const d of dirs) spans.push({ start: d.nameEnd, end: d.closed ? d.end - 2 : d.end });
  const braceRe = /\{[^{}]*\}/g;
  let bm;
  while ((bm = braceRe.exec(code))) spans.push({ start: bm.index, end: braceRe.lastIndex });

  const nameStarts = new Set(dirs.map(d => d.nameStart));
  const re = /([A-Za-z_][A-Za-z0-9_]*)\s*\(/g;
  let m;
  while ((m = re.exec(code))) {
    const at = m.index;
    let inExpr = false;
    for (const s of spans) { if (at >= s.start && at < s.end) { inExpr = true; break; } }
    if (!inExpr) continue;
    const name = m[1];
    if (nameStarts.has(at)) continue;           // `<<Foo(...)>>` 里的指令名本身
    if (EXPR_KEYWORDS.has(name)) continue;
    const prev = at > 0 ? code[at - 1] : '';
    if (prev === '$' || prev === '.') continue;  // `$f(` / `obj.f(`
    out.push({ name, line: lineNo, col: at + 1 });
  }
}

/* ========================================================================== *
 * 公开：parseYarn / listNodes
 * ========================================================================== */

function parseYarn(text, opts) {
  const r = _parse(text, opts);
  return { nodes: r.nodes, errors: r.errors };
}

function listNodes(text) {
  const lines = splitLines(text);
  const out = [];
  let cur = null;
  const flush = () => { if (cur) { out.push(cur); cur = null; } };
  for (let i = 0; i < lines.length; i++) {
    const trimmed = lines[i].trim();
    if (trimmed === '' || trimmed.startsWith('//')) continue;
    const tm = /^title\s*:\s*(.*)$/.exec(trimmed);
    if (tm) { flush(); cur = { title: tm[1].trim(), tags: [], line: i + 1 }; continue; }
    if (!cur) continue;
    const gm = /^tags\s*:\s*(.*)$/.exec(trimmed);
    if (gm) { cur.tags = parseTagsValue(gm[1]); continue; }
    if (/^-{3,}\s*$/.test(trimmed)) { flush(); continue; }
  }
  flush();
  return out;
}

/* ========================================================================== *
 * ctx 归一化：规格给的是 map，知识库给的是数组，两种都吃
 * ========================================================================== */

function normalizeMap(value, keyField) {
  if (!value) return null;
  if (Array.isArray(value)) {
    const map = {};
    for (const item of value) {
      if (!item) continue;
      const k = typeof item === 'string' ? item : item[keyField || 'name'];
      if (typeof k === 'string' && k) map[k] = item;
    }
    return map;
  }
  if (typeof value === 'object') return value;
  return null;
}

function normalizeVariables(value) {
  if (!value) return null;
  if (Array.isArray(value)) {
    const map = {};
    for (const item of value) {
      if (!item) continue;
      if (typeof item === 'string') map[item] = null;
      else if (item.name) map[item.name] = item.type || null;
    }
    return map;
  }
  if (typeof value === 'object') return value;
  return null;
}

function paramList(sig) {
  if (!sig || typeof sig !== 'object') return null;
  const p = sig.parameters;
  if (p == null) return null;
  if (Array.isArray(p)) return p;
  if (typeof p === 'object') return Object.values(p);
  return null;
}

/* ========================================================================== *
 * 公开：diagnose
 * ========================================================================== */

function diagnose(text, ctx) {
  ctx = ctx || {};
  const r = _parse(text, ctx);
  const { nodes, meta } = r;

  const out = [];
  const seen = new Set();
  const push = (severity, code, line, col, message) => {
    const key = code + '|' + line + '|' + col + '|' + message;
    if (seen.has(key)) return;
    seen.add(key);
    out.push({ severity, code, line, col, message, source: 'yarn' });
  };

  // 0) 结构化错误（Y000 / Y005）直接映射
  for (const e of r.errors) {
    push(e.severity || 'error', e.code, e.line, e.col, e.message);
  }

  const commands = normalizeMap(ctx.commands, 'name');
  const functions = normalizeMap(ctx.functions, 'name');
  const variables = normalizeVariables(ctx.variables);
  const nodeIndex = normalizeMap(ctx.nodeIndex, 'title');
  const stateTags = Array.isArray(ctx.stateTags) ? ctx.stateTags : null;
  const fileName = ctx.fileName;

  const warn = (code, line, col, message) => push('warning', code, line, col, message);
  const err = (code, line, col, message) => push('error', code, line, col, message);
  const info = (code, line, col, message) => push('info', code, line, col, message);

  const loc = (msg) => (fileName ? '`' + fileName + '` ' : '') + msg;

  // 本文件内 `<<declare>>` 声明的变量也视为已声明
  const declaredHere = new Set();
  for (const m of meta) for (const n of m.declared) declaredHere.add(n);

  // --- Y004：同一文件内重复的节点 ---------------------------------------
  // 本作方言允许「同名节点多份」，用 `subtitle:` 区分片段：
  //   真实语料 211 个 .yarn 里 title 重复 148 次，但 (title, subtitle) 重复 0 次。
  // 所以判重键是 (title, subtitle)，只有两者都相同才是真的重复（后者会覆盖前者）。
  const titleSeen = new Map();
  for (const n of nodes) {
    const key = n.title + '\u0000' + (n.subtitle || '');
    if (titleSeen.has(key)) {
      const first = titleSeen.get(key);
      err('Y004', n.headerLine, 1, loc(
        '节点 `' + n.title + '`' + (n.subtitle ? '（subtitle `' + n.subtitle + '`）' : '') +
        ' 重复定义（首次出现在第 ' + first + ' 行），后一份会覆盖前一份'));
    } else {
      titleSeen.set(key, n.headerLine);
    }
  }

  for (let ni = 0; ni < nodes.length; ni++) {
    const node = nodes[ni];
    const m = meta[ni];

    // --- 块结构：Y003 ----------------------------------------------------
    // if 与 once 共用同一个栈：`once` 允许自带 `else` 子句，见文件头第 2 条。
    const blockStack = [];
    for (const d of m.dirs) {
      if (d.name === 'if' && d.leading) {
        blockStack.push({ dir: d, once: false, hasIf: true, elseSeen: false });
        continue;
      }
      if (d.name === 'once' && d.leading) {
        blockStack.push({ dir: d, once: true, hasIf: /^if\b/.test(d.args || ''), elseSeen: false });
        continue;
      }
      if (d.name === 'elseif' || d.name === 'else') {
        const top = blockStack.length ? blockStack[blockStack.length - 1] : null;
        const isElseIf = d.name === 'elseif';
        if (!top || (isElseIf && top.once && !top.hasIf)) {
          err('Y003', d.line, d.col, loc('`<<' + d.name + '>>` 没有匹配的 `<<if>>`'));
        } else if (top.elseSeen) {
          // `<<else>>` 只允许一次；`<<elseif>>` 不能出现在 `<<else>>` 之后
          err('Y003', d.line, d.col, loc(isElseIf ? '`<<elseif>>` 出现在 `<<else>>` 之后' : '重复的 `<<else>>`'));
        } else if (!isElseIf) {
          top.elseSeen = true;
        }
        continue;
      }
      if (d.name === 'endif') {
        const top = blockStack.length ? blockStack[blockStack.length - 1] : null;
        if (top && !top.once) blockStack.pop();
        else err('Y003', d.line, d.col, loc('`<<endif>>` 没有匹配的 `<<if>>`'));
        continue;
      }
      if (d.name === 'endonce') {
        let at = -1;
        for (let i = blockStack.length - 1; i >= 0; i--) {
          if (blockStack[i].once) { at = i; break; }
        }
        if (at < 0) {
          err('Y003', d.line, d.col, loc('`<<endonce>>` 没有匹配的 `<<once>>`'));
          continue;
        }
        // once 之上若还压着没闭合的 if，报它们缺 endif，并随 endonce 一起收掉
        for (let i = at + 1; i < blockStack.length; i++) {
          const f = blockStack[i];
          err('Y003', f.dir.line, f.dir.col, loc('节点 `' + node.title + '` 的 `<<if>>` 缺少 `<<endif>>`'));
        }
        blockStack.length = at;
        continue;
      }
    }
    for (const f of blockStack) {
      if (f.once) err('Y003', f.dir.line, f.dir.col, loc('节点 `' + node.title + '` 的 `<<once>>` 缺少 `<<endonce>>`'));
      else err('Y003', f.dir.line, f.dir.col, loc('节点 `' + node.title + '` 的 `<<if>>` 缺少 `<<endif>>`'));
    }

    // --- Y001 / Y007 / Y102：指令相关 ------------------------------------
    for (const d of m.dirs) {
      // Y007：`<<...` 没有配对的 `>>`（漏写或用中文全角引号最常见）。
      // 这一行后面全部内容都会被当成指令参数，Yarn 编译期会直接报错。
      if (!d.closed) {
        err('Y007', d.line, d.col, loc('`<<' + d.name + '` 缺少配对的 `>>`（指令未闭合）'));
      }
      if (commands && !_BUILTIN_SET.has(d.name) && !Object.prototype.hasOwnProperty.call(commands, d.name)) {
        err('Y001', d.line, d.col, loc('未知指令 `' + d.name + '`'));
      }
      if (commands && !_BUILTIN_SET.has(d.name)) {
        const sig = Object.prototype.hasOwnProperty.call(commands, d.name) ? commands[d.name] : null;
        const pl = paramList(sig);
        if (pl) {
          const min = pl.filter(p => !(p && p.optional)).length;
          const last = pl.length ? pl[pl.length - 1] : null;
          const variadic = !!(last && last.isParamsArray);
          const max = variadic ? Infinity : pl.length;
          if (d.argc < min || d.argc > max) {
            const tooFew = d.argc < min;
            const range = variadic
              ? ('至少 ' + min + ' 个')
              : (min === max ? (min + ' 个') : (min + '-' + max + ' 个'));
            const note = tooFew
              ? '（知识库不记录可选参数/重载，少参可能合法）'
              : '（多余的实参会被忽略）';
            const msg = loc('指令 `' + d.name + '` 需要 ' + range + '参数，实际 ' + d.argc + ' 个' + note);
            // 少参可能是合法调用（C# 侧有默认值，但 ysls 里没有重载信息），只提示；
            // 多参一定是写错了，按 warning 报。
            if (tooFew) info('Y102', d.line, d.col, msg);
            else warn('Y102', d.line, d.col, msg);
          }
        }
      }
    }

    // --- Y002：跳转目标 ---------------------------------------------------
    if (nodeIndex) {
      for (const j of m.jumpRefs) {
        if (!j.target) continue;
        if (!Object.prototype.hasOwnProperty.call(nodeIndex, j.target)) {
          err('Y002', j.line, j.col, loc('`<<' + j.name + '>>` 目标节点 `' + j.target + '` 不存在'));
        }
      }
    }

    // --- Y006：set 目标未声明 --------------------------------------------
    if (variables) {
      for (const s of m.setRefs) {
        if (!Object.prototype.hasOwnProperty.call(variables, s.name) && !declaredHere.has(s.name)) {
          err('Y006', s.line, s.col, loc('`<<set>>` 目标变量 `$' + s.name + '` 未声明'));
        }
      }
    }

    // --- Y101：使用未声明的变量 ------------------------------------------
    if (variables) {
      const reported = new Set();
      for (const v of m.vars) {
        if (Object.prototype.hasOwnProperty.call(variables, v.name)) continue;
        if (declaredHere.has(v.name)) continue;
        if (reported.has(v.line + ':' + v.name)) continue;
        reported.add(v.line + ':' + v.name);
        warn('Y101', v.line, v.col, loc('变量 `$' + v.name + '` 未声明'));
      }
    }

    // --- Y103：对话行缺少 #line: -----------------------------------------
    for (const ln of node.lines) {
      if (!ln.id) {
        warn('Y103', ln.line, ln.col, loc('对话行缺少 `#line:` 标记'));
      }
    }

    // --- Y104：非法 #state 值 --------------------------------------------
    if (stateTags) {
      for (const t of m.tags) {
        if (t.key !== 'state' || t.value == null) continue;
        if (stateTags.indexOf(t.value) < 0) {
          warn('Y104', t.line, t.col, loc('未知的 `#state:' + t.value + '`（合法值：' + stateTags.join(', ') + '）'));
        }
      }
    }

    // --- Y105：未知函数 ---------------------------------------------------
    const reportedFn = new Set();
    for (const f of m.funcs) {
      if (YARN_FUNCTIONS.has(f.name) || EXPR_KEYWORDS.has(f.name)) continue;
      if (functions && Object.prototype.hasOwnProperty.call(functions, f.name)) continue;
      if (functions) {
        if (reportedFn.has(f.line + ':' + f.name)) continue;
        reportedFn.add(f.line + ':' + f.name);
        warn('Y105', f.line, f.col, loc('未知函数 `' + f.name + '(…)`'));
      }
    }
  }

  // --- Y106：空选项 -------------------------------------------------------
  for (const node of nodes) {
    for (const o of node.options) {
      if (!o.text) warn('Y106', o.line, o.col, loc('选项 `->` 没有文本'));
    }
  }

  // --- Y107：同一文件内重复的 #line: id ----------------------------------
  const idSeen = new Map();
  for (const m of meta) {
    for (const t of m.tags) {
      if (t.key !== 'line' || t.value == null || t.value === '') continue;
      if (idSeen.has(t.value)) {
        info('Y107', t.line, t.col, loc('`#line:' + t.value + '` 在同一文件内重复（首次出现在第 ' + idSeen.get(t.value) + ' 行）'));
      } else {
        idSeen.set(t.value, t.line);
      }
    }
  }

  out.sort((a, b) => (a.line - b.line) || (a.col - b.col) || (a.code < b.code ? -1 : a.code > b.code ? 1 : 0));
  return out;
}

/* ========================================================================== */

module.exports = { parseYarn, diagnose, listNodes, NODE_BUILTINS };
