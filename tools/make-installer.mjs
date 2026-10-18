#!/usr/bin/env node
/*
 * tools/make-installer.mjs -- build the Windows installer directly with makensis.
 *
 * WHY THIS EXISTS.  `electron-builder --win nsis` runs makensis twice: the first
 * pass is compiled with -DBUILD_UNINSTALLER, and app-builder-lib then *executes*
 * that pass-1 installer so it can write out its own uninstaller
 * (node_modules/app-builder-lib/out/targets/nsis/NsisTarget.js:347).  On this
 * machine that child dies instantly with an NSIS dialog -- "Error writing
 * temporary file.  Make sure your temp folder is valid." -- and exit code 2, so
 * the second pass (the real installer, with the uninstaller embedded) never
 * runs and the .exe left in dist/ is the unusable pass-1 artefact.
 *
 * tools/installer.nsi embeds the uninstaller with WriteUninstaller at build
 * time, so one makensis pass is enough and nothing is executed while building.
 * This script drives that pass, then signs the result with the project identity.
 *
 *   node tools/make-installer.mjs                       # signed dist/OsanaKami IDE Studio Setup 0.1.0.exe
 *   node tools/make-installer.mjs --no-sign --out build/control.exe
 *   node tools/make-installer.mjs --payload build/tiny-payload --out build/tiny.exe --no-sign
 *
 * No new dependencies: node builtins plus the makensis/signtool binaries that
 * electron-builder already cached under %LOCALAPPDATA%.
 */
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { closeSync, existsSync, mkdirSync, openSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, basename, isAbsolute, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = resolve(HERE, "..");
const BUILD = join(REPO, "build");

function fail(message) {
  console.error(`make-installer: error: ${message}`);
  process.exit(1);
}

function note(message) {
  console.log(`make-installer: ${message}`);
}

// ---------------------------------------------------------------------------
// Arguments
// ---------------------------------------------------------------------------
function parseArgs(argv) {
  const out = { sign: true, timestamp: true, lzma: false, audit: true, dev: false, defines: [] };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    const value = () => {
      i += 1;
      if (argv[i] === undefined) fail(`${arg} needs a value`);
      return argv[i];
    };
    switch (arg) {
      case "--payload": out.payload = value(); break;
      case "--licence":
      case "--license": out.licence = value(); break;
      case "--out": out.out = value(); break;
      case "--template": out.template = value(); break;
      case "--define": out.defines.push(value()); break;
      // `--dev` is the only way to build something that is not a release: it
      // allows a skipped audit and a non-empty allow-list.  Everything else
      // (CI, the packaging script, a human making a release candidate) must run
      // the audit and carry a zero allow-list, or it is not a release (G30).
      case "--dev": out.dev = true; break;
      case "--no-sign": out.sign = false; break;
      case "--no-timestamp": out.timestamp = false; break;
      case "--no-verify-sign": out.verifySign = false; break;
      // zlib is the default (LZMA silently breaks installs at this payload size,
      // see tools/installer.nsi); this switch is kept so old command lines run.
      case "--fast-compress": break;
      case "--lzma": out.lzma = true; break;
      case "--no-audit": out.audit = false; out.noAudit = true; break;
      case "--audit-only": out.auditOnly = true; break;
      case "--help":
      case "-h": out.help = true; break;
      default: fail(`unknown argument ${arg}`);
    }
  }
  return out;
}

const args = parseArgs(process.argv.slice(2));
if (args.help) {
  console.log(`usage: node tools/make-installer.mjs [options]

  --payload <dir>     app directory to pack (default dist/win-unpacked)
  --licence <file>    licence text shown on the licence page (default EULA.txt)
  --out <file>        installer to write (default dist/<Product> Setup <version>.exe)
  --template <file>   NSIS script to compile (default tools/installer.nsi)
  --define <K=V>      extra define for makensis (repeatable)
  --lzma              compile with LZMA (known to break installs at this size)
  --fast-compress     accepted for compatibility; zlib is the default
  --dev               a development build: allows --no-audit and a non-empty
                      allow-list, and marks the output as not release-ready
  --no-audit          skip the payload audit (requires --dev)
  --audit-only        run the payload audit and stop before compiling
  --no-sign           skip Authenticode signing
  --no-timestamp      sign without an RFC 3161 timestamp
  --no-verify-sign    do not ask Windows to validate the signature afterwards`);
  process.exit(0);
}

