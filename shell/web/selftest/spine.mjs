/* ------------------------------------------------------------------ */
/* Spine's pages, quads and framing
/* ------------------------------------------------------------------ */

import assert from "node:assert/strict";
import {
  spineAtlasPath,
  spineBaseOf,
  spineDirOf,
  spinePagePath,
  spineSkeletonPath,
} from "../cards.mjs";
import {
  readSkeletonBinary,
} from "../spine.mjs";
import {
  applyEdits,
  attachmentFramesFor,
  attachmentsForSlot,
  clearAttachment,
  clearBone,
  cloneEdits,
  durationOf,
  editCounts,
  emptyEdits,
  framesFor,
  hasEdits,
  removeAttachmentFrame,
  removeFrame,
  setAttachment,
  setAttachmentFrame,
  setBone,
  setDuration,
  setFrame,
} from "../spineedit.mjs";
import {
  atlasPage,
  atlasRegion,
  spineBoneLines,
  spineCacheSize,
  spineContentQuad,
  spineDrawBounds,
  spineDrawList,
  spineFit,
} from "../spineframe.mjs";
import {
  mergedSkins,
  regionCorners,
  sceneAt,
  worldTransforms,
} from "../spinepose.mjs";
import {
  writeSkeletonBinary,
} from "../spinewrite.mjs";
import {
  test,
} from "./harness.mjs";
import {
  edited,
} from "./main.mjs";
import {
  near,
  spineBone,
  spineRig,
} from "./pixel.mjs";

/* ------------------------------------------------------------------ */
/* Spine's pages, quads and framing                                    */
/* ------------------------------------------------------------------ */

/** The atlas shape `parseAtlas` returns, with only the fields this suite uses. */
export const atlasOf = (...regions) => ({
  pages: [{ name: "Cop.png", size: { width: 256, height: 256 }, regions }],
});

export const regionOf = (extra = {}) => ({
  name: "Idle",
  page: "Cop.png",
  x: 0,
  y: 0,
  w: 90,
  h: 126,
  rotate: 0,
  offsetX: 0,
  offsetY: 0,
  origWidth: 0,
  origHeight: 0,
  index: -1,
  properties: {},
  hasBounds: true,
  hasOffsets: false,
  ...extra,
});

/** One region's corners in `spinepose.regionCorners`' order: bl, br, tr, tl. */
export const cornersOf = (x, y, w, h) => [
  { x, y },
  { x: x + w, y },
  { x: x + w, y: y + h },
  { x, y: y + h },
];

/** A point compared with a tolerance, because the quad is an interpolation. */
export function assertNearPoint(actual, x, y, label = "") {
  assert.ok(
    Math.abs(actual.x - x) < 1e-9 && Math.abs(actual.y - y) < 1e-9,
    `${label} expected (${x}, ${y}), got (${actual.x}, ${actual.y})`,
  );
}

test("spine frame: a page and a region are found by the names the atlas wrote", () => {
  const atlas = atlasOf(regionOf());
  assert.equal(atlasPage(atlas, "Cop.png").name, "Cop.png");
  assert.equal(atlasPage(atlas, "Nope.png"), null);
  assert.equal(atlasRegion(atlas, "Idle").region.name, "Idle");
  assert.equal(atlasRegion(atlas, "Nope"), null);
  assert.equal(atlasRegion({ pages: [] }, "Idle"), null);
});

test("spine frame: a quarter-turned region is cached with its sides swapped", () => {
  assert.deepEqual(spineCacheSize(regionOf()), { width: 90, height: 126 });
  assert.deepEqual(spineCacheSize(regionOf({ rotate: 90 })), { width: 126, height: 90 });
  assert.deepEqual(spineCacheSize(regionOf({ rotate: 180 })), { width: 90, height: 126 });
  assert.deepEqual(spineCacheSize(regionOf({ rotate: 270 })), { width: 126, height: 90 });
});

test("spine frame: trim offsets move the drawn rectangle inside the quad", () => {
  const region = regionOf({ origWidth: 100, origHeight: 50, w: 20, h: 10, offsetX: 10, offsetY: 5, hasOffsets: true });
  const quad = spineContentQuad(cornersOf(0, 0, 100, 50), region);
  assert.equal(quad.trimmed, true);
  // The quad's top-left is (0, 50); offsets are measured down from it.
  assertNearPoint(quad.tl, 10, 45, "top-left");
  assertNearPoint(quad.tr, 30, 45, "top-right");
  assertNearPoint(quad.bl, 10, 35, "bottom-left");
  assertNearPoint(quad.br, 30, 35, "bottom-right");
});

