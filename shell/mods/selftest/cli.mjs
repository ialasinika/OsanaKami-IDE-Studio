/*
 * `node shell/main.mjs validate DIR` -- the mod layer with no window and no
 * kernel.  The point of the command is that it runs where the cards cannot: a
 * build machine, a chat reviewer's laptop, a CI container with no game and no
 * compiled kernel.  So the checks here spawn the real command line, not the mod
 * layer directly -- a direct call would prove the validator works and nothing
 * about the thing authors will actually run.
 */

import { ROOT, check, section } from "./foundation.mjs";
import { specTemp, specWrite } from "./corpus.mjs";
import { spawnSync } from "node:child_process";
import { join } from "node:path";

section("the validator as a command: node shell/main.mjs validate");

const CLI = join(ROOT, "shell", "main.mjs");
const root = specTemp("infantgod-cli-");
const userDir = join(root, "user");

function manifest(name, loadOrder) {
  return JSON.stringify({
    name,
    version: "1.0.0",
    gameVersion: "1.0",
    loadOrder,
    author: "selftest",
    description: "selftest fixture: the command line validates without the kernel",
  }, null, 2) + "\n";
}

function writePackage(name, loadOrder, files = {}) {
  specWrite(join(root, name, "mod.json"), manifest(name, loadOrder));
  for (const [rel, text] of Object.entries(files)) specWrite(join(root, name, rel), text);
}

writePackage("CleanPkg", 60);
writePackage("BrokenPkg", 61, {
  "Defines/Character/Hero.json":
    JSON.stringify({ techName: "Hero", spineAssetPath: "Spine/Nope.skel.bytes" }, null, 2) + "\n",
});

function runCli(args) {
  return spawnSync(process.execPath, [CLI, ...args], {
    cwd: ROOT,
    encoding: "utf8",
    timeout: 120000,
  });
}

function asJson(result) {
  try {
    return JSON.parse(result.stdout);
  } catch {
    return null;
  }
}

const clean = runCli(["validate", join(root, "CleanPkg"), "--json", "--user-dir", userDir]);
const cleanDoc = asJson(clean);
check("a clean package exits 0 and says so on stdout",
  clean.status === 0 && cleanDoc !== null && cleanDoc.ok === true &&
    cleanDoc.packages.length === 1 && cleanDoc.totals.errors === 0,
  clean.status + " " + String(clean.stdout).slice(0, 200) + String(clean.stderr).slice(0, 200));

check("--json prints one parseable object and nothing else",
  cleanDoc !== null && String(clean.stdout).trim().startsWith("{") &&
    String(clean.stdout).trim().endsWith("}"),
  JSON.stringify(String(clean.stdout).slice(0, 80)));

check("the document names the tool, the root and where the knowledge came from",
  cleanDoc !== null && cleanDoc.tool === "infantgod-validate" &&
    cleanDoc.modsRoot === root && cleanDoc.knowledge === "present" &&
    cleanDoc.packages[0].name === "CleanPkg",
  JSON.stringify(cleanDoc && {
    tool: cleanDoc.tool, modsRoot: cleanDoc.modsRoot, knowledge: cleanDoc.knowledge,
  }));

const broken = runCli(["validate", join(root, "BrokenPkg"), "--json", "--user-dir", userDir]);
const brokenDoc = asJson(broken);
check("a package with an error exits 1, not 0 and not 2",
  broken.status === 1, String(broken.status));
check("the JSON carries the same D011 the cards show",
  brokenDoc !== null && brokenDoc.ok === false && brokenDoc.totals.errors === 1 &&
    brokenDoc.packages[0].diagnostics.some((d) => d.code === "D011" && d.severity === "error"),
  JSON.stringify(brokenDoc && brokenDoc.packages[0].diagnostics.map((d) => d.code)));
check("and the definition, not just the folder, is in the diagnostic",
  brokenDoc !== null &&
    brokenDoc.packages[0].diagnostics.some((d) =>
      String(d.path).includes("Defines/Character/Hero.json") &&
      String(d.message).includes("Spine/Nope.skel.bytes")),
  JSON.stringify(brokenDoc && brokenDoc.packages[0].diagnostics[0]));

