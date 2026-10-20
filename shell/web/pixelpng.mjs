// A PNG reader and writer, hand-written down to the bit level.
//
// Deliberately imports nothing and touches no DOM, so it runs under Node for
// tests and in the page for the editor.  There is no `zlib` to reach for in a
// browser page anyway, so everything the format needs -- the CRC-32 of a chunk,
// the Adler-32 of the stream, the DEFLATE codec, the five row filters -- is
// implemented here.  Where `storycsv.mjs` hand-writes SHA-256 for the same
// reason, this hand-writes DEFLATE.
//
// Coverage.  Every bit depth and colour type the format defines is read: grey
// at 1/2/4/8/16, RGB at 8/16, palette at 1/2/4/8, grey+alpha at 8/16 and RGBA
// at 8/16, each progressive or Adam7-interlaced.  A palette file needs its
// PLTE and may carry tRNS; a tRNS on grey or RGB makes the named colour
// transparent.  The pairs the format does not define (16-bit palette, 4-bit
// RGB, ...) are refused by name rather than decoded into nonsense.  Every
// chunk's CRC-32 is checked before its contents are used, so a flipped byte is
// damage the reader names instead of pixels that merely look odd.
//
// The card holds RGBA8 and nothing else, so every source has to land there:
//
//   * bit depths below 8 scale up (1 bit becomes 0/255, 2 bits 0/85/170/255,
//     4 bits 0..255 in steps of 17);
//   * 16-bit samples are rounded to nearest -- `round(sample * 255 / 65535)`,
//     ties up, evaluated below as `(sample * 255 + 32768) / 65535` -- because
//     the card has no room for the low seven bits;
//   * a greyscale file becomes grey RGBA, an RGB file opaque RGBA, and a
//     palette index becomes that PLTE entry's colour, with tRNS for its alpha.
//
// What the real files are, measured on all 374 `.png` under `..\Mods`, is
// narrower than the format: every one is bit depth 8, interlace 0; 365 are
// colour type 6 (RGBA) and 9 are colour type 2 (RGB).  The wider reader is
// still worth having -- the card opens whatever the game ships -- but it means
// the fast path in `decodePng` is the only one this corpus exercises.
//
//   * the DEFLATE stream is not all one shape.  Counting blocks across those
//     374 streams: 3 are stored, 162 are fixed-Huffman and 249 are dynamic,
//     so a reader that only handles the compressed kinds (or only the stored
//     kind) fails on real files rather than on a contrived one.
//   * all five row filters occur (21519 none, 706 sub, 13593 up, 6 average,
//     2340 Paeth), so the predictor is load-bearing, not decoration.
//   * the zlib header's check bits are 0/31 in all 374, and the stream's
//     Adler-32 matches the decompressed bytes in all 374 -- which is what makes
//     those two the cheapest real-damage detectors available.
//
// Writing is faithful where it can prove the pixels still fit.  A file read as
// RGB is written as RGB; grey stays grey at its own depth when every pixel is
// still grey and still on that depth's scale; a palette file re-emits its
// PLTE -- the same entries in the same order, with a colour a stroke introduced
// appended, up to 256 -- and its tRNS; a 16-bit file is written at 16 bits.
// Adam7 is re-emitted when the source used it: interlace is layout, and the
// reader now holds every pixel that layout carried.  The 16-bit save writes
// `byte * 257`, the inverse of the decode map: exact for every sample a 16-bit
// file can hold that is a multiple of 257 (which is every sample an 8-bit
// source could supply), while any other sample had already lost its low seven
// bits at decode, not at save.  Pixels the card edited go through that same
// inverse map.
//
// When any of that cannot be proven -- a grey file repainted red, a palette
// pushed past 256 colours, a transparent colour the 16-bit map cannot name --
// the writer falls back to the one shape it always knows: 8-bit RGBA,
// non-interlaced, with an opaque alpha byte for a source that had none.  The
// pixels are what the card sees either way.  Every row is written with filter
// 0, and the DEFLATE is this module's own (`deflateFixed`), so the bytes are
// smaller than the input without borrowing zlib.

/** The eight bytes every PNG starts with. */
export const PNG_SIGNATURE = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

/**
 * What each colour type carries per pixel, and the bit depths the format
 * defines for it.  A pair outside this table is not a PNG this reader refuses
 * to do -- it is not a PNG at all, and `readHeader` says so by name.
 */
const COLOUR_CHANNELS = { 0: 1, 2: 3, 3: 1, 4: 2, 6: 4 };
const COLOUR_DEPTHS = { 0: [1, 2, 4, 8, 16], 2: [8, 16], 3: [1, 2, 4, 8], 4: [8, 16], 6: [8, 16] };

/**
 * Adam7's seven passes: where each starts and how far it steps.  A pass with
 * no pixel in either direction is empty and contributes no rows -- getting
 * that wrong shifts every later pass by one scanline and corrupts the image in
 * a way that still looks like an image.
 */
const ADAM7 = [
  { x0: 0, y0: 0, dx: 8, dy: 8 },
  { x0: 4, y0: 0, dx: 8, dy: 8 },
  { x0: 0, y0: 4, dx: 4, dy: 8 },
  { x0: 2, y0: 0, dx: 4, dy: 4 },
  { x0: 0, y0: 2, dx: 2, dy: 4 },
  { x0: 1, y0: 0, dx: 2, dy: 2 },
  { x0: 0, y0: 1, dx: 1, dy: 2 },
];
const PROGRESSIVE = [{ x0: 0, y0: 0, dx: 1, dy: 1 }];

/** How many columns (or rows) a pass covers, from the full size. */
function passLength(size, start, step) {
  return size <= start ? 0 : Math.ceil((size - start) / step);
}

/** Bytes in one unpacked (filtered but not yet unfiltered) row of a pass. */
function rowBytes(width, header) {
  return Math.ceil((width * header.channels * header.depth) / 8);
}

/**
 * The filter's byte step: one *pixel*, not one channel and never the row
 * length.  A 16-bit sample is two bytes, and a sub-byte pixel is one byte, so
 * this is the only expression that is right for every depth.
 */
function filterStep(header) {
  return Math.max(1, Math.ceil((header.channels * header.depth) / 8));
}

/**
 * The passes that actually carry pixels, with their sizes, strides and the
 * source coordinates of their first pixel.  One list feeds both directions:
 * `decodePng` walks it to scatter samples into the card, `encodePng` walks it
 * to gather them back, and neither can disagree with the other about how many
 * bytes a file holds.
 */
function passLayout(width, height, header) {
  const passes = header.interlace === 1 ? ADAM7 : PROGRESSIVE;
  const layout = [];
  for (const pass of passes) {
    const passWidth = passLength(width, pass.x0, pass.dx);
    if (passWidth === 0) continue;
    const passHeight = passLength(height, pass.y0, pass.dy);
    if (passHeight === 0) continue;
    layout.push({
      x0: pass.x0,
      y0: pass.y0,
      dx: pass.dx,
      dy: pass.dy,
      width: passWidth,
      height: passHeight,
      stride: rowBytes(passWidth, header),
    });
  }
  return layout;
}

/**
 * A sample at its source depth as an 8-bit channel.  Depth 16 rounds to
 * nearest with ties up; a 1/2/4-bit grey scales by 255/1, 255/3, 255/15.
 */
function toByte(sample, depth) {
  if (depth === 16) return (sample * 255 + 32768) / 65535 | 0;
  if (depth === 8) return sample;
  return sample * (255 / ((1 << depth) - 1));
}

