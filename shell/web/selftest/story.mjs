/* ------------------------------------------------------------------ */
/* story.mjs and translation tables
/* ------------------------------------------------------------------ */

import assert from "node:assert/strict";
import {
  createHash,
} from "node:crypto";
import {
  readFileSync,
} from "node:fs";
import {
  readFile,
} from "node:fs/promises";
import {
  storyAddLine,
  storyLineIds,
  storyLineText,
  storyRowForLine,
  storySetText,
} from "../cards.mjs";
import {
  LINE_ID,
  STORY_LINE_KINDS,
  lineIdOf,
  nextLineId,
  parseStory,
  serializeStory,
  setLineSpeaker,
  setLineText,
  storyAbout,
  storyLines,
  storyNodes,
} from "../story.mjs";
import {
  CSV_BOM,
  CSV_COLUMNS,
  compareTables,
  csvLineIdOf,
  idOfLine,
  lockOf,
  looksLikeLock,
  metadataOf,
  parseCsv,
  rowFor,
  rowState,
  rowsById,
  serializeCsv,
  setColumn,
  speakersOf,
} from "../storycsv.mjs";
import {
  test,
  testAsync,
} from "./harness.mjs";
import {
  edited,
} from "./main.mjs";

/* ------------------------------------------------------------------ */
/* story.mjs: a `.yarn` file has to come back out the way it went in    */
/* ------------------------------------------------------------------ */

/** A body line's fields, with `edit` dropped: it is the dirty mark, not a field. */
export const storyLineShape = (entry) => {
  const copy = { ...entry };
  delete copy.edit;
  return copy;
};

export const storyFixture = (lines, eol = "\n", tail = true) => `${lines.join(eol)}${tail ? eol : ""}`;

/**
 * How many body lines a fixture's lines hold, counted the way the parser reads it.
 *
 * The last of them is the blank line a joined fixture leaves behind its final EOL
 * -- a blank line is a body line like any other here, so it is counted rather than
 * skipped.  Derived instead of hard-coded because a fixture is edited far more
 * often than this rule is, and an off-by-one would look like a parser bug.
 */
export const storyBodyCount = (lines) => {
  const split = lines.indexOf("---");
  return split === -1 ? lines.length : lines.length - split;
};

/*
 * The fixtures below are shapes taken from the real corpus, not invented: a
 * `when:always` header with no space, `=>Speaker:` with an arrow, a dialogue line
 * whose tag run ends in a space, and an inline `<<if ...>>` all occur in `Mods/`.
 */
export const NODE_A_LINES = [
  "title: Morning",
  "subtitle: kitchen",
  "when:always",
  "tags:#hub #reach",
  "---",
  "// 开场",
  "Aistalt: 早。 #state:Idle #line:07c13ab ",
  "    MaoGirl: 嗯。",
  "=>Nerd: 看这个。",
  "Aistalt: 小心。<<if Tech()>=1>> #Tech #line:0123abc",
  "  其他: [strong]重要[/strong]。[excite]哈[/excite]",
  "<<set $X = false>> // 解释",
  "-> 追问",
  "    -> 再问 #line:0abc123",
];

export const NODE_A = storyFixture(NODE_A_LINES);

export const NODE_B = storyFixture([
  "title: Night",
  "when: always",
  "---",
  "#line:09f0e1d",
  "   ",
  "Aistalt: 睡吧。",
]);

test("story: an LF file with one node is the text it came from, byte for byte", () => {
  assert.equal(serializeStory(parseStory(NODE_A)), NODE_A);
});

test("story: a CRLF file keeps its CRLF -- 2 of the 211 real files are", () => {
  const text = storyFixture(["title: A", "---", "A: x #line:0000001"], "\r\n");
  assert.equal(serializeStory(parseStory(text)), text);
});

test("story: a file with no newline at the end gets none back", () => {
  const text = storyFixture(["title: A", "---", "A: x"], "\n", false);
  assert.equal(serializeStory(parseStory(text)), text);
  assert.equal(parseStory(text).trailingNewline, false, "and the parse says so");
});

test("story: a BOM is kept, and is not mistaken for the first character of a title", () => {
  const text = `\uFEFF${NODE_A}`;
  const story = parseStory(text);
  assert.equal(story.bom, "\uFEFF");
  assert.equal(story.nodes[0].title, "Morning", "the BOM is not part of the header line");
  assert.equal(serializeStory(story), text);
});

test("story: an empty string parses to nothing and prints nothing", () => {
  const story = parseStory("");
  assert.deepEqual(story.nodes, []);
  assert.equal(story.trailingNewline, false);
  assert.equal(serializeStory(story), "");
  assert.equal(parseStory("").lines.length, 0);
});

test("story: a file of nothing but comments is all body, and round-trips", () => {
  const text = storyFixture(["// 一", "// 二", "// 三"]);
  const story = parseStory(text);
  assert.equal(story.nodes.length, 1, "there is no `===`, so the whole file is one node");
  assert.equal(serializeStory(story), text);
  assert.deepEqual(storyLines(story.nodes[0]).map((line) => line.kind), ["comment", "comment", "comment"]);
});

