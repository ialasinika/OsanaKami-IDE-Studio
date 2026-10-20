/**
 * card-agent.mjs -- the seat where an agent works from, inside the window.
 *
 * The model is the shell's provider; the hands are the tools the mounted cards
 * declare (`shell/web/cards/agent-tools.mjs`) plus the shell's own read-only
 * verbs.  This card owns only the loop: ask, call the tools the answer names,
 * feed the results back, repeat.  A card tool runs here, against the live card;
 * a shell tool goes through `ai.invoke`, so what a model can do outside the
 * window is exactly what that frame allows -- today only `kb.search` and
 * `mod.validate`, both read-only.
 *
 * The loop is deliberately small and legible: six rounds, one request each,
 * no retries.  An agent that needs a diff card and a consent step before it
 * writes anything is a later round; this one proves the pipe.
 */

import { cardShell, h, makeStatus } from "./dom.mjs";

/** How many model turns one question gets before the card stops asking. */
const MAX_ROUNDS = 6;

/** The one sentence that keeps a small model from narrating instead of calling. */
const SYSTEM_PROMPT = [
  "You are working inside OsanaKami IDE Studio, a modding studio for a Unity game.",
  "Use the tools you are given: they read the files and documents the open cards",
  "are looking at, validate packages and search the game's knowledge base. Cite",
  "the file paths a tool returns. You cannot",
  "write anything; if an edit is needed, say exactly what it is.",
].join(" ");

/**
 * The messages a tool result contributes (OpenAI chat shape: one `tool` message
 * per call, keyed by the id the model chose).
 */
function toolMessages(calls, results) {
  return results.map((result, index) => ({
    role: "tool",
    tool_call_id: calls[index] && calls[index].id ? calls[index].id : `call_${index}`,
    content: JSON.stringify(result),
  }));
}

/** The tool calls in an assistant message, as an array whatever the model sent. */
function toolCallsOf(message) {
  const calls = message && Array.isArray(message.tool_calls) ? message.tool_calls : [];
  return calls.filter((call) => call && call.function && typeof call.function.name === "string");
}

