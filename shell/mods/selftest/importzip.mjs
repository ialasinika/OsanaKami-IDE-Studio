import { HERE, ROOT, require, createMods, check, section } from "./foundation.mjs";
import { spawnSync } from "node:child_process";
import {
  existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

/*
 * G59：把别人给的 zip 解成一个包。读侧和写侧是两个方向：写侧只承诺
 * “连自己的字节读不读得回来”，所以这里第一件事是用一个第三方风格的
 * 最小解析器（`locate`，只找本地头的偏移）去改一个字节，证明 CRC 真的
 * 被查；然后才信任 `readZip` 的其余判断。所有拒绝都必须发生在写盘之前，
 * 测试用“目标目录不存在、外层没有写出文件”来钉这一点。
 */

section("import a zip package: mod.importZip and import");

const zipCore = require(join(HERE, "zip.js"));

/** 递归列出目录里的文件，返回 [{rel, abs}]，rel 用正斜杠。 */
function walk(dir, base) {
  const out = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const abs = join(dir, entry.name);
    const rel = base === "" ? entry.name : `${base}/${entry.name}`;
    if (entry.isDirectory()) out.push(...walk(abs, rel));
    else if (entry.isFile()) out.push({ rel, abs });
  }
  return out.sort((a, b) => (a.rel < b.rel ? -1 : a.rel > b.rel ? 1 : 0));
}

/** 在 zip 里找某个名字的本地头，返回 { dataAt, size }（压缩数据的位置）。 */
function locate(buffer, wanted) {
  let eocd = -1;
  for (let i = buffer.length - 22; i >= Math.max(0, buffer.length - 65557); i--) {
    if (buffer.readUInt32LE(i) === 0x06054b50) { eocd = i; break; }
  }
  if (eocd < 0) throw new Error("no EOCD");
  const count = buffer.readUInt16LE(eocd + 10);
  let at = buffer.readUInt32LE(eocd + 16);
  for (let n = 0; n < count; n++) {
    const nameLen = buffer.readUInt16LE(at + 28);
    const extraLen = buffer.readUInt16LE(at + 30);
    const commentLen = buffer.readUInt16LE(at + 32);
    const localAt = buffer.readUInt32LE(at + 42);
    const name = buffer.toString("utf8", at + 46, at + 46 + nameLen);
    if (name === wanted) {
      const localNameLen = buffer.readUInt16LE(localAt + 26);
      const localExtraLen = buffer.readUInt16LE(localAt + 28);
      return { dataAt: localAt + 30 + localNameLen + localExtraLen, size: buffer.readUInt32LE(at + 20) };
    }
    at += 46 + nameLen + extraLen + commentLen;
  }
  throw new Error("no entry named " + wanted);
}

/** 从包目录做一份 zip，供“导入一个不属于本写出器的包”用。 */
function archiveOf(dir, top) {
  return zipCore.zipEntries(walk(dir, "").map((file) => ({
    name: top === "" ? file.rel : `${top}/${file.rel}`,
    data: readFileSync(file.abs),
  })));
}

function refusal(fn) {
  try {
    fn();
    return "";
  } catch (err) {
    return err && err.message ? err.message : String(err);
  }
}

