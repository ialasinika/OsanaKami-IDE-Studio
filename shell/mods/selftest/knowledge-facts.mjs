import { HERE, ROOT, require, createMods, KNOWLEDGE_PATH, checks, check, section, stats, characters } from "./foundation.mjs";
import { hit, specTemp, specWrite } from "./corpus.mjs";
import { spawn, spawnSync } from "node:child_process";
import { createRequire } from "node:module";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

section("the knowledge generator (tools/gen_knowledge.mjs)");

{
  const gen = join(ROOT, "tools", "gen_knowledge.mjs");
  const fixtureRoot = join(ROOT, "build", "knowledge-fixture");
  const gameDir = join(fixtureRoot, "game");
  const outPath = join(fixtureRoot, "committed.json");
  rmSync(fixtureRoot, { recursive: true, force: true });

  /*
   * 自造的迷你游戏树：两个 schema、一个基线定义、一个 Yarn 文件、一份 CSV。
   * 里面故意放了 description 和 #region 式的文档文本，用来证明它们会被丢掉；
   * 角色表根本不在生成物里。fixture 在 build/ 下（gitignored 的草稿区）。
   */
  specWrite(join(gameDir, "SODefines", "Schema", "Demo.schema.json"), JSON.stringify({
    type: "object", description: "documentation that must not ship",
    properties: {
      techName: { type: "string" },
      hp: { type: "number", description: "also stripped" },
      portrait: { type: "string", description: "Relative path to sprite image file (png)" },
      friend: { type: "string", description: "TechName reference to OtherDefinition" },
    },
  }, null, 2));
  specWrite(join(gameDir, "SODefines", "Schema", "Other.schema.json"), JSON.stringify({
    type: "object", properties: { techName: { type: "string" } },
  }, null, 2));
  specWrite(join(gameDir, "SODefines", "Defines", "Demo", "Hero.json"), JSON.stringify({
    techName: "Demo_Hero", description: "stripped too", hp: 3,
  }, null, 2));
  specWrite(join(gameDir, "MyMod", "Yarn", "Logic", "Demo.yarn"), [
    "title: Demo_Start",
    "tags: #hub",
    "---",
    "<<declare $Visits = 0>>",
    "<<set $Visits += 1>>",
    "Demo_Hero: 早。 #line:0abcdef #state:Idle",
    "<<if $Visits > 1>>",
    "<<jump Demo_Hub>>",
    "<<endif>>",
    "===",
    "",
  ].join("\n"));
  specWrite(join(gameDir, "MyMod", "Yarn", "NewProject.csv"),
    "language,id,text,file,node,lineNumber,lock,comment\nzh-CN,line:0abcdef,早,Demo.yarn,Demo_Start,6,,\n");

  const mod = await import(pathToFileURL(gen).href);
  const kb = mod.buildKnowledge(gameDir);
  check("the generator reads schemas, baseline, yarn and locales from a game tree",
    Object.keys(kb.schemas).length === 2 && kb.baseline.Demo.includes("Demo_Hero") &&
    kb.stats.yarnFiles === 1 && kb.localization.baseLanguage === "zh-CN",
    JSON.stringify({ stats: kb.stats, base: kb.localization.baseLanguage }));
  check("no documentation text survives into the knowledge base",
    !JSON.stringify(kb).includes('"description"'), "a description key survived");
  /*
   * G41: the two facts that sentence-shaped descriptions encode must survive the
   * text.  If they do not, regenerating the KB silently empties the reference and
   * sprite checks and `ok:true` starts meaning "nothing was looked at".
   */
  check("a description naming a TechName reference leaves the reference behind as a fact",
    kb.schemas.Demo.properties.friend["x-techReference"] === "OtherDefinition",
    JSON.stringify(kb.schemas.Demo.properties.friend));
  check("a description naming a sprite path leaves the flag behind as a fact",
    kb.schemas.Demo.properties.portrait["x-sprite"] === true,
    JSON.stringify(kb.schemas.Demo.properties.portrait));
  check("and neither sentence itself survives",
    !JSON.stringify(kb).includes("Relative path to sprite image file") &&
    !JSON.stringify(kb).includes("TechName reference to"),
    "a description sentence survived");
  check("the character table is not generated at all",
    kb.characters === undefined, JSON.stringify(Object.keys(kb)));

  const run = spawnSync(process.execPath, [gen, "--game-dir", gameDir, "--out", outPath], { encoding: "utf8" });
  check("the CLI writes a knowledge base", run.status === 0 && existsSync(outPath), run.stderr || run.stdout);

  /* --schema-dir / --defines-dir 必须真的被读到：把 schema 指到另一个目录。 */
  specWrite(join(fixtureRoot, "extra-schema", "Extra.schema.json"), JSON.stringify({
    type: "object", properties: { techName: { type: "string" } },
  }, null, 2));
  const dirsOut = join(fixtureRoot, "dirs.json");
  const dirsRun = spawnSync(process.execPath, [gen, "--game-dir", gameDir,
    "--schema-dir", join(fixtureRoot, "extra-schema"),
    "--defines-dir", join(gameDir, "SODefines", "Defines"),
    "--out", dirsOut], { encoding: "utf8" });
  const dirsKb = existsSync(dirsOut) ? JSON.parse(readFileSync(dirsOut, "utf8")) : null;
  check("--schema-dir/--defines-dir name the two subdirectories directly",
    dirsRun.status === 0 && dirsKb !== null &&
    Object.keys(dirsKb.schemas).join(",") === "Extra" && dirsKb.baseline.Demo.includes("Demo_Hero"),
    dirsRun.stderr || dirsRun.stdout);
  const greenCheck = spawnSync(process.execPath, [gen, "--game-dir", gameDir, "--check", outPath], { encoding: "utf8" });
  check("--check is green against the file the generator just wrote", greenCheck.status === 0,
    JSON.stringify({ status: greenCheck.status, out: (greenCheck.stdout || "").trim().slice(-200) }));

  /*
   * --diff only describes the gap between the committed file and a facts-only
   * generation (the committed file came from an older, richer extractor), so it
   * always exits 0 -- unlike --check.  The fixture is used here because it is
   * the one committed file we can regenerate exactly.
   */
  const diffGreen = spawnSync(process.execPath, [gen, "--game-dir", gameDir, "--diff", outPath], { encoding: "utf8" });
  check("--diff describes an agreeing committed file and still exits 0",
    diffGreen.status === 0 &&
    /只在已提交 KB/.test(diffGreen.stdout || "") &&
    /只在生成版/.test(diffGreen.stdout || "") &&
    ["commands", "functions", "variables", "nodes"].every((name) =>
      new RegExp(`^\\s+${name}\\s`, "m").test(diffGreen.stdout || "")),
    JSON.stringify({ status: diffGreen.status, out: (diffGreen.stdout || "").trim().slice(-240) }));

  const drifted = JSON.parse(readFileSync(outPath, "utf8"));
  drifted.commands.push({ name: "Ghost_Cmd", parameters: [], usage: 0 });
  drifted.nodes = drifted.nodes.filter((node) => node.title !== "Demo_Start");
  const driftedPath = join(fixtureRoot, "drifted-committed.json");
  writeFileSync(driftedPath, JSON.stringify(drifted) + "\n");
  const diffDrift = spawnSync(process.execPath, [gen, "--game-dir", gameDir, "--diff", driftedPath], { encoding: "utf8" });
  check("--diff names what only the committed KB has, and what only the generated copy has",
    diffDrift.status === 0 &&
    /只在已提交 KB 里（1 个）：Ghost_Cmd/.test(diffDrift.stdout || "") &&
    /只在生成版里（1 个）：Demo_Start/.test(diffDrift.stdout || ""),
    JSON.stringify({ status: diffDrift.status, out: (diffDrift.stdout || "").trim().slice(-280) }));

  const diffMissing = spawnSync(process.execPath, [gen, "--game-dir", gameDir, "--diff", join(fixtureRoot, "no-such-kb.json")], { encoding: "utf8" });
  check("--diff with no readable committed file exits 2", diffMissing.status === 2,
    JSON.stringify({ status: diffMissing.status }));

  /*
   * G37 残余：--out 默认不得把「更富」的 KB（带 documentation / 参数名 / returnType）
   * 静默换成 facts-only 版；加 --force 才允许。这里刻意造一份富 KB 当靶子。
   */
  const rich = JSON.parse(readFileSync(outPath, "utf8"));
  rich.commands.push({
    name: "GetTopic", parameters: [{ name: "topicTechName", type: "string" }],
    returnType: "number", documentation: "rich text that facts-only output would drop", usage: 26,
  });
  const richPath = join(fixtureRoot, "rich.json");
  const richText = JSON.stringify(rich) + "\n";
  writeFileSync(richPath, richText);
  const guarded = spawnSync(process.execPath, [gen, "--game-dir", gameDir, "--out", richPath], { encoding: "utf8" });
  check("--out refuses to overwrite a richer knowledge base with a facts-only one",
    guarded.status === 2 &&
    /拒绝覆盖更富的知识库/.test(guarded.stderr || "") &&
    /--force/.test(guarded.stderr || "") &&
    readFileSync(richPath, "utf8") === richText,
    JSON.stringify({ status: guarded.status, err: (guarded.stderr || "").trim().slice(-200) }));
  const forced = spawnSync(process.execPath, [gen, "--game-dir", gameDir, "--out", richPath, "--force"], { encoding: "utf8" });
  const forcedKb = existsSync(richPath) ? JSON.parse(readFileSync(richPath, "utf8")) : null;
  check("--force allows the overwrite and the result is facts-only",
    forced.status === 0 && forcedKb !== null && mod.documentationDensity(forcedKb) === 0,
    JSON.stringify({ status: forced.status, density: forcedKb && mod.documentationDensity(forcedKb),
      err: (forced.stderr || "").trim().slice(-160) }));
  check("a facts-only file is not treated as rich (the guard does not block normal regeneration)",
    mod.outOverwriteRefusal(richPath, kb) === null &&
    mod.documentationDensity(kb) === 0 &&
    mod.outOverwriteRefusal(join(fixtureRoot, "absent.json"), kb) === null,
    JSON.stringify({ density: mod.documentationDensity(kb), refusal: mod.outOverwriteRefusal(richPath, kb) }));

  /*
   * G37 的另一半：显式给出的目录无效时直接报错，且文案要说明「回退被显式设置关闭」。
   */
  const lostSchema = join(fixtureRoot, "no-schema-dir");
  const lostSchemaRun = spawnSync(process.execPath, [gen, "--game-dir", gameDir,
    "--schema-dir", lostSchema, "--out", join(fixtureRoot, "never-schema.json")], { encoding: "utf8" });
  check("a missing explicit --schema-dir is an error that says the fallback was disabled",
    lostSchemaRun.status === 2 &&
    /指定的目录不存在/.test(lostSchemaRun.stderr || "") &&
    /显式设置已关闭自动回退/.test(lostSchemaRun.stderr || "") &&
    /不会再改用 <game-dir>\/SODefines\/Schema。/.test(lostSchemaRun.stderr || "") &&
    !existsSync(join(fixtureRoot, "never-schema.json")),
    JSON.stringify({ status: lostSchemaRun.status, err: (lostSchemaRun.stderr || "").trim().slice(-220) }));
  const lostDefinesRun = spawnSync(process.execPath, [gen, "--game-dir", gameDir,
    "--defines-dir", join(fixtureRoot, "no-defines-dir"), "--out", join(fixtureRoot, "never-defines.json")], { encoding: "utf8" });
  check("a missing explicit --defines-dir gets the same wording",
    lostDefinesRun.status === 2 &&
    /显式设置已关闭自动回退/.test(lostDefinesRun.stderr || "") &&
    /不会再改用 <game-dir>\/SODefines\/Defines。/.test(lostDefinesRun.stderr || ""),
    JSON.stringify({ status: lostDefinesRun.status, err: (lostDefinesRun.stderr || "").trim().slice(-220) }));

  specWrite(join(gameDir, "SODefines", "Defines", "Demo", "Extra.json"), JSON.stringify({ techName: "Demo_Extra" }, null, 2));
  const redCheck = spawnSync(process.execPath, [gen, "--game-dir", gameDir, "--check", outPath], { encoding: "utf8" });
  check("--check goes red when a fact drifted and names the section",
    redCheck.status === 1 && /baseline/.test(redCheck.stdout || ""),
    JSON.stringify({ status: redCheck.status, out: (redCheck.stdout || "").trim().slice(-200) }));

  const noGame = spawnSync(process.execPath, [gen, "--game-dir", join(fixtureRoot, "nope"), "--out", join(fixtureRoot, "never.json")], { encoding: "utf8" });
  check("with no game directory the generator exits 2 and writes nothing",
    noGame.status === 2 && !existsSync(join(fixtureRoot, "never.json")),
    JSON.stringify({ status: noGame.status, err: (noGame.stderr || "").trim().slice(-160) }));
  check("an invalid explicit --game-dir says the fallback was turned off by the explicit setting",
    /显式给出的 --game-dir 无效/.test(noGame.stderr || "") && /回退被显式设置关闭/.test(noGame.stderr || ""),
    JSON.stringify({ err: (noGame.stderr || "").trim().slice(-200) }));
}

