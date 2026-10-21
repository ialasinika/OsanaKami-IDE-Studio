// Byte-oriented utilities shared by every iaqs module.
#pragma once

#include <cstddef>
#include <cstdint>
#include <filesystem>
#include <span>
#include <string>
#include <string_view>
#include <vector>

namespace iaqs {

// Arbitrary bytes are stored in std::string: cheap, movable, no encoding policy.
using Bytes = std::string;

using ByteSpan = std::span<const uint8_t>;

inline ByteSpan bytes_span(std::string_view s) {
  return ByteSpan(reinterpret_cast<const uint8_t*>(s.data()), s.size());
}

inline std::string_view bytes_view(ByteSpan s) {
  return std::string_view(reinterpret_cast<const char*>(s.data()), s.size());
}

// ---------------------------------------------------------------- hex
std::string to_hex(const uint8_t* data, size_t size);
std::string to_hex(ByteSpan data);
std::string to_hex(std::string_view data);
bool from_hex(std::string_view hex, Bytes& out);  // false on malformed input

// ---------------------------------------------------------------- varint (LEB128)
void append_uvarint(Bytes& out, uint64_t value);
bool read_uvarint(ByteSpan& in, uint64_t& value);  // advances `in` on success

// ---------------------------------------------------------------- paths
// Path strings crossing the API are UTF-8; these convert through u8string so
// non-ASCII (e.g. Chinese) repository paths never go through the ANSI code page.
std::filesystem::path fs_path_from_utf8(std::string_view text);
std::string fs_path_to_utf8(const std::filesystem::path& path);

// ---------------------------------------------------------------- file io
Bytes read_file(const std::string& path);  // throws std::runtime_error
void write_file(const std::string& path, ByteSpan data);
// Writes to a temp file in the same directory, fsyncs, then atomically replaces
// `path` (MoveFileExW(REPLACE_EXISTING) on Windows).
void write_file_atomic(const std::string& path, ByteSpan data);
bool file_exists(const std::string& path);
bool dir_exists(const std::string& path);
void make_dirs(const std::string& path);
uint64_t file_size(const std::string& path);  // throws if missing
void remove_file(const std::string& path);    // throws on failure

// ---------------------------------------------------------------- little endian
uint16_t load_u16_le(const uint8_t* p);
uint32_t load_u32_le(const uint8_t* p);
uint64_t load_u64_le(const uint8_t* p);
void store_u16_le(uint8_t* p, uint16_t v);
void store_u32_le(uint8_t* p, uint32_t v);
void store_u64_le(uint8_t* p, uint64_t v);

inline void append_u16_le(Bytes& out, uint16_t v) {
  uint8_t b[2];
  store_u16_le(b, v);
  out.append(reinterpret_cast<char*>(b), 2);
}
inline void append_u32_le(Bytes& out, uint32_t v) {
  uint8_t b[4];
  store_u32_le(b, v);
  out.append(reinterpret_cast<char*>(b), 4);
}
inline void append_u64_le(Bytes& out, uint64_t v) {
  uint8_t b[8];
  store_u64_le(b, v);
  out.append(reinterpret_cast<char*>(b), 8);
}

// ---------------------------------------------------------------- strings
std::vector<std::string_view> split(std::string_view s, char sep);
std::string trim(std::string_view s);
std::string to_lower_ascii(std::string_view s);
bool starts_with(std::string_view s, std::string_view prefix);

}  // namespace iaqs
