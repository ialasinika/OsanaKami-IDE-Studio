/* ------------------------------------------------------------------ */
/* the project view
/* ------------------------------------------------------------------ */

import assert from "node:assert/strict";
import {
  OutputBuffer,
  describeCard,
  dirNameOf,
  formatExit,
  parseCommandLine,
  projectRows,
  projectSummary,
} from "../cards.mjs";
import {
  test,
} from "./harness.mjs";

/* ------------------------------------------------------------------ */
/* the project view                                                    */
/* ------------------------------------------------------------------ */

/*
 * The project panel is the one surface that has to know the whole workspace at
 * once, so the interesting cases are the ones the `files` card cannot see: what
 * the board has open but the disk does not have any more, and what the kernel
 * never handed over at all.
 *
 * The fixture is what `workspace.list` really returns: the kernel skips
 * `.git`, `.infantgod`, `build`, `node_modules` and friends *while walking*
 * (`IGNORED_DIRS` in `core/src/wksp.c`), so no listing carries them and the
 * panel has nothing to filter. `workspace.info.ignored` names them instead.
 */
export const PROJECT_LISTING = {
  files: [
    { path: "core/src/view.c", size: 500, mtime: 900_000, dir: false },
    { path: "core/src/rpc.c", size: 400, mtime: 900_000, dir: false },
    { path: "README.md", size: 100, mtime: 900_000, dir: false },
    { path: "examples/hello.yarn", size: 807, mtime: 900_000, dir: false },
    { path: "core", size: 0, mtime: 900_000, dir: true },
  ],
  count: 5,
  truncated: false,
};

test("project: the project is the files of the workspace, grouped", () => {
  const view = projectRows(PROJECT_LISTING);
  // Root first, then folders alphabetically; folders are the grouping, so a
  // directory entry in the listing is counted but never becomes a row.
  assert.deepEqual(view.groups.map((group) => group.label), ["(root)", "core/src/", "examples/"]);
  assert.deepEqual(view.groups[0].rows.map((row) => row.name), ["README.md"]);
  assert.deepEqual(view.groups[1].rows.map((row) => row.name), ["rpc.c", "view.c"]);
  assert.deepEqual(view.groups[2].rows.map((row) => row.name), ["hello.yarn"]);
  assert.equal(view.groups[1].rows[0].folder, "core/src");
  assert.equal(view.groups[1].rows[0].sizeText, "400B");

  assert.equal(view.counts.files, 4);
  assert.equal(view.counts.dirs, 1);
  assert.equal(view.counts.shown, 4, "every file the kernel returned is shown");
  assert.equal(view.counts.open, 0);
  assert.equal(view.counts.complete, true);
});

test("project: the panel shows what it is given, it does not re-filter it", () => {
  // The kernel decides what a workspace listing contains. If a fork's kernel
  // hands back `build/` after all, the row belongs on screen -- a second,
  // client-side ignore list could only ever disagree with the one in C, and
  // would silently drop rows the user asked to see. `workspace.info.ignored`
  // is how the panel explains an absence; it never invents one.
  const withGenerated = {
    files: [
      { path: "core/src/rpc.c", size: 400, mtime: 900_000, dir: false },
      { path: "build/infantgod.exe", size: 999, mtime: 900_000, dir: false },
      { path: "node_modules/dep/index.js", size: 1, mtime: 900_000, dir: false },
    ],
    truncated: false,
  };
  const view = projectRows(withGenerated);
  assert.equal(view.counts.files, 3);
  assert.deepEqual(view.groups.map((group) => group.label), [
    "build/", "core/src/", "node_modules/dep/",
  ]);
  // The folder the file sits in is never part of the name.
  const rows = view.groups.flatMap((group) => group.rows);
  assert.equal(rows.find((row) => row.path === "node_modules/dep/index.js").name, "index.js");
});

test("project: an open editor is marked, and a file that left the disk is named", () => {
  const view = projectRows(PROJECT_LISTING, {
    open: [
      { id: "c2", path: "core/src/rpc.c", dirty: true },
      { id: "c5", path: "gone/away.c", dirty: false },
      { id: "c1", path: "examples/hello.yarn", dirty: false },
    ],
  });
  const byPath = new Map(view.groups.flatMap((group) => group.rows).map((row) => [row.path, row]));
  assert.equal(byPath.get("core/src/rpc.c").open, true);
  assert.equal(byPath.get("core/src/rpc.c").dirty, true);
  assert.equal(byPath.get("core/src/rpc.c").cardId, "c2");
  assert.equal(byPath.get("core/src/view.c").open, false);

  // The open list is the board's answer to "what am I editing", file order.
  assert.deepEqual(view.openRows.map((row) => row.path), [
    "core/src/rpc.c", "examples/hello.yarn", "gone/away.c",
  ]);
  assert.deepEqual(view.openRows.map((row) => row.present), [true, true, false]);
  assert.deepEqual(view.missingRows.map((row) => row.path), ["gone/away.c"]);
  assert.equal(view.counts.open, 3);
  assert.equal(view.counts.dirty, 1);
  assert.equal(view.counts.missing, 1);

  // Two cards on one file: both are open (the board may carry it), but a row
  // can only point at one of them, and it says so by naming the first.
  const twice = projectRows(PROJECT_LISTING, {
    open: [{ id: "c2", path: "core/src/rpc.c" }, { id: "c9", path: "core/src/rpc.c" }],
  });
  assert.equal(twice.counts.open, 2);
  assert.equal(twice.groups.flatMap((g) => g.rows).find((r) => r.path === "core/src/rpc.c").cardId, "c2");
});

