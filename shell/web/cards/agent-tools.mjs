/**
 * cards/agent-tools.mjs -- the tools a card puts in an agent's hands (G49).
 *
 * Every card kind owns a piece of the studio -- a file being edited, a
 * package's diagnostics, a knowledge base lookup -- and until this file none of
 * them said so to the agent layer.  A kind now declares an `agent` array next
 * to its `render`:
 *
 *   registerCardKind({
 *     kind: "editor",
 *     render: renderEditor,
 *     agent: [defineCardTool({
 *       kind: "editor",
 *       name: "read",
 *       description: "The open file's path, saved state and text.",
 *       handler: (handle) => ({ path: handle.path, text: handle.text() }),
 *     })],
 *   });
 *
 * and the model sees `card.editor.read`.  The namespace is the point: the
 * agent can name the card it means without this layer inventing a second copy
 * of the editor, and a kind that declares nothing is visibly absent
 * (`cardToolInventory`) instead of silently exposed.
 *
 * Two properties are deliberate:
 *
 *   - Pure data and functions: no imports, no DOM, no RPC, no card instance.
 *     The host hands `buildCardTools` the mounted handles and the bridge a
 *     handler may use (`call`, the window's client).  That is what lets the
 *     contract be tested in Node, next to the rest of the card layer.
 *   - Read-only only.  `defineCardTool` rejects `safety: "write"`, because a
 *     write through a tool would bypass the diff card the tool layer is
 *     waiting for; when that card exists, this is the one place to grow.
 *
 * The Node side (`shell/ai/cards.mjs`) re-exports this file, so the tool
 * registry that already holds `kb.search` and `mod.validate` accepts card
 * declarations without a translation layer.
 */

/** Every card tool's name starts here; the rest is `<kind>.<verb>`. */
export const CARD_TOOL_PREFIX = "card.";

/** The one safety label a card tool may carry in this release. */
export const CARD_TOOL_SAFETY = Object.freeze(["read-only"]);

/** The shape of one declaration, for documentation and the tests that hold it. */
export const CARD_TOOL_CONTRACT = Object.freeze({
  required: Object.freeze(["kind", "name", "description", "handler"]),
  optional: Object.freeze(["parameters", "safety"]),
});

const KIND_NAME = /^[a-z][a-z0-9]*$/;

/** One bad declaration.  A code lets the chat loop report it as data. */
export class CardToolError extends Error {
  constructor(code, message) {
    super(message);
    this.name = "CardToolError";
    this.code = typeof code === "string" && code !== "" ? code : "invalid_tool";
  }
}

/** The tool name a declaration becomes: `card.<kind>.<name>`. */
export function cardToolName(kind, name) {
  return CARD_TOOL_PREFIX + kind + "." + name;
}

/**
 * Validate and freeze one card-tool declaration.
 *
 * Throws `CardToolError("invalid_tool")` on anything a kind could get wrong at
 * registration time, which is where such a mistake is cheap to see.
 */
export function defineCardTool(spec) {
  if (spec === null || typeof spec !== "object" || Array.isArray(spec)) {
    throw new CardToolError("invalid_tool", "defineCardTool: the spec must be an object");
  }
  const kind = spec.kind;
  if (typeof kind !== "string" || !KIND_NAME.test(kind)) {
    throw new CardToolError("invalid_tool",
      "defineCardTool: kind looks like a registered card kind: " + JSON.stringify(kind));
  }
  const name = spec.name;
  if (typeof name !== "string" || !KIND_NAME.test(name)) {
    throw new CardToolError("invalid_tool",
      "defineCardTool: name is one lower-case verb such as `read`: " + JSON.stringify(name));
  }
  const safety = spec.safety === undefined ? "read-only" : spec.safety;
  if (!CARD_TOOL_SAFETY.includes(safety)) {
    throw new CardToolError("invalid_tool",
      `defineCardTool: card.${kind}.${name}: safety ${JSON.stringify(safety)} is not allowed -- `
      + "card tools are read-only until a diff card exists");
  }
  const description = typeof spec.description === "string" ? spec.description.trim() : "";
  if (description === "") {
    throw new CardToolError("invalid_tool",
      `defineCardTool: card.${kind}.${name}: description is required and is what the model sees`);
  }
  if (typeof spec.handler !== "function") {
    throw new CardToolError("invalid_tool", `defineCardTool: card.${kind}.${name}: handler must be a function`);
  }
  const parameters = spec.parameters === undefined
    ? { type: "object", properties: {}, additionalProperties: false }
    : JSON.parse(JSON.stringify(spec.parameters));
  if (parameters === null || typeof parameters !== "object" || Array.isArray(parameters) ||
      parameters.type !== "object") {
    throw new CardToolError("invalid_tool",
      `defineCardTool: card.${kind}.${name}: parameters must be a JSON-schema object with type 'object'`);
  }
  return Object.freeze({
    kind,
    name,
    toolName: cardToolName(kind, name),
    description,
    parameters: deepFreeze(parameters),
    safety,
    handler: spec.handler,
  });
}

