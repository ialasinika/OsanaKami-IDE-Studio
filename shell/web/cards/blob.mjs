/**
 * cards/blob.mjs -- reading and writing text that may exceed one RPC frame.
 *
 * Part of `cards.mjs`, which re-exports this file; see that file's header for
 * why the card layer is split the way it is.
 */

/**
 * Bytes one `file.blobRead` or `file.blobAppend` call carries.
 *
 * `SDE_BLOB_MAX_CHUNK`: a frame carries at most this many decoded bytes and a
 * chunk over it is refused rather than truncated, so the limit is the kernel's
 * and this is the client's half of it.  The game's own translation tables are
 * 4.5-5.75 MB (`NewProject_RU.csv` is 5,751,617 bytes) and `file.read` refuses
 * anything over 4 MiB, so a table moves through a blob session instead: a
 * mebibyte a call is six calls for the largest table the game ships, no single
 * frame big enough to matter, and no call that asks for the whole file.
 */
export const BLOB_CHUNK_BYTES = 1024 * 1024;

/** base64 to bytes.  `atob` is the page's decoder; `Buffer` is not here. */
export function bytesFromBase64(base64) {
  const binary = atob(String(base64));
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) {
    bytes[i] = binary.charCodeAt(i);
  }
  return bytes;
}

/** Bytes to base64.  `btoa` is the page's encoder and wants a binary string. */
export function base64FromBytes(bytes) {
  let binary = "";
  const step = 0x8000;
  for (let i = 0; i < bytes.length; i += step) {
    binary += String.fromCharCode.apply(null, bytes.subarray(i, i + step));
  }
  return btoa(binary);
}

/** The chunk size a caller asked for, never more than one frame may carry. */
export function chunkBytesOf(options) {
  const wanted = Number.isFinite(options.chunkBytes)
    ? Math.floor(options.chunkBytes)
    : BLOB_CHUNK_BYTES;
  if (wanted < 1) {
    throw new Error(`a chunk of ${options.chunkBytes} bytes is not a chunk`);
  }
  return Math.min(wanted, BLOB_CHUNK_BYTES);
}

/**
 * Read a text file through a `file.blob*` read session.
 *
 * `file.read` carries a file inside one JSON string and refuses anything over
 * 4 MiB, which is every translation table the game ships; a session moves the
 * file in frames instead, and the kernel never holds the whole thing at once.
 * The session is opened once, read until `eof`, and aborted whatever happens --
 * including when a frame fails -- because a session left open holds a file.
 *
 * The bytes are decoded with a STREAMING decoder, so a frame that ends in the
 * middle of a character is completed by the next one instead of becoming a
 * replacement mark, and the final `decode()` flushes the character the last
 * frame may have left open.
 *
 * Two details are not left to the decoder.  A byte-order mark is kept as a fact
 * rather than silently eaten: the decoder is told not to interpret it, the mark
 * is reported as `bom` and taken off the text, and a caller that writes the
 * text back passes the flag on so the table round-trips byte for byte.  And the
 * decode is strict, because a lenient one would turn a table that is not UTF-8
 * into one with U+FFFD in it and the next save would write those replacements
 * over the modder's own characters; a file that will not decode is refused
 * while the mistake is still a sentence.
 *
 * Returns `{ text, bom, size, revision, chunks }`.  Every way this can go wrong
 * -- a missing file or a refused frame, a session the kernel has forgotten, a
 * frame served from the wrong offset, a frame longer than one may be, bytes
 * that are not UTF-8 -- throws an Error whose message is the sentence to show.
 * There is no partial result: the caller either gets the whole file or gets
 * nothing, because half a translation table shown as the table is the card
 * lying about the mod.
 */