if (args.noAudit && !args.dev) {
  fail("--no-audit is a development escape hatch: pass --dev as well.\n"
    + "  A release runs the payload audit; that is the only thing that keeps the game's data out of the installer (G30).");
}

const pkg = JSON.parse(readFileSync(join(REPO, "package.json"), "utf8"));
const APP_NAME = pkg.productName || pkg.name;
const APP_VERSION = pkg.version;
const APP_EXE = `${APP_NAME}.exe`;
const APP_ID = pkg.build?.appId || "com.osanakami.idestudio";
const APP_PUBLISHER = pkg.author || APP_NAME;

const abs = (p) => (isAbsolute(p) ? p : resolve(REPO, p));
const PAYLOAD = abs(args.payload || join("dist", "win-unpacked"));
const LICENCE = abs(args.licence || "EULA.txt");
const ICON = abs(join("electron", "icon.ico"));
const TEMPLATE = abs(args.template || join("tools", "installer.nsi"));
const OUT = abs(args.out || join("dist", `${APP_NAME} Setup ${APP_VERSION}.exe`));
// VIProductVersion wants four numbers, so `0.1.1-alpha.1` becomes `0.1.1.0`
// (a pre-release tail is not a number makensis can take).
const v4 = /^(\d+)\.(\d+)\.(\d+)(?:\.(\d+))?/.exec(APP_VERSION);
const version4 = v4 ? `${v4[1]}.${v4[2]}.${v4[3]}.${v4[4] || 0}` : "0.0.0.0";

const DEFINES = {
  APP_NAME,
  APP_VERSION,
  APP_VERSION4: version4,
  APP_EXE,
  APP_ID,
  APP_PUBLISHER,
  PAYLOAD_DIR: PAYLOAD,
  LICENCE_FILE: LICENCE,
  ICON_FILE: ICON,
  OUT_FILE: OUT,
  UNINST_KEY: `Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\${APP_ID}`,
};
for (const extra of args.defines) {
  const at = extra.indexOf("=");
  if (at < 1) fail(`--define needs K=V, got ${extra}`);
  DEFINES[extra.slice(0, at)] = extra.slice(at + 1);
}

// ---------------------------------------------------------------------------
// Toolchain lookup
// ---------------------------------------------------------------------------
function firstExisting(paths) {
  for (const p of paths) if (p && existsSync(p)) return p;
  return null;
}

function findMakensis() {
  const cache = process.env.LOCALAPPDATA ? join(process.env.LOCALAPPDATA, "electron-builder", "Cache", "nsis") : null;
  const candidates = [process.env.MAKENSIS];
  if (cache && existsSync(cache)) {
    // Newest cached NSIS first, so a cache bump does not break the build.
    const versions = readdirSync(cache)
      .filter((name) => /^nsis-\d/.test(name))
      .sort()
      .reverse();
    for (const v of versions) candidates.push(join(cache, v, "Bin", "makensis.exe"));
  }
  candidates.push("C:\\Program Files (x86)\\NSIS\\makensis.exe", "C:\\Program Files\\NSIS\\makensis.exe");
  for (const dir of (process.env.PATH || "").split(";")) {
    if (dir) candidates.push(join(dir, "makensis.exe"));
  }
  return firstExisting(candidates);
}

function findSigntool() {
  const cache = process.env.LOCALAPPDATA
    ? join(process.env.LOCALAPPDATA, "electron-builder", "Cache", "winCodeSign")
    : null;
  const candidates = [process.env.SIGNTOOL];
  if (cache && existsSync(cache)) {
    const versions = readdirSync(cache).filter((n) => /^winCodeSign-/.test(n)).sort().reverse();
    for (const v of versions) {
      candidates.push(join(cache, v, "windows-10", "x64", "signtool.exe"));
      candidates.push(join(cache, v, "windows-10", "x86", "signtool.exe"));
    }
  }
  for (const dir of (process.env.PATH || "").split(";")) {
    if (dir) candidates.push(join(dir, "signtool.exe"));
  }
  return firstExisting(candidates);
}

