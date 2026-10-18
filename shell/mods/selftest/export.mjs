import { HERE, require, createMods, check, section } from "./foundation.mjs";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { inflateRawSync, crc32 } from "node:zlib";

/*
 * G45：导出 zip。这里不借第三方的压缩包读库 —— 读回来也用本文件的
 * `readZip`，它只实现本写出器用到的那部分格式（EOCD + 中央目录 + 本地头），
 * 因此「写出的字节能被别人读」这件事必须由格式本身证明：签名、偏移、
 * CRC、压缩方法都逐项对过。语料里 wav 会超过内核 4 MiB 单次读上限，
 * 所以整条路径不经过 `file.read`。
 */

/** 从 zip Buffer 里读出 [{ name, method, crc, data, flags }]，按中央目录顺序。 */
function readZip(buffer) {
  /* EOCD 在末尾 22 字节起，注释长度不定：从尾部向前找签名。 */
  let eocd = -1;
  for (let i = buffer.length - 22; i >= Math.max(0, buffer.length - 65557); i--) {
    if (buffer.readUInt32LE(i) === 0x06054b50) {
      eocd = i;
      break;
    }
  }
  if (eocd < 0) throw new Error("no end-of-central-directory record");
  const count = buffer.readUInt16LE(eocd + 10);
  const cdSize = buffer.readUInt32LE(eocd + 12);
  const cdOffset = buffer.readUInt32LE(eocd + 16);
  if (cdOffset + cdSize !== eocd) throw new Error("central directory does not end at the EOCD");

  const entries = [];
  let at = cdOffset;
  for (let n = 0; n < count; n++) {
    if (buffer.readUInt32LE(at) !== 0x02014b50) throw new Error("bad central header at " + at);
    const flags = buffer.readUInt16LE(at + 8);
    const method = buffer.readUInt16LE(at + 10);
    const crc = buffer.readUInt32LE(at + 16);
    const csize = buffer.readUInt32LE(at + 20);
    const usize = buffer.readUInt32LE(at + 24);
    const nameLen = buffer.readUInt16LE(at + 28);
    const extraLen = buffer.readUInt16LE(at + 30);
    const commentLen = buffer.readUInt16LE(at + 32);
    const localAt = buffer.readUInt32LE(at + 42);
    const name = buffer.toString("utf8", at + 46, at + 46 + nameLen);

    if (buffer.readUInt32LE(localAt) !== 0x04034b50) throw new Error("bad local header for " + name);
    const localNameLen = buffer.readUInt16LE(localAt + 26);
    const localExtraLen = buffer.readUInt16LE(localAt + 28);
    const dataAt = localAt + 30 + localNameLen + localExtraLen;
    const raw = buffer.subarray(dataAt, dataAt + csize);
    const data = method === 8 ? inflateRawSync(raw) : method === 0 ? raw : null;
    if (data === null) throw new Error("unknown method " + method + " for " + name);
    if (data.length !== usize) throw new Error("uncompressed size mismatch for " + name);
    if ((crc32(data) >>> 0) !== crc) throw new Error("CRC mismatch for " + name);
    entries.push({ name, method, crc, data, flags });
    at += 46 + nameLen + extraLen + commentLen;
  }
  if (at !== eocd) throw new Error("central directory has trailing bytes");
  return entries;
}

