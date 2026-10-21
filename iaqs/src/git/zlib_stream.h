#pragma once

#include <cstddef>
#include <cstdint>

#include "core/util.h"

namespace iaqs::git {

// Minimal zlib (RFC 1950/1951) support used by git pack files.
// Decompression implements stored, fixed-Huffman and dynamic-Huffman blocks.
// Compression emits stored (uncompressed) deflate blocks, which is valid zlib
// and keeps iaqs dependency-free; git inflates it like any other stream.

inline constexpr uint64_t kUnknownSize = UINT64_MAX;

// Inflates a zlib stream. `expected_size` is checked against the result when it
// is not kUnknownSize. When `consumed` is non-null it receives the number of
// input bytes the stream occupied (including the 2-byte header and Adler-32).
Bytes zlib_decompress(ByteSpan input, uint64_t expected_size = kUnknownSize,
                      std::size_t* consumed = nullptr);

Bytes zlib_compress_stored(ByteSpan data);

uint32_t adler32(ByteSpan data);

// Standard CRC-32 (reflected polynomial 0xEDB88320) as used by zlib and by the
// git pack index (note: not the CRC-32C used by iaqs' own page format).
uint32_t crc32_zlib(ByteSpan data);

}  // namespace iaqs::git
