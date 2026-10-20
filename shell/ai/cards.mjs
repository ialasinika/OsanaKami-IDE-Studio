/**
 * cards.mjs -- the agent layer's view of the card tools (G49).
 *
 * The contract itself lives in `shell/web/cards/agent-tools.mjs`, next to the
 * card kinds that declare it, because that file has to run in the window and
 * may import nothing.  This file is the Node-side name for the same contract:
 * `shell/ai/selftest.mjs`, a future server-side loop and the docs all reach it
 * here, and `buildCardTools` returns the exact shape `createToolRegistry()`
 * accepts (`name`, `description`, `parameters`, `safety`, `handler`), so a
 * declaration needs no translation layer.
 *
 * The two halves of the rule stay where they belong:
 *
 *   - what a card may declare -- `shell/web/cards/agent-tools.mjs`
 *   - what a run may call     -- `shell/main.mjs` `ai.*` verbs (read-only)
 *
 * Nothing here touches the filesystem, the network or the DOM.
 */

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
} from "../web/cards/agent-tools.mjs";
