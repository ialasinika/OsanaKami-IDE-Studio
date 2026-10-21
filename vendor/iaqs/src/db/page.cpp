#include "db/page.h"

#include <cstring>
#include <stdexcept>

#include "crypto/crc32c.h"

namespace iaqs::db {

std::string page_ref_to_string(const PageRef& ref) {
  return std::to_string(ref.seg) + ":" + std::to_string(ref.page) + ":" +
         std::to_string(ref.generation);
}

Bytes encode_page(PageType type, uint8_t flags, uint32_t generation,
                  ByteSpan body) {
  if (body.size() > 0xffff) throw std::runtime_error("page body too large");
  Bytes out;
  out.resize(kPageHeaderSize + body.size());
  uint8_t* p = reinterpret_cast<uint8_t*>(out.data());
  p[0] = static_cast<uint8_t>(type);
  p[1] = flags;
  store_u16_le(p + 2, static_cast<uint16_t>(body.size()));
  store_u32_le(p + 4, generation);
  std::memcpy(p + kPageHeaderSize, body.data(), body.size());
  const uint32_t combined = crc32c(p, 8, crc32c(body));
  store_u32_le(p + 8, combined);
  return out;
}

bool decode_page(ByteSpan plain, PageHeader& header, ByteSpan& body) {
  if (plain.size() < kPageHeaderSize) return false;
  const uint8_t* p = plain.data();
  header.type = static_cast<PageType>(p[0]);
  header.flags = p[1];
  header.page_len = load_u16_le(p + 2);
  header.generation = load_u32_le(p + 4);
  header.crc = load_u32_le(p + 8);
  if (kPageHeaderSize + header.page_len > plain.size()) return false;
  body = ByteSpan(p + kPageHeaderSize, header.page_len);
  const uint32_t stored = crc32c(p, 8, crc32c(body));
  return stored == header.crc;
}

}  // namespace iaqs::db