test("project: a missing file is only a fact when the listing is complete", () => {
  const truncated = { ...PROJECT_LISTING, truncated: true };
  const view = projectRows(truncated, { open: [{ id: "c5", path: "gone/away.c" }] });
  assert.equal(view.counts.truncated, true);
  assert.equal(view.counts.complete, false);
  assert.equal(view.missingRows.length, 1, "the row is still reported");
  assert.match(projectSummary(view.counts), /listing truncated/, "...but the summary says why");
});

test("project: the filter narrows the tree and never the open list", () => {
  const view = projectRows(PROJECT_LISTING, {
    filter: "**/*.c",
    open: [{ id: "c1", path: "examples/hello.yarn" }],
  });
  assert.deepEqual(view.groups.map((group) => group.label), ["core/src/"]);
  assert.equal(view.counts.files, 4, "the whole project is still counted");
  assert.equal(view.counts.shown, 2);
  assert.equal(view.counts.open, 1, "an open file stays visible however the tree is filtered");

  const word = projectRows(PROJECT_LISTING, { filter: "view" });
  assert.deepEqual(word.groups.flatMap((group) => group.rows).map((row) => row.path), [
    "core/src/view.c",
  ], "a substring hits the path");
  assert.deepEqual(projectRows(PROJECT_LISTING, { filter: "nothing-matches" }).groups, []);
  assert.deepEqual(projectRows(PROJECT_LISTING, { filter: "build/**" }).groups, [],
    "a filter aimed at a directory the kernel skips matches nothing, which is why the "
    + "empty state names the skipped directories instead of pretending they are empty");
});

test("project: paths are the kernel's, whatever the host put in them", () => {
  assert.equal(dirNameOf("a/b/c.txt"), "a/b");
  assert.equal(dirNameOf("a.txt"), "", "a file at the root has no folder");
  assert.equal(dirNameOf("a/"), "a");
  assert.equal(dirNameOf(""), "");
  assert.equal(dirNameOf("a\\b\\c.txt"), "a/b", "one separator, like the kernel's paths");
});

test("project: the one-line summary counts the workspace and the board", () => {
  assert.equal(projectSummary(projectRows(PROJECT_LISTING).counts),
    "4 files · 1 folders · 0 open");
  assert.equal(projectSummary({
    files: 128, dirs: 6, open: 2, dirty: 1, missing: 1, truncated: true,
  }), "128 files · 6 folders · 2 open · 1 unsaved · 1 missing · listing truncated");
  assert.equal(projectSummary(null), "0 files · 0 open");
  assert.equal(projectSummary({}), "0 files · 0 open");
});

test("runner: the output buffer drops the head rather than growing forever", () => {
  const buffer = new OutputBuffer({ maxChars: 100, maxLines: 5 });
  buffer.append("a".repeat(80));
  assert.equal(buffer.length, 80);
  buffer.append("b".repeat(80));
  assert.equal(buffer.length, 100, "the buffer is capped");
  assert.equal(buffer.dropped, 60);
  const lines = buffer.lines();
  assert.match(lines[0], /earlier characters/);
  assert.equal(lines.length, 2, "one marker line, then the surviving text");

  const many = new OutputBuffer({ maxChars: 100000, maxLines: 3 });
  many.append("1\n2\n3\n4\n5\n");
  assert.deepEqual(many.lines(), [
    "[... 0 earlier characters, 3 earlier lines dropped ...]",
    "4",
    "5",
    "",
  ]);
  many.clear();
  assert.deepEqual(many.lines(), [""]);
});

test("runner: exit codes read as words, not numbers", () => {
  assert.equal(formatExit(0), "exit 0");
  assert.equal(formatExit(2), "exit 2");
  assert.equal(formatExit(-1), "killed (-1)");
  assert.equal(formatExit(null), "running");
  assert.equal(formatExit(undefined), "running");
});

test("command line: quoting and card descriptions", () => {
  assert.deepEqual(parseCommandLine("open examples/hello.yarn"), ["open", "examples/hello.yarn"]);
  assert.deepEqual(parseCommandLine('  run  "python tools/e2e.py" "a b.yarn" '), ["run", "python tools/e2e.py", "a b.yarn"]);
  assert.deepEqual(parseCommandLine('link c1 c2 "runs the file"'), ["link", "c1", "c2", "runs the file"]);
  assert.deepEqual(parseCommandLine("note hello world"), ["note", "hello", "world"]);
  assert.deepEqual(parseCommandLine("   "), []);
  assert.deepEqual(parseCommandLine(""), []);

  assert.equal(describeCard({ kind: "editor", file: "a.yarn" }), "editor a.yarn");
  assert.equal(describeCard({ kind: "runner", cmd: "ls" }), "runner ls");
  assert.equal(describeCard({ kind: "files" }), "files **/*");
  assert.equal(describeCard(null), "no card selected");
});
