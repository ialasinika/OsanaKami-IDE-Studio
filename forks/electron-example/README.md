# electron-example -- a fork that is only a window

This fork is a worked example, not a shipped variant.  It puts the *same* shell
in an Electron window: `shell/main.mjs` still serves the interface and still
starts the kernel, `shell/web/` is still the interface, and nothing in the
kernel or the base shell mentions Electron.  The only new things are a
`package.json` that asks for Electron and an `electron/main.cjs` that opens a
window on the server the base shell already knows how to start.

That split is the point of the fork mechanism.  A fork may add a dependency,
a framework, a platform port or a piece of UI.  It changes what it needs to
change, in one directory, and the base repository stays dependency-free
(`docs/FORK.md` is the rule this example follows).

## What it is

- `fork.json` -- what `tools/release.py --fork electron-example` reads: name,
  title, one-line summary.  The overlay is `files/`, laid over the bundle root,
  so `files/package.json` becomes the bundle's `package.json`.
- `files/package.json` -- the fork's own dependencies (Electron) and the start
  script.  The base bundle has no `package.json` on purpose.
- `files/electron/main.cjs` -- the window.  It starts the base shell with
  `--no-open`, waits for it to print its address, loads that address in a
  `BrowserWindow`, and kills the server when the window closes.
- `files/ELECTRON.md` -- the same instructions as this file, shipped inside the
  fork's bundle so the person who unzips it can read them.

## What it is not

- **Never built here.**  This repository has no `node_modules`, no lockfile and
  no network; Electron was never installed and this window was never launched
  from this checkout.  The code is written against Electron 30+ (CommonJS main
  process, `contextIsolation`, `sandbox`), and that is the extent of the claim.
- **Not part of a release.**  `tools/release.py` only takes `--fork` for a
  channel whose table lists forks (1.x final and LTS see `tools/release.py`),
  and the base `make test` / `make smoke` never touch this directory.  This
  fork exists so the mechanism in the changelog has something real to point at.

## Building it

```sh
python tools/release.py --fork electron-example --dry-run   # the plan
python tools/release.py --fork electron-example             # a 1.x channel only
```

Either way the fork's bundle and `electron-example-fork.zip` land under
`dist/<version>/electron-example/`, and `APPLY.md` in the fork zip says what to
lay the fork's files on.  To run it by hand from a bundle:

```sh
cd <bundle>
npm install        # the fork's only dependency, from the fork's package.json
npm start          # electron ., which runs electron/main.cjs
```