// ---------------------------------------------------------------------------
// Pre-flight: prove every file the template will bake in exists
// ---------------------------------------------------------------------------
function walk(dir, base = "", files = []) {
  let bytes = 0;
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, entry.name);
    const rel = base ? `${base}/${entry.name}` : entry.name;
    if (entry.isDirectory()) {
      bytes += walk(p, rel, files).bytes;
    } else if (entry.isFile()) {
      bytes += statSync(p).size;
      files.push({ rel, abs: p });
    }
  }
  return { bytes, files };
}

function substitute(text) {
  let out = text;
  for (let i = 0; i < 10; i += 1) {
    const next = out.replace(/\$\{([A-Za-z0-9_]+)\}/g, (whole, name) =>
      Object.prototype.hasOwnProperty.call(DEFINES, name) ? DEFINES[name] : whole);
    if (next === out) break;
    out = next;
  }
  return out;
}

const makensis = findMakensis();
if (!makensis) fail("makensis.exe not found; set MAKENSIS or install NSIS (electron-builder's cache is also searched)");
if (!existsSync(TEMPLATE)) fail(`template not found: ${TEMPLATE}`);
if (!existsSync(PAYLOAD)) fail(`payload directory not found: ${PAYLOAD} -- run \`npm run pack\` first`);
if (!existsSync(join(PAYLOAD, APP_EXE))) fail(`payload has no ${APP_EXE}: ${join(PAYLOAD, APP_EXE)}`);

const payload = walk(PAYLOAD);
if (payload.files.length === 0) fail(`payload directory is empty: ${PAYLOAD}`);

