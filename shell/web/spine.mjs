// Reading Spine 4.2 binary skeletons (.skel.bytes) and text atlases (.atlas.txt).
//
// This is an independent, dependency-free reader for the *data* format used by
// Spine 4.2.x exports. It is a layout parser only: it knows nothing about posing,
// drawing or a renderer, so it runs unchanged in a browser and in Node.
//
// Layout reference: the 4.2 runtime's SkeletonBinary.java / SkeletonInput
// (Esoteric Software, Spine Runtimes License). The field order below follows that
// reader exactly, so a buffer that parses here is the same buffer that runtime
// would accept. The one deliberate simplification: the runtime's global `scale`
// (normally 1, used by the editor to convert units) is fixed at 1, so every
// length/x/y value is reported in the file's own units.
//
// Conventions used by the returned model:
//   - colors are arrays of 0..1 floats. The file stores them as uint32 RGBA8888
//     (dark colors as RGB888), so they are normalised on the way out.
//   - missing/absent things are `null`, never `undefined`.
//   - index fields are 0-based, except attachment name references in the file,
//     which are 1-based and already resolved to strings here.
//   - every timeline's `curve` is null (linear), {stepped:true}, or
//     {cx1,cy1,cx2,cy2} for a cubic bezier. Multi-channel timelines keep the
//     first channel's curve in `curve` and all channels in `curves`.

const ATTACHMENT_TYPES = [
  "region", "boundingbox", "mesh", "linkedmesh", "path", "point", "clipping", "sequence",
];
const BLEND_MODES = ["normal", "additive", "multiply", "screen"];
// Spine 4.2 calls this field `inherit`; older runtimes called it `transformMode`.
// The values are identical, so both names are reported on each bone.
const INHERIT_MODES = [
  "normal", "onlyTranslation", "noRotationOrReflection", "noScale", "noScaleOrReflection",
];
const POSITION_MODES = ["fixed", "percent"];
const SPACING_MODES = ["length", "fixed", "percent", "proportional"];
const ROTATE_MODES = ["tangent", "chain", "chainScale"];
const SEQUENCE_MODES = [
  "hold", "once", "loop", "pingpong", "onceReverse", "loopReverse", "pingpongReverse",
];

// Timeline type codes, from SkeletonBinary's constants.
const SLOT_ATTACHMENT = 0;
const SLOT_RGBA = 1;
const SLOT_RGB = 2;
const SLOT_RGBA2 = 3;
const SLOT_RGB2 = 4;
const SLOT_ALPHA = 5;
const BONE_ROTATE = 0;
const BONE_TRANSLATE = 1;
const BONE_TRANSLATEX = 2;
const BONE_TRANSLATEY = 3;
const BONE_SCALE = 4;
const BONE_SCALEX = 5;
const BONE_SCALEY = 6;
const BONE_SHEAR = 7;
const BONE_SHEARX = 8;
const BONE_SHEARY = 9;
const BONE_INHERIT = 10;
const ATTACHMENT_DEFORM = 0;
const ATTACHMENT_SEQUENCE = 1;
const PATH_POSITION = 0;
const PATH_SPACING = 1;
const PATH_MIX = 2;
const PHYSICS_INERTIA = 0;
const PHYSICS_STRENGTH = 1;
const PHYSICS_DAMPING = 2;
const PHYSICS_MASS = 4;
const PHYSICS_WIND = 5;
const PHYSICS_GRAVITY = 6;
const PHYSICS_MIX = 7;
const PHYSICS_RESET = 8;
const CURVE_LINEAR = 0;
const CURVE_STEPPED = 1;
const CURVE_BEZIER = 2;

// ---------------------------------------------------------------------------
// Byte reader
// ---------------------------------------------------------------------------

