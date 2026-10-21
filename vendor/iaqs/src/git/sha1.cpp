#include "git/sha1.h"

#include <algorithm>
#include <cstring>
#include <stdexcept>

namespace iaqs::git {
namespace {

inline uint32_t rol(uint32_t value, unsigned bits) {
  return (value << bits) | (value >> (32 - bits));
}

inline uint32_t load_be32(const uint8_t* p) {
  return (static_cast<uint32_t>(p[0]) << 24) | (static_cast<uint32_t>(p[1]) << 16) |
         (static_cast<uint32_t>(p[2]) << 8) | static_cast<uint32_t>(p[3]);
}

inline void store_be32(uint8_t* p, uint32_t value) {
  p[0] = static_cast<uint8_t>(value >> 24);
  p[1] = static_cast<uint8_t>(value >> 16);
  p[2] = static_cast<uint8_t>(value >> 8);
  p[3] = static_cast<uint8_t>(value);
}

}  // namespace

Sha1::Sha1() { reset_state(); }

void Sha1::reset_state() {
  state_ = {0x67452301u, 0xEFCDAB89u, 0x98BADCFEu, 0x10325476u, 0xC3D2E1F0u};
  buffer_size_ = 0;
  total_size_ = 0;
  finished_ = false;
}

void Sha1::update(ByteSpan data) {
  if (finished_) throw std::runtime_error("sha1: update after finish");
  total_size_ += data.size();
  std::size_t offset = 0;
  if (buffer_size_ != 0) {
    const std::size_t take = std::min(buffer_.size() - buffer_size_, data.size());
    std::memcpy(buffer_.data() + buffer_size_, data.data(), take);
    buffer_size_ += take;
    offset += take;
    if (buffer_size_ == buffer_.size()) {
      process_block(buffer_.data());
      buffer_size_ = 0;
    }
  }
  while (offset + 64 <= data.size()) {
    process_block(data.data() + offset);
    offset += 64;
  }
  if (offset < data.size()) {
    std::memcpy(buffer_.data(), data.data() + offset, data.size() - offset);
    buffer_size_ = data.size() - offset;
  }
}

void Sha1::update(std::string_view text) {
  update(ByteSpan(reinterpret_cast<const uint8_t*>(text.data()), text.size()));
}

std::array<uint8_t, 20> Sha1::finish() {
  if (finished_) throw std::runtime_error("sha1: finish called twice");
  const uint64_t bit_length = total_size_ * 8;
  buffer_[buffer_size_++] = 0x80;
  if (buffer_size_ > 56) {
    std::fill(buffer_.begin() + static_cast<std::ptrdiff_t>(buffer_size_), buffer_.end(), 0);
    process_block(buffer_.data());
    buffer_size_ = 0;
  }
  std::fill(buffer_.begin() + static_cast<std::ptrdiff_t>(buffer_size_),
            buffer_.begin() + 56, 0);
  for (int i = 0; i < 8; ++i) {
    buffer_[56 + static_cast<std::size_t>(i)] =
        static_cast<uint8_t>(bit_length >> ((7 - i) * 8));
  }
  process_block(buffer_.data());
  buffer_size_ = 0;
  finished_ = true;

  std::array<uint8_t, 20> out{};
  for (int word = 0; word < 5; ++word) {
    store_be32(out.data() + word * 4, state_[static_cast<std::size_t>(word)]);
  }
  return out;
}

void Sha1::process_block(const uint8_t* block) {
  uint32_t w[80];
  for (int i = 0; i < 16; ++i) w[i] = load_be32(block + i * 4);
  for (int i = 16; i < 80; ++i) {
    w[i] = rol(w[i - 3] ^ w[i - 8] ^ w[i - 14] ^ w[i - 16], 1);
  }
  uint32_t a = state_[0];
  uint32_t b = state_[1];
  uint32_t c = state_[2];
  uint32_t d = state_[3];
  uint32_t e = state_[4];
  for (int i = 0; i < 80; ++i) {
    uint32_t f = 0;
    uint32_t k = 0;
    if (i < 20) {
      f = (b & c) | ((~b) & d);
      k = 0x5A827999u;
    } else if (i < 40) {
      f = b ^ c ^ d;
      k = 0x6ED9EBA1u;
    } else if (i < 60) {
      f = (b & c) | (b & d) | (c & d);
      k = 0x8F1BBCDCu;
    } else {
      f = b ^ c ^ d;
      k = 0xCA62C1D6u;
    }
    const uint32_t temp = rol(a, 5) + f + e + k + w[i];
    e = d;
    d = c;
    c = rol(b, 30);
    b = a;
    a = temp;
  }
  state_[0] += a;
  state_[1] += b;
  state_[2] += c;
  state_[3] += d;
  state_[4] += e;
}

std::array<uint8_t, 20> sha1(ByteSpan data) {
  Sha1 hasher;
  hasher.update(data);
  return hasher.finish();
}

std::array<uint8_t, 20> sha1(std::string_view text) {
  return sha1(ByteSpan(reinterpret_cast<const uint8_t*>(text.data()), text.size()));
}

std::string sha1_hex(ByteSpan data) {
  static constexpr char kHex[] = "0123456789abcdef";
  const auto digest = sha1(data);
  std::string out(40, '0');
  for (std::size_t i = 0; i < digest.size(); ++i) {
    out[i * 2] = kHex[digest[i] >> 4];
    out[i * 2 + 1] = kHex[digest[i] & 0x0F];
  }
  return out;
}

std::string sha1_hex(std::string_view text) {
  return sha1_hex(ByteSpan(reinterpret_cast<const uint8_t*>(text.data()), text.size()));
}

std::string sha1_hex(const std::array<uint8_t, 20>& digest) {
  static constexpr char kHex[] = "0123456789abcdef";
  std::string out(40, '0');
  for (std::size_t i = 0; i < digest.size(); ++i) {
    out[i * 2] = kHex[digest[i] >> 4];
    out[i * 2 + 1] = kHex[digest[i] & 0x0F];
  }
  return out;
}

std::array<uint8_t, 20> git_object_id(std::string_view type, ByteSpan payload) {
  Sha1 hasher;
  std::string header(type);
  header += ' ';
  header += std::to_string(payload.size());
  header.push_back('\0');
  hasher.update(header);
  hasher.update(payload);
  return hasher.finish();
}

}  // namespace iaqs::git