/** The inverse of `toByte` for a value that is known to be on the scale. */
function fromByte(byte, depth) {
  if (depth === 16) return byte * 257;
  if (depth === 8) return byte;
  return byte / (255 / ((1 << depth) - 1));
}

/* ------------------------------------------------------------ small tools */

function u32(bytes, at) {
  return ((bytes[at] << 24) | (bytes[at + 1] << 16) | (bytes[at + 2] << 8) | bytes[at + 3]) >>> 0;
}

/**
 * A view over the same bytes as a `Uint8Array`.
 *
 * `decodePng` promises to accept a Node `Buffer`, and a Buffer *is* a
 * Uint8Array subclass -- but this module may not say `Buffer` or reach for any
 * `node:` builtin to know that.  Reading through a fresh `Uint8Array` view
 * works for both and keeps the parameter honest.
 */
function asBytes(input) {
  if (input instanceof Uint8Array) return new Uint8Array(input.buffer, input.byteOffset, input.byteLength);
  if (ArrayBuffer.isView(input)) return new Uint8Array(input.buffer, input.byteOffset, input.byteLength);
  throw new Error("not a PNG: expected a Uint8Array, got " + (input === null ? "null" : typeof input));
}

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n += 1) {
    let c = n;
    for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c >>> 0;
  }
  return table;
})();

