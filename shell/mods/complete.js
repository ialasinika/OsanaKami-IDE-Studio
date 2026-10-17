'use strict';

/**
 * complete.js -- the language service the editor talks to.
 * ---------------------------------------------------------
 * Pure functions over (text, caret offset, index). No filesystem, no RPC, no
 * clock, no randomness: the same input must always produce the same output
 * (the reference spec, 03 section 11.9, calls this "suggestion determinism").
 *
 * Two entry points are meant to become two shell RPC verbs:
 *
 *   complete(text, caret, index, opts) -> {context, items, isIncomplete}
 *   hover(text, caret, index)          -> {range, kind, contents} | null
 *
 * `text` is always the *document being edited*, not the file on disk, and the
 * caret is a 0-based UTF-16 offset into it (see positions.js). Nothing here
 * writes, and nothing here may assume the document is saved.
 *
 * The candidate lists themselves are NOT duplicated here: search.js already
 * owns commands / functions / variables / nodes / characters / tags and their
 * fuzzy matching, so this file only answers "which list is the caret in?" and
 * "what exactly would be replaced?".
 */

const {
  clampOffset,
  lineStarts,
  offsetToPosition,
  lineText,
  wordAt,
} = require('./positions.js');

// Yarn's own built-in commands (`<<jump>>`, `<<set>>`, ...) are not in the
// game's knowledge base -- the game never declares them -- but they are the
// commands an author types most, so the built-in list is part of the service.
const { NODE_BUILTINS } = require('./yarn.js');

/* ---------------------------------------------------------------- contexts */

// Commands whose first argument is a node title. Kept short on purpose: the
// knowledge base stores parameter *types* as plain strings, so there is no
// machine-readable "this parameter is a node" flag to trust. These three are
// the ones the reference spec (01 section 5) names explicitly.
const NODE_ARG_COMMANDS = new Set(['jump', 'detour', 'visited', 'call']);

// `#tag:` shapes we know. The value of `#state:` is a character state; the
// others are not in our knowledge base, so they complete to nothing rather
// than to an invented list.
const TAG_SHAPES = {
  line: { value: 'line-id' },
  state: { value: 'state' },
  vo: { value: 'vo' },
  Check: { value: 'attribute' },
  Topic: { value: 'topic' },
  Modify: { value: 'variable' },
};

// `#tag` (no colon yet) -> what to insert after the tag name.
const TAG_INSERT = {
  line: 'line:',
  state: 'state:',
  vo: 'vo:',
  Check: 'Check:',
  Topic: 'Topic:',
  Modify: 'Modify:',
};

const IDENT_BEFORE = /[A-Za-z0-9_\u4e00-\u9fff]*$/;
const IDENT_AFTER = /^[A-Za-z0-9_\u4e00-\u9fff]*/;

/**
 * Describe the completion context at `caret`.
 *
 * Returned shape:
 *   {
 *     kind: 'none'|'command'|'argument'|'tag'|'tagvalue'|'variable'|'character'|'speaker',
 *     prefix:     text already typed for the candidate (without its sigil),
 *     context:    the search.js candidate context string, or '',
 *     replace:    {startOffset, endOffset} -- exactly the span the inserted text replaces,
 *     line, character,
 *     command?, argIndex?, tag?, quoted?
 *   }
 *
 * @param {string} text
 * @param {number} caret
 * @returns {object}
 */
