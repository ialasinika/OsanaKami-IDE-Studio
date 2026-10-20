/* ------------------------------------------------------------------ */
/* cards.mjs -- token spans and the pure helpers
/* ------------------------------------------------------------------ */

import assert from "node:assert/strict";
import { audioMime, audioSizeLabel, clockLabel, dataUrl, isAudioPath } from "../audioinfo.mjs";
import {
  COMMAND_HELP,
  COMPLETION_KIND_LABELS,
  COMPLETION_LIMIT,
  INDENT_UNIT,
  applyCompletion,
  applyTokenSpans,
  cardKind,
  completionKindLabel,
  completionState,
  describeSources,
  findMatches,
  formatAge,
  formatListing,
  formatSize,
  hoverLine,
  indentAfterEnter,
  indentSelection,
  isYarnPath,
  knownCardKinds,
  lineColumn,
  markHits,
  matchesFilter,
  modSectionCollapsed,
  normaliseTokenKind,
  replaceAllMatches,
  replaceMatchAt,
  segmentsText,
  setModSectionCollapsed,
  stepCompletion,
} from "../cards.mjs";
import {
  test,
} from "./harness.mjs";
test("settings: the sources rows say where the game and the knowledge came from", () => {
  const found = describeSources({
    game: { found: true, dir: "games/Mods", source: "env" },
    knowledge: { state: "present", path: "shell/mods/knowledge.json", source: "bundled", schemas: 51 },
  });
  assert.deepEqual(found.map((row) => row.label), ["game mods", "knowledge base"]);
  assert.equal(found[0].value, "games/Mods");
  assert.match(found[0].note, /found via env/);
  assert.equal(found[1].value, "shell/mods/knowledge.json");
  assert.match(found[1].note, /present · bundled · 51 schemas/);

  const missing = describeSources({
    game: { found: false, dir: null, source: "discover", tried: [{ path: "a" }, { path: "b" }] },
    knowledge: { state: "missing", path: null, source: "missing", schemas: 0, loadError: "no knowledge.json" },
  });
  assert.equal(missing[0].value, "not found");
  assert.match(missing[0].note, /looked in 2 places/);
  assert.equal(missing[1].value, "(none)");
  assert.equal(missing[2].label, "knowledge error");
  assert.match(missing[2].value, /no knowledge\.json/);
});


/* ------------------------------------------------------------------ */
/* cards.mjs -- token spans and the pure helpers                        */
/* ------------------------------------------------------------------ */

test("tokens: spans are applied in order, with the gap rendered as plain", () => {
  const text = "++ hello world";
  const tokens = [[0, 2, "command"], [10, 14, "keyword"]];
  const segments = applyTokenSpans(text, tokens);
  assert.deepEqual(segments, [
    { start: 0, end: 2, kind: "command" },
    { start: 2, end: 10, kind: "plain" },
    { start: 10, end: 14, kind: "keyword" },
  ]);
  assert.equal(segmentsText(text, tokens), text, "segments must reconstruct the text exactly");
});

test("tokens: a tiling tokenizer produces no plain filler", () => {
  const text = "++ [>+<]\n";
  const tokens = [[0, 2, "command"], [2, 3, "ws"], [3, 8, "command"], [8, 9, "ws"]];
  const segments = applyTokenSpans(text, tokens);
  assert.deepEqual(segments.map((seg) => seg.kind), ["command", "plain", "command", "plain"]);
  assert.equal(segmentsText(text, tokens), text);
});

test("tokens: ws/ident become plain, unknown kinds do not vanish", () => {
  assert.equal(normaliseTokenKind("ws"), "plain");
  assert.equal(normaliseTokenKind("ident"), "plain");
  assert.equal(normaliseTokenKind("keyword"), "keyword");
  assert.equal(normaliseTokenKind("wat"), "plain");
  assert.equal(normaliseTokenKind(undefined), "plain");
  const segments = applyTokenSpans("abcdef", [[0, 3, "keyword"], [3, 6, "wat"]]);
  assert.deepEqual(segments, [{ start: 0, end: 3, kind: "keyword" }, { start: 3, end: 6, kind: "plain" }]);
});

