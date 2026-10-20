/* ------------------------------------------------------------------ */
/* a PNG is a file, and the pixel card's colour opinion
/* ------------------------------------------------------------------ */

import assert from "node:assert/strict";
import {
  readFileSync,
} from "node:fs";
import {
  deflateSync,
  inflateSync,
} from "node:zlib";
import {
  pixelColourOf,
  pixelInkOf,
  pixelPaletteOf,
} from "../cards.mjs";
import {
  PNG_SIGNATURE,
  blankImage,
  decodePng,
  encodePng,
  pixelAt,
  setPixelAt,
} from "../pixelpng.mjs";
import {
  centrePan,
  framedPan,
  insideView,
  visible,
  zoomAt,
} from "../pixelview.mjs";
import {
  applyMatrix,
  bezierValue,
  easeFraction,
  frameWindow,
  localPoses,
  mergedSkins,
  regionCorners,
  sceneAt,
  slotAttachmentName,
  slotColorAt,
  worldTransforms,
} from "../spinepose.mjs";
import {
  test,
} from "./harness.mjs";

/* ------------------------------------------------------------------ */
/* a PNG is a file, and reading one is the page's own job               */
/* ------------------------------------------------------------------ */

/*
 * The fixtures were written by an independent writer
 * (`build/make_pixel_fixtures.mjs`, which deflates with the platform zlib and
 * computes its own CRCs instead of asking this module): a 4x5 RGBA image whose
 * five rows use filter types 0..4 in turn, the same image deflated into stored
 * blocks, a 2x1 RGB image with no alpha channel, and one real 6x3 export out of
 * the mod corpus. A decoder that inherited this module's bugs cannot have
 * inherited the fixtures too.
 */
export const PNG_FILTERED = "iVBORw0KGgoAAAANSUhEUgAAAAQAAAAFCAYAAABirU3bAAAAPElEQVR42mNgYGD4b8Mq+K2CS+ntFn7jJ4zcRuLfbFgFv8MwE7eR+HdkzCyWopenIiPyHYZZwDKsgnAMAEvvGZivNw1JAAAAAElFTkSuQmCC";
export const PNG_STORED = "iVBORw0KGgoAAAANSUhEUgAAAAQAAAAFCAYAAABirU3bAAAAYElEQVR4AQFVAKr/AAAAAP88BRH2eAoi7bQPM+QBCzIX9jwFEfc8BRH3PAUR9wILMhf3CzIX9wsyF/cLMhf3AxZkLm4kHBT3JBwU9yQcFPcECzIX9wsFEfcLBRH3CwUR90vvGZjdUsDJAAAAAElFTkSuQmCC";
export const PNG_RGB = "iVBORw0KGgoAAAANSUhEUgAAAAIAAAABCAIAAAB7QOjdAAAAD0lEQVR42mPgEpE7MS0FAAUHAf+/Bwq6AAAAAElFTkSuQmCC";
export const PNG_CORPUS = "iVBORw0KGgoAAAANSUhEUgAAAAYAAAADCAYAAACwAX77AAAAFUlEQVR4XmNgwAfq49L/w2gYGycAAPfpBspw35zwAAAAAElFTkSuQmCC";

export const pngBytes = (base64) => new Uint8Array(Buffer.from(base64, "base64"));

/* What went into PNG_FILTERED, worked out here from the formula the fixture
   writer used. The numbers come from the arithmetic, not from the module, so a
   decoder that is merely self-consistent still fails this. */
export function pngFilteredPixels() {
  const expected = new Uint8Array(4 * 5 * 4);
  for (let y = 0; y < 5; y += 1) {
    for (let x = 0; x < 4; x += 1) {
      const at = (y * 4 + x) * 4;
      expected[at] = (x * 60 + y * 11) % 256;
      expected[at + 1] = (x * 5 + y * 50) % 256;
      expected[at + 2] = (x * 17 + y * 23) % 256;
      expected[at + 3] = 255 - (x + y) * 9;
    }
  }
  return expected;
}

export const PNG_CRC_TABLE = (() => {
  const table = new Int32Array(256);
  for (let n = 0; n < 256; n += 1) {
    let c = n;
    for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c;
  }
  return table;
})();

