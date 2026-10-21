// LZ1（IAQSLZ1）压缩格式的单元测试。
// 覆盖：空输入、单字节、重复文本压缩率、随机二进制、4 MiB 文本、
// 确定性、magic 判断，以及截断/篡改/长度不符时的异常。
#include "lz/lz1.h"

#include <cstdint>
#include <string>

#include "core/util.h"
#include "harness.h"

namespace {

// 极简确定性伪随机数发生器（xorshift32），避免引入第三方依赖。
struct Rng {
  uint32_t state;

  explicit Rng(uint32_t seed) : state(seed == 0 ? 0x9E3779B9u : seed) {}

  uint32_t next() {
    state ^= state << 13;
    state ^= state >> 17;
    state ^= state << 5;
    return state;
  }

  uint8_t next_byte() { return static_cast<uint8_t>(next() >> 24); }
};

iaqs::Bytes random_bytes(size_t size, uint32_t seed) {
  Rng rng(seed);
  iaqs::Bytes out(size, '\0');
  for (size_t i = 0; i < size; ++i) {
    out[i] = static_cast<char>(rng.next_byte());
  }
  return out;
}

// 同一段落重复多次：可压缩性极强，用于验证压缩率。
iaqs::Bytes repetitive_text(size_t copies) {
  const std::string paragraph =
      "the quick brown fox jumps over the lazy dog. "
      "pack my box with five dozen liquor jugs.\n";
  iaqs::Bytes out;
  out.reserve(paragraph.size() * copies);
  for (size_t i = 0; i < copies; ++i) {
    out += paragraph;
  }
  return out;
}

// 生成约 bytes 字节的伪文本（行内容带编号，近似真实文本，含 CRLF）。
iaqs::Bytes numbered_text(size_t bytes) {
  iaqs::Bytes out;
  out.reserve(bytes + 64);
  size_t i = 0;
  while (out.size() < bytes) {
    out += "line ";
    out += std::to_string(i);
    out += ": the quick brown fox jumps over the lazy dog\r\n";
    ++i;
  }
  out.resize(bytes);
  return out;
}

// 构造只含 magic + raw_len 的帧头。
iaqs::Bytes make_frame(uint64_t raw_len) {
  iaqs::Bytes frame;
  frame.append("IAQSLZ1", 7);
  iaqs::append_uvarint(frame, raw_len);
  return frame;
}

// 改写帧头中的 raw_len，token 流保持原样（用于制造「长度不符」）。
iaqs::Bytes rewrite_raw_len(iaqs::ByteSpan frame, uint64_t new_len) {
  iaqs::ByteSpan in = frame.subspan(7);
  uint64_t old_len = 0;
  CHECK(iaqs::read_uvarint(in, old_len));
  iaqs::Bytes out;
  out.assign(reinterpret_cast<const char*>(frame.data()), 7);
  iaqs::append_uvarint(out, new_len);
  out.append(reinterpret_cast<const char*>(in.data()), in.size());
  return out;
}

}  // namespace

IAQS_TEST(lz1, empty_input) {
  const iaqs::Bytes raw;
  const iaqs::Bytes compressed =
      iaqs::lz::lz1_compress(iaqs::bytes_span(raw));
  CHECK(iaqs::lz::lz1_is_compressed(iaqs::bytes_span(compressed)));
  CHECK(compressed.size() >= size_t{8});  // magic + raw_len
  CHECK_EQ(iaqs::lz::lz1_decompress(iaqs::bytes_span(compressed)), raw);
}

IAQS_TEST(lz1, single_byte) {
  for (const char value : {static_cast<char>(0x00), static_cast<char>(0x41),
                           static_cast<char>(0xFF)}) {
    const iaqs::Bytes raw(1, value);
    const iaqs::Bytes compressed =
        iaqs::lz::lz1_compress(iaqs::bytes_span(raw));
    CHECK_EQ(iaqs::lz::lz1_decompress(iaqs::bytes_span(compressed)), raw);
  }
}

IAQS_TEST(lz1, repetitive_text_compresses_well) {
  const iaqs::Bytes raw = repetitive_text(200);
  CHECK(raw.size() > size_t{1000});
  const iaqs::Bytes compressed =
      iaqs::lz::lz1_compress(iaqs::bytes_span(raw));
  // 重复文本至少应压缩到一半以下。
  CHECK(compressed.size() * 2 < raw.size());
  CHECK_EQ(iaqs::lz::lz1_decompress(iaqs::bytes_span(compressed)), raw);
}

IAQS_TEST(lz1, random_binary_roundtrip) {
  const iaqs::Bytes raw = random_bytes(200000, 0x00C0FFEEu);
  const iaqs::Bytes compressed =
      iaqs::lz::lz1_compress(iaqs::bytes_span(raw));
  CHECK_EQ(iaqs::lz::lz1_decompress(iaqs::bytes_span(compressed)), raw);
  // 不可压缩输入的膨胀必须很小（< 1%）。
  CHECK(compressed.size() < raw.size() + raw.size() / 100 + size_t{64});
}

IAQS_TEST(lz1, large_text_roundtrip) {
  const iaqs::Bytes raw = numbered_text(size_t{4} << 20);  // 4 MiB
  const iaqs::Bytes compressed =
      iaqs::lz::lz1_compress(iaqs::bytes_span(raw));
  CHECK_EQ(iaqs::lz::lz1_decompress(iaqs::bytes_span(compressed)), raw);
  CHECK(compressed.size() < raw.size());
}