test("spine frame: no offsets means the quad itself, and no corners mean nothing", () => {
  const region = regionOf({ origWidth: 100, origHeight: 50, w: 100, h: 50 });
  const quad = spineContentQuad(cornersOf(0, 0, 100, 50), region);
  assert.equal(quad.trimmed, false);
  assertNearPoint(quad.tl, 0, 50, "top-left");
  assertNearPoint(quad.br, 100, 0, "bottom-right");
  assert.equal(spineContentQuad([], regionOf()), null);
  // No untrimmed size recorded: there is nothing to scale against, so the quad
  // comes back as it arrived rather than vanishing.
  const bare = spineContentQuad(cornersOf(0, 0, 1, 1), regionOf());
  assert.equal(bare.trimmed, false);
  assertNearPoint(bare.tl, 0, 1, "top-left of a unit quad");
});

test("spine frame: a draw list names what it cannot draw instead of dropping it", () => {
  const scene = [
    { kind: "region", slotIndex: 0, name: "Body", path: "Idle", color: [1, 1, 1, 0.5], corners: cornersOf(0, 0, 90, 126) },
    { kind: "region", slotIndex: 1, name: "Ghost", path: null, corners: cornersOf(0, 0, 1, 1) },
    { kind: "mesh", slotIndex: 2, name: "Cloth", path: null, corners: [] },
  ];
  const list = spineDrawList(scene, atlasOf(regionOf()));
  assert.equal(list.items.length, 1);
  assert.deepEqual(list.items[0].colour, [1, 1, 1, 0.5]);
  assert.equal(list.items[0].page, "Cop.png");
  assert.equal(list.missing.length, 1);
  assert.equal(list.missing[0].name, "Ghost");
  assert.equal(list.unsupported.length, 1);
  assert.equal(list.unsupported[0].kind, "mesh");
});

test("spine frame: the bounds cover every corner, and an empty list has none", () => {
  const list = spineDrawList([
    { kind: "region", slotIndex: 0, name: "Body", path: "Idle", color: [1, 1, 1, 1], corners: cornersOf(-10, -20, 20, 40) },
  ], atlasOf(regionOf({ origWidth: 90, origHeight: 126 })));
  const bounds = spineDrawBounds(list.items);
  assert.deepEqual(bounds, { minX: -10, minY: -20, maxX: 10, maxY: 20, width: 20, height: 40 });
  assert.equal(spineDrawBounds([]), null);
});

test("spine frame: the fit keeps the padded inside of the viewport", () => {
  const bounds = { minX: -10, minY: -20, maxX: 10, maxY: 20, width: 20, height: 40 };
  const fit = spineFit(bounds, 200, 200, 0.1);
  assert.equal(fit.scale, 4, "160 pixels usable, 40 units tall");
  assert.equal(fit.tx, 0);
  assert.equal(fit.ty, 0);
  assert.deepEqual(spineFit(null, 200, 200), { scale: 1, tx: 0, ty: 0 });
  assert.deepEqual(spineFit({ ...bounds, width: 0 }, 200, 200), { scale: 1, tx: 0, ty: 0 });
});

test("spine frame: a bone line starts at its origin and points along its matrix", () => {
  const skeleton = { bones: [{ name: "root", parentIndex: -1, length: 10 }] };
  const lines = spineBoneLines(skeleton, [{ a: 0, b: 1, c: -1, d: 0, e: 5, f: 5 }]);
  assert.equal(lines.length, 1);
  assert.equal(lines[0].name, "root");
  assert.equal(lines[0].parentIndex, -1, "the root's own -1 comes through as written");
  assert.deepEqual(lines[0].origin, { x: 5, y: 5 });
  assert.ok(Math.abs(lines[0].tip.x - 5) < 1e-9 && Math.abs(lines[0].tip.y - 15) < 1e-9, "a quarter turn points up");
  assert.deepEqual(spineBoneLines({ bones: [] }, []), []);
  assert.deepEqual(spineBoneLines({ bones: [{ name: "b", length: 1 }] }, []), [], "a bone with no transform is not guessed");
});

