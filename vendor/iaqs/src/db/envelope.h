// Page envelope: AEAD over the whole plaintext page (slot is fixed size).
#pragma once

#include <array>
#include <cstddef>
#include <cstdint>

#include "core/util.h"
#include "db/page.h"

namespace iaqs::db {

inline constexpr uint16_t kEnvelopeVersion = 1;

struct EnvelopeInfo {
  uint16_t version = 0;
  uint16_t flags = 0;
  uint32_t generation = 0;
};

// Seals `plaintext` (≤ max_plain_page_size(page_size)) into a fixed
// `page_size` slot:
//   [u16 version][u16 flags][u32 stored_len][u32 generation][u32 slot_crc]
//   followed by ciphertext (AEAD output, including tag).
// The nonce/AAD bind seg/page/generation, so the slot cannot be moved or
// replayed onto another slot. Remaining slot bytes are zero.
Bytes seal_page(const std::array<uint8_t, 32>& page_key, uint32_t epoch,
                const PageRef& ref, ByteSpan plaintext, uint32_t page_size);

// Parses and CRC-checks the envelope header. Returns false when malformed.
bool read_envelope_info(ByteSpan slot, EnvelopeInfo& info);

// Opens a slot previously produced by seal_page(). `ref` must match the
// stored generation, otherwise a stale reference is reported. Throws
// std::runtime_error when the slot is malformed, the CRC fails, or AEAD
// authentication fails.
Bytes open_page(const std::array<uint8_t, 32>& page_key, uint32_t epoch,
                const PageRef& ref, ByteSpan slot);

}  // namespace iaqs::db