// ---------------------------------------------------------------------------
// Ownership manifest -- the only files the uninstaller may remove (G36)
// ---------------------------------------------------------------------------
// The uninstaller used to end with `RMDir /r "$INSTDIR"`, which deletes whatever
// else the user put in the directory, and the installer never checked that the
// directory was ours to write into.  Both sides now know exactly what was laid
// down: the payload is walked here, once, and the list is compiled into the
// uninstaller and written into the install as `install-manifest.txt`.
function nsisRel(rel) {
  if (/["\r\n$]/.test(rel)) {
    fail(`payload file name cannot be written into the install manifest: ${rel}`);
  }
  return rel.split("/").join("\\");
}

const manifestFiles = payload.files.map((file) => file.rel).sort((a, b) => a.localeCompare(b, "en"));
// Every ancestor of every payload file, deepest first: `RMDir` is not recursive,
// so removing `sub` before `sub\deep` would fail and leave the empty parent.
const manifestDirs = [...new Set(manifestFiles.flatMap((rel) => {
  const parts = rel.split("/");
  const out = [];
  for (let i = 1; i < parts.length; i += 1) out.push(parts.slice(0, i).join("/"));
  return out;
}))].sort((a, b) => b.split("/").length - a.split("/").length || a.localeCompare(b, "en"));
// The licence page lays one file down beside the payload; it is ours too, and it
// is not in the payload walk because the template names it separately.
const licenceRel = basename(LICENCE);

const MANIFEST_TXT = join(BUILD, "install-manifest.txt");
const MANIFEST_NSI = join(BUILD, "install-manifest.nsi");
const manifestText = [
  `# ${APP_NAME} install manifest`,
  `# version ${APP_VERSION}`,
  "# One relative path per line: the files this installer laid down. The",
  "# uninstaller removes exactly these and leaves everything else alone (G36).",
  ...manifestFiles,
  "",
].join("\n");
writeFileSync(MANIFEST_TXT, manifestText);
writeFileSync(MANIFEST_NSI, [
  "; generated by tools/make-installer.mjs -- do not edit",
  "; The files and directories the installer owns, as NSIS commands (G36).",
  "!macro InstallerManifestFile",
  `  File "/oname=$INSTDIR\\install-manifest.txt" "${MANIFEST_TXT}"`,
  "!macroend",
  "!macro UninstallerManifestFiles",
  ...manifestFiles.map((rel) => `  Delete "$INSTDIR\\${nsisRel(rel)}"`),
  `  Delete "$INSTDIR\\${nsisRel(licenceRel)}"`,
  `  Delete "$INSTDIR\\install-manifest.txt"`,
  `  Delete "$INSTDIR\\Uninstall ${APP_NAME}.exe"`,
  "!macroend",
  "!macro UninstallerManifestDirs",
  ...manifestDirs.map((rel) => `  RMDir "$INSTDIR\\${nsisRel(rel)}"`),
  '  RMDir "$INSTDIR"',
  "!macroend",
  "",
].join("\n"));
note(`manifest   ${MANIFEST_TXT} (${manifestFiles.length} files, ${manifestDirs.length} directories)`);
// The template compiles these two paths in: the macro file and the text file
// that is laid down beside the app so the uninstaller can prove ownership.
DEFINES.MANIFEST_NSI = MANIFEST_NSI;
DEFINES.MANIFEST_TXT = MANIFEST_TXT;

const templateSource = readFileSync(TEMPLATE, "utf8");
const missing = [];
const checkPaths = (raw, what) => {
  const cleaned = substitute(raw.trim()).replace(/^"|"$/g, "");
  if (cleaned.includes("${")) {
    missing.push(`${what}: unresolved define in "${raw.trim()}"`);
    return;
  }
  const target = cleaned.replace(/[\\/]\*\.\*$/, "").replace(/[\\/]\*$/, "");
  if (!existsSync(target)) missing.push(`${what}: ${target}`);
};
for (const m of templateSource.matchAll(/!insertmacro\s+MUI_PAGE_LICENSE\s+(.+)/g)) checkPaths(m[1], "licence page");
for (const m of templateSource.matchAll(/^\s*File\s+\/r\s+(.+)$/gm)) checkPaths(m[1], "payload");
for (const m of templateSource.matchAll(/!define\s+MUI_ICON\s+(.+)/g)) checkPaths(m[1], "icon");
if (!existsSync(dirname(OUT))) mkdirSync(dirname(OUT), { recursive: true });
if (missing.length) fail(`template files missing:\n  ${missing.join("\n  ")}`);
if (!/WriteUninstaller/.test(templateSource)) {
  console.warn("make-installer: warning: template never calls WriteUninstaller -- the installer will have no uninstaller");
}

note(`template   ${TEMPLATE}`);
note(`payload    ${PAYLOAD} (${payload.files.length} files, ${payload.bytes} bytes)`);
note(`licence    ${LICENCE} (${existsSync(LICENCE) ? `${statSync(LICENCE).size} bytes` : "not referenced"})`);
note(`output     ${OUT}`);
note(`makensis   ${makensis}`);

// ---------------------------------------------------------------------------
// Payload audit -- the game's own data must not ship
// ---------------------------------------------------------------------------
// Empty on purpose.  The baseline the audit used to allow-list is no longer
// shipped: the IDE derives it from the player's own game at runtime
// (shell/mods/knowledge-build.js), and the rest of the game's data has been
// neutralised.  A release build fails while this list is non-empty.
const AUDIT_ALLOW = [];
// Product identity that is legitimate in the payload.  Blanked before matching,
// so the product's own name is not read as the game's name.
const AUDIT_IDENTITY = [
  // The product's own name, in every spelling it takes in our sources.
  "OsanaKami IDE Studio", "OsanaKamiIDEStudio", "osanakami-ide-studio",
  "com.osanakami.idestudio",
  // Internal identifiers that still say "infantgod" on purpose: the kernel's file
  // name, the workspace state directory and the protocol name are not user-facing
  // text, and renaming them would desynchronise the shipped kernel binary.
  "infantgod.exe", "InfantGod.exe", ".infantgod", "infantgod",
];
// Electron/Chromium runtime and notices: not our content, and 20 MB of English
// prose whose ordinary words ("Company", "Nerd") are also character names.
const AUDIT_THIRD_PARTY = [/^LICENSE\.electron\.txt$/, /^LICENSES\.chromium\.html$/, /(^|\/)locales\//];
const AUDIT_BINARY = new Set([
  ".exe", ".dll", ".node", ".pak", ".bin", ".dat", ".asar", ".ico", ".png",
  ".jpg", ".jpeg", ".gif", ".webp", ".woff", ".woff2", ".ttf", ".zip", ".7z", ".pdf",
]);

function* auditWalk(dir, base) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const rel = base ? `${base}/${entry.name}` : entry.name;
    if (entry.isDirectory()) yield* auditWalk(join(dir, entry.name), rel);
    else if (entry.isFile()) yield { rel, file: join(dir, entry.name) };
  }
}

