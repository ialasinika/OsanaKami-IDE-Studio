// Spine 4.2 binary skeleton writer.
//
// The counterpart of `readSkeletonBinary` in ./spine.mjs: it takes the model that
// reader returns and emits the same bytes the Spine exporter wrote. The reader's
// model is deliberately close to the wire format; the few things it cannot
// recompute are kept as raw fields on the model:
//
//   - attachment.flags        raw flag byte (presence bits: colour, rotation, path,
//                             weighted, ...; a present-but-default value is
//                             indistinguishable from an absent one in the model)
//   - *.nameRef / pathRef /   raw 1-based string-table indices (the table can hold
//     declaredNameRef /        duplicate strings, so the value alone does not say
//     parentRef /              which index the exporter used)
//     attachmentNameRef
//   - animation.timelineCountHint
//   - timeline.bezierCount    (read by the reader and otherwise discarded)
//   - slot/ik/transform/path/physics constraint `flags`/`flags2` raw bytes
//   - physics.stepDivisor     raw divisor byte (step is stored as 1/divisor)
//   - ik timeline frame.flags raw per-frame flag byte
//   - attachment timeline frame.nameRef / frame.modeAndIndex
//   - events timeline frame.stringValueNull
//
// A hand-built model that omits the raw fields still writes: the writer derives a
// canonical value from the decoded fields. That output is valid and re-readable,
// but only a reader-produced model is guaranteed byte-identical to the source.

const ATTACHMENT_TYPE_BYTES = {
  region: 0,
  boundingbox: 1,
  mesh: 2,
  linkedmesh: 3,
  path: 4,
  point: 5,
  clipping: 6,
};

const INHERIT_INDEX = {
  normal: 0,
  onlyTranslation: 1,
  noRotationOrReflection: 2,
  noScale: 3,
  noScaleOrReflection: 4,
};

const BLEND_MODES = ["normal", "additive", "multiply", "screen"];
const POSITION_MODES = ["fixed", "percent"];
const SPACING_MODES = ["length", "fixed", "percent", "proportional"];
const ROTATE_MODES = ["tangent", "chain", "chainScale"];
const SEQUENCE_MODES = ["hold", "once", "loop", "pingpong", "onceReverse", "loopReverse", "pingpongReverse"];

const SLOT_ATTACHMENT = 0;
const SLOT_RGBA = 1;
const SLOT_RGB = 2;
const SLOT_RGBA2 = 3;
const SLOT_RGB2 = 4;
const SLOT_ALPHA = 5;

const BONE_TYPE_BYTES = {
  rotate: 0,
  translate: 1,
  translateX: 2,
  translateY: 3,
  scale: 4,
  scaleX: 5,
  scaleY: 6,
  shear: 7,
  shearX: 8,
  shearY: 9,
  inherit: 10,
};
const BONE_TWO_CHANNEL = new Set(["translate", "translateX", "translateY", "scale", "shear"]);
const BONE_ONE_CHANNEL_FIELD = {
  rotate: "angle",
  scaleX: "scale",
  scaleY: "scale",
  shearX: "shear",
  shearY: "shear",
};

const PATH_TYPE_BYTES = { pathPosition: 0, pathSpacing: 1, pathMix: 2 };

const PHYSICS_TYPE_BYTES = {
  physicsInertia: 0,
  physicsStrength: 1,
  physicsDamping: 2,
  physicsMass: 4,
  physicsWind: 5,
  physicsGravity: 6,
  physicsMix: 7,
  physicsReset: 8,
};

const CURVE_LINEAR = 0;
const CURVE_STEPPED = 1;
const CURVE_BEZIER = 2;

// ---------------------------------------------------------------------------
// Byte writer
// ---------------------------------------------------------------------------

class Writer {
  constructor() {
    this.bytes = new Uint8Array(4096);
    this.length = 0;
    this.view = new DataView(this.bytes.buffer);
  }

  reserve(count) {
    if (this.length + count <= this.bytes.length) return;
    let size = this.bytes.length * 2;
    while (size < this.length + count) size *= 2;
    const next = new Uint8Array(size);
    next.set(this.bytes.subarray(0, this.length));
    this.bytes = next;
    this.view = new DataView(next.buffer);
  }

  u8(value) {
    this.reserve(1);
    this.bytes[this.length++] = value & 0xff;
  }

  bool(value) {
    this.u8(value ? 1 : 0);
  }

  // Fixed 4-byte big-endian signed integer (libGDX DataOutput.writeInt).
  i32(value) {
    this.reserve(4);
    this.view.setInt32(this.length, value | 0, false);
    this.length += 4;
  }

  // Fixed 4-byte big-endian IEEE-754 float.
  f32(value) {
    this.reserve(4);
    this.view.setFloat32(this.length, value, false);
    this.length += 4;
  }

  // Unsigned variable-length integer, 7 data bits per byte, low group first.
  varint(value) {
    let rest = value >>> 0;
    while (rest > 0x7f) {
      this.u8((rest & 0x7f) | 0x80);
      rest >>>= 7;
    }
    this.u8(rest);
  }

  // Zigzag-encoded signed integer (libGDX writeInt(value, false)).
  sint(value) {
    this.varint(((value << 1) ^ (value >> 31)) >>> 0);
  }

  // A length-prefixed UTF-8 string: 0 = null, 1 = "", n = n-1 bytes of UTF-8.
  string(text) {
    if (text === null || text === undefined) {
      this.varint(0);
      return;
    }
    if (text === "") {
      this.varint(1);
      return;
    }
    const encoded = new TextEncoder().encode(text);
    this.varint(encoded.length + 1);
    this.reserve(encoded.length);
    this.bytes.set(encoded, this.length);
    this.length += encoded.length;
  }

