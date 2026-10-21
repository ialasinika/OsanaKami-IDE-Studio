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
constexpr size_t kOffKdfType = 40;
constexpr size_t kOffSalt = 41;
constexpr size_t kOffIters = 57;
constexpr size_t kOffWrappedNonce = 61;
constexpr size_t kOffWrappedCipher = 73;
constexpr size_t kOffWrappedTag = 105;
constexpr size_t kOffVerifierNonce = 121;
constexpr size_t kOffVerifierTag = 133;
constexpr size_t kOffCrc = 149;

}  // namespace

Manifest Manifest::create_public(uint32_t page_size, uint64_t segment_max,
                                 uint32_t kdf_iters) {
  Manifest m;
  m.page_size = page_size;
  m.segment_max = segment_max;
  m.kdf_iters = kdf_iters;
  const Bytes uuid = random_bytes(m.db_uuid.size());
  std::memcpy(m.db_uuid.data(), uuid.data(), m.db_uuid.size());
  const Bytes salt = random_bytes(m.kdf_salt.size());
  std::memcpy(m.kdf_salt.data(), salt.data(), m.kdf_salt.size());
  const Bytes nonce = random_bytes(m.wrapped_dek_nonce.size());
  std::memcpy(m.wrapped_dek_nonce.data(), nonce.data(), m.wrapped_dek_nonce.size());
  const Bytes vnonce = random_bytes(m.verifier_nonce.size());
  std::memcpy(m.verifier_nonce.data(), vnonce.data(), m.verifier_nonce.size());
  return m;
}

Manifest Manifest::create_plain(uint32_t page_size, uint64_t segment_max) {
  Manifest m;
  m.page_size = page_size;
  m.segment_max = segment_max;
  m.kdf_type = kKdfNone;
  m.kdf_iters = 0;
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
  p[kOffKdfType] = kdf_type;
  std::memcpy(p + kOffSalt, kdf_salt.data(), kdf_salt.size());
  store_u32_le(p + kOffIters, kdf_iters);
  std::memcpy(p + kOffWrappedNonce, wrapped_dek_nonce.data(),
              wrapped_dek_nonce.size());
  std::memcpy(p + kOffWrappedCipher, wrapped_dek_ciphertext.data(),
              wrapped_dek_ciphertext.size());
  std::memcpy(p + kOffWrappedTag, wrapped_dek_tag.data(),
              wrapped_dek_tag.size());
  std::memcpy(p + kOffVerifierNonce, verifier_nonce.data(),
              verifier_nonce.size());
  std::memcpy(p + kOffVerifierTag, verifier_tag.data(),
              verifier_tag.size());
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
  out.kdf_type = p[kOffKdfType];
  std::memcpy(out.kdf_salt.data(), p + kOffSalt, out.kdf_salt.size());
  out.kdf_iters = load_u32_le(p + kOffIters);
  std::memcpy(out.wrapped_dek_nonce.data(), p + kOffWrappedNonce,
              out.wrapped_dek_nonce.size());
  std::memcpy(out.wrapped_dek_ciphertext.data(), p + kOffWrappedCipher,
              out.wrapped_dek_ciphertext.size());
  std::memcpy(out.wrapped_dek_tag.data(), p + kOffWrappedTag,
              out.wrapped_dek_tag.size());
  std::memcpy(out.verifier_nonce.data(), p + kOffVerifierNonce,
              out.verifier_nonce.size());
  std::memcpy(out.verifier_tag.data(), p + kOffVerifierTag,
              out.verifier_tag.size());

  if (out.format_version != kManifestFormatVersion) return false;
  if (out.kdf_type != kKdfNone && out.kdf_type != kKdfPbkdf2HmacSha256) {
    return false;
  }
  if (out.page_size < 1024 || out.page_size > 65536) return false;
  if (out.segment_max < out.page_size) return false;
  return true;
}

Manifest load_manifest(const std::string& path) {
  const Bytes data = read_file(path);
  Manifest m;
  if (!Manifest::decode(bytes_span(data), m)) {
    throw std::runtime_error("manifest: corrupt or unsupported format");
  }
  return m;
}

void save_manifest(const std::string& path, const Manifest& manifest) {
  const Bytes data = manifest.encode();
  write_file_atomic(path, bytes_span(data));
}

}  // namespace iaqs::db
