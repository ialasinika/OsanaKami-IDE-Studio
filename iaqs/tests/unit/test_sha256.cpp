#include "crypto/sha256.h"

#include <algorithm>
#include <string>

#include "harness.h"

using namespace iaqs;

namespace {

std::string digest_hex(ByteSpan data) { return sha256_hex(data); }

}  // namespace

IAQS_TEST(sha256, known_vectors) {
  CHECK_EQ(digest_hex(bytes_span("")),
           "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855");
  CHECK_EQ(digest_hex(bytes_span("abc")),
           "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad");
  CHECK_EQ(digest_hex(bytes_span("abcdbcdecdefdefgefghfghighijhijkijkljklmklmnlmnomnopnopq")),
           "248d6a61d20638b8e5c026930c3e6039a33ce45964ff2167f6ecedd419db06c1");
}

IAQS_TEST(sha256, million_a) {
  std::string data(1000000, 'a');
  CHECK_EQ(digest_hex(bytes_span(data)),
           "cdc76e5c9914fb9281a1c7e284d73e67f1809a48a497200e046d39ccc7112cd0");
}

IAQS_TEST(sha256, incremental_updates_match_single_shot) {
  std::string data;
  for (int i = 0; i < 5000; ++i) data.push_back(static_cast<char>((i * 37) & 0xff));
  const auto expected = sha256(bytes_span(data));

  Sha256 hasher;
  size_t offset = 0;
  size_t step = 1;
  while (offset < data.size()) {
    const size_t take = std::min(step, data.size() - offset);
    hasher.update(ByteSpan(reinterpret_cast<const uint8_t*>(data.data() + offset), take));
    offset += take;
    step = step * 3 + 1;
  }
  CHECK(sha256(bytes_span(data)) == expected);
  CHECK(hasher.finish() == expected);
}

IAQS_TEST(sha256, reset_reuses_object) {
  Sha256 hasher;
  hasher.update(bytes_span("abc"));
  CHECK_EQ(iaqs::to_hex(ByteSpan(hasher.finish().data(), 32)),
           "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad");
  hasher.reset();
  hasher.update(bytes_span(""));
  CHECK_EQ(iaqs::to_hex(ByteSpan(hasher.finish().data(), 32)),
           "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855");
}
