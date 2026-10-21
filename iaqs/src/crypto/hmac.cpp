#include "crypto/hmac.h"

#include <cstring>
#include <stdexcept>

#include "crypto/sha256.h"

namespace iaqs {

Sha256Digest hmac_sha256(ByteSpan key, ByteSpan message) {
  constexpr size_t kBlock = 64;
  uint8_t key_block[kBlock];
  std::memset(key_block, 0, sizeof key_block);
  if (key.size() > kBlock) {
    const Sha256Digest hashed = sha256(key);
    std::memcpy(key_block, hashed.data(), hashed.size());
  } else {
    std::memcpy(key_block, key.data(), key.size());
  }

  uint8_t ipad[kBlock];
  uint8_t opad[kBlock];
  for (size_t i = 0; i < kBlock; ++i) {
    ipad[i] = static_cast<uint8_t>(key_block[i] ^ 0x36);
    opad[i] = static_cast<uint8_t>(key_block[i] ^ 0x5c);
  }

  Sha256 inner;
  inner.update(ByteSpan(ipad, kBlock));
  inner.update(message);
  const Sha256Digest inner_digest = inner.finish();

  Sha256 outer;
  outer.update(ByteSpan(opad, kBlock));
  outer.update(ByteSpan(inner_digest.data(), inner_digest.size()));
  return outer.finish();
}

void pbkdf2_hmac_sha256(ByteSpan password, ByteSpan salt, uint32_t iterations,
                        ByteSpan out) {
  if (iterations == 0) {
    throw std::runtime_error("pbkdf2: iterations must be >= 1");
  }
  constexpr size_t kHlen = 32;
  const size_t blocks = (out.size() + kHlen - 1) / kHlen;
  uint8_t* dst = const_cast<uint8_t*>(out.data());
  size_t produced = 0;
  for (size_t block_index = 1; block_index <= blocks; ++block_index) {
    // U1 = PRF(password, salt || INT_BE32(block_index))
    Bytes u_input;
    u_input.append(reinterpret_cast<const char*>(salt.data()), salt.size());
    u_input.push_back(static_cast<char>((block_index >> 24) & 0xff));
    u_input.push_back(static_cast<char>((block_index >> 16) & 0xff));
    u_input.push_back(static_cast<char>((block_index >> 8) & 0xff));
    u_input.push_back(static_cast<char>(block_index & 0xff));

    Sha256Digest u = hmac_sha256(password, bytes_span(u_input));
    Sha256Digest acc = u;
    for (uint32_t i = 1; i < iterations; ++i) {
      u = hmac_sha256(password, ByteSpan(u.data(), u.size()));
      for (size_t j = 0; j < kHlen; ++j) acc[j] ^= u[j];
    }
    const size_t take = (out.size() - produced) < kHlen
                            ? (out.size() - produced)
                            : kHlen;
    std::memcpy(dst + produced, acc.data(), take);
    produced += take;
  }
}

Bytes pbkdf2_hmac_sha256(ByteSpan password, ByteSpan salt,
                         uint32_t iterations, size_t derived_len) {
  Bytes out;
  out.resize(derived_len);
  if (derived_len > 0) {
    pbkdf2_hmac_sha256(password, salt, iterations,
                       ByteSpan(reinterpret_cast<uint8_t*>(out.data()),
                                out.size()));
  }
  return out;
}

Bytes pbkdf2_hmac_sha256(std::string_view password, ByteSpan salt,
                         uint32_t iterations, size_t derived_len) {
  return pbkdf2_hmac_sha256(bytes_span(password), salt, iterations, derived_len);
}

}  // namespace iaqs
