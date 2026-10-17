/**
 * cards/card-settings.mjs -- the settings card: the shell's preferences, edited as a form.
 *
 * Part of `cards.mjs`, which re-exports this file; see that file's header for
 * why the card layer is split the way it is.
 */
import { button, cardShell, h, makeStatus } from "./dom.mjs";

/**
 * The settings card (G48): the one place a card may talk about the machine
 * rather than the project.
 *
 * It edits exactly what `config.get`/`config.set` say it may edit -- the AI
 * provider, the view a window opens in, and how often the cards ask the kernel
 * what changed -- and it *shows* the rest (the workspace, the files that hold
 * these values) without offering to change it, because those are process
 * arguments and a change needs a restart.
 *
 * The renderer never judges a value: `config.set` validates and writes, and its
 * message is what the status line shows.  A form that re-implemented the rules
 * would eventually disagree with the store that owns them, and the store is the
 * one the API calls actually read.
 */
export function renderSettings(card, ctx) {
  const { client } = ctx;

  function textInput(attrs) {
    return h("input", "settings-input", {
      attrs: Object.assign({ type: "text", spellcheck: "false" }, attrs),
    });
  }

  function numberInput(attrs) {
    return h("input", "settings-input", { attrs: Object.assign({ type: "number" }, attrs) });
  }

  function field(label, input, note) {
    const children = [h("span", "settings-label", { text: label }), input];
    if (note !== undefined) {
      children.push(h("span", "settings-note", { text: note }));
    }
    return h("div", "settings-field", { children });
  }

  function check(label, input) {
    return h("div", "settings-field settings-check", {
      children: [input, h("span", "settings-label", { text: label })],
    });
  }

  function codeRow(label) {
    const value = h("code", "settings-path-value");
    const row = h("div", "settings-path", {
      children: [h("span", "settings-path-label", { text: label }), value],
    });
    return { row, value };
  }

  function option(value, label) {
    const el = document.createElement("option");
    el.value = value;
    el.textContent = label;
    return el;
  }

  const baseUrl = textInput({ placeholder: "https://api.deepseek.com/v1" });
  const model = textInput({ placeholder: "deepseek-chat" });
  const apiKey = h("input", "settings-input", {
    attrs: { type: "password", autocomplete: "off", placeholder: "no key stored" },
  });
  const temperature = numberInput({ min: "0", max: "2", step: "0.1" });
  const maxTokens = numberInput({ min: "1", max: "131072", step: "1" });
  const timeoutMs = numberInput({ min: "1", max: "3600000", step: "1000" });
  const stream = h("input", "", { attrs: { type: "checkbox" } });
  const clearKey = h("input", "", { attrs: { type: "checkbox" } });

  const aiBlock = h("div", "settings-block", {
    children: [
      h("h3", "settings-heading", { text: "AI provider" }),
      field("endpoint", baseUrl),
      field("model", model),
      field("api key", apiKey, "the stored key is never shown; leave it blank to keep it"),
      field("temperature", temperature),
      field("max tokens", maxTokens),
      field("timeout (ms)", timeoutMs),
      check("stream the answer", stream),
      check("forget the stored key", clearKey),
    ],
  });

  const bootView = h("select", "settings-input", {
    children: [option("mod", "mod"), option("classic", "classic")],
  });
  const watchPollMs = numberInput({ min: "250", max: "60000", step: "250" });
  const prefsBlock = h("div", "settings-block", {
    children: [
      h("h3", "settings-heading", { text: "this machine" }),
      field("opens in", bootView, "the view a new window starts in"),
      field("poll interval (ms)", watchPollMs, "how often the cards ask the kernel what changed"),
    ],
  });

  const userData = codeRow("user data");
  const prefsFile = codeRow("preferences");
  const aiFile = codeRow("ai provider");
  const electronSettings = codeRow("window settings");
  const workspaceRow = codeRow("workspace");
  const modsRow = codeRow("mods");
  const pathsBlock = h("div", "settings-block", {
    children: [
      h("h3", "settings-heading", { text: "where this lives" }),
      userData.row,
      prefsFile.row,
      aiFile.row,
      electronSettings.row,
      workspaceRow,
      modsRow,
    ],
  });

  const saveButton = button("save", "write the provider and the view", () => {
    save();
  });
  const reloadButton = button("reload", "read the settings again", () => {
    load();
  });
  const controls = h("div", "settings-controls", { children: [saveButton, reloadButton] });
  const status = makeStatus();
  const body = h("div", "card-body settings-body", {
    children: [pathsBlock, aiBlock, prefsBlock, controls, status],
  });
  const shell = cardShell(card, body);
  shell.label.textContent = "the user's machine";

  let last = null;

  function show(answer) {
    last = answer;
    const ai = answer?.ai ?? {};
    baseUrl.value = typeof ai.baseUrl === "string" ? ai.baseUrl : "";
    model.value = typeof ai.model === "string" ? ai.model : "";
    apiKey.value = "";
    apiKey.placeholder = ai.hasApiKey === true ? "stored key is kept; type to replace it" : "no key stored yet";
    temperature.value = ai.temperature === null || ai.temperature === undefined ? "" : String(ai.temperature);
    maxTokens.value = ai.maxTokens === null || ai.maxTokens === undefined ? "" : String(ai.maxTokens);
    timeoutMs.value = ai.timeoutMs === null || ai.timeoutMs === undefined ? "" : String(ai.timeoutMs);
    stream.checked = ai.stream !== false;
    clearKey.checked = false;
    const prefs = answer?.prefs ?? {};
    bootView.value = prefs.bootView === "classic" ? "classic" : "mod";
    watchPollMs.value = prefs.watchPollMs === null || prefs.watchPollMs === undefined
      ? "" : String(prefs.watchPollMs);
    const files = answer?.files ?? {};
    userData.value.textContent = answer?.userDir ?? "(unknown)";
    prefsFile.value.textContent = files.preferences ?? "(unknown)";
    aiFile.value.textContent = files.ai ?? "(unknown)";
    electronSettings.value.textContent = files.settings ?? "(unknown)";
    workspaceRow.value.textContent = answer?.app?.workspace ?? "(none)";
    modsRow.value.textContent = answer?.app?.modsRoot ?? "(none)";
    const notes = [];
    for (const list of [ai.warnings, ai.errors, prefs.warnings, prefs.errors]) {
      if (Array.isArray(list)) {
        notes.push(...list.map((item) => (item && typeof item === "object" ? item.message ?? String(item) : String(item))));
      }
    }
    status.textContent = notes.length === 0
      ? "saved in the user data directory; a window reads it on boot"
      : notes.join(" · ");
  }

  async function load() {
    status.textContent = "reading settings…";
    try {
      show(await client.call("config.get", {}));
    } catch (err) {
      status.textContent = `settings unavailable: ${err.message}`;
    }
  }

  /** Only the fields with something in them travel: a missing key keeps its default. */
  function gather() {
    const patch = { prefs: { bootView: bootView.value, watchPollMs: Number(watchPollMs.value) } };
    const ai = {};
    if (baseUrl.value.trim() !== "") {
      ai.baseUrl = baseUrl.value.trim();
    }
    if (model.value.trim() !== "") {
      ai.model = model.value.trim();
    }
    if (temperature.value !== "") {
      ai.temperature = Number(temperature.value);
    }
    if (maxTokens.value !== "") {
      ai.maxTokens = Number(maxTokens.value);
    }
    if (timeoutMs.value !== "") {
      ai.timeoutMs = Number(timeoutMs.value);
    }
    ai.stream = stream.checked;
    if (apiKey.value !== "") {
      ai.apiKey = apiKey.value;
    }
    if (clearKey.checked) {
      patch.clearKey = true;
    }
    patch.ai = ai;
    return patch;
  }

  async function save() {
    status.textContent = "writing…";
    try {
      show(await client.call("config.set", gather()));
      status.textContent = "saved; this window keeps its view until it is reloaded";
    } catch (err) {
      status.textContent = `not saved: ${err.message}`;
    }
  }

  load();

  return {
    el: shell.el,
    handle: {
      kind: "settings",
      focus() {
        baseUrl.focus();
      },
      load,
      save,
      value() {
        return last;
      },
    },
    destroy() {},
  };
}

/* ------------------------------------------------------------------ */
/* registrations                                                          */
/* ------------------------------------------------------------------ */

/*
 * The kinds this fork ships: the prototype's six, plus the three game surfaces
 * at the bottom.  Each registration is self-contained: a fork that wants a
 * different note card replaces this object, not a case in a switch three
 * hundred lines away.  Adding one is one more call, and the board, the command
 * line and the kernel need no change at all -- `card.kind` is already an open
 * string everywhere else.
 */
