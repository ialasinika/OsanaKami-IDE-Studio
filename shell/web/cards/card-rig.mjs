/**
 * cards/card-rig.mjs -- the rig card: a Spine skeleton, posed and played.
 *
 * Part of `cards.mjs`, which re-exports this file; see that file's header for
 * why the card layer is split the way it is.
 */
import { parseAtlas, readSkeletonBinary } from "../spine.mjs";
import {
  FRAME_EPSILON,
  applyEdits,
  attachmentFramesFor,
  attachmentsForSlot,
  cloneEdits,
  durationOf,
  editCounts,
  emptyEdits,
  findAnimation,
  framesFor,
  hasEdits,
  removeFrame,
  setAttachment,
  setAttachmentFrame,
  setBone,
  setFrame,
} from "../spineedit.mjs";
import { spineBoneLines, spineDrawBounds, spineDrawList, spineFit } from "../spineframe.mjs";
import { localPoses, mergedSkins, sceneAt } from "../spinepose.mjs";
import { writeSkeletonBinary } from "../spinewrite.mjs";
import { bytesFromBase64 } from "./blob.mjs";
import { cardShell, fillRows, h, makeStatus } from "./dom.mjs";

/** The atlas that belongs beside a `.skel.bytes`, or "" for other names. */
export function spineAtlasPath(file) {
  const path = typeof file === "string" ? file.replace(/\\/g, "/") : "";
  if (/\.atlas\.txt$/i.test(path)) {
    return path;
  }
  if (/\.skel\.bytes$/i.test(path)) {
    return path.replace(/\.skel\.bytes$/i, ".atlas.txt");
  }
  return "";
}

/** The skeleton that belongs beside an `.atlas.txt`, or "" for other names. */
export function spineSkeletonPath(file) {
  const path = typeof file === "string" ? file.replace(/\\/g, "/") : "";
  if (/\.skel\.bytes$/i.test(path)) {
    return path;
  }
  if (/\.atlas\.txt$/i.test(path)) {
    return path.replace(/\.atlas\.txt$/i, ".skel.bytes");
  }
  return "";
}

/** The directory part of a workspace path: "" for a bare name. */
export function spineDirOf(file) {
  const path = typeof file === "string" ? file.replace(/\\/g, "/") : "";
  const slash = path.lastIndexOf("/");
  return slash < 0 ? "" : path.slice(0, slash);
}

/** The file-name part of a workspace path. */
export function spineBaseOf(file) {
  const path = typeof file === "string" ? file.replace(/\\/g, "/") : "";
  return path.slice(path.lastIndexOf("/") + 1);
}

/** A page image's workspace path, given the atlas path and the page name. */
export function spinePagePath(atlasPath, pageName) {
  const dir = spineDirOf(atlasPath);
  const name = typeof pageName === "string" ? pageName : "";
  return dir === "" ? name : `${dir}/${name}`;
}

/** How far one frame may advance playback, in seconds. */
export const RIG_MAX_STEP = 0.1;

/** Playback speeds the toolbar offers. */
export const RIG_SPEEDS = [0.25, 0.5, 1, 2];

/** Zoom limits, in device pixels per skeleton unit. */
export const RIG_ZOOM_MIN = 0.02;

export const RIG_ZOOM_MAX = 40;

/** `requestAnimationFrame` where it exists, a timer where it does not. */
export function scheduleFrame(fn) {
  if (typeof requestAnimationFrame === "function") {
    return { raf: requestAnimationFrame(fn) };
  }
  return { timer: setTimeout(() => fn(Date.now()), 16) };
}

export function cancelFrame(handle) {
  if (handle === null || typeof handle !== "object") {
    return;
  }
  if (handle.raf !== undefined && typeof cancelAnimationFrame === "function") {
    cancelAnimationFrame(handle.raf);
  }
  if (handle.timer !== undefined) {
    clearTimeout(handle.timer);
  }
}

/**
 * The rig card.  `handle` exposes the loaded model and the pose controls so
 * the app (and a probe) can drive the card without synthesising clicks.
 */