// app.asar is our own packed sources, not an opaque blob.  Its layout, as
// electron-builder writes it: uint32(4), uint32(headerSize), uint32(headerSize),
// uint32(jsonLength), the JSON tree, then padding, then the file data.  Reading
// the entries lets a hit inside the packed app be reported with its own name
// instead of being waved through as "binary".
function asarEntries(buffer) {
  if (buffer.length < 20 || buffer.readUInt32LE(0) !== 4) return null;
  const headerSize = buffer.readUInt32LE(4);
  const jsonLength = buffer.readUInt32LE(12);
  if (headerSize <= 0 || headerSize > buffer.length || jsonLength <= 0 || jsonLength > buffer.length - 16) return null;
  const header = JSON.parse(buffer.subarray(16, 16 + jsonLength).toString("utf8"));
  const dataOffset = 8 + headerSize;
  const out = [];
  const walk = (node, base) => {
    for (const [name, entry] of Object.entries(node.files || {})) {
      const rel = base ? `${base}/${name}` : name;
      if (entry.files) walk(entry, rel);
      else if (entry.offset !== undefined && entry.size !== undefined) {
        const start = dataOffset + Number(entry.offset);
        out.push({ rel, buffer: buffer.subarray(start, start + Number(entry.size)) });
      }
    }
  };
  walk(header, "");
  return out;
}

// Our sources are UTF-8 (some carry a BOM); a few legacy data files are GBK.
// Decode as UTF-8 when that is lossless so `幼神` can match, and fall back to a
// byte-preserving latin1 read so the ASCII markers still work on GBK files.
function decodeText(buffer) {
  const utf8 = buffer.toString("utf8");
  return utf8.includes("\uFFFD") ? buffer.toString("latin1") : utf8;
}

// What the audit found, for the build summary.  A release is only release-ready
// when this says the audit ran, found nothing, and there was no allow-list.
let auditResult = null;

