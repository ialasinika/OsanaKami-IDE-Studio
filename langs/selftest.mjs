#!/usr/bin/env node
/**
 * selftest.mjs -- proves the language layer works with no kernel, no shell and
 * no network.  Run it after editing a descriptor or the tokenizer.
 *
 *     node langs/selftest.mjs
 *
 * Exits 0 on success, 1 on the first failure.
 */

import { readdirSync, readFileSync } from "node:fs";
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

check("flat is the default family", bf.family === "flat" && bf.rawElements.length === 0, bf.family);

const sgml = parseDescriptor(
  'id html\next .html\nfamily sgml\nraw_element "script" "style"\n',
  "html.lang",
);
check("family parsed", sgml.family === "sgml", sgml.family);
check(
  "raw elements parsed",
  JSON.stringify(sgml.rawElements) === '["script","style"]',
  JSON.stringify(sgml.rawElements),
);
check(
  "an explicit flat family is allowed",
  parseDescriptor("id x\next .x\nfamily flat\nline_comment #\n", "x.lang").family === "flat",
);
check(
  "the same family twice is allowed",
  parseDescriptor("id x\next .x\nfamily flat\nfamily flat\n", "x.lang").family === "flat",
);

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
rejects("a flat key with family sgml is fatal", "id x\next .x\nfamily sgml\nline_comment #\n");
rejects("raw_element without a family is fatal", 'id x\next .x\nraw_element "script"\n');
rejects("an unknown family is fatal", "id x\next .x\nfamily fortran\n");
rejects("two different families are fatal", "id x\next .x\nfamily sgml\nfamily flat\n");
rejects("an element name with a space is fatal", 'id x\next .x\nfamily sgml\nraw_element "script style"\n');
rejects("an empty raw_element is fatal", "id x\next .x\nfamily sgml\nraw_element\n");

section("registry");

