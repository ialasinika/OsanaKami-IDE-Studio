/**
 * cards/registry.mjs -- the card-kind hook and the words a card uses about itself.
 *
 * Part of `cards.mjs`, which re-exports this file; see that file's header for
 * why the card layer is split the way it is.
 */

/**
 * Every registered kind, in registration order, keyed by `card.kind`.
 *
 * This map is the single extension point of the board's visual vocabulary.
 * It is a hook, not a plugin system: there is no loading, no sandbox, no
 * manifest, no version negotiation and no discovery.  A fork registers its
 * kinds in this file, or in a file it adds next to this one.
 */
export const KIND_REGISTRY = new Map();

/**
 * The shape `registerCardKind` accepts.  Documentation, not enforcement --
 * but it is the exact list `selftest.mjs` holds new kinds to.
 *
 * A kind is one object:
 *
 *   kind      string   must equal `card.kind` on the wire
 *   title     string   human name, used by the board's own UI
 *   describe  card => string
 *                      one line for the header; may not throw
 *   render    (card, ctx) => {el, handle, destroy}
 *                      the only required member
 *   create    () => object
 *                      the extra fields a *new* card of this kind starts with
 *
 * `render` gets `ctx = {client, app}` and owns its own DOM.  It reads and
 * writes whatever fields it likes on `card`, which for `sheet` is a nested
 * object rather than a string: nothing in the board, the protocol or the
 * kernel assumes a card's state is text.
 */
export const CARD_KIND_CONTRACT = Object.freeze({
  required: Object.freeze(["kind", "render"]),
  optional: Object.freeze(["title", "describe", "create"]),
});

/**
 * Register one card kind.  Returns the frozen spec, so the caller can hold on
 * to it and see exactly what the registry kept.
 *
 * Re-registering an existing kind throws unless `replace: true` is passed, so
 * a fork that means to override a built-in has to say so.
 */
export function registerCardKind(spec) {
  if (spec === null || typeof spec !== "object") {
    throw new TypeError("registerCardKind: spec must be an object");
  }
  const { kind } = spec;
  if (typeof kind !== "string" || kind === "") {
    throw new TypeError("registerCardKind: spec.kind must be a non-empty string");
  }
  if (typeof spec.render !== "function") {
    throw new TypeError(`registerCardKind: ${kind}.render must be a function`);
  }
  if (KIND_REGISTRY.has(kind) && spec.replace !== true) {
    throw new Error(`registerCardKind: card kind ${JSON.stringify(kind)} is already registered`);
  }
  const frozen = Object.freeze({
    title: kind,
    describe: (card) => `${kind} ${card.id}`,
    create: () => ({}),
    ...spec,
  });
  KIND_REGISTRY.set(kind, frozen);
  return frozen;
}

/** The spec registered for `kind`, or null. */
export function cardKind(kind) {
  return KIND_REGISTRY.get(kind) ?? null;
}

/** Every registered kind name, in registration order. */
export function knownCardKinds() {
  return [...KIND_REGISTRY.keys()];
}

/** One-line description of a card, used by the board header. */
export function describeCard(card) {
  if (card === null || typeof card !== "object") {
    return "no card selected";
  }
  const kind = typeof card.kind === "string" ? card.kind : "?";
  const spec = KIND_REGISTRY.get(kind);
  if (spec !== undefined) {
    try {
      const line = spec.describe(card);
      if (typeof line === "string" && line !== "") {
        return line;
      }
    } catch (err) {
      /* A kind whose describe() throws must not take the whole header down. */
      return `${kind} ${card.id} (describe threw)`;
    }
  }
  return `${kind} ${card.id}`;
}

/** The command line's `help` text. Kept here so README and UI agree. */
export const COMMAND_HELP = [
  "open <path>              open a file in a new editor card",
  "note <text>              drop a note card",
  "sheet [title]            drop a structured-data card (typed cells, not text)",
  "story <path>             open a .yarn file as nodes and lines, not text",
  "pixel <path.png> [w] [h]     draw a PNG: pixels are the file, not the board",
  "rig <path.skel.bytes>    show a Spine rig: bones, skins, animation timeline",
  "new <type> <dir> <name>  create a file from the game's own schemas",
  "import <from> <dir> [to] copy a file into a package (byte for byte), then open it",
  "example [name]           copy the demo package into the mods folder and open it",
  "run <cmd>                start a command in a runner card",
  "files [glob]             open the file list card",
  "project [glob]           open the project panel (the workspace as one project)",
  "mod <dir>                游戏 Mod 包卡片（打开目录、列出定义与 Yarn）",
  "problems <dir>           游戏 Mod 校验结果（错误/警告/提示，可跳转）",
  "docs [query]             游戏知识库：136 指令 / 63 函数 / 678 变量 / 1221 节点",
  "settings                 AI provider, default view and poll interval",
  "link <from> <to> [label] connect two cards",
  "unlink <linkId>          remove a connection",
  "focus <id>               select and centre a card",
  "delete <id>              remove a card",
  "save                     write the board to .infantgod/board.json",
  "undo                     take back the last board edit (Ctrl+Z)",
  "redo                     put it back (Ctrl+Shift+Z or Ctrl+Y)",
  "mode classic|mod        which way of looking at the same document",
  "log                      show or hide the message strip",
  "help                     list these commands, and open the card that quotes the sources",
  "clear                    empty the message strip",
];

/* ------------------------------------------------------------------ */
/* the sheet model (pure)                                                 */
/* ------------------------------------------------------------------ */

/**
 * What to show for a board entry that has no renderer: a kind this build does
 * not know, or -- because board.json is user-editable -- an entry that is not a
 * card at all.
 *
 * Pure and exported on purpose.  This is the one render path that must never
 * throw: one malformed entry in the file must not take the whole canvas down,
 * and its message is therefore worth checking without a browser.
 *
 * @param {object|null|undefined} card
 * @returns {{id: string, kind: string, label: string, message: string}}
 */
export function unknownCardPlaceholder(card) {
  const known = `Known kinds: ${knownCardKinds().join(", ")}.`;
  if (card === null || card === undefined) {
    return {
      id: "",
      kind: "(none)",
      label: "(missing)",
      message: "This board entry is empty (null), so there is nothing to render. "
        + `The entry is preserved in board.json until it is fixed there.  ${known}`,
    };
  }
  if (typeof card !== "object" || Array.isArray(card)) {
    return {
      id: "",
      kind: "(not a card)",
      label: "(malformed)",
      message: `This board entry is ${JSON.stringify(card)}, not a card object. `
        + `The entry is preserved in board.json until it is fixed there.  ${known}`,
    };
  }
  const kind = typeof card.kind === "string" && card.kind !== "" ? card.kind : "(no kind)";
  return {
    id: typeof card.id === "string" ? card.id : "",
    kind,
    label: "(unknown)",
    message: `No renderer for card kind ${JSON.stringify(card.kind)}. `
      + "The card is preserved in board.json; register a kind in cards.mjs."
      + `  ${known}`,
  };
}