function auditPayload() {
  if (args.audit === false) {
    // Only reachable with --dev: the caller asked not to look.  Say so in the
    // summary, because a build whose audit did not run is not a release (G30).
    auditResult = { ran: false, clean: false, reason: "--no-audit (dev build)" };
    console.warn("make-installer: WARNING: payload audit skipped (--dev --no-audit): this build is not release-ready");
    return;
  }
  const allow = new Map(AUDIT_ALLOW);
  // Character names come from the payload itself, so the audit tracks the data.
  const knowledgePath = join(PAYLOAD, "resources", "shell", "mods", "knowledge.json");
  let names = [];
  if (existsSync(knowledgePath)) {
    try {
      const knowledge = JSON.parse(readFileSync(knowledgePath, "utf8"));
      names = (knowledge.localization?.characters || []).map((c) => c.name).filter(Boolean);
    } catch (error) {
      fail(`payload audit: cannot read character names from ${knowledgePath}: ${error.message}`);
    }
  }
  const quoted = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  // Case-sensitive on purpose: the cast list is full of ordinary English words
  // (Runner, News, Cop, Nobody, Company), and shell code uses `runner` and
  // `news` as identifiers.  A trailing lowercase identifier is not game data; a
  // capitalised name in a string literal is.
  const boundary = (alternatives) =>
    new RegExp(`(?<![A-Za-z0-9_$])(${alternatives.map(quoted).join("|")})(?![A-Za-z0-9_$])`, "g");
  const characterRx = boundary([...new Set(["Aistalt", "MaoGirl", ...names])]);
  const rules = [
    [characterRx, "game character name"],
    [boundary(["InfantGod"]), "game name"],
    [/幼神/g, "game name"],
    // A path that only exists on one machine, in either shape a document may
    // spell it.  The user segment is captured and judged in code, not excluded
    // by a lookahead: a lookahead hides the separator, and then backtracking
    // lets "C:\Users\you" match as "C:\Users\" plus a leftover backslash --
    // which is exactly the false positive this rule produced the first time.
    [/[A-Za-z]:[\\/]+Users[\\/]+([A-Za-z0-9._$@-]+)/gi, "absolute developer path", 1],
    [/(?:^|[^A-Za-z0-9_.-])\/(?:home|Users)\/([A-Za-z0-9._-]+)/g, "absolute developer path", 1],
    // A UNC share has a host, and a JSON-escaped Windows path has no dotted
    // segment of that shape; requiring the dot keeps the rule from reading
    // document text as a network path.
    [/\\\\{1,2}(?:[A-Za-z0-9-]+\.)+[A-Za-z]{2,}\\[A-Za-z0-9._$-]+/g, "network share path"],
  ];
  //: Stand-in user names: a document may show a path's shape without naming a
  //: machine, and `tools/path_guard.py` allows the same set.
  const PLACEHOLDER_USERS = new Set(["you", "your-user", "your_user", "<user>", "<you>", "user", "%username%", "…"]);

  const allowed = [];
  const violations = [];
  let scanned = 0;
  let scannedBytes = 0;
  let asarScanned = 0;
  let skippedThirdParty = 0;
  let skippedBinary = 0;

  const scanOne = (rel, text) => {
    const masked = AUDIT_IDENTITY.reduce((t, s) => t.split(s).join(" ".repeat(s.length)), text);
    const lineOf = (index) => text.slice(0, index).split("\n").length;
    const found = [];
    for (const [rx, kind, userGroup] of rules) {
      for (const match of masked.matchAll(rx)) {
        if (userGroup !== undefined && PLACEHOLDER_USERS.has((match[userGroup] || "").toLowerCase())) continue;
        found.push({ kind, marker: match[0], line: lineOf(match.index) });
      }
    }
    if (found.length) (allow.has(rel) ? allowed : violations).push({ rel, found });
  };

  for (const { rel, file } of auditWalk(PAYLOAD, "")) {
    if (AUDIT_THIRD_PARTY.some((rx) => rx.test(rel))) { skippedThirdParty += 1; continue; }
    const dot = rel.lastIndexOf(".");
    const ext = dot < 0 ? "" : rel.slice(dot).toLowerCase();
    const size = statSync(file).size;
    if (size > 64 * 1024 * 1024) { skippedBinary += 1; continue; }

    if (ext === ".asar") {
      const buffer = readFileSync(file);
      let entries = null;
      try { entries = asarEntries(buffer); } catch { entries = null; }
      if (!entries) { skippedBinary += 1; continue; }
      scanned += 1;
      scannedBytes += size;
      for (const entry of entries) {
        const entryDot = entry.rel.lastIndexOf(".");
        if (entryDot >= 0 && AUDIT_BINARY.has(entry.rel.slice(entryDot).toLowerCase())) continue;
        asarScanned += 1;
        scanOne(`${rel}:${entry.rel}`, decodeText(entry.buffer));
      }
      continue;
    }

    if (dot < 0 || AUDIT_BINARY.has(ext)) { skippedBinary += 1; continue; }
    scanned += 1;
    scannedBytes += size;
    scanOne(rel, decodeText(readFileSync(file)));
  }

  note(`audit      ${scanned} text file(s) / ${asarScanned} packed app entry(ies), ${scannedBytes} bytes scanned; ${skippedBinary} non-text file(s) and ${skippedThirdParty} third-party notice/runtime file(s) not scanned`);
  if (AUDIT_ALLOW.length === 0) {
    note("audit      allow-list is empty: every name in the payload is either ours or neutral");
  } else {
    note(`audit      allow-list (${AUDIT_ALLOW.length} entries):`);
    for (const [rel, why] of AUDIT_ALLOW) note(`audit        ${rel} -- ${why}`);
  }
  if (allowed.length) {
    const hits = allowed.reduce((sum, entry) => sum + entry.found.length, 0);
    note(`audit      allow-listed hits: ${hits} in ${allowed.length} file(s)`);
    for (const entry of allowed) {
      note(`audit        ${entry.rel}: ${entry.found.slice(0, 12).map((f) => `${f.marker}@${f.line}`).join(", ")}${entry.found.length > 12 ? ", ..." : ""}`);
    }
  }
  const total = violations.reduce((sum, entry) => sum + entry.found.length, 0);
  const allowedHits = allowed.reduce((sum, entry) => sum + entry.found.length, 0);
  auditResult = {
    ran: true,
    clean: total === 0,
    hits: total,
    files: violations.length,
    allowList: AUDIT_ALLOW.length,
    allowListHits: allowedHits,
    scanned,
  };
  if (total) {
    const lines = violations.map((entry) =>
      `${entry.rel}: ${entry.found.length} hit(s) -- ${entry.found.slice(0, 12).map((f) => `${f.marker}@${f.line}`).join(", ")}${entry.found.length > 12 ? ", ..." : ""}`);
    if (args.audit) {
      fail(`payload audit found ${total} hit(s) in ${violations.length} file(s) outside the allow-list:\n  ${lines.join("\n  ")}\n  allow-list: ${AUDIT_ALLOW.map((entry) => entry[0]).join(", ")}`);
    }
    console.warn(`make-installer: WARNING: payload audit found ${total} hit(s) in ${violations.length} file(s) outside the allow-list, compiling anyway (--dev --no-audit):\n  ${lines.join("\n  ")}`);
  } else {
    note("audit      clean: no game data or developer path outside the allow-list");
  }
  if (args.auditOnly) {
    note("audit      --audit-only: stopping before the compile");
    process.exit(total === 0 ? 0 : 1);
  }
  // A release has no allow-list at all: the entries are the game's own data,
  // and `--dev` is the only way to ship a build that still names them (G30).
  if (!args.dev && AUDIT_ALLOW.length > 0) {
    fail(`the payload audit's allow-list still has ${AUDIT_ALLOW.length} entry(ies):\n`
      + `  ${AUDIT_ALLOW.map((entry) => entry[0]).join("\n  ")}\n`
      + "  A release build must carry none of the game's data (G30); pass --dev for a development build.");
  }
}

