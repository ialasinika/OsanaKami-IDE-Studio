/**
 * selftest/agent.mjs -- the card tools an agent can be handed (G49).
 *
 * No model and no network here: `buildCardTools` is pure, so the checks give it
 * fake mounted handles and a recording bridge, then assert what a model would
 * see and what a handler would call.  The loop itself lives in the agent card
 * and is browser-only; what is provable without a window is the declaration,
 * the namespace, the read-only rule and the bridge.
 */

import assert from "node:assert/strict";
import { cardAgentTools, cardKind, cardToolInventory, knownCardKinds } from "../cards.mjs";
import {
  CARD_TOOL_PREFIX,
  CardToolError,
  buildCardTools,
  cardToolName,
  defineCardTool,
  isCardToolName,
} from "../cards/agent-tools.mjs";
import {
  test,
} from "./harness.mjs";

test("agent: the seat is a card, and the kinds that own data declare tools", () => {
  assert.equal(cardKind("agent").title, "Agent");
  assert.equal(typeof cardKind("agent").render, "function");
  assert.deepEqual(cardAgentTools(cardKind("agent")), []);

  const inventory = cardToolInventory(knownCardKinds().map((kind) => ({
    kind,
    spec: cardKind(kind),
    title: cardKind(kind).title,
  })));
  const byKind = new Map(inventory.map((row) => [row.kind, row]));
  assert.deepEqual([...byKind.get("editor").tools], ["card.editor.read", "card.editor.reveal"]);
  assert.deepEqual([...byKind.get("mod").tools], ["card.mod.diagnostics"]);
  assert.deepEqual([...byKind.get("problems").tools], ["card.problems.diagnostics"]);
  assert.deepEqual([...byKind.get("docs").tools], ["card.docs.lookup", "card.docs.search"]);
  for (const absent of ["agent", "settings", "help", "audio", "pixel", "story", "rig"]) {
    assert.equal(byKind.get(absent).registered, false, `${absent} must not claim a tool`);
  }
  for (const row of inventory) {
    for (const name of row.tools) {
      assert.ok(isCardToolName(name), `${name} carries the card namespace`);
      assert.ok(name.startsWith(CARD_TOOL_PREFIX));
      assert.equal(name, cardToolName(row.kind, name.slice((CARD_TOOL_PREFIX + row.kind + ".").length)));
    }
  }
});

test("agent: a card tool is read-only by construction", () => {
  assert.throws(
    () => defineCardTool({ kind: "editor", name: "write", description: "writes", handler() {}, safety: "write" }),
    (error) => error instanceof CardToolError && /read-only/.test(error.message),
  );
  assert.throws(
    () => defineCardTool({ kind: "Agent", name: "read", description: "x", handler() {} }),
    (error) => error instanceof CardToolError && /kind/.test(error.message),
  );
  assert.throws(
    () => defineCardTool({ kind: "editor", name: "read", handler() {} }),
    (error) => error instanceof CardToolError && /description/.test(error.message),
  );
  const tool = defineCardTool({ kind: "editor", name: "read", description: "reads", handler: () => 1 });
  assert.equal(tool.safety, "read-only");
  assert.ok(Object.isFrozen(tool));
  assert.deepEqual(tool.parameters, { type: "object", properties: {}, additionalProperties: false });
});

test("agent: built handlers reach the handle and the bridge, and say so when either is missing", async () => {
  const calls = [];
  const handle = {
    path: "Defines/Character/Warden.json",
    text: () => "{\"techName\":\"Warden\"}",
    dirty: false,
    revision: 7,
    reveal: (place) => place.line === 3 && place.pointer === "name",
  };
  const modHandle = { root: () => "Mods/Lantern" };
  const tools = buildCardTools({
    cards: [
      { kind: "editor", handle, spec: cardKind("editor") },
      { kind: "mod", handle: modHandle, spec: cardKind("mod") },
    ],
    host: {
      call: async (verb, params) => {
        calls.push([verb, params]);
        return {
          root: "C:/games/Mods/Lantern",
          ok: false,
          diagnostics: [
            { severity: "error", code: "D006", message: "sprite missing", path: "A" },
            { severity: "info", code: "M014", message: "partial", path: "B" },
          ],
          summary: { files: 4 },
        };
      },
    },
  });
  const byName = new Map(tools.map((tool) => [tool.name, tool]));
  for (const tool of tools) {
    assert.equal(tool.readOnly, true);
    assert.equal(tool.safety, "read-only");
  }

  assert.deepEqual(await byName.get("card.editor.read").handler({}), {
    path: "Defines/Character/Warden.json",
    text: "{\"techName\":\"Warden\"}",
    dirty: false,
    revision: 7,
  });
  assert.equal(await byName.get("card.editor.reveal").handler({ line: 3, pointer: "name" }), true);

  const answer = await byName.get("card.mod.diagnostics").handler({});
  assert.equal(calls[0][0], "mod.validate");
  assert.deepEqual(calls[0][1], { root: "Mods/Lantern" });
  assert.deepEqual(answer.counts, { error: 1, warning: 0, info: 1 });
  assert.equal(answer.root, "C:/games/Mods/Lantern");
  assert.equal(answer.diagnostics.length, 2);

  // A bridge that is not there is a tool failure the loop can report, not a
  // crash inside the card.
  const orphan = buildCardTools({ cards: [{ kind: "mod", handle: modHandle, spec: cardKind("mod") }] });
  await assert.rejects(
    () => orphan[0].handler({}),
    (error) => error instanceof CardToolError && error.code === "handler_failed" && /not connected/.test(error.message),
  );

  // Two cards of one kind cannot both answer to `card.mod.diagnostics`.
  assert.throws(
    () => buildCardTools({
      cards: [
        { kind: "mod", handle: modHandle, spec: cardKind("mod") },
        { kind: "mod", handle: modHandle, spec: cardKind("mod") },
      ],
    }),
    (error) => error instanceof CardToolError && /declared the same tool/.test(error.message),
  );
});