export async function readTextInChunks(client, path, options = {}) {
  const chunkBytes = chunkBytesOf(options);
  const onProgress = typeof options.onProgress === "function" ? options.onProgress : () => {};
  const decoder = new TextDecoder("utf-8", { stream: true, ignoreBOM: true, fatal: true });
  const parts = [];

  /* `want_revision` is how a table's base revision is learned: `file.stat`
     reports 0 for a file too large to read whole. */
  const opened = await client.call("file.blobOpen", { path, mode: "read", want_revision: true });
  const session = opened.session;
  const size = Number(opened.size);
  if (!Number.isInteger(size) || size < 0) {
    throw new Error(`the kernel reported a size of ${opened.size} for ${path}`);
  }

  let offset = 0;
  let chunks = 0;
  let eof = false;
  onProgress(0, size);
  try {
    while (!eof) {
      let frame;
      try {
        frame = await client.call("file.blobRead", { session, offset, length: chunkBytes });
      } catch (err) {
        throw new Error(`frame at byte ${offset}: ${err.message}`);
      }

      /* The reply says where the bytes begin.  A kernel that served the wrong
         offset would hand back bytes already read, which reads as a table that
         is fine and is not, so the echo is checked rather than trusted. */
      if (Number(frame.offset) !== offset) {
        throw new Error(`asked for byte ${offset} and got byte ${frame.offset}`);
      }

      let bytes;
      try {
        bytes = bytesFromBase64(frame.data === undefined ? "" : frame.data);
      } catch (err) {
        throw new Error(`the base64 at byte ${offset}: ${err.message}`);
      }
      if (bytes.length > chunkBytes) {
        throw new Error(`the kernel sent ${bytes.length} bytes for a ${chunkBytes} byte frame at byte ${offset}`);
      }

      if (bytes.length === 0) {
        /* Asking past the end is not an error: the answer is an empty frame and
           `eof`.  A kernel that says "not the end" while sending nothing has
           stopped with bytes still to come, and a shorter table passed off as
           the table is the thing this reader exists to refuse. */
        if (frame.eof === true || offset >= size) {
          break;
        }
        throw new Error(`the read stopped at byte ${offset} of ${size}`);
      }

      try {
        parts.push(decoder.decode(bytes, { stream: true }));
      } catch (err) {
        throw new Error(`the bytes at byte ${offset} are not UTF-8 text`);
      }
      offset += bytes.length;
      chunks += 1;
      onProgress(offset, size);

      /* `eof` ends it; the offset reaching the size the kernel last reported is
         the same answer from a kernel that forgets to set it.  A file that grew
         while it was read moves that size on, so the reading follows it. */
      eof = frame.eof === true || offset >= size;
    }
  } finally {
    /* The session holds the file open, so it goes away on every path -- and a
       kernel that has already forgotten it is not worth a second error. */
    try {
      await client.call("file.blobAbort", { session });
    } catch (err) {
      /* the read's own error is the one to report */
    }
  }

  /* Flush: the last frame may have ended in the middle of a character. */
  try {
    parts.push(decoder.decode());
  } catch (err) {
    throw new Error(`the last bytes of ${path} are not UTF-8 text`);
  }
  let text = parts.join("");
  /* The mark is a fact about the file, named here so a write can put it back;
     it is not a character of the table. */
  const bom = text.charCodeAt(0) === 0xfeff;
  if (bom) {
    text = text.slice(1);
  }
  return { text, bom, size, revision: opened.revision, chunks };
}

/**
 * Write text through a `file.blob*` write session.
 *
 * The bytes are the file, so the text is encoded once, sliced into frames the
 * kernel accepts, appended, and published with `file.blobCommit`, whose
 * `total_size` is the client's own statement that nothing was left out -- the
 * kernel publishes only when it equals the bytes actually written.  A refused
 * commit leaves the session open, so the error the caller sees is the kernel's
 * own sentence; the session is aborted on the way out either way, which takes
 * the session's temporary file with it.
 *
 * Returns `{ size, revision, replaced, chunks }`; `revision` is the next
 * `base_revision` for the file, the number `file.read` would report for it.
 *
 * `options.bom` puts the byte-order mark back in front of the text.  The reader
 * reports the mark as a fact rather than a character, so the writer is where it
 * returns: a table read with a mark and written without one is a different file,
 * and the game's own tables are compared by bytes.
 */
