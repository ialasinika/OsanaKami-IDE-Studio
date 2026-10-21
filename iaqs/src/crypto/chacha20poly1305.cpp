#include "crypto/chacha20poly1305.h"

#include <cstring>

#include "crypto/rand.h"

namespace iaqs {
namespace {

inline uint32_t load32le(const uint8_t* p) {
  return static_cast<uint32_t>(p[0]) | (static_cast<uint32_t>(p[1]) << 8) |
         (static_cast<uint32_t>(p[2]) << 16) |
         (static_cast<uint32_t>(p[3]) << 24);
}

inline void store32le(uint8_t* p, uint32_t v) {
  p[0] = static_cast<uint8_t>(v);
  p[1] = static_cast<uint8_t>(v >> 8);
  p[2] = static_cast<uint8_t>(v >> 16);
  p[3] = static_cast<uint8_t>(v >> 24);
}

inline uint32_t rotl32(uint32_t v, int c) { return (v << c) | (v >> (32 - c)); }

inline void quarter_round(uint32_t& a, uint32_t& b, uint32_t& c,
                          uint32_t& d) {
  a += b;
  d ^= a;
  d = rotl32(d, 16);
  c += d;
  b ^= c;
  b = rotl32(b, 12);
  a += b;
  d ^= a;
  d = rotl32(d, 8);
  c += d;
  b ^= c;
  b = rotl32(b, 7);
}

// Poly1305 one-time authenticator, 32-bit limbs, adapted from the public
// domain poly1305-donna implementation.
class Poly1305 {
 public:
  void init(const uint8_t key[32]) {
    r_[0] = load32le(key + 0) & 0x3ffffff;
    r_[1] = (load32le(key + 3) >> 2) & 0x3ffff03;
    r_[2] = (load32le(key + 6) >> 4) & 0x3ffc0ff;
    r_[3] = (load32le(key + 9) >> 6) & 0x3f03fff;
    r_[4] = (load32le(key + 12) >> 8) & 0x00fffff;
    pad_[0] = load32le(key + 16);
    pad_[1] = load32le(key + 20);
    pad_[2] = load32le(key + 24);
    pad_[3] = load32le(key + 28);
    h_[0] = h_[1] = h_[2] = h_[3] = h_[4] = 0;
    leftover_ = 0;
    final_ = false;
  }

  void update(const uint8_t* m, size_t bytes) {
    if (leftover_ != 0) {
      const size_t want = 16 - leftover_;
      const size_t take = bytes < want ? bytes : want;
      std::memcpy(buffer_ + leftover_, m, take);
      leftover_ += take;
      m += take;
      bytes -= take;
      if (leftover_ < 16) return;
      blocks(buffer_, 16);
      leftover_ = 0;
    }
    if (bytes >= 16) {
      const size_t full = bytes & ~static_cast<size_t>(15);
      blocks(m, full);
      m += full;
      bytes -= full;
    }
    if (bytes > 0) {
      std::memcpy(buffer_, m, bytes);
      leftover_ = bytes;
    }
  }

  // Pads with zeros up to the next multiple of 16 (the AEAD input padding).
  void pad16() {
    static const uint8_t zeros[16] = {};
    const size_t rem = leftover_ == 0 ? 0 : 16 - leftover_;
    if (rem != 0) update(zeros, rem);
  }

