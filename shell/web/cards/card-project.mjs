/**
 * cards/card-project.mjs -- the project card: the workspace merged with what is open.
 *
 * Part of `cards.mjs`, which re-exports this file; see that file's header for
 * why the card layer is split the way it is.
 */
import { button, cardShell, h, makeStatus } from "./dom.mjs";
import { projectRows, projectSummary } from "./text.mjs";

/**
 * The project panel: the one surface that treats the workspace as *one
 * project*.
 *
 * A normal IDE keeps a project so that editing many files is cheap: you can
 * see what the project contains and what you already have open, and you can
 * get from one to the other without hunting for a rectangle on the plane.
 * That is exactly what this card is -- `workspace.list` merged with the
 * board's editor cards -- and it is why it is a card and not a side panel:
 * where it sits is project state like everything else.
 *
 * It deliberately lists the *whole* workspace -- every file the kernel will
 * hand over, not just the ones the filter matches -- because the useful
 * sentence it can say is "this file is gone and a card still points at it",
 * and that needs the whole project.  Its one piece of state is `filter`, which
 * lives on the card and therefore in `.infantgod/board.json`.
 */
export function renderProject(card, ctx) {
  const { client, app } = ctx;

  const rootLine = h("div", "project-root");
  const filterInput = h("input", "project-filter", {
    attrs: { type: "text", spellcheck: "false", placeholder: "**/*  (folder glob or a word)" },
  });
  filterInput.value = typeof card.filter === "string" && card.filter !== "" ? card.filter : "**/*";
  const refreshButton = h("button", "project-button", {
    attrs: { type: "button", title: "list the workspace again" },
    text: "refresh",
  });
  const controls = h("div", "project-controls", {
    children: [filterInput, refreshButton],
  });
  const openSection = h("div", "project-section project-open");
  const treeSection = h("div", "project-section project-tree");
  const status = makeStatus();
  const body = h("div", "card-body card-body-project", {
    children: [rootLine, controls, openSection, treeSection, status],
  });
  const shell = cardShell(card, body);

  let timer = null;
  let requestSeq = 0;
  let lastOpenSignature = null;

  /**
   * The directories the kernel never lists, as names (`workspace.info.ignored`).
   * Empty when an older or forked kernel does not report them, in which case the
   * panel simply says less instead of guessing.
   */
  function hiddenDirs() {
    const info = app.workspace();
    const names = info && Array.isArray(info.ignored) ? info.ignored : [];
    return names.filter((name) => typeof name === "string" && name !== "");
  }

  function updateLabel() {
    const filter = filterInput.value.trim() || "**/*";
    shell.label.textContent = filter === "**/*" ? "workspace" : filter;
  }

  /** What the board has open, as one string: the panel re-lists only on change. */
  function openSignature() {
    const parts = [];
    for (const entry of app.openEditors()) {
      parts.push(`${entry.id}:${entry.path}:${entry.dirty ? 1 : 0}`);
    }
    return parts.join("|");
  }

  function renderRoot() {
    const info = app.workspace();
    if (info === null || info === undefined) {
      rootLine.textContent = "workspace: the path was not reported by the kernel";
      return;
    }
    const name = typeof info.name === "string" && info.name !== "" ? info.name : info.root;
    rootLine.textContent = `${name} — ${info.root}`;
    // The tooltip is where "why is build/ missing?" gets answered: the kernel
    // skips these directory names while it walks and says so in this list.
    const hidden = hiddenDirs();
    rootLine.title = hidden.length === 0
      ? String(info.root)
      : `${info.root}\nnot listed by the kernel: ${hidden.join(", ")}`;
  }

  /** Open a project file: an existing card is revealed, a new one is placed. */
  function openProjectFile(path) {
    const card_ = app.openFile(path, { at: { x: card.x + card.w + 400, y: card.y + 240 } });
    if (card_ !== null && card_ !== undefined) {
      app.revealCard(card_.id);
    }
  }

  /** One row of the open list: click reveals the card, the x closes it. */
  function openRow(entry) {
    const classes = ["project-row", "is-open"];
    if (entry.dirty) {
      classes.push("is-dirty");
    }
    if (!entry.present) {
      classes.push("is-missing");
    }
    const row = h("div", classes.join(" "));
    const button = h("button", "project-file", { attrs: { type: "button", title: entry.path } });
    button.append(h("span", "project-name", { text: entry.name }));
    button.append(h("span", "project-meta", {
      text: [
        entry.folder === "" ? "" : `${entry.folder}/`,
        entry.dirty ? "unsaved" : "",
        entry.present ? "" : "file is gone",
      ].filter(Boolean).join(" · "),
    }));
    button.addEventListener("click", () => openProjectFile(entry.path));
    row.append(button);
    if (entry.id !== "") {
      const close = h("button", "project-close", {
        attrs: { type: "button", title: `take the card for ${entry.path} off the board (the file is not touched)` },
        text: "\u00d7",
      });
      close.addEventListener("click", (event) => {
        event.stopPropagation();
        app.closeCard(entry.id);
      });
      row.append(close);
    }
    return row;
  }

  /** One row of the tree: click opens the file, or reveals it if it is open. */
  function treeRow(entry) {
    const classes = ["project-row"];
    if (entry.open) {
      classes.push("is-open");
    }
    if (entry.dirty) {
      classes.push("is-dirty");
    }
    const row = h("div", classes.join(" "));
    const button = h("button", "project-file", { attrs: { type: "button", title: entry.path } });
    button.append(h("span", "project-dot", { text: entry.open ? "\u25cf" : "" }));
    button.append(h("span", "project-name", { text: entry.name }));
    button.append(h("span", "project-meta", {
      text: [entry.dirty ? "unsaved" : "", entry.sizeText, entry.ageText].filter(Boolean).join(" "),
    }));
    button.addEventListener("click", () => openProjectFile(entry.path));
    row.append(button);
    return row;
  }

  function renderOpen(result) {
    openSection.textContent = "";
    if (result.openRows.length === 0) {
      openSection.append(h("div", "project-empty", { text: "nothing open yet — click a file below" }));
      return;
    }
    openSection.append(h("div", "project-heading", { text: `open · ${result.openRows.length}` }));
    for (const entry of result.openRows) {
      openSection.append(openRow(entry));
    }
  }

  function renderTree(result) {
    treeSection.textContent = "";
    if (result.groups.length === 0) {
      // A filter that matches nothing is usually a filter aimed at a directory
      // the kernel does not hand over, so name those directories here.
      const hidden = hiddenDirs();
      const why = result.counts.files === 0
        ? "this workspace has no files"
        : "no file matches the filter";
      treeSection.append(h("div", "project-empty", {
        text: hidden.length === 0 || result.counts.files === 0
          ? why
          : `${why} · the kernel does not list ${hidden.join(", ")}`,
      }));
      return;
    }
    for (const group of result.groups) {
      treeSection.append(h("div", "project-heading", { text: group.label }));
      for (const entry of group.rows) {
        treeSection.append(treeRow(entry));
      }
    }
  }

  async function refresh() {
    const seq = requestSeq + 1;
    requestSeq = seq;
    const filter = filterInput.value.trim() || "**/*";
    status.textContent = "listing…";
    let listing;
    try {
      listing = await client.call("workspace.list", { glob: "**/*", limit: 4000 });
    } catch (err) {
      status.textContent = `list failed: ${err.message}`;
      return;
    }
    if (seq !== requestSeq) {
      return; // a newer request overtook this one
    }
    const result = projectRows(listing, {
      open: app.openEditors(),
      filter,
    });
    lastOpenSignature = openSignature();
    renderRoot();
    renderOpen(result);
    renderTree(result);
    status.textContent = projectSummary(result.counts)
      + (result.counts.complete ? "" : " · truncated, so “missing” may over-report");
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

  // The board is the source of truth for what is open, so opening or closing
  // an editor anywhere -- a command, the files card, this panel -- re-lists.
  // The signature check keeps a pan (which re-renders every card) from
  // re-listing, and a pan happens on every animation frame.
  const off = app.onBoardChanged(() => {
    if (openSignature() === lastOpenSignature) {
      return;
    }
    refresh();
  });

  filterInput.addEventListener("input", () => {
    card.filter = filterInput.value;
    updateLabel();
    app.boardTouched(true);
    scheduleRefresh();
  });
  filterInput.addEventListener("keydown", (event) => {
    if (event.key === "Escape") {
      filterInput.blur();
    }
    event.stopPropagation();
  });
  refreshButton.addEventListener("click", () => refresh());

  updateLabel();
  refresh();

  return {
    el: shell.el,
    handle: {
      kind: "project",
      refresh,
      /** Re-point the filter from outside (the `project <glob>` command). */
      setFilter(value) {
        const text = typeof value === "string" && value.trim() !== "" ? value.trim() : "**/*";
        if (filterInput.value !== text) {
          filterInput.value = text;
          card.filter = text;
          updateLabel();
          app.boardTouched(true);
        }
        refresh();
      },
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
      off();
    },
  };
}

/* -------------------- sheet -------------------- */