export async function writeTextInChunks(client, path, text, options = {}) {
  const chunkBytes = chunkBytesOf(options);
  const onProgress = typeof options.onProgress === "function" ? options.onProgress : () => {};
  const bytes = new TextEncoder().encode(options.bom === true ? "\ufeff" + text : text);
  const params = { path, mode: "write" };
  if (options.baseRevision !== undefined && options.baseRevision !== null) {
    params.base_revision = options.baseRevision;
  }

  const opened = await client.call("file.blobOpen", params);
  const session = opened.session;
  let offset = 0;
  let chunks = 0;
  onProgress(0, bytes.length);
  try {
    while (offset < bytes.length) {
      const frame = bytes.subarray(offset, offset + chunkBytes);
      const appended = await client.call("file.blobAppend", {
        session, data: base64FromBytes(frame), offset,
      });
      const moved = Number(appended.offset);
      if (!Number.isInteger(moved) || moved !== offset + frame.length) {
        throw new Error(`appended ${frame.length} bytes at byte ${offset} and the kernel reported byte ${appended.offset}`);
      }
      offset = moved;
      chunks += 1;
      onProgress(offset, bytes.length);
    }
    const committed = await client.call("file.blobCommit", { session, total_size: bytes.length });
    return {
      size: bytes.length,
      revision: committed.revision,
      replaced: committed.replaced === true,
      chunks,
    };
  } finally {
    try {
      await client.call("file.blobAbort", { session });
    } catch (err) {
      /* committed above, or the write's own error is the one to report */
    }
  }
}

/**
 * Is this error the kernel saying "that file does not fit one call"?
 *
 * `file.read` and `file.write` carry the file inside one JSON string and refuse
 * anything over 4 MiB with `file is too large to open` / `file is too large to
 * overwrite` (core/src/wksp.c).  That refusal is not a failed read: it is the
 * kernel telling the caller to use a session.  The sentence is the only part of
 * the answer the client can rely on, because the kernel reports it through the
 * same path-error code as a missing file (`fail_path`), so the test is on the
 * words the kernel writes and nothing else.
 */
export function isTooLargeFile(err) {
  const message = err && typeof err.message === "string" ? err.message : "";
  return message.indexOf("too large") >= 0;
}

/**
 * Read a text file whole, or in frames when the kernel refuses it for size.
 *
 * This is the call every card that shows a file starts with.  `file.read` is
 * the cheap answer: one call, the line endings, the size and the revision, and
 * the text a small file already is.  Over 4 MiB it answers with a refusal
 * instead, and that refusal is answered here with `readTextInChunks` -- the
 * same session the table card has used since the boundary was found, so a 5 MB
 * `.yarn` opens in the editor and a 5 MB table opens in the story card.
 *
 * Only the size refusal falls back.  A missing file or broken encoding is the
 * error the caller should show, not a reason to try again another way.
 *
 * Returns `readTextInChunks`'s `{ text, bom, size, revision, chunks }` with two
 * more facts: `chunked` says which reader answered (and so whether the text
 * still has its BOM, which the frame reader reports separately), and `eol` is
 * the kernel's word for the line endings when `file.read` answered, `null`
 * when it did not -- the frame reader moves bytes, not lines.
 */
export async function readTextFile(client, path, options = {}) {
  try {
    const result = await client.call("file.read", { path });
    return {
      text: typeof result.text === "string" ? result.text : "",
      bom: false,
      size: result.size,
      revision: result.revision,
      eol: result.eol,
      chunks: 1,
      chunked: false,
    };
  } catch (err) {
    if (!isTooLargeFile(err)) {
      throw err;
    }
  }
  const read = await readTextInChunks(client, path, options);
  return { ...read, eol: null, chunked: true };
}

/**
 * Write text whole, or in frames when the kernel refuses it for size.
 *
 * The writing half of `readTextFile`, for the same reason: `file.write` refuses
 * a body over 4 MiB and a session does not.  `options.bom` puts a mark back in
 * front of the text -- the frame reader keeps the mark as a fact instead of a
 * character, so a caller that read a file with one owes this flag on the way
 * back out.  `file.read` does not report the mark, so a whole read hands it to
 * the caller inside the text and passes no flag.
 *
 * Returns `{ revision, chunked, ... }`; a stale write is the same error from
 * either path (`base_revision`), so the caller keeps one catch for it.
 */
export async function writeTextFile(client, path, text, options = {}) {
  const params = { path, text };
  if (options.bom === true) {
    params.text = "\ufeff" + text;
  }
  if (options.baseRevision !== undefined && options.baseRevision !== null) {
    params.base_revision = options.baseRevision;
  }
  try {
    const result = await client.call("file.write", params);
    return {
      revision: result.revision,
      eol: result.eol,
      chunks: 1,
      chunked: false,
    };
  } catch (err) {
    if (!isTooLargeFile(err)) {
      throw err;
    }
  }
  const written = await writeTextInChunks(client, path, text, options);
  return { ...written, eol: null, chunked: true };
}

/* ------------------------------------------------------------------ */
/* DOM                                                                    */
/* ------------------------------------------------------------------ */