auditPayload();

// ---------------------------------------------------------------------------
// Compile
// ---------------------------------------------------------------------------
if (!existsSync(BUILD)) mkdirSync(BUILD, { recursive: true });
const logPath = join(BUILD, "make-installer.log");
const makensisArgs = ["/V3"];
for (const [key, value] of Object.entries(DEFINES)) makensisArgs.push(`-D${key}=${value}`);
if (args.lzma) makensisArgs.push("-DLZMA=1");
makensisArgs.push(TEMPLATE);

note(`compiling  makensis ${makensisArgs.filter((a) => a.startsWith("-D")).join(" ")} ${TEMPLATE}`);
const startedAt = Date.now();
const code = await new Promise((done) => {
  const fd = openSync(logPath, "w");
  const child = spawn(makensis, makensisArgs, { cwd: REPO, stdio: ["ignore", fd, fd] });
  child.on("error", (err) => {
    closeSync(fd);
    fail(`could not run makensis: ${err.message}`);
  });
  child.on("exit", (exitCode) => {
    closeSync(fd);
    done(exitCode);
  });
});

const log = readFileSync(logPath, "utf8");
const logLines = log.split(/\r?\n/);
const statLines = logLines.filter((l) => /^\s*(Install|Uninstall):\s/.test(l));
for (const line of statLines) note(`stats      ${line.trim()}`);
// makensis summarises warnings as "N warning(s):" followed by indented detail
// lines; keep the whole block so a broken template is diagnosable without
// opening the log file.
const warnAt = logLines.findIndex((l) => /^\s*\d+\s+warnings?:\s*$/i.test(l));
if (warnAt >= 0) {
  const details = [];
  for (let i = warnAt + 1; i < logLines.length && /^\s+\S/.test(logLines[i]); i += 1) details.push(logLines[i].trim());
  console.warn(`make-installer: warning: makensis reported ${details.length} warning(s)${details.length ? `:\n  ${details.join("\n  ")}` : ""}`);
}

if (code !== 0) {
  const tail = log.split(/\r?\n/).filter(Boolean).slice(-25).join("\n");
  console.error(tail);
  fail(`makensis exited ${code} (full log: ${logPath})`);
}
if (!existsSync(OUT)) fail(`makensis exited 0 but ${OUT} does not exist (log: ${logPath})`);
// A stale artefact from an earlier build must never be mistaken for this one.
if (statSync(OUT).mtimeMs < startedAt - 1000) fail(`${OUT} was not written by this build (stale file)`);

let outBytes = statSync(OUT).size;
const floor = Math.max(64 * 1024, Math.floor(payload.bytes * 0.25));
if (outBytes < floor) fail(`installer is only ${outBytes} bytes (expected at least ${floor}) -- payload did not make it in`);
note(`built      ${OUT} (${outBytes} bytes)`);

const sha256 = (file) => createHash("sha256").update(readFileSync(file)).digest("hex");
let digest = sha256(OUT);
note(`sha256     ${digest}`);

// ---------------------------------------------------------------------------
// Sign
// ---------------------------------------------------------------------------
const IDENTITY = join(process.env.USERPROFILE || homedir(), ".infantgod");
let signature = "NotSigned";
let signerThumbprint = null;

