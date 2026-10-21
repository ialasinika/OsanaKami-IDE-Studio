# iaqs — the version store

`iaqs` is the single-user, single-machine history store a mod package gets: no
server, no account, one encrypted store per package. It began as a separate
project of the same author (C++20, 0BSD, no third-party code) and this directory
is now the project's own fork — it lives in the tree, is edited like the rest of
the tree, and is built by `tools/build-iaqs.ps1` into `build-iaqs/iaqs.exe`.

Upstream is the same author's `iaqs` checkout elsewhere on this machine, with no
git history of its own; the copy was taken on 2026-10-21, after upstream's M7
audit pass (upstream README sha256 `965E0D89...`). Upstream's own README and
helper scripts are not carried here: they describe a password flow this fork
removed, and its build scripts hardcode a machine path and a build directory
inside the source tree. Our build is `tools/build-iaqs.ps1`.

## What this fork changes

The point of the fork is that the editor never asks for a password. A mod author
should be able to press "save a version" and get a version.

- **Plaintext store.** A new MANIFEST mode (`kdf_type = kKdfNone`) stores pages
  and WAL records as plaintext with their CRC-32C checksums intact. The CLI only
  creates and opens that mode: `Database::create(dir, "")` /
  `Database::open(dir, "")`. The page envelope grew a plaintext flag
  (`kEnvelopeFlagPlain`), and `seal_page` / `open_page` / the WAL
  writer and reader take an `encrypted` flag so both modes share one format
  without guessing.
- **The password surface is gone.** `passwd`, `rekey`, `--password-stdin`,
  `IAQS_PASSWORD`, `IAQS_NEW_PASSWORD`, `--new-password`,
  `--allow-weak-password` and the interactive prompts were removed from the CLI
  and from the usage text. `init` takes no password. Opening a plaintext store
  with a password, or calling `change_password` / `rekey_data` on it, is an
  error rather than a silent no-op.
- **Encryption support stays in the engine.** The wrapped-key format, the
  crypto modules and `passwd`/`rekey` internals are still compiled and still
  covered by tests talking to `Database` directly; they are simply unreachable
  from this project's CLI. That keeps the upstream test suite meaningful and
  leaves the door open if a package ever wants to be sealed.
- **Tests run with `TEMP` inside the workspace.** This machine's file sandbox
  lets a child process write under the workspace only, so
  `tools/build-iaqs.ps1 -Tests` points `TEMP`/`TMP` at
  `build-iaqs/test-temp` for the run. Without that, every temp-directory test
  fails with "cannot create directories: Permission denied".

The deltas are confined to `src/db/` (manifest, envelope, wal, pager,
database), `src/cli/cli.cpp` and `src/i18n/i18n.cpp`; `git diff` against the
first fork commit shows every one of them. `tests/unit/test_plain_store.cpp`
pins the new mode, and the rest of the upstream suite still runs against the
encrypted mode.

## Building and testing

```powershell
# with MinGW-w64's bin first on PATH, and a compiler that can find its own cc1:
powershell -NoProfile -ExecutionPolicy Bypass -File tools/build-iaqs.ps1 -Strip -Tests
```

`cmake`, `g++` and `mingw32-make` must be on PATH. The build lands at
`build-iaqs/iaqs.exe`; `build-iaqs/` is ignored. The suite is 254 tests: the
upstream 248 plus six for the plaintext mode.

## Synchronising with upstream

Upstream changes rarely and has no revision to name, so a sync is a manual copy:

1. Copy that checkout over this directory except `.gitattributes` (which keeps
   the tree's bytes untranslated) and this README.
2. `git diff` against the fork's first commit to see the deltas that need
   re-applying; `test_plain_store.cpp` fails loudly when the plaintext mode is
   missing.
3. Re-run the build and the suite before trusting it.

## What is here

- `src/cli/` — the command surface (`init add status commit log show cat-file
  ls-tree branch switch merge diff tag reset info gc fsck rm mv restore clean
  rev-parse checkpoint placeholder export-git import-git lang`).
- `src/db/` — the storage engine: MANIFEST, page pager, WAL, B-tree, the
  relational layer and the key hierarchy.
- `src/vcs/` — objects, the version tree, worktree and streaming.
- `src/crypto/` — ChaCha20-Poly1305, HMAC, PBKDF2, SHA-256/SHA-1, CRC-32C.
- `tests/` — the unit and component suites.
- `docs/design/` — the upstream design documents; they explain the object model
  and the storage format the editor will lean on.
