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
  markHits,
  matchesFilter,
  normaliseTokenKind,
  parseCommandLine,
  parseZoomArgument,
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
  readTextInChunks,
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
} from "./cards/card-mod.mjs";

import { renderDocs } from "./cards/card-docs.mjs";
import { renderEditor } from "./cards/card-editor.mjs";
import { renderFiles } from "./cards/card-files.mjs";
import { renderMod } from "./cards/card-mod.mjs";
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

registerCardKind({
  kind: "editor",
  title: "Editor",
  describe: (card) => `editor ${card.file || "(no file)"}`,
  create: () => ({ file: "" }),
  render: renderEditor,
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
});

registerCardKind({
  kind: "problems",
  title: "Problems",
  describe: (card) => `problems ${card.root || "(no mod)"}`,
  create: () => ({ root: "" }),
  render: renderProblems,
});

registerCardKind({
  kind: "docs",
  title: "Docs",
  describe: (card) => `docs ${card.query || "(knowledge base)"}`,
  create: () => ({ query: "" }),
  render: renderDocs,
});

registerCardKind({
  kind: "settings",
  title: "Settings",
  describe: () => "settings the user's machine",
  create: () => ({}),
  render: renderSettings,
});
