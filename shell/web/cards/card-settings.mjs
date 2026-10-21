/**
 * cards/card-settings.mjs -- the settings card: the shell's preferences, edited as a form.
 *
 * Part of `cards.mjs`, which re-exports this file; see that file's header for
 * why the card layer is split the way it is.
 */
import { button, cardShell, h, makeStatus, makeTranslations } from "./dom.mjs";
import { t } from "../i18n.mjs";

/**
 * G44: the two answers the settings card shows but may not edit -- where the
 * game's Mods folder was found (or where discovery looked when it was not),
 * and which knowledge.json is in effect.  Kept pure and exported so the suite
 * can pin the wording without a DOM: the card is only the renderer.
 */
export function describeSources(sources) {
  const game = (sources && sources.game) || {};
  const knowledge = (sources && sources.knowledge) || {};
  const plural = (count, word) => `${count} ${word}${count === 1 ? "" : "s"}`;
  const rows = [];
  if (game.found === true && typeof game.dir === "string" && game.dir !== "") {
    rows.push({ label: "game mods", value: game.dir, note: `found via ${game.source}` });
  } else {
    const tried = Array.isArray(game.tried) ? game.tried : [];
    rows.push({ label: "game mods", value: "not found", note: `looked in ${plural(tried.length, "place")}` });
  }
  const value = typeof knowledge.path === "string" && knowledge.path !== "" ? knowledge.path : "(none)";
  const bits = [typeof knowledge.state === "string" ? knowledge.state : "missing"];
  if (knowledge.source) bits.push(knowledge.source);
  if (Number.isFinite(knowledge.schemas)) bits.push(`${knowledge.schemas} schemas`);
  rows.push({ label: "knowledge base", value, note: bits.join(" · ") });
  const error = knowledge.loadError || knowledge.deriveError;
  if (error) rows.push({ label: "knowledge error", value: String(error), note: "" });
  return rows;
}

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
  // G56: the card follows the language while it is open; `tr.relabel()`
  // rewrites what is already on screen, from the same table the headings use.
  const tr = makeTranslations();

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
      h("h3", "settings-heading", { text: tr.text("settings.ai") }),
      field(tr.text("settings.endpoint"), baseUrl),
      field(tr.text("settings.model"), model),
      field(tr.text("settings.apiKey"), apiKey, tr.text("settings.apiKeyNote")),
      field(tr.text("settings.temperature"), temperature),
      field(tr.text("settings.maxTokens"), maxTokens),
      field(tr.text("settings.timeout"), timeoutMs),
      check(tr.text("settings.stream"), stream),
      check(tr.text("settings.forgetKey"), clearKey),
    ],
  });

  const bootView = h("select", "settings-input", {
    children: [option("mod", "mod"), option("classic", "classic")],
  });
  const watchPollMs = numberInput({ min: "250", max: "60000", step: "250" });
  // G56: a chooser, not a text field -- an unknown value in preferences.json is
  // normalized on the shell side, and the card only offers what the table has.
  const localeSelect = h("select", "settings-input", {
    children: [option("", t("settings.languageAuto")), option("en", "English"), option("zh", "中文")],
  });
  localeSelect.addEventListener("change", () => {
    if (ctx.app && typeof ctx.app.setLocale === "function") {
      ctx.app.setLocale(localeSelect.value);
      tr.relabel();
    }
  });
  const guideButton = button(tr.text("settings.guide"), "", () => {
    if (ctx.app && typeof ctx.app.openStartCard === "function") {
      ctx.app.openStartCard();
    }
  });
  const prefsBlock = h("div", "settings-block", {
    children: [
      h("h3", "settings-heading", { text: tr.text("settings.machine") }),
      field(tr.text("settings.opensIn"), bootView, tr.text("settings.opensInNote")),
      field(tr.text("settings.poll"), watchPollMs, tr.text("settings.pollNote")),
      field(tr.text("settings.language"), localeSelect, tr.text("settings.languageNote")),
      h("div", "settings-field settings-check", { children: [guideButton] }),
    ],
  });

  const userData = codeRow(tr.text("settings.userData"));
  const prefsFile = codeRow(tr.text("settings.preferences"));
  const aiFile = codeRow(tr.text("settings.aiFile"));
  const electronSettings = codeRow(tr.text("settings.windowSettings"));
  const workspaceRow = codeRow(tr.text("settings.workspace"));
  const modsRow = codeRow(tr.text("settings.mods"));
  const gameRow = codeRow(tr.text("settings.gameMods"));
  const knowledgeRow = codeRow(tr.text("settings.knowledge"));
  const gameNote = h("span", "settings-note");
  const knowledgeNote = h("span", "settings-note");
  const pathsBlock = h("div", "settings-block", {
    children: [
      h("h3", "settings-heading", { text: tr.text("settings.where") }),
      userData.row,
      prefsFile.row,
      aiFile.row,
      electronSettings.row,
      workspaceRow,
      modsRow,
      gameRow.row,
      gameNote,
      knowledgeRow.row,
      knowledgeNote,
    ],
  });

  const saveButton = button(tr.text("settings.save"), "", () => {
    save();
  });
  const reloadButton = button(tr.text("settings.reload"), "", () => {
    load();
  });
  const controls = h("div", "settings-controls", { children: [saveButton, reloadButton] });
  const status = makeStatus();
  const body = h("div", "card-body settings-body", {
    children: [pathsBlock, aiBlock, prefsBlock, controls, status],
  });
  const shell = cardShell(card, body);
  shell.label.textContent = tr.text("settings.machine");

  let last = null;

  /** G44: the read-only half -- filled from `mod.sources`, never editable. */
  function showSources(sources) {
    const rows = describeSources(sources);
    const game = rows[0];
    gameRow.value.textContent = game.value;
    gameNote.textContent = game.note;
    const knowledge = rows[1];
    knowledgeRow.value.textContent = knowledge.value;
    knowledgeNote.textContent = knowledge.note;
  }

  function show(answer) {
    last = answer;
    const ai = answer?.ai ?? {};
    baseUrl.value = typeof ai.baseUrl === "string" ? ai.baseUrl : "";
    model.value = typeof ai.model === "string" ? ai.model : "";
    apiKey.value = "";
    apiKey.placeholder = ai.hasApiKey === true ? tr.text("settings.apiKeyStored") : tr.text("settings.apiKeyNone");
    temperature.value = ai.temperature === null || ai.temperature === undefined ? "" : String(ai.temperature);
    maxTokens.value = ai.maxTokens === null || ai.maxTokens === undefined ? "" : String(ai.maxTokens);
    timeoutMs.value = ai.timeoutMs === null || ai.timeoutMs === undefined ? "" : String(ai.timeoutMs);
    stream.checked = ai.stream !== false;
    clearKey.checked = false;
    const prefs = answer?.prefs ?? {};
    bootView.value = prefs.bootView === "classic" ? "classic" : "mod";
    localeSelect.value = prefs.locale === "en" || prefs.locale === "zh" ? prefs.locale : "";
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
      ? tr.text("settings.saved")
      : notes.join(" · ");
  }

  async function load() {
    status.textContent = tr.text("settings.reading");
    let sources = null;
    try {
      sources = await client.call("mod.sources", {});
    } catch (err) {
      sources = null;
    }
    if (sources) {
      showSources(sources);
    } else {
      gameRow.value.textContent = "(unavailable)";
      gameNote.textContent = "the mod layer did not answer";
      knowledgeRow.value.textContent = "(unavailable)";
      knowledgeNote.textContent = "";
    }
    try {
      show(await client.call("config.get", {}));
    } catch (err) {
      status.textContent = `settings unavailable: ${err.message}`;
    }
  }

  /** Only the fields with something in them travel: a missing key keeps its default. */
  function gather() {
    const patch = { prefs: { bootView: bootView.value, watchPollMs: Number(watchPollMs.value), locale: localeSelect.value } };
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
    status.textContent = tr.text("settings.saving");
    try {
      show(await client.call("config.set", gather()));
      status.textContent = tr.text("settings.savedNow");
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
      relabel() {
        tr.relabel();
      },
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