  finish() {
    return this.bytes.slice(0, this.length);
  }
}

// ---------------------------------------------------------------------------
// Value helpers
// ---------------------------------------------------------------------------

function toByte(value) {
  const rounded = Math.round(value * 255);
  return rounded < 0 ? 0 : rounded > 255 ? 255 : rounded;
}

// [r, g, b, a] in 0..1 -> uint32 RGBA8888.
function packRgba(color) {
  const c = color || [1, 1, 1, 1];
  return ((toByte(c[0]) << 24) | (toByte(c[1]) << 16) | (toByte(c[2]) << 8) | toByte(c[3])) | 0;
}

// [r, g, b] in 0..1 -> uint32 RGB888; null -> -1 (no dark colour).
function packRgb(color) {
  if (color === null || color === undefined) return -1;
  return ((toByte(color[0]) << 16) | (toByte(color[1]) << 8) | toByte(color[2])) | 0;
}

function isWhiteColor(color) {
  return color !== null && color !== undefined
    && color[0] === 1 && color[1] === 1 && color[2] === 1 && (color[3] === undefined || color[3] === 1);
}

// `preferred` is the raw 1-based index the file used; it is only honoured when it
// really points at the same string, and only because the table may hold duplicates.
function stringIndexOf(skeleton, value, preferred) {
  if (value === null || value === undefined) return 0;
  const strings = skeleton.strings;
  if (preferred > 0 && strings[preferred - 1] === value) return preferred;
  const index = strings.indexOf(value);
  if (index < 0) {
    throw new Error(`writeSkeletonBinary: string ${JSON.stringify(value)} is not in the skeleton's string table`);
  }
  return index + 1;
}

function countBezier(frames) {
  let count = 0;
  for (let i = 0; i < frames.length - 1; i++) {
    const curve = frames[i].curve;
    if (curve !== null && curve !== undefined && !curve.stepped) count++;
  }
  return count;
}

function bezierCountOf(timeline) {
  return timeline.bezierCount !== undefined ? timeline.bezierCount : countBezier(timeline.frames);
}

function writeHash(w, hash) {
  const bytes = new Array(8).fill(0);
  if (typeof hash === "string" && hash.length === 16) {
    for (let i = 0; i < 8; i++) bytes[i] = parseInt(hash.slice(i * 2, i * 2 + 2), 16);
  }
  for (const byte of bytes) w.u8(byte);
}

// ---------------------------------------------------------------------------
// Curves and frame runs
// ---------------------------------------------------------------------------

function writeCurve(w, frame, channelCount) {
  const curve = frame === undefined ? null : frame.curve;
  if (curve === null || curve === undefined) {
    w.u8(CURVE_LINEAR);
    return;
  }
  if (curve.stepped) {
    w.u8(CURVE_STEPPED);
    return;
  }
  w.u8(CURVE_BEZIER);
  const curves = frame.curves || [curve];
  for (let channel = 0; channel < channelCount; channel++) {
    const control = curves[channel] || curves[0];
    w.f32(control.cx1);
    w.f32(control.cy1);
    w.f32(control.cx2);
    w.f32(control.cy2);
  }
}

// A single-channel run: frame 0 values, then each next frame's values followed by
// the previous segment's curve byte.
function writeOneChannelFrames(w, frames, field) {
  if (frames.length === 0) return;
  w.f32(frames[0].time);
  w.f32(frames[0][field]);
  for (let i = 0; i < frames.length - 1; i++) {
    const next = frames[i + 1];
    w.f32(next.time);
    w.f32(next[field]);
    writeCurve(w, frames[i], 1);
  }
}

function writeTwoChannelFrames(w, frames) {
  if (frames.length === 0) return;
  w.f32(frames[0].time);
  w.f32(frames[0].x);
  w.f32(frames[0].y);
  for (let i = 0; i < frames.length - 1; i++) {
    const next = frames[i + 1];
    w.f32(next.time);
    w.f32(next.x);
    w.f32(next.y);
    writeCurve(w, frames[i], 2);
  }
}

function writeColorFrames(w, frames, components) {
  if (frames.length === 0) return;
  w.f32(frames[0].time);
  for (let c = 0; c < components; c++) w.u8(toByte(frames[0].color[c]));
  for (let i = 0; i < frames.length - 1; i++) {
    const next = frames[i + 1];
    w.f32(next.time);
    for (let c = 0; c < components; c++) w.u8(toByte(next.color[c]));
    writeCurve(w, frames[i], components);
  }
}

function writeTransformFrames(w, frames) {
  const fields = ["mixRotate", "mixX", "mixY", "mixScaleX", "mixScaleY", "mixShearY"];
  if (frames.length === 0) return;
  w.f32(frames[0].time);
  for (const field of fields) w.f32(frames[0][field]);
  for (let i = 0; i < frames.length - 1; i++) {
    const next = frames[i + 1];
    w.f32(next.time);
    for (const field of fields) w.f32(next[field]);
    writeCurve(w, frames[i], 6);
  }
}

function writePathMixFrames(w, frames) {
  if (frames.length === 0) return;
  w.f32(frames[0].time);
  w.f32(frames[0].mixRotate);
  w.f32(frames[0].mixX);
  w.f32(frames[0].mixY);
  for (let i = 0; i < frames.length - 1; i++) {
    const next = frames[i + 1];
    w.f32(next.time);
    w.f32(next.mixRotate);
    w.f32(next.mixX);
    w.f32(next.mixY);
    writeCurve(w, frames[i], 3);
  }
}

