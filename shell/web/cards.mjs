/**
 * cards.mjs -- one renderer and one behaviour set per card kind.
 *
 * DELETE THIS FILE and the document still opens; it just has no cards to show.
 * OsanaKami IDE Studio has no plugin system: extending the visual vocabulary means
 * editing a card module.  What it does have is a *hook* -- `registerCardKind()`
 * -- so that "adding a kind" is one self-contained object instead of an edit to a
 * switch in three places.  Thirteen kinds are registered at the bottom of this
 * file: editor, runner, note, files, project, sheet, story, pixel, rig, mod,
 * problems, docs and settings.
 *
 * The renderers and their models live under `cards/`, one concern per file; this
 * file is the stable surface.  The pure half (tokens, listings, commands, the
 * sheet and story models, blob transfer) imports nothing from the DOM and is what
 * `selftest.mjs` checks under Node.  The DOM half returns `{ el, handle, destroy }`
 * and a card never talks to the kernel directly -- it is driven through `ctx`.
 *
 * Token colours are applied to a `<pre>` that sits *under* a transparent
 * `<textarea>`, never by rewriting the text itself.  That keeps the caret alive
 * across re-tokenisation: the element being edited is never touched, at the cost
 * of both layers sharing identical metrics (see `style.css`) and the pre
 * scrolled in lockstep with the textarea.
 */

export {
  COMPLETION_KIND_LABELS,
  COMPLETION_LIMIT,
  INDENT_UNIT,
  OutputBuffer,
  applyCompletion,
  applyTokenSpans,
  completionKindLabel,
  completionState,
  countKinds,
  dirNameOf,
  findMatches,
  formatAge,
  formatExit,
  formatListing,
  formatSize,
  hoverLine,
  indentAfterEnter,
  indentSelection,
  isYarnPath,
  lineColumn,
  lineStartOffset,
  markHits,
  matchesFilter,
  normaliseTokenKind,
  parseCommandLine,
  parseZoomArgument,
  pointerKey,
  pointerOffset,
  projectRows,
  projectSummary,
  replaceAllMatches,
  replaceMatchAt,
  segmentsText,
  stepCompletion,
} from "./cards/text.mjs";
export {
  CARD_KIND_CONTRACT,
  COMMAND_HELP,
  cardKind,
  describeCard,
  knownCardKinds,
  registerCardKind,
  unknownCardPlaceholder,
} from "./cards/registry.mjs";
export {
  SHEET_TYPES,
  addSheetColumn,
  addSheetRow,
  coerceSheetValue,
  emptySheet,
  nextSheetSelection,
  normaliseSheet,
  removeSheetColumn,
  removeSheetRow,
  setSheetCell,
  sheetCell,
  sheetSummary,
  sheetToTSV,
  updateSheetColumn,
} from "./cards/sheet.mjs";
export {
  storyAcceptSuggestion,
  storyAddLine,
  storyEditableText,
  storyLineIds,
  storyLineText,
  storyRowForLine,
  storySetSpeaker,
  storySetText,
  storySuggestions,
  storyWriteText,
} from "./cards/story.mjs";
export {
  BLOB_CHUNK_BYTES,
  base64FromBytes,
  bytesFromBase64,
  isTooLargeFile,
  readTextFile,
  readTextInChunks,
  writeTextFile,
  writeTextInChunks,
} from "./cards/blob.mjs";
export { renderCard } from "./cards/dom.mjs";
export { PIXEL_NEW_SIZE, pixelColourOf, pixelInkOf, pixelPaletteOf } from "./cards/card-pixel.mjs";
export {
  spineAtlasPath,
  spineBaseOf,
  spineDirOf,
  spinePagePath,
  spineSkeletonPath,
} from "./cards/card-rig.mjs";
export {
  defineRel,
  diagCounts,
  diagFile,
  diagWhere,
  groupDefines,
  modHeadline,
  modPath,
  modSectionCollapsed,
  setModSectionCollapsed,
} from "./cards/card-mod.mjs";
export { diagLine, diagTarget } from "./cards/card-problems.mjs";
export { describeSources } from "./cards/card-settings.mjs";
// G49: the declarations a card kind puts in an agent's hands, and the builder
// that turns mounted cards into tools.  Re-exported here so the host imports
// the card layer once.
export {
  CARD_TOOL_CONTRACT,
  CARD_TOOL_PREFIX,
  CARD_TOOL_SAFETY,
  CardToolError,
  buildCardTools,
  cardAgentTools,
  cardToolInventory,
  cardToolName,
  defineCardTool,
  isCardToolName,
} from "./cards/agent-tools.mjs";

