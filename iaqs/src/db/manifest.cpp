#include "db/manifest.h"

#include <cstring>
#include <stdexcept>

#include "crypto/crc32c.h"
#include "crypto/rand.h"

namespace iaqs::db {
namespace {

constexpr uint8_t kMagic[8] = {'I', 'A', 'Q', 'S', 'D', 'B', '1', '\0'};

// Fixed offsets inside the encoded manifest.
constexpr size_t kOffMagic = 0;
constexpr size_t kOffVersion = 8;
constexpr size_t kOffPageSize = 12;
constexpr size_t kOffSegmentMax = 16;
constexpr size_t kOffUuid = 24;
constexpr size_t kOffCrc = 40;

// Format 1 sized its fixed part for a wrapped data key. A file of that size is
// recognised here only to say why it cannot be opened.
constexpr size_t kOldEncodedSize = 153;
constexpr size_t kOldPasswordModeOffset = 40;
constexpr uint8_t kOldPasswordMode = 1;

}  // namespace

Manifest Manifest::create(uint32_t page_size, uint64_t segment_max) {
  Manifest m;
  m.page_size = page_size;
  m.segment_max = segment_max;
  const Bytes uuid = random_bytes(m.db_uuid.size());
  std::memcpy(m.db_uuid.data(), uuid.data(), m.db_uuid.size());
  return m;
}

Bytes Manifest::encode() const {
  Bytes out(kEncodedSize, '\0');
  uint8_t* p = reinterpret_cast<uint8_t*>(out.data());
  std::memcpy(p + kOffMagic, kMagic, sizeof kMagic);
  store_u32_le(p + kOffVersion, format_version);
  store_u32_le(p + kOffPageSize, page_size);
  store_u64_le(p + kOffSegmentMax, segment_max);
  std::memcpy(p + kOffUuid, db_uuid.data(), db_uuid.size());
  store_u32_le(p + kOffCrc, crc32c(p, kOffCrc));
  return out;
}

bool Manifest::decode(ByteSpan data, Manifest& out) {
  if (data.size() != kEncodedSize) return false;
  const uint8_t* p = data.data();
  if (std::memcmp(p + kOffMagic, kMagic, sizeof kMagic) != 0) return false;
  if (crc32c(p, kOffCrc) != load_u32_le(p + kOffCrc)) return false;

  out.format_version = load_u32_le(p + kOffVersion);
  out.page_size = load_u32_le(p + kOffPageSize);
  out.segment_max = load_u64_le(p + kOffSegmentMax);
  std::memcpy(out.db_uuid.data(), p + kOffUuid, out.db_uuid.size());

  if (out.format_version != kManifestFormatVersion) return false;
  if (out.page_size < 1024 || out.page_size > 65536) return false;
  if (out.segment_max < out.page_size) return false;
  return true;
}

Manifest load_manifest(const std::string& path) {
  const Bytes data = read_file(path);
  Manifest m;
  if (Manifest::decode(bytes_span(data), m)) return m;
  // A format-1 manifest still stores a key-derivation mode byte here. There is
  // no code left to unwrap such a key, so say so instead of failing vaguely.
  if (data.size() == kOldEncodedSize &&
      std::memcmp(data.data(), kMagic, sizeof kMagic) == 0 &&
      static_cast<uint8_t>(data[kOldPasswordModeOffset]) == kOldPasswordMode) {
    throw std::runtime_error(
        "this database was written with a password mode this build no longer "
        "has");
  }
  throw std::runtime_error("manifest: corrupt or unsupported format");
}

void save_manifest(const std::string& path, const Manifest& manifest) {
  const Bytes data = manifest.encode();
  write_file_atomic(path, bytes_span(data));
}

}  // namespace iaqs::db
