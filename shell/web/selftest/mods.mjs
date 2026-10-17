/* ------------------------------------------------------------------ */
/* the mod's own command schema, and the command line
/* ------------------------------------------------------------------ */

import assert from "node:assert/strict";
import {
  readFileSync,
} from "node:fs";
import {
  storyAcceptSuggestion,
  storyEditableText,
  storySuggestions,
  storyWriteText,
} from "../cards.mjs";
import {
  parseStory,
  serializeStory,
  storyLines,
} from "../story.mjs";
import {
  applyCommand,
  commandTypedAt,
  completeYsls,
  parseYsls,
  yslsAbout,
  yslsSignature,
} from "../ysls.mjs";
import {
  test,
} from "./harness.mjs";
import {
  edited,
} from "./main.mjs";

/* ------------------------------------------------------------------ */
/* the mod's own command schema                                         */
/* ------------------------------------------------------------------ */

/*
 * An inline schema, not the mod's own 87 KB one: this suite has to run in a
 * checkout that has no `Mods` directory beside it.  Every field here is one the
 * real `InfantGod-generated.ysls.json` really has -- that shape was measured over
 * the whole file before the module was written.
 */
export const YSLS_FIXTURE = JSON.stringify({
  version: 2,
  commands: [
    {
      yarnName: "AddAchievement",
      definitionName: "AddAchievement",
      fileName: "Achievements.cs",
      language: "csharp",
      async: false,
      containsErrors: false,
      location: "",
      parameters: [
        { name: "achievementTechName", type: "string", isParamsArray: false, defaultValue: null },
      ],
    },
    {
      yarnName: "AddItems",
      parameters: [{ name: "items", type: "string", isParamsArray: true, defaultValue: "none" }],
    },
    { yarnName: "Broken", containsErrors: true, parameters: [] },
    { yarnName: "", parameters: [] },
  ],
  functions: [
    {
      yarnName: "HasAchievement",
      containsErrors: false,
      parameters: [{ name: "achievementTechName", type: "string" }],
      return: { type: "bool" },
    },
  ],
});

test("ysls: the schema is read as its two lists, in the file's own order", () => {
  const schema = parseYsls(YSLS_FIXTURE);
  assert.equal(schema.error, "");
  assert.equal(schema.version, 2);
  assert.equal(schema.commands.length, 4);
  assert.equal(schema.functions.length, 1);
  assert.deepEqual(schema.entries.map((entry) => entry.name),
    ["AddAchievement", "AddItems", "Broken", "", "HasAchievement"]);
  assert.equal(schema.commands[0].kind, "command");
  assert.equal(schema.functions[0].kind, "function");
  assert.equal(schema.functions[0].returnType, "bool");
  assert.equal(schema.functions[0].return === undefined, true, "no field the shell did not make");
  assert.equal(schema.commands[0].parameters[0].name, "achievementTechName");
  assert.equal(schema.commands[1].parameters[0].isParamsArray, true);
  assert.equal(schema.commands[1].parameters[0].hasDefault, true);
  assert.equal(schema.commands[1].parameters[0].defaultValue, "none");
});

test("ysls: a file that is not a schema is refused, not read as an empty one", () => {
  assert.equal(parseYsls("{ nope").error === "", false);
  assert.equal(parseYsls("[1,2]").error === "", false);
  assert.equal(parseYsls('{"hello":1}').error.includes("not a .ysls.json"), true);
  /* An empty schema is a schema: the game writes both keys, empty or not. */
  const empty = parseYsls('{"version":2,"commands":[],"functions":[]}');
  assert.equal(empty.error, "");
  assert.equal(empty.entries.length, 0);
});

test("ysls: the schema's one sentence counts both lists and the version", () => {
  assert.equal(yslsAbout(parseYsls(YSLS_FIXTURE)), "ysls: 4 commands, 1 functions, version 2");
  assert.equal(yslsAbout(parseYsls("{ nope")).startsWith("ysls: not a schema"), true);
  assert.equal(yslsAbout(null), "ysls: nothing was parsed");
});

test("ysls: a call is written the way the schema draws it", () => {
  const schema = parseYsls(YSLS_FIXTURE);
  const [add, items] = schema.commands;
  assert.equal(yslsSignature(add), "AddAchievement achievementTechName:string");
  assert.equal(yslsSignature(items), "AddItems items:string...");
  assert.equal(yslsSignature(schema.functions[0]),
    "HasAchievement(achievementTechName:string) -> bool");
});

test("ysls: what is offered starts with what was typed, and never a broken name", () => {
  const schema = parseYsls(YSLS_FIXTURE);
  const names = (prefix, limit) => completeYsls(schema, prefix, limit).map((entry) => entry.name);
  assert.deepEqual(names("Add"), ["AddAchievement", "AddItems"]);
  assert.deepEqual(names("add"), ["AddAchievement", "AddItems"], "the match ignores case");
  assert.deepEqual(names("Achieve"), ["AddAchievement", "HasAchievement"],
    "a name that contains it comes after a name that starts with it");
  assert.deepEqual(names(""), ["AddAchievement", "AddItems", "HasAchievement"],
    "an empty prefix offers the file's own order, and skips what is unusable");
  assert.deepEqual(names("Add", 1), ["AddAchievement"], "the limit is the limit");
  assert.deepEqual(names("Broken"), [], "the compiler marked it broken");
  assert.deepEqual(names("zzz"), []);
});