export function pngCrc32(bytes) {
  let c = 0xffffffff;
  for (const byte of bytes) c = PNG_CRC_TABLE[(c ^ byte) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

/*
 * A writer of PNGs that shares nothing with the module under test: the bytes
 * below are packed here, deflated by the platform zlib and stamped with the
 * CRC above.  `pngFile` takes the filtered stream already built, so a test
 * decides exactly what a damaged or unusual file looks like.
 */
export function pngJoin(parts) {
  let total = 0;
  for (const part of parts) total += part.length;
  const out = new Uint8Array(total);
  let at = 0;
  for (const part of parts) {
    out.set(part, at);
    at += part.length;
  }
  return out;
}

export function pngChunk(type, body) {
  const out = new Uint8Array(body.length + 12);
  const view = new DataView(out.buffer);
  view.setUint32(0, body.length);
  for (let i = 0; i < 4; i += 1) out[4 + i] = type.charCodeAt(i);
  out.set(body, 8);
  view.setUint32(8 + body.length, pngCrc32(out.subarray(4, 8 + body.length)));
  return out;
}

export function pngFile({
  width, height, depth, colour,
  interlace = 0,
  palette = null,
  paletteAlpha = null,
  transparent = null,
  raw,
  extra = [],
}) {
  const ihdr = new Uint8Array(13);
  const view = new DataView(ihdr.buffer);
  view.setUint32(0, width);
  view.setUint32(4, height);
  ihdr[8] = depth;
  ihdr[9] = colour;
  ihdr[10] = 0; // compression
  ihdr[11] = 0; // filter
  ihdr[12] = interlace;
  const parts = [PNG_SIGNATURE, pngChunk("IHDR", ihdr)];
  if (palette !== null) parts.push(pngChunk("PLTE", new Uint8Array(palette)));
  if (paletteAlpha !== null) parts.push(pngChunk("tRNS", new Uint8Array(paletteAlpha)));
  if (transparent !== null) parts.push(pngChunk("tRNS", new Uint8Array(transparent)));
  for (const chunk of extra) parts.push(chunk);
  parts.push(pngChunk("IDAT", new Uint8Array(deflateSync(Buffer.from(raw)))));
  parts.push(pngChunk("IEND", new Uint8Array(0)));
  return pngJoin(parts);
}

/* The seven Adam7 passes, copied here from the format so the test's idea of
   the layout is not the module's. */
export const PNG_PASSES = [
  { x0: 0, y0: 0, dx: 8, dy: 8 },
  { x0: 4, y0: 0, dx: 8, dy: 8 },
  { x0: 0, y0: 4, dx: 4, dy: 8 },
  { x0: 2, y0: 0, dx: 4, dy: 4 },
  { x0: 0, y0: 2, dx: 2, dy: 4 },
  { x0: 1, y0: 0, dx: 2, dy: 2 },
  { x0: 0, y0: 1, dx: 1, dy: 2 },
];

export function pngPassCount(size, start, step) {
  return size <= start ? 0 : Math.ceil((size - start) / step);
}

/** Samples packed MSB-first for depths 1/2/4 (identical to the bytes at 8). */
export function pngBits(samples, depth) {
  const out = new Uint8Array(Math.ceil((samples.length * depth) / 8));
  let bit = 0;
  for (const sample of samples) {
    out[bit >> 3] |= sample << (8 - depth - (bit & 7));
    bit += depth;
  }
  return out;
}

/** Sixteen-bit samples, big-endian, no scaling. */
export function pngWords(samples) {
  const out = new Uint8Array(samples.length * 2);
  samples.forEach((sample, index) => {
    out[index * 2] = (sample >>> 8) & 0xff;
    out[index * 2 + 1] = sample & 0xff;
  });
  return out;
}

/** Rows of packed samples, each behind a filter-type-0 byte. */
export function pngRaw(rows) {
  return pngJoin(rows.map((row) => pngJoin([new Uint8Array([0]), row])));
}

export function pngChunksOf(bytes) {
  const found = [];
  for (let at = 8; at + 12 <= bytes.length;) {
    const length = ((bytes[at] << 24) | (bytes[at + 1] << 16) | (bytes[at + 2] << 8) | bytes[at + 3]) >>> 0;
    const type = String.fromCharCode(bytes[at + 4], bytes[at + 5], bytes[at + 6], bytes[at + 7]);
    found.push({ type, data: bytes.slice(at + 8, at + 8 + length) });
    at += 12 + length;
  }
  return found;
}

export function pngChunkOf(bytes, type) {
  return pngChunksOf(bytes).find((chunk) => chunk.type === type) ?? null;
}

export function pngRawOf(bytes) {
  return new Uint8Array(inflateSync(Buffer.from(pngChunkOf(bytes, "IDAT").data)));
}

/* A 3x3 RGB8 image for the Adam7 check: every pixel a different colour. */
export function adam7Pixels(width, height) {
  const rgb = [];
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) rgb.push(x * 40 + 1, y * 50 + 2, x * 10 + y * 7);
  }
  return rgb;
}

/* The same image as the filtered stream an interlaced encoder must produce:
   the passes in order, each row a filter byte and its pixels. */
export function adam7Raw(rgb, width, height) {
  const rows = [];
  for (const pass of PNG_PASSES) {
    const columns = pngPassCount(width, pass.x0, pass.dx);
    if (columns === 0) continue;
    const lines = pngPassCount(height, pass.y0, pass.dy);
    for (let line = 0; line < lines; line += 1) {
      const y = pass.y0 + line * pass.dy;
      const row = new Uint8Array(1 + columns * 3);
      for (let column = 0; column < columns; column += 1) {
        const x = pass.x0 + column * pass.dx;
        const from = (y * width + x) * 3;
        row[1 + column * 3] = rgb[from];
        row[2 + column * 3] = rgb[from + 1];
        row[3 + column * 3] = rgb[from + 2];
      }
      rows.push(row);
    }
  }
  return pngJoin(rows);
}

