# iaqs, vendored

`iaqs` is the single-user, single-machine version store this project hands a
mod author's package to: local history, no server, no account. It is a separate
project of the same author, and this tree is the copy the app is built against.

## What is here

`src/`, `tests/`, `docs/design/`, `scripts/`, `CMakeLists.txt`, `README.md`,
`LICENSE` and `.gitignore` are copied verbatim from the upstream development
tree. `README.md` is upstream's own: it has the command surface, the
design-decision list and the milestone table. The design documents under
`docs/design/` are the reason the copy is worth carrying at all -- they describe
the object model, the storage layer, the version tree and the encryption threat
model.

The copy was re-synced on 2026-10-21, after upstream's M7 audit pass: the README
and the tree now say 248 unit tests (not 240), name the path-containment and
crash-safety hardening, and list `restore --all`, `clean`, `checkpoint` and the
language-pack commands. Upstream has no git history to name a revision by, so
the date is the anchor.

## Rules

- **Do not edit this tree.** It is kept byte-identical so a newer upstream build
  can be copied over it without a merge. A behaviour change belongs in the
  adapter (`shell/versioning.js`) or upstream, never here.
- `tools/path_guard.py` skips `vendor/` for the same reason: upstream's examples
  name machine paths, and those paths are documentation of another project, not
  a leak of this one.
- The executable is built, never committed. `build-iaqs/` is ignored.

## Building it

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File tools/build-iaqs.ps1
# with the unit tests, and stripped for shipping:
powershell -NoProfile -ExecutionPolicy Bypass -File tools/build-iaqs.ps1 -Strip -Tests
```

`cmake`, `g++` and `mingw32-make` must be on PATH; on this machine that means
putting MinGW-w64's `bin` first (the project README has the exact toolchain and
the reason Ninja is not used). The build lands at `build-iaqs/iaqs.exe`.

## Version

Upstream's CMake project version is `0.1.0`. The shell adapter asks
`iaqs --version` once at startup and hides the history feature when the binary
is missing or older than the minimum it knows -- an absent tool is a state, not
a crash, the same rule the support matrix follows for the game.