import { renderDocs } from "./cards/card-docs.mjs";
import { defineCardTool } from "./cards/agent-tools.mjs";
import { renderAgent } from "./cards/card-agent.mjs";
import { renderAudio } from "./cards/card-audio.mjs";
import { renderEditor } from "./cards/card-editor.mjs";
import { renderFiles } from "./cards/card-files.mjs";
import { renderHelp } from "./cards/card-help.mjs";
import { diagCounts, renderMod } from "./cards/card-mod.mjs";
import { renderNote } from "./cards/card-note.mjs";
import { PIXEL_NEW_SIZE, PIXEL_PALETTE, renderPixel } from "./cards/card-pixel.mjs";
import { renderProblems } from "./cards/card-problems.mjs";
import { renderProject } from "./cards/card-project.mjs";
import { renderRig } from "./cards/card-rig.mjs";
import { renderRunner } from "./cards/card-runner.mjs";
import { renderSettings } from "./cards/card-settings.mjs";
import { renderSheet } from "./cards/card-sheet.mjs";
import { renderStory } from "./cards/card-story.mjs";
import { registerCardKind } from "./cards/registry.mjs";
import { emptySheet, sheetSummary } from "./cards/sheet.mjs";

/* -- the agent surface (G49) ------------------------------------------ */

/*
 * What each kind tells an agent it may do.  Only kinds whose handle can answer
 * honestly are here; a kind that declares nothing is absent from
 * `cardToolInventory` rather than silently offered.  All six are read-only:
 * writes still go through the user, a save button and the diff card that does
 * not exist yet.
 */
function agentBridge(ctx, tool) {
  if (ctx === null || typeof ctx !== "object" || typeof ctx.call !== "function") {
    throw new Error(`${tool}: this card is not connected to the shell`);
  }
  return ctx.call;
}

/** Shared by the mod and problems cards: run the validator, report its shape. */
function diagnosticsTool(kind) {
  return defineCardTool({
    kind,
    name: "diagnostics",
    description:
      "Validate a package and return the counts plus the first 50 diagnostics. "
      + "Every diagnostic's path is relative to `root`, the resolved package folder.",
    parameters: {
      type: "object",
      properties: { root: { type: "string" } },
      additionalProperties: false,
    },
    handler: async (handle, args, ctx) => {
      const call = agentBridge(ctx, `card.${kind}.diagnostics`);
      const root = typeof args.root === "string" && args.root !== "" ? args.root : handle.root();
      if (root === "") {
        throw new Error(`card.${kind}.diagnostics: name a package first`);
      }
      const report = await call("mod.validate", { root });
      const counts = diagCounts(report.diagnostics);
      return {
        root: typeof report.root === "string" && report.root !== "" ? report.root : root,
        ok: report.ok === true,
        counts,
        diagnostics: report.diagnostics.slice(0, 50),
      };
    },
  });
}

const editorAgentTools = [
  defineCardTool({
    kind: "editor",
    name: "read",
    description: "The text this editor shows, its path, whether it has unsaved edits, and the last revision read.",
    handler: (handle) => ({
      path: handle.path,
      text: handle.text(),
      dirty: handle.dirty,
      revision: handle.revision,
    }),
  }),
  defineCardTool({
    kind: "editor",
    name: "reveal",
    description: "Scroll this editor to a line or a JSON pointer; true when the place exists in the text.",
    parameters: {
      type: "object",
      properties: { line: { type: "integer" }, pointer: { type: "string" } },
      additionalProperties: false,
    },
    handler: (handle, args) => handle.reveal({
      line: typeof args.line === "number" ? args.line : undefined,
      pointer: typeof args.pointer === "string" ? args.pointer : undefined,
    }) === true,
  }),
];

const docsAgentTools = [
  defineCardTool({
    kind: "docs",
    name: "lookup",
    description: "One documentation entry by kind and name, optionally from a package's own definitions.",
    parameters: {
      type: "object",
      properties: {
        kind: { type: "string" },
        name: { type: "string" },
        root: { type: "string" },
      },
      required: ["kind", "name"],
      additionalProperties: false,
    },
    handler: async (_handle, args, ctx) => {
      const call = agentBridge(ctx, "card.docs.lookup");
      const text = await call("mod.docFor", {
        kind: String(args.kind),
        name: String(args.name),
        root: typeof args.root === "string" && args.root !== "" ? args.root : undefined,
      });
      return { text };
    },
  }),
  defineCardTool({
    kind: "docs",
    name: "search",
    description: "Search the knowledge base (and optionally a package) for a word; returns matching entries.",
    parameters: {
      type: "object",
      properties: {
        query: { type: "string" },
        limit: { type: "integer" },
        root: { type: "string" },
      },
      required: ["query"],
      additionalProperties: false,
    },
    handler: async (_handle, args, ctx) => {
      const call = agentBridge(ctx, "card.docs.search");
      return call("mod.search", {
        query: String(args.query),
        limit: typeof args.limit === "number" ? args.limit : undefined,
        root: typeof args.root === "string" && args.root !== "" ? args.root : undefined,
      });
    },
  }),
];

