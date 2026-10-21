// delta（IAQSD1）格式的单元测试。
// 覆盖：base==target、追加/修改/删除一行、空 base/target、无换行长行、
// 随机二进制 roundtrip、头部长度被篡改、COPY 越界、截断/尾随字节、
// delta_ratio 与 is_delta。
#include "lz/delta.h"

#include <cstdint>
#include <string>
#include <vector>

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

// 生成 lines 行文本，每行内容各不相同（带编号）。
iaqs::Bytes make_line_text(size_t lines, const std::string& tag) {
  iaqs::Bytes out;
  for (size_t i = 0; i < lines; ++i) {
    out += "row " + std::to_string(i) + ": " + tag + " filler text\n";
  }
  return out;
}

// 每一行的起始偏移（第一行固定为 0）。
std::vector<size_t> line_starts(const iaqs::Bytes& text) {
  std::vector<size_t> starts;
  starts.push_back(0);
  for (size_t i = 0; i < text.size(); ++i) {
    if (text[i] == '\n' && i + 1 < text.size()) {
      starts.push_back(i + 1);
    }
  }
  return starts;
}

// 把第 index 行替换为 new_line（new_line 为空即删除该行）。
iaqs::Bytes replace_line(const iaqs::Bytes& text, size_t index,
                         const std::string& new_line) {
  const std::vector<size_t> starts = line_starts(text);
  const size_t begin = starts.at(index);
  const size_t end = index + 1 < starts.size() ? starts[index + 1] : text.size();
  iaqs::Bytes out(text.data(), begin);
  out += new_line;
  out.append(text.data() + end, text.size() - end);
  return out;
}

// 用 append_uvarint 手工拼一个 delta 帧头。
iaqs::Bytes make_header(size_t base_size, size_t tgt_size) {
  iaqs::Bytes out;
  out.append("IAQSD1", 6);
  iaqs::append_uvarint(out, base_size);
  iaqs::append_uvarint(out, tgt_size);
  return out;
}

}  // namespace

IAQS_TEST(delta, identical_input_is_tiny) {
  const iaqs::Bytes base = make_line_text(120, "alpha");
  const iaqs::Bytes target = base;
  const iaqs::Bytes delta =
      iaqs::delta::make_delta(iaqs::bytes_span(base), iaqs::bytes_span(target));
  CHECK(iaqs::delta::is_delta(iaqs::bytes_span(delta)));
  CHECK(delta.size() < size_t{64});
  CHECK(iaqs::delta::delta_ratio(iaqs::bytes_span(delta),
                                 iaqs::bytes_span(target)) < 0.05);
  CHECK_EQ(iaqs::delta::apply_delta(iaqs::bytes_span(base),
                                    iaqs::bytes_span(delta)),
           target);
}

IAQS_TEST(delta, append_one_line) {
  const iaqs::Bytes base = make_line_text(100, "alpha");
  iaqs::Bytes target = base;
  target += "a brand new appended line\n";
  const iaqs::Bytes delta =
      iaqs::delta::make_delta(iaqs::bytes_span(base), iaqs::bytes_span(target));
  CHECK(iaqs::delta::delta_ratio(iaqs::bytes_span(delta),
                                 iaqs::bytes_span(target)) < 0.20);
  CHECK_EQ(iaqs::delta::apply_delta(iaqs::bytes_span(base),
                                    iaqs::bytes_span(delta)),
           target);
}

IAQS_TEST(delta, change_one_line) {
  const iaqs::Bytes base = make_line_text(100, "alpha");
  const iaqs::Bytes target =
      replace_line(base, 50, "row 50: this line was changed\n");
  const iaqs::Bytes delta =
      iaqs::delta::make_delta(iaqs::bytes_span(base), iaqs::bytes_span(target));
  // 改一行的 delta 应明显小于目标体积（要求 < 20%）。
  CHECK(iaqs::delta::delta_ratio(iaqs::bytes_span(delta),
                                 iaqs::bytes_span(target)) < 0.20);
  CHECK_EQ(iaqs::delta::apply_delta(iaqs::bytes_span(base),
                                    iaqs::bytes_span(delta)),
           target);
}

