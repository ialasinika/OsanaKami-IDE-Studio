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

# Release is the default; the flag is honoured because tools/build.py passes it.
ifdef RELEASE
CFLAGS += -O2
endif

# ---------------------------------------------------------------------------
# build
# ---------------------------------------------------------------------------

.PHONY: all check fullcheck test run clean modules

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
	$(PYTHON) tools/e2e.py --kernel $(BIN)

# The same suite against the whole endpoint, which adds language support.
fullcheck: $(BIN)
	$(PYTHON) tools/e2e.py --kernel-cmd "$(NODE) shell/main.mjs rpc --workspace ."

# Everything the project can prove about itself without a window: the C JSON
# codec, the language layer, the browser modules, the mod layer, and both
# protocol modes.
#
# Note the explicit --workspace for the mod suite: the mod layer refuses any
# path outside its root, and that containment rule is itself under test, so the
# suite must not be run from whatever directory happens to be current.
test: check fullcheck $(JSONTEST)
	$(JSONTEST)
	$(NODE) langs/selftest.mjs
	$(NODE) shell/web/selftest.mjs
	$(NODE) shell/mods/selftest.mjs

modules: $(BIN)
	$(BIN) modules

# The window: a static server plus the system browser in app mode.  No
# Electron, no bundled Chromium, no download.
run: $(BIN)
	$(NODE) shell/main.mjs serve --workspace .

clean:
	$(PYTHON) -c "import shutil;shutil.rmtree('build',ignore_errors=True)"
	@echo "cleaned build/"