function crc32(bytes) {
  let c = 0xffffffff;
  for (let i = 0; i < bytes.length; i += 1) c = CRC_TABLE[(c ^ bytes[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

/** The zlib checksum: two running sums, modulo the largest prime below 65536. */
function adler32(bytes) {
  let a = 1;
  let b = 0;
  for (let i = 0; i < bytes.length; i += 1) {
    a += bytes[i];
    b += a;
    // Wait until the sums are near the modulus before folding, or every byte
    // would cost two `%` divisions on a 28-megapixel corpus.
    if ((i & 0xfff) === 0xfff) {
      a %= 65521;
      b %= 65521;
    }
  }
  return (((b % 65521) << 16) | (a % 65521)) >>> 0;
}

/* -------------------------------------------------------------- Huffman */

/**
 * Canonical Huffman codes, decoded bit by bit.
 *
 * DEFLATE sends Huffman codes most-significant-bit-first while everything
 * around them is least-significant-first, so the reader below does not pop
 * `length` bits and look them up -- it walks one bit at a time and appends,
 * which is the only order that reads a code the way it was written.
 */
function huffman(lengths) {
  let max = 0;
  for (let i = 0; i < lengths.length; i += 1) if (lengths[i] > max) max = lengths[i];
  const counted = new Uint32Array(max + 1);
  for (let i = 0; i < lengths.length; i += 1) if (lengths[i] > 0) counted[lengths[i]] += 1;
  const next = new Uint32Array(max + 1);
  let code = 0;
  for (let bits = 1; bits <= max; bits += 1) {
    code = (code + counted[bits - 1]) << 1;
    next[bits] = code;
  }
  /*
   * The table is indexed by the bits read so far, *including* their length, so
   * a code and the longer code that starts with the same bits cannot collide.
   * After `bits` reads the running index is `(1 << bits) | code`, which lands
   * one past this key -- hence the `index - 1` at the lookup. Sizing the table
   * at `1 << max` and keying it on `bits << max` puts every single entry past
   * the end of the array, where a typed array reads back `undefined` instead of
   * throwing: `undefined !== 0` then sails through the entry test and the
   * caller decodes `NaN` forever without consuming a bit. That is a hang, not a
   * failure, and it is why the bound below is a plain truthiness test.
   */
  const table = new Int32Array(1 << (max + 1));
  for (let symbol = 0; symbol < lengths.length; symbol += 1) {
    const bits = lengths[symbol];
    if (bits === 0) continue;
    table[(1 << bits) - 1 + next[bits]] = symbol + 1;
    next[bits] += 1;
  }
  return (read) => {
    let index = 1;
    for (let bits = 1; bits <= max; bits += 1) {
      index = (index << 1) | read();
      const entry = table[index - 1];
      if (entry) return entry - 1;
    }
    throw new Error("damaged PNG: the DEFLATE stream has no code for these bits");
  };
}

// The fixed literal/length code of RFC 1951, and the fixed distance code.
const fixedLiteral = huffman((() => {
  const lengths = new Uint8Array(288);
  for (let i = 0; i < 144; i += 1) lengths[i] = 8;
  for (let i = 144; i < 256; i += 1) lengths[i] = 9;
  for (let i = 256; i < 280; i += 1) lengths[i] = 7;
  for (let i = 280; i < 288; i += 1) lengths[i] = 8;
  return lengths;
})());
const fixedDistance = huffman(new Uint8Array(30).fill(5));

const CODE_ORDER = [16, 17, 18, 0, 8, 7, 9, 6, 10, 5, 11, 4, 12, 3, 13, 2, 14, 1, 15];
const LENGTH_BASE = [3, 4, 5, 6, 7, 8, 9, 10, 11, 13, 15, 17, 19, 23, 27, 31, 35, 43, 51, 59, 67, 83, 99, 115, 131, 163, 195, 227, 258];
const LENGTH_EXTRA = [0, 0, 0, 0, 0, 0, 0, 0, 1, 1, 1, 1, 2, 2, 2, 2, 3, 3, 3, 3, 4, 4, 4, 4, 5, 5, 5, 5, 0];
const DIST_BASE = [1, 2, 3, 4, 5, 7, 9, 13, 17, 25, 33, 49, 65, 97, 129, 193, 257, 385, 513, 769, 1025, 1537, 2049, 3073, 4097, 6145, 8193, 12289, 16385, 24577];
const DIST_EXTRA = [0, 0, 0, 0, 1, 1, 2, 2, 3, 3, 4, 4, 5, 5, 6, 6, 7, 7, 8, 8, 9, 9, 10, 10, 11, 11, 12, 12, 13, 13];

/**
 * A DEFLATE stream, expanded.  `limit` is the number of bytes the PNG header
 * says to expect: decoding past it means the stream and the header disagree,
 * and the failure is reported before the array can grow large.
 */
function inflate(bytes, from, to, limit) {
  const out = new Uint8Array(limit);
  let written = 0;
  let at = from;
  let buffer = 0;
  let held = 0;

  const read = (count) => {
    while (held < count) {
      if (at >= to) throw new Error("damaged PNG: the DEFLATE stream ends inside a block");
      buffer |= bytes[at] << held;
      held += 8;
      at += 1;
    }
    const value = buffer & ((1 << count) - 1);
    buffer >>>= count;
    held -= count;
    return value;
  };
  const bit = () => read(1);
  const emit = (value) => {
    if (written >= limit) throw new Error("damaged PNG: the DEFLATE stream decodes to more bytes than its image needs");
    out[written] = value;
    written += 1;
  };

  for (;;) {
    const final = read(1);
    const kind = read(2);
    if (kind === 0) {
      // A stored block is byte-aligned and carries its own length twice.
      const skip = held & 7;
      if (skip > 0) read(skip);
      const start = at;
      if (start + 4 > to) throw new Error("damaged PNG: a stored block is cut off");
      const length = bytes[start] | (bytes[start + 1] << 8);
      const inverse = bytes[start + 2] | (bytes[start + 3] << 8);
      if (length !== (~inverse & 0xffff)) throw new Error("damaged PNG: a stored block's two lengths disagree");
      if (start + 4 + length > to) throw new Error("damaged PNG: a stored block runs past the IDAT data");
      for (let i = 0; i < length; i += 1) emit(bytes[start + 4 + i]);
      at = start + 4 + length;
    } else if (kind === 1 || kind === 2) {
      let decodeLiteral = fixedLiteral;
      let decodeDistance = fixedDistance;
      if (kind === 2) {
        const hlit = read(5) + 257;
        const hdist = read(5) + 1;
        const hclen = read(4) + 4;
        const codeLengths = new Uint8Array(19);
        for (let i = 0; i < hclen; i += 1) codeLengths[CODE_ORDER[i]] = read(3);
        const decodeCode = huffman(codeLengths);
        const lengths = new Uint8Array(hlit + hdist);
        let filled = 0;
        while (filled < lengths.length) {
          const symbol = decodeCode(bit);
          if (symbol < 16) {
            lengths[filled] = symbol;
            filled += 1;
          } else if (symbol === 16) {
            if (filled === 0) throw new Error("damaged PNG: the code lengths start with a repeat");
            const prior = lengths[filled - 1];
            const times = read(2) + 3;
            for (let i = 0; i < times && filled < lengths.length; i += 1) {
              lengths[filled] = prior;
              filled += 1;
            }
          } else {
            const times = (symbol === 17 ? read(3) + 3 : read(7) + 11);
            for (let i = 0; i < times && filled < lengths.length; i += 1) {
              lengths[filled] = 0;
              filled += 1;
            }
          }
        }
        decodeLiteral = huffman(lengths.subarray(0, hlit));
        decodeDistance = huffman(lengths.subarray(hlit));
      }
      for (;;) {
        const symbol = decodeLiteral(bit);
        if (symbol < 256) {
          emit(symbol);
          continue;
        }
        if (symbol === 256) break;
        const index = symbol - 257;
        if (index >= LENGTH_BASE.length) throw new Error("damaged PNG: a length code outside the alphabet");
        const length = LENGTH_BASE[index] + read(LENGTH_EXTRA[index]);
        const code = decodeDistance(bit);
        if (code >= DIST_BASE.length) throw new Error("damaged PNG: a distance code outside the alphabet");
        const distance = DIST_BASE[code] + read(DIST_EXTRA[code]);
        const from_ = written - distance;
        if (from_ < 0) throw new Error("damaged PNG: a back-reference reaches before the start of the image");
        for (let i = 0; i < length; i += 1) {
          // Byte at a time on purpose: a back-reference may overlap the bytes it
          // is producing, and a bulk copy would read them before they exist.
          emit(out[from_ + i]);
        }
      }
    } else {
      throw new Error("damaged PNG: a DEFLATE block of the reserved type");
    }
    if (final === 1) break;
  }
  if (written !== limit) {
    throw new Error(`damaged PNG: the stream holds ${written} bytes where the image needs ${limit}`);
  }
  return out;
}

/* ------------------------------------------------------------ dimensions */

/**
 * Read and check the IHDR the way a PNG reader must: everything this decoder
 * will not do is refused *here*, by name, so a refusal is never mistaken for
 * corruption and an unusual-but-legal file never reaches the pixel loop.
 */
function readHeader(bytes) {
  const width = u32(bytes, 0);
  const height = u32(bytes, 4);
  const depth = bytes[8];
  const colour = bytes[9];
  const compression = bytes[10];
  const filter = bytes[11];
  const interlace = bytes[12];
  if (width === 0 || height === 0) {
    throw new Error(`damaged PNG: the header names a ${width}x${height} image`);
  }
  if (compression !== 0) throw new Error(`unsupported PNG: compression method ${compression}, only 0 is defined`);
  if (filter !== 0) throw new Error(`unsupported PNG: filter method ${filter}, only 0 is defined`);
  if (interlace !== 0 && interlace !== 1) {
    throw new Error(`unsupported PNG: interlace ${interlace}, only 0 (none) and 1 (Adam7) are read`);
  }
  const depths = COLOUR_DEPTHS[colour];
  if (depths === undefined) {
    throw new Error(`unsupported PNG: colour type ${colour}, only 0 (grey), 2 (RGB), 3 (palette), 4 (grey+alpha) and 6 (RGBA) are read`);
  }
  if (!depths.includes(depth)) {
    throw new Error(`unsupported PNG: bit depth ${depth} for colour type ${colour}, which the format defines as ${depths.join(", ")}`);
  }
  return { width, height, colour, depth, interlace, channels: COLOUR_CHANNELS[colour] };
}

function readInt32(bytes, at) {
  return (bytes[at] << 24) | (bytes[at + 1] << 16) | (bytes[at + 2] << 8) | bytes[at + 3];
}

/**
 * The bytes of every IDAT chunk, in order, plus the palette chunks, with the
 * rest of the file checked.
 *
 * Each chunk's CRC-32 covers its type and body, so checking it before reading
 * the body turns a flipped byte into a named failure instead of a picture that
 * is subtly wrong.  The palette checks that need the IHDR (a palette image
 * without a PLTE, a tRNS where the colour type forbids one) happen after the
 * loop, when the header this reader already parsed is in hand.
 */
function readChunks(bytes, header) {
  const parts = [];
  let total = 0;
  let inImageData = false;
  let sawHeader = false;
  let sawEnd = false;
  let palette = null;
  let paletteAlpha = null;
  let transparent = null;
  let at = 8;
  while (at + 12 <= bytes.length) {
    const length = readInt32(bytes, at);
    if (length < 0) throw new Error("damaged PNG: a chunk length with the top bit set");
    const type = String.fromCharCode(bytes[at + 4], bytes[at + 5], bytes[at + 6], bytes[at + 7]);
    if (at + 12 + length > bytes.length) {
      throw new Error(`damaged PNG: the ${type} chunk is truncated`);
    }
    const stated = readInt32(bytes, at + 8 + length) >>> 0;
    const actual = crc32(bytes.subarray(at + 4, at + 8 + length));
    if (stated !== actual) {
      throw new Error(`damaged PNG: the ${type} chunk's CRC-32 is ${stated.toString(16)} where its bytes give ${actual.toString(16)}`);
    }
    if (!sawHeader && type !== "IHDR") throw new Error(`damaged PNG: the first chunk is ${type}, not IHDR`);
    if (inImageData && type !== "IDAT" && type !== "IEND") {
      // The format requires the image data to be one run of IDAT chunks; a
      // chunk wedged between two of them means the file is not one this reader
      // can trust to have read every byte of the stream.
      throw new Error(`damaged PNG: a ${type} chunk interrupts the image data`);
    }
    if (type === "IHDR") {
      if (sawHeader) throw new Error("damaged PNG: a second IHDR chunk");
      if (length !== 13) throw new Error(`damaged PNG: IHDR is ${length} bytes, not 13`);
      sawHeader = true;
    } else if (type === "PLTE") {
      if (palette !== null) throw new Error("damaged PNG: a second PLTE chunk");
      if (length === 0 || length % 3 !== 0 || length > 768) {
        throw new Error(`damaged PNG: PLTE carries ${length} bytes, which is not 3 to 768 in steps of 3`);
      }
      palette = bytes.slice(at + 8, at + 8 + length);
    } else if (type === "tRNS") {
      if (transparent !== null) throw new Error("damaged PNG: a second tRNS chunk");
      transparent = bytes.slice(at + 8, at + 8 + length);
    } else if (type === "IDAT") {
      if (inImageData === false) inImageData = true;
      const part = bytes.subarray(at + 8, at + 8 + length);
      parts.push(part);
      total += length;
    } else if (type === "IEND") {
      if (length !== 0) throw new Error(`damaged PNG: IEND carries ${length} bytes`);
      sawEnd = true;
      break;
    }
    at += 12 + length;
  }
  if (!sawHeader) throw new Error("damaged PNG: no IHDR chunk");
  if (!sawEnd) throw new Error("damaged PNG: no IEND chunk");
  if (parts.length === 0) throw new Error("damaged PNG: no IDAT chunk");

  if (header.colour === 3) {
    if (palette === null) throw new Error("damaged PNG: a palette image has no PLTE chunk");
    const entries = palette.length / 3;
    const capacity = 1 << header.depth;
    if (entries > capacity) {
      throw new Error(`damaged PNG: PLTE has ${entries} entries where bit depth ${header.depth} can address ${capacity}`);
    }
    if (transparent !== null) {
      if (transparent.length > entries) {
        throw new Error(`damaged PNG: tRNS names ${transparent.length} alphas for a ${entries}-entry PLTE`);
      }
      paletteAlpha = transparent;
      transparent = null;
    }
  } else {
    if ((header.colour === 0 || header.colour === 4) && palette !== null) {
      throw new Error(`damaged PNG: a PLTE chunk on a colour type ${header.colour} image`);
    }
    if (transparent !== null && (header.colour === 4 || header.colour === 6)) {
      throw new Error(`damaged PNG: a tRNS chunk on a colour type ${header.colour} image`);
    }
    if (transparent !== null) {
      const wanted = header.colour === 0 ? 2 : 6;
      if (transparent.length !== wanted) {
        throw new Error(`damaged PNG: tRNS carries ${transparent.length} bytes where colour type ${header.colour} needs ${wanted}`);
      }
      if (header.depth < 16) {
        const most = (1 << header.depth) - 1;
        for (let i = 0; i + 1 < transparent.length; i += 2) {
          const value = (transparent[i] << 8) | transparent[i + 1];
          if (value > most) {
            throw new Error(`damaged PNG: tRNS names sample ${value}, outside the ${header.depth}-bit range`);
          }
        }
      }
    }
  }

  const idat = new Uint8Array(total);
  let cursor = 0;
  for (const part of parts) {
    idat.set(part, cursor);
    cursor += part.length;
  }
  return { idat, palette, paletteAlpha, transparent };
}

/**
 * Undo the five row filters, in place, for one run of rows.
 *
 * `into` holds the unfiltered rows back to back and `from` is where this run's
 * filtered bytes start in `raw`; the returned offset is the first byte after
 * them, so an Adam7 file can be walked pass by pass without copying the whole
 * stream first.
 *
 * `bpp` is the byte `left` step: one *pixel*, as `filterStep` computes it --
 * four bytes for RGBA8, three for RGB8, two for RGBA16, one for a sub-byte
 * grey pixel.  Using the row length here is the classic silent corruption:
 * every row decodes to plausible bytes and only the picture is wrong.
 */
function unfilterRows(raw, from, stride, height, bpp, into) {
  let source = from;
  let to = 0;
  for (let y = 0; y < height; y += 1) {
    const kind = raw[source];
    source += 1;
    const row = into.subarray(to, to + stride);
    const above = y >= 1 ? into.subarray(to - stride, to) : null;
    if (kind === 0) {
      row.set(raw.subarray(source, source + stride));
    } else if (kind === 1) {
      for (let i = 0; i < stride; i += 1) {
        const left = i >= bpp ? row[i - bpp] : 0;
        row[i] = (raw[source + i] + left) & 0xff;
      }
    } else if (kind === 2) {
      for (let i = 0; i < stride; i += 1) {
        const up = above === null ? 0 : above[i];
        row[i] = (raw[source + i] + up) & 0xff;
      }
    } else if (kind === 3) {
      for (let i = 0; i < stride; i += 1) {
        const left = i >= bpp ? row[i - bpp] : 0;
        const up = above === null ? 0 : above[i];
        row[i] = (raw[source + i] + ((left + up) >> 1)) & 0xff;
      }
    } else if (kind === 4) {
      for (let i = 0; i < stride; i += 1) {
        const a = i >= bpp ? row[i - bpp] : 0;
        const b = above === null ? 0 : above[i];
        const c = above === null || i < bpp ? 0 : above[i - bpp];
        const p = a + b - c;
        const pa = p > a ? p - a : a - p;
        const pb = p > b ? p - b : b - p;
        const pc = p > c ? p - c : c - p;
        const guess = pa <= pb && pa <= pc ? a : pb <= pc ? b : c;
        row[i] = (raw[source + i] + guess) & 0xff;
      }
    } else {
      throw new Error(`damaged PNG: row ${y} has filter type ${kind}, which is not one of the five`);
    }
    source += stride;
    to += stride;
  }
  return source;
}

/**
 * Sample `index` of an unfiltered row, at its source depth.
 *
 * Sub-byte samples are packed from the most significant end of the first byte,
 * in pixel order; 16-bit samples are big-endian.  Both rules are the format's,
 * not a choice this reader makes.
 */
function readSample(row, index, depth) {
  if (depth === 8) return row[index];
  if (depth === 16) return (row[index * 2] << 8) | row[index * 2 + 1];
  const bit = index * depth;
  return (row[bit >> 3] >> (8 - depth - (bit & 7))) & ((1 << depth) - 1);
}

/**
 * One source pixel, expanded into the four RGBA8 bytes the card holds.
 *
 * The colour type decides which samples exist; `toByte` is the only place a
 * sample changes width, so the 16-bit rounding is stated once.  A tRNS colour
 * key is compared at the *source* depth, before any mapping, because that is
 * what the file stored; comparing mapped bytes would make two different
 * 16-bit samples with the same high byte both transparent.
 */
function expandPixel(header, row, px, chunks, into, at) {
  const depth = header.depth;
  const colour = header.colour;
  const first = px * header.channels;
  if (colour === 3) {
    const index = readSample(row, px, depth);
    const entries = chunks.palette.length / 3;
    if (index >= entries) {
      throw new Error(`damaged PNG: palette index ${index} is past the ${entries}-entry PLTE`);
    }
    const entry = index * 3;
    into[at] = chunks.palette[entry];
    into[at + 1] = chunks.palette[entry + 1];
    into[at + 2] = chunks.palette[entry + 2];
    into[at + 3] = chunks.paletteAlpha !== null && index < chunks.paletteAlpha.length ? chunks.paletteAlpha[index] : 255;
    return;
  }
  if (colour === 0) {
    const sample = readSample(row, first, depth);
    const grey = toByte(sample, depth);
    into[at] = grey;
    into[at + 1] = grey;
    into[at + 2] = grey;
    into[at + 3] = chunks.transparent !== null && sample === ((chunks.transparent[0] << 8) | chunks.transparent[1]) ? 0 : 255;
    return;
  }
  if (colour === 4) {
    const grey = toByte(readSample(row, first, depth), depth);
    into[at] = grey;
    into[at + 1] = grey;
    into[at + 2] = grey;
    into[at + 3] = toByte(readSample(row, first + 1, depth), depth);
    return;
  }
  const red = readSample(row, first, depth);
  const green = readSample(row, first + 1, depth);
  const blue = readSample(row, first + 2, depth);
  into[at] = toByte(red, depth);
  into[at + 1] = toByte(green, depth);
  into[at + 2] = toByte(blue, depth);
  if (colour === 2) {
    const key = chunks.transparent;
    into[at + 3] = key !== null
      && red === ((key[0] << 8) | key[1])
      && green === ((key[2] << 8) | key[3])
      && blue === ((key[4] << 8) | key[5]) ? 0 : 255;
  } else {
    into[at + 3] = toByte(readSample(row, first + 3, depth), depth);
  }
}

/* --------------------------------------------------------------- the API */

/** A blank image, all one colour.  `pixels` is RGBA whatever the colour is. */
export function blankImage(width, height, rgba = [0, 0, 0, 0]) {
  const w = Math.floor(Number(width));
  const h = Math.floor(Number(height));
  if (!(w > 0) || !(h > 0)) throw new Error(`an image needs a positive size, got ${width}x${height}`);
  const colour = rgba === null || rgba === undefined ? [] : rgba;
  const channel = (index, fallback) => {
    const value = colour[index];
    return value === undefined || value === null ? fallback : Number(value) & 0xff;
  };
  const pixels = new Uint8Array(w * h * 4);
  const r = channel(0, 0);
  const g = channel(1, 0);
  const b = channel(2, 0);
  const a = channel(3, 255);
  for (let i = 0; i < pixels.length; i += 4) {
    pixels[i] = r;
    pixels[i + 1] = g;
    pixels[i + 2] = b;
    pixels[i + 3] = a;
  }
  return { width: w, height: h, pixels };
}

/**
 * The image in a PNG, as RGBA whatever the file's colour type was, together
 * with the `format` it came in so `encodePng` can write that shape back.
 *
 * An RGB or greyscale file becomes opaque; a tRNS key becomes alpha 0 on the
 * pixels that name it.  `format` is
 *
 *   { colourType, bitDepth, interlace, palette, paletteAlpha, transparent }
 *
 * where `palette` is the PLTE body or null, `paletteAlpha` is the tRNS body of
 * a palette image or null, and `transparent` is the raw 2- or 6-byte tRNS of a
 * grey or RGB image or null.  The bodies are the file's own bytes, copied, so
 * a save can re-emit them without inventing a palette.
 *
 * 8-bit RGBA and RGB without interlace take the direct path: one unfilter into
 * the destination (plus one 3-byte-per-pixel scratch for RGB), no per-pixel
 * sample reads.  Everything else -- sub-byte depths, 16-bit, palette, Adam7 --
 * goes through `expandPixel`, where the width change happens once.
 */
export function decodePng(bytes) {
  const data = asBytes(bytes);
  if (data.length < PNG_SIGNATURE.length) {
    throw new Error(`not a PNG: ${data.length} bytes is too short to hold the 8-byte signature`);
  }
  for (let i = 0; i < PNG_SIGNATURE.length; i += 1) {
    if (data[i] !== PNG_SIGNATURE[i]) {
      throw new Error(`not a PNG: the signature starts ${[...data.subarray(0, 8)].map((b) => b.toString(16).padStart(2, "0")).join(" ")}`);
    }
  }
  const header = readHeader(data.subarray(16, 29));
  const chunks = readChunks(data, header);
  const idat = chunks.idat;

  // The zlib header, then the DEFLATE stream it wraps.
  if (idat.length < 6) throw new Error(`damaged PNG: the image data is ${idat.length} bytes, too short for a zlib stream`);
  const method = idat[0] & 0x0f;
  const window_ = (idat[0] >> 4) & 0x0f;
  if (method !== 8) throw new Error(`damaged PNG: the zlib stream uses compression method ${method}`);
  if (window_ > 7) throw new Error(`damaged PNG: the zlib stream asks for a ${1 << (window_ + 8)}-byte history`);
  if (((idat[0] << 8) | idat[1]) % 31 !== 0) {
    throw new Error(`damaged PNG: the zlib header's check bits do not sum to a multiple of 31 (${idat[0]}, ${idat[1]})`);
  }

  const layout = passLayout(header.width, header.height, header);
  let expected = 0;
  for (const pass of layout) expected += (pass.stride + 1) * pass.height;
  const raw = inflate(idat, 2, idat.length - 4, expected);

  const declared = u32(idat, idat.length - 4);
  const actual = adler32(raw);
  if (declared !== actual) {
    throw new Error(`damaged PNG: the stream's Adler-32 is ${declared.toString(16)} where its bytes give ${actual.toString(16)}`);
  }

  const pixels = new Uint8Array(header.width * header.height * 4);
  if (header.interlace === 0 && header.depth === 8 && header.colour === 6) {
    unfilterRows(raw, 0, header.width * 4, header.height, 4, pixels);
  } else if (header.interlace === 0 && header.depth === 8 && header.colour === 2) {
    const rgb = new Uint8Array(header.width * header.height * 3);
    unfilterRows(raw, 0, header.width * 3, header.height, 3, rgb);
    // Expand 3 bytes per pixel to 4.  Walking backwards keeps the read and the
    // write from lapping each other, which a forward pass would not.
    for (let count = header.width * header.height - 1; count >= 0; count -= 1) {
      const from = count * 3;
      const to = count * 4;
      pixels[to] = rgb[from];
      pixels[to + 1] = rgb[from + 1];
      pixels[to + 2] = rgb[from + 2];
      pixels[to + 3] = 255;
    }
  } else {
    const step = filterStep(header);
    let from = 0;
    for (const pass of layout) {
      const rows = new Uint8Array(pass.stride * pass.height);
      from = unfilterRows(raw, from, pass.stride, pass.height, step, rows);
      for (let py = 0; py < pass.height; py += 1) {
        const row = rows.subarray(py * pass.stride, (py + 1) * pass.stride);
        const y = pass.y0 + py * pass.dy;
        for (let px = 0; px < pass.width; px += 1) {
          const x = pass.x0 + px * pass.dx;
          expandPixel(header, row, px, chunks, pixels, (y * header.width + x) * 4);
        }
      }
    }
  }

  return {
    width: header.width,
    height: header.height,
    pixels,
    format: {
      colourType: header.colour,
      bitDepth: header.depth,
      interlace: header.interlace,
      palette: chunks.palette,
      paletteAlpha: chunks.paletteAlpha,
      transparent: chunks.transparent,
    },
  };
}

/* ------------------------------------------------------------- encoding */

function huffmanCodes(lengths) {
  let max = 0;
  for (let i = 0; i < lengths.length; i += 1) if (lengths[i] > max) max = lengths[i];
  const counted = new Uint32Array(max + 1);
  for (let i = 0; i < lengths.length; i += 1) if (lengths[i] > 0) counted[lengths[i]] += 1;
  const next = new Uint32Array(max + 1);
  let code = 0;
  for (let bits = 1; bits <= max; bits += 1) {
    code = (code + counted[bits - 1]) << 1;
    next[bits] = code;
  }
  const codes = new Uint16Array(lengths.length);
  for (let symbol = 0; symbol < lengths.length; symbol += 1) {
    const bits = lengths[symbol];
    if (bits === 0) continue;
    codes[symbol] = next[bits];
    next[bits] += 1;
  }
  return codes;
}

const FIXED_LITERAL_LENGTHS = (() => {
  const lengths = new Uint8Array(288);
  for (let i = 0; i < 144; i += 1) lengths[i] = 8;
  for (let i = 144; i < 256; i += 1) lengths[i] = 9;
  for (let i = 256; i < 280; i += 1) lengths[i] = 7;
  for (let i = 280; i < 288; i += 1) lengths[i] = 8;
  return lengths;
})();
const FIXED_LITERAL_CODES = huffmanCodes(FIXED_LITERAL_LENGTHS);
const FIXED_DISTANCE_CODES = huffmanCodes(new Uint8Array(30).fill(5));

/**
 * Fixed-Huffman DEFLATE with a three-byte hash chain.
 *
 * The writer does not have to compress, only to be read: a stored block per
 * 64 KiB would be a valid PNG.  It compresses anyway because the alternative
 * is an "editor" that turns a 300 KiB texture into a 4 MiB one, and because
 * fixed-Huffman literals are 8-9 bits, so the code below is the shortest way
 * to be smaller than the input.  The chain is deliberately shallow: this is
 * not competing with zlib's level 9, and a bounded search is what keeps the
 * cost of `encodePng` predictable on a 28-megapixel corpus.
 */
function deflateFixed(raw) {
  const length = raw.length;
  const sha = new Int32Array(1 << 15).fill(-1);
  const chain = new Int32Array(length).fill(-1);
  const output = [];
  let buffer = 0;
  let held = 0;

  const write = (value, bits) => {
    buffer |= value << held;
    held += bits;
    while (held >= 8) {
      output.push(buffer & 0xff);
      buffer >>>= 8;
      held -= 8;
    }
  };
  const writeCode = (code, bits) => {
    /*
     * A Huffman code goes into the stream most-significant-bit-first, while
     * `write` fills every byte from its low end.  The two orders only cancel if
     * the code is reversed first: `write` really does emit `reversed & 1` -- the
     * code's least-significant bit -- as the first bit.  Walking `i` down from
     * `bits - 1` to 0 and shifting left rebuilds the code exactly as it came in,
     * which is not a reversal at all, and the reader then takes literal 0's
     * `00110000` as `00001100` -- a different symbol on every byte.
     */
    let reversed = 0;
    for (let i = 0; i < bits; i += 1) reversed = (reversed << 1) | ((code >>> i) & 1);
    write(reversed, bits);
  };
  const findLength = (value) => {
    let at = LENGTH_BASE.length - 1;
    while (at > 0 && LENGTH_BASE[at] > value) at -= 1;
    return at;
  };
  const findDistance = (value) => {
    let at = DIST_BASE.length - 1;
    while (at > 0 && DIST_BASE[at] > value) at -= 1;
    return at;
  };

  write(1, 1); // the final block
  write(1, 2); // fixed Huffman

  let at = 0;
  const limit = length - 3;
  while (at < length) {
    let bestLength = 0;
    let bestDistance = 0;
    if (at <= limit) {
      const key = ((raw[at] << 10) ^ (raw[at + 1] << 5) ^ raw[at + 2]) & ((1 << 15) - 1);
      let candidate = sha[key];
      let depth = 0;
      while (candidate >= 0 && depth < 24) {
        const distance = at - candidate;
        if (distance > 32768) break;
        let span = 0;
        const most = length - at > 258 ? 258 : length - at;
        while (span < most && raw[candidate + span] === raw[at + span]) span += 1;
        if (span > bestLength) {
          bestLength = span;
          bestDistance = distance;
          if (span >= 258) break;
        }
        candidate = chain[candidate];
        depth += 1;
      }
      chain[at] = sha[key];
      sha[key] = at;
    }

    if (bestLength >= 3) {
      const literal = findLength(bestLength);
      writeCode(FIXED_LITERAL_CODES[257 + literal], FIXED_LITERAL_LENGTHS[257 + literal]);
      if (LENGTH_EXTRA[literal] > 0) write(bestLength - LENGTH_BASE[literal], LENGTH_EXTRA[literal]);
      const distance = findDistance(bestDistance);
      writeCode(FIXED_DISTANCE_CODES[distance], 5);
      if (DIST_EXTRA[distance] > 0) write(bestDistance - DIST_BASE[distance], DIST_EXTRA[distance]);
      // Every position inside the match still has to enter the hash chain, or
      // the next match would not be able to start in the middle of this one.
      for (let step = 1; step < bestLength; step += 1) {
        const position = at + step;
        if (position <= limit) {
          const key = ((raw[position] << 10) ^ (raw[position + 1] << 5) ^ raw[position + 2]) & ((1 << 15) - 1);
          chain[position] = sha[key];
          sha[key] = position;
        }
      }
      at += bestLength;
    } else {
      writeCode(FIXED_LITERAL_CODES[raw[at]], FIXED_LITERAL_LENGTHS[raw[at]]);
      at += 1;
    }
  }

  writeCode(FIXED_LITERAL_CODES[256], FIXED_LITERAL_LENGTHS[256]); // end of block
  if (held > 0) output.push(buffer & 0xff);
  return Uint8Array.from(output);
}

function chunk(type, body) {
  const out = new Uint8Array(body.length + 12);
  out[0] = (body.length >>> 24) & 0xff;
  out[1] = (body.length >>> 16) & 0xff;
  out[2] = (body.length >>> 8) & 0xff;
  out[3] = body.length & 0xff;
  for (let i = 0; i < 4; i += 1) out[4 + i] = type.charCodeAt(i);
  out.set(body, 8);
  const check = crc32(out.subarray(4, 8 + body.length));
  out[8 + body.length] = (check >>> 24) & 0xff;
  out[9 + body.length] = (check >>> 16) & 0xff;
  out[10 + body.length] = (check >>> 8) & 0xff;
  out[11 + body.length] = check & 0xff;
  return out;
}

/* ------------------------------------------------------------- planning */

/**
 * A pixel's four bytes as one Map key.  A palette entry and a pixel are the
 * same key, which is what lets a save find the entry a pixel names without a
 * linear search per pixel; `>>> 0` keeps red's high bit from making the same
 * colour two different numbers.
 */
function pixelKey(pixels, at) {
  return ((pixels[at] << 24) | (pixels[at + 1] << 16) | (pixels[at + 2] << 8) | pixels[at + 3]) >>> 0;
}

function optionalBytes(value, name) {
  if (value === undefined || value === null) return null;
  if (!(value instanceof Uint8Array)) throw new Error(`damaged image: format.${name} is not a Uint8Array`);
  return value;
}

/** The one shape always available: 8-bit RGBA, not interlaced, no palette. */
function rgbaPlan() {
  return { colour: 6, depth: 8, interlace: 0, channels: 4, palette: null, paletteAlpha: null, transparent: null, index: null };
}

function plainPlan(colour, depth, interlace, channels, palette, transparent) {
  return { colour, depth, interlace, channels, palette, paletteAlpha: null, transparent, index: null };
}

/**
 * RGB at its source depth, or null when the card's pixels need an alpha the
 * colour type cannot carry.
 *
 * Every pixel must be opaque or transparent as a whole: RGB has no alpha
 * channel, so an alpha of 0 can only mean "this exact colour is the tRNS key",
 * and a partly transparent pixel is not representable at all.  The same check
 * runs in both directions -- an opaque pixel that happens to equal the key
 * would be punched out on the next read, and a transparent pixel that does not
 * equal it would come back opaque -- so either one is a fallback, not a guess.
 */
function rgbPlan(depth, interlace, palette, transparent, pixels) {
  if (transparent !== null && transparent.length !== 6) {
    throw new Error(`damaged image: a colour type 2 format carries ${transparent.length} bytes of tRNS, not 6`);
  }
  // A 16-bit key cannot be re-named: two samples that differ only in the low
  // seven bits decode to the same byte, so "which pixels were transparent" is
  // no longer recoverable from the card.  RGBA8 stores what the card did see.
  if (depth === 16 && transparent !== null) return null;
  let key = null;
  if (transparent !== null) {
    key = [
      toByte((transparent[0] << 8) | transparent[1], depth),
      toByte((transparent[2] << 8) | transparent[3], depth),
      toByte((transparent[4] << 8) | transparent[5], depth),
    ];
  }
  for (let at = 0; at < pixels.length; at += 4) {
    const alpha = pixels[at + 3];
    const hit = key !== null && pixels[at] === key[0] && pixels[at + 1] === key[1] && pixels[at + 2] === key[2];
    if (alpha !== 0 && alpha !== 255) return null;
    if (alpha === 0 && !hit) return null;
    if (alpha === 255 && hit) return null;
  }
  let body = null;
  if (key !== null) {
    body = new Uint8Array(6);
    for (let channel = 0; channel < 3; channel += 1) {
      const sample = fromByte(key[channel], depth);
      body[channel * 2] = (sample >>> 8) & 0xff;
      body[channel * 2 + 1] = sample & 0xff;
    }
  }
  return plainPlan(2, depth, interlace, 3, palette, body);
}

/**
 * Grey at its source depth, or null.
 *
 * Two things have to still hold: every pixel is grey, and its byte is one the
 * depth can actually store -- 1 bit holds 0/255, 2 bits 0/85/170/255, 4 bits
 * multiples of 17.  The scale test is `byte * (2^depth - 1) % 255 === 0`, which
 * is those three sets and is vacuously true at 8 and 16 bits.
 */
function greyPlan(depth, interlace, transparent, pixels) {
  if (transparent !== null && transparent.length !== 2) {
    throw new Error(`damaged image: a colour type 0 format carries ${transparent.length} bytes of tRNS, not 2`);
  }
  if (depth === 16 && transparent !== null) return null;
  const scale = (1 << depth) - 1;
  let key = null;
  if (transparent !== null) key = toByte((transparent[0] << 8) | transparent[1], depth);
  for (let at = 0; at < pixels.length; at += 4) {
    if (pixels[at] !== pixels[at + 1] || pixels[at] !== pixels[at + 2]) return null;
    if ((pixels[at] * scale) % 255 !== 0) return null;
    const alpha = pixels[at + 3];
    const hit = key !== null && pixels[at] === key;
    if (alpha !== 0 && alpha !== 255) return null;
    if (alpha === 0 && !hit) return null;
    if (alpha === 255 && hit) return null;
  }
  let body = null;
  if (key !== null) {
    const sample = fromByte(key, depth);
    body = new Uint8Array([(sample >>> 8) & 0xff, sample & 0xff]);
  }
  return plainPlan(0, depth, interlace, 1, null, body);
}

/** Grey+alpha at 8 or 16 bits, or null when a pixel is not grey. */
function greyAlphaPlan(depth, interlace, transparent, pixels) {
  if (transparent !== null) throw new Error("damaged image: a colour type 4 format carries a tRNS chunk");
  for (let at = 0; at < pixels.length; at += 4) {
    if (pixels[at] !== pixels[at + 1] || pixels[at] !== pixels[at + 2]) return null;
  }
  return plainPlan(4, depth, interlace, 2, null, null);
}

/**
 * A palette, or null when the image needs more than 256 colours.
 *
 * The source entries are kept in order -- unused ones included, so a file the
 * card did not edit re-emits its own PLTE byte for byte -- and a colour the
 * card introduced is appended, in the order it was first seen.  tRNS keeps an
 * alpha byte per entry up to the last one below 255; the trailing 255s are
 * implied by the format and are not written.  The bit depth stays the source's
 * unless the appended entries no longer fit, and only then is it widened.
 */
function palettePlan(depth, interlace, palette, paletteAlpha, pixels) {
  if (palette === null) throw new Error("damaged image: a colour type 3 format has no palette");
  if (palette.length === 0 || palette.length % 3 !== 0 || palette.length > 768) {
    throw new Error(`damaged image: PLTE carries ${palette.length} bytes, which is not 3 to 768 in steps of 3`);
  }
  const entries = palette.length / 3;
  if (paletteAlpha !== null && paletteAlpha.length > entries) {
    throw new Error(`damaged image: tRNS names ${paletteAlpha.length} alphas for a ${entries}-entry PLTE`);
  }
  const keys = [];
  const index = new Map();
  for (let i = 0; i < entries; i += 1) {
    const alpha = paletteAlpha !== null && i < paletteAlpha.length ? paletteAlpha[i] : 255;
    const key = ((palette[i * 3] << 24) | (palette[i * 3 + 1] << 16) | (palette[i * 3 + 2] << 8) | alpha) >>> 0;
    keys.push(key);
    if (!index.has(key)) index.set(key, i);
  }
  for (let at = 0; at < pixels.length; at += 4) {
    const key = pixelKey(pixels, at);
    if (index.has(key)) continue;
    if (keys.length >= 256) return null;
    index.set(key, keys.length);
    keys.push(key);
  }
  const needed = keys.length <= 2 ? 1 : keys.length <= 4 ? 2 : keys.length <= 16 ? 4 : 8;
  const body = new Uint8Array(keys.length * 3);
  const alpha = new Uint8Array(keys.length);
  for (let i = 0; i < keys.length; i += 1) {
    body[i * 3] = (keys[i] >>> 24) & 0xff;
    body[i * 3 + 1] = (keys[i] >>> 16) & 0xff;
    body[i * 3 + 2] = (keys[i] >>> 8) & 0xff;
    alpha[i] = keys[i] & 0xff;
  }
  let kept = keys.length;
  while (kept > 0 && alpha[kept - 1] === 255) kept -= 1;
  return {
    colour: 3,
    depth: Math.max(depth, needed),
    interlace,
    channels: 1,
    palette: body,
    paletteAlpha: kept === 0 ? null : alpha.slice(0, kept),
    transparent: null,
    index,
  };
}

/**
 * The shape a save should use: the source format when every pixel still fits
 * it, and 8-bit RGBA when it does not.
 */
function planFormat(image, pixels, width, height) {
  const format = image.format;
  if (format === undefined || format === null) return rgbaPlan();
  if (typeof format !== "object") throw new Error(`damaged image: format is ${typeof format}, not an object`);
  const colour = format.colourType;
  const depth = format.bitDepth;
  const interlace = format.interlace;
  const depths = COLOUR_DEPTHS[colour];
  if (depths === undefined) throw new Error(`damaged image: format colour type ${colour} is not 0, 2, 3, 4 or 6`);
  if (!depths.includes(depth)) throw new Error(`damaged image: format bit depth ${depth} for colour type ${colour}`);
  if (interlace !== 0 && interlace !== 1) throw new Error(`damaged image: format interlace ${interlace} is not 0 or 1`);
  const palette = optionalBytes(format.palette, "palette");
  const paletteAlpha = optionalBytes(format.paletteAlpha, "paletteAlpha");
  const transparent = optionalBytes(format.transparent, "transparent");
  if ((colour === 0 || colour === 4) && palette !== null) {
    throw new Error(`damaged image: a colour type ${colour} format carries a PLTE`);
  }
  if ((colour === 4 || colour === 6) && transparent !== null) {
    throw new Error(`damaged image: a colour type ${colour} format carries a tRNS chunk`);
  }
  let plan = null;
  if (colour === 6) plan = plainPlan(6, depth, interlace, 4, palette, null);
  else if (colour === 2) plan = rgbPlan(depth, interlace, palette, transparent, pixels);
  else if (colour === 0) plan = greyPlan(depth, interlace, transparent, pixels);
  else if (colour === 4) plan = greyAlphaPlan(depth, interlace, transparent, pixels);
  else plan = palettePlan(depth, interlace, palette, paletteAlpha, pixels);
  return plan === null ? rgbaPlan() : plan;
}

/**
 * The filtered byte stream: for each pass, a zero filter byte and then the
 * samples for that pass's pixels.
 *
 * One bit accumulator serves every depth, so a 4-bit grey pixel and a 16-bit
 * RGBA sample go through the same shift; the depth-specific part is only how
 * many bits one sample occupies, and the trailing byte of a sub-byte row is
 * padded with zeros as the format requires.  The row order and the pixel
 * coordinates are `passLayout`'s, the same list the reader walks, so an
 * interlaced file written from an interlaced source carries its pixels to the
 * places the reader will look for them.
 */
function gatherRows(pixels, width, height, plan) {
  const layout = passLayout(width, height, plan);
  let total = 0;
  for (const pass of layout) total += (pass.stride + 1) * pass.height;
  const out = new Uint8Array(total);
  let at = 0;
  for (const pass of layout) {
    for (let py = 0; py < pass.height; py += 1) {
      out[at] = 0; // filter type none, like every row this writer has emitted
      at += 1;
      const y = pass.y0 + py * pass.dy;
      let acc = 0;
      let held = 0;
      const put = (value, bits) => {
        acc = (acc << bits) | value;
        held += bits;
        while (held >= 8) {
          held -= 8;
          out[at] = (acc >>> held) & 0xff;
          at += 1;
        }
      };
      for (let px = 0; px < pass.width; px += 1) {
        const base = (y * width + pass.x0 + px * pass.dx) * 4;
        if (plan.colour === 3) {
          const index = plan.index.get(pixelKey(pixels, base));
          if (index === undefined) throw new Error("damaged image: a pixel has no palette entry");
          put(index, plan.depth);
          continue;
        }
        const depth = plan.depth;
        if (plan.colour === 0) {
          put(fromByte(pixels[base], depth), depth);
        } else if (plan.colour === 4) {
          put(fromByte(pixels[base], depth), depth);
          put(fromByte(pixels[base + 3], depth), depth);
        } else if (plan.colour === 2) {
          put(fromByte(pixels[base], depth), depth);
          put(fromByte(pixels[base + 1], depth), depth);
          put(fromByte(pixels[base + 2], depth), depth);
        } else {
          put(fromByte(pixels[base], depth), depth);
          put(fromByte(pixels[base + 1], depth), depth);
          put(fromByte(pixels[base + 2], depth), depth);
          put(fromByte(pixels[base + 3], depth), depth);
        }
      }
      if (held > 0) {
        out[at] = (acc << (8 - held)) & 0xff;
        at += 1;
      }
    }
  }
  return out;
}

/**
 * The image as a PNG, in the format it arrived in when that format can still
 * hold every pixel, and as 8-bit RGBA when it cannot.
 *
 * The returned file and its source share a colour type and bit depth whenever
 * the pixels allow it: RGB stays RGB, grey stays grey at its own depth, a
 * palette re-emits its PLTE, and RGB/RGBA at 16 bits is written at 16 bits
 * through `byte * 257`, the inverse of the decode map.  Interlace is kept too.
 *
 * The fallback is the shape this writer always knows how to build: colour type
 * 6, depth 8, no interlace, opacity where the source had no alpha.  A caller
 * never has to ask which happened -- `decodePng(encodePng(image))` returns the
 * same pixels either way, and the new image's own `format` says what was
 * written.
 */
export function encodePng(image) {
  if (image === null || typeof image !== "object") throw new Error("an image is needed to encode a PNG");
  const width = Math.floor(Number(image.width));
  const height = Math.floor(Number(image.height));
  if (!(width > 0) || !(height > 0)) throw new Error(`an image needs a positive size, got ${image.width}x${image.height}`);
  const pixels = asBytes(image.pixels);
  if (pixels.length !== width * height * 4) {
    throw new Error(`damaged image: ${width}x${height} needs ${width * height * 4} bytes and the image has ${pixels.length}`);
  }

  const plan = planFormat(image, pixels, width, height);
  const raw = gatherRows(pixels, width, height, plan);

  const body = deflateFixed(raw);
  const stream = new Uint8Array(body.length + 6);
  stream[0] = 0x78; // CM 8 and CINFO 7: deflate over 32 KiB of history
  stream[1] = 0x9c; // the check bits that make 0x789c a multiple of 31
  stream.set(body, 2);
  const sum = adler32(raw);
  stream[body.length + 2] = (sum >>> 24) & 0xff;
  stream[body.length + 3] = (sum >>> 16) & 0xff;
  stream[body.length + 4] = (sum >>> 8) & 0xff;
  stream[body.length + 5] = sum & 0xff;

  const header = new Uint8Array(13);
  header[0] = (width >>> 24) & 0xff;
  header[1] = (width >>> 16) & 0xff;
  header[2] = (width >>> 8) & 0xff;
  header[3] = width & 0xff;
  header[4] = (height >>> 24) & 0xff;
  header[5] = (height >>> 16) & 0xff;
  header[6] = (height >>> 8) & 0xff;
  header[7] = height & 0xff;
  header[8] = plan.depth;
  header[9] = plan.colour;
  header[10] = 0; // compression
  header[11] = 0; // filter
  header[12] = plan.interlace;

  const parts = [PNG_SIGNATURE, chunk("IHDR", header)];
  if (plan.palette !== null) parts.push(chunk("PLTE", plan.palette));
  if (plan.transparent !== null) parts.push(chunk("tRNS", plan.transparent));
  if (plan.paletteAlpha !== null) parts.push(chunk("tRNS", plan.paletteAlpha));
  parts.push(chunk("IDAT", stream), chunk("IEND", new Uint8Array(0)));
  let total = 0;
  for (const part of parts) total += part.length;
  const out = new Uint8Array(total);
  let cursor = 0;
  for (const part of parts) {
    out.set(part, cursor);
    cursor += part.length;
  }
  return out;
}

/* -------------------------------------------------------------- pixels */

/** The RGBA bytes at a point, or `null` when the point is outside the image. */
export function pixelAt(image, x, y) {
  if (image === null || typeof image !== "object") return null;
  const px = Math.floor(Number(x));
  const py = Math.floor(Number(y));
  if (!(px >= 0) || !(py >= 0) || px >= image.width || py >= image.height) return null;
  const at = (py * image.width + px) * 4;
  return [image.pixels[at], image.pixels[at + 1], image.pixels[at + 2], image.pixels[at + 3]];
}

/** Write the RGBA bytes at a point.  Outside the image is a no-op, not an error. */
export function setPixelAt(image, x, y, rgba) {
  if (image === null || typeof image !== "object") return;
  const px = Math.floor(Number(x));
  const py = Math.floor(Number(y));
  if (!(px >= 0) || !(py >= 0) || px >= image.width || py >= image.height) return;
  const colour = rgba === null || rgba === undefined ? [] : rgba;
  const at = (py * image.width + px) * 4;
  for (let i = 0; i < 4; i += 1) {
    const value = colour[i];
    if (value !== undefined && value !== null) image.pixels[at + i] = Number(value) & 0xff;
  }
}
