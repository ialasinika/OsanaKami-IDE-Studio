#pragma once

#include <array>
#include <cstdint>
#include <filesystem>
#include <string>
#include <vector>

#include "core/util.h"

namespace iaqs::git {

// git pack v2 / idx v2 interoperability. Objects are written without deltas
// (each entry is a full zlib stream); reading supports delta entries in packs
// produced by git (`OFS_DELTA` and `REF_DELTA`).
enum class PackType : uint8_t {
  Commit = 1,
  Tree = 2,
  Blob = 3,
  Tag = 4,
  OfsDelta = 6,
  RefDelta = 7,
};

inline constexpr uint64_t kPackIdxMagic = 0xFF744F63u;

struct PackObject {
  uint8_t type = 0;  // resolved type: 1 commit, 2 tree, 3 blob, 4 tag
  std::array<uint8_t, 20> id{};
  Bytes payload;
};

struct PackEntryInfo {
  uint64_t offset = 0;
  uint8_t type = 0;
  uint64_t size = 0;
  std::array<uint8_t, 20> id{};
};

struct PackFile {
  std::vector<PackObject> objects;
  std::vector<PackEntryInfo> entries;
  std::array<uint8_t, 20> checksum{};
};

struct PackIndex {
  std::vector<std::array<uint8_t, 20>> ids;
  std::vector<uint32_t> crcs;
  std::vector<uint64_t> offsets;
  std::array<uint8_t, 20> pack_checksum{};
};

[[nodiscard]] const char* pack_type_name(uint8_t type);
[[nodiscard]] uint8_t pack_type_from_name(std::string_view name);

// Writes `<prefix>.pack` and `<prefix>.idx`, returning the pack checksum hex.
std::string write_pack(const std::filesystem::path& prefix,
                       const std::vector<PackObject>& objects);

// Reads a pack. When `idx_path` is non-empty the index is also verified.
PackFile read_pack(const std::filesystem::path& pack_path,
                   const std::filesystem::path& idx_path = {});

PackIndex read_pack_index(const std::filesystem::path& idx_path);

// Exposed for tests: applies a git delta instruction stream.
Bytes apply_git_delta(ByteSpan base, ByteSpan delta);

}  // namespace iaqs::git
