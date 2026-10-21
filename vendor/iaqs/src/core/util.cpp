#include "core/util.h"

#include <algorithm>
#include <cstdio>
#include <cstring>
#include <filesystem>
#include <stdexcept>
#include <string>
#include <system_error>

#ifdef _WIN32
#include <windows.h>
#else
#include <unistd.h>
#endif

namespace iaqs {
namespace {

namespace fs = std::filesystem;

fs::path path_from_utf8(const std::string& s) {
  return fs::path(std::u8string(reinterpret_cast<const char8_t*>(s.data()),
                                s.size()));
}

std::string path_message(const std::string& what, const std::string& path) {
  return what + ": " + path;
}

std::string win32_error(DWORD code) {
#ifdef _WIN32
  return std::system_category().message(static_cast<int>(code));
#else
  (void)code;
  return "system error";
#endif
}

std::string temp_path_for(const std::string& path) {
  static unsigned counter = 0;
  ++counter;
#ifdef _WIN32
  const unsigned long pid = GetCurrentProcessId();
#else
  const unsigned long pid = static_cast<unsigned long>(getpid());
#endif
  return path + ".tmp-" + std::to_string(pid) + "-" + std::to_string(counter);
}

}  // namespace

// ---------------------------------------------------------------- paths

std::filesystem::path fs_path_from_utf8(std::string_view text) {
  return path_from_utf8(std::string(text));
}

std::string fs_path_to_utf8(const std::filesystem::path& path) {
  const std::u8string text = path.u8string();
  return std::string(reinterpret_cast<const char*>(text.data()), text.size());
}

// ---------------------------------------------------------------- hex

std::string to_hex(const uint8_t* data, size_t size) {
  static const char digits[] = "0123456789abcdef";
  std::string out;
  out.resize(size * 2);
  for (size_t i = 0; i < size; ++i) {
    out[2 * i] = digits[data[i] >> 4];
    out[2 * i + 1] = digits[data[i] & 0x0f];
  }
  return out;
}

std::string to_hex(ByteSpan data) { return to_hex(data.data(), data.size()); }

std::string to_hex(std::string_view data) { return to_hex(bytes_span(data)); }

bool from_hex(std::string_view hex, Bytes& out) {
  if (hex.size() % 2 != 0) return false;
  out.clear();
  out.resize(hex.size() / 2);
  auto nibble = [](char c) -> int {
    if (c >= '0' && c <= '9') return c - '0';
    if (c >= 'a' && c <= 'f') return c - 'a' + 10;
    if (c >= 'A' && c <= 'F') return c - 'A' + 10;
    return -1;
  };
  for (size_t i = 0; i < out.size(); ++i) {
    const int hi = nibble(hex[2 * i]);
    const int lo = nibble(hex[2 * i + 1]);
    if (hi < 0 || lo < 0) return false;
    out[i] = static_cast<char>((hi << 4) | lo);
  }
  return true;
}

// ---------------------------------------------------------------- varint

void append_uvarint(Bytes& out, uint64_t value) {
  while (value >= 0x80) {
    out.push_back(static_cast<char>(static_cast<uint8_t>(value) | 0x80));
    value >>= 7;
  }
  out.push_back(static_cast<char>(value));
}

bool read_uvarint(ByteSpan& in, uint64_t& value) {
  value = 0;
  unsigned shift = 0;
  size_t consumed = 0;
  for (uint8_t byte : in) {
    if (consumed >= 10) return false;
    if (shift >= 64) return false;
    value |= static_cast<uint64_t>(byte & 0x7f) << shift;
    ++consumed;
    if ((byte & 0x80) == 0) {
      in = in.subspan(consumed);
      return true;
    }
    shift += 7;
  }
  return false;
}

// ---------------------------------------------------------------- file io

Bytes read_file(const std::string& path) {
  std::FILE* f = nullptr;
#ifdef _WIN32
  f = _wfopen(path_from_utf8(path).c_str(), L"rb");
#else
  f = std::fopen(path.c_str(), "rb");
#endif
  if (f == nullptr) {
    throw std::runtime_error(path_message("cannot open for reading", path));
  }
  Bytes data;
  char buffer[65536];
  size_t got = 0;
  while ((got = std::fread(buffer, 1, sizeof buffer, f)) > 0) {
    data.append(buffer, got);
  }
  const bool bad = std::ferror(f) != 0;
  std::fclose(f);
  if (bad) {
    throw std::runtime_error(path_message("read error", path));
  }
  return data;
}

void write_file(const std::string& path, ByteSpan data) {
  std::FILE* f = nullptr;
#ifdef _WIN32
  f = _wfopen(path_from_utf8(path).c_str(), L"wb");
#else
  f = std::fopen(path.c_str(), "wb");
#endif
  if (f == nullptr) {
    throw std::runtime_error(path_message("cannot open for writing", path));
  }
  if (!data.empty() &&
      std::fwrite(data.data(), 1, data.size(), f) != data.size()) {
    std::fclose(f);
    throw std::runtime_error(path_message("write error", path));
  }
  if (std::fflush(f) != 0) {
    std::fclose(f);
    throw std::runtime_error(path_message("flush error", path));
  }
  std::fclose(f);
}

void write_file_atomic(const std::string& path, ByteSpan data) {
  const std::string tmp = temp_path_for(path);
  write_file(tmp, data);
#ifdef _WIN32
  if (!MoveFileExW(path_from_utf8(tmp).c_str(), path_from_utf8(path).c_str(),
                   MOVEFILE_REPLACE_EXISTING | MOVEFILE_WRITE_THROUGH)) {
    const DWORD err = GetLastError();
    DeleteFileW(path_from_utf8(tmp).c_str());
    throw std::runtime_error(path_message("atomic rename failed: " +
                                              win32_error(err),
                                          path));
  }
#else
  std::error_code ec;
  fs::rename(path_from_utf8(tmp), path_from_utf8(path), ec);
  if (ec) {
    fs::remove(path_from_utf8(tmp), ec);
    throw std::runtime_error(path_message("atomic rename failed", path));
  }
#endif
}

bool file_exists(const std::string& path) {
  std::error_code ec;
  return fs::is_regular_file(path_from_utf8(path), ec);
}

bool dir_exists(const std::string& path) {
  std::error_code ec;
  return fs::is_directory(path_from_utf8(path), ec);
}

void make_dirs(const std::string& path) {
  std::error_code ec;
  fs::create_directories(path_from_utf8(path), ec);
  if (ec) {
    throw std::runtime_error(path_message("cannot create directories", path));
  }
}

uint64_t file_size(const std::string& path) {
  std::error_code ec;
  const auto size = fs::file_size(path_from_utf8(path), ec);
  if (ec) {
    throw std::runtime_error(path_message("cannot stat", path));
  }
  return static_cast<uint64_t>(size);
}

void remove_file(const std::string& path) {
  std::error_code ec;
  if (!fs::remove(path_from_utf8(path), ec) || ec) {
    throw std::runtime_error(path_message("cannot remove", path));
  }
}

// ---------------------------------------------------------------- endian

#if defined(_WIN32) || (defined(__BYTE_ORDER__) && \
                        __BYTE_ORDER__ == __ORDER_LITTLE_ENDIAN__) || \
    defined(__x86_64__) || defined(__i386__)
