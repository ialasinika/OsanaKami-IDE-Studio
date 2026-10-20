/**
 * readtext.js -- the mod layer's one answer to "may this file be read as text?".
 *
 * G14: the card layer reads through the kernel, which refuses a directory, a
 * file over `SDE_WKSP_MAX_READ`, and anything containing a NUL byte (the two
 * read verbs exist exactly because text and bytes are different questions).
 * `shell/mods/*` reads with `node:fs` and, until now, had its own answer: a
 * 300 MB file would be read whole and an image would come back as mojibake.
 *
 * Both sides still read their own bytes -- the mod layer runs in the shell's
 * process and the kernel is a separate executable -- so "one answer" cannot be
 * one implementation.  It can be one *rule*, checked on every run against the
 * kernel's header: `selftest.mjs` parses `SDE_WKSP_MAX_READ` out of
 * `core/include/wksp.h` and fails if the two numbers drift.  The NUL rule is
 * the kernel's too, not a wider guess: a file that holds a NUL byte is not the
 * text the kernel would hand back.
 *
 * The functions never throw; they return `{ ok, text, error }` like the rest of
 * the mod layer.
 */
const fs = require('node:fs');

/** Must equal SDE_WKSP_MAX_READ in `core/include/wksp.h`; the suite checks. */
const MAX_TEXT_BYTES = 4 * 1024 * 1024;

/** The kernel's own sentence for this refusal, so both layers read the same. */
const TOO_LARGE = 'file is too large to open';
const BINARY = 'file is binary';

/** Strip a UTF-8 BOM exactly once, the way the card layer does. */
function stripBom(text) {
  return text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
}

function errText(error) {
  return error && error.message ? error.message : String(error);
}

/**
 * Read one file as text under the kernel's rules.
 *
 * Returns `{ ok: true, text, bytes }` or `{ ok: false, text: null, error }`.
 * `bytes` is the byte length, for callers that want to report a size without
 * asking the file system a second time.
 */
function readTextFile(abs) {
  try {
    const stat = fs.statSync(abs);
    if (stat.isDirectory()) {
      return { ok: false, text: null, error: `${abs} is a directory` };
    }
    if (stat.size > MAX_TEXT_BYTES) {
      return { ok: false, text: null, error: `${TOO_LARGE}: ${abs}` };
    }
    const buf = fs.readFileSync(abs);
    if (buf.includes(0)) {
      return { ok: false, text: null, error: `${BINARY} -- read it as bytes: ${abs}` };
    }
    return { ok: true, text: stripBom(buf.toString('utf8')), bytes: buf.length };
  } catch (error) {
    return { ok: false, text: null, error: errText(error) };
  }
}

module.exports = {
  MAX_TEXT_BYTES,
  readTextFile,
  stripBom,
};
