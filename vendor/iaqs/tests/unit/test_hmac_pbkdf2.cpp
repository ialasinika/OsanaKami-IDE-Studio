#include "crypto/hmac.h"

#include <string>

#include "core/util.h"
#include "harness.h"

using namespace iaqs;

namespace {

std::string hex(const Bytes& bytes) {
  return to_hex(bytes_span(bytes));
}

}  // namespace

// RFC 4231, section 4. Test case 1.
IAQS_TEST(hmac, rfc4231_case1) {
  Bytes key(20, static_cast<char>(0x0b));
  const auto mac = hmac_sha256(bytes_span(key), bytes_span("Hi There"));
  CHECK_EQ(iaqs::to_hex(ByteSpan(mac.data(), mac.size())),
           "b0344c61d8db38535ca8afceaf0bf12b881dc200c9833da726e9376c2e32cff7");
}

// RFC 4231, section 4. Test case 2.
IAQS_TEST(hmac, rfc4231_case2) {
  const auto mac = hmac_sha256(bytes_span("Jefe"),
                               bytes_span("what do ya want for nothing?"));
  CHECK_EQ(iaqs::to_hex(ByteSpan(mac.data(), mac.size())),
           "5bdcc146bf60754e6a042426089575c75a003f089d2739839dec58b964ec3843");
}

// RFC 4231, section 4. Test case 3.
IAQS_TEST(hmac, rfc4231_case3) {
  Bytes key(20, static_cast<char>(0xaa));
  Bytes data(50, static_cast<char>(0xdd));
  const auto mac = hmac_sha256(bytes_span(key), bytes_span(data));
  CHECK_EQ(iaqs::to_hex(ByteSpan(mac.data(), mac.size())),
           "773ea91e36800e46854db8ebd09181a72959098b3ef8c122d9635514ced565fe");
}

// RFC 4231, section 4. Test case 6: key longer than the block size.
IAQS_TEST(hmac, rfc4231_case6_long_key) {
  Bytes key(131, static_cast<char>(0xaa));
  const auto mac = hmac_sha256(bytes_span(key),
                               bytes_span("Test Using Larger Than Block-Size Key - Hash Key First"));
  CHECK_EQ(iaqs::to_hex(ByteSpan(mac.data(), mac.size())),
           "60e431591ee0b67f0d8a26aacbf5b77f8e0bc6213728c5140546040f0ee37f54");
}

// PBKDF2-HMAC-SHA256 vectors (commonly published; independent of SHA-1 case).
IAQS_TEST(pbkdf2, known_vectors) {
  CHECK_EQ(hex(pbkdf2_hmac_sha256(bytes_span("password"), bytes_span("salt"), 1, 32)),
           "120fb6cffcf8b32c43e7225256c4f837a86548c92ccc35480805987cb70be17b");
  CHECK_EQ(hex(pbkdf2_hmac_sha256(bytes_span("password"), bytes_span("salt"), 2, 32)),
           "ae4d0c95af6b46d32d0adff928f06dd02a303f8ef3c251dfd6e2d85a95474c43");
  CHECK_EQ(hex(pbkdf2_hmac_sha256(bytes_span("password"), bytes_span("salt"), 4096, 32)),
           "c5e478d59288c841aa530db6845c4c8d962893a001ce4e11a4963873aa98134a");
}

IAQS_TEST(pbkdf2, longer_output_is_block_concatenation) {
  const Bytes long_out = pbkdf2_hmac_sha256(bytes_span("pw"), bytes_span("NaCl"), 3, 69);
  const Bytes first = pbkdf2_hmac_sha256(bytes_span("pw"), bytes_span("NaCl"), 3, 32);
  CHECK_EQ(hex(long_out.substr(0, 32)), hex(first));
  CHECK_EQ(long_out.size(), 69u);
}

IAQS_TEST(pbkdf2, zero_iterations_rejected) {
  CHECK_THROW(pbkdf2_hmac_sha256(bytes_span("pw"), bytes_span("salt"), 0, 32),
              std::runtime_error);
}

IAQS_TEST(pbkdf2, empty_results) {
  Bytes out;
  pbkdf2_hmac_sha256(bytes_span("pw"), bytes_span("salt"), 1, ByteSpan());
  CHECK(out.empty());
  CHECK(pbkdf2_hmac_sha256(bytes_span("pw"), bytes_span("salt"), 1, 0).empty());
}
