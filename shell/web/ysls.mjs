/*
 * ysls.mjs -- the mod's own command schema, read so the story card can suggest
 * what an author is halfway through typing.
 *
 * Yarn Spinner's commands are not keywords: `AddAchievement`, `AddNPC`,
 * `ChangeController` and the rest are C# methods the game registered, and the
 * only place their names and parameters are written down is the `.ysls.json`
 * file the Yarn compiler emits from the mod's own source.  The schema is the
 * authority -- a hand-written list in this shell would be wrong the day the mod
 * adds a command, and wrong today in ways nobody would notice until a line
 * silently failed to run.
 *
 * The shape this was measured against (a mod's generated `.ysls.json`,
 * version 2: 136 commands, 63 functions, 166 parameters, no duplicate names):
 *
 *     { version: 2,
 *       commands:  [ { yarnName, definitionName, fileName, language, async,
 *                      containsErrors, location, parameters: [
 *                        { name, type, isParamsArray, defaultValue? } ] } ],
 *       functions: [ ...same..., return: { type } ] }
 *
 * `parameter.documentation` does not exist in this file and `defaultValue`
 * exists on three parameters out of 166, so a completion never invents a
 * description: it offers the name, the parameters and their types, and nothing
 * it did not read.
 *
 * This module is pure: no DOM, no imports, no clock.  The corpus is the bar, and
 * the card's own probe runs it over the real schema.
 */

/** The two kinds the schema keeps apart, in the order a card should offer them. */
export const YSLS_KINDS = ["command", "function"];

/** The parameter types this file uses.  Anything else is passed through. */
export const YSLS_TYPES = ["string", "number", "bool"];

/** The caret spot a suggestion would replace, or `null` when there is none. */
function spotOf(text, caret) {
  if (typeof text !== "string" || text === "") {
    return null;
  }
  const at = Number.isInteger(caret) && caret >= 0 && caret <= text.length
    ? caret
    : text.length;
  const open = text.lastIndexOf("<<", at);
  if (open === -1) {
    return null;
  }
  const typed = text.slice(open + 2, at);
  /* A command's name ends at the first space: past it the author is writing
     arguments, and a name suggestion there would replace an argument.  A `>`
     means the command is closed and the caret is somewhere after it. */
  if (typed.includes(">") || /\s/.test(typed)) {
    return null;
  }
  return { prefix: typed, start: open + 2, end: at };
}

/**
 * What the author is halfway through typing, if it is a command's name.
 *
 * Answers `{prefix, start, end}` -- the name typed so far and the span a
 * suggestion would replace -- or `null` when the caret is not in a `<<...>>`
 * name.  `<<` is looked up rather than parsed, because this runs on every
 * keystroke in a line that is already parsed.
 */
export function commandTypedAt(text, caret) {
  return spotOf(text, caret);
}

/**
 * Put a name where the author was typing, keeping the rest of the line and
 * putting the caret after the inserted name.
 */
export function applyCommand(text, caret, name) {
  const spot = spotOf(text, caret);
  if (spot === null || typeof name !== "string" || name === "") {
    return { text, caret: Number.isInteger(caret) ? caret : String(text).length };
  }
  return {
    text: `${text.slice(0, spot.start)}${name}${text.slice(spot.end)}`,
    caret: spot.start + name.length,
  };
}

function parameterOf(raw) {
  const param = raw === null || typeof raw !== "object" ? {} : raw;
  const hasDefault = param.defaultValue !== undefined && param.defaultValue !== null;
  return {
    name: typeof param.name === "string" ? param.name : "",
    type: typeof param.type === "string" ? param.type : "",
    isParamsArray: param.isParamsArray === true,
    hasDefault,
    defaultValue: hasDefault ? String(param.defaultValue) : null,
  };
}

function entryOf(raw, kind) {
  const entry = raw === null || typeof raw !== "object" ? {} : raw;
  const parameters = Array.isArray(entry.parameters) ? entry.parameters.map(parameterOf) : [];
  const ret = entry.return === null || typeof entry.return !== "object" ? null : entry.return;
  return {
    name: typeof entry.yarnName === "string" ? entry.yarnName : "",
    kind,
    definitionName: typeof entry.definitionName === "string" ? entry.definitionName : "",
    fileName: typeof entry.fileName === "string" ? entry.fileName : "",
    documentation: typeof entry.documentation === "string" ? entry.documentation : "",
    isAsync: entry.async === true,
    /* A schema the compiler marked as broken is not something to suggest: the
       command exists in the file and does not exist in the game. */
    usable: entry.containsErrors !== true && typeof entry.yarnName === "string"
      && entry.yarnName !== "",
    parameters,
    returnType: ret !== null && typeof ret.type === "string" ? ret.type : null,
  };
}