test("story: a node with no `---` keeps its `key:` lines and everything after is body", () => {
  const text = storyFixture(["title: A", "when:always", "Aistalt: 你好。 #line:0a1b2c3"]);
  const story = parseStory(text);
  assert.deepEqual(story.nodes[0].headerLines, ["title: A", "when:always"]);
  assert.equal(story.nodes[0].title, "A");
  assert.equal(story.nodes[0].when, "always");
  assert.deepEqual(storyLines(story.nodes[0]).map((line) => line.kind), ["dialogue"]);
  assert.equal(serializeStory(story), text);
});

test("story: `when:always` and `when: always` are the same header, and both survive", () => {
  const tight = parseStory(storyFixture(["title: A", "when:always", "---", "x"]));
  const loose = parseStory(storyFixture(["title: A", "when: always", "---", "x"]));
  assert.equal(tight.nodes[0].when, "always");
  assert.equal(loose.nodes[0].when, "always");
  assert.equal(serializeStory(tight), storyFixture(["title: A", "when:always", "---", "x"]));
  assert.equal(serializeStory(loose), storyFixture(["title: A", "when: always", "---", "x"]));
});

test("story: a two-node file keeps the `===` and the blank lines around it exactly once", () => {
  const text = `${NODE_A}\n===\n\n${NODE_B}`;
  const story = parseStory(text);
  assert.equal(story.nodes.length, 2);
  assert.deepEqual(story.nodes[1].separator.lines, ["===", ""], "the gap hangs on the node that follows it");
  assert.equal(serializeStory(story), text);
});

test("story: a trailing `===` with no node after it is kept, not dropped", () => {
  const text = storyFixture(["title: A", "---", "x", "===", ""]);
  const story = parseStory(text);
  assert.equal(story.nodes.length, 1);
  assert.deepEqual(story.post, ["===", ""]);
  assert.equal(serializeStory(story), text);
});

test("story: leading blank lines belong to the first node and come back in front of it", () => {
  const text = storyFixture(["", "", "title: A", "---", "x"]);
  const story = parseStory(text);
  assert.deepEqual(story.nodes[0].separator.lines, ["", ""]);
  assert.equal(story.nodes[0].startLine, 3, "the node's own text starts at file line 3");
  assert.equal(serializeStory(story), text);
});

test("story: `===` and `---` are recognised through surrounding whitespace", () => {
  const text = storyFixture(["title: A", "  ---  ", "x", " ===", "title: B", "---", "y"]);
  const story = parseStory(text);
  assert.equal(story.nodes.length, 2, "a padded ` ===` still separates two nodes");
  assert.equal(serializeStory(story), text, "and comes back with its padding");
});

test("story: an indented speaker and a `=>` speaker are both dialogue", () => {
  // Index 0 is the `// 开场` comment, so the speakers below sit one line later
  // than they read in the fixture.
  const lines = storyLines(parseStory(NODE_A).nodes[0]);
  const plain = lines[1];
  const indented = lines[2];
  const arrow = lines[3];
  assert.equal(plain.kind, "dialogue");
  assert.equal(plain.indent, "");
  assert.equal(plain.speaker, "Aistalt");
  assert.equal(plain.text, "早。");
  assert.equal(indented.kind, "dialogue");
  assert.equal(indented.indent, "    ", "the indent is kept, so an edit cannot lose it");
  assert.equal(indented.speaker, "MaoGirl");
  assert.equal(arrow.kind, "dialogue");
  assert.equal(arrow.speaker, "Nerd");
  assert.equal(arrow.raw, "=>Nerd: 看这个。");
});

test("story: a speaker name that is not ASCII is still a speaker", () => {
  const line = storyLines(parseStory(NODE_A).nodes[0])[5];
  assert.equal(line.kind, "dialogue");
  assert.equal(line.speaker, "其他");
  assert.equal(line.text, "[strong]重要[/strong]。[excite]哈[/excite]");
});

test("story: a colon in running text is not a speaker", () => {
  const text = storyFixture(["title: A", "---", "他说: 你好", "note to self: buy milk"]);
  const lines = storyLines(parseStory(text).nodes[0]);
  assert.equal(lines[0].kind, "dialogue", "one name-shaped word before the colon is a speaker, even in CJK");
  assert.equal(lines[1].kind, "other", "a space in front of the colon means this is narration, not a speaker");
  assert.equal(lines[1].speaker, null);
  assert.equal(serializeStory(parseStory(text)), text);
});

test("story: a trailing `#state:`/`#line:` run is read without being moved", () => {
  const line = storyLines(parseStory(NODE_A).nodes[0])[1];
  assert.equal(line.id, "07c13ab");
  assert.equal(line.state, "Idle");
  assert.deepEqual(line.tags, ["#state:Idle", "#line:07c13ab"]);
  assert.equal(line.raw, "Aistalt: 早。 #state:Idle #line:07c13ab ", "the space after the id is part of the line");
  assert.equal(line.text, "早。", "and the text stops before the run");
});