test("pixelpng: the module imports nothing, reads no clock and touches no DOM", () => {
  const code = readFileSync(new URL("../pixelpng.mjs", import.meta.url), "utf8");
  assert.equal(/^\s*import\b/m.test(code), false, "no imports");
  assert.equal(/\bwindow\b|\bdocument\b|\blocalStorage\b/.test(code), false, "no DOM");
  assert.equal(/Math\.random|Date\.now|new Date\(/.test(code), false, "no clock, no randomness");
});

test("pixelpng: a blank image is the size asked for, and transparent", () => {
  const blank = blankImage(3, 2);
  assert.equal(blank.width, 3);
  assert.equal(blank.height, 2);
  assert.equal(blank.pixels.length, 24, "three by two, four channels each");
  assert.equal(blank.pixels.every((byte) => byte === 0), true);
  const red = blankImage(2, 1, [255, 0, 0, 255]);
  assert.deepEqual(pixelAt(red, 0, 0), [255, 0, 0, 255]);
  assert.deepEqual(pixelAt(red, 1, 0), [255, 0, 0, 255]);
});

test("pixelpng: a pixel outside the image is null, and writing one is a no-op", () => {
  const image = blankImage(2, 1);
  assert.equal(pixelAt(image, -1, 0), null);
  assert.equal(pixelAt(image, 2, 0), null);
  assert.equal(pixelAt(image, 0, 1), null);
  setPixelAt(image, 9, 9, [1, 2, 3, 4]);
  assert.equal(image.pixels.every((byte) => byte === 0), true, "nothing was written");
  setPixelAt(image, 1, 0, [9, 8, 7, 6]);
  assert.deepEqual(pixelAt(image, 1, 0), [9, 8, 7, 6]);
  assert.deepEqual(pixelAt(image, 0, 0), [0, 0, 0, 0], "its neighbour is untouched");
});

test("pixelpng: all five row filters decode to the pixels that went in", () => {
  const expected = pngFilteredPixels();
  const decoded = decodePng(pngBytes(PNG_FILTERED));
  assert.equal(decoded.width, 4);
  assert.equal(decoded.height, 5);
  assert.deepEqual([...decoded.pixels], [...expected]);
  /* The same pixels, deflated into stored blocks rather than Huffman-coded. */
  assert.deepEqual([...decodePng(pngBytes(PNG_STORED)).pixels], [...expected]);
  /* A Node Buffer is as acceptable as a Uint8Array. */
  assert.deepEqual([...decodePng(Buffer.from(PNG_FILTERED, "base64")).pixels], [...expected]);
});

test("pixelpng: a file with no alpha channel decodes opaque", () => {
  const decoded = decodePng(pngBytes(PNG_RGB));
  assert.equal(decoded.width, 2);
  assert.equal(decoded.height, 1);
  assert.deepEqual(pixelAt(decoded, 0, 0), [10, 20, 30, 255], "no alpha byte means fully opaque");
  assert.deepEqual(pixelAt(decoded, 1, 0), [200, 150, 100, 255]);
});

test("pixelpng: a real exporter's file comes back at the size its own header says", () => {
  const bytes = pngBytes(PNG_CORPUS);
  const decoded = decodePng(bytes);
  /* The width and height are read here, out of the raw IHDR, so the decoder is
     not the only witness to its own answer. */
  assert.equal(decoded.width, bytes[19] | (bytes[18] << 8) | (bytes[17] << 16) | (bytes[16] << 24));
  assert.equal(decoded.height, bytes[23] | (bytes[22] << 8) | (bytes[21] << 16) | (bytes[20] << 24));
  assert.equal(decoded.width, 6);
  assert.equal(decoded.height, 3);
  assert.deepEqual([...decodePng(encodePng(decoded)).pixels], [...decoded.pixels]);
});

test("pixelpng: every greyscale depth decodes to the byte its scale names", () => {
  const cases = [
    { depth: 1, samples: [0, 1, 0, 1], expected: [0, 255, 0, 255] },
    { depth: 2, samples: [0, 1, 2, 3], expected: [0, 85, 170, 255] },
    { depth: 4, samples: [0, 7, 15], expected: [0, 119, 255] },
    { depth: 8, samples: [10, 200], expected: [10, 200] },
  ];
  for (const entry of cases) {
    const raw = pngRaw([pngBits(entry.samples, entry.depth)]);
    const file = pngFile({ width: entry.samples.length, height: 1, depth: entry.depth, colour: 0, raw });
    const decoded = decodePng(file);
    assert.equal(decoded.width, entry.samples.length, `${entry.depth}-bit width`);
    assert.deepEqual([...decoded.pixels], entry.expected.flatMap((value) => [value, value, value, 255]),
      `${entry.depth}-bit grey`);
    assert.deepEqual(decoded.format, {
      colourType: 0,
      bitDepth: entry.depth,
      interlace: 0,
      palette: null,
      paletteAlpha: null,
      transparent: null,
    }, `${entry.depth}-bit format is reported`);
  }
});

test("pixelpng: grey+alpha keeps both channels", () => {
  const raw = pngRaw([new Uint8Array([10, 255, 20, 0])]);
  const decoded = decodePng(pngFile({ width: 2, height: 1, depth: 8, colour: 4, raw }));
  assert.deepEqual([...decoded.pixels], [10, 10, 10, 255, 20, 20, 20, 0]);
  assert.equal(decoded.format.colourType, 4);
  assert.equal(decoded.format.bitDepth, 8);
});

test("pixelpng: a palette index becomes its PLTE entry, tRNS and all", () => {
  const palette = [255, 0, 0, 0, 255, 0, 0, 0, 255];
  const file = pngFile({
    width: 3, height: 1, depth: 8, colour: 3,
    palette,
    paletteAlpha: [0, 128],
    raw: pngRaw([new Uint8Array([2, 1, 0])]),
  });
  const decoded = decodePng(file);
  assert.deepEqual([...decoded.pixels], [0, 0, 255, 255, 0, 255, 0, 128, 255, 0, 0, 0]);
  assert.deepEqual([...decoded.format.palette], palette, "the PLTE body is carried, not rebuilt");
  assert.deepEqual([...decoded.format.paletteAlpha], [0, 128], "a short tRNS leaves the rest opaque");
  assert.equal(decoded.format.colourType, 3);
  /* Four-bit indices are packed two to a byte, and an entry with no tRNS byte
     is fully opaque. */
  const four = decodePng(pngFile({
    width: 2, height: 1, depth: 4, colour: 3,
    palette: [10, 20, 30, 40, 50, 60],
    paletteAlpha: [200],
    raw: pngRaw([pngBits([1, 0], 4)]),
  }));
  assert.deepEqual([...four.pixels], [40, 50, 60, 255, 10, 20, 30, 200],
    "tRNS names entries from the front: entry 0 is 200, entry 1 has no byte and stays opaque");
  assert.equal(four.format.bitDepth, 4);
  assert.deepEqual([...four.format.palette], [10, 20, 30, 40, 50, 60]);
  assert.deepEqual([...four.format.paletteAlpha], [200], "a four-bit palette carries a tRNS just the same");
});

test("pixelpng: a sixteen-bit sample is rounded to the byte the card holds", () => {
  const rgb = decodePng(pngFile({
    width: 2, height: 1, depth: 16, colour: 2,
    raw: pngRaw([pngWords([1000, 2000, 3000, 65535, 0, 257])]),
  }));
  /* The expected bytes are round(sample * 255 / 65535), worked out here rather
     than read back from the module. */
  assert.deepEqual([...rgb.pixels], [4, 8, 12, 255, 255, 0, 1, 255]);
  assert.equal(rgb.format.bitDepth, 16);
  assert.equal(rgb.format.colourType, 2);
  const rgba = decodePng(pngFile({
    width: 1, height: 1, depth: 16, colour: 6,
    raw: pngRaw([pngWords([0, 257, 65535, 32896])]),
  }));
  assert.deepEqual([...rgba.pixels], [0, 1, 255, 128], "257 and 32896 are multiples of 257, so exact");
});

test("pixelpng: an Adam7 file is put back together pixel by pixel", () => {
  const width = 5;
  const height = 4;
  const rgb = adam7Pixels(width, height);
  const decoded = decodePng(pngFile({
    width, height, depth: 8, colour: 2, interlace: 1,
    raw: adam7Raw(rgb, width, height),
  }));
  const expected = [];
  for (let at = 0; at < rgb.length; at += 3) expected.push(rgb[at], rgb[at + 1], rgb[at + 2], 255);
  assert.deepEqual([...decoded.pixels], expected, "every pass lands on its own pixels");
  assert.equal(decoded.format.interlace, 1);
});

test("pixelpng: a malformed or impossible PNG is named, not guessed at", () => {
  const grey = (options) => pngFile({ width: 2, height: 1, depth: 8, colour: 0, raw: pngRaw([new Uint8Array([1, 2])]), ...options });
  assert.throws(() => decodePng(pngFile({
    width: 2, height: 1, depth: 8, colour: 3, palette: null,
    raw: pngRaw([new Uint8Array([0, 1])]),
  })), /damaged PNG: a palette image has no PLTE chunk/, "a palette image needs its PLTE");
  assert.throws(() => decodePng(grey({ interlace: 2 })), /unsupported PNG: interlace 2/,
    "an interlace method the format does not define");
  assert.throws(() => decodePng(pngFile({
    width: 1, height: 1, depth: 4, colour: 2,
    raw: pngRaw([pngBits([0, 0, 0], 4)]),
  })), /unsupported PNG: bit depth 4 for colour type 2/, "RGB has no four-bit form");
  assert.throws(() => decodePng(grey({ transparent: [0, 0, 0] })),
    /damaged PNG: tRNS carries 3 bytes where colour type 0 needs 2/, "a grey tRNS is one sample");
  assert.throws(() => decodePng(pngFile({
    width: 1, height: 1, depth: 8, colour: 3,
    palette: [1, 2, 3, 4, 5, 6],
    raw: pngRaw([new Uint8Array([5])]),
  })), /damaged PNG: palette index 5 is past the 2-entry PLTE/, "an index outside the palette");
  assert.throws(() => decodePng(pngFile({
    width: 1, height: 1, depth: 1, colour: 3,
    palette: [1, 2, 3, 4, 5, 6, 7, 8, 9],
    raw: pngRaw([pngBits([0], 1)]),
  })), /damaged PNG: PLTE has 3 entries where bit depth 1 can address 2/,
  "a palette larger than its depth can index");

  /* A flipped byte in the IDAT body leaves the zlib stream plausible, so the
     chunk CRC is the only thing that catches it. */
  const good = grey({});
  const marker = good.findIndex((byte, index) => index >= 8
    && byte === 0x49 && good[index + 1] === 0x44 && good[index + 2] === 0x41 && good[index + 3] === 0x54);
  const flipped = new Uint8Array(good);
  flipped[marker + 4] ^= 0x01;
  assert.throws(() => decodePng(flipped), /damaged PNG: the IDAT chunk's CRC-32 is/,
    "a corrupt chunk is named by its CRC");

  assert.throws(() => decodePng(Buffer.from("title: T\n---\n")), /not a PNG/);
  assert.throws(() => decodePng(new Uint8Array(2)), /not a PNG/);
  assert.throws(() => decodePng(pngBytes(PNG_FILTERED).slice(0, 40)), /damaged PNG: /,
    "a stream that stops early");
});

test("pixelpng: an RGB file saves as RGB, stream and header unchanged", () => {
  const raw = pngRaw([new Uint8Array([1, 2, 3, 4, 5, 6])]);
  const file = pngFile({ width: 2, height: 1, depth: 8, colour: 2, raw });
  const decoded = decodePng(file);
  const saved = encodePng(decoded);
  assert.deepEqual([...pngChunkOf(saved, "IHDR").data], [...pngChunkOf(file, "IHDR").data], "same IHDR");
  /* The IDAT bytes come from two different compressors, so "the same stream"
     means the bytes after inflating: the row filters and the samples. */
  assert.deepEqual([...pngRawOf(saved)], [...raw], "the same filtered rows");
  assert.equal(pngChunkOf(saved, "PLTE"), null, "no palette was invented");
  const back = decodePng(saved);
  assert.deepEqual([...back.pixels], [...decoded.pixels]);
  assert.equal(back.format.colourType, 2);
  assert.equal(back.format.bitDepth, 8);
  /* An edited pixel is still carried by an RGB file: the card wrote an opaque
     colour, which RGB can hold. */
  setPixelAt(decoded, 1, 0, [9, 9, 9, 255]);
  const edited = decodePng(encodePng(decoded));
  assert.deepEqual(pixelAt(edited, 1, 0), [9, 9, 9, 255]);
  assert.equal(edited.format.colourType, 2);
});

test("pixelpng: a palette file saves its PLTE and tRNS back", () => {
  const palette = [255, 0, 0, 0, 255, 0, 0, 0, 255];
  const file = pngFile({
    width: 3, height: 1, depth: 8, colour: 3,
    palette,
    paletteAlpha: [0, 128],
    raw: pngRaw([new Uint8Array([2, 1, 0])]),
  });
  const decoded = decodePng(file);
  const saved = encodePng(decoded);
  assert.deepEqual([...pngChunkOf(saved, "PLTE").data], palette, "the same entries in the same order");
  assert.deepEqual([...pngChunkOf(saved, "tRNS").data], [0, 128]);
  assert.deepEqual([...decodePng(saved).pixels], [...decoded.pixels]);
  /* A colour the card introduced is appended, and its alpha with it. */
  setPixelAt(decoded, 0, 0, [1, 2, 3, 255]);
  const edited = decodePng(encodePng(decoded));
  assert.deepEqual(pixelAt(edited, 0, 0), [1, 2, 3, 255]);
  assert.equal(edited.format.colourType, 3);
  assert.deepEqual([...edited.format.palette], [...palette, 1, 2, 3], "the new colour is appended");
});

test("pixelpng: sixteen-bit files save at sixteen bits", () => {
  const rgb = decodePng(pngFile({
    width: 2, height: 1, depth: 16, colour: 2,
    raw: pngRaw([pngWords([1000, 2000, 3000, 65535, 0, 257])]),
  }));
  const rgbSaved = encodePng(rgb);
  assert.equal(pngChunkOf(rgbSaved, "IHDR").data[8], 16);
  assert.equal(pngChunkOf(rgbSaved, "IHDR").data[9], 2);
  assert.deepEqual([...decodePng(rgbSaved).pixels], [...rgb.pixels]);
  /* Every sample is written as byte * 257, the inverse of the decode map: the
     low seven bits 1000 never had were lost at decode, not at save. */
  assert.deepEqual([...pngRawOf(rgbSaved)], [...pngRaw([pngWords([1028, 2056, 3084, 65535, 0, 257])])],
    "the sixteen-bit samples are the inverse of the decode map");
  /* A sample that is a multiple of 257 survives exactly. */
  const rgba = decodePng(pngFile({
    width: 1, height: 1, depth: 16, colour: 6,
    raw: pngRaw([pngWords([0, 257, 65535, 32896])]),
  }));
  const rgbaSaved = encodePng(rgba);
  assert.equal(pngChunkOf(rgbaSaved, "IHDR").data[9], 6);
  assert.deepEqual([...pngRawOf(rgbaSaved)], [...pngRaw([pngWords([0, 257, 65535, 32896])])]);
  assert.deepEqual([...decodePng(rgbaSaved).pixels], [0, 1, 255, 128]);
});

test("pixelpng: a grey file stays grey, and falls back to RGBA only when it must", () => {
  const raw = pngRaw([pngBits([0, 7, 15], 4)]);
  const decoded = decodePng(pngFile({ width: 3, height: 1, depth: 4, colour: 0, raw }));
  const saved = encodePng(decoded);
  assert.equal(pngChunkOf(saved, "IHDR").data[8], 4, "the grey depth is kept");
  assert.equal(pngChunkOf(saved, "IHDR").data[9], 0, "and the colour type");
  assert.deepEqual([...pngRawOf(saved)], [...raw], "four-bit samples are packed back the way they came");
  assert.deepEqual([...decodePng(saved).pixels], [...decoded.pixels]);
  /* One pixel off the depth's scale: no four-bit grey can name 200, so the
     writer falls back to the shape it always knows. */
  setPixelAt(decoded, 1, 0, [200, 200, 200, 255]);
  const fallback = decodePng(encodePng(decoded));
  assert.equal(fallback.format.colourType, 6);
  assert.equal(fallback.format.bitDepth, 8);
  assert.deepEqual(pixelAt(fallback, 1, 0), [200, 200, 200, 255]);
  assert.deepEqual([...fallback.pixels], [...decoded.pixels], "the pixels are what the card sees either way");
  setPixelAt(decoded, 0, 0, [255, 0, 0, 255]);
  const red = decodePng(encodePng(decoded));
  assert.equal(red.format.colourType, 6, "a grey file repainted red cannot stay grey");
  assert.deepEqual(pixelAt(red, 0, 0), [255, 0, 0, 255]);
});

test("pixelpng: an interlaced file is written interlaced again", () => {
  const width = 5;
  const height = 4;
  const rgb = adam7Pixels(width, height);
  const raw = adam7Raw(rgb, width, height);
  const decoded = decodePng(pngFile({ width, height, depth: 8, colour: 2, interlace: 1, raw }));
  const saved = encodePng(decoded);
  assert.equal(pngChunkOf(saved, "IHDR").data[12], 1, "interlace is layout, and layout is kept");
  assert.deepEqual([...pngRawOf(saved)], [...raw], "the passes are written in the same order");
  const back = decodePng(saved);
  assert.deepEqual([...back.pixels], [...decoded.pixels]);
  assert.equal(back.format.interlace, 1);
});

test("pixelpng: what it writes is a PNG, chunk for chunk", () => {
  const image = blankImage(3, 2);
  setPixelAt(image, 0, 0, [1, 2, 3, 4]);
  setPixelAt(image, 2, 1, [250, 251, 252, 253]);
  const bytes = encodePng(image);
  assert.deepEqual([...bytes.slice(0, 8)], [...PNG_SIGNATURE]);
  const chunks = [];
  for (let at = 8; at + 12 <= bytes.length;) {
    const length = (bytes[at] << 24) | (bytes[at + 1] << 16) | (bytes[at + 2] << 8) | bytes[at + 3];
    const type = String.fromCharCode(...bytes.slice(at + 4, at + 8));
    const data = bytes.slice(at + 8, at + 8 + length);
    /* A chunk's CRC covers its type as well as its data; hashing the data alone
       still leaves a file most readers accept, so this is checked here. */
    const stated = ((bytes[at + 8 + length] << 24) | (bytes[at + 8 + length + 1] << 16)
      | (bytes[at + 8 + length + 2] << 8) | bytes[at + 8 + length + 3]) >>> 0;
    assert.equal(stated, pngCrc32(bytes.slice(at + 4, at + 8 + length)), `${type} chunk CRC`);
    chunks.push({ type, data });
    at += 12 + length;
  }
  assert.deepEqual(chunks.map((chunk) => chunk.type), ["IHDR", "IDAT", "IEND"]);
  assert.deepEqual([...chunks[0].data], [0, 0, 0, 3, 0, 0, 0, 2, 8, 6, 0, 0, 0],
    "three by two, eight bits a sample, colour type 6, not interlaced");
  /* Inside the stream: filter byte zero, then the image's own bytes, twice. */
  const raw = inflateSync(Buffer.from(chunks[1].data));
  assert.equal(raw.length, 2 * (1 + 3 * 4));
  assert.equal(raw[0], 0);
  assert.equal(raw[13], 0, "the second row carries its own filter byte");
  assert.deepEqual([...raw.slice(1, 13)], [...image.pixels.slice(0, 12)]);
  assert.deepEqual([...raw.slice(14)], [...image.pixels.slice(12)]);
});

test("pixelpng: a round trip through the channels comes back the same", () => {
  for (let width = 1; width <= 5; width += 1) {
    const image = blankImage(width, 1);
    for (let x = 0; x < width; x += 1) {
      setPixelAt(image, x, 0, [x * 50, 255 - x * 50, 128, x === 0 ? 0 : 255]);
    }
    const back = decodePng(encodePng(image));
    assert.equal(back.width, width);
    assert.deepEqual([...back.pixels], [...image.pixels], `width ${width}`);
  }
  const one = blankImage(1, 1, [0, 255, 128, 7]);
  assert.deepEqual([...decodePng(encodePng(one)).pixels], [0, 255, 128, 7]);
});

/* ------------------------------------------------------------------ */
/* the pixel card's colour opinion                                     */
/* ------------------------------------------------------------------ */

/*
 * The canvas half of a pixel card needs a browser and is covered by
 * `tools/input_smoke.py` instead. What is left over is the part between the
 * board document and the pixels: a palette is stored as strings, and the card
 * is the only thing that turns them into colours. These four checks pin that
 * down, because a palette that quietly loses an entry would come back on the
 * next board load as a different palette.
 */

test("pixel card: a stored palette is read back as the colours that went in", () => {
  assert.deepEqual(pixelPaletteOf(["#abc", "#112233", "#ABC"]), ["#aabbcc", "#112233", "#aabbcc"]);
});

test("pixel card: a palette with nothing usable in it falls back to the default", () => {
  for (const value of [null, undefined, [], "not a list", ["red", "#12345", 7], [null, {}]]) {
    const palette = pixelPaletteOf(value);
    assert.equal(palette.length, 16, `${JSON.stringify(value)} must give the default palette`);
    for (const colour of palette) {
      assert.match(colour, /^#[0-9a-f]{6}$/, `${JSON.stringify(value)} gave ${colour}`);
    }
  }
  assert.deepEqual(pixelPaletteOf(["nope"]), pixelPaletteOf([]));
});

test("pixel card: a colour is #rrggbb, or #rgb, or it is not a colour", () => {
  assert.deepEqual(pixelColourOf("#ff8000"), [255, 128, 0, 255]);
  assert.deepEqual(pixelColourOf("abc"), [170, 187, 204, 255], "the short form doubles each digit");
  assert.deepEqual(pixelColourOf("  #000000  "), [0, 0, 0, 255], "surrounding space is not part of the colour");
  for (const bad of ["", "#", "#12345", "#1234567", "red", "rgb(1,2,3)", null, 12, {}]) {
    assert.equal(pixelColourOf(bad), null, `${JSON.stringify(bad)} is not a colour`);
  }
});

test("pixel card: the readout shows a pixel's colour, and grey where there is none", () => {
  assert.equal(pixelInkOf([1, 2, 3, 255]), "#010203");
  assert.equal(pixelInkOf([255, 0, 128, 0]), "#ff0080", "a transparent pixel still has a colour to show");
  assert.equal(pixelInkOf(null), pixelInkOf(undefined), "nothing under the pointer is one answer, not two");
  assert.match(pixelInkOf(null), /^#[0-9a-f]{6}$/);
});

/* ------------------------------------------------------------------ */
/*
 * Spine's arithmetic, before there is a card to show it in.
 *
 * These are whole-corner comparisons on purpose: a bone order mistake or a
 * transposed matrix still produces plausible numbers, and a test that only
 * looked at one coordinate would not notice.
 */
export function spineBone(name, parentIndex, extra = {}) {
  return {
    name,
    parentIndex,
    rotation: 0,
    x: 0,
    y: 0,
    scaleX: 1,
    scaleY: 1,
    shearX: 0,
    shearY: 0,
    length: 0,
    transformMode: 0,
    ...extra,
  };
}

export function spineRig(bones, extra = {}) {
  return { version: "4.2.43", bones, slots: [], skins: [], animations: [], ...extra };
}

export const near = (got, want) => Math.abs(got - want) <= 1e-9;

test("spine pose: a child bone follows its parent's quarter turn", () => {
  const rig = spineRig([spineBone("root", -1, { rotation: 90 }), spineBone("child", 0, { x: 10 })]);
  const world = worldTransforms(rig, null, 0);
  assert.ok(near(world[1].e, 0), `child x was ${world[1].e}`);
  assert.ok(near(world[1].f, 10), `child y was ${world[1].f}`);
});

test("spine pose: a parent's scale lengthens the child's reach", () => {
  const rig = spineRig([spineBone("root", -1, { scaleX: 2, scaleY: 2 }), spineBone("child", 0, { x: 10 })]);
  assert.ok(near(worldTransforms(rig, null, 0)[1].e, 20));
});

test("spine pose: a region sits centred on its bone", () => {
  const matrix = { a: 1, b: 0, c: 0, d: 1, e: 0, f: 0 };
  const corners = regionCorners({ width: 10, height: 4, x: 0, y: 0, rotation: 0, scaleX: 1, scaleY: 1 }, matrix);
  assert.deepEqual(corners.map((point) => [point.x, point.y]), [[-5, -2], [5, -2], [5, 2], [-5, 2]]);
  const moved = applyMatrix(matrix, 3, 4);
  assert.deepEqual([moved.x, moved.y], [3, 4], "a matrix with no rotation is the identity");
});

test("spine pose: a region turns with its bone, corners and all", () => {
  const rig = spineRig([spineBone("root", -1, { rotation: 90 })]);
  const corners = regionCorners(
    { width: 10, height: 4, x: 0, y: 0, rotation: 0, scaleX: 1, scaleY: 1 },
    worldTransforms(rig, null, 0)[0],
  );
  // A quarter turn maps (x, y) to (-y, x); the rectangle stands on end.
  assert.deepEqual(corners.map((point) => Math.round(point.x)), [2, 2, -2, -2]);
  assert.deepEqual(corners.map((point) => Math.round(point.y)), [-5, 5, 5, -5]);
});

test("spine pose: a rotate timeline is read halfway between its frames", () => {
  const rig = spineRig([spineBone("root", -1), spineBone("child", 0, { x: 10 })]);
  const animation = { name: "a", duration: 1, timelines: [
    { type: "rotate", boneIndex: 0, frames: [{ time: 0, angle: 0, curve: null }, { time: 1, angle: 90 }] },
  ] };
  const world = worldTransforms(rig, animation, 0.5);
  assert.ok(near(world[1].e, Math.cos(Math.PI / 4) * 10));
  assert.ok(near(world[1].f, Math.sin(Math.PI / 4) * 10));
});

test("spine pose: the local pose is the number a drag edits, before parents compose it", () => {
  const rig = spineRig([spineBone("root", -1), spineBone("child", 0, { x: 10 })]);
  const animation = { name: "a", duration: 1, timelines: [
    { type: "rotate", boneIndex: 0, frames: [{ time: 0, angle: 0 }, { time: 1, angle: 90 }] },
  ] };
  const pose = localPoses(rig, animation, 0.5);
  assert.equal(pose.length, 2);
  assert.equal(Math.round(pose[0].rotation), 45, "halfway between the frames");
  assert.equal(pose[1].x, 10, "a bone the animation does not touch keeps its setup numbers");
  assert.deepEqual(localPoses(rig, null, 0)[0], {
    rotation: 0, x: 0, y: 0, scaleX: 1, scaleY: 1, shearX: 0, shearY: 0,
  });
});

test("spine pose: a stepped frame holds its value, a linear one moves", () => {
  assert.equal(easeFraction({ stepped: true }, 0.9), 0);
  assert.equal(easeFraction(null, 0.25), 0.25);
  assert.ok(bezierValue({ cx1: 0.42, cy1: 0, cx2: 1, cy2: 1 }, 0.5) < 0.5, "an ease-in starts slowly");
  assert.equal(bezierValue({ cx1: 0, cy1: 0, cx2: 1, cy2: 1 }, 1), 1);
});

test("spine pose: a time outside the animation is clamped, not extrapolated", () => {
  const frames = [{ time: 0, angle: 0 }, { time: 1, angle: 90 }];
  assert.equal(frameWindow(frames, -5).before, true);
  assert.equal(frameWindow(frames, 5).after, true);
  assert.equal(frameWindow(frames, 0.25).fraction, 0.25);
  assert.equal(frameWindow([], 0), null, "no frames is no window");
});

test("spine pose: a bone that names itself as its parent still has a place", () => {
  const rig = spineRig([spineBone("weird", 0)]);
  const world = worldTransforms(rig, null, 0);
  assert.deepEqual([world[0].e, world[0].f], [0, 0], "a corrupt parent index must not recurse forever");
});

test("spine pose: a region is drawn with its rectangle, a mesh admits it is not", () => {
  const rig = spineRig(
    [spineBone("root", -1)],
    {
      slots: [
        { name: "skin", boneIndex: 0, color: [1, 1, 1, 1], attachmentName: "body" },
        { name: "net", boneIndex: 0, color: [1, 1, 1, 1], attachmentName: "web" },
      ],
      skins: [{ name: "default", attachments: [
        { slotIndex: 0, name: "body", type: "region", width: 2, height: 2, x: 0, y: 0, rotation: 0, scaleX: 1, scaleY: 1 },
        { slotIndex: 1, name: "web", type: "mesh" },
      ] }],
    },
  );
  const scene = sceneAt(rig, null, 0);
  assert.equal(scene.items.length, 2);
  assert.equal(scene.items[0].kind, "region");
  assert.equal(scene.items[0].corners.length, 4);
  assert.equal(scene.items[1].kind, "mesh");
  assert.equal(scene.items[1].corners.length, 0, "a mesh is reported, not silently dropped");
});

test("spine pose: a colour timeline multiplies the slot's colour", () => {
  const rig = spineRig(
    [spineBone("root", -1)],
    { slots: [{ name: "a", boneIndex: 0, color: [1, 1, 1, 1], attachmentName: null }] },
  );
  const animation = { name: "fade", duration: 1, timelines: [
    { type: "color", slotIndex: 0, frames: [
      { time: 0, color: [1, 1, 1, 1], curve: null },
      { time: 1, color: [1, 1, 1, 0] },
    ] },
  ] };
  assert.equal(slotColorAt(rig, null, 0, 0, [1, 1, 1, 1])[3], 1, "no animation keeps the setup colour");
  assert.equal(slotColorAt(rig, animation, 0, 0.5, [1, 1, 1, 1])[3], 0.5);
});

test("spine pose: skins compose in order, a later skin winning the same slot name", () => {
  const rig = spineRig(
    [spineBone("root", -1)],
    {
      slots: [
        { name: "body", boneIndex: 0, color: [1, 1, 1, 1], attachmentName: "idle" },
        { name: "eyes", boneIndex: 0, color: [1, 1, 1, 1], attachmentName: "open" },
      ],
      skins: [
        { name: "Body/Expose", attachments: [
          { slotIndex: 0, name: "idle", type: "region", width: 1, height: 1 },
        ] },
        { name: "Body/Normal", attachments: [
          { slotIndex: 0, name: "idle", type: "region", width: 2, height: 2 },
        ] },
        { name: "Eyes/Normal", attachments: [
          { slotIndex: 1, name: "open", type: "region", width: 1, height: 1 },
        ] },
      ],
    },
  );
  const merged = mergedSkins(rig);
  assert.equal(merged.length, 2, "the same slot and name from two skins is one attachment");
  assert.equal(merged.find((attachment) => attachment.slotIndex === 0).width, 2, "a later skin wins");
  const scene = sceneAt(rig, null, 0, { skin: merged });
  assert.equal(scene.items.length, 2, "the body and the eyes are drawn together, which is the point");
});

test("spine pose: a rig with no skins composes to nothing", () => {
  const rig = spineRig([spineBone("root", -1)], { skins: [] });
  assert.deepEqual(mergedSkins(rig), []);
});

test("spine pose: an attachment timeline switches what the slot shows", () => {
  const rig = spineRig(
    [spineBone("root", -1)],
    { slots: [{ name: "a", boneIndex: 0, color: [1, 1, 1, 1], attachmentName: "idle" }] },
  );
  const animation = { name: "a", duration: 1, timelines: [
    { type: "attachment", slotIndex: 0, frames: [{ time: 0, name: "idle" }, { time: 0.5, name: "attack" }] },
  ] };
  assert.equal(slotAttachmentName(rig, null, 0, 0), "idle");
  assert.equal(slotAttachmentName(rig, animation, 0, 0.2), "idle");
  assert.equal(slotAttachmentName(rig, animation, 0, 0.7), "attack");
});

/* ------------------------------------------------------------------ */
/* the pixel card's framing, before there is a canvas to frame         */
/* ------------------------------------------------------------------ */

/*
 * Two of the browser bugs in `docs/gaps2.md` were about where the image lands,
 * not about its pixels.  A card opened while another tab was in front measured
 * its surface as 0x0, kept that measurement and never re-measured (G52); and a
 * zoom held the viewport centre, so a 32x32 sprite that started at the canvas
 * corner was scrolled out of sight by one press of + (G53).  The card now asks
 * `pixelview.mjs` for the numbers, and these checks are that arithmetic under
 * Node: the browser half is `tools/input_smoke.py`'s job.
 */

test("pixel view: the module imports nothing, reads no clock and touches no DOM", () => {
  const code = readFileSync(new URL("../pixelview.mjs", import.meta.url), "utf8");
  assert.equal(/^\s*import\b/m.test(code), false, "no imports");
  assert.equal(/\bwindow\b|\bdocument\b|\blocalStorage\b/.test(code), false, "no DOM");
  assert.equal(/Math\.random|Date\.now|new Date\(/.test(code), false, "no clock, no randomness");
});

test("pixel view: a card that measured 0x0 is centred once its surface is laid out", () => {
  /* A hidden card's measurement is not a frame: it must not become a pan that
     is then kept forever (G52). */
  const hidden = framedPan(0, 0, 32, 32, 1, -999, -999, false);
  assert.deepEqual(hidden, { panX: -999, panY: -999 }, "no layout means no framing decision");
  assert.equal(visible(0, 0, 32, 32, 1, hidden.panX, hidden.panY), false, "a 0x0 surface shows nothing");
  /* `shown()` then measures 640x480, and the same card is centred in it.  The
     expected numbers are worked out here, not read back from the module. */
  const shown = framedPan(640, 480, 32, 32, 1, hidden.panX, hidden.panY, false);
  assert.deepEqual(shown, { panX: (640 - 32) / 2, panY: (480 - 32) / 2 });
  assert.equal(visible(640, 480, 32, 32, 1, shown.panX, shown.panY), true);
  assert.equal(insideView(640, 480, 32, 32, 1, shown.panX, shown.panY), true,
    "the whole image is on screen, not merely some of it");
});

test("pixel view: a 32x32 image at 1x, 2x and 8x with the centre pan is on screen", () => {
  for (const zoom of [1, 2, 8]) {
    const pan = centrePan(640, 480, 32, 32, zoom);
    assert.equal(visible(640, 480, 32, 32, zoom, pan.panX, pan.panY), true, `${zoom}x intersects the viewport`);
    assert.equal(insideView(640, 480, 32, 32, zoom, pan.panX, pan.panY), true, `${zoom}x is wholly inside`);
  }
  /* "Visible" and "wholly inside" are different questions: half a sprite over
     the top-left corner is on screen and still not inside. */
  assert.equal(visible(640, 480, 32, 32, 1, -16, -16), true, "half a sprite is still on screen");
  assert.equal(insideView(640, 480, 32, 32, 1, -16, -16), false, "and not wholly inside");
});

test("pixel view: a wheel zoom keeps the pixel under the cursor where it was", () => {
  const pan = { panX: 300, panY: 200 };
  const anchor = { x: 420, y: 260 };
  const fromZoom = 2;
  const toZoom = 4;
  /* The image point under the cursor before the zoom... */
  const before = { x: (anchor.x - pan.panX) / fromZoom, y: (anchor.y - pan.panY) / fromZoom };
  const zoomed = zoomAt(pan.panX, pan.panY, fromZoom, toZoom, anchor.x, anchor.y);
  assert.deepEqual(zoomed, { panX: 180, panY: 140 });
  /* ...is still under the cursor after it. */
  const after = { x: (anchor.x - zoomed.panX) / toZoom, y: (anchor.y - zoomed.panY) / toZoom };
  assert.ok(Math.abs(after.x - before.x) <= 1e-9 && Math.abs(after.y - before.y) <= 1e-9,
    `the image point moved from (${before.x}, ${before.y}) to (${after.x}, ${after.y})`);
  /* Zooming back out on the same anchor returns the pan it started from. */
  assert.deepEqual(zoomAt(zoomed.panX, zoomed.panY, toZoom, fromZoom, anchor.x, anchor.y), pan);
});

test("pixel view: a pan the person made is not re-centred by shown()", () => {
  for (const [viewW, viewH] of [[0, 0], [640, 480], [1280, 720]]) {
    assert.deepEqual(framedPan(viewW, viewH, 32, 32, 1, 10, 20, true), { panX: 10, panY: 20 },
      `shown at ${viewW}x${viewH} keeps the person's pan`);
  }
  /* Without the flag, the same call centres: the flag is the whole difference. */
  assert.deepEqual(framedPan(640, 480, 32, 32, 1, 10, 20, false), centrePan(640, 480, 32, 32, 1));
});
