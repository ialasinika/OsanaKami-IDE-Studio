# seIDE MSI packaging

Turns a **runnable release bundle** into a Windows installer, `seide-<version>-win64.msi`.
The bundle is produced by the release tool and looks like this:

```
seide.exe            VERSION            README.md   CHANGELOG.md   LICENSE   LICENSE-DOCS
shell/main.mjs       shell/web/...      langs/...   docs/...       examples/...
```

Neither file here is part of the offline build: `make` and `make test` never
touch `tools/msi/`, and nothing in the normal developer path needs WiX.

## When it is used

**GA and LTS releases only.** A release candidate is handed out as a zip of the
bundle; the MSI exists for the release a user installs once and keeps. That
split is deliberate: a `.msi` is a versioned, upgradeable, machine-wide
installation, and pre-release version strings do not fit Windows Installer's
numeric `ProductVersion` cleanly (see the note in [`build.py`](build.py)).

## Build it

```console
python tools/msi/build.py --bundle DIR --version 1.0.0 --out seide-1.0.0-win64.msi
python tools/msi/build.py --bundle DIR --version 1.0.0 --out out.msi ^
                          --manufacturer "seIDE contributors" --ui-name seIDE
```

`--manufacturer` and `--ui-name` default to `seIDE contributors` and `seIDE`,
so the second line only matters for a fork.

To expand and check the WiX source **without WiX installed** (this is the check
CI can run before it provisions anything):

```console
python tools/msi/build.py --check --bundle DIR --version 1.0.0
```

It prints the bundle file count, the component count and `well-formed`, and
exits 0. Exit codes: `0` ok, `2` tooling or packaging failure (no WiX, bad
bundle, malformed template), `3` a malformed command line such as a version
that is not `X.Y.Z`.

## WiX is required

The installer is built with **WiX 4 or 5**; the build command is
`wix build -arch x64 -ext WixToolset.UI.wixext ...` (the exact argv, and why
each flag is there, is in the [`build.py`](build.py) docstring). Install it with
either:

```console
dotnet tool install --global wix
```

or the WiX 4/5 installer from <https://wixtoolset.org/>. If `wix` is not on
`PATH` (and `$WIX` is unset), `build.py` prints one line naming the missing tool
and how to get it, and exits `2`. It never writes a fake or empty `.msi`.

The template uses the **built-in WiX UI** (`WixUI_InstallDir`), which in WiX 4/5
ships as a separate extension, so the build passes
`-ext WixToolset.UI.wixext`. That extension must be *available* to the WiX
installation, not merely named: depending on how WiX was installed you may need
`wix extension add WixToolset.UI.wixext` (or the matching NuGet package) once
before the build will accept the flag. `/qn` silent installs do not need the UI
extension at all; a build variant without the `ui:` namespace and the `WixUI`
element would drop the dependency entirely.

## The Node 24 prerequisite

The MSI installs the kernel, the shell and the language files. It does **not**
install a JavaScript runtime, because the project never bundles Node or
Electron (see the repository README). The window is launched by
`node shell/main.mjs serve --workspace DIR`, so **Node 24 must already be
installed and on `PATH`** for the Start Menu shortcut to do anything. The
shortcut runs `seide-window.cmd`, a two-line shim in the install directory that
exists only to pin `%~dp0` and to carry that note where a reader will see it.

## What the MSI deliberately does not do

* **No `PATH` edit.** Installing seIDE changes no environment variable.
* **No bundled runtime.** No Node, no Electron; that prerequisite is the user's.
* **No auto-update and no network access.** A newer MSI replaces an older one
  via `MajorUpgrade` when a human runs it; nothing checks for updates.
* **No per-user files.** The board state lives in `%USERPROFILE%\.seide\`,
  outside the install directory, so uninstalling seIDE removes the program and
  leaves the board exactly where it was.
* **No writes outside** `[ProgramFiles64Folder]seIDE\` and the standard
  Installer/ARP registry keys.
* **No custom actions.** Uninstall removes exactly what was installed.

A per-machine install needs an elevated prompt; `msiexec /i
seide-<version>-win64.msi /qn` is silent and therefore needs a context that is
already elevated.

## Status: no MSI has ever been built here

**This machine has no WiX installed** (neither `wix` nor `dotnet`), so nothing
in this directory has been through `wix build` or through a real install: the
`.wxs` has only ever been *expanded and validated* by `--check`, and a real
build attempt correctly exits `2` with the missing-tool line and produces no
`.msi`. The WiX syntax here follows the v4 schema and is written to be consumed
by `wix build`; the first person with WiX should expect to fix small issues
(a renamed UI extension, a directory-id complaint) rather than assume a clean
bind. Verified on this machine: `--check` on a 9-file probe bundle expands to
11 components and is well-formed; `--version 1.0` exits 3;
`python -m py_compile tools/msi/build.py` exits 0.