test("story: a line ending in `#line:... ` keeps its trailing space through a round trip", () => {
  const text = storyFixture(["title: A", "---", "A: 你好。 #state:Idle #line:07c13ab "]);
  assert.equal(serializeStory(parseStory(text)), text);
  assert.ok(serializeStory(parseStory(text)).endsWith("#line:07c13ab \n"));
});

test("story: the whole tag run is read, not just its last token", () => {
  const line = storyLines(parseStory(NODE_A).nodes[0])[1];
  assert.deepEqual(line.tags, ["#state:Idle", "#line:07c13ab"], "`#state:` is a tag, not text");
  assert.equal(line.state, "Idle");
});

test("story: inline markup and an inline `<<if>>` stay inside the text", () => {
  const lines = storyLines(parseStory(NODE_A).nodes[0]);
  const inline = lines[4];
  assert.equal(inline.kind, "dialogue");
  assert.equal(inline.text, "小心。<<if Tech()>=1>>");
  assert.deepEqual(inline.tags, ["#Tech", "#line:0123abc"]);
  assert.equal(inline.id, "0123abc");
  assert.equal(lines[5].text, "[strong]重要[/strong]。[excite]哈[/excite]");
  assert.equal(lines[5].speaker, "其他");
});

test("story: a `<<set ...>> // comment` line is a command with its comment split out", () => {
  const line = storyLines(parseStory(NODE_A).nodes[0])[6];
  assert.equal(line.kind, "command");
  assert.equal(line.command, "<<set $X = false>>");
  assert.equal(line.comment, "解释");
  assert.equal(line.raw, "<<set $X = false>> // 解释");
});

test("story: an `-> ` line is an option, indented or not, with its own tag run", () => {
  const lines = storyLines(parseStory(NODE_A).nodes[0]);
  assert.equal(lines[7].kind, "option");
  assert.equal(lines[7].text, "追问");
  assert.equal(lines[8].kind, "option");
  assert.equal(lines[8].indent, "    ");
  assert.equal(lines[8].id, "0abc123");
  assert.equal(lines[8].text, "再问");
});

/* ------------------------------------------------------------------ */
/* the shapes the first pass at the classifier filed as `other`         */
/* ------------------------------------------------------------------ */

test("story: an option written tight against its arrow is still an option", () => {
  // Measured, not invented: 1,046 of the real corpus's option lines look like
  // this, and a lookahead that wanted a space filed every one of them as `other`.
  const text = storyFixture(["title: A", "---", "->49年？<<once>> #line:0749555 ", "    ->不。"]);
  const lines = storyLines(parseStory(text).nodes[0]);
  assert.equal(lines[0].kind, "option", "no space between `->` and the text");
  assert.equal(lines[0].text, "49年？<<once>>");
  assert.equal(lines[0].id, "0749555");
  assert.equal(lines[1].kind, "option");
  assert.equal(lines[1].indent, "    ");
  assert.equal(serializeStory(parseStory(text)), text, "and the tight arrow comes back tight");
});

test("story: `=> Name:` with a space after the arrow is dialogue", () => {
  const raw = "    => Aistalt: 那么预言……<<once if $Terrorist_EatAnotherSpicy == true>> #line:054b614 ";
  const text = storyFixture(["title: A", "---", raw]);
  const line = storyLines(parseStory(text).nodes[0])[0];
  assert.equal(line.kind, "dialogue", "the space belongs to the arrow, not to the name");
  assert.equal(line.indent, "    ");
  assert.equal(line.speaker, "Aistalt");
  assert.equal(line.id, "054b614");
  assert.equal(serializeStory(parseStory(text)), text);
});

test("story: a bare `->` with nothing after it is body text, not an empty option", () => {
  const text = storyFixture(["title: A", "---", "->"]);
  const line = storyLines(parseStory(text).nodes[0])[0];
  assert.equal(line.kind, "other", "there is no option text to show, so no option is claimed");
  assert.equal(serializeStory(parseStory(text)), text, "and it is written back as it was");
});

test("story: a line that is only a `#`-run is its own kind", () => {
  const text = storyFixture(["title: A", "---", "#Tech #line:04d5e6f"]);
  const line = storyLines(parseStory(text).nodes[0])[0];
  assert.equal(line.kind, "hashtag");
  assert.equal(line.id, "04d5e6f");
  assert.deepEqual(line.tags, ["#Tech", "#line:04d5e6f"]);
  assert.equal(serializeStory(parseStory(text)), text);
});

test("story: every line kind the classifier can produce is in the frozen list", () => {
  const kinds = new Set();
  kinds.add(storyLines(parseStory(NODE_A).nodes[0])[0].kind);
  kinds.add(storyLines(parseStory(storyFixture(["// c"])).nodes[0])[0].kind);
  for (const line of storyLines(parseStory(NODE_A).nodes[0])) {
    kinds.add(line.kind);
  }
  for (const kind of kinds) {
    assert.ok(STORY_LINE_KINDS.indexOf(kind) !== -1, `${kind} is a listed kind`);
  }
  assert.ok(Object.isFrozen(STORY_LINE_KINDS), "the list is frozen: a caller cannot add a kind");
  assert.ok(STORY_LINE_KINDS.indexOf("other") !== -1, "`other` exists so no line is ever unrepresentable");
});

