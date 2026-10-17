/*
 * spineedit.mjs -- what the spine card edits, kept away from both the file
 * format and the DOM.
 *
 * The card shows a rig; this module is the answer to "and if I move that bone?".
 * An *edit* is a small plain object describing the difference from the file:
 *
 *   { bones:      { "<boneIndex>":  { x?, y?, rotation?, scaleX?, scaleY? } },
 *     slots:      { "<slotIndex>":  "<attachmentName>" | "" },
 *     durations:  { "<animation>":  seconds },
 *     animations: { "<animation>": { bones: { "<boneIndex>": { rotate?, translate?, scale? } },
 *                                    slots: { "<slotIndex>": { attachment? } } } } }
 *
 * A `rotate`/`translate`/`scale` value is a frame list in the shape `spine.mjs`
 * parses (documented at the top of `spinepose.mjs`), so applying an edit is
 * "replace that timeline's frames" and the pose arithmetic in `spinepose.mjs`
 * does the rest -- no second interpolator, and a writer can serialise the result
 * because it is made of the format's own pieces.
 *
 * Frames are whole timelines, never deltas: the first time a bone's rotation is
 * keyed, the file's existing frames are copied in (`framesFor`), so the card's
 * key list is always the truth.  A missing frame list means "the file's".
 *
 * `applyEdits` returns a *new* skeleton; the parsed one is never mutated, so a
 * card can throw its edits away and draw the file again.
 */

/** Two key times closer than this are the same key (a frame is ms-precise). */
export const FRAME_EPSILON = 1e-4;

const BONE_TYPES = ["rotate", "translate", "scale"];

function isObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function cloneValue(value) {
  if (Array.isArray(value)) return value.map(cloneValue);
  if (isObject(value)) {
    const out = {};
    for (const key of Object.keys(value)) out[key] = cloneValue(value[key]);
    return out;
  }
  return value;
}

/** An edit that changes nothing. */
export function emptyEdits() {
  return { bones: {}, slots: {}, durations: {}, animations: {} };
}

/** A deep copy, so a card can keep "before" and "after" side by side. */
export function cloneEdits(edits) {
  return cloneValue(isObject(edits) ? edits : emptyEdits());
}

/** True when anything at all differs from the file. */
export function hasEdits(edits) {
  if (!isObject(edits)) return false;
  return Object.keys(edits.bones || {}).length > 0
    || Object.keys(edits.slots || {}).length > 0
    || Object.keys(edits.durations || {}).length > 0
    || Object.keys(edits.animations || {}).length > 0;
}

/** How many bones, slots and animations the edit touches -- for a status line. */
export function editCounts(edits) {
  const counts = { bones: 0, slots: 0, animations: 0, frames: 0 };
  if (!isObject(edits)) return counts;
  counts.bones = Object.keys(edits.bones || {}).length;
  counts.slots = Object.keys(edits.slots || {}).length;
  const animations = edits.animations || {};
  counts.animations = Object.keys(animations).length;
  for (const name of Object.keys(animations)) {
    const bones = (animations[name] && animations[name].bones) || {};
    for (const index of Object.keys(bones)) {
      for (const type of BONE_TYPES) {
        const frames = bones[index][type];
        if (Array.isArray(frames)) counts.frames += frames.length;
      }
    }
    const slots = (animations[name] && animations[name].slots) || {};
    for (const index of Object.keys(slots)) {
      const frames = slots[index].attachment;
      if (Array.isArray(frames)) counts.frames += frames.length;
    }
  }
  return counts;
}

/** Replace one bone's setup-pose numbers; `undefined` values are dropped. */
export function setBone(edits, boneIndex, patch) {
  const next = cloneEdits(edits);
  const key = String(boneIndex);
  const bone = isObject(next.bones[key]) ? next.bones[key] : {};
  for (const field of ["x", "y", "rotation", "scaleX", "scaleY"]) {
    if (!Object.prototype.hasOwnProperty.call(patch, field)) continue;
    const value = patch[field];
    if (typeof value === "number" && Number.isFinite(value)) bone[field] = value;
    else delete bone[field];
  }
  if (Object.keys(bone).length === 0) delete next.bones[key];
  else next.bones[key] = bone;
  return next;
}

/** Forget a bone's setup-pose edit (not its keyframes). */
export function clearBone(edits, boneIndex) {
  const next = cloneEdits(edits);
  delete next.bones[String(boneIndex)];
  return next;
}

