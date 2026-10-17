/*
 * The demo packages the install ships beside the editor (`examples/Mods`).
 *
 * Why this module exists at all: the mod layer only ever opens a directory
 * under `modsRoot` (`resolveArg` refuses everything else, deliberately -- a card
 * must not be able to reach into the filesystem by its `dir` field).  A package
 * that ships with the application is therefore *outside* everything the editor
 * can open.  The fix is not to widen `mod.open`; it is to copy the demo into the
 * mods folder first, which is also what the user wants: a package they can read,
 * edit and break without it being reinstalled under them.
 *
 * Nothing here writes unless `installExample` is called, and that never
 * overwrites: a target that already holds something is refused by name (or
 * reported as already installed when it *is* the demo), because silently
 * replacing a package someone edited is the one outcome worse than a refusal.
 *
 * CommonJS, node:fs/node:path only, like its siblings.
 */

"use strict";

const fs = require("fs");
const path = require("path");

/** Environment override, same spirit as `INFANTGOD_MODS_DIR`. */
const EXAMPLES_ENV = "INFANTGOD_EXAMPLES_DIR";
/** The package opened when a caller does not name one. */
const DEFAULT_EXAMPLE = "Lantern";
/** A demo package is a handful of files; anything this big is not one. */
const MAX_FILES = 500;

class ExampleError extends Error {
  constructor(message) {
    super("example: " + message);
    this.name = "ExampleError";
  }
}

/**
 * Where the bundled demo packages live.
 *
 * Three answers, in the order the rest of the mod layer uses for its own
 * discovery: an explicit option, the environment, then "beside the editor" --
 * which is `examples/Mods` both in a checkout (`<repo>/shell/mods/../..`) and in
 * an install (`<resources>/shell/mods/../..`, because `examples/` is shipped as
 * a sibling of `shell/`).  One expression, two layouts, no process argument.
 */
function examplesRoot(options = {}) {
  const explicit = options && typeof options.examplesDir === "string" ? options.examplesDir : "";
  if (explicit !== "") {
    return { root: path.resolve(explicit), source: "option" };
  }
  const fromEnv = process.env[EXAMPLES_ENV];
  if (typeof fromEnv === "string" && fromEnv !== "") {
    return { root: path.resolve(fromEnv), source: "environment" };
  }
  return {
    root: path.resolve(__dirname, "..", "..", "examples", "Mods"),
    source: "bundled",
  };
}

function isDirectory(target) {
  try {
    return fs.statSync(target).isDirectory();
  } catch {
    return false;
  }
}

/** Directories under `root` that carry a `mod.json`, in name order. */
function readPackages(root) {
  let entries = [];
  try {
    entries = fs.readdirSync(root, { withFileTypes: true });
  } catch {
    return [];
  }
  const packages = [];
  for (const entry of entries) {
    if (!entry.isDirectory() || entry.name.startsWith(".")) continue;
    const dir = path.join(root, entry.name);
    const manifest = path.join(dir, "mod.json");
    let name = entry.name;
    if (fs.existsSync(manifest)) {
      try {
        const parsed = JSON.parse(fs.readFileSync(manifest, "utf8"));
        if (parsed && typeof parsed.name === "string" && parsed.name.trim() !== "") {
          name = parsed.name.trim();
        }
      } catch {
        /* A demo with a broken manifest is still a directory worth listing: the
           editor is allowed to look at a package it cannot parse. */
      }
    }
    packages.push({ name, dir: entry.name, hasManifest: fs.existsSync(manifest) });
  }
  packages.sort((a, b) => (a.dir < b.dir ? -1 : a.dir > b.dir ? 1 : 0));
  return packages;
}

/**
 * What the editor can offer: every demo package beside it, and whether there are
 * any.  Never throws -- "this build has no examples" is a state, not an error,
 * exactly like a missing knowledge base.
 */
