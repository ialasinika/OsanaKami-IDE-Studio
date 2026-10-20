/**
 * pixelview.mjs -- the pixel card's framing arithmetic.
 *
 * The card draws an image inside a surface that may be smaller or larger than
 * it, at a zoom the person chose, and this module is the whole of "where does
 * the image land".  It is pure on purpose: the suite checks the geometry under
 * Node, where there is no canvas, and the card then paints with exactly these
 * numbers.
 *
 * The convention, once:
 *
 *   * Coordinates are canvas CSS pixels -- the units `getBoundingClientRect()`
 *     and a pointer event's `clientX`/`clientY` speak.  They are not device
 *     pixels and not the canvas bitmap's own pixels.
 *   * The image's origin is its top-left corner, and image pixel (ix, iy) is
 *     drawn at (panX + ix * zoom, panY + iy * zoom).  `panX`/`panY` are
 *     therefore the translation of the image origin: where its top-left corner
 *     sits on the canvas.  A 32x32 image at zoom 8 occupies a 256x256 square
 *     starting at (panX, panY).
 *   * `zoom` is canvas pixels per image pixel: 1 draws the image one-to-one,
 *     8 makes every image pixel an 8x8 square.  The card keeps it at 1 or more
 *     (`PIXEL_ZOOM_MIN`), and never at 0.
 *
 * Why this exists at all: two of the browser bugs in `docs/gaps2.md` are not
 * about pixels but about this arithmetic.  A card opened while another tab was
 * in front measured its surface as 0x0 and never re-measured, so the image had
 * nowhere to be drawn (G52); and a zoom that held the *viewport* centre still
 * scrolled a small sprite out of sight (G53).  Keeping the decision in a module
 * with no DOM lets the suite pin it down, and leaves the card to measure and
 * draw.
 *
 * Nothing here imports anything, reads a clock or touches a DOM, so the same
 * numbers are available to the page and to the suite.
 */

/**
 * The pan that puts the whole image in the middle of the view.
 *
 * @param {number} viewW  surface width in canvas CSS pixels
 * @param {number} viewH  surface height in canvas CSS pixels
 * @param {number} imageW image width in image pixels
 * @param {number} imageH image height in image pixels
 * @param {number} zoom   canvas pixels per image pixel
 * @returns {{panX: number, panY: number}} the translation of the image origin
 */
export function centrePan(viewW, viewH, imageW, imageH, zoom) {
  return {
    panX: (viewW - imageW * zoom) / 2,
    panY: (viewH - imageH * zoom) / 2,
  };
}

/**
 * The pan after a zoom that keeps one canvas point over the same image point.
 *
 * The image point under the anchor is `(anchor - pan) / fromZoom`; after the
 * zoom it must sit under the same anchor, so `anchor = newPan + imagePoint *
 * toZoom`.  Solving for `newPan` is the whole function.  The wheel passes the
 * cursor as the anchor (the pixel under the cursor stays under it), the +/-
 * buttons pass the image's centre (the picture grows around itself), and
 * either way the caller decides what "held still" means.
 *
 * @param {number} panX     current image-origin translation
 * @param {number} panY     current image-origin translation
 * @param {number} fromZoom current canvas pixels per image pixel
 * @param {number} toZoom   next canvas pixels per image pixel
 * @param {number} anchorX  the canvas point to keep still
 * @param {number} anchorY  the canvas point to keep still
 * @returns {{panX: number, panY: number}} the translation after the zoom
 */
export function zoomAt(panX, panY, fromZoom, toZoom, anchorX, anchorY) {
  const scale = toZoom / fromZoom;
  return {
    panX: anchorX - (anchorX - panX) * scale,
    panY: anchorY - (anchorY - panY) * scale,
  };
}

/**
 * Is any of the image on the surface at all?  Positive-area overlap, so an
 * image that ends exactly where the viewport starts is not visible -- there is
 * no pixel on screen to draw.
 *
 * A view that measured 0x0 (the card is not laid out, or not in front) sees
 * nothing whatever the pan says, which is the whole point of the check: the
 * ordinary rectangle test would call a centred image "visible" in a zero-width
 * viewport.
 */
export function visible(viewW, viewH, imageW, imageH, zoom, panX, panY) {
  if (!isMeasurable(viewW, viewH, imageW, imageH, zoom)) {
    return false;
  }
  return panX < viewW
    && panY < viewH
    && panX + imageW * zoom > 0
    && panY + imageH * zoom > 0;
}

/**
 * Is the whole image inside the surface?  This is what "a small sprite stays on
 * screen when it is zoomed" means precisely: not merely intersecting the
 * viewport, but with every one of its pixels between the edges.
 */
export function insideView(viewW, viewH, imageW, imageH, zoom, panX, panY) {
  if (!isMeasurable(viewW, viewH, imageW, imageH, zoom)) {
    return false;
  }
  return panX >= 0
    && panY >= 0
    && panX + imageW * zoom <= viewW
    && panY + imageH * zoom <= viewH;
}

/**
 * The framing decision every repaint makes, and the one `handle.shown()` makes
 * when a tab comes forward.
 *
 * A view that measured 0x0 has no opinion: a card opened in the background must
 * not turn that measurement into a pan and then keep it.  A pan -- or a wheel
 * zoom, which is the same kind of decision -- that the person made is theirs,
 * and no later repaint may undo it.  Only an unmeasured, un-panned card is
 * centred, which is what makes opening a card in the background land on the
 * same picture as opening it in front.
 *
 * @param {number}  viewW  surface width in canvas CSS pixels (0 when hidden)
 * @param {number}  viewH  surface height in canvas CSS pixels (0 when hidden)
 * @param {number}  imageW image width in image pixels
 * @param {number}  imageH image height in image pixels
 * @param {number}  zoom   canvas pixels per image pixel
 * @param {number}  panX   the pan to keep when the person owns the framing
 * @param {number}  panY   the pan to keep when the person owns the framing
 * @param {boolean} panned true once the person has panned or wheel-zoomed
 * @returns {{panX: number, panY: number}} the translation to draw with
 */
export function framedPan(viewW, viewH, imageW, imageH, zoom, panX, panY, panned) {
  if (panned || !(viewW > 0) || !(viewH > 0)) {
    return { panX, panY };
  }
  return centrePan(viewW, viewH, imageW, imageH, zoom);
}

/** True when a rectangle of this image at this zoom can be drawn at all. */
function isMeasurable(viewW, viewH, imageW, imageH, zoom) {
  return viewW > 0 && viewH > 0 && imageW > 0 && imageH > 0 && zoom > 0;
}
