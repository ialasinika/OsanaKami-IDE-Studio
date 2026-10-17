/**
 * selftest.mjs -- the shell's proof, runnable with no browser and no kernel.
 *
 *     node shell/web/selftest.mjs
 *
 * It imports the pure parts of the web shell and drives them with a fake
 * `fetch` (an in-memory SSE stream) and no DOM at all, so the protocol
 * plumbing, the board model, the undo ring and the token-span logic are checked
 * exactly as the browser will use them.
 *
 * What that means: there is no browser here. The tiles' pixels, pointer
 * handling, focus, keyboard handling and every CSS rule are never exercised.
 * One check calls `renderCard` against a stub element that records structure
 * and nothing else, purely to prove that a malformed board entry produces a
 * placeholder instead of an exception; one more builds the whole shell against
 * an element stub and types at the real `mode` switch, because refusing a view
 * that no longer exists is a promise made in `createApp`, not in the registry.
 * The `note:` line at the end of every run says the same thing, so a green run
 * is never read as "the browser was tested".
 *
 * Exit code is 0 only when every check passes; the summary is `ok N/N`.
 */

import { stats } from "./selftest/harness.mjs";

/*
 * One section at a time, awaited: a section adds its checks as it is evaluated,
 * so awaiting keeps the straight line a single script had.  A plain list of
 * static side-effect imports does not: every section's top-level awaits start
 * under one evaluation, and a section still waiting on its stub can overlap the
 * next section's tests -- a stale `document` then reaches a frame the shell
 * queued, and the run dies inside a timer instead of a check.
 */
await import("./selftest/rpc.mjs");
await import("./selftest/board.mjs");
await import("./selftest/cards.mjs");
await import("./selftest/project.mjs");
await import("./selftest/http.mjs");
await import("./selftest/sheet.mjs");
await import("./selftest/main.mjs");
await import("./selftest/views.mjs");
await import("./selftest/story.mjs");
await import("./selftest/translation.mjs");
await import("./selftest/mods.mjs");
await import("./selftest/pixel.mjs");
await import("./selftest/spine.mjs");

/* ------------------------------------------------------------------ */

const { checks, failures } = stats();
const passed = checks - failures.length;
/*
 * Said on every run, pass or fail, because a green `ok N/N` is easy to read as
 * "the UI works". It does not: this suite has no browser in it.
 */
const note = `note: ${checks} checks, no DOM -- the tiles' pixels, focus, pointer, keyboard and wheel events are not covered`;
if (failures.length > 0) {
  for (const { name, err } of failures) {
    console.error(`FAIL ${name}\n     ${err && err.message ? err.message : err}`);
    if (err && err.stack && !/^AssertionError/.test(err.name || "")) {
      console.error(String(err.stack).split("\n").slice(1, 4).map((line) => `     ${line.trim()}`).join("\n"));
    }
  }
  console.error(`ok ${passed}/${checks}`);
  console.error(note);
  process.exitCode = 1;
} else {
  console.log(`ok ${passed}/${checks}`);
  console.log(note);
}