/** Which attachment a slot shows before any animation touches it; "" hides it. */
export function setAttachment(edits, slotIndex, name) {
  const next = cloneEdits(edits);
  if (typeof name === "string" && name !== "") next.slots[String(slotIndex)] = name;
  else delete next.slots[String(slotIndex)];
  return next;
}

export function clearAttachment(edits, slotIndex) {
  const next = cloneEdits(edits);
  delete next.slots[String(slotIndex)];
  return next;
}

/** A longer animation: the card needs it to key a pose past the file's end. */
export function setDuration(edits, animation, seconds) {
  const next = cloneEdits(edits);
  if (typeof seconds === "number" && Number.isFinite(seconds) && seconds > 0) {
    next.durations[String(animation)] = seconds;
  } else {
    delete next.durations[String(animation)];
  }
  return next;
}

/** The animation object a name refers to, or null. */
export function findAnimation(skeleton, animation) {
  const animations = skeleton !== null && skeleton !== undefined && Array.isArray(skeleton.animations)
    ? skeleton.animations
    : [];
  return animations.find((entry) => entry.name === animation) ?? null;
}

/** The duration the card should show: an edited one wins over the file's. */
export function durationOf(skeleton, animation, edits) {
  const edited = isObject(edits) && isObject(edits.durations) ? edits.durations[String(animation)] : undefined;
  if (typeof edited === "number" && Number.isFinite(edited) && edited > 0) return edited;
  const found = findAnimation(skeleton, animation);
  const value = found !== null ? found.duration : 0;
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

function editedBone(edits, animation, boneIndex, create) {
  const animations = edits.animations || (create ? (edits.animations = {}) : null);
  if (animations === null) return null;
  const name = String(animation);
  if (!isObject(animations[name])) {
    if (!create) return null;
    animations[name] = { bones: {}, slots: {} };
  }
  const bones = animations[name].bones || (create ? (animations[name].bones = {}) : null);
  if (bones === null) return null;
  const key = String(boneIndex);
  if (!isObject(bones[key])) {
    if (!create) return null;
    bones[key] = {};
  }
  return bones[key];
}

function editedSlot(edits, animation, slotIndex, create) {
  const animations = edits.animations || (create ? (edits.animations = {}) : null);
  if (animations === null) return null;
  const name = String(animation);
  if (!isObject(animations[name])) {
    if (!create) return null;
    animations[name] = { bones: {}, slots: {} };
  }
  const slots = animations[name].slots || (create ? (animations[name].slots = {}) : null);
  if (slots === null) return null;
  const key = String(slotIndex);
  if (!isObject(slots[key])) {
    if (!create) return null;
    slots[key] = {};
  }
  return slots[key];
}

/** The timeline `spine.mjs` parsed for one bone and one property, or null. */
function fileTimeline(skeleton, animation, boneIndex, type) {
  const found = findAnimation(skeleton, animation);
  if (found === null || !Array.isArray(found.timelines)) return null;
  return found.timelines.find(
    (timeline) => timeline.type === type && timeline.boneIndex === boneIndex,
  ) ?? null;
}

function fileAttachmentTimeline(skeleton, animation, slotIndex) {
  const found = findAnimation(skeleton, animation);
  if (found === null || !Array.isArray(found.timelines)) return null;
  return found.timelines.find(
    (timeline) => timeline.type === "attachment" && timeline.slotIndex === slotIndex,
  ) ?? null;
}

/**
 * The frames the card should show for a bone property: the edit's, or a copy of
 * the file's (which is then seeded into the edit, so the next `setFrame` edits a
 * whole timeline rather than a stray key).
 */
export function framesFor(edits, skeleton, animation, boneIndex, type) {
  const bone = editedBone(edits, animation, boneIndex, false);
  const edited = bone !== null && Array.isArray(bone[type]) ? bone[type] : null;
  if (edited !== null) return cloneValue(edited);
  const timeline = fileTimeline(skeleton, animation, boneIndex, type);
  return timeline !== null && Array.isArray(timeline.frames) ? cloneValue(timeline.frames) : [];
}

/** Same question for a slot's attachment timeline. */
export function attachmentFramesFor(edits, skeleton, animation, slotIndex) {
  const slot = editedSlot(edits, animation, slotIndex, false);
  const edited = slot !== null && Array.isArray(slot.attachment) ? slot.attachment : null;
  if (edited !== null) return cloneValue(edited);
  const timeline = fileAttachmentTimeline(skeleton, animation, slotIndex);
  return timeline !== null && Array.isArray(timeline.frames) ? cloneValue(timeline.frames) : [];
}

/** A frame's time clamped into the animation (a key past the end never plays). */
function clampTime(skeleton, animation, edits, time) {
  const value = typeof time === "number" && Number.isFinite(time) ? time : 0;
  const duration = durationOf(skeleton, animation, edits);
  return Math.min(Math.max(value, 0), duration);
}

function putFrame(frames, frame) {
  const out = [];
  for (const existing of frames) {
    if (Math.abs(existing.time - frame.time) < FRAME_EPSILON) continue;
    out.push(cloneValue(existing));
  }
  out.push(cloneValue(frame));
  out.sort((a, b) => a.time - b.time);
  return out;
}

function dropFrame(frames, time) {
  return frames
    .filter((frame) => Math.abs(frame.time - time) >= FRAME_EPSILON)
    .map(cloneValue);
}

/**
 * Key one bone property at `time`.
 *
 * `value` is `{ angle }` for rotate, `{ x, y }` for translate and scale.  The
 * new frame is linear; the frame before it keeps whatever curve it had, because
 * that curve is stored on the frame the segment starts from.
 */
export function setFrame(edits, skeleton, options) {
  const { animation, boneIndex, type } = options;
  if (!BONE_TYPES.includes(type)) throw new Error(`spineedit: unknown bone timeline ${type}`);
  const next = cloneEdits(edits);
  const time = clampTime(skeleton, animation, next, options.time);
  const frames = putFrame(framesFor(next, skeleton, animation, boneIndex, type), {
    time,
    ...cloneValue(isObject(options.value) ? options.value : {}),
    curve: options.curve ?? null,
  });
  const bone = editedBone(next, animation, boneIndex, true);
  bone[type] = frames;
  return next;
}

/** Remove the frame at `time`; the rest of the timeline is untouched. */
export function removeFrame(edits, skeleton, options) {
  const { animation, boneIndex, type } = options;
  if (!BONE_TYPES.includes(type)) throw new Error(`spineedit: unknown bone timeline ${type}`);
  const next = cloneEdits(edits);
  const frames = dropFrame(framesFor(next, skeleton, animation, boneIndex, type), options.time);
  const bone = editedBone(next, animation, boneIndex, true);
  bone[type] = frames;
  return next;
}

/** Key one slot's attachment at `time`; `name` "" means "nothing here". */
export function setAttachmentFrame(edits, skeleton, options) {
  const { animation, slotIndex } = options;
  const next = cloneEdits(edits);
  const time = clampTime(skeleton, animation, next, options.time);
  const frames = putFrame(attachmentFramesFor(next, skeleton, animation, slotIndex), {
    time,
    name: typeof options.name === "string" && options.name !== "" ? options.name : null,
  });
  const slot = editedSlot(next, animation, slotIndex, true);
  slot.attachment = frames;
  return next;
}

export function removeAttachmentFrame(edits, skeleton, options) {
  const { animation, slotIndex } = options;
  const next = cloneEdits(edits);
  const frames = dropFrame(
    attachmentFramesFor(next, skeleton, animation, slotIndex),
    options.time,
  );
  const slot = editedSlot(next, animation, slotIndex, true);
  slot.attachment = frames;
  return next;
}

/** The largest key time in an edit -- what an animation's duration must reach. */
function lastKeyTime(edits, animation) {
  const animations = isObject(edits.animations) ? edits.animations : {};
  const entry = animations[String(animation)];
  if (!isObject(entry)) return 0;
  let last = 0;
  for (const index of Object.keys(entry.bones || {})) {
    for (const type of BONE_TYPES) {
      const frames = entry.bones[index][type];
      if (!Array.isArray(frames)) continue;
      for (const frame of frames) {
        if (typeof frame.time === "number" && frame.time > last) last = frame.time;
      }
    }
  }
  for (const index of Object.keys(entry.slots || {})) {
    const frames = entry.slots[index].attachment;
    if (!Array.isArray(frames)) continue;
    for (const frame of frames) {
      if (typeof frame.time === "number" && frame.time > last) last = frame.time;
    }
  }
  return last;
}

/**
 * The skeleton the card should draw: the parsed model with the edit applied.
 *
 * Only the arrays the edit touches are cloned -- a rig with 110 bones and 40
 * skins is re-applied on every drag frame, and none of this should be a deep
 * copy of the file.
 */
export function applyEdits(skeleton, edits) {
  if (!hasEdits(edits)) return skeleton;
  const bones = Array.isArray(skeleton.bones) ? skeleton.bones.slice() : [];
  for (const index of Object.keys(edits.bones || {})) {
    const at = Number(index);
    if (!Number.isInteger(at) || at < 0 || at >= bones.length) continue;
    bones[at] = { ...bones[at], ...edits.bones[index] };
  }
  const slots = Array.isArray(skeleton.slots) ? skeleton.slots.slice() : [];
  for (const index of Object.keys(edits.slots || {})) {
    const at = Number(index);
    if (!Number.isInteger(at) || at < 0 || at >= slots.length) continue;
    const name = edits.slots[index];
    slots[at] = { ...slots[at], attachmentName: typeof name === "string" && name !== "" ? name : null };
  }

  const animations = Array.isArray(skeleton.animations) ? skeleton.animations.slice() : [];
  const byName = new Map();
  for (let i = 0; i < animations.length; i += 1) byName.set(animations[i].name, i);
  for (const name of Object.keys(edits.animations || {})) {
    const edit = edits.animations[name];
    if (!isObject(edit)) continue;
    const at = byName.get(name);
    const base = at === undefined
      ? { name, duration: 0, timelines: [] }
      : { ...animations[at], timelines: Array.isArray(animations[at].timelines) ? animations[at].timelines.slice() : [] };
    const timelines = base.timelines;
    for (const index of Object.keys(edit.bones || {})) {
      const boneIndex = Number(index);
      if (!Number.isInteger(boneIndex) || boneIndex < 0) continue;
      for (const type of BONE_TYPES) {
        const frames = edit.bones[index][type];
        if (!Array.isArray(frames)) continue;
        const found = timelines.findIndex(
          (timeline) => timeline.type === type && timeline.boneIndex === boneIndex,
        );
        const timeline = { type, boneIndex, frames: cloneValue(frames) };
        if (found >= 0) timelines[found] = timeline;
        else timelines.push(timeline);
      }
    }
    for (const index of Object.keys(edit.slots || {})) {
      const slotIndex = Number(index);
      if (!Number.isInteger(slotIndex) || slotIndex < 0) continue;
      const frames = edit.slots[index].attachment;
      if (!Array.isArray(frames)) continue;
      const found = timelines.findIndex(
        (timeline) => timeline.type === "attachment" && timeline.slotIndex === slotIndex,
      );
      const timeline = { type: "attachment", slotIndex, frames: cloneValue(frames) };
      if (found >= 0) timelines[found] = timeline;
      else timelines.push(timeline);
    }
    const editedDuration = isObject(edits.durations) ? edits.durations[name] : undefined;
    const duration = typeof editedDuration === "number" && Number.isFinite(editedDuration)
      ? editedDuration
      : base.duration;
    base.duration = Math.max(
      typeof duration === "number" && Number.isFinite(duration) ? duration : 0,
      lastKeyTime(edits, name),
    );
    base.timelines = timelines;
    if (at === undefined) {
      byName.set(name, animations.length);
      animations.push(base);
    } else {
      animations[at] = base;
    }
  }

  return { ...skeleton, bones, slots, animations };
}

/**
 * The attachment names a slot can show, from every skin in the rig: the card's
 * slot picker uses this, because a rig keeps its body, eyes and mouth in
 * different skins and any of them can be put on a slot.
 */
export function attachmentsForSlot(skeleton, slotIndex) {
  const names = [];
  const seen = new Set();
  const skins = Array.isArray(skeleton.skins) ? skeleton.skins : [];
  for (const skin of skins) {
    const attachments = skin !== null && typeof skin === "object" && Array.isArray(skin.attachments)
      ? skin.attachments
      : [];
    for (const attachment of attachments) {
      if (attachment === null || typeof attachment !== "object") continue;
      if (attachment.slotIndex !== slotIndex) continue;
      const name = typeof attachment.name === "string" ? attachment.name : "";
      if (name === "" || seen.has(name)) continue;
      seen.add(name);
      names.push(name);
    }
  }
  return names;
}
