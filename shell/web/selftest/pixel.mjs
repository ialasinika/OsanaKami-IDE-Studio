/* ------------------------------------------------------------------ */
/* a PNG is a file, and the pixel card's colour opinion
/* ------------------------------------------------------------------ */

import assert from "node:assert/strict";
import {
  readFileSync,
} from "node:fs";
import {
  inflateSync,
} from "node:zlib";
import {
  pixelColourOf,
  pixelInkOf,
  pixelPaletteOf,
} from "../cards.mjs";
import {
  PNG_SIGNATURE,
  blankImage,
  decodePng,
  encodePng,
  pixelAt,
  setPixelAt,
} from "../pixelpng.mjs";
import {
  applyMatrix,
  bezierValue,
  easeFraction,
  frameWindow,
  localPoses,
  mergedSkins,
  regionCorners,
  sceneAt,
  slotAttachmentName,
  slotColorAt,
  worldTransforms,
} from "../spinepose.mjs";
import {
  test,
} from "./harness.mjs";

/* ------------------------------------------------------------------ */
/* a PNG is a file, and reading one is the page's own job               */
/* ------------------------------------------------------------------ */

/*
 * The fixtures were written by an independent writer
 * (`build/make_pixel_fixtures.mjs`, which deflates with the platform zlib and
 * computes its own CRCs instead of asking this module): a 4x5 RGBA image whose
 * five rows use filter types 0..4 in turn, the same image deflated into stored
 * blocks, a 2x1 RGB image with no alpha channel, and one real 6x3 export out of
 * the mod corpus. A decoder that inherited this module's bugs cannot have
 * inherited the fixtures too.
 */
export const PNG_FILTERED = "iVBORw0KGgoAAAANSUhEUgAAAAQAAAAFCAYAAABirU3bAAAAPElEQVR42mNgYGD4b8Mq+K2CS+ntFn7jJ4zcRuLfbFgFv8MwE7eR+HdkzCyWopenIiPyHYZZwDKsgnAMAEvvGZivNw1JAAAAAElFTkSuQmCC";
export const PNG_STORED = "iVBORw0KGgoAAAANSUhEUgAAAAQAAAAFCAYAAABirU3bAAAAYElEQVR4AQFVAKr/AAAAAP88BRH2eAoi7bQPM+QBCzIX9jwFEfc8BRH3PAUR9wILMhf3CzIX9wsyF/cLMhf3AxZkLm4kHBT3JBwU9yQcFPcECzIX9wsFEfcLBRH3CwUR90vvGZjdUsDJAAAAAElFTkSuQmCC";
export const PNG_RGB = "iVBORw0KGgoAAAANSUhEUgAAAAIAAAABCAIAAAB7QOjdAAAAD0lEQVR42mPgEpE7MS0FAAUHAf+/Bwq6AAAAAElFTkSuQmCC";
export const PNG_CORPUS = "iVBORw0KGgoAAAANSUhEUgAAAAYAAAADCAYAAACwAX77AAAAFUlEQVR4XmNgwAfq49L/w2gYGycAAPfpBspw35zwAAAAAElFTkSuQmCC";

export const pngBytes = (base64) => new Uint8Array(Buffer.from(base64, "base64"));

/* What went into PNG_FILTERED, worked out here from the formula the fixture
   writer used. The numbers come from the arithmetic, not from the module, so a
   decoder that is merely self-consistent still fails this. */
export function pngFilteredPixels() {
  const expected = new Uint8Array(4 * 5 * 4);
  for (let y = 0; y < 5; y += 1) {
    for (let x = 0; x < 4; x += 1) {
      const at = (y * 4 + x) * 4;
      expected[at] = (x * 60 + y * 11) % 256;
      expected[at + 1] = (x * 5 + y * 50) % 256;
      expected[at + 2] = (x * 17 + y * 23) % 256;
      expected[at + 3] = 255 - (x + y) * 9;
    }
  }
  return expected;
}

export const PNG_CRC_TABLE = (() => {
  const table = new Int32Array(256);
  for (let n = 0; n < 256; n += 1) {
    let c = n;
    for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c;
  }
  return table;
})();

