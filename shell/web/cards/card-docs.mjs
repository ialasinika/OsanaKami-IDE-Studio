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

  const hbButton = button("window", "what the game hooks into", () => loadWindow());
  const controls = h("div", "mod-controls", { children: [queryInput, hbButton] });
  const list = h("div", "mod-rows docs-rows");
  const doc = h("pre", "docs-text");
  const status = makeStatus();

  const body = h("div", "card-body card-body-docs", {
    children: [controls, list, doc, status],
  });
  const shell = cardShell(card, body);
  shell.label.textContent = queryInput.value === "" ? "knowledge base" : queryInput.value;

  let requestSeq = 0;

  async function show(kind, name) {
    status.textContent = `reading ${kind} ${name}…`;
    try {
      const text = await client.call("mod.docFor", { kind, name });
      doc.textContent = typeof text === "string" ? text : String(text ?? "");
      doc.scrollTop = 0;
      status.textContent = `${kind} ${name}`;
    } catch (err) {
      status.textContent = `doc failed: ${err.message}`;
    }
  }

  async function search() {
    const query = queryInput.value.trim();
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
      hits = await client.call("mod.search", { query, limit: 80 });
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
    status.textContent = "reading the knowledge base…";
    let stats;
    try {
      stats = await client.call("mod.stats", {});
    } catch (err) {
      status.textContent = `knowledge base unavailable: ${err.message}`;
      return;
    }
    const keys = Object.keys(stats ?? {});
    fillRows(list, keys.map((key) => ({
      label: key,
      meta: String(stats[key]),
      title: `${key} = ${stats[key]}`,
    })));
    let types = [];
    try {
      types = await client.call("mod.types", {});
    } catch {
      types = [];
    }
    fillRows(list, [
      ...keys.map((key) => ({ label: key, meta: String(stats[key]) })),
      ...(Array.isArray(types) ? types : []).map((type) => ({
        label: type.type,
        meta: `${type.count ?? 0} baseline` +
          (type.support && type.support.level ? ` · ${type.support.level}` : ""),
        title: `required: ${(type.required ?? []).join(", ")}` +
          (type.support && type.support.manager ? `\nmanager: ${type.support.manager}` : "") +
          (type.support && type.support.note ? `\n${type.support.note}` : ""),
        onClick: () => show("type", type.type),
      })),
    ]);
    doc.textContent = "";
    status.textContent = "search the knowledge base, or click a type";
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
    },
    destroy() {},
  };
}

/* -- kind: settings -- the user's own machine ------------------------- */
