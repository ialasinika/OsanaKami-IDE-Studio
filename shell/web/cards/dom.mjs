/**
 * cards/dom.mjs -- the smallest DOM a card is built from -- `h`, the shell, the header/status helpers.
 *
 * Part of `cards.mjs`, which re-exports this file; see that file's header for
 * why the card layer is split the way it is.
 */
import { KIND_REGISTRY, unknownCardPlaceholder } from "./registry.mjs";
import { applyTokenSpans, markHits } from "./text.mjs";

/** Create an element with class names, text, attributes and children. */
export function h(tag, className, options = {}) {
  const el = document.createElement(tag);
  if (className) {
    el.className = className;
  }
  if (options.text !== undefined) {
    el.textContent = options.text;
  }
  if (options.attrs) {
    for (const key of Object.keys(options.attrs)) {
      el.setAttribute(key, options.attrs[key]);
    }
  }
  if (options.children) {
    for (const child of options.children) {
      el.append(child);
    }
  }
  return el;
}

/**
 * Wrap a card body in the shell every kind shares: a title bar (the drag
 * handle), the body, and a corner grip (the resize handle).  `main.mjs` binds
 * its pointer gestures to `[data-role="card-title"]` and `[data-role="grip"]`.
 */
export function cardShell(card, body, options = {}) {
  const title = h("div", "card-title", { attrs: { "data-role": "card-title" } });
  title.append(h("span", "card-kind", { text: card.kind }));
  const label = h("span", "card-label", { attrs: { "data-role": "card-label" } });
  title.append(label);
  const tools = h("span", "card-tools", { attrs: { "data-role": "card-tools" } });
  title.append(tools);

  const grip = h("div", "card-grip", { attrs: { "data-role": "grip", title: "drag to resize" } });
  const el = h("div", `card card-${card.kind}`, {
    attrs: { "data-card-id": card.id },
    children: [title, body, grip],
  });
  if (options.accent) {
    el.classList.add("is-accent");
  }
  return { el, title, label, tools };
}

/**
 * Fill a `<pre>` with one text node or `<span>` per segment.
 *
 * `hits` (from `findMatches`) widen each segment with a flag, and every matched
 * piece is wrapped in a `<mark>` so it shows through the transparent textarea
 * above.  `current` is the match the find bar is standing on.
 */
export function paintTokens(pre, text, tokens, hits = [], current = -1) {
  const segments = markHits(applyTokenSpans(text, tokens), hits, current);
  pre.textContent = "";
  const frag = document.createDocumentFragment();
  for (const seg of segments) {
    const chunk = text.slice(seg.start, seg.end);
    let node;
    if (seg.kind === "plain") {
      node = document.createTextNode(chunk);
    } else {
      node = h("span", `tok-${seg.kind}`, { text: chunk });
    }
    if (seg.hit) {
      node = h("mark", seg.current ? "ed-hit is-current" : "ed-hit", {
        attrs: { "data-role": "find-hit" },
        children: [node],
      });
    }
    frag.append(node);
  }
  pre.append(frag);
  return segments.length;
}

export function makeStatus() {
  return h("div", "card-status", { attrs: { "data-role": "card-status" } });
}

/**
 * Build one card.
 *
 * @param {object} card  the board card; its extra fields are the card's state
 * @param {object} ctx   `{client, app}` -- the only way out of a card
 * @returns {{el: HTMLElement, handle: object, destroy: Function}}
 */
export function renderCard(card, ctx) {
  const spec = card !== null && typeof card === "object" && !Array.isArray(card)
    ? KIND_REGISTRY.get(card.kind)
    : undefined;
  return spec === undefined ? renderUnknown(card) : spec.render(card, ctx);
}

