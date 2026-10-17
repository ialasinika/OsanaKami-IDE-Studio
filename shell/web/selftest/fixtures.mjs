/* ------------------------------------------------------------------ */
/* fixtures: a fake /rpc, a fake SSE stream, and the stub elements     */
/* ------------------------------------------------------------------ */

/* ------------------------------------------------------------------ */
/* a fake /rpc and a fake SSE stream                                   */
/* ------------------------------------------------------------------ */

/** An SSE body whose chunks can be cut anywhere we like. */
export function sseStream(chunks, { holdOpen = false } = {}) {
  let index = 0;
  return new ReadableStream({
    pull(controller) {
      if (index < chunks.length) {
        const chunk = chunks[index];
        index += 1;
        controller.enqueue(typeof chunk === "string" ? new TextEncoder().encode(chunk) : chunk);
        return;
      }
      if (!holdOpen) {
        controller.close();
      }
    },
  });
}

/**
 * @param {object} options
 * @param {Array<object|Function>} options.replies  one per POST, in order
 * @param {string[]} [options.chunks]  raw SSE chunks
 */
/**
 * The mock host answers in JSON-RPC, because that is the only shape the real
 * host uses: the request's id comes back with either a `result` or an `error`.
 * Testing against any other shape would prove nothing about the real endpoint.
 */
export function toJsonRpc(value, record) {
  const id = record && record.body && record.body.id !== undefined ? record.body.id : null;
  if (value === undefined) {
    return { jsonrpc: "2.0", id, result: {} };
  }
  if (value.ok === true) {
    return { jsonrpc: "2.0", id, result: value.result };
  }
  if (value.error !== undefined) {
    return { jsonrpc: "2.0", id, error: value.error };
  }
  return { jsonrpc: "2.0", id, result: value.result === undefined ? value : value.result };
}

export function fakeFetch({ replies = [], chunks = [], holdOpen = false, onCall = null }) {
  const calls = [];
  let replyIndex = 0;
  const impl = async (url, init) => {
    const record = { url, init, body: init && init.body ? JSON.parse(init.body) : null };
    calls.push(record);
    if (onCall !== null) {
      onCall(record);
    }
    if (url.endsWith("/events")) {
      return { ok: true, status: 200, body: sseStream(chunks, { holdOpen }) };
    }
    const reply = replies[replyIndex];
    replyIndex += 1;
    const value = typeof reply === "function" ? reply(record) : reply;
    if (value instanceof Error) {
      throw value;
    }
    if (value && value.httpError === true) {
      return { ok: false, status: value.status || 500, text: async () => "" };
    }
    return {
      ok: true,
      status: 200,
      text: async () => JSON.stringify(toJsonRpc(value, record)),
    };
  };
  impl.calls = calls;
  return impl;
}

/** Let every already-resolved promise chain run to completion. */
export const tick = (n = 6) => new Promise((resolve) => {
  let left = n;
  const step = () => {
    left -= 1;
    if (left <= 0) {
      resolve();
    } else {
      setTimeout(step, 0);
    }
  };
  setTimeout(step, 0);
});

/* ------------------------------------------------------------------ */
/* stub elements, for the checks that have to touch the DOM layer       */
/* ------------------------------------------------------------------ */

/**
 * Record structure, and nothing else.
 *
 * The suite has no browser, and the interesting half of `renderCard` is not
 * layout: it is the decision to fall back to a placeholder instead of throwing
 * on an entry that is not a card. That decision builds real elements through
 * `document.createElement`, so the smallest possible element stub is installed
 * for the duration of one check. It has no layout, no focus and no real events
 * -- which is exactly what the closing `note:` line says is not covered.
 */
