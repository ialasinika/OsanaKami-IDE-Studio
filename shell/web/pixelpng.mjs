// A PNG reader and writer, hand-written down to the bit level.
//
// Deliberately imports nothing and touches no DOM, so it runs under Node for
// tests and in the page for the editor.  There is no `zlib` to reach for in a
// browser page anyway, so everything the format needs -- the CRC-32 of a chunk,
// the Adler-32 of the stream, the DEFLATE codec, the five row filters -- is
// implemented here.  Where `storycsv.mjs` hand-writes SHA-256 for the same
// reason, this hand-writes DEFLATE.
//
// What the real files are, measured on all 374 `.png` under `..\Mods`:
//
//   * every one is bit depth 8, interlace 0; 365 are colour type 6 (RGBA) and
//     9 are colour type 2 (RGB).  Those two are what `decodePng` accepts and
//     nothing else -- no palette, no 16-bit, no Adam7.
//   * the DEFLATE stream is not all one shape.  Counting blocks across those
//     374 streams: 3 are stored, 162 are fixed-Huffman and 249 are dynamic,
//     so a reader that only handles the compressed kinds (or only the stored
//     kind) fails on real files rather than on a contrived one.
//   * all five row filters occur (21519 none, 706 sub, 13593 up, 6 average,
//     2340 Paeth), so the predictor is load-bearing, not decoration.
//   * the zlib header's check bits are 0/31 in all 374, and the stream's
//     Adler-32 matches the decompressed bytes in all 374 -- which is what makes
//     those two the cheapest real-damage detectors available.

/** The eight bytes every PNG starts with. */
export const PNG_SIGNATURE = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

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
  if (depth !== 8) throw new Error(`unsupported PNG: bit depth ${depth}, only 8 is read`);
  if (colour !== 6 && colour !== 2) {
    throw new Error(`unsupported PNG: colour type ${colour}, only 6 (RGBA) and 2 (RGB) are read`);
  }
  if (compression !== 0) throw new Error(`unsupported PNG: compression method ${compression}, only 0 is defined`);
  if (filter !== 0) throw new Error(`unsupported PNG: filter method ${filter}, only 0 is defined`);
  if (interlace !== 0) throw new Error(`unsupported PNG: interlace ${interlace}, only 0 (none) is read`);
  return { width, height, colour, channels: colour === 6 ? 4 : 3 };
}

function readInt32(bytes, at) {
  return (bytes[at] << 24) | (bytes[at + 1] << 16) | (bytes[at + 2] << 8) | bytes[at + 3];
}

/** The bytes of every IDAT chunk, in order, with the rest of the file checked. */
function readChunks(bytes) {
  const parts = [];
  let total = 0;
  let inImageData = false;
  let sawHeader = false;
  let sawEnd = false;
  let at = 8;
  while (at + 12 <= bytes.length) {
    const length = readInt32(bytes, at);
    if (length < 0) throw new Error("damaged PNG: a chunk length with the top bit set");
    const type = String.fromCharCode(bytes[at + 4], bytes[at + 5], bytes[at + 6], bytes[at + 7]);
    if (at + 12 + length > bytes.length) {
      throw new Error(`damaged PNG: the ${type} chunk is truncated`);
    }
    if (!sawHeader && type !== "IHDR") throw new Error(`damaged PNG: the first chunk is ${type}, not IHDR`);
    if (type === "IHDR") {
      if (sawHeader) throw new Error("damaged PNG: a second IHDR chunk");
      if (length !== 13) throw new Error(`damaged PNG: IHDR is ${length} bytes, not 13`);
      sawHeader = true;
    } else if (type === "IDAT") {
      if (inImageData === false) inImageData = true;
      const part = bytes.subarray(at + 8, at + 8 + length);
      parts.push(part);
      total += length;
    } else if (type === "IEND") {
      if (length !== 0) throw new Error(`damaged PNG: IEND carries ${length} bytes`);
      sawEnd = true;
      break;
    } else if (inImageData) {
      // The format requires the image data to be one run of IDAT chunks; a
      // chunk wedged between two of them means the file is not one this reader
      // can trust to have read every byte of the stream.
      throw new Error(`damaged PNG: a ${type} chunk interrupts the image data`);
    }
    at += 12 + length;
  }
  if (!sawHeader) throw new Error("damaged PNG: no IHDR chunk");
  if (!sawEnd) throw new Error("damaged PNG: no IEND chunk");
  if (parts.length === 0) throw new Error("damaged PNG: no IDAT chunk");
  const idat = new Uint8Array(total);
  let cursor = 0;
  for (const part of parts) {
    idat.set(part, cursor);
    cursor += part.length;
  }
  return idat;
}

