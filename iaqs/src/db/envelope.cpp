#include "db/envelope.h"

#include <cstring>
#include <stdexcept>

#include "crypto/crc32c.h"

namespace iaqs::db {
namespace {

// Slot header layout (16 bytes).
constexpr size_t kOffVersion = 0;
constexpr size_t kOffReserved = 2;
constexpr size_t kOffStoredLen = 4;
constexpr size_t kOffGeneration = 8;
constexpr size_t kOffSlotCrc = 12;

}  // namespace

Bytes seal_page(const PageRef& ref, ByteSpan plaintext, uint32_t page_size) {
  if (page_size <= kEnvelopeHeaderSize) {
    throw std::runtime_error("seal_page: page_size too small");
  }
  if (plaintext.size() > max_plain_page_size(page_size)) {
    throw std::runtime_error("seal_page: plaintext exceeds page capacity");
  }

  Bytes slot(page_size, '\0');
  uint8_t* p = reinterpret_cast<uint8_t*>(slot.data());
  store_u16_le(p + kOffVersion, kEnvelopeVersion);
  store_u16_le(p + kOffReserved, 0);
  store_u32_le(p + kOffStoredLen, static_cast<uint32_t>(plaintext.size()));
  store_u32_le(p + kOffGeneration, ref.generation);
  std::memcpy(p + kEnvelopeHeaderSize, plaintext.data(), plaintext.size());
  const uint32_t slot_crc = crc32c(p, kOffSlotCrc, crc32c(plaintext));
  store_u32_le(p + kOffSlotCrc, slot_crc);
  return slot;
}

bool read_envelope_info(ByteSpan slot, EnvelopeInfo& info) {
  if (slot.size() < kEnvelopeHeaderSize) return false;
  const uint8_t* p = slot.data();
  info.version = load_u16_le(p + kOffVersion);
  const uint16_t reserved = load_u16_le(p + kOffReserved);
  const uint32_t stored_len = load_u32_le(p + kOffStoredLen);
  info.generation = load_u32_le(p + kOffGeneration);
  const uint32_t stored_crc = load_u32_le(p + kOffSlotCrc);
  if (info.version != kEnvelopeVersion) return false;
  if (reserved != 0) return false;
  if (stored_len > slot.size() - kEnvelopeHeaderSize) return false;
  const ByteSpan page(p + kEnvelopeHeaderSize, stored_len);
  return crc32c(p, kOffSlotCrc, crc32c(page)) == stored_crc;
}

Bytes open_page(const PageRef& ref, ByteSpan slot) {
  EnvelopeInfo info;
  if (!read_envelope_info(slot, info)) {
    throw std::runtime_error("open_page: corrupt envelope header");
  }
  if (info.generation != ref.generation) {
    throw std::runtime_error("open_page: stale page reference");
  }

  const size_t stored_len = load_u32_le(slot.data() + kOffStoredLen);
  const ByteSpan page(slot.data() + kEnvelopeHeaderSize, stored_len);
  Bytes plaintext(reinterpret_cast<const char*>(page.data()), page.size());

  // The plaintext page header repeats the generation; mismatch means the slot
  // was framed inconsistently.
  PageHeader header;
  ByteSpan body;
  if (!decode_page(bytes_span(plaintext), header, body) ||
      header.generation != info.generation) {
    throw std::runtime_error("open_page: page header mismatch");
  }
  return plaintext;
}

}  // namespace iaqs::db
