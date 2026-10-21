// Page envelope: a checksummed slot header in front of the plaintext page.
#pragma once

#include <cstddef>
#include <cstdint>

#include "core/util.h"
#include "db/page.h"

namespace iaqs::db {

inline constexpr uint16_t kEnvelopeVersion = 1;

struct EnvelopeInfo {
  uint16_t version = 0;
  uint32_t generation = 0;
};

// Frames `plaintext` (≤ max_plain_page_size(page_size)) into a fixed
// `page_size` slot:
//   [u16 version][u16 reserved][u32 stored_len][u32 generation][u32 slot_crc]
// followed by the page bytes. The CRC covers the header bytes before it plus
// the page, so a torn or bit-flipped slot is rejected by read_envelope_info()
// before a page is decoded. Remaining slot bytes are zero.
Bytes seal_page(const PageRef& ref, ByteSpan plaintext, uint32_t page_size);

// Parses and CRC-checks the envelope header. Returns false when malformed.
bool read_envelope_info(ByteSpan slot, EnvelopeInfo& info);

// Opens a slot previously produced by seal_page(). `ref` must match the stored
// generation, otherwise a stale reference is reported. Throws
// std::runtime_error when the slot is malformed, the CRC fails, or the page
// header does not repeat the slot's generation.
Bytes open_page(const PageRef& ref, ByteSpan slot);

}  // namespace iaqs::db