function deriveIkFrameFlags(frame, previousCurve) {
  let flags = 0;
  if (previousCurve && previousCurve.stepped) flags |= 64;
  else if (previousCurve) flags |= 128;
  if (frame.mix !== undefined && frame.mix !== 0) flags |= 1;
  if (frame.mix !== undefined && frame.mix !== 0 && frame.mix !== 1) flags |= 2;
  if (frame.softness) flags |= 4;
  if (frame.bendDirection === 1) flags |= 8;
  if (frame.compress) flags |= 16;
  if (frame.stretch) flags |= 32;
  return flags;
}

// The IK timeline packs a frame's flag byte, its time/mix/softness, and (for the
// segment before it) the curve bits. The bezier control points of segment k are
// written after frame k+1's own values, which is the order the runtime reads them.
function writeIkFrame(w, frame, previousCurve) {
  const flags = frame.flags !== undefined ? frame.flags : deriveIkFrameFlags(frame, previousCurve);
  w.u8(flags);
  w.f32(frame.time);
  if ((flags & 1) !== 0 && (flags & 2) !== 0) w.f32(frame.mix);
  if ((flags & 4) !== 0) w.f32(frame.softness);
}

function writeIkFrames(w, frames) {
  if (frames.length === 0) return;
  writeIkFrame(w, frames[0], null);
  for (let i = 0; i < frames.length - 1; i++) {
    writeIkFrame(w, frames[i + 1], frames[i].curve);
    const curve = frames[i].curve;
    if (curve && !curve.stepped) {
      const curves = frames[i].curves || [curve];
      for (let channel = 0; channel < 2; channel++) {
        const control = curves[channel] || curves[0];
        w.f32(control.cx1);
        w.f32(control.cy1);
        w.f32(control.cx2);
        w.f32(control.cy2);
      }
    }
  }
}

// ---------------------------------------------------------------------------
// Attachments
// ---------------------------------------------------------------------------

function deriveAttachmentFlags(attachment) {
  const typeByte = ATTACHMENT_TYPE_BYTES[attachment.type];
  if (typeByte === undefined) throw new Error(`writeSkeletonBinary: unknown attachment type ${attachment.type}`);
  let flags = typeByte;
  const declared = attachment.declaredName;
  if (declared !== undefined && declared !== null && declared !== attachment.name) flags |= 8;
  const path = attachment.path;
  const declaredOrName = declared === undefined ? attachment.name : declared;
  const pathDiffers = path !== null && path !== undefined && path !== declaredOrName;
  switch (attachment.type) {
    case "region":
      if (pathDiffers) flags |= 16;
      if (!isWhiteColor(attachment.color)) flags |= 32;
      if (attachment.sequence) flags |= 64;
      if (attachment.rotation) flags |= 128;
      break;
    case "mesh":
      if (pathDiffers) flags |= 16;
      if (!isWhiteColor(attachment.color)) flags |= 32;
      if (attachment.sequence) flags |= 64;
      if (attachment.bones !== null && attachment.bones !== undefined) flags |= 128;
      break;
    case "linkedmesh":
      if (pathDiffers) flags |= 16;
      if (!isWhiteColor(attachment.color)) flags |= 32;
      if (attachment.sequence) flags |= 64;
      if (attachment.inheritTimelines) flags |= 128;
      break;
    case "boundingbox":
    case "clipping":
      if (attachment.bones !== null && attachment.bones !== undefined) flags |= 16;
      break;
    case "path":
      if (attachment.closed) flags |= 16;
      if (attachment.constantSpeed) flags |= 32;
      if (attachment.bones !== null && attachment.bones !== undefined) flags |= 64;
      break;
    default:
      break;
  }
  return flags;
}

function writeSequence(w, sequence) {
  w.varint(sequence.count);
  w.varint(sequence.start);
  w.varint(sequence.digits);
  w.varint(sequence.setupIndex);
}

function vertexCountOf(bones) {
  let count = 0;
  let index = 0;
  while (index < bones.length) {
    count++;
    index += 1 + bones[index];
  }
  return count;
}

function writeVertices(w, attachment) {
  const vertices = attachment.vertices || [];
  const bones = attachment.bones === undefined ? null : attachment.bones;
  const vertexCount = attachment.worldVerticesLength !== undefined
    ? attachment.worldVerticesLength / 2
    : bones === null ? vertices.length / 2 : vertexCountOf(bones);
  w.varint(vertexCount);
  if (bones === null) {
    for (const value of vertices) w.f32(value);
    return;
  }
  let boneCursor = 0;
  let vertexCursor = 0;
  for (let i = 0; i < vertexCount; i++) {
    const boneCount = bones[boneCursor++];
    w.varint(boneCount);
    for (let ii = 0; ii < boneCount; ii++) {
      w.varint(bones[boneCursor++]);
      w.f32(vertices[vertexCursor++]);
      w.f32(vertices[vertexCursor++]);
      w.f32(vertices[vertexCursor++]);
    }
  }
}

