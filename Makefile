# InfantGod Studio kernel -- C89, zero third-party dependencies, offline build.
#
# Everything this file needs is a C89 compiler and GNU make.  There is no
# configure step, no package manager and no network access: `make` either
# finds a compiler or it does not.
#
# A fork trims the kernel by deleting lines from the SRC list below, the
# matching file under core/, and any method in core/src/rpc.c that calls it.
# `infantgod modules` prints what each line costs.

CC      = C:/mingw64/mingw64/bin/gcc.exe
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
	core/src/wksp.c \
	core/src/board.c \
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

.PHONY: all check fullcheck probe smoke test run clean modules version-check icon window package

all: $(BIN)

$(BIN): $(OBJ)
	$(CC) $(OBJ) -o $@ $(LDFLAGS)
	@echo "built $@"

# The kernel's own unit test: the JSON codec, which everything else trusts.
JSONTEST = build/obj/test_json.exe

$(JSONTEST): core/tests/test_json.c $(OBJDIR)/json.o $(OBJDIR)/buf.o $(OBJDIR)/vec.o
	$(CC) $(CFLAGS) core/tests/test_json.c $(OBJDIR)/json.o $(OBJDIR)/buf.o $(OBJDIR)/vec.o -o $@

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
# touch your board or your files.
probe: $(BIN)
	$(PYTHON) tools/kernel_probe.py

# The version is decided in VERSION; every copy of it -- the config header, the
# shell banner, core/src/main.c, package.json -- is checked here so the binary
# cannot drift from the number a release will be tagged with, or from the one
# electron-builder stamps into the installer.
version-check:
	$(PYTHON) tools/version.py check

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
# codec, the language layer, the browser modules, the mod layer, the fixed bugs,
# the version copies, and both protocol modes.
#
# Note the explicit --workspace for the mod suite: the mod layer refuses any
# path outside its root, and that containment rule is itself under test, so the
# suite must not be run from whatever directory happens to be current.
test: check fullcheck probe version-check $(JSONTEST)
	$(JSONTEST)
	$(NODE) langs/selftest.mjs
	$(NODE) shell/web/selftest.mjs
	$(NODE) shell/mods/selftest.mjs

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
package: $(BIN)
	npm run dist

# The window: a static server plus the system browser in app mode.  No
# Electron, no bundled Chromium, no download.
run: $(BIN)
	$(NODE) shell/main.mjs serve --workspace .

clean:
	$(PYTHON) -c "import shutil;shutil.rmtree('build',ignore_errors=True)"
	@echo "cleaned build/"
