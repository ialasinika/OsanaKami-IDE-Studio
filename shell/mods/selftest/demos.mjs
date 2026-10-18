import { HERE, require, createMods, check, section, mods } from "./foundation.mjs";
import { sent } from "./dispatch.mjs";
import { spawn, spawnSync } from "node:child_process";
import { createRequire } from "node:module";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

section("the demo packages the install ships");

{
  const examplesCore = require(join(HERE, "examples.js"));
  const listing = examplesCore.listExamples();
  check("examples/Mods is found beside the shell",
    listing.present && listing.source === "bundled" && listing.root.endsWith(join("examples", "Mods")),
    JSON.stringify({ root: listing.root, source: listing.source, present: listing.present }));
  check("the two demo packages are listed, with Lantern as the default",
    listing.packages.map((one) => one.dir).join(",") === "Lantern,Lantern_Tests" && listing.default === "Lantern",
    JSON.stringify(listing.packages.map((one) => one.dir)));

  const countFiles = (dir) => {
    let total = 0;
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (entry.isDirectory()) total += countFiles(join(dir, entry.name));
      else if (entry.isFile()) total += 1;
    }
    return total;
  };
  const shippedRoot = join(listing.root, "Lantern");
  const shippedFiles = countFiles(shippedRoot);

  const sandbox = mkdtempSync(join(tmpdir(), "infantgod-example-"));
  const occupied = mkdtempSync(join(tmpdir(), "infantgod-example-occupied-"));
  const nothing = mkdtempSync(join(tmpdir(), "infantgod-example-nothing-"));
  try {
    const fresh = createMods({ modsRoot: sandbox });
    check("the facade answers what ships, with the same listing",
      fresh.examples().packages.length === listing.packages.length, JSON.stringify(fresh.examples().packages.map((one) => one.dir)));

    const copied = fresh.example({});
    check("`mod.example` copies the demo into the mods folder",
      copied.installed === true && copied.dir === "Lantern" &&
      copied.modRoot === join(sandbox, "Lantern") && copied.files === shippedFiles,
      JSON.stringify({ dir: copied.dir, files: copied.files, shippedFiles }));
    check("the copied package is byte-identical to the one that ships",
      Buffer.compare(readFileSync(join(copied.modRoot, "mod.json")), readFileSync(join(shippedRoot, "mod.json"))) === 0,
      copied.file);
    check("the copy is openable, which the bundled original never was",
      fresh.openMod({ dir: "Lantern" }).manifest.name === "Lantern",
      JSON.stringify(fresh.openMod({ dir: "Lantern" }).manifest));
    const again = fresh.example({ name: "Lantern" });
    check("asking twice reports `already installed` and copies nothing",
      again.installed === false && again.files === 0, JSON.stringify(again));

    const refused = (params) => {
      try {
        fresh.example(params);
        return "";
      } catch (err) {
        return err.message;
      }
    };
    check("an unknown demo name is refused by name, with the list",
      refused({ name: "Nope" }).startsWith("example: no demo package named") &&
      refused({ name: "Nope" }).includes("Lantern"),
      refused({ name: "Nope" }));

    mkdirSync(join(occupied, "Lantern_Tests"), { recursive: true });
    writeFileSync(join(occupied, "Lantern_Tests", "notes.txt"), "mine\n");
    const busy = createMods({ modsRoot: occupied });
    let clash = "";
    try {
      busy.example({ name: "Lantern_Tests" });
    } catch (err) {
      clash = err.message;
    }
    check("the refusal names the directory and says why",
      clash.includes("already holds files") && clash.startsWith("example: "), clash);
    check("the refused directory keeps its file",
      readFileSync(join(occupied, "Lantern_Tests", "notes.txt"), "utf8") === "mine\n");

    check("with no mods folder the copy is refused, not sent somewhere",
      (() => {
        try {
          createMods({}).example({});
          return "";
        } catch (err) {
          return err.message;
        }
      })().startsWith("example: there is no mods folder"),
      "createMods({}) has no modsRoot");

    const empty = examplesCore.listExamples({ examplesDir: nothing });
    check("a build with no demo packages reports the state, not an error",
      empty.present === false && empty.default === null, JSON.stringify(empty));
    check("installing from a build with no demo packages says so",
      (() => {
        try {
          examplesCore.installExample({ examplesRoot: nothing, modsRoot: sandbox });
          return "";
        } catch (err) {
          return err.message;
        }
      })().includes("no demo package is installed beside the editor"),
      nothing);
  } finally {
    rmSync(sandbox, { recursive: true, force: true });
    rmSync(occupied, { recursive: true, force: true });
    rmSync(nothing, { recursive: true, force: true });
  }
}
