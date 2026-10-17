/**
 * cards/card-runner.mjs -- the runner card: one command, its output, its exit code.
 *
 * Part of `cards.mjs`, which re-exports this file; see that file's header for
 * why the card layer is split the way it is.
 */
import { cardShell, h, makeStatus } from "./dom.mjs";
import { OutputBuffer, formatExit } from "./text.mjs";

export function renderRunner(card, ctx) {
  const { client, app } = ctx;
  const output = new OutputBuffer();
  const state = {
    runId: card.run_id !== undefined && card.run_id !== null ? card.run_id : null,
    running: false,
    exit: null,
    timer: null,
  };

  const cmdInput = h("input", "run-cmd", {
    attrs: { type: "text", spellcheck: "false", placeholder: "command…" },
  });
  cmdInput.value = typeof card.cmd === "string" ? card.cmd : "";

  const runButton = h("button", "card-button", { text: "run", attrs: { type: "button" } });
  const stopButton = h("button", "card-button", { text: "stop", attrs: { type: "button" } });
  const clearButton = h("button", "card-button", { text: "clear", attrs: { type: "button" } });
  const controls = h("div", "run-controls", {
    children: [cmdInput, runButton, stopButton, clearButton],
  });
  const view = h("pre", "run-out");
  const status = makeStatus();
  const body = h("div", "card-body card-body-runner", { children: [controls, view, status] });

  const shell = cardShell(card, body);
  const exitTag = h("span", "run-exit", { text: formatExit(state.exit) });
  shell.tools.append(exitTag);
  shell.label.textContent = "";

  function paint() {
    view.textContent = output.lines().join("\n");
    view.scrollTop = view.scrollHeight;
    exitTag.textContent = formatExit(state.exit);
    if (state.runId !== null) {
      status.textContent = `run ${state.runId} · ${state.running ? "running" : formatExit(state.exit)}`;
    } else {
      status.textContent = state.exit === null ? "not started" : formatExit(state.exit);
    }
    cmdInput.disabled = state.running;
    stopButton.disabled = !state.running;
  }

  /** Coalesce output into at most one repaint per interval. */
  function schedulePaint() {
    if (state.timer !== null) {
      return;
    }
    state.timer = setTimeout(() => {
      state.timer = null;
      paint();
    }, 60);
  }

  async function start() {
    const cmd = cmdInput.value.trim();
    if (cmd === "") {
      app.log("warn", "run: empty command");
      return;
    }
    if (state.running) {
      app.log("warn", `card ${card.id} is already running`);
      return;
    }
    card.cmd = cmd;
    app.boardTouched(true);
    output.clear();
    state.exit = null;
    paint();
    try {
      const result = await client.call("exec.start", {
        card_id: card.id,
        cmd,
        cwd: typeof card.cwd === "string" && card.cwd !== "" ? card.cwd : ".",
      });
      state.runId = result.run_id;
      state.running = true;
      card.run_id = state.runId;
      app.registerRun(result.run_id, card.id);
      paint();
    } catch (err) {
      status.textContent = `could not start: ${err.message}`;
      app.log("error", `exec.start failed: ${err.message}`);
    }
  }

  async function stop() {
    if (state.runId === null) {
      return;
    }
    try {
      await client.call("exec.stop", { run_id: state.runId });
    } catch (err) {
      app.log("error", `exec.stop failed: ${err.message}`);
    }
  }

  runButton.addEventListener("click", start);
  stopButton.addEventListener("click", stop);
  clearButton.addEventListener("click", () => {
    output.clear();
    paint();
  });
  cmdInput.addEventListener("keydown", (event) => {
    if (event.key === "Enter") {
      event.preventDefault();
      start();
      return;
    }
    event.stopPropagation();
  });
  cmdInput.addEventListener("input", () => {
    card.cmd = cmdInput.value;
    app.boardTouched(true);
  });

  paint();

  return {
    el: shell.el,
    handle: {
      kind: "runner",
      start,
      stop,
      focus() {
        cmdInput.focus();
        cmdInput.select();
      },
      owns(runId) {
        return state.runId !== null && state.runId === runId;
      },
      /**
       * Adopt a run started before its reply landed, so output emitted in that
       * window is not dropped on the floor.
       */
      adopt(runId) {
        if (state.runId !== null && state.runId !== runId) {
          return false;
        }
        state.runId = runId;
        state.running = true;
        card.run_id = runId;
        paint();
        return true;
      },
      output(data) {
        output.append(data);
        schedulePaint();
      },
      exit(code) {
        state.exit = code;
        state.running = false;
        state.runId = null;
        paint();
        app.boardTouched(true);
      },
    },
    destroy() {
      if (state.timer !== null) {
        clearTimeout(state.timer);
      }
    },
  };
}

/* -------------------- note -------------------- */