test("story: a body line no rule fits is `other`, and is still written back untouched", () => {
  const text = storyFixture(["title: A", "---", "$$$ not yarn $$$"]);
  const line = storyLines(parseStory(text).nodes[0])[0];
  assert.equal(line.kind, "other");
  assert.equal(line.raw, "$$$ not yarn $$$");
  assert.equal(serializeStory(parseStory(text)), text);
});

test("story: a blank line made of spaces keeps those spaces", () => {
  const text = storyFixture(["title: A", "---", "   ", "\t"]);
  const lines = storyLines(parseStory(text).nodes[0]);
  assert.deepEqual(lines.map((line) => line.kind), ["blank", "blank"]);
  assert.equal(serializeStory(parseStory(text)), text);
});

test("story: editing a speaker keeps the `#line:` id and every other line raw", () => {
  const story = parseStory(NODE_A);
  const node = story.nodes[0];
  const before = storyLines(node).map((line) => line.raw);
  const changed = setLineSpeaker(node, 1, "Company");
  assert.equal(changed.speaker, "Company");
  const out = serializeStory(story);
  assert.ok(out.includes("Company: 早。 #state:Idle #line:07c13ab "), "the id and the run stay put");
  assert.ok(!out.includes("Aistalt: 早。"), "the old speaker is gone");
  assert.ok(out.includes("=>Nerd: 看这个。"), "the arrow line is untouched");
  assert.ok(out.includes("    MaoGirl: 嗯。"), "so is the indented one");
  const after = storyLines(story.nodes[0]).map((line) => line.raw);
  assert.deepEqual(after.slice(2), before.slice(2), "no other line moved");
});

test("story: editing a speaker keeps the indent and the `=>`", () => {
  const story = parseStory(NODE_A);
  const node = story.nodes[0];
  assert.equal(setLineSpeaker(node, 2, "Cop").raw, "    Cop: 嗯。");
  assert.equal(setLineSpeaker(node, 3, "Aistalt").raw, "=>Aistalt: 看这个。");
});

test("story: editing text rewrites only the span between the colon and the tag run", () => {
  const story = parseStory(NODE_A);
  const node = story.nodes[0];
  const changed = setLineText(node, 1, "新的台词");
  assert.equal(changed.text, "新的台词");
  const out = serializeStory(story);
  assert.ok(out.includes("Aistalt: 新的台词 #state:Idle #line:07c13ab "), "speaker, tags and trailing space all kept");
  assert.ok(out.includes("=>Nerd: 看这个。"), "and the neighbouring lines are their raw text");
});

test("story: editing a line that is not dialogue changes nothing and says so", () => {
  const story = parseStory(NODE_A);
  const node = story.nodes[0];
  assert.equal(setLineText(node, 0, "x"), null, "a comment has no text span to rewrite");
  assert.equal(setLineSpeaker(node, 0, "x"), null);
  assert.equal(setLineText(node, 999, "x"), null, "an index off the end is not a line");
  assert.equal(serializeStory(story), NODE_A, "and the file is exactly what it was");
});

test("story: a fresh id is seven lowercase hex digits and is never one of `taken`", () => {
  const taken = new Set();
  for (let step = 0; step < 500; step += 1) {
    const id = nextLineId(taken);
    assert.match(id, /^[0-9a-f]{7}$/);
    assert.equal(taken.has(id), false, `${id} is fresh`);
    taken.add(id);
  }
  assert.equal(taken.size, 500, "500 draws, 500 distinct ids");
});

test("story: `nextLineId` steps past a taken id instead of rejecting the draw", () => {
  const first = nextLineId([]);
  assert.notEqual(nextLineId([first]), first, "the id that was just handed out is not handed out again");
  assert.match(nextLineId(new Set([first])), /^[0-9a-f]{7}$/);
});

test("story: `nextLineId` is deterministic -- the same taken set gives the same id", () => {
  const taken = ["07c13ab", "0123abc", "0abc123"];
  assert.equal(nextLineId(taken), nextLineId(taken));
  assert.equal(nextLineId(new Set(taken)), nextLineId(taken), "a Set and an array of the same ids agree");
  assert.notEqual(nextLineId(taken), nextLineId([]), "and a different taken set is a different starting point");
});

test("story: `LINE_ID` reads the marker wherever it sits on the line", () => {
  assert.equal(lineIdOf("A: 你好。 #line:07c13ab"), "07c13ab");
  assert.equal(lineIdOf("-> 再问 #line:0abc123"), "0abc123");
  assert.equal(lineIdOf("<<set $X = 1>> #line:0f0f0f0"), "0f0f0f0");
  assert.equal(lineIdOf("A: 没有标记。"), null);
  assert.equal(lineIdOf(""), null);
  assert.equal(lineIdOf(null), null);
  assert.ok(LINE_ID.test("A: x #line:07c13ab"), "the exported pattern matches a real marker");
  assert.equal(lineIdOf("#line:07c13ab").length, 7, "the corpus writes exactly seven characters");
});