constexpr bool kLittleEndian = true;
#else
constexpr bool kLittleEndian = false;
#endif

namespace {
uint16_t bswap16(uint16_t v) { return static_cast<uint16_t>((v >> 8) | (v << 8)); }
uint32_t bswap32(uint32_t v) {
  return ((v & 0x000000ffu) << 24) | ((v & 0x0000ff00u) << 8) |
         ((v & 0x00ff0000u) >> 8) | ((v & 0xff000000u) >> 24);
}
uint64_t bswap64(uint64_t v) {
  return ((v & 0x00000000000000ffull) << 56) |
         ((v & 0x000000000000ff00ull) << 40) |
         ((v & 0x0000000000ff0000ull) << 24) |
         ((v & 0x00000000ff000000ull) << 8) |
         ((v & 0x000000ff00000000ull) >> 8) |
         ((v & 0x0000ff0000000000ull) >> 24) |
         ((v & 0x00ff000000000000ull) >> 40) |
         ((v & 0xff00000000000000ull) >> 56);
}
}  // namespace

uint16_t load_u16_le(const uint8_t* p) {
  uint16_t v;
  std::memcpy(&v, p, 2);
  return kLittleEndian ? v : bswap16(v);
}

uint32_t load_u32_le(const uint8_t* p) {
  uint32_t v;
  std::memcpy(&v, p, 4);
  return kLittleEndian ? v : bswap32(v);
}

uint64_t load_u64_le(const uint8_t* p) {
  uint64_t v;
  std::memcpy(&v, p, 8);
  return kLittleEndian ? v : bswap64(v);
}

void store_u16_le(uint8_t* p, uint16_t v) {
  if (!kLittleEndian) v = bswap16(v);
  std::memcpy(p, &v, 2);
}

void store_u32_le(uint8_t* p, uint32_t v) {
  if (!kLittleEndian) v = bswap32(v);
  std::memcpy(p, &v, 4);
}

void store_u64_le(uint8_t* p, uint64_t v) {
  if (!kLittleEndian) v = bswap64(v);
  std::memcpy(p, &v, 8);
}

// ---------------------------------------------------------------- strings

std::vector<std::string_view> split(std::string_view s, char sep) {
  std::vector<std::string_view> parts;
  size_t start = 0;
  while (true) {
    const size_t pos = s.find(sep, start);
    if (pos == std::string_view::npos) {
      parts.push_back(s.substr(start));
      break;
    }
    parts.push_back(s.substr(start, pos - start));
    start = pos + 1;
  }
  return parts;
}

std::string trim(std::string_view s) {
  size_t begin = 0;
  size_t end = s.size();
  while (begin < end && (s[begin] == ' ' || s[begin] == '\t' ||
                         s[begin] == '\r' || s[begin] == '\n')) {
    ++begin;
  }
  while (end > begin && (s[end - 1] == ' ' || s[end - 1] == '\t' ||
                         s[end - 1] == '\r' || s[end - 1] == '\n')) {
    --end;
  }
  return std::string(s.substr(begin, end - begin));
}

std::string to_lower_ascii(std::string_view s) {
  std::string out(s);
  for (char& c : out) {
    if (c >= 'A' && c <= 'Z') c = static_cast<char>(c - 'A' + 'a');
  }
  return out;
}

bool starts_with(std::string_view s, std::string_view prefix) {
  return s.size() >= prefix.size() && s.substr(0, prefix.size()) == prefix;
}

}  // namespace iaqs
