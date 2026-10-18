import { HERE, require, KNOWLEDGE_PATH, check, section, characters } from "./foundation.mjs";
import { hit } from "./corpus.mjs";
import { kernelCalls, kernel, frame } from "./dispatch.mjs";
import { spawn, spawnSync } from "node:child_process";
import { createRequire } from "node:module";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

section("language service: completion and hover");
{
  const search = require(join(HERE, "search.js"));
  const lang = require(join(HERE, "complete.js"));
  const index = search.buildIndex(JSON.parse(readFileSync(KNOWLEDGE_PATH, "utf8")), {});
  const eq = (name, actual, expected) => check(name, JSON.stringify(actual) === JSON.stringify(expected),
    `got ${JSON.stringify(actual)}, want ${JSON.stringify(expected)}`);
  const at = (text) => text.length;
  const labels = (result, n) => result.items.slice(0, n || 5).map((i) => i.label);

  {
    const text = "<<jum";
    const ctx = lang.classify(text, at(text));
    eq("a command context", ctx.kind, "command");
    eq("its prefix", ctx.prefix, "jum");
    eq("its replace range", [ctx.replace.startOffset, ctx.replace.endOffset], [2, 5]);
    const result = lang.complete(text, at(text), index);
    check("it offers jump", labels(result, 30).includes("jump"), JSON.stringify(labels(result, 30)));
    const jump = result.items.find((i) => i.label === "jump");
    check("a command inserts with a trailing space", jump && jump.insertText === "jump ", JSON.stringify(jump && jump.insertText));
  }
  {
    const text = "<<jum>>";
    eq("mid-word replaces only the word", [lang.classify(text, 5).replace.startOffset, lang.classify(text, 5).replace.endOffset], [2, 5]);
  }
  {
    const text = "<<jump ";
    const ctx = lang.classify(text, at(text));
    eq("an argument context", ctx.kind, "argument");
    eq("the command it belongs to", ctx.command, "jump");
    eq("the argument index", ctx.argIndex, 0);
    eq("a node-name argument", ctx.context, "node");
    const result = lang.complete(text, at(text), index);
    check("arguments come back as labelled items", result.items.length > 0 && result.items.every((i) => typeof i.label === "string"));
  }
  {
    const text = '<<jump "Init';
    const ctx = lang.classify(text, at(text));
    eq("a quoted argument is still an argument", ctx.kind, "argument");
    eq("the quote is not part of the prefix", ctx.prefix, "Init");
    eq("the replace range stays inside the quotes", [ctx.replace.startOffset, ctx.replace.endOffset], [8, 12]);
    const result = lang.complete(text, at(text), index);
    check("a quoted prefix matches a node", result.items.some((i) => i.label === "Initial"), JSON.stringify(labels(result, 5)));
  }
  {
    const text = "<<AdvanceTime ";
    eq("a builtin with no known argument context", lang.classify(text, at(text)).context, "");
    eq("so it offers nothing", lang.complete(text, at(text), index).items.length, 0);
  }
  {
    const text = "#sta";
    const ctx = lang.classify(text, at(text));
    eq("a tag context", ctx.kind, "tag");
    eq("its prefix", ctx.prefix, "sta");
    const result = lang.complete(text, at(text), index);
    check("it offers state", labels(result, 10).includes("state"), JSON.stringify(labels(result, 10)));
    const state = result.items.find((i) => i.label === "state");
    eq("a tag inserts its colon", state && state.insertText, "state:");
  }
  {
    const text = "Warden: hi #line";
    const ctx = lang.classify(text, at(text));
    eq("a tag after text", ctx.kind, "tag");
    eq("and its prefix", ctx.prefix, "line");
  }
  {
    check("C# is not a tag", lang.classify("See C#", 6).kind === "none");
  }
  {
    const text = "#state:";
    const ctx = lang.classify(text, at(text));
    eq("a tag value context", ctx.kind, "tagvalue");
    eq("the tag it belongs to", ctx.tag, "state");
    eq("its values are the index's state names",
      lang.complete(text, at(text), index).items.length, (index.emotionTags || []).length);
  }
  {
    const text = "#state:Cal";
    const ctx = lang.classify(text, at(text));
    eq("a tag value prefix", ctx.prefix, "Cal");
    eq("and its replace range ends at the caret", ctx.replace.endOffset, 10);
  }
  {
    const text = "#vo:";
    const ctx = lang.classify(text, at(text));
    eq("#vo is a tag value with no index behind it", [ctx.kind, ctx.tag, ctx.context], ["tagvalue", "vo", ""]);
    eq("so it offers nothing", lang.complete(text, at(text), index).items.length, 0);
  }
  {
    const text = "  $Achi";
    const ctx = lang.classify(text, at(text));
    eq("a variable context", ctx.kind, "variable");
    eq("its prefix", ctx.prefix, "Achi");
    const result = lang.complete(text, at(text), index);
    const hit = result.items.find((i) => String(i.label).toLowerCase() === "achievement_sooooboring");
    check("a variable inserts with its real casing and a dollar", hit && hit.insertText === "$Achievement_SOOOOBORING", hit && hit.insertText);
  }
  {
    const known = index.characters[0].name;
    const text = known.slice(0, 2);
    const ctx = lang.classify(text, at(text));
    eq("a speaker context", ctx.kind, "character");
    eq("its prefix is what was typed", ctx.prefix, text);
    const result = lang.complete(text, at(text), index);
    check("the speaker is offered", labels(result, 30).includes(known), JSON.stringify(labels(result, 30)));
  }
  {
    const text = "Ward: hello";
    const ctx = lang.classify(text, 4);
    eq("a speaker mid-line", ctx.kind, "character");
    eq("with the name typed so far", ctx.prefix, "Ward");
  }
  {
    eq("an empty line is not a speaker", lang.classify("", 0).kind, "none");
  }
  {
    const text = "<<jum";
    check("a partial command has no hover", lang.hover(text, at(text), index) === null);
  }
  {
    const text = "<<jump>>";
    const hover = lang.hover(text, 4, index);
    check("a command hovers", hover && hover.kind === "command", JSON.stringify(hover && hover.kind));
    check("the hover says the command's name", hover && hover.contents[0].value.includes("jump"), hover && hover.contents[0].value.slice(0, 40));
  }
  {
    const text = "$Achievement_SOOOOBORING";
    const hover = lang.hover(text, 4, index);
    check("a variable hovers", hover && hover.kind === "variable", JSON.stringify(hover && hover.kind));
    check("the hover says the variable's type", hover && hover.contents[0].value.includes("bool"), hover && hover.contents[0].value);
  }
  {
    const hover = lang.hover("#state:", 3, index);
    check("a tag hovers", hover && hover.kind === "tag" && hover.name === "state", JSON.stringify(hover && hover.name));
  }
  {
    const hover = lang.hover("A sentence with Initial inside it.", 17, index);
    check("a node name in prose hovers", hover && hover.kind === "node", JSON.stringify(hover && hover.kind));
  }
  {
    const text = "<<";
    const first = JSON.stringify(lang.complete(text, at(text), index));
    const second = JSON.stringify(lang.complete(text, at(text), index));
    check("completion is deterministic", first === second);
    check("completion is bounded", lang.complete(text, at(text), index).items.length <= 200,
      String(lang.complete(text, at(text), index).items.length));
  }
  {
    eq("a closed command is not a command context", lang.classify("<<jump>>", 8).kind, "none");
  }
  {
    const text = "title: X\r\n---\r\n<<jum";
    const ctx = lang.classify(text, at(text));
    eq("a CRLF document still finds the command", ctx.kind, "command");
    eq("on the right line", ctx.line, 3);
    eq("with the right prefix", ctx.prefix, "jum");
  }
}