registerCardKind({
  kind: "editor",
  title: "Editor",
  describe: (card) => `editor ${card.file || "(no file)"}`,
  create: () => ({ file: "" }),
  render: renderEditor,
  agent: editorAgentTools,
});

registerCardKind({
  kind: "runner",
  title: "Command",
  describe: (card) => `runner ${card.cmd || "(no command)"}`,
  create: () => ({ cmd: "", cwd: "" }),
  render: renderRunner,
});

registerCardKind({
  kind: "note",
  title: "Note",
  describe: (card) => `note ${card.id}`,
  create: () => ({ text: "" }),
  render: renderNote,
});

registerCardKind({
  kind: "files",
  title: "Files",
  describe: (card) => `files ${card.filter || "**/*"}`,
  create: () => ({ filter: "**/*" }),
  render: renderFiles,
});

registerCardKind({
  kind: "project",
  title: "Project",
  describe: (card) => `project ${card.filter || "**/*"}`,
  create: () => ({ filter: "**/*" }),
  render: renderProject,
});

registerCardKind({
  kind: "sheet",
  title: "Sheet",
  describe: (card) => `sheet ${card.title !== "" && card.title !== undefined ? card.title : sheetSummary(card.doc)}`,
  create: () => ({ title: "", doc: emptySheet() }),
  render: renderSheet,
});

registerCardKind({
  kind: "story",
  title: "Story",
  describe: (card) => `story ${card.file || "(no file)"}`,
  create: () => ({ file: "" }),
  render: renderStory,
});

registerCardKind({
  kind: "pixel",
  title: "Pixel",
  describe: (card) => `pixel ${card.file || "(no file)"}`,
  // The four fields are the whole board-side card.  `width`/`height` are the
  // *declared* size a missing file is created at -- the game's own 96x96 sprite
  // convention -- and `palette` travels in the document so a fork's colours come
  // back with the board.
  create: () => ({ file: "", width: PIXEL_NEW_SIZE, height: PIXEL_NEW_SIZE, palette: PIXEL_PALETTE.slice() }),
  render: renderPixel,
});

registerCardKind({
  kind: "rig",
  title: "Rig",
  describe: (card) => `rig ${card.file || "(no skeleton)"}`,
  // The document keeps what a reopening card should come back to; the pose time
  // and the camera do not belong to the board.
  create: () => ({ file: "", animation: "", skin: "", bones: true }),
  render: renderRig,
});

/* -- the three game surfaces ------------------------------------------ */

registerCardKind({
  kind: "mod",
  title: "Mod",
  describe: (card) => `mod ${card.dir || "(no dir)"}`,
  create: () => ({ dir: "" }),
  render: renderMod,
  agent: [diagnosticsTool("mod")],
});

registerCardKind({
  kind: "problems",
  title: "Problems",
  describe: (card) => `problems ${card.root || "(no mod)"}`,
  create: () => ({ root: "" }),
  render: renderProblems,
  agent: [diagnosticsTool("problems")],
});

registerCardKind({
  kind: "docs",
  title: "Docs",
  describe: (card) => `docs ${card.query || "(knowledge base)"}`,
  create: () => ({ query: "" }),
  render: renderDocs,
  agent: docsAgentTools,
});

registerCardKind({
  kind: "settings",
  title: "Settings",
  describe: () => "settings the user's machine",
  create: () => ({}),
  render: renderSettings,
});

registerCardKind({
  kind: "help",
  title: "Help",
  describe: () => "where the answers come from",
  create: () => ({}),
  render: renderHelp,
});

registerCardKind({
  kind: "audio",
  title: "Audio",
  describe: (card) => `audio ${card.file || "(no file)"}`,
  create: () => ({ file: "" }),
  render: renderAudio,
});

// G49: the agent seat.  It declares no tools of its own -- it is the caller,
// not one of the hands -- so it is deliberately absent from `cardToolInventory`.
registerCardKind({
  kind: "agent",
  title: "Agent",
  describe: (card) => `agent ${card.prompt || "(one conversation)"}`,
  create: () => ({ prompt: "" }),
  render: renderAgent,
});