/* ------------------------------------------------------------------ */
/* a regenerated knowledge base still knows the fields it checks      */
/* ------------------------------------------------------------------ */

section("a facts-only knowledge base keeps the fields the checker looks at");

{
  const validate = require(join(HERE, "validate.js"));
  const factsOnly = {
    schemas: {
      Hero: {
        type: "object",
        properties: {
          portrait: { type: "string", "x-sprite": true },
          friend: { type: "string", "x-techReference": "OtherDefinition" },
        },
      },
      Other: { type: "object", properties: { techName: { type: "string" } } },
    },
  };
  const rich = {
    schemas: {
      Hero: {
        type: "object",
        properties: {
          portrait: { type: "string", description: "Relative path to sprite image file (png)" },
          friend: { type: "string", description: "TechName reference to OtherDefinition" },
        },
      },
      Other: { type: "object", properties: { techName: { type: "string" } } },
    },
  };
  const factsMap = validate.referenceMap(factsOnly.schemas);
  const richMap = validate.referenceMap(rich.schemas);
  check("the sprite and reference fields survive in a facts-only knowledge base",
    factsMap.Hero.portrait === "sprite" && factsMap.Hero.friend === "Other",
    JSON.stringify(factsMap));
  check("a rich KB and a facts-only KB describe the same fields",
    JSON.stringify(factsMap) === JSON.stringify(richMap),
    JSON.stringify({ factsMap, richMap }));
  const stripped = {
    schemas: {
      Hero: { type: "object", properties: { portrait: { type: "string" }, friend: { type: "string" } } },
      Other: rich.schemas.Other,
    },
  };
  check("with neither the fact nor the sentence there is nothing to check, and the map is empty",
    Object.keys(validate.referenceMap(stripped.schemas).Hero).length === 0,
    JSON.stringify(validate.referenceMap(stripped.schemas)));
  const summary = validate.schemaSummary(factsOnly);
  check("schemaSummary lists the same sprite path",
    summary.find((s) => s.type === "Hero").sprites.join(",") === "portrait",
    JSON.stringify(summary.map((s) => [s.type, s.sprites])));

  /*
   * 派生出来的知识库只有事实键。校验必须认它们，否则「没有发布物知识库」的机器
   * 上 D005/D006 会静默消失，ok:true 又会变成「什么都没看」。
   */
  const factsKbFile = specWrite(join(specTemp("infantgod-facts-kb-"), "knowledge.json"), JSON.stringify({
    version: 1, stats: {}, commands: [], functions: [], variables: [], nodes: [],
    schemas: factsOnly.schemas, baseline: { Other: ["Exists"] },
    localization: { locales: [], characters: [] },
    undocumentedCommands: [], undeclaredVariables: [],
  }, null, 2) + "\n");
  const factsPkg = join(specTemp("infantgod-facts-mod-"), "FactsOnlyMod");
  specWrite(join(factsPkg, "mod.json"), JSON.stringify({
    name: "FactsOnlyMod", version: "1.0.0", gameVersion: "1.0", loadOrder: 5,
    author: "selftest", description: "a package checked against a facts-only knowledge base",
  }, null, 2) + "\n");
  specWrite(join(factsPkg, "Defines", "Hero", "Probe.json"), JSON.stringify({
    techName: "Hero_Probe", portrait: "Sprites/Missing.png", friend: "No_Such_Other",
  }, null, 2) + "\n");
  const factsMods = createMods({ knowledgePath: factsKbFile, gameModsDir: join(factsPkg, "no-game") });
  const factsReport = factsMods.validatePackage({ root: factsPkg });
  check("a facts-only knowledge base still runs D006 and D005",
    factsReport.diagnostics.some((d) => d.code === "D006") &&
    factsReport.diagnostics.some((d) => d.code === "D005"),
    JSON.stringify(factsReport.diagnostics.map((d) => d.code)));
}

