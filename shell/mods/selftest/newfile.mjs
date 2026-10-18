import { HERE, require, createMods, check, section, mods, types } from "./foundation.mjs";
import { spawn, spawnSync } from "node:child_process";
import { createRequire } from "node:module";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

section("new file by type: mod.newFile");
{
  const sandbox = mkdtempSync(join(tmpdir(), "infantgod-newfile-"));
  try {
    const fresh = createMods({ modsRoot: sandbox });
    const created = await fresh.scaffold({ dir: join(sandbox, "Files"), modName: "Files", template: "full" });
    const pkg = created.modRoot;
    const newfileCore = require(join(HERE, "newfile.js"));
    const readText = (rel) => readFileSync(join(pkg, rel), "utf8");
    const readBytes = (rel) => readFileSync(join(pkg, rel));

    /* a schema type -------------------------------------------------- */

    const definePath = "Defines/Attr/NewAttr.json";
    const define = fresh.newFile({ dir: pkg, type: "Attr", name: "NewAttr" });
    check("a schema type is written at Defines/<Type>/<name>.json",
      define.path === definePath && define.kind === "define" && define.warnings.length === 0,
      JSON.stringify(define));
    const defineText = readText(definePath);
    check("the writer reports the byte length it wrote",
      define.bytes === Buffer.byteLength(defineText), define.bytes + " vs " + Buffer.byteLength(defineText));
    const attrType = fresh.types().find((t) => t.type === "Attr");
    check("the JSON carries exactly the schema's required keys",
      JSON.stringify(Object.keys(JSON.parse(defineText))) === JSON.stringify(attrType.required),
      defineText.trim());
    check("the identity field equals the file name (so M006 can hold)",
      JSON.parse(defineText).techName === "NewAttr", defineText.trim());
    check("it is pretty JSON with a trailing newline",
      defineText.startsWith('{\n  "techName": "NewAttr"') && defineText.endsWith("\n"), JSON.stringify(defineText));
    const defineCheck = fresh.validateDefineText({ type: "Attr", text: defineText, relPath: definePath });
    check("validateDefineText reports zero errors for it",
      defineCheck.errors === 0, JSON.stringify(defineCheck.diagnostics));

    /* overwrite is opt-in -------------------------------------------- */

    const duplicate = (() => {
      try {
        fresh.newFile({ dir: pkg, type: "Attr", name: "NewAttr" });
        return null;
      } catch (err) {
        return err.message;
      }
    })();
    check("writing it again without overwrite refuses and says how",
      typeof duplicate === "string" && duplicate.includes("already exists") && duplicate.includes("overwrite: true"),
      String(duplicate));
    const rewritten = fresh.newFile({ dir: pkg, type: "Attr", name: "NewAttr", overwrite: true });
    check("overwrite: true rewrites the same path",
      rewritten.path === definePath && readText(definePath) === defineText, JSON.stringify(rewritten));

    /* yarn ----------------------------------------------------------- */

    const storyPath = "Yarn/NewStory.yarn";
    const story = fresh.newFile({ dir: pkg, type: "yarn", name: "NewStory" });
    const storyText = readText(storyPath);
    check("yarn is written at Yarn/<name>.yarn with the repo's story header",
      story.path === storyPath && storyText.startsWith("title: NewStory\nwhen: always\n---\n")
        && storyText.includes("-> END\n===\n"),
      JSON.stringify(story));
    const storyDiag = fresh.diagnoseYarn({ text: storyText, fileName: storyPath, root: pkg });
    check("the generated story parses with zero diagnostics",
      storyDiag.available === true && storyDiag.diagnostics.length === 0,
      JSON.stringify(storyDiag.diagnostics));
    check("its #line: id is derived from the name, not from the clock",
      newfileCore.yarnStoryFor("NewStory") === storyText && newfileCore.lineIdFor("NewStory").length === 8,
      newfileCore.lineIdFor("NewStory"));

    /* translation ---------------------------------------------------- */

    const csvPath = "Yarn/NewStory.csv";
    const csv = fresh.newFile({ dir: pkg, type: "translation", name: "NewStory" });
    const csvBytes = readBytes(csvPath);
    check("translation is written at Yarn/<name>.csv",
      csv.path === csvPath && csv.kind === "translation", JSON.stringify(csv));
    check("the CSV is BOM + CRLF + the real 8-column header, with no rows",
      csvBytes[0] === 0xef && csvBytes[1] === 0xbb && csvBytes[2] === 0xbf
        && csvBytes.slice(3).toString("utf8")
          === "language,id,text,file,node,lineNumber,lock,comment\r\n",
      JSON.stringify(csvBytes.slice(0, 3).toString("hex") + " " + csvBytes.slice(3).toString("utf8")));
    check("the header still lists lineNumber/lock/comment (the docs' 4 columns are stale)",
      newfileCore.TRANSLATION_HEADER.split(",").length === 8, newfileCore.TRANSLATION_HEADER);

    /* sprite --------------------------------------------------------- */

    const spritePath = "Sprites/NewIcon.png";
    const sprite = fresh.newFile({ dir: pkg, type: "sprite", name: "NewIcon" });
    const png = readBytes(spritePath);
    const pngSignature = png.slice(0, 8).toString("hex");
    check("sprite is written at Sprites/<name>.png",
      sprite.path === spritePath && sprite.kind === "sprite", JSON.stringify(sprite));
    check("the bytes are a PNG with a plausible IHDR",
      pngSignature === "89504e470d0a1a0a"
        && png.slice(12, 16).toString("ascii") === "IHDR"
        && png.readUInt32BE(16) === 96 && png.readUInt32BE(20) === 96,
      pngSignature + " " + png.slice(12, 16).toString("ascii") + " " + png.readUInt32BE(16) + "x" + png.readUInt32BE(20));

    /* refusals ------------------------------------------------------- */

    const refusal = (params) => {
      try {
        fresh.newFile(params);
        return null;
      } catch (err) {
        return err.message;
      }
    };
    const spine = refusal({ dir: pkg, type: "spine", name: "Rig" });
    check("spine refuses and names Spine, so the UI can say why before writing",
      typeof spine === "string" && spine.includes("Spine"), String(spine));
    const audio = refusal({ dir: pkg, type: "audio", name: "Sfx" });
    check("audio refuses and names the tool that could make one",
      typeof audio === "string" && /recording|synthesiser/.test(audio), String(audio));
    const unknown = refusal({ dir: pkg, type: "Bogus", name: "X" });
    check("an unknown type refuses by name",
      typeof unknown === "string" && unknown.includes('unknown type "Bogus"'), String(unknown));
    const escaping = refusal({ dir: pkg, type: "yarn", name: "../Escape" });
    check("a name that would escape the package is refused before any write",
      typeof escaping === "string" && /path separator/.test(escaping) && !existsSync(join(sandbox, "Escape.yarn")),
      String(escaping));
    check("every refusal message starts with the verb prefix",
      [spine, audio, unknown, escaping].every((m) => typeof m === "string" && m.startsWith("new file: ")),
      JSON.stringify([spine, audio, unknown, escaping]));
    const missing = ["dir", "type", "name"].map((key) => {
      const params = { dir: pkg, type: "yarn", name: "Probe" };
      delete params[key];
      return refusal(params);
    });
    check("dir, type and name are all required",
      missing.every((m) => typeof m === "string" && m.includes("is required")), JSON.stringify(missing));
    const badName = refusal({ dir: pkg, type: "Attr", name: "Not-An-Identifier" });
    check("a schema type's name must be an identifier (it is also the techName)",
      typeof badName === "string" && badName.includes("not a valid techName"), String(badName));

    /* dir resolution ------------------------------------------------- */

    const fromSubdir = fresh.newFile({ dir: join(pkg, "Yarn"), type: "Attr", name: "FromSubdir" });
    check("dir may be a subdirectory of the package and still lands at the package root",
      fromSubdir.path === "Defines/Attr/FromSubdir.json", JSON.stringify(fromSubdir));
    mkdirSync(join(sandbox, "not-a-mod"), { recursive: true });
    const outside = refusal({ dir: join(sandbox, "not-a-mod"), type: "yarn", name: "X" });
    check("a directory outside any package refuses with the package sentence",
      typeof outside === "string" && outside.includes("is not inside a mod package"), String(outside));
    const relative = fresh.newFile({ dir: "Files/Files", type: "translation", name: "Relative" });
    check("dir may be relative to the mods root",
      relative.path === "Yarn/Relative.csv", JSON.stringify(relative));

    const caseInsensitive = fresh.newFile({ dir: pkg, type: "attr", name: "CaseProbe" });
    check("a lowercase type resolves to the schema's real spelling",
      caseInsensitive.path === "Defines/Attr/CaseProbe.json", JSON.stringify(caseInsensitive));

    /* the cache a following mod.open reads --------------------------- */

    const before = fresh.openMod({ dir: pkg });
    const openedPath = "Defines/Attr/OpenedAfter.json";
    fresh.newFile({ dir: pkg, type: "Attr", name: "OpenedAfter" });
    const after = fresh.openMod({ dir: pkg });
    check("mod.open sees a file written moments earlier (the scan cache was invalidated)",
      !before.defines.some((d) => d.file === openedPath) && after.defines.some((d) => d.file === openedPath),
      JSON.stringify(after.defines.map((d) => d.file).slice(-3)));

    /* every schema type, not just Attr -------------------------------- */

    const typedMods = createMods({ modsRoot: sandbox });
    const typedCreated = await typedMods.scaffold({ dir: join(sandbox, "Typed"), modName: "Typed", template: "minimal" });
    const typedPkg = typedCreated.modRoot;
    const schemaTypes = typedMods.types();
    const broken = [];
    for (const t of schemaTypes) {
      try {
        const written = typedMods.newFile({ dir: typedPkg, type: t.type, name: "Probe_" + t.type });
        const verdict = typedMods.validateDefineText({
          type: t.type,
          text: readFileSync(written.file, "utf8"),
          relPath: written.path,
        });
        if (verdict.errors !== 0) broken.push(t.type + ": " + JSON.stringify(verdict.diagnostics));
      } catch (err) {
        broken.push(t.type + ": " + err.message);
      }
    }
    check("every one of the 51 schema types generates a define that validates clean",
      schemaTypes.length === 51 && broken.length === 0, JSON.stringify(broken.slice(0, 3)));

    /* determinism ---------------------------------------------------- */

    const planA = newfileCore.planNewFile({ type: "yarn", name: "Same" });
    const planB = newfileCore.planNewFile({ type: "yarn", name: "Same" });
    check("planning the same file twice gives the same bytes (no clock, no random)",
      JSON.stringify(planA) === JSON.stringify(planB), JSON.stringify(planA));
    check("the planner writes nothing by itself",
      !existsSync(join(pkg, "Yarn", "Same.yarn")), "Yarn/Same.yarn");
  } finally {
    rmSync(sandbox, { recursive: true, force: true });
  }
}

/* ------------------------------------------------------------------ */

/*
 * 导入和新建是两条腿：新建从 schema 生成，导入把一个磁盘上已有的文件搬进包。
 * 这一节只锁「搬」的契约：目标目录规则、`to`/`name` 语义、逐字节保真、
 * 校验失败要删掉刚拷贝的文件、overwrite、路径逃逸拒绝。
 *
 * 字节保真为什么值得单测：导入最常见的用途就是把别处已经能用的文件原样放进
 * 包，任何 BOM/换行/重编码的"顺手整理"都会让内容悄悄变样 —— 而 §18.2 的
 * 原则是「编辑既有文件＝字节保真」，导入是它的第一现场。
 */
