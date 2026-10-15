# seIDE kernel -- C89, zero third-party dependencies, offline build.
#
# Everything this file needs is a C89 compiler and GNU make.  There is no
# configure step, no package manager and no network access: `make` either
# finds a compiler or it does not.
#
# A fork trims the kernel by deleting lines from the SRC list below, the
# matching file under core/, and any method in core/src/rpc.c that calls it.
# `seide modules` prints what each line costs.

CC      = C:/mingw64/mingw64/bin/gcc.exe
CFLAGS  = -std=c89 -pedantic -Wall -Wextra -Werror -O2 -Icore/include
LDFLAGS =

BIN     = build/seide.exe
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

# Release is the default; the flag is honoured because tools/build.py passes it.
ifdef RELEASE
CFLAGS += -O2
endif

# ---------------------------------------------------------------------------
# build
# ---------------------------------------------------------------------------

.PHONY: all check fullcheck probe smoke test run clean modules

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
	$(PYTHON) tools/e2e.py --seide $(BIN)

# The same suite against the whole endpoint, which adds language support.
fullcheck: $(BIN)
	$(PYTHON) tools/e2e.py --seide-cmd "$(NODE) shell/main.mjs rpc --workspace ."

# The kernel regression probe: every bug in docs/BUGS.md, checked after the fix.
# It drives the kernel against a scratch workspace under build/, so it cannot
# touch your board or your files.
probe: $(BIN)
	$(PYTHON) tools/kernel_probe.py

# The window, without a human: starts the host, drives the system browser
# headless, and asserts on the rendered DOM.  Needs a browser; says so and
# skips (exit 0) when there is none.
smoke: $(BIN)
	$(PYTHON) tools/browser_smoke.py --timeout 90

# Everything the project can prove about itself without a window: the C JSON
# codec, the language layer, the browser modules, the fixed bugs, and both
# protocol modes.
test: check fullcheck probe $(JSONTEST)
	$(JSONTEST)
	$(NODE) langs/selftest.mjs
	$(NODE) shell/web/selftest.mjs

modules: $(BIN)
	$(BIN) modules

# The window: a static server plus the system browser in app mode.  No
# Electron, no bundled Chromium, no download.
run: $(BIN)
	$(NODE) shell/main.mjs serve --workspace .

clean:
	$(PYTHON) -c "import shutil;shutil.rmtree('build',ignore_errors=True)"
	@echo "cleaned build/"
