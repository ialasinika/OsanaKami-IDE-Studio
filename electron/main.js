/*
 * The Electron window.
 *
 * This file is the whole native shell, and it is deliberately the only place
 * that knows Electron exists.  `shell/` -- the endpoints, the mod layer, the
 * board -- is unchanged and still runs under plain `node shell/main.mjs serve`,
 * so the same product is available as a browser app for anyone who does not
 * want a 200 MB download.
 *
 * The split is:
 *
 *   this file          starts the HTTP endpoint, opens a window on it, owns the
 *                      settings file, and kills the process tree on quit
 *   shell/main.mjs     HTTP + SSE + JSON-RPC, and the `mod.*` verbs
 *   core/              the C kernel, spawned by the shell as a child process
 *
 * There is no preload script and no IPC.  The board is a plain web app that
 * talks to 127.0.0.1 with fetch() and EventSource, so the secure defaults
 * (contextIsolation, no nodeIntegration, sandbox) work as they are and the
 * renderer never needs a bridge.
 */

"use strict";

const { app, BrowserWindow, Menu, dialog, shell } = require("electron");
const { spawn } = require("node:child_process");
const fs = require("node:fs");
const path = require("node:path");
const newMod = require("./newmod.js");
const examples = require("./examples.js");

/* ------------------------------------------------------------------ */
/* paths                                                              */
/* ------------------------------------------------------------------ */

const REPO = path.join(__dirname, "..");

/*
 * Everything the shell needs at run time -- its own code, the language
 * descriptions and the native kernel -- is shipped as ordinary files beside
 * the executable (electron-builder's `extraResources`), not inside `app.asar`.
 *
 * Two reasons, both learned the hard way.  `spawn` needs a real `cwd`, and a
 * path inside the archive is not a directory: the failure is ENOENT, which
 * reads like "the executable is missing" and sends you hunting in the wrong
 * place.  And Node's ESM loader reaches for `fs` in ways Electron's asar shim
 * does not cover, so an `import` that works in development can fail once
 * packed.  Keeping the shell outside the archive removes the whole question.
 */
const APP_ROOT = app.isPackaged ? process.resourcesPath : REPO;
const SHELL_MAIN = path.join(APP_ROOT, "shell", "main.mjs");

/*
 * The kernel is a separate native binary, so it cannot live inside the app
 * bundle's code.  In development it is simply the Makefile's output.
 */
const KERNEL = app.isPackaged
  ? path.join(APP_ROOT, "infantgod.exe")
  : path.join(REPO, "build", "infantgod.exe");

const settingsPath = () => path.join(app.getPath("userData"), "settings.json");
const logPath = () => path.join(app.getPath("userData"), "boot.log");

/*
 * A packaged Windows app has no console, so `console.log` from the main process
 * goes nowhere: a user reporting "it opens then closes" would have nothing to
 * send.  Every boot step is mirrored to stderr *and* to a file next to the
 * settings, which is the one place that always exists and is always writable.
 */
function log(message) {
  const line = `[${new Date().toISOString()}] ${message}\n`;
  try {
    process.stderr.write(line);
  } catch (err) {
    /* no console attached */
  }
  try {
    fs.mkdirSync(path.dirname(logPath()), { recursive: true });
    fs.appendFileSync(logPath(), line, "utf8");
  } catch (err) {
    /* never let logging be the reason the app dies */
  }
}

/*
 * A packaged app has no meaningful working directory and its own directory is
 * read-only, so the workspace -- the one directory the kernel may read and
 * write, and where .infantgod/board.json lives -- has to be an explicit,
 * writable path.  Documents/OsanaKamiIDEStudio is the first-run default; the
 * File menu is how you point at a real project.
 */
const defaultWorkspace = () => path.join(app.getPath("documents"), "OsanaKamiIDEStudio");

