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
  const re = /#([A-Za-z_][A-Za-z0-9_]*)(?::([^\s#]*))?/g;
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
    entries.push({
      key, value, line: 0, col: hashAt + 1,
      start: hashAt, end: re.lastIndex, text: str.slice(hashAt, re.lastIndex),
    });
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
      declared: [], setRefs: [], jumpRefs: [], visitedRefs: [],
      when: null, subtitleLine: null,
      headerEndLine: headerLine,
    };
    nodes.push(cur);
    meta.push(curMeta);
  };

  const closeNode = (endLine, closed) => {
    cur.bodyEndLine = Math.max(cur.bodyStartLine, endLine);
    cur.closed = !!closed;
    if (!closed) {
      // 规格里没有这条（我们自有）：缺 `===` 会让后续内容被吞，但规格未把它定为错误，降为 warning。
      errors.push({
        severity: 'warning', code: 'Y005', line: cur.bodyEndLine, col: 1,
        message: (fileName ? fileName + ': ' : '') +
          '节点 `' + cur.title + '` 缺少 `===` 收尾',
      });
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
        if (kv[1] === 'subtitle') curMeta.subtitleLine = lineNo;
        if (kv[1] === 'when') curMeta.when = kv[2].trim() || null;
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

  // 规格 §11.10 明确「空文件 / 没有 title: 的文件」不报，因此不再产出 Y000。
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

    // CR-102：`visited("节点名")` 的双引号目标（位置含双引号）
    if (d.name === 'visited') {
      const vm = /^\s*"([^"]*)"/.exec(d.args || '');
      if (vm) {
        const q = code.indexOf('"', d.nameEnd);
        m.visitedRefs.push({
          value: vm[1],
          line: lineNo,
          col: q >= 0 ? q + 1 : d.col,
          end: q >= 0 ? q + 2 : d.col + 1,
        });
      }
    }

    for (const v of d.vars) m.vars.push({ name: v.name, line: lineNo, col: v.col });
  }

  // --- 元数据 tag ---------------------------------------------------------
  for (const e of tagInfo.entries) {
    e.line = lineNo;
    m.tags.push(e);
  }

  // --- 函数调用（供 Y105 使用）------------------------------------------
  collectFunctionCalls(code, lineNo, dirs, m.funcs, m.visitedRefs);

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
      // CR-501：整行（已剥注释）与行内第一个 `#` 的 0-based 偏移
      raw: code.trimEnd(),
      hashAt: code.indexOf('#'),
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
function collectFunctionCalls(code, lineNo, dirs, out, visitedOut) {
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
    if (name === 'visited' && visitedOut) {
      const hit = /^visited\s*\(\s*"([^"]*)"\s*\)/.exec(code.slice(at));
      if (hit) visitedOut.push({ value: hit[1], line: lineNo, col: at + 1 });
    }
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
 * 规格辅助：§11.2 槽位让路、S2 近似建议、CR-115 确定性 subtitle、CR-501 标签区
 * ========================================================================== */

/** §11.2 积木槽位：同一行里有 `【` 开头、`】` 结尾、中间非空的一段。 */
function hasSlot(text) {
  return /【[^】\r\n]*[^【】\r\n][^】\r\n]*】/.test(String(text || ''));
}

/** 编辑距离（S2 相似度用）。 */
function levenshtein(a, b) {
  const s = String(a == null ? '' : a);
  const t = String(b == null ? '' : b);
  if (s === t) return 0;
  const m = s.length, n = t.length;
  if (!m) return n;
  if (!n) return m;
  let prev = new Array(n + 1);
  let cur = new Array(n + 1);
  for (let j = 0; j <= n; j++) prev[j] = j;
  for (let i = 1; i <= m; i++) {
    cur[0] = i;
    for (let j = 1; j <= n; j++) {
      const cost = s.charCodeAt(i - 1) === t.charCodeAt(j - 1) ? 0 : 1;
      cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + cost);
    }
    const tmp = prev; prev = cur; cur = tmp;
  }
  return prev[n];
}