{
  const sandbox = mkdtempSync(join(tmpdir(), "infantgod-importzip-"));
  try {
    const home = createMods({ modsRoot: sandbox });
    const made = await home.scaffold({ dir: join(sandbox, "ShipIt"), modName: "ShipIt", template: "full" });
    const pkg = made.modRoot;

    /* 写侧 → 读侧：自己的字节先过自己的读器 ------------------------- */

    const exported = home.exportPackage({ dir: pkg });
    const zipBytes = readFileSync(exported.out);
    const entries = zipCore.readZip(zipBytes);
    check("the archive the exporter wrote reads back through the importer's reader",
      entries.entries.length === exported.files, entries.entries.length + " entries");
    check("every entry keeps the package's single top layer",
      entries.entries.every((entry) => entry.name.startsWith("ShipIt/")), entries.entries[0] && entries.entries[0].name);
    const manifest = entries.entries.find((entry) => entry.name === "ShipIt/mod.json");
    check("the manifest comes back byte-identical",
      manifest !== undefined && Buffer.compare(manifest.data, readFileSync(join(pkg, "mod.json"))) === 0, "mod.json");

    /* 解压到一个空的 mods 根 ---------------------------------------- */

    const target = mkdtempSync(join(tmpdir(), "infantgod-import-target-"));
    try {
      const dest = createMods({ modsRoot: target });
      const landed = dest.importZip({ from: exported.out });
      check("importZip unpacks the archive under the mods root and returns the package root",
        landed.root === join(target, "ShipIt") && existsSync(join(target, "ShipIt", "mod.json")),
        JSON.stringify({ root: landed.root }));
      check("the answer names the package relative to the mods root",
        landed.dir === "ShipIt" && landed.name === "ShipIt" && landed.folder === "ShipIt",
        JSON.stringify({ dir: landed.dir, name: landed.name, folder: landed.folder }));
      const unpacked = entries.entries.reduce((sum, entry) => sum + entry.data.length, 0);
      check("the import reports what the archive held and where it went",
        landed.files === exported.files && landed.bytes === unpacked && landed.replaced === false,
        JSON.stringify({ files: landed.files, bytes: landed.bytes, unpacked: unpacked, archived: exported.files }));
      check("importing validates the package it just unpacked, without blocking on findings",
        landed.knowledge !== undefined && typeof landed.errors === "number" &&
          typeof landed.warnings === "number" && Array.isArray(landed.diagnostics),
        JSON.stringify({ errors: landed.errors, warnings: landed.warnings, knowledge: landed.knowledge }));

      const again = refusal(() => dest.importZip({ from: exported.out }));
      check("a second import of the same package needs overwrite: true",
        again.includes("already exists") && again.includes("overwrite: true"), again);

      writeFileSync(join(target, "ShipIt", "stray.txt"), "left over\n");
      const replaced = dest.importZip({ from: exported.out, overwrite: true });
      check("overwrite replaces the package wholesale: a stray file from the old copy is gone",
        replaced.replaced === true && !existsSync(join(target, "ShipIt", "stray.txt")),
        JSON.stringify({ replaced: replaced.replaced }));

      /* 别人的包：根目录就是包，没有包装层 --------------------------- */

      const flat = archiveOf(pkg, "");
      const flatLanded = dest.importZip({ from: writeZip(sandbox, "Flat.zip", flat), overwrite: true });
      check("a zip whose root is the package imports into a folder named by its manifest",
        flatLanded.dir === "ShipIt" && flatLanded.replaced === true && existsSync(join(target, "ShipIt", "mod.json")),
        JSON.stringify({ dir: flatLanded.dir }));

      /* 拒绝：全部发生在写盘之前 ------------------------------------ */

      const slip = writeZip(sandbox, "Slip.zip", zipCore.zipEntries([
        { name: "ShipIt/../escape.txt", data: Buffer.from("escape\n") },
        { name: "ShipIt/mod.json", data: readFileSync(join(pkg, "mod.json")) },
      ]));
      const slipMsg = refusal(() => dest.importZip({ from: slip, name: "Slip" }));
      check("an entry that climbs out with .. is refused by name",
        slipMsg.includes("points outside the archive") && !existsSync(join(target, "escape.txt")),
        slipMsg);

      const absolute = writeZip(sandbox, "Absolute.zip", zipCore.zipEntries([
        { name: "/etc/absolute.txt", data: Buffer.from("x\n") },
        { name: "Pkg/mod.json", data: readFileSync(join(pkg, "mod.json")) },
      ]));
      check("an absolute entry name is refused by name",
        refusal(() => dest.importZip({ from: absolute, name: "Absolute" })).includes("an absolute path"), "refused");

      const duplicated = writeZip(sandbox, "Duplicated.zip", zipCore.zipEntries([
        { name: "Pkg\\mod.json", data: readFileSync(join(pkg, "mod.json")) },
        { name: "Pkg/mod.json", data: readFileSync(join(pkg, "mod.json")) },
      ]));
      check("two entries that normalize to the same path are refused",
        /two entries are named/.test(refusal(() => dest.importZip({ from: duplicated, name: "Dup" }))), "refused");

      const noManifest = writeZip(sandbox, "NoManifest.zip", zipCore.zipEntries([
        { name: "Readme/readme.txt", data: Buffer.from("no package here\n") },
      ]));
      const noManifestMsg = refusal(() => dest.importZip({ from: noManifest, name: "NoManifest" }));
      check("an archive without mod.json is called out as not a Mod package",
        noManifestMsg.includes("no mod.json") && noManifestMsg.includes("not a Mod package"), noManifestMsg);

      const damaged = Buffer.from(zipBytes);
      const at = locate(damaged, "ShipIt/mod.json");
      damaged[at.dataAt + at.size - 1] ^= 0xff;
      const damagedPath = writeZip(sandbox, "Damaged.zip", damaged);
      const damagedMsg = refusal(() => dest.importZip({ from: damagedPath, name: "Damaged" }));
      check("a flipped byte inside an entry is caught by inflate or the CRC, before anything is written",
        /does not inflate|fails its CRC/.test(damagedMsg) && !existsSync(join(target, "Damaged")),
        damagedMsg);

      const missing = refusal(() => dest.importZip({ from: join(sandbox, "nowhere.zip") }));
      check("a missing archive is a message, not a stack trace",
        missing.startsWith("import zip: ") && /no such file|does not exist|cannot read/i.test(missing), missing);

      /* 校验报告不拦导入：坏包也进得去，卡片随后能看见错误 ---------- */

      const broken = join(sandbox, "BrokenPkg");
      mkdirSync(join(broken, "Defines", "Character"), { recursive: true });
      writeFileSync(join(broken, "mod.json"), readFileSync(join(pkg, "mod.json")));
      writeFileSync(join(broken, "Defines", "Character", "Hero.json"),
        JSON.stringify({ techName: "Hero", spineAssetPath: "Spine/Nowhere.skel.bytes" }, null, 2) + "\n");
      const brokenZip = writeZip(sandbox, "BrokenPkg.zip", archiveOf(broken, "BrokenPkg"));
      const brokenLanded = dest.importZip({ from: brokenZip });
      check("a package with a validator error still imports, and the answer carries the error",
        brokenLanded.errors >= 1 &&
          brokenLanded.diagnostics.some((diagnostic) => diagnostic.code === "D011"),
        JSON.stringify({ errors: brokenLanded.errors, codes: brokenLanded.diagnostics.map((d) => d.code) }));

      /* CLI：同一个动词，两种输出 ------------------------------------ */

      const cliTarget = mkdtempSync(join(tmpdir(), "infantgod-import-cli-"));
      try {
        const run = (extra) => spawnSync(process.execPath, [
          join(HERE, "..", "main.mjs"), "unpack", exported.out, "--dir", cliTarget, "--json", ...extra,
        ], { encoding: "utf8", cwd: join(HERE, "..", "..") });
        const first = run([]);
        const answer = (() => {
          try {
            return JSON.parse(first.stdout);
          } catch {
            return null;
          }
        })();
        check("the command line imports the archive and prints the same report as JSON",
          first.status === 0 && answer !== null && answer.ok === true && answer.dir === "ShipIt",
          (first.status + " " + (first.stdout || first.stderr || "")).slice(0, 200));
        const second = run([]);
        check("importing twice from the command line exits 2 with the overwrite hint",
          second.status === 2 && (second.stderr + second.stdout).includes("already exists"),
          (second.status + " " + (second.stderr || "")).slice(0, 200));
        const named = run(["--overwrite", "--name", "Renamed"]);
        check("--name puts the package in the folder it asks for",
          named.status === 0 && existsSync(join(cliTarget, "Renamed", "mod.json")),
          (named.status + " " + (named.stderr || "")).slice(0, 200));
      } finally {
        rmSync(cliTarget, { recursive: true, force: true });
      }

      /* 协议缝：卡片拿到的就是这一帧 -------------------------------- */

      const { dispatch } = await import(pathToFileURL(join(ROOT, "shell", "main.mjs")).href);
      const kernel = { call: async () => { throw new Error("no kernel"); } };
      const languages = { available: true, list: () => ({ langs: [] }), tokenize: () => ({ tokens: [], lang: null }) };
      const seam = await dispatch({
        jsonrpc: "2.0", id: 600, method: "mod.importZip", params: { from: exported.out, overwrite: true },
      }, kernel, languages, dest);
      check("mod.importZip is on the dispatch table and answers with the package it unpacked",
        seam.result !== undefined && typeof seam.result.root === "string" &&
          typeof seam.result.files === "number" && seam.result.dir === "ShipIt",
        JSON.stringify(seam).slice(0, 200));
    } finally {
      rmSync(target, { recursive: true, force: true });
    }
  } finally {
    rmSync(sandbox, { recursive: true, force: true });
  }
}

/** 把字节写进沙盒并返回绝对路径。 */
function writeZip(dir, name, buffer) {
  writeFileSync(join(dir, name), buffer);
  return join(dir, name);
}