function classify(text, caret) {
  const src = typeof text === 'string' ? text : '';
  const at = clampOffset(src, caret);
  const starts = lineStarts(src);
  const pos = offsetToPosition(src, at, starts);
  const lineStart = starts[pos.line - 1];
  const body = lineText(src, pos.line);
  const before = src.slice(lineStart, at);
  const after = src.slice(at, lineStart + body.length);
  const base = {
    kind: 'none',
    prefix: '',
    context: '',
    replace: { startOffset: at, endOffset: at },
    line: pos.line,
    character: pos.character,
  };

  // 1. Inside an unclosed <<...>> on this line? -------------------------------
  const open = before.lastIndexOf('<<');
  if (open >= 0 && before.lastIndexOf('>>') < open) {
    const inner = before.slice(open + 2);
    const wordStartLine = lineStart + open + 2;
    const lead = /^\s*/.exec(inner)[0].length;
    if (inner.trim() === '') {
      // Right after `<<`: command names, replace the empty span.
      return Object.assign(base, {
        kind: 'command',
        context: 'command',
        replace: { startOffset: wordStartLine + lead, endOffset: at + IDENT_AFTER.exec(after)[0].length },
      });
    }
    const tokens = [];
    const re = /\S+/g;
    let m;
    while ((m = re.exec(inner))) tokens.push({ text: m[0], start: m.index, end: m.index + m[0].length });
    // Caret inside the first token -> still completing the command name.
    if (tokens.length === 1 && at - (lineStart + open + 2) <= tokens[0].end) {
      const t = tokens[0];
      return Object.assign(base, {
        kind: 'command',
        context: 'command',
        prefix: t.text,
        replace: { startOffset: wordStartLine + t.start, endOffset: wordStartLine + t.end },
      });
    }
    const command = tokens.length ? tokens[0].text : '';
    // Which argument is being edited? `before` ends at the caret, so when it
    // ends with whitespace the caret sits at the start of a new argument;
    // otherwise it is inside the last token (even if that token is complete).
    const last = tokens[tokens.length - 1];
    const editingNew = /\s$/.test(inner);
    const argToken = editingNew ? null : last;
    const argIndex = editingNew ? tokens.length - 1 : tokens.length - 2;
    let prefix = argToken ? argToken.text : '';
    let start = argToken ? wordStartLine + argToken.start : at;
    let end = argToken ? wordStartLine + argToken.end : at + IDENT_AFTER.exec(after)[0].length;
    // A quoted argument: complete inside the quotes, keep them out of the range.
    let quoted = false;
    if (prefix.startsWith('"')) {
      quoted = true;
      prefix = prefix.slice(1);
      start += 1;
      if (prefix.endsWith('"')) { prefix = prefix.slice(0, -1); end -= 1; }
    }
    return Object.assign(base, {
      kind: 'argument',
      context: argumentContext(command, argIndex),
      prefix,
      replace: { startOffset: start, endOffset: Math.max(end, start) },
      command,
      argIndex,
      quoted,
    });
  }

  // 2. A #tag on this line, with no whitespace after it. ----------------------
  const hash = tagHashIndex(before);
  if (hash >= 0) {
    const tagPart = before.slice(hash + 1);
    const wordAfter = IDENT_AFTER.exec(after)[0];
    if (tagPart.indexOf(':') < 0) {
      return Object.assign(base, {
        kind: 'tag',
        context: 'tag',
        prefix: tagPart,
        replace: { startOffset: lineStart + hash + 1, endOffset: at + wordAfter.length },
      });
    }
    const colon = tagPart.indexOf(':');
    const tagName = tagPart.slice(0, colon);
    const value = tagPart.slice(colon + 1);
    const shape = TAG_SHAPES[tagName];
    if (shape) {
      return Object.assign(base, {
        kind: 'tagvalue',
        context: shape.value === 'state' ? 'state' : '',
        prefix: value,
        replace: { startOffset: lineStart + hash + 1 + colon + 1, endOffset: at + wordAfter.length },
        tag: tagName,
      });
    }
    return base;
  }

  // 3. A $variable. ----------------------------------------------------------
  const dollar = before.lastIndexOf('$');
  if (dollar >= 0 && /^[A-Za-z0-9_\u4e00-\u9fff]*$/.test(before.slice(dollar + 1))) {
    return Object.assign(base, {
      kind: 'variable',
      context: 'variable',
      prefix: before.slice(dollar + 1),
      replace: { startOffset: lineStart + dollar + 1, endOffset: at + IDENT_AFTER.exec(after)[0].length },
    });
  }

  // 4. A speaker at the start of a dialogue line (no colon typed yet). --------
  const speaker = speakerContext(before, after, lineStart);
  if (speaker) {
    return Object.assign(base, {
      kind: 'character',
      context: 'character',
      prefix: speaker.prefix,
      replace: speaker.replace,
    });
  }

  return base;
}

/**
 * Where the `#` of a tag sits if the caret is inside one, else -1.
 * A tag `#` starts the line, or follows whitespace: `text #line:` is a tag,
 * `C#` is not.
 */
function tagHashIndex(before) {
  const idx = before.lastIndexOf('#');
  if (idx < 0) return -1;
  const chBefore = idx === 0 ? '' : before[idx - 1];
  if (chBefore !== '' && !/\s/.test(chBefore)) return -1;
  // No whitespace between `#` and the caret:
  if (/\s/.test(before.slice(idx + 1))) return -1;
  return idx;
}

/**
 * Which search.js context a given argument position wants. Best effort: the
 * knowledge base does not survive the game's C# parameter types, so this knows
 * about the node-targeting commands and otherwise falls back to "no opinion".
 */
function argumentContext(command, argIndex) {
  if (argIndex !== 0) return '';
  if (NODE_ARG_COMMANDS.has(command)) return 'node';
  return '';
}

