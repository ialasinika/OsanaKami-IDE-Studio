#include "git/zlib_stream.h"

#include <algorithm>
#include <array>
#include <stdexcept>
#include <vector>

namespace iaqs::git {
namespace {

[[noreturn]] void fail(const std::string& what) { throw std::runtime_error("zlib: " + what); }

class BitReader {
 public:
  explicit BitReader(ByteSpan input) : input_(input) {}

  uint32_t bits(int count) {
    if (count == 0) return 0;
    if (!ensure(static_cast<unsigned>(count))) fail("truncated stream");
    const uint32_t value = buffer_ & ((1u << count) - 1u);
    buffer_ >>= count;
    bits_left_ -= count;
    return value;
  }

  void align_to_byte() {
    // Discard bits from the current partially consumed byte. Whole bytes that
    // were prefetched must be "unread" so callers can see the trailer.
    const unsigned discard = bits_left_ % 8;
    buffer_ >>= discard;
    bits_left_ -= static_cast<int>(discard);
    if (bits_left_ > 0) {
      pos_ -= static_cast<std::size_t>(bits_left_ / 8);
      bits_left_ = 0;
      buffer_ = 0;
    }
  }

  uint8_t byte() {
    if (bits_left_ >= 8) {
      const uint8_t value = static_cast<uint8_t>(buffer_ & 0xFFu);
      buffer_ >>= 8;
      bits_left_ -= 8;
      return value;
    }
    if (pos_ >= input_.size()) fail("truncated stream");
    return input_[pos_++];
  }

  uint32_t bits_le(int count) {
    uint32_t value = 0;
    for (int i = 0; i < count; ++i) value |= bits(1) << i;
    return value;
  }

  std::size_t consumed() const { return pos_; }

  std::size_t remaining() const { return input_.size() - pos_; }
  ByteSpan rest() const { return input_.subspan(pos_); }

 private:
  bool ensure(unsigned count) {
    while (static_cast<unsigned>(bits_left_) < count) {
      if (pos_ >= input_.size()) return false;
      buffer_ |= static_cast<uint32_t>(input_[pos_++]) << bits_left_;
      bits_left_ += 8;
    }
    return true;
  }

  ByteSpan input_;
  std::size_t pos_ = 0;
  uint32_t buffer_ = 0;
  int bits_left_ = 0;
};

struct Huffman {
  std::array<int, 16> counts{};
  std::array<int, 288> symbols{};

  void build(const std::vector<int>& lengths) {
    counts.fill(0);
    symbols.fill(0);
    for (const int length : lengths) {
      if (length < 0 || length > 15) fail("bad code length");
      ++counts[static_cast<std::size_t>(length)];
    }
    if (counts[0] == static_cast<int>(lengths.size())) return;  // all zero: unused tree
    counts[0] = 0;
    std::array<int, 16> offsets{};
    int total = 0;
    for (int length = 1; length < 16; ++length) {
      offsets[static_cast<std::size_t>(length)] = total;
      total += counts[static_cast<std::size_t>(length)];
    }
    for (std::size_t i = 0; i < lengths.size(); ++i) {
      const int length = lengths[i];
      if (length == 0) continue;
      symbols[static_cast<std::size_t>(offsets[static_cast<std::size_t>(length)]++)] = static_cast<int>(i);
    }
  }

