#include <array>
#include <filesystem>
#include <string>

#include "core/util.h"
#include "db/keys.h"
#include "db/manifest.h"
#include "harness.h"

using namespace iaqs;
using namespace iaqs::db;

namespace {

Manifest make_manifest() {
  return Manifest::create_public(8192, 16ull * 1024 * 1024, 1000);
}

std::filesystem::path temp_manifest_path() {
  return std::filesystem::temp_directory_path() / "iaqs_test_manifest.bin";
}

}  // namespace

IAQS_TEST(manifest, encode_decode_roundtrip) {
  Manifest original = make_manifest();
  Keyring::initialize(original, "correct horse battery staple");
  const Bytes encoded = original.encode();
  CHECK_EQ(encoded.size(), Manifest::kEncodedSize);

  Manifest decoded;
  CHECK(Manifest::decode(bytes_span(encoded), decoded));
  CHECK_EQ(decoded.page_size, 8192u);
  CHECK_EQ(decoded.segment_max, original.segment_max);
  CHECK_EQ(decoded.kdf_iters, 1000u);
  CHECK(decoded.db_uuid == original.db_uuid);
  CHECK(decoded.kdf_salt == original.kdf_salt);
  CHECK(decoded.wrapped_dek_ciphertext == original.wrapped_dek_ciphertext);
  CHECK(decoded.verifier_tag == original.verifier_tag);
}

IAQS_TEST(manifest, file_roundtrip) {
  Manifest original = make_manifest();
  Keyring::initialize(original, "pw");
  const auto path = temp_manifest_path();
  std::filesystem::remove(path);
  save_manifest(path.string(), original);
  const Manifest loaded = load_manifest(path.string());
  CHECK(loaded.db_uuid == original.db_uuid);
  Keyring ring;
  CHECK(ring.unlock(loaded, "pw"));
  std::filesystem::remove(path);
}

IAQS_TEST(manifest, rejects_corruption) {
  Manifest original = make_manifest();
  Keyring::initialize(original, "pw");
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
}

IAQS_TEST(manifest, random_fields_differ) {
  Manifest a = make_manifest();
  Manifest b = make_manifest();
  CHECK(!(a.db_uuid == b.db_uuid));
  CHECK(!(a.kdf_salt == b.kdf_salt));
}

IAQS_TEST(keys, unlock_success_and_wrong_password) {
  Manifest m = make_manifest();
  Keyring::initialize(m, "s3cret");
  {
    Keyring ring;
    CHECK(ring.unlock(m, "s3cret"));
    CHECK(ring.unlocked());
    CHECK(!(ring.keys().dek == Key32{}));
  }
  Keyring wrong;
  CHECK(!wrong.unlock(m, "wrong"));
  CHECK(!wrong.unlocked());
}

IAQS_TEST(keys, subkeys_are_deterministic_and_distinct) {
  Manifest m = make_manifest();
  Keyring::initialize(m, "pw");
  Keyring a;
  Keyring b;
  CHECK(a.unlock(m, "pw"));
  CHECK(b.unlock(m, "pw"));
  CHECK(a.keys().page_key == b.keys().page_key);
  CHECK(a.keys().wal_key == b.keys().wal_key);
  CHECK(a.keys().meta_key == b.keys().meta_key);
  CHECK(!(a.keys().page_key == a.keys().wal_key));
  CHECK(!(a.keys().page_key == a.keys().meta_key));
  CHECK(!(a.keys().wal_key == a.keys().meta_key));
}

IAQS_TEST(keys, tampered_verifier_rejected) {
  Manifest m = make_manifest();
  Keyring::initialize(m, "pw");
  m.verifier_tag[0] = static_cast<uint8_t>(m.verifier_tag[0] ^ 1);
  Keyring ring;
  CHECK(!ring.unlock(m, "pw"));
}

IAQS_TEST(keys, tampered_wrapped_dek_rejected) {
  Manifest m = make_manifest();
  Keyring::initialize(m, "pw");
  m.wrapped_dek_ciphertext[5] = static_cast<uint8_t>(m.wrapped_dek_ciphertext[5] ^ 1);
  Keyring ring;
  CHECK(!ring.unlock(m, "pw"));
}

IAQS_TEST(keys, wipe_clears_state) {
  Manifest m = make_manifest();
  Keyring::initialize(m, "pw");
  Keyring ring;
  CHECK(ring.unlock(m, "pw"));
  ring.wipe();
  CHECK(!ring.unlocked());
  CHECK(ring.keys().dek == Key32{});
}
