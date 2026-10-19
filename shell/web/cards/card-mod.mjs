/**
 * cards/card-mod.mjs -- the mod card: one package, its files, defines, sprites and diagnostics.
 *
 * Part of `cards.mjs`, which re-exports this file; see that file's header for
 * why the card layer is split the way it is.
 */
import { button, cardShell, fillRows, h, makeStatus, section } from "./dom.mjs";

/** Count diagnostics by severity; anything unrecognised counts as info. */
export function diagCounts(diagnostics) {
  const counts = { error: 0, warning: 0, info: 0 };
  for (const diagnostic of Array.isArray(diagnostics) ? diagnostics : []) {
    const raw = diagnostic && typeof diagnostic.severity === "string" ? diagnostic.severity : "";
    const severity = Object.prototype.hasOwnProperty.call(counts, raw) ? raw : "info";
    counts[severity] += 1;
  }
  return counts;
}

/** A define list grouped by type, types and names in alphabetical order. */
export function groupDefines(defines) {
  const byType = new Map();
  for (const define of Array.isArray(defines) ? defines : []) {
    const type = define && typeof define.type === "string" ? define.type : "(unknown)";
    if (!byType.has(type)) byType.set(type, []);
    byType.get(type).push(define);
  }
  return [...byType.entries()]
    .sort((a, b) => a[0].localeCompare(b[0]))
    .map(([type, items]) => ({
      type,
      items: items.slice().sort((a, b) => String(a.techName ?? "").localeCompare(String(b.techName ?? ""))),
    }));
}

/**
 * The mod-root-relative path of one define entry, or "".  `mod.open` names it
 * `file`; a host that still says `path` is read too, because a heading and a row
 * that cannot name their file are the same dead click.
 */
export function defineRel(item) {
  if (item === null || typeof item !== "object") {
    return "";
  }
  if (typeof item.file === "string" && item.file !== "") {
    return item.file;
  }
  return typeof item.path === "string" ? item.path : "";
}

/** The headline a `mod` card shows for an opened package. */
export function modHeadline(opened) {
  if (opened === null || typeof opened !== "object") {
    return "no mod opened";
  }
  const manifest = opened.manifest ?? {};
  const name = typeof manifest.name === "string" && manifest.name !== "" ? manifest.name : "(unnamed)";
  const version = typeof manifest.version === "string" && manifest.version !== "" ? manifest.version : "?";
  const order = typeof manifest.loadOrder === "number" ? manifest.loadOrder : "?";
  const game = typeof manifest.gameVersion === "string" && manifest.gameVersion !== "" ? manifest.gameVersion : "?";
  return `${name} ${version} — loadOrder ${order} · gameVersion ${game}`;
}

/**
 * Join a mod-relative path onto its root, so a card can hand the result to
 * `app.openFile`.  Absolute paths are left alone: `mod.*` results are
 * root-relative, but a fork that ever returns absolute ones still works.
 */
export function modPath(root, rel) {
  if (typeof rel !== "string" || rel === "") {
    return "";
  }
  const clean = rel.replace(/\\/g, "/");
  if (clean.startsWith("/") || /^[A-Za-z]:/.test(clean)) {
    return clean;
  }
  const base = typeof root === "string" ? root.replace(/\\/g, "/").replace(/\/+$/, "") : "";
  return base === "" ? clean : `${base}/${clean}`;
}

/** The file a diagnostic points at, without its `#json/pointer` suffix. */
export function diagFile(diagnostic) {
  const raw = diagnostic && typeof diagnostic.path === "string" ? diagnostic.path : "";
  return raw.split("#")[0];
}

/** Where inside that file the diagnostic sits, or the empty string. */
export function diagWhere(diagnostic) {
  const raw = diagnostic && typeof diagnostic.path === "string" ? diagnostic.path : "";
  const hash = raw.indexOf("#");
  return hash < 0 ? "" : raw.slice(hash + 1);
}