class Reader {
  constructor(bytes, label) {
    if (bytes instanceof ArrayBuffer) bytes = new Uint8Array(bytes);
    else if (ArrayBuffer.isView(bytes) && !(bytes instanceof Uint8Array)) {
      bytes = new Uint8Array(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    }
    if (!(bytes instanceof Uint8Array)) {
      throw new TypeError("readSkeletonBinary: expected a Uint8Array (or ArrayBuffer)");
    }
    this.bytes = bytes;
    this.view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    this.pos = 0;
    this.label = label || "skeleton";
    this.strings = [];
    // The 1-based index used by the most recent stringRef(); the writer needs the
    // raw index back because the string table can hold duplicate values.
    this.lastStringRef = 0;
  }

  fail(message) {
    throw new Error(`${this.label}: ${message} at byte offset ${this.pos} (0x${this.pos.toString(16)})`);
  }

  need(n) {
    if (this.pos + n > this.bytes.length) {
      this.fail(`unexpected end of data: wanted ${n} byte(s), only ${this.bytes.length - this.pos} left`);
    }
  }

  u8() {
    this.need(1);
    return this.bytes[this.pos++];
  }

  i8() {
    const b = this.u8();
    return (b << 24) >> 24;
  }

  // A fixed 4-byte big-endian signed integer (libGDX DataInput.readInt()).
  i32() {
    this.need(4);
    const b = this.bytes;
    const p = this.pos;
    this.pos += 4;
    return ((b[p] << 24) | (b[p + 1] << 16) | (b[p + 2] << 8) | b[p + 3]) | 0;
  }

  // A 4-byte big-endian IEEE-754 float.
  f32() {
    this.need(4);
    const value = this.view.getFloat32(this.pos, false);
    this.pos += 4;
    return value;
  }

  // A variable-length integer (libGDX DataInput.readVarInt, 7 bits per byte,
  // least significant group first). The runtime uses readInt(true) for counts
  // and indices, and readInt(false) (zigzag) for signed values, see sint().
  varint() {
    let b = this.u8();
    let value = b & 0x7f;
    for (let shift = 7; (b & 0x80) !== 0; shift += 7) {
      if (shift > 28) this.fail("variable-length integer is longer than 5 bytes");
      b = this.u8();
      value |= (b & 0x7f) << shift;
    }
    return value;
  }

  // A count or 0-based index: unsigned and non-negative.
  count() {
    const start = this.pos;
    const value = this.varint();
    if (value < 0) {
      throw new Error(`${this.label}: negative length/count at byte offset ${start} (0x${start.toString(16)})`);
    }
    return value;
  }

  // A zigzag-encoded signed integer (libGDX readInt(false)).
  sint() {
    const value = this.varint();
    return (value >>> 1) ^ -(value & 1);
  }

  bool() {
    return this.u8() !== 0;
  }

  // A length-prefixed UTF-8 string. 0 = null, 1 = "", n = n-1 bytes of UTF-8.
  string() {
    const start = this.pos;
    const byteCount = this.count();
    if (byteCount === 0) return null;
    if (byteCount === 1) return "";
    const length = byteCount - 1;
    this.need(length);
    const text = decodeUtf8(this.bytes, this.pos, this.pos + length);
    this.pos += length;
    if (text === null) {
      throw new Error(`${this.label}: malformed UTF-8 string at byte offset ${start} (0x${start.toString(16)})`);
    }
    return text;
  }

  // A 1-based index into the file's string table; 0 means null.
  stringRef() {
    const start = this.pos;
    const index = this.count();
    this.lastStringRef = index;
    if (index === 0) return null;
    const value = this.strings[index - 1];
    if (value === undefined) {
      throw new Error(
        `${this.label}: string reference ${index} is outside the ${this.strings.length}-entry table ` +
        `at byte offset ${start} (0x${start.toString(16)})`,
      );
    }
    return value;
  }
}

function decodeUtf8(bytes, start, end) {
  let out = "";
  let i = start;
  while (i < end) {
    const b = bytes[i++];
    if (b < 0x80) {
      out += String.fromCharCode(b);
    } else if (b >= 0xc2 && b < 0xe0) {
      if (i >= end) return null;
      out += String.fromCharCode(((b & 0x1f) << 6) | (bytes[i++] & 0x3f));
    } else if (b >= 0xe0 && b < 0xf0) {
      if (i + 1 >= end) return null;
      const b2 = bytes[i++];
      const b3 = bytes[i++];
      out += String.fromCharCode(((b & 0x0f) << 12) | ((b2 & 0x3f) << 6) | (b3 & 0x3f));
    } else if (b >= 0xf0 && b < 0xf5) {
      if (i + 2 >= end) return null;
      const b2 = bytes[i++];
      const b3 = bytes[i++];
      const b4 = bytes[i++];
      const code = ((b & 0x07) << 18) | ((b2 & 0x3f) << 12) | ((b3 & 0x3f) << 6) | (b4 & 0x3f);
      if (code > 0x10ffff) return null;
      const offset = code - 0x10000;
      out += String.fromCharCode(0xd800 + (offset >> 10), 0xdc00 + (offset & 0x3ff));
    } else {
      // The 4.2 runtime does not accept 4-byte sequences either; report the file.
      return null;
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// Small value helpers
// ---------------------------------------------------------------------------

// uint32 RGBA8888 -> [r, g, b, a] with each component in 0..1.
function colorFromRgba(value) {
  const v = value >>> 0;
  return [(v >>> 24) / 255, ((v >>> 16) & 0xff) / 255, ((v >>> 8) & 0xff) / 255, (v & 0xff) / 255];
}

// uint32 RGB888 -> [r, g, b] in 0..1.
function colorFromRgb(value) {
  const v = value >>> 0;
  return [((v >>> 16) & 0xff) / 255, ((v >>> 8) & 0xff) / 255, (v & 0xff) / 255];
}

function readColorBytes(r, componentCount) {
  const color = new Array(componentCount);
  for (let i = 0; i < componentCount; i++) color[i] = r.u8() / 255;
  return color;
}

function enumValue(names, index, r, what) {
  const value = names[index];
  if (value === undefined) r.fail(`unknown ${what} ${index}`);
  return value;
}

// ---------------------------------------------------------------------------
// Vertices, sequences and attachments
// ---------------------------------------------------------------------------

function readSequence(r) {
  return {
    count: r.count(),
    start: r.count(),
    digits: r.count(),
    setupIndex: r.count(),
  };
}

// A vertex buffer. `vertices` is flat; for weighted meshes it holds x, y, weight
// triples per bone influence and `bones` holds [boneCount, boneIndex, ...] per
// vertex. For unweighted meshes it holds x, y pairs and `bones` is null.
function readVertices(r, weighted) {
  const vertexCount = r.count();
  const length = vertexCount << 1;
  if (!weighted) {
    const vertices = new Array(length);
    for (let i = 0; i < length; i++) vertices[i] = r.f32();
    return { length, vertices, bones: null };
  }
  const vertices = [];
  const bones = [];
  for (let i = 0; i < vertexCount; i++) {
    const boneCount = r.count();
    bones.push(boneCount);
    for (let ii = 0; ii < boneCount; ii++) {
      bones.push(r.count());
      vertices.push(r.f32(), r.f32(), r.f32());
    }
  }
  return { length, vertices, bones };
}

function readShortArray(r, count) {
  const values = new Array(count);
  for (let i = 0; i < count; i++) values[i] = (r.count() << 16) >> 16;
  return values;
}

function readFloatArray(r, count) {
  const values = new Array(count);
  for (let i = 0; i < count; i++) values[i] = r.f32();
  return values;
}

function readAttachment(r, slotIndex, key, nonessential) {
  const flags = r.u8();
  // The attachment's own name is only stored when it differs from the skin key.
  const declaredName = (flags & 8) !== 0 ? r.stringRef() : key;
  const declaredNameRef = (flags & 8) !== 0 ? r.lastStringRef : 0;
  const type = ATTACHMENT_TYPES[flags & 0x7];
  // `flags` is kept raw: a writer cannot always recompute it, because a
  // present-but-default field (a white colour, a zero rotation) looks the same in
  // the model as an absent one. `pathRef`/`parentRef`/`declaredNameRef` are the raw
  // 1-based string-table indices for the same reason: the table can hold duplicate
  // strings, so the value alone does not pin the index the file used.
  const base = {
    slotIndex, name: key, declaredName, type, flags, declaredNameRef,
    path: null, pathRef: 0, parentRef: 0,
  };

  switch (type) {
    case "region": {
      base.path = (flags & 16) !== 0 ? r.stringRef() : null;
      base.pathRef = (flags & 16) !== 0 ? r.lastStringRef : 0;
      base.color = (flags & 32) !== 0 ? colorFromRgba(r.i32()) : [1, 1, 1, 1];
      base.sequence = (flags & 64) !== 0 ? readSequence(r) : null;
      base.rotation = (flags & 128) !== 0 ? r.f32() : 0;
      base.x = r.f32();
      base.y = r.f32();
      base.scaleX = r.f32();
      base.scaleY = r.f32();
      base.width = r.f32();
      base.height = r.f32();
      if (base.path === null) base.path = declaredName;
      return base;
    }
    case "boundingbox": {
      const vertices = readVertices(r, (flags & 16) !== 0);
      base.vertices = vertices.vertices;
      base.bones = vertices.bones;
      base.worldVerticesLength = vertices.length;
      base.color = nonessential ? colorFromRgba(r.i32()) : null;
      return base;
    }
    case "mesh": {
      base.path = (flags & 16) !== 0 ? r.stringRef() : declaredName;
      base.pathRef = (flags & 16) !== 0 ? r.lastStringRef : 0;
      base.color = (flags & 32) !== 0 ? colorFromRgba(r.i32()) : [1, 1, 1, 1];
      base.sequence = (flags & 64) !== 0 ? readSequence(r) : null;
      base.hullLength = r.count();
      const vertices = readVertices(r, (flags & 128) !== 0);
      base.vertices = vertices.vertices;
      base.bones = vertices.bones;
      base.worldVerticesLength = vertices.length;
      base.uvs = readFloatArray(r, vertices.length);
      base.triangles = readShortArray(r, (vertices.length - base.hullLength - 2) * 3);
      if (nonessential) {
        base.edges = readShortArray(r, r.count());
        base.width = r.f32();
        base.height = r.f32();
      } else {
        base.edges = null;
        base.width = 0;
        base.height = 0;
      }
      return base;
    }
    case "linkedmesh": {
      base.path = (flags & 16) !== 0 ? r.stringRef() : declaredName;
      base.pathRef = (flags & 16) !== 0 ? r.lastStringRef : 0;
      base.color = (flags & 32) !== 0 ? colorFromRgba(r.i32()) : [1, 1, 1, 1];
      base.sequence = (flags & 64) !== 0 ? readSequence(r) : null;
      base.inheritTimelines = (flags & 128) !== 0;
      base.skinIndex = r.count();
      base.parent = r.stringRef();
      base.parentRef = r.lastStringRef;
      base.width = nonessential ? r.f32() : 0;
      base.height = nonessential ? r.f32() : 0;
      return base;
    }
    case "path": {
      base.closed = (flags & 16) !== 0;
      base.constantSpeed = (flags & 32) !== 0;
      const vertices = readVertices(r, (flags & 64) !== 0);
      base.vertices = vertices.vertices;
      base.bones = vertices.bones;
      base.worldVerticesLength = vertices.length;
      base.lengths = readFloatArray(r, vertices.length / 6);
      base.color = nonessential ? colorFromRgba(r.i32()) : null;
      return base;
    }
    case "point": {
      base.rotation = r.f32();
      base.x = r.f32();
      base.y = r.f32();
      base.color = nonessential ? colorFromRgba(r.i32()) : null;
      return base;
    }
    case "clipping": {
      base.endSlotIndex = r.count();
      const vertices = readVertices(r, (flags & 16) !== 0);
      base.vertices = vertices.vertices;
      base.bones = vertices.bones;
      base.worldVerticesLength = vertices.length;
      base.color = nonessential ? colorFromRgba(r.i32()) : null;
      return base;
    }
    default:
      return r.fail(`unsupported attachment type ${flags & 0x7}`);
  }
}

// ---------------------------------------------------------------------------
// Timelines
// ---------------------------------------------------------------------------

function curveFromByte(r, byte) {
  if (byte === CURVE_LINEAR) return null;
  if (byte === CURVE_STEPPED) return { stepped: true };
  if (byte === CURVE_BEZIER) return { cx1: r.f32(), cy1: r.f32(), cx2: r.f32(), cy2: r.f32() };
  return r.fail(`unknown curve type ${byte}`);
}

function finishCurve(curves) {
  // Multi-channel timelines carry one bezier per channel; expose them all and
  // repeat the first as `curve` for callers that only animate one value.
  return { curve: curves.length > 0 ? curves[0] : null, curves };
}

// A one-channel timeline (rotate, scale, shear, path position, physics, ...).
function readTimeline1(r, frameCount) {
  const frames = [];
  let time = r.f32();
  let value = r.f32();
  for (let frame = 0, bezier = 0; ; frame++) {
    const entry = { time, value };
    frames.push(entry);
    if (frame === frameCount - 1) break;
    const time2 = r.f32();
    const value2 = r.f32();
    const curves = [];
    const curveByte = r.u8();
    if (curveByte === CURVE_STEPPED) entry.curve = { stepped: true };
    else if (curveByte === CURVE_BEZIER) curves.push(curveFromByte(r, CURVE_BEZIER));
    time = time2;
    value = value2;
    if (curves.length > 0) entry.curve = curves[0];
  }
  return frames;
}

// A two-channel timeline (translate, scale, shear). The runtime reads both values
// even for its X-only/Y-only variants, so both are reported here.
function readTimeline2(r, frameCount) {
  const frames = [];
  let time = r.f32();
  let x = r.f32();
  let y = r.f32();
  for (let frame = 0; ; frame++) {
    const entry = { time, x, y };
    frames.push(entry);
    if (frame === frameCount - 1) break;
    const time2 = r.f32();
    const x2 = r.f32();
    const y2 = r.f32();
    const curveByte = r.u8();
    const curves = [];
    if (curveByte === CURVE_STEPPED) entry.curve = { stepped: true };
    else if (curveByte === CURVE_BEZIER) {
      curves.push(curveFromByte(r, CURVE_BEZIER), curveFromByte(r, CURVE_BEZIER));
    }
    time = time2;
    x = x2;
    y = y2;
    if (curves.length > 0) entry.curve = curves[0];
    if (curves.length > 1) entry.curves = curves;
  }
  return frames;
}

function lastTime(frames) {
  return frames.length > 0 ? frames[frames.length - 1].time : 0;
}

function readColorTimeline(r, frameCount, components) {
  // components: 4 = RGBA, 3 = RGB, 7 = RGBA + RGB dark, 6 = RGB + RGB dark, 1 = alpha.
  const frames = [];
  const colorChannels = components === 7 ? 7 : components;
  let time = r.f32();
  let color = readColorBytes(r, colorChannels);
  for (let frame = 0, bezier = 0; ; frame++) {
    const entry = { time, color };
    frames.push(entry);
    if (frame === frameCount - 1) break;
    const time2 = r.f32();
    const color2 = readColorBytes(r, colorChannels);
    const curveByte = r.u8();
    if (curveByte === CURVE_STEPPED) entry.curve = { stepped: true };
    else if (curveByte === CURVE_BEZIER) {
      const curves = new Array(colorChannels);
      for (let c = 0; c < colorChannels; c++) curves[c] = curveFromByte(r, CURVE_BEZIER);
      entry.curves = curves;
      entry.curve = curves[0];
    }
    time = time2;
    color = color2;
  }
  return frames;
}

// Physics/style categories whose timeline payload is a plain one-channel curve.
const PHYSICS_TIMELINE_TYPES = {
  [PHYSICS_INERTIA]: "physicsInertia",
  [PHYSICS_STRENGTH]: "physicsStrength",
  [PHYSICS_DAMPING]: "physicsDamping",
  [PHYSICS_MASS]: "physicsMass",
  [PHYSICS_WIND]: "physicsWind",
  [PHYSICS_GRAVITY]: "physicsGravity",
  [PHYSICS_MIX]: "physicsMix",
};

function readAnimation(r, name, eventDataList, slotCount) {
  const timelines = [];
  // The file starts each animation with a hint at how many timelines follow; it is
  // only a capacity hint, not needed to read the animation, but a byte-for-byte
  // writer has to reproduce it, so keep it on the model.
  const timelineCountHint = r.count();

  // 1. Slot timelines (attachment + colour).
  for (let i = 0, n = r.count(); i < n; i++) {
    const slotIndex = r.count();
    for (let ii = 0, nn = r.count(); ii < nn; ii++) {
      const type = r.u8();
      const frameCount = r.count();
      switch (type) {
        case SLOT_ATTACHMENT: {
          const frames = [];
          for (let frame = 0; frame < frameCount; frame++) {
            const time = r.f32();
            const frameName = r.stringRef();
            frames.push({ time, name: frameName, nameRef: r.lastStringRef, curve: null });
          }
          timelines.push({ type: "attachment", slotIndex, frames });
          break;
        }
        case SLOT_RGBA: {
          const bezierCount = r.count();
          timelines.push({ type: "color", slotIndex, bezierCount, frames: readColorTimeline(r, frameCount, 4) });
          break;
        }
        case SLOT_RGB: {
          const bezierCount = r.count();
          timelines.push({ type: "color", slotIndex, bezierCount, frames: readColorTimeline(r, frameCount, 3) });
          break;
        }
        case SLOT_RGBA2: {
          const bezierCount = r.count();
          timelines.push({ type: "color", slotIndex, bezierCount, frames: readColorTimeline(r, frameCount, 7) });
          break;
        }
        case SLOT_RGB2: {
          const bezierCount = r.count();
          timelines.push({ type: "color", slotIndex, bezierCount, frames: readColorTimeline(r, frameCount, 6) });
          break;
        }
        case SLOT_ALPHA: {
          const bezierCount = r.count();
          timelines.push({ type: "alpha", slotIndex, bezierCount, frames: readColorTimeline(r, frameCount, 1) });
          break;
        }
        default:
          r.fail(`unknown slot timeline type ${type}`);
      }
    }
  }

  // 2. Bone timelines.
  for (let i = 0, n = r.count(); i < n; i++) {
    const boneIndex = r.count();
    for (let ii = 0, nn = r.count(); ii < nn; ii++) {
      const type = r.u8();
      const frameCount = r.count();
      if (type === BONE_INHERIT) {
        const frames = [];
        for (let frame = 0; frame < frameCount; frame++) {
          frames.push({
            time: r.f32(),
            inherit: enumValue(INHERIT_MODES, r.u8(), r, "inherit mode"),
            curve: null,
          });
        }
        timelines.push({ type: "inherit", boneIndex, frames });
        continue;
      }
      const bezierCount = r.count();
      switch (type) {
        case BONE_ROTATE:
          timelines.push({
            type: "rotate",
            boneIndex,
            bezierCount,
            frames: readTimeline1(r, frameCount).map((f) => ({ time: f.time, angle: f.value, curve: f.curve || null })),
          });
          break;
        case BONE_TRANSLATE:
        case BONE_SCALE:
        case BONE_SHEAR: {
          const kind = type === BONE_TRANSLATE ? "translate" : type === BONE_SCALE ? "scale" : "shear";
          timelines.push({ type: kind, boneIndex, bezierCount, frames: readTimeline2(r, frameCount) });
          break;
        }
        case BONE_TRANSLATEX:
        case BONE_TRANSLATEY:
          timelines.push({
            type: type === BONE_TRANSLATEX ? "translateX" : "translateY",
            boneIndex,
            bezierCount,
            frames: readTimeline2(r, frameCount),
          });
          break;
        case BONE_SCALEX:
        case BONE_SCALEY:
          timelines.push({
            type: type === BONE_SCALEX ? "scaleX" : "scaleY",
            boneIndex,
            bezierCount,
            frames: readTimeline1(r, frameCount).map((f) => ({ time: f.time, scale: f.value, curve: f.curve || null })),
          });
          break;
        case BONE_SHEARX:
        case BONE_SHEARY:
          timelines.push({
            type: type === BONE_SHEARX ? "shearX" : "shearY",
            boneIndex,
            bezierCount,
            frames: readTimeline1(r, frameCount).map((f) => ({ time: f.time, shear: f.value, curve: f.curve || null })),
          });
          break;
        default:
          r.fail(`unknown bone timeline type ${type}`);
      }
    }
  }

  // 3. IK constraint timelines.
  for (let i = 0, n = r.count(); i < n; i++) {
    const index = r.count();
    const frameCount = r.count();
    const bezierCount = r.count();
    const frames = [];
    let flags = r.u8();
    let time = r.f32();
    let mix = (flags & 1) !== 0 ? ((flags & 2) !== 0 ? r.f32() : 1) : 0;
    let softness = (flags & 4) !== 0 ? r.f32() : 0;
    for (let frame = 0, bezier = 0; ; frame++) {
      const entry = {
        time,
        mix,
        softness,
        flags,
        bendDirection: (flags & 8) !== 0 ? 1 : -1,
        compress: (flags & 16) !== 0,
        stretch: (flags & 32) !== 0,
        curve: null,
      };
      frames.push(entry);
      if (frame === frameCount - 1) break;
      flags = r.u8();
      const time2 = r.f32();
      const mix2 = (flags & 1) !== 0 ? ((flags & 2) !== 0 ? r.f32() : 1) : 0;
      const softness2 = (flags & 4) !== 0 ? r.f32() : 0;
      if ((flags & 64) !== 0) entry.curve = { stepped: true };
      else if ((flags & 128) !== 0) {
        const curves = [curveFromByte(r, CURVE_BEZIER), curveFromByte(r, CURVE_BEZIER)];
        entry.curves = curves;
        entry.curve = curves[0];
      }
      time = time2;
      mix = mix2;
      softness = softness2;
    }
    timelines.push({ type: "ik", ikIndex: index, bezierCount, frames });
  }

  // 4. Transform constraint timelines.
  for (let i = 0, n = r.count(); i < n; i++) {
    const index = r.count();
    const frameCount = r.count();
    const bezierCount = r.count();
    const frames = [];
    const readFrameValues = () => ({
      time: r.f32(),
      mixRotate: r.f32(),
      mixX: r.f32(),
      mixY: r.f32(),
      mixScaleX: r.f32(),
      mixScaleY: r.f32(),
      mixShearY: r.f32(),
    });
    let values = readFrameValues();
    for (let frame = 0; ; frame++) {
      const entry = { ...values };
      frames.push(entry);
      if (frame === frameCount - 1) break;
      const next = readFrameValues();
      const curveByte = r.u8();
      if (curveByte === CURVE_STEPPED) entry.curve = { stepped: true };
      else if (curveByte === CURVE_BEZIER) {
        const curves = new Array(6);
        for (let c = 0; c < 6; c++) curves[c] = curveFromByte(r, CURVE_BEZIER);
        entry.curves = curves;
        entry.curve = curves[0];
      }
      values = next;
    }
    timelines.push({ type: "transform", transformIndex: index, bezierCount, frames });
  }

  // 5. Path constraint timelines.
  for (let i = 0, n = r.count(); i < n; i++) {
    const index = r.count();
    for (let ii = 0, nn = r.count(); ii < nn; ii++) {
      const type = r.u8();
      const frameCount = r.count();
      const bezierCount = r.count();
      if (type === PATH_POSITION || type === PATH_SPACING) {
        const frames = readTimeline1(r, frameCount).map((f) => ({
          time: f.time,
          value: f.value,
          curve: f.curve || null,
        }));
        timelines.push({
          type: type === PATH_POSITION ? "pathPosition" : "pathSpacing",
          pathIndex: index,
          bezierCount,
          frames,
        });
        continue;
      }
      if (type !== PATH_MIX) r.fail(`unknown path timeline type ${type}`);
      const frames = [];
      const readMix = () => ({ time: r.f32(), mixRotate: r.f32(), mixX: r.f32(), mixY: r.f32() });
      let mix = readMix();
      for (let frame = 0; ; frame++) {
        const entry = { ...mix };
        frames.push(entry);
        if (frame === frameCount - 1) break;
        const next = readMix();
        const curveByte = r.u8();
        if (curveByte === CURVE_STEPPED) entry.curve = { stepped: true };
        else if (curveByte === CURVE_BEZIER) {
          const curves = [curveFromByte(r, CURVE_BEZIER), curveFromByte(r, CURVE_BEZIER), curveFromByte(r, CURVE_BEZIER)];
          entry.curves = curves;
          entry.curve = curves[0];
        }
        mix = next;
      }
      timelines.push({ type: "pathMix", pathIndex: index, bezierCount, frames });
    }
  }

  // 6. Physics constraint timelines.
  for (let i = 0, n = r.count(); i < n; i++) {
    const index = r.count() - 1;
    for (let ii = 0, nn = r.count(); ii < nn; ii++) {
      const type = r.u8();
      const frameCount = r.count();
      if (type === PHYSICS_RESET) {
        const frames = [];
        for (let frame = 0; frame < frameCount; frame++) frames.push({ time: r.f32(), curve: null });
        timelines.push({ type: "physicsReset", physicsIndex: index, frames });
        continue;
      }
      const bezierCount = r.count();
      const kind = PHYSICS_TIMELINE_TYPES[type];
      if (!kind) r.fail(`unknown physics timeline type ${type}`);
      const frames = readTimeline1(r, frameCount).map((f) => ({
        time: f.time,
        value: f.value,
        curve: f.curve || null,
      }));
      timelines.push({ type: kind, physicsIndex: index, bezierCount, frames });
    }
  }

  // 7. Attachment timelines (deform and sequence).
  for (let i = 0, n = r.count(); i < n; i++) {
    const skinIndex = r.count();
    for (let ii = 0, nn = r.count(); ii < nn; ii++) {
      const slotIndex = r.count();
      for (let iii = 0, nnn = r.count(); iii < nnn; iii++) {
        const attachmentName = r.stringRef();
        const attachmentNameRef = r.lastStringRef;
        const type = r.u8();
        const frameCount = r.count();
        if (type === ATTACHMENT_DEFORM) {
          const bezierCount = r.count();
          const frames = [];
          let time = r.f32();
          for (let frame = 0; ; frame++) {
            // `end` is the number of values in the changed range; `start` is the
            // first vertex offset. Both are absent/zero for an undeformed frame.
            const end = r.count();
            let start = 0;
            let values = [];
            if (end !== 0) {
              start = r.count();
              values = readFloatArray(r, end);
            }
            const entry = { time, start, end, values, curve: null };
            frames.push(entry);
            if (frame === frameCount - 1) break;
            time = r.f32();
            const curveByte = r.u8();
            if (curveByte === CURVE_STEPPED) entry.curve = { stepped: true };
            else if (curveByte === CURVE_BEZIER) {
              const curve = curveFromByte(r, CURVE_BEZIER);
              entry.curves = [curve];
              entry.curve = curve;
            }
          }
          timelines.push({ type: "deform", skinIndex, slotIndex, attachmentName, attachmentNameRef, bezierCount, frames });
          continue;
        }
        if (type !== ATTACHMENT_SEQUENCE) r.fail(`unknown attachment timeline type ${type}`);
        const frames = [];
        for (let frame = 0; frame < frameCount; frame++) {
          const time = r.f32();
          const modeAndIndex = r.i32();
          frames.push({
            time,
            modeAndIndex,
            mode: SEQUENCE_MODES[modeAndIndex & 0xf] ?? null,
            index: modeAndIndex >> 4,
            delay: r.f32(),
            curve: null,
          });
        }
        timelines.push({ type: "sequence", skinIndex, slotIndex, attachmentName, attachmentNameRef, frames });
      }
    }
  }

  // 8. Draw order. The file stores slot index / movement pairs; the timeline's
  // frame value is the resulting slot order, computed the same way as the runtime.
  const drawOrderCount = r.count();
  if (drawOrderCount > 0) {
    const frames = [];
    for (let i = 0; i < drawOrderCount; i++) {
      const time = r.f32();
      const offsetCount = r.count();
      const offsets = [];
      const drawOrder = new Array(slotCount).fill(-1);
      let unchanged = new Array(slotCount - offsetCount);
      let originalIndex = 0;
      let unchangedIndex = 0;
      for (let ii = 0; ii < offsetCount; ii++) {
        const slotIndex = r.count();
        while (originalIndex !== slotIndex) unchanged[unchangedIndex++] = originalIndex++;
        const offset = r.count();
        drawOrder[originalIndex + offset] = originalIndex++;
        offsets.push({ slotIndex, offset });
      }
      while (originalIndex < slotCount) unchanged[unchangedIndex++] = originalIndex++;
      for (let ii = slotCount - 1; ii >= 0; ii--) {
        if (drawOrder[ii] === -1) drawOrder[ii] = unchanged[--unchangedIndex];
      }
      frames.push({ time, offsets, drawOrder, curve: null });
    }
    timelines.push({ type: "drawOrder", frames });
  }

  // 9. Events.
  const eventCount = r.count();
  if (eventCount > 0) {
    const frames = [];
    for (let i = 0; i < eventCount; i++) {
      const time = r.f32();
      const eventIndex = r.count();
      const eventData = eventDataList[eventIndex];
      if (eventData === undefined) r.fail(`event index ${eventIndex} is outside the events table`);
      const intValue = r.sint(); // readInt(false): zigzag variable-length
      const floatValue = r.f32();
      let stringValue = r.string();
      const stringValueNull = stringValue === null;
      if (stringValue === null) stringValue = eventData.stringValue;
      let volume = 1;
      let balance = 0;
      if (eventData.audioPath !== null) {
        volume = r.f32();
        balance = r.f32();
      }
      frames.push({ time, eventIndex, intValue, floatValue, stringValue, stringValueNull, volume, balance, curve: null });
    }
    timelines.push({ type: "events", frames });
  }

  let duration = 0;
  for (const timeline of timelines) duration = Math.max(duration, lastTime(timeline.frames));

  return { name, duration, timelines, timelineCountHint };
}

// ---------------------------------------------------------------------------
// Skeleton
// ---------------------------------------------------------------------------

const SUPPORTED_VERSION = /^4\.2(\.|$)/;

export function readSkeletonBinary(input) {
  const r = new Reader(input, "spine skeleton");
  const skeleton = {};

  // Header.
  const hashBytes = [];
  for (let i = 0; i < 8; i++) hashBytes.push(r.u8());
  const hash = hashBytes.some((b) => b !== 0) ? hashBytes.map((b) => b.toString(16).padStart(2, "0")).join("") : null;
  const versionOffset = r.pos;
  const version = r.string();
  if (version === null || !SUPPORTED_VERSION.test(version)) {
    throw new Error(
      `spine skeleton: unsupported version ${JSON.stringify(version)} at byte offset ${versionOffset} ` +
      `(0x${versionOffset.toString(16)}); this reader handles 4.2.x`,
    );
  }
  const x = r.f32();
  const y = r.f32();
  const width = r.f32();
  const height = r.f32();
  const referenceScale = r.f32();
  const nonessential = r.bool();
  const fps = nonessential ? r.f32() : 30;
  const imagesPath = nonessential ? r.string() : null;
  const audioPath = nonessential ? r.string() : null;

  // String table: every attachment name/path referenced by index later on.
  const stringCount = r.count();
  r.strings = new Array(stringCount);
  for (let i = 0; i < stringCount; i++) r.strings[i] = r.string();

  // Bones.
  const bones = [];
  for (let i = 0, n = r.count(); i < n; i++) {
    const name = r.string();
    const parentIndex = i === 0 ? null : r.count();
    const bone = {
      index: i,
      name,
      parentIndex,
      rotation: r.f32(),
      x: r.f32(),
      y: r.f32(),
      scaleX: r.f32(),
      scaleY: r.f32(),
      shearX: r.f32(),
      shearY: r.f32(),
      length: r.f32(),
      transformMode: null,
      inherit: null,
      skinRequired: false,
      color: null,
      icon: null,
      visible: true,
    };
    bone.inherit = enumValue(INHERIT_MODES, r.u8(), r, "inherit mode");
    bone.transformMode = bone.inherit; // 3.8 name for the same field
    bone.skinRequired = r.bool();
    if (nonessential) {
      bone.color = colorFromRgba(r.i32());
      bone.icon = r.string();
      bone.visible = r.bool();
    }
    bones.push(bone);
  }

  // Slots.
  const slots = [];
  for (let i = 0, n = r.count(); i < n; i++) {
    const name = r.string();
    const boneIndex = r.count();
    if (bones[boneIndex] === undefined) r.fail(`slot ${JSON.stringify(name)} names missing bone ${boneIndex}`);
    const color = colorFromRgba(r.i32());
    const darkColorValue = r.i32();
    const darkColor = darkColorValue === -1 ? null : colorFromRgb(darkColorValue);
    const attachmentName = r.stringRef();
    const attachmentNameRef = r.lastStringRef;
    const blendMode = enumValue(BLEND_MODES, r.count(), r, "blend mode");
    const visible = nonessential ? r.bool() : true;
    slots.push({ index: i, name, boneIndex, color, darkColor, attachmentName, attachmentNameRef, blendMode, visible });
  }

  // IK constraints.
  const ik = [];
  for (let i = 0, n = r.count(); i < n; i++) {
    const name = r.string();
    const order = r.count();
    const boneIndices = [];
    for (let ii = 0, nn = r.count(); ii < nn; ii++) boneIndices.push(r.count());
    const targetIndex = r.count();
    const flags = r.u8();
    const constraint = {
      index: i,
      name,
      order,
      boneIndices,
      targetIndex,
      flags,
      skinRequired: (flags & 1) !== 0,
      bendDirection: (flags & 2) !== 0 ? 1 : -1,
      compress: (flags & 4) !== 0,
      stretch: (flags & 8) !== 0,
      uniform: (flags & 16) !== 0,
      mix: 1,
      softness: 0,
    };
    if ((flags & 32) !== 0) constraint.mix = (flags & 64) !== 0 ? r.f32() : 1;
    if ((flags & 128) !== 0) constraint.softness = r.f32();
    ik.push(constraint);
  }

  // Transform constraints.
  const transform = [];
  for (let i = 0, n = r.count(); i < n; i++) {
    const name = r.string();
    const order = r.count();
    const boneIndices = [];
    for (let ii = 0, nn = r.count(); ii < nn; ii++) boneIndices.push(r.count());
    const targetIndex = r.count();
    let flags = r.u8();
    const constraint = {
      index: i,
      name,
      order,
      boneIndices,
      targetIndex,
      flags,
      skinRequired: (flags & 1) !== 0,
      local: (flags & 2) !== 0,
      relative: (flags & 4) !== 0,
      offsetRotation: 0,
      offsetX: 0,
      offsetY: 0,
      offsetScaleX: 0,
      offsetScaleY: 0,
      offsetShearY: 0,
      mixRotate: 1,
      mixX: 1,
      mixY: 1,
      mixScaleX: 1,
      mixScaleY: 1,
      mixShearY: 1,
    };
    if ((flags & 8) !== 0) constraint.offsetRotation = r.f32();
    if ((flags & 16) !== 0) constraint.offsetX = r.f32();
    if ((flags & 32) !== 0) constraint.offsetY = r.f32();
    if ((flags & 64) !== 0) constraint.offsetScaleX = r.f32();
    if ((flags & 128) !== 0) constraint.offsetScaleY = r.f32();
    flags = r.u8();
    if ((flags & 1) !== 0) constraint.offsetShearY = r.f32();
    if ((flags & 2) !== 0) constraint.mixRotate = r.f32();
    if ((flags & 4) !== 0) constraint.mixX = r.f32();
    if ((flags & 8) !== 0) constraint.mixY = r.f32();
    if ((flags & 16) !== 0) constraint.mixScaleX = r.f32();
    if ((flags & 32) !== 0) constraint.mixScaleY = r.f32();
    if ((flags & 64) !== 0) constraint.mixShearY = r.f32();
    constraint.flags2 = flags;
    transform.push(constraint);
  }

  // Path constraints.
  const path = [];
  for (let i = 0, n = r.count(); i < n; i++) {
    const name = r.string();
    const order = r.count();
    const skinRequired = r.bool();
    const boneIndices = [];
    for (let ii = 0, nn = r.count(); ii < nn; ii++) boneIndices.push(r.count());
    const targetSlotIndex = r.count();
    const flags = r.u8();
    const constraint = {
      index: i,
      name,
      order,
      skinRequired,
      boneIndices,
      targetSlotIndex,
      flags,
      positionMode: enumValue(POSITION_MODES, flags & 1, r, "path position mode"),
      spacingMode: enumValue(SPACING_MODES, (flags >> 1) & 3, r, "path spacing mode"),
      rotateMode: enumValue(ROTATE_MODES, (flags >> 3) & 3, r, "path rotate mode"),
      offsetRotation: 0,
      position: 0,
      spacing: 0,
      mixRotate: 0,
      mixX: 0,
      mixY: 0,
    };
    if ((flags & 128) !== 0) constraint.offsetRotation = r.f32();
    constraint.position = r.f32();
    constraint.spacing = r.f32();
    constraint.mixRotate = r.f32();
    constraint.mixX = r.f32();
    constraint.mixY = r.f32();
    path.push(constraint);
  }

  // Physics constraints.
  const physics = [];
  for (let i = 0, n = r.count(); i < n; i++) {
    const name = r.string();
    const order = r.count();
    const boneIndex = r.count();
    const flags = r.u8();
    const constraint = {
      index: i,
      name,
      order,
      boneIndex,
      flags,
      skinRequired: (flags & 1) !== 0,
      x: 0,
      y: 0,
      rotate: 0,
      scaleX: 0,
      shearX: 0,
      limit: 5000,
      step: 0,
      inertia: 0,
      strength: 0,
      damping: 0,
      massInverse: 1,
      wind: 0,
      gravity: 0,
      inertiaGlobal: false,
      strengthGlobal: false,
      dampingGlobal: false,
      massGlobal: false,
      windGlobal: false,
      gravityGlobal: false,
      mixGlobal: false,
      mix: 1,
    };
    if ((flags & 2) !== 0) constraint.x = r.f32();
    if ((flags & 4) !== 0) constraint.y = r.f32();
    if ((flags & 8) !== 0) constraint.rotate = r.f32();
    if ((flags & 16) !== 0) constraint.scaleX = r.f32();
    if ((flags & 32) !== 0) constraint.shearX = r.f32();
    constraint.limit = (flags & 64) !== 0 ? r.f32() : 5000;
    const stepDivisor = r.u8();
    constraint.stepDivisor = stepDivisor;
    constraint.step = stepDivisor === 0 ? 0 : 1 / stepDivisor;
    constraint.inertia = r.f32();
    constraint.strength = r.f32();
    constraint.damping = r.f32();
    constraint.massInverse = (flags & 128) !== 0 ? r.f32() : 1;
    constraint.wind = r.f32();
    constraint.gravity = r.f32();
    const flags2 = r.u8();
    constraint.inertiaGlobal = (flags2 & 1) !== 0;
    constraint.strengthGlobal = (flags2 & 2) !== 0;
    constraint.dampingGlobal = (flags2 & 4) !== 0;
    constraint.massGlobal = (flags2 & 8) !== 0;
    constraint.windGlobal = (flags2 & 16) !== 0;
    constraint.gravityGlobal = (flags2 & 32) !== 0;
    constraint.mixGlobal = (flags2 & 64) !== 0;
    constraint.mix = (flags2 & 128) !== 0 ? r.f32() : 1;
    constraint.flags2 = flags2;
    physics.push(constraint);
  }

  // Skins. The default skin has no name in the file and is only present when it
  // has at least one slot; named skins follow. Only named skins store a color,
  // bone list and constraint list; for the default skin those fields stay empty.
  const skins = [];
  const defaultSlotCount = r.count();
  if (defaultSlotCount !== 0) {
    const skin = { name: "default", isDefault: true, color: null, bones: [], constraints: [], attachments: [] };
    // readSkin already consumed the slot count; read its contents from here.
    for (let i = 0; i < defaultSlotCount; i++) {
      const slotIndex = r.count();
      const attachmentCount = r.count();
      for (let ii = 0; ii < attachmentCount; ii++) {
        const key = r.stringRef();
        const keyRef = r.lastStringRef;
        const attachment = readAttachment(r, slotIndex, key, nonessential);
        attachment.nameRef = keyRef;
        skin.attachments.push(attachment);
      }
    }
    skins.push(skin);
  }

  for (let i = 0, n = r.count(); i < n; i++) {
    const skin = {
      name: r.string(),
      color: nonessential ? colorFromRgba(r.i32()) : [1, 1, 1, 1],
      bones: [],
      constraints: [],
      attachments: [],
    };
    for (let ii = 0, nn = r.count(); ii < nn; ii++) skin.bones.push(r.count());
    for (let ii = 0, nn = r.count(); ii < nn; ii++) skin.constraints.push({ type: "ik", index: r.count() });
    for (let ii = 0, nn = r.count(); ii < nn; ii++) skin.constraints.push({ type: "transform", index: r.count() });
    for (let ii = 0, nn = r.count(); ii < nn; ii++) skin.constraints.push({ type: "path", index: r.count() });
    for (let ii = 0, nn = r.count(); ii < nn; ii++) skin.constraints.push({ type: "physics", index: r.count() });
    for (let ii = 0, slotCount = r.count(); ii < slotCount; ii++) {
      const slotIndex = r.count();
      for (let iii = 0, attachmentCount = r.count(); iii < attachmentCount; iii++) {
        const key = r.stringRef();
        const keyRef = r.lastStringRef;
        const attachment = readAttachment(r, slotIndex, key, nonessential);
        attachment.nameRef = keyRef;
        skin.attachments.push(attachment);
      }
    }
    skins.push(skin);
  }

  // Events.
  const events = [];
  for (let i = 0, n = r.count(); i < n; i++) {
    const name = r.string();
    const intValue = r.sint();
    const floatValue = r.f32();
    const stringValue = r.string();
    const audioPath = r.string();
    const volume = audioPath !== null ? r.f32() : 1;
    const balance = audioPath !== null ? r.f32() : 0;
    events.push({ index: i, name, intValue, floatValue, stringValue, audioPath, volume, balance });
  }

  // Animations. The draw-order timeline needs the slot count, so hand it over.
  const animations = [];
  for (let i = 0, n = r.count(); i < n; i++) {
    const name = r.string();
    animations.push(readAnimation(r, name, events, slots.length));
  }

  if (r.pos !== r.bytes.length) {
    throw new Error(
      `spine skeleton: ${r.bytes.length - r.pos} unconsumed byte(s) after the last animation ` +
      `at byte offset ${r.pos} (0x${r.pos.toString(16)})`,
    );
  }

  return {
    version,
    hash,
    bytesRead: r.pos,
    x,
    y,
    width,
    height,
    fps,
    referenceScale,
    nonessential,
    imagesPath,
    audioPath,
    strings: r.strings,
    bones,
    slots,
    ik,
    transform,
    path,
    physics,
    skins,
    events,
    animations,
  };
}

// ---------------------------------------------------------------------------
// Text atlas
// ---------------------------------------------------------------------------

/**
 * Parse a Spine/libGDX text atlas.
 *
 * A page starts with the image file name, then `key: value` lines
 * (`size`, `filter`, `pma`, ...). Regions follow: a name line, then
 * `bounds`/`offsets`/`rotate`/`index` lines. Blank lines and `#` comments are
 * ignored. Region `rotate` becomes 0, 90, 180 or 270 degrees.
 */
export function parseAtlas(text) {
  if (typeof text !== "string") throw new TypeError("parseAtlas: expected a string");
  const lines = text.split(/\r?\n/);
  const pages = [];
  let page = null;
  let region = null;
  const fail = (lineNumber, message) => {
    throw new Error(`atlas line ${lineNumber}: ${message}`);
  };

  for (let i = 0; i < lines.length; i++) {
    const lineNumber = i + 1;
    const line = lines[i].trim();
    if (line === "" || line.startsWith("#")) continue;

    const colon = line.indexOf(":");
    if (colon > 0) {
      if (page === null) fail(lineNumber, `property "${line}" appears before any page name`);
      const key = line.slice(0, colon).trim().toLowerCase();
      const value = line.slice(colon + 1).trim();
      if (region === null) applyPageProperty(page, key, value, lineNumber, fail);
      else applyRegionProperty(region, key, value, lineNumber, fail);
      continue;
    }

    // A bare line is a page image name or a region name.
    if (page === null || /\.(png|jpe?g|webp|bmp|gif)$/i.test(line)) {
      page = {
        name: line,
        size: null,
        filter: null,
        pma: false,
        format: null,
        repeat: null,
        properties: {},
        regions: [],
      };
      pages.push(page);
      region = null;
    } else {
      region = {
        name: line,
        page: page.name,
        x: 0,
        y: 0,
        w: 0,
        h: 0,
        rotate: 0,
        offsetX: 0,
        offsetY: 0,
        origWidth: 0,
        origHeight: 0,
        index: -1,
        properties: {},
        hasBounds: false,
        hasOffsets: false,
      };
      page.regions.push(region);
    }
  }

  for (const p of pages) {
    if (p.size === null) throw new Error(`atlas page "${p.name}": missing size line`);
    for (const region of p.regions) {
      if (!region.hasBounds) throw new Error(`atlas region "${region.name}": missing bounds line`);
    }
  }
  return { pages };
}

function parseIntegers(value, count, fail, label, lineNumber) {
  const parts = value.split(",").map((part) => part.trim());
  if (parts.length !== count || parts.some((part) => !/^-?\d+$/.test(part))) {
    fail(lineNumber, `${label} expects ${count} integers separated by commas, got "${value}"`);
  }
  return parts.map(Number);
}

function applyPageProperty(page, key, value, lineNumber, fail) {
  switch (key) {
    case "size": {
      const [w, h] = parseIntegers(value, 2, fail, "size", lineNumber);
      page.size = { w, h };
      break;
    }
    case "filter": {
      const parts = value.split(",").map((part) => part.trim());
      page.filter = { min: parts[0], mag: parts[1] ?? parts[0] };
      break;
    }
    case "pma":
      if (value !== "true" && value !== "false") fail(lineNumber, `pma expects true or false, got "${value}"`);
      page.pma = value === "true";
      break;
    case "format":
      page.format = value;
      break;
    case "repeat":
      page.repeat = value;
      break;
    default:
      // Unknown page properties are kept verbatim, not rejected: future exporters
      // may add some and they do not change the region geometry.
      page.properties[key] = value;
  }
}

function applyRegionProperty(region, key, value, lineNumber, fail) {
  switch (key) {
    case "bounds": {
      const [x, y, w, h] = parseIntegers(value, 4, fail, "bounds", lineNumber);
      region.x = x;
      region.y = y;
      region.w = w;
      region.h = h;
      region.hasBounds = true;
      break;
    }
    case "offsets": {
      const [offsetX, offsetY, origWidth, origHeight] = parseIntegers(value, 4, fail, "offsets", lineNumber);
      region.offsetX = offsetX;
      region.offsetY = offsetY;
      region.origWidth = origWidth;
      region.origHeight = origHeight;
      region.hasOffsets = true;
      break;
    }
    case "rotate":
      if (value === "true") region.rotate = 90;
      else if (value === "false" || value === "") region.rotate = 0;
      else if (/^\d+$/.test(value) && (value === "90" || value === "180" || value === "270")) region.rotate = Number(value);
      else fail(lineNumber, `rotate expects true, false, 90, 180 or 270, got "${value}"`);
      break;
    case "index":
      if (!/^-?\d+$/.test(value)) fail(lineNumber, `index expects an integer, got "${value}"`);
      region.index = Number(value);
      break;
    default:
      region.properties[key] = value;
  }
}