/**
 * S2 近似建议：候选只从当前索引取；去掉首尾空白后比较；相似度 = 编辑距离 ÷ 较长长度；
 * 大小写差异固定 0.85 且优先；≥0.8 才建议；同分取字典序最小；纯数字差异不建议。
 */
function suggestName(value, candidates) {
  const v = String(value == null ? '' : value).trim();
  if (!v) return null;
  if (/^-?\d+(\.\d+)?$/.test(v)) return null;
  let best = null;
  let bestScore = 0;
  for (const raw of candidates || []) {
    const c = String(raw == null ? '' : raw).trim();
    if (!c || c === v) continue;
    if (/^-?\d+(\.\d+)?$/.test(c)) continue;
    let score;
    if (c.toLowerCase() === v.toLowerCase()) {
      score = 0.85;
    } else {
      const len = Math.max(v.length, c.length);
      score = len ? 1 - levenshtein(v.toLowerCase(), c.toLowerCase()) / len : 0;
      if (score < 0.8) continue;
    }
    if (score > bestScore || (score === bestScore && best !== null && c < best)) {
      best = c;
      bestScore = score;
    }
  }
  return bestScore >= 0.8 ? best : null;
}

/** CR-115 的确定性 subtitle：由 title + when 值 + 组内序号决定（Auto_ + 10 位小写十六进制）。 */
function autoSubtitle(title, when, ordinal) {
  const src = String(title || '') + '\u0000' + String(when || '') + '\u0000' + String(ordinal || 0);
  let h1 = 0x811c9dc5;
  let h2 = 0x01000193;
  for (let i = 0; i < src.length; i++) {
    const ch = src.charCodeAt(i);
    h1 = Math.imul(h1 ^ ch, 0x01000193) >>> 0;
    h2 = (h2 + ch) >>> 0;
    h2 = Math.imul(h2 ^ (h2 >>> 13), 0x5bd1e995) >>> 0;
  }
  const hex = (h1 >>> 0).toString(16).padStart(8, '0') + (h2 >>> 0).toString(16).padStart(8, '0');
  return 'Auto_' + hex.slice(0, 10);
}

/**
 * CR-501 的「标签区」判定：可选 `if`/`jump`/`detour` + 空白 + 一个 `<<…>>`，
 * 之后是可选的多个标签直到行尾；只有标签、没有 `<<…>>` 也算合法标签区
 * （规格 §3 把标签区定义为行尾连续的 `#tag`；实测语料 2314/2316 条选项行都是这种形态）。
 * 传入的是从行内第一个 `#` 开始的尾部文本。
 */
function isLegalTagArea(tail) {
  const TAG = '(?:#[A-Za-z_][A-Za-z0-9_]*(?::[^\\s#]+)?)';
  const re = new RegExp(
    '^\\s*(?:(?:if|jump|detour)\\s+)?(?:<<[\\s\\S]*>>)?(?:\\s*' + TAG + ')*\\s*$'
  );
  return re.test(String(tail || ''));
}

/* ========================================================================== *
 * 公开：diagnose
 * ========================================================================== */

/**
 * 诊断一份 Yarn 文本。
 *
 * 与旧版的差别（规格 L1 保真）：
 *   - 生成顺序按 §11.3 的 13 步分桶，桶内按位置升序，最后截到 500 条/文档；
 *   - 未知 #state 值（CR-109）保留原码 Y104（warning），新增 CR-102/104/105/106/107/108/
 *     113/114/115/116/201/202/203/501；
 *   - §11.2 槽位让路、§11.1 索引为空静默、§11.7 去重键；
 *   - Y003/Y005/Y006/Y101/Y103/Y105/Y106/Y107 是「我们自有、规格无此条」的检查，
 *     按规格没有对应 error 就一律降为 warning/info（详见 docs/MODS.md 码表）。
 *
 * ctx 字段（都能缺省，缺了对应规则就静默）：
 *   fileName, commands, functions, variables, nodeIndex, stateTags,
 *   characters, tagVocabulary {builtin,result,personality}, modNames,
 *   declarations {name:{file,line}}, nodeGroups (Map|Object title -> members),
 *   modCommands [{name,file,line,args}], pairs [{start,end,certain,why}],
 *   checks {defines,variables,nodes}
 */