function writeAttachment(w, skeleton, attachment) {
  const flags = attachment.flags !== undefined ? attachment.flags : deriveAttachmentFlags(attachment);
  w.u8(flags);
  if ((flags & 8) !== 0) {
    w.varint(stringIndexOf(skeleton, attachment.declaredName, attachment.declaredNameRef));
  }
  switch (flags & 0x7) {
    case 0: // region
      if ((flags & 16) !== 0) w.varint(stringIndexOf(skeleton, attachment.path, attachment.pathRef));
      if ((flags & 32) !== 0) w.i32(packRgba(attachment.color));
      if ((flags & 64) !== 0) writeSequence(w, attachment.sequence);
      if ((flags & 128) !== 0) w.f32(attachment.rotation);
      w.f32(attachment.x);
      w.f32(attachment.y);
      w.f32(attachment.scaleX);
      w.f32(attachment.scaleY);
      w.f32(attachment.width);
      w.f32(attachment.height);
      return;
    case 1: // boundingbox
      writeVertices(w, attachment);
      if (skeleton.nonessential) w.i32(packRgba(attachment.color));
      return;
    case 2: // mesh
      if ((flags & 16) !== 0) w.varint(stringIndexOf(skeleton, attachment.path, attachment.pathRef));
      if ((flags & 32) !== 0) w.i32(packRgba(attachment.color));
      if ((flags & 64) !== 0) writeSequence(w, attachment.sequence);
      w.varint(attachment.hullLength);
      writeVertices(w, attachment);
      for (const uv of attachment.uvs) w.f32(uv);
      for (const triangle of attachment.triangles) w.varint(triangle & 0xffff);
      if (skeleton.nonessential) {
        w.varint(attachment.edges.length);
        for (const edge of attachment.edges) w.varint(edge & 0xffff);
        w.f32(attachment.width);
        w.f32(attachment.height);
      }
      return;
    case 3: // linkedmesh
      if ((flags & 16) !== 0) w.varint(stringIndexOf(skeleton, attachment.path, attachment.pathRef));
      if ((flags & 32) !== 0) w.i32(packRgba(attachment.color));
      if ((flags & 64) !== 0) writeSequence(w, attachment.sequence);
      w.varint(attachment.skinIndex);
      w.varint(stringIndexOf(skeleton, attachment.parent, attachment.parentRef));
      if (skeleton.nonessential) {
        w.f32(attachment.width);
        w.f32(attachment.height);
      }
      return;
    case 4: // path
      writeVertices(w, attachment);
      for (const length of attachment.lengths) w.f32(length);
      if (skeleton.nonessential) w.i32(packRgba(attachment.color));
      return;
    case 5: // point
      w.f32(attachment.rotation);
      w.f32(attachment.x);
      w.f32(attachment.y);
      if (skeleton.nonessential) w.i32(packRgba(attachment.color));
      return;
    case 6: // clipping
      w.varint(attachment.endSlotIndex);
      writeVertices(w, attachment);
      if (skeleton.nonessential) w.i32(packRgba(attachment.color));
      return;
    default:
      throw new Error(`writeSkeletonBinary: unsupported attachment flag byte ${flags} (type ${flags & 0x7})`);
  }
}

// ---------------------------------------------------------------------------
// Skeleton sections
// ---------------------------------------------------------------------------

function writeBones(w, skeleton) {
  const bones = skeleton.bones || [];
  w.varint(bones.length);
  for (let i = 0; i < bones.length; i++) {
    const bone = bones[i];
    w.string(bone.name);
    if (i > 0) w.varint(bone.parentIndex);
    w.f32(bone.rotation);
    w.f32(bone.x);
    w.f32(bone.y);
    w.f32(bone.scaleX);
    w.f32(bone.scaleY);
    w.f32(bone.shearX);
    w.f32(bone.shearY);
    w.f32(bone.length);
    const inherit = bone.inherit === null || bone.inherit === undefined ? bone.transformMode : bone.inherit;
    const inheritIndex = INHERIT_INDEX[inherit];
    if (inheritIndex === undefined) throw new Error(`writeSkeletonBinary: unknown bone inherit mode ${inherit}`);
    w.u8(inheritIndex);
    w.bool(bone.skinRequired);
    if (skeleton.nonessential) {
      w.i32(packRgba(bone.color));
      w.string(bone.icon === undefined ? null : bone.icon);
      w.bool(bone.visible);
    }
  }
}

function writeSlots(w, skeleton) {
  const slots = skeleton.slots || [];
  w.varint(slots.length);
  for (const slot of slots) {
    w.string(slot.name);
    w.varint(slot.boneIndex);
    w.i32(packRgba(slot.color));
    w.i32(packRgb(slot.darkColor));
    w.varint(stringIndexOf(skeleton, slot.attachmentName, slot.attachmentNameRef));
    const blendIndex = BLEND_MODES.indexOf(slot.blendMode);
    if (blendIndex < 0) throw new Error(`writeSkeletonBinary: unknown blend mode ${slot.blendMode}`);
    w.varint(blendIndex);
    if (skeleton.nonessential) w.bool(slot.visible);
  }
}

function constraintIkFlags(constraint) {
  if (constraint.flags !== undefined) return constraint.flags;
  let flags = 0;
  if (constraint.skinRequired) flags |= 1;
  if (constraint.bendDirection === 1) flags |= 2;
  if (constraint.compress) flags |= 4;
  if (constraint.stretch) flags |= 8;
  if (constraint.uniform) flags |= 16;
  if (constraint.mix !== undefined && constraint.mix !== 1) flags |= 32 | 64;
  if (constraint.softness) flags |= 128;
  return flags;
}

function writeIkConstraints(w, skeleton) {
  const constraints = skeleton.ik || [];
  w.varint(constraints.length);
  for (const constraint of constraints) {
    w.string(constraint.name);
    w.varint(constraint.order);
    w.varint(constraint.boneIndices.length);
    for (const boneIndex of constraint.boneIndices) w.varint(boneIndex);
    w.varint(constraint.targetIndex);
    const flags = constraintIkFlags(constraint);
    w.u8(flags);
    if ((flags & 32) !== 0 && (flags & 64) !== 0) w.f32(constraint.mix);
    if ((flags & 128) !== 0) w.f32(constraint.softness);
  }
}

