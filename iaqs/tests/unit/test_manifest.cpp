#include <array>
#include <cstring>
#include <filesystem>
#include <fstream>
#include <stdexcept>
#include <string>

#include "core/util.h"
#include "crypto/crc32c.h"
#include "db/manifest.h"
#include "harness.h"

using namespace iaqs;
using namespace iaqs::db;

namespace {

Manifest make_manifest() {
  return Manifest::create(8192, 16ull * 1024 * 1024);
}

std::filesystem::path temp_manifest_path() {
  return std::filesystem::temp_directory_path() / "iaqs_test_manifest.bin";
}

// A format-1 manifest: same magic, format_version 1, and the old key-mode byte
// at offset 40. This build has no code to read it and must say why.
Bytes legacy_manifest_bytes() {
  Bytes out(153, '\0');
  std::memcpy(out.data(), "IAQSDB1", 8);
  uint8_t* p = reinterpret_cast<uint8_t*>(out.data());
  store_u32_le(p + 8, 1);
  store_u32_le(p + 12, 8192);
  store_u64_le(p + 16, 16ull * 1024 * 1024);
  p[40] = 1;
  return out;
}

void write_bytes(const std::filesystem::path& path, const Bytes& data) {
  std::ofstream out(path, std::ios::binary | std::ios::trunc);
  out.write(data.data(), static_cast<std::streamsize>(data.size()));
}

}  // namespace

IAQS_TEST(manifest, encode_decode_roundtrip) {
  const Manifest original = make_manifest();
  const Bytes encoded = original.encode();
  CHECK_EQ(encoded.size(), Manifest::kEncodedSize);

  Manifest decoded;
  CHECK(Manifest::decode(bytes_span(encoded), decoded));
  CHECK_EQ(decoded.format_version, kManifestFormatVersion);
  CHECK_EQ(decoded.page_size, 8192u);
  CHECK_EQ(decoded.segment_max, original.segment_max);
  CHECK(decoded.db_uuid == original.db_uuid);
}

IAQS_TEST(manifest, file_roundtrip) {
  const Manifest original = make_manifest();
  const auto path = temp_manifest_path();
  std::filesystem::remove(path);
  save_manifest(path.string(), original);
  const Manifest loaded = load_manifest(path.string());
  CHECK(loaded.db_uuid == original.db_uuid);
  CHECK_EQ(loaded.page_size, original.page_size);
  CHECK_EQ(loaded.segment_max, original.segment_max);
  std::filesystem::remove(path);
}

IAQS_TEST(manifest, rejects_corruption) {
  const Manifest original = make_manifest();
  Bytes encoded = original.encode();

  Bytes bad_crc = encoded;
  bad_crc[40] = static_cast<char>(bad_crc[40] ^ 0xff);
  Manifest decoded;
  CHECK(!Manifest::decode(bytes_span(bad_crc), decoded));

  Bytes truncated = encoded.substr(0, encoded.size() - 1);
  CHECK(!Manifest::decode(bytes_span(truncated), decoded));

  Bytes bad_magic = encoded;
  bad_magic[0] = 'X';
  CHECK(!Manifest::decode(bytes_span(bad_magic), decoded));

  // Sizing that the pager can never honour is rejected even with a good CRC.
  Bytes bad_page_size = encoded;
  uint8_t* p = reinterpret_cast<uint8_t*>(bad_page_size.data());
  store_u32_le(p + 12, 512);
  store_u32_le(p + 40, crc32c(p, 40));
  CHECK(!Manifest::decode(bytes_span(bad_page_size), decoded));
}

IAQS_TEST(manifest, random_identity_differs) {
  const Manifest a = make_manifest();
  const Manifest b = make_manifest();
  CHECK(!(a.db_uuid == b.db_uuid));
}

IAQS_TEST(manifest, legacy_password_manifest_is_refused_by_name) {
  const auto path = temp_manifest_path();
  std::filesystem::remove(path);
  write_bytes(path, legacy_manifest_bytes());
  bool explained = false;
  try {
    load_manifest(path.string());
  } catch (const std::runtime_error& error) {
    explained = std::string(error.what()).find("password mode") != std::string::npos;
  }
  CHECK(explained);
  std::filesystem::remove(path);
}

IAQS_TEST(manifest, unknown_manifest_is_refused) {
  const auto path = temp_manifest_path();
  std::filesystem::remove(path);
  write_bytes(path, Bytes(Manifest::kEncodedSize, '\x5a'));
  bool refused = false;
  try {
    load_manifest(path.string());
  } catch (const std::runtime_error& error) {
    refused = std::string(error.what()).find("corrupt or unsupported format") !=
              std::string::npos;
  }
  CHECK(refused);
  std::filesystem::remove(path);
}