export function stubDom() {
  class StubElement {
    constructor(tag) {
      this.tagName = tag;
      this.children = [];
      this.attrs = {};
      this.className = "";
      this.textContent = "";
      this.classList = {
        add: (name) => {
          this.className = `${this.className} ${name}`.trim();
        },
      };
    }

    setAttribute(key, value) {
      this.attrs[key] = String(value);
    }

    append(child) {
      this.children.push(child);
      return child;
    }

    remove() {
      this.removed = true;
    }

    addEventListener() {}
  }

  const previous = Object.prototype.hasOwnProperty.call(globalThis, "document")
    ? globalThis.document
    : undefined;
  globalThis.document = {
    createElement: (tag) => new StubElement(tag),
    createTextNode: (text) => ({ textContent: String(text), children: [] }),
    createDocumentFragment: () => new StubElement("#fragment"),
  };

  return {
    /** Flatten every text node under a stub element. */
    text(el) {
      if (el === null || el === undefined) {
        return "";
      }
      const own = typeof el.textContent === "string" ? el.textContent : "";
      const kids = Array.isArray(el.children) ? el.children.map((child) => this.text(child)).join("") : "";
      return own + kids;
    },
    restore() {
      if (previous === undefined) {
        delete globalThis.document;
      } else {
        globalThis.document = previous;
      }
    },
  };
}

/*
 * A whole document, just enough to build the app.
 *
 * `stubDom` above is a fragment recorder with no ids; this is the other
 * extreme.  Every id `createApp` reaches for answers with an element, so the
 * shell's own construction path runs under Node and a typed command can be
 * handed to the *real* `mode` switch instead of to a paraphrase of its rules.
 * It is still not a browser: no layout, no measurement, no focus, no wheel and
 * no selection, which is what the closing `note:` line admits.
 *
 * Elements remember the classes the shell toggles, because that is how a switch
 * of view shows up without pixels: the shell paints the current view onto
 * `<body>`/`#board`, and `viewClasses()` reads it back.
 */
