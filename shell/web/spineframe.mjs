/**
 * spineframe.mjs -- from a posed skeleton to the rectangles a canvas blits.
 *
 * The Spine work is split so that each layer can be checked on its own:
 *
 *   spine.mjs       bytes -> model   (`readSkeletonBinary`, `parseAtlas`)
 *   spinepose.mjs   model + time -> posed bones and region corners
 *   this module     posed regions + atlas -> page rectangles on quads
 *   cards.mjs       the `spine` card: canvas, textures, bones, timeline
 *
 * Everything here is pure: no `document`, no canvas, no Node API.  That is what
 * lets `selftest.mjs` check the atlas arithmetic -- trim offsets, rotation, the
 * corner order -- without a browser, and what keeps the renderer down to
 * "cache a bitmap per region, then blit it through this quad".
 *
 * The triple duty of `offsets` in an atlas is the reason this file exists.  A
 * region may be *trimmed* (its rectangle is smaller than the attachment that
 * refers to it) and/or *rotated* in the page.  The skeleton only knows the
 * untrimmed size, so the mapping from an attachment's quad to the page's
 * rectangle is: interpolate the trimmed box inside the untrimmed quad, then
 * hand the renderer the page rectangle and the four corners in page order.
 *
 * The orientation convention for `rotate` follows the runtime that writes these
 * files: the stored rectangle is the displayed rectangle turned 90 degrees
 * clockwise in the page, so `rotate: 90` means the page image must be turned 90
 * degrees counter-clockwise to be displayed.  The renderer does that when it
 * builds the per-region bitmap; here only the *sizes* depend on it.
 */

/** A fresh point.  Corners are plain objects so a test can compare them. */
function point(x, y) {
  return { x, y };
}

function finite(value, fallback) {
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

function isObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

/**
 * The page a region lives on, by page name (the atlas's image file name, e.g.
 * `Cop.png`).  Returns null when the atlas has no such page.
 */
export function atlasPage(atlas, name) {
  const pages = isObject(atlas) && Array.isArray(atlas.pages) ? atlas.pages : [];
  return pages.find((page) => page.name === name) ?? null;
}

/**
 * One region by name, with the page it belongs to: `{page, region}` or null.
 * Names are the atlas's region names, which for a region attachment are its
 * `path` when it has one and its slot attachment name otherwise.
 */
export function atlasRegion(atlas, name) {
  const pages = isObject(atlas) && Array.isArray(atlas.pages) ? atlas.pages : [];
  for (const page of pages) {
    const region = (Array.isArray(page.regions) ? page.regions : []).find((r) => r.name === name);
    if (region !== undefined) {
      return { page, region };
    }
  }
  return null;
}

/**
 * The displayed size of a region's trimmed rectangle.  A rotated region is
 * stored as its displayed rectangle turned a quarter turn, so width and height
 * swap for 90 and 270.
 */
export function spineCacheSize(region) {
  const rotate = finite(region.rotate, 0) % 360;
  const swapped = rotate === 90 || rotate === 270;
  const width = finite(region.w, 0);
  const height = finite(region.h, 0);
  return swapped ? { width: height, height: width } : { width, height };
}

/**
 * Where the trimmed rectangle sits inside an attachment's untrimmed quad.
 *
 * `corners` is one region's four world corners in Spine's order -- bottom-left,
 * bottom-right, top-right, top-left -- as `spinepose.regionCorners` returns
 * them.  The result is the four world corners of the *trimmed* rectangle, in
 * the order a renderer wants them for an image: top-left, top-right, bottom-left,
 * bottom-right.  `trimmed` is false when no offsets were recorded, which is the
 * common case and makes this the untrimmed quad itself.
 *
 * The atlas offsets are measured from the untrimmed top-left corner, downwards.
 * Interpolating along the quad's own edges (rather than scaling the region's
 * numbers) keeps this correct for a scaled or rotated attachment, where the
 * quad's pixels-per-unit is not 1.
 */
export function spineContentQuad(corners, region) {
  if (!Array.isArray(corners) || corners.length !== 4) {
    return null;
  }
  const [bl, br, tr, tl] = corners;
  const untrimmedWidth = finite(region.origWidth, 0);
  const untrimmedHeight = finite(region.origHeight, 0);
  const hasOffsets = region.hasOffsets === true && untrimmedWidth > 0 && untrimmedHeight > 0;
  const offsetX = hasOffsets ? finite(region.offsetX, 0) : 0;
  const offsetY = hasOffsets ? finite(region.offsetY, 0) : 0;
  const size = spineCacheSize(region);
  const across = untrimmedWidth > 0 ? size.width / untrimmedWidth : 1;
  const down = untrimmedHeight > 0 ? size.height / untrimmedHeight : 1;

  // TL + (TR - TL) * u + (BL - TL) * v, with u across and v downwards, for each
  // of the trimmed rectangle's four corners.  `tl` here is the untrimmed one.
  const lerp = (u, v) => point(
    tl.x + (tr.x - tl.x) * u + (bl.x - tl.x) * v,
    tl.y + (tr.y - tl.y) * u + (bl.y - tl.y) * v,
  );
  const u0 = hasOffsets ? offsetX / untrimmedWidth : 0;
  const v0 = hasOffsets ? offsetY / untrimmedHeight : 0;
  return {
    tl: lerp(u0, v0),
    tr: lerp(u0 + across, v0),
    bl: lerp(u0, v0 + down),
    br: lerp(u0 + across, v0 + down),
    trimmed: hasOffsets,
  };
}

/**
 * The draw list for one posed scene: every region slot resolved against the
 * atlas, in draw order.
 *
 * `scene` is `spinepose.sceneAt(...)`'s result.  Each item keeps the slot it
 * came from so a viewer can select it, the quad to blit, and the atlas
 * rectangle to blit *from*.  A region the atlas does not have is reported in
 * `missing` instead of being drawn wrong; a non-region attachment (mesh, path,
 * bounding box, point) is reported in `unsupported` -- this viewer draws
 * regions, and says so rather than pretending the rig is complete.
 */
export function spineDrawList(scene, atlas) {
  const items = Array.isArray(scene) ? scene : (isObject(scene) && Array.isArray(scene.items) ? scene.items : []);
  const draw = [];
  const missing = [];
  const unsupported = [];
  for (const item of items) {
    if (!isObject(item)) {
      continue;
    }
    const kind = typeof item.kind === "string" ? item.kind : "unknown";
    if (kind !== "region") {
      unsupported.push({ slotIndex: item.slotIndex, name: item.name, kind });
      continue;
    }
    const name = typeof item.path === "string" && item.path !== ""
      ? item.path
      : (typeof item.name === "string" ? item.name : "");
    const found = atlasRegion(atlas, name);
    if (found === null) {
      missing.push({ slotIndex: item.slotIndex, name, kind });
      continue;
    }
    const quad = spineContentQuad(item.corners, found.region);
    if (quad === null) {
      missing.push({ slotIndex: item.slotIndex, name, kind });
      continue;
    }
    draw.push({
      slotIndex: item.slotIndex,
      name: typeof item.name === "string" ? item.name : name,
      colour: Array.isArray(item.color) ? item.color : [1, 1, 1, 1],
      page: found.page.name,
      region: found.region,
      quad,
      size: spineCacheSize(found.region),
    });
  }
  return { items: draw, missing, unsupported };
}

/**
 * The bounds of every corner in a draw list, or null when it is empty.  The
 * card uses this to frame the whole rig the first time it paints.
 */
export function spineDrawBounds(items) {
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const item of Array.isArray(items) ? items : []) {
    if (!isObject(item) || !isObject(item.quad)) {
      continue;
    }
    for (const corner of [item.quad.tl, item.quad.tr, item.quad.bl, item.quad.br]) {
      if (!isObject(corner)) {
        continue;
      }
      minX = Math.min(minX, corner.x);
      minY = Math.min(minY, corner.y);
      maxX = Math.max(maxX, corner.x);
      maxY = Math.max(maxY, corner.y);
    }
  }
  if (minX === Infinity || maxX === -Infinity) {
    return null;
  }
  return { minX, minY, maxX, maxY, width: maxX - minX, height: maxY - minY };
}