/** Unknown kinds are preserved and shown, never silently deleted. */
export function renderUnknown(card) {
  const notice = unknownCardPlaceholder(card);
  const body = h("div", "card-body card-body-unknown", {
    children: [h("p", "card-message", { text: notice.message })],
  });
  // `cardShell` reads `id`/`kind` off its argument, so it gets the repaired
  // values rather than the malformed entry: a null still has to produce a card.
  const shell = cardShell({ id: notice.id, kind: notice.kind }, body);
  shell.label.textContent = notice.label;
  return {
    el: shell.el,
    handle: { kind: notice.kind, focus() {} },
    destroy() {},
  };
}

/* -------------------- editing text -------------------- */

export function button(label, title, onClick) {
  const el = h("button", "card-button", { text: label, attrs: { type: "button", title } });
  el.addEventListener("click", onClick);
  return el;
}

/**
 * A collapsible-looking section: a heading plus clickable rows.  Every row is
 * `{label, meta, onClick, severity}`; a row without `onClick` is inert text,
 * `empty: true` marks the one placeholder row of a section with nothing in it,
 * and `severity` tints the row with the shared `.sev-*` colours.  `extra` is one
 * more control on the row -- `{label, onClick, title}` -- for a row whose
 * second target would otherwise be unreachable (a D006 sprite row points at
 * two files: the image that is missing and the JSON that asks for it).
 *
 * `onClick` makes the *title* a target too, which is how the mod card's three
 * section headings open the file they head.  It is a keyboard-reachable div and
 * not a <button>: the stylesheet draws the heading as an inert label, and a
 * button element would paint its own chrome over it.
 */
export function section(className, title, count, onClick) {
  const label = count === undefined ? title : `${title} (${count})`;
  const head = h("div", "mod-section-title", {
    text: label,
    attrs: onClick
      ? { role: "button", tabindex: "0", title: `open the ${title} file` }
      : {},
  });
  if (onClick) {
    head.style.cursor = "pointer";
    head.addEventListener("click", onClick);
    head.addEventListener("keydown", (event) => {
      if (event.key !== "Enter" && event.key !== " ") {
        return;
      }
      event.preventDefault();
      onClick(event);
    });
  }
  const rows = h("div", "mod-rows");
  return { el: h("div", `mod-section ${className}`, { children: [head, rows] }), rows };
}

export function fillRows(container, rows) {
  const frag = document.createDocumentFragment();
  for (const row of rows) {
    const classes = ["mod-row"];
    if (row.dir) classes.push("is-dir");
    if (row.empty) classes.push("mod-row-empty");
    if (row.severity) classes.push(`sev-${row.severity}`);
    const el = h(row.onClick ? "button" : "div", classes.join(" "), {
      attrs: row.onClick ? { type: "button", title: row.title ?? "" } : {},
    });
    el.append(h("span", "mod-row-name", { text: row.label }));
    if (row.meta !== undefined && row.meta !== "") {
      el.append(h("span", "mod-row-meta", { text: row.meta }));
    }
    if (row.extra) {
      const extra = h("span", "mod-row-extra", {
        attrs: { role: "button", tabindex: "0", title: row.extra.title ?? "", "data-role": "mod-row-extra" },
        text: row.extra.label,
      });
      extra.addEventListener("click", (event) => {
        event.stopPropagation();
        row.extra.onClick(event);
      });
      extra.addEventListener("keydown", (event) => {
        if (event.key !== "Enter" && event.key !== " ") {
          return;
        }
        event.stopPropagation();
        event.preventDefault();
        row.extra.onClick(event);
      });
      el.append(extra);
    }
    if (row.onClick) {
      el.addEventListener("click", row.onClick);
    }
    frag.append(el);
  }
  container.textContent = "";
  container.append(frag);
}

/* -- kind: mod -- the package itself ---------------------------------- */

/** True when the caret sits at the very start of a text-like control. */
export function caretAtStart(node) {
  return typeof node.selectionStart !== "number" || node.selectionStart === 0;
}

/** True when the caret sits at the very end, or the control has no caret. */
export function caretAtEnd(node) {
  return typeof node.selectionEnd !== "number" || node.selectionEnd >= node.value.length;
}
