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
 * folder is found: the layer must stay useful on a machine that only has the
 * knowledge base.
 *
 * One section is the exception to "no kernel, no network": the File menu's
 * "新建模组…" exists only to send one `mod.scaffold` frame to a live shell
 * endpoint, so the last check spawns `node shell/main.mjs serve` on loopback
 * and creates a real mod.  It skips when there is no kernel binary to spawn.
 *
 * Exits 0 on success, 1 on the first failure.
 */

import { failures, checks, skipped, section } from "./selftest/foundation.mjs";

/*
 * One group at a time, awaited: each group adds its checks as it is evaluated,
 * so awaiting keeps the straight line one script had.  Static side-effect
 * imports do not: every group's top-level awaits would start under one
 * evaluation and a group could overlap the next one's spawned server.
 */
await import("./selftest/foundation.mjs");
await import("./selftest/corpus.mjs");
await import("./selftest/spec.mjs");
await import("./selftest/traps.mjs");
await import("./selftest/scaffold-cross.mjs");
await import("./selftest/dispatch.mjs");
await import("./selftest/examples-menu.mjs");
await import("./selftest/knowledge-state.mjs");
await import("./selftest/knowledge-facts.mjs");
await import("./selftest/language.mjs");
await import("./selftest/newfile.mjs");
await import("./selftest/importfile.mjs");
await import("./selftest/export.mjs");
await import("./selftest/importzip.mjs");
await import("./selftest/cli.mjs");
await import("./selftest/game.mjs");
await import("./selftest/demos.mjs");

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
