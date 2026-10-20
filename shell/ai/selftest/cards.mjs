/**
 * shell/ai/selftest/cards.mjs -- the agent layer's side of G49.
 *
 * The contract itself is tested next to the card layer
 * (`shell/web/selftest/agent.mjs`).  What only this side can prove is that the
 * Node adapter is the same module, and that a card declaration needs no
 * translation to go through the registry the agent loop actually uses:
 * `createToolRegistry()` accepts `buildCardTools()` output as-is.
 *
 * No RPC, no network, no filesystem: the mounted handles and the bridge are
 * stand-ins.
 */

import { strict as assert } from "node:assert";

import * as browserTools from "../../web/cards/agent-tools.mjs";
import {
  CARD_TOOL_PREFIX,
  CardToolError,
  buildCardTools,
  cardToolInventory,
  cardToolName,
  defineCardTool,
  isCardToolName,
} from "../cards.mjs";
import { createToolRegistry, invokeToolCall } from "../tools.mjs";
import { section, check } from "./harness.mjs";

/** One declaration shaped like the real editor's, with stand-in handlers. */
function editorTools(calls) {
  return [
    defineCardTool({
      kind: "editor",
      name: "read",
      description: "The open file's path and text.",
      handler: (handle) => ({ path: handle.path, text: handle.text() }),
    }),
    defineCardTool({
      kind: "editor",
      name: "check",
      description: "Ask the shell for the package this card opened.",
      handler: async (handle, args, bridge) => {
        calls.push(["check", handle.path, args, bridge.kind]);
        return bridge.call("mod.validate", { root: "Mods/MyMod" });
      },
    }),
  ];
}

export async function runCardsSection() {
  section("cards -- the tools a card declares, through the shell's registry");

  await check("the node adapter re-exports the browser module's contract", () => {
    assert.equal(buildCardTools, browserTools.buildCardTools);
    assert.equal(defineCardTool, browserTools.defineCardTool);
    assert.equal(CARD_TOOL_PREFIX, "card.");
    assert.equal(cardToolName("editor", "read"), "card.editor.read");
    assert.equal(isCardToolName("card.editor.read"), true);
    assert.equal(isCardToolName("kb.search"), false);
  });

  await check("a card declaration becomes a registry tool, read-only", async () => {
    const calls = [];
    const tools = buildCardTools({
      cards: [
        { kind: "editor", handle: { path: "Yarn/Story.yarn", text: () => "title: Start" }, spec: { agent: editorTools(calls) } },
        { kind: "editor", handle: null, spec: { agent: editorTools(calls) } },
      ],
      host: { call: async (name, params) => ({ name, params }) },
    });
    assert.deepEqual(tools.map((tool) => tool.name), ["card.editor.read", "card.editor.check"]);
    assert.ok(tools.every((tool) => tool.readOnly === true && tool.safety === "read-only"));

    const registry = createToolRegistry({ tools });
    assert.equal(registry.size, 2);
    assert.equal(registry.has("card.editor.read"), true);
    assert.equal(registry.has("card.editor.write"), false);
    assert.deepEqual(registry.openaiTools().map((entry) => entry.function.name),
      ["card.editor.read", "card.editor.check"]);
    assert.equal(registry.list()[0].safety, "read-only");
  });

  await check("invoking a card tool runs the card handler with its own handle", async () => {
    const calls = [];
    const registry = createToolRegistry({
      tools: buildCardTools({
        cards: [{ kind: "editor", handle: { path: "Yarn/Story.yarn", text: () => "title: Start" }, spec: { agent: editorTools(calls) } }],
        host: { call: async (name, params) => ({ name, params }) },
      }),
    });

    const read = await invokeToolCall(registry, {
      id: "call_1",
      type: "function",
      function: { name: "card.editor.read", arguments: "{}" },
    });
    assert.equal(read.ok, true);
    assert.deepEqual(read.result, { path: "Yarn/Story.yarn", text: "title: Start" });

    const checked = await invokeToolCall(registry, {
      id: "call_2",
      type: "function",
      function: { name: "card.editor.check", arguments: "{}" },
    });
    assert.equal(checked.ok, true);
    assert.deepEqual(checked.result, { name: "mod.validate", params: { root: "Mods/MyMod" } });
    assert.deepEqual(calls, [["check", "Yarn/Story.yarn", {}, "editor"]]);
  });

  await check("a card handler that throws is handler_failed, not a crash", async () => {
    const again = await invokeToolCall(
      createToolRegistry({
        tools: buildCardTools({
          cards: [{
            kind: "editor",
            handle: {},
            spec: {
              agent: [defineCardTool({
                kind: "editor",
                name: "broken",
                description: "throws on purpose",
                handler: () => { throw new CardToolError("unavailable", "the card is gone"); },
              })],
            },
          }],
          host: { call: async () => null },
        }),
      }),
      { id: "call_3", type: "function", function: { name: "card.editor.broken", arguments: "{}" } }
    );
    assert.equal(again.ok, false);
    assert.equal(again.error.code, "handler_failed");
    assert.match(again.error.message, /the card is gone/);
  });

  await check("two cards cannot declare the same tool", () => {
    assert.throws(
      () => buildCardTools({
        cards: [
          { kind: "editor", handle: {}, spec: { agent: editorTools([]) } },
          { kind: "editor", handle: {}, spec: { agent: editorTools([]) } },
        ],
        host: { call: async () => null },
      }),
      (error) => error instanceof CardToolError && /two cards declared the same tool/.test(error.message)
    );
  });

  await check("a card tool cannot ask for write access", () => {
    assert.throws(
      () => defineCardTool({ kind: "editor", name: "save", description: "write", safety: "write", handler: () => null }),
      (error) => error instanceof CardToolError && /read-only until a diff card exists/.test(error.message)
    );
  });

  await check("the inventory says which kinds declare tools, and which do not", () => {
    const inventory = cardToolInventory([
      { kind: "editor", title: "Editor", spec: { agent: editorTools([]) } },
      { kind: "settings", title: "Settings", spec: {} },
      { kind: "mod", title: "Mod", spec: null },
    ]);
    assert.deepEqual(inventory, [
      { kind: "editor", title: "Editor", registered: true, tools: ["card.editor.read", "card.editor.check"] },
      { kind: "settings", title: "Settings", registered: false, tools: [] },
      { kind: "mod", title: "Mod", registered: false, tools: [] },
    ]);
  });
}
