/* ------------------------------------------------------------------ */
/* Whether the kernel will read a path this window is about to open
/* ------------------------------------------------------------------ */

/**
 * A path is absolute when it starts with a drive (`C:`) or a slash.
 *
 * Callers hand `openFile` either spelling and may use either separator; the
 * kernel takes both.  A UNC share (`\\server\share`) arrives as `//server/...`
 * once separators are folded and is absolute for the same reason.
 */
export function isAbsolutePath(path) {
  const clean = String(path == null ? "" : path).replace(/\\/g, "/");
  return /^[A-Za-z]:\//.test(clean) || clean.startsWith("/");
}

/**
 * Whether the kernel will read `path`, given the workspace root it reports.
 *
 * A relative name is inside by construction: the kernel resolves it against its
 * own workspace, which is the only place a relative name can land.  An absolute
 * path has to sit under the reported root.  When no root is known yet (the boot
 * `workspace.info` reply has not arrived), a relative name is still left to the
 * kernel and an absolute one is outside.
 *
 * Deliberately a sentence about reading, not about canonicalising: this window
 * keeps the caller's form -- a diagnostic row's absolute path is the proof that
 * the row used the package root `mod.validate` answered (G51) -- so the check
 * compares the string it was given against the root the shell reports.
 */
export function isInsideWorkspace(path, workspaceRoot) {
  const clean = String(path == null ? "" : path).replace(/\\/g, "/");
  if (!isAbsolutePath(clean)) {
    return true;
  }
  const root = String(workspaceRoot == null ? "" : workspaceRoot)
    .replace(/\\/g, "/")
    .replace(/\/+$/, "");
  if (root === "") {
    return false;
  }
  const folded = clean.replace(/\/+$/, "").toLowerCase();
  const foldedRoot = root.toLowerCase();
  return folded === foldedRoot || folded.startsWith(`${foldedRoot}/`);
}
