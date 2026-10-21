// SHA-256 (FIPS 180-4), plus hex helper. Zero dependencies.
#pragma once

#include <array>
#include <cstddef>
#include <cstdint>
#include <string>
#include <string_view>

#include "core/util.h"

namespace iaqs {

class Sha256 {
 public:
  Sha256();
  void update(ByteSpan data);
  void update(std::string_view data) { update(bytes_span(data)); }
  // Finalizes the digest. The object must not be updated afterwards (unless
  // reset() is called).
  std::array<uint8_t, 32> finish();
  void reset();

 private:
  void transform(const uint8_t block[64]);
  std::array<uint32_t, 8> state_{};
  uint8_t buffer_[64]{};
  size_t buffer_len_ = 0;
  uint64_t total_len_ = 0;
};

std::array<uint8_t, 32> sha256(ByteSpan data);
std::array<uint8_t, 32> sha256(std::string_view data);
std::string sha256_hex(ByteSpan data);
std::string sha256_hex(std::string_view data);

}  // namespace iaqs