  void finish(uint8_t tag[16]) {
    if (leftover_ != 0) {
      buffer_[leftover_++] = 1;
      while (leftover_ < 16) buffer_[leftover_++] = 0;
      final_ = true;
      blocks(buffer_, 16);
      final_ = false;
    }

    uint32_t h0 = h_[0], h1 = h_[1], h2 = h_[2], h3 = h_[3], h4 = h_[4];
    uint32_t c = h1 >> 26;
    h1 &= 0x3ffffff;
    h2 += c;
    c = h2 >> 26;
    h2 &= 0x3ffffff;
    h3 += c;
    c = h3 >> 26;
    h3 &= 0x3ffffff;
    h4 += c;
    c = h4 >> 26;
    h4 &= 0x3ffffff;
    h0 += c * 5;
    c = h0 >> 26;
    h0 &= 0x3ffffff;
    h1 += c;

    uint32_t g0 = h0 + 5;
    c = g0 >> 26;
    g0 &= 0x3ffffff;
    uint32_t g1 = h1 + c;
    c = g1 >> 26;
    g1 &= 0x3ffffff;
    uint32_t g2 = h2 + c;
    c = g2 >> 26;
    g2 &= 0x3ffffff;
    uint32_t g3 = h3 + c;
    c = g3 >> 26;
    g3 &= 0x3ffffff;
    uint32_t g4 = h4 + c - (1u << 26);

    uint32_t mask = (g4 >> 31) - 1;  // 0xffffffff when g4 >= 0
    g0 &= mask;
    g1 &= mask;
    g2 &= mask;
    g3 &= mask;
    g4 &= mask;
    mask = ~mask;
    h0 = (h0 & mask) | g0;
    h1 = (h1 & mask) | g1;
    h2 = (h2 & mask) | g2;
    h3 = (h3 & mask) | g3;
    h4 = (h4 & mask) | g4;

    h0 = (h0 | (h1 << 26)) & 0xffffffffu;
    h1 = ((h1 >> 6) | (h2 << 20)) & 0xffffffffu;
    h2 = ((h2 >> 12) | (h3 << 14)) & 0xffffffffu;
    h3 = ((h3 >> 18) | (h4 << 8)) & 0xffffffffu;

    uint64_t f = static_cast<uint64_t>(h0) + pad_[0];
    h0 = static_cast<uint32_t>(f);
    f = static_cast<uint64_t>(h1) + pad_[1] + (f >> 32);
    h1 = static_cast<uint32_t>(f);
    f = static_cast<uint64_t>(h2) + pad_[2] + (f >> 32);
    h2 = static_cast<uint32_t>(f);
    f = static_cast<uint64_t>(h3) + pad_[3] + (f >> 32);
    h3 = static_cast<uint32_t>(f);

    store32le(tag + 0, h0);
    store32le(tag + 4, h1);
    store32le(tag + 8, h2);
    store32le(tag + 12, h3);
  }

