// HMAC-SHA256 (RFC 2104) and PBKDF2-HMAC-SHA256 (RFC 8018).
#pragma once

#include <array>
#include <cstddef>
#include <cstdint>
#include <string>

#include "core/util.h"

namespace iaqs {

using Sha256Digest = std::array<uint8_t, 32>;

Sha256Digest hmac_sha256(ByteSpan key, ByteSpan message);
inline Sha256Digest hmac_sha256(std::string_view key, std::string_view message) {
  return hmac_sha256(bytes_span(key), bytes_span(message));
}

// Fills `out` (any length) with PBKDF2-HMAC-SHA256 output.
void pbkdf2_hmac_sha256(ByteSpan password, ByteSpan salt, uint32_t iterations,
                        ByteSpan out);
Bytes pbkdf2_hmac_sha256(ByteSpan password, ByteSpan salt,
                         uint32_t iterations, size_t derived_len);
// Convenience overload used by the database layer.
Bytes pbkdf2_hmac_sha256(std::string_view password, ByteSpan salt,
                         uint32_t iterations, size_t derived_len);

}  // namespace iaqs
