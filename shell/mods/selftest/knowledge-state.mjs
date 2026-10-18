import { HERE, ROOT, require, createMods, KNOWLEDGE_PATH, defaultUserDir, knowledgeBuild, checks, check, section, mods, stats, characters } from "./foundation.mjs";
import { specTemp, specWrite } from "./corpus.mjs";
import { spawn, spawnSync } from "node:child_process";
import { createRequire } from "node:module";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

section("a knowledge base that is not there");

{
  const base = specTemp("infantgod-nokb-");
  const absent = join(base, "absent-knowledge.json");
  const bare = createMods({ modsRoot: base, knowledgePath: absent, gameModsDir: join(base, "no-game") });

  const state = bare.knowledgeState();
  check("knowledgeState names the missing knowledge base",
    state.state === "missing" && state.schemas === 0 && state.path === absent,
    JSON.stringify(state));

  const pkgRoot = join(base, "Bare");
  specWrite(join(pkgRoot, "mod.json"), JSON.stringify({
    name: "Bare", version: "1.0.0", gameVersion: "1.0", loadOrder: 5,
    author: "selftest", description: "no knowledge base",
  }, null, 2) + "\n");

  const report = bare.validatePackage({ root: pkgRoot });
  check("validatePackage reports the knowledge base as missing",
    report.knowledge === "missing", JSON.stringify(report.knowledge));
  check("a missing knowledge base is an error, so ok:true cannot mean 'nothing was checked'",
    report.ok === false && report.diagnostics.some((d) => d.code === "E000" && d.severity === "error"),
    JSON.stringify({ ok: report.ok, errors: report.summary.errors, codes: report.diagnostics.map((d) => d.code) }));

  const built = await bare.scaffold({ dir: join(base, "Fresh"), modName: "Fresh", template: "yarn-story" });
  check("scaffold still writes a package with no knowledge base",
    existsSync(join(built.modRoot, "mod.json")), built.modRoot);
  check("and says so instead of silently degrading",
    built.warnings.some((w) => /知识库/.test(w)), JSON.stringify(built.warnings));

  const readAll = (dir) => {
    let text = "";
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const abs = join(dir, entry.name);
      text += entry.isDirectory() ? readAll(abs) : readFileSync(abs, "utf8");
    }
    return text;
  };
  const generated = readAll(built.modRoot);
  const gameNames = ["Aistalt", "Biden", "Company", "Cop", "Greta", "Journalist", "Judge"];
  check("the generated package never mentions the seven built-in character names",
    gameNames.every((n) => !generated.includes(n)),
    gameNames.filter((n) => generated.includes(n)).join(", "));
  check("the generated story speaks as the mod's own name, not a game protagonist",
    generated.includes("Fresh:"), "no Fresh speaker in the generated package");
  const manifest = JSON.parse(readFileSync(join(built.modRoot, "mod.json"), "utf8"));
  check("and the manifest carries no character table",
    !Array.isArray(manifest.characters) || manifest.characters.length === 0 ||
    manifest.characters.every((c) => !gameNames.includes(String(c && c.name))),
    JSON.stringify(manifest.characters));
}

/* ------------------------------------------------------------------ */
/* where the knowledge base comes from                                 */
/* ------------------------------------------------------------------ */

section("the knowledge base is resolved, shipped or derived (G30/G31)");