/*
 * 两个 shell 动词：`mod.complete` 与 `mod.hover`。光标是正在编辑的文档上的
 * 0-based UTF-16 偏移（positions.js 的定义），文档本身不必保存过 —— 编辑器
 * 拿内存里的文本直接问，动词不读盘。
 */
section("language service: the two shell verbs");
{
  const text = "title: Probe\n---\n<<jum";
  const answered = await frame(41, "mod.complete", { text, caret: text.length });
  check("mod.complete answers with a context and items, not a bare array",
    answered.error === undefined && answered.result !== undefined
      && answered.result.context.kind === "command"
      && answered.result.context.prefix === "jum"
      && Array.isArray(answered.result.items),
    JSON.stringify(answered).slice(0, 160));

  const jump = answered.result && answered.result.items.find((i) => i.label === "jump");
  check("an item carries what the editor has to replace and insert",
    jump !== undefined && jump.insertText === "jump "
      && typeof jump.replace.startOffset === "number" && jump.replace.startOffset < jump.replace.endOffset,
    JSON.stringify(jump));

  check("the context counts lines of the document it was given, not of a file",
    answered.result.context.line === 3 && answered.result.context.character === 5,
    JSON.stringify(answered.result.context));

  check("isIncomplete is part of the answer", answered.result.isIncomplete === false,
    String(answered.result.isIncomplete));

  const hovered = await frame(42, "mod.hover", { text: "<<jump X>>", caret: 3 });
  check("mod.hover names the token under the caret",
    hovered.error === undefined && hovered.result !== null
      && hovered.result.kind === "command" && hovered.result.name === "jump",
    JSON.stringify(hovered.result && hovered.result.kind));

  const silent = await frame(43, "mod.hover", { text: "zz", caret: 2 });
  check("nothing under the caret is null, not an invented answer",
    silent.result === null && silent.error === undefined, JSON.stringify(silent).slice(0, 120));

  const defaults = await frame(44, "mod.complete", {});
  check("missing text and caret default to an empty document, not INVALID_PARAMS",
    defaults.error === undefined && defaults.result.context.kind === "none" && defaults.result.items.length === 0,
    JSON.stringify(defaults).slice(0, 140));

  const noParams = await frame(45, "mod.hover", {});
  check("mod.hover with no document is null too",
    noParams.result === null && noParams.error === undefined, JSON.stringify(noParams).slice(0, 120));

  const again = await frame(46, "mod.complete", { text, caret: text.length });
  check("the same document and caret give the same answer",
    JSON.stringify(again.result) === JSON.stringify(answered.result));

  check("neither verb reached the kernel", kernelCalls === 0, String(kernelCalls));
}

/* ------------------------------------------------------------------ */
/* G50: mod.newFile — 在一个已有的包里按类型新建一个文件               */
/* ------------------------------------------------------------------ */

/*
 * 这个动词的输入是（目录, 类型, 名字），输出是一个真实存在、并且包校验器认
 * 为干净的文件。写盘/覆盖/拒绝的行为都在临时沙盒里跑，不碰语料、不碰仓库。
 *
 * 为什么每个 kind 都要看内容而不只是看路径：编辑器下一步是「把新文件打开给
 * 人编辑」，一个空文件或一个解析不了的故事等于没生成。
 */
