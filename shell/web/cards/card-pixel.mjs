/**
 * cards/card-pixel.mjs -- the pixel card: a sprite on a canvas, one tool at a time.
 *
 * Part of `cards.mjs`, which re-exports this file; see that file's header for
 * why the card layer is split the way it is.
 */
import { blankImage, decodePng, encodePng, pixelAt, setPixelAt } from "../pixelpng.mjs";
import { framedPan, zoomAt } from "../pixelview.mjs";
import { cardShell, h, makeStatus } from "./dom.mjs";

/** Tools a pixel card offers; the current one is held in `state.tool`. */
export const PIXEL_TOOLS = [
  { name: "pencil", hint: "pencil: draw with the current colour (B)" },
  { name: "eraser", hint: "eraser: clear a pixel to transparent (E)" },
  { name: "fill", hint: "fill: flood the same-coloured region under the pointer (G)" },
  { name: "eyedropper", hint: "eyedropper: take the colour under the pointer (I)" },
  { name: "hand", hint: "hand: pan the image; the middle button pans with any tool" },
];

/** The default `#rrggbb` palette a new pixel card starts from. */
export const PIXEL_PALETTE = [
  "#000000", "#ffffff", "#7f7f7f", "#c8c8c8",
  "#803c14", "#e08020", "#3c3c28", "#f0d890",
  "#7c1c14", "#d04028", "#204018", "#489030",
  "#202048", "#4060a8", "#5a2c5c", "#a058a0",
];

/**
 * The size a missing sprite is declared at before the person changes it, and
 * the size a card opened without one is given: 96x96, the game's own
 * `Sprites\Situation_96` convention.  Exported so `main.mjs`'s `openPixelCard`
 * declares exactly the number this kind's `create()` seeds, and so the D006 row
 * that opens a sprite the mod does not carry lands at a usable size.
 */
export const PIXEL_NEW_SIZE = 96;

/** The single-letter tool keys, so the hints above are not just words. */
export const PIXEL_TOOL_KEYS = { b: "pencil", e: "eraser", g: "fill", i: "eyedropper", h: "hand" };

export const PIXEL_ZOOM_MIN = 1;

export const PIXEL_ZOOM_MAX = 32;

/** How many gestures a card can take back. */
export const PIXEL_HISTORY = 64;

/**
 * The colour the hand/eyedropper readout shows: the pixel's own colour, or a
 * near-black that is visible on the checkerboard when the pixel is transparent.
 *
 * Exported, with the two below it, for the suite: this is the card's whole
 * opinion about colour, and it is testable without a canvas.
 */
export function pixelInkOf(rgba) {
  if (rgba === null || rgba === undefined) {
    return "#4a4a4a";
  }
  return `#${[rgba[0], rgba[1], rgba[2]].map((byte) => Number(byte).toString(16).padStart(2, "0")).join("")}`;
}

