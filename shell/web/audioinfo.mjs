/**
 * audioinfo.mjs -- what the window can say about an audio file before playing it.
 *
 * The kernel hands bytes to a card as base64 (`file.read_bytes`), capped at the
 * same four mebibytes `file.read` is capped at; a card that wants to play a
 * recording therefore needs three small decisions that have nothing to do with
 * the DOM: which files are audio, which media type to label the bytes with, and
 * how to write a size or a length without pretending to be precise. They live
 * here, without imports, so `selftest.mjs` can pin them under Node -- the same
 * arrangement `pixelview.mjs` and `storycsv.mjs` have.
 *
 * Every mapping below is a label for the browser's decoder, not a promise: the
 * card plays what the bytes say, and an unsupported recording fails at
 * `loadedmetadata`, where the card can say so.
 */

/** The file extensions this build treats as recordings, and the media type each gets. */
export const AUDIO_TYPES = Object.freeze({
  ".wav": "audio/wav",
  ".ogg": "audio/ogg",
  ".oga": "audio/ogg",
  ".mp3": "audio/mpeg",
  ".flac": "audio/flac",
  ".aif": "audio/aiff",
  ".aiff": "audio/aiff",
  ".m4a": "audio/mp4",
  ".opus": "audio/ogg",
});

/**
 * The media type for a path, or `null` when it is not a recording.
 *
 * The extension is matched case-insensitively and the query/fragment is
 * ignored: cards get workspace-relative paths, but a caller that passes a URL
 * should still get the same answer.
 */
export function audioMime(path) {
  if (typeof path !== "string") {
    return null;
  }
  const clean = path.split(/[?#]/)[0];
  const dot = clean.lastIndexOf(".");
  if (dot < 0) {
    return null;
  }
  const extension = clean.slice(dot).toLowerCase();
  return Object.prototype.hasOwnProperty.call(AUDIO_TYPES, extension) ? AUDIO_TYPES[extension] : null;
}

/** True when the path names a recording this card would open. */
export function isAudioPath(path) {
  return audioMime(path) !== null;
}

/**
 * A byte count as a person reads it: `812 B`, `48.3 KiB`, `1.2 MiB`.
 *
 * One decimal place, and no decimal for bytes, because a recording's exact
 * length in bytes is never what a listener wants to know.
 */
export function audioSizeLabel(bytes) {
  if (typeof bytes !== "number" || !Number.isFinite(bytes) || bytes < 0) {
    return "unknown size";
  }
  if (bytes < 1024) {
    return `${Math.round(bytes)} B`;
  }
  if (bytes < 1024 * 1024) {
    return `${(bytes / 1024).toFixed(1)} KiB`;
  }
  return `${(bytes / (1024 * 1024)).toFixed(1)} MiB`;
}

/**
 * A duration as `m:ss` (or `h:mm:ss` past an hour), or `--:--` when the browser
 * has not reported a finite length. A voice line is seconds long; a song is
 * minutes; nobody needs milliseconds in either.
 */
export function clockLabel(seconds) {
  if (typeof seconds !== "number" || !Number.isFinite(seconds) || seconds < 0) {
    return "--:--";
  }
  const whole = Math.round(seconds);
  const hours = Math.floor(whole / 3600);
  const minutes = Math.floor((whole - hours * 3600) / 60);
  const rest = whole - hours * 3600 - minutes * 60;
  const pad = (value) => String(value).padStart(2, "0");
  return hours > 0 ? `${hours}:${pad(minutes)}:${pad(rest)}` : `${minutes}:${pad(rest)}`;
}

/**
 * The `src` a card gives an `<audio>` element for bytes it already holds.
 *
 * A data URL, because the bytes are already in the page and a second fetch
 * would have to go through a route the kernel does not offer: the shell's HTTP
 * front end serves cards and the board, not project files.
 */
export function dataUrl(base64, mime) {
  const payload = typeof base64 === "string" ? base64 : "";
  const type = typeof mime === "string" && mime !== "" ? mime : "application/octet-stream";
  return `data:${type};base64,${payload}`;
}
