#!/usr/bin/env node
/**
 * selftest.mjs -- proves the language layer works with no kernel, no shell and
 * no network.  Run it after editing a descriptor or the tokenizer.
 *
 *     node langs/selftest.mjs
 *
 * Exits 0 on success, 1 on the first failure.
 */

import { readFileSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { LangError, LangRegistry, parseDescriptor } from "./lang.mjs";
import { tokenize, tokenizeLines, tokenizePlain } from "./tokenize.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));

let failures = 0;
let checks = 0;

function check(name, condition, detail) {
  checks += 1;
  if (condition) {
    console.log(`  ok   ${name}`);
  } else {
    failures += 1;
    console.log(`  FAIL ${name}${detail === undefined ? "" : ` -- ${detail}`}`);
  }
}

function section(title) {
  console.log(`\n${title}`);
}

/** Spans must tile [0, len) exactly once, in order. */
function assertTiles(text, spans) {
  let at = 0;
  for (const [start, end, kind] of spans) {
    if (start !== at) {
      return `gap or overlap at ${at} (span starts at ${start})`;
    }
    if (!(end > start)) {
      return `empty span at ${start}`;
    }
    if (typeof kind !== "string" || kind === "") {
      return `missing kind at ${start}`;
    }
    at = end;
  }
  return at === text.length ? null : `tiling ends at ${at}, expected ${text.length}`;
}

/* ------------------------------------------------------------------ */

section("descriptor parsing");

/* The same eight keys and the same shapes as `langs/yarn.lang` -- quoted word
 * kinds, unquoted markers, two extensions, both comment styles -- so the parser
 * is exercised by an inline descriptor while the tokenizer below runs on the
 * file that actually ships. */
const inlineText = `# InfantGod Studio language descriptor
id yarn
title Yarn
ext .yarn
ext .yarnproject
line_comment //
block_comment_open /*
block_comment_close */
string "\\""
kind keyword "title" "when" "tags" "subtitle" "tracking" "position"
kind keyword "if" "elseif" "else" "endif" "set" "declare" "jump" "detour" "return" "stop" "once" "endonce" "wait"
kind keyword "true" "false" "null"
kind command "<<" ">>" "---" "===" "->" "#" "$" ":" "," "(" ")" "[" "]" "{" "}" "|"
kind command "<" ">"
`;

const inlineLang = parseDescriptor(inlineText, "yarn.lang");
check("id parsed", inlineLang.id === "yarn", inlineLang.id);
check("title parsed", inlineLang.title === "Yarn", inlineLang.title);
check(
  "extensions parsed",
  inlineLang.extensions.length === 2 &&
    inlineLang.extensions[0] === ".yarn" &&
    inlineLang.extensions[1] === ".yarnproject",
  JSON.stringify(inlineLang.extensions),
);
check("line comment is not quoted", inlineLang.lineComment === "//", JSON.stringify(inlineLang.lineComment));
check(
  "block comment delimiters are not quoted",
  inlineLang.blockOpen === "/*" && inlineLang.blockClose === "*/",
  `${JSON.stringify(inlineLang.blockOpen)}/${JSON.stringify(inlineLang.blockClose)}`,
);
check("one string delimiter", inlineLang.strings.length === 1 && inlineLang.strings[0] === '"', JSON.stringify(inlineLang.strings));
check("eighteen command literals", inlineLang.literals.length === 18, String(inlineLang.literals.length));
check(
  "literals are longest-first",
  inlineLang.literals.every((e, i, a) => i === 0 || a[i - 1].text.length >= e.text.length),
  JSON.stringify(inlineLang.literals.map((e) => e.text)),
);
check(
  "literals and words are split by first char",
  inlineLang.words.size === 22 && inlineLang.literals.length === 18,
  `words ${inlineLang.words.size} literals ${inlineLang.literals.length}`,
);
check(
  "punctuation never lands in the word map",
  !inlineLang.words.has("<<") && !inlineLang.words.has(":"),
  JSON.stringify([...inlineLang.words.keys()]),
);
check(
  "word entries carry their declared kind",
  inlineLang.words.get("title") === "keyword" && inlineLang.words.get("if") === "keyword",
  JSON.stringify([...inlineLang.words].slice(0, 4)),
);

const quoted = parseDescriptor('id x\next .x\nline_comment "//"\n', "x.lang");
check("quoted marker unquoted on read", quoted.lineComment === "//", JSON.stringify(quoted.lineComment));

const derived = parseDescriptor("id my-lang\next .ml\n", "d.lang");
check("title derived from id", derived.title === "My Lang", derived.title);

const withWords = parseDescriptor('id toy\next .toy\nkind keyword "if" "else"\nkind command "{" "}"\n', "t.lang");
check("word entries detected by first char", withWords.words.get("if") === "keyword");
check("literal entries detected by first char", withWords.literals.length === 2);

section("descriptor rejection");

function rejects(name, text) {
  let threw = null;
  try {
    parseDescriptor(text, "bad.lang");
  } catch (err) {
    threw = err;
  }
  check(name, threw instanceof LangError, threw === null ? "no error raised" : String(threw));
}

rejects("unknown key is fatal", "id x\next .x\ncolour_scheme rainbow\n");
rejects("unknown kind is fatal", 'id x\next .x\nkind sparkle "!"\n');
rejects("unquoted token is fatal", "id x\next .x\nkind keyword if\n");
rejects("missing id is fatal", "ext .x\n");
rejects("bad id is fatal", "id 9bad\next .x\n");
rejects("dangling block open is fatal", "id x\next .x\nblock_comment_open /*\n");
rejects("empty quoted token is fatal", 'id x\next .x\nkind keyword ""\n');

section("registry");

const registry = LangRegistry.fromDir(HERE);
check("yarn is loaded", registry.byId("yarn") !== null);
check("json is loaded", registry.byId("json") !== null);
check("unknown id resolves to null", registry.byId("cobol") === null);
check("detect by extension", registry.detect("examples/hello.yarn")?.id === "yarn");
check("detect by the second extension", registry.detect("project.yarnproject")?.id === "yarn");
check("detect JSON by extension", registry.detect("examples/sample.json")?.id === "json");
check("detect ignores case", registry.detect("EXAMPLES/HELLO.YARN")?.id === "yarn");
check("detect unknown extension", registry.detect("notes.md") === null);
check("resolve prefers explicit lang", registry.resolve({ lang: "json", path: "examples/hello.yarn" })?.id === "json");
check(
  "list is wire shaped",
  JSON.stringify(registry.list()) ===
    '[{"id":"json","title":"JSON","extensions":[".json"]},' +
      '{"id":"yarn","title":"Yarn","extensions":[".yarn",".yarnproject"]}]',
  JSON.stringify(registry.list()),
);

section("tokenizer");

/* The real fixture, read from disk rather than inlined, because the offsets
 * below are asserted exactly and a re-typed copy could drift from the file the
 * editor will actually open. */
const yarnSrc = readFileSync(join(HERE, "..", "examples", "hello.yarn"), "utf8");
const yarnSpans = tokenize(inlineLang, yarnSrc);
const commentSpans = yarnSpans.filter((s) => s[2] === "comment");
check("tiles the input", assertTiles(yarnSrc, yarnSpans) === null, assertTiles(yarnSrc, yarnSpans));
check(
  "every Yarn command marker classified",
  yarnSpans.filter((s) => s[2] === "command").length === 66,
  String(yarnSpans.filter((s) => s[2] === "command").length),
);
check("exactly two comment spans", commentSpans.length === 2, JSON.stringify(commentSpans));
check(
  "a block comment spans the marker to the closer, excluding the newline",
  JSON.stringify(commentSpans[0]) === '[86,112,"comment"]',
  JSON.stringify(commentSpans[0]),
);
check(
  "whitespace is reported, not skipped",
  JSON.stringify(tokenize(inlineLang, "<<if $x>> // note\n  hello\n").filter((s) => s[2] === "ws")) ===
    '[[4,5,"ws"],[9,10,"ws"],[17,20,"ws"],[25,26,"ws"]]',
  JSON.stringify(tokenize(inlineLang, "<<if $x>> // note\n  hello\n").filter((s) => s[2] === "ws")),
);

check("empty input yields no spans", tokenize(inlineLang, "").length === 0);
check("plain text tiles", assertTiles("hello, world\n", tokenizePlain("hello, world\n")) === null);
check(
  "plain text has no ident spans",
  tokenizePlain("hello\n").every((s) => s[2] === "ws" || s[2] === "punct"),
  JSON.stringify(tokenizePlain("hello\n")),
);

const cLang = parseDescriptor(
  'id c\next .c\nline_comment //\nblock_comment_open /*\nblock_comment_close */\nstring "\\""\nkind keyword "int" "return"\nkind type "char"\n',
  "c.lang",
);
const cSrc = 'int main(void) { /* hi */ return 0; } // done\nchar *s = "a\\"b";\n';
const cSpans = tokenize(cLang, cSrc);
check("C source tiles", assertTiles(cSrc, cSpans) === null, assertTiles(cSrc, cSpans));
check("returns, int and char are recognized", cSpans.filter((s) => s[2] === "keyword").length === 2 && cSpans.filter((s) => s[2] === "type").length === 1, JSON.stringify(cSpans));
check("two comment spans", cSpans.filter((s) => s[2] === "comment").length === 2, JSON.stringify(cSpans.filter((s) => s[2] === "comment")));
check("escaped quote stays inside the string", cSpans.filter((s) => s[2] === "string").length === 1, JSON.stringify(cSpans.filter((s) => s[2] === "string")));
check("number recognized", cSpans.some((s) => s[2] === "number"), JSON.stringify(cSpans));

const lineGroups = tokenizeLines(inlineLang, yarnSrc);
check(
  "line grouping covers every line",
  Array.isArray(lineGroups) && lineGroups.length === 27,
  Array.isArray(lineGroups) ? String(lineGroups.length) : "no line groups",
);
check(
  "line grouping is exactly the flat spans, regrouped",
  (() => {
    /* A span that crosses a line boundary -- the whitespace inside the block
     * comment's line, or around `---` -- is split into one span per line, so the
     * flat form is the same TEXT covered by the same number of characters, not
     * the same list of spans.  Both halves of that claim are asserted: a dropped
     * or double-counted span fails either one. */
    const flat = lineGroups.flat();
    const lengthOf = (list) => list.reduce((total, span) => total + (span[1] - span[0]), 0);
    const textOf = (list) => list.map((span) => yarnSrc.slice(span[0], span[1])).join("");
    return lengthOf(flat) === lengthOf(yarnSpans) && textOf(flat) === textOf(yarnSpans);
  })(),
  JSON.stringify(lineGroups.flat().slice(0, 3)),
);
check(
  "a trailing newline does not invent a line",
  lineGroups[lineGroups.length - 1].length === 0,
  JSON.stringify(lineGroups[lineGroups.length - 1]),
);

/* ------------------------------------------------------------------ */
/* the shipped descriptors, exercised over the shipped fixtures        */

section("yarn and json descriptors");

const EX = join(HERE, "..", "examples");
const yarn = registry.byId("yarn");
const json = registry.byId("json");

check("yarn descriptor is registered", yarn !== null);
check("yarn id and title", yarn.id === "yarn" && yarn.title === "Yarn", `${yarn.id}/${yarn.title}`);
check(
  "yarn extensions",
  JSON.stringify(yarn.extensions) === '[".yarn",".yarnproject"]',
  JSON.stringify(yarn.extensions),
);
check("yarn has a line comment", yarn.lineComment === "//", JSON.stringify(yarn.lineComment));
check("yarn has a block comment", yarn.blockOpen === "/*" && yarn.blockClose === "*/");
check("yarn has one string delimiter", yarn.strings.length === 1 && yarn.strings[0] === '"', JSON.stringify(yarn.strings));
check("yarn header keys are words", yarn.words.get("title") === "keyword" && yarn.words.get("tags") === "keyword");
check("yarn builtins are words", yarn.words.get("if") === "keyword" && yarn.words.get("jump") === "keyword");
check("yarn booleans are words", yarn.words.get("true") === "keyword" && yarn.words.get("null") === "keyword");
check(
  "yarn command markers are literals",
  yarn.literals.some((e) => e.text === "<<" && e.kind === "command") &&
    yarn.literals.some((e) => e.text === "===" && e.kind === "command"),
);
check("yarn declares no numbers as words", !yarn.words.has("1") && !yarn.words.has("0"));

check("json descriptor is registered", json !== null);
check("json id and title", json.id === "json" && json.title === "JSON", `${json.id}/${json.title}`);
check("json extension", JSON.stringify(json.extensions) === '[".json"]', JSON.stringify(json.extensions));
check("json has no line comment", json.lineComment === "", JSON.stringify(json.lineComment));
check("json has no block comment", json.blockOpen === "" && json.blockClose === "");
check("json keywords", json.words.get("true") === "keyword" && json.words.get("null") === "keyword");
check(
  "json punctuation is command",
  json.literals.length === 6 && json.literals.every((e) => e.kind === "command"),
  JSON.stringify(json.literals),
);

/* The file parsed above and the file on disk must describe the same language:
 * a descriptor edit that only touched one of them is the failure this catches.
 * Both tokenize appends below, so `hello.yarn` is read once. */
const fixtureSrc = readFileSync(join(EX, "hello.yarn"), "utf8");
const fixtureSpans = tokenize(yarn, fixtureSrc);
check("yarn fixture tiles", assertTiles(fixtureSrc, fixtureSpans) === null, assertTiles(fixtureSrc, fixtureSpans));
check(
  "the shipped descriptor and the inline one tokenize identically",
  JSON.stringify(tokenize(inlineLang, fixtureSrc)) === JSON.stringify(fixtureSpans),
  `${tokenize(inlineLang, fixtureSrc).length} spans vs ${fixtureSpans.length}`,
);
check("yarn has a comment span", fixtureSpans.some((s) => s[2] === "comment"));
check("yarn has a string span", fixtureSpans.some((s) => s[2] === "string"));
check("yarn has a keyword span", fixtureSpans.some((s) => s[2] === "keyword"));
check("yarn has a command span", fixtureSpans.some((s) => s[2] === "command"));
{
  // `<<` must win over `<`: the longest-first literal table is what makes the
  // two-character marker one span instead of two `<` puncts.
  const open = fixtureSrc.indexOf("<<");
  const span = fixtureSpans.find((s) => s[0] === open);
  check(
    "yarn `<<` wins over `<`",
    open >= 0 && span !== undefined && span[1] === open + 2 && span[2] === "command",
    `${JSON.stringify(span)} at ${open}`,
  );
}

const jsonSrc = readFileSync(join(EX, "sample.json"), "utf8");
const jsonSpans = tokenize(json, jsonSrc);
check("json fixture tiles", assertTiles(jsonSrc, jsonSpans) === null, assertTiles(jsonSrc, jsonSpans));
check("json has a string span", jsonSpans.some((s) => s[2] === "string"));
check("json has a number span", jsonSpans.some((s) => s[2] === "number"));
check("json has a keyword span", jsonSpans.some((s) => s[2] === "keyword"));
check("json has a command span", jsonSpans.some((s) => s[2] === "command"));

/* `tokenize` scans a JavaScript *string*, so every offset it reports is a UTF-16
 * code unit index -- what `text.length` counts -- and not a byte offset.  The two
 * coincide for ASCII and differ for Chinese prose, which is every 《幼神》 script,
 * so the difference is measured on the shipped fixture instead of asserted.  The
 * docs send a reader here for exactly this claim (`langs/README.md`,
 * `docs/FORK.md`, `docs/PARADIGM.md`, `docs/PROTOCOL.md`), and the check names
 * spell out the tiling property -- start at 0, no gap, end at `text.length` -- so
 * a failure names which half moved. */
section("offsets are string indices, not bytes");

/* An inline fixture carries the two cases a file on disk cannot guarantee:
 * Chinese text and an astral character -- one code point, two code units. */
const wideInline = "<<set $x = 1>> \u4E2D\u6587 \u{1F600}\n";
const wideInlineSpans = tokenize(yarn, wideInline);
const wideInlineTiling = assertTiles(wideInline, wideInlineSpans);
check("inline non-ASCII input tiles", wideInlineTiling === null, wideInlineTiling);
check(
  "the inline fixture's code units and bytes really differ",
  wideInline.length !== Buffer.byteLength(wideInline, "utf8"),
  `units=${wideInline.length} bytes=${Buffer.byteLength(wideInline, "utf8")}`,
);
check(
  "an astral character is two code units and one code point",
  wideInline.length - [...wideInline].length === 1,
  `units=${wideInline.length} code points=${[...wideInline].length}`,
);
const wideInlineLast = wideInlineSpans[wideInlineSpans.length - 1];
check(
  "its last offset is the code-unit length, not the byte length",
  wideInlineLast !== undefined && wideInlineLast[1] === wideInline.length,
  `${JSON.stringify(wideInlineLast)} units=${wideInline.length}`
    + ` bytes=${Buffer.byteLength(wideInline, "utf8")}`,
);
check(
  "slicing by those offsets rebuilds the exact text",
  wideInlineSpans.map(([s, e]) => wideInline.slice(s, e)).join("") === wideInline,
);

/* The shipped fixture, read from disk rather than re-typed: 632 code units and
 * 807 bytes as committed, so a drifted fixture shows up in the failure detail. */
const fixtureTiling = assertTiles(fixtureSrc, fixtureSpans);
const fixtureLast = fixtureSpans[fixtureSpans.length - 1];
check("the shipped non-ASCII fixture tiles", fixtureTiling === null, fixtureTiling);
check(
  "the shipped fixture's code units and bytes really differ",
  fixtureSrc.length !== Buffer.byteLength(fixtureSrc, "utf8"),
  `units=${fixtureSrc.length} bytes=${Buffer.byteLength(fixtureSrc, "utf8")}`,
);
check(
  "the first span starts at 0",
  fixtureSpans[0] !== undefined && fixtureSpans[0][0] === 0,
  JSON.stringify(fixtureSpans[0]),
);
check(
  "neighbouring spans touch",
  fixtureSpans.every((span, i) => i === 0 || span[0] === fixtureSpans[i - 1][1]),
  JSON.stringify(fixtureSpans.find((span, i) => i > 0 && span[0] !== fixtureSpans[i - 1][1])),
);
check(
  "the last span ends at the code-unit length, not the byte length",
  fixtureLast !== undefined &&
    fixtureLast[1] === fixtureSrc.length &&
    fixtureSrc.length !== Buffer.byteLength(fixtureSrc, "utf8"),
  `${JSON.stringify(fixtureLast)} units=${fixtureSrc.length}`
    + ` bytes=${Buffer.byteLength(fixtureSrc, "utf8")}`,
);
check(
  "slicing the shipped fixture by those offsets rebuilds it exactly",
  fixtureSpans.map(([s, e]) => fixtureSrc.slice(s, e)).join("") === fixtureSrc,
);

section("independence from the kernel");

const hereFiles = readdirSync(HERE);
check(
  "the language layer is data plus JavaScript, no C",
  !hereFiles.some((f) => f.endsWith(".c") || f.endsWith(".h")),
  hereFiles.join(", "),
);
check(
  "a file with no matching language still tokenizes",
  assertTiles("const x = 1;\n", tokenize(registry.resolve({ path: "x.unknown" }), "const x = 1;\n")) === null,
);

/* ------------------------------------------------------------------ */

console.log(`\n${checks - failures}/${checks} checks passed`);
if (failures > 0) {
  console.log(`${failures} FAILED`);
  process.exit(1);
}
console.log("langs: ok");