function listExamples(options = {}) {
  const { root, source } = examplesRoot(options);
  const packages = readPackages(root);
  return {
    root,
    source,
    present: packages.length > 0,
    packages,
    /** The one `mod.example` installs when no name is given. */
    default: packages.length === 0 ? null : (packages.find((one) => one.dir === DEFAULT_EXAMPLE) ?? packages[0]).dir,
  };
}

/** Count the regular files under `dir`; a symlink is refused rather than copied. */
function collect(dir, out, depth = 0) {
  if (depth > 12) {
    throw new ExampleError("the package is nested more than 12 directories deep: " + dir);
  }
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isSymbolicLink()) {
      throw new ExampleError("the demo package links to another file (" + full + "); a copy would escape it");
    }
    if (entry.isDirectory()) {
      collect(full, out, depth + 1);
    } else if (entry.isFile()) {
      out.push(full);
      if (out.length > MAX_FILES) {
        throw new ExampleError("the demo package holds more than " + MAX_FILES + " files");
      }
    }
  }
}

/** Copy `from` to `to`, byte for byte, creating the parent directories. */
function copyTree(from, to, files) {
  fs.mkdirSync(to, { recursive: true });
  for (const file of files) {
    const rel = path.relative(from, file);
    const target = path.join(to, rel);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.copyFileSync(file, target);
  }
}

/** Does `dir` already hold anything a user would miss if it were replaced? */
function holdsSomething(dir) {
  try {
    return fs.readdirSync(dir).length > 0;
  } catch {
    return false;
  }
}

/**
 * Copy one demo package into `modsRoot` and answer where it landed.
 *
 * Idempotent: asking twice is not an error, it is "already installed" -- the
 * second answer says `installed: false` and copies nothing.  A *different*
 * package already sitting at the target name is refused, because the only
 * alternatives are "overwrite someone's work" and "pretend it was installed".
 */
function installExample({ examplesRoot: root, modsRoot, name } = {}) {
  const targetRoot = typeof modsRoot === "string" && modsRoot !== ""
    ? path.resolve(modsRoot)
    : "";
  if (targetRoot === "") {
    throw new ExampleError("there is no mods folder to install into (start the shell with --mods-root)");
  }
  const listing = listExamples({ examplesDir: typeof root === "string" ? root : undefined });
  if (!listing.present) {
    throw new ExampleError(
      "no demo package is installed beside the editor (looked in " + listing.root + ")",
    );
  }
  const wanted = typeof name === "string" && name.trim() !== ""
    ? name.trim()
    : (listing.default ?? "");
  const picked = listing.packages.find((one) => one.dir === wanted || one.name === wanted);
  if (picked === undefined) {
    const have = listing.packages.map((one) => one.dir).join(", ");
    throw new ExampleError('no demo package named "' + wanted + '" (have: ' + have + ')');
  }

  const source = path.join(listing.root, picked.dir);
  const target = path.join(targetRoot, picked.dir);
  const manifestAtTarget = path.join(target, "mod.json");
  if (holdsSomething(target)) {
    let already = false;
    try {
      const parsed = JSON.parse(fs.readFileSync(manifestAtTarget, "utf8"));
      already = Boolean(parsed) && typeof parsed.name === "string";
    } catch {
      already = false;
    }
    if (already) {
      return {
        installed: false,
        name: picked.dir,
        dir: picked.dir,
        modRoot: target,
        file: manifestAtTarget,
        files: 0,
        source,
        message: "the demo package is already in the mods folder",
      };
    }
    throw new ExampleError(
      target + " already holds files and is not the demo package; move it away first",
    );
  }

  const files = [];
  collect(source, files);
  copyTree(source, target, files);
  return {
    installed: true,
    name: picked.dir,
    dir: picked.dir,
    modRoot: target,
    file: manifestAtTarget,
    files: files.length,
    source,
    message: "the demo package was copied into the mods folder",
  };
}

module.exports = {
  EXAMPLE_ENV_NAME: EXAMPLES_ENV,
  DEFAULT_EXAMPLE,
  ExampleError,
  examplesRoot,
  listExamples,
  installExample,
};