export function renderMod(card, ctx) {
  const { client, app } = ctx;

  const dirInput = h("input", "mod-dir", {
    attrs: {
      type: "text",
      spellcheck: "false",
      // `Mods/MyMod` pointed at `<workspace>/Mods/MyMod`, which is not where
      // `mod.open` resolves a relative name: it joins the *mods root* (the
      // workspace itself under `serve`). The example has to be a name that
      // works, and the hint under it says how relative paths are read.
      placeholder: "NewMod",
      title: "a name relative to the mods root, or an absolute path",
    },
  });
  dirInput.value = typeof card.dir === "string" ? card.dir : "";

  const openButton = button("open", "read mod.json and list the package", () => openMod());
  const validateButton = button("validate", "check every define and Yarn file", () => validate());
  const controls = h("div", "mod-controls", { children: [dirInput, openButton, validateButton] });

  /*
   * Creating one file (G50) is the same verb the command line uses: pick a kind,
   * pick a name, and the shell writes what its own knowledge base says the file
   * has to contain.  The list of kinds is read from `mod.types`, so a fork with
   * three schemas offers three kinds; the four kinds this side adds by hand are
   * the ones no schema describes (a story, a translation, a sprite) plus the two
   * that need a tool this editor does not have, and those are shown greyed with
   * the reason on them rather than hidden.
   */
  const newType = h("select", "mod-new-type", {
    attrs: { title: "what kind of file to create" },
  });
  const newName = h("input", "mod-new-name", {
    attrs: {
      type: "text",
      spellcheck: "false",
      placeholder: "Goods_Sword",
      title: "the new file's name -- for a define, the techName the file name has to equal",
    },
  });
  const newButton = button("new", "write a new file from the game's own schema, then open it", () => {
    createFile();
  });
  const newControls = h("div", "mod-controls mod-new", { children: [newType, newName, newButton] });

  /*
   * Importing an existing file (G50's other half) is the same three questions,
   * with a source instead of a kind: which file, into which package, and -- for
   * a file whose name says nothing about where it belongs -- an explicit target.
   * The file is copied byte for byte, so this row is also the way to bring a
   * translated table or a sprite from an old mod across without rewriting it.
   */
  const importFrom = h("input", "mod-import-from", {
    attrs: {
      type: "text",
      spellcheck: "false",
      placeholder: "<art>/icon.png",
      title: "the file to copy in -- absolute, or relative to the workspace",
    },
  });
  const importTo = h("input", "mod-import-to", {
    attrs: {
      type: "text",
      spellcheck: "false",
      placeholder: "Sprites/icon.png (optional)",
      title: "where it lands inside the package; only needed when the name does not say",
    },
  });
  const importButton = button("import", "copy a file into this package, byte for byte, then open it", () => {
    importFile();
  });
  const importControls = h("div", "mod-controls mod-import", {
    children: [importFrom, importTo, importButton],
  });

  /*
   * Exporting (G45) writes the container the community actually passes around:
   * a zip whose single top layer is the folder name, so unpacking it into the
   * game's `Mods/` lands as `Mods/<Name>/`.  The game does not read zips -- this
   * is transport.  The same validator runs first, so a package with errors does
   * not leave as a zip; warnings and infos ride along in the answer.
   *
   * The field takes a name relative to the mods root (the rule every write verb
   * uses) or an absolute path; empty means `<modsRoot>/<Name>.zip`.
   */
  const exportOut = h("input", "mod-export-out", {
    attrs: {
      type: "text",
      spellcheck: "false",
      placeholder: "(optional) FolderName.zip",
      title: "where the zip goes -- relative to the mods root, or absolute; empty means <modsRoot>/<Name>.zip",
    },
  });
  const exportButton = button("export zip", "write this package as a zip to hand to someone else", () => exportZip());
  const exportControls = h("div", "mod-controls mod-export", {
    children: [exportOut, exportButton],
  });

  /*
   * Installing (G11) is the last mile after `export`: the same package, but
   * straight into the folder the game reads, instead of a zip the author has to
   * unpack by hand.  The field is the game's Mods folder; it is usually
   * discovered without being typed, and it exists so a machine with two installs
   * can say which one.
   */
  const installDir = h("input", "mod-install-dir", {
    attrs: {
      type: "text",
      spellcheck: "false",
      placeholder: "(optional) the game's Mods folder",
      title: "where the game reads mods -- leave it empty to use the discovered folder",
    },
  });
  const installButton = button("install into game", "copy this package into the game's Mods folder", () => {
    installIntoGame();
  });
  const installControls = h("div", "mod-controls mod-install", {
    children: [installDir, installButton],
  });

  /*
   * What the game said (G12): the validator only knows what the files claim.
   * `Player.log` is the game's own verdict, and it is the file an author is
   * least likely to find on their own.  The name defaults to the opened package,
   * so the common case is one click.
   */
  const logName = h("input", "mod-log-name", {
    attrs: {
      type: "text",
      spellcheck: "false",
      placeholder: "(optional) ModName",
      title: "show the log lines that mention this name; empty uses the opened package",
    },
  });
  const logButton = button("what the game said", "read the game's Player.log and show what it says about this mod", () => {
    readGameLog();
  });
  const logControls = h("div", "mod-controls mod-log", {
    children: [logName, logButton],
  });

  const headline = h("div", "mod-headline");
  const counts = h("div", "mod-counts");
  const modJsonSection = section("mod-manifest", "mod.json", undefined, () => openSectionFile("mod.json"));
  const definesSection = section("mod-defines", "Defines", undefined, () => openSectionFile("defines"));
  const yarnSection = section("mod-yarn", "Yarn", undefined, () => openSectionFile("yarn"));
  const status = makeStatus();

  /** What the last successful `mod.open` returned, or null before the first. */
  let opened = null;

  const body = h("div", "card-body card-body-mod", {
    children: [controls, newControls, importControls, exportControls, installControls, logControls, headline, counts, modJsonSection.el, definesSection.el, yarnSection.el, status],
  });
  const shell = cardShell(card, body);
  shell.label.textContent = dirInput.value === "" ? "(no dir)" : dirInput.value;

  let requestSeq = 0;

  /**
   * The file a section heading opens, or null when the package has nothing for
   * that section yet.  `mod.json` is always `<root>/mod.json`; Defines opens the
   * first define file and Yarn the first Yarn file, in the order the rows list
   * them, so the heading that names a file does open that file.
   */
  function sectionFile(kind) {
    const root = opened !== null && typeof opened.root === "string" && opened.root !== ""
      ? opened.root
      : dirInput.value.trim();
    if (root === "") {
      return null;
    }
    if (kind === "mod.json") {
      return modPath(root, "mod.json");
    }
    if (kind === "defines") {
      // `mod.open` names a define's file `file`; older hosts called it `path`.
      const first = groupDefines(opened === null ? [] : opened.defines)
        .flatMap((group) => group.items)
        .map((item) => defineRel(item))
        .find((rel) => rel !== "");
      return first === undefined ? null : modPath(root, first);
    }
    const yarnFiles = opened !== null && Array.isArray(opened.yarnFiles) ? opened.yarnFiles : [];
    const first = yarnFiles.find((entry) => typeof (typeof entry === "string" ? entry : entry.path) === "string");
    if (first === undefined) {
      return null;
    }
    return modPath(root, typeof first === "string" ? first : first.path);
  }

  const SECTION_NAMES = { "mod.json": "mod.json", defines: "Defines", yarn: "Yarn" };

  function openSectionFile(kind) {
    const path = sectionFile(kind);
    if (path === null || path === "") {
      app.log("warn", `the ${SECTION_NAMES[kind] ?? kind} section has nothing to open yet`);
      return;
    }
    app.openFile(path);
  }

  /** Fill a section, or its one placeholder row when there is nothing in it. */
  function fillOrEmpty(sectionEl, rows) {
    fillRows(sectionEl.rows, rows.length === 0 ? [{ label: "（空）", empty: true }] : rows);
  }

  /**
   * The kinds the "new" row offers: everything the game's knowledge base has a
   * schema for, then the three files this editor writes itself, then the two
   * that need a tool it does not have -- greyed, with the reason in the label,
   * because a menu that hides them cannot explain why they are missing.
   */
  async function loadTypes() {
    let types = [];
    try {
      types = await client.call("mod.types", {});
    } catch {
      types = [];
    }
    const raw = Array.isArray(types) ? types : [];
    const kinds = [
      ...raw.map((type) => {
        // G4: the wiki's support matrix rides on every entry.  An unsupported type
        // is still creatable — it is a valid file — but the menu says the game will
        // not read it, which is the one thing the schema alone cannot tell you.
        const support = type.support && typeof type.support === "object" ? type.support : null;
        const mark = support && support.level === "unsupported"
          ? " — the game ignores this type"
          : support && support.level === "partial"
            ? " — partly read by the game"
            : "";
        return {
          value: type.type,
          label: `${type.type}${type.required && type.required.length > 0 ? ` (${type.required.join(", ")})` : ""}${mark}`,
        };
      }),
      { value: "yarn", label: "Story (.yarn)" },
      { value: "translation", label: "Translation (.csv)" },
      { value: "sprite", label: "Sprite (.png)" },
      { value: "spine", label: "Rig (.skel.bytes) — needs Spine", disabled: true },
      { value: "audio", label: "Audio (.wav) — needs a recording", disabled: true },
    ];
    newType.textContent = "";
    for (const kind of kinds) {
      const option = document.createElement("option");
      option.value = kind.value;
      option.textContent = kind.label;
      option.disabled = kind.disabled === true;
      newType.append(option);
    }
    newButton.disabled = kinds.length === 0;
  }

  /**
   * Create the file the row names, then open it.
   *
   * The answer names the file the shell wrote, so this side opens *that* path
   * instead of guessing where the verb would have put it -- the generate rules
   * live in one place (`shell/mods/newfile.js`), and a card that re-derived the
   * path would eventually guess a different directory.
   */
  async function createFile() {
    const root = opened !== null && typeof opened.root === "string" && opened.root !== ""
      ? opened.root
      : dirInput.value.trim();
    if (root === "") {
      status.textContent = "open a mod first: a new file needs a package to live in";
      app.log("warn", "new file: open a mod first -- a new file needs a package to live in");
      return;
    }
    const type = newType.value;
    const name = newName.value.trim();
    if (name === "") {
      status.textContent = "give the new file a name";
      return;
    }
    status.textContent = `creating ${type} ${name}…`;
    let answer;
    try {
      answer = await client.call("mod.newFile", { dir: root, type, name });
    } catch (err) {
      status.textContent = `not created: ${err.message}`;
      app.log("warn", `new file failed: ${err.message}`);
      return;
    }
    const file = typeof answer.file === "string" && answer.file !== ""
      ? answer.file
      : modPath(root, answer.path);
    newName.value = "";
    status.textContent = `created ${answer.path} (${answer.bytes} bytes)`;
    app.log("info", `new file (${answer.path}) — ${type === "sprite" ? "the pixels are the file" : "the schema filled the fields it requires"}`);
    if (type === "sprite") {
      app.openPixelCard(file);
    } else {
      app.openFile(file);
    }
  }

  /**
   * Copy an existing file into the package and open it.
   *
   * The verb copies the bytes; this side never rewrites them.  A file whose name
   * does not say where it belongs (a define's directory *is* its type) has to be
   * given a target, and the shell refuses rather than guessing, because a define
   * in the wrong `Defines/<Type>/` is a file the game will not load.
   */
  async function importFile() {
    const root = opened !== null && typeof opened.root === "string" && opened.root !== ""
      ? opened.root
      : dirInput.value.trim();
    if (root === "") {
      status.textContent = "open a mod first: an import needs a package to land in";
      app.log("warn", "import: open a mod first -- an import needs a package to land in");
      return;
    }
    const from = importFrom.value.trim();
    if (from === "") {
      status.textContent = "give a file to import";
      return;
    }
    const to = importTo.value.trim();
    status.textContent = `importing ${from}…`;
    let answer;
    try {
      answer = await client.call("mod.importFile", {
        dir: root,
        from,
        ...(to === "" ? {} : { to }),
      });
    } catch (err) {
      status.textContent = `not imported: ${err.message}`;
      app.log("warn", `import failed: ${err.message}`);
      return;
    }
    const file = typeof answer.file === "string" && answer.file !== ""
      ? answer.file
      : modPath(root, answer.path);
    importFrom.value = "";
    importTo.value = "";
    status.textContent = `imported ${answer.path} (${answer.bytes} bytes)`;
    app.log("info", `imported ${answer.path} (${answer.bytes} bytes) — copied byte for byte`);
    if (answer.kind === "sprite" || /\.png$/i.test(answer.path)) {
      app.openPixelCard(file);
    } else {
      app.openFile(file);
    }
  }

  /**
   * Write the open package as a distributable zip, or say why it did not leave.
   *
   * The shell answers with the archive size and the file count, and with the
   * precheck's warning/info counts: errors block the export, warnings do not.
   * `file` is the path relative to the mods root when it is inside it, which is
   * what the log line should name.
   */
  async function exportZip() {
    const dir = dirInput.value.trim();
    if (dir === "") {
      status.textContent = "give a mod directory first";
      app.log("warn", "mod export: type NewMod (relative to the mods root) or an absolute path first");
      return;
    }
    const out = exportOut.value.trim();
    status.textContent = "exporting…";
    let answer;
    try {
      answer = await client.call("mod.export", {
        dir,
        ...(out === "" ? {} : { out }),
      });
    } catch (err) {
      status.textContent = `not exported: ${err.message}`;
      app.log("warn", `cannot export ${dir}: ${err.message}`);
      return;
    }
    const where = typeof answer.file === "string" && answer.file !== "" ? answer.file : answer.out;
    status.textContent = `exported ${where} (${answer.files} files, ${answer.bytes} bytes)`;
    app.log("info",
      `exported ${where}: ${answer.files} files, ${answer.bytes} bytes, ` +
      `${answer.warnings ?? 0} warnings and ${answer.infos ?? 0} infos from the precheck`);
    if (Array.isArray(answer.skipped) && answer.skipped.length > 0) {
      app.log("info", `left out ${answer.skipped.length} file(s): ${answer.skipped.join(", ")}`);
    }
  }

  /*
   * G11: `mod.installGame` copies the package into `<gameMods>/<Name>` and
   * refuses an existing folder unless `overwrite` is passed -- replacing an
   * install is the destructive step, and the card does not hide it behind a
   * click.  Errors (validator, existing folder, no game folder found) come back
   * as messages, so the refusal is shown where the button is.
   */
  async function installIntoGame() {
    const dir = dirInput.value.trim();
    if (dir === "") {
      status.textContent = "give a mod directory first";
      app.log("warn", "mod install: type NewMod (relative to the mods root) or an absolute path first");
      return;
    }
    const gameModsDir = installDir.value.trim();
    status.textContent = "installing…";
    let answer;
    try {
      answer = await client.call("mod.installGame", {
        dir,
        ...(gameModsDir === "" ? {} : { gameModsDir }),
      });
    } catch (err) {
      status.textContent = `not installed: ${err.message}`;
      app.log("warn", `cannot install ${dir}: ${err.message}`);
      return;
    }
    status.textContent = `installed ${answer.target} (${answer.files} files, ${answer.bytes} bytes)`;
    app.log("info",
      `installed ${answer.name} into ${answer.target}: ${answer.files} files, ${answer.bytes} bytes` +
      (answer.replaced ? " (replaced the previous copy)" : "") +
      `, ${answer.warnings ?? 0} warnings and ${answer.infos ?? 0} infos from the precheck`);
    if (answer.knowledge === "missing") {
      app.log("info", "no knowledge base: the precheck could only look at the file structure");
    }
  }

  /**
   * G12: read the tail of the game's `Player.log` and show the lines worth
   * showing -- errors, ModLoader/mod lines, and any mention of this package.
   * The answer is deliberately not a live tail: one read, fifteen lines, and
   * the totals, which is what an author needs after a test run.
   */
  async function readGameLog() {
    const typed = logName.value.trim();
    const name = typed !== ""
      ? typed
      : (opened !== null && opened.manifest && typeof opened.manifest.name === "string"
        ? opened.manifest.name
        : "");
    status.textContent = "reading the game log…";
    let answer;
    try {
      answer = await client.call("mod.gameLog", {
        ...(name === "" ? {} : { modName: name }),
      });
    } catch (err) {
      status.textContent = `no game log: ${err.message}`;
      app.log("warn", `cannot read the game log: ${err.message}`);
      return;
    }
    if (answer.found !== true) {
      status.textContent = "no Player.log found";
      app.log("warn", "the game log was not found -- start the game once, or pass --path in the shell");
      return;
    }
    const totals = answer.totals || { lines: 0, errors: 0, mods: 0, mentions: 0 };
    status.textContent =
      `${answer.path} · ${totals.errors} errors · ${totals.mods} mod lines · ${totals.mentions} mentions`;
    app.log("info",
      `game log ${answer.path}: ${totals.lines} lines, ${totals.errors} errors, ` +
      `${totals.mods} mod lines, ${totals.mentions} mentions`);
    const shown = (Array.isArray(answer.lines) ? answer.lines : []).slice(0, 15);
    for (const line of shown) {
      app.log(line.kind === "error" ? "warn" : "info", `  ${line.line}: ${line.text}`);
    }
    if (shown.length === 0) {
      app.log("info", "nothing in the log mentions this package -- the game said nothing about it");
    }
  }

  async function openMod() {
    const dir = dirInput.value.trim();
    if (dir === "") {
      status.textContent = "give a mod directory first";
      app.log("warn", "mod: type NewMod (relative to the mods root) or an absolute path first");
      return;
    }
    const seq = requestSeq + 1;
    requestSeq = seq;
    status.textContent = "opening…";
    let result;
    try {
      result = await client.call("mod.open", { dir });
    } catch (err) {
      status.textContent = `open failed: ${err.message}`;
      // A failed open used to leave only this one line inside the card, which
      // is clipped in the default tile layout: the log gives it a second exit.
      app.log("warn", `cannot open ${dir}: ${err.message}`);
      return;
    }
    if (seq !== requestSeq) {
      return;
    }
    opened = result;

    card.dir = dir;
    shell.label.textContent = dir;
    headline.textContent = modHeadline(opened);
    const summary = opened.summary ?? {};
    counts.textContent = [
      `${summary.defines ?? 0} defines`,
      `${summary.yarnFiles ?? summary.yarn ?? 0} yarn`,
      `${summary.csvFiles ?? summary.csv ?? 0} csv`,
      `${summary.sprites ?? 0} sprites`,
    ].join(" · ");

    const manifest = opened.manifest ?? {};
    fillOrEmpty(modJsonSection, Object.keys(manifest).map((key) => ({
      label: key,
      meta: typeof manifest[key] === "object" ? JSON.stringify(manifest[key]) : String(manifest[key]),
    })));

    const root = opened.root ?? dir;
    const grouped = groupDefines(opened.defines);
    fillOrEmpty(definesSection, grouped.flatMap((group) => [
      { label: group.type, meta: `${group.items.length}`, title: group.type },
      ...group.items.map((item) => {
        const rel = defineRel(item);
        return {
          label: `  ${item.techName}`,
          meta: rel,
          title: rel,
          onClick: rel === "" ? undefined : () => app.openFile(modPath(root, rel)),
        };
      }),
    ]));

    const yarnFiles = Array.isArray(opened.yarnFiles) ? opened.yarnFiles : [];
    fillOrEmpty(yarnSection, yarnFiles.map((entry) => {
      const rel = typeof entry === "string" ? entry : entry.path;
      return {
        label: typeof rel === "string" ? rel.split("/").pop() : String(rel),
        meta: typeof rel === "string" ? rel.split("/").slice(0, -1).join("/") : "",
        title: rel,
        onClick: () => app.openFile(modPath(root, rel)),
      };
    }));

    /*
     * `mod.open` is tolerant by design: a missing directory, a broken mod.json
     * and an unreadable file all come back as diagnostics rather than an error,
     * so the card can still list whatever it did find.  Tolerant is not the same
     * as silent -- a package the host called an error (`OPEN001` when the path is
     * not a directory, `M001` for a missing or broken manifest) is a failed open,
     * and before this it kept the "opened <root>" line and hid the reason.
     */
    const diagnostics = Array.isArray(opened.diagnostics) ? opened.diagnostics : [];
    const errors = diagnostics.filter((one) => one !== null && one !== undefined && one.severity === "error");
    if (errors.length > 0) {
      const first = errors[0];
      const reason = typeof first.message === "string" && first.message !== ""
        ? first.message
        : String(first.code ?? "the package cannot be opened");
      status.textContent = `open failed: ${reason}`;
      app.log("warn", `cannot open ${dir}: ${reason}`);
    } else {
      status.textContent = `opened ${root}`;
      app.log("info", `opened ${root}`);
    }
    app.boardTouched(true);
  }

  async function validate() {
    const dir = dirInput.value.trim();
    if (dir === "") {
      status.textContent = "give a mod directory first";
      app.log("warn", "mod validate: type NewMod (relative to the mods root) or an absolute path first");
      return;
    }
    status.textContent = "validating…";
    let report;
    try {
      report = await client.call("mod.validate", { root: dir });
    } catch (err) {
      status.textContent = `validate failed: ${err.message}`;
      app.log("warn", `cannot validate ${dir}: ${err.message}`);
      return;
    }
    const s = report.summary ?? {};
    const counts2 = diagCounts(report.diagnostics);
    status.textContent = `${s.files ?? 0} files · ${counts2.error} errors · ${counts2.warning} warnings · ${counts2.info} infos`;
    app.log(counts2.error === 0 ? "info" : "warn",
      `${dir}: ${counts2.error} errors, ${counts2.warning} warnings, ${counts2.info} infos`);
  }

  openButton.addEventListener("click", () => openMod());
  dirInput.addEventListener("keydown", (event) => {
    event.stopPropagation();
    if (event.key === "Enter") {
      openMod();
    }
  });
  newName.addEventListener("keydown", (event) => {
    event.stopPropagation();
    if (event.key === "Enter") {
      createFile();
    }
  });
  for (const field of [importFrom, importTo]) {
    field.addEventListener("keydown", (event) => {
      event.stopPropagation();
      if (event.key === "Enter") {
        importFile();
      }
    });
  }
  exportOut.addEventListener("keydown", (event) => {
    event.stopPropagation();
    if (event.key === "Enter") {
      exportZip();
    }
  });
  installDir.addEventListener("keydown", (event) => {
    event.stopPropagation();
    if (event.key === "Enter") {
      installIntoGame();
    }
  });
  logName.addEventListener("keydown", (event) => {
    event.stopPropagation();
    if (event.key === "Enter") {
      readGameLog();
    }
  });

  loadTypes();

  // An unopened card says how the input is read and shows each section's
  // placeholder: a blank rectangle gave no clue that `Mods/MyMod` was wrong.
  counts.textContent = "relative paths resolve against the mods root; an absolute path also works";
  fillOrEmpty(modJsonSection, []);
  fillOrEmpty(definesSection, []);
  fillOrEmpty(yarnSection, []);

  if (dirInput.value !== "") {
    openMod();
  } else {
    status.textContent = "NewMod (relative to the mods root) or an absolute path, then Enter";
  }

  return {
    el: shell.el,
    handle: {
      kind: "mod",
      focus() {
        dirInput.focus();
      },
      refresh: openMod,
      setDir(dir) {
        dirInput.value = typeof dir === "string" ? dir : "";
        return openMod();
      },
      root() {
        return dirInput.value.trim();
      },
    },
    destroy() {},
  };
}

/* -- kind: problems -- validation output ------------------------------ */
