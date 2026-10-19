/**
 * game.mjs -- G11 (install a package into the game) and G12 (read and follow the
 * game's own Player.log).  Both are proved against fake trees under the OS temp
 * dir: no game, no Unity, no network, and no path on the machine that runs this.
 *
 * The install checks cover the states that matter to an author: a first install,
 * a second install without --overwrite, a replacement, and a package the
 * validator refuses.  The log checks cover discovery (two candidates, newest
 * wins), the tail reader (only the tail, starting on a line boundary), the
 * scanner (error / mod / mention) and the follower (only appended bytes, and a
 * file that disappears mid-watch is a report, not a throw).
 */

import { spawnSync } from "node:child_process";
import {
  appendFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";

import { ROOT, check, createMods, gamepath, section } from "./foundation.mjs";
import { specTemp, specWrite } from "./corpus.mjs";

function manifest(name) {
  return JSON.stringify({
    name,
    version: "1.0.0",
    gameVersion: "1.0",
    loadOrder: 60,
    author: "selftest",
    description: "selftest fixture: the package is installed into a fake game tree",
  }, null, 2) + "\n";
}

function thrown(fn) {
  try {
    fn();
    return "";
  } catch (err) {
    return err && err.message ? String(err.message) : String(err);
  }
}

function runCli(args) {
  return spawnSync(process.execPath, [join(ROOT, "shell", "main.mjs"), ...args], {
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

/* ------------------------------------------------------------------ */
/* G11 -- 装进游戏                                                      */
/* ------------------------------------------------------------------ */

section("G11: install a package into the game");

const base = specTemp("infantgod-g11-");
const modsHome = join(base, "mods");
const pkgRoot = join(modsHome, "MyPkg");
const fakeGame = join(base, "Game");
const gameModsDir = join(fakeGame, "StreamingAssets", "Mods");
const userDir = join(base, "user");

specWrite(join(pkgRoot, "mod.json"), manifest("MyPkg"));
specWrite(join(pkgRoot, "notes.txt"), "a package that only carries a manifest and a note\n");
mkdirSync(join(gameModsDir, "SODefines", "Schema"), { recursive: true });
writeFileSync(join(gameModsDir, "SODefines", "Schema", "Item.json"), "{}\n");

/*
 * An explicit, readable game Mods folder with no baseline in it.  Every install
 * below names its target through the call's `gameDir`, but the precheck validates
 * against the instance's knowledge view: on a machine with no game install a
 * missing folder adds M012 ("cross-Mod checks skipped") and the precheck counts a
 * warning the package did not cause.
 */
const emptyGameMods = join(base, "game-mods");
mkdirSync(join(emptyGameMods, "SODefines", "Schema"), { recursive: true });
const game = createMods({ modsRoot: modsHome, userDir, env: {}, gameModsDir: emptyGameMods });

check("the fake tree is recognisable as a game Mods folder", gamepath.looksLikeGameModsDir(gameModsDir) === true);
check("installGame is on the facade", typeof game.installGame === "function");

const first = game.installGame({ dir: pkgRoot, gameDir: fakeGame });
check("installGame copies the package to <gameMods>/<name>",
  first.target === join(gameModsDir, "MyPkg"), first.target);
check("installGame reports the game folder it resolved",
  first.gameMods.dir === gameModsDir && first.gameMods.found === true,
  JSON.stringify(first.gameMods));
check("installGame counts the files and the bytes",
  first.files === 2 && first.bytes > 0 &&
    first.bytes === statSync(join(pkgRoot, "mod.json")).size + statSync(join(pkgRoot, "notes.txt")).size,
  first.files + " files, " + first.bytes + " bytes");
check("the precheck reports the knowledge base it used",
  first.knowledge === "present" && first.warnings === 0 && first.infos === 0,
  JSON.stringify({ knowledge: first.knowledge, warnings: first.warnings, infos: first.infos }));
check("the copied bytes are identical to the package's",
  readFileSync(join(first.target, "notes.txt"), "utf8") ===
    readFileSync(join(pkgRoot, "notes.txt"), "utf8"));
check("a first install replaced nothing", first.replaced === false, String(first.replaced));
check("no staging or backup directory is left behind",
  readdirSync(gameModsDir).filter((name) => name.startsWith(".")).length === 0,
  JSON.stringify(readdirSync(gameModsDir)));

const refusal = thrown(() => game.installGame({ dir: pkgRoot, gameDir: fakeGame }));
check("a second install without overwrite is refused, naming the folder and the flag",
  /already exists/.test(refusal) && /--overwrite/.test(refusal) && refusal.includes(first.target),
  refusal);
check("the refusal leaves the installed copy intact",
  existsSync(join(first.target, "mod.json")) && existsSync(join(first.target, "notes.txt")));

writeFileSync(join(first.target, "stale.txt"), "from an older install\n");
const second = game.installGame({ dir: pkgRoot, gameDir: fakeGame, overwrite: true });
check("overwrite replaces the installed copy", second.replaced === true && second.target === first.target,
  JSON.stringify({ replaced: second.replaced, target: second.target }));
check("overwrite swaps the folder instead of merging into it",
  !existsSync(join(first.target, "stale.txt")));
check("overwrite leaves a complete copy",
  readFileSync(join(first.target, "notes.txt"), "utf8").includes("only carries a manifest"));

const badRoot = join(modsHome, "BadPkg");
specWrite(join(badRoot, "mod.json"), manifest("BadPkg"));
specWrite(join(badRoot, "Defines", "Character", "Hero.json"),
  JSON.stringify({ techName: "Hero", spineAssetPath: "Spine/Nope.skel.bytes" }, null, 2) + "\n");

const blocked = thrown(() => game.installGame({ dir: badRoot, gameDir: fakeGame }));
check("a package with an error is refused with the count", /has 1 error\(s\)/.test(blocked), blocked);
check("the refusal names the first diagnostic code", /D011/.test(blocked), blocked);
check("nothing was copied for the refused package", !existsSync(join(gameModsDir, "BadPkg")));

const emptyRoot = join(base, "empty-root");
mkdirSync(emptyRoot, { recursive: true });
const nowhere = thrown(() => game.installGame({ dir: pkgRoot, searchRoots: [emptyRoot] }));
check("installGame without a game folder says where it looked",
  /no game Mods folder was found/.test(nowhere) &&
    nowhere.includes(emptyRoot) && nowhere.includes("INFANTGOD_MODS_DIR"),
  nowhere);

/* ------------------------------------------------------------------ */
/* G12 -- 游戏自己说了什么                                              */
/* ------------------------------------------------------------------ */

section("G12: the game's own log");

const logBase = specTemp("infantgod-g12-");
const olderLog = specWrite(join(logBase, "Acme", "OldGame", "Player.log"), "[INFO] an old run\n");
const newerLog = specWrite(join(logBase, "Acme", "Game", "Player.log"), [
  "[INFO] Unity 2022 boot",
  "[ERROR] NullReferenceException: Sword is null",
  "[ModLoader] loaded MyPkg",
  "[INFO] MyPkg registered 3 defs",
].join("\n") + "\n");
const anHourAgo = new Date(Date.now() - 60 * 60 * 1000);
utimesSync(olderLog, anHourAgo, anHourAgo);

const picked = gamepath.discoverPlayerLog({ searchRoots: [logBase], env: {} });
check("discoverPlayerLog picks the most recently modified log",
  picked.found === true && picked.path === newerLog && picked.size === statSync(newerLog).size,
  JSON.stringify({ path: picked.path, size: picked.size }));

const soloRoot = join(logBase, "solo-root");
const soloLog = specWrite(join(soloRoot, "Solo", "Player.log"), "[INFO] solo\n");
const solo = gamepath.discoverPlayerLog({ searchRoots: [soloRoot], env: {} });
check("discoverPlayerLog also looks at <root>/<X>/Player.log",
  solo.found === true && solo.path === soloLog, solo.path);

const absent = gamepath.discoverPlayerLog({ searchRoots: [join(logBase, "no-game-here")], env: {} });
check("a missing log is an explicit found:false with the places it tried",
  absent.found === false && absent.path === null && absent.tried.length > 0 &&
    absent.tried.some((entry) => String(entry.path).includes("no-game-here")),
  JSON.stringify(absent.tried.slice(0, 2)));

const tailFile = specWrite(join(logBase, "tail", "Player.log"), "");
let body = "";
for (let i = 0; i < 200; i++) body += `[INFO] line ${String(i).padStart(3, "0")} filler filler\n`;
writeFileSync(tailFile, body, "utf8");
const tail = gamepath.readLogTail(tailFile, { bytes: 400 });
check("readLogTail reads only the tail",
  tail.text.length < body.length && tail.offset > 0 &&
    tail.size === statSync(tailFile).size,
  JSON.stringify({ text: tail.text.length, offset: tail.offset, size: tail.size }));
check("readLogTail starts on a line boundary",
  /^\[INFO\] line \d{3} /.test(tail.text) && !tail.text.includes("line 000"),
  JSON.stringify(tail.text.slice(0, 40)));

const logText = [
  "[INFO] game started",
  "[ERROR] NullReferenceException: boom",
  "[ModLoader] loaded MyPkg from disk",
  "[INFO] MyPkg registered 3 defs",
  "[INFO] nothing interesting here",
].join("\n");
const scan = gamepath.scanLogText(logText, { modName: "MyPkg" });
check("scanLogText counts every line it looked at", scan.totals.lines === 5, String(scan.totals.lines));
check("scanLogText classifies an error line",
  scan.totals.errors === 1 && scan.lines.some((l) => l.kind === "error" && l.line === 2),
  JSON.stringify(scan.lines.map((l) => l.kind)));
check("scanLogText classifies a ModLoader line as mod",
  scan.totals.mods === 1 && scan.lines.some((l) => l.kind === "mod" && /ModLoader/.test(l.text)));
check("a package mention is shown as info, and counted",
  scan.totals.mentions === 2 &&
    scan.lines.some((l) => l.kind === "info" && /registered 3 defs/.test(l.text)),
  JSON.stringify(scan.totals));
check("scanLogText drops lines that say nothing",
  !scan.lines.some((l) => /nothing interesting/.test(l.text)));

const followFile = specWrite(join(logBase, "follow", "Player.log"), "[INFO] boot\n");
const progress = [];
let appends = 0;
let followErr = null;
let followed = null;
try {
  followed = await gamepath.followPlayerLog(
    {
      path: followFile,
      intervalMs: 100,
      durationMs: 600,
      sleep: async () => {
        if (appends === 0) {
          appends += 1;
          appendFileSync(followFile, "[ERROR] added while watching\n");
        }
      },
    },
    (sample) => progress.push(sample),
  );
} catch (err) {
  followErr = err;
}
check("followPlayerLog reports only the appended bytes",
  followErr === null && followed !== null && followed.samples === 1 &&
    progress.length === 1 && progress[0].changed === true,
  followErr === null ? JSON.stringify(followed) + " samples=" + progress.length : String(followErr));
check("followPlayerLog hands the appended text to onProgress",
  progress.length === 1 && /added while watching/.test(progress[0].text),
  JSON.stringify(progress.map((p) => p.text)));
check("followPlayerLog stops on duration with the final offset",
  followed !== null && followed.stoppedBecause === "duration" &&
    followed.offset === statSync(followFile).size,
  followed === null ? "" : JSON.stringify(followed));

const goneFile = specWrite(join(logBase, "gone", "Player.log"), "[INFO] boot\n");
let goneErr = null;
let gone = null;
try {
  gone = await gamepath.followPlayerLog(
    {
      path: goneFile,
      intervalMs: 50,
      durationMs: 400,
      sleep: async () => {
        rmSync(goneFile, { force: true });
      },
    },
    () => {},
  );
} catch (err) {
  goneErr = err;
}
check("a log that disappears mid-watch is reported, not thrown",
  goneErr === null && gone !== null && gone.stoppedBecause === "gone",
  goneErr === null ? JSON.stringify(gone) : String(goneErr));

const answer = game.gameLog({ path: newerLog, modName: "MyPkg" });
check("gameLog answers with the path it read",
  answer.found === true && answer.path === newerLog, answer.path);
check("gameLog carries the totals and the matching lines",
  answer.totals.errors === 1 && answer.totals.mods === 1 && answer.totals.mentions === 2 &&
    answer.lines.length === 3,
  JSON.stringify(answer.totals) + " lines=" + answer.lines.length);
check("gameLog reports where the text starts and how big the log is",
  answer.offset === 0 && answer.size === statSync(newerLog).size &&
    answer.bytes === answer.size - answer.offset,
  JSON.stringify({ offset: answer.offset, size: answer.size, bytes: answer.bytes }));

const noLog = game.gameLog({ searchRoots: [join(logBase, "empty-root")] });
check("gameLog says found:false instead of guessing a path",
  noLog.found === false && noLog.path === null && Array.isArray(noLog.tried) &&
    noLog.totals.lines === 0,
  JSON.stringify({ found: noLog.found, path: noLog.path }));

const streamFile = specWrite(join(logBase, "stream", "Player.log"), "[INFO] boot\n");
setTimeout(() => {
  try {
    appendFileSync(streamFile, "[ERROR] late failure\n");
  } catch {
    /* the file is a fixture; if it is gone the check below says so */
  }
}, 120);
const streamed = await game.followGameLog({ path: streamFile, durationMs: 400, intervalMs: 50 });
check("followGameLog collects what arrives during the watch",
  streamed.found === true && streamed.samples >= 1 && streamed.totals.errors === 1 &&
    streamed.lines.some((l) => /late failure/.test(l.text)),
  JSON.stringify({ samples: streamed.samples, totals: streamed.totals }));

/* ------------------------------------------------------------------ */
/* the same two verbs on the command line                               */
/* ------------------------------------------------------------------ */

section("the install and log verbs on the command line");

const cliLog = runCli(["log", "--path", newerLog, "--mod", "MyPkg", "--json", "--user-dir", userDir]);
const cliLogDoc = asJson(cliLog);
check("`log --json` writes one parseable object and exits 0",
  cliLog.status === 0 && cliLogDoc !== null && cliLogDoc.ok === true &&
    cliLogDoc.path === newerLog &&
    String(cliLog.stdout).trim().startsWith("{") && String(cliLog.stdout).trim().endsWith("}"),
  cliLog.status + " " + String(cliLog.stdout).slice(0, 120) + String(cliLog.stderr).slice(0, 120));
check("`log --json` carries the totals and the lines",
  cliLogDoc !== null && cliLogDoc.totals.errors === 1 && cliLogDoc.totals.mentions === 2 &&
    cliLogDoc.lines.length === 3,
  JSON.stringify(cliLogDoc && cliLogDoc.totals));

const cliMissing = runCli(["log", "--path", join(logBase, "no-such.log"), "--json", "--user-dir", userDir]);
const missingDoc = asJson(cliMissing);
check("`log` exits 2 when there is no log, and says where it looked",
  cliMissing.status === 2 && missingDoc !== null && missingDoc.ok === false &&
    /no Player\.log found/.test(missingDoc.error || ""),
  cliMissing.status + " " + JSON.stringify(missingDoc));

const cliGame = join(base, "CliGame");
mkdirSync(join(cliGame, "StreamingAssets", "Mods", "SODefines", "Schema"), { recursive: true });
const cliInstall = runCli(["install", pkgRoot, "--game-dir", cliGame, "--json", "--user-dir", userDir]);
const installDoc = asJson(cliInstall);
const cliTarget = join(cliGame, "StreamingAssets", "Mods", "MyPkg");
check("`install` exits 0 and names the target",
  cliInstall.status === 0 && installDoc !== null && installDoc.ok === true &&
    installDoc.target === cliTarget && installDoc.files === 2,
  cliInstall.status + " " + String(cliInstall.stdout).slice(0, 160) + String(cliInstall.stderr).slice(0, 160));
check("`install` actually put the files in the game folder",
  existsSync(join(cliTarget, "mod.json")) && existsSync(join(cliTarget, "notes.txt")));

const cliBad = runCli(["install", badRoot, "--game-dir", cliGame, "--json", "--user-dir", userDir]);
const badDoc = asJson(cliBad);
check("`install` exits 1 when the precheck blocks it",
  cliBad.status === 1 && badDoc !== null && badDoc.ok === false &&
    /has 1 error\(s\)/.test(badDoc.error || ""),
  cliBad.status + " " + JSON.stringify(badDoc));

const cliUnknown = runCli(["frobnicate"]);
check("an unknown verb still exits 2", cliUnknown.status === 2, String(cliUnknown.status));

const cliInstallTwice = runCli(["install", pkgRoot, "--game-dir", cliGame, "--json", "--user-dir", userDir]);
check("`install` refuses the installed copy without --overwrite (exit 2, not 1)",
  cliInstallTwice.status === 2 && /--overwrite/.test(String(asJson(cliInstallTwice) && asJson(cliInstallTwice).error)),
  cliInstallTwice.status + " " + String(cliInstallTwice.stdout).slice(0, 160));
