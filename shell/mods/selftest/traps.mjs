/**
 * traps.mjs -- G10：schema 只能给形状、给不了约定的那些 wiki 陷阱。
 *
 * 这一组检查只使用临时目录里的合成包，不依赖游戏语料：
 *
 *   D019  EventReference（FMOD 事件引用）不能用 JSON 手写
 *   D020  Yarn 的 GetTopic() / WasVisited() 在求值时读运行时状态
 *   D021  Character.initialTransform 的文档值是 -7.2；画布是 256×144
 *   D022  Unity GUID 的形状（全零 / 连字符 / 非法）
 *
 * 最后一段在真语料上量一遍计数（有语料时才跑），确认新增的四个码只有
 * warning/info，且没有把干净包变成 error。
 */

import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { join } from "node:path";

import { HAVE_CORPUS, specMods, specTemp, specWrite } from "./corpus.mjs";
import { HERE, MODS_DIR, check, section } from "./foundation.mjs";

const require = createRequire(import.meta.url);
const validateCore = require(join(HERE, "validate.js"));
const scaffold = require(join(HERE, "scaffold.js"));

const KB = JSON.parse(readFileSync(join(HERE, "knowledge.json"), "utf8"));
const buildDefine = scaffold.__internal.buildDefineObject;

function tempMod(name) {
  const root = join(specTemp("infantgod-traps-"), name);
  specWrite(join(root, "mod.json"), JSON.stringify({
    name,
    version: "1.0.0",
    gameVersion: "1.0",
    loadOrder: 50,
    author: "selftest",
    description: "G10 trap fixture",
  }, null, 2) + "\n");
  return root;
}

function cloneKb() {
  return JSON.parse(JSON.stringify(KB));
}

function codesOf(diagnostics, code) {
  return diagnostics.filter((d) => d.code === code);
}

function hasSeverity(diagnostics, severity) {
  return diagnostics.some((d) => d.severity === severity);
}

/* ------------------------------------------------------------------ */

section("G10: EventReference cannot be constructed from JSON (D019)");