/** Speaker-name completion: only when the line so far is *just* the name. */
function speakerContext(before, after, lineStart) {
  const m = /^(\s*)([^<>#[\]$:=]*)$/.exec(before);
  if (!m) return null;
  const typed = m[2];
  // An empty line is not a speaker yet -- that would pop the list on every
  // newline. Require at least one typed character, or a following colon.
  const willBeSpeaker = /^:/.test(after) || typed.trim() !== '';
  if (!willBeSpeaker) return null;
  if (typed.trim() === '' && !/^\s*:/.test(after)) return null;
  const lead = m[1].length;
  return {
    prefix: typed.trimStart(),
    replace: {
      startOffset: lineStart + lead,
      endOffset: lineStart + lead + typed.trimStart().length,
    },
  };
}

/* --------------------------------------------------------------- completing */

/**
 * The candidate list for the caret position.
 * @param {string} text
 * @param {number} caret
 * @param {object} index  buildIndex(...) result from search.js
 * @param {{limit?:number, search?:function}} opts
 * @returns {{context:object, items:Array, isIncomplete:boolean}}
 */
function complete(text, caret, index, opts) {
  const options = opts || {};
  const ctx = classify(text, caret);
  const items = [];
  let isIncomplete = false;
  if (!index || ctx.kind === 'none') return { context: ctx, items: items, isIncomplete: false };

  const search = options.search || require('./search.js').suggest;

  if (ctx.kind === 'tagvalue' && ctx.tag === 'state') {
    // `#state:` values: the index's state list (character states from the game
    // baseline when the knowledge base carries it, our neutral list otherwise).
    const states = Array.isArray(index.emotionTags) ? index.emotionTags : [];
    const p = String(ctx.prefix || '').toLowerCase();
    for (const name of states) {
      if (p && String(name).toLowerCase().indexOf(p) !== 0) continue;
      items.push(makeItem(name, 'state', '状态 ' + name, name, ctx));
    }
    items.sort(byLabel);
    return { context: ctx, items: items.slice(0, options.limit || 200), isIncomplete: items.length > (options.limit || 200) };
  }
  if (ctx.kind === 'tagvalue') return { context: ctx, items: [], isIncomplete: false };

  const res = search(index, ctx.prefix, ctx.context, { limit: options.limit || 200 }) || {};
  isIncomplete = Boolean(res.isIncomplete);
  for (const it of Array.isArray(res.items) ? res.items : []) {
    items.push(makeItem(it.label, it.kind, it.detail, insertTextFor(ctx, it), ctx, it.documentation, it.sortText));
  }
  return { context: ctx, items: items, isIncomplete: isIncomplete };
}

/**
 * Turn the search item's insertText into what the editor should actually put
 * in the document for this context. `#line` needs its colon, a command needs a
 * trailing space so the next word starts in the argument slot, and a quoted
 * node name must not smuggle its own quotes in.
 */
function insertTextFor(ctx, item) {
  const raw = item && item.insertText != null ? String(item.insertText) : String(item.label || '');
  if (ctx.kind === 'command') return raw.replace(/\s+$/, '') + ' ';
  if (ctx.kind === 'tag') {
    const tag = String(item.label || '').replace(/^#/, '');
    if (TAG_INSERT[tag]) return TAG_INSERT[tag];
    return raw;
  }
  if (ctx.kind === 'variable') return raw.startsWith('$') ? raw : '$' + raw;
  return raw;
}

function makeItem(label, kind, detail, insertText, ctx, documentation, sortText) {
  return {
    label: String(label),
    kind: String(kind || ''),
    detail: detail == null ? '' : String(detail),
    insertText: String(insertText),
    documentation: documentation == null ? '' : String(documentation),
    sortText: sortText == null ? '' : String(sortText),
    replace: { startOffset: ctx.replace.startOffset, endOffset: ctx.replace.endOffset },
  };
}

function byLabel(a, b) {
  return a.label < b.label ? -1 : a.label > b.label ? 1 : 0;
}

/* ------------------------------------------------------------------ hovering */

/**
 * What is under the caret? Resolution order follows the reference spec (01
 * section 6): tag, then command/function, then variable, then node title, then
 * speaker. Returns null when we have nothing trustworthy to say -- an empty
 * hover is better than an invented one.
 *
 * @param {string} text @param {number} caret @param {object} index
 * @returns {null|{range:object, kind:string, name:string, contents:Array<{kind:string,value:string}>}}
 */
function hover(text, caret, index) {
  const src = typeof text === 'string' ? text : '';
  if (!index) return null;
  const at = clampOffset(src, caret);
  const starts = lineStarts(src);
  const pos = offsetToPosition(src, at, starts);
  const lineStart = starts[pos.line - 1];
  const body = lineText(src, pos.line);

  // 1. A #tag, name or value, anywhere on the hovered token.
  const tag = tagRegionAt(body, lineStart, at);
  if (tag) {
    const doc = tagDocumentation(tag.name, tag.value, index);
    if (!doc) return null;
    return {
      range: { startOffset: tag.startOffset, endOffset: tag.endOffset },
      kind: 'tag',
      name: tag.name,
      contents: [{ kind: 'markdown', value: doc }],
    };
  }

  // 2. Inside a <<command ...>> token: the command itself, or a node argument.
  const cmd = commandTokenAt(body, lineStart, at);
  if (cmd) {
    const command = findCommand(index, cmd.name);
    if (!command) return null;
    const arg = cmd.args.find((a) => at >= a.startOffset && at <= a.endOffset);
    if (arg && NODE_ARG_COMMANDS.has(command.name)) {
      const node = findNode(index, arg.text.replace(/^"|"$/g, ''));
      if (node) return nodeHover(node, arg.startOffset, arg.endOffset);
    }
    return {
      range: { startOffset: cmd.startOffset, endOffset: cmd.endOffset },
      kind: 'command',
      name: command.name,
      contents: [{ kind: 'markdown', value: markdownForCommand(command) }],
    };
  }

  const tok = tokenAt(src, at);
  if (!tok.text) return null;

  // 3. A $variable. `wordAt` keeps the `$` (it is not a word delimiter), so
  // trip it here rather than teaching the generic tokenizer about sigils.
  if (src[tok.startOffset - 1] === '$' || tok.text.charAt(0) === '$') {
    const name = tok.text.charAt(0) === '$' ? tok.text.slice(1) : tok.text;
    const startOffset = tok.text.charAt(0) === '$' ? tok.startOffset + 1 : tok.startOffset;
    const v = findVariable(index, name);
    if (!v) return null;
    return {
      range: { startOffset: startOffset, endOffset: tok.endOffset },
      kind: 'variable',
      name: v.name,
      contents: [{ kind: 'markdown', value: `**$${v.name}**\n\n变量，类型 \`${v.type || v.csType || 'unknown'}\`` }],
    };
  }

  // 4. A node title or a character name.
  const node = findNode(index, tok.text);
  if (node) return nodeHover(node, tok.startOffset, tok.endOffset);
  const ch = findCharacter(index, tok.text);
  if (ch) {
    return {
      range: { startOffset: tok.startOffset, endOffset: tok.endOffset },
      kind: 'character',
      name: ch.name,
      contents: [{ kind: 'markdown', value: `**${ch.name}**\n\n角色` + (ch.colour ? `，配色 \`${ch.colour}\`` : '') }],
    };
  }
  return null;
}

/** The word under the caret; a caret just after a word still hovers that word. */
function tokenAt(src, at) {
  let w = wordAt(src, at);
  if (!w.text && at > 0) {
    const back = wordAt(src, at - 1);
    if (back.text) w = back;
  }
  return w;
}

/**
 * The <<command args...>> token that contains t, if any. Works for closed
 * and still-open tokens (which matters while the user is typing).
 * Returns null when the caret is outside every command token on the line.
 */
function commandTokenAt(body, lineStart, at) {
  const atInLine = at - lineStart;
  if (atInLine < 0) return null;
  const open = body.lastIndexOf('<<', atInLine);
  if (open < 0) return null;
  const close = body.indexOf('>>', open + 2);
  const tokenEnd = close >= 0 ? close + 2 : body.length;
  if (atInLine < open || atInLine > tokenEnd) return null;
  const innerEnd = close >= 0 ? close : body.length;
  const inner = body.slice(open + 2, innerEnd);
  const nameMatch = /^\s*([^\s]+)/.exec(inner);
  if (!nameMatch) return null;
  const args = [];
  const re = /\S+/g;
  let m;
  let seenName = false;
  while ((m = re.exec(inner))) {
    if (!seenName) { seenName = true; continue; }
    const startOffset = lineStart + open + 2 + m.index;
    args.push({ text: m[0], startOffset: startOffset, endOffset: startOffset + m[0].length });
  }
  return {
    name: nameMatch[1],
    args: args,
    startOffset: lineStart + open,
    endOffset: lineStart + tokenEnd,
  };
}

/**
 * The #tag[:value] region containing t (as a plain code-unit offset).
 * Returns null when the caret is not inside a tag we know.
 */
function tagRegionAt(body, lineStart, at) {
  const atInLine = at - lineStart;
  if (atInLine < 0) return null;
  let hash = -1;
  for (let i = Math.min(atInLine, body.length); i >= 0; i -= 1) {
    const ch = body[i];
    if (ch === '#') {
      const prev = i === 0 ? '' : body[i - 1];
      if (prev === '' || /\s/.test(prev)) { hash = i; break; }
    }
    if (i < atInLine && ch !== undefined && /\s/.test(ch)) return null;
  }
  if (hash < 0) return null;
  let end = hash + 1;
  while (end < body.length && !/\s/.test(body[end])) end += 1;
  const region = body.slice(hash + 1, end);
  const m = /^([A-Za-z]+):(.*)$/.exec(region);
  if (!m || !TAG_SHAPES[m[1]]) return null;
  return {
    name: m[1],
    value: m[2],
    startOffset: lineStart + hash + 1,
    endOffset: lineStart + end,
  };
}

function nodeHover(node, startOffset, endOffset) {
  return {
    range: { startOffset: startOffset, endOffset: endOffset },
    kind: 'node',
    name: node.title,
    contents: [{ kind: 'markdown', value: `**${node.title}**\n\n节点，定义在 \`${node.file}\`` }],
  };
}

/* ---------------------------------------------------------------- lookups */

function lower(v) { return String(v == null ? '' : v).toLowerCase(); }

function findCommand(index, name) {
  const n = lower(name);
  if (!n) return null;
  if (Array.isArray(index.commands)) {
    const hit = index.commands.find((c) => lower(c.name) === n);
    if (hit) return hit;
  }
  if (NODE_BUILTINS && NODE_BUILTINS.has && NODE_BUILTINS.has(name)) {
    return { name: name, parameters: [], documentation: '', source: '', builtin: true };
  }
  return null;
}

function findVariable(index, name) {
  const n = lower(name);
  if (!n || !Array.isArray(index.variables)) return null;
  return index.variables.find((v) => lower(String(v.name).replace(/^\$/, '')) === n) || null;
}

function findNode(index, title) {
  const n = lower(title);
  if (!n || !Array.isArray(index.nodes)) return null;
  return index.nodes.find((x) => lower(x.title) === n) || null;
}

function findCharacter(index, name) {
  const n = lower(name);
  if (!n || !Array.isArray(index.characters)) return null;
  return index.characters.find((c) => lower(c.name) === n) || null;
}

function markdownForCommand(cmd) {
  const params = Array.isArray(cmd.parameters) ? cmd.parameters : [];
  const lines = [`**<<${cmd.name}>>**`];
  if (cmd.documentation) lines.push('', String(cmd.documentation));
  if (params.length) {
    lines.push('', '参数：');
    for (const p of params) {
      const opt = p.optional ? '（可选）' : '';
      const rest = p.isParamsArray ? '…' : '';
      lines.push(`- \`${p.name}: ${p.type}${rest}\`${opt}`);
    }
  }
  if (cmd.source) lines.push('', `定义在 \`${cmd.source}\``);
  return lines.join('\n');
}

function tagDocumentation(name, value, index) {
  const tag = String(name || '');
  if (!tag) return '';
  if (TAG_SHAPES[tag] == null && tag !== 'line') return '';
  const head = `**#${tag}${value ? ':' : ':'}**`;
  switch (tag) {
    case 'line':
      return `${head}\n\n台词行标识（line id），与本地化表对应。每行的 id 在同一文件内必须唯一。`;
    case 'state':
      return `${head}\n\n角色状态名。${value ? `\n\n当前值 \`${value}\`${stateKnown(index, value) ? '' : '（知识库里没有这个状态名）'}` : ''}`;
    case 'vo':
      return `${head}\n\n语音（voice over）名，指向 Defines/VoiceOverDefinition。`;
    case 'Check':
      return `${head}\n\n条件检查，写法与 \`<<if>>\` 一致。`;
    case 'Topic':
      return `${head}\n\n话题名，指向 Defines/Topic。`;
    case 'Modify':
      return `${head}\n\n变量修改。`;
    default:
      return '';
  }
}

function stateKnown(index, value) {
  const states = Array.isArray(index.emotionTags) ? index.emotionTags : [];
  return states.some((s) => lower(s) === lower(value));
}

module.exports = {
  classify,
  complete,
  hover,
  NODE_ARG_COMMANDS,
  TAG_SHAPES,
  TAG_INSERT,
};
