#!/usr/bin/env node
/**
 * selftest.mjs -- proves the language layer works with no kernel, no shell and
 * no network.  Run it after editing a descriptor or the tokenizer.
 *
 *     node langs/selftest.mjs
 *
 * Exits 0 on success, 1 on the first failure.
 */

import { readdirSync } from "node:fs";
import { dirname } from "node:path";
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

const bfText = `# seIDE language descriptor
id brainfuck
title Brainfuck
ext .bf
line_comment #
kind command "+" "-" "<" ">" "[" "]" "." ","
`;

const bf = parseDescriptor(bfText, "brainfuck.lang");
check("id parsed", bf.id === "brainfuck", bf.id);
check("title parsed", bf.title === "Brainfuck", bf.title);
check("extension parsed", bf.extensions.length === 1 && bf.extensions[0] === ".bf");
check("line comment is not quoted", bf.lineComment === "#", JSON.stringify(bf.lineComment));
check("eight command literals", bf.literals.length === 8, String(bf.literals.length));
check("literals are longest-first", bf.literals.every((e, i, a) => i === 0 || a[i - 1].text.length >= e.text.length));
check("no word entries for punctuation", bf.words.size === 0, String(bf.words.size));

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
check("brainfuck is loaded", registry.byId("brainfuck") !== null);
check("unknown id resolves to null", registry.byId("cobol") === null);
check("detect by extension", registry.detect("examples/hello.bf")?.id === "brainfuck");
check("detect ignores case", registry.detect("EXAMPLES/HELLO.BF")?.id === "brainfuck");
check("detect unknown extension", registry.detect("notes.md") === null);
check("resolve prefers explicit lang", registry.resolve({ lang: "brainfuck", path: "a.md" })?.id === "brainfuck");
check(
  "list is wire shaped",
  JSON.stringify(registry.list()) === '[{"id":"brainfuck","title":"Brainfuck","extensions":[".bf"]}]',
  JSON.stringify(registry.list()),
);

section("tokenizer");

const program = "++[>+<-] # ignore\n.>,\n";
const spans = tokenize(bf, program);
const commentSpan = spans.find((s) => s[2] === "comment");
check("tiles the input", assertTiles(program, spans) === null, assertTiles(program, spans));
check("all eleven commands classified", spans.filter((s) => s[2] === "command").length === 11, JSON.stringify(spans));
check("exactly one comment span", spans.filter((s) => s[2] === "comment").length === 1, JSON.stringify(spans));
check(
  "comment spans the marker to end of line, excluding the newline",
  JSON.stringify(commentSpan) === '[9,17,"comment"]',
  JSON.stringify(commentSpan),
);
check(
  "whitespace is reported, not skipped",
  JSON.stringify(spans.filter((s) => s[2] === "ws")) === '[[8,9,"ws"],[17,18,"ws"],[21,22,"ws"]]',
  JSON.stringify(spans.filter((s) => s[2] === "ws")),
);

check("empty input yields no spans", tokenize(bf, "").length === 0);
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

const lines = tokenizeLines(bf, program);
check("line grouping covers every line", lines.length === 3, String(lines.length));
check(
  "line grouping is exactly the flat spans, regrouped",
  JSON.stringify(lines.flat()) === JSON.stringify(spans),
  JSON.stringify(lines.flat()),
);
check("a trailing newline does not invent a line", lines[2].length === 0, JSON.stringify(lines[2]));

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