/**
 * The bones a viewer can show, drawn from the transforms `worldTransforms`
 * returned: a line per bone from its origin in its parent's space to its tip,
 * which is what makes a rig readable next to its picture.  Pure so the overlay
 * can be checked without a canvas.
 */
export function spineBoneLines(skeleton, transforms) {
  const bones = isObject(skeleton) && Array.isArray(skeleton.bones) ? skeleton.bones : [];
  const lines = [];
  for (let index = 0; index < bones.length; index += 1) {
    const bone = bones[index];
    const transform = Array.isArray(transforms) ? transforms[index] : null;
    if (!isObject(bone) || !isObject(transform)) {
      continue;
    }
    const length = finite(bone.length, 0);
    const angle = (finite(transform.a, 1) === 0 && finite(transform.b, 0) === 0)
      ? 0
      : Math.atan2(transform.b, transform.a);
    const origin = point(finite(transform.e, 0), finite(transform.f, 0));
    const tip = point(
      origin.x + Math.cos(angle) * length,
      origin.y + Math.sin(angle) * length,
    );
    lines.push({
      index,
      name: typeof bone.name === "string" ? bone.name : `bone ${index}`,
      parentIndex: typeof bone.parentIndex === "number" ? bone.parentIndex : null,
      origin,
      tip,
    });
  }
  return lines;
}

/**
 * `{scale, tx, ty}` to fit `bounds` into a `width` x `height` viewport with a
 * `padding` fraction of margin, in the y-up space the skeleton lives in.  The
 * card converts to device coordinates (y-down) when it paints.
 */
export function spineFit(bounds, width, height, padding = 0.08) {
  if (!isObject(bounds) || bounds.width <= 0 || bounds.height <= 0
    || !Number.isFinite(width) || !Number.isFinite(height) || width <= 0 || height <= 0) {
    return { scale: 1, tx: 0, ty: 0 };
  }
  const pad = Math.min(0.45, Math.max(0, finite(padding, 0.08)));
  const usableWidth = width * (1 - pad * 2);
  const usableHeight = height * (1 - pad * 2);
  const scale = Math.min(usableWidth / bounds.width, usableHeight / bounds.height);
  const centreX = (bounds.minX + bounds.maxX) / 2;
  const centreY = (bounds.minY + bounds.maxY) / 2;
  return { scale, tx: centreX, ty: centreY };
}
