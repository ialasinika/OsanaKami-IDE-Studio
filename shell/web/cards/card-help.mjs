/**
 * cards/card-help.mjs -- the help card: where the answers come from, in the window.
 *
 * Part of `cards.mjs`, which re-exports this file; see that file's header for
 * why the card layer is split the way it is.
 */
import { cardShell, h, makeStatus } from "./dom.mjs";
import { COMMAND_HELP } from "./registry.mjs";

/**
 * The help card (G15): the wiki URL and the type-support matrix, rendered.
 *
 * Both used to live only in data-source comments -- the URL in `support.json`'s
 * header and the matrix in `shell/mods/support.json` -- so a user reading the
 * window could not see either.  The card asks `mod.stats` for the same matrix
 * the validator quotes (M013/M014 read it), which is why it cannot drift from
 * the checks: there is one copy, in `support.json`.
 *
 * It is a card rather than a dialog because it is a place to read, not a
 * question to answer: it keeps its scroll position, it can be moved beside an
 * open document, and `help` on the command line brings it back.
 */
export function renderHelp(card, ctx) {
  const { client } = ctx;

  const wikiLine = h("p", "help-note");
  const counts = h("p", "help-note");
  const matrix = h("div", "help-matrix");
  const status = makeStatus();

  const body = h("div", "card-body card-body-help", {
    children: [
      h("h3", "help-heading", { text: "the game's wiki" }),
      wikiLine,
      h("h3", "help-heading", { text: "what this build will check" }),
      counts,
      matrix,
      h("h3", "help-heading", { text: "commands" }),
      h("div", "help-commands", {
        children: COMMAND_HELP.map((row) => h("code", "help-command", { text: row })),
      }),
      h("h3", "help-heading", { text: "where the codes are written down" }),
      h("p", "help-note", {
        text: "docs/MODS.md in the source tree lists every diagnostic code the window can "
          + "show (D001-D018, M009/M012-M014, Y110/Y122/Y123); the game's own §11 numbering "
          + "and the checks that are not implemented yet are in the same file.",
      }),
      status,
    ],
  });
  const shell = cardShell(card, body);
  shell.label.textContent = "sources, not guesses";

  const LEVEL_CLASS = {
    supported: "is-supported",
    partial: "is-partial",
    unsupported: "is-unsupported",
    unknown: "is-unknown",
  };

  function levelBadge(level) {
    const text = typeof level === "string" && level !== "" ? level : "unknown";
    return h("span", `help-level ${LEVEL_CLASS[text] || "is-unknown"}`, { text: text });
  }

  /**
   * One row per type, in the matrix's order (JSON order, so it reads like the
   * file it came from rather than like a sorted list nobody chose).  `manager`
   * says which registry actually takes the type; `note` quotes the wiki where
   * the matrix carries one.
   */
  function row(type, entry) {
    const info = entry && typeof entry === "object" ? entry : {};
    const parts = [h("span", "help-type", { text: type }), levelBadge(info.level)];
    if (typeof info.manager === "string" && info.manager !== "") {
      parts.push(h("span", "help-manager", { text: info.manager }));
    }
    const built = h("div", "help-row", { children: parts });
    if (typeof info.note === "string" && info.note !== "") {
      built.append(h("div", "help-row-note", { text: info.note }));
    }
    return built;
  }

  function show(answer) {
    const support = answer?.support && typeof answer.support === "object" ? answer.support : null;
    if (support === null) {
      // No knowledge base (the game is not installed and nothing was derived):
      // the card says so instead of showing an empty table that looks broken.
      wikiLine.textContent = "No knowledge base is loaded, so there is no matrix to quote; "
        + "the game's wiki is the source the build reads from.";
      counts.textContent = "Run the build where the game is installed to derive the knowledge base.";
      return;
    }
    const wiki = typeof support.wiki === "string" && support.wiki !== "" ? support.wiki : null;
    if (wiki === null) {
      wikiLine.textContent = "support.json names no wiki URL.";
    } else {
      wikiLine.textContent = "The support matrix and the definitions this build reads come from ";
      wikiLine.append(h("a", "help-link", {
        attrs: { href: wiki, target: "_blank", rel: "noreferrer" },
        text: wiki,
      }));
      wikiLine.append(document.createTextNode("."));
    }
    const types = support.types && typeof support.types === "object" ? support.types : {};
    const names = Object.keys(types);
    const tally = { supported: 0, partial: 0, unsupported: 0, unknown: 0 };
    for (const name of names) {
      const level = types[name] && types[name].level;
      const key = Object.prototype.hasOwnProperty.call(tally, level) ? level : "unknown";
      tally[key] += 1;
    }
    counts.textContent = `${names.length} types: ${tally.supported} supported, ${tally.partial} partial, `
      + `${tally.unsupported} unsupported, ${tally.unknown} not stated by the wiki. `
      + "A type the wiki does not mention is not a verdict: it is checked as unknown.";
    matrix.textContent = "";
    for (const name of names) {
      matrix.append(row(name, types[name]));
    }
    if (names.length === 0) {
      matrix.append(h("p", "help-note", { text: "The matrix is empty." }));
    }
  }

  let disposed = false;

  async function load() {
    try {
      const answer = await client.call("mod.stats");
      if (disposed) {
        return;
      }
      status.textContent = "";
      show(answer);
    } catch (error) {
      if (!disposed) {
        status.textContent = `could not read the support matrix: ${error && error.message ? error.message : String(error)}`;
      }
    }
  }

  load();

  return {
    el: shell,
    handle: {
      kind: "help",
      focus() {},
    },
    destroy() {
      disposed = true;
    },
  };
}
