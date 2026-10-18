import { ROOT, require, gamepath, DISCOVERY, modsIndex, checks, check, section, mods } from "./foundation.mjs";
import { HAVE_CORPUS, specTemp } from "./corpus.mjs";
import { frame, newMod } from "./dispatch.mjs";
import { spawn, spawnSync } from "node:child_process";
import { createRequire } from "node:module";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

section('the File menu: "打开示例 Mod"');

export const examplesMenu = require(join(ROOT, "electron", "examples.js"));

export function answering(body, status = 200) {
  return async () => ({ status, text: async () => (typeof body === "string" ? body : JSON.stringify(body)) });
}
export function reply(result) {
  return { jsonrpc: "2.0", id: 1, result };
}

check("the item is one frame and one address, nothing else",
  JSON.stringify(Object.keys(examplesMenu).sort()) === JSON.stringify(["install", "openUrl"]),
  JSON.stringify(Object.keys(examplesMenu).sort()));

export const frames = [];
try {
  const answer = await examplesMenu.install({
    endpoint: "http://127.0.0.1:9/",
    fetchImpl: async (url, init) => {
      frames.push({ url, init });
      return { status: 200, text: async () => JSON.stringify(reply({ installed: true, dir: "Lantern", modRoot: "mods/Lantern", files: 22 })) };
    },
  });
  check("install posts to <endpoint>/rpc", frames.length === 1 && frames[0].url === "http://127.0.0.1:9/rpc", JSON.stringify(frames.map((one) => one.url)));
  check("with POST and a JSON body",
    frames[0].init.method === "POST" && frames[0].init.headers["content-type"] === "application/json",
    JSON.stringify(frames[0].init.method));
  check("the body is the exact mod.example frame",
    frames[0].init.body === '{"jsonrpc":"2.0","id":1,"method":"mod.example","params":{}}',
    frames[0].init.body);
  check("the reply's result is what the menu navigates with",
    answer.dir === "Lantern" && answer.files === 22, JSON.stringify(answer));
} catch (err) {
  check("install posts to <endpoint>/rpc", false, String(err));
}

try {
  let body = null;
  await examplesMenu.install({
    endpoint: "http://127.0.0.1:9",
    name: "  Lantern_Tests  ",
    fetchImpl: async (_url, init) => {
      body = init.body;
      return { status: 200, text: async () => JSON.stringify(reply({ installed: false, dir: "Lantern_Tests", modRoot: "mods/Lantern_Tests", files: 0 })) };
    },
  });
  check("a typed name is trimmed into the params",
    body === '{"jsonrpc":"2.0","id":1,"method":"mod.example","params":{"name":"Lantern_Tests"}}',
    body);
} catch (err) {
  check("a typed name is trimmed into the params", false, String(err));
}

export let serverSaid = null;
try {
  await examplesMenu.install({
    endpoint: "http://127.0.0.1:9",
    fetchImpl: answering({ jsonrpc: "2.0", id: 1, error: { code: -32603, name: "RpcError", message: 'example: no demo package named "Nope"' } }),
  });
} catch (err) {
  serverSaid = err;
}
check("the shell's refusal is the menu's message, with its code",
  serverSaid instanceof Error && serverSaid.message === 'example: no demo package named "Nope"' && serverSaid.code === -32603,
  serverSaid === null ? "no error" : `${serverSaid.message} / ${serverSaid.code}`);

export let noDir = null;
try {
  await examplesMenu.install({
    endpoint: "http://127.0.0.1:9",
    fetchImpl: answering(reply({ installed: true, files: 22 })),
  });
} catch (err) {
  noDir = err.message;
}
check("a reply with no directory is refused, not navigated to",
  typeof noDir === "string" && noDir.includes("没有可打开的目录"), noDir);

export let noEndpoint = null;
try {
  await examplesMenu.install({ endpoint: "   ", fetchImpl: answering(reply({ dir: "Lantern" })) });
} catch (err) {
  noEndpoint = err.message;
}
check("a session without an endpoint is refused before any request",
  typeof noEndpoint === "string" && noEndpoint.includes("还没有 shell 端点"), noEndpoint);

export const openShell = { url: "http://127.0.0.1:9/", workspace: ROOT, modsRoot: join(ROOT, "examples", "Mods") };
check("the address is the new-mod shortcut's, so one channel does both",
  examplesMenu.openUrl === undefined || examplesMenu.openUrl(openShell, "mods/Lantern") === newMod.openModUrl(openShell, "mods/Lantern"),
  examplesMenu.openUrl(openShell, "mods/Lantern"));
check("and it carries the package in ?mod=",
  examplesMenu.openUrl(openShell, "mods/Lantern").includes("?mod=mods%2FLantern"),
  examplesMenu.openUrl(openShell, "mods/Lantern"));

/* ------------------------------------------------------------------ */
/* finding the game: a setting, the environment, or discovery          */
/* ------------------------------------------------------------------ */

section("finding the game without a path written into the source");