test("tokens: non-ASCII offsets are string indices, so colours do not drift", () => {
  // `langs/tokenize.mjs` scans a JavaScript string, so its offsets count UTF-16
  // code units -- the unit `.length` and `.slice` use. Byte offsets would put
  // every colour after a CJK character one glyph too early, which is what the
  // docs used to warn about; the implementation was measured and it does not.
  // `langs/selftest.mjs` measures the same thing one layer down, at the
  // tokeniser; this is the shell's segment layer, which must not re-derive.
  const text = "+++ \u4E2D\u6587 \u{1F600}";
  assert.equal(text.length, 9, "the fixture's unit length must differ from its byte length");
  assert.equal(Buffer.byteLength(text, "utf8"), 15);
  // Exactly what the tokenizer emits for this text: a command run, whitespace,
  // then one ident run over two CJK characters and a two-code-unit astral one.
  const tokens = [[0, 3, "command"], [3, 4, "ws"], [4, 9, "ident"]];
  assert.equal(segmentsText(text, tokens), text, "the offsets must reconstruct the text exactly");
  assert.deepEqual(
    applyTokenSpans(text, tokens).map((seg) => seg.kind),
    ["command", "plain", "plain"],
  );
  assert.deepEqual(applyTokenSpans(text, tokens).slice(-1)[0], { start: 4, end: 9, kind: "plain" });
});

test("indent: a bare caret gets one step, not a whole line", () => {
  const out = indentSelection("abc\n", 1, 1);
  assert.equal(out.text, `a${INDENT_UNIT}bc\n`);
  assert.deepEqual(
    [out.selectionStart, out.selectionEnd],
    [1 + INDENT_UNIT.length, 1 + INDENT_UNIT.length],
  );
});

test("indent: a selection indents every line it touches, not the rest", () => {
  const out = indentSelection("one\ntwo\nthree\n", 1, 5);
  assert.equal(out.text, `${INDENT_UNIT}one\n${INDENT_UNIT}two\nthree\n`);
  assert.equal(
    out.text.slice(out.selectionStart, out.selectionEnd),
    `${INDENT_UNIT}one\n${INDENT_UNIT}two`,
  );
});

test("indent: a selection ending on a newline does not drag the next line in", () => {
  const out = indentSelection("one\ntwo\n", 0, 4);
  assert.equal(out.text, `${INDENT_UNIT}one\ntwo\n`);
  assert.equal(out.selectionEnd, INDENT_UNIT.length + 3);
});

test("indent: shift+tab takes one step back and never eats real text", () => {
  const text = "\tone\n  two\nthree\n";
  const out = indentSelection(text, 0, text.length, { outdent: true });
  assert.equal(out.text, "one\ntwo\nthree\n");
  // One leading space is indentation too, and only that one character goes.
  assert.equal(indentSelection(" one\n", 0, 5, { outdent: true }).text, "one\n");
  assert.equal(indentSelection("one\n", 0, 4, { outdent: true }).text, "one\n");
});

test("indent: enter keeps the line's indentation and steps in after an opener", () => {
  assert.equal(indentAfterEnter("    foo"), "    ");
  assert.equal(indentAfterEnter("if (x) {"), INDENT_UNIT);
  assert.equal(indentAfterEnter(`    if (x) {`), INDENT_UNIT + INDENT_UNIT);
  assert.equal(indentAfterEnter(""), "");
  assert.equal(indentAfterEnter("    "), "    ");
});

test("find: matches are literal, left to right, and do not overlap", () => {
  assert.deepEqual(findMatches("aAaA", "aa"), [{ start: 0, end: 2 }, { start: 2, end: 4 }]);
  assert.deepEqual(findMatches("aaa", "aa"), [{ start: 0, end: 2 }]);
  assert.deepEqual(findMatches("HeLLo", "hello"), [{ start: 0, end: 5 }]);
  assert.deepEqual(findMatches("abc", ""), []);
  assert.deepEqual(findMatches("abc", "zz"), []);
});

test("find: a query whose case fold changes length stays case-sensitive", () => {
  // 'İ'.toLowerCase() is two code units, so a folded search could not report
  // offsets into the original text; that search falls back to exact matching.
  assert.equal("\u0130".toLowerCase().length, 2);
  assert.deepEqual(findMatches("\u0130x", "i\u0307"), []);
  assert.deepEqual(findMatches("\u0130x", "\u0130"), [{ start: 0, end: 1 }]);
});

