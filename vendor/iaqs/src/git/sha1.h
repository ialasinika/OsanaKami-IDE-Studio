#pragma once

#include <array>
#include <cstddef>
#include <cstdint>
#include <string>
#include <string_view>

#include "core/util.h"

namespace iaqs::git {

// SHA-1 is only used for git pack compatibility (git object ids and pack
// trailer hashes). iaqs' own object ids remain SHA-256.
class Sha1 {
 public:
  Sha1();
  void update(ByteSpan data);
  void update(std::string_view text);
  std::array<uint8_t, 20> finish();

 private:
  void reset_state();
  void process_block(const uint8_t* block);

  std::array<uint32_t, 5> state_{};
  std::array<uint8_t, 64> buffer_{};
  std::size_t buffer_size_ = 0;
  uint64_t total_size_ = 0;
  bool finished_ = false;
};

std::array<uint8_t, 20> sha1(ByteSpan data);
std::array<uint8_t, 20> sha1(std::string_view text);
std::string sha1_hex(ByteSpan data);
std::string sha1_hex(std::string_view text);
std::string sha1_hex(const std::array<uint8_t, 20>& digest);
// git object id: sha1("<type> <size>\0" + payload).
std::array<uint8_t, 20> git_object_id(std::string_view type, ByteSpan payload);

}  // namespace iaqs::git
