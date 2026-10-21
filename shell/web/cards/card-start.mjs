/**
 * cards/card-start.mjs -- the first card a new person sees (G58).
 *
 * The editor opens on an empty board, and the mod card asks for a package path
 * typed from memory.  Between those two facts a first-time user has no way in,
 * so this card states the three things that matter -- open the folder, open a
 * package and validate it, then fix and install -- and points each at the verb
 * that does it.  It is a card rather than a dialog so it can sit on the board,
 * be reopened from Settings, and be resized like anything else.
 *
 * The "got it, hide this" button writes `prefs.onboarded`; the shell opens this
 * card by itself only while that preference is false, so closing it once is a
 * decision, not an accident of this window.
 */
import { button, cardShell, h, makeStatus, makeTranslations } from "./dom.mjs";
import { t } from "../i18n.mjs";

export function renderStart(card, ctx) {
  const { client, app } = ctx;
  const tr = makeTranslations();
  const list = h("div", "start-packages");
  const status = makeStatus();

  const openMods = button("", "open the mod card on the game's Mods folder", () => {
    if (typeof app.openModCard === "function") {
      app.openModCard("");
    }
  });
  tr.text(openMods, "start.openMods");

  const openPackage = button("", "open a package the game already has", () => {
    const first = list.querySelector("button");
    if (first !== null && typeof app.openModCard === "function") {
      app.openModCard(first.dataset.dir);
    }
  });
  tr.text(openPackage, "start.openPackage");

  const help = button("", "open the help card", () => {
    if (typeof app.openHelpCard === "function") {
      app.openHelpCard();
    }
  });
  tr.text(help, "start.help");

  const finish = button("", "hide the guide; the help card keeps the same answers", () => {
    card.done = true;
    if (typeof app.onboarded === "function") {
      app.onboarded();
    }
    status.textContent = t("start.done");
  });
  tr.text(finish, "start.finish");

  const steps = h("div", "start-steps");
  const step = (n, headingKey, bodyKey, control) => {
    const row = h("div", "start-step", {
      children: [h("span", "start-number", { text: String(n) })],
    });
    const name = h("span", "start-step-name");
    tr.text(name, headingKey);
    const note = h("span", "start-step-body");
    tr.text(note, bodyKey);
    row.append(name, note);
    if (control) {
      row.append(control);
    }
    steps.append(row);
  };
  step(1, "start.step1", "start.step1.body", openMods);
  step(2, "start.step2", "start.step2.body", openPackage);
  step(3, "start.step3", "start.step3.body", help);

  const body = h("div", "card-body card-body-start", {
    children: [
      h("p", "start-intro", { text: t("start.intro") }),
      steps,
      list,
      status,
      h("div", "start-footer", { children: [finish] }),
    ],
  });
  const shell = cardShell(card, body);

  /** The packages under the game's Mods folder, as buttons that open the mod card. */
  async function loadPackages() {
    let answer = null;
    try {
      answer = await client.call("mod.packages", {});
    } catch {
      answer = null;
    }
    const entries = answer !== null && Array.isArray(answer.packages) ? answer.packages : [];
    if (entries.length === 0) {
      status.textContent = t("mod.pickNone");
      list.replaceChildren();
      return;
    }
    const rows = entries.slice(0, 6).map((entry) => {
      const name = entry.manifest !== null && typeof entry.manifest === "object"
        && typeof entry.manifest.name === "string" && entry.manifest.name !== ""
        ? entry.manifest.name
        : entry.folder;
      const row = h("button", "start-package", { attrs: { type: "button" }, text: name });
      row.dataset.dir = entry.dir;
      row.addEventListener("click", () => {
        if (typeof app.openModCard === "function") {
          app.openModCard(entry.dir);
        }
      });
      return row;
    });
    list.replaceChildren(...rows);
  }

  loadPackages();

  return {
    el: shell.el,
    handle: {
      kind: "start",
      focus() {
        openMods.focus();
      },
      relabel() {
        tr.relabel();
        status.textContent = "";
        loadPackages();
      },
    },
    destroy() {},
  };
}
