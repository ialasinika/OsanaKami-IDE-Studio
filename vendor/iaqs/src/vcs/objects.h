// Logical object model: blob / tree / commit / tag (design 01).
//
// The on-disk (on-database) representation is a payload whose object id is
//   sha256_hex("<type> <payload_size>\0" + payload)
// The encoders below produce exactly that payload; the store adds the frame and
// hashing. Everything here is byte-safe (no encodings, no newline translation).
#pragma once

#include <cstdint>
#include <string>
#include <string_view>
#include <vector>

#include "core/util.h"

namespace iaqs::vcs {

enum class ObjType : uint8_t { Blob = 1, Tree = 2, Commit = 3, Tag = 4 };

std::string_view type_name(ObjType type);
ObjType type_from_name(std::string_view name);
const char* type_name_cstr(ObjType type);

// File modes we understand.
inline constexpr uint32_t kModeFile = 0100644;
inline constexpr uint32_t kModeExec = 0100755;
inline constexpr uint32_t kModeSymlink = 0120000;
inline constexpr uint32_t kModeDir = 0040000;

struct TreeEntry {
  uint32_t mode = kModeFile;
  ObjType type = ObjType::Blob;
  std::string oid;   // 64 lowercase hex
  std::string name;  // single path segment, raw bytes
};

struct Commit {
  std::string tree;
  std::vector<std::string> parents;
  int64_t time = 0;      // unix seconds
  std::string tz = "+0000";
  std::string message;   // raw bytes, trailing newline added on encode
};

struct Tag {
  std::string object;
  ObjType type = ObjType::Commit;
  std::string name;
  int64_t time = 0;
  std::string tz = "+0000";
  std::string message;
};

// Single-segment name escaping: "\\" "\n" "\r" "\t"; every other byte verbatim.
std::string escape_name(std::string_view name);
std::string unescape_name(std::string_view escaped);

// Canonical mode value for a file (keeps only the four understood kinds).
uint32_t canonical_mode(uint32_t mode);

// "<type> <size>\0" + payload.
std::string frame(ObjType type, std::string_view payload);
// sha256_hex(frame(type, payload)).
std::string object_id(ObjType type, std::string_view payload);

std::string encode_tree(const std::vector<TreeEntry>& entries);
std::vector<TreeEntry> decode_tree(std::string_view payload);

std::string encode_commit(const Commit& commit);
Commit decode_commit(std::string_view payload);

std::string encode_tag(const Tag& tag);
Tag decode_tag(std::string_view payload);

}  // namespace iaqs::vcs
