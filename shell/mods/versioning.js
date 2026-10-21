'use strict';
/*
 * The package history, kept by `iaqs` (this project's fork under `iaqs/`).
 *
 * Where it lives: the editor's own installation folder, not the package.  A mod
 * package is shared, exported and installed into the game; its history belongs
 * to the editor on this machine.  `<install>/history/<slug>-<hash of the package
 * path>` is one store, so moving the package on disk starts a new history rather
 * than merging two authors' timelines.
 *
 * Every function here answers with a result object instead of throwing: the
 * binary may be missing (a build without `tools/build-iaqs.ps1`, a stripped
 * payload), in which case history is a state the UI reports, not a crash.
 */

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const childProcess = require('child_process');

const STORE_DIR = 'history';
const META_NAME = 'package.txt';
const BINARY_NAMES = ['iaqs.exe', path.join('build-iaqs', 'iaqs.exe'), path.join('iaqs', 'iaqs.exe')];
const DEFAULT_TIMEOUT_MS = 20000;

function normalizePath(dir) {
  const resolved = path.resolve(String(dir));
  const slashed = resolved.replace(/\\/g, '/');
  return process.platform === 'win32' ? slashed.toLowerCase() : slashed;
}

/** Stable folder name for one package path: readable slug plus a short hash. */
function storeName(dir) {
  const hash = crypto.createHash('sha256').update(normalizePath(dir)).digest('hex').slice(0, 12);
  const base = path.basename(path.resolve(String(dir))).replace(/[^A-Za-z0-9._-]+/g, '-').replace(/^-+|-+$/g, '');
  return (base || 'package') + '-' + hash;
}

function parsePorcelain(text) {
  const entries = [];
  for (const raw of String(text || '').split(/\r?\n/)) {
    if (raw.length < 4) continue;
    const state = raw.slice(0, 2);
    const file = raw.slice(3);
    if (!file) continue;
    entries.push({ state, path: file.replace(/\\/g, '/') });
  }
  return entries;
}

function parseLog(text) {
  const commits = [];
  for (const raw of String(text || '').split(/\r?\n/)) {
    const m = /^([0-9a-f]{6,40})\s+(.*)$/.exec(raw.trim());
    if (m) commits.push({ oid: m[1], message: m[2] });
  }
  return commits;
}

/**
 * @param {object} [options]
 * @param {string} options.installDir   the editor's install/repository root; the store root is `<this>/history`
 * @param {string} [options.exePath]    explicit iaqs.exe (tests, unusual installs)
 * @param {object} [options.env]        environment table (tests); `INFANTGOD_IAQS` overrides the binary
 * @param {function} [options.spawn]    child_process.spawnSync-shaped hook (tests)
 */
