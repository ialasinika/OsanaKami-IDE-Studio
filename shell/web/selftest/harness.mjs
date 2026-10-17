/* ------------------------------------------------------------------ */
/*
 * The suite's own shelf: the counter, the failure list, and the two ways to add
 * a check.  A check runs the moment its section module is imported, which is
 * how one script's straight-line run is kept.
 */
const failures = [];
let checks = 0;

/** The runner's end-of-run arithmetic; the count is never written by hand. */
export function stats() {
  return { checks, failures };
}

export function test(name, fn) {
  checks += 1;
  try {
    fn();
  } catch (err) {
    failures.push({ name, err });
  }
}

export async function testAsync(name, fn) {
  checks += 1;
  try {
    await fn();
  } catch (err) {
    failures.push({ name, err });
  }
}
