/**
 * cards/card-note.mjs -- the note card: markdown-ish text that is nobody else's file.
 *
 * Part of `cards.mjs`, which re-exports this file; see that file's header for
 * why the card layer is split the way it is.
 */
import { cardShell, h, makeStatus } from "./dom.mjs";

export function renderNote(card, ctx) {
  const { app } = ctx;
  const area = h("textarea", "note-input", {
    attrs: { spellcheck: "false", placeholder: "scratch…" },
  });
  area.value = typeof card.text === "string" ? card.text : "";
  const status = makeStatus();
  const body = h("div", "card-body card-body-note", { children: [area, status] });
  const shell = cardShell(card, body);

  function update() {
    const text = area.value;
    status.textContent = `${text.length} chars · stored in the board`;
    shell.label.textContent = text.split("\n")[0].slice(0, 48);
  }

  area.addEventListener("input", () => {
    card.text = area.value;
    update();
    app.boardTouched(true);
  });
  area.addEventListener("keydown", (event) => {
    event.stopPropagation();
  });
  update();

  return {
    el: shell.el,
    handle: {
      kind: "note",
      focus() {
        area.focus();
      },
    },
    destroy() {},
  };
}

/* -------------------- files -------------------- */