/* ------------------------------------------------------------------ */
/* the acceptance grep: nothing under shell/ names a machine           */
/* ------------------------------------------------------------------ */

section("nothing shipped under shell/ names a machine");

{
  const hits = [];
  const WALK_SKIP = new Set(["node_modules", ".git"]);
  const walk = (dir) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (WALK_SKIP.has(entry.name) || entry.name.startsWith(".")) continue;
      const abs = join(dir, entry.name);
      if (entry.isDirectory()) { walk(abs); continue; }
      if (!/\.(js|mjs|cjs|json|html|css|md|txt|yarn|yarnproject|csv|py|sh|bat|ps1|nsi)$/i.test(entry.name)) continue;
      const text = readFileSync(abs, "utf8");
      const hit = text.match(/[A-Za-z]:[\\/]Users[\\/]|\/Users\/[A-Za-z0-9._-]/);
      if (hit) hits.push(abs.slice(ROOT.length + 1) + " -> " + hit[0]);
    }
  };
  walk(join(ROOT, "shell"));
  check("no shipped file under shell/ contains an absolute path into a user profile",
    hits.length === 0, hits.slice(0, 5).join("; "));

  const shipped = JSON.parse(readFileSync(KNOWLEDGE_PATH, "utf8"));
  check("the shipped knowledge base no longer names the machine it was generated on",
    !Object.prototype.hasOwnProperty.call(shipped, "gameModsDir") &&
    !(shipped.localization && Object.prototype.hasOwnProperty.call(shipped.localization, "projectPath")),
    JSON.stringify({ keys: Object.keys(shipped).length }));
  check("and the facts survived: schemas and baseline are still there",
    Object.keys(shipped.schemas || {}).length > 0 && Object.keys(shipped.baseline || {}).length > 0,
    JSON.stringify({ schemas: Object.keys(shipped.schemas || {}).length, baseline: Object.keys(shipped.baseline || {}).length }));
}