/**
 * The schema as a card can use it: every command and function in the order the
 * file wrote them, with the fields this shell understands and no others.
 */
export function parseYsls(text) {
  let raw;
  try {
    raw = JSON.parse(String(text));
  } catch (err) {
    return { version: 0, commands: [], functions: [], entries: [], error: err.message };
  }
  if (raw === null || typeof raw !== "object") {
    return { version: 0, commands: [], functions: [], entries: [], error: "not a JSON object" };
  }
  /* A file with neither list is not a schema with nothing in it: it is some
     other JSON that happens to parse, and reading it as an empty schema would
     silently complete nothing for the rest of the session. */
  if (!Array.isArray(raw.commands) && !Array.isArray(raw.functions)) {
    return {
      version: 0, commands: [], functions: [], entries: [],
      error: "no commands and no functions -- not a .ysls.json",
    };
  }
  const commands = (Array.isArray(raw.commands) ? raw.commands : []).map((e) => entryOf(e, "command"));
  const functions = (Array.isArray(raw.functions) ? raw.functions : []).map((e) => entryOf(e, "function"));
  return {
    version: Number.isInteger(raw.version) ? raw.version : 0,
    commands,
    functions,
    entries: [...commands, ...functions],
    error: "",
  };
}

/**
 * How a call to this entry is written, in one line.
 *
 * A command is a bare name followed by its arguments (`AddAchievement
 * achievementTechName:string`); a function is called with parentheses and may
 * answer (`HasAchievement(achievementTechName:string) -> bool`), because that
 * is the difference the schema is drawing by keeping the two lists apart.
 */
export function yslsSignature(entry) {
  const item = entry === null || typeof entry !== "object" ? {} : entry;
  const params = (Array.isArray(item.parameters) ? item.parameters : []).map((param) => {
    const type = param.type === "" ? "" : `:${param.type}`;
    return `${param.name}${type}${param.isParamsArray ? "..." : ""}`;
  });
  const name = typeof item.name === "string" ? item.name : "";
  if (item.kind === "function") {
    const ret = typeof item.returnType === "string" && item.returnType !== ""
      ? ` -> ${item.returnType}`
      : "";
    return `${name}(${params.join(", ")})${ret}`;
  }
  return [name, ...params].join(" ");
}

/**
 * The entries to offer for `prefix`, best first, at most `limit`.
 *
 * A name that starts with what was typed beats a name that merely contains it,
 * and the schema's own order is kept inside each group: commands first, because
 * the file lists them first and a command is what an author is usually writing.
 * An empty prefix offers the head of the file rather than nothing, which is what
 * makes `<<` alone a way to browse the mod's commands.
 */
export function completeYsls(schema, prefix, limit = 8) {
  const source = schema === null || typeof schema !== "object" || !Array.isArray(schema.entries)
    ? []
    : schema.entries;
  const top = Number.isInteger(limit) && limit > 0 ? limit : 8;
  const needle = typeof prefix === "string" ? prefix.toLowerCase() : "";
  const starts = [];
  const contains = [];
  for (const entry of source) {
    if (entry.usable !== true) {
      continue;
    }
    const name = entry.name.toLowerCase();
    if (name.startsWith(needle)) {
      starts.push(entry);
    } else if (needle !== "" && name.includes(needle)) {
      contains.push(entry);
    }
  }
  return [...starts, ...contains].slice(0, top);
}

/** One line naming what was read, in the voice of `viewAbout`. */
export function yslsAbout(schema) {
  if (schema === null || typeof schema !== "object" || !Array.isArray(schema.entries)) {
    return "ysls: nothing was parsed";
  }
  if (typeof schema.error === "string" && schema.error !== "") {
    return `ysls: not a schema -- ${schema.error}`;
  }
  const commands = schema.commands.length;
  const functions = schema.functions.length;
  const version = schema.version === 0 ? "no version" : `version ${schema.version}`;
  return `ysls: ${commands} commands, ${functions} functions, ${version}`;
}