const registry = LangRegistry.fromDir(HERE);
check("brainfuck is loaded", registry.byId("brainfuck") !== null);
check("unknown id resolves to null", registry.byId("cobol") === null);
check("detect by extension", registry.detect("examples/hello.bf")?.id === "brainfuck");
check("detect ignores case", registry.detect("EXAMPLES/HELLO.BF")?.id === "brainfuck");
check("detect unknown extension", registry.detect("notes.md") === null);
check("resolve prefers explicit lang", registry.resolve({ lang: "brainfuck", path: "a.md" })?.id === "brainfuck");
check("html is loaded as a family member", registry.byId("html")?.family === "sgml");
check("detect picks html", registry.detect("examples/page.html")?.id === "html");
check("detect picks html for xhtml", registry.detect("page.xhtml")?.id === "html");
check("detect picks xml for svg", registry.detect("icon.svg")?.id === "xml");
check(
  "list is wire shaped",
  JSON.stringify(registry.list().map((l) => l.id)) === '["brainfuck","html","xml"]' &&
    registry.list().every((l) => typeof l.title === "string" && Array.isArray(l.extensions)),
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

section("offsets are string indices, not bytes");

// The docs used to call these byte offsets.  The tokenizer scans a JavaScript
// string, so they are code units; these are the fixtures where the two numbers
// differ, which is what makes the claim testable rather than asserted.
const wideBf = "+++ \u4E2D\u6587 \u{1F600}\n# \u6CE8\u91CA\n>+<.";
const wideSpans = tokenize(bf, wideBf);
check("non-ASCII text tiles", assertTiles(wideBf, wideSpans) === null, assertTiles(wideBf, wideSpans));
check(
  "the tiling ends at text.length, not at the byte length",
  wideSpans[wideSpans.length - 1][1] === wideBf.length &&
    wideBf.length !== Buffer.byteLength(wideBf, "utf8"),
  `last=${wideSpans[wideSpans.length - 1][1]} units=${wideBf.length}`
    + ` bytes=${Buffer.byteLength(wideBf, "utf8")}`,
);
check(
  "slicing by those offsets rebuilds the exact text",
  wideSpans.map(([s, e]) => wideBf.slice(s, e)).join("") === wideBf,
);
const wideComment = wideSpans.find((s) => s[2] === "comment");
check(
  "a comment holding non-ASCII keeps its own text whole",
  wideComment !== undefined && wideBf.slice(wideComment[0], wideComment[1]) === "# \u6CE8\u91CA",
  JSON.stringify(wideComment),
);
const wideHtml = '<p title="\u4E2D\u6587">\u4F60\u597D \u{1F600}</p>';
const wideHtmlSpans = tokenize(registry.byId("html"), wideHtml);
check(
  "the SGML family tiles non-ASCII the same way",
  assertTiles(wideHtml, wideHtmlSpans) === null &&
    wideHtmlSpans[wideHtmlSpans.length - 1][1] === wideHtml.length,
  assertTiles(wideHtml, wideHtmlSpans),
);

section("the SGML family");

const html = registry.byId("html");
const xml = registry.byId("xml");

// A corpus rather than one happy path: half-typed documents are what an
// editor actually sees, and every one of them still has to tile.
const sgmlCorpus = [
  '<!DOCTYPE html>\n<html><head><title>t</title></head>\n<body class="a">x &amp; y</body></html>\n',
  '<?xml version="1.0"?><a b=\'c\'><![CDATA[x < y]]></a>',
  "<p>unclosed",
  '<p title="unclosed>',
  "<!-- never closed",
  "<script>if (a < b) { x++; }</script>",
  "<p>a < b > c & d</p>",
  "",
  '<ns:a xmlns:ns="u"><ns:b/></ns:a>',
];
for (const one of sgmlCorpus) {
  const label = one.length > 30 ? `${one.slice(0, 27)}...` : JSON.stringify(one);
  const bad = assertTiles(one, tokenize(html, one));
  check(`tiles ${label}`, bad === null, bad);
}

const rawBody = "<script>if (a < b) { x++; }</script>";
const rawSpans = tokenize(html, rawBody);
check(
  "a raw body is never markup",
  rawSpans.every(
    (s) => !(s[0] >= rawBody.indexOf("if") && s[1] <= rawBody.indexOf("</script>") &&
      ["keyword", "type", "string", "comment"].includes(s[2])),
  ),
  JSON.stringify(rawSpans),
);
check(
  "a raw body stops at its closing tag",
  rawSpans.filter((s) => s[2] === "keyword").length === 2,
  JSON.stringify(rawSpans),
);
check(
  "the closing tag of a raw element is markup again",
  JSON.stringify(rawSpans.slice(-3)) === '[[27,29,"punct"],[29,35,"keyword"],[35,36,"punct"]]',
  JSON.stringify(rawSpans.slice(-3)),
);
check(
  "script is ordinary markup in XML",
  tokenize(xml, rawBody).filter((s) => s[2] === "keyword").length === 2,
  JSON.stringify(tokenize(xml, rawBody)),
);

const commentOnly = tokenize(html, '<!-- <p a="b"> -->');
check(
  "a comment swallows markup and quotes",
  commentOnly.length === 1 && commentOnly[0][2] === "comment" &&
    commentOnly[0][1] === '<!-- <p a="b"> -->'.length,
  JSON.stringify(commentOnly),
);
check("an unclosed comment runs to the end", JSON.stringify(tokenize(html, "<!-- x <p>y")) === '[[0,11,"comment"]]');

check("an entity is a constant", tokenize(html, "a &amp; b").filter((s) => s[2] === "constant").length === 1);
check("a bare & is punctuation", tokenize(html, "a & b").every((s) => s[2] !== "constant"));
check("a lone < is punctuation", tokenize(html, "a < b").some((s) => s[2] === "punct" && s[0] === 2));
check("a doctype has a keyword", tokenize(xml, "<!DOCTYPE html>").some((s) => s[2] === "keyword"));
check(
  "a processing instruction has a keyword",
  tokenize(xml, '<?xml version="1.0"?>').some((s) => s[2] === "keyword"),
);
check("CDATA is a string", tokenize(xml, "<x><![CDATA[a < b]]></x>").some((s) => s[2] === "string"));
check(
  "attribute values are strings, attribute names are types",
  JSON.stringify(tokenize(html, '<p class="x">')) ===
    '[[0,1,"punct"],[1,2,"keyword"],[2,3,"ws"],[3,8,"type"],[8,9,"punct"],[9,12,"string"],[12,13,"punct"]]',
  JSON.stringify(tokenize(html, '<p class="x">')),
);

const page = readFileSync(join(HERE, "..", "examples", "page.html"), "utf8");
const pageSpans = tokenize(html, page);
check("examples/page.html tiles", assertTiles(page, pageSpans) === null, assertTiles(page, pageSpans));
check(
  "examples/page.html shows off every kind it can",
  pageSpans.some((s) => s[2] === "keyword") &&
    pageSpans.some((s) => s[2] === "type") &&
    pageSpans.some((s) => s[2] === "string") &&
    pageSpans.some((s) => s[2] === "constant") &&
    pageSpans.some((s) => s[2] === "comment"),
  JSON.stringify([...new Set(pageSpans.map((s) => s[2]))]),
);
// Whitespace runs cross line boundaries here, so the per-line spans are a
// refinement of the flat ones rather than the same array.
const pageLines = tokenizeLines(html, page).flat();
const kindAt = (spans, at) => spans.find(([s, e]) => s <= at && at < e)?.[2];
check(
  "line grouping refines the flat spans without changing a kind",
  assertTiles(page, pageLines) === null &&
    pageLines.length >= pageSpans.length &&
    pageLines.every(([s, e, k]) => kindAt(pageSpans, s) === k && kindAt(pageSpans, e - 1) === k),
  `${pageLines.length} line spans vs ${pageSpans.length} flat spans`,
);

const xmlFixture = readFileSync(join(HERE, "..", "examples", "hello.xml"), "utf8");
const xmlSpans = tokenize(xml, xmlFixture);
check("examples/hello.xml tiles", assertTiles(xmlFixture, xmlSpans) === null, assertTiles(xmlFixture, xmlSpans));
check(
  "examples/hello.xml shows a declaration, a comment, an entity and CDATA",
  xmlSpans.slice(0, 4).some((s) => s[2] === "keyword") &&
    xmlSpans.some((s) => s[2] === "comment") &&
    xmlSpans.some((s) => s[2] === "constant") &&
    xmlSpans.some((s) => s[2] === "string"),
  JSON.stringify([...new Set(xmlSpans.map((s) => s[2]))]),
);

const svgFixture = readFileSync(join(HERE, "..", "examples", "notes.svg"), "utf8");
const svgSpans = tokenize(xml, svgFixture);
check("examples/notes.svg tiles", assertTiles(svgFixture, svgSpans) === null, assertTiles(svgFixture, svgSpans));
check(
  "examples/notes.svg is coloured as XML, so .svg needs no descriptor of its own",
  registry.detect("examples/notes.svg")?.id === "xml" &&
    svgSpans.some((s) => s[2] === "type") &&
    svgSpans.some((s) => s[2] === "comment") &&
    svgSpans.some((s) => s[2] === "keyword"),
  JSON.stringify([...new Set(svgSpans.map((s) => s[2]))]),
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
