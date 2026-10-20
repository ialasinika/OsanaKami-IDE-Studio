/**
 * cards/card-problems.mjs -- the problems card: diagnostics as a list you can click.
 *
 * Part of `cards.mjs`, which re-exports this file; see that file's header for
 * why the card layer is split the way it is.
 */
import { diagCounts, diagFile, diagWhere, modPath } from "./card-mod.mjs";
import { button, cardShell, fillRows, h, makeStatus } from "./dom.mjs";

/** The 1-based line a diagnostic points at, or `undefined` when it names none. */
export function diagLine(diagnostic) {
  const line = diagnostic?.line;
  return Number.isInteger(line) && line > 0 ? line : undefined;
}

/**
 * Where a diagnostic row should open: `{path, line, pointer}`.
 *
 * `root` is the *resolved* package root `mod.validate` answered, not the text
 * the user typed.  The diagnostic's `path` is `Rel/File.json#json/pointer`;
 * the file half is joined onto the root so `file.read` receives a path it can
 * resolve, and the pointer half is passed through untouched -- `#` is not part
 * of a filesystem name, and the editor needs the pointer to find the key
 * inside the JSON.  `line` is only set when the diagnostic carries one.
 */
export function diagTarget(root, diagnostic) {
  const file = diagFile(diagnostic);
  return {
    path: file === "" ? "" : modPath(root, file),
    line: diagLine(diagnostic),
    pointer: diagWhere(diagnostic),
  };
}

export function renderProblems(card, ctx) {
  const { client, app } = ctx;

  const rootInput = h("input", "problems-root", {
    attrs: { type: "text", spellcheck: "false", placeholder: "Mods/MyMod" },
  });
  rootInput.value = typeof card.root === "string" ? card.root : "";

  const runButton = button("validate", "validate the package and its Yarn", () => run());
  const controls = h("div", "mod-controls", { children: [rootInput, runButton] });
  const summaryEl = h("div", "mod-counts");
  const list = h("div", "mod-rows problems-rows");
  const status = makeStatus();

  const body = h("div", "card-body card-body-problems", {
    children: [controls, summaryEl, list, status],
  });
  const shell = cardShell(card, body);
  shell.label.textContent = rootInput.value === "" ? "(no mod)" : rootInput.value;

  function paint(diagnostics, root) {
    const counts = diagCounts(diagnostics);
    summaryEl.textContent = `${counts.error} errors · ${counts.warning} warnings · ${counts.info} infos`;
    const order = { error: 0, warning: 1, info: 2 };
    const sorted = (Array.isArray(diagnostics) ? diagnostics : [])
      .slice()
      .sort((a, b) => (order[a?.severity] ?? 3) - (order[b?.severity] ?? 3));
    fillRows(list, sorted.map((diagnostic) => {
      const where = diagWhere(diagnostic);
      const target = diagFile(diagnostic);
      const open = diagTarget(root, diagnostic);
      const row = {
        label: `${diagnostic?.code ?? "?"} ${diagnostic?.message ?? ""}`,
        meta: where === "" ? target : `${target} ${where}`,
        title: diagnostic?.message ?? "",
        severity: diagnostic?.severity ?? "info",
        onClick: open.path === "" ? undefined
          : () => app.openFile(open.path, { line: open.line, pointer: open.pointer }),
      };
      /*
       * D006 is the one diagnostic whose *subject* is another file: the JSON is
       * fine, the sprite it names is not there.  The sprite path is `actual`
       * (mod-root-relative, never carrying the `#json/pointer` that `path`
       * does), so the row opens a pixel card for it -- and the declaring JSON
       * stays one click away on the meta line rather than being replaced.
       */
      if (row.label.startsWith("D006") && typeof diagnostic.actual === "string") {
        const sprite = diagnostic.actual.replace(/\\/g, "/").split("#")[0];
        if (sprite !== "" && typeof app.openPixelCard === "function") {
          row.onClick = () => app.openPixelCard(modPath(root, sprite));
          row.extra = {
            label: target === "" ? "declaring file" : `declared in ${target}`,
            title: `open ${target}, the file that declares this sprite`,
            onClick: () => app.openFile(open.path, { line: open.line, pointer: open.pointer }),
          };
        }
      }
      return row;
    }));
    if (sorted.length === 0) {
      list.append(h("div", "mod-row mod-row-empty", { text: "nothing to report" }));
    }
  }

  async function run() {
    const root = rootInput.value.trim();
    if (root === "") {
      status.textContent = "give a mod directory first";
      return;
    }
    status.textContent = "validating…";
    let report;
    try {
      report = await client.call("mod.validate", { root });
    } catch (err) {
      status.textContent = `validate failed: ${err.message}`;
      return;
    }
    card.root = root;
    shell.label.textContent = root;
    /* The response's `root` is the package path the mod layer resolved -- which
       is what every diagnostic path is relative to.  The text in the input may
       be a name the mod layer resolved against its own mods root (`Lantern`),
       so it cannot be used to build a path the kernel will read.  A shell older
       than the field still works: fall back to the input. */
    const resolved = typeof report.root === "string" && report.root !== "" ? report.root : root;
    paint(report.diagnostics, resolved);
    const counts = diagCounts(report.diagnostics);
    status.textContent = `${report.summary?.files ?? 0} files checked`;
    app.log(counts.error === 0 ? "info" : "warn",
      `${root}: ${counts.error} errors, ${counts.warning} warnings`);
  }

  rootInput.addEventListener("keydown", (event) => {
    event.stopPropagation();
    if (event.key === "Enter") {
      run();
    }
  });

  if (rootInput.value !== "") {
    run();
  } else {
    status.textContent = "validate a mod directory, e.g. Mods/MyMod";
  }

  return {
    el: shell.el,
    handle: {
      kind: "problems",
      focus() {
        rootInput.focus();
      },
      run,
      root() {
        return rootInput.value.trim();
      },
    },
    destroy() {},
  };
}

/* -- kind: docs -- the knowledge base --------------------------------- */
