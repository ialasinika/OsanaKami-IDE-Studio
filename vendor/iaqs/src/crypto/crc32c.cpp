#include "crypto/crc32c.h"

namespace iaqs {
namespace {

// Reflected CRC32C table for polynomial 0x1EDC6F41 (reversed: 0x82F63B78).
const uint32_t* table() {
  static uint32_t t[256];
  static bool initialized = false;
  if (!initialized) {
    for (uint32_t i = 0; i < 256; ++i) {
      uint32_t crc = i;
      for (int bit = 0; bit < 8; ++bit) {
        crc = (crc & 1) ? ((crc >> 1) ^ 0x82F63B78u) : (crc >> 1);
      }
      t[i] = crc;
    }
    initialized = true;
  }
  return t;
}

}  // namespace

uint32_t crc32c(const uint8_t* data, size_t size, uint32_t seed) {
  const uint32_t* t = table();
  // Standard CRC-32C framing: init ^0xFFFFFFFF, final xor 0xFFFFFFFF. The
  // `seed` parameter accepts a previously finalized CRC so updates can chain.
  uint32_t crc = seed ^ 0xFFFFFFFFu;
  for (size_t i = 0; i < size; ++i) {
    crc = t[(crc ^ data[i]) & 0xffu] ^ (crc >> 8);
  }
  return crc ^ 0xFFFFFFFFu;
}

uint32_t crc32c(ByteSpan data, uint32_t seed) {
  return crc32c(data.data(), data.size(), seed);
}

uint32_t crc32c(std::string_view data, uint32_t seed) {
  return crc32c(bytes_span(data), seed);
}

}  // namespace iaqs