test("spine frame: the four names a rig's files wear", () => {
  const skeleton = "Mods/Cop/Cop.skel.bytes";
  const atlas = "Mods/Cop/Cop.atlas.txt";
  assert.equal(spineAtlasPath(skeleton), atlas);
  assert.equal(spineAtlasPath(atlas), atlas);
  assert.equal(spineAtlasPath("Mods/Cop/Cop.png"), "");
  assert.equal(spineSkeletonPath(atlas), skeleton);
  assert.equal(spineSkeletonPath(skeleton), skeleton);
  assert.equal(spineSkeletonPath("Mods/Cop/Cop.png"), "");
  assert.equal(spineDirOf(skeleton), "Mods/Cop");
  assert.equal(spineDirOf("Cop.skel.bytes"), "");
  assert.equal(spineBaseOf(skeleton), "Cop.skel.bytes");
  assert.equal(spinePagePath(atlas, "Cop.png"), "Mods/Cop/Cop.png");
  assert.equal(spinePagePath("Cop.atlas.txt", "Cop.png"), "Cop.png");
  assert.equal(spineAtlasPath("Mods\\Cop\\Cop.skel.bytes"), atlas, "a Windows path is still a path");
});

/* ------------------------------------------------------------------ */
/*
 * Spine's edits, before the card that makes them.
 *
 * An edit is applied by handing `spinepose.mjs` a skeleton whose timelines have
 * been replaced, so these tests ask the pose code what the edited rig looks
 * like: a keyed bone moves at its time, a key does not quietly delete the
 * frames the file had, and the parsed skeleton is still the file's afterwards.
 */
export function spineSlot(name, boneIndex, attachmentName) {
  return { name, boneIndex, color: [1, 1, 1, 1], darkColor: null, attachmentName, blendMode: 0 };
}

export function editedScene(rig, edits, animationName, time) {
  const skeleton = applyEdits(rig, edits);
  const animation = animationName === null
    ? null
    : skeleton.animations.find((entry) => entry.name === animationName) ?? null;
  return sceneAt(skeleton, animation, time, { skin: mergedSkins(skeleton) });
}

export function spineRegion(slotIndex, name) {
  return {
    slotIndex,
    name,
    type: "region",
    path: name,
    width: 4,
    height: 4,
    x: 0,
    y: 0,
    rotation: 0,
    scaleX: 1,
    scaleY: 1,
  };
}

export function spineAnimatedRig(frames = [{ time: 0, angle: 0 }, { time: 1, angle: 90 }]) {
  return spineRig([spineBone("root", -1), spineBone("child", 0, { x: 10 })], {
    animations: [{ name: "a", duration: 1, timelines: [{ type: "rotate", boneIndex: 0, frames }] }],
  });
}

test("spine edit: an edit that changes nothing is the parsed skeleton itself", () => {
  const rig = spineRig([spineBone("root", -1)]);
  assert.equal(applyEdits(rig, emptyEdits()), rig, "no copy is made when nothing is edited");
  assert.equal(hasEdits(emptyEdits()), false);
  assert.deepEqual(editCounts(emptyEdits()), { bones: 0, slots: 0, animations: 0, frames: 0 });
});

test("spine edit: a held bone's numbers are the setup pose, and the file stays the file", () => {
  const rig = spineRig([spineBone("root", -1), spineBone("child", 0, { x: 10 })]);
  const edits = setBone(emptyEdits(), 0, { rotation: 90 });
  const world = worldTransforms(applyEdits(rig, edits), null, 0);
  assert.ok(near(world[1].e, 0), `child x was ${world[1].e}`);
  assert.ok(near(world[1].f, 10), `child y was ${world[1].f}`);
  assert.equal(rig.bones[0].rotation, 0, "the parsed skeleton is not the edit's to change");
  assert.equal(clearBone(edits, 0).bones["0"], undefined, "clearing forgets the bone");
});

