# Releasing seIDE

A release is three things that agree: **a commit**, **a tag** on it, and **an
archive** of it, plus a `SHA256SUMS` that says which bytes were handed out.
`tools/release.py` does all four in one run and refuses to guess when something
does not add up.

There is one number in this project.  Everything else below is derived from it.

```sh
python tools/version.py show      # 0.2.0-alpha.1, channel alpha
python tools/release.py --dry-run # the whole plan, nothing written
```

---

## 1. The one version

`VERSION`, at the repository root, is the only place a seIDE version is
decided:

```
0.2.0-alpha.1
```

That is `X.Y.Z`, optionally followed by `-channel.N`, where `channel` is one of
`alpha`, `beta`, `rc`.  A release has no suffix.  The shape matters: it is what
lets `tools/version.py` and `tools/release.py` tell a pre-release from a
release without a lookup table.

Two files carry a copy, because C89 and JavaScript cannot read a file at build
time without a build step this project does not have:

| file | the copy |
|---|---|
| `core/include/seide_cfg.h` | `#define SDE_VERSION "0.2.0-alpha.1"` |
| `shell/main.mjs` | `const SHELL_VERSION = "0.2.0-alpha.1";` |

Nothing else may carry one.  `#define SDE_VERSION` used to sit in
`core/src/main.c` as well; it does not any more, and `tools/version.py` fails
if a `.c` file grows a second one.

```sh
python tools/version.py show            # version, channel, what the stage promises
python tools/version.py check           # every copy, the changelog section, exit 1 on drift
python tools/version.py set 0.2.0-rc.1  # write the number into VERSION and both copies
python tools/version.py bump            # advance one step: alpha.1 -> alpha.2 -> beta.1 -> rc.1
make version-check                      # the check alone
```

`make test` runs `tools/version.py check`, so the tree cannot pass its own
tests while the binary and the shell disagree about what version they are.
`bump` stops at a release: from `0.2.0-rc.1` it will not invent `0.2.0` or
`0.3.0` for you, because that decision is yours, not a tool's.

The other half of the check is the changelog.  The top `##` section of
`CHANGELOG.md` must be either `## Unreleased` (work in progress) or
`## v<version>` (frozen at release).  A release freezes it.

---

## 2. The channels

| channel | branch | version | artifacts | suites | what it promises |
|---|---|---|---|---|---|
| `alpha` | `main` | `-alpha.N` | source archive | `make test` | a public look at work in progress; the interface may still change |
| `beta` | `release/X.Y` | `-beta.N` | source + win64 bundle | `make test`, `make smoke` | feature-frozen; bugs and polish only |
| `rc` | `release/X.Y` | `-rc.N` | source + win64 bundle | `make test`, `make smoke` | only fixes; a regression here pushes the number |
| `final` | `release/X.Y` | *(none)* | source + win64 bundle (+ MSI at 1.x) | `make test`, `make smoke` | the interface is frozen |
| `lts` | `lts/X.Y` | *(none)* | source + win64 bundle (+ MSI) | `make test`, `make smoke` | 1.0.0 onwards; fixes only for a window that is deliberately not fixed yet |

The source archive is on **every** channel, including the ones with a bundle:
a binary nobody can rebuild is not a release this project knows how to make.

Two things are 1.x ideas, and the 0.x line does not have them.  There is no
`lts/` branch and no MSI before `1.0.0`; `tools/release.py` says so rather
than pretending.  `--with-msi` tries the installer step below 1.x anyway, for
the day it is needed, and `--no-msi` goes the other way: a 1.x final or LTS cut
that deliberately ships without the installer, which the notes and the manifest
then say out loud.  That flag exists for the machine this project is developed
on, which has no WiX -- it rehearses the rest of the GA path for real instead of
faking the piece it cannot build.

**Branch model.**  `main` integrates.  The first beta cuts
`release/<major>.<minor>` (so `release/0.2`), and every later pre-release and
the final release of that line is cut from it; fixes land on `main` and are
cherry-picked back.  After a `1.0.0` final, `lts/<major>.<minor>` may open from
that tag for fixes with no new features.  A release is always cut from the
branch its channel names; `--allow-branch` rehearses somewhere else and the
release notes say the branch rule was waived.

---

## 3. Cutting a release

```sh
python tools/version.py bump      # or: set 0.2.0-beta.1
#   ... edit CHANGELOG.md so the top section is '## Unreleased' ...
git add -A && git commit -m "Prepare 0.2.0-alpha.2"
python tools/release.py --dry-run # plan only
python tools/release.py           # the real thing
```

`release.py` runs five steps and stops at the first gate that says no:

1. **preflight** -- `VERSION` agrees with every copy; a `make` and a `gcc` can
   be found; the current branch is the channel's branch; the tree is clean; the
   tag is free; `git remote` is reported (not required).
2. **verify** -- runs the channel's suites (`make test`, plus `make smoke` from
   beta up) and records the exit code of each.
3. **freeze** -- renames `## Unreleased` to `## v<version> — <date>` and
   commits that on its own, so the changelog in the tag is the changelog that
   shipped.  `--no-freeze` skips it for a rehearsal.
4. **artifacts** -- builds the kernel, writes the channel's artifacts into
   `dist/<version>/`, then `SHA256SUMS`, `RELEASE-NOTES.md` and
   `manifest.json` beside them.
5. **tag** -- `git tag -a v<version>` on the release commit.  Nothing is pushed
   unless `--push` is given, and this repository has no remote configured, so
   today an alpha is a local archive, a local tag and a manifest that says so.

Everything lands in `dist/<version>/` (git-ignored; it can be regenerated from
the tag):