{
  const base = specTemp("infantgod-kb-resolve-");
  const noGame = join(base, "no-game");

  /** 一份能分辨来源的迷你知识库：schema 让 state=present，commands 带来源标记。 */
  const kbFile = (file, marker) => specWrite(file, JSON.stringify({
    version: 1,
    stats: { marker: marker },
    commands: [{ name: marker, parameters: [], usage: 0 }],
    functions: [], variables: [], nodes: [], baseline: {},
    schemas: { Demo: { type: "object", properties: {} } },
    localization: { baseLanguage: "zh-CN", locales: [], characters: [] },
  }, null, 2) + "\n");
  const markerOf = (mods) => {
    const kb = mods.knowledge();
    return kb.commands && kb.commands[0] ? kb.commands[0].name : null;
  };

  const optionFile = kbFile(join(base, "option", "k.json"), "From_Option");
  const envFile = kbFile(join(base, "env", "k.json"), "From_Env");
  const bundledFile = kbFile(join(base, "bundled", "k.json"), "From_Bundled");
  const userDir = join(base, "user");
  const userFile = kbFile(join(userDir, "knowledge.json"), "From_User");
  const bundledMissing = join(base, "no-bundled", "knowledge.json");

  const p1 = createMods({
    knowledgePath: optionFile, bundledKnowledgePath: bundledFile, userDir: userDir,
    env: { INFANTGOD_KNOWLEDGE: envFile }, gameModsDir: noGame,
  });
  check("an explicit knowledgePath wins over environment, shipped and user copies",
    p1.knowledgeState().source === "option" && p1.knowledgeState().path === optionFile && markerOf(p1) === "From_Option",
    JSON.stringify(p1.knowledgeState()));

  const p2 = createMods({
    bundledKnowledgePath: bundledFile, userDir: userDir,
    env: { INFANTGOD_KNOWLEDGE: envFile }, gameModsDir: noGame,
  });
  check("INFANTGOD_KNOWLEDGE wins over the shipped and user copies",
    p2.knowledgeState().source === "env" && markerOf(p2) === "From_Env",
    JSON.stringify(p2.knowledgeState()));

  const p3 = createMods({ bundledKnowledgePath: bundledFile, userDir: userDir, env: {}, gameModsDir: noGame });
  check("a shipped knowledge.json wins over a stale copy in the user dir",
    p3.knowledgeState().source === "bundled" && markerOf(p3) === "From_Bundled",
    JSON.stringify(p3.knowledgeState()));

  const p4 = createMods({ bundledKnowledgePath: bundledMissing, userDir: userDir, env: {}, gameModsDir: noGame });
  check("a copy derived earlier in the user dir is used when nothing ships",
    p4.knowledgeState().source === "user" && markerOf(p4) === "From_User" && p4.knowledgeState().path === userFile,
    JSON.stringify(p4.knowledgeState()));

  /* 自造的迷你游戏树：派生只依赖 SODefines/Schema + SODefines/Defines + 一个 Yarn 文件。 */
  const gameDir = join(base, "game");
  specWrite(join(gameDir, "SODefines", "Schema", "Demo.schema.json"), JSON.stringify({
    type: "object", properties: { techName: { type: "string" } },
  }, null, 2));
  specWrite(join(gameDir, "SODefines", "Defines", "Demo", "Hero.json"), JSON.stringify({ techName: "Demo_Hero" }, null, 2));
  specWrite(join(gameDir, "MyMod", "Yarn", "Logic", "Demo.yarn"), [
    "title: Demo_Start", "---", "Demo_Hero: 早。 #line:0abcdef", "===", "",
  ].join("\n"));

  const now = "2026-01-01T00:00:00.000Z";
  const coreKb = knowledgeBuild.buildKnowledge(gameDir, { now: now });
  const genMod = await import(pathToFileURL(join(ROOT, "tools", "gen_knowledge.mjs")).href);
  const genKb = genMod.buildKnowledge(gameDir, { now: now });
  check("tools/gen_knowledge.mjs is a thin CLI over shell/mods/knowledge-build.js, not a second copy",
    JSON.stringify(genKb) === JSON.stringify(coreKb) &&
    genMod.canonicalKnowledge === knowledgeBuild.canonicalKnowledge &&
    genMod.diffKnowledge === knowledgeBuild.diffKnowledge,
    JSON.stringify({ same: JSON.stringify(genKb) === JSON.stringify(coreKb) }));

  /* 四个位置都没有：自己派生一份，写进 userDir。 */
  const deriveUser = join(base, "derive");
  const derived = createMods({ bundledKnowledgePath: bundledMissing, userDir: deriveUser, env: {}, gameModsDir: gameDir });
  const derivedState = derived.knowledgeState();
  check("with nothing shipped or cached, the knowledge base is derived from the game's own folder",
    derivedState.state === "present" && derivedState.source === "derived" &&
    derivedState.path === join(deriveUser, "knowledge.json") && existsSync(derivedState.path),
    JSON.stringify(derivedState));
  const derivedKb = derived.knowledge();
  check("the derived knowledge base carries the game's facts, not an empty shell",
    derivedKb.stats.yarnFiles === 1 && derivedKb.schemas.Demo !== undefined &&
    derivedKb.baseline.Demo.includes("Demo_Hero"),
    JSON.stringify({ stats: derivedKb.stats, base: derivedKb.baseline }));
  const written = JSON.parse(readFileSync(derivedState.path, "utf8"));
  check("the file it wrote holds exactly the facts the core derives",
    JSON.stringify(knowledgeBuild.canonicalKnowledge(written)) ===
    JSON.stringify(knowledgeBuild.canonicalKnowledge(coreKb)),
    "written file and fresh derivation disagree");

  /* 第二次启动用缓存，不重新派生（游戏目录变了也不该重算）。 */
  const beforeMtime = statSync(derivedState.path).mtimeMs;
  specWrite(join(gameDir, "MyMod", "Yarn", "Logic", "Second.yarn"), "title: Demo_Two\n---\nDemo_Hero: 再来。\n===\n");
  const second = createMods({ bundledKnowledgePath: bundledMissing, userDir: deriveUser, env: {}, gameModsDir: gameDir });
  const secondState = second.knowledgeState();
  check("the next boot reuses the derived file instead of deriving again",
    secondState.source === "user" && second.knowledge().stats.yarnFiles === 1,
    JSON.stringify({ state: secondState, yarnFiles: second.knowledge().stats.yarnFiles }));
  check("and it does not rewrite the file it already had", statSync(derivedState.path).mtimeMs === beforeMtime,
    String(statSync(derivedState.path).mtimeMs) + " vs " + String(beforeMtime));

  /* 派生的写出目标不可用 / 游戏目录不可用：两种失败都要说出来，不能当空 KB。 */
  const blocked = join(base, "blocked");
  specWrite(blocked, "this is a file, not a directory");
  const blockedMods = createMods({ bundledKnowledgePath: bundledMissing, userDir: blocked, env: {}, gameModsDir: gameDir });
  const blockedState = blockedMods.knowledgeState();
  check("an unwritable user dir is reported as a derivation failure",
    blockedState.state === "missing" && !!blockedState.deriveError,
    JSON.stringify(blockedState));

  const noGameMods = createMods({ bundledKnowledgePath: bundledMissing, userDir: join(base, "nouser"), env: {}, gameModsDir: noGame });
  const noGameState = noGameMods.knowledgeState();
  check("no knowledge base and no game folder is the named missing state, with nothing invented",
    noGameState.state === "missing" && noGameState.schemas === 0 &&
    /knowledge\.json 不存在/.test(noGameState.loadError || "") &&
    !existsSync(join(base, "nouser", "knowledge.json")),
    JSON.stringify(noGameState));

  const corruptDir = join(base, "corrupt");
  specWrite(join(corruptDir, "knowledge.json"), "{ this is not json");
  const corruptMods = createMods({ bundledKnowledgePath: bundledMissing, userDir: corruptDir, env: {}, gameModsDir: gameDir });
  const corruptState = corruptMods.knowledgeState();
  check("a corrupt knowledge.json is a named load error, not an empty knowledge base",
    corruptState.state === "missing" && corruptState.source === "user" &&
    /JSON/.test(corruptState.loadError || ""),
    JSON.stringify(corruptState));

  /* 用户目录的默认位置与 INFANTGOD_USER_DIR 覆盖。 */
  const appDir = "OsanaKami IDE Studio";
  /* 拼出来而不是写字面量：tools/path_guard.py 会把源码里的 /home/<名字> 当成机器路径。 */
  const homeU = ["", "home", "u"].join("/");
  check("defaultUserDir follows each platform's convention",
    defaultUserDir({ APPDATA: "C:/roaming", LOCALAPPDATA: "C:/local" }, "win32") === join("C:/roaming", appDir) &&
    defaultUserDir({ LOCALAPPDATA: "C:/local" }, "win32") === join("C:/local", appDir) &&
    defaultUserDir({ HOME: homeU }, "darwin") === join(homeU, "Library", "Application Support", appDir) &&
    defaultUserDir({ HOME: homeU }, "linux") === join(homeU, ".local", "share", appDir) &&
    defaultUserDir({ HOME: homeU, XDG_DATA_HOME: "/data" }, "linux") === join("/data", appDir),
    JSON.stringify([
      defaultUserDir({ APPDATA: "C:/roaming" }, "win32"),
      defaultUserDir({ HOME: homeU }, "darwin"),
      defaultUserDir({ HOME: homeU }, "linux"),
    ]));

  const envUser = join(base, "env-user");
  const envUserMods = createMods({
    bundledKnowledgePath: bundledMissing, env: { INFANTGOD_USER_DIR: envUser }, gameModsDir: gameDir,
  });
  check("INFANTGOD_USER_DIR chooses where the derived file goes",
    envUserMods.knowledgeState().source === "derived" &&
    envUserMods.knowledgeState().path === join(envUser, "knowledge.json"),
    JSON.stringify(envUserMods.knowledgeState()));

  /* 仓库里跑（ship 了 knowledge.json）：用打包的那份，绝不写用户目录。 */
  const moduleUser = join(base, "module-user");
  const moduleMods = createMods({ userDir: moduleUser, env: {} });
  check("a checkout serves the shipped knowledge base and writes nothing to the user dir",
    moduleMods.knowledgeState().source === "bundled" &&
    moduleMods.knowledgeState().path === KNOWLEDGE_PATH && !existsSync(moduleUser),
    JSON.stringify(moduleMods.knowledgeState()));

  /* 文件被换掉（内容/大小变了）后，下一次使用要重读，而不是一直用旧的事实。 */
  const liveFile = kbFile(join(base, "live", "knowledge.json"), "From_Live");
  const liveMods = createMods({ knowledgePath: liveFile, env: {} });
  const firstRead = markerOf(liveMods);
  kbFile(join(base, "live", "knowledge.json"), "From_Live_Renamed");
  const refreshed = markerOf(liveMods);
  check("a knowledge.json replaced on disk is re-read on the next use",
    firstRead === "From_Live" && refreshed === "From_Live_Renamed",
    JSON.stringify({ firstRead: firstRead, refreshed: refreshed }));
}

