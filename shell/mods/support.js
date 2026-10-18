'use strict';
/**
 * support.js — wiki 的类型支持矩阵（G4）
 *
 * 游戏本体的 `knowledge.json` 是从类型系统倒出来的：它知道 51 种类型长什么样，
 * 但不知道哪一种 Mod 真的能用。这个模块把那半句话补上——`support.json` 是人工
 * 从 wiki [e.Mod结构与限制](https://wiki.infantgod.xyz/e.Mod结构与限制) 抄下来的
 * 矩阵，回答两个问题：
 *
 *   1. 这个类型的定义在游戏里会被消费吗？（supported / partial / unsupported / unknown）
 *   2. 由哪个 manager 消费？（“注册 ≠ 生效”的那条链子）
 *
 * 知识库仍是 `knowledge.json`；本文件只补一列“游戏认不认”，所以它跟知识库分开放，
 * 不参与 G5 的再生流程（wiki 的事实无法从游戏程序集里自动导出）。
 *
 * 只依赖 Node 内置模块，CommonJS。
 *
 *   forType(type)      -> { level, manager?, note? } | null
 *   table()            -> { [type]: { level, manager?, note? } }
 *   levels()           -> ['supported', 'partial', 'unsupported', 'unknown']
 *   managers()         -> 11 个消费 ModRegistry 的 manager 名
 *   wiki()             -> 来源 URL
 *   diagnosticFor(type)-> { severity, code, message, messageEn } | null（供校验器用）
 */

const fs = require('fs');
const path = require('path');

const DATA_PATH = path.join(__dirname, 'support.json');
const LEVELS = ['supported', 'partial', 'unsupported', 'unknown'];

/** 缓存解析结果；文件坏了就退化成空矩阵（校验器因此静默跳过，不误报）。 */
let cached = null;

function load() {
  if (cached) return cached;
  let data = null;
  try {
    data = JSON.parse(fs.readFileSync(DATA_PATH, 'utf8'));
  } catch {
    data = null;
  }
  const types = data && data.types && typeof data.types === 'object' ? data.types : {};
  cached = {
    types: types,
    levels: data && data.levels && typeof data.levels === 'object' ? data.levels : {},
    managers: data && Array.isArray(data.managers) ? data.managers.slice() : [],
    wiki: data && typeof data.wiki === 'string' ? data.wiki : ''
  };
  return cached;
}

/** 全部类型 → { level, manager?, note? }（没有矩阵时是 {}）。 */
function table() {
  return load().types;
}

/** 一个类型的矩阵条目；未知类型返回 null（调用方自己决定要不要报）。 */
function forType(type) {
  const types = table();
  const key = type == null ? '' : String(type);
  return Object.prototype.hasOwnProperty.call(types, key) ? types[key] : null;
}

/** 四个支持档位，按从“最能用”到“最不能用”排序。 */
function levels() {
  return LEVELS.slice();
}

/** 11 个确实合并 ModRegistry 的 manager（wiki“注册成功不等于可用”一节）。 */
function managers() {
  return load().managers.slice();
}

/** 事实来源。 */
function wiki() {
  return load().wiki;
}

/* ================================================================== *
 * 校验器用的诊断载荷
 * ================================================================== */

/**
 * 类型级诊断。每个包每种类型只由调用方装一次（一包 22 个不支持类型不会刷 22 条
 * 同义警告）；单文件校验则每次一份。
 *
 * 返回 null 表示这个类型不需要报：supported 不报，unknown 也不报——wiki 没表态的
 * 类型，编辑器没有资格替它下结论。
 */
function diagnosticFor(type) {
  const entry = forType(type);
  if (!entry) return null;
  const name = String(type);

  if (entry.level === 'unsupported') {
    return {
      severity: 'warning',
      code: 'M013',
      message: '定义类型 "' + name + '" 在游戏里不会被消费：wiki 把它列在“当前不适合独立扩展”' +
        '（能注册进 ModRegistry，但没有 manager 读取它），所以这个文件在游戏里不会生效。',
      messageEn: 'The game never consumes "' + name + '" definitions from mods: the wiki lists it ' +
        'under "not suitable for independent expansion" (it registers in ModRegistry, but no ' +
        'manager reads it), so this file has no effect in the game.'
    };
  }

  if (entry.level === 'partial') {
    const who = entry.manager ? '，消费者：' + entry.manager : '';
    const note = entry.note ? ' ' + entry.note : '';
    return {
      severity: 'info',
      code: 'M014',
      message: '定义类型 "' + name + '" 只被部分支持' + who + '。' + note,
      messageEn: 'Only part of "' + name + '" is consumed from mods' +
        (entry.manager ? ' (consumer: ' + entry.manager + ')' : '') +
        '.' + (entry.note ? ' ' + entry.note : '')
    };
  }

  return null;
}

module.exports = {
  DATA_PATH: DATA_PATH,
  forType: forType,
  table: table,
  levels: levels,
  managers: managers,
  wiki: wiki,
  diagnosticFor: diagnosticFor
};