export function renderAgent(card, ctx) {
  const { client, app } = ctx;
  const body = h("div", "card-body agent-body");
  const shell = cardShell(card, body);
  shell.label.textContent = "read-only, on the tools this window declares";
  const status = makeStatus();

  const note = h("p", "agent-note", {
    text: "Ask for a reading of the package, a validation pass, or a document. "
      + "The agent can only use the tools the open cards declare, and every one of "
      + "them is read-only.",
  });
  const log = h("div", "agent-log");
  const composer = h("div", "agent-composer");
  const input = h("textarea", "agent-input", {
    attrs: {
      rows: "2",
      placeholder: "e.g. what does the Lantern package get wrong, and which line?",
      "aria-label": "what should the agent look at",
    },
  });
  const ask = h("button", "agent-ask", { text: "Ask", attrs: { type: "button" } });
  const stop = h("button", "agent-stop", { text: "Stop", attrs: { type: "button", hidden: "" } });
  composer.append(input, h("div", "agent-actions", { children: [ask, stop] }));
  body.append(note, log, status, composer);

  const state = {
    history: [],
    busy: false,
    /** Bumped by Stop; a round that returns to a newer generation does nothing. */
    generation: 0,
  };
  /** card tool name -> the built tool, refreshed on every round (see toolSpecs). */
  const local = new Map();

  function say(author, text, kind = "") {
    const row = h("div", `agent-turn${kind ? ` ${kind}` : ""}`);
    row.append(
      h("div", "agent-role", { text: author }),
      h("div", "agent-text", { text }),
    );
    log.append(row);
    log.scrollTop = log.scrollHeight;
  }

  function setBusy(busy, label) {
    state.busy = busy;
    ask.disabled = busy;
    input.disabled = busy;
    stop.hidden = !busy;
    status.textContent = label || (busy ? "thinking" : "");
  }

  /**
   * The tools this card can offer: the shell's own read-only verbs, plus the
   * ones the mounted cards declare right now.
   *
   * The card tools are rebuilt on every round instead of cached, because the
   * handles they close over are the live cards: closing an editor must not
   * leave a `card.editor.read` answering from a tombstone.  A shell too old to
   * know `ai.tools` still yields the card tools, so the seat is never empty.
   */
  async function toolSpecs() {
    const spec = (tool) => ({
      type: "function",
      function: { name: tool.name, description: tool.description, parameters: tool.parameters },
    });
    local.clear();
    const declared = typeof app.cardTools === "function" ? app.cardTools() : [];
    for (const tool of declared) {
      local.set(tool.name, tool);
    }
    let fromShell = [];
    try {
      const answer = await client.call("ai.tools", {});
      fromShell = Array.isArray(answer.tools) ? answer.tools : [];
    } catch (error) {
      // A shell without ai.* verbs predates this round: the card tools still
      // work, and the status line says why the list is short.
      status.textContent = `no shell tools: ${error && error.message ? error.message : String(error)}`;
    }
    return [...declared.map(spec), ...fromShell];
  }

  /**
   * Run one tool call where it belongs: a card tool against the mounted card
   * here, a shell tool through `ai.invoke`, which is where the read-only
   * registry and its path sandbox live.
   */
  async function runTool(name, args) {
    const tool = local.get(name);
    if (tool !== undefined) {
      try {
        return { ok: true, name, result: await tool.handler(args) };
      } catch (error) {
        return { ok: false, name, error: error && error.message ? error.message : String(error) };
      }
    }
    return client.call("ai.invoke", { name, arguments: args });
  }

  /** One model turn with the tools in hand; returns the assistant message. */
  async function chatOnce(messages) {
    const tools = await toolSpecs();
    const answer = await client.call("ai.chat", {
      messages,
      tools,
      toolChoice: tools.length > 0 ? "auto" : undefined,
    });
    if (!answer || !answer.message) {
      throw new Error("the provider answered nothing this card can read");
    }
    return answer.message;
  }

  /**
   * Run one question to an answer.  Returns `{ok, text, rounds, toolCalls}` for
   * the caller (the smoke test and `handle.ask`); never throws for a model or
   * tool failure, because a failed round belongs on the card, not in a console.
   */
  async function converse(question) {
    const generation = state.generation;
    const stale = () => state.generation !== generation;
    const messages = [{ role: "system", content: SYSTEM_PROMPT }, ...state.history];
    messages.push({ role: "user", content: question });
    let rounds = 0;
    let toolCalls = 0;
    for (; rounds < MAX_ROUNDS; rounds += 1) {
      const message = await chatOnce(messages);
      if (stale()) {
        return { ok: false, text: "stopped", rounds, toolCalls };
      }
      const calls = toolCallsOf(message);
      if (calls.length === 0) {
        const text = typeof message.content === "string" ? message.content : "";
        state.history = messages.slice(2);
        state.history.push({ role: "assistant", content: text });
        return { ok: true, text, rounds, toolCalls };
      }
      // Keep the assistant message verbatim: the provider needs its own
      // `tool_calls` ids back before the `tool` messages that answer them.
      messages.push({ role: "assistant", content: message.content ?? "", tool_calls: calls });
      const results = [];
      for (const call of calls) {
        toolCalls += 1;
        let argumentsObject = {};
        try {
          argumentsObject = call.function.arguments ? JSON.parse(call.function.arguments) : {};
        } catch (error) {
          results.push({ ok: false, error: "the arguments were not JSON" });
          say(`tool ${call.function.name}`, "the arguments were not JSON", "agent-failed");
          continue;
        }
        const outcome = await runTool(call.function.name, argumentsObject);
        results.push(outcome && outcome.ok === true
          ? { ok: true, name: call.function.name, result: outcome.result }
          : { ok: false, name: call.function.name, error: (outcome && outcome.error) || "the call failed" });
        say(`tool ${call.function.name}`,
          outcome && outcome.ok === true ? "answered" : `failed: ${(outcome && outcome.error) || "no detail"}`,
          outcome && outcome.ok === true ? "" : "agent-failed");
      }
      messages.push(...toolMessages(calls, results));
    }
    return {
      ok: false,
      text: `the agent used ${MAX_ROUNDS} rounds without an answer`,
      rounds,
      toolCalls,
    };
  }

  async function askQuestion() {
    const question = input.value.trim();
    if (question === "" || state.busy) {
      return null;
    }
    input.value = "";
    say("you", question);
    setBusy(true);
    try {
      const result = await converse(question);
      if (result.ok) {
        say("agent", result.text || "(the answer had no text)");
        status.textContent = `${result.rounds + 1} turn(s), ${result.toolCalls} tool call(s)`;
      } else if (result.text !== "stopped") {
        say("agent", result.text, "agent-failed");
        status.textContent = "stopped without an answer";
      } else {
        say("agent", "stopped", "agent-failed");
      }
      app.log(result.ok ? "info" : "warn",
        `agent: ${result.ok ? "answered" : result.text} after ${result.toolCalls} tool call(s)`);
      return result;
    } catch (error) {
      const message = error && error.message ? error.message : String(error);
      say("agent", message, "agent-failed");
      status.textContent = "the round failed";
      app.log("warn", `agent: ${message}`);
      return { ok: false, text: message, rounds: 0, toolCalls: 0 };
    } finally {
      setBusy(false);
    }
  }

  function halt() {
    if (!state.busy) {
      return false;
    }
    state.generation += 1;
    setBusy(false, "stopped");
    return true;
  }

  ask.addEventListener("click", () => {
    askQuestion();
  });
  stop.addEventListener("click", () => {
    halt();
  });
  input.addEventListener("keydown", (event) => {
    event.stopPropagation();
    if (event.key === "Enter" && !event.shiftKey) {
      event.preventDefault();
      askQuestion();
    }
  });

  // A card that opens with a prompt in hand (the `agent <question>` command)
  // asks it once, the way the editor loads the file it was created with.
  if (typeof card.prompt === "string" && card.prompt.trim() !== "") {
    input.value = card.prompt;
    askQuestion();
  } else {
    status.textContent = "ready";
  }

  return {
    el: shell.el,
    handle: {
      kind: "agent",
      focus() {
        input.focus();
      },
      /** Drive one round from the smoke test or a future command. */
      ask(question) {
        if (typeof question === "string") {
          input.value = question;
        }
        return askQuestion();
      },
      stop() {
        return halt();
      },
      get busy() {
        return state.busy;
      },
      /** What the card has said so far, oldest first. */
      transcript() {
        return log.children.length;
      },
    },
    destroy() {
      state.generation += 1;
      state.busy = false;
    },
  };
}
