import { HERE, require, check, section } from "./foundation.mjs";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

/*
 * G61：包历史放在编辑器自己的安装目录，不放在包内；打开或新建包时自动建库。
 * 这里分两层证明：
 *   1. 命令行的构造与输出解析（注入假的 spawn，不依赖二进制）；
 *   2. 真二进制的完整往返（未构建 `build-iaqs/iaqs.exe` 时 skip，和内核测试
 *      一样按环境跳过，而不是假绿）。
 */

const { createHistory, storeName, parsePorcelain, parseLog } = require("../versioning.js");

section("package history");

/* ------------------------------------------------------------------ */
/* 命令面：注入 spawn，钉住参数与解析。                                  */

const calls = [];
const fakeSpawn = (bin, args) => {
  calls.push({ bin, args });
  const verb = args.find((arg) => ["init", "status", "add", "commit", "log", "restore"].includes(arg));
  if (verb === "init") {
    mkdirSync(args[args.length - 1], { recursive: true });
    return { status: 0, stdout: "Initialized repository\n", stderr: "" };
  }
  if (verb === "status") return { status: 0, stdout: " M mod.json\n?? notes/new.txt\n", stderr: "" };
  if (verb === "commit") return { status: 0, stdout: "Committed 0123456789ab\n", stderr: "" };
  if (verb === "add") return { status: 0, stdout: "", stderr: "" };
  if (verb === "log") return { status: 0, stdout: "0123456789ab second\nfedcba987654 first\n", stderr: "" };
  if (verb === "restore") return { status: 0, stdout: "Restored *\n", stderr: "" };
  return { status: 0, stdout: "", stderr: "" };
};

const fakeInstall = mkdtempSync(join(tmpdir(), "infantgod-history-unit-"));
const fakePackage = join(fakeInstall, "Mods", "HistoryDemo");
mkdirSync(fakePackage, { recursive: true });
writeFileSync(join(fakePackage, "mod.json"), "{}\n");

const unit = createHistory({ installDir: fakeInstall, exePath: process.execPath, spawn: fakeSpawn });
check(
  "the store sits under the editor's install folder, named after the package -- " + unit.storeFor(fakePackage),
  unit.storeFor(fakePackage).startsWith(join(fakeInstall, "history") + require("node:path").sep)
);

const made = unit.ensure(fakePackage);
check("the first open creates the store and records the package path",
  made.ok === true && made.created === true && readFileSync(join(made.store, "package.txt"), "utf8").trim().endsWith("historydemo"),
  JSON.stringify(made));
check("the creation ran `iaqs init` against the store",
  calls.length === 1
    && calls[0].args.includes("init")
    && calls[0].args[calls[0].args.length - 1] === made.store
    && calls[0].args.includes("--worktree"),
  JSON.stringify(calls[0] && calls[0].args));

const before = calls.length;
const again = unit.ensure(fakePackage);
check("opening it again does not create a second store",
  again.ok === true && again.created === false && calls.length === before,
  `created=${again.created} calls=${calls.length - before}`);

const status = unit.status(fakePackage);
check("status parses porcelain into edited and new paths",
  status.ok === true && status.entries.length === 2 && status.entries[0].path === "mod.json" && status.entries[1].path === "notes/new.txt",
  JSON.stringify(status.entries));

const saved = unit.save(fakePackage, "second");
check("save stages everything and commits with the message",
  saved.ok === true && saved.committed === true && saved.oid === "0123456789ab" && saved.message === "second",
  JSON.stringify(saved));
check("save ran `add -A` before `commit -m second`",
  calls.some((call) => call.args.includes("add") && call.args.includes("-A"))
    && calls.some((call) => call.args.includes("commit") && call.args.includes("-m") && call.args.includes("second")));

const restore = unit.restore(fakePackage, { all: true });
check("restore with no paths asks for the whole worktree",
  restore.ok === true && calls[calls.length - 1].args.includes("--all"),
  JSON.stringify(calls[calls.length - 1] && calls[calls.length - 1].args));

