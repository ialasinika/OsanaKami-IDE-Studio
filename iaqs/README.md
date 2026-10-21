# iaqs — the version store

`iaqs` is the single-user, single-machine history store a mod package gets: no
server, no account, one plaintext store per package. It began as a separate
project of the same author (C++20, 0BSD, no third-party code) and this directory
is now the project's own fork — it lives in the tree, is edited like the rest of
the tree, and `make iaqs-bin` builds it into `build-iaqs/iaqs.exe`.

Upstream is the same author's `iaqs` checkout elsewhere on this machine, with no
git history of its own; the copy was taken on 2026-10-21, after upstream's M7
audit pass (upstream README sha256 `965E0D89...`). Upstream's own README and
helper scripts are not carried here: they describe a password flow this fork
removed, and its build scripts hardcode a machine path and a build directory
inside the source tree. Our build is `make iaqs-bin` / `make iaqs-check`,

## What this fork changes

The point of the fork is that the editor never asks for a password, and that the
store can live beside the app instead of inside the package. A mod author should
be able to press "save a version" and get a version.

- **No encryption.** The ChaCha20-Poly1305 page cipher, HMAC/PBKDF2 key
  derivation, the keyring and the wrapped-key MANIFEST are deleted with their
  tests. The MANIFEST is a 44-byte plaintext header (magic, format version 2,
  page size, segment size, database uuid, CRC-32C); pages and WAL records are
  stored as-is with their checksums. `src/crypto/` keeps only what object ids and
  checksums need: SHA-256/SHA-1, CRC-32C and the system RNG. A database written
  by the old password format is refused by name (`this database was written with
  a password mode this build no longer has`) instead of being half-read.
- **The password surface is gone.** `passwd`, `rekey`, `--password-stdin`,
  `IAQS_PASSWORD`, `IAQS_NEW_PASSWORD`, `--new-password`,
  `--allow-weak-password`, the interactive prompts, the default-password ladder
  and the "wrong password" exit code were removed from the CLI, the usage text
  and the i18n catalogs. `Database::create(dir, page_size)` and
  `Database::open(dir)` take no password.
- **The database and the tree are two paths.** `--repo` names the database
  (where `.iaqs/` lives), `--worktree` names the tree whose files the versions
  describe; without `--worktree` the two are the same directory. `Repo::init` and
  `Repo::open` take the pair, so the editor can keep a package's store in its own
  install folder while the package stays where the author put it.
- **Tests run with `TEMP` inside the workspace.** This machine's file sandbox
  lets a child process write under the workspace only, so
  `make iaqs-check` points `TEMP`/`TMP` at
  `build-iaqs/test-temp` for the run. Without that, every temp-directory test
  fails with "cannot create directories: Permission denied".

The deltas are confined to `src/db/` (manifest, envelope, wal, pager, database,
page), `src/vcs/repo.*`, `src/cli/cli.cpp`, `src/i18n/i18n.cpp` and the tests;
`git diff` against the fork's first commit shows every one of them. The storage
checks are unchanged in kind: page and slot CRC refusal, WAL replay and truncated
tails, segment merging, MANIFEST round trip and corruption, pager generation
moves, oversize refusal.

`docs/design/` is the upstream design set, kept for the object model and the
storage story. `07-encryption.md` is deleted; where `00`, `04` and `05` mention
encryption or passwords they describe upstream, not this tree.

## Building and testing

```powershell
# with MinGW-w64's bin first on PATH, and a compiler that can find its own cc1:
make iaqs-check          # build, then run the fork's suite
```

`cmake` and a C++ compiler must be on PATH; the generator is `MinGW Makefiles`
when `mingw32-make` is there and `Unix Makefiles` otherwise (MSYS2, CI). The
build lands at `build-iaqs/iaqs.exe`; `build-iaqs/` is ignored. `make test`
runs `iaqs-check` too, and both commands print a skip and exit 0 where the
toolchain is absent. The suite is 233 tests: the upstream 254 minus the crypto,
key and rekey tests, plus the plaintext and manifest-version checks
`test_plain_store` pins.

## Synchronising with upstream

Upstream changes rarely and has no revision to name, so a sync is a manual copy:

1. Copy that checkout over this directory except `.gitattributes` (which keeps
   the tree's bytes untranslated) and this README.
2. `git diff` against the fork's first commit to see the deltas that need
   re-applying; `test_plain_store.cpp` fails loudly when the plaintext mode is
   missing and `test_manifest` fails when a password MANIFEST is accepted.
3. Re-run the build and the suite before trusting it.

## What is here

- `src/cli/` — the command surface (`init add status commit log show cat-file
  ls-tree branch switch merge diff tag reset info gc fsck rm mv restore clean
  rev-parse checkpoint placeholder export-git import-git lang`).
- `src/db/` — the storage engine: MANIFEST, page pager, WAL, B-tree and the
  relational layer.
- `src/vcs/` — objects, the version tree, worktree and streaming.
- `src/crypto/` — SHA-256/SHA-1, CRC-32C and the system RNG.
- `tests/` — the unit and component suites.
- `docs/design/` — the upstream design documents; they explain the object model
  and the storage format the editor leans on.
