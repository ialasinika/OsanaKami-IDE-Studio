# electron-example -- what you just unzipped

This bundle is the base seIDE bundle plus one fork: an Electron window around
the same shell.  The base shell still serves the interface and starts the
kernel; Electron only draws the window.  Nothing in `build/seide.exe` or
`shell/` is patched.

## Run it

```sh
npm install      # reads package.json, installs Electron -- this fork's one dependency
npm start        # electron . -> electron/main.cjs
```

`electron/main.cjs` starts `shell/main.mjs serve --no-open`, waits for the
address it prints, and loads it in a window.  Closing the window kills the
server, so no port and no kernel are left behind.

`npm install` needs the network.  The base bundle does not: without these two
steps it runs the way `START-HERE.txt` says, in your own browser.

## Where the board lives

Not in this directory.  An installed bundle can be read-only, so the fork keeps
its workspace in the per-user application data directory Electron reports
(`app.getPath("userData")/workspace`).  Set `SEIDE_WORKSPACE` to override it.

## What this fork does not do

It does not bundle Chromium into the base IDE, it does not add Electron to the
base `package.json` (there is not one), and it is not part of a base release:
`tools/release.py --fork electron-example` only runs for a channel whose table
lists forks.  See `docs/FORK.md` for what a fork may touch, and the Electron
documentation for the window options used here.