test("spine edit: a key seeds the file's frames instead of forgetting them", () => {
  const rig = spineAnimatedRig([
    { time: 0, angle: 0, curve: { stepped: true } },
    { time: 1, angle: 90 },
  ]);
  const edits = setFrame(emptyEdits(), rig, {
    animation: "a", boneIndex: 0, type: "rotate", time: 0.5, value: { angle: 45 },
  });
  const frames = framesFor(edits, rig, "a", 0, "rotate");
  assert.deepEqual(frames.map((frame) => frame.time), [0, 0.5, 1]);
  assert.equal(frames[1].angle, 45);
  assert.deepEqual(frames[0].curve, { stepped: true }, "the curve that opens a segment survives a key inside it");
  // 0.75 is halfway between 45 and 90: the child turns to an angle of 67.5 degrees.
  const world = worldTransforms(applyEdits(rig, edits), applyEdits(rig, edits).animations[0], 0.75);
  assert.ok(near(world[1].e, Math.cos((67.5 * Math.PI) / 180) * 10), `child x was ${world[1].e}`);
  assert.ok(near(world[1].f, Math.sin((67.5 * Math.PI) / 180) * 10), `child y was ${world[1].f}`);
});

test("spine edit: a key at a time already keyed replaces it, it does not stack", () => {
  const rig = spineAnimatedRig();
  const edits = setFrame(emptyEdits(), rig, {
    animation: "a", boneIndex: 0, type: "rotate", time: 0.5, value: { angle: 45 },
  });
  const again = setFrame(edits, rig, {
    animation: "a", boneIndex: 0, type: "rotate", time: 0.50001, value: { angle: 60 },
  });
  const frames = framesFor(again, rig, "a", 0, "rotate");
  assert.equal(frames.length, 3, "the near-identical time is the same key");
  assert.equal(frames[1].angle, 60);
});

test("spine edit: deleting a key leaves the frames the file had", () => {
  const rig = spineRig([spineBone("root", -1)], {
    animations: [{
      name: "a",
      duration: 1,
      timelines: [{ type: "rotate", boneIndex: 0, frames: [{ time: 0, angle: 0 }, { time: 0.5, angle: 45 }, { time: 1, angle: 90 }] }],
    }],
  });
  const edits = removeFrame(emptyEdits(), rig, { animation: "a", boneIndex: 0, type: "rotate", time: 0.5 });
  assert.deepEqual(framesFor(edits, rig, "a", 0, "rotate").map((frame) => frame.time), [0, 1]);
});

test("spine edit: a key past the end needs a longer animation first", () => {
  const rig = spineAnimatedRig();
  const clamped = setFrame(emptyEdits(), rig, {
    animation: "a", boneIndex: 0, type: "rotate", time: 4, value: { angle: 180 },
  });
  assert.deepEqual(
    framesFor(clamped, rig, "a", 0, "rotate").map((frame) => frame.time),
    [0, 1],
    "a key at 4 s of a 1 s animation is clamped to the end it could play",
  );
  const longer = setFrame(setDuration(emptyEdits(), "a", 5), rig, {
    animation: "a", boneIndex: 0, type: "rotate", time: 4, value: { angle: 180 },
  });
  assert.equal(durationOf(rig, "a", longer), 5);
  assert.deepEqual(framesFor(longer, rig, "a", 0, "rotate").map((frame) => frame.time), [0, 1, 4]);
  assert.equal(applyEdits(rig, longer).animations[0].duration, 5, "the applied animation is long enough to hold the key");
});

test("spine edit: a slot can show another skin's attachment, held or keyed", () => {
  const rig = {
    version: "4.2.43",
    bones: [spineBone("root", -1)],
    slots: [spineSlot("body", 0, "Idle")],
    skins: [{ name: "Body/Normal", attachments: [spineRegion(0, "Idle"), spineRegion(0, "Open")] }],
    animations: [{
      name: "a",
      duration: 1,
      timelines: [{ type: "attachment", slotIndex: 0, frames: [{ time: 0, name: "Idle" }, { time: 1, name: "Open" }] }],
    }],
  };
  assert.deepEqual(attachmentsForSlot(rig, 0), ["Idle", "Open"], "the names come from the skins, once each");
  const held = setAttachment(emptyEdits(), 0, "Open");
  assert.equal(editedScene(rig, held, null, 0).items[0].name, "Open", "with no animation the held attachment shows");
  assert.equal(editedScene(rig, emptyEdits(), "a", 0).items[0].name, "Idle");
  const keyed = setAttachmentFrame(emptyEdits(), rig, { animation: "a", slotIndex: 0, time: 0.5, name: "Open" });
  assert.equal(editedScene(rig, keyed, "a", 0.5).items[0].name, "Open", "a keyed attachment switches at its frame");
  assert.equal(editedScene(rig, keyed, "a", 0.75).items[0].name, "Open", "an attachment is stepped, never mixed");
  assert.deepEqual(
    attachmentFramesFor(keyed, rig, "a", 0).map((frame) => frame.name),
    ["Idle", "Open", "Open"],
    "the file's own attachment frames are still the timeline",
  );
  assert.equal(removeAttachmentFrame(keyed, rig, { animation: "a", slotIndex: 0, time: 0.5 })
    .animations.a.slots["0"].attachment.length, 2);
  assert.equal(clearAttachment(held, 0).slots["0"], undefined);
});

