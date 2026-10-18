import { HERE, require, createMods, checks, check, section, mods } from "./foundation.mjs";
import { spawn, spawnSync } from "node:child_process";
import { createRequire } from "node:module";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

section("import a file into a mod package: mod.importFile");
{
  const sandbox = mkdtempSync(join(tmpdir(), "infantgod-importfile-"));
  // 绝对路径的来源要放在 modsRoot 之外，才能证明 from 可以来自包外。
  const elsewhere = mkdtempSync(join(tmpdir(), "infantgod-import-src-"));
  try {
    const fresh = createMods({ modsRoot: sandbox });
    const created = await fresh.scaffold({ dir: join(sandbox, "Importer"), modName: "Importer", template: "full" });
    const pkg = created.modRoot;
    const importfileCore = require(join(HERE, "importfile.js"));
    const newfileCore = require(join(HERE, "newfile.js"));
    const readBytes = (rel) => readFileSync(join(pkg, rel));
    const refused = (params) => {
      try {
        fresh.importFile(params);
        return null;
      } catch (err) {
        return err.message;
      }
    };

    const sources = join(sandbox, "sources"); // 包外、modsRoot 内：可走相对路径
    mkdirSync(sources, { recursive: true });

    /* PNG：字节保真 + 目标目录 --------------------------------------- */

    const png = newfileCore.makeSpritePng();
    const pngSource = join(elsewhere, "hero.png");
    writeFileSync(pngSource, png);
    const importedPng = fresh.importFile({ dir: pkg, from: pngSource, name: "hero" });
    check("a PNG from outside the mods root lands at Sprites/<name>.png",
      importedPng.path === "Sprites/hero.png" && importedPng.kind === "sprite",
      JSON.stringify(importedPng));
    check("the imported PNG is byte-identical to the source (no re-encoding)",
      Buffer.compare(readBytes("Sprites/hero.png"), png) === 0, importedPng.bytes + " bytes");
    check("the writer reports the source size",
      importedPng.bytes === png.length, importedPng.bytes + " vs " + png.length);

    /* to 精确落位 ---------------------------------------------------- */

    const exact = fresh.importFile({ dir: pkg, from: pngSource, to: "Sprites/hero_to.png" });
    check("to: \"Sprites/hero_to.png\" lands exactly there",
      exact.path === "Sprites/hero_to.png" && Buffer.compare(readBytes("Sprites/hero_to.png"), png) === 0,
      JSON.stringify(exact));

    /* overwrite 是 opt-in -------------------------------------------- */

    const duplicate = refused({ dir: pkg, from: pngSource, name: "hero" });
    check("importing onto an existing file without overwrite refuses and says how",
      typeof duplicate === "string" && duplicate.includes("already exists") && duplicate.includes("overwrite: true"),
      String(duplicate));
    // 改一个 IDAT 内的字节：仍是合法 PNG（签名/IHDR 都在），但内容确实不同，
    // 这样「覆盖」的成功才可证，而不是又一次写了同样的字节。
    const changed = Buffer.from(png);
    changed[changed.length - 5] = changed[changed.length - 5] ^ 0xff;
    writeFileSync(pngSource, changed);
    const replaced = fresh.importFile({ dir: pkg, from: pngSource, name: "hero", overwrite: true });
    check("overwrite: true replaces the file with the new bytes",
      Buffer.compare(readBytes("Sprites/hero.png"), changed) === 0
        && Buffer.compare(readBytes("Sprites/hero.png"), png) !== 0, JSON.stringify(replaced));
    check("the overwrite is reported as a warning, not silently",
      replaced.warnings.some((w) => w.includes("already existed")), JSON.stringify(replaced.warnings));

    /* yarn：解析得动，字节不变 --------------------------------------- */

    const yarnText = "title: ImportedTalk\nwhen: always\n---\nNarrator: Hello there.\n-> END\n===\n";
    const yarnSource = join(sources, "talk.yarn");
    writeFileSync(yarnSource, yarnText, "utf8");
    const importedYarn = fresh.importFile({ dir: pkg, from: "sources/talk.yarn", name: "ImportedTalk" });
    check("a .yarn imported by a modsRoot-relative path lands at Yarn/<name>.yarn",
      importedYarn.path === "Yarn/ImportedTalk.yarn" && importedYarn.kind === "yarn",
      JSON.stringify(importedYarn));
    check("the imported story is byte-identical",
      readBytes("Yarn/ImportedTalk.yarn").toString("utf8") === yarnText, importedYarn.bytes + " bytes");
    check("the report carries the Yarn diagnostics of the imported story",
      Array.isArray(importedYarn.diagnostics)
        && importedYarn.diagnostics.filter((d) => d.severity === "error").length === 0,
      JSON.stringify(importedYarn.diagnostics));

    /* csv：BOM + CRLF 原样落地 --------------------------------------- */

    const csvText = "\ufefflanguage,id,text,file,node,lineNumber,lock,comment\r\nzh-CN,talk.0001,你好,Yarn/talk.yarn,ImportedTalk,5,0,\r\n";
    const csvSource = join(sources, "talk.csv");
    writeFileSync(csvSource, csvText, "utf8");
    const importedCsv = fresh.importFile({ dir: pkg, from: csvSource, name: "Imported" });
    check("a .csv lands at Yarn/<name>.csv",
      importedCsv.path === "Yarn/Imported.csv" && importedCsv.kind === "translation",
      JSON.stringify(importedCsv));
    check("the imported CSV keeps its BOM and CRLF exactly",
      readBytes("Yarn/Imported.csv").equals(Buffer.from(csvText, "utf8")),
      JSON.stringify(readBytes("Yarn/Imported.csv").slice(0, 3).toString("hex")));

    /* 定义：目录就是类型，不猜 --------------------------------------- */

    const other = join(sandbox, "OtherMod");
    mkdirSync(join(other, "Defines", "Goods"), { recursive: true });
    writeFileSync(join(other, "mod.json"), JSON.stringify({ name: "OtherMod" }));
    const goodsSource = join(other, "Defines", "Goods", "Goods_Imported.json");
    writeFileSync(goodsSource, JSON.stringify({ techName: "Goods_Imported" }, null, 2) + "\n");
    const importedDefine = fresh.importFile({ dir: pkg, from: goodsSource });
    check("a define JSON keeps its Defines/<Type>/ directory when imported",
      importedDefine.path === "Defines/Goods/Goods_Imported.json" && importedDefine.kind === "define",
      JSON.stringify(importedDefine));
    check("the imported define validates clean",
      fresh.validateDefineText({
        type: "Goods",
        text: readFileSync(join(pkg, importedDefine.path), "utf8"),
        relPath: importedDefine.path,
      }).errors === 0, JSON.stringify(importedDefine.diagnostics));

    const randomJson = join(elsewhere, "loose.json");
    writeFileSync(randomJson, JSON.stringify({ techName: "Loose" }));
    const noType = refused({ dir: pkg, from: randomJson });
    check("a .json with no Defines/<Type>/ segment refuses and asks for to",
      typeof noType === "string" && noType.includes("to:") && noType.includes("Defines/<Type>"),
      String(noType));
    const withTo = fresh.importFile({ dir: pkg, from: randomJson, to: "Defines/Goods/Goods_Loose.json" });
    check("the same .json imports when to names the type directory",
      withTo.path === "Defines/Goods/Goods_Loose.json", JSON.stringify(withTo));
    const looseTo = fresh.importFile({ dir: pkg, from: randomJson, to: "Misc/extra.json" });
    check("a .json imported outside Defines/ gets a syntax-only warning",
      looseTo.path === "Misc/extra.json"
        && looseTo.warnings.some((w) => w.includes("only its JSON syntax was checked")),
      JSON.stringify(looseTo.warnings));

    /* 校验失败要清场 ------------------------------------------------- */

    const brokenSource = join(other, "Defines", "Goods", "Goods_Broken.json");
    writeFileSync(brokenSource, JSON.stringify({ name: "no techName" }, null, 2) + "\n");
    const broken = refused({ dir: pkg, from: brokenSource });
    check("a define that fails validation refuses with the first error",
      typeof broken === "string" && broken.includes("does not validate"), String(broken));
    check("the failed define left NO file behind",
      !existsSync(join(pkg, "Defines", "Goods", "Goods_Broken.json")), "Defines/Goods/Goods_Broken.json");

    const fakePngSource = join(sources, "fake.png");
    writeFileSync(fakePngSource, "not a png at all");
    const fakePng = refused({ dir: pkg, from: fakePngSource, name: "fake" });
    check("a .png whose bytes are not a PNG refuses",
      typeof fakePng === "string" && fakePng.includes("not a PNG"), String(fakePng));
    check("the rejected PNG left NO file behind",
      !existsSync(join(pkg, "Sprites", "fake.png")), "Sprites/fake.png");
    const fakePngTo = refused({ dir: pkg, from: fakePngSource, to: "Sprites/fake_to.png" });
    check("the PNG check follows the target, not the source extension",
      typeof fakePngTo === "string" && fakePngTo.includes("not a PNG")
        && !existsSync(join(pkg, "Sprites", "fake_to.png")), String(fakePngTo));

    /* 路径逃逸与未知扩展名 ------------------------------------------- */

    const escaping = refused({ dir: pkg, from: pngSource, to: "../escape.png" });
    check("to: \"../escape.png\" is refused before any write",
      typeof escaping === "string" && escaping.includes("inside the mod package")
        && !existsSync(join(pkg, "..", "escape.png")), String(escaping));
    const drivePath = refused({ dir: pkg, from: pngSource, to: "C:/tmp/x.png" });
    check("an absolute/drive to is refused",
      typeof drivePath === "string" && drivePath.includes("drive path"), String(drivePath));
    const posixAbsolute = refused({ dir: pkg, from: pngSource, to: "/Sprites/x.png" });
    check("a POSIX-absolute to is refused",
      typeof posixAbsolute === "string" && posixAbsolute.includes("not absolute"), String(posixAbsolute));
    const directoryTo = refused({ dir: pkg, from: pngSource, to: "Sprites/" });
    check("a directory in to is refused",
      typeof directoryTo === "string" && directoryTo.includes("not a directory"), String(directoryTo));

    const unknownSource = join(sources, "notes.txt");
    writeFileSync(unknownSource, "hello");
    const unknown = refused({ dir: pkg, from: unknownSource });
    check("an unknown extension refuses and lists what this side knows",
      typeof unknown === "string" && unknown.includes('unknown extension ".txt"')
        && unknown.includes(".yarn") && unknown.includes(".skel.bytes"), String(unknown));

    const badName = refused({ dir: pkg, from: pngSource, name: "not-an-identifier" });
    check("a name must be an identifier",
      typeof badName === "string" && badName.includes("not valid"), String(badName));
    const nameWithExt = refused({ dir: pkg, from: pngSource, name: "hero.png" });
    check("a name may not carry an extension",
      typeof nameWithExt === "string" && nameWithExt.includes("not valid"), String(nameWithExt));

    /* 源文件的基本检查 ----------------------------------------------- */

    const missingSource = refused({ dir: pkg, from: join(sources, "nope.png") });
    check("a source that does not exist refuses",
      typeof missingSource === "string" && missingSource.includes("does not exist"), String(missingSource));
    const dirSource = refused({ dir: pkg, from: sources });
    check("a directory as source refuses",
      typeof dirSource === "string" && dirSource.includes("not a regular file"), String(dirSource));
    const bigSource = join(elsewhere, "big.wav");
    writeFileSync(bigSource, Buffer.alloc(importfileCore.MAX_IMPORT_BYTES + 1));
    const tooBig = refused({ dir: pkg, from: bigSource });
    check("a source over the 64 MiB limit refuses and names its size",
      typeof tooBig === "string" && tooBig.includes("64 MiB") && tooBig.includes("MiB"),
      String(tooBig));
    rmSync(bigSource, { force: true });

    /* audio / spine：目录按规则，内容不深查 --------------------------- */

    const wavSource = join(sources, "sound.wav");
    writeFileSync(wavSource, Buffer.from("RIFF0000WAVEfmt ", "ascii"));
    const importedWav = fresh.importFile({ dir: pkg, from: wavSource, name: "Sound" });
    check("a .wav lands at Audio/<name>.wav byte-identically",
      importedWav.path === "Audio/Sound.wav"
        && readBytes("Audio/Sound.wav").toString("ascii") === "RIFF0000WAVEfmt ",
      JSON.stringify(importedWav));
    const emptyWavSource = join(sources, "empty.wav");
    writeFileSync(emptyWavSource, Buffer.alloc(0));
    const emptyWav = fresh.importFile({ dir: pkg, from: emptyWavSource, name: "Empty" });
    check("an empty audio file imports with a warning instead of a silent pass",
      emptyWav.path === "Audio/Empty.wav" && emptyWav.warnings.some((w) => w.includes("empty")),
      JSON.stringify(emptyWav.warnings));

    const skelSource = join(sources, "Hero.skel.bytes");
    writeFileSync(skelSource, Buffer.from([1, 2, 3, 4]));
    const importedSkel = fresh.importFile({ dir: pkg, from: skelSource });
    check("a .skel.bytes keeps its full basename under Spine/",
      importedSkel.path === "Spine/Hero.skel.bytes" && importedSkel.kind === "spine",
      JSON.stringify(importedSkel));
    const atlasSource = join(sources, "Hero.atlas.txt");
    writeFileSync(atlasSource, "Hero\nsize: 1,1\n");
    const importedAtlas = fresh.importFile({ dir: pkg, from: atlasSource });
    check("a .atlas.txt keeps its full basename under Spine/",
      importedAtlas.path === "Spine/Hero.atlas.txt", JSON.stringify(importedAtlas));

    /* dir 解析 ------------------------------------------------------- */

    const fromSubdir = fresh.importFile({ dir: join(pkg, "Yarn"), from: csvSource, name: "FromSubdir" });
    check("dir may be a subdirectory of the package and still lands at the package root",
      fromSubdir.path === "Yarn/FromSubdir.csv", JSON.stringify(fromSubdir));
    mkdirSync(join(sandbox, "not-a-mod"), { recursive: true });
    const outside = refused({ dir: join(sandbox, "not-a-mod"), from: pngSource, name: "X" });
    check("a directory outside any package refuses with the package sentence",
      typeof outside === "string" && outside.includes("is not inside a mod package"), String(outside));
    const relativeDir = fresh.importFile({ dir: "Importer/Importer", from: pngSource, name: "RelativeDir" });
    check("dir may be relative to the mods root",
      relativeDir.path === "Sprites/RelativeDir.png", JSON.stringify(relativeDir));

    check("every refusal message starts with the verb prefix",
      [duplicate, noType, broken, fakePng, escaping, drivePath, unknown, badName, missingSource, tooBig, outside]
        .every((m) => typeof m === "string" && m.startsWith("import file: ")),
      JSON.stringify([noType, broken, outside]));

    /* 缓存失效：紧随其后的 mod.open 要看得见 ------------------------- */

    const opened = fresh.openMod({ dir: pkg });
    check("mod.open sees the imported sprite and story (the scan cache was invalidated)",
      opened.sprites.includes("Sprites/hero.png")
        && opened.yarnFiles.includes("Yarn/ImportedTalk.yarn"),
      JSON.stringify({ sprites: opened.sprites.slice(-2), yarn: opened.yarnFiles.slice(-2) }));
    check("mod.open sees the imported define",
      opened.defines.some((d) => d.file === "Defines/Goods/Goods_Imported.json"),
      JSON.stringify(opened.defines.map((d) => d.file).slice(-2)));

    /* planner 是纯的 ------------------------------------------------- */

    const planA = importfileCore.planImport({ modRoot: pkg, from: yarnSource, name: "Same" });
    const planB = importfileCore.planImport({ modRoot: pkg, from: yarnSource, name: "Same" });
    check("planning the same import twice gives the same result",
      JSON.stringify(planA) === JSON.stringify(planB),
      JSON.stringify({ path: planA.relPath, kind: planA.kind }));
    check("the planner writes nothing by itself",
      !existsSync(join(pkg, "Yarn", "Same.yarn")), "Yarn/Same.yarn");
  } finally {
    rmSync(sandbox, { recursive: true, force: true });
    rmSync(elsewhere, { recursive: true, force: true });
  }
}

/* ------------------------------------------------------------------ */
/* the demo packages beside the editor: mod.examples / mod.example     */
/* ------------------------------------------------------------------ */

/*
 * G35.  The demo ships beside the editor and `mod.open` refuses everything
 * outside `modsRoot`, so the only reachable demo is a copied one.  These checks
 * pin both halves: what ships is found by name, and the copy is byte-identical,
 * openable, idempotent and never overwrites a directory someone made.
 */