function createHistory(options) {
  const opts = options && typeof options === 'object' ? options : {};
  const env = opts.env && typeof opts.env === 'object' ? opts.env : process.env;
  const installDir = path.resolve(String(opts.installDir || env.INFANTGOD_INSTALL_DIR || process.cwd()));
  const spawn = typeof opts.spawn === 'function' ? opts.spawn : childProcess.spawnSync;
  let cachedExe;

  function root() {
    return path.join(installDir, STORE_DIR);
  }

  function exe() {
    if (cachedExe !== undefined) return cachedExe;
    const explicit = opts.exePath || env.INFANTGOD_IAQS;
    if (explicit) {
      cachedExe = fs.existsSync(explicit) ? path.resolve(explicit) : null;
      return cachedExe;
    }
    for (const name of BINARY_NAMES) {
      const candidate = path.join(installDir, name);
      if (fs.existsSync(candidate)) { cachedExe = candidate; return cachedExe; }
    }
    cachedExe = null;
    return cachedExe;
  }

  function available() {
    return exe() !== null;
  }

  function storeFor(dir) {
    return path.join(root(), storeName(dir));
  }

  function metaFor(dir) {
    return path.join(storeFor(dir), META_NAME);
  }

  function known(dir) {
    return fs.existsSync(metaFor(dir));
  }

  function run(dir, args, runOptions) {
    const bin = exe();
    if (!bin) return { ok: false, reason: 'unavailable', stdout: '', stderr: '' };
    // The store (database, objects, WAL) lives in the editor's history folder;
    // the files being versioned are the package, which must stay untouched.  The
    // fork's --worktree carries that split.
    const result = spawn(bin, ['--repo', storeFor(dir), '--worktree', path.resolve(String(dir))].concat(args), {
      windowsHide: true,
      encoding: 'utf8',
      timeout: (runOptions && runOptions.timeoutMs) || DEFAULT_TIMEOUT_MS,
      env: Object.assign({}, env)
    });
    const stdout = result && typeof result.stdout === 'string' ? result.stdout : '';
    const stderr = result && typeof result.stderr === 'string' ? result.stderr : '';
    const status = result && typeof result.status === 'number' ? result.status : null;
    return {
      ok: status === 0,
      status,
      code: result && result.error ? String(result.error.code || result.error.message) : null,
      stdout,
      stderr,
      error: (result && result.error && result.error.message) || (status === 0 ? null : stderr.trim() || `iaqs exited ${status}`)
    };
  }

  /**
   * Make sure the package has a store, creating one on first sight.  Idempotent:
   * a store that already exists is left untouched.
   */
  function ensure(dir) {
    if (!available()) return { ok: false, reason: 'unavailable', store: storeFor(dir) };
    const store = storeFor(dir);
    try {
      fs.mkdirSync(root(), { recursive: true });
    } catch (error) {
      return { ok: false, reason: 'mkdir-failed', store, error: error.message };
    }
    if (known(dir)) return { ok: true, store, created: false };
    const created = run(dir, ['init', store]);
    if (!created.ok) return { ok: false, reason: 'init-failed', store, error: created.error };
    try {
      fs.writeFileSync(metaFor(dir), normalizePath(dir) + '\n', 'utf8');
    } catch (error) {
      return { ok: false, reason: 'meta-failed', store, error: error.message };
    }
    return { ok: true, store, created: true };
  }

  function status(dir) {
    const ensured = ensure(dir);
    if (!ensured.ok) return Object.assign({}, ensured, { entries: [] });
    const answer = run(dir, ['status', '--porcelain']);
    return {
      ok: answer.ok,
      store: ensured.store,
      created: ensured.created,
      entries: answer.ok ? parsePorcelain(answer.stdout) : [],
      error: answer.error
    };
  }

  /**
   * Commit every change in the package as one version.  Nothing changed is a
   * normal answer, not an empty commit.
   */
  function save(dir, message) {
    const label = typeof message === 'string' && message.trim() !== '' ? message.trim() : 'save';
    const state = status(dir);
    if (!state.ok) return state;
    if (state.entries.length === 0) {
      return { ok: true, store: state.store, committed: false, reason: 'clean', entries: [] };
    }
    const staged = run(dir, ['add', '-A']);
    if (!staged.ok) return { ok: false, store: state.store, committed: false, error: staged.error };
    const committed = run(dir, ['commit', '-m', label]);
    if (!committed.ok) return { ok: false, store: state.store, committed: false, error: committed.error };
    const m = /Committed\s+([0-9a-f]{6,40})/.exec(committed.stdout);
    return {
      ok: true,
      store: state.store,
      committed: true,
      oid: m ? m[1] : null,
      message: label,
      entries: state.entries
    };
  }

  function log(dir, limit) {
    const ensured = ensure(dir);
    if (!ensured.ok) return Object.assign({}, ensured, { commits: [] });
    const wanted = Number.isInteger(limit) ? limit : Number.parseInt(String(limit ?? ''), 10);
    const count = Number.isInteger(wanted) && wanted > 0 ? wanted : 30;
    const answer = run(dir, ['log', '--oneline', '-n', String(count)]);
    return {
      ok: answer.ok,
      store: ensured.store,
      commits: answer.ok ? parseLog(answer.stdout) : [],
      error: answer.error
    };
  }

  /** Restore the committed bytes: `all` restores every tracked path. */
  function restore(dir, restoreOptions) {
    const ro = restoreOptions && typeof restoreOptions === 'object' ? restoreOptions : {};
    const ensured = ensure(dir);
    if (!ensured.ok) return ensured;
    const paths = Array.isArray(ro.paths) ? ro.paths.filter((p) => typeof p === 'string' && p !== '') : [];
    const args = ['restore'];
    if (!ro.all && paths.length > 0) args.push(...paths);
    else args.push('--all');
    const answer = run(dir, args);
    return { ok: answer.ok, store: ensured.store, paths, error: answer.error };
  }

  return { root, exe, available, storeFor, metaFor, known, ensure, status, save, log, restore, run };
}

module.exports = { createHistory, storeName, normalizePath, parsePorcelain, parseLog, STORE_DIR };
