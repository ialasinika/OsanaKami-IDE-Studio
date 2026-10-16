# The Electron wrapper

This directory is the only part of the project that knows Electron exists. It
turns InfantGod Studio into a desktop application: a real window, a real taskbar
entry, an installer, and no dependency on whatever browser happens to be
installed.

Nothing under `shell/`, `langs/`, `core/` or `tools/` changed to make this work,
and nothing there should have to. The same product is still available as a
browser app:

```sh
node shell/main.mjs serve --workspace .      # system browser, no npm install
npm start                                    # Electron window
```

## Why it is this small

`electron/main.js` is the whole wrapper — one file, no preload script, no IPC
channel, no renderer bundle. That is possible because the board was already a
web application talking to `127.0.0.1` over `fetch()` and `EventSource`, so
Electron only has to do three things:

1. start the HTTP endpoint as a child process,
2. open a `BrowserWindow` on the URL it prints,
3. kill the endpoint when the window closes.

Everything else an Electron app usually needs — a preload bridge, a
`contextBridge` API, message passing — exists to give a renderer access to Node.
The board does not want Node access: it wants `mod.*`, `lang.*`, `file.*` and
`board.*`, which are already JSON-RPC methods with their own containment rules.
So the renderer stays in Electron's secure defaults:

```js
webPreferences: { nodeIntegration: false, contextIsolation: true, sandbox: true }
```

and the mod layer's `--mods-root` allowlist remains the only way a card reaches
the filesystem.

## How it boots

```
electron .                                       InfantGod Studio.exe (or electron)
  └─ main.js
       ├─ reads <userData>/settings.json         { workspace, modsRoot }
       ├─ spawns process.execPath                the shell, under ELECTRON_RUN_AS_NODE=1
       │    shell/main.mjs serve --workspace … --port 0 --no-open
       │      └─ spawns build/infantgod.exe rpc  the kernel
       ├─ parses "board  http://127.0.0.1:PORT/" from the shell's stdout
       └─ new BrowserWindow().loadURL(that URL)
```

`process.execPath` is Electron's own binary; with `ELECTRON_RUN_AS_NODE=1` it
behaves as plain Node. That is what keeps the installer at one runtime instead of
shipping a second copy of Node.

`--port 0` asks the OS for a free port, so two checkouts do not fight over a
fixed one. `--no-open` is essential: without it the shell would launch the system
browser on top of the Electron window.

### Killing the tree

`taskkill /pid <pid> /T /F` — not `child.kill()`. The shell starts the kernel as
its own child, so killing only the shell leaves a kernel process behind holding
`.infantgod/board.json`. This is the one place the wrapper is platform-aware.

## Settings

There is no settings UI. Settings live in Electron's per-user directory:

| platform | path |
| --- | --- |
| Windows | `%APPDATA%\InfantGod Studio\settings.json` |

```json
{
  "workspace": "C:\\Users\\you\\Documents\\InfantGodStudio",
  "modsRoot": "D:\\Games\\Infant God\\StreamingAssets\\Mods"
}
```

A packaged app has no meaningful working directory, and `--workspace .` would
resolve to the inside of a read-only install, so the workspace has to be an
explicit writable directory. On first run it defaults to
`Documents/InfantGodStudio`, which is created if it is missing; **File → Choose
Workspace…** moves it, and the choice is remembered.

`modsRoot` is optional and only narrows what `mod.*` may touch. Leave it out and
the mod verbs are bounded by the workspace, exactly as on the command line.

## Menus

| menu | item | does |
| --- | --- | --- |
| File | Choose Workspace… | `Ctrl+O` — pick a directory, restart the endpoint on it |
| File | Choose Mods Folder… | `Ctrl+M` — pick the game's `Mods` folder |
| File | Open Workspace / Mods Folder | reveal it in Explorer |
| View | Reload, DevTools, zoom, fullscreen | the Electron roles |
| Help | About / Endpoint… | the live URLs and the settings path |

There is no `Edit` menu: the board's canvas has no clipboard model of its own,
and the roles Electron would add (`cut`/`copy`/`paste`) apply to the focused
`<textarea>` anyway.

## The icon

`electron/icon.ico` is **generated**, not drawn by hand:

```sh
python tools/make_icon.py      # or: make icon
```

It renders the product's own paradigm — three cards with coloured title bars,
joined by links — from the palette in `shell/web/style.css`, at 8× and
downsampled, and writes every size from 16 to 256 into one `.ico`.

## Building a distributable

Only `electron/` goes inside `app.asar`. Everything the shell needs at run time —
its own code, the language descriptions, and the kernel — ships as ordinary files
beside the executable, which is why `main.js` keeps an `APP_ROOT` that is
`process.resourcesPath` when packaged and the repository when not:

```json
"files": ["electron/**/*", "package.json"],
"extraResources": [
  { "from": "build/infantgod.exe", "to": "infantgod.exe" },
  { "from": "shell", "to": "shell" },
  { "from": "langs", "to": "langs" }
]
```

Keeping the shell out of the archive is not an aesthetic choice. `spawn` needs a
real `cwd`, and a path inside `app.asar` is not a directory — the failure is
`ENOENT`, which reads like "the executable is missing" and sends you looking in
the wrong place. (That is exactly how this was found: the packed app booted,
printed its endpoint, and then died with
`spawn …\InfantGod Studio.exe ENOENT`.) Node's ESM loader also reaches for `fs`
in ways Electron's asar shim does not cover, so keeping the shell outside the
archive removes the whole class of problem rather than one instance of it.

Build the kernel first, then package:

```sh
mingw32-make -f Makefile SHELL=cmd.exe      # -> build/infantgod.exe
npm run pack                                 # unpacked tree in dist/win-unpacked
npm run dist                                 # NSIS installer in dist/
```

`npm run pack` is what you want while iterating: it skips the installer step and
produces something you can run directly. To check the installer too:

```sh
"dist/InfantGod Studio Setup 0.1.0.exe" /S   # silent, per-user
%LOCALAPPDATA%\Programs\InfantGod Studio\InfantGod Studio.exe
```

### If npm cannot reach its registry

`registry.npmjs.org` and Electron's GitHub release host are both slow or
unreachable from some networks. Mirrors work:

```sh
npm install --registry=https://registry.npmmirror.com \
  --fetch-timeout=600000 --fetch-retries=5

# and for the Electron and electron-builder binaries themselves:
ELECTRON_MIRROR=https://npmmirror.com/mirrors/electron/
ELECTRON_BUILDER_BINARIES_MIRROR=https://npmmirror.com/mirrors/electron-builder-binaries/
```

Nothing in this repository hardcodes a mirror: the project takes no position on
which registry you use.

## If Electron starts at low integrity

On a machine where the checkout was written by a sandboxed build agent, Electron
can die before any of `main.js` runs — a `0x80000003` breakpoint, or a
`[FATAL:platform_win.cc] Check failed` — or, if it gets further, fail on
`app.getPath("userData")` with `Failed to create directory` / `EPERM`.

The cause is not Electron. Windows launched the process at **Low** mandatory
integrity, because every file under `node_modules/electron` inherited a low
integrity label from whatever wrote it. Chromium's sandbox cannot initialise from
Low, and Low cannot create the per-user data directory. Ask for the label back:

```sh
icacls node_modules\electron /setintegritylevel Medium /T /C /Q
```

The label is per-file and survives copying, so it needs doing once per checkout.
`build/infantgod.exe` needs the same treatment: at Low integrity the kernel cannot
create `.infantgod/board.json`, and the status line reports
`save failed: cannot create directory`.

## If Electron runs but no window appears

When the shell that launches the app is itself Electron-as-Node — an editor
extension host, an agent harness, a CI step reusing `electron.exe` — it may have
exported `ELECTRON_RUN_AS_NODE=1`. Every Electron process it starts then runs as
plain Node: it exits immediately, stdout and stderr are empty, and no `boot.log`
is written. Nothing is wrong with the app; the variable is inherited.

```sh
Remove-Item Env:ELECTRON_RUN_AS_NODE    # PowerShell
set ELECTRON_RUN_AS_NODE=               # cmd.exe
unset ELECTRON_RUN_AS_NODE              # sh
```

This only affects processes started from such a shell. Launching from Explorer or
an ordinary terminal is unaffected.

## Constraints, stated plainly

- **Windows only.** `core/port/` has a Win32 implementation and nothing else, so
  the packaged app is a Windows app. The wrapper itself is portable.
- **No terminal.** The runner card executes a command and shows its output; there
  is no pty, so interactive programs will not work here either.
- **No auto-update, no crash reporting.**
- **`node_modules/` is a build-time dependency only.** The shipped files are
  `electron/`, `shell/`, `langs/` and the kernel; Electron's runtime is the only
  thing npm contributes.

## Signing

```sh
npm run cert     # once per machine: create the identity and trust it here
npm run dist     # every build from then on is signed
```

`npm run cert` runs [tools/make_cert.ps1](../tools/make_cert.ps1), which makes a
self-signed certificate with the Code Signing EKU and exports it to
`%USERPROFILE%\.infantgod\` — a `.pfx` for the private key, a `.pw` for its
password, a `.cer` for the public half. Nothing secret enters the checkout, and
`.gitignore` blocks `*.pfx` / `*.pw` / `*.cer` in case someone exports one there
anyway: a private key that reaches a commit has to be rotated, and the history
keeps it forever.

[tools/sign.mjs](../tools/sign.mjs) is what `npm run dist` actually runs. It finds
that `.pfx`, puts it in `CSC_LINK` / `CSC_KEY_PASSWORD`, and hands control to
electron-builder. If no identity exists it says so and builds unsigned, so a
fresh clone still builds. **Anything already in `CSC_LINK` wins** — that is how a
real certificate, or a CI secret, is used without editing anything.

Four files get signed: the app executable, `resources/elevate.exe`, the NSIS
uninstaller, and the installer. electron-builder also timestamps them against
DigiCert's RFC 3161 responder, which is what keeps the signature verifiable after
the certificate expires in 2029.

```
> Get-AuthenticodeSignature "dist\InfantGod Studio Setup 0.1.0.exe"

Status  Valid
Signer  CN=InfantGod Studio
```

### What a self-signed signature does and does not buy

It buys **integrity**: anyone can tell the artifact has not been altered since it
was signed, and the thumbprint identifies which build it came from.

It does **not** buy **authenticity, and it does not silence SmartScreen.** No
certificate authority vouches for the name, so on every machine other than the one
that ran `npm run cert`, Windows reports "Unknown Publisher" and SmartScreen still
warns. That is not a bug in this setup; it is the difference between proving a file
is unchanged and proving who made it, and only a CA-issued certificate gives the
second one.

To use a real one, export it to the same `.pfx` path and rerun `npm run cert`'s
sibling step — or skip all of this and set the environment directly:

```sh
CSC_LINK=C:\path\to\real.pfx CSC_KEY_PASSWORD=... npm run dist
```

`win.signtoolOptions.publisherName` in `package.json` is `InfantGod Studio` and
must match the certificate's subject, or the NSIS installer will refuse to build.
(An older electron-builder wanted this key at `win.publisherName` and warns when
it finds it there.)

