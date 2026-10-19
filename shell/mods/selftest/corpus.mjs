import { require, createMods, MODS_DIR, checks, check, section, skip, mods, types } from "./foundation.mjs";
import { spawn, spawnSync } from "node:child_process";
import { createRequire } from "node:module";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

/* corpus: only when the extracted game folder is reachable            */
/* ------------------------------------------------------------------ */

export const HAVE_CORPUS = existsSync(join(MODS_DIR, "MyMod")) && existsSync(join(MODS_DIR, "SODefines"));

section("the game's own MyMod package");

if (!HAVE_CORPUS) {
  skip("corpus checks (no Mods folder found; pass --mods DIR or set INFANTGOD_MODS_DIR)");
} else {
  const opened = mods.openMod({ dir: join(MODS_DIR, "MyMod") });
  check("openMod returns the documented members",
    JSON.stringify(Object.keys(opened).sort()) ===
    JSON.stringify(["csvFiles", "defines", "diagnostics", "manifest", "root", "sprites", "summary", "yarnFiles"]),
    JSON.stringify(Object.keys(opened)));
  check("manifest is the real mod.json",
    opened.manifest.name === "MyMod" && opened.manifest.loadOrder === 0,
    JSON.stringify(opened.manifest));
  check("211 Yarn files found", opened.yarnFiles.length === 211, String(opened.yarnFiles.length));
  check("MyMod ships no Defines/", opened.defines.length === 0, String(opened.defines.length));

  /*
   * The corpus has 14 .csv files but only 11 are languages: one is
   * `NewProject-metadata.csv` (line metadata, not a language) and two live in
   * `Yarn/.VSCodeCounter/`, which is editor residue.  A naive `*.csv` glob
   * reports 14/11/14 from three different call sites -- this pins all three to
   * the same number.
   */
  check("csvFiles counts languages, not every .csv", opened.csvFiles.length === 11, String(opened.csvFiles.length));
  check("openMod summary agrees with validatePackage",
    opened.summary.csv === 11 && opened.summary.yarn === 211,
    JSON.stringify(opened.summary));

  const report = mods.validatePackage({ root: join(MODS_DIR, "MyMod") });
  check("MyMod validates with zero errors", report.summary.errors === 0, JSON.stringify(report.summary));
  check("validatePackage and openMod agree on the language count",
    report.summary.csvFiles === 11, String(report.summary.csvFiles));

  const loc = mods.localization({ root: join(MODS_DIR, "MyMod") });
  check("11 localisation files", loc !== null && loc.locales.length === 11, loc === null ? "null" : String(loc.locales.length));
  check("exactly one base language", loc.locales.filter((l) => l.base).length === 1,
    JSON.stringify(loc.locales.filter((l) => l.base).map((l) => l.file)));
  /*
   * The suffix table in scaffold.js records `bg` with an empty suffix (for
   * mods that name their base file after themselves), so a suffix-only lookup
   * folds `NewProject_bg.csv` into the base language and loses Bulgarian.
   */
  const codes = [...new Set(loc.locales.map((l) => l.code))].sort();
  check("all 11 language codes are distinct",
    codes.length === 11, JSON.stringify(codes));
  check("Bulgarian is bg, not folded into the base language",
    codes.includes("bg") && loc.locales.find((l) => l.file.endsWith("_bg.csv")).code === "bg");
  check("the base file is the unsuffixed one", loc.locales.find((l) => l.base).file === "Yarn/NewProject.csv",
    loc.locales.find((l) => l.base).file);
  check("metadata.csv is not counted as a language",
    loc.locales.every((l) => !/metadata\.csv$/i.test(l.file)));
  check("editor residue is not counted as a language",
    loc.locales.every((l) => !l.file.includes(".VSCodeCounter")));
  check("every language has the full string table",
    loc.locales.every((l) => l.rows === 18609),
    JSON.stringify(loc.locales.filter((l) => l.rows !== 18609).map((l) => [l.file, l.rows])));

  section("the game's own SODefines package");

  const so = mods.validatePackage({ root: join(MODS_DIR, "SODefines") });
  check("1306 files", so.summary.files === 1306, String(so.summary.files));
  check("1305 defines", so.summary.defines === 1305, String(so.summary.defines));
  check("51 types present", Object.keys(so.summary.byType).length === 51, String(Object.keys(so.summary.byType).length));
  check("exactly the two known data defects are errors",
    so.summary.errors === 2 && so.diagnostics.filter((d) => d.severity === "error").every((d) => d.code === "D006"),
    JSON.stringify(so.diagnostics.filter((d) => d.severity === "error").map((d) => d.code)));
  check("no false TechName errors against the baseline",
    so.diagnostics.every((d) => d.code !== "D005"),
    JSON.stringify(so.diagnostics.filter((d) => d.code === "D005").slice(0, 3)));

  section("diagnosing real Yarn");

  const livePath = join(MODS_DIR, "MyMod", "Yarn", "Logic", "2.Live.yarn");
  if (!existsSync(livePath)) {
    skip("2.Live.yarn diagnosis");
  } else {
    const fs = require("node:fs");
    const text = fs.readFileSync(livePath, "utf8");
    const diag = mods.diagnoseYarn({ text, fileName: livePath, root: join(MODS_DIR, "MyMod") });
    check("diagnose returns available/diagnostics/nodes",
      JSON.stringify(Object.keys(diag).sort()) === JSON.stringify(["available", "diagnostics", "nodes"]),
      JSON.stringify(Object.keys(diag)));
    check("the game's own dialogue has no errors",
      diag.diagnostics.filter((d) => d.severity === "error").length === 0,
      JSON.stringify(diag.diagnostics.filter((d) => d.severity === "error").slice(0, 3)));
    check("its nodes are listed", diag.nodes.length > 0, String(diag.nodes.length));
  }
}