test("story: `storyNodes` is one entry per node, with the header fields a list draws", () => {
  const story = parseStory(`${NODE_A}\n===\n${NODE_B}`);
  const nodes = storyNodes(story);
  assert.equal(nodes.length, 2);
  assert.deepEqual(nodes[0], {
    index: 0,
    title: "Morning",
    subtitle: "kitchen",
    when: "always",
    tags: ["#hub", "#reach"],
    lineCount: storyBodyCount(NODE_A_LINES),
    startLine: 1,
  });
  assert.deepEqual(nodes[1].title, "Night");
  assert.equal(nodes[1].when, "always");
  assert.deepEqual(nodes[1].tags, [], "a node with no `tags:` header has an empty list, not null");
});

test("story: `storyLines` gives every field, with nulls where a kind has none", () => {
  const node = parseStory(NODE_A).nodes[0];
  for (const line of storyLines(node)) {
    assert.equal(typeof line.kind, "string");
    assert.equal(typeof line.raw, "string");
    assert.equal(typeof line.indent, "string");
    assert.ok(Array.isArray(line.tags));
    assert.ok(line.speaker === null || typeof line.speaker === "string");
    assert.ok(line.text === null || typeof line.text === "string");
    assert.ok(line.id === null || typeof line.id === "string");
    assert.ok(line.state === null || typeof line.state === "string");
    assert.ok(line.command === null || typeof line.command === "string");
    assert.ok(line.comment === null || typeof line.comment === "string");
    assert.ok(JSON.stringify(line).length > 0, "an entry survives JSON.stringify");
    assert.equal(Object.prototype.hasOwnProperty.call(line, "edit"), false, "the dirty mark is not a field a caller sees");
  }
});

test("story: a parse of a serialize of a parse is structurally the same story", () => {
  const first = parseStory(`${NODE_A}\n===\n${NODE_B}`);
  const second = parseStory(serializeStory(first));
  assert.equal(serializeStory(second), serializeStory(first));
  assert.equal(second.nodes.length, first.nodes.length);
  assert.equal(second.eol, first.eol);
  assert.equal(second.trailingNewline, first.trailingNewline);
  assert.equal(second.bom, first.bom);
  assert.deepEqual(second.post, first.post);
  for (let at = 0; at < first.nodes.length; at += 1) {
    const left = first.nodes[at];
    const right = second.nodes[at];
    assert.deepEqual(right.separator.lines, left.separator.lines);
    assert.deepEqual(right.headerLines, left.headerLines);
    assert.deepEqual(right.rawBodyLines, left.rawBodyLines);
    assert.equal(right.title, left.title);
    assert.equal(right.when, left.when);
    assert.deepEqual(storyLines(right), storyLines(left), `node ${at} lists the same lines`);
  }
});

test("story: an edit is idempotent -- serializing twice does not rewrite the line again", () => {
  const story = parseStory(NODE_A);
  setLineSpeaker(story.nodes[0], 1, "Company");
  const once = serializeStory(story);
  assert.equal(serializeStory(story), once, "a second serialize is the same text");
  assert.equal(serializeStory(parseStory(once)), once, "and so is a parse and serialize of that text");
});

test("story: `storyAbout` names what was parsed in one line", () => {
  const one = storyAbout(parseStory(NODE_A));
  assert.ok(one.startsWith("yarn story: 1 node, "), one);
  const crlf = storyAbout(parseStory(storyFixture(["title: A", "---", "x"], "\r\n")));
  assert.ok(crlf.includes("CRLF line endings"), crlf);
  const bom = storyAbout(parseStory(`\uFEFF${NODE_A}`));
  assert.ok(bom.includes("a BOM, "), bom);
  const noTail = storyAbout(parseStory(storyFixture(["title: A", "---", "x"], "\n", false)));
  assert.ok(noTail.includes("no newline at the end"), noTail);
  assert.equal(storyAbout(null), "yarn story: nothing was parsed");
});

