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
 * writable path.  Documents/InfantGodStudio is the first-run default; the
 * File menu is how you point at a real project.
 */
const defaultWorkspace = () => path.join(app.getPath("documents"), "InfantGodStudio");

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
    title: "InfantGod Studio",
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
      win.setTitle(`InfantGod Studio — ${workspace}`);
    }
    console.log(started.log.trimEnd());
  } catch (err) {
    log(`boot FAILED: ${(err && err.stack) || err}`);
    reportFailure("幼神工坊启动失败", err);
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
/* menus                                                              */
/* ------------------------------------------------------------------ */

function buildMenu() {
  const template = [
    {
      label: "File",
      submenu: [
        { label: "Choose Workspace…", accelerator: "CmdOrCtrl+O", click: () => pickWorkspace().catch((e) => reportFailure("切换工作区失败", e)) },
        { label: "Choose Mods Folder…", accelerator: "CmdOrCtrl+M", click: () => pickModsRoot().catch((e) => reportFailure("切换 Mods 目录失败", e)) },
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
              title: "InfantGod Studio",
              message: `InfantGod Studio ${app.getVersion()}`,
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