/**
 * Undo the five row filters, in place.
 *
 * `left` is the byte `stride` to the left -- four bytes for RGBA, three for
 * RGB -- and this is the one stride in the format that has nothing to do with
 * the row length: the predictor always steps by one *pixel*.  Using the row
 * length here is the classic silent corruption: every row decodes to plausible
 * bytes and only the picture is wrong.
 */
function unfilter(image, raw, stride, height) {
  const pixels = image.pixels;
  const bpp = stride === 0 ? 1 : image.channels;
  let from = 0;
  let to = 0;
  for (let y = 0; y < height; y += 1) {
    const kind = raw[from];
    from += 1;
    const row = pixels.subarray(to, to + stride);
    const above = to >= stride ? pixels.subarray(to - stride, to) : null;
    if (kind === 0) {
      row.set(raw.subarray(from, from + stride));
    } else if (kind === 1) {
      for (let i = 0; i < stride; i += 1) {
        const left = i >= bpp ? row[i - bpp] : 0;
        row[i] = (raw[from + i] + left) & 0xff;
      }
    } else if (kind === 2) {
      for (let i = 0; i < stride; i += 1) {
        const up = above === null ? 0 : above[i];
        row[i] = (raw[from + i] + up) & 0xff;
      }
    } else if (kind === 3) {
      for (let i = 0; i < stride; i += 1) {
        const left = i >= bpp ? row[i - bpp] : 0;
        const up = above === null ? 0 : above[i];
        row[i] = (raw[from + i] + ((left + up) >> 1)) & 0xff;
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
        row[i] = (raw[from + i] + guess) & 0xff;
      }
    } else {
      throw new Error(`damaged PNG: row ${y} has filter type ${kind}, which is not one of the five`);
    }
    from += stride;
    to += stride;
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
 * The image in a PNG, as RGBA whatever the file's colour type was.  An RGB
 * file becomes opaque: the format has no alpha channel to carry over, and 0
 * there would turn every such image into a transparent hole.
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
  const idat = readChunks(data);

  // The zlib header, then the DEFLATE stream it wraps.
  if (idat.length < 6) throw new Error(`damaged PNG: the image data is ${idat.length} bytes, too short for a zlib stream`);
  const method = idat[0] & 0x0f;
  const window_ = (idat[0] >> 4) & 0x0f;
  if (method !== 8) throw new Error(`damaged PNG: the zlib stream uses compression method ${method}`);
  if (window_ > 7) throw new Error(`damaged PNG: the zlib stream asks for a ${1 << (window_ + 8)}-byte history`);
  if (((idat[0] << 8) | idat[1]) % 31 !== 0) {
    throw new Error(`damaged PNG: the zlib header's check bits do not sum to a multiple of 31 (${idat[0]}, ${idat[1]})`);
  }

  const stride = header.width * header.channels;
  const expected = (stride + 1) * header.height;
  const raw = inflate(idat, 2, idat.length - 4, expected);

  const declared = u32(idat, idat.length - 4);
  const actual = adler32(raw);
  if (declared !== actual) {
    throw new Error(`damaged PNG: the stream's Adler-32 is ${declared.toString(16)} where its bytes give ${actual.toString(16)}`);
  }

  const image = {
    width: header.width,
    height: header.height,
    channels: header.channels,
    pixels: new Uint8Array(header.width * header.height * 4),
  };
  unfilter(image, raw, stride, header.height);

  if (header.channels === 4) return { width: image.width, height: image.height, pixels: image.pixels };

  // Expand 3 bytes per pixel to 4.  Walking backwards keeps the read and the
  // write from lapping each other, which a forward pass would not.
  const rgba = new Uint8Array(header.width * header.height * 4);
  for (let count = header.width * header.height - 1; count >= 0; count -= 1) {
    const at = count * 3;
    const to = count * 4;
    rgba[to] = image.pixels[at];
    rgba[to + 1] = image.pixels[at + 1];
    rgba[to + 2] = image.pixels[at + 2];
    rgba[to + 3] = 255;
  }
  return { width: image.width, height: image.height, pixels: rgba };
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

/**
 * The image as a PNG: 8-bit RGBA, colour type 6, no interlace, every row
 * filtered as `none`.  Never any other shape, so the colour type in the header
 * and the four bytes per pixel in the stream cannot drift apart.
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

  const stride = width * 4;
  const raw = new Uint8Array((stride + 1) * height);
  for (let y = 0; y < height; y += 1) {
    raw[y * (stride + 1)] = 0; // filter type none
    raw.set(pixels.subarray(y * stride, (y + 1) * stride), y * (stride + 1) + 1);
  }

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
  header[8] = 8; // bit depth
  header[9] = 6; // colour type RGBA
  header[10] = 0; // compression
  header[11] = 0; // filter
  header[12] = 0; // interlace

  const parts = [
    PNG_SIGNATURE,
    chunk("IHDR", header),
    chunk("IDAT", stream),
    chunk("IEND", new Uint8Array(0)),
  ];
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