test("replace: one match, or every match, and the rest of the text survives", () => {
  const text = "aa bb aa";
  const hits = findMatches(text, "aa");
  assert.equal(replaceMatchAt(text, hits[1], "Z"), "aa bb Z");
  assert.deepEqual(replaceAllMatches(text, "AA", "zZ"), { text: "zZ bb zZ", count: 2 });
  assert.deepEqual(replaceAllMatches(text, "nope", "zZ"), { text, count: 0 });
});

test("find: hits split coloured segments without moving a single character", () => {
  const text = "if (x) x";
  const segments = applyTokenSpans(text, [[0, 2, "keyword"]]);
  const marked = markHits(segments, findMatches(text, "x"), 1);
  assert.equal(marked.map((seg) => text.slice(seg.start, seg.end)).join(""), text);
  assert.deepEqual(marked.filter((seg) => seg.hit).map((seg) => seg.start), [4, 7]);
  assert.deepEqual(marked.filter((seg) => seg.current).map((seg) => seg.start), [7]);
  // A hit inside a coloured run keeps the run's kind on both sides of it.
  const split = markHits(applyTokenSpans("abc", [[0, 3, "keyword"]]), findMatches("abc", "b"));
  assert.deepEqual(
    split.map((seg) => [seg.start, seg.end, seg.kind, seg.hit]),
    [[0, 1, "keyword", false], [1, 2, "keyword", true], [2, 3, "keyword", false]],
  );
});

test("language: only a .yarn file asks the service", () => {
  assert.equal(isYarnPath("main.yarn"), true);
  assert.equal(isYarnPath("Mods/MyMod/yarn/Main.YARN"), true);
  assert.equal(isYarnPath("README.md"), false);
  assert.equal(isYarnPath(""), false);
  assert.equal(isYarnPath(null), false);
});

test("language: every context kind the service names has a label", () => {
  // The keys are the kinds `classify()` answers with; a kind the card meets but
  // does not know prints itself rather than nothing.
  assert.deepEqual(Object.keys(COMPLETION_KIND_LABELS).sort(), [
    "argument", "character", "command", "none", "speaker", "tag", "tagvalue", "variable",
  ]);
  assert.equal(completionKindLabel("command"), "指令");
  assert.equal(completionKindLabel("argument"), "参数");
  assert.equal(completionKindLabel("tagvalue"), "标签值");
  assert.equal(completionKindLabel("none"), "");
  assert.equal(completionKindLabel("something-new"), "something-new");
  assert.equal(completionKindLabel(null), "");
});

test("language: the menu shows at most eight rows and says how many it hid", () => {
  const many = [];
  for (let n = 0; n < 137; n += 1) {
    many.push({ label: `cmd${n}`, kind: "command", detail: "", insertText: `cmd${n} ` });
  }
  const answer = {
    context: { kind: "command", prefix: "", replace: { startOffset: 2, endOffset: 2 } },
    items: many,
  };
  const state = completionState("<<", 2, answer);
  assert.equal(state.open, true);
  assert.equal(state.kind, "command");
  assert.equal(state.kindLabel, "指令");
  assert.equal(state.items.length, COMPLETION_LIMIT);
  assert.equal(COMPLETION_LIMIT, 8);
  assert.equal(state.total, 137);
  assert.equal(state.more, true);
  assert.deepEqual(state.items[0].replace, { startOffset: 2, endOffset: 2 });
  // An item without its own span borrows the context's -- the two are the same
  // range, and a shell may send it once.
  const borrowed = completionState("<<", 2, {
    context: { kind: "command", replace: { startOffset: 2, endOffset: 2 } },
    items: [{ label: "set" }],
  });
  assert.deepEqual(borrowed.items[0].replace, { startOffset: 2, endOffset: 2 });
  assert.equal(borrowed.items[0].insertText, "set");
});