section("export a mod package as a zip: mod.export");
{
  const sandbox = mkdtempSync(join(tmpdir(), "infantgod-export-"));
  try {
    const fresh = createMods({ modsRoot: sandbox });
    const zipCore = require(join(HERE, "zip.js"));
    const made = await fresh.scaffold({ dir: join(sandbox, "ShipIt"), modName: "ShipIt", template: "full" });
    const pkg = made.modRoot;

    /* 计划：确定性清单与排除表 -------------------------------------- */

    writeFileSync(join(pkg, "notes.code-workspace"), "{}\n");
    writeFileSync(join(pkg, "build.log"), "noise\n");
    writeFileSync(join(pkg, ".tmp-cache"), "noise\n");
    mkdirSync(join(pkg, "dist"), { recursive: true });
    writeFileSync(join(pkg, "dist", "bundle.js"), "noise\n");

    const plan = zipCore.planExport({ modRoot: pkg, outFile: join(pkg, "ShipIt.zip") });
    const rels = plan.files.map((file) => file.rel);
    check("the plan walks the whole package and sorts the names",
      rels.length > 0 && rels.join("|") === rels.slice().sort().join("|"), rels.length + " files");
    check("the exclusion list keeps editor and build noise out of the zip",
      !rels.includes("notes.code-workspace") && !rels.includes("build.log")
        && !rels.includes(".tmp-cache") && !rels.some((rel) => rel.startsWith("dist/")),
      JSON.stringify(plan.skipped));
    check("excluded files are reported as skipped, not silently dropped",
      plan.skipped.includes("notes.code-workspace") && plan.skipped.includes("build.log"),
      JSON.stringify(plan.skipped));
    check("the plan totals the uncompressed size",
      plan.bytes === plan.files.reduce((sum, file) => sum + file.size, 0), plan.bytes + " bytes");

    /* 容器：格式正确、可读回、确定性 -------------------------------- */

    const entries = plan.files.map((file) => ({
      name: "ShipIt/" + file.rel,
      data: readFileSync(file.abs),
    }));
    const buffer = zipCore.zipEntries(entries);
    const read = readZip(buffer);
    check("every entry reads back with a matching size and CRC",
      read.length === entries.length, read.length + " entries");
    check("every name keeps its single ShipIt/ top layer",
      read.every((entry) => entry.name.startsWith("ShipIt/")), read[0] && read[0].name);
    const byName = new Map(read.map((entry) => [entry.name, entry]));
    check("the manifest comes back byte-identical",
      byName.has("ShipIt/mod.json")
        && Buffer.compare(byName.get("ShipIt/mod.json").data, readFileSync(join(pkg, "mod.json"))) === 0,
      "mod.json");
    check("compressible text is stored with deflate, not stored raw",
      read.some((entry) => entry.method === 8), JSON.stringify(read.map((entry) => entry.method)));

    const shuffled = entries.slice().reverse();
    check("input order does not change the bytes: the archive is deterministic",
      Buffer.compare(zipCore.zipEntries(entries), zipCore.zipEntries(shuffled)) === 0,
      zipCore.zipEntries(entries).length + " bytes");
    check("a second run of the same plan is byte-identical",
      Buffer.compare(buffer, zipCore.zipEntries(entries)) === 0, "same input, same bytes");

    /* 非 UTF-8 / 不可压缩的字节也走同一条路 -------------------------- */

    const random = Buffer.alloc(512);
    for (let i = 0; i < random.length; i++) random[i] = (i * 37 + (i * i) % 251) & 0xff;
    const mixed = readZip(zipCore.zipEntries([
      { name: "ShipIt/中文 目录/说明.txt", data: Buffer.from("你好，世界\n", "utf8") },
      { name: "ShipIt/audio/voice.wav", data: random },
    ]));
    const chinese = mixed.find((entry) => entry.name.includes("说明"));
    const stored = mixed.find((entry) => entry.name.endsWith("voice.wav"));
    check("a non-ASCII name is flagged as UTF-8 and reads back unchanged",
      chinese !== undefined && chinese.name === "ShipIt/中文 目录/说明.txt" && (chinese.flags & (1 << 11)) !== 0,
      chinese && (chinese.name + " flags=" + chinese.flags));
    check("incompressible bytes are stored rather than grown by deflate",
      stored !== undefined && stored.method === 0 && Buffer.compare(stored.data, random) === 0,
      stored && ("method=" + stored.method));
    check("two entries cannot have the same name",
      (() => {
        try {
          zipCore.zipEntries([
            { name: "a.txt", data: Buffer.from("a") },
            { name: "a.txt", data: Buffer.from("b") },
          ]);
          return false;
        } catch (err) {
          return err.message.includes("two entries are named a.txt");
        }
      })(), "duplicate names refused");

    /* exportPackage：写盘 + 预检门 ---------------------------------- */

    const out = join(sandbox, "ShipIt.zip");
    const report = fresh.exportPackage({ dir: pkg });
    check("exportPackage writes <modsRoot>/<Name>.zip by default",
      report.out === out && existsSync(out), JSON.stringify({ out: report.out, expected: out }));
    check("the report names the archive relative to the mods root",
      report.file === "ShipIt.zip" && report.name === "ShipIt", JSON.stringify(report.file));
    check("the export carries every planned file",
      report.files === plan.files.length && report.bytes === readFileSync(out).length,
      report.files + " files, " + report.bytes + " bytes");
    check("the precheck's warnings and infos ride along in the answer",
      typeof report.warnings === "number" && typeof report.infos === "number",
      JSON.stringify({ warnings: report.warnings, infos: report.infos }));
    check("the written archive reads back", readZip(readFileSync(out)).length === report.files,
      "read back " + report.files + " entries");
    check("the written archive has the package name as its single top layer",
      readZip(readFileSync(out)).every((entry) => entry.name.startsWith("ShipIt/")), "ShipIt/");

    const again = fresh.exportPackage({ dir: pkg, out: "ShipIt.zip", overwrite: true });
    check("exporting the same package twice gives the same bytes (a shared zip can be checked)",
      Buffer.compare(readFileSync(out), readFileSync(again.out)) === 0, "byte-identical");

    const existsMsg = (() => {
      try {
        fresh.exportPackage({ dir: pkg, out: "ShipIt.zip" });
        return "";
      } catch (err) {
        return err.message;
      }
    })();
    check("overwriting an existing zip needs overwrite: true",
      existsMsg.includes("already exists") && existsMsg.includes("overwrite: true"), existsMsg);

    const outsideMsg = (() => {
      try {
        fresh.exportPackage({ dir: pkg, out: "../escape.zip" });
        return "";
      } catch (err) {
        return err.message;
      }
    })();
    check("an archive outside the mods root is refused before anything is written",
      outsideMsg.startsWith("export: ") && /越界|outside/.test(outsideMsg), outsideMsg);

    /* 预检门：error 拦下，warning 放行 ------------------------------- */

    const brokenDir = join(sandbox, "Broken");
    mkdirSync(join(brokenDir, "Defines", "Character"), { recursive: true });
    writeFileSync(join(brokenDir, "mod.json"), JSON.stringify({ name: "Broken" }, null, 2) + "\n");
    writeFileSync(join(brokenDir, "Defines", "Character", "Hero.json"),
      JSON.stringify({ techName: "Hero", spineAssetPath: "Spine/Nowhere.skel.bytes" }, null, 2) + "\n");
    const blocked = (() => {
      try {
        fresh.exportPackage({ dir: brokenDir });
        return "";
      } catch (err) {
        return err.message;
      }
    })();
    check("a package with a validator error does not leave as a zip",
      blocked.includes("has 1 error(s)") && blocked.includes("D011") && blocked.includes("fix the errors first"),
      blocked);
    check("the refused export wrote no archive",
      !existsSync(join(sandbox, "Broken.zip")), "Broken.zip absent");

    /* CLI：与卡片同一个动词 ----------------------------------------- */

    const cliRoot = mkdtempSync(join(tmpdir(), "infantgod-export-cli-"));
    try {
      const cli = createMods({ modsRoot: cliRoot });
      const cliCreated = await cli.scaffold({ dir: join(cliRoot, "CliShip"), modName: "CliShip", template: "full" });
      const cliPkg = cliCreated.modRoot;
      const ran = spawnSync(process.execPath, [
        join(HERE, "..", "main.mjs"), "export", cliPkg, "--json",
      ], { encoding: "utf8", cwd: join(HERE, "..", "..") });
      const answer = (() => {
        try {
          return JSON.parse(ran.stdout);
        } catch {
          return null;
        }
      })();
      check("the command line exports the package and prints the same report as JSON",
        ran.status === 0 && answer !== null && answer.ok === true && answer.name === "CliShip",
        (ran.status + " " + (ran.stdout || "")).slice(0, 200));
      check("the command line archive lands next to the package",
        answer !== null && existsSync(answer.out) && readZip(readFileSync(answer.out)).length === answer.files,
        answer && answer.out);
    } finally {
      rmSync(cliRoot, { recursive: true, force: true });
    }
  } finally {
    rmSync(sandbox, { recursive: true, force: true });
  }
}
