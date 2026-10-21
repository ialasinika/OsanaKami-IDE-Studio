# OsanaKami IDE Studio kernel -- C89, zero third-party dependencies, offline build.
#
# Everything this file needs is a C89 compiler and GNU make.  There is no
# configure step, no package manager and no network access: `make` either
# finds a compiler or it does not.
#
# A fork trims the kernel by deleting lines from the SRC list below, the
# matching file under core/, and any method in core/src/rpc.c that calls it.
# `infantgod modules` prints what each line costs.

# CC is the compiler on PATH unless something names another.  The MinGW-w64
# toolchain this project is developed with is often not on PATH: set MINGW_BIN
# to the directory that holds gcc.exe (a machine fact, so it lives in the
# environment, not here) and it is used.  `make CC=...` and tools/build.py,
# which resolves the same two knobs and passes CC through, work too.
MINGW_BIN ?=
# ``?=`` would leave make's built-in ``CC=cc`` in place, so this is a plain
# assignment; a command-line ``CC=...`` still wins, which is what tools/build.py
# and a developer who names a compiler rely on.
CC      = $(if $(MINGW_BIN),$(MINGW_BIN)/gcc.exe,gcc)
CFLAGS  = -std=c89 -pedantic -Wall -Wextra -Werror -O2 -Icore/include
LDFLAGS =

BIN     = build/infantgod.exe
OBJDIR  = build/obj

PYTHON  = python
NODE    = node

# ---------------------------------------------------------------------------
# sources -- one line per module, in dependency order
# ---------------------------------------------------------------------------

SRC = \
	core/src/buf.c \
	core/src/vec.c \
	core/src/json.c \
	core/src/base64.c \
	core/src/wksp.c \
	core/src/blob.c \
	core/src/view.c \
	core/src/exec.c \
	core/src/rpc.c \
	core/src/serve.c \
	core/src/app.c \
	core/src/main.c

# The platform layer is the one place that knows which OS this is.  A fork
# targeting another system writes core/port/sys_<name>.c and proc_<name>.c
# and selects it here; nothing above core/port changes.
SRC += core/port/sys_win32.c core/port/proc_win32.c

OBJ = $(addprefix $(OBJDIR)/,$(notdir $(SRC:.c=.o)))