{
  /*
   * docs/EDITOR_GAPS.md §14.1: the game folder used to be baked into scaffold.js
   * and into this file.  The rule now is setting > environment > discovery, and
   * "not found" is a state with a name, never a guess.  These checks build their
   * own little game tree, so they say the same thing on every machine.
   */
  const base = specTemp("infantgod-discover-");
  const corpus = join(base, "ModsFull", "Mods");
  mkdirSync(join(corpus, "SODefines", "Schema"), { recursive: true });
  mkdirSync(join(corpus, "MyMod", "Yarn"), { recursive: true });

  const bySetting = gamepath.discoverGameModsDir({ gameModsDir: corpus, env: {} });
  check("an explicit setting wins over the environment and over discovery",
    bySetting.dir === corpus && bySetting.source === "setting",
    JSON.stringify({ dir: bySetting.dir, source: bySetting.source }));

  const byEnv = gamepath.discoverGameModsDir({ env: { INFANTGOD_GAME_DIR: base } });
  check("INFANTGOD_GAME_DIR finds <dir>/ModsFull/Mods",
    byEnv.dir === corpus && byEnv.source === "INFANTGOD_GAME_DIR/ModsFull/Mods",
    JSON.stringify({ dir: byEnv.dir, source: byEnv.source }));

  const bySearch = gamepath.discoverGameModsDir({ env: {}, searchRoots: [base] });
  check("discovery under a root finds ModsFull/Mods under it",
    bySearch.dir === corpus && bySearch.source === "discover",
    JSON.stringify({ dir: bySearch.dir, source: bySearch.source }));

  const nothing = gamepath.discoverGameModsDir({ gameModsDir: join(base, "nope"), env: {} });
  check("a setting that is not a game folder is refused by name, not silently ignored",
    nothing.dir === null && nothing.source === "not found" && nothing.found === false,
    JSON.stringify({ source: nothing.source, tried: nothing.tried.length }));

  check("the default roots include the checkout's parent -- a relative rule, not this machine",
    gamepath.defaultSearchRoots({}).some((r) => r === resolve(ROOT, "..")),
    JSON.stringify(gamepath.defaultSearchRoots({}).slice(-2)));

  /*
   * Steam 的默认位置按平台不同，而测试机器只有一个平台。所以平台和 env 都可以
   * 注入，三条检查用同一份注入数据说三个平台的话——它们不需要真的装一个 Steam。
   */
  const fakeHome = join(base, "home");
  const winDirs = gamepath.steamInstallDirs({ "ProgramFiles(x86)": "C:\\PF86" }, "win32");
  check("on Windows the Steam install directory comes from ProgramFiles(x86)",
    JSON.stringify(winDirs) === JSON.stringify([join("C:\\PF86", "Steam")]), JSON.stringify(winDirs));

  const linuxDirs = gamepath.steamInstallDirs({ HOME: fakeHome }, "linux");
  check("on Linux the default Steam roots are ~/.local/share/Steam and ~/.steam/steam",
    linuxDirs.includes(join(fakeHome, ".local", "share", "Steam")) &&
      linuxDirs.includes(join(fakeHome, ".steam", "steam")),
    JSON.stringify(linuxDirs));

  const macDirs = gamepath.steamInstallDirs({ HOME: fakeHome }, "darwin");
  check("on macOS the default Steam root is ~/Library/Application Support/Steam",
    macDirs.includes(join(fakeHome, "Library", "Application Support", "Steam")),
    JSON.stringify(macDirs));

  check("a Linux discovery uses the injected HOME, not the machine's",
    gamepath.defaultSearchRoots({ HOME: fakeHome }, "linux").includes(join(fakeHome, ".local", "share", "Steam")),
    JSON.stringify(gamepath.defaultSearchRoots({ HOME: fakeHome }, "linux").slice(0, 3)));

  check("describeDiscovery says where the folder was found, and by what",
    gamepath.describeDiscovery({ found: true, dir: join(base, "Mods"), source: "discover" }) ===
      `found ${join(base, "Mods")} (discover)`,
    gamepath.describeDiscovery({ found: true, dir: join(base, "Mods"), source: "discover" }));

  check("describeDiscovery on a miss counts the places it looked, with a plural",
    gamepath.describeDiscovery({ found: false, tried: [{}, {}, {}] }) === "not found; looked in 3 places" &&
      gamepath.describeDiscovery({ found: false, tried: [{}] }) === "not found; looked in 1 place",
    gamepath.describeDiscovery({ found: false, tried: [{}, {}, {}] }));

  check("an injected platform reaches discovery: no Windows ProgramFiles is needed on Linux",
    gamepath
      .discoverGameModsDir({ env: { HOME: fakeHome }, platform: "linux", searchRoots: [base] })
      .dir === corpus,
    JSON.stringify({ dir: gamepath.discoverGameModsDir({ env: { HOME: fakeHome }, platform: "linux", searchRoots: [base] }).dir }));

  const info = mods.gameMods();
  check("the facade reports where the game folder came from",
    info !== null && typeof info.source === "string" &&
    (info.dir === null ? info.source === "not found" : typeof info.dir === "string"),
    JSON.stringify(info));

  check("with no --mods the corpus is exactly what discovery found",
    modsIndex >= 0 || HAVE_CORPUS === DISCOVERY.found,
    JSON.stringify({ mods: modsIndex >= 0, found: DISCOVERY.found, have: HAVE_CORPUS, source: DISCOVERY.source }));
}

/* ------------------------------------------------------------------ */
/* a knowledge base that is not there                                  */
/* ------------------------------------------------------------------ */