  int decode(BitReader& reader) const {
    int code = 0;
    int first = 0;
    int index = 0;
    for (int length = 1; length < 16; ++length) {
      code |= static_cast<int>(reader.bits(1));
      const int count = counts[static_cast<std::size_t>(length)];
      if (code - first < count) return symbols[static_cast<std::size_t>(index + (code - first))];
      index += count;
      first = (first + count) << 1;
      code <<= 1;
    }
    fail("invalid Huffman code");
  }
};

constexpr int kLengthBase[29] = {3,  4,  5,  6,  7,  8,  9,  10, 11,  13,  15,  17,  19,
                                 23, 27, 31, 35, 43, 51, 59, 67, 83, 99, 115, 131, 163,
                                 195, 227, 258};
constexpr int kLengthExtra[29] = {0, 0, 0, 0, 0, 0, 0, 0, 1, 1, 1, 1, 2, 2, 2,
                                  2, 3, 3, 3, 3, 4, 4, 4, 4, 5, 5, 5, 5, 0};
constexpr int kDistanceBase[30] = {1,    2,    3,    4,    5,    7,     9,     13,    17,  25,
                                   33,   49,   65,   97,   129,  193,   257,   385,   513, 769,
                                   1025, 1537, 2049, 3073, 4097, 6145, 8193, 12289, 16385, 24577};
constexpr int kDistanceExtra[30] = {0, 0, 0, 0, 1, 1, 2, 2,  3,  3,  4,  4,  5,  5,  6,
                                    6, 7, 7, 8, 8, 9, 9, 10, 10, 11, 11, 12, 12, 13, 13};

void inflate_codes(BitReader& reader, Bytes& out, const Huffman& literals,
                   const Huffman& distances, uint64_t limit) {
  for (;;) {
    const int symbol = literals.decode(reader);
    if (symbol < 256) {
      out.push_back(static_cast<char>(symbol));
      if (out.size() > limit) fail("output too large");
      continue;
    }
    if (symbol == 256) return;
    if (symbol < 257 || symbol > 285) fail("bad length symbol");
    const int length_index = symbol - 257;
    int length = kLengthBase[length_index];
    if (kLengthExtra[length_index] != 0) {
      length += static_cast<int>(reader.bits(kLengthExtra[length_index]));
    }
    const int distance_symbol = distances.decode(reader);
    if (distance_symbol < 0 || distance_symbol > 29) fail("bad distance symbol");
    int distance = kDistanceBase[distance_symbol];
    if (kDistanceExtra[distance_symbol] != 0) {
      distance += static_cast<int>(reader.bits(kDistanceExtra[distance_symbol]));
    }
    if (distance <= 0 || static_cast<std::size_t>(distance) > out.size()) fail("bad distance");
    const std::size_t start = out.size() - static_cast<std::size_t>(distance);
    for (int i = 0; i < length; ++i) {
      out.push_back(out[start + static_cast<std::size_t>(i)]);
      if (out.size() > limit) fail("output too large");
    }
  }
}

void build_fixed(Huffman& literals, Huffman& distances) {
  std::vector<int> lit_lengths(288);
  for (int i = 0; i < 144; ++i) lit_lengths[static_cast<std::size_t>(i)] = 8;
  for (int i = 144; i < 256; ++i) lit_lengths[static_cast<std::size_t>(i)] = 9;
  for (int i = 256; i < 280; ++i) lit_lengths[static_cast<std::size_t>(i)] = 7;
  for (int i = 280; i < 288; ++i) lit_lengths[static_cast<std::size_t>(i)] = 8;
  literals.build(lit_lengths);
  distances.build(std::vector<int>(30, 5));
}

void build_dynamic(BitReader& reader, Huffman& literals, Huffman& distances) {
  const int hlit = static_cast<int>(reader.bits(5)) + 257;
  const int hdist = static_cast<int>(reader.bits(5)) + 1;
  const int hclen = static_cast<int>(reader.bits(4)) + 4;
  static constexpr int kOrder[19] = {16, 17, 18, 0, 8,  7, 9,  6, 10, 5,
                                     11, 4,  12, 3, 13, 2, 14, 1, 15};
  std::vector<int> code_lengths(19, 0);
  for (int i = 0; i < hclen; ++i) {
    code_lengths[static_cast<std::size_t>(kOrder[i])] = static_cast<int>(reader.bits(3));
  }
  Huffman code_huffman;
  code_huffman.build(code_lengths);

  std::vector<int> lengths;
  lengths.reserve(static_cast<std::size_t>(hlit + hdist));
  while (static_cast<int>(lengths.size()) < hlit + hdist) {
    const int symbol = code_huffman.decode(reader);
    if (symbol < 16) {
      lengths.push_back(symbol);
    } else if (symbol == 16) {
      if (lengths.empty()) fail("repeat with no previous length");
      const int repeat = 3 + static_cast<int>(reader.bits(2));
      const int previous = lengths.back();
      for (int i = 0; i < repeat; ++i) lengths.push_back(previous);
    } else if (symbol == 17) {
      const int repeat = 3 + static_cast<int>(reader.bits(3));
      for (int i = 0; i < repeat; ++i) lengths.push_back(0);
    } else if (symbol == 18) {
      const int repeat = 11 + static_cast<int>(reader.bits(7));
      for (int i = 0; i < repeat; ++i) lengths.push_back(0);
    } else {
      fail("bad code length symbol");
    }
  }
  if (static_cast<int>(lengths.size()) != hlit + hdist) fail("too many code lengths");
  literals.build(std::vector<int>(lengths.begin(), lengths.begin() + hlit));
  distances.build(std::vector<int>(lengths.begin() + hlit, lengths.end()));
}

}  // namespace

uint32_t adler32(ByteSpan data) {
  uint32_t a = 1;
  uint32_t b = 0;
  for (const uint8_t byte : data) {
    a = (a + byte) % 65521u;
    b = (b + a) % 65521u;
  }
  return (b << 16) | a;
}

uint32_t crc32_zlib(ByteSpan data) {
  static std::array<uint32_t, 256> table = [] {
    std::array<uint32_t, 256> values{};
    for (uint32_t i = 0; i < 256; ++i) {
      uint32_t crc = i;
      for (int bit = 0; bit < 8; ++bit) {
        crc = (crc & 1u) != 0 ? (crc >> 1) ^ 0xEDB88320u : crc >> 1;
      }
      values[i] = crc;
    }
    return values;
  }();
  uint32_t crc = 0xFFFFFFFFu;
  for (const uint8_t byte : data) {
    crc = table[(crc ^ byte) & 0xFFu] ^ (crc >> 8);
  }
  return crc ^ 0xFFFFFFFFu;
}

Bytes zlib_decompress(ByteSpan input, uint64_t expected_size, std::size_t* consumed) {
  if (input.size() < 2) fail("truncated header");
  const uint8_t cmf = input[0];
  const uint8_t flg = input[1];
  if ((cmf & 0x0F) != 8) fail("unsupported compression method");
  if (((static_cast<uint32_t>(cmf) << 8) | flg) % 31 != 0) fail("bad header checksum");
  if ((flg & 0x20) != 0) fail("preset dictionaries are unsupported");

  BitReader reader(input.subspan(2));
  Bytes out;
  const uint64_t limit = expected_size == kUnknownSize ? (static_cast<uint64_t>(1) << 31)
                                                       : expected_size;
  out.reserve(static_cast<std::size_t>(std::min<uint64_t>(limit, 1u << 20)));
  bool final_block = false;
  while (!final_block) {
    final_block = reader.bits(1) != 0;
    const int type = static_cast<int>(reader.bits(2));
    if (type == 0) {
      reader.align_to_byte();
      const uint16_t len = static_cast<uint16_t>(reader.byte()) |
                           (static_cast<uint16_t>(reader.byte()) << 8);
      const uint16_t nlen = static_cast<uint16_t>(reader.byte()) |
                            (static_cast<uint16_t>(reader.byte()) << 8);
      if (static_cast<uint16_t>(~len) != nlen) fail("stored block length mismatch");
      for (int i = 0; i < len; ++i) out.push_back(static_cast<char>(reader.byte()));
    } else if (type == 1) {
      Huffman literals;
      Huffman distances;
      build_fixed(literals, distances);
      inflate_codes(reader, out, literals, distances, limit);
    } else if (type == 2) {
      Huffman literals;
      Huffman distances;
      build_dynamic(reader, literals, distances);
      inflate_codes(reader, out, literals, distances, limit);
    } else {
      fail("reserved block type");
    }
    if (out.size() > limit) fail("output exceeds expected size");
  }
  reader.align_to_byte();
  const std::size_t body_consumed = reader.consumed();
  if (reader.remaining() < 4) fail("missing Adler-32");
  const ByteSpan trailer = reader.rest();
  const uint32_t expected_adler = (static_cast<uint32_t>(trailer[0]) << 24) |
                                  (static_cast<uint32_t>(trailer[1]) << 16) |
                                  (static_cast<uint32_t>(trailer[2]) << 8) |
                                  static_cast<uint32_t>(trailer[3]);
  if (adler32(ByteSpan(reinterpret_cast<const uint8_t*>(out.data()), out.size())) != expected_adler) {
    fail("Adler-32 mismatch");
  }
  if (expected_size != kUnknownSize && out.size() != expected_size) fail("size mismatch");
  if (consumed != nullptr) *consumed = 2 + body_consumed + 4;
  return out;
}

Bytes zlib_compress_stored(ByteSpan data) {
  Bytes out;
  out.reserve(data.size() + data.size() / 65535 * 5 + 16);
  out.push_back(static_cast<char>(0x78));
  out.push_back(static_cast<char>(0x01));
  std::size_t pos = 0;
  do {
    const std::size_t chunk = std::min<std::size_t>(65535, data.size() - pos);
    const bool final_block = pos + chunk >= data.size();
    out.push_back(static_cast<char>(final_block ? 1 : 0));
    out.push_back(static_cast<char>(chunk & 0xFFu));
    out.push_back(static_cast<char>((chunk >> 8) & 0xFFu));
    const uint16_t nlen = static_cast<uint16_t>(~static_cast<uint16_t>(chunk));
    out.push_back(static_cast<char>(nlen & 0xFFu));
    out.push_back(static_cast<char>((nlen >> 8) & 0xFFu));
    if (chunk != 0) {
      out.append(reinterpret_cast<const char*>(data.data() + pos), chunk);
    }
    pos += chunk;
  } while (pos < data.size());
  const uint32_t checksum = adler32(data);
  out.push_back(static_cast<char>(checksum >> 24));
  out.push_back(static_cast<char>(checksum >> 16));
  out.push_back(static_cast<char>(checksum >> 8));
  out.push_back(static_cast<char>(checksum));
  return out;
}

}  // namespace iaqs::git