const whole = runCli(["validate", root, "--json", "--user-dir", userDir]);
const wholeDoc = asJson(whole);
check("a mods root validates every package under it, in name order",
  whole.status === 1 && wholeDoc !== null &&
    wholeDoc.packages.map((p) => p.name).join(",") === "BrokenPkg,CleanPkg",
  wholeDoc === null ? String(whole.stderr).slice(0, 200)
    : wholeDoc.packages.map((p) => p.name).join(","));
check("the totals add the packages up",
  wholeDoc !== null && wholeDoc.totals.packages === 2 && wholeDoc.totals.failed === 1 &&
    wholeDoc.totals.errors === 1,
  JSON.stringify(wholeDoc && wholeDoc.totals));

const text = runCli(["validate", join(root, "BrokenPkg"), "--user-dir", userDir]);
check("without --json the report is still a report, with the code and the count",
  text.status === 1 && String(text.stdout).includes("D011") &&
    String(text.stdout).includes("BrokenPkg") &&
    /1 error\b/.test(String(text.stdout)),
  String(text.stdout).slice(0, 300));

const textClean = runCli(["validate", join(root, "CleanPkg"), "--user-dir", userDir]);
check("a clean text report says ok and exits 0",
  textClean.status === 0 && String(textClean.stdout).includes("CleanPkg  ok") &&
    /0 errors\b/.test(String(textClean.stdout)),
  String(textClean.stdout).slice(0, 200));

const noArg = runCli(["validate"]);
check("no directory is a usage error (2), with the shape of the command",
  noArg.status === 2 && String(noArg.stderr).includes("validate needs a directory"),
  String(noArg.stderr).slice(0, 160));

const notDir = runCli(["validate", join(root, "CleanPkg", "mod.json")]);
check("a file, not a directory, is refused as a usage error",
  notDir.status === 2 && String(notDir.stderr).includes("not a directory"),
  String(notDir.stderr).slice(0, 160));

const emptyRoot = specTemp("infantgod-cli-empty-");
const empty = runCli(["validate", emptyRoot, "--json", "--user-dir", userDir]);
check("a root with no packages is refused, not reported clean",
  empty.status === 2 && String(empty.stderr).includes("no mod packages found"),
  String(empty.stderr).slice(0, 160));

const extra = runCli(["rpc", "extra"]);
check("the old commands still refuse a stray positional argument",
  extra.status === 2 && String(extra.stderr).includes("unexpected argument: extra"),
  String(extra.stderr).slice(0, 160));

/*
 * G44: `sources` is the command that answers "where do the mod layer's answers
 * come from?" without a window -- the game folder discovery settled on and the
 * knowledge.json in effect.  The game folder is an explicit fixture here, so
 * the answer does not depend on what this machine happens to have installed.
 */
const game = specTemp("infantgod-cli-game-");
specWrite(join(game, "Mods", "Placeholder.txt"), "not a package\n");

const sources = runCli(["sources", "--json", "--mods-root", root, "--game-dir", game, "--user-dir", userDir]);
const sourcesDoc = asJson(sources);
check("sources answers with the game folder and the knowledge base it uses",
  sources.status === 0 && sourcesDoc !== null && sourcesDoc.ok === true &&
    sourcesDoc.game !== undefined && sourcesDoc.game.found === true &&
    String(sourcesDoc.game.dir).replace(/\\/g, "/").toLowerCase().endsWith("/mods") &&
    sourcesDoc.knowledge !== undefined && sourcesDoc.knowledge.state === "present" &&
    sourcesDoc.knowledge.schemas === 51,
  sources.status + " " + JSON.stringify(sourcesDoc && { game: sourcesDoc.game, knowledge: sourcesDoc.knowledge }).slice(0, 300));

check("and the JSON says where the knowledge came from, not just that it exists",
  sourcesDoc !== null && typeof sourcesDoc.knowledge.source === "string" &&
    sourcesDoc.knowledge.source !== "" && typeof sourcesDoc.knowledge.path === "string" &&
    sourcesDoc.knowledge.path !== "",
  JSON.stringify(sourcesDoc && { source: sourcesDoc.knowledge.source, path: sourcesDoc.knowledge.path }));

const sourcesText = runCli(["sources", "--mods-root", root, "--game-dir", game, "--user-dir", userDir]);
check("without --json it prints both answers as plain lines",
  sourcesText.status === 0 && /^game mods: /m.test(String(sourcesText.stdout)) &&
    /^knowledge base: /m.test(String(sourcesText.stdout)),
  String(sourcesText.stdout).slice(0, 240));