function constraintTransformFlags(constraint) {
  if (constraint.flags !== undefined) return constraint.flags;
  let flags = 0;
  if (constraint.skinRequired) flags |= 1;
  if (constraint.local) flags |= 2;
  if (constraint.relative) flags |= 4;
  if (constraint.offsetRotation) flags |= 8;
  if (constraint.offsetX) flags |= 16;
  if (constraint.offsetY) flags |= 32;
  if (constraint.offsetScaleX) flags |= 64;
  if (constraint.offsetScaleY) flags |= 128;
  return flags;
}

function constraintTransformFlags2(constraint) {
  if (constraint.flags2 !== undefined) return constraint.flags2;
  let flags = 0;
  if (constraint.offsetShearY) flags |= 1;
  if (constraint.mixRotate !== undefined && constraint.mixRotate !== 1) flags |= 2;
  if (constraint.mixX !== undefined && constraint.mixX !== 1) flags |= 4;
  if (constraint.mixY !== undefined && constraint.mixY !== 1) flags |= 8;
  if (constraint.mixScaleX !== undefined && constraint.mixScaleX !== 1) flags |= 16;
  if (constraint.mixScaleY !== undefined && constraint.mixScaleY !== 1) flags |= 32;
  if (constraint.mixShearY !== undefined && constraint.mixShearY !== 1) flags |= 64;
  return flags;
}

function writeTransformConstraints(w, skeleton) {
  const constraints = skeleton.transform || [];
  w.varint(constraints.length);
  for (const constraint of constraints) {
    w.string(constraint.name);
    w.varint(constraint.order);
    w.varint(constraint.boneIndices.length);
    for (const boneIndex of constraint.boneIndices) w.varint(boneIndex);
    w.varint(constraint.targetIndex);
    let flags = constraintTransformFlags(constraint);
    w.u8(flags);
    if ((flags & 8) !== 0) w.f32(constraint.offsetRotation);
    if ((flags & 16) !== 0) w.f32(constraint.offsetX);
    if ((flags & 32) !== 0) w.f32(constraint.offsetY);
    if ((flags & 64) !== 0) w.f32(constraint.offsetScaleX);
    if ((flags & 128) !== 0) w.f32(constraint.offsetScaleY);
    flags = constraintTransformFlags2(constraint);
    w.u8(flags);
    if ((flags & 1) !== 0) w.f32(constraint.offsetShearY);
    if ((flags & 2) !== 0) w.f32(constraint.mixRotate);
    if ((flags & 4) !== 0) w.f32(constraint.mixX);
    if ((flags & 8) !== 0) w.f32(constraint.mixY);
    if ((flags & 16) !== 0) w.f32(constraint.mixScaleX);
    if ((flags & 32) !== 0) w.f32(constraint.mixScaleY);
    if ((flags & 64) !== 0) w.f32(constraint.mixShearY);
  }
}

function constraintPathFlags(constraint) {
  if (constraint.flags !== undefined) return constraint.flags;
  const position = Math.max(0, POSITION_MODES.indexOf(constraint.positionMode === undefined ? "fixed" : constraint.positionMode));
  const spacing = Math.max(0, SPACING_MODES.indexOf(constraint.spacingMode === undefined ? "length" : constraint.spacingMode));
  const rotate = Math.max(0, ROTATE_MODES.indexOf(constraint.rotateMode === undefined ? "tangent" : constraint.rotateMode));
  let flags = (position & 1) | ((spacing & 3) << 1) | ((rotate & 3) << 3);
  if (constraint.offsetRotation) flags |= 128;
  return flags;
}

function writePathConstraints(w, skeleton) {
  const constraints = skeleton.path || [];
  w.varint(constraints.length);
  for (const constraint of constraints) {
    w.string(constraint.name);
    w.varint(constraint.order);
    w.bool(constraint.skinRequired);
    w.varint(constraint.boneIndices.length);
    for (const boneIndex of constraint.boneIndices) w.varint(boneIndex);
    w.varint(constraint.targetSlotIndex);
    const flags = constraintPathFlags(constraint);
    w.u8(flags);
    if ((flags & 128) !== 0) w.f32(constraint.offsetRotation);
    w.f32(constraint.position);
    w.f32(constraint.spacing);
    w.f32(constraint.mixRotate);
    w.f32(constraint.mixX);
    w.f32(constraint.mixY);
  }
}

function constraintPhysicsFlags(constraint) {
  if (constraint.flags !== undefined) return constraint.flags;
  let flags = 0;
  if (constraint.skinRequired) flags |= 1;
  if (constraint.x) flags |= 2;
  if (constraint.y) flags |= 4;
  if (constraint.rotate) flags |= 8;
  if (constraint.scaleX) flags |= 16;
  if (constraint.shearX) flags |= 32;
  if (constraint.limit !== undefined && constraint.limit !== 5000) flags |= 64;
  if (constraint.massInverse !== undefined && constraint.massInverse !== 1) flags |= 128;
  return flags;
}

function constraintPhysicsFlags2(constraint) {
  if (constraint.flags2 !== undefined) return constraint.flags2;
  let flags = 0;
  if (constraint.inertiaGlobal) flags |= 1;
  if (constraint.strengthGlobal) flags |= 2;
  if (constraint.dampingGlobal) flags |= 4;
  if (constraint.massGlobal) flags |= 8;
  if (constraint.windGlobal) flags |= 16;
  if (constraint.gravityGlobal) flags |= 32;
  if (constraint.mixGlobal) flags |= 64;
  if (constraint.mix !== undefined && constraint.mix !== 1) flags |= 128;
  return flags;
}