test("spine edit: editing answers a new edit and never touches the one it was asked from", () => {
  const rig = spineAnimatedRig();
  const before = JSON.stringify(rig);
  const edits = emptyEdits();
  const once = setFrame(edits, rig, {
    animation: "a", boneIndex: 0, type: "rotate", time: 0.5, value: { angle: 45 },
  });
  const twice = setBone(once, 0, { rotation: 30 });
  assert.deepEqual(edits, emptyEdits(), "the edit it was asked from is untouched");
  assert.equal(hasEdits(once), true);
  const counts = editCounts(twice);
  assert.deepEqual(counts, { bones: 1, slots: 0, animations: 1, frames: 3 });
  assert.equal(JSON.stringify(rig), before, "the parsed skeleton is the file's, before and after");
  const copy = cloneEdits(twice);
  copy.bones["0"].rotation = 999;
  assert.equal(twice.bones["0"].rotation, 30, "a clone is a copy, not the same object");
  assert.throws(
    () => setFrame(edits, rig, { animation: "a", boneIndex: 0, type: "nope", time: 0, value: {} }),
    /unknown bone timeline/,
  );
});

/*
 * The writer, against the one rig this suite owns: a 135-byte synthetic
 * skeleton (one bone "root", one slot "body", one region attachment) that
 * `tools/browser_smoke.py` builds for the rig card's check. It is embedded
 * here as base64 because a test that needs the game's install cannot run in
 * the suite, and the writer's real proof -- all 37 shipped rigs, byte for byte
 * -- lives in `build/_verify_spinewrite.mjs`.
 */
export const SPINE_FIXTURE = "AAAAAAAAAAAHNC4yLjQzAAAAAAAAAABCgAAAQoAAAD+AAAAAAQVib2R5AQVyb290AAAAAAAAAAAAAAAAP4AAAD+AAAAAAAAAAAAAAELIAAAAAAEFYm9keQD//////////wEAAAAAAAEAAQEAAAAAAAAAAAA/gAAAP4AAAEKAAABCgAAAAAAA";

export function spineFixtureBytes() {
  return Uint8Array.from(atob(SPINE_FIXTURE), (character) => character.charCodeAt(0));
}

test("spine write: the rig the reader just read writes back as the same bytes", () => {
  const bytes = spineFixtureBytes();
  assert.equal(bytes.length, 135, "the fixture is the 135-byte rig the browser check uses");
  const skeleton = readSkeletonBinary(bytes);
  const written = writeSkeletonBinary(skeleton);
  assert.equal(written.length, bytes.length, "a reader-produced model carries every byte it read");
  assert.deepEqual([...written], [...bytes]);
});

test("spine write: an edited setup pose survives a write and a re-read", () => {
  const skeleton = readSkeletonBinary(spineFixtureBytes());
  const edited = applyEdits(skeleton, setBone(emptyEdits(), 0, { rotation: 30 }));
  const again = readSkeletonBinary(writeSkeletonBinary(edited));
  assert.equal(again.bones.length, 1);
  assert.equal(again.bones[0].rotation, 30, "the number the editor wrote is the number the reader reads");
  assert.equal(again.slots[0].name, "body");
  assert.equal(again.skins[0].attachments[0].name, "body");
  assert.equal(again.skins[0].attachments[0].width, 64, "the attachment's atlas-measured rectangle is still there");
});
