#include "db/envelope.h"

#include <cstring>
#include <stdexcept>

#include "crypto/chacha20poly1305.h"
#include "crypto/crc32c.h"

namespace iaqs::db {
namespace {

// Slot header layout (16 bytes).
constexpr size_t kOffVersion = 0;
constexpr size_t kOffFlags = 2;
constexpr size_t kOffStoredLen = 4;
constexpr size_t kOffGeneration = 8;
constexpr size_t kOffSlotCrc = 12;

// nonce = epoch u32 || generation u32 || page_no u16 || seg u16.
void build_nonce(uint32_t epoch, uint32_t generation, uint32_t page,
                 uint32_t seg, uint8_t nonce[12]) {
  store_u32_le(nonce + 0, epoch);
  store_u32_le(nonce + 4, generation);
  store_u16_le(nonce + 8, static_cast<uint16_t>(page));
  store_u16_le(nonce + 10, static_cast<uint16_t>(seg));
}

// AAD = version u16 || flags u16 || seg u32 || page u32 || generation u32.
void build_aad(uint16_t version, uint16_t flags, uint32_t seg, uint32_t page,
               uint32_t generation, uint8_t aad[16]) {
  store_u16_le(aad + 0, version);
  store_u16_le(aad + 2, flags);
  store_u32_le(aad + 4, seg);
  store_u32_le(aad + 8, page);
  store_u32_le(aad + 12, generation);
}

}  // namespace

Bytes seal_page(const std::array<uint8_t, 32>& page_key, uint32_t epoch,
                const PageRef& ref, ByteSpan plaintext, uint32_t page_size,
                bool encrypted) {
  if (page_size <= kEnvelopeHeaderSize + kAeadTagSize) {
    throw std::runtime_error("seal_page: page_size too small");
  }
  if (plaintext.size() > max_plain_page_size(page_size)) {
    throw std::runtime_error("seal_page: plaintext exceeds page capacity");
  }

  uint16_t flags = 0;
  Bytes sealed;
  if (encrypted) {
    uint8_t nonce[12];
    build_nonce(epoch, ref.generation, ref.page, ref.seg, nonce);
    uint8_t aad[16];
    build_aad(kEnvelopeVersion, 0, ref.seg, ref.page, ref.generation, aad);
    sealed = aead_seal(page_key.data(), nonce, plaintext,
                       ByteSpan(aad, sizeof aad));
  } else {
    // Plaintext slot: no key and no AEAD tag. The slot CRC above plus the
    // page's own CRC remain the integrity check.
    flags = kEnvelopeFlagPlain;
    sealed.assign(reinterpret_cast<const char*>(plaintext.data()),
                  plaintext.size());
  }
  if (kEnvelopeHeaderSize + sealed.size() > page_size) {
    throw std::runtime_error("seal_page: sealed page exceeds slot");
  }

  Bytes slot(page_size, '\0');
  uint8_t* p = reinterpret_cast<uint8_t*>(slot.data());
  store_u16_le(p + kOffVersion, kEnvelopeVersion);
  store_u16_le(p + kOffFlags, flags);
  store_u32_le(p + kOffStoredLen, static_cast<uint32_t>(sealed.size()));
  store_u32_le(p + kOffGeneration, ref.generation);
  std::memcpy(p + kEnvelopeHeaderSize, sealed.data(), sealed.size());
  const uint32_t slot_crc = crc32c(p, kOffSlotCrc, crc32c(sealed));
  store_u32_le(p + kOffSlotCrc, slot_crc);
  return slot;
}

bool read_envelope_info(ByteSpan slot, EnvelopeInfo& info) {
  if (slot.size() < kEnvelopeHeaderSize) return false;
  const uint8_t* p = slot.data();
  info.version = load_u16_le(p + kOffVersion);
  info.flags = load_u16_le(p + kOffFlags);
  const uint32_t stored_len = load_u32_le(p + kOffStoredLen);
  info.generation = load_u32_le(p + kOffGeneration);
  const uint32_t stored_crc = load_u32_le(p + kOffSlotCrc);
  if (info.version != kEnvelopeVersion) return false;
  if (stored_len > slot.size() - kEnvelopeHeaderSize) return false;
  if ((info.flags & kEnvelopeFlagPlain) == 0 && stored_len < kAeadTagSize) {
    return false;
  }
  const ByteSpan ciphertext(p + kEnvelopeHeaderSize, stored_len);
  return crc32c(p, kOffSlotCrc, crc32c(ciphertext)) == stored_crc;
}

Bytes open_page(const std::array<uint8_t, 32>& page_key, uint32_t epoch,
                const PageRef& ref, ByteSpan slot, bool encrypted) {
  EnvelopeInfo info;
  if (!read_envelope_info(slot, info)) {
    throw std::runtime_error("open_page: corrupt envelope header");
  }
  if (info.generation != ref.generation) {
    throw std::runtime_error("open_page: stale page reference");
  }

  const size_t stored_len = load_u32_le(slot.data() + kOffStoredLen);
  const uint8_t* p = slot.data();
  const ByteSpan ciphertext(p + kEnvelopeHeaderSize, stored_len);

  uint8_t nonce[12];
  build_nonce(epoch, info.generation, ref.page, ref.seg, nonce);
  uint8_t aad[16];
  build_aad(info.version, info.flags, ref.seg, ref.page, info.generation, aad);

  Bytes plaintext;
  const bool plain = (info.flags & kEnvelopeFlagPlain) != 0;
  if (plain != !encrypted) {
    throw std::runtime_error(
        "open_page: slot encryption does not match the database");
  }
  if (plain) {
    plaintext.assign(reinterpret_cast<const char*>(ciphertext.data()),
                     ciphertext.size());
  } else if (!aead_open(page_key.data(), nonce, ciphertext,
                        ByteSpan(aad, sizeof aad), plaintext)) {
    throw std::runtime_error("open_page: authentication failed");
  }
  // The plaintext page header repeats the generation; mismatch means the slot
  // was replayed/sealed inconsistently.
  PageHeader header;
  ByteSpan body;
  if (!decode_page(bytes_span(plaintext), header, body) ||
      header.generation != info.generation) {
    throw std::runtime_error("open_page: page header mismatch");
  }
  return plaintext;
}

}  // namespace iaqs::db