check("the folder name is readable and carries a stable hash",
  /^HistoryDemo-[0-9a-f]{12}$/.test(storeName(fakePackage)) && storeName(fakePackage) === storeName(fakePackage),
  storeName(fakePackage));
check("two packages with the same basename keep separate histories",
  storeName(fakePackage) !== storeName(join(fakeInstall, "Elsewhere", "HistoryDemo")));

check("porcelain reader keeps git's two-letter state",
  JSON.stringify(parsePorcelain("A  new.txt\n M old.txt\n")) === JSON.stringify([
    { state: "A ", path: "new.txt" },
    { state: " M", path: "old.txt" }
  ]));
check("log reader takes the short oid and the first line",
  JSON.stringify(parseLog("0123456789ab second\nfedcba987654 first\n")) === JSON.stringify([
    { oid: "0123456789ab", message: "second" },
    { oid: "fedcba987654", message: "first" }
  ]));

const missing = createHistory({ installDir: fakeInstall, exePath: join(fakeInstall, "no-such-iaqs.exe") });
const absent = missing.ensure(fakePackage);
check("a missing binary is a state the UI can report, not a throw",
  absent.ok === false && absent.reason === "unavailable",
  JSON.stringify(absent));

rmSync(fakeInstall, { recursive: true, force: true });

/* ------------------------------------------------------------------ */
/* 真二进制：建库、改文件、提交、读日志、恢复。                          */

const realExe = resolve(HERE, "..", "..", "build-iaqs", "iaqs.exe");
if (!existsSync(realExe)) {
  console.log("  skip the real binary round trip (build-iaqs/iaqs.exe is not built)");
} else {
  /*
   * The sandbox on the Windows development machine lets a child process create
   * files only under `build-iaqs/` (the folder the build script labels); the
   * system temp folder belongs to a higher integrity level.  Other machines use
   * the normal temp folder.
   */
  const buildRoot = resolve(HERE, "..", "..", "build-iaqs");
  const tempParent = existsSync(buildRoot) ? buildRoot : tmpdir();
  const install = mkdtempSync(join(tempParent, "infantgod-history-install-"));
  const pkg = mkdtempSync(join(tempParent, "infantgod-history-pkg-"));
  try {
    writeFileSync(join(pkg, "mod.json"), JSON.stringify({ name: "HistoryDemo" }) + "\n");
    writeFileSync(join(pkg, "note.txt"), "one\n");
    const real = createHistory({ installDir: install, exePath: realExe });

    const created = real.ensure(pkg);
    check("the real binary initialises the store on first open",
      created.ok === true && created.created === true && existsSync(join(install, "history")),
      JSON.stringify(created));

    writeFileSync(join(pkg, "note.txt"), "two\n");
    const dirty = real.status(pkg);
    check("the real binary reports the edited file",
      dirty.ok === true && dirty.entries.some((entry) => entry.path === "note.txt"),
      JSON.stringify(dirty.entries));

    const first = real.save(pkg, "first");
    check("the real binary commits the version",
      first.ok === true && first.committed === true && /^[0-9a-f]{12}$/.test(String(first.oid)),
      JSON.stringify(first));
    const clean = real.save(pkg, "nothing");
    check("committing nothing is not reported as a version",
      clean.ok === true && clean.committed === false,
      JSON.stringify(clean));

    const log = real.log(pkg);
    check("the real binary lists the commit with its message",
      log.ok === true && log.commits.length === 1 && log.commits[0].message === "first",
      JSON.stringify(log.commits));

    writeFileSync(join(pkg, "note.txt"), "three\n");
    const reverted = real.restore(pkg, { all: true });
    check("the real binary restores the committed bytes",
      reverted.ok === true && readFileSync(join(pkg, "note.txt"), "utf8") === "two\n",
      `${reverted.ok} ${JSON.stringify(readFileSync(join(pkg, "note.txt"), "utf8"))}`);
  } finally {
    rmSync(install, { recursive: true, force: true });
    rmSync(pkg, { recursive: true, force: true });
  }
}