function physicsStepDivisor(constraint) {
  if (constraint.stepDivisor !== undefined) return constraint.stepDivisor;
  if (constraint.step === undefined || constraint.step === 0) return 0;
  return Math.round(1 / constraint.step);
}

function writePhysicsConstraints(w, skeleton) {
  const constraints = skeleton.physics || [];
  w.varint(constraints.length);
  for (const constraint of constraints) {
    w.string(constraint.name);
    w.varint(constraint.order);
    w.varint(constraint.boneIndex);
    let flags = constraintPhysicsFlags(constraint);
    w.u8(flags);
    if ((flags & 2) !== 0) w.f32(constraint.x);
    if ((flags & 4) !== 0) w.f32(constraint.y);
    if ((flags & 8) !== 0) w.f32(constraint.rotate);
    if ((flags & 16) !== 0) w.f32(constraint.scaleX);
    if ((flags & 32) !== 0) w.f32(constraint.shearX);
    if ((flags & 64) !== 0) w.f32(constraint.limit);
    w.u8(physicsStepDivisor(constraint));
    w.f32(constraint.inertia);
    w.f32(constraint.strength);
    w.f32(constraint.damping);
    if ((flags & 128) !== 0) w.f32(constraint.massInverse);
    w.f32(constraint.wind);
    w.f32(constraint.gravity);
    flags = constraintPhysicsFlags2(constraint);
    w.u8(flags);
    if ((flags & 128) !== 0) w.f32(constraint.mix);
  }
}

function groupAttachmentsBySlot(attachments) {
  const blocks = [];
  for (const attachment of attachments || []) {
    const last = blocks.length > 0 ? blocks[blocks.length - 1] : null;
    if (last !== null && last.slotIndex === attachment.slotIndex) last.attachments.push(attachment);
    else blocks.push({ slotIndex: attachment.slotIndex, attachments: [attachment] });
  }
  return blocks;
}

function writeSkinAttachments(w, skeleton, skinBlocks) {
  w.varint(skinBlocks.length);
  for (const block of skinBlocks) {
    w.varint(block.slotIndex);
    w.varint(block.attachments.length);
    for (const attachment of block.attachments) {
      w.varint(stringIndexOf(skeleton, attachment.name, attachment.nameRef));
      writeAttachment(w, skeleton, attachment);
    }
  }
}

function writeSkins(w, skeleton) {
  const skins = skeleton.skins || [];
  const defaultSkin = skins.find((skin) => skin.isDefault === true);
  if (defaultSkin) writeSkinAttachments(w, skeleton, groupAttachmentsBySlot(defaultSkin.attachments));
  else w.varint(0);

  const namedSkins = skins.filter((skin) => skin.isDefault !== true);
  w.varint(namedSkins.length);
  for (const skin of namedSkins) {
    w.string(skin.name);
    if (skeleton.nonessential) w.i32(packRgba(skin.color));
    w.varint(skin.bones.length);
    for (const boneIndex of skin.bones) w.varint(boneIndex);
    for (const type of ["ik", "transform", "path", "physics"]) {
      const indices = skin.constraints.filter((constraint) => constraint.type === type).map((constraint) => constraint.index);
      w.varint(indices.length);
      for (const index of indices) w.varint(index);
    }
    writeSkinAttachments(w, skeleton, groupAttachmentsBySlot(skin.attachments));
  }
}

function writeEvents(w, skeleton) {
  const events = skeleton.events || [];
  w.varint(events.length);
  for (const event of events) {
    const audioPath = event.audioPath === undefined ? null : event.audioPath;
    w.string(event.name);
    w.sint(event.intValue === undefined ? 0 : event.intValue);
    w.f32(event.floatValue === undefined ? 0 : event.floatValue);
    w.string(event.stringValue === undefined ? null : event.stringValue);
    w.string(audioPath);
    if (audioPath !== null) {
      w.f32(event.volume === undefined ? 1 : event.volume);
      w.f32(event.balance === undefined ? 0 : event.balance);
    }
  }
}

// ---------------------------------------------------------------------------
// Animations
// ---------------------------------------------------------------------------

function consecutiveGroups(items, keyOf) {
  const groups = [];
  for (const item of items) {
    const key = keyOf(item);
    const last = groups.length > 0 ? groups[groups.length - 1] : null;
    if (last !== null && last.key === key) last.items.push(item);
    else groups.push({ key, items: [item] });
  }
  return groups;
}

function slotTimelineComponents(timeline) {
  if (timeline.type === "alpha") return 1;
  const frames = timeline.frames;
  return frames.length > 0 ? frames[0].color.length : 4;
}

function slotColorType(timeline) {
  if (timeline.type === "alpha") return SLOT_ALPHA;
  switch (slotTimelineComponents(timeline)) {
    case 4: return SLOT_RGBA;
    case 3: return SLOT_RGB;
    case 7: return SLOT_RGBA2;
    case 6: return SLOT_RGB2;
    default:
      throw new Error(`writeSkeletonBinary: unsupported colour timeline component count ${slotTimelineComponents(timeline)}`);
  }
}

function writeSlotTimeline(w, skeleton, timeline) {
  const frames = timeline.frames;
  if (timeline.type === "attachment") {
    w.u8(SLOT_ATTACHMENT);
    w.varint(frames.length);
    for (const frame of frames) {
      w.f32(frame.time);
      w.varint(stringIndexOf(skeleton, frame.name, frame.nameRef));
    }
    return;
  }
  w.u8(slotColorType(timeline));
  w.varint(frames.length);
  w.varint(bezierCountOf(timeline));
  writeColorFrames(w, frames, slotTimelineComponents(timeline));
}