IAQS_TEST(delta, delete_one_line) {
  const iaqs::Bytes base = make_line_text(100, "alpha");
  const iaqs::Bytes target = replace_line(base, 50, "");
  const iaqs::Bytes delta =
      iaqs::delta::make_delta(iaqs::bytes_span(base), iaqs::bytes_span(target));
  CHECK(iaqs::delta::delta_ratio(iaqs::bytes_span(delta),
                                 iaqs::bytes_span(target)) < 0.20);
  CHECK_EQ(iaqs::delta::apply_delta(iaqs::bytes_span(base),
                                    iaqs::bytes_span(delta)),
           target);
}

IAQS_TEST(delta, empty_inputs) {
  const iaqs::Bytes empty;
  const iaqs::Bytes text = make_line_text(5, "beta");

  // 空 base → 空 target：合法空 delta，ratio 定义为 1.0。
  iaqs::Bytes delta =
      iaqs::delta::make_delta(iaqs::bytes_span(empty), iaqs::bytes_span(empty));
  CHECK(iaqs::delta::is_delta(iaqs::bytes_span(delta)));
  CHECK_EQ(iaqs::delta::apply_delta(iaqs::bytes_span(empty),
                                    iaqs::bytes_span(delta)),
           empty);
  CHECK_EQ(iaqs::delta::delta_ratio(iaqs::bytes_span(delta),
                                    iaqs::bytes_span(empty)),
           1.0);

  // 空 base → 非空 target（全部 INSERT）。
  delta = iaqs::delta::make_delta(iaqs::bytes_span(empty),
                                  iaqs::bytes_span(text));
  CHECK_EQ(iaqs::delta::apply_delta(iaqs::bytes_span(empty),
                                    iaqs::bytes_span(delta)),
           text);

  // 非空 base → 空 target（无指令）。
  delta =
      iaqs::delta::make_delta(iaqs::bytes_span(text), iaqs::bytes_span(empty));
  CHECK_EQ(iaqs::delta::apply_delta(iaqs::bytes_span(text),
                                    iaqs::bytes_span(delta)),
           empty);
  CHECK_EQ(iaqs::delta::delta_ratio(iaqs::bytes_span(delta),
                                    iaqs::bytes_span(empty)),
           1.0);
}

IAQS_TEST(delta, long_line_without_newline) {
  iaqs::Bytes base;
  while (base.size() < size_t{4096}) {
    base += "abcdefghij";  // 整份文件只有一行，没有 '\n'
  }
  CHECK(base.find('\n') == std::string::npos);

  // 完全相同：应退化为一条大 COPY。
  const iaqs::Bytes same_delta =
      iaqs::delta::make_delta(iaqs::bytes_span(base), iaqs::bytes_span(base));
  CHECK(same_delta.size() < size_t{64});
  CHECK_EQ(iaqs::delta::apply_delta(iaqs::bytes_span(base),
                                    iaqs::bytes_span(same_delta)),
           base);

  // 改一个字节：行内不做字节级微调，但仍必须正确还原。
  iaqs::Bytes target = base;
  target[10] = 'Z';
  const iaqs::Bytes delta = iaqs::delta::make_delta(
      iaqs::bytes_span(base), iaqs::bytes_span(target));
  CHECK_EQ(iaqs::delta::apply_delta(iaqs::bytes_span(base),
                                    iaqs::bytes_span(delta)),
           target);
}

IAQS_TEST(delta, random_binary_roundtrip) {
  for (const size_t size : {size_t{1}, size_t{1000}, size_t{100000}}) {
    const iaqs::Bytes base = random_bytes(size, static_cast<uint32_t>(size));
    const iaqs::Bytes target = random_bytes(size + 7, 0xA5A5A5A5u);
    const iaqs::Bytes delta = iaqs::delta::make_delta(
        iaqs::bytes_span(base), iaqs::bytes_span(target));
    CHECK(iaqs::delta::is_delta(iaqs::bytes_span(delta)));
    CHECK_EQ(iaqs::delta::apply_delta(iaqs::bytes_span(base),
                                      iaqs::bytes_span(delta)),
             target);
  }
}