test("language: nothing to show closes the menu, and a missing answer is nothing", () => {
  const empty = completionState("<<", 2, {
    context: { kind: "command", replace: { startOffset: 2, endOffset: 2 } },
    items: [],
  });
  assert.equal(empty.open, false);
  assert.deepEqual(empty.items, []);
  assert.equal(empty.total, 0);
  assert.equal(empty.kindLabel, "指令");
  // A shell without the mod layer, an older kernel, a thrown call: the caller
  // passes null and the menu stays shut.
  const absent = completionState("<<", 2, null);
  assert.equal(absent.open, false);
  assert.deepEqual(absent.items, []);
  assert.equal(absent.kind, "");
  // Junk in the answer must not throw.
  assert.equal(completionState("x", 1, { items: "nope" }).open, false);
  assert.equal(completionState(null, null, { items: [{}] }).open, true);
});

test("language: accepting a candidate replaces exactly its span, caret after the text", () => {
  const command = completionState("<<jum", 5, {
    context: { kind: "command", prefix: "jum", replace: { startOffset: 2, endOffset: 5 } },
    items: [{ label: "jump", kind: "command", insertText: "jump ", replace: { startOffset: 2, endOffset: 5 } }],
  });
  assert.deepEqual(applyCompletion(command, command.items[0]), { text: "<<jump ", caret: 7 });
  // A speaker at the start of a line becomes the name and its colon; the rest
  // of the line is untouched.
  const speaker = completionState("Ai\nnext", 2, {
    context: { kind: "character", prefix: "Ai", replace: { startOffset: 0, endOffset: 2 } },
    items: [{ label: "Aistalt", insertText: "Aistalt: ", replace: { startOffset: 0, endOffset: 2 } }],
  });
  assert.deepEqual(applyCompletion(speaker, speaker.items[0]), { text: "Aistalt: \nnext", caret: 9 });
  // A quoted argument's span excludes the quotes the author already typed.
  const quoted = completionState('<<jump "Ai', 10, {
    context: { kind: "argument", replace: { startOffset: 8, endOffset: 10 } },
    items: [{ label: "Aistalt", insertText: "Aistalt", replace: { startOffset: 8, endOffset: 10 } }],
  });
  assert.deepEqual(applyCompletion(quoted, quoted.items[0]), { text: '<<jump "Aistalt', caret: 15 });
  // An out-of-range span is clamped, not trusted: the service's offsets are
  // for the text it was given, and the buffer is the authority.
  const wild = applyCompletion(
    { text: "ab", replace: { startOffset: 0, endOffset: 0 } },
    { insertText: "x", replace: { startOffset: 90, endOffset: 99 } },
  );
  assert.deepEqual(wild, { text: "abx", caret: 3 });
});

test("language: the arrows wrap at both ends and a closed menu has nowhere to go", () => {
  const items = [{}, {}, {}];
  assert.equal(stepCompletion({ items, index: 0 }, 1), 1);
  assert.equal(stepCompletion({ items, index: 2 }, 1), 0);
  assert.equal(stepCompletion({ items, index: 0 }, -1), 2);
  assert.equal(stepCompletion({ items, index: 1 }, 0), 1);
  assert.equal(stepCompletion({ items: [], index: 0 }, 1), -1);
  assert.equal(stepCompletion(null, 1), -1);
});

test("language: hover prints one plain line, and an empty answer clears it", () => {
  assert.equal(hoverLine(null), "");
  assert.equal(hoverLine({ contents: [] }), "");
  assert.equal(hoverLine({ contents: [{ kind: "markdown", value: "" }] }), "");
  assert.equal(
    hoverLine({ contents: [{ kind: "markdown", value: "**<<jump>>**\n\njumps to a node." }] }),
    "<<jump>> jumps to a node.",
  );
  // More than one block: the line is the first block, not a pile.
  assert.equal(
    hoverLine({ contents: [{ value: "first" }, { value: "second" }] }),
    "first",
  );
  assert.equal(hoverLine({ contents: [{ kind: "markdown", value: "#line:\n\n  a line id  " }] }), "line: a line id");
});