IAQS_TEST(lz1, deterministic_output) {
  const iaqs::Bytes raw = numbered_text(100000);
  const iaqs::Bytes first = iaqs::lz::lz1_compress(iaqs::bytes_span(raw));
  const iaqs::Bytes second = iaqs::lz::lz1_compress(iaqs::bytes_span(raw));
  CHECK_EQ(first, second);
}

IAQS_TEST(lz1, is_compressed_detection) {
  const iaqs::Bytes empty;
  CHECK(!iaqs::lz::lz1_is_compressed(iaqs::bytes_span(empty)));
  CHECK(!iaqs::lz::lz1_is_compressed(iaqs::bytes_span(iaqs::Bytes("IAQSLZ"))));
  const iaqs::Bytes raw = numbered_text(1000);
  CHECK(!iaqs::lz::lz1_is_compressed(iaqs::bytes_span(raw)));
  CHECK(iaqs::lz::lz1_is_compressed(
      iaqs::bytes_span(iaqs::lz::lz1_compress(iaqs::bytes_span(raw)))));
}

IAQS_TEST(lz1, rejects_bad_magic_and_truncation) {
  const iaqs::Bytes raw = numbered_text(5000);
  const iaqs::Bytes good = iaqs::lz::lz1_compress(iaqs::bytes_span(raw));

  // magic 被篡改。
  iaqs::Bytes bad_magic = good;
  bad_magic[2] = 'X';
  CHECK_THROW(iaqs::lz::lz1_decompress(iaqs::bytes_span(bad_magic)),
              std::runtime_error);

  // 空输入不是合法帧。
  const iaqs::Bytes empty;
  CHECK_THROW(iaqs::lz::lz1_decompress(iaqs::bytes_span(empty)),
              std::runtime_error);

  // 帧尾被截断一个字节。
  iaqs::Bytes truncated = good;
  truncated.resize(truncated.size() - 1);
  CHECK_THROW(iaqs::lz::lz1_decompress(iaqs::bytes_span(truncated)),
              std::runtime_error);

  // 只有 magic、没有 raw_len。
  CHECK_THROW(iaqs::lz::lz1_decompress(iaqs::bytes_span(iaqs::Bytes("IAQSLZ1"))),
              std::runtime_error);
}

IAQS_TEST(lz1, rejects_tampered_lengths) {
  const iaqs::Bytes raw = numbered_text(5000);
  const iaqs::Bytes good = iaqs::lz::lz1_compress(iaqs::bytes_span(raw));

  // 声明比实际多 1 字节：token 流耗尽时长度仍不足。
  const iaqs::Bytes longer =
      rewrite_raw_len(iaqs::bytes_span(good), raw.size() + 1);
  CHECK_THROW(iaqs::lz::lz1_decompress(iaqs::bytes_span(longer)),
              std::runtime_error);

  // 声明比实际少 1 字节：某条指令会越过 raw_len。
  const iaqs::Bytes shorter =
      rewrite_raw_len(iaqs::bytes_span(good), raw.size() - 1);
  CHECK_THROW(iaqs::lz::lz1_decompress(iaqs::bytes_span(shorter)),
              std::runtime_error);

  // 尾随多余字节。
  iaqs::Bytes trailing = good;
  trailing.push_back('\0');
  CHECK_THROW(iaqs::lz::lz1_decompress(iaqs::bytes_span(trailing)),
              std::runtime_error);

  // raw_len 超上限（防炸弹）。
  const iaqs::Bytes oversized = make_frame(uint64_t{1} << 40);
  CHECK_THROW(iaqs::lz::lz1_decompress(iaqs::bytes_span(oversized)),
              std::runtime_error);
}

IAQS_TEST(lz1, rejects_invalid_tokens) {
  // dist = 0 非法。
  iaqs::Bytes dist_zero = make_frame(4);
  dist_zero.push_back(static_cast<char>(0x00));
  iaqs::append_uvarint(dist_zero, 0);
  iaqs::append_uvarint(dist_zero, 3);
  CHECK_THROW(iaqs::lz::lz1_decompress(iaqs::bytes_span(dist_zero)),
              std::runtime_error);

  // dist 超过已输出长度（引用不存在的历史）。
  iaqs::Bytes dist_ahead = make_frame(4);
  dist_ahead.push_back(static_cast<char>(0x00));
  iaqs::append_uvarint(dist_ahead, 5);
  iaqs::append_uvarint(dist_ahead, 3);
  CHECK_THROW(iaqs::lz::lz1_decompress(iaqs::bytes_span(dist_ahead)),
              std::runtime_error);

  // 匹配长度小于 3。
  iaqs::Bytes short_match = make_frame(4);
  short_match.push_back(static_cast<char>(0x01));  // 1 字节字面量
  short_match.push_back('a');
  short_match.push_back(static_cast<char>(0x00));
  iaqs::append_uvarint(short_match, 1);  // dist 合法
  iaqs::append_uvarint(short_match, 2);  // len 非法（< 3）
  CHECK_THROW(iaqs::lz::lz1_decompress(iaqs::bytes_span(short_match)),
              std::runtime_error);

  // 字面量负载被截断。
  iaqs::Bytes short_literal = make_frame(10);
  short_literal.push_back(static_cast<char>(0x05));  // 需要 5 字节，只给 2 字节
  short_literal += "ab";
  CHECK_THROW(iaqs::lz::lz1_decompress(iaqs::bytes_span(short_literal)),
              std::runtime_error);
}