// Logged from module scope as well as from `boot()`: if the app dies during
// Chromium's own start-up, `boot()` never runs and this line is the only trace.
log(
  `main: electron ${process.versions.electron}, node ${process.versions.node}, ` +
    `argv ${JSON.stringify(process.argv.slice(1))}`
);

function readSettings() {
  try {
    const parsed = JSON.parse(fs.readFileSync(settingsPath(), "utf8"));
    return parsed && typeof parsed === "object" ? parsed : {};
  } catch (err) {
    // A missing or corrupt settings file is a first run, not a failure.
    return {};
  }
}

function writeSettings(next) {
  fs.mkdirSync(path.dirname(settingsPath()), { recursive: true });
  fs.writeFileSync(settingsPath(), `${JSON.stringify(next, null, 2)}\n`, "utf8");
}

function ensureDir(dir) {
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

/* ------------------------------------------------------------------ */
/* the shell child process                                            */
/* ------------------------------------------------------------------ */

let child = null;
let booting = false;

/**
 * Kills the shell *and everything it spawned*.  The shell starts the kernel as
 * its own child, so killing only the shell would leave a kernel process behind
 * holding the workspace open -- on Windows, `taskkill /T` is what makes the
 * difference.
 */
function stopShell() {
  const dying = child;
  child = null;
  if (!dying || dying.killed || dying.exitCode !== null) {
    return;
  }
  try {
    if (process.platform === "win32") {
      spawn("taskkill", ["/pid", String(dying.pid), "/T", "/F"], { stdio: "ignore", windowsHide: true });
    } else {
      dying.kill("SIGTERM");
    }
  } catch (err) {
    try {
      dying.kill();
    } catch (ignored) {
      /* already gone */
    }
  }
}

/**
 * Starts `shell/main.mjs serve` under Electron's own Node (`ELECTRON_RUN_AS_NODE`)
 * so the package does not have to ship a second Node runtime, and resolves with
 * the URL the shell prints once it is listening.
 */
function startShell({ workspace, modsRoot }) {
  stopShell();

  return new Promise((resolve, reject) => {
    if (!fs.existsSync(KERNEL)) {
      reject(new Error(
        `找不到内核：${KERNEL}\n\n` +
        "先用 mingw 编译它：\n" +
        "  mingw32-make -f Makefile SHELL=cmd.exe",
      ));
      return;
    }

    const args = [
      SHELL_MAIN, "serve",
      "--workspace", workspace,
      "--kernel", KERNEL,
      "--port", "0",
      // 知识库的派生结果写进 Electron 的用户数据目录，而不是 %APPDATA% 下另建一个。
      "--user-dir", app.getPath("userData"),
      // Without this the shell launches the system browser as well, and you get
      // a second window on top of this one.
      "--no-open",
    ];
    if (modsRoot) {
      args.push("--mods-root", modsRoot);
    }

    const proc = spawn(process.execPath, args, {
      cwd: APP_ROOT,
      env: { ...process.env, ELECTRON_RUN_AS_NODE: "1" },
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
    });
    child = proc;

    let out = "";
    let err = "";
    let settled = false;

    const giveUp = setTimeout(() => {
      if (settled) return;
      settled = true;
      reject(new Error(`端点 10 秒内没有报出端口。\n\nstdout:\n${out}\nstderr:\n${err}`));
    }, 10000);

    const finish = (fn) => {
      if (settled) return;
      settled = true;
      clearTimeout(giveUp);
      fn();
    };

    proc.stdout.setEncoding("utf8");
    proc.stdout.on("data", (chunk) => {
      out += chunk;
      // "  board   http://127.0.0.1:54735/"
      const found = out.match(/board\s+(http:\/\/127\.0\.0\.1:\d+\/)/);
      if (found) {
        finish(() => resolve({ url: found[1], log: out }));
      }
    });

    proc.stderr.setEncoding("utf8");
    proc.stderr.on("data", (chunk) => {
      err += chunk;
      process.stderr.write(chunk);
    });

    proc.on("error", (cause) => finish(() => reject(cause)));
    proc.on("exit", (code) => {
      // A restart kills the old endpoint and immediately spawns a new one; the
      // old process's exit event lands *after* that, so clearing `child`
      // unconditionally would forget the live one and leak it at quit.
      if (child === proc) child = null;
      finish(() => reject(new Error(`端点退出，代码 ${code}\n\n${out}${err}`)));
    });
  });
}

/* ------------------------------------------------------------------ */
/* the window                                                         */
/* ------------------------------------------------------------------ */

let win = null;
let session = null; // { workspace, modsRoot, url, log }

function createWindow(url) {
  win = new BrowserWindow({
    width: 1500,
    height: 1000,
    minWidth: 900,
    minHeight: 600,
    backgroundColor: "#14171b",
    title: "OsanaKami IDE Studio",
    show: false,
    webPreferences: {
      // The board needs none of these; leaving them off is what keeps the
      // renderer unable to touch the filesystem except through `mod.*` and the
      // kernel's own allowlist.
      nodeIntegration: false,
      contextIsolation: true,
      sandbox: true,
    },
  });

  win.once("ready-to-show", () => win.show());
  win.on("closed", () => {
    win = null;
  });

  // The board is a web app.  Anything trying to open a new window is a link out
  // of it, so hand that to the real browser instead of opening a chromeless
  // Electron window with no way back.
  win.webContents.setWindowOpenHandler(({ url: target }) => {
    shell.openExternal(target);
    return { action: "deny" };
  });

  return win.loadURL(url);
}

/* ------------------------------------------------------------------ */
/* boot                                                               */
/* ------------------------------------------------------------------ */

function reportFailure(title, err) {
  dialog.showErrorBox(title, String((err && err.message) || err));
}

/* Electron's dialog functions are overloaded on whether a parent window is
 * given, so `undefined` is not a valid stand-in for "no parent". */
function openDialog(options) {
  return win === null ? dialog.showOpenDialog(options) : dialog.showOpenDialog(win, options);
}

/* The save dialog is overloaded on the parent window the same way. */
function saveDialog(options) {
  return win === null ? dialog.showSaveDialog(options) : dialog.showSaveDialog(win, options);
}

function messageBox(options) {
  return win === null ? dialog.showMessageBox(options) : dialog.showMessageBox(win, options);
}

async function boot() {
  if (booting) return;
  booting = true;
  try {
    log(`boot: electron ${process.versions.electron}, node ${process.versions.node}, packaged=${app.isPackaged}`);
    log(`boot: kernel ${KERNEL} (exists=${fs.existsSync(KERNEL)})`);
    log(`boot: userData ${app.getPath("userData")}`);

    const settings = readSettings();
    log(`boot: settings ${JSON.stringify(settings)}`);

    const workspace = ensureDir(settings.workspace || defaultWorkspace());
    const modsRoot = typeof settings.modsRoot === "string" && settings.modsRoot !== "" ? settings.modsRoot : "";
    log(`boot: workspace ${workspace}`);
    log(`boot: modsRoot ${modsRoot || "(same as workspace)"}`);

    const started = await startShell({ workspace, modsRoot });
    session = { workspace, modsRoot, url: started.url, log: started.log };
    log(`boot: endpoint ${started.url}`);

    if (win === null) {
      log("boot: creating window");
      await createWindow(started.url);
      log("boot: window loaded");
    } else {
      log("boot: reloading window");
      await win.loadURL(started.url);
      log("boot: window reloaded");
    }
    if (win !== null) {
      win.setTitle(`OsanaKami IDE Studio — ${workspace}`);
    }
    console.log(started.log.trimEnd());
  } catch (err) {
    log(`boot FAILED: ${(err && err.stack) || err}`);
    reportFailure("OsanaKami IDE Studio 启动失败", err);
    app.quit();
  } finally {
    booting = false;
  }
}

/** Restarts the endpoint against new settings and reloads the window. */
async function reboot(patch) {
  const settings = { ...readSettings(), ...patch };
  writeSettings(settings);
  await boot();
}

async function pickWorkspace() {
  const result = await openDialog({
    title: "选择工作区（内核可读写的目录）",
    defaultPath: (session && session.workspace) || defaultWorkspace(),
    properties: ["openDirectory", "createDirectory"],
  });
  if (result.canceled || result.filePaths.length === 0) return;
  await reboot({ workspace: result.filePaths[0] });
}

async function pickModsRoot() {
  const result = await openDialog({
    title: "选择游戏 Mods 目录（可留空）",
    defaultPath: (session && session.modsRoot) || (session && session.workspace) || defaultWorkspace(),
    properties: ["openDirectory"],
  });
  if (result.canceled || result.filePaths.length === 0) return;
  await reboot({ modsRoot: result.filePaths[0] });
}

/* ------------------------------------------------------------------ */
/* a new mod                                                          */
/* ------------------------------------------------------------------ */

/**
 * Ask the page to write its unsaved board before navigating it.  The page has
 * `beforeunload` for the user's own navigations, but that does not cover a
 * reload main.js starts: the new document is on its way before the old one can
 * put up a dialog, and the layout from the last autosave window would be gone.
 * `__infantgodFlushBoard` (shell/web/main.mjs) saves only when there is
 * something unsaved and answers `{status: "clean"|"saved"|"failed"}`.
 *
 * A page without the hook (not the app) or a flush that fails is logged and the
 * navigation still happens: a mod the user just created has to be shown.
 */
async function flushBoardBeforeNavigation() {
  if (win === null) return;
  let outcome;
  try {
    outcome = await win.webContents.executeJavaScript(
      "typeof window.__infantgodFlushBoard === \"function\" ? window.__infantgodFlushBoard() : null",
    );
  } catch (err) {
    log(`flush before navigation failed: ${(err && err.message) || err}`);
    return;
  }
  if (outcome !== null && typeof outcome === "object" && outcome.status === "failed") {
    log(`flush before navigation failed: ${outcome.detail || "the board could not be written"}`);
  }
}

/**
 * File -> "打开示例 Mod": copy the bundled demo package into the mods folder and
 * show it.
 *
 * The demo ships beside the editor, which is outside the mods folder, and the
 * shell refuses to open a mod outside it (`resolveArg` is a containment rule, not
 * a convenience).  So the menu asks `mod.example` to copy the package in -- which
 * also leaves the user with a copy they can edit -- and then navigates the same
 * `?mod=` way the new-mod shortcut does.
 */
async function openExample() {
  if (session === null) return;
  try {
    const answer = await examples.install({ endpoint: session.url });
    log(answer.installed
      ? `example: ${answer.dir} (${answer.files} files) copied into ${answer.modRoot}`
      : `example: ${answer.dir} is already in ${answer.modRoot}`);
    await flushBoardBeforeNavigation();
    if (win !== null) await win.loadURL(examples.openUrl(session, answer.modRoot));
  } catch (err) {
    reportFailure("打开示例 Mod 失败", err);
  }
}

/**
 * File -> "新建模组…": a save dialog names the folder, then the shell's own
 * `mod.scaffold` -- over the endpoint this window is already talking to --
 * writes the template.  Nothing here reads `shell/mods/` directly: a packaged
 * app keeps the shell outside `app.asar`.
 *
 * `templateId` is one of electron/newmod.js's TEMPLATES, chosen by the menu
 * item; the dialog only decides where, so the same code serves all four.
 */
async function pickNewMod(templateId) {
  if (session === null) return;
  const remembered = readSettings().newModDir;
  const parent =
    typeof remembered === "string" && remembered !== ""
      ? remembered
      : newMod.defaultParent(session);
  const root = newMod.writableRoot(session);

  try {
    const result = await saveDialog({
      title: "新建模组",
      defaultPath: path.join(parent, "NewMod"),
      buttonLabel: "创建",
      properties: ["createDirectory", "showOverwriteConfirmation"],
    });
    if (result.canceled || !result.filePath) return;

    const chosen = result.filePath;
    const target = newMod.plan({ parent: path.dirname(chosen), typedName: path.basename(chosen) });

    /*
     * F1: the dialog can name any folder, but `mod.scaffold` only writes under
     * the mods root (the workspace when none is configured).  Ask before the
     * write instead of relaying `EOUTSIDE` afterwards.
     */
    const confined = newMod.confine({ parent: target.dir, root });
    let dir = confined.dir;
    if (confined.moved) {
      const answer = await messageBox({
        type: "question",
        title: "新建模组",
        message: `${target.dir} 不在可写入的 Mods 目录内`,
        detail: `模组只能创建在 ${root} 下。要在 ${root} 里创建 "${target.modName}" 吗？`,
        buttons: ["在这里创建", "取消"],
        defaultId: 0,
        cancelId: 1,
      });
      if (answer.response !== 0) return;
      dir = root;
    }

    let created;
    try {
      created = await newMod.createMod({
        endpoint: session.url,
        dir,
        modName: target.modName,
        template: templateId,
      });
    } catch (err) {
      /*
       * F2: a partially written package used to be a dead end -- the dialog
       * offered "overwrite" but the frame never carried the flag.  Recognise
       * the refusal and let the user replace the files, which is the only way
       * the menu can repair its own leftovers.
       */
      if (!newMod.needsOverwrite(err)) throw err;
      const answer = await messageBox({
        type: "question",
        title: "新建模组",
        message: `${path.join(dir, target.modName)} 里已经有文件`,
        detail: "要用这个模板替换其中的同名文件吗？（其它文件会保留）",
        buttons: ["替换", "取消"],
        defaultId: 0,
        cancelId: 1,
      });
      if (answer.response !== 0) return;
      created = await newMod.createMod({
        endpoint: session.url,
        dir,
        modName: target.modName,
        template: templateId,
        overwrite: true,
      });
    }

    /*
     * F3: remembering the folder is a convenience, not part of creating the
     * package.  A failed settings write used to turn a written package into
     * "新建模组失败", after which retrying hit F2's dead end.
     */
    let rememberedNote = "";
    try {
      writeSettings({ ...readSettings(), newModDir: dir });
    } catch (err) {
      log(`newmod: could not remember the folder ${dir}: ${err && err.message ? err.message : err}`);
      rememberedNote = `\n（未能记住这个文件夹：${err && err.message ? err.message : err}）`;
    }
    log(`newmod: ${created.modRoot} (${created.created.length} files, template ${templateId})`);

    await messageBox({
      type: "info",
      title: "新建模组",
      message: `已在 ${created.modRoot} 生成模组`,
      detail:
        ([...created.created, ...(created.warnings || [])].map(String).join("\n") || "（没有新增文件）") + rememberedNote,
      buttons: ["好"],
    });

    /*
     * "展开在选择的工作区": the project panel *is* the workspace, so a mod that
     * already sits inside it only needs the window pointed at it.  One that
     * does not gets offered the one change that would make it visible -- the
     * mod's parent as the workspace -- rather than a path the shell would
     * refuse.
     *
     * A bare reload used to be enough here, and it left the new package
     * invisible: the board on disk still held `mod(dir: "")`, so the window
     * came back with "(no dir)" and three empty sections.  The reload now
     * carries the package in the URL (`?mod=`), which is how the page knows
     * which directory to open; unsaved layout is flushed first because a
     * reload is decided before the old page can answer a dialog.
     */
    const container = path.dirname(created.modRoot);
    if (newMod.isInside(created.modRoot, session.workspace)) {
      await flushBoardBeforeNavigation();
      if (win !== null) await win.loadURL(newMod.openModUrl(session, created.modRoot));
      return;
    }
    const answer = await messageBox({
      type: "question",
      title: "新建模组",
      message: `${created.modRoot} 不在当前工作区内（${session.workspace}）`,
      detail: `要把 ${container} 设为工作区吗？`,
      buttons: ["是", "否"],
      defaultId: 0,
      cancelId: 1,
    });
    if (answer.response === 0) await reboot({ workspace: container });
  } catch (err) {
    // A refused scaffold, an unwritable folder, a name Windows dislikes: all
    // of them are the user's to see, never a silent no-op.
    reportFailure("新建模组失败", err);
  }
}

/* ------------------------------------------------------------------ */
/* menus                                                              */
/* ------------------------------------------------------------------ */

function buildMenu() {
  /*
   * The template list and the fragment come from electron/newmod.js, so the
   * menu and its parity check (shell/mods/selftest.mjs) read one array.
   * `minimal` gets the accelerator: it is the item someone reaches for while
   * the workspace is still open.
   */
  const newModItems = newMod.menuTemplate({ onPick: pickNewMod });
  const minimal = newMod.TEMPLATES.findIndex((template) => template.id === "minimal");
  if (minimal !== -1) newModItems[0].submenu[minimal].accelerator = "CmdOrCtrl+N";

  const template = [
    {
      label: "File",
      submenu: [
        { label: "Choose Workspace…", accelerator: "CmdOrCtrl+O", click: () => pickWorkspace().catch((e) => reportFailure("切换工作区失败", e)) },
        { label: "Choose Mods Folder…", accelerator: "CmdOrCtrl+M", click: () => pickModsRoot().catch((e) => reportFailure("切换 Mods 目录失败", e)) },
        ...newModItems,
        {
          label: "打开示例 Mod",
          click: () => {
            openExample();
          },
        },
        { type: "separator" },
        {
          label: "Open Workspace Folder",
          click: () => {
            if (session) shell.openPath(session.workspace);
          },
        },
        {
          label: "Open Mods Folder",
          click: () => {
            if (session && session.modsRoot) shell.openPath(session.modsRoot);
          },
        },
        { type: "separator" },
        { role: "quit", label: "Quit" },
      ],
    },
    {
      label: "View",
      submenu: [
        { role: "reload" },
        { role: "forceReload" },
        { role: "toggleDevTools" },
        { type: "separator" },
        { role: "resetZoom" },
        { role: "zoomIn" },
        { role: "zoomOut" },
        { type: "separator" },
        { role: "togglefullscreen" },
      ],
    },
    {
      label: "Help",
      submenu: [
        {
          label: "About / Endpoint…",
          click: () => {
            const lines = session
              ? [
                  `工作区   ${session.workspace}`,
                  `Mods 目录 ${session.modsRoot || "(同工作区)"}`,
                  `端点     ${session.url}`,
                  `内核     ${KERNEL}`,
                  "",
                  "设置文件 " + settingsPath(),
                ]
              : ["端点尚未启动。"];
            messageBox({
              type: "info",
              title: "OsanaKami IDE Studio",
              message: `OsanaKami IDE Studio ${app.getVersion()}`,
              detail: lines.join("\n"),
              buttons: ["好"],
            });          },
        },
      ],
    },
  ];
  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

/* ------------------------------------------------------------------ */
/* lifecycle                                                          */
/* ------------------------------------------------------------------ */

/*
 * Two windows on one board means two endpoints writing one .infantgod/board.json,
 * which is exactly the revision fight the protocol's STALE_REVISION exists to
 * catch.  One instance, and the second launch focuses the first.
 */
if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on("second-instance", () => {
    if (win === null) return;
    if (win.isMinimized()) win.restore();
    win.focus();
  });

  app.whenReady().then(() => {
    buildMenu();
    return boot();
  });

  app.on("activate", () => {
    if (win === null) boot();
  });

  app.on("window-all-closed", () => {
    app.quit();
  });

  app.on("will-quit", () => {
    stopShell();
  });
}