IAQS_TEST(delta, never_throws_on_arbitrary_input) {
  // 任意输入都必须能生成合法 delta 并能原样还原。
  for (const size_t size : {size_t{0}, size_t{17}, size_t{4096}}) {
    for (const uint32_t seed : {1u, 7u}) {
      const iaqs::Bytes base = random_bytes(size, seed * 31 + 1);
      const iaqs::Bytes target = random_bytes(size, seed * 17 + 5);
      const iaqs::Bytes delta = iaqs::delta::make_delta(
          iaqs::bytes_span(base), iaqs::bytes_span(target));
      CHECK(iaqs::delta::is_delta(iaqs::bytes_span(delta)));
      CHECK_EQ(iaqs::delta::apply_delta(iaqs::bytes_span(base),
                                        iaqs::bytes_span(delta)),
               target);
    }
  }
}

IAQS_TEST(delta, rejects_header_tampering) {
  const iaqs::Bytes base = make_line_text(10, "gamma");

  // base_size 与实际 base 长度不符。
  const iaqs::Bytes bad_base = make_header(base.size() + 1, base.size());
  CHECK_THROW(iaqs::delta::apply_delta(iaqs::bytes_span(base),
                                       iaqs::bytes_span(bad_base)),
              std::runtime_error);

  // base_size 偏小同样拒绝。
  const iaqs::Bytes small_base = make_header(base.size() - 1, base.size());
  CHECK_THROW(iaqs::delta::apply_delta(iaqs::bytes_span(base),
                                       iaqs::bytes_span(small_base)),
              std::runtime_error);

  // tgt_size 被改小：COPY 指令长度越过目标。
  iaqs::Bytes tgt_small = make_header(base.size(), 1);
  tgt_small.push_back(static_cast<char>(0x00));  // COPY
  iaqs::append_uvarint(tgt_small, 0);            // off
  iaqs::append_uvarint(tgt_small, base.size());  // len > tgt_size
  CHECK_THROW(iaqs::delta::apply_delta(iaqs::bytes_span(base),
                                       iaqs::bytes_span(tgt_small)),
              std::runtime_error);

  // tgt_size 被改大：指令流耗尽时输出仍不足。
  iaqs::Bytes tgt_large = make_header(base.size(), base.size() + 1);
  tgt_large.push_back(static_cast<char>(0x00));  // COPY
  iaqs::append_uvarint(tgt_large, 0);
  iaqs::append_uvarint(tgt_large, base.size());
  CHECK_THROW(iaqs::delta::apply_delta(iaqs::bytes_span(base),
                                       iaqs::bytes_span(tgt_large)),
              std::runtime_error);

  // 未知指令（0x02）。
  iaqs::Bytes unknown = make_header(base.size(), 1);
  unknown.push_back(static_cast<char>(0x02));
  CHECK_THROW(iaqs::delta::apply_delta(iaqs::bytes_span(base),
                                       iaqs::bytes_span(unknown)),
              std::runtime_error);
}

