// Plaintext MANIFEST: public KDF parameters plus the wrapped DEK.
#pragma once

#include <array>
#include <cstdint>
#include <string>

#include "core/util.h"
#include "db/page.h"

namespace iaqs::db {

inline constexpr uint32_t kManifestFormatVersion = 1;
inline constexpr uint8_t kKdfPbkdf2HmacSha256 = 1;
// This project's own repositories use `kKdfNone`: pages and the WAL are stored
// as plaintext with their checksums intact, so there is no password to lose.
// The password-wrapped format above stays for upstream compatibility and for
// the database engine's own tests.
inline constexpr uint8_t kKdfNone = 0;

struct Manifest {
  static constexpr size_t kEncodedSize = 153;
  static constexpr uint32_t kDefaultIters = 600000;

  uint32_t format_version = kManifestFormatVersion;
  uint32_t page_size = kDefaultPageSize;
  uint64_t segment_max = kDefaultSegmentMax;
  std::array<uint8_t, 16> db_uuid{};
  uint8_t kdf_type = kKdfPbkdf2HmacSha256;
  std::array<uint8_t, 16> kdf_salt{};
  uint32_t kdf_iters = kDefaultIters;
  std::array<uint8_t, 12> wrapped_dek_nonce{};
  std::array<uint8_t, 32> wrapped_dek_ciphertext{};
  std::array<uint8_t, 16> wrapped_dek_tag{};
  std::array<uint8_t, 12> verifier_nonce{};
  std::array<uint8_t, 16> verifier_tag{};

  Bytes encode() const;
  static bool decode(ByteSpan data, Manifest& out);

  // Fills public fields (uuid/salt/iterations) with fresh random values; the
  // caller still has to wrap the DEK via Keyring::initialize().
  static Manifest create_public(uint32_t page_size, uint64_t segment_max,
                                uint32_t kdf_iters);

  // Fresh manifest for a plaintext database: identity and sizing only, no
  // salt, no iterations, no wrapped key.
  static Manifest create_plain(uint32_t page_size, uint64_t segment_max);
};

Manifest load_manifest(const std::string& path);
void save_manifest(const std::string& path, const Manifest& manifest);

}  // namespace iaqs::db
