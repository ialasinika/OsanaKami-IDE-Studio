// Plaintext MANIFEST: database identity and sizing, plus a checksum.
#pragma once

#include <array>
#include <cstdint>
#include <string>

#include "core/util.h"
#include "db/page.h"

namespace iaqs::db {

// Version 2 dropped the key-derivation fields and the wrapped data key: this
// build has no password at all, so the manifest is identity and sizing only.
inline constexpr uint32_t kManifestFormatVersion = 2;

struct Manifest {
  static constexpr size_t kEncodedSize = 44;

  uint32_t format_version = kManifestFormatVersion;
  uint32_t page_size = kDefaultPageSize;
  uint64_t segment_max = kDefaultSegmentMax;
  std::array<uint8_t, 16> db_uuid{};

  Bytes encode() const;
  static bool decode(ByteSpan data, Manifest& out);

  // Fresh manifest with a random identity; sizing comes from the caller.
  static Manifest create(uint32_t page_size, uint64_t segment_max);
};

Manifest load_manifest(const std::string& path);
void save_manifest(const std::string& path, const Manifest& manifest);

}  // namespace iaqs::db