{
  const root = tempMod("TrapFmod");
  const bad = buildDefine("AudioEvent", "Trap_Fmod", {
    eventReference: "event:/trap/hum",
  });
  specWrite(join(root, "Defines", "AudioEvent", "Trap_Fmod.json"),
    JSON.stringify(bad, null, 2) + "\n");

  const report = validateCore.validateModPackage(root, { kb: KB });
  const d019 = codesOf(report.diagnostics, "D019");
  check("a hand-written string EventReference is D019", d019.length === 1,
    JSON.stringify(report.diagnostics.map((d) => d.code)));
  check("D019 names the field path", d019.some((d) => /#eventReference$/.test(d.path)),
    d019.map((d) => d.path).join(","));
  check("D019 says the value must come from Unity/the game",
    d019.every((d) => /Unity\/FMOD/.test(d.message) && /游戏\/Unity|game\/Unity/.test(d.message)),
    d019.map((d) => d.message).join(" | "));
  check("D019 is not an error", !hasSeverity(d019, "error"));
  check("the type error is still reported alongside the trap warning",
    report.diagnostics.some((d) => d.code === "D003" && /#eventReference$/.test(d.path)),
    JSON.stringify(report.diagnostics.map((d) => d.code)));

  const cleanMod = tempMod("TrapFmodClean");
  const clean = buildDefine("AudioEvent", "Trap_FmodOk", {
    eventReference: {
      Guid: { Data1: 12, Data2: 34, Data3: 56, Data4: 78 },
      Path: "event:/trap/hum",
    },
  });
  specWrite(join(cleanMod, "Defines", "AudioEvent", "Trap_FmodOk.json"),
    JSON.stringify(clean, null, 2) + "\n");
  const again = validateCore.validateModPackage(cleanMod, { kb: KB });
  check("a complete {Guid,Path} EventReference is not D019",
    codesOf(again.diagnostics, "D019").length === 0,
    JSON.stringify(codesOf(again.diagnostics, "D019").map((d) => d.path)));
  check("a package with a complete EventReference has no errors", !hasSeverity(again.diagnostics, "error"),
    JSON.stringify(again.diagnostics.filter((d) => d.severity === "error").map((d) => d.code + ":" + d.message)));
}

/* ------------------------------------------------------------------ */

section("G10: Yarn GetTopic()/WasVisited() are not pure (D020)");

{
  const root = tempMod("TrapYarn");
  specWrite(join(root, "Yarn", "Side.yarn"),
    "title: TrapSide\n---\n<<if GetTopic(\"TrapTopic\") > 0>>\n台词。 #line:abc1234\n<<endif>>\n===\n");
  specWrite(join(root, "Yarn", "Visited.yarn"),
    "title: TrapVisited\n---\n<<if WasVisited()>>\n台词。 #line:abc1235\n<<endif>>\n===\n");
  specWrite(join(root, "Yarn", "Talk.yarn"),
    "title: TrapTalk\n---\n" +
    "Narrator: 调用 WasVisited() 会读到运行时状态。 #line:abc1236\n" +
    "// GetTopic(\"x\") 写在注释里不是调用\n===\n");

  const report = validateCore.validateModPackage(root, { kb: KB });
  const d020 = codesOf(report.diagnostics, "D020");
  check("one D020 per calling file, none for prose or comments", d020.length === 2,
    JSON.stringify(d020.map((d) => d.path)));
  check("D020 points at the GetTopic line", d020.some((d) => /Side\.yarn/.test(d.path) && /第 3 行/.test(d.message)),
    JSON.stringify(d020.map((d) => d.path + " " + d.message)));
  check("D020 also catches WasVisited", d020.some((d) => /Visited\.yarn/.test(d.path) && /WasVisited/.test(d.message)),
    JSON.stringify(d020.map((d) => d.path)));
  check("the prose mention in Talk.yarn is not D020", d020.every((d) => !/Talk\.yarn/.test(d.path)),
    JSON.stringify(d020.map((d) => d.path)));
  check("D020 is not an error", !hasSeverity(d020, "error"));
}

/* ------------------------------------------------------------------ */

section("G10: Character.initialTransform is -7.2 (D021)");

{
  const root = tempMod("TrapCharacter");
  const obj = buildDefine("Character", "Trap_Hero");
  check("the scaffold itself writes the documented -7.2",
    obj.initialTransform === -7.2, String(obj.initialTransform));

  const ok = validateCore.validateDefine("Character", obj, { kb: KB, modRoot: root, techNames: ["Trap_Hero"] });
  check("the scaffolded Character is not D021", codesOf(ok, "D021").length === 0,
    JSON.stringify(ok.map((d) => d.code)));

  const drifted = validateCore.validateDefine("Character",
    Object.assign({}, obj, { initialTransform: 0 }),
    { kb: KB, modRoot: root, techNames: ["Trap_Hero"] });
  const d021 = codesOf(drifted, "D021");
  check("initialTransform 0 is D021", d021.length === 1,
    JSON.stringify(drifted.map((d) => d.code + ":" + (d.path || ""))));
  check("D021 names the field and the documented value",
    d021.every((d) => /initialTransform/.test(d.path || "") && /-7\.2/.test(d.message)),
    JSON.stringify(d021.map((d) => d.path + " " + d.message)));

  const float32 = validateCore.validateDefine("Character",
    Object.assign({}, obj, { initialTransform: -7.199999809265137 }),
    { kb: KB, modRoot: root, techNames: ["Trap_Hero"] });
  check("the corpus float32 rounding -7.199999809265137 is accepted",
    codesOf(float32, "D021").length === 0,
    JSON.stringify(float32.map((d) => d.code)));
}

/* ------------------------------------------------------------------ */

section("G10: the 256x144 canvas (D021)");

/*
 * 今天的知识库里没有哪个 schema 声明画布几何字段（UIAnimation 也没有），
 * 所以真实语料上这条分支不会命中。为了让检查本身被证明，这里给 UIAnimation
 * 的副本补上游戏将来可能导出的字段——这正是 D021 要检查的形状。
 */
{
  const kb = cloneKb();
  const props = kb.schemas.UIAnimation.properties;
  props.canvasWidth = { type: "number" };
  props.canvasHeight = { type: "number" };
  props.canvasSize = { type: "string" };

  const bad = validateCore.validateDefine("UIAnimation",
    Object.assign(buildDefine("UIAnimation", "Trap_Ui"), { canvasWidth: 320, canvasHeight: 180 }),
    { kb });
  const d021 = codesOf(bad, "D021");
  check("320x180 is two D021 warnings", d021.length === 2,
    JSON.stringify(d021.map((d) => d.path)));
  check("D021 reports the documented 256x144",
    d021.every((d) => /256×144/.test(d.message)), JSON.stringify(d021.map((d) => d.message)));

  const good = validateCore.validateDefine("UIAnimation",
    Object.assign(buildDefine("UIAnimation", "Trap_Ui"), { canvasWidth: 256, canvasHeight: 144, canvasSize: "256x144" }),
    { kb });
  check("256x144 is not D021", codesOf(good, "D021").length === 0,
    JSON.stringify(good.map((d) => d.code)));

  const size = validateCore.validateDefine("UIAnimation",
    Object.assign(buildDefine("UIAnimation", "Trap_Ui"), { canvasSize: "320x180" }),
    { kb });
  check("a size string that drifts is D021", codesOf(size, "D021").length === 1,
    JSON.stringify(size.map((d) => d.path)));
}

/* ------------------------------------------------------------------ */

section("G10: Unity GUID shapes (D022)");

{
  const kb = cloneKb();
  kb.schemas.EchoGuidProbe = {
    type: "object",
    properties: { guid: { type: "string" } },
  };

  const zero = validateCore.validateDefine("EchoGuidProbe", { guid: "0".repeat(32) }, { kb });
  const d022zero = codesOf(zero, "D022");
  check("an all-zero 32-hex GUID is D022", d022zero.length === 1,
    JSON.stringify(zero.map((d) => d.code)));
  check("the all-zero GUID is a warning", d022zero.every((d) => d.severity === "warning"),
    d022zero.map((d) => d.severity).join(","));

  const valid = validateCore.validateDefine("EchoGuidProbe", { guid: "0123456789abcdef0123456789abcdef" }, { kb });
  check("a normal 32-hex GUID is not D022", codesOf(valid, "D022").length === 0,
    JSON.stringify(valid.map((d) => d.code)));

  const dashed = validateCore.validateDefine("EchoGuidProbe",
    { guid: "01234567-89ab-cdef-0123-456789abcdef" }, { kb });
  check("the dashed .NET form is D022 info", codesOf(dashed, "D022").length === 1 &&
    codesOf(dashed, "D022").every((d) => d.severity === "info"),
    JSON.stringify(codesOf(dashed, "D022").map((d) => d.severity + ":" + d.code)));

  const junk = validateCore.validateDefine("EchoGuidProbe", { guid: "not-a-guid" }, { kb });
  check("an invalid GUID string is D022 info", codesOf(junk, "D022").length === 1 &&
    codesOf(junk, "D022").every((d) => d.severity === "info"),
    JSON.stringify(codesOf(junk, "D022").map((d) => d.severity + ":" + d.code)));

  const eventKb = cloneKb();
  const eventObj = buildDefine("AudioEvent", "Trap_ZeroGuid", {
    eventReference: {
      Guid: { Data1: 0, Data2: 0, Data3: 0, Data4: 0 },
      Path: "event:/trap/zero",
    },
  });
  const event = validateCore.validateDefine("AudioEvent", eventObj, { kb: eventKb });
  const d022 = codesOf(event, "D022");
  check("an all-zero EventReference.Guid is D022", d022.length === 1,
    JSON.stringify(event.map((d) => d.code + ":" + (d.path || ""))));
  check("the all-zero EventReference.Guid path is the Guid slot",
    d022.every((d) => /(^|#)eventReference\.Guid$/.test(d.path)),
    d022.map((d) => d.path).join(","));
  check("a zero Guid is not D019 (the shape is complete)", codesOf(event, "D019").length === 0,
    JSON.stringify(codesOf(event, "D019").map((d) => d.path)));
}

/* ------------------------------------------------------------------ */

section("G10: calibration on the real corpora");

if (!HAVE_CORPUS) {
  check("corpus calibration is skipped without a game folder", true);
} else {
  const expected = 0;
  for (const name of ["MyMod", "SODefines"]) {
    const report = specMods.validatePackage({ root: join(MODS_DIR, name) });
    const newCodes = report.diagnostics.filter((d) => /^(D019|D020|D021|D022)$/.test(d.code));
    check(`${name}: G10 codes carry no errors`, newCodes.every((d) => d.severity !== "error"),
      JSON.stringify(newCodes.filter((d) => d.severity === "error").map((d) => d.code + ":" + d.path)));
    const d021 = codesOf(report.diagnostics, "D021");
    check(`${name}: no D021 drift in the corpus (expected ${expected})`, d021.length === 0,
      JSON.stringify(d021.slice(0, 5).map((d) => d.path + " " + d.message)));
  }
}
