#include <cstdint>
#include <filesystem>
#include <string>
#include <vector>

#include "core/util.h"
#include "harness.h"

using namespace iaqs;

IAQS_TEST(util, hex_roundtrip) {
  Bytes raw;
  for (int i = 0; i < 256; ++i) raw.push_back(static_cast<char>(i));
  const std::string text = to_hex(bytes_span(raw));
  CHECK_EQ(text.size(), 512u);
  Bytes back;
  CHECK(from_hex(text, back));
  CHECK_EQ(back, raw);
  CHECK(from_hex("", back));
  CHECK(back.empty());
  CHECK(!from_hex("zz", back));
  CHECK(!from_hex("abc", back));
}

IAQS_TEST(util, uvarint_roundtrip) {
  const std::vector<uint64_t> values = {0,          1,          2,
                                        127,        128,        300,
                                        16383,      16384,      1u << 20,
                                        0xffffffffu, 0xffffffffffffffffull};
  for (uint64_t value : values) {
    Bytes encoded;
    append_uvarint(encoded, value);
    ByteSpan span = bytes_span(encoded);
    uint64_t decoded = 0;
    CHECK(read_uvarint(span, decoded));
    CHECK_EQ(decoded, value);
    CHECK(span.empty());
  }
}

IAQS_TEST(util, uvarint_rejects_truncated) {
  Bytes encoded;
  append_uvarint(encoded, 300);
  encoded.pop_back();
  ByteSpan span = bytes_span(encoded);
  uint64_t decoded = 0;
  CHECK(!read_uvarint(span, decoded));

  // 11 continuation bytes is longer than any valid encoding.
  Bytes too_long(11, static_cast<char>(0x80));
  ByteSpan long_span = bytes_span(too_long);
  CHECK(!read_uvarint(long_span, decoded));
}

IAQS_TEST(util, little_endian_roundtrip) {
  uint8_t buffer[8];
  store_u16_le(buffer, 0x1234);
  CHECK_EQ(load_u16_le(buffer), 0x1234u);
  store_u32_le(buffer, 0xdeadbeefu);
  CHECK_EQ(load_u32_le(buffer), 0xdeadbeefu);
  store_u64_le(buffer, 0x0123456789abcdefull);
  CHECK_EQ(load_u64_le(buffer), 0x0123456789abcdefull);
}

IAQS_TEST(util, string_helpers) {
  const std::vector<std::string_view> parts = split("a,b,,c", ',');
  CHECK_EQ(parts.size(), 4u);
  CHECK_EQ(std::string(parts[0]), "a");
  CHECK_EQ(std::string(parts[2]), "");
  CHECK_EQ(trim("  hello \t\r\n"), "hello");
  CHECK_EQ(to_lower_ascii("AbC_1"), "abc_1");
  CHECK(starts_with("refs/heads/main", "refs/"));
  CHECK(!starts_with("refs", "refs/"));
}

IAQS_TEST(util, atomic_file_write_and_read) {
  const auto path = std::filesystem::temp_directory_path() / "iaqs_util_test.bin";
  std::filesystem::remove(path);
  Bytes payload;
  payload.push_back('\0');
  payload.push_back('h');
  payload.push_back('i');
  for (int i = 0; i < 300; ++i) payload.push_back(static_cast<char>(i & 0xff));
  write_file_atomic(path.string(), bytes_span(payload));
  CHECK(file_exists(path.string()));
  CHECK_EQ(file_size(path.string()), static_cast<uint64_t>(payload.size()));
  CHECK_EQ(read_file(path.string()), payload);
  remove_file(path.string());
  CHECK(!file_exists(path.string()));
}