export function stubAppDom() {
  const WIDTH = 1200;
  const HEIGHT = 800;

  const element = (tag) => {
    const classes = new Set();
    const stub = {
      tagName: String(tag).toUpperCase(),
      children: [],
      attrs: {},
      dataset: {},
      style: {},
      className: "",
      textContent: "",
      title: "",
      type: "",
      value: "",
      id: "",
      hidden: false,
      scrollTop: 0,
      scrollHeight: 0,
      offsetWidth: WIDTH,
      offsetHeight: HEIGHT,
      childElementCount: 0,
      firstElementChild: null,
      queries: new Map(),
      classes,
      classList: {
        add: (name) => {
          classes.add(String(name));
        },
        remove: (name) => {
          classes.delete(String(name));
        },
        contains: (name) => classes.has(String(name)),
        toggle(name, on) {
          const wanted = on === undefined ? !classes.has(String(name)) : Boolean(on);
          if (wanted) {
            classes.add(String(name));
          } else {
            classes.delete(String(name));
          }
          return wanted;
        },
      },
      append(...children) {
        for (const child of children) {
          if (child !== null && child !== undefined) {
            this.children.push(child);
          }
        }
        this.childElementCount = this.children.length;
        this.firstElementChild = this.children[0] || null;
      },
      appendChild(child) {
        this.append(child);
        return child;
      },
      removeChild(child) {
        this.children = this.children.filter((one) => one !== child);
        this.childElementCount = this.children.length;
        this.firstElementChild = this.children[0] || null;
        return child;
      },
      replaceChildren(...children) {
        this.children = [];
        this.append(...children);
      },
      remove() {
        this.removed = true;
      },
      setAttribute(key, value) {
        this.attrs[key] = String(value);
        if (key === "id") {
          this.id = String(value);
        }
      },
      getAttribute(key) {
        return Object.prototype.hasOwnProperty.call(this.attrs, key) ? this.attrs[key] : null;
      },
      addEventListener() {},
      removeEventListener() {},
      focus() {},
      blur() {},
      select() {},
      setSelectionRange() {},
      getBoundingClientRect() {
        return { x: 0, y: 0, top: 0, left: 0, right: WIDTH, bottom: HEIGHT, width: WIDTH, height: HEIGHT };
      },
      querySelector(selector) {
        if (!this.queries.has(selector)) {
          const found = element("div");
          found.setAttribute("class", String(selector).replace(/^[.#]/, ""));
          this.queries.set(selector, found);
        }
        return this.queries.get(selector);
      },
      querySelectorAll() {
        return [];
      },
      closest() {
        return null;
      },
      contains() {
        return false;
      },
    };
    // The shell empties panels with `innerHTML = ""`; there is nothing to parse
    // and never will be here, because nothing here is a browser.
    Object.defineProperty(stub, "innerHTML", {
      get() {
        return "";
      },
      set() {
        this.children = [];
        this.childElementCount = 0;
        this.firstElementChild = null;
      },
    });
    return stub;
  };

  const byId = new Map();
  const elementFor = (id) => {
    if (!byId.has(id)) {
      byId.set(id, element("div"));
    }
    return byId.get(id);
  };

  const body = element("body");
  elementFor("board");

  const previous = new Map();
  const swap = (name, value) => {
    previous.set(name, Object.prototype.hasOwnProperty.call(globalThis, name) ? globalThis[name] : undefined);
    globalThis[name] = value;
  };
  const media = { matches: false, addEventListener() {}, removeEventListener() {} };
  const style = { getPropertyValue: () => "" };

  swap("document", {
    body,
    documentElement: element("html"),
    activeElement: null,
    getElementById: (id) => (id === null || id === undefined ? null : elementFor(String(id))),
    createElement: (tag) => element(tag),
    createElementNS: (namespace, tag) => element(tag),
    createTextNode: (text) => ({ textContent: String(text), children: [] }),
    createDocumentFragment: () => element("#fragment"),
    querySelector: (selector) => elementFor(`query:${selector}`),
    querySelectorAll: () => [],
    addEventListener() {},
    removeEventListener() {},
  });
  swap("window", {
    addEventListener() {},
    removeEventListener() {},
    matchMedia: () => media,
    getComputedStyle: () => style,
    devicePixelRatio: 1,
    innerWidth: WIDTH,
    innerHeight: HEIGHT,
  });
  swap("requestAnimationFrame", (fn) => setTimeout(fn, 0));
  swap("cancelAnimationFrame", (handle) => clearTimeout(handle));
  swap("getComputedStyle", () => style);
  swap("matchMedia", () => media);
  swap("HTMLElement", class {});
  swap("HTMLInputElement", class {});
  swap("HTMLTextAreaElement", class {});
  swap("Element", class {});

  return {
    /** The `<body>` the current view is painted onto. */
    body,
    /** The stub behind an id, for reading what the shell did with it. */
    element: (id) => elementFor(String(id)),
    /** The lines currently in `#log`, oldest first. */
    logLines() {
      return elementFor("log").children;
    },
    /** The view the shell painted, by class, sorted. */
    viewClasses() {
      return [...body.classes].sort();
    },
    /** Flatten every text node under a stub element. */
    text(el) {
      if (el === null || el === undefined) {
        return "";
      }
      const own = typeof el.textContent === "string" ? el.textContent : "";
      const kids = Array.isArray(el.children) ? el.children.map((child) => this.text(child)).join("") : "";
      return own + kids;
    },
    restore() {
      for (const [name, value] of previous) {
        if (value === undefined) {
          delete globalThis[name];
        } else {
          globalThis[name] = value;
        }
      }
    },
  };
}

/** A listener-recording stand-in for a DOM element. */
export function stubEventTarget() {
  const listeners = new Map();
  return {
    list(type) {
      return listeners.get(type) || [];
    },
    count(type) {
      return this.list(type).length;
    },
    addEventListener(type, fn) {
      const list = listeners.get(type) || [];
      list.push(fn);
      listeners.set(type, list);
    },
    removeEventListener(type, fn) {
      const list = listeners.get(type) || [];
      listeners.set(type, list.filter((entry) => entry !== fn));
    },
    fire(type, detail = {}) {
      for (const fn of [...this.list(type)]) {
        fn({ type, ...detail });
      }
    },
  };
}