export function pngCrc32(bytes) {
  let c = 0xffffffff;
  for (const byte of bytes) c = PNG_CRC_TABLE[(c ^ byte) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

test("pixelpng: the module imports nothing, reads no clock and touches no DOM", () => {
  const code = readFileSync(new URL("../pixelpng.mjs", import.meta.url), "utf8");
  assert.equal(/^\s*import\b/m.test(code), false, "no imports");
  assert.equal(/\bwindow\b|\bdocument\b|\blocalStorage\b/.test(code), false, "no DOM");
  assert.equal(/Math\.random|Date\.now|new Date\(/.test(code), false, "no clock, no randomness");
});

test("pixelpng: a blank image is the size asked for, and transparent", () => {
  const blank = blankImage(3, 2);
  assert.equal(blank.width, 3);
  assert.equal(blank.height, 2);
  assert.equal(blank.pixels.length, 24, "three by two, four channels each");
  assert.equal(blank.pixels.every((byte) => byte === 0), true);
  const red = blankImage(2, 1, [255, 0, 0, 255]);
  assert.deepEqual(pixelAt(red, 0, 0), [255, 0, 0, 255]);
  assert.deepEqual(pixelAt(red, 1, 0), [255, 0, 0, 255]);
});

test("pixelpng: a pixel outside the image is null, and writing one is a no-op", () => {
  const image = blankImage(2, 1);
  assert.equal(pixelAt(image, -1, 0), null);
  assert.equal(pixelAt(image, 2, 0), null);
  assert.equal(pixelAt(image, 0, 1), null);
  setPixelAt(image, 9, 9, [1, 2, 3, 4]);
  assert.equal(image.pixels.every((byte) => byte === 0), true, "nothing was written");
  setPixelAt(image, 1, 0, [9, 8, 7, 6]);
  assert.deepEqual(pixelAt(image, 1, 0), [9, 8, 7, 6]);
  assert.deepEqual(pixelAt(image, 0, 0), [0, 0, 0, 0], "its neighbour is untouched");
});

test("pixelpng: all five row filters decode to the pixels that went in", () => {
  const expected = pngFilteredPixels();
  const decoded = decodePng(pngBytes(PNG_FILTERED));
  assert.equal(decoded.width, 4);
  assert.equal(decoded.height, 5);
  assert.deepEqual([...decoded.pixels], [...expected]);
  /* The same pixels, deflated into stored blocks rather than Huffman-coded. */
  assert.deepEqual([...decodePng(pngBytes(PNG_STORED)).pixels], [...expected]);
  /* A Node Buffer is as acceptable as a Uint8Array. */
  assert.deepEqual([...decodePng(Buffer.from(PNG_FILTERED, "base64")).pixels], [...expected]);
});

test("pixelpng: a file with no alpha channel decodes opaque", () => {
  const decoded = decodePng(pngBytes(PNG_RGB));
  assert.equal(decoded.width, 2);
  assert.equal(decoded.height, 1);
  assert.deepEqual(pixelAt(decoded, 0, 0), [10, 20, 30, 255], "no alpha byte means fully opaque");
  assert.deepEqual(pixelAt(decoded, 1, 0), [200, 150, 100, 255]);
});

test("pixelpng: a real exporter's file comes back at the size its own header says", () => {
  const bytes = pngBytes(PNG_CORPUS);
  const decoded = decodePng(bytes);
  /* The width and height are read here, out of the raw IHDR, so the decoder is
     not the only witness to its own answer. */
  assert.equal(decoded.width, bytes[19] | (bytes[18] << 8) | (bytes[17] << 16) | (bytes[16] << 24));
  assert.equal(decoded.height, bytes[23] | (bytes[22] << 8) | (bytes[21] << 16) | (bytes[20] << 24));
  assert.equal(decoded.width, 6);
  assert.equal(decoded.height, 3);
  assert.deepEqual([...decodePng(encodePng(decoded)).pixels], [...decoded.pixels]);
});

test("pixelpng: a PNG this reader does not decode is refused, not guessed at", () => {
  const withByte = (offset, value) => {
    const bytes = pngBytes(PNG_FILTERED);
    bytes[offset] = value;
    return bytes;
  };
  // assert.throws matches its pattern against String(error), which begins with
  // "Error: ", so these patterns are not anchored at the start of the message.
  assert.throws(() => decodePng(withByte(25, 3)), /unsupported PNG: /, "a palette image");
  assert.throws(() => decodePng(withByte(25, 0)), /unsupported PNG: /, "greyscale");
  assert.throws(() => decodePng(withByte(24, 4)), /unsupported PNG: /, "four bits per sample");
  assert.throws(() => decodePng(withByte(28, 1)), /unsupported PNG: /, "interlaced");
  assert.throws(() => decodePng(Buffer.from("title: T\n---\n")), /not a PNG/);
  assert.throws(() => decodePng(new Uint8Array(2)), /not a PNG/);
  assert.throws(() => decodePng(pngBytes(PNG_FILTERED).slice(0, 40)), /damaged PNG: /,
    "a stream that stops early");
});

test("pixelpng: what it writes is a PNG, chunk for chunk", () => {
  const image = blankImage(3, 2);
  setPixelAt(image, 0, 0, [1, 2, 3, 4]);
  setPixelAt(image, 2, 1, [250, 251, 252, 253]);
  const bytes = encodePng(image);
  assert.deepEqual([...bytes.slice(0, 8)], [...PNG_SIGNATURE]);
  const chunks = [];
  for (let at = 8; at + 12 <= bytes.length;) {
    const length = (bytes[at] << 24) | (bytes[at + 1] << 16) | (bytes[at + 2] << 8) | bytes[at + 3];
    const type = String.fromCharCode(...bytes.slice(at + 4, at + 8));
    const data = bytes.slice(at + 8, at + 8 + length);
    /* A chunk's CRC covers its type as well as its data; hashing the data alone
       still leaves a file most readers accept, so this is checked here. */
    const stated = ((bytes[at + 8 + length] << 24) | (bytes[at + 8 + length + 1] << 16)
      | (bytes[at + 8 + length + 2] << 8) | bytes[at + 8 + length + 3]) >>> 0;
    assert.equal(stated, pngCrc32(bytes.slice(at + 4, at + 8 + length)), `${type} chunk CRC`);
    chunks.push({ type, data });
    at += 12 + length;
  }
  assert.deepEqual(chunks.map((chunk) => chunk.type), ["IHDR", "IDAT", "IEND"]);
  assert.deepEqual([...chunks[0].data], [0, 0, 0, 3, 0, 0, 0, 2, 8, 6, 0, 0, 0],
    "three by two, eight bits a sample, colour type 6, not interlaced");
  /* Inside the stream: filter byte zero, then the image's own bytes, twice. */
  const raw = inflateSync(Buffer.from(chunks[1].data));
  assert.equal(raw.length, 2 * (1 + 3 * 4));
  assert.equal(raw[0], 0);
  assert.equal(raw[13], 0, "the second row carries its own filter byte");
  assert.deepEqual([...raw.slice(1, 13)], [...image.pixels.slice(0, 12)]);
  assert.deepEqual([...raw.slice(14)], [...image.pixels.slice(12)]);
});

test("pixelpng: a round trip through the channels comes back the same", () => {
  for (let width = 1; width <= 5; width += 1) {
    const image = blankImage(width, 1);
    for (let x = 0; x < width; x += 1) {
      setPixelAt(image, x, 0, [x * 50, 255 - x * 50, 128, x === 0 ? 0 : 255]);
    }
    const back = decodePng(encodePng(image));
    assert.equal(back.width, width);
    assert.deepEqual([...back.pixels], [...image.pixels], `width ${width}`);
  }
  const one = blankImage(1, 1, [0, 255, 128, 7]);
  assert.deepEqual([...decodePng(encodePng(one)).pixels], [0, 255, 128, 7]);
});

/* ------------------------------------------------------------------ */
/* the pixel card's colour opinion                                     */
/* ------------------------------------------------------------------ */

/*
 * The canvas half of a pixel card needs a browser and is covered by
 * `tools/input_smoke.py` instead. What is left over is the part between the
 * board document and the pixels: a palette is stored as strings, and the card
 * is the only thing that turns them into colours. These four checks pin that
 * down, because a palette that quietly loses an entry would come back on the
 * next board load as a different palette.
 */

test("pixel card: a stored palette is read back as the colours that went in", () => {
  assert.deepEqual(pixelPaletteOf(["#abc", "#112233", "#ABC"]), ["#aabbcc", "#112233", "#aabbcc"]);
});

test("pixel card: a palette with nothing usable in it falls back to the default", () => {
  for (const value of [null, undefined, [], "not a list", ["red", "#12345", 7], [null, {}]]) {
    const palette = pixelPaletteOf(value);
    assert.equal(palette.length, 16, `${JSON.stringify(value)} must give the default palette`);
    for (const colour of palette) {
      assert.match(colour, /^#[0-9a-f]{6}$/, `${JSON.stringify(value)} gave ${colour}`);
    }
  }
  assert.deepEqual(pixelPaletteOf(["nope"]), pixelPaletteOf([]));
});

test("pixel card: a colour is #rrggbb, or #rgb, or it is not a colour", () => {
  assert.deepEqual(pixelColourOf("#ff8000"), [255, 128, 0, 255]);
  assert.deepEqual(pixelColourOf("abc"), [170, 187, 204, 255], "the short form doubles each digit");
  assert.deepEqual(pixelColourOf("  #000000  "), [0, 0, 0, 255], "surrounding space is not part of the colour");
  for (const bad of ["", "#", "#12345", "#1234567", "red", "rgb(1,2,3)", null, 12, {}]) {
    assert.equal(pixelColourOf(bad), null, `${JSON.stringify(bad)} is not a colour`);
  }
});

test("pixel card: the readout shows a pixel's colour, and grey where there is none", () => {
  assert.equal(pixelInkOf([1, 2, 3, 255]), "#010203");
  assert.equal(pixelInkOf([255, 0, 128, 0]), "#ff0080", "a transparent pixel still has a colour to show");
  assert.equal(pixelInkOf(null), pixelInkOf(undefined), "nothing under the pointer is one answer, not two");
  assert.match(pixelInkOf(null), /^#[0-9a-f]{6}$/);
});

/* ------------------------------------------------------------------ */
/*
 * Spine's arithmetic, before there is a card to show it in.
 *
 * These are whole-corner comparisons on purpose: a bone order mistake or a
 * transposed matrix still produces plausible numbers, and a test that only
 * looked at one coordinate would not notice.
 */
export function spineBone(name, parentIndex, extra = {}) {
  return {
    name,
    parentIndex,
    rotation: 0,
    x: 0,
    y: 0,
    scaleX: 1,
    scaleY: 1,
    shearX: 0,
    shearY: 0,
    length: 0,
    transformMode: 0,
    ...extra,
  };
}

export function spineRig(bones, extra = {}) {
  return { version: "4.2.43", bones, slots: [], skins: [], animations: [], ...extra };
}

export const near = (got, want) => Math.abs(got - want) <= 1e-9;

test("spine pose: a child bone follows its parent's quarter turn", () => {
  const rig = spineRig([spineBone("root", -1, { rotation: 90 }), spineBone("child", 0, { x: 10 })]);
  const world = worldTransforms(rig, null, 0);
  assert.ok(near(world[1].e, 0), `child x was ${world[1].e}`);
  assert.ok(near(world[1].f, 10), `child y was ${world[1].f}`);
});

test("spine pose: a parent's scale lengthens the child's reach", () => {
  const rig = spineRig([spineBone("root", -1, { scaleX: 2, scaleY: 2 }), spineBone("child", 0, { x: 10 })]);
  assert.ok(near(worldTransforms(rig, null, 0)[1].e, 20));
});

test("spine pose: a region sits centred on its bone", () => {
  const matrix = { a: 1, b: 0, c: 0, d: 1, e: 0, f: 0 };
  const corners = regionCorners({ width: 10, height: 4, x: 0, y: 0, rotation: 0, scaleX: 1, scaleY: 1 }, matrix);
  assert.deepEqual(corners.map((point) => [point.x, point.y]), [[-5, -2], [5, -2], [5, 2], [-5, 2]]);
  const moved = applyMatrix(matrix, 3, 4);
  assert.deepEqual([moved.x, moved.y], [3, 4], "a matrix with no rotation is the identity");
});

test("spine pose: a region turns with its bone, corners and all", () => {
  const rig = spineRig([spineBone("root", -1, { rotation: 90 })]);
  const corners = regionCorners(
    { width: 10, height: 4, x: 0, y: 0, rotation: 0, scaleX: 1, scaleY: 1 },
    worldTransforms(rig, null, 0)[0],
  );
  // A quarter turn maps (x, y) to (-y, x); the rectangle stands on end.
  assert.deepEqual(corners.map((point) => Math.round(point.x)), [2, 2, -2, -2]);
  assert.deepEqual(corners.map((point) => Math.round(point.y)), [-5, 5, 5, -5]);
});

test("spine pose: a rotate timeline is read halfway between its frames", () => {
  const rig = spineRig([spineBone("root", -1), spineBone("child", 0, { x: 10 })]);
  const animation = { name: "a", duration: 1, timelines: [
    { type: "rotate", boneIndex: 0, frames: [{ time: 0, angle: 0, curve: null }, { time: 1, angle: 90 }] },
  ] };
  const world = worldTransforms(rig, animation, 0.5);
  assert.ok(near(world[1].e, Math.cos(Math.PI / 4) * 10));
  assert.ok(near(world[1].f, Math.sin(Math.PI / 4) * 10));
});

test("spine pose: the local pose is the number a drag edits, before parents compose it", () => {
  const rig = spineRig([spineBone("root", -1), spineBone("child", 0, { x: 10 })]);
  const animation = { name: "a", duration: 1, timelines: [
    { type: "rotate", boneIndex: 0, frames: [{ time: 0, angle: 0 }, { time: 1, angle: 90 }] },
  ] };
  const pose = localPoses(rig, animation, 0.5);
  assert.equal(pose.length, 2);
  assert.equal(Math.round(pose[0].rotation), 45, "halfway between the frames");
  assert.equal(pose[1].x, 10, "a bone the animation does not touch keeps its setup numbers");
  assert.deepEqual(localPoses(rig, null, 0)[0], {
    rotation: 0, x: 0, y: 0, scaleX: 1, scaleY: 1, shearX: 0, shearY: 0,
  });
});

test("spine pose: a stepped frame holds its value, a linear one moves", () => {
  assert.equal(easeFraction({ stepped: true }, 0.9), 0);
  assert.equal(easeFraction(null, 0.25), 0.25);
  assert.ok(bezierValue({ cx1: 0.42, cy1: 0, cx2: 1, cy2: 1 }, 0.5) < 0.5, "an ease-in starts slowly");
  assert.equal(bezierValue({ cx1: 0, cy1: 0, cx2: 1, cy2: 1 }, 1), 1);
});

test("spine pose: a time outside the animation is clamped, not extrapolated", () => {
  const frames = [{ time: 0, angle: 0 }, { time: 1, angle: 90 }];
  assert.equal(frameWindow(frames, -5).before, true);
  assert.equal(frameWindow(frames, 5).after, true);
  assert.equal(frameWindow(frames, 0.25).fraction, 0.25);
  assert.equal(frameWindow([], 0), null, "no frames is no window");
});

test("spine pose: a bone that names itself as its parent still has a place", () => {
  const rig = spineRig([spineBone("weird", 0)]);
  const world = worldTransforms(rig, null, 0);
  assert.deepEqual([world[0].e, world[0].f], [0, 0], "a corrupt parent index must not recurse forever");
});

test("spine pose: a region is drawn with its rectangle, a mesh admits it is not", () => {
  const rig = spineRig(
    [spineBone("root", -1)],
    {
      slots: [
        { name: "skin", boneIndex: 0, color: [1, 1, 1, 1], attachmentName: "body" },
        { name: "net", boneIndex: 0, color: [1, 1, 1, 1], attachmentName: "web" },
      ],
      skins: [{ name: "default", attachments: [
        { slotIndex: 0, name: "body", type: "region", width: 2, height: 2, x: 0, y: 0, rotation: 0, scaleX: 1, scaleY: 1 },
        { slotIndex: 1, name: "web", type: "mesh" },
      ] }],
    },
  );
  const scene = sceneAt(rig, null, 0);
  assert.equal(scene.items.length, 2);
  assert.equal(scene.items[0].kind, "region");
  assert.equal(scene.items[0].corners.length, 4);
  assert.equal(scene.items[1].kind, "mesh");
  assert.equal(scene.items[1].corners.length, 0, "a mesh is reported, not silently dropped");
});

test("spine pose: a colour timeline multiplies the slot's colour", () => {
  const rig = spineRig(
    [spineBone("root", -1)],
    { slots: [{ name: "a", boneIndex: 0, color: [1, 1, 1, 1], attachmentName: null }] },
  );
  const animation = { name: "fade", duration: 1, timelines: [
    { type: "color", slotIndex: 0, frames: [
      { time: 0, color: [1, 1, 1, 1], curve: null },
      { time: 1, color: [1, 1, 1, 0] },
    ] },
  ] };
  assert.equal(slotColorAt(rig, null, 0, 0, [1, 1, 1, 1])[3], 1, "no animation keeps the setup colour");
  assert.equal(slotColorAt(rig, animation, 0, 0.5, [1, 1, 1, 1])[3], 0.5);
});

test("spine pose: skins compose in order, a later skin winning the same slot name", () => {
  const rig = spineRig(
    [spineBone("root", -1)],
    {
      slots: [
        { name: "body", boneIndex: 0, color: [1, 1, 1, 1], attachmentName: "idle" },
        { name: "eyes", boneIndex: 0, color: [1, 1, 1, 1], attachmentName: "open" },
      ],
      skins: [
        { name: "Body/Expose", attachments: [
          { slotIndex: 0, name: "idle", type: "region", width: 1, height: 1 },
        ] },
        { name: "Body/Normal", attachments: [
          { slotIndex: 0, name: "idle", type: "region", width: 2, height: 2 },
        ] },
        { name: "Eyes/Normal", attachments: [
          { slotIndex: 1, name: "open", type: "region", width: 1, height: 1 },
        ] },
      ],
    },
  );
  const merged = mergedSkins(rig);
  assert.equal(merged.length, 2, "the same slot and name from two skins is one attachment");
  assert.equal(merged.find((attachment) => attachment.slotIndex === 0).width, 2, "a later skin wins");
  const scene = sceneAt(rig, null, 0, { skin: merged });
  assert.equal(scene.items.length, 2, "the body and the eyes are drawn together, which is the point");
});

test("spine pose: a rig with no skins composes to nothing", () => {
  const rig = spineRig([spineBone("root", -1)], { skins: [] });
  assert.deepEqual(mergedSkins(rig), []);
});

test("spine pose: an attachment timeline switches what the slot shows", () => {
  const rig = spineRig(
    [spineBone("root", -1)],
    { slots: [{ name: "a", boneIndex: 0, color: [1, 1, 1, 1], attachmentName: "idle" }] },
  );
  const animation = { name: "a", duration: 1, timelines: [
    { type: "attachment", slotIndex: 0, frames: [{ time: 0, name: "idle" }, { time: 0.5, name: "attack" }] },
  ] };
  assert.equal(slotAttachmentName(rig, null, 0, 0), "idle");
  assert.equal(slotAttachmentName(rig, animation, 0, 0.2), "idle");
  assert.equal(slotAttachmentName(rig, animation, 0, 0.7), "attack");
});