test("ysls: the caret is in a command's name or it is not", () => {
  assert.deepEqual(commandTypedAt("<<Add", 5), { prefix: "Add", start: 2, end: 5 });
  assert.deepEqual(commandTypedAt("Hi <<Add", 8), { prefix: "Add", start: 5, end: 8 });
  assert.deepEqual(commandTypedAt("<<Add", 4), { prefix: "Ad", start: 2, end: 4 },
    "half a name is still inside the name");
  assert.equal(commandTypedAt("<<Add and words", 15), null, "a space ends the name");
  assert.equal(commandTypedAt("<<Add>>", 7), null, "a `>` closes the command");
  assert.equal(commandTypedAt("no command here", 5), null);
  assert.equal(commandTypedAt("Hi there", 99), null, "a caret past the end is no caret");
});

test("ysls: taking a name replaces the typed part and keeps the rest", () => {
  assert.deepEqual(applyCommand("<<Add", 5, "AddAchievement"),
    { text: "<<AddAchievement", caret: 16 });
  assert.deepEqual(applyCommand("Hi <<Add>> there", 8, "AddAchievement"),
    { text: "Hi <<AddAchievement>> there", caret: 19 });
  assert.deepEqual(applyCommand("no command", 5, "AddAchievement"),
    { text: "no command", caret: 5 }, "nothing to replace, nothing replaced");
  assert.deepEqual(applyCommand("<<Add", 5, ""), { text: "<<Add", caret: 5 });
});

test("ysls: the module imports nothing, reads no clock and touches no DOM", () => {
  const code = readFileSync(new URL("../ysls.mjs", import.meta.url), "utf8");
  assert.equal(/^\s*import\b/m.test(code), false, "no imports");
  assert.equal(/\bwindow\b|\bdocument\b|\blocalStorage\b/.test(code), false, "no DOM");
  assert.equal(/Math\.random|Date\.now|new Date\(/.test(code), false, "no clock, no randomness");
});

/* ------------------------------------------------------------------ */
/* the command line, and the schema's completion in the card            */
/* ------------------------------------------------------------------ */

export const COMMAND_STORY = [
  "title: T",
  "---",
  "  <<Add>>",
  "Aistalt: Hi. #line:1111111",
  "===",
  "",
].join("\n");

test("story card: a command line is edited as its command, not its indent", () => {
  /* The parser leaves `indent` empty on a command line and keeps the spaces in
     `raw`, so the indent comes off the raw line instead. */
  assert.equal(storyEditableText({ kind: "command", indent: "", raw: "  <<Add>>" }), "<<Add>>");
  assert.equal(storyEditableText({ kind: "command", indent: "", raw: "<<A>>" }), "<<A>>");
  assert.equal(storyEditableText({ kind: "dialogue", text: "Hi." }), "Hi.");
  assert.equal(storyEditableText(null), "");
  assert.equal(storyEditableText({ kind: "command" }), "", "a line with nothing in it is empty");
});

test("story card: writing a command back keeps its indent and the file's other lines", () => {
  const story = parseStory(COMMAND_STORY);
  const line = storyLines(story.nodes[0]).find((entry) => entry.kind === "command");
  assert.ok(line !== undefined, "the fixture has no command line");
  assert.equal(line.raw, "  <<Add>>");
  assert.equal(storyWriteText(story, 0, line.index, line, "<<AddAchievement>>"), true);
  const text = serializeStory(story);
  assert.equal(text.includes("  <<AddAchievement>>"), true, text);
  assert.equal(text.includes("#line:1111111"), true, "the line below is untouched");
  assert.equal(serializeStory(parseStory(text)), text, "and the file still round-trips");
  /* Writing a dialogue line through the same door edits its words, not its raw. */
  const words = storyLines(parseStory(COMMAND_STORY).nodes[0])[1];
  const dialogue = parseStory(COMMAND_STORY);
  assert.equal(storyWriteText(dialogue, 0, 1, words, "Bye."), true);
  assert.equal(serializeStory(dialogue).includes("Aistalt: Bye. #line:1111111"), true,
    serializeStory(dialogue));
});

test("story card: a `<<` in a line is completed from the schema, and prose is not", () => {
  const schema = parseYsls(YSLS_FIXTURE);
  const names = (result) => result.items.map((entry) => entry.name);
  const command = { kind: "command", indent: "", raw: "<<Add" };
  assert.deepEqual(names(storySuggestions(command, 5, schema)), ["AddAchievement", "AddItems"]);
  assert.deepEqual(storySuggestions(command, 5, null).items, [], "no schema, nothing to offer");
  assert.deepEqual(storySuggestions(null, 5, schema).items, []);
  const prose = { kind: "dialogue", text: "Hi.", tags: [] };
  assert.deepEqual(storySuggestions(prose, 3, schema).items, []);
  /* A `<<` inside dialogue is where an author writes a command, so it completes. */
  const inline = { kind: "dialogue", text: "Hi <<Add", tags: [] };
  assert.deepEqual(names(storySuggestions(inline, 13, schema)), ["AddAchievement", "AddItems"]);
  assert.equal(storySuggestions(command, 5, schema).text, "<<Add", "the text comes back too");
});

test("story card: taking a suggestion writes the name and puts the caret after it", () => {
  const command = { kind: "command", indent: "", raw: "<<Add" };
  assert.deepEqual(storyAcceptSuggestion(command, 5, "AddAchievement"),
    { text: "<<AddAchievement", caret: 16 });
  assert.deepEqual(storyAcceptSuggestion(command, 5, ""), { text: "<<Add", caret: 5 });
});