test("tokens: bad spans are dropped and overlaps are clipped", () => {
  const text = "0123456789";
  const tokens = [
    [100, 200, "keyword"],   // past the end
    [5, 5, "keyword"],       // empty
    [8, 3, "keyword"],       // inverted
    [0, 6, "comment"],
    [2, 9, "string"],        // overlaps the comment
    "nonsense",
    { start: 9, end: 10, kind: "number" },
  ];
  const segments = applyTokenSpans(text, tokens);
  assert.deepEqual(segments, [
    { start: 0, end: 6, kind: "comment" },
    { start: 6, end: 9, kind: "string" },
    { start: 9, end: 10, kind: "number" },
  ]);
  assert.equal(segmentsText(text, tokens), text);
  assert.deepEqual([...applyTokenSpans("", [])], []);
  assert.deepEqual([...applyTokenSpans("abc", null)], [{ start: 0, end: 3, kind: "plain" }]);
});

test("tokens: line/column readout matches the caret", () => {
  assert.deepEqual(lineColumn("ab\ncd", 0), { line: 1, column: 1 });
  assert.deepEqual(lineColumn("ab\ncd", 2), { line: 1, column: 3 });
  assert.deepEqual(lineColumn("ab\ncd", 3), { line: 2, column: 1 });
  assert.deepEqual(lineColumn("ab\ncd", 99), { line: 2, column: 3 });
});

test("files: formatListing sorts directories first and formats sizes", () => {
  const now = 1_000_000;
  const listing = {
    files: [
      { path: "tools/e2e.py", size: 2048, mtime: now - 3600, dir: false },
      { path: "examples", size: 0, mtime: now - 10, dir: true },
      { path: "core/src/app.c", size: 500, mtime: now - 90, dir: false },
      { path: "README.md", size: 5 * 1024 * 1024, mtime: now - 86400 * 3, dir: false },
      { path: "", size: 1, mtime: 0, dir: false },
      null,
    ],
    count: 5,
    truncated: true,
  };
  const { rows, count, truncated } = formatListing(listing, { now });
  assert.equal(count, 5);
  assert.equal(truncated, true);
  assert.deepEqual(rows.map((row) => row.path), [
    "examples", "README.md", "core/src/app.c", "tools/e2e.py",
  ]);
  assert.equal(rows[0].dir, true);
  assert.equal(rows[0].name, "examples");
  assert.equal(rows[1].sizeText, "5.0M");
  assert.equal(rows[1].ageText, "3d");
  assert.equal(rows[2].sizeText, "500B");
  assert.equal(rows[3].ageText, "1h");
  assert.deepEqual(formatListing({}).rows, []);
});

test("files: size and age formatting stay readable", () => {
  assert.equal(formatSize(0), "0B");
  assert.equal(formatSize(1023), "1023B");
  assert.equal(formatSize(1024), "1.0K");
  assert.equal(formatSize(1536), "1.5K");
  assert.equal(formatSize(10 * 1024), "10K");
  assert.equal(formatSize(-1), "");
  assert.equal(formatSize(NaN), "");
  assert.equal(formatAge(1000, 1000), "0s");
  assert.equal(formatAge(1000, 1060), "1m");
  assert.equal(formatAge(1000, 1000 + 7200), "2h");
  assert.equal(formatAge(NaN, 0), "");
});

test("files: the filter box understands globs and substrings", () => {
  assert.equal(matchesFilter("examples/hello.yarn", "**/*"), true);
  assert.equal(matchesFilter("examples/hello.yarn", "**/*.yarn"), true);
  assert.equal(matchesFilter("examples/sub/a.yarn", "**/*.yarn"), true);
  assert.equal(matchesFilter("core/src/app.c", "**/*.yarn"), false);
  assert.equal(matchesFilter("core/src/app.c", "app"), true);
  assert.equal(matchesFilter("core/src/app.c", "src/*.c"), false);
  assert.equal(matchesFilter("core/src/app.c", "core/src/*.c"), true);
  assert.equal(matchesFilter("anything", ""), true);
});

