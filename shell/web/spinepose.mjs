/*
 * spinepose.mjs -- the arithmetic a Spine skeleton needs before it can be drawn
 * or edited, kept separate from the file format and from the DOM.
 *
 * Nothing here reads a file, touches the page, or knows what a card is.  It
 * takes the model `spine.mjs` parses out of a `.skel.bytes` file and answers a
 * single question: at time `t` of animation `a`, where is every bone and what
 * corners does every region attachment have on screen?
 *
 * The transform order is Spine's, not ours.  A bone's local transform is
 *
 *     T(x, y) * R(rotation) * S(scaleX, scaleY)  with a shear applied to the
 *     x axis' y component before the rotation
 *
 * and a child's world transform is its parent's world transform multiplied by
 * its local one.  Getting that order wrong is not a small error: it puts every
 * limb in the wrong place, which is why the tests for this module compare
 * whole corner lists rather than a single number.
 *
 * The model shape is the one `spine.mjs` promises:
 *
 *   { bones:   [{ name, parentIndex, rotation, x, y, scaleX, scaleY,
 *                 shearX, shearY, length, transformMode }],
 *     slots:   [{ name, boneIndex, color, darkColor, attachmentName, blendMode }],
 *     skins:   [{ name, attachments: [{ slotIndex, name, type, path, ... }] }],
 *     animations: [{ name, duration, timelines: [ ... ] }] }
 *
 * A timeline is one of (types not listed here are ignored on purpose, so a
 * newer exporter does not stop the viewer):
 *
 *   { type: "rotate",    boneIndex, frames: [{ time, angle, curve }] }
 *   { type: "translate", boneIndex, frames: [{ time, x, y, curve }] }
 *   { type: "scale",     boneIndex, frames: [{ time, x, y, curve }] }
 *   { type: "shear",     boneIndex, frames: [{ time, x, y, curve }] }
 *   { type: "color",     slotIndex, frames: [{ time, color, curve }] }
 *   { type: "attachment",slotIndex, frames: [{ time, name }] }
 *   { type: "drawOrder", frames: [{ time, offsets: [{ slotIndex, offset }] }] }
 *
 * `curve` is null for linear, `{ stepped: true }` for stepped, or
 * `{ cx1, cy1, cx2, cy2 }` for a bezier whose control points are in normalised
 * (time, value) space.  A frame holds the value *entering* the next frame, which
 * is how Spine's own binary layout stores them.
 */

