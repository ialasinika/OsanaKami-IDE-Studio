#include <cstdint>
#include <string>
#include <vector>

#include "core/util.h"
#include "git/zlib_stream.h"
#include "harness.h"

using namespace iaqs;
using namespace iaqs::git;

IAQS_TEST(git_zlib, stored_roundtrip_sizes) {
  const std::vector<std::size_t> sizes = {0, 1, 17, 1000, 70000};
  for (const std::size_t size : sizes) {
    std::string payload(size, '\0');
    for (std::size_t i = 0; i < size; ++i) {
      payload[i] = static_cast<char>((i * 37 + 11) & 0xFF);
    }
    const Bytes compressed = zlib_compress_stored(bytes_span(payload));
    CHECK(!compressed.empty());
    const Bytes inflated = zlib_decompress(bytes_span(compressed), size);
    CHECK_EQ(inflated, payload);
  }
}

IAQS_TEST(git_zlib, consumed_bytes_and_expected_size) {
  const std::string payload = "hello world, hello zlib";
  const Bytes compressed = zlib_compress_stored(bytes_span(payload));
  std::size_t consumed = 0;
  const Bytes inflated = zlib_decompress(bytes_span(compressed), payload.size(), &consumed);
  CHECK_EQ(inflated, payload);
  CHECK_EQ(consumed, compressed.size());

  const Bytes unknown = zlib_decompress(bytes_span(compressed));
  CHECK_EQ(unknown, payload);
}

IAQS_TEST(git_zlib, wrong_expected_size_is_rejected) {
  const std::string payload = "abc";
  const Bytes compressed = zlib_compress_stored(bytes_span(payload));
  CHECK_THROW(zlib_decompress(bytes_span(compressed), payload.size() - 1), std::runtime_error);
  CHECK_THROW(zlib_decompress(bytes_span(compressed), payload.size() + 1), std::runtime_error);
}

IAQS_TEST(git_zlib, truncated_and_corrupt_streams_are_rejected) {
  const std::string payload = "some payload to compress";
  const Bytes compressed = zlib_compress_stored(bytes_span(payload));
  CHECK_THROW(zlib_decompress(bytes_span(compressed).first(compressed.size() / 2)),
              std::runtime_error);
  Bytes corrupt = compressed;
  corrupt[0] = 0x00;  // invalid zlib CMF
  CHECK_THROW(zlib_decompress(bytes_span(corrupt)), std::runtime_error);
}

IAQS_TEST(git_zlib, checksums_match_zlib_reference_values) {
  const std::string_view text = "123456789";
  CHECK_EQ(crc32_zlib(bytes_span(text)), uint32_t{0xCBF43926u});
  CHECK_EQ(adler32(bytes_span(text)), uint32_t{0x091E01DEu});
  CHECK_EQ(crc32_zlib(bytes_span(std::string_view{})), uint32_t{0});
  CHECK_EQ(adler32(bytes_span(std::string_view{})), uint32_t{1});
}
