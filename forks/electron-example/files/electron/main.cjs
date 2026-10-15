"use strict";

/*
 * The whole Electron fork.
 *
 * The base shell already knows how to serve the interface and start the
 * kernel; this file does not reimplement any of that.  It starts
 * `shell/main.mjs serve --no-open` as a child, waits for the address the shell
 * prints on start, and points a BrowserWindow at it.  When the window goes
 * away the child is killed, so no port and no kernel are left behind.
 *
 * `ELECTRON_RUN_AS_NODE` is what lets the fork use the Node that Electron
 * already ships instead of requiring a system Node install.
 */

const { app, BrowserWindow, shell } = require("electron");
const { spawn } = require("node:child_process");
const fs = require("node:fs");
const path = require("node:path");

const ROOT = path.resolve(__dirname, "..");
const SERVE = path.join(ROOT, "shell", "main.mjs");
const ADDRESS = /http:\/\/127\.0\.0\.1:\d+\//;

// A bundle can be installed read-only (Program Files, an MSI), so the board
// must not live inside it.  The workspace is per-user state, and
// SEIDE_WORKSPACE overrides it for a portable run.
const WORKSPACE = process.env.SEIDE_WORKSPACE || path.join(app.getPath("userData"), "workspace");

let child = null;
let win = null;
let stopping = false;

function startServer() {
  return new Promise((resolve, reject) => {
    const proc = spawn(
      process.execPath,
      [SERVE, "serve", "--workspace", WORKSPACE, "--no-open"],
      {
        cwd: ROOT,
        env: { ...process.env, ELECTRON_RUN_AS_NODE: "1" },
        stdio: ["ignore", "pipe", "pipe"],
        windowsHide: true,
      },
    );
    child = proc;

    const timer = setTimeout(() => {
      reject(new Error("the shell printed no address within 20 seconds"));
    }, 20000);
    const settled = (fn, value) => {
      clearTimeout(timer);
      fn(value);
    };

    let buffered = "";
    proc.stdout.setEncoding("utf8");
    proc.stdout.on("data", (chunk) => {
      buffered += chunk;
      const found = buffered.match(ADDRESS);
      if (found) settled(resolve, found[0]);
    });
    proc.stderr.setEncoding("utf8");
    proc.stderr.on("data", (chunk) => {
      process.stderr.write(`[shell] ${chunk}`);
    });

    proc.once("error", (err) => settled(reject, err));
    proc.once("exit", (code, signal) => {
      child = null;
      // Before the address, this is a failed start; after it, the server the
      // window is showing has died, and the window has nothing to show.
      settled(reject, new Error(`the shell exited (code ${code}, signal ${signal})`));
      if (win && !win.isDestroyed()) win.destroy();
    });
  });
}

function stopServer() {
  if (stopping) return;
  stopping = true;
  if (child && child.exitCode === null && !child.killed) {
    child.kill();
  }
  child = null;
}

async function open() {
  fs.mkdirSync(WORKSPACE, { recursive: true });
  const url = await startServer();

  win = new BrowserWindow({
    width: 1280,
    height: 820,
    minWidth: 640,
    minHeight: 420,
    title: "seIDE",
    backgroundColor: "#101418",
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      spellcheck: false,
    },
  });
  win.setMenuBarVisibility(false);

  // A link in the interface opens in the real browser, never in the app.
  win.webContents.setWindowOpenHandler(({ url: target }) => {
    shell.openExternal(target);
    return { action: "deny" };
  });

  win.once("closed", () => {
    win = null;
    stopServer();
  });

  await win.loadURL(url);
}

app.whenReady().then(open).catch((err) => {
  console.error(`seIDE electron: ${err && err.message ? err.message : err}`);
  stopServer();
  app.exit(1);
});

// This application is a window, not a tray icon: closing it ends the session.
app.on("window-all-closed", () => {
  stopServer();
  app.quit();
});
app.on("before-quit", stopServer);
process.on("exit", stopServer);