```
dist/0.2.0-alpha.1/
  seide-0.2.0-alpha.1-src.zip    the source at the tag
  SHA256SUMS                     one line per artifact
  RELEASE-NOTES.md               what ran, what shipped, what is known
  manifest.json                  the same facts, machine-readable
```

`RELEASE-NOTES.md` is generated, not written: it states the version, the
channel, the commit, the suites that actually ran (with their exit codes), the
artifacts with their sizes and hashes, and the known limits.  A rehearsal
therefore produces notes that say what did *not* run -- `--skip-tests` is
visible in the artifact, not just in the log.

### Rehearsing

| flag | what it does | what the notes then say |
|---|---|---|
| `--dry-run` | prints the plan, writes nothing, runs no suite | *(no release directory is produced)* |
| `--no-tag` | builds the artifacts but creates no tag | `tag: <tag> (NOT created: --no-tag)` |
| `--no-freeze` | leaves the changelog section as `## Unreleased` | `The changelog was not dated (--no-freeze)` |
| `--skip-tests` | runs no suite | `nothing: --skip-tests was used, so this release claims nothing was run.` |
| `--tests smoke` | overrides the suite list (repeatable; `test`, `smoke`) | exactly those suites, with the real command and exit code |
| `--with-msi` | tries the installer step below 1.x; only LTS/final require it | the MSI's name and hash, or the reason there is none |
| `--no-msi` | skips the installer a 1.x final or LTS requires | `The installer was not built (--no-msi)`, and `manifest.json` keeps `msi: null` with that sentence in `msi_note` |
| `--allow-branch` | rehearses on a branch the channel does not own | `The branch rule was waived (--allow-branch)`, naming both branches |
| `--dist DIR` | writes the release directory somewhere else | *(the notes do not name the directory; the manifest records the artifacts)* |

A rehearsal is not a release until the tree is clean, the branch is right, the
notes name a commit and the tag exists.

---

## 4. Promoting a line

```sh
# first beta of 0.2 -- branch once, then never again for this line
git switch -c release/0.2
python tools/version.py set 0.2.0-beta.1
git commit -am "Prepare 0.2.0-beta.1"
python tools/release.py            # channel comes from the -beta suffix

# a fix during beta/rc
git switch main && git commit ... && git switch release/0.2 && git cherry-pick <sha>
python tools/version.py bump && git commit -am "Prepare 0.2.0-beta.2"
python tools/release.py

# the release itself: no suffix, so no channel migration
python tools/version.py set 0.2.0
git commit -am "Prepare 0.2.0"
python tools/release.py --channel final
```

After `1.0.0`, an LTS line is opened deliberately and rarely:

```sh
git switch -c lts/1.0 v1.0.0
# fixes only, no new features
python tools/release.py --channel lts
```

The LTS window is **not fixed yet** -- no number of months has been decided,
so no document promises one.  That is a decision to make at 1.0.0, not a
sentence to write now.

---

## 5. Forks

A fork that wants the pipeline's help puts two things under `forks/<name>/`:

```
forks/<name>/fork.json      {"name": "...", "title": "...", "summary": "..."}
forks/<name>/files/...      laid over the bundle root, file for file
```

```sh
python tools/release.py --fork electron-example --dry-run
python tools/release.py --fork electron-example
```

The fork then gets its own tag (`<name>-v<version>`), its own release
directory (`dist/<version>/<name>/`), a bundle with `files/` laid over the
bundle root, and `<name>-fork.zip` -- the fork's whole delta plus an `APPLY.md`
that says what to lay it on.  `fork.json` may set `"no_fork_zip": true` for a
fork that only exists as an overlay.

`forks/electron-example/` is the worked example: an Electron window around the
same shell, with Electron in the fork's own `package.json`.  Electron never
enters the kernel or the base shell -- that is the point of keeping it here,
and it is why this repository has no dependencies of its own.  See
`docs/FORK.md` for what a fork may touch.

---

## 6. The installer (1.x)

```sh
python tools/msi/build.py --check  --bundle <dir> --version 1.0.0
python tools/msi/build.py          --bundle <dir> --version 1.0.0 --out seide-1.0.0-win64.msi
```

`tools/msi/` expands a WiX v4 source for a staged bundle and calls `wix` to
bind it: a per-machine install under `Program Files\seIDE` with the kernel, the
shell, the docs, a Start Menu shortcut, and `seide-window.cmd` as the launcher.
WiX is deliberately **not** a build dependency.  A machine without it gets one
sentence saying so and exit code 2 -- never an empty or fake `.msi`.  For 1.x
final and LTS the MSI is required: a release that cannot make one fails instead
of shipping without it.

The board is never installed into the install directory: it is per-user state
(see `docs/PROJECT.md`), and `tools/msi/` does not touch it.

---

## 7. What this pipeline does not claim

- **Nothing has been pushed.**  No remote is configured; `--push` will fail
  until one is.
- **The GitHub workflow has never run.**  `.github/workflows/ci.yml` exists and
  says in its own header that it has not been executed on a GitHub runner.
- **No MSI has ever been built.**  No WiX and no `dotnet` on this machine;
  `tools/msi/README.md` states it plainly, and the WiX UI extension needs to be
  available to the WiX install before the first real build.
- **The smoke tests need a browser.**  `make smoke` (and therefore a beta
  release's verify step) says so and skips with exit 0 when there is none.
- **The pipeline is not a notary.**  `SHA256SUMS` proves the artifacts did not
  change after the run; it does not prove who ran it.  There is no signing key
  and no provenance attestation, and the notes say so rather than implying one.