IAQS_TEST(delta, rejects_copy_out_of_range) {
  const iaqs::Bytes base = make_line_text(3, "delta");

  // off 恰好等于 base 长度（空拷贝区间之后仍越界语义）。
  iaqs::Bytes off_at_end = make_header(base.size(), 10);
  off_at_end.push_back(static_cast<char>(0x00));
  iaqs::append_uvarint(off_at_end, base.size());
  iaqs::append_uvarint(off_at_end, 1);
  CHECK_THROW(iaqs::delta::apply_delta(iaqs::bytes_span(base),
                                       iaqs::bytes_span(off_at_end)),
              std::runtime_error);

  // len 越过 base 末尾。
  iaqs::Bytes len_too_big = make_header(base.size(), 10);
  len_too_big.push_back(static_cast<char>(0x00));
  iaqs::append_uvarint(len_too_big, 0);
  iaqs::append_uvarint(len_too_big, base.size() + 1);
  CHECK_THROW(iaqs::delta::apply_delta(iaqs::bytes_span(base),
                                       iaqs::bytes_span(len_too_big)),
              std::runtime_error);

  // off + len 恰好越过末尾。
  iaqs::Bytes off_plus_len = make_header(base.size(), 10);
  off_plus_len.push_back(static_cast<char>(0x00));
  iaqs::append_uvarint(off_plus_len, base.size() - 1);
  iaqs::append_uvarint(off_plus_len, 2);
  CHECK_THROW(iaqs::delta::apply_delta(iaqs::bytes_span(base),
                                       iaqs::bytes_span(off_plus_len)),
              std::runtime_error);
}

IAQS_TEST(delta, rejects_truncation_and_trailing_bytes) {
  const iaqs::Bytes base = make_line_text(20, "epsilon");
  const iaqs::Bytes target = replace_line(base, 10, "changed line\n");
  const iaqs::Bytes delta =
      iaqs::delta::make_delta(iaqs::bytes_span(base), iaqs::bytes_span(target));

  // 帧被截断（最后一条指令的负载不完整）。
  iaqs::Bytes truncated = delta;
  truncated.resize(truncated.size() - 1);
  CHECK_THROW(iaqs::delta::apply_delta(iaqs::bytes_span(base),
                                       iaqs::bytes_span(truncated)),
              std::runtime_error);

  // 帧头都不完整。
  iaqs::Bytes short_header = delta;
  short_header.resize(3);
  CHECK_THROW(iaqs::delta::apply_delta(iaqs::bytes_span(base),
                                       iaqs::bytes_span(short_header)),
              std::runtime_error);

  // 解出 tgt_size 之后还有多余字节。
  iaqs::Bytes trailing = delta;
  trailing.push_back('\0');
  CHECK_THROW(iaqs::delta::apply_delta(iaqs::bytes_span(base),
                                       iaqs::bytes_span(trailing)),
              std::runtime_error);

  // 空 delta 不是合法帧。
  const iaqs::Bytes empty;
  CHECK_THROW(iaqs::delta::apply_delta(iaqs::bytes_span(base),
                                       iaqs::bytes_span(empty)),
              std::runtime_error);
}

IAQS_TEST(delta, ratio_reasonable_for_one_line_change) {
  const iaqs::Bytes base = make_line_text(200, "alpha");
  const iaqs::Bytes target =
      replace_line(base, 100, "row 100: only this line changed\n");
  const iaqs::Bytes delta =
      iaqs::delta::make_delta(iaqs::bytes_span(base), iaqs::bytes_span(target));
  CHECK(iaqs::delta::delta_ratio(iaqs::bytes_span(delta),
                                 iaqs::bytes_span(target)) < 0.20);
  CHECK_EQ(iaqs::delta::apply_delta(iaqs::bytes_span(base),
                                    iaqs::bytes_span(delta)),
           target);
}

IAQS_TEST(delta, is_delta_detection) {
  const iaqs::Bytes text = make_line_text(3, "zeta");
  const iaqs::Bytes delta =
      iaqs::delta::make_delta(iaqs::bytes_span(text), iaqs::bytes_span(text));
  CHECK(iaqs::delta::is_delta(iaqs::bytes_span(delta)));
  CHECK(!iaqs::delta::is_delta(iaqs::bytes_span(text)));
  CHECK(!iaqs::delta::is_delta(iaqs::bytes_span(iaqs::Bytes("IAQSD"))));
  CHECK(!iaqs::delta::is_delta(iaqs::bytes_span(iaqs::Bytes("IAQSLZ1"))));
  const iaqs::Bytes empty;
  CHECK(!iaqs::delta::is_delta(iaqs::bytes_span(empty)));
}