 private:
  void blocks(const uint8_t* m, size_t bytes) {
    const uint32_t hibit = final_ ? 0u : (1u << 24);
    const uint32_t r0 = r_[0], r1 = r_[1], r2 = r_[2], r3 = r_[3], r4 = r_[4];
    const uint32_t s1 = r1 * 5, s2 = r2 * 5, s3 = r3 * 5, s4 = r4 * 5;
    uint32_t h0 = h_[0], h1 = h_[1], h2 = h_[2], h3 = h_[3], h4 = h_[4];

    while (bytes >= 16) {
      h0 += load32le(m + 0) & 0x3ffffff;
      h1 += (load32le(m + 3) >> 2) & 0x3ffffff;
      h2 += (load32le(m + 6) >> 4) & 0x3ffffff;
      h3 += (load32le(m + 9) >> 6) & 0x3ffffff;
      h4 += (load32le(m + 12) >> 8) | hibit;

      const uint64_t d0 = static_cast<uint64_t>(h0) * r0 +
                          static_cast<uint64_t>(h1) * s4 +
                          static_cast<uint64_t>(h2) * s3 +
                          static_cast<uint64_t>(h3) * s2 +
                          static_cast<uint64_t>(h4) * s1;
      uint64_t d1 = static_cast<uint64_t>(h0) * r1 +
                    static_cast<uint64_t>(h1) * r0 +
                    static_cast<uint64_t>(h2) * s4 +
                    static_cast<uint64_t>(h3) * s3 +
                    static_cast<uint64_t>(h4) * s2;
      uint64_t d2 = static_cast<uint64_t>(h0) * r2 +
                    static_cast<uint64_t>(h1) * r1 +
                    static_cast<uint64_t>(h2) * r0 +
                    static_cast<uint64_t>(h3) * s4 +
                    static_cast<uint64_t>(h4) * s3;
      uint64_t d3 = static_cast<uint64_t>(h0) * r3 +
                    static_cast<uint64_t>(h1) * r2 +
                    static_cast<uint64_t>(h2) * r1 +
                    static_cast<uint64_t>(h3) * r0 +
                    static_cast<uint64_t>(h4) * s4;
      uint64_t d4 = static_cast<uint64_t>(h0) * r4 +
                    static_cast<uint64_t>(h1) * r3 +
                    static_cast<uint64_t>(h2) * r2 +
                    static_cast<uint64_t>(h3) * r1 +
                    static_cast<uint64_t>(h4) * r0;

      uint32_t c = static_cast<uint32_t>(d0 >> 26);
      h0 = static_cast<uint32_t>(d0) & 0x3ffffff;
      d1 += c;
      c = static_cast<uint32_t>(d1 >> 26);
      h1 = static_cast<uint32_t>(d1) & 0x3ffffff;
      d2 += c;
      c = static_cast<uint32_t>(d2 >> 26);
      h2 = static_cast<uint32_t>(d2) & 0x3ffffff;
      d3 += c;
      c = static_cast<uint32_t>(d3 >> 26);
      h3 = static_cast<uint32_t>(d3) & 0x3ffffff;
      d4 += c;
      c = static_cast<uint32_t>(d4 >> 26);
      h4 = static_cast<uint32_t>(d4) & 0x3ffffff;
      h0 += c * 5;
      c = h0 >> 26;
      h0 &= 0x3ffffff;
      h1 += c;

      m += 16;
      bytes -= 16;
    }

    h_[0] = h0;
    h_[1] = h1;
    h_[2] = h2;
    h_[3] = h3;
    h_[4] = h4;
  }