# Every object depends on every header, because make cannot see an #include.
# Without this line a header-only change -- a version bump is exactly that --
# rebuilt nothing, and the binary ended up reporting two versions at once:
# `infantgod version` from the .c that happened to be edited, `hello` from a
# stale rpc.o.  Coarse on purpose: eleven sources cost nothing to recompile, and
# a wildcard rule has no first-build gap the way `-include *.d` has.
HEADERS = $(wildcard core/include/*.h)

# Release is the default; the flag is honoured because tools/build.py passes it.
ifdef RELEASE
CFLAGS += -O2
endif

# ---------------------------------------------------------------------------
# build
# ---------------------------------------------------------------------------

.PHONY: all check fullcheck probe smoke test run clean modules version-check path-check installer-check sign-check iaqs-bin iaqs-check ci ci-installer icon window package

all: $(BIN)

$(BIN): $(OBJ)
	$(CC) $(OBJ) -o $@ $(LDFLAGS)
	@echo "built $@"

# The kernel's own unit test: the JSON codec, which everything else trusts.
JSONTEST = build/obj/test_json.exe

$(JSONTEST): core/tests/test_json.c $(OBJDIR)/json.o $(OBJDIR)/buf.o $(OBJDIR)/vec.o
	$(CC) $(CFLAGS) core/tests/test_json.c $(OBJDIR)/json.o $(OBJDIR)/buf.o $(OBJDIR)/vec.o -o $@

# The blob layer's own unit test: the five file.blob* methods, base64 on the
# wire, offsets, limits and sessions -- driven through sde_rpc_handle(), so it
# needs every object except the one that owns main().  Its scratch files live
# under build/test-blob and are removed on every exit path, so `make test`
# leaves nothing behind.
BLOBTEST = build/obj/test_blob.exe

$(BLOBTEST): core/tests/test_blob.c $(filter-out $(OBJDIR)/main.o,$(OBJ))
	$(CC) $(CFLAGS) core/tests/test_blob.c $(filter-out $(OBJDIR)/main.o,$(OBJ)) -o $@

# The object directory is a directory, not a file: an order-only prerequisite
# keeps make from rebuilding everything whenever its timestamp moves.  It is
# created through Python rather than mkdir because the recipe shell differs
# between cmd.exe and sh.exe, and Python is needed by this project anyway.
$(OBJDIR):
	$(PYTHON) -c "import os;os.makedirs(r'$(OBJDIR)',exist_ok=True)"

$(OBJ): | $(OBJDIR)

# The file that says which version this is, and every header it reaches: see
# HEADERS above for why the headers are named at all.
$(OBJ): $(HEADERS) VERSION

$(OBJDIR)/%.o: core/src/%.c
	$(CC) $(CFLAGS) -c $< -o $@

$(OBJDIR)/%.o: core/port/%.c
	$(CC) $(CFLAGS) -c $< -o $@

# ---------------------------------------------------------------------------
# verification
# ---------------------------------------------------------------------------

# End-to-end against the kernel alone: drives the real binary over stdio and
# asserts the protocol.  Languages are skipped here -- they live in the shell.
check: $(BIN)
	$(PYTHON) tools/e2e.py --kernel $(BIN)

# The same suite against the whole endpoint, which adds language support.
fullcheck: $(BIN)
	$(PYTHON) tools/e2e.py --kernel-cmd "$(NODE) shell/main.mjs rpc --workspace ."

# The kernel regression probe: every bug in docs/BUGS.md, checked after the fix.
# It drives the kernel against a scratch workspace under build/, so it cannot
# touch your view document or your files.
probe: $(BIN)
	$(PYTHON) tools/kernel_probe.py

# The version is decided in VERSION; every copy of it -- the config header, the
# shell banner, core/src/main.c, package.json -- is checked here so the binary
# cannot drift from the number a release will be tagged with, or from the one
# electron-builder stamps into the installer.
version-check:
	$(PYTHON) tools/version.py check

# The second client: `tools/seide_cli.py`, against its own scratch workspace.
# The reference shell is one consumer of the protocol and a board is one kind of
# document, so this is the check that the frozen contract still stands on its
# own -- no shell code involved, and no schema assumed.
cli-check: $(BIN)
	$(PYTHON) tools/seide_cli.py selfcheck

# No tracked file may name a directory that exists only on one machine.  The run
# is `--strict`: any absolute path that is not a documented placeholder or an
# allow-listed Windows-shaped test fixture fails it.  The allow-list in the tool
# records each exception with a reason; the rules themselves are checked against
# synthetic strings first, because a guard that silently stops matching is worse
# than none.
path-check:
	$(PYTHON) tools/path_guard.py --self-test
	$(PYTHON) tools/path_guard.py --strict

# The installer's own promises, on the real Windows installer and uninstaller:
# a new folder installs and an upgrade works, the uninstaller removes the files
# it laid down and leaves a stranger's files alone, a folder holding a stranger's
# file is refused, and an uninstaller away from its manifest deletes nothing
# (G36).  It compiles a two-file installer with the cached NSIS; a machine
# without makensis skips with exit 0, the way the browser smokes skip without a
# browser.
installer-check:
	$(PYTHON) tools/installer_smoke.py

# The signing wiring, without a certificate: a compiled stand-in for signtool
# proves the dry-run argv and its redaction, the two exit-2 paths (no
# certificate, no signtool), that a real compile hands signtool the installer
# and not the payload, that neither the log nor build/make-installer.json holds
# the password, and that a non-zero signtool fails the build.  Needs gcc and
# makensis; skips with exit 0 when either is absent, like installer-check.
sign-check:
	$(PYTHON) tools/sign_smoke.py

# The version store: build-iaqs/iaqs.exe is what the installer payload ships and
# what the history adapter runs.  `iaqs-check` builds it and runs the fork's own
# suite; without cmake and a C++ compiler both print a skip and exit 0, the same
# contract as installer-check and sign-check.  The build tree and the binary are
# ignored, never committed.
iaqs-bin:
	$(PYTHON) tools/iaqs.py build

iaqs-check: iaqs-bin
	$(PYTHON) tools/iaqs.py test

# A fixture installer for CI: the same make-installer.mjs a release runs, on a
# two-file payload instead of dist/win-unpacked.  Skipped without makensis.
ci-installer:
	$(PYTHON) tools/ci_installer.py

# The window, without a human: starts the host, drives the system browser
# headless, and asserts on the rendered DOM.  Then the same window with a
# pointer, a keyboard and a wheel: --dump-dom drives none of them, so
# input_smoke.py serves a wrapper page and dispatches Ctrl+Z and a wheel from
# inside it.  Both need a browser; both say so and skip (exit 0) when there is
# none.
smoke: $(BIN)
	$(PYTHON) tools/browser_smoke.py --timeout 90
	$(PYTHON) tools/input_smoke.py --timeout 90

# Everything the project can prove about itself without a window: the C JSON
# codec, the version store's C++ suite, the language layer, the browser modules,
# the mod layer, the AI layer, the fixed bugs, the version copies, the second
# client, and both protocol modes.
#
# Note the explicit --workspace for the mod suite: the mod layer refuses any
# path outside its root, and that containment rule is itself under test, so the
# suite must not be run from whatever directory happens to be current.
test: check fullcheck probe cli-check version-check path-check installer-check sign-check iaqs-check $(JSONTEST) $(BLOBTEST)
	$(JSONTEST)
	$(BLOBTEST)
	$(NODE) langs/selftest.mjs
	$(NODE) shell/web/selftest.mjs
	$(NODE) shell/mods/selftest.mjs
	$(NODE) shell/ai/selftest.mjs

# The GitHub Actions `test` job, with the local toolchain: the whole `test`
# target, the fixture installer the job uploads, and the workflow audit.  The
# browser smoke is a separate CI job and is deliberately not part of this.
# A missing makensis or gcc turns the installer/signing checks into skips, the
# same way they skip on a runner without NSIS.
ci: test
	$(MAKE) ci-installer
	$(PYTHON) tools/ci_audit.py

modules: $(BIN)
	$(BIN) modules

# The Electron window's icon is generated from the app palette, not drawn by
# hand, so it stays in step with style.css.  Needs Pillow.
icon:
	$(PYTHON) tools/make_icon.py

# The Electron window itself.  `npm install` first; the kernel must be built,
# because the wrapper ships it as a separate binary rather than a JS module.
window: $(BIN)
	npm start

# An unpacked Electron tree in dist/win-unpacked, and an NSIS installer.
package: iaqs-bin $(BIN)
	npm run dist

# The window: a static server plus the system browser in app mode.  No
# Electron, no bundled Chromium, no download.
run: $(BIN)
	$(NODE) shell/main.mjs serve --workspace .

clean:
	$(PYTHON) -c "import shutil;shutil.rmtree('build',ignore_errors=True)"
	@echo "cleaned build/"
