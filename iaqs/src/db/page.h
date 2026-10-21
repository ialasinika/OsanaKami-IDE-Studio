// Logical page format (plaintext, before compression/encryption).
#pragma once

#include <cstddef>
#include <cstdint>
#include <string>

#include "core/util.h"

namespace iaqs::db {

inline constexpr uint32_t kDefaultPageSize = 8192;
inline constexpr uint64_t kDefaultSegmentMax = 256ull * 1024 * 1024;

// Physical slot envelope overhead: 16-byte header + 16-byte AEAD tag.
inline constexpr size_t kEnvelopeHeaderSize = 16;
inline constexpr size_t kAeadTagSize = 16;

enum class PageType : uint8_t {
  SegmentHeader = 0x01,
  System = 0x10,
  Heap = 0x20,
  BTreeInternal = 0x30,
  BTreeLeaf = 0x31,
  Overflow = 0x40,
  Free = 0x50,
};

// Physical address of a page slot; generation increments on every overwrite.
struct PageRef {
  uint32_t seg = 0;
  uint32_t page = 0;
  uint32_t generation = 0;
};

inline bool operator==(const PageRef& a, const PageRef& b) {
  return a.seg == b.seg && a.page == b.page && a.generation == b.generation;
}
inline bool operator!=(const PageRef& a, const PageRef& b) { return !(a == b); }

std::string page_ref_to_string(const PageRef& ref);

// Plaintext page header (12 bytes), followed by the page body.
inline constexpr size_t kPageHeaderSize = 12;

struct PageHeader {
  PageType type = PageType::Free;
  uint8_t flags = 0;
  uint16_t page_len = 0;  // body length in bytes
  uint32_t generation = 0;
  uint32_t crc = 0;
};

// Encodes header + body; the CRC covers the first 8 header bytes and the body.
Bytes encode_page(PageType type, uint8_t flags, uint32_t generation,
                  ByteSpan body);

// Validates the CRC and parses the header. Returns false when `plain` is too
// short, the body length is inconsistent, or the CRC does not match.
bool decode_page(ByteSpan plain, PageHeader& header, ByteSpan& body);

// Maximum plaintext page size for a given physical slot size.
inline size_t max_plain_page_size(uint32_t page_size) {
  return page_size - kEnvelopeHeaderSize - kAeadTagSize;
}

}  // namespace iaqs::db
