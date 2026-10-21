#include "crypto/crc32c.h"

#include <string>

#include "harness.h"

using namespace iaqs;

IAQS_TEST(crc32c, known_vectors) {
  CHECK_EQ(crc32c(bytes_span("")), 0u);
  CHECK_EQ(crc32c(bytes_span("123456789")), 0xE3069283u);
  CHECK_EQ(crc32c(bytes_span("The quick brown fox jumps over the lazy dog")),
           0x22620404u);
}

IAQS_TEST(crc32c, split_updates_match_single_shot) {
  Bytes data;
  for (int i = 0; i < 1000; ++i) data.push_back(static_cast<char>((i * 31 + 7) & 0xff));
  const uint32_t single = crc32c(bytes_span(data));
  uint32_t chained = crc32c(
      ByteSpan(reinterpret_cast<const uint8_t*>(data.data()), 37));
  chained = crc32c(ByteSpan(reinterpret_cast<const uint8_t*>(data.data()) + 37,
                            data.size() - 37),
                   chained);
  CHECK_EQ(chained, single);
}

IAQS_TEST(crc32c, binary_with_zero_bytes) {
  const uint8_t data[8] = {0, 0, 0, 0, 0, 0, 0, 0};
  CHECK_EQ(crc32c(ByteSpan(data, sizeof data)), crc32c(ByteSpan(data, sizeof data)));
}