/* ------------------------------------------------------------------ */

/*
 * 语言服务的位置层（docs/LANGUAGE.md §2）。位置是纯函数，不需要浏览器也不需要
 * 语料：行从 1 数，列与 UTF-16 offset 从 0 数，CRLF 与裸 CR 各算一种行尾，区间
 * 从不跨行。这里钉的是"屏幕要什么"，错一个偏移就是选错一个字符。
 */
section("language service: positions");
{
  const {
    lineStarts, lineCount, offsetToPosition, positionToOffset, columnAt, lineText,
    rangeBetween, rangeOfLineCols, diagnosticRange, wordAt, isRangeInText, shiftRange, formatRange,
  } = require(join(HERE, "positions.js"));
  const eq = (name, actual, expected) => check(name, JSON.stringify(actual) === JSON.stringify(expected),
    `got ${JSON.stringify(actual)}, want ${JSON.stringify(expected)}`);

  eq("empty text has one empty line", lineStarts(""), [0]);
  eq("empty text counts as one line", lineCount(""), 1);
  eq("one line, no terminator", lineStarts("abc"), [0]);
  eq("LF starts a line", lineStarts("a\nb"), [0, 2]);
  eq("a trailing LF opens a last empty line", lineStarts("a\n"), [0, 2]);
  eq("CRLF counts as two code units", lineStarts("a\r\nb"), [0, 3]);
  eq("CRLF line count", lineCount("a\r\nb"), 2);
  eq("a lone CR is a line ending too", lineStarts("a\rb"), [0, 2]);
  eq("blank lines", lineStarts("\n\n"), [0, 1, 2]);
  eq("trailing CRLF", lineStarts("a\r\n"), [0, 3]);

  eq("offset 0", offsetToPosition("abc", 0), { line: 1, character: 0 });
  eq("offset 2", offsetToPosition("abc", 2), { line: 1, character: 2 });
  eq("the end of the text is a position", offsetToPosition("abc", 3), { line: 1, character: 3 });
  eq("past an LF", offsetToPosition("a\nb", 2), { line: 2, character: 0 });
  eq("past a CRLF", offsetToPosition("a\r\nb", 3), { line: 2, character: 0 });
  // The \r itself belongs to line 1, character 1.
  eq("the CR is still line 1", offsetToPosition("a\r\nb", 1), { line: 1, character: 1 });
  eq("offset past a trailing LF", offsetToPosition("a\n", 2), { line: 2, character: 0 });
  eq("an offset past the end clamps", offsetToPosition("abc", 99), { line: 1, character: 3 });
  eq("a negative offset clamps", offsetToPosition("abc", -5), { line: 1, character: 0 });
  eq("a NaN offset clamps", offsetToPosition("abc", NaN), { line: 1, character: 0 });

  // A smiley is TWO UTF-16 code units: the screen counts what the string counts.
  const smiley = "\u{1F600}";
  eq("a smiley is two code units", smiley.length, 2);
  eq("the middle of a pair is a position", offsetToPosition(smiley + "x", 1), { line: 1, character: 1 });
  eq("after a pair", offsetToPosition(smiley + "x", 2), { line: 1, character: 2 });
  eq("column counts code units", columnAt(smiley + "x", 2), 2);

  eq("position to offset 0", positionToOffset("abc", { line: 1, character: 0 }), 0);
  eq("position to offset 2", positionToOffset("abc", { line: 1, character: 2 }), 2);
  eq("a character past the line clamps to its end", positionToOffset("abc", { line: 1, character: 99 }), 3);
  eq("line 2 begins after the LF", positionToOffset("a\nb", { line: 2, character: 0 }), 2);
  eq("a line past the end clamps to the text end", positionToOffset("a\nb", { line: 9, character: 0 }), 3);
  eq("line 0 still lands inside the text", positionToOffset("a\nb", { line: 0, character: 1 }), 1);
  eq("line 2 of a CRLF file", positionToOffset("a\r\nb", { line: 2, character: 1 }), 4);

  const text = "第一行\nsecond line\r\nthird\tline\n\n\u{1F600} emoji end";
  let roundTrips = true;
  for (let i = 0; i <= text.length; i += 1) {
    if (positionToOffset(text, offsetToPosition(text, i)) !== i) { roundTrips = false; break; }
  }
  check("every offset survives the round trip", roundTrips);

  eq("lineText strips a CRLF", lineText("a\r\nb", 1), "a");
  eq("lineText, second line", lineText("a\r\nb", 2), "b");
  eq("lineText past the end is empty", lineText("a\n", 5), "");

  const range = rangeBetween("a\nbc\nd", 2, 4);
  eq("range start", range.start, { line: 2, character: 0 });
  eq("range end", range.end, { line: 2, character: 2 });
  eq("range offsets", [range.startOffset, range.endOffset], [2, 4]);
  eq("a backwards range is normalised", rangeBetween("abc", 3, 1).startOffset, 1);
  eq("a range prints as line:col-line:col", formatRange(rangeBetween("abc", 1, 3)), "1:1-1:3");

  const byLineCols = rangeOfLineCols("xx\nalpha beta\n", 2, 1, 6);
  eq("line/column to offsets", [byLineCols.startOffset, byLineCols.endOffset], [3, 8]);
  const toLineEnd = rangeOfLineCols("xx\nalpha beta\n", 2, 7, 7);
  eq("a column range that runs to the end stops at the line end", [toLineEnd.startOffset, toLineEnd.endOffset], [9, 13]);
  const onEmptyLine = rangeOfLineCols("a\n\nb", 2, 1, 1);
  eq("an empty line has a zero-width range", [onEmptyLine.startOffset, onEmptyLine.endOffset], [2, 2]);

  const diagText = "xx\n  <<jump Nowhere>>\n";
  const withLength = diagnosticRange(diagText, { line: 2, col: 3, length: 14 });
  eq("a diagnostic with a length", [withLength.startOffset, withLength.endOffset], [5, 19]);
  const toEnd = diagnosticRange(diagText, { line: 2, col: 3 });
  eq("a diagnostic without a length runs to the line end", [toEnd.startOffset, toEnd.endOffset], [5, 21]);
  const noCol = diagnosticRange(diagText, { line: 2 });
  eq("a diagnostic without a column starts at the line start", noCol.startOffset, 3);

  eq("word at a command name", wordAt("  <<jump Nowhere>>", 8).text, "jump");
  eq("word at an argument", wordAt("  <<jump Nowhere>>", 13).text, "Nowhere");
  eq("word at a boundary", wordAt("abc def", 3).text, "abc");
  eq("word after a space", wordAt("abc def", 4).text, "def");
  eq("word with CJK and underscore", wordAt("节点: 灯笼_Awake", 5).text, "灯笼_Awake");
  eq("no word in empty text", wordAt("", 0).text, "");

  check("a range inside the text is accepted", isRangeInText("abcdef", { startOffset: 1, endOffset: 3 }));
  check("a range outside the text is rejected", !isRangeInText("abcdef", { startOffset: 1, endOffset: 99 }));
  check("a zero-width range is not a range in the text", !isRangeInText("abcdef", { startOffset: 2, endOffset: 2 }));
  eq("shifting a range", shiftRange({ startOffset: 1, endOffset: 3 }, 10), { startOffset: 11, endOffset: 13 });
  eq("a NaN shift leaves the range alone", shiftRange({ startOffset: 1, endOffset: 3 }, NaN), { startOffset: 1, endOffset: 3 });

  const yarnText = "title: Demo\n---\n<<jump Missing>>\n\tWarden: Hello #line:abc1234\n";
  const realRange = diagnosticRange(yarnText, { line: 3, col: 1, length: 16 });
  eq("a real Yarn diagnostic lands on line 3", realRange.start.line, 3);
  eq("a real Yarn diagnostic starts at column 1", realRange.start.character, 0);
  eq("and covers the command", yarnText.slice(realRange.startOffset, realRange.endOffset), "<<jump Missing>>");
}

/*
 * 补全与悬停（docs/LANGUAGE.md §3-§5）。两个函数都只读索引、不写盘：补全说
 * "这里能写什么"，悬停说"这个词是什么"，没有把握时返回 null 而不是编一个。
 */