/** `#rrggbb` (or `#rgb`) to `[r, g, b, 255]`, or null for anything else. */
export function pixelColourOf(text) {
  const raw = typeof text === "string" ? text.trim().replace(/^#/, "") : "";
  const hex = raw.length === 3 ? raw.split("").map((c) => c + c).join("") : raw;
  if (!/^[0-9a-fA-F]{6}$/.test(hex)) {
    return null;
  }
  return [
    parseInt(hex.slice(0, 2), 16),
    parseInt(hex.slice(2, 4), 16),
    parseInt(hex.slice(4, 6), 16),
    255,
  ];
}

/** The palette in the board document, as a list of usable `#rrggbb` strings. */
export function pixelPaletteOf(value) {
  const wanted = Array.isArray(value) ? value : [];
  const out = [];
  for (const entry of wanted) {
    const colour = pixelColourOf(entry);
    if (colour !== null) {
      out.push(pixelInkOf(colour));
    }
  }
  return out.length === 0 ? PIXEL_PALETTE.slice() : out;
}

export function renderPixel(card, ctx) {
  const { client, app } = ctx;

  const state = {
    /** The file the pixels belong to; also mirrored into the board document. */
    file: typeof card.file === "string" ? card.file : "",
    /** `{width, height, pixels}` -- the only copy of the artwork in memory. */
    image: null,
    /** The kernel's revision for the bytes on disk, or null when there is none. */
    baseRevision: null,
    /** Set when the file could not be decoded: a save would clobber it. */
    readError: null,
    /** How the pixels in `image` got here, for the label and the status line. */
    origin: "new",
    palette: pixelPaletteOf(card.palette),
    tool: "pencil",
    colour: "#000000",
    zoom: PIXEL_ZOOM_MIN,
    panX: 0,
    panY: 0,
    /*
     * True once the person has moved the picture themselves -- a hand or middle
     * button drag, or a wheel zoom.  Until then the framing follows the surface,
     * which is how a card opened in the background is centred when it first
     * becomes visible; after it, `shown()` and every repaint keep their pan.
     */
    panTouched: false,
    pointer: null,
    pending: null,
    history: [],
    /** Index of the last applied step, or -1 when the image is at the start. */
    index: -1,
    saving: false,
    busy: false,
  };

  /* -- the chrome ---------------------------------------------------- */

  const toolsBar = h("div", "pixel-tools", { attrs: { "data-role": "pixel-tools" } });
  const toolButtons = new Map();
  for (const tool of PIXEL_TOOLS) {
    const el = h("button", "pixel-tool", {
      attrs: { type: "button", title: tool.hint, "data-role": `pixel-tool-${tool.name}`, "data-tool": tool.name },
      text: tool.name,
    });
    el.addEventListener("click", () => selectTool(tool.name));
    toolButtons.set(tool.name, el);
    toolsBar.append(el);
  }

  const colourInput = h("input", "pixel-colour", {
    attrs: { type: "color", value: state.colour, "data-role": "pixel-colour", title: "the colour the pencil draws with" },
  });
  colourInput.value = state.colour;
  colourInput.addEventListener("input", () => {
    state.colour = String(colourInput.value || state.colour);
    paintSwatches();
  });

  const swatches = h("div", "pixel-swatches", { attrs: { "data-role": "pixel-palette" } });
  toolsBar.append(colourInput, swatches);

  const widthInput = h("input", "pixel-size", {
    attrs: { type: "number", min: "1", max: "4096", "data-role": "pixel-width", title: "declared width of a new image" },
  });
  const heightInput = h("input", "pixel-size", {
    attrs: { type: "number", min: "1", max: "4096", "data-role": "pixel-height", title: "declared height of a new image" },
  });
  const newButton = h("button", "pixel-button", {
    attrs: { type: "button", "data-role": "pixel-new", title: "throw the pixels away and start a blank image at this size" },
    text: "New",
  });
  newButton.addEventListener("click", () => newImage());
  const sizeGroup = h("div", "pixel-group pixel-sizes", {
    children: [widthInput, h("span", "pixel-times", { text: "×" }), heightInput, newButton],
  });

  const zoomOut = h("button", "pixel-button", {
    attrs: { type: "button", "data-role": "pixel-zoom-out", title: "zoom out (Ctrl+wheel)" },
    text: "−",
  });
  const zoomIn = h("button", "pixel-button", {
    attrs: { type: "button", "data-role": "pixel-zoom-in", title: "zoom in (Ctrl+wheel)" },
    text: "+",
  });
  const zoomReadout = h("span", "pixel-zoom-label", { attrs: { "data-role": "pixel-zoom" } });
  zoomOut.addEventListener("click", () => setZoom(Math.floor(state.zoom / 2)));
  zoomIn.addEventListener("click", () => setZoom(state.zoom * 2));
  const zoomGroup = h("div", "pixel-group pixel-zooms", { children: [zoomOut, zoomIn, zoomReadout] });

  const saveButton = h("button", "pixel-button is-primary", {
    attrs: { type: "button", "data-role": "pixel-save", title: "write the PNG back through file.write_bytes (Ctrl+S in the card)" },
    text: "save",
  });
  saveButton.addEventListener("click", () => save());

  const tools = h("div", "pixel-groups", { children: [sizeGroup, zoomGroup, saveButton] });

  const canvas = h("canvas", "pixel-canvas", {
    attrs: { "data-role": "pixel-canvas", tabindex: "0", title: "wheel to zoom · middle button or the hand tool to pan" },
  });
  const surface = h("div", "pixel-surface", { attrs: { "data-role": "pixel-surface" }, children: [canvas] });
  const status = makeStatus();
  const body = h("div", "card-body card-body-pixel", { children: [toolsBar, surface, tools, status] });
  const shell = cardShell(card, body);

  const context = typeof canvas.getContext === "function" ? canvas.getContext("2d") : null;

  /*
   * `putImageData` ignores the CTM, the clip and the alpha, so the zoom/pan
   * transform cannot be applied to the image directly.  The image is put,
   * untransformed, into an offscreen bitmap at its own size and handed back to
   * the visible canvas with `drawImage`, which *does* honour the transform --
   * with smoothing off, still on crisp pixel edges.  Created lazily, and sized
   * from the image rather than from the surface.
   */
  let offscreen = null;
  let offscreenContext = null;
  /** True while the window is listening for the end of the live gesture. */
  let gestureBound = false;
  /*
   * Clicks that arrived once the card was on screen but before its file read had
   * answered.  There is no image to stamp into yet, so the press is refused --
   * and that refusal must not vanish.  The load's own report lands right after
   * it and would otherwise wipe the one sign that the click did nothing, and the
   * person would go on to save an image they never drew on.  So they are counted
   * here and said again as soon as there is an image to draw on.
   */
  let ignoredWhileLoading = 0;

  /** The "and N clicks did nothing" tail for a report; empty when there were none. */
  function ignoredNote() {
    if (ignoredWhileLoading === 0) {
      return "";
    }
    const count = ignoredWhileLoading;
    ignoredWhileLoading = 0;
    return ` (${count} click${count === 1 ? "" : "s"} before the image was ready did nothing)`;
  }

  /* -- painting ------------------------------------------------------ */

  /** Pick a tool by name, the one place that changes it. */
  function selectTool(name) {
    if (!toolButtons.has(name)) {
      return;
    }
    state.tool = name;
    paintTools();
  }

  function paintTools() {
    for (const [name, el] of toolButtons) {
      el.classList.toggle("is-on", name === state.tool);
    }
    colourInput.value = state.colour;
    canvas.classList.toggle("is-hand", state.tool === "hand");
  }

  function paintSwatches() {
    swatches.textContent = "";
    for (const colour of state.palette) {
      const swatch = h("button", "pixel-swatch", {
        attrs: { type: "button", title: colour, "data-role": "pixel-swatch", "data-colour": colour },
      });
      swatch.style = { backgroundColor: colour };
      if (colour.toLowerCase() === String(state.colour).toLowerCase()) {
        swatch.classList.add("is-on");
      }
      swatch.addEventListener("click", () => {
        state.colour = colour;
        paintTools();
        paintSwatches();
      });
      swatches.append(swatch);
    }
  }

  /**
   * The pixels on screen: the image goes into the offscreen bitmap whole and
   * untransformed, and the visible canvas gets it back with one `drawImage`
   * inside the zoom/pan transform.  `putImageData` cannot take a transform at
   * all, so painting the image straight onto the visible canvas would ignore
   * zoom and pan -- and leave a click painting a different pixel than the one
   * under the cursor.  Nothing is composed per pixel, so a repaint cannot
   * disagree with `state.image` -- and a stub context sees exactly the image
   * the card holds, which is what makes this card testable without a browser.
   */
  function paintCanvas() {
    const image = state.image;
    if (image === null || context === null) {
      return;
    }
    const view = surface.getBoundingClientRect ? surface.getBoundingClientRect() : { width: 0, height: 0 };
    const viewWidth = Math.max(0, Math.floor(view.width || 0));
    const viewHeight = Math.max(0, Math.floor(view.height || 0));
    /*
     * Framing happens here, not in the caller: every path that puts pixels on
     * the canvas -- the first paint, the next frame's repaint, `shown()`, an
     * undo -- measures the surface first, so an un-panned image is centred on
     * whatever the surface really is and a pan the person made is left alone.
     * The raw 0x0 measurement is not a frame worth centring into; it means the
     * card is not laid out yet.
     */
    const framed = framedPan(viewWidth, viewHeight, image.width, image.height, state.zoom,
      state.panX, state.panY, state.panTouched);
    state.panX = framed.panX;
    state.panY = framed.panY;
    const width = Math.max(1, viewWidth);
    const height = Math.max(1, viewHeight);
    if (canvas.width !== width || canvas.height !== height) {
      canvas.width = width;
      canvas.height = height;
    }
    if (offscreen === null || offscreenContext === null) {
      offscreen = document.createElement("canvas");
      offscreenContext = typeof offscreen.getContext === "function" ? offscreen.getContext("2d") : null;
    }
    if (offscreenContext === null) {
      return;
    }
    if (offscreen.width !== image.width || offscreen.height !== image.height) {
      offscreen.width = image.width;
      offscreen.height = image.height;
    }
    const source = offscreenContext.createImageData(image.width, image.height);
    source.data.set(image.pixels);
    offscreenContext.putImageData(source, 0, 0);

    context.setTransform(1, 0, 0, 1, 0, 0);
    context.clearRect(0, 0, canvas.width, canvas.height);
    const originX = Math.round(state.panX);
    const originY = Math.round(state.panY);
    // Where the image sits, in the canvas' own pixels: the click mapping below
    // uses the same two numbers, so a test that aims at image pixel (x, y) can
    // read them here instead of re-deriving the framing rule (which changed when
    // an unpanned image started being centred instead of pinned to the corner).
    canvas.dataset.panX = String(originX);
    canvas.dataset.panY = String(originY);
    canvas.dataset.zoom = String(state.zoom);
    context.setTransform(state.zoom, 0, 0, state.zoom, originX, originY);
    if (typeof context.imageSmoothingEnabled === "boolean") {
      context.imageSmoothingEnabled = false;
    }
    context.drawImage(offscreen, 0, 0);
  }

  function updateLabel() {
    shell.label.textContent = state.file === "" ? "(no file)" : state.file;
    shell.label.title = state.file;
    const image = state.image;
    if (image !== null) {
      widthInput.value = String(image.width);
      heightInput.value = String(image.height);
    }
    zoomReadout.textContent = `${state.zoom}×`;
  }

  function updateStatus(extra = null) {
    const image = state.image;
    const parts = [];
    if (extra !== null) {
      parts.push(extra);
    }
    if (state.file === "") {
      parts.push("no file");
    } else {
      parts.push(`${state.file}${state.origin === "file" ? "" : ` (${state.origin})`}`);
    }
    if (image !== null) {
      parts.push(`${image.width}×${image.height}`);
    }
    parts.push(`${state.zoom}×`);
    parts.push(state.tool);
    parts.push(state.colour);
    if (state.pointer !== null && image !== null) {
      const [r, g, b, a] = state.pointer;
      parts.push(a === 0 ? "transparent" : `${r},${g},${b}·${Math.round((a / 255) * 100)}%`);
    }
    if (state.readError !== null) {
      parts.push("not writable until it reloads");
    }
    if (state.baseRevision === null && state.origin === "new") {
      parts.push("reading…");
    }
    status.textContent = parts.join(" · ");
  }

  function paint() {
    paintTools();
    paintCanvas();
    updateLabel();
    updateStatus();
  }

  /**
   * Re-measure the surface and repaint.  The card is assembled while it may be
   * detached or behind another card, and `paintCanvas` can only measure the
   * rect the browser gives it: a 0x0 measurement leaves the bitmap 1x1 and the
   * image invisible until something forces a repaint (`G52` in
   * `docs/gaps2.md`).
   *
   * The app calls this when the card comes to the front -- a tab switch, a
   * selection, a focus -- because only then does the surface have a size.
   * Safe to call at any time and repeatedly, with or without an image; it
   * returns false and does nothing until an image is loaded.  An un-panned
   * image is centred on the measured size; a pan the person made is kept.
   */
  function shown() {
    if (state.image === null || context === null) {
      return false;
    }
    paintCanvas();
    return true;
  }

  function renderStatus(message) {
    updateStatus(message);
  }

  function report(message, level = "info") {
    app.log(level, message);
    renderStatus(message);
  }

  /* -- the board field ------------------------------------------------- */

  /**
   * Keep the board document's four fields in step with the card.  `record:
   * false` because opening a file or declaring a size is not an edit anybody
   * wants to take back with Ctrl+Z -- the pixels are the edits, and they live
   * in this card's own ring.
   */
  function writeToBoard() {
    if (state.file !== card.file) {
      card.file = state.file;
    }
    if (state.image !== null) {
      if (card.width !== state.image.width) {
        card.width = state.image.width;
      }
      if (card.height !== state.image.height) {
        card.height = state.image.height;
      }
    }
    card.palette = state.palette.slice();
    app.boardTouched(true, { record: false });
  }

  /* -- history: this card's own ring ---------------------------------- */

  /** True when the pixels are exactly what was last loaded or saved. */
  function atClean() {
    const step = state.index < 0 ? null : state.history[state.index];
    return step !== null && step.clean === true;
  }

  function resetHistory() {
    state.history = [];
    state.index = -1;
    // Nothing has been saved yet, so no position in the ring is "clean"; the
    // empty stack is what says so.
  }

  function markClean() {
    for (const step of state.history) {
      step.clean = false;
    }
    if (state.index >= 0) {
      state.history[state.index].clean = true;
    }
  }

  function pushStep(before, after, label) {
    state.history = state.history.slice(0, state.index + 1);
    state.history.push({ before, after, label, clean: false });
    while (state.history.length > PIXEL_HISTORY) {
      state.history.shift();
    }
    state.index = state.history.length - 1;
  }

  /** Write one side of one touched pixel back. */
  function restorePixel(pixel, x, y) {
    const image = state.image;
    if (image === null) {
      return;
    }
    setPixelAt(image, x, y, [pixel.r, pixel.g, pixel.b, pixel.a]);
  }

  function cardUndo() {
    if (state.image === null || state.index < 0) {
      return false;
    }
    const step = state.history[state.index];
    for (const pixel of step.before) {
      restorePixel(pixel, pixel.x, pixel.y);
    }
    state.index -= 1;
    paintCanvas();
    updateStatus(`undid: the ${step.label}`);
    return true;
  }

  function cardRedo() {
    if (state.image === null || state.index + 1 >= state.history.length) {
      return false;
    }
    const step = state.history[state.index + 1];
    for (const pixel of step.after) {
      restorePixel(pixel, pixel.x, pixel.y);
    }
    state.index += 1;
    paintCanvas();
    updateStatus(`redid: the ${step.label}`);
    return true;
  }

  /* -- gestures ------------------------------------------------------- */

  function pixelTarget() {
    return state.tool === "eraser" ? [0, 0, 0, 0] : (pixelColourOf(state.colour) || [0, 0, 0, 0]);
  }

  function pixelLabel() {
    if (state.tool === "eraser") return "eraser stroke";
    if (state.tool === "fill") return "fill";
    if (state.tool === "eyedropper") return "eyedropper";
    return "pencil stroke";
  }

  /**
   * One pixel, recorded into the pending step.  `fill` says the caller already
   * knew the pixel's colour from `pixelAt`, so the read after the write is
   * skipped -- a flood fill over a transparent region would otherwise do one
   * `pixelAt` per pixel for an answer it already had.
   */
  function stamp(x, y, rgba, known) {
    const image = state.image;
    if (image === null || state.pending === null) {
      return;
    }
    const before = known === undefined ? pixelAt(image, x, y) : known;
    if (before === null) {
      return;
    }
    if (before[0] === rgba[0] && before[1] === rgba[1] && before[2] === rgba[2] && before[3] === rgba[3]) {
      return;
    }
    setPixelAt(image, x, y, rgba);
    const after = [rgba[0], rgba[1], rgba[2], rgba[3]];
    state.pending.touched.set(y * image.width + x, { x, y, before, after });
    state.pending.count += 1;
  }

  /**
   * Walk the line between two pixels.  A pointer move can jump many pixels, so
   * a stamp per event leaves gaps; Bresenham is what makes a fast drag a line.
   */
  function strokeLine(x0, y0, x1, y1) {
    const rgba = pixelTarget();
    let x = x0;
    let y = y0;
    const dx = Math.abs(x1 - x0);
    const dy = -Math.abs(y1 - y0);
    const sx = x0 < x1 ? 1 : -1;
    const sy = y0 < y1 ? 1 : -1;
    let err = dx + dy;
    let guard = 0;
    const limit = dx - dy + 2;
    for (;;) {
      stamp(x, y, rgba);
      if ((x === x1 && y === y1) || guard > limit) {
        return;
      }
      const twice = 2 * err;
      if (twice >= dy) {
        err += dy;
        x += sx;
      }
      if (twice <= dx) {
        err += dx;
        y += sy;
      }
      guard += 1;
    }
  }

  /** 4-way flood fill of the same-coloured region under the pointer. */
  function floodFill(x, y) {
    const image = state.image;
    if (image === null) {
      return;
    }
    const seed = pixelAt(image, x, y);
    const rgba = pixelTarget();
    if (seed === null
      || (seed[0] === rgba[0] && seed[1] === rgba[1] && seed[2] === rgba[2] && seed[3] === rgba[3])) {
      return;
    }
    const queued = new Set();
    const queue = [[x, y]];
    queued.add(y * image.width + x);
    while (queue.length > 0) {
      const [cx, cy] = queue.pop();
      const here = pixelAt(image, cx, cy);
      if (here === null
        || here[0] !== seed[0] || here[1] !== seed[1] || here[2] !== seed[2] || here[3] !== seed[3]) {
        continue;
      }
      stamp(cx, cy, rgba, here);
      for (const [nx, ny] of [[cx + 1, cy], [cx - 1, cy], [cx, cy + 1], [cx, cy - 1]]) {
        if (nx < 0 || ny < 0 || nx >= image.width || ny >= image.height) {
          continue;
        }
        const key = ny * image.width + nx;
        if (queued.has(key)) {
          continue;
        }
        queued.add(key);
        queue.push([nx, ny]);
      }
    }
  }

  /** The pointer's position in image pixels, from any event with clientX/Y. */
  function imagePoint(event) {
    const rect = typeof canvas.getBoundingClientRect === "function"
      ? canvas.getBoundingClientRect()
      : { left: 0, top: 0 };
    // The origin is drawn rounded (`paintCanvas`), so it is read rounded here:
    // a click at an edge must paint the pixel that is under the cursor on
    // screen, not the one half a pixel to its left.
    return {
      x: Math.floor(((event.clientX || 0) - (rect.left || 0) - Math.round(state.panX)) / state.zoom),
      y: Math.floor(((event.clientY || 0) - (rect.top || 0) - Math.round(state.panY)) / state.zoom),
    };
  }

  function stampAt(event) {
    const at = imagePoint(event);
    if (state.tool === "fill") {
      floodFill(at.x, at.y);
    } else {
      strokeLine(at.x, at.y, at.x, at.y);
    }
  }

  function readPixel(event) {
    const image = state.image;
    if (image === null) {
      return;
    }
    const at = imagePoint(event);
    const rgba = pixelAt(image, at.x, at.y);
    if (rgba === null) {
      return;
    }
    state.pointer = rgba;
    if (state.tool === "eyedropper") {
      state.colour = pixelInkOf(rgba);
      paintTools();
      paintSwatches();
    }
    updateStatus();
  }

  function panBy(dx, dy) {
    if (dx === 0 && dy === 0) {
      return;
    }
    state.panX += dx;
    state.panY += dy;
    // A drag is the person taking the framing: from here on no repaint, and no
    // `shown()` when the tab comes back, re-centres the image under them.
    state.panTouched = true;
    paintCanvas();
  }

  function startStroke(event) {
    const image = state.image;
    if (image === null) {
      ignoredWhileLoading += 1;
      report("no image loaded", "warn");
      return false;
    }
    if (state.tool === "eyedropper") {
      readPixel(event);
      return false;
    }
    state.pending = { touched: new Map(), count: 0, label: pixelLabel() };
    const at = imagePoint(event);
    stampAt(event);
    /*
     * Remember the down point.  Without it the first `pointermove` of a fast
     * drag would find `state.last` empty and stamp one pixel there instead of
     * drawing the line the drag actually covered.
     */
    state.last = state.tool === "fill" ? null : at;
    paintCanvas();
    return true;
  }

  function endStroke() {
    // Whatever ended the gesture, the window no longer needs to hear about it:
    // the listeners exist for exactly the length of one gesture.
    unbindGestureEnd();
    const pending = state.pending;
    state.pending = null;
    if (pending === null || pending.count === 0) {
      return;
    }
    // Only the pixels the gesture touched travel into the ring: an undo of one
    // pixel on a 96x96 sprite must not carry 36 KB of untouched pixels with it.
    // The two sides are separate copies -- a step that carried the same array
    // for both would restore the colour it was meant to take back.
    const touched = [...pending.touched.values()];
    const side = (pixel, key) => {
      const rgba = pixel[key];
      return { x: pixel.x, y: pixel.y, r: rgba[0], g: rgba[1], b: rgba[2], a: rgba[3] };
    };
    pushStep(touched.map((pixel) => side(pixel, "before")),
      touched.map((pixel) => side(pixel, "after")), pending.label);
    writeToBoard();
    updateStatus();
  }

  /*
   * A gesture that ends off the card still has to end.  The surface's own
   * `pointerup` never fires when the pointer is released over the toolbar, the
   * desk or another card, and an uncommitted stroke would leave the pixels
   * changed with nothing on the undo ring -- and the next gesture would carry
   * on from the old endpoint.  So the window is listened to for exactly as long
   * as a gesture is live: bound by the `pointerdown` that starts one, released
   * by `endStroke`, and the surface's own pointerup takes the same path.
   */
  function finishGesture() {
    if (state.panning !== undefined && state.panning !== null) {
      state.panning = null;
      canvas.classList.remove("is-panning");
      endStroke();
      return;
    }
    state.drawing = false;
    state.last = null;
    endStroke();
  }

  function bindGestureEnd() {
    if (gestureBound || typeof window === "undefined" || window === null
      || typeof window.addEventListener !== "function") {
      return;
    }
    gestureBound = true;
    window.addEventListener("pointerup", finishGesture);
    window.addEventListener("pointercancel", finishGesture);
  }

  function unbindGestureEnd() {
    if (!gestureBound) {
      return;
    }
    gestureBound = false;
    if (typeof window !== "undefined" && window !== null && typeof window.removeEventListener === "function") {
      window.removeEventListener("pointerup", finishGesture);
      window.removeEventListener("pointercancel", finishGesture);
    }
  }

  canvas.addEventListener("pointerdown", (event) => {
    if (event.button === 1 || (event.button === 0 && state.tool === "hand")) {
      state.panning = { x: event.clientX, y: event.clientY };
      canvas.classList.add("is-panning");
      bindGestureEnd();
      event.preventDefault();
      return;
    }
    if (event.button !== 0) {
      return;
    }
    if (startStroke(event)) {
      state.drawing = true;
      bindGestureEnd();
    }
    event.preventDefault();
  });

  surface.addEventListener("pointermove", (event) => {
    readPixel(event);
    if (state.panning !== undefined && state.panning !== null) {
      panBy(event.clientX - state.panning.x, event.clientY - state.panning.y);
      state.panning = { x: event.clientX, y: event.clientY };
      return;
    }
    if (!state.drawing) {
      return;
    }
    const image = state.image;
    if (image === null) {
      return;
    }
    const at = imagePoint(event);
    if (state.last !== undefined && state.last !== null) {
      strokeLine(state.last.x, state.last.y, at.x, at.y);
    } else {
      stampAt(event);
    }
    state.last = at;
    paintCanvas();
  });

  surface.addEventListener("pointerup", () => finishGesture());

  surface.addEventListener("pointerleave", () => {
    state.pointer = null;
    updateStatus();
  });

  canvas.addEventListener("wheel", (event) => {
    event.preventDefault();
    const rect = typeof canvas.getBoundingClientRect === "function"
      ? canvas.getBoundingClientRect()
      : { left: 0, top: 0 };
    /*
     * Anchor the wheel on the pixel under the cursor, not on the middle of the
     * canvas: at 8x a picture can sit in one corner, and zooming from the centre
     * throws it out of view.  The pointer's canvas coordinates are the anchor,
     * and the zoom counts as the person's own framing from here on.
     */
    setZoom(state.zoom * (event.deltaY < 0 ? 2 : 0.5), {
      x: (event.clientX || 0) - (rect.left || 0),
      y: (event.clientY || 0) - (rect.top || 0),
    }, true);
  });

  /* The canvas keeps its own history keystrokes: without this, Ctrl+Z over a
     drawing would move the *board* under it, because the pixels are
     deliberately not in the board's ring. */
  canvas.addEventListener("keydown", (event) => {
    /* The tool letters the button hints promise (B, E, G, I, H). */
    if (!event.ctrlKey && !event.metaKey && !event.altKey && PIXEL_TOOL_KEYS[String(event.key).toLowerCase()] !== undefined) {
      selectTool(PIXEL_TOOL_KEYS[String(event.key).toLowerCase()]);
      event.stopPropagation();
      event.preventDefault();
      return;
    }
    if (!(event.ctrlKey || event.metaKey) || event.key.toLowerCase() !== "z") {
      return;
    }
    event.stopPropagation();
    event.preventDefault();
    if (event.shiftKey) {
      if (!cardRedo()) {
        report("nothing to redo");
      }
      return;
    }
    if (!cardUndo()) {
      report("nothing to undo");
    }
  });

  canvas.addEventListener("contextmenu", (event) => event.preventDefault());

  /**
   * Set the zoom, anchored on `anchor` in canvas CSS pixels.  The default
   * anchor is the image's centre, so the +/- buttons keep the picture where it
   * was in the viewport; the wheel passes the cursor point instead, so the
   * pixel under the pointer stays under the pointer.
   *
   * `userFramed` marks the zoom as the person's own framing: until they zoom or
   * pan, an un-panned image is re-centred whenever the surface is measured.
   */
  function setZoom(wanted, anchor = null, userFramed = false) {
    const next = Math.max(PIXEL_ZOOM_MIN, Math.min(PIXEL_ZOOM_MAX, Math.floor(Number(wanted) || PIXEL_ZOOM_MIN)));
    if (next === state.zoom) {
      return;
    }
    const rect = typeof canvas.getBoundingClientRect === "function"
      ? canvas.getBoundingClientRect()
      : { width: 0, height: 0, left: 0, top: 0 };
    let at = anchor;
    if (at === null) {
      at = state.image === null
        ? { x: (rect.width || 0) / 2, y: (rect.height || 0) / 2 }
        : {
          x: state.panX + state.image.width * state.zoom / 2,
          y: state.panY + state.image.height * state.zoom / 2,
        };
    }
    const framed = zoomAt(state.panX, state.panY, state.zoom, next, at.x, at.y);
    state.zoom = next;
    state.panX = Math.round(framed.panX);
    state.panY = Math.round(framed.panY);
    if (userFramed) {
      state.panTouched = true;
    }
    paintCanvas();
    updateLabel();
    updateStatus();
  }

  /* -- load, new, save ------------------------------------------------ */

  /** A kernel `NOT_FOUND` (1002) is not a failure: it is a file not written yet. */
  function isMissingFile(err) {
    const parts = [err && err.code, err && err.symbol, err && err.errorName, err && err.name];
    if (err && err.data && typeof err.data === "object") {
      parts.push(err.data.code, err.data.name);
    }
    return parts.some((part) => part === 1002 || String(part ?? "").includes("NOT_FOUND"));
  }

  function adoptBlank(width, height, origin) {
    state.image = blankImage(width, height, [0, 0, 0, 0]);
    state.origin = origin;
    state.baseRevision = null;
    // A new image is a new framing: the next paint centres it again, even if
    // the person had panned the picture that was there before.
    state.panTouched = false;
    resetHistory();
  }

  function newImage() {
    const width = Math.max(1, Math.min(4096, Math.floor(Number(widthInput.value) || PIXEL_NEW_SIZE)));
    const height = Math.max(1, Math.min(4096, Math.floor(Number(heightInput.value) || PIXEL_NEW_SIZE)));
    adoptBlank(width, height, "new");
    writeToBoard();
    report(`new image, ${width}×${height} — save to write it`);
    paint();
  }

  /**
   * Read the PNG.  A file that is not there yet is a new image; a file that is
   * there but cannot be decoded is a refusal: `state.readError` makes `save`
   * decline, so a card that cannot read a PNG never writes over it.
   */
  async function load(path) {
    if (state.busy) {
      return false;
    }
    state.busy = true;
    const wanted = typeof path === "string" && path.trim() !== "" ? path.trim().replace(/\\/g, "/") : state.file;
    state.file = wanted;
    state.readError = null;
    renderStatus("reading…");
    try {
      const result = await client.call("file.read_bytes", { path: wanted });
      state.baseRevision = result.revision === undefined ? null : result.revision;
      let bytes;
      try {
        const binary = atob(String(result.base64 || ""));
        bytes = new Uint8Array(binary.length);
        for (let i = 0; i < binary.length; i += 1) {
          bytes[i] = binary.charCodeAt(i);
        }
      } catch (err) {
        bytes = null;
        state.readError = `base64: ${err.message}`;
      }
      if (bytes !== null) {
        try {
          state.image = decodePng(bytes);
          state.origin = "file";
          // A loaded image is framed afresh: the first paint centres it.
          state.panTouched = false;
          resetHistory();
          writeToBoard();
          paint();
          report(`loaded ${state.image.width}×${state.image.height} — ${bytes.length} bytes${ignoredNote()}`);
          state.busy = false;
          return true;
        } catch (err) {
          state.readError = err.message;
        }
      }
    } catch (err) {
      if (!isMissingFile(err)) {
        state.image = null;
        report(`could not read ${wanted}: ${err.message}`, "error");
        paint();
        state.busy = false;
        return false;
      }
      // No file yet.  The declared size is what the person typed, or the size
      // the caller asked for; nothing is written until they press save.
      const width = Math.max(1, Math.min(4096, Math.floor(Number(widthInput.value) || Number(card.width) || PIXEL_NEW_SIZE)));
      const height = Math.max(1, Math.min(4096, Math.floor(Number(heightInput.value) || Number(card.height) || PIXEL_NEW_SIZE)));
      adoptBlank(width, height, "new");
      writeToBoard();
      paint();
      report(`new image, ${width}×${height} — save to write it${ignoredNote()}`, "warn");
      state.busy = false;
      return true;
    }
    // The bytes arrived but they are not a PNG this reader understands.
    const width = Math.max(1, Math.min(4096, Math.floor(Number(card.width) || PIXEL_NEW_SIZE)));
    const height = Math.max(1, Math.min(4096, Math.floor(Number(card.height) || PIXEL_NEW_SIZE)));
    adoptBlank(width, height, "unreadable");
    paint();
    report(`${wanted}: ${state.readError} — not saving over it${ignoredNote()}`, "error");
    state.busy = false;
    return false;
  }

  /** `Uint8Array` to base64, without `Buffer`: this page has `btoa`. */
  function base64Of(bytes) {
    let binary = "";
    const step = 0x8000;
    for (let i = 0; i < bytes.length; i += step) {
      binary += String.fromCharCode.apply(null, bytes.subarray(i, i + step));
    }
    return btoa(binary);
  }

  async function save() {
    if (state.image === null) {
      report("nothing to save", "warn");
      return false;
    }
    if (state.file === "") {
      report("no file to write — open one with `pixel <path.png>`", "warn");
      return false;
    }
    if (state.readError !== null) {
      report(`not saving: the file did not decode (${state.readError})`, "error");
      return false;
    }
    if (state.saving) {
      return false;
    }
    state.saving = true;
    const note = `${state.image.width}×${state.image.height}`;
    renderStatus("saving…");
    const base64 = base64Of(encodePng(state.image));
    const params = { path: state.file, base64 };
    if (state.baseRevision !== null) {
      params.base_revision = state.baseRevision;
    }
    try {
      const result = await client.call("file.write_bytes", params);
      state.baseRevision = result.revision === undefined ? state.baseRevision : result.revision;
      state.origin = "file";
      markClean();
      report(`saved ${note} — revision ${state.baseRevision}`,
        state.baseRevision === null ? "warn" : "info");
      return true;
    } catch (err) {
      if (client.isStaleRevision(err)) {
        // The file moved under us.  `resolveStale` is the app's own question,
        // so the answer is the same one an editor card gets; the one thing this
        // must never do is write anyway.
        const current = err.data === null || err.data === undefined
          ? null
          : (typeof err.data === "object" ? err.data.current_revision : err.data);
        const choice = app.resolveStale
          ? await app.resolveStale({ path: state.file, current, cardId: card.id })
          : "cancel";
        state.saving = false;
        if (choice === "overwrite") {
          state.baseRevision = typeof current === "number" ? current : null;
          return save();
        }
        if (choice === "reload") {
          await load(state.file);
          return false;
        }
        report(`${state.file} changed on disk; nothing was written`, "warn");
        return false;
      }
      report(`save failed: ${err.message}`, "error");
      return false;
    } finally {
      state.saving = false;
    }
  }

  /* -- go ------------------------------------------------------------- */

  // A caller can hand the declared size in through the card fields, which is
  // how the D006 row opens a missing sprite at a usable size.
  widthInput.value = String(Math.max(1, Math.floor(Number(card.width) || PIXEL_NEW_SIZE)));
  heightInput.value = String(Math.max(1, Math.floor(Number(card.height) || PIXEL_NEW_SIZE)));
  paintTools();
  paintSwatches();
  paint();

  const startPath = state.file !== ""
    ? state.file
    : (typeof card.file === "string" ? card.file : "");
  if (startPath !== "") {
    load(startPath);
  } else {
    adoptBlank(
      Math.max(1, Math.floor(Number(card.width) || PIXEL_NEW_SIZE)),
      Math.max(1, Math.floor(Number(card.height) || PIXEL_NEW_SIZE)),
      "new",
    );
    writeToBoard();
    paint();
    renderStatus("no file yet — open one with `pixel <path.png>`, or save this one");
  }

  /*
   * The first paint above runs while the card is still being assembled, so the
   * surface can measure a detached 0x0 rect and the bitmap would stay 1x1.  A
   * repaint is scheduled for the next frame, which helps when the card is
   * already laid out by then.  It is not enough on its own: a card created
   * behind another card is still hidden on that frame and measures 0x0 again,
   * so nothing re-measures when it finally comes to the front -- that is the
   * app's `handle.shown()` call on the tab/selection path.
   */
  if (typeof requestAnimationFrame === "function") {
    requestAnimationFrame(() => paint());
  }

  return {
    el: shell.el,
    handle: {
      kind: "pixel",
      // The app asks the focused card to take the step first; `true` means the
      // board's own undo ring must not move as well.
      undo: cardUndo,
      redo: cardRedo,
      save,
      load,
      newImage,
      // Re-measures the surface and repaints once an image is loaded: call it
      // when this card comes to the front (tab switch, selection, focus), when
      // the layout finally exists.  Returns false while there is no image.
      shown,
      canUndo() {
        return state.index >= 0;
      },
      canRedo() {
        return state.index + 1 < state.history.length;
      },
      /** How many gestures are on the card's own ring. */
      steps() {
        return state.history.length;
      },
      /** The pixels, for a caller or a test: `{width, height, pixels}`. */
      image() {
        return state.image;
      },
      /** The PNG a save would write, as bytes. */
      bytes() {
        return state.image === null ? null : encodePng(state.image);
      },
      get path() {
        return state.file;
      },
      get revision() {
        return state.baseRevision;
      },
      get dirty() {
        return !atClean() && state.index >= 0;
      },
      get readError() {
        return state.readError;
      },
      hasPath(path) {
        return state.file !== "" && state.file === path;
      },
      /**
       * Adopt the PNG as it is on disk now, discarding the drawing.
       *
       * Only a clean card is ever asked (`watch.mjs` warns instead whenever
       * `dirty` is set); the guard is for the race, not the normal path.
       */
      reload() {
        if (!atClean() && state.index >= 0) {
          return Promise.resolve(false);
        }
        return load(state.file);
      },
      /** The file is gone from disk: say so. The drawing stays until saved back. */
      onFileGone() {
        report("gone from disk — save writes it back", "warn");
      },
      /** External change: report it, never reload over unsaved strokes. */
      onFileChanged(revision) {
        if (revision !== null && revision === state.baseRevision) {
          return;
        }
        report(`changed on disk (rev ${revision}) — save overwrites`, "warn");
      },
      focus() {
        canvas.focus();
      },
    },
    destroy() {
      // Every listener lives on an element inside this card, so removing the
      // element removes them; the only things that outlive it are the pending
      // stroke and the window's gesture-end listener, and neither is worth
      // anything without the image.
      state.drawing = false;
      state.panning = null;
      state.pending = null;
      unbindGestureEnd();
    },
  };
}

/* ------------------------------------------------------------------ */
/* the rig card                                                       */
/* ------------------------------------------------------------------ */

/*
 * A Spine export is three files that never name each other in full:
 * `Rig.skel.bytes` (the skeleton), `Rig.atlas.txt` (where each region sits on
 * the page) and `Rig.png` (the page itself).  `spine.mjs` reads the first two,
 * `spinepose.mjs` poses the bones at a time, `spineframe.mjs` turns that pose
 * into page rectangles, and this renderer caches one bitmap per region and
 * blits it through its quad.
 *
 * It is a viewer, and it says what it does not show: mesh, path, point and
 * clipping attachments are counted in the status line instead of being drawn,
 * and a region the atlas does not carry is named, not skipped silently.
 * Nothing on this card writes a file.
 *
 * The card's document state is `{file, animation, skin, bones}`.  The pose time
 * is deliberately not saved: it changes thirty times a second while playing.
 */