test("mod: a folded section is remembered on the card, not in the DOM", () => {
  // G54: the mod card folds mod.json / Defines / Yarn so a short window can
  // reach the lower sections.  The state has to survive a re-render, so it is a
  // field on the card document -- a missing field means "open", which is what a
  // board saved before this existed has.
  const card = { id: "c1" };
  assert.equal(modSectionCollapsed(card, "manifest"), false);
  assert.equal(modSectionCollapsed(card, "yarn"), false);

  setModSectionCollapsed(card, "manifest", true);
  assert.equal(modSectionCollapsed(card, "manifest"), true);
  assert.deepEqual(card.collapsed, { manifest: true });

  setModSectionCollapsed(card, "yarn", true);
  assert.deepEqual(card.collapsed, { manifest: true, yarn: true });

  // Opening one section must not open the others.
  setModSectionCollapsed(card, "manifest", false);
  assert.equal(modSectionCollapsed(card, "manifest"), false);
  assert.equal(modSectionCollapsed(card, "yarn"), true);
  assert.deepEqual(card.collapsed, { yarn: true });

  // Malformed or absent state opens the section rather than throwing.
  assert.equal(modSectionCollapsed({}, "defines"), false);
  assert.equal(modSectionCollapsed({ collapsed: null }, "defines"), false);
  assert.equal(modSectionCollapsed({ collapsed: "nope" }, "defines"), false);
  assert.equal(modSectionCollapsed(null, "defines"), false);
  setModSectionCollapsed(null, "defines", true);
  setModSectionCollapsed({ collapsed: "nope" }, "defines", true);
  assert.deepEqual(card.collapsed, { yarn: true }, "folding one card must not leak into another");
});

test("help: the card is registered and reads the registry's command list", () => {
  // G15: the help card is a card, so it must be a registered kind like any
  // other -- a kind that exists only in a menu item would not survive a board
  // reload.  Its command list is the one the command line prints, not a copy.
  assert.ok(knownCardKinds().includes("help"), "the help kind is registered");
  const help = cardKind("help");
  assert.equal(help.title, "Help");
  assert.equal(typeof help.render, "function");
  assert.ok(COMMAND_HELP.length >= 10, `the command list has ${COMMAND_HELP.length} rows`);
  assert.ok(COMMAND_HELP.some((row) => row.startsWith("help ")), "help is in the help list");
});

test("audio: a recording is recognised by extension, not by content", () => {
  // G2: the card is chosen before any byte is read, so the extension is the
  // only signal -- and a wrong "yes" would open the editor on bytes it must
  // refuse.  Case and query strings are normalised; dot-less names are not audio.
  assert.equal(audioMime("Voice/line1.wav"), "audio/wav");
  assert.equal(audioMime("Voice/LINE.OGG"), "audio/ogg");
  assert.equal(audioMime("Voice/line1.wav?x=1"), "audio/wav");
  assert.equal(audioMime("Voice/song.mp3"), "audio/mpeg");
  assert.equal(audioMime("Voice/take.flac"), "audio/flac");
  assert.equal(audioMime("Scripts/Mod.json"), null);
  assert.equal(audioMime("Voice/noext"), null);
  assert.equal(audioMime(null), null);
  assert.equal(isAudioPath("a/b/c.oga"), true);
  assert.equal(isAudioPath("a/b/c.png"), false);
});

test("audio: sizes and lengths are written the way a listener reads them", () => {
  assert.equal(audioSizeLabel(0), "0 B");
  assert.equal(audioSizeLabel(812.4), "812 B");
  assert.equal(audioSizeLabel(1024), "1.0 KiB");
  assert.equal(audioSizeLabel(49000), "47.9 KiB");
  assert.equal(audioSizeLabel(2.5 * 1024 * 1024), "2.5 MiB");
  assert.equal(audioSizeLabel(NaN), "unknown size");
  assert.equal(clockLabel(0), "0:00");
  assert.equal(clockLabel(3.4), "0:03");
  assert.equal(clockLabel(63), "1:03");
  assert.equal(clockLabel(3725), "1:02:05");
  assert.equal(clockLabel(Infinity), "--:--");
});

test("audio: bytes become a data URL the player can take", () => {
  // The shell's HTTP front end serves the app, not project files, so a card
  // that holds the bytes hands the player a data URL instead of a path.
  assert.equal(dataUrl("AAEC", "audio/wav"), "data:audio/wav;base64,AAEC");
  assert.equal(dataUrl("", ""), "data:application/octet-stream;base64,");
  assert.equal(dataUrl(null, null), "data:application/octet-stream;base64,");
});