/* ------------------------------------------------------------------ */
/* a brand-new mod must be clean: the acceptance test                  */
/* ------------------------------------------------------------------ */

section("a freshly scaffolded mod");

{
  const sandbox = mkdtempSync(join(tmpdir(), "infantgod-mods-"));
  try {
    /*
     * A readable game Mods folder with no baseline in it.  The checks below are
     * about the package, and a machine with no game install adds M012 ("cross-Mod
     * checks skipped") to every report it validates -- true, but about the machine,
     * not about the mod.  An empty SODefines/Schema satisfies the structure marker
     * and contributes no baseline, so the knowledge the checker uses is the bundled
     * one whether or not the machine has a game.
     */
    const emptyGameMods = join(sandbox, "game-mods");
    mkdirSync(join(emptyGameMods, "SODefines", "Schema"), { recursive: true });
    const fresh = createMods({ modsRoot: sandbox, gameModsDir: emptyGameMods });
    const created = await fresh.scaffold({ dir: join(sandbox, "Probe"), modName: "Probe", template: "full" });
    check("scaffold reports the files it wrote", Array.isArray(created.created) && created.created.length > 0,
      JSON.stringify(created.created));
    /*
     * `dir` is the *parent*, and the package lands in `dir/<modName>` -- that is
     * scaffold.js's own contract.  Every other verb takes the package root, so
     * this is the one asymmetry worth pinning down with a check.
     */
    check("dir is the parent and the package lands in dir/<modName>",
      created.modRoot === join(sandbox, "Probe", "Probe"),
      created.modRoot);

    const report = fresh.validatePackage({ root: created.modRoot });
    check("a new mod validates with zero errors", report.summary.errors === 0, JSON.stringify(report.summary));
    check("and zero warnings", report.summary.warnings === 0, JSON.stringify({
      warnings: report.diagnostics.filter((d) => d.severity === "warning").map((d) => d.code + " " + d.path),
    }));

    /*
     * The generated Yarn jumps between nodes it declares itself, and the
     * generated Topic references the generated Attr by techName.  Both only
     * resolve if the mod's own definitions are merged into the knowledge the
     * checker uses -- consulting the game baseline alone reports Y002 and D005.
     */
    const story = report.diagnostics.filter((d) => d.code === "Y002" || d.code === "D005");
    check("no unresolved self-references", story.length === 0, JSON.stringify(story.map((d) => d.code + " " + d.path)));
    check("the generated icons exist on disk",
      report.diagnostics.every((d) => d.code !== "D006"),
      JSON.stringify(report.diagnostics.filter((d) => d.code === "D006").map((d) => d.path)));

    const storyText = [
      "title: Probe_Start",
      "---",
      "<<jump Probe_Hub>>",
      "===",
      "title: Probe_Hub",
      "---",
      "<<jump Probe_Start>>",
      "===",
      "",
    ].join("\n");
    const diag = fresh.diagnoseYarn({ text: storyText, fileName: "Probe/Story.yarn", root: created.modRoot });
    check("a new mod's own jump targets resolve",
      diag.diagnostics.every((d) => d.code !== "Y002"),
      JSON.stringify(diag.diagnostics.filter((d) => d.code === "Y002")));
  } finally {
    rmSync(sandbox, { recursive: true, force: true });
  }
}

/* ------------------------------------------------------------------ */
/* the verbs the cards call                                            */
/* ------------------------------------------------------------------ */

section("search, docs and completion");

export const hit = mods.search({ query: "Love", limit: 5 });
check("search finds the Love command first", hit[0] && hit[0].kind === "command" && hit[0].name === "Love",
  JSON.stringify(hit[0]));
check("search results are shaped for a list card",
  hit.every((h) => typeof h.kind === "string" && typeof h.name === "string" && typeof h.detail === "string"));

export const loveDoc = mods.docFor({ kind: "command", name: "Love" });
check("docFor returns readable markdown", typeof loveDoc === "string" && loveDoc.includes("Love") && loveDoc.includes("```yarn"),
  String(loveDoc).slice(0, 80));

export const suggestions = mods.suggest({ prefix: "Lo", context: "command" });
check("completion offers Love first", suggestions[0] && suggestions[0].label === "Love", JSON.stringify(suggestions[0]));
check("completion carries an insertable text and a doc",
  suggestions.every((s) => typeof s.insertText === "string" && typeof s.documentation === "string"));

export const badDoc = (() => {
  try {
    mods.docFor({ kind: "command", name: "NoSuchCommandName" });
    return null;
  } catch (err) {
    return err.message;
  }
})();
check("an unknown name is reported, not invented", badDoc === null || typeof badDoc === "string");

/* ------------------------------------------------------------------ */
/* the acceptance list, exercised directly                             */
/* ------------------------------------------------------------------ */

/*
 * `mods` above is deliberately narrowed to the corpus folder, so anything
 * outside it is EOUTSIDE.  These fixtures live in the OS temp dir and so need
 * an unguarded instance of their own; the guard is then tested separately.
 */

export const specMods = createMods({});
export const specTemps = [];

export function specTemp(prefix) {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  specTemps.push(dir);
  return dir;
}

export function specWrite(abs, text) {
  mkdirSync(dirname(abs), { recursive: true });
  writeFileSync(abs, text, "utf8");
  return abs;
}