function writeBoneTimeline(w, timeline) {
  const frames = timeline.frames;
  const typeByte = BONE_TYPE_BYTES[timeline.type];
  if (typeByte === undefined) throw new Error(`writeSkeletonBinary: unknown bone timeline type ${timeline.type}`);
  w.u8(typeByte);
  w.varint(frames.length);
  if (timeline.type === "inherit") {
    for (const frame of frames) {
      w.f32(frame.time);
      const inheritIndex = INHERIT_INDEX[frame.inherit];
      if (inheritIndex === undefined) throw new Error(`writeSkeletonBinary: unknown inherit mode ${frame.inherit}`);
      w.u8(inheritIndex);
    }
    return;
  }
  w.varint(bezierCountOf(timeline));
  if (BONE_TWO_CHANNEL.has(timeline.type)) writeTwoChannelFrames(w, frames);
  else writeOneChannelFrames(w, frames, BONE_ONE_CHANNEL_FIELD[timeline.type]);
}

function writePathTimeline(w, timeline) {
  const frames = timeline.frames;
  const typeByte = PATH_TYPE_BYTES[timeline.type];
  if (typeByte === undefined) throw new Error(`writeSkeletonBinary: unknown path timeline type ${timeline.type}`);
  w.u8(typeByte);
  w.varint(frames.length);
  w.varint(bezierCountOf(timeline));
  if (timeline.type === "pathMix") writePathMixFrames(w, frames);
  else {
    let field = "value";
    if (frames.length > 0 && frames[0].value === undefined) field = timeline.type === "pathPosition" ? "position" : "spacing";
    writeOneChannelFrames(w, frames, field);
  }
}

function writePhysicsTimeline(w, timeline) {
  const typeByte = PHYSICS_TYPE_BYTES[timeline.type];
  if (typeByte === undefined) throw new Error(`writeSkeletonBinary: unknown physics timeline type ${timeline.type}`);
  w.u8(typeByte);
  w.varint(timeline.frames.length);
  if (timeline.type === "physicsReset") {
    for (const frame of timeline.frames) w.f32(frame.time);
    return;
  }
  w.varint(bezierCountOf(timeline));
  writeOneChannelFrames(w, timeline.frames, "value");
}

function writeDeformTimeline(w, skeleton, timeline) {
  const frames = timeline.frames;
  w.u8(0); // ATTACHMENT_DEFORM
  w.varint(frames.length);
  w.varint(bezierCountOf(timeline));
  if (frames.length === 0) return;
  w.f32(frames[0].time);
  for (let i = 0; i < frames.length; i++) {
    const frame = frames[i];
    w.varint(frame.end);
    if (frame.end !== 0) {
      w.varint(frame.start);
      for (const value of frame.values) w.f32(value);
    }
    if (i < frames.length - 1) {
      w.f32(frames[i + 1].time);
      writeCurve(w, frame, 1);
    }
  }
}

function writeSequenceTimeline(w, timeline) {
  w.u8(1); // ATTACHMENT_SEQUENCE
  w.varint(timeline.frames.length);
  for (const frame of timeline.frames) {
    w.f32(frame.time);
    let modeAndIndex = frame.modeAndIndex;
    if (modeAndIndex === undefined) {
      const modeIndex = Math.max(0, SEQUENCE_MODES.indexOf(frame.mode === null ? "hold" : frame.mode));
      modeAndIndex = (modeIndex | ((frame.index || 0) << 4)) | 0;
    }
    w.i32(modeAndIndex);
    w.f32(frame.delay === undefined ? 0 : frame.delay);
  }
}

