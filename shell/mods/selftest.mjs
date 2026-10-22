#!/usr/bin/env node
/**
 * selftest.mjs -- proves the 幼神 mod layer works with no kernel, no browser
 * and no network.  Run it after editing the facade, the knowledge base or any
 * ported core module.
 *
 *     node shell/mods/selftest.mjs [--mods DIR]
 *
 * `--mods` points at the game's extracted `Mods` folder.  Without it the folder is
 * discovered (INFANTGOD_MODS_DIR / INFANTGOD_GAME_DIR, the Steam libraries, the
 * user's home, the checkout's parent) -- this file never names a path on the
 * machine it happens to run on.  The corpus checks are skipped, not failed, when no
 * folder is found, and the knowledge-base groups are skipped when the checkout has
 * no `shell/mods/knowledge.json` (`knowledge.json` is derived from the player's own
 * game and is not tracked; `.gitignore`, docs/EDITOR_GAPS.md §14.1 G26).  The
 * layer must stay testable on a clean clone and on a machine that only has one of
 * the two.
 *
 * One section is the exception to "no kernel, no network": the File menu's
 * "新建模组…" exists only to send one `mod.scaffold` frame to a live shell
 * endpoint, so the last check spawns `node shell/main.mjs serve` on loopback
 * and creates a real mod.  It skips when there is no kernel binary to spawn.
 *
 * Exits 0 on success, 1 on the first failure.
 */

import { failures, checks, skipped, section, skip, SHIPPED_KNOWLEDGE } from "./selftest/foundation.mjs";

/*
 * One group at a time, awaited: each group adds its checks as it is evaluated,
 * so awaiting keeps the straight line one script had.  Static side-effect
 * imports do not: every group's top-level awaits would start under one
 * evaluation and a group could overlap the next one's spawned server.
 *
 * The groups after the foundation all read the schemas the rich knowledge base
 * carries.  A clean clone has no `shell/mods/knowledge.json` (it is derived
 * from the player's game and gitignored), and then they are skipped with a
 * named line instead of failing against the empty knowledge base.  The
 * foundation itself stays: the template shape and the text cap are not
 * knowledge-base facts.
 */
const GROUPS = [
  "corpus", "spec", "traps", "scaffold-cross", "dispatch", "examples-menu",
  "knowledge-state", "knowledge-facts", "language", "newfile", "importfile",
  "export", "importzip", "history", "cli", "game", "demos",
];

await import("./selftest/foundation.mjs");

if (SHIPPED_KNOWLEDGE) {
  for (const group of GROUPS) await import(`./selftest/${group}.mjs`);
} else {
  for (const group of GROUPS) skip(`${group} (no shipped knowledge base)`);
}

/* ------------------------------------------------------------------ */

section("results");

const total = checks;
console.log(`\n${total - failures}/${total} checks passed${skipped ? ` (${skipped} skipped)` : ""}`);
console.log(`ok ${total - failures}/${total}${skipped ? ` (${skipped} skipped)` : ""}`);
if (failures > 0) {
  console.log(`mods: FAIL (${failures})`);
  process.exit(1);
}
console.log("mods: ok");
