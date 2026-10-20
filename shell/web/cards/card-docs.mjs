/**
 * cards/card-docs.mjs -- the docs card: what the knowledge base says about a name.
 *
 * Part of `cards.mjs`, which re-exports this file; see that file's header for
 * why the card layer is split the way it is.
 */
import { button, cardShell, fillRows, h, makeStatus } from "./dom.mjs";

export function renderDocs(card, ctx) {
  const { client } = ctx;

  const queryInput = h("input", "docs-query", {
    attrs: { type: "text", spellcheck: "false", placeholder: "Love, jump, Speaker, Goods_Folk…" },
  });
  queryInput.value = typeof card.query === "string" ? card.query : "";
  // G18: the docs card used to be read-only against the game knowledge base.  A
  // package root makes it answer for the mod the author is actually editing --
  // its defines, yarn nodes, tables and sprites -- without validating it.
  const rootInput = h("input", "docs-query docs-root", {
    attrs: { type: "text", spellcheck: "false", placeholder: "package root, e.g. Mods/MyMod" },
  });
  rootInput.value = typeof card.root === "string" ? card.root : "";

  const hbButton = button("window", "what the game hooks into", () => loadWindow());
  const packageButton = button("window", "read this package", () => {
    packageRoot();
    loadWindow();
  });
  const controls = h("div", "mod-controls", { children: [rootInput, packageButton, queryInput, hbButton] });
  const list = h("div", "mod-rows docs-rows");
  const doc = h("pre", "docs-text");
  const status = makeStatus();

  const body = h("div", "card-body card-body-docs", {
    children: [controls, list, doc, status],
  });
  const shell = cardShell(card, body);
  shell.label.textContent = queryInput.value === "" ? "knowledge base" : queryInput.value;

  let requestSeq = 0;

  /** The package the card is reading right now; "" means the game KB only. */
  function packageRoot() {
    const value = rootInput.value.trim();
    card.root = value;
    if (value === "") shell.label.textContent = queryInput.value === "" ? "knowledge base" : queryInput.value;
    return value;
  }

  async function show(kind, name) {
    const root = packageRoot();
    status.textContent = `reading ${kind} ${name}…`;
    try {
      const text = await client.call("mod.docFor", root === "" ? { kind, name } : { kind, name, root });
      doc.textContent = typeof text === "string" ? text : String(text ?? "");
      doc.scrollTop = 0;
      status.textContent = `${kind} ${name}`;
    } catch (err) {
      status.textContent = `doc failed: ${err.message}`;
    }
  }

  async function search() {
    const query = queryInput.value.trim();
    const root = packageRoot();
    const seq = requestSeq + 1;
    requestSeq = seq;
    if (query === "") {
      await loadWindow();
      return;
    }
    card.query = query;
    shell.label.textContent = query;
    status.textContent = "searching…";
    let hits;
    try {
      hits = await client.call("mod.search", root === ""
        ? { query, limit: 80 }
        : { query, limit: 80, root });
    } catch (err) {
      status.textContent = `search failed: ${err.message}`;
      return;
    }
    if (seq !== requestSeq) {
      return;
    }
    const items = Array.isArray(hits) ? hits : (hits?.results ?? []);
    fillRows(list, items.map((hit) => ({
      label: hit.name ?? hit.label ?? "?",
      meta: hit.kind ?? "",
      title: hit.detail ?? hit.documentation ?? "",
      onClick: () => show(hit.kind ?? "command", hit.name ?? hit.label),
    })));
    status.textContent = `${items.length} hit${items.length === 1 ? "" : "s"}`;
  }

  async function loadWindow() {
    const root = packageRoot();
    status.textContent = root === "" ? "reading the knowledge base…" : `reading ${root}…`;
    let stats;
    try {
      stats = await client.call("mod.stats", root === "" ? {} : { root });
    } catch (err) {
      status.textContent = `knowledge base unavailable: ${err.message}`;
      return;
    }
    const pack = stats && stats.package ? stats.package : null;
    // `support` is the help card's cross-reference, not a counter; printing it as
    // a row would read "[object Object]".
    const keys = Object.keys(stats ?? {}).filter((key) => key !== "package" && key !== "support");
    const rows = [];
    if (pack) {
      rows.push({
        label: pack.name || "(unnamed package)",
        meta: `${pack.summary.defines} defines · ${pack.summary.yarn} yarn · ${pack.summary.csv} csv · ${pack.summary.sprites} sprites`,
        title: pack.root,
      });
      for (const type of Object.keys(pack.types).sort()) {
        rows.push({
          label: type,
          meta: `${pack.types[type]} in this package`,
          title: `${pack.types[type]} definition(s) of ${type} in this package`,
          onClick: () => show("type", type),
        });
      }
      rows.push({ label: "(the game's knowledge base)", meta: `${keys.length} counters` });
    }
    for (const key of keys) {
      rows.push({ label: key, meta: String(stats[key]), title: `${key} = ${stats[key]}` });
    }
    let types = [];
    try {
      types = await client.call("mod.types", root === "" ? {} : { root });
    } catch {
      types = [];
    }
    const typeRows = (Array.isArray(types) ? types : []).map((type) => ({
      label: type.type,
      meta: `${type.count ?? 0} baseline` +
        (type.packageCount ? ` · ${type.packageCount} here` : "") +
        (type.support && type.support.level ? ` · ${type.support.level}` : ""),
      title: `required: ${(type.required ?? []).join(", ")}` +
        (type.packageCount ? `\nthis package: ${type.packageCount}` : "") +
        (type.support && type.support.manager ? `\nmanager: ${type.support.manager}` : "") +
        (type.support && type.support.note ? `\n${type.support.note}` : ""),
      onClick: () => show("type", type.type),
    }));
    fillRows(list, [...rows, ...typeRows]);
    doc.textContent = "";
    if (pack) {
      shell.label.textContent = pack.name || pack.root;
      status.textContent = `package ${pack.name || pack.root} · search it, the KB, or click a type`;
    } else {
      status.textContent = "search the knowledge base, or click a type";
    }
  }

  queryInput.addEventListener("keydown", (event) => {
    event.stopPropagation();
    if (event.key === "Enter") {
      search();
    }
  });
  queryInput.addEventListener("input", () => {
    if (queryInput.value.trim() === "") {
      loadWindow();
    }
  });
  rootInput.addEventListener("keydown", (event) => {
    event.stopPropagation();
    if (event.key === "Enter") {
      loadWindow();
    }
  });
  rootInput.addEventListener("input", () => {
    card.root = rootInput.value.trim();
    if (card.root === "") {
      loadWindow();
    }
  });

  if (queryInput.value !== "") {
    search();
  } else {
    loadWindow();
  }

  return {
    el: shell.el,
    handle: {
      kind: "docs",
      focus() {
        queryInput.focus();
      },
      search,
      show,
      query() {
        return queryInput.value.trim();
      },
      root() {
        return typeof card.root === "string" ? card.root : "";
      },
    },
    destroy() {},
  };
}

/* -- kind: settings -- the user's own machine ------------------------- */