function writeAnimation(w, skeleton, animation) {
  const timelines = animation.timelines || [];
  w.string(animation.name);
  w.varint(animation.timelineCountHint !== undefined ? animation.timelineCountHint : timelines.length);

  // 1. Slot timelines (attachment + colour). Blocks are keyed by slot index.
  const slotGroups = consecutiveGroups(
    timelines.filter((timeline) => timeline.type === "attachment" || timeline.type === "color" || timeline.type === "alpha"),
    (timeline) => timeline.slotIndex,
  );
  w.varint(slotGroups.length);
  for (const group of slotGroups) {
    w.varint(group.key);
    w.varint(group.items.length);
    for (const timeline of group.items) writeSlotTimeline(w, skeleton, timeline);
  }

  // 2. Bone timelines. Blocks are keyed by bone index.
  const boneGroups = consecutiveGroups(
    timelines.filter((timeline) => BONE_TYPE_BYTES[timeline.type] !== undefined),
    (timeline) => timeline.boneIndex,
  );
  w.varint(boneGroups.length);
  for (const group of boneGroups) {
    w.varint(group.key);
    w.varint(group.items.length);
    for (const timeline of group.items) writeBoneTimeline(w, timeline);
  }

  // 3. IK constraint timelines: one block per timeline.
  const ikTimelines = timelines.filter((timeline) => timeline.type === "ik");
  w.varint(ikTimelines.length);
  for (const timeline of ikTimelines) {
    w.varint(timeline.ikIndex);
    w.varint(timeline.frames.length);
    w.varint(bezierCountOf(timeline));
    writeIkFrames(w, timeline.frames);
  }

  // 4. Transform constraint timelines: one block per timeline.
  const transformTimelines = timelines.filter((timeline) => timeline.type === "transform");
  w.varint(transformTimelines.length);
  for (const timeline of transformTimelines) {
    w.varint(timeline.transformIndex);
    w.varint(timeline.frames.length);
    w.varint(bezierCountOf(timeline));
    writeTransformFrames(w, timeline.frames);
  }

  // 5. Path constraint timelines. Blocks are keyed by path index.
  const pathGroups = consecutiveGroups(
    timelines.filter((timeline) => PATH_TYPE_BYTES[timeline.type] !== undefined),
    (timeline) => timeline.pathIndex,
  );
  w.varint(pathGroups.length);
  for (const group of pathGroups) {
    w.varint(group.key);
    w.varint(group.items.length);
    for (const timeline of group.items) writePathTimeline(w, timeline);
  }

  // 6. Physics constraint timelines. The file stores index+1; blocks by index.
  const physicsGroups = consecutiveGroups(
    timelines.filter((timeline) => PHYSICS_TYPE_BYTES[timeline.type] !== undefined),
    (timeline) => timeline.physicsIndex,
  );
  w.varint(physicsGroups.length);
  for (const group of physicsGroups) {
    w.varint(group.key + 1);
    w.varint(group.items.length);
    for (const timeline of group.items) writePhysicsTimeline(w, timeline);
  }

  // 7. Attachment timelines (deform and sequence), nested skin -> slot -> name.
  const attachmentTimelines = timelines.filter((timeline) => timeline.type === "deform" || timeline.type === "sequence");
  const skinGroups = consecutiveGroups(attachmentTimelines, (timeline) => timeline.skinIndex);
  w.varint(skinGroups.length);
  for (const skinGroup of skinGroups) {
    w.varint(skinGroup.key);
    const slotGroups = consecutiveGroups(skinGroup.items, (timeline) => timeline.slotIndex);
    w.varint(slotGroups.length);
    for (const slotGroup of slotGroups) {
      w.varint(slotGroup.key);
      const nameGroups = consecutiveGroups(
        slotGroup.items,
        (timeline) => `${timeline.type}\u0000${timeline.attachmentName}`,
      );
      w.varint(nameGroups.length);
      for (const nameGroup of nameGroups) {
        const first = nameGroup.items[0];
        w.varint(stringIndexOf(skeleton, first.attachmentName, first.attachmentNameRef));
        for (const timeline of nameGroup.items) {
          if (timeline.type === "deform") writeDeformTimeline(w, skeleton, timeline);
          else writeSequenceTimeline(w, timeline);
        }
      }
    }
  }

  // 8. Draw order timeline (at most one; the count is its frame count).
  const drawOrder = timelines.find((timeline) => timeline.type === "drawOrder");
  w.varint(drawOrder === undefined ? 0 : drawOrder.frames.length);
  if (drawOrder !== undefined) {
    for (const frame of drawOrder.frames) {
      w.f32(frame.time);
      w.varint(frame.offsets.length);
      for (const offset of frame.offsets) {
        w.varint(offset.slotIndex);
        w.varint(offset.offset);
      }
    }
  }

  // 9. Events timeline (at most one; the count is its frame count).
  const eventsTimeline = timelines.find((timeline) => timeline.type === "events");
  w.varint(eventsTimeline === undefined ? 0 : eventsTimeline.frames.length);
  if (eventsTimeline !== undefined) {
    for (const frame of eventsTimeline.frames) {
      w.f32(frame.time);
      w.varint(frame.eventIndex);
      w.sint(frame.intValue === undefined ? 0 : frame.intValue);
      w.f32(frame.floatValue === undefined ? 0 : frame.floatValue);
      const explicitNull = frame.stringValueNull === true;
      w.string(explicitNull ? null : frame.stringValue === undefined ? null : frame.stringValue);
      const eventData = (skeleton.events || [])[frame.eventIndex];
      const audioPath = eventData === undefined || eventData.audioPath === undefined ? null : eventData.audioPath;
      if (audioPath !== null) {
        w.f32(frame.volume === undefined ? 1 : frame.volume);
        w.f32(frame.balance === undefined ? 0 : frame.balance);
      }
    }
  }
}

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------

/**
 * Serialise a skeleton model (as returned by `readSkeletonBinary`) back to the
 * Spine 4.2 binary format. Returns a fresh `Uint8Array`.
 */
export function writeSkeletonBinary(skeleton) {
  if (skeleton === null || typeof skeleton !== "object") {
    throw new TypeError("writeSkeletonBinary: expected a skeleton model object");
  }
  if (!Array.isArray(skeleton.strings)) {
    throw new TypeError("writeSkeletonBinary: skeleton.strings must be an array");
  }
  const w = new Writer();

  // Header.
  writeHash(w, skeleton.hash);
  w.string(skeleton.version);
  w.f32(skeleton.x);
  w.f32(skeleton.y);
  w.f32(skeleton.width);
  w.f32(skeleton.height);
  w.f32(skeleton.referenceScale);
  w.bool(skeleton.nonessential);
  if (skeleton.nonessential) {
    w.f32(skeleton.fps);
    w.string(skeleton.imagesPath === undefined ? null : skeleton.imagesPath);
    w.string(skeleton.audioPath === undefined ? null : skeleton.audioPath);
  }

  // String table.
  w.varint(skeleton.strings.length);
  for (const text of skeleton.strings) w.string(text);

  writeBones(w, skeleton);
  writeSlots(w, skeleton);
  writeIkConstraints(w, skeleton);
  writeTransformConstraints(w, skeleton);
  writePathConstraints(w, skeleton);
  writePhysicsConstraints(w, skeleton);
  writeSkins(w, skeleton);
  writeEvents(w, skeleton);

  const animations = skeleton.animations || [];
  w.varint(animations.length);
  for (const animation of animations) writeAnimation(w, skeleton, animation);

  return w.finish();
}