export function renderRig(card, ctx) {
  const { client, app } = ctx;

  const state = {
    /** The skeleton the card shows; the atlas beside it is derived from it. */
    file: typeof card.file === "string" ? card.file : "",
    skeleton: null,
    atlas: null,
    /** Page name -> decoded bitmap, or an error message in `pageErrors`. */
    textures: new Map(),
    pageErrors: new Map(),
    /** Region key -> small canvas already in display orientation. */
    caches: new Map(),
    animations: [],
    animationIndex: -1,
    /** -1 is "default skin" -- the skin the skeleton names, or its first. */
    skinIndex: -1,
    time: 0,
    playing: false,
    speed: 1,
    showBones: card.bones !== false,
    selectedBone: -1,
    /**
     * The in-memory edit of the rig (`spineedit.mjs`) and the parsed skeleton
     * with that edit applied.  Every draw uses `working`; the parsed
     * `state.skeleton` stays the file and is what the pure helpers are given.
     */
    edits: emptyEdits(),
    working: null,
    /** Read-only unless the Edit button is pressed. */
    editMode: false,
    /** The revision the skeleton bytes came from, so a save can refuse to race. */
    baseRevision: null,
    /** True while a save is in flight; a second Ctrl+S must not queue another. */
    saving: false,
    /** `{scale, tx, ty}`, world -> view, or null until the first paint fits it. */
    camera: null,
    /** The last draw list, for the status line and for a probe. */
    list: null,
    error: null,
    busy: false,
    frame: null,
    lastTick: 0,
    destroyed: false,
  };

  const cleanups = [];

  function listen(target, type, handler, options) {
    target.addEventListener(type, handler, options);
    cleanups.push(() => target.removeEventListener(type, handler, options));
  }

  /* -- the chrome ---------------------------------------------------- */

  const tools = h("div", "rig-tools", { attrs: { "data-role": "rig-tools" } });

  const fileInput = h("input", "rig-file", {
    attrs: {
      type: "text",
      spellcheck: "false",
      placeholder: "path/to/Rig.skel.bytes",
      "data-role": "rig-file",
      title: "the skeleton to show; its atlas and page are read beside it",
    },
  });
  fileInput.value = state.file;

  const animSelect = h("select", "rig-select", {
    attrs: { "data-role": "rig-animation", title: "the animation to pose" },
  });
  const skinSelect = h("select", "rig-select", {
    attrs: { "data-role": "rig-skin", title: "the skin to show" },
  });
  const playButton = h("button", "rig-button", {
    attrs: { type: "button", "data-role": "rig-play", title: "play or pause the animation" },
    text: "Play",
  });
  const speedSelect = h("select", "rig-select rig-select-speed", {
    attrs: { "data-role": "rig-speed", title: "playback speed" },
  });
  for (const speed of RIG_SPEEDS) {
    speedSelect.append(h("option", "", {
      attrs: { value: String(speed) },
      text: `${speed}x`,
    }));
  }
  speedSelect.value = "1";
  const bonesButton = h("button", "rig-button", {
    attrs: { type: "button", "data-role": "rig-bones-toggle", title: "show or hide the bones" },
    text: "Bones",
  });
  const fitButton = h("button", "rig-button", {
    attrs: { type: "button", "data-role": "rig-fit", title: "frame the whole rig" },
    text: "Fit",
  });
  /*
   * The edit controls are new chrome, not a new card: with Edit off the toolbar
   * looks and behaves exactly as the viewer did.  Edit changes what the canvas
   * shows; Save is the one button in this card that writes a file, and it writes
   * the rig the canvas is showing, byte for byte, through `spinewrite.mjs`.
   */
  const editButton = h("button", "rig-button", {
    attrs: {
      type: "button",
      "data-role": "rig-edit",
      "aria-pressed": "false",
      title: "edit the pose in memory, then Save writes it",
    },
    text: "Edit",
  });
  const keyButton = h("button", "rig-button", {
    attrs: { type: "button", "data-role": "rig-key", title: "key the selected bone at this time" },
    text: "Key",
  });
  const unkeyButton = h("button", "rig-button", {
    attrs: { type: "button", "data-role": "rig-unkey", title: "remove the selected bone's keys at this time" },
    text: "Unkey",
  });
  const resetButton = h("button", "rig-button", {
    attrs: { type: "button", "data-role": "rig-reset", title: "throw every edit away and draw the file again" },
    text: "Reset",
  });
  const saveButton = h("button", "rig-button", {
    attrs: { type: "button", "data-role": "rig-save", title: "write the edited rig back to its own .skel.bytes (Ctrl+S)" },
    text: "Save",
  });
  const timeRange = h("input", "rig-time", {
    attrs: {
      type: "range",
      min: "0",
      max: "0",
      step: "0.001",
      value: "0",
      "data-role": "rig-time",
      title: "the pose time",
    },
  });
  const timeLabel = h("span", "rig-time-label", { text: "0.00 / 0.00 s" });

  tools.append(
    fileInput,
    animSelect,
    playButton,
    speedSelect,
    timeRange,
    timeLabel,
    skinSelect,
    bonesButton,
    fitButton,
    editButton,
    keyButton,
    unkeyButton,
    resetButton,
    saveButton,
  );

  const canvas = h("canvas", "rig-canvas", {
    attrs: {
      "data-role": "rig-canvas",
      tabindex: "0",
      title: "wheel zooms, drag pans, click picks a bone, space plays; with Edit on a drag turns the selected bone",
    },
  });
  /*
   * The inspector is three number inputs plus the selected bone's key list and
   * slot pickers.  It is built once and re-seeded, never rebuilt from scratch,
   * so a drag that re-renders the list cannot eat a half-typed number.
   */
  const numberInput = (role, title) => h("input", "rig-num", {
    attrs: { type: "number", step: "1", "data-role": role, title: title },
  });
  const xInput = numberInput("rig-x", "the selected bone's local x at this time");
  const yInput = numberInput("rig-y", "the selected bone's local y at this time");
  const rotationInput = numberInput("rig-rotation", "the selected bone's local rotation, in degrees");
  const keysList = h("div", "rig-keys", { attrs: { "data-role": "rig-keys" } });
  const attachmentsList = h("div", "rig-attachments", { attrs: { "data-role": "rig-attachments" } });
  const editPanel = h("div", "rig-edit", {
    attrs: { "data-role": "rig-edit-panel", hidden: "" },
    children: [
      h("div", "rig-edit-title", { text: "Bone" }),
      h("div", "rig-edit-row", {
        children: [
          h("label", "rig-field", { children: [h("span", "rig-field-name", { text: "x" }), xInput] }),
          h("label", "rig-field", { children: [h("span", "rig-field-name", { text: "y" }), yInput] }),
          h("label", "rig-field", { children: [h("span", "rig-field-name", { text: "rot" }), rotationInput] }),
        ],
      }),
      h("div", "rig-edit-title", { text: "Keys" }),
      keysList,
      h("div", "rig-edit-title", { text: "Attachments" }),
      attachmentsList,
    ],
  });
  const bonesList = h("div", "rig-bones", { attrs: { "data-role": "rig-bones" } });
  const side = h("div", "rig-side", { children: [bonesList, editPanel] });
  const stage = h("div", "rig-stage", { children: [canvas] });
  const main = h("div", "rig-main", { children: [stage, side] });
  const status = makeStatus();
  const body = h("div", "card-body card-body-rig", { children: [tools, main, status] });
  const shell = cardShell(card, body);

  /* -- state helpers ------------------------------------------------- */

  function currentAnimation() {
    if (state.animationIndex < 0 || state.animationIndex >= state.animations.length) {
      return null;
    }
    const entry = state.animations[state.animationIndex];
    const animations = state.skeleton !== null && Array.isArray(state.skeleton.animations)
      ? state.skeleton.animations
      : [];
    return animations[entry.index] ?? null;
  }

  function currentSkin() {
    const skins = state.skeleton !== null && Array.isArray(state.skeleton.skins) ? state.skeleton.skins : [];
    return state.skinIndex >= 0 && skins[state.skinIndex] !== undefined ? skins[state.skinIndex] : null;
  }

  function currentSkinAttachments() {
    const skin = currentSkin();
    if (skin !== null && Array.isArray(skin.attachments)) {
      return skin.attachments;
    }
    /*
     * No skin chosen means the composition, not "no attachments": these rigs
     * keep the body, the eyes and the mouth in separate skins and the game
     * stacks them, so the single setup skin would show a character with a
     * missing face.  `mergedSkins` says exactly which pieces that is.
     */
    return mergedSkins(state.skeleton);
  }

  /* -- the edit model ------------------------------------------------ */

  /** The skeleton to draw: the parsed file with the card's edits applied. */
  function workingSkeleton() {
    return state.working !== null ? state.working : state.skeleton;
  }

  /**
   * The animation the pose is read from: the chosen name, but taken from the
   * applied skeleton, because `applyEdits` replaces the timelines the pose math
   * interpolates.  `currentAnimation()` keeps answering the file's entry (the
   * board saves its name and duration from there).
   */
  function workingAnimation() {
    const chosen = currentAnimation();
    if (chosen === null) {
      return null;
    }
    const applied = state.working !== null ? findAnimation(state.working, chosen.name) : null;
    return applied !== null ? applied : chosen;
  }

  function animationName() {
    const animation = currentAnimation();
    return animation === null ? "" : animation.name;
  }

  /** The duration to play and to key against: an edited duration wins. */
  function editedDuration() {
    const animation = currentAnimation();
    if (animation === null) {
      return 0;
    }
    return durationOf(state.skeleton, animation.name, state.edits);
  }

  /**
   * Take a new edit object from `spineedit.mjs`: rebuild the applied skeleton
   * the drawing uses, re-seed the panel, repaint.  The parsed model is never
   * mutated, so Reset is just "apply the empty edit".
   */
  function applyEdit(next) {
    state.edits = next;
    state.working = state.skeleton === null ? null : applyEdits(state.skeleton, next);
    refreshEditPanel();
    paint();
  }

  /** The selected bone's local pose numbers at the playhead. */
  function localPoseOf(boneIndex) {
    const skeleton = workingSkeleton();
    if (skeleton === null) {
      return null;
    }
    const poses = localPoses(skeleton, workingAnimation(), state.time);
    return boneIndex >= 0 && boneIndex < poses.length ? poses[boneIndex] : null;
  }

  /**
   * Record a pose number for one bone.  With an animation selected it becomes a
   * key at the playhead; with none it is the setup pose.  The module clamps the
   * key time against the animation's duration, so this passes the time as-is.
   */
  function writePose(boneIndex, patch, type) {
    const name = animationName();
    if (name !== "") {
      applyEdit(setFrame(state.edits, state.skeleton, {
        animation: name,
        boneIndex: boneIndex,
        type: type,
        time: state.time,
        value: patch,
      }));
      return;
    }
    if (type === "rotate") {
      applyEdit(setBone(state.edits, boneIndex, { rotation: patch.angle }));
      return;
    }
    applyEdit(setBone(state.edits, boneIndex, { x: patch.x, y: patch.y }));
  }

  /** A bone's on-screen origin in world units, from the last painted pose. */
  function worldOriginOf(boneIndex) {
    const transforms = Array.isArray(state.transforms) ? state.transforms : [];
    const transform = transforms[boneIndex];
    if (transform === undefined || transform === null) {
      return null;
    }
    const x = Number(transform.e);
    const y = Number(transform.f);
    return Number.isFinite(x) && Number.isFinite(y) ? { x: x, y: y } : null;
  }

  /** World point -> client point, the same mapping `paint` draws through. */
  function screenPointOf(point) {
    const rect = canvas.getBoundingClientRect();
    const camera = state.camera;
    return {
      x: rect.left + (point.x - camera.tx) * camera.scale + rect.width / 2,
      y: rect.top + rect.height / 2 - (point.y - camera.ty) * camera.scale,
    };
  }

  function plural(count, one, many) {
    return `${count} ${count === 1 ? one : many}`;
  }

  /** What the status line adds about the edit, or "" when nothing is edited. */
  function editSuffix() {
    const counts = editCounts(state.edits);
    const parts = [];
    if (state.editMode) {
      parts.push("edit mode");
    }
    const bits = [];
    if (counts.bones > 0) {
      bits.push(plural(counts.bones, "bone", "bones"));
    }
    if (counts.slots > 0) {
      bits.push(plural(counts.slots, "slot", "slots"));
    }
    if (counts.frames > 0) {
      bits.push(plural(counts.frames, "key", "keys"));
    }
    if (bits.length > 0) {
      parts.push(`edited: ${bits.join(", ")}`);
    }
    return parts.length === 0 ? "" : ` \u00b7 ${parts.join(" \u00b7 ")}`;
  }

  /** Seed one number input, unless a person is typing in it. */
  function setNumber(input, value) {
    if (document.activeElement === input) {
      return;
    }
    input.value = Number.isFinite(value) ? String(Math.round(value * 1000) / 1000) : "";
  }

  /** Re-seed the inspector, the key list and the slot pickers. */
  function refreshEditPanel() {
    const editing = state.editMode;
    editPanel.hidden = !editing;
    keyButton.hidden = !editing;
    unkeyButton.hidden = !editing;
    resetButton.hidden = !editing;
    saveButton.hidden = !editing && !hasEdits(state.edits);
    // Save is live only when there is an edit to write and no write in flight.
    saveButton.disabled = !hasEdits(state.edits) || state.saving || state.skeleton === null;
    editButton.classList.toggle("is-on", editing);
    editButton.setAttribute("aria-pressed", editing ? "true" : "false");
    canvas.classList.toggle("is-editing", editing);
    refreshKeys();
    refreshAttachments();
    const pose = state.selectedBone >= 0 ? localPoseOf(state.selectedBone) : null;
    if (pose === null) {
      setNumber(xInput, NaN);
      setNumber(yInput, NaN);
      setNumber(rotationInput, NaN);
    } else {
      setNumber(xInput, pose.x);
      setNumber(yInput, pose.y);
      setNumber(rotationInput, pose.rotation);
    }
    const keyable = animationName() !== "" && state.selectedBone >= 0;
    keyButton.disabled = !keyable;
    unkeyButton.disabled = !keyable;
  }

  /** The selected bone's rotate timeline: the edit's frames, or the file's. */
  function refreshKeys() {
    keysList.textContent = "";
    const name = animationName();
    const bone = state.selectedBone;
    if (name === "") {
      keysList.append(h("div", "rig-bones-empty", { text: "pick an animation to key" }));
      return;
    }
    if (bone < 0) {
      keysList.append(h("div", "rig-bones-empty", { text: "pick a bone to key" }));
      return;
    }
    const frames = framesFor(state.edits, state.skeleton, name, bone, "rotate");
    if (frames.length === 0) {
      keysList.append(h("div", "rig-bones-empty", { text: "no keys for this bone" }));
      return;
    }
    fillRows(keysList, frames.map((frame) => {
      const time = Number(frame.time);
      const at = Number.isFinite(time) ? time : 0;
      const angle = Number(frame.angle);
      return {
        label: `${at.toFixed(3)} s`,
        meta: `${(Number.isFinite(angle) ? angle : 0).toFixed(1)}\u00b0`,
        title: `move the playhead to ${at.toFixed(3)} s`,
        onClick: () => setTime(at),
        extra: {
          label: "\u00d7",
          title: "remove this key",
          onClick: () => applyEdit(removeFrame(state.edits, state.skeleton, {
            animation: name,
            boneIndex: bone,
            type: "rotate",
            time: at,
          })),
        },
      };
    }));
  }

  /** What a slot shows at the playhead, as the pose math sees it. */
  function currentAttachmentOf(slotIndex) {
    const name = animationName();
    if (name !== "") {
      const frames = attachmentFramesFor(state.edits, state.skeleton, name, slotIndex);
      let value = null;
      for (const frame of frames) {
        const time = Number(frame.time);
        if (Number.isFinite(time) && time <= state.time + FRAME_EPSILON) {
          value = typeof frame.name === "string" ? frame.name : "";
        }
      }
      if (value !== null) {
        return value;
      }
    }
    const skeleton = workingSkeleton();
    const slot = skeleton !== null && Array.isArray(skeleton.slots) ? skeleton.slots[slotIndex] : null;
    return slot !== null && typeof slot.attachmentName === "string" ? slot.attachmentName : "";
  }

  /** One picker per slot whose bone is the selected bone. */
  function refreshAttachments() {
    attachmentsList.textContent = "";
    const skeleton = workingSkeleton();
    const bone = state.selectedBone;
    if (skeleton === null || bone < 0) {
      attachmentsList.append(h("div", "rig-bones-empty", { text: "pick a bone to edit its slots" }));
      return;
    }
    const slots = Array.isArray(skeleton.slots) ? skeleton.slots : [];
    const mine = [];
    for (let index = 0; index < slots.length; index += 1) {
      if (slots[index] !== null && typeof slots[index] === "object" && slots[index].boneIndex === bone) {
        mine.push(index);
      }
    }
    if (mine.length === 0) {
      attachmentsList.append(h("div", "rig-bones-empty", { text: "this bone has no slots" }));
      return;
    }
    for (const index of mine) {
      const slot = slots[index];
      const select = h("select", "rig-select", {
        attrs: {
          "data-role": "rig-attachment",
          "data-slot": String(index),
          title: "what this slot shows",
        },
      });
      select.append(h("option", "", { attrs: { value: "" }, text: "(none)" }));
      for (const name of attachmentsForSlot(skeleton, index)) {
        select.append(h("option", "", { attrs: { value: name }, text: name }));
      }
      select.value = currentAttachmentOf(index);
      attachmentsList.append(h("label", "rig-field rig-field-wide", {
        children: [
          h("span", "rig-field-name", { text: typeof slot.name === "string" ? slot.name : `slot ${index}` }),
          select,
        ],
      }));
    }
  }

  function say(message, level = "") {
    status.textContent = message;
    status.className = level === "" ? "card-status" : `card-status is-${level}`;
  }

  function writeToBoard() {
    card.file = state.file;
    const animation = currentAnimation();
    card.animation = animation === null || typeof animation.name !== "string" ? "" : animation.name;
    const skin = currentSkin();
    card.skin = skin === null || typeof skin.name !== "string" ? "" : skin.name;
    card.bones = state.showBones;
    if (typeof app.boardTouched === "function") {
      app.boardTouched();
    }
  }

  /* -- controls ------------------------------------------------------ */

  function updateTimeline() {
    const duration = editedDuration();
    timeRange.max = String(Math.max(0, duration));
    timeRange.value = String(Math.max(0, Math.min(duration, state.time)));
    timeLabel.textContent = `${state.time.toFixed(2)} / ${duration.toFixed(2)} s`;
    timeRange.disabled = animationName() === "";
  }

  function refreshBones() {
    const bones = state.skeleton !== null && Array.isArray(state.skeleton.bones) ? state.skeleton.bones : [];
    bonesList.textContent = "";
    if (bones.length === 0) {
      bonesList.append(h("div", "rig-bones-empty", { text: "no bones" }));
      return;
    }
    fillRows(bonesList, bones.map((bone, index) => {
      const label = typeof bone.name === "string" ? bone.name : `bone ${index}`;
      const parent = typeof bone.parentIndex === "number" ? bones[bone.parentIndex] : undefined;
      const parentName = parent !== undefined && typeof parent.name === "string" ? parent.name : "";
      const slots = state.skeleton.slots.filter((slot) => slot.boneIndex === index).length;
      return {
        label,
        meta: parentName === "" ? "root" : `parent ${parentName}`,
        title: `bone ${index}${slots === 0 ? "" : `, ${slots} slot(s)`}`,
        empty: false,
        onClick: () => selectBone(index),
      };
    }));
    markBones();
  }

  function fillSelects() {
    animSelect.textContent = "";
    for (const animation of state.animations) {
      animSelect.append(h("option", "", {
        attrs: { value: String(animation.index) },
        text: animation.name,
      }));
    }
    skinSelect.textContent = "";
    skinSelect.append(h("option", "", { attrs: { value: "-1" }, text: "all skins (merged)" }));
    const skins = state.skeleton !== null && Array.isArray(state.skeleton.skins) ? state.skeleton.skins : [];
    for (let index = 0; index < skins.length; index += 1) {
      const name = typeof skins[index].name === "string" ? skins[index].name : `skin ${index}`;
      skinSelect.append(h("option", "", { attrs: { value: String(index) }, text: name }));
    }
  }

  function refreshControls() {
    playButton.textContent = state.playing ? "Pause" : "Play";
    playButton.setAttribute("aria-pressed", state.playing ? "true" : "false");
    bonesButton.classList.toggle("is-on", state.showBones);
    animSelect.value = state.animationIndex < 0 ? "" : String(state.animations[state.animationIndex]?.index ?? "");
    animSelect.disabled = state.animations.length === 0;
    skinSelect.value = String(state.skinIndex);
    shell.label.textContent = state.file === "" ? "(no skeleton)" : spineBaseOf(state.file);
    updateTimeline();
  }

  /* -- reading ------------------------------------------------------- */

  async function readBytes(path) {
    const result = await client.call("file.read_bytes", { path });
    return bytesFromBase64(String(result.base64 || ""));
  }

  /** The skeleton's bytes together with the revision they were read at. */
  async function readBytesWithRevision(path) {
    const result = await client.call("file.read_bytes", { path });
    return {
      bytes: bytesFromBase64(String(result.base64 || "")),
      revision: typeof result.revision === "number" ? result.revision : null,
    };
  }

  async function readText(path) {
    const result = await client.call("file.read", { path });
    return typeof result.text === "string" ? result.text : "";
  }

  async function decodeBitmap(path, bytes) {
    if (typeof Blob === "function" && typeof createImageBitmap === "function") {
      return await createImageBitmap(new Blob([bytes], { type: "image/png" }));
    }
    const canObjectUrl = typeof URL !== "undefined" && typeof URL.createObjectURL === "function";
    if (typeof Image === "function" && canObjectUrl) {
      const url = URL.createObjectURL(new Blob([bytes], { type: "image/png" }));
      try {
        return await new Promise((resolve, reject) => {
          const image = new Image();
          image.onload = () => resolve(image);
          image.onerror = () => reject(new Error(`cannot decode ${path}`));
          image.src = url;
        });
      } finally {
        URL.revokeObjectURL(url);
      }
    }
    throw new Error("this environment has no image decoder");
  }

  async function loadTextures(atlasPath, atlas) {
    state.textures.clear();
    state.pageErrors.clear();
    for (const page of Array.isArray(atlas.pages) ? atlas.pages : []) {
      const path = spinePagePath(atlasPath, page.name);
      try {
        state.textures.set(page.name, await decodeBitmap(path, await readBytes(path)));
      } catch (err) {
        state.pageErrors.set(page.name, err.message);
      }
    }
  }

  function fail(message) {
    state.error = message;
    state.skeleton = null;
    state.atlas = null;
    state.list = null;
    state.edits = emptyEdits();
    state.working = null;
    state.editMode = false;
    state.caches.clear();
    state.animations = [];
    state.animationIndex = -1;
    state.skinIndex = -1;
    state.camera = null;
    animSelect.textContent = "";
    skinSelect.textContent = "";
    refreshBones();
    refreshControls();
    refreshEditPanel();
    state.busy = false;
    say(message, "error");
    paint();
    return false;
  }

  /**
   * Read one skeleton and the atlas beside it.  A file that is not a Spine
   * export is a refusal, not a guess: the card shows the reader's own message,
   * byte offset included, instead of an empty canvas that looks like a rig with
   * nothing in it.
   */
  async function load(file) {
    if (state.busy) {
      return false;
    }
    const wanted = typeof file === "string" ? file.trim().replace(/\\/g, "/") : state.file;
    const skeletonPath = spineSkeletonPath(wanted);
    const atlasPath = spineAtlasPath(wanted);
    if (skeletonPath === "") {
      return fail(`rig: ${wanted === "" ? "(no file)" : wanted} is not a .skel.bytes or .atlas.txt path`);
    }
    state.busy = true;
    state.error = null;
    state.file = skeletonPath;
    state.baseRevision = null;
    fileInput.value = skeletonPath;
    say(`reading ${spineBaseOf(skeletonPath)}…`);
    try {
      const [skeletonFile, atlasText] = await Promise.all([readBytesWithRevision(skeletonPath), readText(atlasPath)]);
      const skeletonBytes = skeletonFile.bytes;
      let skeleton = null;
      let atlas = null;
      const problems = [];
      try {
        skeleton = readSkeletonBinary(skeletonBytes);
      } catch (err) {
        problems.push(`skeleton: ${err.message}`);
      }
      try {
        atlas = parseAtlas(atlasText);
      } catch (err) {
        problems.push(`atlas: ${err.message}`);
      }
      if (skeleton === null || atlas === null) {
        return fail(problems.join("; "));
      }
      state.skeleton = skeleton;
      state.atlas = atlas;
      state.baseRevision = skeletonFile.revision;
      state.edits = emptyEdits();
      state.working = skeleton;
      state.caches.clear();
      state.camera = null;
      state.selectedBone = -1;
      state.animations = (Array.isArray(skeleton.animations) ? skeleton.animations : []).map((animation, index) => ({
        index,
        name: typeof animation.name === "string" ? animation.name : `animation ${index}`,
        duration: typeof animation.duration === "number" && Number.isFinite(animation.duration) ? animation.duration : 0,
      }));
      const wantedAnimation = state.animations.findIndex((animation) => animation.name === card.animation);
      state.animationIndex = wantedAnimation >= 0
        ? wantedAnimation
        : (state.animations.length > 0 ? 0 : -1);
      const skins = Array.isArray(skeleton.skins) ? skeleton.skins : [];
      const wantedSkin = skins.findIndex((skin) => skin.name === card.skin);
      state.skinIndex = wantedSkin;
      state.time = 0;
      fillSelects();
      refreshBones();
      refreshControls();
      refreshEditPanel();
      await loadTextures(atlasPath, atlas);
      state.busy = false;
      writeToBoard();
      paint();
      return true;
    } catch (err) {
      return fail(`could not read ${spineBaseOf(skeletonPath)}: ${err.message}`);
    }
  }

  /* -- painting ------------------------------------------------------ */

  /** One cached bitmap per atlas region, already turned to display orientation. */
  function cacheFor(item) {
    const key = `${item.page}\u0000${item.region.name}`;
    if (state.caches.has(key)) {
      return state.caches.get(key);
    }
    const bitmap = state.textures.get(item.page);
    if (bitmap === undefined || bitmap === null) {
      state.caches.set(key, null);
      return null;
    }
    const region = item.region;
    const width = Math.max(1, Math.round(item.size.width));
    const height = Math.max(1, Math.round(item.size.height));
    const cache = document.createElement("canvas");
    cache.width = width;
    cache.height = height;
    const context = cache.getContext("2d");
    if (context === null) {
      state.caches.set(key, null);
      return null;
    }
    /*
     * A rotated atlas region is stored turned a quarter turn clockwise in the
     * page (`rotate: true` and `rotate: 90` both mean that), so it is turned
     * back here, around the centre of its displayed rectangle.  The page holds
     * `region.w` x `region.h`; the displayed pair is swapped, and `item.size`
     * carries that already.
     */
    const degrees = Number.isFinite(region.rotate) ? region.rotate : 0;
    context.translate(width / 2, height / 2);
    context.rotate((-Math.PI / 180) * degrees);
    context.drawImage(
      bitmap,
      region.x, region.y, region.w, region.h,
      -region.w / 2, -region.h / 2, region.w, region.h,
    );
    state.caches.set(key, cache);
    return cache;
  }

  function viewSize() {
    const rect = canvas.getBoundingClientRect();
    const fallbackWidth = Math.max(320, Math.round(Number(card.w) || 560) - 24);
    const fallbackHeight = Math.max(240, Math.round(Number(card.h) || 500) - 96);
    const width = Math.max(1, Math.round(rect.width || fallbackWidth));
    const height = Math.max(1, Math.round(rect.height || fallbackHeight));
    const ratio = typeof devicePixelRatio === "number" && devicePixelRatio > 0 ? Math.min(3, devicePixelRatio) : 1;
    return { width, height, ratio };
  }

  function drawBones(context, pixel, transforms, ratio) {
    for (const line of spineBoneLines(workingSkeleton(), transforms)) {
      const origin = pixel(line.origin);
      const tip = pixel(line.tip);
      const selected = line.index === state.selectedBone;
      context.strokeStyle = selected ? "#ffd166" : "rgba(94, 187, 255, 0.72)";
      context.lineWidth = (selected ? 3 : 1.4) * ratio;
      context.beginPath();
      context.moveTo(origin.x, origin.y);
      context.lineTo(tip.x, tip.y);
      context.stroke();
      context.fillStyle = selected ? "#ffd166" : "rgba(94, 187, 255, 0.9)";
      context.beginPath();
      context.arc(origin.x, origin.y, (selected ? 3.4 : 2.2) * ratio, 0, Math.PI * 2);
      context.fill();
    }
  }

  function summaryText(list) {
    const skeleton = workingSkeleton();
    if (skeleton === null) {
      return "";
    }
    const parts = [
      `${skeleton.bones.length} bones`,
      `${skeleton.slots.length} slots`,
      `${state.animations.length} animations`,
      `${list.items.length} regions`,
    ];
    if (list.missing.length > 0) {
      parts.push(`${list.missing.length} not in the atlas`);
    }
    if (list.unsupported.length > 0) {
      parts.push(`${list.unsupported.length} attachments not drawn`);
    }
    const pageErrors = [...state.pageErrors.entries()];
    if (pageErrors.length > 0) {
      parts.push(`${pageErrors.length} page(s) failed: ${pageErrors.map(([name]) => name).join(", ")}`);
    }
    return parts.join(" \u00b7 ");
  }

  function paint() {
    if (state.destroyed) {
      return;
    }
    const view = viewSize();
    const pixelWidth = Math.max(1, Math.round(view.width * view.ratio));
    const pixelHeight = Math.max(1, Math.round(view.height * view.ratio));
    if (canvas.width !== pixelWidth || canvas.height !== pixelHeight) {
      canvas.width = pixelWidth;
      canvas.height = pixelHeight;
    }
    const context = canvas.getContext("2d");
    if (context === null) {
      return;
    }
    context.setTransform(1, 0, 0, 1, 0, 0);
    context.fillStyle = "#0d1015";
    context.fillRect(0, 0, canvas.width, canvas.height);
    updateTimeline();
    const working = workingSkeleton();
    if (working === null || state.atlas === null) {
      return;
    }
    const scene = sceneAt(working, workingAnimation(), state.time, {
      skin: currentSkinAttachments(),
    });
    const list = spineDrawList(scene, state.atlas);
    state.list = list;
    state.transforms = scene.transforms;
    if (state.camera === null) {
      state.camera = spineFit(spineDrawBounds(list.items), view.width, view.height);
    }
    const camera = state.camera;
    const pixel = (point) => ({
      x: ((point.x - camera.tx) * camera.scale + view.width / 2) * view.ratio,
      y: (view.height / 2 - (point.y - camera.ty) * camera.scale) * view.ratio,
    });
    for (const item of list.items) {
      const cache = cacheFor(item);
      if (cache === null) {
        continue;
      }
      const alpha = Array.isArray(item.colour) && Number.isFinite(item.colour[3])
        ? Math.max(0, Math.min(1, item.colour[3]))
        : 1;
      if (alpha <= 0) {
        continue;
      }
      const topLeft = pixel(item.quad.tl);
      const topRight = pixel(item.quad.tr);
      const bottomLeft = pixel(item.quad.bl);
      const width = Math.max(1, item.size.width);
      const height = Math.max(1, item.size.height);
      context.save();
      context.globalAlpha = alpha;
      context.setTransform(
        (topRight.x - topLeft.x) / width, (topRight.y - topLeft.y) / width,
        (bottomLeft.x - topLeft.x) / height, (bottomLeft.y - topLeft.y) / height,
        topLeft.x, topLeft.y,
      );
      context.drawImage(cache, 0, 0);
      context.restore();
    }
    if (state.showBones) {
      drawBones(context, pixel, scene.transforms, view.ratio);
    }
    if (state.error === null) {
      say(`${summaryText(list)}${editSuffix()}`);
    } else {
      say(state.error, "error");
    }
  }

  /* -- time ---------------------------------------------------------- */

  function advance(seconds) {
    const duration = editedDuration();
    if (duration <= 0) {
      state.time = 0;
      return;
    }
    state.time = (state.time + seconds) % duration;
    if (state.time < 0) {
      state.time += duration;
    }
  }

  function tick(now) {
    if (state.destroyed || !state.playing) {
      return;
    }
    const elapsed = state.lastTick === 0 ? 0 : Math.min(RIG_MAX_STEP, Math.max(0, (now - state.lastTick) / 1000));
    state.lastTick = now;
    advance(elapsed * state.speed);
    paint();
    if (state.playing) {
      state.frame = scheduleFrame(tick);
    }
  }

  function play() {
    if (state.skeleton === null || state.playing) {
      return;
    }
    state.playing = true;
    state.lastTick = 0;
    refreshControls();
    state.frame = scheduleFrame(tick);
  }

  function pause() {
    state.playing = false;
    cancelFrame(state.frame);
    state.frame = null;
    refreshControls();
  }

  function togglePlay() {
    if (state.playing) {
      pause();
    } else {
      play();
    }
  }

  function setTime(seconds) {
    const duration = editedDuration();
    state.time = Math.max(0, Math.min(duration, Number.isFinite(seconds) ? seconds : 0));
    refreshEditPanel();
    paint();
  }

  function markBones() {
    const rows = bonesList.querySelectorAll(".mod-row");
    rows.forEach((row, index) => {
      row.classList.toggle("is-selected", index === state.selectedBone);
    });
  }

  function selectBone(index) {
    state.selectedBone = typeof index === "number" && Number.isFinite(index) ? index : -1;
    if (!state.showBones && state.selectedBone >= 0) {
      state.showBones = true;
      writeToBoard();
      refreshControls();
    }
    paint();
    markBones();
    refreshEditPanel();
  }

  /* -- wiring -------------------------------------------------------- */

  listen(animSelect, "change", () => {
    const index = state.animations.findIndex((animation) => String(animation.index) === animSelect.value);
    state.animationIndex = index;
    state.time = 0;
    state.camera = null;
    writeToBoard();
    refreshControls();
    refreshEditPanel();
    paint();
  });

  listen(skinSelect, "change", () => {
    state.skinIndex = Number(skinSelect.value);
    if (!Number.isFinite(state.skinIndex)) {
      state.skinIndex = -1;
    }
    writeToBoard();
    refreshControls();
    paint();
  });

  listen(playButton, "click", togglePlay);

  listen(speedSelect, "change", () => {
    const speed = Number(speedSelect.value);
    state.speed = Number.isFinite(speed) && speed > 0 ? speed : 1;
  });

  listen(timeRange, "input", () => {
    setTime(Number(timeRange.value));
  });

  listen(bonesButton, "click", () => {
    state.showBones = !state.showBones;
    writeToBoard();
    refreshControls();
    paint();
  });

  listen(fitButton, "click", () => {
    state.camera = null;
    paint();
  });

  /* -- edit controls -------------------------------------------------- */

  listen(editButton, "click", () => {
    state.editMode = !state.editMode;
    refreshEditPanel();
    paint();
  });

  listen(resetButton, "click", () => {
    if (!hasEdits(state.edits)) {
      refreshEditPanel();
      paint();
      return;
    }
    applyEdit(emptyEdits());
  });

  listen(keyButton, "click", () => {
    const bone = state.selectedBone;
    const name = animationName();
    const pose = bone >= 0 ? localPoseOf(bone) : null;
    if (name === "" || pose === null) {
      return;
    }
    let next = setFrame(state.edits, state.skeleton, {
      animation: name,
      boneIndex: bone,
      type: "rotate",
      time: state.time,
      value: { angle: pose.rotation },
    });
    next = setFrame(next, state.skeleton, {
      animation: name,
      boneIndex: bone,
      type: "translate",
      time: state.time,
      value: { x: pose.x, y: pose.y },
    });
    applyEdit(next);
  });

  listen(unkeyButton, "click", () => {
    const bone = state.selectedBone;
    const name = animationName();
    if (name === "" || bone < 0) {
      return;
    }
    let next = removeFrame(state.edits, state.skeleton, {
      animation: name, boneIndex: bone, type: "rotate", time: state.time,
    });
    next = removeFrame(next, state.skeleton, {
      animation: name, boneIndex: bone, type: "translate", time: state.time,
    });
    applyEdit(next);
  });

  /** The inspector writes through the same path a drag does. */
  function commitInspector(type) {
    const bone = state.selectedBone;
    const pose = bone >= 0 ? localPoseOf(bone) : null;
    if (pose === null) {
      return;
    }
    if (type === "rotate") {
      const rotation = Number(rotationInput.value);
      if (Number.isFinite(rotation)) {
        writePose(bone, { angle: rotation }, "rotate");
      }
      return;
    }
    const x = Number(xInput.value);
    const y = Number(yInput.value);
    if (Number.isFinite(x) && Number.isFinite(y)) {
      writePose(bone, { x: x, y: y }, "translate");
    }
  }

  listen(xInput, "change", () => commitInspector("translate"));
  listen(yInput, "change", () => commitInspector("translate"));
  listen(rotationInput, "change", () => commitInspector("rotate"));

  listen(attachmentsList, "change", (event) => {
    const target = event.target;
    if (target === null || typeof target.closest !== "function") {
      return;
    }
    const select = target.closest("select[data-slot]");
    if (select === null) {
      return;
    }
    const slotIndex = Number(select.getAttribute("data-slot"));
    if (!Number.isFinite(slotIndex) || slotIndex < 0) {
      return;
    }
    const value = select.value;
    const name = animationName();
    if (name !== "" && value !== "") {
      applyEdit(setAttachmentFrame(state.edits, state.skeleton, {
        animation: name, slotIndex: slotIndex, time: state.time, name: value,
      }));
      return;
    }
    applyEdit(setAttachment(state.edits, slotIndex, value));
  });

  listen(fileInput, "change", () => {
    if (fileInput.value.trim() !== "") {
      load(fileInput.value.trim());
    }
  });

  listen(fileInput, "keydown", (event) => {
    if (event.key !== "Enter") {
      return;
    }
    event.preventDefault();
    if (fileInput.value.trim() !== "") {
      load(fileInput.value.trim());
    }
  });

  listen(canvas, "wheel", (event) => {
    if (state.camera === null) {
      return;
    }
    event.preventDefault();
    const rect = canvas.getBoundingClientRect();
    const offsetX = event.clientX - rect.left - rect.width / 2;
    const offsetY = event.clientY - rect.top - rect.height / 2;
    const factor = Math.exp(-event.deltaY * 0.0015);
    const scale = Math.min(RIG_ZOOM_MAX, Math.max(RIG_ZOOM_MIN, state.camera.scale * factor));
    const worldX = state.camera.tx + offsetX / state.camera.scale;
    const worldY = state.camera.ty - offsetY / state.camera.scale;
    state.camera = { scale, tx: worldX - offsetX / scale, ty: worldY + offsetY / scale };
    paint();
  }, { passive: false });

  let pan = null;
  /* -- writing ------------------------------------------------------- */

  /** `Uint8Array` to base64, without `Buffer`: this page has `btoa`. */
  function base64OfBytes(bytes) {
    let binary = "";
    const step = 0x8000;
    for (let index = 0; index < bytes.length; index += step) {
      binary += String.fromCharCode.apply(null, bytes.subarray(index, index + step));
    }
    return btoa(binary);
  }

  /**
   * Write the rig the canvas is showing back to the `.skel.bytes` it came from.
   *
   * `writeSkeletonBinary` emits the parsed model's own bytes -- including the raw
   * side-channel fields the reader kept because they cannot be recomputed -- so a
   * rig saved without edits is byte-identical to the file, and an edited one
   * differs only where it was edited.  The revision the file was read at travels
   * with the write, so a file that moved on disk is never overwritten silently.
   */
  async function save() {
    if (state.skeleton === null) {
      say("nothing to save: no skeleton is loaded", "warn");
      return false;
    }
    if (state.file === "") {
      say("no file to write — open one with `rig <path.skel.bytes>`", "warn");
      return false;
    }
    if (!hasEdits(state.edits)) {
      say("nothing to save — the rig is the file's own bytes", "warn");
      return false;
    }
    if (state.saving) {
      return false;
    }
    let bytes = null;
    try {
      bytes = writeSkeletonBinary(workingSkeleton());
    } catch (err) {
      say(`not saving: the writer refused (${err.message})`, "error");
      return false;
    }
    state.saving = true;
    refreshEditPanel();
    const counts = editCounts(state.edits);
    const note = plural(counts.bones, "bone", "bones") + `, ${plural(counts.slots, "slot", "slots")}, ${plural(counts.frames, "key", "keys")}`;
    say(`writing ${spineBaseOf(state.file)} (${bytes.length} bytes, ${note})…`);
    const params = { path: state.file, base64: base64OfBytes(bytes) };
    if (state.baseRevision !== null) {
      params.base_revision = state.baseRevision;
    }
    try {
      const result = await client.call("file.write_bytes", params);
      const applied = workingSkeleton();
      state.baseRevision = typeof result.revision === "number" ? result.revision : state.baseRevision;
      // What is on disk is now exactly the model that was written: no reload, no reparse.
      state.skeleton = applied;
      state.working = applied;
      state.edits = emptyEdits();
      state.saving = false;
      // A duration edit can reshape the timeline, so the chrome is rebuilt from
      // the model that was just written rather than from the one before it.
      state.animations = (Array.isArray(applied.animations) ? applied.animations : []).map((animation, index) => ({
        index,
        name: typeof animation.name === "string" ? animation.name : `animation ${index}`,
        duration: typeof animation.duration === "number" && Number.isFinite(animation.duration) ? animation.duration : 0,
      }));
      fillSelects();
      refreshBones();
      refreshControls();
      refreshEditPanel();
      paint();
      say(`saved ${spineBaseOf(state.file)} — ${bytes.length} bytes, revision ${state.baseRevision === null ? "?" : state.baseRevision}`, "info");
      return true;
    } catch (err) {
      state.saving = false;
      refreshEditPanel();
      if (client.isStaleRevision(err)) {
        // The file moved under us.  Ask the app the same question an editor card
        // gets; the one thing this must never do is write anyway.
        const current = err.data === null || err.data === undefined
          ? null
          : (typeof err.data === "object" ? err.data.current_revision : err.data);
        const choice = app.resolveStale
          ? await app.resolveStale({ path: state.file, current, cardId: card.id })
          : "cancel";
        if (choice === "overwrite") {
          state.baseRevision = typeof current === "number" ? current : null;
          return save();
        }
        if (choice === "reload") {
          return load(state.file);
        }
        say(`${state.file} changed on disk; nothing was written`, "warn");
        return false;
      }
      say(`save failed: ${err.message}`, "error");
      return false;
    }
  }

  listen(saveButton, "click", () => {
    save();
  });

  /** The in-flight bone drag, or null while the canvas pans. */
  let editDrag = null;
  /** A drag that moved is an edit, not a pick: it must not re-select on mouseup. */
  let suppressPick = false;

  listen(canvas, "mousedown", (event) => {
    if (event.button !== 0) {
      return;
    }
    const bone = state.selectedBone;
    if (state.editMode && bone >= 0 && state.camera !== null && state.skeleton !== null) {
      const origin = worldOriginOf(bone);
      const pose = localPoseOf(bone);
      if (origin !== null && pose !== null) {
        const screen = screenPointOf(origin);
        editDrag = {
          boneIndex: bone,
          mode: event.shiftKey ? "translate" : "rotate",
          startX: event.clientX,
          startY: event.clientY,
          startAngle: Math.atan2(screen.y - event.clientY, event.clientX - screen.x),
          base: { x: pose.x, y: pose.y, rotation: pose.rotation },
          moved: false,
        };
        event.preventDefault();
        return;
      }
    }
    pan = { x: event.clientX, y: event.clientY };
  });
  listen(window, "mousemove", (event) => {
    if (editDrag !== null) {
      const dx = event.clientX - editDrag.startX;
      const dy = event.clientY - editDrag.startY;
      if (!editDrag.moved && Math.hypot(dx, dy) > 2) {
        editDrag.moved = true;
      }
      if (editDrag.moved && state.camera !== null) {
        if (editDrag.mode === "rotate") {
          const origin = worldOriginOf(editDrag.boneIndex);
          if (origin !== null) {
            /*
             * The angle swept around the bone's on-screen origin, in world
             * degrees: the screen's y axis points down, so atan2 is fed the
             * negated y difference and the sweep keeps its sign.
             */
            const screen = screenPointOf(origin);
            const angle = Math.atan2(screen.y - event.clientY, event.clientX - screen.x);
            let delta = ((angle - editDrag.startAngle) * 180) / Math.PI;
            while (delta > 180) delta -= 360;
            while (delta < -180) delta += 360;
            writePose(editDrag.boneIndex, { angle: editDrag.base.rotation + delta }, "rotate");
          }
        } else {
          writePose(editDrag.boneIndex, {
            x: editDrag.base.x + dx / state.camera.scale,
            y: editDrag.base.y - dy / state.camera.scale,
          }, "translate");
        }
      }
      return;
    }
    if (pan === null || state.camera === null) {
      return;
    }
    const dx = event.clientX - pan.x;
    const dy = event.clientY - pan.y;
    pan = { x: event.clientX, y: event.clientY };
    state.camera = {
      scale: state.camera.scale,
      tx: state.camera.tx - dx / state.camera.scale,
      ty: state.camera.ty + dy / state.camera.scale,
    };
    paint();
  });
  listen(window, "mouseup", () => {
    if (editDrag !== null) {
      suppressPick = editDrag.moved;
      editDrag = null;
    }
    pan = null;
  });

  listen(canvas, "click", (event) => {
    if (suppressPick) {
      suppressPick = false;
      return;
    }
    if (state.skeleton === null || state.list === null || !state.showBones) {
      return;
    }
    const rect = canvas.getBoundingClientRect();
    const x = event.clientX - rect.left;
    const y = event.clientY - rect.top;
    const camera = state.camera;
    if (camera === null) {
      return;
    }
    const world = {
      x: camera.tx + (x - rect.width / 2) / camera.scale,
      y: camera.ty - (y - rect.height / 2) / camera.scale,
    };
    const transforms = state.transforms ?? [];
    let best = -1;
    let bestDistance = Infinity;
    for (const line of spineBoneLines(workingSkeleton(), transforms)) {
      const distance = Math.hypot(line.origin.x - world.x, line.origin.y - world.y);
      if (distance < bestDistance) {
        bestDistance = distance;
        best = line.index;
      }
    }
    const limit = 10 / camera.scale;
    selectBone(bestDistance <= limit ? best : -1);
  });

  listen(canvas, "keydown", (event) => {
    if ((event.ctrlKey || event.metaKey) && (event.key === "s" || event.key === "S")) {
      event.preventDefault();
      save();
      return;
    }
    if (event.key === " ") {
      event.preventDefault();
      togglePlay();
      return;
    }
    if (event.key !== "ArrowLeft" && event.key !== "ArrowRight") {
      return;
    }
    event.preventDefault();
    const duration = editedDuration();
    const step = (duration > 0 ? duration : 1) / 60;
    setTime(state.time + (event.key === "ArrowRight" ? step : -step));
  });

  /* -- go ------------------------------------------------------------ */

  canvas.setAttribute("aria-label", "the posed skeleton");
  refreshBones();
  refreshControls();
  refreshEditPanel();
  if (state.file !== "") {
    load(state.file);
  } else {
    say("no skeleton yet: open one with `rig <path.skel.bytes>`");
  }
  paint();

  /*
   * The first paint runs while the card is still detached, so the canvas can
   * measure 0 and the camera would be fitted to nothing.  One repaint after the
   * layout is where the environment has frames; the probe paints again through
   * the same path once it has laid the card out.
   */
  if (typeof requestAnimationFrame === "function") {
    requestAnimationFrame(() => paint());
  }

  return {
    el: shell.el,
    handle: {
      kind: "rig",
      hasPath(path) {
        return state.file === path;
      },
      /** The skeleton path this card shows; the watch names the file by it. */
      get path() {
        return state.file;
      },
      /**
       * Adopt the skeleton as it is on disk now, discarding the edit panel.
       *
       * Only a clean card is ever asked (`watch.mjs` warns instead whenever
       * `dirty()` is true); the guard is for the race, not the normal path.
       */
      reload() {
        if (hasEdits(state.edits)) {
          return Promise.resolve(false);
        }
        return load(state.file);
      },
      /** The file is gone from disk: say so. Saving writes the model back. */
      onFileGone() {
        say("gone from disk — save writes it back", "warn");
        app.log("warn", `${state.file} is gone from disk`);
      },
      /** External change: report it, never reload over unsaved edits. */
      onFileChanged(revision) {
        if (revision !== null && revision === state.baseRevision) {
          return;
        }
        say(`changed on disk (rev ${revision}) — save overwrites`, "warn");
        app.log("warn", `${state.file} changed on disk (rev ${revision})`);
      },
      load,
      skeleton() {
        return state.skeleton;
      },
      atlas() {
        return state.atlas;
      },
      drawList() {
        return state.list;
      },
      animations() {
        return state.animations.slice();
      },
      animation() {
        return currentAnimation();
      },
      setAnimation(name) {
        const index = state.animations.findIndex((animation) => animation.name === name);
        if (index >= 0) {
          state.animationIndex = index;
          state.time = 0;
          state.camera = null;
          writeToBoard();
          refreshControls();
          refreshEditPanel();
          paint();
        }
        return index >= 0;
      },
      setTime,
      time() {
        return state.time;
      },
      play,
      pause,
      isPlaying() {
        return state.playing;
      },
      setBones(value) {
        state.showBones = value === true;
        writeToBoard();
        refreshControls();
        paint();
      },
      showBones() {
        return state.showBones;
      },
      selectBone,
      selectedBone() {
        return state.selectedBone;
      },
      fit() {
        state.camera = null;
        paint();
      },
      /** The last page error per page, for a caller that wants to say so. */
      pageErrors() {
        return [...state.pageErrors.entries()].map(([page, message]) => ({ page, message }));
      },
      /**
       * The in-memory edit (a copy, so a caller cannot mutate the card's).
       * `save()` below is what writes it; nothing writes on its own.
       */
      edits() {
        return cloneEdits(state.edits);
      },
      setEdits(value) {
        state.edits = cloneEdits(value);
        state.working = state.skeleton === null ? null : applyEdits(state.skeleton, state.edits);
        refreshEditPanel();
        paint();
      },
      resetEdits() {
        state.edits = emptyEdits();
        state.working = state.skeleton === null ? null : applyEdits(state.skeleton, state.edits);
        refreshEditPanel();
        paint();
      },
      dirty() {
        return hasEdits(state.edits);
      },
      /** Write the edited rig back to its own file; resolves true when it landed. */
      save() {
        return save();
      },
      /** The revision the skeleton bytes came from, or null before a read. */
      revision() {
        return state.baseRevision;
      },
      /** The parsed skeleton with the edits applied -- what the canvas draws. */
      working() {
        return workingSkeleton();
      },
    },
    destroy() {
      state.destroyed = true;
      state.playing = false;
      cancelFrame(state.frame);
      state.frame = null;
      for (const cleanup of cleanups) {
        cleanup();
      }
      cleanups.length = 0;
      state.textures.clear();
      state.caches.clear();
    },
  };
}

/* ------------------------------------------------------------------ */
/* the game's mod surfaces                                              */
/* ------------------------------------------------------------------ */

/*
 * Three card kinds that make this board a mod IDE for the game instead of a
 * generic canvas.  All three are read-mostly: they call the shell's `mod.*`
 * verbs (which own the game knowledge) and hand paths to the `editor` card
 * that already exists.  None of them reaches the kernel directly, and none of
 * them needs a kernel change, because a card's payload is stored verbatim.
 */