async function run(exe, argv, { quiet = false, env = null } = {}) {
  return new Promise((done) => {
    const child = spawn(exe, argv, {
      cwd: REPO,
      stdio: quiet ? ["ignore", "pipe", "pipe"] : "inherit",
      env: env ? { ...process.env, ...env } : process.env,
    });
    let out = "";
    if (quiet) {
      child.stdout?.on("data", (d) => { out += d; });
      child.stderr?.on("data", (d) => { out += d; });
    }
    child.on("error", (err) => done({ code: -1, out: `${out}\n${err.message}` }));
    child.on("exit", (exitCode) => done({ code: exitCode, out }));
  });
}

function powershell() {
  for (const exe of ["pwsh.exe", "pwsh", "powershell.exe"]) {
    const onPath = (process.env.PATH || "").split(";").some((d) => d && existsSync(join(d, exe)));
    if (onPath) return exe;
  }
  return "powershell.exe";
}

if (args.sign) {
  const signtool = findSigntool();
  if (!signtool) fail("signtool.exe not found; set SIGNTOOL or pass --no-sign");
  const pfx = process.env.CSC_LINK || join(IDENTITY, "codesign.pfx");
  const pwFile = join(IDENTITY, "codesign.pw");
  const password = process.env.CSC_KEY_PASSWORD
    || (existsSync(pwFile) ? readFileSync(pwFile, "utf8").trim() : "");
  if (!password || !existsSync(pfx)) {
    fail(`no signing identity (${pfx}); run \`npm run cert\` or pass --no-sign`);
  }
  const argv = ["sign", "/f", pfx, "/p", password, "/fd", "sha256", "/td", "sha256"];
  if (args.timestamp) argv.push("/tr", process.env.TIMESTAMP_URL || "http://timestamp.digicert.com");
  argv.push(OUT);
  note(`signing    ${signtool} sign /f ${pfx} /p *** ${args.timestamp ? "/tr <timestamp> " : ""}${OUT}`);
  const signed = await run(signtool, argv);
  if (signed.code !== 0) fail(`signtool exited ${signed.code}; the installer is NOT signed`);
  digest = sha256(OUT);
  // The signature is appended to the file: the size on disk is no longer the size
  // makensis wrote, so measure it again rather than reporting the pre-signature one.
  outBytes = statSync(OUT).size;
  note(`signed     sha256 ${digest} (${outBytes} bytes)`);

  if (args.verifySign !== false) {
    const ps = `$s = Get-AuthenticodeSignature -LiteralPath $env:MI_FILE; `
      + `[pscustomobject]@{ Status = $s.Status.ToString(); Subject = $s.SignerCertificate.Subject; Thumbprint = $s.SignerCertificate.Thumbprint } | ConvertTo-Json -Compress`;
    const verified = await run(powershell(), ["-NoProfile", "-NonInteractive", "-Command", ps], { quiet: true, env: { MI_FILE: OUT } });
    const json = (verified.out.match(/\{.*\}/) || [""])[0];
    if (!json) fail(`could not read the signature back: ${verified.out.trim()}`);
    const info = JSON.parse(json);
    signature = `${info.Status} / ${info.Subject}`;
    signerThumbprint = info.Thumbprint || null;
    note(`signature  ${signature} (thumbprint ${signerThumbprint})`);
    if (info.Status !== "Valid") fail(`signature status is ${info.Status}, expected Valid`);
  }
}

const summary = {
  installer: OUT,
  bytes: outBytes,
  sha256: digest,
  signature,
  signerThumbprint,
  payload: { dir: PAYLOAD, files: payload.files.length, bytes: payload.bytes },
  manifest: { files: manifestFiles.length, directories: manifestDirs.length },
  stats: statLines.map((l) => l.trim()),
  makensis,
  template: TEMPLATE,
  defines: DEFINES,
  compression: args.lzma ? "lzma" : "zlib",
  signed: args.sign,
  // The build's own account of whether it may be handed to a stranger: a release
  // ran the audit, found nothing, and had no allow-list left (G30).
  dev: args.dev === true,
  audit: auditResult,
  releaseReady: auditResult !== null
    && auditResult.ran === true
    && auditResult.clean === true
    && AUDIT_ALLOW.length === 0,
};
writeFileSync(join(BUILD, "make-installer.json"), `${JSON.stringify(summary, null, 2)}\n`);
note(`done       ${OUT}`);
