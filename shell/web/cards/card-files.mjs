/**
 * cards/card-files.mjs -- the files card: a folder listing with sizes and ages.
 *
 * Part of `cards.mjs`, which re-exports this file; see that file's header for
 * why the card layer is split the way it is.
 */
import { button, cardShell, h, makeStatus } from "./dom.mjs";
import { formatListing } from "./text.mjs";

export function renderFiles(card, ctx) {
  const { client, app } = ctx;
  const filterInput = h("input", "files-filter", {
    attrs: { type: "text", spellcheck: "false", placeholder: "**/*" },
  });
  filterInput.value = typeof card.filter === "string" && card.filter !== "" ? card.filter : "**/*";
  const list = h("div", "files-list");
  const status = makeStatus();
  const body = h("div", "card-body card-body-files", {
    children: [filterInput, list, status],
  });
  const shell = cardShell(card, body);
  shell.label.textContent = filterInput.value;

  let timer = null;
  let requestSeq = 0;

  async function refresh() {
    const seq = requestSeq + 1;
    requestSeq = seq;
    const filter = filterInput.value.trim() || "**/*";
    status.textContent = "listing…";
    let listing;
    try {
      listing = await client.call("workspace.list", { glob: filter, limit: 4000 });
    } catch (err) {
      status.textContent = `list failed: ${err.message}`;
      return;
    }
    if (seq !== requestSeq) {
      return; // a newer request overtook this one
    }
    const now = Math.floor(Date.now() / 1000);
    const { rows, count, truncated } = formatListing(listing, { now });
    const frag = document.createDocumentFragment();
    for (const row of rows) {
      const button = h("button", `file-row${row.dir ? " is-dir" : ""}`, {
        attrs: { type: "button", title: row.path },
      });
      button.append(h("span", "file-name", { text: row.dir ? `${row.name}/` : row.name }));
      button.append(h("span", "file-meta", {
        text: [row.sizeText, row.ageText].filter(Boolean).join(" "),
      }));
      button.addEventListener("click", () => {
        if (row.dir) {
          filterInput.value = `${row.path}/**/*`;
          card.filter = filterInput.value;
          shell.label.textContent = filterInput.value;
          app.boardTouched(true);
          refresh();
          return;
        }
        app.openFile(row.path);
      });
      frag.append(button);
    }
    list.textContent = "";
    list.append(frag);
    status.textContent = `${rows.length}/${count} entries${truncated ? " · truncated" : ""}`;
  }

  function scheduleRefresh() {
    if (timer !== null) {
      clearTimeout(timer);
    }
    timer = setTimeout(() => {
      timer = null;
      refresh();
    }, 180);
  }

  filterInput.addEventListener("input", () => {
    card.filter = filterInput.value;
    shell.label.textContent = filterInput.value;
    app.boardTouched(true);
    scheduleRefresh();
  });
  filterInput.addEventListener("keydown", (event) => {
    if (event.key === "Escape") {
      filterInput.blur();
    }
    event.stopPropagation();
  });

  refresh();

  return {
    el: shell.el,
    handle: {
      kind: "files",
      refresh,
      focus() {
        filterInput.focus();
        filterInput.select();
      },
    },
    destroy() {
      if (timer !== null) {
        clearTimeout(timer);
      }
      requestSeq += 1;
    },
  };
}

/* -------------------- project -------------------- */