test("story: the module is pure -- no DOM, no imports, no clock", () => {
  const source = readFileSync(new URL("../story.mjs", import.meta.url), "utf8");
  /*
   * The prose is removed before the grep, and the grep would be wrong without
   * that: the module *documents* that its ids do not come from `Math.random`
   * and calls the file it parses "the document", so reading the raw text finds
   * both words in the sentences that promise the opposite.  What is checked is
   * the code.  (`readFileSync`, not `readFile`: this check has to be counted
   * before the summary at the bottom of this file runs, and a promise settles
   * after it, so a failure here would be reported too late to be seen.)
   */
  const code = source.replace(/\/\*[\s\S]*?\*\//g, " ");
  assert.equal(/^\s*import\s/m.test(code), false, "no imports at all");
  assert.equal(/\bwindow\b|\bdocument\b|\blocalStorage\b/.test(code), false, "no DOM");
  assert.equal(/Math\.random|Date\.now|new Date\(/.test(code), false, "no clock, no randomness");
});

/* ------------------------------------------------------------------ */
/* translation tables                                                  */
/* ------------------------------------------------------------------ */

export const CSV_HEAD = `${CSV_BOM}${CSV_COLUMNS.join(",")}\r\n`;

test("storycsv: a quoted row survives a round trip, byte for byte", () => {
  const text =
    CSV_HEAD +
    `en,line:07c13ab,"Aistalt: It means ""the storm is coming."", see?",E:\\tales\\a.yarn,Node,16,43ac4d62,\r\n`;
  const table = parseCsv(text);
  assert.equal(table.rows[0].text, 'Aistalt: It means "the storm is coming.", see?');
  assert.equal(table.rows[0].fieldCount, 8);
  assert.equal(serializeCsv(table), text);
});

test("storycsv: the byte order mark and the line ending are reported, not normalised", () => {
  const crlf = parseCsv(CSV_HEAD + "en,line:a,Hi,f,Node,1,00000000,\r\n");
  assert.equal(crlf.bom, true);
  assert.equal(crlf.eol, "\r\n");
  const lf = parseCsv("a,b\n1,2\n");
  assert.equal(lf.bom, false);
  assert.equal(lf.eol, "\n");
  assert.equal(serializeCsv(lf), "a,b\n1,2\n");
});

test("storycsv: a file with no trailing newline gets none back", () => {
  const text = "a,b\n1,2";
  assert.equal(serializeCsv(parseCsv(text)), text);
});

test("storycsv: a header-only table keeps its one line ending", () => {
  const text = `${CSV_HEAD}`;
  assert.equal(serializeCsv(parseCsv(text)), text);
  assert.equal(parseCsv(text).rows.length, 0);
});

test("storycsv: its SHA-256 agrees with the platform's, including the padding edges", () => {
  const hex = (text) => createHash("sha256").update(text, "utf8").digest("hex").slice(0, 8);
  const cases = ["", "a", "abc", "\u4f60\u597d", "\u{1F600}", "x".repeat(55), "x".repeat(56), "x".repeat(57), "x".repeat(64), "x".repeat(119), "x".repeat(120)];
  for (const text of cases) {
    assert.equal(lockOf(text), hex(text), `len=${text.length}`);
  }
  assert.equal(lockOf(""), "e3b0c442");
  assert.equal(lockOf("abc"), "ba7816bf");
});

test("storycsv: the lock is the first four bytes in big-endian order", () => {
  const digest = createHash("sha256").update("Hello", "utf8").digest();
  assert.equal(lockOf("Hello"), digest.subarray(0, 4).toString("hex"));
  assert.notEqual(lockOf("Hello"), digest.subarray(0, 4).reverse().toString("hex"));
});

test("storycsv: line ids normalise, and a non-hex id is not an id", () => {
  assert.equal(csvLineIdOf("line:07C13AB"), "07c13ab");
  assert.equal(idOfLine("07C13AB"), "line:07c13ab");
  assert.equal(csvLineIdOf("line:e4f5g6h"), null);
  assert.equal(csvLineIdOf("nope"), null);
  assert.notEqual(csvLineIdOf, lineIdOf, "this is not story.mjs's lineIdOf");
});

test("storycsv: line metadata splits into tags and a state", () => {
  const meta = metadataOf("Line metadata: Tech state:Funny");
  assert.deepEqual(meta.tags, ["Tech"]);
  assert.equal(meta.state, "Funny");
  assert.equal(metadataOf("Line metadata: state:Idle").state, "Idle");
  assert.deepEqual(metadataOf("").tags, []);
  assert.equal(metadataOf("").state, "");
});

test("storycsv: speakers come back in first-seen order, and a tight colon is not one", () => {
  const wide = parseCsv(
    "language,id,text,file,node,lineNumber,lock,comment\n" +
      "en,line:a,Aistalt: \u55e8\u3002,f,Node,1,00000000,\n" +
      "en,line:b,NoBody: \u4ec0\u4e48\uff1f,f,Node,2,00000000,\n" +
      "en,line:c,Aistalt: \u53c8\u89c1\u9762\u4e86\u3002,f,Node,3,00000000,\n",
  );
  assert.deepEqual(speakersOf(wide.rows), ["Aistalt", "NoBody"]);
  const tight = parseCsv("h\nen,line:d,Aistalt:\u76d1\u7763\uff0c\u5373\u4fbf,f,Node,4,00000000,\n");
  assert.deepEqual(speakersOf(tight.rows), []);
});

test("storycsv: comparison finds stale, untranslated, missing and orphan rows", () => {
  const head = "language,id,text,file,node,lineNumber,lock,comment\n";
  const source = parseCsv(
    head + `en,line:a,Hello,f,Node,1,${lockOf("Hello")},\n` + `en,line:b,World,f,Node,2,${lockOf("World")},\n`,
  );
  const current = compareTables(
    source,
    parseCsv(
      head +
        `ja,line:a,\u4f60\u597d,f,Node,1,${lockOf("Hello")},\n` +
        `ja,line:b,World,f,Node,2,${lockOf("World")},\n` +
        `ja,line:z,Orphan,f,Node,9,${lockOf("Orphan")},\n`,
    ),
  );
  assert.equal(current.translated, 2);
  assert.deepEqual(current.untranslated.map((row) => row.id), ["line:b"]);
  assert.deepEqual(current.missing, []);
  assert.deepEqual(current.orphan.map((row) => row.id), ["line:z"]);
  assert.deepEqual(current.stale, []);
  assert.equal(current.total, 2);
  assert.equal(current.language, "ja");

  const aged = compareTables(
    source,
    parseCsv(head + `ja,line:a,\u4f60\u597d,f,Node,1,deadbeef,\n`),
  );
  assert.equal(aged.stale.length, 1);
  assert.equal(aged.stale[0].id, "line:a");
  assert.equal(aged.stale[0].was, "deadbeef");
  assert.equal(aged.stale[0].now, lockOf("Hello"));
  assert.deepEqual(aged.missing.map((row) => row.id), ["line:b"]);

  const noLock = compareTables(
    source,
    parseCsv(head + `ja,line:a,\u4f60\u597d,f,Node,1,,\n`),
  );
  assert.deepEqual(noLock.stale, [], "a row with no lock is not called stale");
  assert.equal(noLock.untranslated.length, 0);
});

test("storycsv: editing a column rewrites that row and nothing else", () => {
  const text =
    "language,id,text,file,node,lineNumber,lock,comment\n" +
    `ja,line:a,\u4f60\u597d,f,Node,1,${lockOf("Hello")},\n` +
    `ja,line:b,World,f,Node,2,${lockOf("World")},\n`;
  const table = parseCsv(text);
  setColumn(table.rows[0], "text", "\u4f60\u597d, \u4e16\u754c");
  const lines = serializeCsv(table).split("\n");
  assert.equal(lines[0], text.split("\n")[0]);
  assert.equal(lines[1], `ja,line:a,"\u4f60\u597d, \u4e16\u754c",f,Node,1,${lockOf("Hello")},`);
  assert.equal(lines[2], text.split("\n")[2]);
  assert.throws(() => setColumn(table.rows[0], "nope", "x"), /unknown column/);
  assert.equal(looksLikeLock("deadbeef"), true);
  assert.equal(looksLikeLock("not a lock"), false);
});

test("storycsv: one row's verdict is the same one the summary counts", () => {
  const source = {
    id: "line:a",
    text: "Hello",
    fields: ["en", "line:a", "Hello", "f", "Node", "1", "00000000", ""],
  };
  assert.equal(rowState(source, null), "missing");
  assert.equal(rowState(source, { text: "\u4f60\u597d", lock: lockOf("Hello") }), "ok");
  assert.equal(rowState(source, { text: "Hello", lock: lockOf("Hello") }), "untranslated");
  assert.equal(rowState(source, { text: "\u4f60\u597d", lock: "deadbeef" }), "stale");
  assert.equal(rowState(source, { text: "\u4f60\u597d", lock: "" }), "ok", "no lock is not staleness");
  assert.equal(rowState(source, { text: "\u4f60\u597d", lock: "DEADBEEF" }), "stale", "the lock compares case-insensitively");

  const table = parseCsv("language,id,text,file,node,lineNumber,lock,comment\nja,line:a,\u4f60\u597d,f,Node,1,deadbeef,\n");
  const byId = rowsById(table);
  assert.equal(byId.get("line:a").text, "\u4f60\u597d");
  assert.equal(byId.get("line:b"), undefined);
  assert.equal(rowState(source, byId.get("line:a")), "stale");
});

test("storycsv: a row with an unexpected field count is reported, not silently accepted", () => {
  const table = parseCsv("language,id,text,file,node,lineNumber,lock,comment\nen,line:a,Hello,f\n");
  assert.equal(table.odd.length, 1);
  assert.equal(table.odd[0].fields, 4);
  assert.equal(table.rows.length, 1);
  assert.equal(table.rows[0].fieldCount, 4);
  assert.equal(table.rows[0].comment, "");
});

test("storycsv: the metadata table's five columns and LF endings are kept", () => {
  const text = "id,file,node,lineNumber,metadata\nline:a,E:\\a.yarn,Node,3,state:Happy\n";
  const table = parseCsv(text);
  assert.deepEqual(table.odd, []);
  assert.equal(table.eol, "\n");
  assert.equal(table.rows[0].fieldCount, 5);
  /*
   * The fifth field is `metadata` to the game and the fourth is `lineNumber`,
   * so under the eight names this module knows they land in `node` and `lock`.
   * That mismatch is why a rewrite writes `row.fields` back rather than the
   * named columns, and why this table still round-trips exactly.
   */
  assert.equal(table.rows[0].node, "state:Happy");
  assert.equal(table.rows[0].lock, "");
  assert.equal(serializeCsv(table), text);
});

test("storycsv: the module imports nothing, reads no clock and touches no DOM", () => {
  /*
   * Read synchronously: the summary below runs at module load, so a bare
   * `testAsync` here would record its failure after the `ok N/N` line -- or
   * escape as an unhandled rejection and take the whole summary with it.
   */
  const code = readFileSync(new URL("../storycsv.mjs", import.meta.url), "utf8");
  assert.equal(/^\s*import\b/m.test(code), false, "no imports");
  assert.equal(/\bwindow\b|\bdocument\b|\blocalStorage\b/.test(code), false, "no DOM");
  assert.equal(/Math\.random|Date\.now|new Date\(/.test(code), false, "no clock, no randomness");
});

/* ------------------------------------------------------------------ */
/* a line the story gains is a row the table owes                      */
/* ------------------------------------------------------------------ */

export const ADD_TABLE = [
  "language,id,text,file,node,lineNumber,lock,comment",
  "en,line:1111111,Aistalt: Hi.,E:\\UnityProject\\Infant God\\Assets\\YarnScripts\\Logic\\1.Welcome.yarn,Welcome_Node,19,072a7a30,",
  "en,line:2222222,Aistalt: Bye.,E:\\UnityProject\\Infant God\\Assets\\YarnScripts\\Logic\\1.Welcome.yarn,Welcome_Node,23,deadbeef,",
].join("\r\n") + "\r\n";

export const ADD_STORY = [
  "title: Welcome_Node",
  "tags: hub",
  "---",
  "Aistalt: Hi. #line:1111111",
  "Aistalt: Bye. #line:2222222",
  "===",
  "",
].join("\n");

/** The story with one line added after its first, re-read the way the card does. */
export function withAddedLine() {
  const story = parseStory(ADD_STORY);
  storyAddLine(story, 0, 1, "And again.");
  return parseStory(serializeStory(story));
}

test("story card: a new line is given an id no line had, and moves no other id", () => {
  const before = storyLineIds(parseStory(ADD_STORY));
  const after = storyLineIds(withAddedLine());
  assert.equal(before.length, 2);
  assert.equal(after.length, 3);
  assert.deepEqual(after.slice(0, 1), before.slice(0, 1));
  assert.deepEqual(after.slice(2), before.slice(1));
  assert.equal(before.includes(after[1]), false, "the new id was already in the file");
});

test("story card: a line's words are the ones a table's `text` column holds", () => {
  const lines = storyLines(withAddedLine().nodes[0]);
  assert.equal(storyLineText(lines[1]), "Aistalt: And again.");
  /* A line with no speaker is its own words; a line with no text is empty. */
  const option = storyLines(parseStory("title: T\n---\n-> Say nothing\n===\n").nodes[0]);
  assert.equal(storyLineText(option[0]), "Say nothing");
  assert.equal(storyLineText({ speaker: null, text: null }), "");
});

test("story card: the row for a new line names the id the line was given", () => {
  const story = withAddedLine();
  const table = parseCsv(ADD_TABLE);
  const line = storyLines(story.nodes[0])[1];
  const row = storyRowForLine(story, 0, 1, table);
  assert.equal(row.id, `line:${line.id}`);
  assert.equal(row.text, "Aistalt: And again.");
  assert.equal(row.lock, lockOf(row.text));
  assert.equal(row.language, "en");
  /* The path the game writes is the author's, so it comes from the table. */
  assert.equal(row.file, table.rows[0].file);
  assert.equal(row.node, "Welcome_Node");
  assert.equal(row.lineNumber, 24, "the node's highest line number, plus one");
  assert.equal(row.comment, "");
});

test("story card: a line with no id is owed no row", () => {
  const story = parseStory("title: T\n---\nAistalt: Hi.\n===\n");
  assert.equal(storyRowForLine(story, 0, 0, parseCsv(ADD_TABLE)), null);
  assert.equal(storyRowForLine(story, 0, 0, null), null);
  assert.equal(storyRowForLine(story, 9, 0, parseCsv(ADD_TABLE)), null);
});

test("story card: the row a new line gets reads back as the row that was written", () => {
  const table = parseCsv(ADD_TABLE);
  table.rows.push(rowFor(storyRowForLine(withAddedLine(), 0, 1, table)));
  const round = parseCsv(serializeCsv(table));
  assert.equal(round.rows.length, 3);
  assert.deepEqual(round.rows[2], table.rows[2]);
  assert.equal(round.eol, "\r\n");
  assert.equal(round.bom, false);
  /* Every other row is still the bytes it was. */
  assert.deepEqual(round.rows[0].fields, parseCsv(ADD_TABLE).rows[0].fields);
});

test("story card: a fresh row reads untranslated, and stale once the line changes", () => {
  const story = withAddedLine();
  const table = parseCsv(ADD_TABLE);
  const row = rowFor(storyRowForLine(story, 0, 1, table));
  const words = () => ({ text: storyLineText(storyLines(story.nodes[0])[1]) });
  assert.equal(rowState(words(), row), "untranslated");
  assert.equal(storySetText(story, 0, 1, "And again, changed."), true);
  assert.equal(rowState(words(), row), "stale");
});