function diagnose(text, ctx) {
  ctx = ctx || {};
  const r = _parse(text, ctx);
  const { nodes, meta } = r;

  // ---- 输出装配：§11.3 的 13 步生成顺序 + 单文档 500 条上限 --------------
  const buckets = [];
  for (let i = 0; i < 13; i++) buckets.push([]);
  const seen = new Set();
  const emit = (step, severity, code, line, col, message, related) => {
    const s = Math.min(13, Math.max(1, step | 0));
    const key = code + '|' + line + '|' + col + '|' + message;
    if (seen.has(key)) return;
    seen.add(key);
    const item = { severity, code, line, col, message, source: 'yarn' };
    if (related && related.length) item.related = related.slice(0, 8);
    buckets[s - 1].push(item);
  };
  const warn = (step, code, line, col, message, related) => emit(step, 'warning', code, line, col, message, related);
  const err = (step, code, line, col, message, related) => emit(step, 'error', code, line, col, message, related);
  const info = (step, code, line, col, message, related) => emit(step, 'info', code, line, col, message, related);

  // 0) 解析器的结构性结果（Y005 已降 warning；Y000 按 §11.10 不再产出）
  for (const e of r.errors) emit(1, e.severity || 'warning', e.code, e.line, e.col, e.message);

  const commands = normalizeMap(ctx.commands, 'name');
  const functions = normalizeMap(ctx.functions, 'name');
  const variables = normalizeVariables(ctx.variables);
  const nodeIndex = normalizeMap(ctx.nodeIndex, 'title');
  const stateTags = Array.isArray(ctx.stateTags) ? ctx.stateTags : null;
  const characters = Array.isArray(ctx.characters) ? ctx.characters : null;
  const modNames = Array.isArray(ctx.modNames) ? ctx.modNames : null;
  const declarations = ctx.declarations && typeof ctx.declarations === 'object' ? ctx.declarations : null;
  const pairs = Array.isArray(ctx.pairs) ? ctx.pairs : null;
  const modCommands = Array.isArray(ctx.modCommands) ? ctx.modCommands : null;
  const checks = Object.assign({ defines: true, variables: true, nodes: true }, ctx.checks || {});
  const fileName = ctx.fileName;
  const fileKey = ctx.fileKey != null ? String(ctx.fileKey) : fileName;

  const loc = (msg) => (fileName ? '`' + fileName + '` ' : '') + msg;
  const hasIndex = (map) => !!map && Object.keys(map).length > 0;

  // 本文件内 `<<declare>>` 声明的变量也视为已声明
  const declaredHere = new Set();
  for (const m of meta) for (const n of m.declared) declaredHere.add(n);

  // ---- §11.1：索引为空时该族静默（不许把每个值都报成未知） --------------
  const stateTablePresent = !!stateTags && stateTags.length > 0;
  const stateTagsUsable = checks.defines && stateTablePresent;
  const charactersUsable = checks.defines && !!characters && characters.length > 0;
  const variablesUsable = checks.variables && hasIndex(variables);
  const declarationsUsable = checks.variables && !!declarations && Object.keys(declarations).length > 0;
  const nodeIndexUsable = checks.nodes && hasIndex(nodeIndex);

  // 合法标签词表（四组：内建 / 结果标识 / 人格 / 当前 Mod 目录名）
  const vocab = ctx.tagVocabulary && typeof ctx.tagVocabulary === 'object' ? ctx.tagVocabulary : null;
  const legalTags = vocab ? [].concat(
    Array.isArray(vocab.builtin) ? vocab.builtin : [],
    Array.isArray(vocab.result) ? vocab.result : [],
    Array.isArray(vocab.personality) ? vocab.personality : []
  ).filter((s) => typeof s === 'string' && s) : [];
  const tagNames = legalTags.concat(modNames || []);
  const tagsUsable = legalTags.length > 0;
  const specialTags = { state: true, Topic: true, Check: true, Modify: true };

  for (let ni = 0; ni < nodes.length; ni++) {
    const node = nodes[ni];
    const m = meta[ni];

    // --- 块结构：Y003（我们自有；规格无此条 → warning）--------------------
    const blockStack = [];
    for (const d of m.dirs) {
      if (hasSlot(d.args)) continue;
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
          warn(1, 'Y003', d.line, d.col, loc('`<<' + d.name + '>>` 没有匹配的 `<<if>>`'));
        } else if (top.elseSeen) {
          warn(1, 'Y003', d.line, d.col, loc(isElseIf ? '`<<elseif>>` 出现在 `<<else>>` 之后' : '重复的 `<<else>>`'));
        } else if (!isElseIf) {
          top.elseSeen = true;
        }
        continue;
      }
      if (d.name === 'endif') {
        const top = blockStack.length ? blockStack[blockStack.length - 1] : null;
        if (top && !top.once) blockStack.pop();
        else warn(1, 'Y003', d.line, d.col, loc('`<<endif>>` 没有匹配的 `<<if>>`'));
        continue;
      }
      if (d.name === 'endonce') {
        let at = -1;
        for (let i = blockStack.length - 1; i >= 0; i--) {
          if (blockStack[i].once) { at = i; break; }
        }
        if (at < 0) {
          warn(1, 'Y003', d.line, d.col, loc('`<<endonce>>` 没有匹配的 `<<once>>`'));
          continue;
        }
        for (let i = at + 1; i < blockStack.length; i++) {
          const f = blockStack[i];
          warn(1, 'Y003', f.dir.line, f.dir.col, loc('节点 `' + node.title + '` 的 `<<if>>` 缺少 `<<endif>>`'));
        }
        blockStack.length = at;
        continue;
      }
    }
    for (const f of blockStack) {
      if (f.once) warn(1, 'Y003', f.dir.line, f.dir.col, loc('节点 `' + node.title + '` 的 `<<once>>` 缺少 `<<endonce>>`'));
      else warn(1, 'Y003', f.dir.line, f.dir.col, loc('节点 `' + node.title + '` 的 `<<if>>` 缺少 `<<endif>>`'));
    }

    // --- 指令：Y007 / Y001 / Y102 ----------------------------------------
    for (const d of m.dirs) {
      if (hasSlot(d.args)) continue;
      // Y007：`<<...` 没有配对的 `>>`（规格 §11.10 不报；我们保留为 warning，见码表）
      if (!d.closed) {
        warn(1, 'Y007', d.line, d.col, loc('`<<' + d.name + '` 缺少配对的 `>>`（指令未闭合）'));
      }
      if (commands && !_BUILTIN_SET.has(d.name) && !Object.prototype.hasOwnProperty.call(commands, d.name)) {
        err(1, 'Y001', d.line, d.col, loc('未知指令 `' + d.name + '`'));
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
            const range = variadic ? ('至少 ' + min + ' 个')
              : (min === max ? (min + ' 个') : (min + '-' + max + ' 个'));
            const note = tooFew ? '（知识库不记录可选参数/重载，少参可能合法）' : '（多余的实参会被忽略）';
            const msg = loc('指令 `' + d.name + '` 需要 ' + range + '参数，实际 ' + d.argc + ' 个' + note);
            if (tooFew) info(1, 'Y102', d.line, d.col, msg);
            else warn(1, 'Y102', d.line, d.col, msg);
          }
        }
      }
    }

    // --- CR-101（Y002）：跳转目标 ----------------------------------------
    if (nodeIndexUsable) {
      const titles = Object.keys(nodeIndex);
      for (const j of m.jumpRefs) {
        if (!j.target || hasSlot(j.target)) continue;
        if (!Object.prototype.hasOwnProperty.call(nodeIndex, j.target)) {
          const sug = suggestName(j.target, titles);
          err(2, 'Y002', j.line, j.col, loc(
            '`<<' + j.name + '>>` 目标节点 `' + j.target + '` 不存在' +
            (sug ? '；相近的节点：`' + sug + '`' : '')), null);
        }
      }
    }

    // --- CR-103 家族：Y006（set 目标未声明）/ Y101（使用未声明变量）-------
    if (variablesUsable) {
      for (const s of m.setRefs) {
        if (!Object.prototype.hasOwnProperty.call(variables, s.name) && !declaredHere.has(s.name)) {
          warn(3, 'Y006', s.line, s.col, loc('`<<set>>` 目标变量 `$' + s.name + '` 未声明'));
        }
      }
      const reported = new Set();
      for (const v of m.vars) {
        if (Object.prototype.hasOwnProperty.call(variables, v.name)) continue;
        if (declaredHere.has(v.name)) continue;
        if (reported.has(v.line + ':' + v.name)) continue;
        reported.add(v.line + ':' + v.name);
        warn(3, 'Y101', v.line, v.col, loc('变量 `$' + v.name + '` 未声明'));
      }
    }

    // --- CR-104（Y109）：跨文件重复 declare -------------------------------
    if (declarationsUsable) {
      const declaredSoFar = new Set();
      for (const node2 of nodes) {
        for (const dec of node2.declarations) {
          if (!dec.name) continue;
          if (declaredSoFar.has(dec.name)) continue;   // 同文件第二次 declare 不报（附录 C-4）
          declaredSoFar.add(dec.name);
          const first = Object.prototype.hasOwnProperty.call(declarations, dec.name) ? declarations[dec.name] : null;
          if (!first) continue;
          if (fileKey != null && first.file === fileKey) continue; // 本文件就是首次声明者
          err(4, 'Y109', dec.line, 1, loc(
            'Redeclaration of existing variable `$' + dec.name + '`：`$' + dec.name +
            '` 已经在 ' + (first.file || '游戏本体') + ':' + (first.line || 0) +
            ' 声明过，重复声明会让整个 Mod 编译失败；删掉这一行 `<<declare>>`'),
            [{ file: first.file || '', line: first.line || 0, message: '首次声明的位置' }]);
        }
      }
    }

    // --- 标签区：CR-113 / 105 / 106 / 107 / 108 / 109（Y110..Y115）、Y103/Y107
    for (const t of m.tags) {
      if (t.key === 'line') continue;                 // §11.10：单独的 #line 豁免所有标签检查
      const tagText = t.text || ('#' + t.key + (t.value == null ? '' : ':' + t.value));
      if (hasSlot(tagText)) continue;                 // §11.2 槽位让路

      // CR-113（Y110）：需要参数却没带参数（`#line` 已豁免）
      if (t.value == null && Object.prototype.hasOwnProperty.call(specialTags, t.key)) {
        err(5, 'Y110', t.line, t.col, loc(
          '`#' + t.key + '` 缺少参数，游戏无法识别；写全应为 `#' + t.key + ':<参数>`' +
          (t.key === 'state' ? '（例：`#state:Idle`）'
            : t.key === 'Topic' ? '（例：`#Topic:Topic_Law`）'
              : t.key === 'Check' ? '（例：`#Check:Troll:20:Topic_Law`）'
                : '（例：`#Modify:$变量:true`）')));
        continue;
      }

      if (!tagsUsable) continue;
      if (tagNames.indexOf(t.key) >= 0) continue;

      // CR-106（Y113）：只差大小写
      const caseHit = tagNames.filter((c) => c.toLowerCase() === t.key.toLowerCase());
      if (caseHit.length) {
        err(5, 'Y113', t.line, t.col, loc(
          '标签 `#' + t.key + '` 大小写不对；游戏区分大小写，应写成 `#' + caseHit[0] + '`'));
        continue;
      }

      // CR-107（Y114）：`#state` 漏了冒号
      const lk = t.key.toLowerCase();
      if (t.value == null && lk.length > 5 && lk.slice(0, 5) === 'state' && stateTablePresent) {
        const rest = t.key.slice(5);
        const hit = stateTags.filter((s) => s.toLowerCase() === rest.toLowerCase());
        const fixed = hit.length ? '#state:' + hit[0] : '#state:<状态名>';
        err(5, 'Y114', t.line, t.col, loc(
          '`#state` 后面必须跟冒号和状态名，`#' + t.key + '` 会被当成未知标签；应写成 `' + fixed + '`'));
        continue;
      }

      // CR-105（Y112）：未知标签
      const sug = suggestName(t.key, tagNames);
      err(5, 'Y112', t.line, t.col, loc(
        '未知标签 `#' + t.key + '`：游戏不认识这个标签' + (sug ? '；相近的标签：`#' + sug + '`' : '')));
    }

    // CR-108（Y115）/ CR-109（Y104）：#state 的值
    if (stateTagsUsable) {
      for (const t of m.tags) {
        if (t.key !== 'state' || t.value == null || t.value === '') continue;
        if (hasSlot(t.text || '')) continue;
        if (stateTags.indexOf(t.value) >= 0) continue;
        const caseHit = stateTags.filter((s) => s.toLowerCase() === t.value.toLowerCase());
        if (caseHit.length) {
          err(5, 'Y115', t.line, t.col, loc(
            '`#state:' + t.value + '` 与状态 `' + caseHit[0] + '` 只有大小写不同；游戏里它们是两个不同的状态，应写成 `#state:' + caseHit[0] + '`'));
          continue;
        }
        const sug = suggestName(t.value, stateTags);
        warn(5, 'Y104', t.line, t.col, loc(
          '未知的 `#state:' + t.value + '`（知识库只有 ' + stateTags.length + ' 个状态名）' +
          (sug ? '；相近的合法状态：`' + sug + '`' : '') +
          '；如果不是拼错了，可能是本 Mod 自定义的状态，或游戏更新后新增的状态'));
      }
    }

    // --- Y103：对话行缺少 #line:（我们自有；规格未要求 → info）-----------
    for (const ln of node.lines) {
      if (!ln.id) info(5, 'Y103', ln.line, ln.col, loc('对话行缺少 `#line:` 标记（不影响运行，仅提示）'));
    }

    // --- Y105：未知函数（我们自有；规格 §11.10 明确不检查函数名 → info 提示）
    if (hasIndex(functions)) {
      for (const f of m.funcs) {
        if (!f || !f.name || YARN_FUNCTIONS.has(f.name)) continue;
        if (Object.prototype.hasOwnProperty.call(functions, f.name)) continue;
        info(5, 'Y105', f.line || 1, f.col || 1, loc(
          '未知函数 `' + f.name + '(...)`：知识库没有这个函数，可能是拼写错误，也可能是我们还没收录'));
      }
    }

    // --- CR-114（Y111）：Character: 行里的名字不是角色 ---------------------
    if (charactersUsable) {
      for (const ln of node.lines) {
        if (!ln.speaker || ln.speaker.toLowerCase() !== 'character') continue;
        const value = String(ln.text || '').trim();
        if (!value || value.charAt(0) === '$' || hasSlot(value)) continue;
        const names = value.split(/[,，\s]+/).map((s) => s.trim()).filter(Boolean);
        const unknown = names.filter((n) => characters.indexOf(n) < 0);
        if (!unknown.length) continue;
        const sug = suggestName(unknown[0], characters);
        err(5, 'Y111', ln.line, ln.col, loc(
          '`Character:` 行里的 ' + unknown.map((n) => '`' + n + '`').join('、') +
          ' 不是角色名：游戏找不到这个角色，这一行不会生效' +
          (sug ? '；相近的角色：`' + sug + '`' : '')));
      }
    }

    // --- Y107：同一文件内重复的 #line: id（我们自有 → info）--------------
    const idSeen = new Map();
    for (const t of m.tags) {
      if (t.key !== 'line' || t.value == null || t.value === '') continue;
      if (idSeen.has(t.value)) {
        info(5, 'Y107', t.line, t.col, loc('`#line:' + t.value + '` 在同一文件内重复（首次出现在第 ' + idSeen.get(t.value) + ' 行）'));
      } else {
        idSeen.set(t.value, t.line);
      }
    }

    // --- CR-102（Y108）：visited 目标节点不存在 ---------------------------
    if (nodeIndexUsable && m.visitedRefs && m.visitedRefs.length) {
      const titles = Object.keys(nodeIndex);
      for (const v of m.visitedRefs) {
        if (!v.value || hasSlot(v.value)) continue;
        if (Object.prototype.hasOwnProperty.call(nodeIndex, v.value)) continue;
        const sug = suggestName(v.value, titles);
        err(2, 'Y108', v.line, v.col, loc(
          '`visited("' + v.value + '")` 的目标节点 `' + v.value + '` 不存在' +
          (/^\s|\s$/.test(v.value) ? '（目标名首尾有空白，去掉空白再试）' : '') +
          (sug ? '；相近的节点：`' + sug + '`' : '')));
      }
    }

    // --- Y106（我们自有）：空选项 ----------------------------------------
    for (const o of node.options) {
      if (!o.text) warn(5, 'Y106', o.line, o.col, loc('选项 `->` 没有文本'));
    }

    // --- CR-501（Y121）：选项行 `#` 后混入普通文字 ------------------------
    for (const o of node.options) {
      if (o.hashAt == null || o.hashAt < 0) continue;
      if (hasSlot(o.raw || '')) continue;
      const tail = String(o.raw || '').slice(o.hashAt);
      if (isLegalTagArea(tail)) continue;
      err(11, 'Y121', o.line, o.hashAt + 1, loc(
        '选项行的 `#` 后面跟了普通文字，游戏编译器会报 `Unexpected … while reading a shortcut option statement`，' +
        '整条选项无法解析，整个 Mod 都跑不起来；把文字移到 `#` 前面，或把 `#` 改成 `//`'));
    }
  }

  // ---- CR-115 / CR-116：节点组（§11.7 按组成员去重）----------------------
  {
    const groups = new Map();
    const addMember = (title, member) => {
      if (!title) return;
      if (!groups.has(title)) groups.set(title, []);
      groups.get(title).push(member);
    };
    const raw = ctx.nodeGroups;
    if (raw) {
      const entries = raw instanceof Map ? Array.from(raw.entries()) : Object.entries(raw);
      for (const pair of entries) {
        const title = pair[0];
        const members = Array.isArray(pair[1]) ? pair[1] : [];
        for (const mem of members) {
          if (!mem) continue;
          // 本文件的成员以编辑器里的当前文本为准（§11.5 未保存文档并入）
          if (fileKey != null && mem.file === fileKey) continue;
          addMember(title, {
            file: mem.file || '',
            line: mem.line || 0,
            subtitleLine: mem.subtitleLine || mem.line || 0,
            subtitle: mem.subtitle == null ? null : mem.subtitle,
            when: mem.when || null,
            current: false,
          });
        }
      }
    }
    for (let i = 0; i < nodes.length; i++) {
      const n = nodes[i];
      const m = meta[i];
      addMember(n.title, {
        file: fileKey || '',
        line: n.headerLine,
        subtitleLine: m.subtitleLine || n.headerLine,
        subtitle: n.subtitle,
        when: m.when,
        current: true,
      });
    }
    for (const arr of groups.values()) {
      arr.sort((a, b) => (a.file < b.file ? -1 : a.file > b.file ? 1 : 0) || (a.line - b.line));
    }
    for (const entry of groups) {
      const title = entry[0];
      const members = entry[1];
      if (members.length < 2) continue;
      if (!members.some((mem) => mem.when)) continue;
      for (let idx = 0; idx < members.length; idx++) {
        const mem = members[idx];
        if (!mem.current) continue;
        if (!mem.subtitle) {
          err(12, 'Y116', mem.line, 1, loc(
            '节点组 `' + title + '` 有 ' + members.length + ' 个成员，这个成员缺少 `subtitle:`：' +
            '游戏只认第一个同名节点，其余分支会被静默丢弃；在 title 行下面加一行 `subtitle: ' +
            autoSubtitle(title, mem.when, idx) + '`'));
          continue;
        }
        let dup = null;
        for (let j = 0; j < idx; j++) {
          const other = members[j];
          if (other.subtitle && other.subtitle === mem.subtitle) { dup = other; break; }
        }
        if (dup) {
          err(12, 'Y117', mem.subtitleLine, 1, loc(
            '节点组 `' + title + '` 里已经有成员用了 `subtitle: ' + mem.subtitle +
            '`（首次出现在 ' + (dup.file || '(本文件)') + ':' + dup.line + '）；' +
            '游戏只保留第一份，这一份会被丢弃，换一个 subtitle'),
            [{ file: dup.file || '', line: dup.line, message: '首次使用该 subtitle 的成员' }]);
        }
      }
    }
  }

  // ---- CR-201 / CR-202 / CR-203：配对命令（§11.7 mod 级只报一次）----------
  if (pairs && modCommands && fileKey != null) {
    const cmds = [];
    for (const c of modCommands) {
      if (!c || !c.name) continue;
      if (c.file === fileKey) continue;                  // 当前文件以文本为准
      if (hasSlot(c.args || '')) continue;
      cmds.push({ name: c.name, line: c.line || 0, file: c.file || '' });
    }
    for (const node of nodes) {
      for (const c of node.commands) {
        if (hasSlot(c.args || '')) continue;
        cmds.push({ name: c.name, line: c.line || 0, file: fileKey });
      }
    }
    for (const p of pairs) {
      if (!p || !p.start || !p.end) continue;
      const starts = cmds.filter((c) => c.name === p.start);
      const ends = cmds.filter((c) => c.name === p.end);
      if (!starts.length && !ends.length) continue;
      const certain = p.certain !== false;
      const report = (step, code, occ, other, msg, severity) => {
        // 落点：mod 内相对路径排序最靠前的、含该命令的文件；只在这个文件里报一次
        const files = Array.from(new Set(occ.map((c) => c.file))).sort();
        if (!files.length || files[0] !== fileKey) return;
        const line = Math.min.apply(null, occ.filter((c) => c.file === fileKey).map((c) => c.line));
        const emitFn = severity === 'info' ? info : err;
        emitFn(step, code, line || 1, 1, loc(msg));
      };
      if (certain && starts.length && !ends.length) {
        report(6, 'Y118', starts, ends,
          '本 Mod 用了 `<<' + p.start + '>>` 共 ' + starts.length + ' 次，却没有任何 `<<' + p.end + '>>`：' +
          '游戏会留下没有收尾的状态/资源；是不是漏写了 `<<' + p.end + '>>`？');
      } else if (certain && ends.length && !starts.length) {
        report(6, 'Y120', ends, starts,
          '本 Mod 用了 `<<' + p.end + '>>`，却没有任何 `<<' + p.start + '>>`：' +
          '这个收尾没有对应的起手，可能无效甚至编译报错；是不是漏写了 `<<' + p.start + '>>`？');
      } else if (!certain && starts.length && !ends.length) {
        report(6, 'Y119', starts, ends,
          '可疑：本 Mod 用了 `<<' + p.start + '>>` 共 ' + starts.length + ' 次，没有配对的 `<<' + p.end + '>>`。' +
          '如果你确实要让它一直保持，可以忽略这条；如果这个 Mod 还没写完，也请忽略。', 'info');
      }
    }
  }

  // ---- 按 §11.3 的步序拼装，桶内按位置升序；单文档上限 500 条 ------------
  const out = [];
  for (const bucket of buckets) {
    bucket.sort((a, b) => (a.line - b.line) || (a.col - b.col) || (a.code < b.code ? -1 : a.code > b.code ? 1 : 0));
    for (const item of bucket) out.push(item);
  }
  return out.length > 500 ? out.slice(0, 500) : out;
}

/* ========================================================================== */

module.exports = { parseYarn, diagnose, listNodes, NODE_BUILTINS };