function deepFreeze(value) {
  if (value !== null && typeof value === "object") {
    for (const key of Object.keys(value)) {
      deepFreeze(value[key]);
    }
    Object.freeze(value);
  }
  return value;
}

/** The declarations a registered card kind carries (empty when it has none). */
export function cardAgentTools(spec) {
  const list = spec === null || spec === undefined ? undefined : spec.agent;
  if (list === undefined || list === null) {
    return [];
  }
  if (!Array.isArray(list)) {
    throw new CardToolError("invalid_tool", "a card kind's `agent` member must be an array of defineCardTool() results");
  }
  for (const tool of list) {
    if (tool === null || typeof tool !== "object" || typeof tool.toolName !== "string") {
      throw new CardToolError("invalid_tool", "a card kind's `agent` array holds only defineCardTool() results");
    }
  }
  return list;
}

/**
 * Turn mounted cards into tools the registry can hold.
 *
 * @param {{
 *   cards?: Array<{kind: string, handle: object|null, spec: object|null}>,
 *   host?: {call?: Function},
 * }} options
 *   A card that is not mounted yet (`handle` null) contributes nothing.
 *   `host.call(name, params)` is the bridge a handler may use; the window
 *   passes its RPC client, a test passes a recorder.
 * @returns {Array<{name, description, parameters, safety, readOnly, handler}>}
 */
export function buildCardTools(options = {}) {
  const cards = Array.isArray(options.cards) ? options.cards : [];
  const host = options.host !== null && typeof options.host === "object" ? options.host : {};
  const tools = [];
  const seen = new Set();
  for (const entry of cards) {
    if (entry === null || typeof entry !== "object") {
      continue;
    }
    const handle = entry.handle;
    if (handle === null || typeof handle !== "object") {
      continue;
    }
    for (const declaration of cardAgentTools(entry.spec ?? null)) {
      if (seen.has(declaration.toolName)) {
        throw new CardToolError("invalid_tool", `two cards declared the same tool: ${declaration.toolName}`);
      }
      seen.add(declaration.toolName);
      tools.push(Object.freeze({
        name: declaration.toolName,
        description: declaration.description,
        parameters: declaration.parameters,
        safety: declaration.safety,
        readOnly: declaration.safety === "read-only",
        handler: async (args) => {
          try {
            return await declaration.handler(handle, args ?? {}, { call: host.call, kind: declaration.kind });
          } catch (error) {
            if (error instanceof CardToolError) {
              throw error;
            }
            throw new CardToolError("handler_failed",
              `${declaration.toolName}: ${error && error.message ? error.message : String(error)}`);
          }
        },
      }));
    }
  }
  return tools;
}

/**
 * Which kinds declare what, without a mounted card: the answer the docs, the
 * agent card and the selftest can agree on.
 *
 * @param {Array<{kind: string, spec: object|null, title?: string}>} kinds
 * @returns {Array<{kind: string, title: string, registered: boolean, tools: string[]}>}
 */
export function cardToolInventory(kinds = []) {
  return kinds.map((entry) => {
    let tools = [];
    try {
      tools = cardAgentTools(entry.spec ?? null).map((tool) => tool.toolName);
    } catch {
      // A broken declaration is a registration bug; the inventory answers
      // "nothing usable" rather than taking the panel down.
      tools = [];
    }
    return {
      kind: entry.kind,
      title: typeof entry.title === "string" && entry.title !== "" ? entry.title : entry.kind,
      registered: tools.length > 0,
      tools,
    };
  });
}

/** Whether a model-visible name is one of ours. */
export function isCardToolName(name) {
  return typeof name === "string" && name.startsWith(CARD_TOOL_PREFIX) && name.length > CARD_TOOL_PREFIX.length;
}