/* ------------------------------------------------------------------ */
/* the game's vocabulary, not ours                                     */
/* ------------------------------------------------------------------ */

section("search: the state names come from the game, not from our source");

{
  /*
   * The fifteen emotion names the completion used to carry as literals are
   * game data, so they are read from the shipped knowledge base at runtime.
   * These checks pin both halves: with the KB the game's own table is offered,
   * without it a neutral fallback is offered and *says* it is a fallback --
   * and the source itself names no game state.
   */
  const searchCore = require(join(HERE, "search.js"));
  const shipped = JSON.parse(readFileSync(KNOWLEDGE_PATH, "utf8"));
  const gameStates = shipped.baseline && Array.isArray(shipped.baseline.CharacterState)
    ? shipped.baseline.CharacterState.map(String)
    : [];

  check("the shipped knowledge base still carries the game's state table",
    gameStates.length > 0, JSON.stringify({ names: gameStates.length }));

  const index = searchCore.buildIndex(shipped);
  const fromKb = searchCore.emotionTagsOf(index);
  check("with a knowledge base the tags are the game's, and the index says where they came from",
    fromKb.source === "knowledge-base" && fromKb.tags.length === gameStates.length,
    JSON.stringify({ source: fromKb.source, tags: fromKb.tags.length, game: gameStates.length }));

  const unreachable = gameStates.filter((name) => {
    const prefix = name.slice(0, Math.min(3, name.length));
    return !searchCore.suggest(index, "#" + prefix, "tag", { limit: 400 }).items
      .some((item) => item.label === name && item.kind === "tag");
  });
  check("and every one of them is still offered by typing its first letters",
    unreachable.length === 0, unreachable.slice(0, 6).join(", "));

  /* The fallback is what a machine without the game sees: it must be honest. */
  const bare = searchCore.buildIndex({});
  const fromNeutral = searchCore.emotionTagsOf(bare);
  check("without a knowledge base the tags are the neutral fallback and say so",
    fromNeutral.source === "neutral" && fromNeutral.tags.length > 0,
    JSON.stringify(fromNeutral));
  check("and not one game state name leaks into the fallback",
    fromNeutral.tags.every((tag) => !gameStates.includes(tag)),
    fromNeutral.tags.filter((tag) => gameStates.includes(tag)).join(", "));

  const bareOffered = searchCore.suggest(bare, "#", "tag").items
    .filter((item) => item.kind === "tag").map((item) => item.label);
  check("the fallback itself is what the completion offers",
    fromNeutral.tags.every((tag) => bareOffered.includes(tag)),
    JSON.stringify(bareOffered.filter((label) => !fromNeutral.tags.includes(label))));

  const source = readFileSync(join(HERE, "search.js"), "utf8");
  const wordish = gameStates.filter((name) => name.length >= 4);
  const literals = wordish.filter((name) => source.includes(`"${name}"`) || source.includes(`'${name}'`));
  check("the search source keeps no game state name as a literal",
    literals.length === 0, literals.slice(0, 6).join(", "));

  const kbDoc = searchCore.suggest(index, "#Ang", "tag").items.find((item) => item.label === "Angry");
  const neutralDoc = searchCore.suggest(bare, "#Neu", "tag").items.find((item) => item.label === "Neutral");
  check("the documentation distinguishes a game tag from the neutral fallback",
    Boolean(kbDoc && /知识库/.test(kbDoc.documentation)) &&
    Boolean(neutralDoc && /中性兜底/.test(neutralDoc.documentation)),
    JSON.stringify({ kb: kbDoc && kbDoc.documentation, neutral: neutralDoc && neutralDoc.documentation }));
}

/* ------------------------------------------------------------------ */
/* the generator                                                       */
/* ------------------------------------------------------------------ */