  uint32_t r_[5]{};
  uint32_t h_[5]{};
  uint32_t pad_[4]{};
  uint8_t buffer_[16]{};
  size_t leftover_ = 0;
  bool final_ = false;
};

bool constant_time_equal(const uint8_t* a, const uint8_t* b, size_t size) {
  uint8_t diff = 0;
  for (size_t i = 0; i < size; ++i) diff |= static_cast<uint8_t>(a[i] ^ b[i]);
  return diff == 0;
}

void aead_mac(const uint8_t one_time_key[32], ByteSpan ciphertext, ByteSpan aad,
              uint8_t tag[16]) {
  Poly1305 poly;
  poly.init(one_time_key);
  poly.update(aad.data(), aad.size());
  poly.pad16();
  poly.update(ciphertext.data(), ciphertext.size());
  poly.pad16();
  uint8_t lengths[16];
  store32le(lengths + 0, static_cast<uint32_t>(aad.size()));
  store32le(lengths + 4, static_cast<uint32_t>(aad.size() >> 32));
  store32le(lengths + 8, static_cast<uint32_t>(ciphertext.size()));
  store32le(lengths + 12, static_cast<uint32_t>(ciphertext.size() >> 32));
  poly.update(lengths, sizeof lengths);
  poly.finish(tag);
}

}  // namespace

void chacha20_block(const uint8_t key[kChaCha20KeySize],
                    const uint8_t nonce[kChaCha20NonceSize], uint32_t counter,
                    uint8_t out[64]) {
  static constexpr uint32_t kSigma[4] = {0x61707865u, 0x3320646eu,
                                         0x79622d32u, 0x6b206574u};
  uint32_t state[16];
  state[0] = kSigma[0];
  state[1] = kSigma[1];
  state[2] = kSigma[2];
  state[3] = kSigma[3];
  for (int i = 0; i < 8; ++i) state[4 + i] = load32le(key + 4 * i);
  state[12] = counter;
  state[13] = load32le(nonce + 0);
  state[14] = load32le(nonce + 4);
  state[15] = load32le(nonce + 8);

  uint32_t x[16];
  std::memcpy(x, state, sizeof x);
  for (int round = 0; round < 10; ++round) {
    quarter_round(x[0], x[4], x[8], x[12]);
    quarter_round(x[1], x[5], x[9], x[13]);
    quarter_round(x[2], x[6], x[10], x[14]);
    quarter_round(x[3], x[7], x[11], x[15]);
    quarter_round(x[0], x[5], x[10], x[15]);
    quarter_round(x[1], x[6], x[11], x[12]);
    quarter_round(x[2], x[7], x[8], x[13]);
    quarter_round(x[3], x[4], x[9], x[14]);
  }
  for (int i = 0; i < 16; ++i) store32le(out + 4 * i, x[i] + state[i]);
}

void chacha20_xor(const uint8_t key[kChaCha20KeySize],
                  const uint8_t nonce[kChaCha20NonceSize], uint32_t counter,
                  ByteSpan input, uint8_t* output) {
  uint8_t stream[64];
  size_t offset = 0;
  uint32_t block_counter = counter;
  while (offset < input.size()) {
    chacha20_block(key, nonce, block_counter, stream);
    const size_t take =
        (input.size() - offset) < sizeof stream ? (input.size() - offset)
                                                : sizeof stream;
    for (size_t i = 0; i < take; ++i) {
      output[offset + i] = static_cast<uint8_t>(input[offset + i] ^ stream[i]);
    }
    offset += take;
    ++block_counter;
  }
  secure_wipe(stream, sizeof stream);
}

Bytes aead_seal(const uint8_t key[kChaCha20KeySize],
                const uint8_t nonce[kChaCha20NonceSize], ByteSpan plaintext,
                ByteSpan aad) {
  Bytes sealed;
  sealed.resize(plaintext.size() + kAeadTagSize);
  chacha20_xor(key, nonce, 1, plaintext,
               reinterpret_cast<uint8_t*>(sealed.data()));

  uint8_t one_time_key[64];
  chacha20_block(key, nonce, 0, one_time_key);
  const ByteSpan ciphertext(reinterpret_cast<const uint8_t*>(sealed.data()),
                            plaintext.size());
  aead_mac(one_time_key, ciphertext, aad,
           reinterpret_cast<uint8_t*>(sealed.data() + plaintext.size()));
  secure_wipe(one_time_key, sizeof one_time_key);
  return sealed;
}

bool aead_open(const uint8_t key[kChaCha20KeySize],
               const uint8_t nonce[kChaCha20NonceSize], ByteSpan sealed,
               ByteSpan aad, Bytes& plaintext) {
  if (sealed.size() < kAeadTagSize) return false;
  const size_t ciphertext_size = sealed.size() - kAeadTagSize;
  const ByteSpan ciphertext(sealed.data(), ciphertext_size);
  const uint8_t* tag = sealed.data() + ciphertext_size;

  uint8_t one_time_key[64];
  chacha20_block(key, nonce, 0, one_time_key);
  uint8_t expected_tag[kAeadTagSize];
  aead_mac(one_time_key, ciphertext, aad, expected_tag);
  secure_wipe(one_time_key, sizeof one_time_key);

  if (!constant_time_equal(expected_tag, tag, kAeadTagSize)) {
    secure_wipe(expected_tag, sizeof expected_tag);
    return false;
  }

  Bytes out;
  out.resize(ciphertext_size);
  if (ciphertext_size > 0) {
    chacha20_xor(key, nonce, 1, ciphertext,
                 reinterpret_cast<uint8_t*>(out.data()));
  }
  plaintext = std::move(out);
  secure_wipe(expected_tag, sizeof expected_tag);
  return true;
}

}  // namespace iaqs