/** Numbers a rig can hand us that must not poison the arithmetic. */
function finite(value, fallback) {
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

/**
 * The value of a bezier curve at normalised time `t` (0..1) on the x axis.
 *
 * Spine stores four control-point coordinates and the timeline is read by
 * asking "for this x, what is y".  A cubic bezier's x is not t, so this solves
 * x(t) = target with a few Newton steps and falls back to bisection when the
 * derivative vanishes at the edges (the common "flat start" curve does exactly
 * that at x = 0).
 */
export function bezierValue(curve, t) {
  const x1 = finite(curve.cx1, 0);
  const y1 = finite(curve.cy1, 0);
  const x2 = finite(curve.cx2, 1);
  const y2 = finite(curve.cy2, 1);
  const target = Math.min(Math.max(t, 0), 1);
  if (target <= 0) return 0;
  if (target >= 1) return 1;

  const bezier = (p1, p2, u) => {
    const v = 1 - u;
    return 3 * v * v * u * p1 + 3 * v * u * u * p2 + u * u * u;
  };
  const bezierSlope = (p1, p2, u) => {
    const v = 1 - u;
    return 3 * v * v * p1 + 6 * v * u * (p2 - p1) + 3 * u * u * (1 - p2);
  };

  let u = target;
  for (let i = 0; i < 8; i += 1) {
    const x = bezier(x1, x2, u) - target;
    if (Math.abs(x) < 1e-6) return bezier(y1, y2, u);
    const slope = bezierSlope(x1, x2, u);
    if (Math.abs(slope) < 1e-6) break;
    u -= x / slope;
    if (u < 0 || u > 1) {
      u = Math.min(Math.max(u, 0), 1);
      break;
    }
  }
  // Bisection finishes what Newton could not: monotone x means the root is
  // bracketed by [0, 1] once the first step stayed inside it.
  let low = 0;
  let high = 1;
  for (let i = 0; i < 32; i += 1) {
    u = (low + high) / 2;
    const x = bezier(x1, x2, u);
    if (Math.abs(x - target) < 1e-6) break;
    if (x < target) low = u;
    else high = u;
  }
  return bezier(y1, y2, u);
}

/** The eased fraction between two frames, linear/stepped/bezier alike. */
export function easeFraction(curve, fraction) {
  if (curve === null || curve === undefined) return fraction;
  if (curve.stepped === true) return 0;
  if (typeof curve.cx1 === "number") return bezierValue(curve, fraction);
  return fraction;
}

/**
 * The two frames around `time`, and how far between them we are.
 *
 * Returns null when the timeline has no frames, and clamps to the first and
 * last frame outside the recorded range -- a viewer asked for t = 99s of a 1s
 * animation must still draw something rather than throw.
 */
export function frameWindow(frames, time) {
  if (!Array.isArray(frames) || frames.length === 0) return null;
  const t = finite(time, 0);
  if (t <= frames[0].time) {
    return { from: frames[0], to: null, fraction: 0, curve: null, before: true };
  }
  const last = frames[frames.length - 1];
  if (t >= last.time) {
    return { from: last, to: null, fraction: 0, curve: null, after: true };
  }
  let low = 0;
  let high = frames.length - 1;
  while (high - low > 1) {
    const mid = (low + high) >> 1;
    if (frames[mid].time <= t) low = mid;
    else high = mid;
  }
  const from = frames[low];
  const to = frames[high];
  const span = to.time - from.time;
  const raw = span > 0 ? (t - from.time) / span : 0;
  return { from, to, fraction: raw, curve: from.curve ?? null, before: false, after: false };
}

/** Linear interpolation that survives `from === to`. */
function mix(from, to, fraction) {
  if (to === null || to === undefined) return from;
  return from + (to - from) * fraction;
}

/**
 * One bone's setup pose, before any timeline touches it.
 *
 * The setup pose is the fallback for everything the animation does not animate,
 * which is the majority of the bones in a real rig.
 */
export function boneSetupPose(skeleton, boneIndex) {
  const bone = skeleton.bones[boneIndex];
  return {
    rotation: finite(bone.rotation, 0),
    x: finite(bone.x, 0),
    y: finite(bone.y, 0),
    scaleX: finite(bone.scaleX, 1),
    scaleY: finite(bone.scaleY, 1),
    shearX: finite(bone.shearX, 0),
    shearY: finite(bone.shearY, 0),
  };
}

/** Apply one timeline's value-at-time to the pose it belongs to. */
function applyTimeline(timeline, time, apply) {
  const window = frameWindow(timeline.frames, time);
  if (window === null) return;
  const { from, to, fraction, curve } = window;
  const eased = to === null ? 0 : easeFraction(curve, fraction);
  apply(from, to, eased, window);
}

/**
 * Every bone's world transform at `time` of `animation`, in skeleton order.
 *
 * Returns an array (indexed like `skeleton.bones`) of
 * `{ a, b, c, d, e, f, worldX, worldY, rotation }` where `a..f` is the affine
 * matrix mapping a point in the bone's local space to world space.
 */
export function worldTransforms(skeleton, animation, time) {
  const bones = skeleton.bones;
  const pose = bones.map((_, index) => boneSetupPose(skeleton, index));
  const timelines = animation !== null && animation !== undefined && Array.isArray(animation.timelines)
    ? animation.timelines
    : [];

  for (const timeline of timelines) {
    const index = finite(timeline.boneIndex, -1);
    if (index < 0 || index >= bones.length) continue;
    const target = pose[index];
    switch (timeline.type) {
      case "rotate":
        applyTimeline(timeline, time, (from, to, eased) => {
          target.rotation = mix(finite(from.angle, 0), to === null ? null : finite(to.angle, 0), eased);
        });
        break;
      case "translate":
        applyTimeline(timeline, time, (from, to, eased) => {
          target.x = mix(finite(from.x, 0), to === null ? null : finite(to.x, 0), eased);
          target.y = mix(finite(from.y, 0), to === null ? null : finite(to.y, 0), eased);
        });
        break;
      case "scale":
        applyTimeline(timeline, time, (from, to, eased) => {
          target.scaleX = mix(finite(from.x, 1), to === null ? null : finite(to.x, 1), eased);
          target.scaleY = mix(finite(from.y, 1), to === null ? null : finite(to.y, 1), eased);
        });
        break;
      case "shear":
        applyTimeline(timeline, time, (from, to, eased) => {
          target.shearX = mix(finite(from.x, 0), to === null ? null : finite(to.x, 0), eased);
          target.shearY = mix(finite(from.y, 0), to === null ? null : finite(to.y, 0), eased);
        });
        break;
      default:
        break;
    }
  }

  const out = new Array(bones.length);
  for (let i = 0; i < bones.length; i += 1) {
    out[i] = composeWorld(bones, pose, out, i);
  }
  return out;
}

/**
 * Compose one bone's world matrix from its parent's, filling `out` in place.
 *
 * Recursive only along the parent chain, and a parent index that points at
 * itself (a corrupt file) is treated as "no parent" instead of looping forever.
 */
function composeWorld(bones, pose, out, index) {
  const bone = bones[index];
  const local = pose[index];
  const parentIndex = finite(bone.parentIndex, -1);
  let parent = null;
  if (parentIndex >= 0 && parentIndex < bones.length && parentIndex !== index) {
    parent = out[parentIndex] !== undefined ? out[parentIndex] : composeWorld(bones, pose, out, parentIndex);
  }

  // One rotation for each axis: shearX tilts the x axis, shearY the y axis, and
  // the y axis is the x axis turned a quarter turn.  `a/b` are the image of the
  // x and y basis vectors' x components, `c/d` their y components.
  const rotationX = (finite(local.rotation, 0) + finite(local.shearX, 0)) * (Math.PI / 180);
  const rotationY = (finite(local.rotation, 0) + 90 + finite(local.shearY, 0)) * (Math.PI / 180);
  const cosX = Math.cos(rotationX);
  const sinX = Math.sin(rotationX);
  const cosY = Math.cos(rotationY);
  const sinY = Math.sin(rotationY);
  const scaleX = finite(local.scaleX, 1);
  const scaleY = finite(local.scaleY, 1);

  const a = cosX * scaleX;
  const b = cosY * scaleY;
  const c = sinX * scaleX;
  const d = sinY * scaleY;
  const x = finite(local.x, 0);
  const y = finite(local.y, 0);

  const world = parent === null
    ? { a, b, c, d, e: x, f: y }
    : {
      a: parent.a * a + parent.b * c,
      b: parent.a * b + parent.b * d,
      c: parent.c * a + parent.d * c,
      d: parent.c * b + parent.d * d,
      e: parent.a * x + parent.b * y + parent.e,
      f: parent.c * x + parent.d * y + parent.f,
    };
  world.worldX = world.e;
  world.worldY = world.f;
  world.rotation = Math.atan2(world.b, world.a) * (180 / Math.PI);
  out[index] = world;
  return world;
}

/** Transform a local point through a bone matrix. */
export function applyMatrix(matrix, x, y) {
  return {
    x: matrix.a * x + matrix.b * y + matrix.e,
    y: matrix.c * x + matrix.d * y + matrix.f,
  };
}

/**
 * The four world corners of a region attachment, in the order Spine draws them
 * (bottom-left, bottom-right, top-right, top-left).
 *
 * A region attachment is a rectangle in its slot bone's space; the width and
 * height come from the atlas region, and the offset/rotation/scale are the
 * attachment's own.  Corners are returned rather than drawn so a test can
 * compare them without a canvas.
 */
export function regionCorners(attachment, matrix) {
  const width = finite(attachment.width, 0);
  const height = finite(attachment.height, 0);
  const scaleX = finite(attachment.scaleX, 1);
  const scaleY = finite(attachment.scaleY, 1);
  const rotation = finite(attachment.rotation, 0) * (Math.PI / 180);
  const cos = Math.cos(rotation);
  const sin = Math.sin(rotation);
  const ox = finite(attachment.x, 0);
  const oy = finite(attachment.y, 0);

  // Spine's region corners are centred on the attachment origin, which is what
  // makes `offsets` in the atlas line up with the skeleton's measurements.
  const halfWidth = (width * scaleX) / 2;
  const halfHeight = (height * scaleY) / 2;
  const local = [
    [-halfWidth, -halfHeight],
    [halfWidth, -halfHeight],
    [halfWidth, halfHeight],
    [-halfWidth, halfHeight],
  ];
  return local.map(([lx, ly]) => {
    const rx = lx * cos - ly * sin + ox;
    const ry = lx * sin + ly * cos + oy;
    return applyMatrix(matrix, rx, ry);
  });
}

/**
 * The attachment a slot shows at `time`: the setup-pose attachment unless an
 * `attachment` timeline says otherwise.
 */
export function slotAttachmentName(skeleton, animation, slotIndex, time) {
  const slot = skeleton.slots[slotIndex];
  let name = typeof slot.attachmentName === "string" ? slot.attachmentName : null;
  const timelines = animation !== null && animation !== undefined && Array.isArray(animation.timelines)
    ? animation.timelines
    : [];
  for (const timeline of timelines) {
    if (timeline.type !== "attachment" || finite(timeline.slotIndex, -1) !== slotIndex) continue;
    const window = frameWindow(timeline.frames, time);
    if (window === null) continue;
    const frame = window.from;
    name = typeof frame.name === "string" && frame.name !== "" ? frame.name : null;
  }
  return name;
}

/**
 * The whole picture at `time`: slot corners, in draw order, with the colour
 * each slot has at that moment.
 *
 * Only region attachments are drawn; a mesh attachment is reported with
 * `kind: "mesh"` and no corners rather than silently skipped, so a viewer can
 * say what it is not drawing.
 */
export function sceneAt(skeleton, animation, time, options = {}) {
  const transforms = worldTransforms(skeleton, animation, time);
  const skin = options.skin ?? defaultSkin(skeleton);
  const bySlot = new Map();
  for (const attachment of skin) {
    if (!bySlot.has(attachment.slotIndex)) bySlot.set(attachment.slotIndex, new Map());
    bySlot.get(attachment.slotIndex).set(attachment.name, attachment);
  }

  const items = [];
  for (let slotIndex = 0; slotIndex < skeleton.slots.length; slotIndex += 1) {
    const slot = skeleton.slots[slotIndex];
    const boneIndex = finite(slot.boneIndex, -1);
    const name = slotAttachmentName(skeleton, animation, slotIndex, time);
    if (name === null) continue;
    const attachments = bySlot.get(slotIndex);
    const attachment = attachments === undefined ? undefined : attachments.get(name);
    if (attachment === undefined) continue;
    const matrix = boneIndex >= 0 && boneIndex < transforms.length ? transforms[boneIndex] : null;
    if (matrix === null) continue;
    const color = slotColorAt(skeleton, animation, slotIndex, time, slot.color);
    if (attachment.type === "region") {
      items.push({
        kind: "region",
        slotIndex,
        name,
        path: typeof attachment.path === "string" ? attachment.path : name,
        color,
        corners: regionCorners(attachment, matrix),
      });
    } else {
      items.push({
        kind: typeof attachment.type === "string" ? attachment.type : "unknown",
        slotIndex,
        name,
        path: typeof attachment.path === "string" ? attachment.path : name,
        color,
        corners: [],
      });
    }
  }
  return { items, transforms };
}

/** The default skin's attachments, flattened, or an empty list. */
export function defaultSkin(skeleton) {
  const skins = Array.isArray(skeleton.skins) ? skeleton.skins : [];
  const fallback = skins.find((skin) => skin.name === "default") ?? skins[0];
  return fallback !== undefined && Array.isArray(fallback.attachments) ? fallback.attachments : [];
}

/**
 * Every skin's attachments flattened into one list: the skins the game's rigs
 * are built from are pieces (a body skin, an eyes skin, a mouth skin), so the
 * picture a player sees is a *composition* of skins rather than any single one.
 *
 * The order is the skeleton's skin order and a later skin wins over an earlier
 * one for the same slot and attachment name -- the same precedence `addSkin`
 * has in the runtime.  A slot still draws only the attachment its setup name
 * selects, so merging cannot show two attachments on one slot.
 */
export function mergedSkins(skeleton) {
  const skins = Array.isArray(skeleton.skins) ? skeleton.skins : [];
  const merged = new Map();
  for (const skin of skins) {
    const attachments = skin !== null && typeof skin === "object" && Array.isArray(skin.attachments)
      ? skin.attachments
      : [];
    for (const attachment of attachments) {
      if (attachment === null || typeof attachment !== "object") continue;
      const slotIndex = typeof attachment.slotIndex === "number" ? attachment.slotIndex : -1;
      const name = typeof attachment.name === "string" ? attachment.name : "";
      merged.set(`${slotIndex}\u0000${name}`, attachment);
    }
  }
  return [...merged.values()];
}

/** A slot's colour at `time`, multiplied through any `color` timeline. */
export function slotColorAt(skeleton, animation, slotIndex, time, setupColor) {
  const base = Array.isArray(setupColor) && setupColor.length === 4
    ? setupColor.map((value) => finite(value, 1))
    : [1, 1, 1, 1];
  const timelines = animation !== null && animation !== undefined && Array.isArray(animation.timelines)
    ? animation.timelines
    : [];
  let color = base;
  for (const timeline of timelines) {
    if (timeline.type !== "color" || finite(timeline.slotIndex, -1) !== slotIndex) continue;
    const window = frameWindow(timeline.frames, time);
    if (window === null) continue;
    const from = Array.isArray(window.from.color) ? window.from.color : base;
    const to = window.to !== null && Array.isArray(window.to.color) ? window.to.color : null;
    const eased = to === null ? 0 : easeFraction(window.curve, window.fraction);
    color = [0, 1, 2, 3].map((i) => mix(finite(from[i], 1), to === null ? null : finite(to[i], 1), eased));
  }
  return color;
}
